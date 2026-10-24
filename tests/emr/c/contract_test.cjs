/* Retained online report reads, lawful retention and print/version contracts.
 * REQ/RISK mappings remain in emr/units/c.json. C2 server_crypto_test.cjs covers real server-key signatures.
 * Device keys, offline approval and their planner were withdrawn by D1753/D1770.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..', '..', '..');
const declaration = () => JSON.parse(fs.readFileSync(path.join(root, 'emr', 'units', 'c.json'), 'utf8'));

/** Top-level TAP results of `node --test --test-reporter=tap`: every declared case exactly once, `ok`, not skipped/todo. */
function judgeTap(text, expected) {
  const problems = [], seen = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^(not ok|ok) \d+ - (.*?)(?: # (SKIP|TODO)\b.*)?$/.exec(line);
    if (!m) continue;
    const id = (/^(C-[CQ]\d{2}) /.exec(m[2]) || [])[1] ?? m[2];
    seen.set(id, [...(seen.get(id) || []), m[1] === 'ok' && !m[3] ? 'pass' : m[3] ? m[3].toLowerCase() : 'fail']);
  }
  for (const id of expected) {
    const results = seen.get(id) || [];
    if (results.length !== 1) problems.push(`${id}: reported ${results.length} times`);
    else if (results[0] !== 'pass') problems.push(`${id}: ${results[0]}`);
  }
  for (const id of seen.keys()) if (!expected.includes(id)) problems.push(`${id}: not declared`);
  return { ok: problems.length === 0, problems };
}

if (process.argv.includes('--judge-tap')) {
  const file = process.argv[process.argv.indexOf('--judge-tap') + 1];
  const unit = declaration(), expected = process.argv.includes('--server-crypto')
    ? unit.cases.server_crypto : unit.cases.contract;
  const verdict = judgeTap(fs.readFileSync(file, 'utf8'), expected);
  process.stdout.write(JSON.stringify({ file, expected: expected.length, ...verdict }) + '\n');
  process.exit(verdict.ok ? 0 : 1);
}

const assert = require('node:assert/strict');
const { test } = require('node:test');
const api = path.join(root, 'api');
const ts = require(path.join(api, 'node_modules/typescript'));
const config = ts.readConfigFile(path.join(api, 'tsconfig.json'), ts.sys.readFile);
assert.equal(config.error === undefined, true, config.error
  ? `TS${config.error.code}: ${ts.flattenDiagnosticMessageText(config.error.messageText, '\n')}` : undefined);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, api);
const previousLoader = require.extensions['.ts'];
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'),
  { compilerOptions: parsed.options, fileName: filename }).outputText, filename);
const load = name => require(path.join(api, 'src', name + '.ts'));
const M = load('emr-contract/composition'), C = load('emr-contract/classification'), A = load('emr-contract/access-event');
const S = load('emr-contract/signature'), L = load('emr-contract/report-lifecycle'), D = load('emr-contract/lawful-defaults');
const CTX = load('emr-report/contract');
const CMD = load('emr-report/commands'), RD = load('emr-report/reads'), RT = load('emr-report/retention');
if (previousLoader) require.extensions['.ts'] = previousLoader; else delete require.extensions['.ts'];

// ---- synthetic server storage, composed once like the server start (A contract) ----
const storedRows = new Map(), dutyRows = new Map(), holdIndex = new Map();
const caps = M.composeEmrAdapters({
  stored: { load: (id, eventId) => storedRows.get(id + ':' + eventId) },
  legal: { load: id => dutyRows.get(id), listHolds: id => ({ recordId: id, holdIds: holdIndex.get(id) || [], complete: true }),
    loadClauseVersions: key => key === 'synthetic-law:article-1'
      ? [{ law: 'synthetic-law', article: 'article-1', publication: '2026-v1', publishedAt: '2026-01-01', effectiveAt: '2026-01-01' }] : [] },
  purpose: { load: () => undefined, loadSignedResult: () => undefined },
  clinical: { loadStudy: () => undefined, loadReportPatient: () => undefined },
});

