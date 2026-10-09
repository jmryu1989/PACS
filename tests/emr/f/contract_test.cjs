/* EMR unit F, round 1 (module-first): pure/contract cases of api/src/emr-audit/contract.ts.
 *
 * REQ-EMR-15·19 -> RISK-F-01 roster_scope        -> TEST-F-01
 * REQ-EMR-07·15 -> RISK-F-02 patient_replay      -> TEST-F-02
 * REQ-EMR-16    -> RISK-F-03 lawful_issue        -> TEST-F-03
 * REQ-EMR-16    -> RISK-F-04 issuance_result     -> TEST-F-04
 * REQ-EMR-15    -> RISK-F-05 followup            -> TEST-F-05
 * REQ-EMR-17    -> RISK-F-06 extended_request_hold -> TEST-F-06
 * legal register 2026-10-09 delta D-15 (REQ-EMR-15·19) -> RISK-F-07 incident_scope -> TEST-F-07
 * legal register 2026-10-09 delta D-7  (REQ-EMR-16)    -> RISK-F-08 rights_request -> TEST-F-08
 *
 * Each case observes both sides: the allowed decision, and for the refused one its error code, no plan/row/package/
 * release/state produced, no port read where none may happen, and inputs left unchanged. Assertions bind to the
 * module's public decisions and refusal codes (the contract), never to product strings, DOM or internal names. The A
 * contract is the real module (installed TypeScript, transpiled the way api/tsconfig.json compiles), composed once with
 * synthetic adapters. Synthetic data only: no database, network, stack or credentials. KIN_EMR_F_SRC lets the mutant
 * runner point at a copy of api/src/emr-audit (with api/src/emr-contract beside it).
 */
'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const API = path.join(ROOT, 'api');
const F_SRC = process.env.KIN_EMR_F_SRC ? path.resolve(process.env.KIN_EMR_F_SRC) : path.join(API, 'src', 'emr-audit');
const A_SRC = path.join(F_SRC, '..', 'emr-contract');
const ts = require(path.join(API, 'node_modules', 'typescript'));
const config = ts.readConfigFile(path.join(API, 'tsconfig.json'), ts.sys.readFile);
assert.equal(config.error, undefined);
const compilerOptions = ts.parseJsonConfigFileContent(config.config, ts.sys, API).options;
const previousLoader = require.extensions['.ts'];
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'),
  { compilerOptions, fileName: filename }).outputText, filename);
const F = require(path.join(F_SRC, 'contract.ts'));
const M = require(path.join(A_SRC, 'composition.ts'));
const C = require(path.join(A_SRC, 'classification.ts'));
const AE = require(path.join(A_SRC, 'access-event.ts'));
const S = require(path.join(A_SRC, 'signature.ts'));
const D = require(path.join(A_SRC, 'lawful-defaults.ts'));
if (previousLoader) require.extensions['.ts'] = previousLoader; else delete require.extensions['.ts'];

// ---- synthetic A composition (once per process, as B's server start will do) ----------------------------------------
const storedRows = new Map(), dutyRows = new Map(), requestRows = new Map();
const caps = M.composeEmrAdapters({
  stored: { load: (recordId, eventId) => storedRows.get(`${recordId}:${eventId}`) },
  legal: { load: holdId => dutyRows.get(holdId), listHolds: recordId => ({ recordId, holdIds: [], complete: true }),
    loadAccessRequest: requestId => requestRows.get(requestId) },
  purpose: { load: () => undefined, loadSignedResult: () => undefined },
  clinical: { loadStudy: () => undefined, loadReportPatient: () => undefined },
});