const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const ms = s => Date.parse(s), iso = n => new Date(n).toISOString(), plus = (s, delta) => iso(ms(s) + delta);
const MIN = 60000, H = 3600000, DAY = 24 * H;
const T0 = '2026-10-05T01:00:00.000Z';
const ISS = 'https://identity.example.test';
const STUDY = '1.2.840.99999.1';
const patient = Object.freeze({ linkId: 'link-1', patientId: 'SYN-1', assigningAuthority: 'hospital-a' });
const who = id => ({ id, issuer: ISS, subject: 'sub-' + id });
const study = (over = {}) => ({ studyId: STUDY, patient: { ...patient }, managingInstitutionId: 'inst-a', readingInstitutionIds: ['inst-a'],
  assignment: { readerId: null, generation: 0 }, ...over });
const actor = (id, over = {}) => ({ identity: who(id), identityRegistrationId: 'reg-' + id, kind: 'member', roles: ['radiologist'], institutionId: 'inst-a',
  canSign: true, canCancel: true, rightsVersion: 'rights-1', sessionState: 'active', ...over });
const ingress = { requestId: 'request-1', ip: { status: 'known', value: { address: '192.0.2.10', source: 'trusted-proxy' } } };
const reportText = (findings = 'SYN 소견 본문') => ({ kind: 'report', findings, conclusion: 'SYN 결론', recommendation: '' });
const allowed = fn => { let value; assert.doesNotThrow(() => { value = fn(); }); return value; };
const allowedAsync = async fn => { let value; await assert.doesNotReject(async () => { value = await fn(); }); return value; };
const deepHas = (value, needle) => JSON.stringify(value).includes(needle);

// Synthetic persisted records feed the real retention and read boundaries; signature verification is covered by C2.
let counter = 0;
const next = prefix => `${prefix}-${++counter}`;
const ACT = { preliminary: 'entry', approve: 'entry', amend: 'correction', addendum: 'additional-entry', cancel: 'correction' };
const server = () => ({ facts: L.newReportFacts(next('report'), STUDY), record: null, archive: null });
function online(srv, id, action, o = {}) {
  const at = o.at ?? T0, recordId = srv.facts.recordId, versionId = next('version'), digest = sha(versionId);
  const command = { action, at, actor: { id, kind: 'member', roles: ['radiologist'], canReadStudy: true, canSign: true, canCancel: true },
    expectedClaimGeneration: srv.facts.claimGeneration, expectedPublishedVersionId: srv.facts.publishedVersion?.versionId ?? null,
    reviewerId: o.reviewerId, reason: o.reason, preservation: o.preservation, version: { recordId, versionId, sha256: digest } };
  if (!ACT[action]) return L.transitionReport(srv.facts, command);
  const eventId = 'stored:' + versionId, prev = srv.record?.parts.at(-1);
  storedRows.set(recordId + ':' + eventId, { recordId, model: 'ReportVersion', row: {}, event: {
    eventId, recordId, versionId, sha256: digest, contentSha256: sha('content:' + digest), at, act: ACT[action],
    signature: { versionId, sha256: digest, signedAt: at, verified: true },
    predecessor: prev ? { recordId, partId: prev.partId, sha256: prev.evidence.event.sha256 } : null,
    components: [], processing: o.stored?.processing ?? null } });
  const retained = { record: srv.record, source: C.resolveStoredRecord(caps.stored, recordId, eventId),
    graph: srv.record ? { records: [srv.record], references: [], complete: true, revision: versionId, checkedAt: at } : null, archive: srv.archive };
  if (o.preservation === 'entry') command.preservationEntry = retained.source;
  if (o.preservation === 'correction') command.preservationCorrection = retained.source;
  const outcome = RT.signedTransition(srv.facts, command, retained);
  return { ...outcome, version: { ref: command.version } };
}
async function run(srv, id, action, options = {}) {
  const plan = online(srv, id, action, options);
  srv.facts = plan.facts; if (plan.retention) srv.record = plan.retention;
  return { plan };
}
async function approvedUnit(at = T0, signer = 'r1') {
  const srv = server(); await run(srv, signer, 'start', { at: plus(at, -MIN) });
  await run(srv, signer, 'approve', { at }); return srv;
}
const finalize = (srv, at) => {
  srv.facts = L.transitionReport(srv.facts, { action: 'finalize', actor: { id: 'finalizer', kind: 'service', roles: ['system'], canReadStudy: true, canSign: false, canCancel: false },
    at, expectedClaimGeneration: srv.facts.claimGeneration, expectedPublishedVersionId: srv.facts.publishedVersion.versionId }).facts;
};

test('C-C08 bodies are served after the durable receipt for the authorized version; display is separate, and unpublished or out-of-scope reads are refused', async () => {
  const srv = await approvedUnit(T0, 'r1');
  const ctx = (over = {}) => ({ actor: actor('c1', { roles: ['clinician'], canSign: false, canCancel: false }), roleAllowed: true, workStudy: null, study: study(), facts: srv.facts, archive: null, resume: null,
    retained: { record: srv.record, at: plus(T0, H) }, ingress, now: plus(T0, H), ...over });
  const plan = allowed(() => RD.planReportRead(ctx(), { surface: 'clinician', versionId: null, eventId: 'read-1' }));
  // REQ-EMR-07 / D-18 -> RISK-EMR-07 -> C-C08: derive observed work, never a default reason.
  const expected = (basis, studyId = STUDY, relatedStudyId = null) => ({ basis, studyId, relatedStudyId, reason: null });
  const workStudy = { studyId: 'current-work-study', patient: { ...patient } };
  const bound = ctx({ actor: actor('r1'), workStudy });
  assert.deepEqual(CTX.workContextFor(ctx()), expected('worklist'));
  assert.deepEqual(CTX.workContextFor(bound), expected('same-patient-comparison', workStudy.studyId, STUDY));
  const assigned = { ...bound, study: study({ assignment: { readerId: 'r1', generation: 7 } }) };
  assert.deepEqual(CTX.workContextFor(assigned), expected('assigned-reading'));
  for (const preliminary of [{ authorId: 'r1', reviewerId: 'r2' }, { authorId: 'r2', reviewerId: 'r1' }])
    assert.deepEqual(CTX.workContextFor({ ...bound, facts: { studyId: STUDY, preliminary } }), expected('assigned-reading'));
  assert.deepEqual(CTX.workContextFor({ ...bound, facts: { studyId: 'other-study', preliminary: { authorId: 'r1', reviewerId: 'r2' } } }),
    expected('same-patient-comparison', workStudy.studyId, STUDY));
  for (const work of [null, { ...workStudy, studyId: STUDY },
    ...['linkId', 'patientId', 'assigningAuthority'].map(key => ({ ...workStudy, patient: { ...patient, [key]: 'different' } }))])
    assert.deepEqual(CTX.workContextFor({ ...bound, workStudy: work }), expected('worklist'));
  for (const [cause, member] of [['background-fetch', actor('r1')], ['service-job', actor('job', { kind: 'service' })]])
    assert.deepEqual(CTX.workContextFor({ ...assigned, cause, actor: member }), expected(cause));
  assert.equal(CTX.workContextFor({ ...assigned, cause: 'service-job' }), null);
  assert.equal(CTX.workContextFor({ ...assigned, actor: actor('job', { kind: 'service' }) }), null);
  const invisible = { ...assigned, actor: actor('r1', { institutionId: 'inst-other' }) };
  assert.equal(CTX.workContextFor(invisible), null);
  assert.throws(() => A.parseAccessEvent({ ...plan.event, context: CTX.workContextFor(invisible) }));
  assert.throws(() => RD.planReportRead(invisible, { surface: 'reader', versionId: null, eventId: 'no-context' }), { code: 'InstitutionRefused' });
  for (const [context, basis, current, related] of [[ctx(), 'worklist', STUDY, null],
    [bound, 'same-patient-comparison', workStudy.studyId, STUDY], [assigned, 'assigned-reading', STUDY, null]]) {
    const observed = RD.planReportRead(context, { surface: 'reader', versionId: null, eventId: 'context-' + basis });
    assert.deepEqual(observed.event.context, expected(basis, current, related));
    assert.deepEqual(RD.displayReported(context, observed, plus(T0, H + 1000), 'display-' + basis).context, expected(basis, current, related));
  }
  assert.equal(plan.version.versionId, srv.facts.publishedVersion.versionId);
  assert.equal(plan.event.targets[0].versionId.value, srv.facts.publishedVersion.versionId);
  assert.equal(A.STATUTORY_ACT[plan.event.action], '열람');
  const order = [], ledger = { async append(event) { order.push('append:' + event.eventId); return { eventId: event.eventId, durableAt: plus(T0, H) }; } };
  const body = await RD.serveReportRead(plan, ledger, async receipt => { order.push('body:' + receipt.eventId); return 'SYN body'; });
  assert.equal(body, 'SYN body');
  assert.deepEqual(order, ['append:read-1', 'body:read-1']);
  const sent = [];
  await assert.rejects(RD.serveReportRead(plan, { async append() { throw new Error('ledger down'); } }, async () => { sent.push('body'); }));
  assert.deepEqual(sent, []);
  const shown = RD.displayReported(ctx(), plan, plus(T0, H + 1000), 'shown-1'), again = RD.displayReported(ctx(), plan, plus(T0, H + 5000), 'shown-2');
  assert.equal(shown.relatedEventId, 'read-1');
  assert.notEqual(shown.eventId, again.eventId);
  assert.equal(A.STATUTORY_ACT[shown.action], '열람');
  // Refused reads produce no read event and no body.
  assert.throws(() => RD.planReportRead(ctx({ actor: actor('c2', { roles: ['clinician'], institutionId: 'inst-b' }) }), { surface: 'clinician', versionId: null, eventId: 'r2' }), { code: 'InstitutionRefused' });
  assert.throws(() => RD.planReportRead(ctx({ actor: actor('c3', { roles: ['admin'] }), roleAllowed: false }), { surface: 'clinician', versionId: null, eventId: 'r3' }), { code: 'RoleRefused' });
  const pre = server();
  await run(pre, 'r1', 'start', { at: plus(T0, -MIN) });
  await run(pre, 'r1', 'preliminary', { at: T0, reviewerId: 'r2' });
  assert.throws(() => RD.planReportRead(ctx({ facts: pre.facts, retained: { record: pre.record, at: plus(T0, H) } }), { surface: 'clinician', versionId: null, eventId: 'r4' }), { code: 'NoPublishedReport' });
  const projection = RD.listProjection(srv.facts, true);
  assert.equal(deepHas(projection, 'SYN 소견 본문'), false);
  assert.equal(projection.publishedVersionId, srv.facts.publishedVersion.versionId);
  // A clinician never receives a version that was not published, even once a later version is approved.
  const prelim = server();
  await run(prelim, 'r1', 'start', { at: plus(T0, -H) });
  const pv = (await run(prelim, 'r1', 'preliminary', { at: plus(T0, -MIN), reviewerId: 'r2' })).plan.version.ref;
  await run(prelim, 'r2', 'approve', { at: T0 });
  const pctx = ctx({ facts: prelim.facts, retained: { record: prelim.record, at: plus(T0, H) } });
  assert.throws(() => RD.planReportRead(pctx, { surface: 'clinician', versionId: pv.versionId, eventId: 'r-pre' }), { code: 'VersionNotPublished' });
  const pub = prelim.facts.publishedVersion.versionId;
  assert.equal(allowed(() => RD.planReportRead(pctx, { surface: 'clinician', versionId: pub, eventId: 'r-pub' })).version.versionId, pub);
  assert.equal(allowed(() => RD.planReportRead({ ...pctx, actor: actor('r3') }, { surface: 'reader', versionId: pv.versionId, eventId: 'r-reader' })).version.versionId, pv.versionId);
});