// ---- helpers ---------------------------------------------------------------------------------------------------------
const clone = value => structuredClone(value);
function refused(run, code, message) {
  let error = null;
  try { run(); } catch (caught) { error = caught; }
  assert.ok(error, `${message} (no refusal)`);
  assert.equal(error.code, code, `${message} (got ${error && (error.code || error.message)})`);
}
async function refusedAsync(run, code, message) {
  let error = null;
  try { await run(); } catch (caught) { error = caught; }
  assert.ok(error, `${message} (no refusal)`);
  assert.equal(error.code, code, `${message} (got ${error && (error.code || error.message)})`);
}
const INST_X = 'inst-x', INST_Y = 'inst-y';
const id = name => ({ id: name, issuer: 'https://idp.example.test', subject: `sub-${name}` });
const known = value => ({ status: 'known', value });
const unresolved = { status: 'unresolved', reason: 'not-resolved' };
const P1 = { linkId: 'link-1', patientId: 'SYN-P1', assigningAuthority: 'hosp-x' };
const P2 = { linkId: 'link-2', patientId: 'SYN-P2', assigningAuthority: 'hosp-x' };
const P3 = { linkId: 'link-3', patientId: 'SYN-P3', assigningAuthority: 'hosp-x' };
const P4 = { linkId: 'link-4', patientId: 'SYN-P4', assigningAuthority: 'hosp-x' };
const NOW = '2026-10-09T01:00:00.000Z';
const PERIOD = { from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' };
const hex = text => crypto.createHash('sha256').update(text).digest('hex');
const b64u = bytes => Buffer.from(bytes).toString('base64url');
const minute = n => new Date(Date.parse('2026-10-05T00:00:00.000Z') + n * 60_000).toISOString();

// Roster
const GRANTED_AT = '2026-10-01T00:00:00.000Z';
function grantOf(subject, institutionId, scopes, more = [], grantId = `grant-${subject}-${institutionId}`) {
  return { grantId, subject: id(subject), institutionId, events: [
    { kind: 'granted', eventId: `${grantId}-1`, at: GRANTED_AT, by: id('officer'), capacity: 'privacy-officer', basisDocumentId: 'appointment-1',
      scopes, validFrom: GRANTED_AT, validUntil: null }, ...more] };
}
function roster(grants, listing = null) {
  const calls = [];
  return { calls, listGrants: subject => { calls.push(subject.id); return listing ? listing(subject) : { subject, complete: true, grants: grants.filter(g => g.subject.id === subject.id) }; } };
}
const caller = (name, institutionId = INST_X, roles = ['staff']) => ({ identity: id(name), institutionId, roles });
const ALL_SCOPES = ['investigate', 'export', 'disclosure', 'inspection'];
const authorityFor = (name, scopes = ALL_SCOPES, institutionId = INST_X) =>
  F.resolveAuditAuthority(roster([grantOf(name, institutionId, scopes)]), caller(name, institutionId), NOW);

// Ledger
let eventCounter = 0;
function target(patient, studyId = 'study-1', recordId = 'rep-1', versionId = 'v1', kind = 'report-version') {
  return { kind, patientLinkSnapshot: known(patient), studyId: known(studyId), recordId: known(recordId), versionId: known(versionId) };
}
function accessEvent(o = {}) {
  eventCounter++;
  const inst = o.inst ?? INST_X;
  return {
    formatVersion: 1, surface: o.surface ?? 'GET studies/:uid/report/versions', eventId: o.eventId ?? `evt-${eventCounter}`,
    userId: known(id(o.actor ?? 'dr-1')), rolesAtTime: known(['radiologist']), actingInstitution: o.acting ?? known(inst),
    managingInstitution: o.managing ?? known(inst), occurredAt: o.at ?? minute(eventCounter),
    trustedProxyIp: o.ip ?? known({ address: o.address ?? '10.0.0.5', source: 'trusted-proxy' }), cause: 'user-view', executor: 'member',
    targets: o.targets ?? [target(o.patient ?? P1, o.study ?? 'study-1', o.record ?? 'rep-1', o.version ?? 'v1')],
    action: o.action ?? 'provide-prepared', result: o.result ?? 'prepared', requestId: `request-${eventCounter}`,
    auditLinkId: `audit:${crypto.randomUUID()}`, relatedEventId: o.related ?? null,
  };
}
function chainRows(events, rows = []) {
  let previous = rows.length ? { sequence: rows[rows.length - 1].entry.sequence, hash: rows[rows.length - 1].entry.hash } : AE.ACCESS_CHAIN_GENESIS;
  const out = [...rows];
  for (const e of events) {
    const entry = AE.sealAccessEvent(previous, e);
    out.push({ entry, durableAt: new Date(Date.parse(e.occurredAt) + 1000).toISOString(), served: null });
    previous = { sequence: entry.sequence, hash: entry.hash };
  }
  return out;
}
function ledgerOf(data) {
  const calls = { top: 0, rows: 0 };
  return { calls, data,
    top: async () => { calls.top++; return data.reduce((max, r) => Math.max(max, r.entry.sequence), 0); },
    rows: async (top, below, take) => { calls.rows++;
      return data.filter(r => r.entry.sequence <= top && (below === null || r.entry.sequence < below))
        .sort((a, b) => b.entry.sequence - a.entry.sequence).slice(0, take); } };
}
const query = (extra = {}) => ({ from: PERIOD.from, to: PERIOD.to, ...extra });

// Fixed versions (C's listing in round 2)
function signedVersion(recordId, versionId, at, previous, o = {}) {
  const patient = o.patient ?? P1, studyId = o.study ?? 'study-1', inst = o.inst ?? INST_X;
  const text = { kind: 'report', findings: `findings ${versionId}`, conclusion: 'conclusion', recommendation: '' };
  const sha = hex(`${recordId}:${versionId}:sha`), content = hex(JSON.stringify(text));
  const event = { eventId: `${recordId}:${versionId}`, recordId, versionId, sha256: sha, contentSha256: content, at,
    act: previous ? 'correction' : 'entry', signature: { versionId, sha256: sha, signedAt: at, verified: true },
    predecessor: previous ? { recordId, partId: previous.resolved.event.versionId, sha256: previous.resolved.event.sha256 } : null,
    components: [], processing: null };
  storedRows.set(`${recordId}:${event.eventId}`, { recordId, model: 'ReportVersion', row: {}, event });
  const resolved = C.resolveStoredRecord(caps.stored, recordId, event.eventId);
  const payload = S.canonicalPayload({ formatVersion: 'emr-signature/1',
    text,
    patient: o.signedPatient ?? patient, studyId, managingInstitutionId: inst, actingInstitutionId: inst, recordKind: 'report-version',
    recordId: o.signedRecord ?? recordId, versionId, author: id('dr-1'), signer: id('dr-1'), identityRegistrationId: 'reg-1',
    action: previous ? 'amend' : 'approve-sign', serverTime: at,
    previousVersion: previous ? { recordId: o.signedRecord ?? recordId, versionId: previous.resolved.event.versionId, sha256: previous.resolved.event.sha256 } : null,
    attachments: [], reason: previous ? 'correction of a typo' : null });
  const envelope = { protected: b64u(JSON.stringify({ alg: 'ES256', kid: 'kid-dr-1', typ: 'emr-signature+jws' })), payload: b64u(payload),
    signature: b64u(crypto.randomBytes(64)) };
  return { resolved, evidence: { versionId, envelope, publicKeyEvidenceId: 'pk-dr-1', identityEvidenceId: 'idv-dr-1' } };
}
function listingOf(recordId, versions, o = {}) {
  return { recordId, complete: o.complete ?? true, revision: o.revision ?? `rev-${versions.length}`,
    subject: { patient: o.patient ?? P1, studyId: o.study ?? 'study-1', managingInstitutionId: o.inst ?? INST_X },
    versions: versions.map(v => v.resolved), signatures: o.signatures ?? versions.map(v => v.evidence) };
}
const V1 = signedVersion('rep-1', 'v1', '2026-10-05T01:00:00.000Z', null);
const V2 = signedVersion('rep-1', 'v2', '2026-10-05T03:00:00.000Z', V1);
const V3 = signedVersion('rep-1', 'v3', '2026-10-09T02:00:00.000Z', V2);
const RECEIVED = '2026-10-09T00:30:00.000Z';
function copyRequest(o = {}) {
  return { requestId: o.requestId ?? 'copy-1', receivedAt: o.receivedAt ?? RECEIVED, patient: P1,
    basis: { clauseId: o.clauseId ?? 'medical:21.1', purpose: o.purpose ?? 'own records' },
    requester: o.requester ?? { kind: 'patient', name: 'SYN Patient One', organization: null },
    evidence: o.evidence ?? [{ kind: 'identity-check', documentId: 'id-check-1', checkedBy: id('clerk-1'), checkedAt: o.checkedAt ?? '2026-10-09T00:35:00.000Z' }],
    scope: o.scope ?? [{ recordId: 'rep-1', versions: 'all' }],
    delivery: o.delivery ?? { recipient: 'SYN Patient One', method: 'in-person', format: 'paper-print' } };
}
function militaryRequest(purpose, receivedAt) {
  return copyRequest({ clauseId: 'medical:21.3.10', purpose, receivedAt,
    requester: { kind: 'statutory-authority', name: 'SYN officer', organization: 'SYN regional military manpower office' },
    evidence: [{ kind: 'official-request', documentId: 'mma-request-1', checkedBy: id('clerk-1'), checkedAt: receivedAt }],
    delivery: { recipient: 'SYN regional military manpower office', method: 'postal', format: 'paper-print' } });
}
const PREPARED_AT = '2026-10-09T01:05:00.000Z';
function prepared(environment = 'operational', request = copyRequest()) {
  const officer = authorityFor('records-officer');
  const approval = F.approveDisclosure(officer, request, NOW);
  return { officer, issuance: F.prepareDisclosurePackage(officer, approval, [listingOf('rep-1', [V1, V2])], PREPARED_AT, environment) };
}
const artifactFor = (issuance, o = {}) => ({ sha256: hex(`bytes of ${issuance.issuanceId}`), byteLength: 2048, format: o.format ?? 'paper-print',
  generator: o.generator ?? 'server', manifestSha256: o.manifestSha256 ?? issuance.manifestSha256 });

// =====================================================================================================================
// TEST-F-01 roster_scope

test('TEST-F-01 roster_scope: a designated auditor gets exactly the granted scopes and a general admin without a grant gets none', () => {
  const reader = roster([grantOf('aud-1', INST_X, ['investigate']), grantOf('adm-2', INST_X, ['investigate', 'export'])]);
  refused(() => F.resolveAuditAuthority(reader, caller('adm-1', INST_X, ['admin']), NOW), 'AuditorNotDesignated',
    'M-F-01: a general admin without a grant gets no audit authority');
  const auditor = F.resolveAuditAuthority(reader, caller('aud-1', INST_X, ['radiologist']), NOW);
  assert.deepEqual([...auditor.scopes], ['investigate']);
  assert.equal(auditor.institutionId, INST_X);
  assert.equal(F.planInvestigation(auditor, query()).institutionId, INST_X);
  refused(() => F.planInvestigation(auditor, query(), 'export'), 'AuditScopeNotGranted', 'an investigate-only grant cannot export');
  // The admin role neither grants nor blocks: a granted admin has exactly its grant.
  const grantedAdmin = F.resolveAuditAuthority(reader, caller('adm-2', INST_X, ['admin']), NOW);
  assert.deepEqual([...grantedAdmin.scopes], ['export', 'investigate']);
  refused(() => F.approveDisclosure(grantedAdmin, copyRequest(), NOW), 'AuditScopeNotGranted', 'admin role adds no disclosure scope');
});

test('TEST-F-01 roster_scope: a revoked, expired, not-yet-valid or moved auditor gets no authority and nothing is read', async () => {
  const revoke = { kind: 'revoked', eventId: 'r-1', at: '2026-10-05T00:00:00.000Z', by: id('officer'), capacity: 'privacy-officer',
    basisDocumentId: 'appointment-1-end', reason: 'role ended' };
  const shorten = { kind: 'changed', eventId: 'c-1', at: '2026-10-02T00:00:00.000Z', by: id('officer'), capacity: 'privacy-officer',
    basisDocumentId: 'appointment-1-change', scopes: ['investigate'], validUntil: '2026-10-08T00:00:00.000Z' };
  const future = grantOf('aud-4', INST_X, ['investigate']);
  future.events[0].validFrom = '2026-11-01T00:00:00.000Z';
  const cases = [
    ['revoked', roster([grantOf('aud-1', INST_X, ['investigate'], [revoke])]), caller('aud-1')],
    ['expired by a change', roster([grantOf('aud-2', INST_X, ['investigate'], [shorten])]), caller('aud-2')],
    ['not yet valid', roster([future]), caller('aud-4')],
    ['moved to another institution', roster([grantOf('aud-5', INST_X, ['investigate'])]), caller('aud-5', INST_Y)],
    ['no institution', roster([grantOf('aud-6', INST_X, ['investigate'])]), caller('aud-6', null)],
  ];
  for (const [label, reader, who] of cases) refused(() => F.resolveAuditAuthority(reader, who, NOW), 'AuditorNotDesignated', label);
  refused(() => F.resolveAuditAuthority(roster([], s => ({ subject: s, complete: false, grants: [] })), caller('aud-1'), NOW),
    'RosterUnavailable', 'a partial roster read is not an empty roster');
  refused(() => F.resolveAuditAuthority({ listGrants: () => { throw new Error('db down'); } }, caller('aud-1'), NOW),
    'RosterUnavailable', 'a failed roster read is not an empty roster');
  refused(() => F.resolveAuditAuthority(roster([], s => ({ subject: s, complete: true, grants: [grantOf('someone-else', INST_X, ['investigate'])] })),
    caller('aud-1'), NOW), 'RosterUnavailable', 'another identity grant in the listing is refused');
  // A copied authority object is not authority, and no plan means no ledger read at all.
  const real = authorityFor('aud-7', ['investigate']);
  const forged = { ...clone(real) };
  const ledger = ledgerOf(chainRows([accessEvent()]));
  refused(() => F.planInvestigation(forged, query()), 'AuditAuthorityRequired', 'a structural copy of authority');
  await refusedAsync(() => F.readInvestigationPage({ ...F.planInvestigation(real, query()) }, ledger), 'InvestigationPlanRequired', 'a copied plan');
  assert.deepEqual(ledger.calls, { top: 0, rows: 0 });
});

test('TEST-F-01 roster_scope: client claims of auditor status, roles or institution are refused and the scope is the grant institution', () => {
  const auditor = authorityFor('aud-1', ['investigate']);
  for (const claim of [{ auditor: true }, { institutionId: INST_Y }, { institution: INST_Y }, { roles: ['auditor'] }, { scope: 'export' }]) {
    const input = query(claim), before = clone(input);
    refused(() => F.planInvestigation(auditor, input), 'ClientAuthorityClaimRefused', `claim ${Object.keys(claim)[0]}`);
    assert.deepEqual(input, before);
  }
  refused(() => F.planInvestigation(auditor, query({ unexpected: 1 })), 'InvestigationQueryRefused', 'unknown key');
  refused(() => F.planInvestigation(auditor, { from: PERIOD.to, to: PERIOD.from }), 'InvestigationQueryRefused', 'empty period');
  refused(() => F.planInvestigation(auditor, query({ limit: 501 })), 'InvestigationQueryRefused', 'page above the maximum');
  refused(() => F.planInvestigation(auditor, query({ address: 'not-an-ip' })), 'InvestigationQueryRefused', 'address must be an IP');
  refused(() => F.planInvestigation(auditor, query({ actions: ['read-everything'] })), 'InvestigationQueryRefused', 'unknown action');
  const plan = F.planInvestigation(auditor, query({ patient: { patientId: 'SYN-P1', assigningAuthority: 'hosp-x' } }));
  assert.equal(plan.institutionId, INST_X);
  assert.equal(plan.limit, 50);
});

test('TEST-F-01 roster_scope: only the institution events are counted, paged and exported and other institutions add nothing', async () => {
  const events = [];
  for (let i = 0; i < 6; i++) {
    events.push(accessEvent({ inst: INST_X, patient: P1, record: `rep-x${i}` }));
    events.push(accessEvent({ inst: INST_Y, patient: P2, record: `rep-y${i}` }));
  }
  // Refused requests resolve no record: their own member institution attributes them.
  events.push(accessEvent({ inst: INST_X, action: 'permission-refused', result: 'refused', managing: unresolved,
    targets: [{ kind: 'report-version', patientLinkSnapshot: unresolved, studyId: unresolved, recordId: unresolved, versionId: unresolved }] }));
  events.push(accessEvent({ inst: INST_Y, action: 'permission-refused', result: 'refused', managing: unresolved,
    targets: [{ kind: 'report-version', patientLinkSnapshot: unresolved, studyId: unresolved, recordId: unresolved, versionId: unresolved }] }));
  const ledger = ledgerOf(chainRows(events));
  const auditor = authorityFor('aud-1');
  const first = await F.readInvestigationPage(F.planInvestigation(auditor, query({ limit: 4 })), ledger, { batch: 3 });
  assert.equal(first.total, 7, 'M-F-02: other institutions add nothing to the count or the page');
  assert.equal(first.rows.length, 4);
  assert.ok(first.rows.every(r => r.managingInstitution.status === 'known' ? r.managingInstitution.value === INST_X : r.actingInstitution.value === INST_X));
  const second = await F.readInvestigationPage(F.planInvestigation(auditor, query({ limit: 4, after: first.nextCursor })), ledger, { batch: 3 });
  assert.equal(second.total, 7);
  assert.equal(second.nextCursor, null);
  const sequences = [...first.rows, ...second.rows].map(r => r.sequence);
  assert.equal(new Set(sequences).size, 7);
  const exported = await F.readInvestigationPage(F.planInvestigation(auditor, query(), 'export'), ledger);
  assert.equal(exported.total, 7);
  assert.deepEqual(exported.rows.map(r => r.sequence), [...sequences].sort((a, b) => b - a));
  const other = await F.readInvestigationPage(F.planInvestigation(authorityFor('aud-y', ALL_SCOPES, INST_Y), query(), 'export'), ledger);
  assert.equal(other.total, 7);
  assert.ok(other.rows.every(r => !r.targets.some(t => t.patient.status === 'known' && t.patient.value.patientId === 'SYN-P1')));
});

test('TEST-F-01 roster_scope: every grant change is rights history kept three years on its own clock apart from the access ledger', () => {
  const change = { kind: 'changed', eventId: 'c-2', at: '2026-12-01T00:00:00.000Z', by: id('officer'), capacity: 'institution-representative',
    basisDocumentId: 'appointment-2', scopes: ['investigate', 'inspection'], validUntil: null };
  const revoke = { kind: 'revoked', eventId: 'r-2', at: '2027-02-01T00:00:00.000Z', by: id('officer'), capacity: 'privacy-officer',
    basisDocumentId: 'appointment-3', reason: 'left the role' };
  const grant = grantOf('aud-1', INST_X, ['investigate'], [change, revoke]);
  for (const e of grant.events) {
    assert.equal(F.rightsHistoryKeptUntil(e), D.civilPeriodEnd(e.at, 3));
    assert.notEqual(F.rightsHistoryKeptUntil(e), D.civilPeriodEnd(e.at, 2));
  }
  // The history replays the grant at any past moment (who could audit when).
  assert.deepEqual([...F.grantStateAt(grant, '2026-11-01T00:00:00.000Z').scopes], ['investigate']);
  assert.deepEqual([...F.grantStateAt(grant, '2027-01-01T00:00:00.000Z').scopes], ['investigate', 'inspection']);
  assert.equal(F.grantStateAt(grant, '2027-03-01T00:00:00.000Z').active, false);
  const malformed = [
    { ...grant, events: [change] },
    { ...grant, events: [grant.events[0], revoke, change] },
    { ...grant, events: [{ ...grant.events[0], capacity: 'admin' }] },
    { ...grant, events: [{ ...grant.events[0], scopes: [] }] },
    { ...grant, events: [{ ...grant.events[0], basisDocumentId: '' }] },
    { ...grant, events: [{ ...grant.events[0], scopes: ['investigate', 'everything'] }] },
  ];
  for (const g of malformed) refused(() => F.grantStateAt(g, NOW), 'RosterHistoryRefused', 'malformed rights history');
});

// =====================================================================================================================
// TEST-F-02 patient_replay

function rematchLedger() {
  const e1 = accessEvent({ surface: 'POST studies/:uid/report/commit', action: 'approve-sign', result: 'succeeded', patient: P1, version: 'v1',
    at: '2026-10-05T01:00:00.000Z' });
  const e2 = accessEvent({ patient: P1, version: 'v1', at: '2026-10-05T02:00:00.000Z' });
  // The study is re-matched to another patient; later events carry the new snapshot.
  const e3 = accessEvent({ patient: P2, version: 'v2', at: '2026-10-06T02:00:00.000Z' });
  return { e1, e2, e3, ledger: ledgerOf(chainRows([e1, e2, e3])) };
}
const currentLink = studyId => (studyId === 'study-1' ? P2 : null);

test('TEST-F-02 patient_replay: replay keeps each event recorded patient, institutions, version and times after a re-match', async () => {
  const { e1, e2, ledger } = rematchLedger();
  const auditor = authorityFor('aud-1');
  const plan = F.planInvestigation(auditor, query({ patient: { patientId: 'SYN-P1', assigningAuthority: 'hosp-x' } }), 'export');
  const page = await F.readInvestigationPage(plan, ledger, { currentLink });
  assert.ok(page.rows.every(r => r.targets.every(t => JSON.stringify(t.patient) === JSON.stringify(known(P1)))),
    'M-F-03: past events stay attributed to the patient they recorded');
  assert.deepEqual(page.rows.map(r => r.eventId), [e2.eventId, e1.eventId]);
  for (const row of page.rows) {
    const t = row.targets[0];
    assert.equal(t.rematched, true);
    assert.deepEqual(t.currentLink, P2);
    assert.deepEqual(t.versionId, known('v1'));
    assert.deepEqual(row.managingInstitution, known(INST_X));
    assert.deepEqual(row.actingInstitution, known(INST_X));
    assert.equal(row.channel, 'online');
  }
  assert.equal(page.rows[1].occurredAt, e1.occurredAt);
  assert.equal(page.rows[1].committedAt, new Date(Date.parse(e1.occurredAt) + 1000).toISOString());
  assert.equal(page.rows[1].statutoryAct, '기재');
  assert.equal(page.rows[0].statutoryAct, '열람');
});

test('TEST-F-02 patient_replay: the new patient finds only its own recorded events and a multi-target event shows only the investigated patient', async () => {
  const { e3, ledger } = rematchLedger();
  const auditor = authorityFor('aud-1');
  const byNew = await F.readInvestigationPage(F.planInvestigation(auditor, query({ patient: { patientId: 'SYN-P2', assigningAuthority: 'hosp-x' } }), 'export'), ledger);
  assert.deepEqual(byNew.rows.map(r => r.eventId), [e3.eventId]);
  const list = accessEvent({ surface: 'GET studies', targets: [target(P1, 'study-1', 'study-1', 'meta-1', 'study-metadata'),
    target(P3, 'study-3', 'study-3', 'meta-3', 'study-metadata')] });
  const listLedger = ledgerOf(chainRows([list]));
  const shown = await F.readInvestigationPage(F.planInvestigation(auditor, query({ patient: { patientId: 'SYN-P1', assigningAuthority: 'hosp-x' } }), 'export'), listLedger);
  assert.equal(shown.rows.length, 1);
  assert.deepEqual(shown.rows[0].targets.map(t => t.patient.value.patientId), ['SYN-P1']);
  const everything = await F.readInvestigationPage(F.planInvestigation(auditor, query(), 'export'), listLedger);
  assert.equal(everything.rows[0].targets.length, 2);
  const otherAuthority = await F.readInvestigationPage(F.planInvestigation(auditor,
    query({ patient: { patientId: 'SYN-P1', assigningAuthority: 'other-hospital' } }), 'export'), listLedger);
  assert.equal(otherAuthority.total, 0);
});

test('TEST-F-02 patient_replay: a stored event whose patient or version was rewritten fails its chain hash and nothing is shown', async () => {
  const { ledger } = rematchLedger();
  const auditor = authorityFor('aud-1');
  const plan = () => F.planInvestigation(auditor, query(), 'export');
  const rewritePatient = clone(ledger.data);
  rewritePatient[0].entry.payload.event.targets[0].patientLinkSnapshot.value = P2;
  await refusedAsync(() => F.readInvestigationPage(plan(), ledgerOf(rewritePatient)), 'LedgerRowIntegrityRefused', 'rewritten patient');
  const rewriteVersion = clone(ledger.data);
  rewriteVersion[1].entry.payload.event.targets[0].versionId.value = 'v9';
  await refusedAsync(() => F.readInvestigationPage(plan(), ledgerOf(rewriteVersion)), 'LedgerRowIntegrityRefused', 'rewritten version');
  const rewriteInstitution = clone(ledger.data);
  rewriteInstitution[2].entry.payload.event.managingInstitution.value = INST_Y;
  await refusedAsync(() => F.readInvestigationPage(plan(), ledgerOf(rewriteInstitution)), 'LedgerRowIntegrityRefused', 'rewritten institution');
  const checkpoint = clone(ledger.data);
  checkpoint[2].entry.payload = { kind: 'expiry', event: checkpoint[2].entry.payload.event };
  await refusedAsync(() => F.readInvestigationPage(plan(), ledgerOf(checkpoint)), 'LedgerRowIntegrityRefused', 'a non-access chain entry');
  const original = await F.readInvestigationPage(plan(), ledger);
  assert.equal(original.total, 3);
});

test('TEST-F-02 patient_replay: refused, aborted and conflict events are replayed as such and filtered by action, result and address', async () => {
  const prepared = accessEvent({ address: '10.0.0.7' });
  const aborted = accessEvent({ action: 'transfer-aborted', result: 'aborted', related: prepared.eventId, address: '10.0.0.7' });
  const conflict = accessEvent({ surface: 'POST studies/:uid/report/commit', action: 'conflict', result: 'failed' });
  const denied = accessEvent({ action: 'permission-refused', result: 'refused', managing: unresolved, ip: unresolved,
    targets: [{ kind: 'report-version', patientLinkSnapshot: unresolved, studyId: unresolved, recordId: unresolved, versionId: unresolved }] });
  const ledger = ledgerOf(chainRows([prepared, aborted, conflict, denied]));
  const auditor = authorityFor('aud-1');
  const read = async q => (await F.readInvestigationPage(F.planInvestigation(auditor, query(q), 'export'), ledger)).rows;
  const all = await read({});
  assert.deepEqual(all.map(r => r.result), ['refused', 'failed', 'aborted', 'prepared']);
  assert.equal(all[0].channel, 'unresolved');
  assert.equal(all[0].statutoryAct, 'none');
  assert.equal(all[2].relatedEventId, prepared.eventId);
  assert.deepEqual((await read({ results: ['refused'] })).map(r => r.eventId), [denied.eventId]);
  assert.deepEqual((await read({ actions: ['transfer-aborted', 'conflict'] })).map(r => r.eventId), [conflict.eventId, aborted.eventId]);
  assert.deepEqual((await read({ address: '10.0.0.7' })).map(r => r.eventId), [aborted.eventId, prepared.eventId]);
  assert.deepEqual((await read({ actorId: 'nobody' })), []);
});

test('TEST-F-02 patient_replay: a source failure, misordered or out-of-snapshot row is an error and never an empty or short result', async () => {
  const rows = chainRows([accessEvent(), accessEvent(), accessEvent()]);
  const auditor = authorityFor('aud-1');
  const plan = () => F.planInvestigation(auditor, query(), 'export');
  const base = ledgerOf(rows);
  const variants = [
    ['top fails', { ...base, top: async () => { throw new Error('db'); } }, 'LedgerReadFailed'],
    ['rows fail', { ...base, rows: async () => { throw new Error('db'); } }, 'LedgerReadFailed'],
    ['not a list', { ...base, rows: async () => null }, 'LedgerReadFailed'],
    ['more than asked', { ...base, rows: async () => [...rows].reverse().concat([...rows].reverse()) }, 'LedgerReadFailed'],
    ['ascending', { ...base, rows: async () => [...rows] }, 'LedgerSourceOrderRefused'],
    ['above the snapshot', { ...base, top: async () => 2 }, 'LedgerSourceOrderRefused'],
  ];
  variants[5][1].rows = async () => [...rows].reverse();
  for (const [label, ledger, code] of variants) await refusedAsync(() => F.readInvestigationPage(plan(), ledger, { batch: 4 }), code, label);
  const empty = await F.readInvestigationPage(plan(), ledgerOf([]));
  assert.deepEqual([empty.total, empty.rows.length, empty.top], [0, 0, 0]);
});

test('TEST-F-02 patient_replay: a sealed cursor continues the same snapshot without duplicates or gaps and another plan, auditor or forged cursor is refused', async () => {
  const rows = chainRows([1, 2, 3, 4, 5].map(() => accessEvent()));
  const ledger = ledgerOf(rows);
  const auditor = authorityFor('aud-1');
  const first = await F.readInvestigationPage(F.planInvestigation(auditor, query({ limit: 2 })), ledger);
  assert.equal(first.total, 5);
  // Rows committed after the first page do not move later pages.
  ledger.data.push(...chainRows([accessEvent(), accessEvent()], rows).slice(rows.length));
  const second = await F.readInvestigationPage(F.planInvestigation(auditor, query({ limit: 2, after: first.nextCursor })), ledger);
  const third = await F.readInvestigationPage(F.planInvestigation(auditor, query({ limit: 2, after: second.nextCursor })), ledger);
  assert.deepEqual([second.total, third.total, third.nextCursor], [5, 5, null]);
  assert.deepEqual([...first.rows, ...second.rows, ...third.rows].map(r => r.sequence), [5, 4, 3, 2, 1]);
  const tampered = first.nextCursor.slice(0, -2) + (first.nextCursor.endsWith('AA') ? 'BB' : 'AA');
  const misuse = [
    ['another filter', F.planInvestigation(auditor, query({ limit: 2, results: ['prepared'], after: first.nextCursor }))],
    ['another page size', F.planInvestigation(auditor, query({ limit: 3, after: first.nextCursor }))],
    ['another auditor', F.planInvestigation(authorityFor('aud-2'), query({ limit: 2, after: first.nextCursor }))],
    ['tampered seal', F.planInvestigation(auditor, query({ limit: 2, after: tampered }))],
    ['garbage', F.planInvestigation(auditor, query({ limit: 2, after: 'not-a-cursor' }))],
  ];
  for (const [label, plan] of misuse) await refusedAsync(() => F.readInvestigationPage(plan, ledger), 'InvestigationCursorRefused', label);
  refused(() => F.planInvestigation(auditor, query({ after: first.nextCursor }), 'export'), 'InvestigationQueryRefused', 'an export has no page');
});

test('TEST-F-02 patient_replay: the investigation is itself an access event for exactly the rows shown and an export is a download', async () => {
  const { e1, e2, ledger } = rematchLedger();
  const auditor = authorityFor('aud-1');
  const page = await F.readInvestigationPage(F.planInvestigation(auditor, query({ patient: { patientId: 'SYN-P1', assigningAuthority: 'hosp-x' } })), ledger);
  const event = F.investigationLedgerEvent(page);
  assert.equal(event.action, 'provide-prepared');
  assert.deepEqual(event.targets.map(t => t.recordId.value).sort(), [e1.eventId, e2.eventId].sort());
  assert.ok(event.targets.every(t => t.kind === 'access-audit' && t.patientLinkSnapshot.value.patientId === 'SYN-P1'));
  const parsed = AE.parseAccessEvent({ formatVersion: 1, surface: 'GET admin/audit', eventId: 'audit-view-1', userId: known(id('aud-1')),
    rolesAtTime: known(['staff']), actingInstitution: known(INST_X), managingInstitution: known(INST_X), occurredAt: NOW,
    trustedProxyIp: known({ address: '10.0.0.9', source: 'trusted-proxy' }), cause: 'user-view', executor: 'member', targets: event.targets,
    action: event.action, result: 'prepared', requestId: 'audit-view-request', auditLinkId: `audit:${crypto.randomUUID()}`, relatedEventId: null });
  assert.equal(parsed.targets.length, 2);
  const exported = await F.readInvestigationPage(F.planInvestigation(auditor, query(), 'export'), ledger);
  assert.equal(F.investigationLedgerEvent(exported).action, 'download');
  refused(() => F.investigationLedgerEvent({ ...page }), 'InvestigationPageRequired', 'a page not read by the contract');
});

// =====================================================================================================================
// TEST-F-03 lawful_issue

test('TEST-F-03 lawful_issue: a patient own request prepares every version with the verification material of each signed version', () => {
  const officer = authorityFor('records-officer');
  const request = copyRequest(), before = clone(request);
  const approval = F.approveDisclosure(officer, request, NOW);
  assert.deepEqual(request, before);
  assert.deepEqual(approval.basis, { clauseId: 'medical:21.1', law: 'medical', article: '21.1', publication: '21524', effectiveAt: '2026-04-07' });
  const issuance = F.prepareDisclosurePackage(officer, approval, [listingOf('rep-1', [V1, V2])], PREPARED_AT);
  const record = issuance.manifest.records[0];
  assert.equal(record.selection, 'all-versions');
  assert.deepEqual(record.versions.map(v => v.versionId), ['v1', 'v2']);
  assert.deepEqual(record.versions[1].predecessor, { versionId: 'v1', sha256: V1.resolved.event.sha256 });
  assert.ok(record.versions.every(v => v.signature && v.signature.keyId === 'kid-dr-1' && v.signature.publicKeyEvidenceId === 'pk-dr-1' &&
    v.signature.identityEvidenceId === 'idv-dr-1' && /^[0-9a-f]{64}$/.test(v.signature.envelopeSha256)));
  assert.deepEqual(record.head, { versionId: 'v2', sha256: V2.resolved.event.sha256 });
  assert.equal(issuance.manifest.approvedBy.id, 'records-officer');
  assert.match(issuance.manifestSha256, /^[0-9a-f]{64}$/);
  assert.equal(F.issuanceState(issuance).state, 'Prepared');
});

test('TEST-F-03 lawful_issue: a military manpower request is judged by the wording in force when it arrived', () => {
  const officer = authorityFor('records-officer');
  // 2026-12-09 23:59:59.999 KST: 제21조③10 does not yet name 확인신체검사.
  refused(() => F.approveDisclosure(officer, militaryRequest('confirmation-examination', '2026-12-09T14:59:59.999Z'), '2026-12-10T01:00:00.000Z'),
    'DisclosurePurposeNotInForce', 'M-F-05: a future clause is not applied before it is in force');
  const fromTenth = F.approveDisclosure(officer, militaryRequest('confirmation-examination', '2026-12-09T15:00:00.000Z'), '2026-12-10T01:00:00.000Z');
  assert.equal(fromTenth.basis.publication, '21776');
  const today = F.approveDisclosure(officer, militaryRequest('conscription-examination', RECEIVED), NOW);
  assert.equal(today.basis.publication, '21524');
  refused(() => F.approveDisclosure(officer, militaryRequest('conscription-examination', '2026-04-06T14:59:59.999Z'), NOW),
    'DisclosureBasisVersionUnknown', 'a receipt before the first reviewed wording');
  refused(() => F.approveDisclosure(officer, copyRequest({ clauseId: 'medical:21.3.99' }), NOW), 'DisclosureBasisUnknown', 'unknown clause');
  refused(() => F.approveDisclosure(officer, militaryRequest('anything', RECEIVED), NOW), 'DisclosurePurposeNotInForce', 'unlisted purpose');
});

test('TEST-F-03 lawful_issue: family, agent and statutory requests need their own qualification evidence and anything missing is refused before any package', () => {
  const officer = authorityFor('records-officer');
  const checked = kind => ({ kind, documentId: `${kind}-doc`, checkedBy: id('clerk-1'), checkedAt: '2026-10-09T00:40:00.000Z' });
  const family = { kind: 'family', name: 'SYN Spouse', organization: null };
  const ok = F.approveDisclosure(officer, copyRequest({ clauseId: 'medical:21.3.1', requester: family,
    evidence: [checked('identity-check'), checked('patient-consent'), checked('relationship-proof')] }), NOW);
  assert.equal(ok.basis.article, '21.3.1');
  const cases = [
    ['no patient consent', copyRequest({ clauseId: 'medical:21.3.1', requester: family, evidence: [checked('identity-check'), checked('relationship-proof')] }), 'QualificationEvidenceMissing'],
    ['agent under the family clause', copyRequest({ clauseId: 'medical:21.3.1', requester: { kind: 'designated-agent', name: 'SYN Agent', organization: null },
      evidence: [checked('identity-check'), checked('patient-consent'), checked('relationship-proof')] }), 'RequesterNotQualified'],
    ['agent without proof of agency', copyRequest({ clauseId: 'medical:21.3.2', requester: { kind: 'designated-agent', name: 'SYN Agent', organization: null },
      evidence: [checked('identity-check'), checked('patient-consent')] }), 'QualificationEvidenceMissing'],
    ['statutory without its authority', copyRequest({ clauseId: 'medical:21.3.6', requester: { kind: 'statutory-authority', name: 'SYN', organization: null },
      evidence: [checked('official-request')] }), 'RequesterNotQualified'],
    ['evidence checked before the request', copyRequest({ checkedAt: '2026-10-09T00:00:00.000Z' }), 'QualificationEvidenceMissing'],
    ['an unsigned electronic copy', copyRequest({ delivery: { recipient: 'SYN', method: 'electronic', format: 'paper-print' } }), 'SignedElectronicDocumentRequired'],
    ['a signed file handed as paper', copyRequest({ delivery: { recipient: 'SYN', method: 'postal', format: 'signed-electronic' } }), 'SignedElectronicDocumentRequired'],
    ['no scope', copyRequest({ scope: [] }), 'DisclosureRequestRefused'],
  ];
  for (const [label, request, code] of cases) {
    const before = clone(request);
    refused(() => F.approveDisclosure(officer, request, NOW), code, label);
    assert.deepEqual(request, before);
  }
  refused(() => F.approveDisclosure(authorityFor('aud-1', ['investigate']), copyRequest(), NOW), 'AuditScopeNotGranted', 'no disclosure scope');
  refused(() => F.prepareDisclosurePackage(officer, { ...ok }, [listingOf('rep-1', [V1, V2])], PREPARED_AT), 'DisclosureApprovalRequired', 'a copied approval');
});

test('TEST-F-03 lawful_issue: the default is the whole record and a requester-specified part stays exact while incomplete or foreign listings are refused', () => {
  const officer = authorityFor('records-officer');
  const part = F.prepareDisclosurePackage(officer, F.approveDisclosure(officer, copyRequest({ scope: [{ recordId: 'rep-1', versions: ['v2'] }] }), NOW),
    [listingOf('rep-1', [V1, V2])], PREPARED_AT);
  assert.equal(part.manifest.records[0].selection, 'requester-specified');
  assert.deepEqual(part.manifest.records[0].versions.map(v => v.versionId), ['v2']);
  const approval = F.approveDisclosure(officer, copyRequest(), NOW);
  const other = signedVersion('rep-2', 'v1', '2026-10-05T01:00:00.000Z', null, { patient: P2 });
  const foreignSigned = signedVersion('rep-4', 'v1', '2026-10-05T01:00:00.000Z', null, { signedRecord: 'rep-other' });
  const cases = [
    ['incomplete listing', [listingOf('rep-1', [V1, V2], { complete: false })], 'VersionListingIncomplete'],
    ['the original is missing', [listingOf('rep-1', [V2])], 'VersionListingIncomplete'],
    ['a version not resolved by the server', [{ ...listingOf('rep-1', [V1, V2]), versions: [clone(V1.resolved), clone(V2.resolved)] }], 'StoredRecordRequired'],
    ['a subject the signed versions contradict', [listingOf('rep-1', [V1, V2], { patient: P2 })], 'SignatureEvidenceMismatch'],
    ['a signed version without its evidence', [listingOf('rep-1', [V1, V2], { signatures: [V1.evidence] })], 'SignatureEvidenceRequired'],
    ['evidence of another record', [{ ...listingOf('rep-1', [V1, V2]), signatures: [V1.evidence, { ...foreignSigned.evidence, versionId: 'v2' }] }], 'SignatureEvidenceMismatch'],
    ['a listing that was not requested', [listingOf('rep-1', [V1, V2]), listingOf('rep-2', [other], { patient: P2 })], 'VersionListingRefused'],
    ['the requested record is missing', [], 'VersionListingRefused'],
  ];
  for (const [label, listings, code] of cases) refused(() => F.prepareDisclosurePackage(officer, approval, listings, PREPARED_AT), code, label);
  // The record named in the request belongs to another patient or institution: no package for this requester.
  const foreignInstitution = signedVersion('rep-7', 'v1', '2026-10-05T01:00:00.000Z', null, { inst: INST_Y });
  for (const [label, recordId, listing] of [['another patient record', 'rep-2', listingOf('rep-2', [other], { patient: P2 })],
    ['another institution record', 'rep-7', listingOf('rep-7', [foreignInstitution], { inst: INST_Y })]]) {
    const scoped = F.approveDisclosure(officer, copyRequest({ scope: [{ recordId, versions: 'all' }] }), NOW);
    refused(() => F.prepareDisclosurePackage(officer, scoped, [listing], PREPARED_AT), 'DisclosureSubjectMismatch', label);
  }
});

test('TEST-F-03 lawful_issue: a record head that moved after preparation refuses issuance and nothing is issued', () => {
  const { officer, issuance } = prepared();
  const before = clone(issuance);
  refused(() => F.issueDisclosure(officer, issuance, { artifact: artifactFor(issuance), listings: [listingOf('rep-1', [V1, V2, V3])], at: '2026-10-09T03:00:00.000Z' }),
    'RecordHeadChanged', 'a new version since preparation');
  refused(() => F.issueDisclosure(officer, issuance, { artifact: artifactFor(issuance), listings: [listingOf('rep-1', [V1, V2], { revision: 'rev-9' })], at: '2026-10-09T03:00:00.000Z' }),
    'RecordHeadChanged', 'another stored revision');
  assert.deepEqual(issuance, before);
  assert.equal(F.issuanceState(issuance).state, 'Prepared');
  const issued = F.issueDisclosure(officer, issuance, { artifact: artifactFor(issuance), listings: [listingOf('rep-1', [V1, V2])], at: '2026-10-09T03:00:00.000Z' });
  assert.equal(F.issuanceState(issued).state, 'Issued');
});

test('TEST-F-03 lawful_issue: the disclosure ledger event built from the package is a valid A event on the authorized-disclosure surface', () => {
  const { issuance } = prepared();
  const targets = F.disclosureLedgerTargets(issuance);
  assert.equal(targets.length, 2);
  const parsed = AE.parseAccessEvent({ formatVersion: 1, surface: 'authorized-disclosure', eventId: 'disclosure-1', userId: known(id('records-officer')),
    rolesAtTime: known(['staff']), actingInstitution: known(INST_X), managingInstitution: known(INST_X), occurredAt: '2026-10-09T03:00:00.000Z',
    trustedProxyIp: known({ address: '10.0.0.9', source: 'trusted-proxy' }), cause: 'user-view', executor: 'member', targets,
    action: 'disclosure', result: 'succeeded', requestId: 'copy-1', auditLinkId: `audit:${crypto.randomUUID()}`, relatedEventId: null });
  assert.deepEqual(parsed.targets.map(t => [t.kind, t.recordId.value, t.versionId.value, t.patientLinkSnapshot.value.patientId]),
    [['disclosure', 'rep-1', 'v1', 'SYN-P1'], ['disclosure', 'rep-1', 'v2', 'SYN-P1']]);
  assert.equal(AE.STATUTORY_ACT[parsed.action], '열람');
});

// =====================================================================================================================
// TEST-F-04 issuance_result

test('TEST-F-04 issuance_result: Issued needs server bytes bound to the manifest and a designated issuer while a print window or client PDF never issues', () => {
  const { officer, issuance } = prepared();
  const opened = F.recordClientObservation(issuance, { observation: 'print-opened', eventId: 'evt-print-1', at: '2026-10-09T02:00:00.000Z' });
  assert.equal(F.issuanceState(opened).state, 'Prepared', 'M-F-04: a print window is not an issued copy');
  const pdf = F.recordClientObservation(opened, { observation: 'pdf-reported', eventId: 'evt-pdf-1', at: '2026-10-09T02:01:00.000Z' });
  assert.equal(F.issuanceState(pdf).state, 'Prepared');
  refused(() => F.recordDelivery(officer, pdf, { outcome: 'delivered', evidence: { kind: 'staff-attested-handover', evidenceId: 'h-1' }, note: null, at: '2026-10-09T02:02:00.000Z' }),
    'IssuedRequired', 'delivery before issue');
  const at = '2026-10-09T03:00:00.000Z', listings = [listingOf('rep-1', [V1, V2])];
  for (const [label, artifact] of [['client-generated bytes', artifactFor(issuance, { generator: 'client' })],
    ['bytes of another manifest', artifactFor(issuance, { manifestSha256: hex('other') })], ['another format', artifactFor(issuance, { format: 'signed-electronic' })]])
    refused(() => F.issueDisclosure(officer, pdf, { artifact, listings, at }), 'IssuedArtifactRequired', label);
  refused(() => F.issueDisclosure(authorityFor('aud-1', ['investigate']), pdf, { artifact: artifactFor(issuance), listings, at }), 'AuditScopeNotGranted', 'not a designated issuer');
  refused(() => F.issueDisclosure(authorityFor('records-y', ALL_SCOPES, INST_Y), pdf, { artifact: artifactFor(issuance), listings, at }), 'AuditScopeNotGranted', 'another institution');
  const issued = F.issueDisclosure(officer, pdf, { artifact: artifactFor(issuance), listings, at });
  const state = F.issuanceState(issued);
  assert.equal(state.state, 'Issued');
  assert.equal(state.issuedArtifactSha256, artifactFor(issuance).sha256);
  const printed = F.recordClientObservation(issued, { observation: 'print-done', eventId: 'evt-print-2', at: '2026-10-09T03:01:00.000Z' });
  assert.equal(F.issuanceState(printed).state, 'Issued');
});

function issuedCopy(environment = 'operational', request) {
  const { officer, issuance } = prepared(environment, request);
  return { officer, issued: F.issueDisclosure(officer, issuance, { artifact: artifactFor(issuance, { format: issuance.manifest.delivery.format }),
    listings: [listingOf('rep-1', [V1, V2])], at: '2026-10-09T03:00:00.000Z' }) };
}

test('TEST-F-04 issuance_result: Delivered needs real handover or receipt evidence while an unknown outcome is ReceiptUnknown and a failure is DeliveryFailed', () => {
  const { officer, issued } = issuedCopy('operational', copyRequest({ delivery: { recipient: 'SYN Patient One', method: 'postal', format: 'paper-print' } }));
  const at = n => `2026-10-1${n}T00:00:00.000Z`;
  refused(() => F.recordDelivery(officer, issued, { outcome: 'delivered', evidence: null, note: null, at: at(0) }), 'DeliveryEvidenceRequired', 'no evidence');
  refused(() => F.recordDelivery(officer, issued, { outcome: 'delivered', evidence: { kind: 'electronic-receipt', evidenceId: 'r' }, note: null, at: at(0) }),
    'DeliveryEvidenceRequired', 'evidence of another channel');
  refused(() => F.recordDelivery(officer, issued, { outcome: 'delivered', evidence: { kind: 'staff-attested-handover', evidenceId: 'h' }, note: null, at: at(0) }),
    'DeliveryEvidenceRequired', 'a hand-over attested for a postal copy');
  refused(() => F.recordDelivery(officer, issued, { outcome: 'unknown', evidence: null, note: null, at: at(0) }), 'DeliveryEvidenceRequired', 'unknown without why');
  const unknown = F.recordDelivery(officer, issued, { outcome: 'unknown', evidence: null, note: 'posted, no receipt yet', at: at(1) });
  assert.equal(F.issuanceState(unknown).state, 'ReceiptUnknown');
  const delivered = F.recordDelivery(officer, unknown, { outcome: 'delivered', evidence: { kind: 'recipient-signed-receipt', evidenceId: 'receipt-1' }, note: null, at: at(2) });
  assert.deepEqual(F.issuanceState(delivered).delivery, { outcome: 'delivered', detection: 'recorded-evidence' });
  assert.equal(F.issuanceState(delivered).state, 'Delivered');
  const failed = F.recordDelivery(officer, issued, { outcome: 'failed', evidence: { kind: 'returned-mail', evidenceId: 'return-1' }, note: null, at: at(1) });
  assert.equal(F.issuanceState(failed).state, 'DeliveryFailed');
  const retried = F.recordDelivery(officer, failed, { outcome: 'delivered', evidence: { kind: 'recipient-signed-receipt', evidenceId: 'receipt-2' }, note: null, at: at(3) });
  assert.equal(F.issuanceState(retried).state, 'Delivered');
  refused(() => F.recordDelivery(officer, delivered, { outcome: 'delivered', evidence: { kind: 'recipient-signed-receipt', evidenceId: 'again' }, note: null, at: at(4) }),
    'IssuedRequired', 'a second delivery after Delivered');
});

test('TEST-F-04 issuance_result: a paper handover is the staff attestation and not a detection and synthetic recipients never count as operational', () => {
  const { officer, issued } = issuedCopy();
  const handed = F.recordDelivery(officer, issued, { outcome: 'delivered', evidence: { kind: 'staff-attested-handover', evidenceId: 'handover-1' }, note: null,
    at: '2026-10-09T04:00:00.000Z' });
  const state = F.issuanceState(handed);
  assert.deepEqual([state.state, state.delivery.detection], ['Delivered', 'staff-attested']);
  assert.equal(handed.events[handed.events.length - 1].by.id, 'records-officer');
  const synthetic = issuedCopy('synthetic-test');
  const syntheticDelivered = F.recordDelivery(synthetic.officer, synthetic.issued, { outcome: 'delivered',
    evidence: { kind: 'staff-attested-handover', evidenceId: 'syn-handover' }, note: null, at: '2026-10-09T04:00:00.000Z' });
  const summary = F.issuanceSummary([syntheticDelivered, prepared().issuance]);
  assert.deepEqual([summary.operational.Delivered, summary.operational.Prepared, summary['synthetic-test'].Delivered], [0, 1, 1]);
  const relabelled = { ...syntheticDelivered, environment: 'operational' };
  refused(() => F.issuanceSummary([relabelled]), 'IssuanceEnvironmentMismatch',
    'M-F-S3: relabelling a synthetic issuance cannot make operational evidence');
  refused(() => F.issuanceState({ ...syntheticDelivered, environment: 'production' }), 'IssuanceRecordRefused', 'an unknown environment');
});

test('TEST-F-04 issuance_result: Closed only after a delivery outcome with a reason when not delivered and abort only before issue on an append-only history', () => {
  const { officer, issued } = issuedCopy();
  const later = '2026-10-10T00:00:00.000Z';
  refused(() => F.closeIssuance(officer, issued, { reason: 'done', at: later }), 'IssuanceTransitionRefused', 'close an undelivered issue');
  refused(() => F.abortIssuance(officer, issued, { reason: 'changed mind', at: later }), 'IssuanceTransitionRefused', 'abort after issue');
  const unknown = F.recordDelivery(officer, issued, { outcome: 'unknown', evidence: null, note: 'no answer', at: later });
  refused(() => F.closeIssuance(officer, unknown, { reason: null, at: '2026-10-11T00:00:00.000Z' }), 'ClosingReasonRequired', 'close unknown without a reason');
  const closed = F.closeIssuance(officer, unknown, { reason: 'requester confirmed by phone', at: '2026-10-11T00:00:00.000Z' });
  assert.equal(F.issuanceState(closed).state, 'Closed');
  refused(() => F.recordClientObservation(closed, { observation: 'print-opened', eventId: 'e', at: '2026-10-12T00:00:00.000Z' }), 'IssuanceTransitionRefused', 'after Closed');
  assert.equal(unknown.events.length, issued.events.length + 1);
  assert.equal(closed.events.length, unknown.events.length + 1);
  const { officer: other, issuance } = prepared();
  const aborted = F.abortIssuance(other, issuance, { reason: 'request withdrawn', at: later });
  assert.equal(F.issuanceState(aborted).state, 'Aborted');
  refused(() => F.issuanceState({ ...closed, events: closed.events.filter(e => e.kind !== 'issued') }), 'IssuedRequired', 'history without its issue');
  refused(() => F.issuanceState({ ...closed, manifest: { ...closed.manifest, purpose: 'edited' } }), 'IssuanceManifestMismatch', 'edited manifest');
  refused(() => F.issuanceState({ ...closed, events: [...closed.events].reverse() }), 'IssuanceTransitionRefused', 'reordered history');
});

// =====================================================================================================================
// TEST-F-05 followup

const OCT_END = '2026-10-31T15:00:00.000Z'; // 2026-11-01 00:00 KST
function reportedCycle(downloadEventIds = [], at = OCT_END) {
  return F.recordInspectionReport(F.newInspectionCycle(INST_X, '2026-10'), { reportSha256: hex('report'), eventCount: 40, downloadEventIds }, at);
}

test('TEST-F-05 followup: an automatically generated monthly report is not an inspection and a designated reviewer completes it', () => {
  const inspector = authorityFor('inspector-1', ['inspection']);
  const cycle = reportedCycle();
  assert.equal(F.inspectionStatus(cycle).state, 'report-only', 'M-F-07: a generated report alone is not a completed inspection');
  refused(() => F.recordInspectionStep(inspector, cycle, { kind: 'closed', at: '2026-11-02T00:00:00.000Z' }), 'HumanReviewRequired', 'close without review');
  refused(() => F.recordInspectionReport(F.newInspectionCycle(INST_X, '2026-10'), { reportSha256: hex('r'), eventCount: 1, downloadEventIds: [] },
    '2026-10-31T14:59:59.999Z'), 'InspectionMonthNotEnded', 'report before the month ends');
  refused(() => F.recordInspectionReport(cycle, { reportSha256: hex('r2'), eventCount: 1, downloadEventIds: [] }, '2026-11-02T00:00:00.000Z'),
    'InspectionReportExists', 'a second report');
  refused(() => F.recordInspectionStep(authorityFor('aud-1', ['investigate']), cycle, { kind: 'reviewed', at: '2026-11-02T00:00:00.000Z', conclusion: 'no-anomaly', note: null }),
    'AuditScopeNotGranted', 'no inspection scope');
  refused(() => F.recordInspectionStep(inspector, cycle, { kind: 'reviewed', at: '2026-11-02T00:00:00.000Z', conclusion: 'no-anomaly', note: null, by: id('someone') }),
    'InspectionStepRefused', 'a step naming its own actor');
  refused(() => F.recordInspectionStep(inspector, cycle, { kind: 'report-generated', at: '2026-11-02T00:00:00.000Z' }), 'InspectionStepRefused', 'a person posing as the generator');
  const reviewed = F.recordInspectionStep(inspector, cycle, { kind: 'reviewed', at: '2026-11-02T00:00:00.000Z', conclusion: 'no-anomaly', note: null });
  assert.equal(F.inspectionStatus(reviewed).state, 'ready-to-close');
  assert.equal(reviewed.events[reviewed.events.length - 1].by.id, 'inspector-1');
  const closed = F.recordInspectionStep(inspector, reviewed, { kind: 'closed', at: '2026-11-02T01:00:00.000Z' });
  assert.equal(F.inspectionStatus(closed).state, 'closed');
  refused(() => F.recordInspectionStep(inspector, closed, { kind: 'reviewed', at: '2026-11-03T00:00:00.000Z', conclusion: 'no-anomaly', note: null }),
    'InspectionClosed', 'after closing');
});

test('TEST-F-05 followup: every download of the month needs a confirmed reason before closing', () => {
  const inspector = authorityFor('inspector-1', ['inspection']);
  let cycle = F.recordInspectionStep(inspector, reportedCycle(['dl-1', 'dl-2']), { kind: 'reviewed', at: '2026-11-02T00:00:00.000Z', conclusion: 'no-anomaly', note: null });
  assert.deepEqual([...F.inspectionStatus(cycle).missingDownloadReasons], ['dl-1', 'dl-2']);
  refused(() => F.recordInspectionStep(inspector, cycle, { kind: 'closed', at: '2026-11-02T01:00:00.000Z' }), 'InspectionFollowUpOpen', 'downloads without reasons');
  cycle = F.recordInspectionStep(inspector, cycle, { kind: 'download-reason', at: '2026-11-02T00:10:00.000Z', eventId: 'dl-1', reason: 'copy issued for request copy-1', outcome: 'legitimate' });
  assert.deepEqual([...F.inspectionStatus(cycle).missingDownloadReasons], ['dl-2']);
  refused(() => F.recordInspectionStep(inspector, cycle, { kind: 'download-reason', at: '2026-11-02T00:11:00.000Z', eventId: 'not-a-download', reason: 'x', outcome: 'legitimate' }),
    'InspectionStepRefused', 'a reason for an event the report does not list');
  cycle = F.recordInspectionStep(inspector, cycle, { kind: 'download-reason', at: '2026-11-02T00:12:00.000Z', eventId: 'dl-2', reason: 'radiologist teaching file request', outcome: 'legitimate' });
  assert.equal(F.inspectionStatus(cycle).state, 'ready-to-close');
  assert.deepEqual([...F.DOWNLOAD_ACTIONS].sort(), ['copy', 'disclosure', 'download', 'pdf']);
});

test('TEST-F-05 followup: an investigation closes only with a recorded action and a passing recheck by designated people', () => {
  const inspector = authorityFor('inspector-1', ['inspection']);
  const step = (cycle, s) => F.recordInspectionStep(inspector, cycle, s);
  let cycle = step(reportedCycle(['dl-1']), { kind: 'investigation-opened', at: '2026-11-02T00:00:00.000Z', investigationId: 'inv-1', eventIds: ['dl-1', 'evt-9'], summary: 'night download' });
  cycle = step(cycle, { kind: 'reviewed', at: '2026-11-02T00:00:00.000Z', conclusion: 'anomaly-found', note: 'odd night access', investigationId: 'inv-1' });
  cycle = step(cycle, { kind: 'download-reason', at: '2026-11-02T00:01:00.000Z', eventId: 'dl-1', reason: 'unclear', outcome: 'investigate', investigationId: 'inv-1' });
  assert.deepEqual([...F.inspectionStatus(cycle).uninvestigated], ['dl-1']);
  refused(() => step(cycle, { kind: 'closed', at: '2026-11-02T00:03:00.000Z' }), 'InspectionFollowUpOpen', 'an investigation without action');
  cycle = step(cycle, { kind: 'action-recorded', at: '2026-11-02T00:04:00.000Z', investigationId: 'inv-1', action: 'account suspended pending interview' });
  cycle = step(cycle, { kind: 'rechecked', at: '2026-11-03T00:00:00.000Z', investigationId: 'inv-1', result: 'not-resolved', note: 'interview pending' });
  assert.deepEqual([...F.inspectionStatus(cycle).openInvestigations], ['inv-1']);
  refused(() => step(cycle, { kind: 'action-recorded', at: '2026-11-03T00:01:00.000Z', investigationId: 'inv-unknown', action: 'x' }), 'InspectionStepRefused', 'an unknown investigation');
  cycle = step(cycle, { kind: 'rechecked', at: '2026-11-04T00:00:00.000Z', investigationId: 'inv-1', result: 'resolved', note: 'lawful, documented' });
  assert.equal(F.inspectionStatus(cycle).state, 'ready-to-close');
  const closed = step(cycle, { kind: 'closed', at: '2026-11-04T01:00:00.000Z' });
  assert.equal(F.inspectionStatus(closed).state, 'closed');
  // A stored cycle whose closing skipped the follow-up is refused on reload.
  const unready = step(reportedCycle(['dl-1']), { kind: 'reviewed', at: '2026-11-02T00:00:00.000Z', conclusion: 'no-anomaly', note: null });
  const forged = { ...unready, events: [...unready.events, { kind: 'closed', at: '2026-11-02T01:00:00.000Z', by: id('inspector-1') }] };
  refused(() => F.inspectionStatus(forged), 'InspectionFollowUpOpen', 'a stored early closing');
  const anomalyOnly = step(reportedCycle(), { kind: 'reviewed', at: '2026-11-02T00:00:00.000Z', conclusion: 'anomaly-found', note: 'x' });
  assert.equal(F.inspectionStatus(anomalyOnly).state, 'in-follow-up');
});

test('TEST-F-05 followup: the inspection period stays the Seoul calendar month before and after 2026-11-01', () => {
  assert.equal(F.inspectionMonth('2026-10-31T14:59:59.999Z'), '2026-10');
  assert.equal(F.inspectionMonth(OCT_END), '2026-11');
  assert.deepEqual([...F.inspectionMonthsDue('2026-09', '2027-01-05T00:00:00.000Z')], ['2026-09', '2026-10', '2026-11', '2026-12']);
  assert.deepEqual([...F.inspectionMonthsDue('2026-11', '2026-11-30T14:59:59.999Z')], []);
  assert.deepEqual([...F.inspectionMonthsDue('2026-11', '2026-11-30T15:00:00.000Z')], ['2026-11']);
  refused(() => F.inspectionMonthsDue('2026-13', NOW), 'InspectionCycleRefused', 'not a month');
});

// =====================================================================================================================
// TEST-F-06 extended_request_hold

const REQ_RECEIVED = '2026-10-09T00:00:00.000Z', REQ_DUE = '2026-10-19T00:00:00.000Z';
const EXT_AT = '2026-10-15T00:00:00.000Z', NEW_DUE = '2026-10-29T00:00:00.000Z', HOLD_AT = '2026-10-09T01:00:00.000Z';
const plusMs = (at, ms) => new Date(Date.parse(at) + ms).toISOString();
function requestFacts(o = {}) {
  return { requestId: o.requestId ?? 'req-hold-1', recordIds: ['rep-1'], receivedAt: REQ_RECEIVED, initialDueAt: REQ_DUE,
    extensions: o.extensions ?? [], resolution: o.resolution ?? null };
}
function holdRow(until, o = {}) {
  const duty = o.type === 'statutory-duty';
  return { holdId: o.holdId ?? 'hold-1', recordId: 'rep-1', basis: { type: o.type ?? 'pending-access-request',
    clause: { law: 'privacy', article: duty ? '36.2' : '35.3', version: '21445' }, clauseId: duty ? 'privacy:36.2' : 'privacy:35.3',
    requestId: o.requestId ?? 'req-hold-1', authorityId: INST_X, authorityKind: 'personal-information-controller', managingInstitutionId: INST_X,
    scope: ['rep-1'], verified: true, validity: { from: HOLD_AT, until, condition: duty ? 'duty-active' : 'request-pending' } },
    actorId: 'officer', at: HOLD_AT, release: o.release ?? null };
}
const EXTENSION = { extensionId: 'ext-1', at: EXT_AT, previousDueAt: REQ_DUE, dueAt: NEW_DUE, basis: { clauseId: 'privacy:35.3', version: '21445' },
  actorId: 'officer', evidenceId: 'delay-notice-1' };

test('TEST-F-06 extended_request_hold: a lawfully extended pending request keeps its hold after the old until and the old until releases nothing', () => {
  const facts = requestFacts(), hold = holdRow(REQ_DUE);
  const extended = F.extendRequestHold(facts, hold, EXTENSION);
  const afterOld = F.requestHoldState(extended.facts, extended.hold, plusMs(REQ_DUE, 1));
  assert.equal(afterOld.preserve, true, 'M-F-06: the old until does not end a pending extended request');
  assert.deepEqual([afterOld.state, afterOld.dueAt], ['pending', NEW_DUE]);
  const overdue = F.requestHoldState(extended.facts, extended.hold, plusMs(NEW_DUE, 86_400_000));
  assert.deepEqual([overdue.preserve, overdue.state], [true, 'pending-overdue']);
  const officer = authorityFor('records-officer');
  const factsBefore = clone(extended.facts), holdBefore = clone(extended.hold);
  refused(() => F.planRequestHoldRelease(officer, extended.facts, extended.hold,
    { reason: 'effect-ended', evidenceId: 'none', endingFact: { kind: 'validity-expired', at: REQ_DUE } }, plusMs(REQ_DUE, 1)),
    'PendingRequestHoldCannotEnd', 'the old until is not an ending fact');
  refused(() => F.planRequestHoldRelease(officer, extended.facts, extended.hold,
    { reason: 'effect-ended', evidenceId: 'none', endingFact: { kind: 'validity-expired', at: NEW_DUE } }, plusMs(NEW_DUE, 1)),
    'PendingRequestHoldCannotEnd', 'nor is the extended until');
  assert.deepEqual([extended.facts, extended.hold], [factsBefore, holdBefore]);
  const unextended = F.requestHoldState(facts, hold, plusMs(REQ_DUE, 1));
  assert.deepEqual([unextended.preserve, unextended.state], [true, 'pending-overdue']);
});

test('TEST-F-06 extended_request_hold: the extension moves the request due and the hold validity together and keeps the earlier due and validity as history', () => {
  const facts = requestFacts(), hold = holdRow(REQ_DUE), before = clone([facts, hold]);
  const extended = F.extendRequestHold(facts, hold, EXTENSION);
  assert.deepEqual([facts, hold], before);
  assert.equal(extended.hold.basis.validity.until, NEW_DUE);
  assert.equal(F.effectiveDue(extended.facts), NEW_DUE);
  assert.equal(extended.facts.initialDueAt, REQ_DUE);
  assert.deepEqual(extended.facts.extensions.map(e => e.extensionId), ['ext-1']);
  assert.deepEqual(extended.superseded, { holdId: 'hold-1', until: REQ_DUE, supersededBy: 'ext-1' });
  // A hold not moved in the same change stays preserved and is reported out of step; it cannot be extended again.
  assert.deepEqual(F.requestHoldState(extended.facts, hold, plusMs(REQ_DUE, 1)), { preserve: true, state: 'hold-out-of-sync', dueAt: NEW_DUE });
  const second = { ...EXTENSION, extensionId: 'ext-2', at: '2026-10-20T00:00:00.000Z', previousDueAt: NEW_DUE, dueAt: '2026-11-08T00:00:00.000Z' };
  refused(() => F.extendRequestHold(extended.facts, hold, second), 'HoldValidityOutOfSync', 'a stale hold');
  const twice = F.extendRequestHold(extended.facts, extended.hold, second);
  assert.deepEqual([F.effectiveDue(twice.facts), twice.superseded.until], ['2026-11-08T00:00:00.000Z', NEW_DUE]);
});

test('TEST-F-06 extended_request_hold: a release binds only to the same request verified resolution and A accepts it on reload', () => {
  const officer = authorityFor('records-officer');
  const resolution = { eventId: 'resolved-1', at: '2026-10-25T00:00:00.000Z', outcome: 'fulfilled' };
  const extended = F.extendRequestHold(requestFacts(), holdRow(REQ_DUE), EXTENSION);
  const facts = { ...extended.facts, resolution }, hold = extended.hold;
  assert.deepEqual(F.requestHoldState(facts, hold, '2026-10-26T00:00:00.000Z'), { preserve: true, state: 'release-required', dueAt: NEW_DUE });
  refused(() => F.planRequestHoldRelease(officer, facts, hold, { reason: 'request-fulfilled', evidenceId: 'resolved-1' }, '2026-10-24T00:00:00.000Z'),
    'PendingRequestHoldCannotEnd', 'before the resolution');
  refused(() => F.planRequestHoldRelease(officer, facts, hold, { reason: 'request-withdrawn', evidenceId: 'resolved-1' }, '2026-10-26T00:00:00.000Z'),
    'HoldReleaseBindingRefused', 'another outcome');
  refused(() => F.planRequestHoldRelease(officer, facts, hold, { reason: 'request-fulfilled', evidenceId: 'other-event' }, '2026-10-26T00:00:00.000Z'),
    'HoldReleaseBindingRefused', 'another event');
  refused(() => F.planRequestHoldRelease(officer, facts, hold, { reason: 'effect-ended', evidenceId: 'resolved-1', endingFact: { kind: 'validity-expired', at: NEW_DUE } },
    '2026-10-30T00:00:00.000Z'), 'RequestHoldNeedsResolution', 'expiry instead of the resolution');
  refused(() => F.planRequestHoldRelease(officer, facts, holdRow(NEW_DUE, { requestId: 'req-other' }), { reason: 'request-fulfilled', evidenceId: 'resolved-1' },
    '2026-10-26T00:00:00.000Z'), 'HoldRequestBindingRefused', 'a hold of another request');
  refused(() => F.planRequestHoldRelease(authorityFor('aud-1', ['investigate']), facts, hold, { reason: 'request-fulfilled', evidenceId: 'resolved-1' },
    '2026-10-26T00:00:00.000Z'), 'AuditScopeNotGranted', 'no disclosure scope');
  const viaEffect = F.planRequestHoldRelease(officer, facts, hold, { reason: 'effect-ended', evidenceId: 'resolved-1',
    endingFact: { kind: 'request-resolved', at: resolution.at, eventId: resolution.eventId } }, '2026-10-26T00:00:00.000Z');
  assert.deepEqual(viaEffect.endingFact, { kind: 'request-resolved', at: resolution.at, eventId: resolution.eventId });
  const release = F.planRequestHoldRelease(officer, facts, hold, { reason: 'request-fulfilled', evidenceId: 'resolved-1' }, '2026-10-26T00:00:00.000Z');
  assert.deepEqual([release.holdId, release.reason, release.evidenceId], ['hold-1', 'request-fulfilled', 'resolved-1']);
  assert.deepEqual(F.requestHoldState(facts, { ...hold, release }, '2026-10-26T00:00:00.000Z').preserve, false);
  // A's own gate re-reads the released hold against the extended request (the round-2 A fix keeps this shape).
  dutyRows.set('hold-1', { ...clone(hold), release: clone(release) });
  requestRows.set('req-hold-1', { requestId: 'req-hold-1', recordIds: ['rep-1'], receivedAt: REQ_RECEIVED, responseDueAt: NEW_DUE, resolution });
  const reloaded = D.reloadLegalHold('rep-1', 'hold-1');
  assert.deepEqual([reloaded.release.reason, reloaded.basis.validity.until], ['request-fulfilled', NEW_DUE]);
  const duty = F.planRequestHoldRelease(officer, { ...requestFacts(), resolution }, holdRow(REQ_DUE, { type: 'statutory-duty' }),
    { reason: 'duty-ended', evidenceId: 'resolved-1' }, '2026-10-26T00:00:00.000Z');
  assert.equal(duty.reason, 'duty-ended');
});

test('TEST-F-06 extended_request_hold: an untimely, backward or unbound extension is refused and a due never becomes unlimited', () => {
  const facts = requestFacts(), hold = holdRow(REQ_DUE);
  const cases = [
    ['after the due passed', { ...EXTENSION, at: REQ_DUE }, 'DeadlineExtensionRefused'],
    ['not later than the due', { ...EXTENSION, dueAt: REQ_DUE }, 'DeadlineExtensionRefused'],
    ['from another due', { ...EXTENSION, previousDueAt: '2026-10-18T00:00:00.000Z' }, 'DeadlineExtensionRefused'],
    ['before the request', { ...EXTENSION, at: '2026-10-08T00:00:00.000Z' }, 'DeadlineExtensionRefused'],
    ['without end', { ...EXTENSION, dueAt: null }, 'RequestDeadlineRefused'],
    ['without a ground', { ...EXTENSION, basis: { clauseId: '', version: '21445' } }, 'RequestDeadlineRefused'],
  ];
  for (const [label, extension, code] of cases) refused(() => F.extendRequestHold(facts, hold, extension), code, label);
  refused(() => F.extendRequestHold(facts, holdRow(null), EXTENSION), 'RequestHoldRefused', 'an unlimited hold');
  refused(() => F.extendRequestHold({ ...facts, resolution: { eventId: 'r', at: '2026-10-10T00:00:00.000Z', outcome: 'withdrawn' } }, hold, EXTENSION),
    'RequestAlreadyResolved', 'a resolved request');
  refused(() => F.extendRequestHold(facts, holdRow(REQ_DUE, { release: { holdId: 'hold-1' } }), EXTENSION), 'HoldAlreadyReleased', 'a released hold');
  refused(() => F.extendRequestHold(facts, holdRow(REQ_DUE, { requestId: 'req-other' }), EXTENSION), 'HoldRequestBindingRefused', 'a hold of another request');
});

// =====================================================================================================================
// TEST-F-07 incident_scope (legal register delta D-15)

function incidentLedger() {
  const attacker = '203.0.113.9';
  return ledgerOf(chainRows([
    accessEvent({ address: attacker, patient: P1, record: 'rep-1' }),
    accessEvent({ address: attacker, patient: P3, record: 'rep-3', study: 'study-3' }),
    accessEvent({ address: attacker, patient: P1, record: 'rep-5' }),
    accessEvent({ address: attacker, action: 'permission-refused', result: 'refused', managing: unresolved,
      targets: [{ kind: 'report-version', patientLinkSnapshot: unresolved, studyId: unresolved, recordId: unresolved, versionId: unresolved }] }),
    accessEvent({ address: '10.0.0.5', patient: P4, record: 'rep-4' }),
  ]));
}

test('TEST-F-07 incident_scope: an incident query names the patients whose records were provided for the period and address and nothing for refused attempts', async () => {
  const auditor = authorityFor('aud-1');
  const plan = F.planInvestigation(auditor, query({ address: '203.0.113.9' }), 'export');
  const scope = await F.incidentScope(auditor, plan, incidentLedger());
  assert.equal(scope.subjectsIdentifiable, true);
  assert.deepEqual(scope.reasons, []);
  assert.deepEqual(scope.identified.map(g => [g.patient.patientId, g.eventIds.length]), [['SYN-P1', 2], ['SYN-P3', 1]]);
  assert.ok(scope.identified[0].firstAt < scope.identified[0].lastAt);
  await refusedAsync(() => F.incidentScope(auditor, F.planInvestigation(auditor, query({ address: '203.0.113.9' })), incidentLedger()),
    'IncidentScopeNeedsCompleteRead', 'a single page cannot scope an incident');
  await refusedAsync(() => F.incidentScope(authorityFor('aud-y', ALL_SCOPES, INST_Y), plan, incidentLedger()), 'AuditScopeNotGranted', 'another institution');
});

test('TEST-F-07 incident_scope: a ledger that cannot be read or verified is reported as subjects not identifiable and never as nobody affected', async () => {
  const auditor = authorityFor('aud-1');
  const plan = () => F.planInvestigation(auditor, query({ address: '203.0.113.9' }), 'export');
  const tampered = clone(incidentLedger().data);
  tampered[1].entry.payload.event.targets[0].patientLinkSnapshot.value = P2;
  const broken = await F.incidentScope(auditor, plan(), ledgerOf(tampered));
  assert.equal(broken.subjectsIdentifiable, false, 'M-F-S1: an unreadable ledger never reads as nobody affected');
  assert.deepEqual(broken.reasons, [{ kind: 'ledger-unreadable', code: 'LedgerRowIntegrityRefused' }]);
  assert.deepEqual(broken.identified, []);
  const down = await F.incidentScope(auditor, plan(), { top: async () => 5, rows: async () => { throw new Error('db'); } });
  assert.deepEqual([down.subjectsIdentifiable, down.reasons[0].code], [false, 'LedgerReadFailed']);
  const outside = await F.incidentScope(auditor, plan(), incidentLedger(), [{ kind: 'access-outside-ledger', note: 'database dump copied' }]);
  assert.equal(outside.subjectsIdentifiable, false);
  assert.equal(outside.identified.length, 2);
  assert.deepEqual(outside.reasons.map(r => [r.kind, r.by.id]), [['access-outside-ledger', 'aud-1']]);
  await refusedAsync(() => F.incidentScope(auditor, plan(), incidentLedger(), [{ kind: 'guess', note: 'x' }]), 'IncidentDeterminationRefused', 'an unlisted finding');
});

// =====================================================================================================================
// TEST-F-08 rights_request (legal register delta D-7: 개인정보 보호법 제36조·제37조)

const RIGHTS_REPORT = signedVersion('rep-r', 'v1', '2026-10-01T01:00:00.000Z', null);
storedRows.set('tpl-1:tpl-1:e1', { recordId: 'tpl-1', model: 'ReadingTemplate', row: {}, event: { eventId: 'tpl-1:e1', recordId: 'tpl-1', versionId: 't1',
  sha256: hex('tpl'), contentSha256: hex('tpl-content'), at: '2026-10-01T01:00:00.000Z', act: 'creation', signature: null, predecessor: null, components: [], processing: null } });
const TEMPLATE = C.resolveStoredRecord(caps.stored, 'tpl-1', 'tpl-1:e1');
const ACCESS_RECORD = M.resolveAccessRecord(accessEvent({ eventId: 'evt-rights-1' }));
const ofP1 = record => ({ record, subject: { patient: P1, managingInstitutionId: INST_X } });
const rightsRequest = (kind, recordIds = ['rep-r', 'tpl-1', 'evt-rights-1']) => ({ requestId: `rights-${kind}`, receivedAt: '2026-10-09T03:00:00.000Z',
  kind, patient: P1, recordIds, statement: 'please act on my records' });
const RIGHTS_RECORDS = [ofP1(RIGHTS_REPORT.resolved), ofP1(TEMPLATE), ofP1(ACCESS_RECORD)];
const DECIDED = '2026-10-09T05:00:00.000Z';
const outcomes = decision => Object.fromEntries(decision.records.map(r => [r.recordId, r.outcome]));

test('TEST-F-08 rights_request: deletion or suspension of a record the law keeps is refused with reason and objection notice while purpose data is acted on', () => {
  const officer = authorityFor('records-officer');
  const deletion = F.decideRightsRequest(officer, rightsRequest('deletion'), RIGHTS_RECORDS, DECIDED);
  assert.equal(outcomes(deletion)['rep-r'], 'refused-retained-by-law', 'M-F-S2: a statutory record is never deleted on request');
  assert.deepEqual(outcomes(deletion), { 'rep-r': 'refused-retained-by-law', 'tpl-1': 'delete-irreversibly', 'evt-rights-1': 'refused-retained-by-law' });
  assert.equal(deletion.notice.content, 'refusal-with-reason-and-objection-method');
  // Receipt 2026-10-09 12:00 KST; the tenth day counted from the receipt day ends 2026-10-18 24:00 KST.
  assert.equal(deletion.notice.dueBy, '2026-10-18T15:00:00.000Z');
  assert.ok(deletion.records.every(r => r.outcome !== 'refused-retained-by-law' || r.basis.includes('privacy:36.1-proviso')));
  const suspension = F.decideRightsRequest(officer, rightsRequest('processing-suspension'), RIGHTS_RECORDS, DECIDED);
  assert.deepEqual(outcomes(suspension), { 'rep-r': 'refused-legal-duty', 'tpl-1': 'suspend-processing', 'evt-rights-1': 'refused-legal-duty' });
  const purposeOnly = F.decideRightsRequest(officer, rightsRequest('deletion', ['tpl-1']), [ofP1(TEMPLATE)], DECIDED);
  assert.equal(purposeOnly.status, 'planned');
  assert.equal(purposeOnly.notice.content, 'action-result-required');
});

test('TEST-F-08 rights_request: a correction is a new signed version that keeps the original and an access event is never edited and the request binds its own patient', () => {
  const officer = authorityFor('records-officer');
  const correction = F.decideRightsRequest(officer, rightsRequest('correction'), RIGHTS_RECORDS, DECIDED);
  assert.deepEqual(outcomes(correction), { 'rep-r': 'correct-by-new-signed-version', 'tpl-1': 'correct', 'evt-rights-1': 'append-correction-note' });
  assert.equal(correction.notice.content, 'action-result-required');
  refused(() => F.decideRightsRequest(officer, rightsRequest('deletion', ['rep-r']), [{ record: RIGHTS_REPORT.resolved, subject: { patient: P2, managingInstitutionId: INST_X } }], DECIDED),
    'DisclosureSubjectMismatch', 'another patient record');
  refused(() => F.decideRightsRequest(officer, rightsRequest('deletion', ['rep-r']), [ofP1(clone(RIGHTS_REPORT.resolved))], DECIDED), 'StoredRecordRequired', 'a record not resolved by the server');
  refused(() => F.decideRightsRequest(officer, rightsRequest('deletion', ['rep-r', 'tpl-1']), [ofP1(TEMPLATE)], DECIDED), 'RightsRequestRefused', 'a requested record not resolved');
  refused(() => F.decideRightsRequest(authorityFor('aud-1', ['investigate']), rightsRequest('deletion'), RIGHTS_RECORDS, DECIDED), 'AuditScopeNotGranted', 'no disclosure scope');
  refused(() => F.decideRightsRequest(officer, { ...rightsRequest('erase-everything') }, RIGHTS_RECORDS, DECIDED), 'RightsRequestRefused', 'an unknown kind');
});

test('TEST-F-02 patient_replay: change and view streams keep independent snapshots and cursors and neither stream may silently disappear', async () => {
  const auditor = authorityFor('aud-1');
  const sources = {
    changes: ledgerOf(chainRows([1, 2, 3].map(n => accessEvent({ eventId: `change-${n}`, surface: 'POST studies/:uid/report/commit',
      action: 'approve-sign', result: 'succeeded' })))),
    views: ledgerOf(chainRows([1, 2, 3].map(n => accessEvent({ eventId: `view-${n}` })))),
  };
  const plans = (changes, views) => ({
    changes: F.planInvestigation(auditor, query({ limit: 2, ...(changes ? { after: changes } : {}) })),
    views: F.planInvestigation(auditor, query({ limit: 2, ...(views ? { after: views } : {}) })),
  });
  const first = await F.readInvestigationStreams(plans(), sources);
  assert.equal(first.totalEntries, 6, 'M-F-S4: both access streams contribute their own entries');
  assert.deepEqual(first.changes.rows.map(r => r.eventId), ['change-3', 'change-2']);
  assert.deepEqual(first.views.rows.map(r => r.eventId), ['view-3', 'view-2']);
  assert.notEqual(first.changes.nextCursor, first.views.nextCursor);
  for (const stream of ['changes', 'views']) {
    const data = sources[stream].data;
    data.push(...chainRows([accessEvent()], data).slice(data.length));
  }
  const next = await F.readInvestigationStreams(plans(first.changes.nextCursor, first.views.nextCursor), sources);
  assert.deepEqual([next.totalEntries, next.changes.rows[0].eventId, next.views.rows[0].eventId], [6, 'change-1', 'view-1']);
  assert.equal(F.investigationLedgerEvent(next.changes).targets[0].recordId.value, 'change-1');
  await refusedAsync(() => F.readInvestigationStreams(plans(first.views.nextCursor, first.changes.nextCursor), sources),
    'InvestigationCursorRefused', 'a cursor never crosses streams');
  await refusedAsync(() => F.readInvestigationStreams(plans(), { changes: sources.changes }), 'LedgerReadFailed', 'a missing stream is not empty');
  const denied = { ...plans(), views: F.planInvestigation(authorityFor('foreign', ALL_SCOPES, INST_Y), query({ limit: 2 })) };
  const before = clone(sources.changes.calls);
  await refusedAsync(() => F.readInvestigationStreams(denied, sources), 'InvestigationStreamSelectionMismatch', 'different scopes cannot be joined');
  assert.deepEqual(sources.changes.calls, before);
});

test('TEST-F-06 extended_request_hold: a reloaded release needs its own verified resolution and institution and cannot end preservation early', () => {
  const officer = authorityFor('records-officer'), hold = holdRow(REQ_DUE);
  const resolution = { eventId: 'done-1', at: '2026-10-12T00:00:00.000Z', outcome: 'fulfilled' };
  const facts = requestFacts({ resolution });
  const release = F.planRequestHoldRelease(officer, facts, hold, { reason: 'request-fulfilled', evidenceId: resolution.eventId }, '2026-10-13T00:00:00.000Z');
  const pending = requestFacts(), invalid = { ...hold, release }, before = clone([pending, invalid]);
  refused(() => F.requestHoldState(pending, invalid, '2026-10-14T00:00:00.000Z'), 'HoldReleaseBindingRefused',
    'M-F-S5: a release without the request resolution never ends preservation');
  assert.deepEqual([pending, invalid], before);
  for (const patch of [{ holdId: 'another' }, { evidenceId: 'other-resolution' }, { authorityVerified: false },
    { reason: 'request-withdrawn' }, { at: '2026-10-11T00:00:00.000Z' }])
    refused(() => F.requestHoldState(facts, { ...hold, release: { ...release, ...patch } }, '2026-10-14T00:00:00.000Z'),
      'HoldReleaseBindingRefused', 'mismatched stored release');
  assert.equal(F.requestHoldState(facts, invalid, '2026-10-12T01:00:00.000Z').preserve, true);
  assert.equal(F.requestHoldState(facts, invalid, release.at).preserve, false);
  refused(() => F.planRequestHoldRelease(authorityFor('foreign-officer', ALL_SCOPES, INST_Y), facts, hold,
    { reason: 'request-fulfilled', evidenceId: resolution.eventId }, release.at), 'AuditScopeNotGranted', 'foreign institution release');
});

test('TEST-F-05 followup: every new action needs a later recheck before closing including actions at the same time', () => {
  const inspector = authorityFor('inspector-1');
  const at = '2026-11-02T01:00:00.000Z';
  const step = (cycle, input) => F.recordInspectionStep(inspector, cycle, { at, ...input });
  let cycle = step(reportedCycle(), { kind: 'investigation-opened', investigationId: 'follow-1', eventIds: ['e-1'], summary: 'investigation' });
  cycle = step(cycle, { kind: 'reviewed', conclusion: 'anomaly-found', note: 'night activity', investigationId: 'follow-1' });
  cycle = step(cycle, { kind: 'action-recorded', investigationId: 'follow-1', action: 'restrict account' });
  cycle = step(cycle, { kind: 'rechecked', investigationId: 'follow-1', result: 'resolved', note: 'access stopped' });
  assert.equal(F.inspectionStatus(cycle).state, 'ready-to-close');
  cycle = step(cycle, { kind: 'action-recorded', investigationId: 'follow-1', action: 'restore corrected account' });
  assert.equal(F.inspectionStatus(cycle).state, 'in-follow-up', 'M-F-S6: a new action cannot reuse an earlier recheck');
  refused(() => step(cycle, { kind: 'closed' }), 'InspectionFollowUpOpen', 'latest action not yet rechecked');
  cycle = step(cycle, { kind: 'rechecked', investigationId: 'follow-1', result: 'resolved', note: 'permissions checked' });
  assert.equal(F.inspectionStatus(step(cycle, { kind: 'closed' })).state, 'closed');
});

const incidentFacts = (patch = {}) => ({ incidentId: 'incident-1', awarenessAt: '2026-10-09T02:00:00.000Z',
  determinationAt: '2026-10-09T03:00:00.000Z', status: 'possible', possibleGround: 'illegal-access-unidentifiable',
  priorPossibleNotice: null, detailsComplete: false, newlyConfirmedAt: null, reportTriggers: [], medicalIncident: null, ...patch });
async function incidentForResponse(unknown = true) {
  const auditor = authorityFor('aud-1');
  const scope = await F.incidentScope(auditor, F.planInvestigation(auditor, query(), 'export'), incidentLedger(),
    unknown ? [{ kind: 'records-not-attributable', note: 'copied database may contain other patients' }] : []);
  return { auditor, scope };
}

test('TEST-F-07 incident_scope: possible leak notice covers all possibly affected subjects within 72 hours and an unknown population is never zero', async () => {
  const { auditor, scope } = await incidentForResponse();
  const input = incidentFacts(), before = clone(input);
  const result = F.planIncidentResponse(auditor, scope, input);
  assert.equal(result.status, 'planned');
  assert.equal(result.subjectsIdentifiable, false);
  assert.deepEqual(result.obligations.map(o => [o.kind, o.recipient, o.dueAt, o.status]),
    [['possible-leak', 'all-possibly-affected-subjects', '2026-10-12T02:00:00.000Z', 'pending']],
    'M-F-S7: possible-leak notice retains its 72-hour deadline and all-possible-subject audience');
  assert.deepEqual(result.obligations[0].requiredFields, ['possible-data-items', 'suspected-time-and-circumstances',
    'subject-protective-actions', 'controller-response-and-remedies', 'contact-department', 'further-notice-on-determination']);
  assert.equal(scope.auditEvent.action, 'download');
  assert.ok(scope.auditEvent.targets.length > 0);
  assert.deepEqual(input, before);
  refused(() => F.planIncidentResponse(auditor, { ...scope }, input), 'IncidentScopeRequired', 'a caller cannot invent a scope');
  const known = await incidentForResponse(false);
  refused(() => F.planIncidentResponse(known.auditor, known.scope, input), 'IncidentResponseRefused', 'unidentifiable ground contradicts a complete query');
  const broader = F.planIncidentResponse(known.auditor, known.scope, incidentFacts({ possibleGround: 'other-subjects-at-risk' }));
  assert.equal(broader.obligations[0].recipient, 'all-possibly-affected-subjects');
});

test('TEST-F-07 incident_scope: confirmed priority and additional notices and PIPC or KISA reports have separate deadlines and required fields', async () => {
  const { auditor, scope } = await incidentForResponse();
  const input = incidentFacts({ status: 'confirmed', determinationAt: '2026-10-10T02:00:00.000Z',
    newlyConfirmedAt: '2026-10-11T02:00:00.000Z', reportTriggers: ['sensitive-or-unique'] });
  const notices = F.planIncidentResponse(auditor, scope, input).obligations;
  assert.deepEqual(notices.map(n => [n.kind, n.recipient, n.dueAt]), [
    ['possible-leak', 'all-possibly-affected-subjects', '2026-10-12T02:00:00.000Z'],
    ['confirmed-priority', 'affected-subjects', '2026-10-12T02:00:00.000Z'],
    ['confirmed-additional', 'affected-subjects', '2026-10-11T02:00:00.000Z'],
    ['pipc-kisa-priority', 'PIPC-or-KISA', '2026-10-13T02:00:00.000Z'],
    ['pipc-kisa-additional', 'PIPC-or-KISA', '2026-10-11T02:00:00.000Z'],
  ]);
  assert.ok(notices[1].requiredFields.includes('legal-rights-and-exercise'));
  assert.ok(notices[3].requiredFields.includes('facts-known-so-far'));
  assert.equal(notices[0].status, 'moot');
  assert.ok(notices.slice(1).every(n => n.status === 'pending'));
  const complete = F.planIncidentResponse(auditor, scope, incidentFacts({ ...input, detailsComplete: true, newlyConfirmedAt: null }));
  assert.deepEqual(complete.obligations.map(n => n.kind), ['possible-leak', 'confirmed-leak', 'pipc-kisa-report']);
  assert.ok(complete.obligations[1].requiredFields.includes('legal-rights-and-exercise'));
  const overdue = F.planIncidentResponse(auditor, scope, incidentFacts({ status: 'confirmed', determinationAt: '2026-10-15T02:00:00.000Z' }));
  assert.equal(overdue.obligations[0].kind, 'possible-leak');
  assert.equal(overdue.obligations[0].dueAt, '2026-10-12T02:00:00.000Z');
  refused(() => F.planIncidentResponse(auditor, scope, incidentFacts({ ...input, newlyConfirmedAt: NOW })),
    'IncidentResponseRefused', 'additional findings cannot predate the confirmation');
});

test('TEST-F-07 incident_scope: not-a-leak follow-up and immediate MOHW notice remain distinct and a template is never sent evidence', async () => {
  const { auditor, scope } = await incidentForResponse();
  const facts = incidentFacts({ status: 'not-a-leak', determinationAt: '2026-10-11T02:00:00.000Z',
    priorPossibleNotice: { noticeId: 'notice-1', sentAt: '2026-10-09T04:00:00.000Z' },
    medicalIncident: { occurredAt: '2026-10-09T00:00:00.000Z', discoveredAt: '2026-10-09T02:00:00.000Z' } });
  const previous = F.planIncidentResponse(auditor, scope, incidentFacts(), { asOf: facts.priorPossibleNotice.sentAt, notices: [
    { kind: 'possible-leak', triggeredAt: facts.awarenessAt, ...facts.priorPossibleNotice },
  ] });
  const result = F.planIncidentResponse(auditor, scope, facts, { previous });
  assert.deepEqual(result.obligations.map(n => [n.kind, n.recipient, n.timing, n.dueAt, n.status]), [
    ['possible-leak', 'all-possibly-affected-subjects', 'without-delay-within-72-hours', '2026-10-12T02:00:00.000Z', 'met'],
    ['not-a-leak', 'previously-notified-subjects', 'immediate', '2026-10-11T02:00:00.000Z', 'pending'],
    ['mohw-notice', 'MOHW', 'immediate', '2026-10-09T02:00:00.000Z', 'missed'],
  ]);
  assert.deepEqual(result.obligations[2].requiredFields, ['institution-name', 'incident-time', 'damage-details', 'technical-support-request']);
  assert.equal(F.planIncidentResponse(auditor, scope, { ...facts, priorPossibleNotice: null, medicalIncident: null }).obligations[0].status, 'moot');
  refused(() => F.planIncidentResponse(authorityFor('foreign', ALL_SCOPES, INST_Y), scope, facts), 'AuditScopeNotGranted', 'foreign incident');
  refused(() => F.planIncidentResponse(auditor, scope, { ...facts, sent: true }), 'IncidentResponseRefused', 'a template cannot claim delivery');
});

test('TEST-F-07 incident_scope: a late no-breach verdict permanently retains the missed possibility obligation', async () => {
  const { auditor, scope } = await incidentForResponse();
  const facts = incidentFacts({ status: 'not-a-leak', determinationAt: '2026-10-15T02:00:00.000Z' });
  const before = clone(facts);
  const result = F.planIncidentResponse(auditor, scope, facts);
  assert.equal(result.verdict, 'not-a-leak');
  const missed = result.obligations.find(o => o.kind === 'possible-leak');
  assert.equal(missed?.status, 'missed', 'M-F-R2-001: a late no-breach verdict retains the missed obligation');
  assert.deepEqual([missed.triggeredAt, missed.dueAt, missed.notice], [facts.awarenessAt, '2026-10-12T02:00:00.000Z', null]);
  assert.deepEqual(missed.basis, ['privacy:34.2', 'privacy-decree:39-2', 'privacy-decree:39-3.1']);
  const lateNotice = { noticeId: 'late-notice', sentAt: '2026-10-14T02:00:00.000Z' };
  const next = F.planIncidentResponse(auditor, scope, facts, { previous: result, notices: [
    { kind: 'possible-leak', triggeredAt: facts.awarenessAt, ...lateNotice },
  ] });
  assert.equal(next.obligations[0].status, 'missed', 'a late notice cannot repair the missed deadline');
  assert.deepEqual(next.obligations[0].notice, lateNotice);
  const retrospect = F.planIncidentResponse(auditor, scope, facts, { previous: result, notices: [
    { kind: 'possible-leak', triggeredAt: facts.awarenessAt, noticeId: 'later-recorded-evidence', sentAt: '2026-10-10T02:00:00.000Z' },
  ] });
  assert.equal(retrospect.obligations[0].status, 'missed', 'a recorded missed status is never relabelled by subsequently supplied evidence');
  const later = F.planIncidentResponse(auditor, scope, { ...facts, determinationAt: '2026-10-20T02:00:00.000Z' }, { previous: next });
  assert.deepEqual(later.obligations[0], next.obligations[0]);
  assert.equal(later.obligations.some(o => o.kind === 'not-a-leak'), false, 'missed is not a met possibility notice');
  assert.deepEqual(facts, before);
});

test('TEST-F-07 incident_scope: a no-breach verdict before the deadline makes the obligation moot without erasing it', async () => {
  const { auditor, scope } = await incidentForResponse();
  const facts = incidentFacts({ status: 'not-a-leak', determinationAt: '2026-10-11T02:00:00.000Z' });
  const result = F.planIncidentResponse(auditor, scope, facts);
  assert.equal(result.verdict, 'not-a-leak');
  assert.deepEqual(result.obligations.map(o => [o.kind, o.status, o.triggeredAt, o.dueAt]),
    [['possible-leak', 'moot', facts.awarenessAt, '2026-10-12T02:00:00.000Z']]);
  const later = F.planIncidentResponse(auditor, scope, { ...facts, determinationAt: '2026-10-15T02:00:00.000Z' }, { previous: result });
  assert.deepEqual(later.obligations, result.obligations, 'a moot obligation stays moot after its former deadline');
  const boundary = F.planIncidentResponse(auditor, scope, { ...facts, determinationAt: '2026-10-12T02:00:00.000Z' },
    { asOf: '2026-10-12T02:00:00.001Z' });
  assert.equal(boundary.obligations[0].status, 'missed', 'only a verdict BEFORE the deadline moots the obligation');
});

test('TEST-F-07 incident_scope: met notices and prior confirmed obligations remain bound across a later verdict', async () => {
  const { auditor, scope } = await incidentForResponse();
  const notice = { noticeId: 'on-time', sentAt: '2026-10-09T02:30:00.000Z' };
  const initial = F.planIncidentResponse(auditor, scope, incidentFacts(), { notices: [
    { kind: 'possible-leak', triggeredAt: incidentFacts().awarenessAt, ...notice },
  ] });
  assert.equal(initial.obligations[0].status, 'met');
  assert.deepEqual(initial.obligations[0].notice, notice);
  const facts = incidentFacts({ status: 'confirmed', determinationAt: '2026-10-10T02:00:00.000Z', detailsComplete: true,
    priorPossibleNotice: notice, reportTriggers: ['sensitive-or-unique'] });
  const confirmed = F.planIncidentResponse(auditor, scope, facts, { previous: initial, notices: [
    { kind: 'confirmed-leak', triggeredAt: facts.determinationAt, noticeId: 'confirmed-notice', sentAt: facts.determinationAt },
  ] });
  const finalFacts = { ...facts, status: 'not-a-leak', determinationAt: '2026-10-15T02:00:00.000Z', reportTriggers: [] };
  const final = F.planIncidentResponse(auditor, scope, finalFacts, { previous: confirmed });
  assert.deepEqual(final.obligations.map(o => [o.kind, o.status]),
    [['possible-leak', 'met'], ['confirmed-leak', 'met'], ['pipc-kisa-report', 'missed'], ['not-a-leak', 'pending']]);
  const later = F.planIncidentResponse(auditor, scope, finalFacts, { previous: final, asOf: '2026-10-20T02:00:00.000Z' });
  assert.equal(later.obligations.find(o => o.kind === 'not-a-leak').status, 'missed', 'follow-up notice history is retained too');
  refused(() => F.planIncidentResponse(auditor, scope, { ...finalFacts, incidentId: 'other' }, { previous: final }),
    'IncidentResponseRefused', 'another incident cannot inherit this history');
  refused(() => F.planIncidentResponse(auditor, scope, facts, { previous: final }),
    'IncidentResponseRefused', 'history cannot move backwards');
});

test('TEST-F-07 incident_scope: stored met possibility notice automatically requires no-breach follow-up without an input flag', async () => {
  const { auditor, scope } = await incidentForResponse();
  const notice = { kind: 'possible-leak', triggeredAt: incidentFacts().awarenessAt,
    noticeId: 'synthetic-notice', sentAt: '2026-10-09T02:30:00.000Z' };
  const previous = F.planIncidentResponse(auditor, scope, incidentFacts(), { notices: [notice] });
  const facts = incidentFacts({ status: 'not-a-leak', determinationAt: '2026-10-11T02:00:00.000Z' });
  delete facts.priorPossibleNotice;
  const before = clone({ facts, previous });
  const result = F.planIncidentResponse(auditor, scope, facts, { previous });
  const followup = result.obligations.find(o => o.kind === 'not-a-leak');
  assert.ok(followup, 'M-F-R3-001: stored met notice requires follow-up without a caller flag');
  assert.deepEqual([followup.recipient, followup.triggeredAt, followup.dueAt, followup.timing, followup.status, followup.notice],
    ['previously-notified-subjects', facts.determinationAt, facts.determinationAt, 'immediate', 'pending', null]);
  assert.deepEqual(followup.requiredFields, ['no-leak-confirmed', 'prior-possible-notice-reference']);
  assert.deepEqual(followup.basis, ['privacy-decree:39-3.3']);
  assert.deepEqual(result.obligations[0], previous.obligations[0]);
  assert.deepEqual({ facts, previous }, before);
});

test('TEST-F-07 incident_scope: contradictory prior notice assertions refuse without producing or changing a plan', async () => {
  const { auditor, scope } = await incidentForResponse();
  const notice = { noticeId: 'synthetic-notice', sentAt: '2026-10-09T02:30:00.000Z' };
  const previous = F.planIncidentResponse(auditor, scope, incidentFacts(), { notices: [
    { kind: 'possible-leak', triggeredAt: incidentFacts().awarenessAt, ...notice },
  ] });
  const facts = incidentFacts({ status: 'not-a-leak', determinationAt: '2026-10-11T02:00:00.000Z' });
  for (const assertion of [null, { ...notice, noticeId: 'other' }, { ...notice, sentAt: '2026-10-09T02:40:00.000Z' }]) {
    const input = { ...facts, priorPossibleNotice: assertion }, before = clone({ input, previous });
    let produced = null;
    refused(() => { produced = F.planIncidentResponse(auditor, scope, input, { previous }); },
      'IncidentResponseRefused', 'a caller cannot contradict the recorded notice');
    assert.equal(produced, null);
    assert.deepEqual({ input, previous }, before);
  }
  const claimed = { ...facts, priorPossibleNotice: notice }, before = clone(claimed);
  let produced = null;
  refused(() => { produced = F.planIncidentResponse(auditor, scope, claimed); },
    'IncidentResponseRefused', 'a caller notice assertion cannot create notice history');
  assert.equal(produced, null);
  assert.deepEqual(claimed, before);
  const matching = F.planIncidentResponse(auditor, scope, claimed, { previous });
  assert.equal(matching.obligations.find(o => o.kind === 'not-a-leak').status, 'pending');
});

test('TEST-F-07 incident_scope: no prior met notice leaves the no-breach path without a follow-up obligation', async () => {
  const { auditor, scope } = await incidentForResponse();
  const pending = F.planIncidentResponse(auditor, scope, incidentFacts());
  const facts = incidentFacts({ status: 'not-a-leak', determinationAt: '2026-10-11T02:00:00.000Z' });
  for (const previous of [undefined, pending]) {
    for (const omit of [false, true]) {
      const input = clone(facts);
      if (omit) delete input.priorPossibleNotice;
      const before = clone({ input, previous });
      const result = F.planIncidentResponse(auditor, scope, input, { previous });
      assert.deepEqual(result.obligations.map(o => [o.kind, o.status, o.notice]), [['possible-leak', 'moot', null]]);
      assert.deepEqual({ input, previous }, before);
    }
  }
});

test('TEST-F-05 followup: a null inspection step gives a typed refusal and leaves the cycle unchanged', () => {
  const inspector = authorityFor('r3-inspector'), cycle = reportedCycle([]), before = clone(cycle);
  let produced = null;
  refused(() => { produced = F.recordInspectionStep(inspector, cycle, null); },
    'InspectionStepRefused', 'M-F-R3-002: null step returns the typed refusal');
  assert.equal(produced, null);
  assert.deepEqual(cycle, before);
  const next = F.recordInspectionStep(inspector, cycle, { kind: 'reviewed', at: '2026-11-02T01:00:00.000Z',
    conclusion: 'no-anomaly', note: 'review after refused input' });
  assert.equal(F.inspectionStatus(next).state, 'ready-to-close');
});

function resolvedInspection() {
  const inspector = authorityFor('r2-inspector'), at = '2026-11-02T01:00:00.000Z';
  const step = (cycle, input) => F.recordInspectionStep(inspector, cycle, { at, ...input });
  let cycle = step(reportedCycle(['dl-new']), { kind: 'reviewed', conclusion: 'anomaly-found', note: 'old anomaly' });
  const investigationId = cycle.events.at(-1).investigationId;
  cycle = step(cycle, { kind: 'download-reason', eventId: 'dl-new', outcome: 'legitimate', reason: 'initial review' });
  cycle = step(cycle, { kind: 'action-recorded', investigationId, action: 'old anomaly remedied' });
  cycle = step(cycle, { kind: 'rechecked', investigationId, result: 'resolved', note: 'old remedy verified' });
  assert.equal(F.inspectionStatus(cycle).state, 'ready-to-close');
  return { cycle, investigationId, step, inspector, at };
}

test('TEST-F-05 followup: a new anomaly after a resolved investigation needs its own action and recheck', () => {
  const old = resolvedInspection(), before = clone(old.cycle);
  let cycle = old.step(old.cycle, { kind: 'reviewed', conclusion: 'anomaly-found', note: 'new unrelated anomaly' });
  assert.equal(F.inspectionStatus(cycle).state, 'in-follow-up', 'M-F-R2-002: a new anomaly cannot reuse an old resolution');
  const investigationId = cycle.events.at(-1).investigationId;
  assert.notEqual(investigationId, old.investigationId);
  refused(() => old.step(cycle, { kind: 'closed' }), 'InspectionFollowUpOpen', 'new finding has no remedy');
  const forged = { ...cycle, events: [...cycle.events, { kind: 'closed', at: old.at, by: id('r2-inspector') }] };
  refused(() => F.inspectionStatus(forged), 'InspectionFollowUpOpen', 'reload refuses premature closure too');
  cycle = old.step(cycle, { kind: 'action-recorded', investigationId, action: 'new remedy' });
  refused(() => old.step(cycle, { kind: 'closed' }), 'InspectionFollowUpOpen', 'new action has no recheck');
  cycle = old.step(cycle, { kind: 'rechecked', investigationId, result: 'resolved', note: 'new remedy checked' });
  assert.equal(F.inspectionStatus(old.step(cycle, { kind: 'closed' })).state, 'closed');
  assert.deepEqual(old.cycle, before);
});

test('TEST-F-05 followup: reopening a resolved finding creates a new investigation and cannot relabel the old resolution', () => {
  const old = resolvedInspection();
  let cycle = old.step(old.cycle, { kind: 'reviewed', conclusion: 'anomaly-found', note: 'same anomaly recurred', investigationId: old.investigationId });
  const nextId = cycle.events.at(-1).investigationId;
  assert.notEqual(nextId, old.investigationId, 'a resolved investigation is not open for attachment');
  assert.deepEqual(F.inspectionStatus(cycle).openInvestigations, [nextId]);
  const history = clone(cycle.events.slice(0, old.cycle.events.length));
  cycle = old.step(cycle, { kind: 'action-recorded', investigationId: old.investigationId, action: 'old case note' });
  cycle = old.step(cycle, { kind: 'rechecked', investigationId: old.investigationId, result: 'resolved', note: 'old case checked again' });
  refused(() => old.step(cycle, { kind: 'closed' }), 'InspectionFollowUpOpen', 'another investigation cannot cover the reopened finding');
  cycle = old.step(cycle, { kind: 'action-recorded', investigationId: nextId, action: 'recurrence remedied' });
  cycle = old.step(cycle, { kind: 'rechecked', investigationId: nextId, result: 'resolved', note: 'recurrence checked' });
  assert.equal(F.inspectionStatus(old.step(cycle, { kind: 'closed' })).state, 'closed');
  assert.deepEqual(cycle.events.slice(0, old.cycle.events.length), history);
});

test('TEST-F-05 followup: each finding attached to an open investigation needs a subsequent action and recheck', () => {
  const old = resolvedInspection();
  let cycle = old.step(old.cycle, { kind: 'reviewed', conclusion: 'anomaly-found', note: 'first new finding' });
  const investigationId = cycle.events.at(-1).investigationId;
  cycle = old.step(cycle, { kind: 'action-recorded', investigationId, action: 'first finding addressed' });
  cycle = old.step(cycle, { kind: 'download-reason', eventId: 'dl-new', reason: 'new evidence', outcome: 'investigate', investigationId });
  assert.equal(cycle.events.at(-1).investigationId, investigationId, 'named open investigation receives the finding');
  cycle = old.step(cycle, { kind: 'rechecked', investigationId, result: 'resolved', note: 'first action checked' });
  refused(() => old.step(cycle, { kind: 'closed' }), 'InspectionFollowUpOpen', 'second finding has no action even though the first action was rechecked');
  cycle = old.step(cycle, { kind: 'action-recorded', investigationId, action: 'both findings addressed' });
  refused(() => old.step(cycle, { kind: 'closed' }), 'InspectionFollowUpOpen', 'new action needs a later recheck');
  cycle = old.step(cycle, { kind: 'rechecked', investigationId, result: 'resolved', note: 'both remedies verified' });
  assert.equal(F.inspectionStatus(old.step(cycle, { kind: 'closed' })).state, 'closed');
});

function checkSignatureMismatch(field, change) {
  const officer = authorityFor('r2-officer'), approval = F.approveDisclosure(officer, copyRequest(), NOW);
  assert.equal(F.prepareDisclosurePackage(officer, approval, [listingOf('rep-1', [V1, V2])], PREPARED_AT).manifest.records[0].versions.length, 2);
  const evidence = clone(V2.evidence), payload = JSON.parse(Buffer.from(evidence.envelope.payload, 'base64url').toString('utf8'));
  change(payload);
  evidence.envelope.payload = b64u(S.canonicalPayload(payload));
  const listings = [listingOf('rep-1', [V1, V2], { signatures: [V1.evidence, evidence] })], before = clone(listings);
  let produced = null;
  refused(() => { produced = F.prepareDisclosurePackage(officer, approval, listings, PREPARED_AT); },
    'SignatureEvidenceMismatch', `M-F-R2-003-${field}: contradictory signature refuses the package`);
  assert.equal(produced, null);
  assert.deepEqual(listings, before);
}
test('TEST-F-03 lawful_issue: signature record id must equal the stored fixed version', () => {
  checkSignatureMismatch('record', p => { p.recordId = 'wrong-record'; p.previousVersion.recordId = 'wrong-record'; });
});
test('TEST-F-03 lawful_issue: signature version id must equal the stored fixed version', () => {
  checkSignatureMismatch('version', p => { p.versionId = 'wrong-version'; });
});
test('TEST-F-03 lawful_issue: signature content hash must equal the stored fixed version', () => {
  checkSignatureMismatch('content', p => { p.text.findings = 'different signed content'; });
});
test('TEST-F-03 lawful_issue: signature signed-at time must equal the stored fixed version', () => {
  checkSignatureMismatch('time', p => { p.serverTime = '2026-10-05T04:00:00.000Z'; });
});
test('TEST-F-03 lawful_issue: signature predecessor hash must equal the stored fixed version', () => {
  checkSignatureMismatch('predecessor', p => { p.previousVersion.sha256 = hex('wrong predecessor'); });
  checkSignatureMismatch('time-and-predecessor', p => {
    p.serverTime = '2026-10-05T04:00:00.000Z'; p.previousVersion.sha256 = hex('wrong predecessor');
  });
});