test('C-C11 retained transitions and reads keep lawful preservation and archive; expired reference-only units cannot take ordinary parts, archived preservation entries do not reopen access and reads without {record, at} are refused (L5-01/03/04)', async () => {
  // L5-01: past its own period and held only by a court order, an ordinary Addendum is refused even with processing claims.
  const srv = await approvedUnit(T0, 'r1');
  finalize(srv, plus(T0, DAY));
  srv.archive = L.archiveFinalizedReport(srv.facts, { actor: { id: 'r1', kind: 'member', roles: ['radiologist'], canReadStudy: true, canSign: true, canCancel: true },
    at: plus(T0, DAY + H), reason: 'SYN 진료 목적 종료', purpose: 'clinical-purpose-ended', expectedPublishedVersionId: srv.facts.publishedVersion.versionId });
  const hold = { holdId: 'order-c11', recordId: srv.facts.recordId, actorId: 'custodian', at: plus(T0, 2 * DAY), release: null,
    basis: { type: 'court-order', clause: { law: 'synthetic-law', article: 'article-1', version: '2026-v1' }, clauseId: 'synthetic-law:article-1', authorityKind: 'court',
      managingInstitutionId: 'inst-a', requestId: 'order-42', authorityId: 'court-1', scope: [srv.facts.recordId], verified: true,
      validity: { from: plus(T0, 2 * DAY), until: null, condition: 'order-in-force' } } };
  dutyRows.set(hold.holdId, hold);
  srv.record = D.placeLegalHold(srv.record, caps.legal, hold.holdId, { records: [srv.record], references: [], complete: true, revision: 'h', checkedAt: hold.at });
  holdIndex.set(srv.facts.recordId, [hold.holdId]);
  const later = '2040-01-01T00:00:00.000Z';
  const processing = { basisId: 'independent-processing-duty', authorized: true, preservesOriginals: true, separateManagement: true, permittedHoldIds: [hold.holdId] };
  assert.throws(() => online(srv, 'r2', 'addendum', { at: later, stored: { processing } }), { code: 'HeldCorrectionAuthorityRequired' });
  const preserved = allowed(() => online(srv, 'r2', 'addendum', { at: later, preservation: 'entry', stored: { processing } }));
  assert.equal(preserved.effects.includes('publish-immediately'), false);
  assert.equal(preserved.facts.publishedVersion.versionId, srv.facts.publishedVersion.versionId);
  assert.equal(RT.readRetention(preserved.facts, srv.archive, null, { record: preserved.retention, at: later }).ordinaryClinicalAccess, false);
  // L5-03: archived within its own period: a preservation entry keeps the archive closed; a clinical Addendum reopens lawfully.
  const arc = await approvedUnit(T0, 'r1');
  finalize(arc, plus(T0, DAY));
  arc.archive = L.archiveFinalizedReport(arc.facts, { actor: { id: 'r1', kind: 'member', roles: ['radiologist'], canReadStudy: true, canSign: true, canCancel: true },
    at: plus(T0, DAY + H), reason: 'SYN 진료 목적 종료', purpose: 'clinical-purpose-ended', expectedPublishedVersionId: arc.facts.publishedVersion.versionId });
  const entryAt = plus(T0, DAY + 2 * H), inPeriod = { basisId: 'preservation-duty', authorized: true, preservesOriginals: true, separateManagement: true, permittedHoldIds: [] };
  const entry = allowed(() => online(arc, 'r2', 'addendum', { at: entryAt, preservation: 'entry', stored: { processing: inPeriod } }));
  assert.equal(entry.effects.includes('publish-immediately'), false);
  const afterEntry = RT.readRetention(entry.facts, arc.archive, null, { record: entry.retention, at: entryAt });
  assert.equal(afterEntry.state, 'retention-only');
  assert.equal(afterEntry.ordinaryClinicalAccess, false);
  // O5: reading the archived unit after its preservation entry stays closed to ordinary access.
  assert.throws(() => RD.planReportRead({ actor: actor('r3'), roleAllowed: true, workStudy: null, study: study(), facts: entry.facts, archive: arc.archive, resume: null,
    retained: { record: entry.retention, at: entryAt }, ingress, now: entryAt }, { surface: 'reader', versionId: null, eventId: 'read-o5' }), { code: 'RetentionOnlyAccessRefused' });
  const clinical = allowed(() => online(arc, 'r2', 'addendum', { at: entryAt }));
  assert.equal(clinical.effects.includes('publish-immediately'), true);
  assert.equal(RT.readRetention(clinical.facts, arc.archive, null, { record: clinical.retention, at: entryAt }).ordinaryClinicalAccess, true);
  // L5-04: every read names the stored record and the instant.
  const fresh = await approvedUnit(T0, 'r1');
  const readCtx = retained => ({ actor: actor('r2'), roleAllowed: true, workStudy: null, study: study(), facts: fresh.facts, archive: null, resume: null, retained, ingress, now: plus(T0, H) });
  for (const missing of [null, undefined, { record: fresh.record }, { at: plus(T0, H) }])
    assert.throws(() => RD.planReportRead(readCtx(missing), { surface: 'reader', versionId: null, eventId: 'read-c11' }), { code: 'RetainedReadArgumentRequired' });
  allowed(() => RD.planReportRead(readCtx({ record: fresh.record, at: plus(T0, H) }), { surface: 'reader', versionId: null, eventId: 'read-c11' }));
  assert.throws(() => RD.planReportRead(readCtx({ record: fresh.record, at: later }), { surface: 'reader', versionId: null, eventId: 'read-c11b' }), { code: 'RetentionOnlyAccessRefused' });
  assert.throws(() => online({ ...fresh, record: null }, 'r1', 'amend', { at: plus(T0, H) }), { code: 'RetainedRecordRequired' });
});

test('C-C13 read and print requests stay on one version and an acknowledgement belongs to its version; printing another version, claiming paper output from print() and carrying an old ACK to a new version are refused', async () => {
  const srv = await approvedUnit(T0, 'r1');
  const v1 = srv.facts.publishedVersion;
  await run(srv, 'r1', 'amend', { at: plus(T0, H) });
  const v2 = srv.facts.publishedVersion;
  const ctx = { actor: actor('r2'), roleAllowed: true, workStudy: null, study: study(), facts: srv.facts, archive: null, resume: null, retained: { record: srv.record, at: plus(T0, 2 * H) }, ingress, now: plus(T0, 2 * H) };
  const preview = RD.planReportRead(ctx, { surface: 'preview', versionId: v1.versionId, eventId: 'preview-1' });
  assert.equal(preview.version.versionId, v1.versionId);
  const opened = allowed(() => RD.printRequested(ctx, preview, v1.versionId, plus(T0, 2 * H + 1000), 'print-1'));
  assert.equal(opened.targets[0].versionId.value, v1.versionId);
  assert.throws(() => RD.printRequested(ctx, preview, v2.versionId, plus(T0, 2 * H + 1000), 'print-2'), { code: 'PrintVersionMismatch' });
  const returned = RD.printReported(ctx, opened, 'dialog-returned', plus(T0, 2 * H + 5000), 'print-done-1');
  assert.equal(returned.physicalOutput, 'not-observed');
  assert.equal(returned.event.relatedEventId, opened.eventId);
  assert.equal(returned.event.result, 'reported');
  const cancelled = RD.printReported(ctx, opened, 'cancelled', plus(T0, 2 * H + 6000), 'print-done-2');
  assert.equal(cancelled.event, null);
  assert.equal(cancelled.physicalOutput, 'not-observed');
  assert.throws(() => RD.printReported(ctx, preview.event, 'dialog-returned', plus(T0, 2 * H + 7000), 'print-done-3'), { code: 'PrintSequenceRefused' });
  assert.throws(() => RD.planReportRead(ctx, { surface: 'reader', versionId: 'never-signed', eventId: 'r-x' }), { code: 'VersionNotRetained' });
  const acks = [{ versionId: v1.versionId, at: plus(T0, 30 * MIN), actorId: 'c1' }];
  assert.deepEqual({ ...RD.acknowledgementState(acks, v2), earlierVersions: [...RD.acknowledgementState(acks, v2).earlierVersions] },
    { current: 'not-acknowledged', earlierVersions: [v1.versionId] });
  assert.equal(RD.acknowledgementState([...acks, { versionId: v2.versionId, at: plus(T0, 3 * H), actorId: 'c1' }], v2).current, 'acknowledged');
  assert.equal(RD.acknowledgementState(acks, null).current, 'nothing-published');
});

test('C-C14 the C declaration matches the files and collected cases exactly; missing, duplicate or undeclared files, existing single-writer paths and not-run cases counted as passed are refused', () => {
  const unit = declaration();
  assert.deepEqual(Object.keys(unit).sort(), ['base_sha', 'candidate_cases', 'cases', 'consult', 'consumers', 'dependencies', 'deployment', 'expected', 'forbidden_single_writer', 'live',
    'migrations', 'models', 'mutants', 'order', 'owned_paths', 'records', 'req_risk_test', 'restore', 'round', 'routes', 'unit'].sort());
  assert.equal(unit.round, 'C2-core');
  const owned = unit.owned_paths;
  assert.equal(new Set(owned).size, owned.length);
  for (const file of owned) assert(fs.statSync(path.join(root, file)).isFile(), file);
  assert.deepEqual(owned.filter(p => unit.forbidden_single_writer.includes(p)), []);
  // The expected set is derived, not counted: every file in the C module/test directories plus the concrete paths the
  // actual CI selector assigns to the C job alone (scripts/ci-paths.json entries no other job or shared list names).
  const ciPaths = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'ci-paths.json'), 'utf8'));
  const elsewhere = new Set([...ciPaths.common, ...ciPaths.shared_browser,
    ...Object.entries(ciPaths.jobs).filter(([job]) => job !== 'emr-c').flatMap(([, paths]) => paths)]);
  const expected = ciPaths.jobs['emr-c'].filter(p => !p.includes('*') && !elsewhere.has(p));
  for (const dir of ['api/src/emr-report', 'api/src/emr-signature', 'tests/emr/c']) {
    const present = fs.readdirSync(path.join(root, dir), { withFileTypes: true }).filter(e => !(e.isDirectory() && e.name === '__pycache__')).map(e => dir + '/' + e.name);
    assert.deepEqual(present.filter(p => !owned.includes(p)), [], dir);
    expected.push(...present);
  }
  assert.deepEqual([...owned].sort(), [...new Set(expected)].sort());
  // Collected cases come from the installed TypeScript parser over the real test files.
  const collected = file => {
    const source = ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), ids = [];
    const visit = node => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'test' && node.arguments.length && ts.isStringLiteralLike(node.arguments[0]))
        ids.push((/^(C-[CQ]\d{2}) /.exec(node.arguments[0].text) || [])[1] ?? node.arguments[0].text);
      ts.forEachChild(node, visit);
    };
    visit(source);
    return ids;
  };
  assert.deepEqual(collected('tests/emr/c/contract_test.cjs'), unit.cases.contract);
  assert.deepEqual(collected('tests/emr/c/server_crypto_test.cjs'), unit.cases.server_crypto);
  assert.deepEqual(Object.keys(unit.expected).sort(), [...Object.keys(unit.cases), 'total'].sort());
  for (const [suite, cases] of Object.entries(unit.cases)) {
    assert.equal(new Set(cases).size, cases.length, suite);
    assert.equal(unit.expected[suite], cases.length, suite);
  }
  assert.equal(Object.values(unit.cases).reduce((total, cases) => total + cases.length, 0), unit.expected.total);
  for (const empty of [unit.routes.active, unit.models.active, unit.records.active, unit.migrations.active, unit.live.active, unit.candidate_cases]) assert.deepEqual(empty, []);
  // The exact-selection judge accepts only every declared case passing once.
  const ids = ['C-C01', 'C-Q01'];
  const tap = lines => 'TAP version 13\n' + lines.join('\n') + '\n1..' + lines.length + '\n';
  assert.equal(judgeTap(tap(['ok 1 - C-C01 a', 'ok 2 - C-Q01 b']), ids).ok, true);
  for (const lines of [['ok 1 - C-C01 a', 'ok 2 - C-Q01 b # SKIP'], ['ok 1 - C-C01 a'], ['ok 1 - C-C01 a', 'ok 2 - C-C01 a', 'ok 3 - C-Q01 b'],
    ['ok 1 - C-C01 a', 'not ok 2 - C-Q01 b'], ['ok 1 - C-C01 a', 'ok 2 - C-Q01 b', 'ok 3 - C-C99 extra'], ['ok 1 - C-C01 a', 'ok 2 - C-Q01 b # TODO later']])
    assert.equal(judgeTap(tap(lines), ids).ok, false, lines.join('|'));
});
