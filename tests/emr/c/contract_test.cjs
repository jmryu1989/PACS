/* EMR-C1 contract tests C-C01..C-C14 (order §7): REQ-EMR-02/03/04/05/07/08/09/10/11/12/13/14/16/17/20 -> RISK-EMR-* -> TEST C-Cnn.
 * Runs the real C modules (api/src/emr-report, api/src/emr-signature) and the A contract they consume, compiled with the
 * installed TypeScript, against explicit synthetic ports and fault ports. Each case pairs what must be allowed with what
 * must be refused or recovered. Byte equality appears only where it is the contract itself: the canonical v2 signature
 * payload (AGENTS 1-B.14, interoperability of signed bytes). No product string, DOM shape or internal name is pinned.
 * Keys are generated per run and marked test-software; the product key policy names only TPM evidence.
 * `--judge-tap <file>`: exact-selection judge for the emr-c workflow (declared cases == passed cases, nothing skipped).
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
  const unit = declaration(), expected = [...unit.cases.contract, ...unit.cases.queue];
  const verdict = judgeTap(fs.readFileSync(file, 'utf8'), expected);
  process.stdout.write(JSON.stringify({ file, expected: expected.length, ...verdict }) + '\n');
  process.exit(verdict.ok ? 0 : 1);
}

const assert = require('node:assert/strict');
const { test } = require('node:test');
const api = path.join(root, 'api');
const ts = require(path.join(api, 'node_modules/typescript'));
const config = ts.readConfigFile(path.join(api, 'tsconfig.json'), ts.sys.readFile);
assert.equal(config.error, undefined);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, api);
const previousLoader = require.extensions['.ts'];
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'),
  { compilerOptions: parsed.options, fileName: filename }).outputText, filename);
const load = name => require(path.join(api, 'src', name + '.ts'));
const M = load('emr-contract/composition'), C = load('emr-contract/classification'), A = load('emr-contract/access-event');
const S = load('emr-contract/signature'), L = load('emr-contract/report-lifecycle'), D = load('emr-contract/lawful-defaults');
const CV = load('emr-signature/canonical-v2'), CS = load('emr-signature/contract'), TB = load('emr-signature/time-basis');
const K = load('emr-signature/keys'), V = load('emr-signature/verify'), NP = load('emr-signature/native-port');
const CMD = load('emr-report/commands'), RD = load('emr-report/reads'), RT = load('emr-report/retention');
const G = load('emr-report/offline-grant'), Q = load('emr-report/offline-queue'), REC = load('emr-report/reconcile');
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

// ---- keys, anchors and the native signer stand-in (explicit test values, not product values) ----
const keyRows = new Map(), privateKeys = new Map();
const keyReader = { load: kid => keyRows.get(kid) ?? null,
  holderOf: thumbprint => [...keyRows.values()].find(r => K.jwkThumbprint(r.publicKey) === thumbprint)?.kid ?? null };
const keyPolicy = Object.freeze({ acceptedEvidence: ['test-software'] });
const timePolicy = Object.freeze({ epsilonMs: 2000, reviewRef: 'test-only:not-a-product-value' });
const anchorRows = new Map(), anchorReader = { load: id => anchorRows.get(id) ?? null };
const ports = { keys: keyReader, keyPolicy, anchors: anchorReader, timePolicy };
const clinician = (id, over = {}) => ({ identity: who(id), identityRegistrationId: 'reg-' + id, institutionId: 'inst-a', canSign: true,
  verifiedAt: '2026-09-01T00:00:00.000Z', ...over });
function keyMaterial() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  return { privateKey, publicKey: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } };
}
function deviceKey(id, { kid = 'kid-' + id, deviceId = 'dev-' + id, osUserId = 'os-' + id, at = '2026-09-01T00:00:00.000Z' } = {}) {
  const k = keyMaterial();
  const reg = K.registerDeviceKey({ kid, deviceId, osUserId, publicKey: k.publicKey, evidence: { kind: 'test-software', evidenceId: 'evidence-' + kid }, at,
    actorId: 'registrar-1' }, clinician(id), keyPolicy, keyReader);
  keyRows.set(kid, reg); privateKeys.set(kid, k.privateKey);
  return reg;
}
for (const id of ['r1', 'r2', 'r3', 't1']) deviceKey(id);
let counter = 0;
const next = prefix => `${prefix}-${++counter}`;
function basis(signedAt, deviceId, { boot = 'boot-1', signBoot = boot, wall = [], age = H, validFor = 48 * H, epsilon = timePolicy.epsilonMs, claimed = signedAt,
  register = true, stored = {} } = {}) {
  const anchorId = next('anchor'), serverTime = plus(signedAt, -age), validUntil = plus(serverTime, validFor);
  if (register) anchorRows.set(anchorId, { anchorId, deviceId, bootId: boot, serverTime, validUntil, ...stored });
  return { anchorId, anchorServerTime: serverTime, anchorValidUntil: validUntil, anchorBootId: boot, anchorTickMs: 5000, signBootId: signBoot,
    signTickMs: 5000 + age, wallClockEvents: wall, interval: { earliest: plus(claimed, -epsilon), latest: plus(claimed, epsilon) } };
}
function payload(o) {
  const reg = keyRows.get(o.kid ?? 'kid-' + o.signer);
  return {
    formatVersion: 'emr-signature/2', text: o.text ?? reportText(), patient: o.patient ?? { ...patient },
    managingInstitutionId: 'inst-a', actingInstitutionId: 'inst-a', studyId: STUDY, recordKind: 'report-version',
    recordId: o.recordId, versionId: o.versionId ?? next('version'), previousVersion: o.previous ?? null, attachments: [],
    author: who(o.author ?? o.signer), signer: who(o.signer), identityRegistrationId: 'reg-' + o.signer, action: o.action, reason: o.reason ?? null,
    eventId: o.eventId ?? next('event'), deviceId: reg.deviceId, kid: reg.kid, grant: o.grant ?? null, claimGeneration: o.claimGeneration,
    draftRevision: o.draftRevision ?? null, deviceSequence: o.sequence ?? 1, predecessorEventId: o.predecessor ?? null,
    signedAt: o.claimedAt ?? o.signedAt, timeBasis: o.timeBasis ?? basis(o.signedAt, reg.deviceId, o.basis),
  };
}
function envelopeFor(p, kid = p.kid) {
  const header = CV.protectedHeaderV2(kid).toString('base64url'), body = CV.canonicalPayloadV2(p).toString('base64url');
  const signature = crypto.sign('sha256', Buffer.from(header + '.' + body), { key: privateKeys.get(kid), dsaEncoding: 'ieee-p1363' });
  return { protected: header, payload: body, signature: signature.toString('base64url') };
}
const verify = (envelope, osUserId) => V.verifySignatureV2(envelope, ports, { osUserId });

// ---- a synthetic server: facts, retention unit, drafts, receipts, ledger, journal ----
const ACT = { preliminary: 'entry', 'approve-sign': 'entry', amend: 'correction', addendum: 'additional-entry', cancel: 'correction' };
const SIGNED = { preliminary: 'preliminary', approve: 'approve-sign', amend: 'amend', addendum: 'addendum', cancel: 'cancel' };
const COMMAND = { 'approve-sign': 'approve', amend: 'amend', addendum: 'addendum', cancel: 'cancel', preliminary: 'preliminary' };
function server(recordId = next('report')) {
  return { facts: L.newReportFacts(recordId, STUDY), record: null, archive: null, drafts: new Map(), receipts: new Map(), ledger: [], commits: [], journal: [] };
}
function retainedFor(srv, sig, options = {}) {
  const p = sig.payload, recordId = srv.facts.recordId, prev = srv.record ? srv.record.parts[srv.record.parts.length - 1] : null, eventId = 'stored:' + p.versionId;
  storedRows.set(recordId + ':' + eventId, { recordId, model: 'ReportVersion', row: {}, event: { eventId, recordId, versionId: p.versionId, sha256: sig.versionSha256,
    contentSha256: sha('content:' + sig.versionSha256), at: p.signedAt, act: options.act ?? ACT[p.action],
    signature: { versionId: p.versionId, sha256: sig.versionSha256, signedAt: p.signedAt, verified: true },
    predecessor: prev ? { recordId, partId: prev.partId, sha256: prev.evidence.event.sha256 } : null, components: [], processing: options.processing ?? null } });
  const source = C.resolveStoredRecord(caps.stored, recordId, eventId);
  return { record: srv.record, source, graph: srv.record ? { records: [srv.record], references: [], complete: true, revision: 'rev-' + srv.commits.length, checkedAt: p.signedAt } : null,
    archive: srv.archive };
}
function storeFor(srv, faults = {}) {
  return {
    async findReceipt(eventId) { return srv.receipts.get(eventId) ?? null; },
    async commit(plan) {
      if (faults.commit) throw Object.assign(new Error('synthetic commit fault'), { code: faults.commit });
      if (srv.receipts.has(plan.eventId)) throw Object.assign(new Error('unique eventId'), { code: 'EventIdExists' });
      if (plan.expected.claimGeneration !== srv.facts.claimGeneration || plan.expected.publishedVersionId !== (srv.facts.publishedVersion?.versionId ?? null))
        throw Object.assign(new Error('stale facts'), { code: 'StaleState' });
      const committedAt = plan.times.receivedAt;
      const receipt = { eventId: plan.eventId, contentDigest: plan.contentDigest, recordId: plan.recordId, versionId: plan.version ? plan.version.ref.versionId : null,
        committedAt, publishedAt: plan.publish ? committedAt : null, ledgerReceipts: plan.ledger.map(e => ({ eventId: e.event.eventId, durableAt: committedAt })) };
      srv.facts = plan.facts; if (plan.retention) srv.record = plan.retention;
      if (plan.draft) srv.drafts.set(plan.draft.author, plan.draft.revision);
      srv.ledger.push(...plan.ledger); srv.commits.push(plan); srv.receipts.set(plan.eventId, receipt);
      return receipt;
    },
  };
}
const journalFor = (srv, fail = false) => ({ async record(f) {
  if (fail) throw new Error('synthetic journal fault');
  srv.journal.push(f); return { journalId: 'journal-' + srv.journal.length, durableAt: f.at };
} });
const commit = (srv, plan, faults = {}) => CMD.executeCommit(plan, storeFor(srv, faults), journalFor(srv, faults.journal), () => plan.times.receivedAt);

/** Plan one connected command the way C2 will: verified signature + stored retention inputs + B2 actor snapshot. */
function online(srv, actorId, action, o = {}) {
  const signedAction = SIGNED[action] ?? null, at = o.at ?? T0;
  let envelope = null, sig = null, retained = null;
  const author = o.author ?? (action === 'approve' && srv.facts.state === 'Preliminary' ? srv.facts.preliminary.authorId : actorId);
  if (signedAction) {
    const p = payload({ action: signedAction, recordId: srv.facts.recordId, signer: o.signer ?? actorId, author, signedAt: at, text: o.text, patient: o.patient,
      previous: o.previous !== undefined ? o.previous : CMD.expectedPreviousVersion(srv.facts, action), claimGeneration: o.claimGeneration ?? srv.facts.claimGeneration,
      draftRevision: o.draftRevision !== undefined ? o.draftRevision : (srv.drafts.get(actorId) ?? null), reason: o.reason, eventId: o.signedEventId, basis: o.basis });
    envelope = envelopeFor(p);
    sig = verify(envelope, keyRows.get(p.kid).osUserId);
    retained = o.retained ?? retainedFor(srv, sig, o.stored);
  }
  const command = { action, recordId: srv.facts.recordId, eventId: o.eventId ?? (sig ? sig.payload.eventId : next('event')),
    expectedClaimGeneration: o.expectedClaimGeneration ?? srv.facts.claimGeneration, expectedPublishedVersionId: srv.facts.publishedVersion?.versionId ?? null,
    draft: o.draft ?? null, reason: o.reason ?? null, reviewerId: o.reviewerId ?? null, preservation: o.preservation ?? null, envelope, ...(o.extra ?? {}) };
  return CMD.planReportCommand({ actor: actor(actorId, o.actor), study: study(o.study), facts: o.facts ?? srv.facts, author: who(author),
    ownDraftRevision: srv.drafts.get(actorId) ?? null, attachments: [], signature: sig, retained, receivedAt: o.receivedAt ?? at, ingress: o.ingress ?? ingress,
    mode: 'online' }, command);
}
async function run(srv, actorId, action, o = {}) {
  const plan = online(srv, actorId, action, o);
  const result = await commit(srv, plan);
  assert.equal(result.status, 'committed');
  return { plan, result };
}
async function approvedUnit(at = T0, signer = 'r1') {
  const srv = server();
  await run(srv, signer, 'start', { at: plus(at, -30 * MIN) });
  await run(srv, signer, 'approve', { at });
  return srv;
}
const finalize = (srv, at) => {
  srv.facts = L.transitionReport(srv.facts, { action: 'finalize', actor: { id: 'finalizer', kind: 'service', roles: ['system'], canReadStudy: true, canSign: false, canCancel: false },
    at, expectedClaimGeneration: srv.facts.claimGeneration, expectedPublishedVersionId: srv.facts.publishedVersion.versionId }).facts;
};

// ---- offline grant, queue entry and server reconcile ----
const offlinePolicy = Object.freeze({ imageBytesQ: 10_000_000, reserveBytesJ: 1_000_000, disconnectedHoursH: 12, epsilonMs: 2000, reviewRef: 'test-only:not-a-product-value' });
const grantRows = new Map(), grantReader = { load: id => grantRows.get(id) ?? null };
function manifest(over = {}) {
  const part = name => ({ part: name, sha256: sha('object:' + name), verifiedSha256: sha('object:' + name), bytes: 1000 });
  return { manifestId: 'manifest-1', studies: [{ studyId: STUDY, role: 'current', parts: G.MANIFEST_PARTS.map(part) },
    { studyId: 'prior-1', role: 'comparison', parts: G.MANIFEST_PARTS.map(part) }], requiredComparisonIds: ['prior-1'], ...over };
}
function grantFor(srv, actorId, issuedAt, { actions = ['approve-sign', 'amend', 'addendum'] } = {}) {
  const readiness = G.offlineReadiness(manifest(), offlinePolicy, { bytes: offlinePolicy.reserveBytesJ });
  const key = keyRows.get('kid-' + actorId);
  const issued = G.issueOfflineGrant({ grantId: next('grant'), deviceId: key.deviceId, kid: key.kid, studies: [
    { studyId: STUDY, recordId: srv.facts.recordId, claimGeneration: srv.facts.claimGeneration, role: 'current' },
    { studyId: 'prior-1', recordId: 'prior-report', claimGeneration: 0, role: 'comparison' }], actions, issuedAt, anchorId: next('grant-anchor') },
    actor(actorId), key, offlinePolicy, readiness);
  grantRows.set(issued.grant.grantId, issued.grant);
  return issued;
}
function offlineEntry(srv, actorId, o) {
  const action = o.action ?? 'approve-sign', reg = keyRows.get('kid-' + actorId);
  const p = payload({ action, recordId: srv.facts.recordId, signer: actorId, author: o.author ?? actorId, signedAt: o.signedAt, text: o.text,
    previous: o.previous !== undefined ? o.previous : CMD.expectedPreviousVersion(srv.facts, COMMAND[action]),
    claimGeneration: o.claimGeneration ?? srv.facts.claimGeneration, draftRevision: o.draftRevision !== undefined ? o.draftRevision : (srv.drafts.get(actorId) ?? null),
    grant: { grantId: o.grant.grant.grantId, digest: o.grant.digest }, sequence: o.sequence, predecessor: o.predecessor, eventId: o.eventId, reason: o.reason, basis: o.basis });
  const owner = { issuer: ISS, subject: 'sub-' + actorId, institutionId: 'inst-a', deviceId: reg.deviceId, osUserId: reg.osUserId };
  const access = { formatVersion: 'emr-offline-access/1', eventId: p.eventId, relatedEventId: null, deviceId: reg.deviceId, deviceSequence: p.deviceSequence, kid: reg.kid,
    identity: who(actorId), actingInstitutionId: 'inst-a', managingInstitutionId: 'inst-a', action, target: { patient: { ...patient }, studyId: STUDY, recordId: p.recordId, versionId: p.versionId },
    occurredAt: p.signedAt, timeBasis: p.timeBasis, ip: { status: 'unresolved', reason: 'not-observed' }, network: 'offline', physicalOutput: null };
  return { formatVersion: 'emr-offline-queue/1', eventId: p.eventId, owner, deviceSequence: p.deviceSequence, predecessorEventId: p.predecessorEventId,
    envelope: envelopeFor(p), access, baseVersionId: p.previousVersion ? p.previousVersion.versionId : null };
}
function reconcile(srv, entry, o = {}) {
  const p = JSON.parse(Buffer.from(entry.envelope.payload, 'base64url').toString('utf8'));
  let retained = null;
  try { retained = retainedFor(srv, V.verifySignatureV2(entry.envelope, ports, { osUserId: entry.owner.osUserId })); } catch { retained = null; }
  return REC.reconcileOfflineEvent({ actor: actor(o.submitter ?? p.signer.id, o.actor), study: study(), facts: srv.facts, author: who(p.author.id),
    ownDraftRevision: srv.drafts.get(p.signer.id) ?? null, attachments: [], retained, receivedAt: o.receivedAt, ingress: o.ingress ?? ingress,
    verification: ports, grants: grantReader, existingReceipt: srv.receipts.get(entry.eventId) ?? null, predecessor: o.predecessor ?? null,
    adoptDivergedDraft: o.adopt ?? false }, entry);
}
async function reconcileAndCommit(srv, entry, o) {
  const decision = reconcile(srv, entry, o);
  assert.equal(decision.kind, 'commit', JSON.stringify(decision.response ?? decision.kind));
  const result = await commit(srv, decision.plan);
  return { decision, result, response: REC.commitResponse(decision.plan, result) };
}

test('C-C01 write, private draft, release, independent preliminary approval and immediate publication; self-approval, another reader\'s draft and re-approving a cancelled unit are refused', async () => {
  const srv = server();
  await run(srv, 'r1', 'start', { at: T0 });
  const text = { findings: 'SYN 초안', conclusion: '', recommendation: '' };
  const saved = await run(srv, 'r1', 'save', { at: plus(T0, MIN), draft: { expectedRevision: null, revision: 'e1:1', text } });
  assert.equal(saved.plan.draft.author, 'r1');
  assert.equal(srv.drafts.get('r1'), 'e1:1');
  // Another reader cannot write into this claim, and the request cannot name an author or an authority.
  assert.throws(() => online(srv, 'r2', 'save', { at: plus(T0, 2 * MIN), draft: { expectedRevision: null, revision: 'e9:1', text } }));
  assert.throws(() => online(srv, 'r1', 'save', { at: plus(T0, 2 * MIN), draft: { expectedRevision: null, revision: 'e1:2', text }, extra: { author: 'r2' } }));
  assert.throws(() => online(srv, 'r1', 'save', { at: plus(T0, 2 * MIN), draft: { expectedRevision: null, revision: 'e1:2', text }, extra: { roles: ['admin'] } }));
  assert.throws(() => online(srv, 'r1', 'save', { at: plus(T0, 2 * MIN), draft: { expectedRevision: 'e1:0', revision: 'e1:2', text } }), { code: 'DraftRevisionConflict' });
  // Release by another authorised reader keeps the author's private draft and only reports its presence.
  const released = await run(srv, 'r2', 'release', { at: plus(T0, 3 * MIN) });
  assert.equal(srv.facts.state, 'Unread');
  assert(released.plan.effects.includes('preserve-private-drafts') && released.plan.effects.includes('notify-draft-presence-only'));
  assert.equal(released.plan.draft, null);
  assert.equal(srv.drafts.get('r1'), 'e1:1');
  assert.throws(() => online(srv, 'r1', 'save', { at: plus(T0, 4 * MIN), expectedClaimGeneration: 1, draft: { expectedRevision: 'e1:1', revision: 'e1:2', text } }));
  await run(srv, 'r1', 'start', { at: plus(T0, 5 * MIN) });
  const preliminary = await run(srv, 'r1', 'preliminary', { at: plus(T0, 6 * MIN), reviewerId: 'r2' });
  assert.equal(srv.facts.state, 'Preliminary');
  assert.equal(preliminary.plan.publish, false);
  assert.equal(preliminary.result.receipt.publishedAt, null);
  assert.throws(() => online(srv, 'r1', 'approve', { at: plus(T0, 7 * MIN), author: 'r1' }));
  const approvedAt = plus(T0, 8 * MIN);
  const approval = await run(srv, 'r2', 'approve', { at: approvedAt });
  assert.equal(srv.facts.state, 'Approved');
  assert.equal(approval.plan.publish, true);
  assert.equal(approval.result.receipt.publishedAt, approvedAt);
  assert.equal(srv.facts.firstApprovedAt, approvedAt);
  assert.equal(srv.facts.amendUntil, plus(approvedAt, DAY));
  assert.equal(srv.facts.publishedVersion.versionId, approval.plan.version.ref.versionId);
  // Admin rights alone, or another institution, do not make a clinical signer.
  const other = server();
  assert.throws(() => online(other, 'r3', 'start', { at: T0, actor: { roles: ['admin'] } }));
  assert.throws(() => online(other, 'r3', 'start', { at: T0, actor: { institutionId: 'inst-b' } }));
  allowed(() => online(other, 'r3', 'start', { at: T0 }));
  await run(other, 'r3', 'start', { at: T0 });
  assert.throws(() => online(other, 'r3', 'approve', { at: plus(T0, MIN), actor: { roles: ['admin'] } }));
  // Cancellation closes the unit; it is not reopened, a successor unit links to it.
  await run(srv, 'r2', 'cancel', { at: plus(T0, 9 * MIN), reason: 'SYN 잘못된 검사' });
  assert.equal(srv.facts.state, 'Cancelled');
  assert.equal(srv.facts.firstApprovedAt, approvedAt);
  assert.throws(() => online(srv, 'r2', 'approve', { at: plus(T0, 10 * MIN) }));
  assert.throws(() => online(srv, 'r2', 'start', { at: plus(T0, 10 * MIN) }));
  const successor = L.newReportAfterCancellation(srv.facts, next('report'), { id: 'r2', kind: 'member', roles: ['radiologist'], canReadStudy: true, canSign: true, canCancel: true }, plus(T0, 11 * MIN));
  assert.equal(successor.previousCancelledRecordId, srv.facts.recordId);
  assert.equal(successor.state, 'Unread');
});

test('C-C02 v1 envelopes re-verify unchanged, v2 binds the exact text and a radiographer signs their own Tech Note; swapped body, patient, version, action, key or event, payloads signed for other facts and signatures on admin text are refused', async () => {
  // v1: exact A bytes plus the ES256 check C owns.
  const v1 = { formatVersion: 'emr-signature/1', text: reportText(), patient: { ...patient }, studyId: STUDY, managingInstitutionId: 'inst-a', actingInstitutionId: 'inst-a',
    recordKind: 'report-version', recordId: 'report-v1', versionId: 'v1', author: who('r1'), signer: who('r1'), identityRegistrationId: 'reg-r1', action: 'approve-sign',
    serverTime: T0, previousVersion: null, attachments: [], reason: null };
  const h1 = Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'kid-r1', typ: 'emr-signature+jws' })).toString('base64url'), b1 = S.canonicalPayload(v1).toString('base64url');
  const env1 = { protected: h1, payload: b1, signature: crypto.sign('sha256', Buffer.from(h1 + '.' + b1), { key: privateKeys.get('kid-r1'), dsaEncoding: 'ieee-p1363' }).toString('base64url') };
  const ok1 = allowed(() => V.verifySignatureV1(env1, keyReader, keyPolicy));
  assert.equal(ok1.keyAtSigningTime, 'active');
  const flipped = Buffer.from(env1.signature, 'base64url'); flipped[5] ^= 1;
  assert.throws(() => V.verifySignatureV1({ ...env1, signature: flipped.toString('base64url') }, keyReader, keyPolicy), { code: 'SignatureIntegrityRefused' });
  assert.throws(() => CV.inspectEnvelopeV2(env1), { code: 'SignatureFormatRefused' });
  // v2: CR/LF, trailing spaces, NFD Hangul and astral characters stay byte-exact.
  const nfd = '한글';
  const text = { kind: 'report', findings: 'line 1\r\nline 2  \n' + nfd + ' \u{1F600}', conclusion: '  lead', recommendation: '' };
  assert.notEqual(nfd.normalize('NFC'), nfd);
  const p = payload({ action: 'approve-sign', recordId: 'report-c02', signer: 'r1', signedAt: T0, claimGeneration: 1, text });
  const bytes = CV.canonicalPayloadV2(p);
  assert.deepEqual(JSON.parse(bytes.toString('utf8')).text, text);
  assert.deepEqual(Object.keys(JSON.parse(bytes.toString('utf8'))), [...CS.SIGNATURE_V2_FIELDS]);
  assert(CV.canonicalPayloadV2(JSON.parse(bytes.toString('utf8'))).equals(bytes));
  const env = envelopeFor(p);
  const sig = allowed(() => verify(env, 'os-r1'));
  assert.equal(sig.payload.text.findings, text.findings);
  assert.equal(sig.versionSha256, sha(bytes));
  assert.throws(() => S.inspectSignatureEnvelope(env));
  const reencode = change => ({ ...env, payload: CV.canonicalPayloadV2({ ...p, ...change }).toString('base64url') });
  for (const change of [{ text: { ...text, findings: text.findings.normalize('NFC') } }, { patient: { ...patient, patientId: 'SYN-2' } }, { versionId: 'other-version' },
    { action: 'amend', previousVersion: { recordId: 'report-c02', versionId: 'v0', sha256: 'ab'.repeat(32) } }, { eventId: 'other-event' }, { signedAt: plus(T0, 1) }])
    assert.throws(() => verify(reencode(change), 'os-r1'), { code: 'SignatureIntegrityRefused' });
  assert.throws(() => verify(reencode({ kid: 'kid-r2' }), 'os-r1'), { code: 'SignatureFormatRefused' });
  assert.throws(() => verify({ ...env, protected: CV.protectedHeaderV2('kid-r2').toString('base64url'), payload: reencode({ kid: 'kid-r2' }).payload }, 'os-r2'),
    { code: 'KeyDeviceRefused' });
  assert.throws(() => V.requireVerifiedV2({ ...sig }), { code: 'VerifiedSignatureRequired' });
  // A correctly signed payload is still refused when what it signs is not this study, signer, base version or event.
  const srv = server();
  await run(srv, 'r1', 'start', { at: plus(T0, -MIN) });
  allowed(() => online(srv, 'r1', 'approve', { at: T0 }));
  for (const [field, option] of [['patient', { patient: { ...patient, patientId: 'SYN-2' } }],
    ['signer', { signer: 'r2' }],
    ['previousVersion', { previous: { recordId: srv.facts.recordId, versionId: 'v-older', sha256: 'cd'.repeat(32) } }],
    ['eventId', { eventId: 'event-not-signed' }]]) {
    assert.throws(() => online(srv, 'r1', 'approve', { at: T0, ...option }), { code: 'SignedPayloadBindingRefused' }, field);
  }
  // D-3: a radiographer signs their own Tech Note; a note written only by an administrator stays unsigned operational text.
  const tech = actor('t1', { roles: ['technician'], canCancel: false }), admin = actor('a1', { roles: ['admin'], canSign: false, canCancel: false });
  assert.equal(CMD.techNoteSigning(tech), 'author-signs');
  assert.equal(CMD.techNoteSigning(admin), 'unsigned-operational');
  assert.throws(() => CMD.techNoteSigning(actor('c9', { roles: ['clinician'] })), { code: 'TechNoteAuthorRefused' });
  const noteRecord = 'tech-note:' + STUDY, noteText = 'SYN 촬영 메모\r\n조영제 주입 지연  ';
  const notePayload = o => ({ ...payload({ action: 'record', recordId: noteRecord, signer: 't1', signedAt: T0, claimGeneration: 0, text: { kind: 'clinical-entry', body: noteText }, ...o }),
    recordKind: 'tech-note' });
  const np = notePayload({}), nenv = envelopeFor(np), nsig = verify(nenv, 'os-t1');
  const noteCtx = (who, signature, previous = null) => ({ actor: who, study: study(), recordId: noteRecord, previous, signature, receivedAt: plus(T0, 1000), ingress });
  const noteInput = { versionId: np.versionId, text: noteText, reason: null, eventId: np.eventId, envelope: nenv };
  const signedNote = allowed(() => CMD.planTechNoteRevision(noteCtx(tech, nsig), noteInput));
  assert.equal(signedNote.signing, 'author-signs');
  assert.equal(signedNote.clinicalEntry, true);
  assert.equal(signedNote.version.sha256, nsig.versionSha256);
  assert.equal(signedNote.signedAt, T0);
  assert.deepEqual(signedNote.ledger.map(e => e.act), ['기재']);
  assert.throws(() => CMD.planTechNoteRevision(noteCtx(tech, nsig), { ...noteInput, text: noteText.trim() }), { code: 'SignedPayloadBindingRefused' });
  assert.throws(() => CMD.planTechNoteRevision(noteCtx(tech, null), { ...noteInput, envelope: null }), { code: 'VerifiedSignatureRequired' });
  const byOther = notePayload({ signer: 'r1' }), otherSig = verify(envelopeFor(byOther), 'os-r1');
  assert.throws(() => CMD.planTechNoteRevision(noteCtx(tech, otherSig), { ...noteInput, versionId: byOther.versionId, eventId: byOther.eventId, envelope: envelopeFor(byOther) }),
    { code: 'SignedPayloadBindingRefused' });
  const adminNote = allowed(() => CMD.planTechNoteRevision(noteCtx(admin, null), { ...noteInput, envelope: null }));
  assert.equal(adminNote.signing, 'unsigned-operational');
  assert.equal(adminNote.clinicalEntry, false);
  assert.equal(adminNote.version, null);
  assert.throws(() => CMD.planTechNoteRevision(noteCtx(admin, nsig), noteInput), { code: 'TechNoteSignatureNotApplicable' });
  // A revision is signed as a correction of the stored latest revision and carries its reason.
  const previous = signedNote.version;
  const rp = notePayload({ action: 'amend', previous, reason: 'SYN 시간 정정', signedAt: plus(T0, MIN) }), renv = envelopeFor(rp), rsig = verify(renv, 'os-t1');
  const revision = allowed(() => CMD.planTechNoteRevision(noteCtx(tech, rsig, previous), { versionId: rp.versionId, text: noteText, reason: 'SYN 시간 정정', eventId: rp.eventId, envelope: renv }));
  assert.deepEqual(revision.ledger.map(e => e.act), ['수정']);
  assert.throws(() => CMD.planTechNoteRevision(noteCtx(tech, rsig, previous), { versionId: rp.versionId, text: noteText, reason: null, eventId: rp.eventId, envelope: renv }),
    { code: 'RevisionReasonRequired' });
});

test('C-C03 a trusted anchor plus same-boot monotonic elapsed time is verified; wall-clock claims, rollbacks, reboots, unverified anchors, widened uncertainty and boundary overlap are refused or held', () => {
  const at = plus(T0, 3 * H), dev = 'dev-r1';
  const ok = allowed(() => TB.evaluateTimeBasis(basis(at, dev), at, dev, anchorReader, timePolicy));
  assert.deepEqual(ok, { status: 'verified', signedAt: at, interval: { earliest: plus(at, -2000), latest: plus(at, 2000) } });
  // The device wall clock said 10 minutes later than the ticks: a claim is not evidence.
  const claimed = plus(at, 10 * MIN);
  assert.throws(() => TB.evaluateTimeBasis(basis(at, dev, { claimed }), claimed, dev, anchorReader, timePolicy), { code: 'TimeBasisMismatch' });
  assert.equal(TB.evaluateTimeBasis(basis(at, dev, { wall: [{ kind: 'rollback', tickMs: 6000 }] }), at, dev, anchorReader, timePolicy).status, 'held');
  assert.equal(TB.evaluateTimeBasis(basis(at, dev, { wall: [{ kind: 'rollback', tickMs: 6000 }] }), at, dev, anchorReader, timePolicy).reason, 'wall-clock-changed');
  assert.equal(TB.evaluateTimeBasis(basis(at, dev, { signBoot: 'boot-2' }), at, dev, anchorReader, timePolicy).reason, 'boot-discontinuity');
  assert.equal(TB.evaluateTimeBasis(basis(at, dev, { register: false }), at, dev, anchorReader, timePolicy).reason, 'anchor-unverified');
  assert.equal(TB.evaluateTimeBasis(basis(at, dev, { age: 50 * H }), at, dev, anchorReader, timePolicy).reason, 'anchor-expired');
  assert.throws(() => TB.evaluateTimeBasis(basis(at, dev, { stored: { serverTime: plus(at, -2 * H) } }), at, dev, anchorReader, timePolicy), { code: 'TimeBasisMismatch' });
  assert.throws(() => TB.evaluateTimeBasis(basis(at, 'dev-r2'), at, dev, anchorReader, timePolicy), { code: 'TimeBasisMismatch' });
  // The reviewed epsilon cannot be widened by the device to cover a boundary.
  assert.throws(() => TB.evaluateTimeBasis(basis(at, dev, { epsilon: 60000 }), at, dev, anchorReader, timePolicy), { code: 'TimeBasisMismatch' });
  for (const missing of [undefined, null, { epsilonMs: 2000 }, { reviewRef: 'x' }])
    assert.throws(() => TB.evaluateTimeBasis(basis(at, dev), at, dev, anchorReader, missing), { code: 'TimePolicyRequired' });
  const interval = { earliest: plus(at, -2000), latest: plus(at, 2000) };
  assert.equal(TB.boundaryPosition(interval, plus(at, 2001)), 'before');
  assert.equal(TB.boundaryPosition(interval, plus(at, 2000)), 'straddles');
  assert.equal(TB.boundaryPosition(interval, plus(at, -2000)), 'at-or-after');
  // A held time is preserved by the verifier but never accepted as a normal connected approval.
  const srv = server();
  srv.facts = L.transitionReport(srv.facts, { action: 'start', actor: { id: 'r1', kind: 'member', roles: ['radiologist'], canReadStudy: true, canSign: true, canCancel: true },
    at: plus(at, -MIN), expectedClaimGeneration: 0, expectedPublishedVersionId: null }).facts;
  const held = verify(envelopeFor(payload({ action: 'approve-sign', recordId: srv.facts.recordId, signer: 'r1', signedAt: at, claimGeneration: 1, basis: { signBoot: 'boot-9' } })), 'os-r1');
  assert.equal(held.time.status, 'held');
  assert.equal(held.keyAtSigningTime, 'unverifiable');
  assert.throws(() => online(srv, 'r1', 'approve', { at, basis: { signBoot: 'boot-9' } }), { code: 'SignatureTimeUnverified' });
  allowed(() => online(srv, 'r1', 'approve', { at }));
});

test('C-C04 t0 is the first actual signing time and amendment closes at t0+24h; late receipt never restarts it, pre-boundary amends survive Finalized, the exact boundary and later are Addendum-only', async () => {
  // Offline approval signed 01:00, received 09:00: the window starts at 01:00.
  const srv = server();
  await run(srv, 'r1', 'start', { at: plus(T0, -H) });
  const grant = grantFor(srv, 'r1', plus(T0, -30 * MIN));
  const approval = offlineEntry(srv, 'r1', { signedAt: T0, grant });
  const received = plus(T0, 8 * H);
  const { decision, response } = await reconcileAndCommit(srv, approval, { receivedAt: received });
  assert.equal(srv.facts.firstApprovedAt, T0);
  assert.equal(srv.facts.amendUntil, plus(T0, DAY));
  assert.equal(decision.plan.times.receivedAt, received);
  assert.equal(response.times.signedAt, T0);
  assert.equal(response.times.committedAt, received);
  // Just before the boundary (whole interval before it) the original signer amends; t0 does not move.
  const lateGrant = grantFor(srv, 'r1', plus(T0, 20 * H));
  const amend = offlineEntry(srv, 'r1', { action: 'amend', signedAt: plus(T0, DAY - 3000), grant: lateGrant, text: reportText('SYN 정정 본문') });
  await reconcileAndCommit(srv, amend, { receivedAt: plus(T0, 25 * H) });
  assert.equal(srv.facts.firstApprovedAt, T0);
  assert.equal(srv.facts.amendUntil, plus(T0, DAY));
  assert.equal(srv.facts.publishedVersion.versionId, srv.facts.bodyVersion.versionId);
  // Straddling or touching the boundary is not an amendment.
  const amendUntil = srv.facts.amendUntil;
  for (const signedAt of [plus(amendUntil, -1000), plus(amendUntil, 2000), plus(amendUntil, H)]) {
    const r = reconcile(srv, offlineEntry(srv, 'r1', { action: 'amend', signedAt, grant: lateGrant }), { receivedAt: plus(T0, 26 * H) });
    assert.equal(r.kind, 'refused');
    assert.equal(r.code, 'AmendWindowClosed');
  }
  // Finalized: a pre-boundary amend that arrives late is admitted as a past event; state and t0 stay.
  const fin = await approvedUnit(T0, 'r2');
  const finGrant = grantFor(fin, 'r2', plus(T0, 20 * H));
  const pre = offlineEntry(fin, 'r2', { action: 'amend', signedAt: plus(T0, DAY - 3000), grant: finGrant });
  const atBoundary = offlineEntry(fin, 'r2', { action: 'amend', signedAt: plus(T0, DAY + 2000), grant: finGrant });
  finalize(fin, plus(T0, DAY + H));
  const before = JSON.stringify(fin.facts);
  const admitted = allowed(() => reconcile(fin, pre, { receivedAt: plus(T0, 30 * H) }));
  assert.equal(admitted.kind, 'admit-late-amend');
  assert.equal(admitted.admission.keep.state, 'Finalized');
  assert.equal(admitted.admission.keep.firstApprovedAt, T0);
  assert.equal(admitted.admission.keep.amendUntil, plus(T0, DAY));
  assert.equal(admitted.admission.signedAt, plus(T0, DAY - 3000));
  const late = reconcile(fin, atBoundary, { receivedAt: plus(T0, 30 * H) });
  assert.equal(late.kind, 'refused');
  assert.equal(late.code, 'AmendWindowClosed');
  assert.equal(JSON.stringify(fin.facts), before);
  assert.equal(fin.facts.state, 'Finalized');
  assert.notEqual(fin.facts.publishedVersion, null);
  assert.throws(() => online(fin, 'r2', 'approve', { at: plus(T0, 31 * H) }));
});

test('C-C05 registered device keys verify their signatures and two-operator recovery issues a new kid; another OS user, signatures after revocation and single-operator recovery are refused', async () => {
  const reg = keyRows.get('kid-r3');
  const at = plus(T0, 2 * H);
  const early = envelopeFor(payload({ action: 'approve-sign', recordId: 'report-c05', signer: 'r3', signedAt: at, claimGeneration: 1 }));
  assert.equal(allowed(() => verify(early, 'os-r3')).keyAtSigningTime, 'active');
  assert.throws(() => verify(early, 'os-someone-else'), { code: 'KeyOsUserRefused' });
  assert.throws(() => K.parseKeyRegistration(reg, { acceptedEvidence: ['tpm-nonexportable'] }), { code: 'KeyEvidenceRefused' });
  assert.throws(() => V.verifySignatureV2(early, { ...ports, keyPolicy: { acceptedEvidence: ['tpm-nonexportable'] } }, { osUserId: 'os-r3' }), { code: 'KeyEvidenceRefused' });
  assert.throws(() => K.requireKeyPolicy(undefined), { code: 'KeyPolicyRequired' });
  // One key material, one clinician registration: a shared or re-registered key is refused.
  const shared = { kid: 'kid-r2-shared', deviceId: 'dev-r2b', osUserId: 'os-r2', publicKey: { ...keyRows.get('kid-r1').publicKey },
    evidence: { kind: 'test-software', evidenceId: 'evidence-shared' }, at: plus(T0, H), actorId: 'registrar-1' };
  assert.throws(() => K.registerDeviceKey(shared, clinician('r2'), keyPolicy, keyReader), { code: 'KeyAlreadyRegistered' });
  assert.throws(() => K.registerDeviceKey({ ...shared, kid: 'kid-r1' }, clinician('r2'), keyPolicy, keyReader), { code: 'KeyIdReused' });
  assert.equal(allowed(() => K.registerDeviceKey({ ...shared, publicKey: keyMaterial().publicKey }, clinician('r2'), keyPolicy, keyReader)).kid, 'kid-r2-shared');
  // The native runtime only answers the product origin and the key's own OS user, and has no raw signing operation.
  const call = (operation, over = {}) => ({ operation, context: { protocol: NP.NATIVE_PROTOCOL, origin: 'https://pacs.example.test', documentId: 'doc-1', osUserId: 'os-r3', ...over } });
  const allowedCall = { origins: ['https://pacs.example.test'], osUserId: 'os-r3' };
  assert.equal(allowed(() => NP.requireNativeCall(call('sign-approval'), allowedCall)).operation, 'sign-approval');
  assert.throws(() => NP.requireNativeCall(call('sign-approval', { origin: 'https://elsewhere.example.test' }), allowedCall), { code: 'NativeBindingRefused' });
  assert.throws(() => NP.requireNativeCall(call('sign-approval', { osUserId: 'os-r1' }), allowedCall), { code: 'NativeBindingRefused' });
  assert.throws(() => NP.requireNativeCall(call('sign-bytes'), allowedCall), { code: 'NativeOperationRefused' });
  assert.throws(() => NP.requireNativeCall(call('sign-approval', { protocol: 'kin-native/0' }), allowedCall), { code: 'NativeProtocolRefused' });
  // Revocation takes effect at its time: earlier signatures stay valid, later ones are not accepted.
  const revokedAt = plus(T0, 3 * H);
  keyRows.set('kid-r3', allowed(() => K.revokeKey(reg, { at: revokedAt, reason: 'SYN device lost', actorId: 'security-1' }, keyPolicy)));
  assert.equal(verify(early, 'os-r3').keyAtSigningTime, 'active');
  const after = envelopeFor(payload({ action: 'approve-sign', recordId: 'report-c05', signer: 'r3', signedAt: plus(T0, 4 * H), claimGeneration: 1 }));
  assert.equal(verify(after, 'os-r3').keyAtSigningTime, 'inactive');
  const srv = server();
  await run(srv, 'r3', 'start', { at: plus(T0, 4 * H - MIN) });
  assert.throws(() => online(srv, 'r3', 'approve', { at: plus(T0, 4 * H) }), { code: 'SigningKeyInactive' });
  // Recovery: identity re-verified, two different authorised operators, new kid; never the old key again.
  const r1 = keyRows.get('kid-r1');
  const material = keyMaterial();
  const replacement = { kid: 'kid-r1-recovered', deviceId: r1.deviceId, osUserId: r1.osUserId, publicKey: material.publicKey, evidence: { kind: 'test-software', evidenceId: 'evidence-recovered' } };
  const recoveryAt = plus(T0, 5 * H);
  const auth = (operators, over = {}) => ({ at: recoveryAt, reason: 'SYN key loss', clinician: clinician('r1', { verifiedAt: plus(T0, 4 * H) }), operators, ...over });
  const two = [{ id: 'op-1', authorized: true }, { id: 'op-2', authorized: true }];
  for (const operators of [[{ id: 'op-1', authorized: true }], [{ id: 'op-1', authorized: true }, { id: 'op-1', authorized: true }],
    [{ id: 'op-1', authorized: true }, { id: 'op-2', authorized: false }], [{ id: 'op-1', authorized: true }, { id: 'r1', authorized: true }]])
    assert.throws(() => K.recoverSigningKey(r1, auth(operators), replacement, keyPolicy, keyReader), { code: 'RecoveryOperatorsRequired' });
  assert.throws(() => K.recoverSigningKey(r1, auth(two, { clinician: clinician('r2', { verifiedAt: plus(T0, 4 * H) }) }), replacement, keyPolicy, keyReader), { code: 'RecoveryIdentityRefused' });
  assert.throws(() => K.recoverSigningKey(r1, auth(two), { ...replacement, kid: 'kid-r1' }, keyPolicy, keyReader), { code: 'KeyIdReused' });
  const beforeRecovery = envelopeFor(payload({ action: 'approve-sign', recordId: 'report-c05b', signer: 'r1', signedAt: plus(T0, 4 * H), claimGeneration: 1 }));
  const recovered = allowed(() => K.recoverSigningKey(r1, auth(two), replacement, keyPolicy, keyReader));
  assert.equal(recovered.replacement.supersedes, 'kid-r1');
  assert.equal(K.keyStatusAt(recovered.retired, plus(recoveryAt, 1)), 'retired');
  assert.equal(K.keyStatusAt(recovered.replacement, plus(recoveryAt, 1)), 'active');
  assert.throws(() => K.parseKeyRegistration({ ...recovered.retired, history: [...recovered.retired.history,
    { status: 'active', effectiveAt: plus(recoveryAt, H), reason: 'reactivate', actorIds: ['op-1'] }] }, keyPolicy));
  const saved = keyRows.get('kid-r1');
  keyRows.set('kid-r1', recovered.retired);
  try {
    assert.equal(verify(beforeRecovery, 'os-r1').keyAtSigningTime, 'active');
    const afterRecovery = envelopeFor(payload({ action: 'approve-sign', recordId: 'report-c05b', signer: 'r1', signedAt: plus(recoveryAt, H), claimGeneration: 1 }));
    assert.equal(verify(afterRecovery, 'os-r1').keyAtSigningTime, 'inactive');
    // Restoring access to the encrypted queue does not restore the old signing key.
    const queue = allowed(() => K.recoverQueueAccess(recovered.retired, auth(two)));
    assert.equal(queue.newSignatures, 'not-restored');
    assert.equal(queue.kid, 'kid-r1');
    assert.throws(() => K.recoverQueueAccess(recovered.retired, auth([{ id: 'op-1', authorized: true }])), { code: 'RecoveryOperatorsRequired' });
  } finally { keyRows.set('kid-r1', saved); }
});

test('C-C06 finite grants over complete reserved manifests permit offline work; expired, out-of-scope actions or studies, incomplete manifests and unreviewed Q/J/H/epsilon are refused', async () => {
  for (const policy of [undefined, null, { ...offlinePolicy, imageBytesQ: 0 }, { ...offlinePolicy, disconnectedHoursH: null }, { ...offlinePolicy, reviewRef: '' },
    (({ epsilonMs, ...rest }) => rest)(offlinePolicy)])
    assert.throws(() => G.requireOfflinePolicy(policy), { code: 'OfflinePolicyUnreviewed' });
  const reserved = { bytes: offlinePolicy.reserveBytesJ };
  assert.equal(G.offlineReadiness(manifest(), offlinePolicy, reserved).ready, true);
  const broken = [
    manifest({ requiredComparisonIds: ['prior-1', 'prior-2'] }),
    manifest({ studies: [manifest().studies[0]] }),
    (() => { const m = manifest(); m.studies[0].parts[1].verifiedSha256 = 'ef'.repeat(32); return m; })(),
    (() => { const m = manifest(); m.studies[1].parts.pop(); return m; })(),
  ];
  for (const m of broken) assert.equal(G.offlineReadiness(m, offlinePolicy, reserved).ready, false);
  assert.equal(G.offlineReadiness(manifest(), { ...offlinePolicy, imageBytesQ: 100 }, reserved).ready, false);
  assert.equal(G.offlineReadiness(manifest(), offlinePolicy, null).ready, false);
  assert.equal(G.offlineReadiness(manifest(), offlinePolicy, { bytes: 10 }).ready, false);
  const srv = server();
  await run(srv, 'r1', 'start', { at: plus(T0, -H) });
  const issuedAt = plus(T0, -30 * MIN);
  const { grant } = grantFor(srv, 'r1', issuedAt, { actions: ['approve-sign'] });
  assert.equal(grant.expiresAt, plus(issuedAt, offlinePolicy.disconnectedHoursH * H));
  const request = { grantId: next('grant'), deviceId: 'dev-r1', kid: 'kid-r1', studies: grant.studies, actions: ['approve-sign'], issuedAt, anchorId: 'a' };
  assert.throws(() => G.issueOfflineGrant(request, actor('r1'), keyRows.get('kid-r1'), offlinePolicy, { ready: false, manifestDigest: 'ab'.repeat(32) }), { code: 'OfflineNotReady' });
  assert.throws(() => G.issueOfflineGrant(request, actor('r1'), keyRows.get('kid-r2'), offlinePolicy, G.offlineReadiness(manifest(), offlinePolicy, reserved)), { code: 'GrantKeyRefused' });
  assert.throws(() => G.issueOfflineGrant(request, actor('r1', { roles: ['clinician'] }), keyRows.get('kid-r1'), offlinePolicy, G.offlineReadiness(manifest(), offlinePolicy, reserved)), { code: 'GrantAuthorityRefused' });
  assert.throws(() => G.issueOfflineGrant({ ...request, studies: [...request.studies, { studyId: 'not-loaded', recordId: 'report-x', claimGeneration: 0, role: 'comparison' }] },
    actor('r1'), keyRows.get('kid-r1'), offlinePolicy, G.offlineReadiness(manifest(), offlinePolicy, reserved)), { code: 'GrantStudyRefused' });
  assert.throws(() => G.parseGrant({ ...grant, expiresAt: plus(grant.expiresAt, H) }), { code: 'GrantLengthRefused' });
  const issued = { grant, digest: G.grantDigest(grant) };
  const inside = verify(offlineEntry(srv, 'r1', { signedAt: T0, grant: issued }).envelope, 'os-r1');
  assert.equal(allowed(() => G.checkSignatureGrant(inside, grantReader)).grant.grantId, grant.grantId);
  const refusedWith = (code, entryOptions, readerOverride = grantReader) => assert.throws(() =>
    G.checkSignatureGrant(verify(offlineEntry(srv, 'r1', { grant: issued, ...entryOptions }).envelope, 'os-r1'), readerOverride), { code });
  refusedWith('GrantActionRefused', { signedAt: T0, action: 'addendum', previous: { recordId: srv.facts.recordId, versionId: 'v0', sha256: 'ab'.repeat(32) } });
  refusedWith('GrantWindowRefused', { signedAt: plus(grant.expiresAt, MIN) });
  refusedWith('GrantWindowRefused', { signedAt: plus(grant.expiresAt, -1000) });
  refusedWith('GrantWindowRefused', { signedAt: plus(issuedAt, -MIN) });
  refusedWith('GrantDigestRefused', { signedAt: T0 }, { load: id => ({ ...grantRows.get(id), actions: ['approve-sign', 'amend'] }) });
  const otherStudy = verify(envelopeFor({ ...payload({ action: 'approve-sign', recordId: 'report-unlisted', signer: 'r1', signedAt: T0, claimGeneration: 1,
    grant: { grantId: grant.grantId, digest: issued.digest } }) }), 'os-r1');
  assert.throws(() => G.checkSignatureGrant(otherStudy, grantReader), { code: 'GrantStudyRefused' });
  const interval = { earliest: T0, latest: T0 };
  assert.deepEqual({ ...G.offlineAccess(grant, 'offline', interval) }, { read: true, sign: true, keepUnsent: true });
  for (const situation of ['logged-out', 'account-switched', 'session-ended'])
    assert.deepEqual({ ...G.offlineAccess(grant, situation, interval) }, { read: false, sign: false, keepUnsent: true });
  assert.deepEqual({ ...G.offlineAccess(grant, 'offline', { earliest: grant.expiresAt, latest: grant.expiresAt }) }, { read: false, sign: false, keepUnsent: true });
});

test('C-C07 an equivalent retry with the same eventId returns the original receipt; the same eventId with other content is a 409 conflict, no duplicate version is made and a failed commit is journalled', async () => {
  const srv = server();
  await run(srv, 'r1', 'start', { at: plus(T0, -MIN) });
  // Two different signed approvals were made under one eventId before either reached the server.
  const plan = online(srv, 'r1', 'approve', { at: T0, signedEventId: 'event-c07' });
  const other = online(srv, 'r1', 'approve', { at: T0, signedEventId: 'event-c07', text: reportText('SYN 다른 본문') });
  const first = await commit(srv, plan);
  assert.equal(first.status, 'committed');
  const again = await allowedAsync(() => commit(srv, plan));
  assert.equal(again.status, 'duplicate');
  assert.deepEqual(again.receipt, first.receipt);
  const versions = () => srv.commits.filter(p => p.eventId === 'event-c07').length;
  assert.equal(versions(), 1);
  await assert.rejects(commit(srv, other), { code: 'EventIdConflict' });
  assert.equal(versions(), 1);
  assert.equal(srv.facts.publishedVersion.versionId, plan.version.ref.versionId);
  // A concurrent duplicate that won the unique key is answered from storage, not committed twice.
  const race = server(), raced = [];
  await run(race, 'r2', 'start', { at: plus(T0, -MIN) });
  const racePlan = online(race, 'r2', 'approve', { at: T0 });
  const real = storeFor(race);
  const racing = { async findReceipt(id) { raced.push(id); return raced.length === 1 ? null : real.findReceipt(id); },
    async commit(p) { await real.commit(p); throw Object.assign(new Error('unique'), { code: 'EventIdExists' }); } };
  const winner = await CMD.executeCommit(racePlan, racing, journalFor(race), () => T0);
  assert.equal(winner.status, 'duplicate');
  assert.equal(race.commits.filter(p => p.eventId === racePlan.eventId).length, 1);
  // Commit failure: journalled outside the rollback, nothing committed; if the journal also fails it still is no success.
  const fail = server();
  await run(fail, 'r1', 'start', { at: plus(T0, -MIN) });
  const failPlan = online(fail, 'r1', 'approve', { at: T0 });
  const failed = await commit(fail, failPlan, { commit: 'LedgerUnavailable' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.journal.journalId, 'journal-1');
  assert.equal(fail.facts.state, 'In Progress');
  assert.equal(fail.receipts.has(failPlan.eventId), false);
  const unrecorded = await commit(fail, failPlan, { commit: 'LedgerUnavailable', journal: true });
  assert.equal(unrecorded.status, 'failed');
  assert.equal(unrecorded.journal, null);
  // Offline: a resent committed event is a duplicate; a different event under the same ID is refused.
  const off = server();
  await run(off, 'r1', 'start', { at: plus(T0, -H) });
  const grant = grantFor(off, 'r1', plus(T0, -30 * MIN));
  const entry = offlineEntry(off, 'r1', { signedAt: T0, grant, eventId: 'event-c07-offline' });
  await reconcileAndCommit(off, entry, { receivedAt: plus(T0, H) });
  assert.equal(reconcile(off, entry, { receivedAt: plus(T0, 2 * H) }).kind, 'duplicate');
  const impostor = offlineEntry(off, 'r1', { signedAt: T0, grant, eventId: 'event-c07-offline', text: reportText('SYN 바뀐 본문') });
  const refused = reconcile(off, impostor, { receivedAt: plus(T0, 2 * H) });
  assert.equal(refused.kind, 'refused');
  assert.equal(refused.code, 'EventIdConflict');
  assert.equal(off.commits.filter(p => p.eventId === 'event-c07-offline').length, 1);
});

test('C-C08 bodies are served after the durable receipt to the actual target and version, display is a separate event, each write act is ledgered once; list/409 leaks, authorisation-as-read and invented offline addresses are refused', async () => {
  const srv = await approvedUnit(T0, 'r1');
  const ctx = (over = {}) => ({ actor: actor('c1', { roles: ['clinician'], canSign: false, canCancel: false }), roleAllowed: true, study: study(), facts: srv.facts, archive: null, resume: null,
    retained: { record: srv.record, at: plus(T0, H) }, ingress, now: plus(T0, H), ...over });
  const plan = allowed(() => RD.planReportRead(ctx(), { surface: 'clinician', versionId: null, eventId: 'read-1' }));
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
  // Each 제23조④ write act is ledgered exactly once with its act.
  const acts = plan => plan.ledger.filter(e => e.kind === 'access-v1').map(e => e.act);
  const writes = server();
  await run(writes, 'r1', 'start', { at: plus(T0, -MIN) });
  assert.deepEqual(acts(online(writes, 'r1', 'save', { at: plus(T0, -30000), draft: { expectedRevision: null, revision: 'e1:1', text: { findings: 'x', conclusion: '', recommendation: '' } } })), ['기재']);
  assert.deepEqual(acts((await run(writes, 'r1', 'approve', { at: T0 })).plan), ['기재']);
  assert.deepEqual(acts((await run(writes, 'r1', 'amend', { at: plus(T0, H) })).plan), ['수정']);
  assert.deepEqual(acts((await run(writes, 'r2', 'addendum', { at: plus(T0, 2 * H) })).plan), ['추가기재']);
  // Offline: the device never observed an IP; the reconnect address belongs to the separate receipt event.
  const off = server();
  await run(off, 'r1', 'start', { at: plus(T0, -H) });
  const grant = grantFor(off, 'r1', plus(T0, -30 * MIN));
  const entry = offlineEntry(off, 'r1', { signedAt: T0, grant });
  assert.throws(() => NP.parseOfflineObservation({ ...entry.access, ip: { status: 'known', value: { address: '192.0.2.10', source: 'trusted-proxy' } } }), { code: 'OfflineAddressRefused' });
  const { decision } = await reconcileAndCommit(off, entry, { receivedAt: plus(T0, H) });
  const observation = decision.plan.ledger.find(e => e.kind === 'offline-observation'), receipt = decision.plan.ledger.find(e => e.kind === 'offline-receipt');
  assert.deepEqual({ ...observation.event.ip }, { status: 'unresolved', reason: 'not-observed' });
  assert.equal(observation.act, '기재');
  assert.equal(receipt.event.ip.value.address, '192.0.2.10');
  assert.equal(receipt.event.relatedEventId, entry.eventId);
  // Conflict answers carry references and times, never the signed body.
  const conflicted = reconcile(off, offlineEntry(off, 'r1', { signedAt: plus(T0, MIN), grant, text: reportText('SYN 비공개 원문') }), { receivedAt: plus(T0, 2 * H) });
  assert.equal(conflicted.kind, 'conflict');
  assert.equal(deepHas(conflicted.response, 'SYN 비공개 원문'), false);
  assert.equal(deepHas(conflicted, 'SYN 비공개 원문'), false);
  const projection = RD.listProjection(srv.facts, true);
  assert.equal(deepHas(projection, 'SYN 소견 본문'), false);
  assert.equal(projection.publishedVersionId, srv.facts.publishedVersion.versionId);
});

test('C-C09 in each of the four reconnect conflicts the server state and my signed original are both kept; automatic merge or overwrite and early application of dependent events are refused', async () => {
  const same = (a, b) => assert.equal(JSON.stringify(a), JSON.stringify(b));
  // 1. Another reader approved meanwhile.
  const a = server();
  await run(a, 'r1', 'start', { at: plus(T0, -2 * H) });
  const ga = grantFor(a, 'r1', plus(T0, -2 * H + MIN));
  const mine = offlineEntry(a, 'r1', { signedAt: plus(T0, -H), grant: ga, text: reportText('SYN 내 승인 원문') });
  await run(a, 'r2', 'release', { at: plus(T0, -50 * MIN) });
  await run(a, 'r2', 'start', { at: plus(T0, -40 * MIN) });
  await run(a, 'r2', 'approve', { at: plus(T0, -30 * MIN) });
  const aBefore = a.facts;
  const r1 = reconcile(a, mine, { receivedAt: T0 });
  assert.equal(r1.kind, 'conflict'); assert.equal(r1.conflict, 'other-approved');
  assert.deepEqual([...r1.allowed], ['addendum-candidate']);
  assert.equal(r1.preserved, 'private-original');
  same(a.facts, aBefore);
  assert.equal(r1.response.currentVersion.versionId, a.facts.publishedVersion.versionId);
  assert.equal(deepHas(r1.response, 'SYN 내 승인 원문'), false);
  // 2. Reassigned / claim released.
  const b = server();
  await run(b, 'r1', 'start', { at: plus(T0, -2 * H) });
  const gb = grantFor(b, 'r1', plus(T0, -2 * H + MIN));
  const mineB = offlineEntry(b, 'r1', { signedAt: plus(T0, -H), grant: gb });
  await run(b, 'r2', 'release', { at: plus(T0, -50 * MIN) });
  const r2 = reconcile(b, mineB, { receivedAt: T0 });
  assert.equal(r2.kind, 'conflict'); assert.equal(r2.conflict, 'reassigned');
  assert.equal(b.facts.state, 'Unread');
  // 3. The parent report was cancelled: my amend and anything depending on it wait.
  const c = await approvedUnit(plus(T0, -3 * H), 'r1');
  const gc = grantFor(c, 'r1', plus(T0, -3 * H + MIN));
  const amend = offlineEntry(c, 'r1', { action: 'amend', signedAt: plus(T0, -2 * H), grant: gc });
  await run(c, 'r2', 'cancel', { at: plus(T0, -H), reason: 'SYN 취소 사유' });
  const r3 = reconcile(c, amend, { receivedAt: T0 });
  assert.equal(r3.kind, 'conflict'); assert.equal(r3.conflict, 'parent-cancelled');
  assert.equal(c.facts.state, 'Cancelled');
  // 4. The same clinician changed the draft elsewhere: no automatic adoption; explicit adoption keeps the original time.
  const d = server();
  await run(d, 'r1', 'start', { at: plus(T0, -2 * H) });
  await run(d, 'r1', 'save', { at: plus(T0, -110 * MIN), draft: { expectedRevision: null, revision: 'e1:1', text: { findings: 'SYN 1', conclusion: '', recommendation: '' } } });
  const gd = grantFor(d, 'r1', plus(T0, -100 * MIN));
  const signed = offlineEntry(d, 'r1', { signedAt: plus(T0, -H), grant: gd, draftRevision: 'e1:1' });
  await run(d, 'r1', 'save', { at: plus(T0, -50 * MIN), draft: { expectedRevision: 'e1:1', revision: 'e1:2', text: { findings: 'SYN 2', conclusion: '', recommendation: '' } } });
  const dBefore = d.facts;
  const r4 = reconcile(d, signed, { receivedAt: T0 });
  assert.equal(r4.kind, 'conflict'); assert.equal(r4.conflict, 'own-draft-diverged');
  same(d.facts, dBefore);
  assert.equal(d.commits.filter(p => p.version).length, 0);
  const adopted = await reconcileAndCommit(d, signed, { receivedAt: T0, adopt: true });
  assert.equal(adopted.result.status, 'committed');
  assert.equal(d.facts.firstApprovedAt, plus(T0, -H));
  // A dependent amend of a conflicted approval is held, not applied ahead of it.
  const dependent = offlineEntry(a, 'r1', { action: 'amend', signedAt: plus(T0, -55 * MIN), grant: ga, sequence: 2, predecessor: mine.eventId,
    previous: { recordId: a.facts.recordId, versionId: 'my-unadopted', sha256: 'ab'.repeat(32) } });
  const r5 = reconcile(a, dependent, { receivedAt: T0, predecessor: { eventId: mine.eventId, committed: false } });
  assert.equal(r5.kind, 'held'); assert.equal(r5.reason, 'predecessor-unresolved');
  same(a.facts, aBefore);
});

test('C-C10 a disconnection keeps working and only the signer\'s own new authentication resumes sending; treating disconnection as an end, another account\'s queue use and session revival are refused', async () => {
  for (const signal of [{ kind: 'network' }, { kind: 'timeout' }, { kind: 'http', status: 503 }, { kind: 'http', status: 401 }, { kind: 'http', status: 403, code: 'FORBIDDEN' },
    { kind: 'http', status: 409 }, { kind: 'http', status: 502, code: 'AUTH_SESSION_ENDED' }])
    assert.equal(Q.classifySessionSignal(signal), 'continue-offline', JSON.stringify(signal));
  assert.equal(Q.classifySessionSignal({ kind: 'http', status: 401, code: 'AUTH_SESSION_ENDED' }), 'awaiting-reauth');
  const owner = { issuer: ISS, subject: 'sub-r1', institutionId: 'inst-a', deviceId: 'dev-r1', osUserId: 'os-r1' };
  const session = over => ({ state: 'active', issuer: ISS, subject: 'sub-r1', institutionId: 'inst-a', deviceId: 'dev-r1', osUserId: 'os-r1', ...over });
  assert.equal(Q.queueAccess(owner, session()), 'own');
  for (const over of [{ subject: 'sub-r2' }, { osUserId: 'os-r2' }, { institutionId: 'inst-b' }, { issuer: 'https://other.example.test' }])
    assert.equal(Q.queueAccess(owner, session(over)), 'other-account');
  const srv = server();
  await run(srv, 'r1', 'start', { at: plus(T0, -H) });
  const grant = grantFor(srv, 'r1', plus(T0, -30 * MIN));
  const entry = offlineEntry(srv, 'r1', { signedAt: T0, grant });
  const ended = reconcile(srv, entry, { receivedAt: plus(T0, H), actor: { sessionState: 'ended' } });
  assert.equal(ended.kind, 'refused'); assert.equal(ended.code, 'SessionEnded');
  const otherAccount = reconcile(srv, entry, { receivedAt: plus(T0, H), submitter: 'r2' });
  assert.equal(otherAccount.kind, 'refused'); assert.equal(otherAccount.code, 'SubmitterNotSigner');
  assert.equal(srv.commits.filter(p => p.version).length, 0);
  const resumed = await reconcileAndCommit(srv, entry, { receivedAt: plus(T0, 2 * H) });
  assert.equal(resumed.result.status, 'committed');
  assert.equal(srv.facts.firstApprovedAt, T0);
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
  assert.equal(preserved.publish, false);
  assert.equal(preserved.facts.publishedVersion.versionId, srv.facts.publishedVersion.versionId);
  assert.equal(RT.readRetention(preserved.facts, srv.archive, null, { record: preserved.retention, at: later }).ordinaryClinicalAccess, false);
  // L5-03: archived within its own period: a preservation entry keeps the archive closed; a clinical Addendum reopens lawfully.
  const arc = await approvedUnit(T0, 'r1');
  finalize(arc, plus(T0, DAY));
  arc.archive = L.archiveFinalizedReport(arc.facts, { actor: { id: 'r1', kind: 'member', roles: ['radiologist'], canReadStudy: true, canSign: true, canCancel: true },
    at: plus(T0, DAY + H), reason: 'SYN 진료 목적 종료', purpose: 'clinical-purpose-ended', expectedPublishedVersionId: arc.facts.publishedVersion.versionId });
  const entryAt = plus(T0, DAY + 2 * H), inPeriod = { basisId: 'preservation-duty', authorized: true, preservesOriginals: true, separateManagement: true, permittedHoldIds: [] };
  const entry = allowed(() => online(arc, 'r2', 'addendum', { at: entryAt, preservation: 'entry', stored: { processing: inPeriod } }));
  assert.equal(entry.publish, false);
  const afterEntry = RT.readRetention(entry.facts, arc.archive, null, { record: entry.retention, at: entryAt });
  assert.equal(afterEntry.state, 'retention-only');
  assert.equal(afterEntry.ordinaryClinicalAccess, false);
  const clinical = allowed(() => online(arc, 'r2', 'addendum', { at: entryAt }));
  assert.equal(clinical.publish, true);
  assert.equal(RT.readRetention(clinical.facts, arc.archive, null, { record: clinical.retention, at: entryAt }).ordinaryClinicalAccess, true);
  // L5-04: every read names the stored record and the instant.
  const fresh = await approvedUnit(T0, 'r1');
  const readCtx = retained => ({ actor: actor('r2'), roleAllowed: true, study: study(), facts: fresh.facts, archive: null, resume: null, retained, ingress, now: plus(T0, H) });
  for (const missing of [null, undefined, { record: fresh.record }, { at: plus(T0, H) }])
    assert.throws(() => RD.planReportRead(readCtx(missing), { surface: 'reader', versionId: null, eventId: 'read-c11' }), { code: 'RetainedReadArgumentRequired' });
  allowed(() => RD.planReportRead(readCtx({ record: fresh.record, at: plus(T0, H) }), { surface: 'reader', versionId: null, eventId: 'read-c11' }));
  assert.throws(() => RD.planReportRead(readCtx({ record: fresh.record, at: later }), { surface: 'reader', versionId: null, eventId: 'read-c11b' }), { code: 'RetentionOnlyAccessRefused' });
  // An existing unit never takes a signed part without its retained record.
  assert.throws(() => online(fresh, 'r1', 'amend', { at: plus(T0, H), retained: { ...retainedFor(fresh, verify(envelopeFor(payload({ action: 'amend', recordId: fresh.facts.recordId,
    signer: 'r1', signedAt: plus(T0, H), claimGeneration: fresh.facts.claimGeneration, previous: fresh.facts.bodyVersion })), 'os-r1')), record: null } }), { code: 'RetainedRecordRequired' });
});

test('C-C12 signed unadopted originals keep the report classification and recovery copies end with their purpose; draft end, cache expiry or an unverified receipt never delete the only signed original', () => {
  const original = RT.offlineArtifactRetention('signed-unadopted-original');
  const report = C.RECORD_CLASSIFICATION['report-version'].retention;
  assert.equal(original.mode, 'statutory');
  // The period is A's report-version classification, never a number fixed in C (legal register LR-15/§5-02, D-19).
  assert.equal(original.years, report.years);
  assert.deepEqual([...original.clauseIds], report.statutoryMinimum.map(m => m.clauseId));
  assert.equal(original.autoPublish, false);
  const recovery = RT.offlineArtifactRetention('recovery-work-copy');
  assert.equal(recovery.mode, 'purpose');
  assert.equal(recovery.years, null);
  assert(recovery.purposeEnds.length > 0);
  const cache = RT.offlineArtifactRetention('offline-cache-copy');
  assert.equal(cache.mode, 'cache');
  assert.equal(cache.years, null);
  assert.equal(RT.offlineArtifactRetention('unsigned-private-draft').mode, 'purpose');
  assert.throws(() => RT.offlineArtifactRetention('anything-else'), { code: 'OfflineArtifactUnknown' });
  assert.equal(RT.mayRemoveLocalOriginal('server-retention-receipt', { eventId: 'e-1', verified: true }, 'e-1'), true);
  for (const cause of ['draft-purpose-ended', 'cache-evicted', 'logout', 'grant-expired', 'conflict'])
    assert.equal(RT.mayRemoveLocalOriginal(cause, { eventId: 'e-1', verified: true }, 'e-1'), false, cause);
  assert.equal(RT.mayRemoveLocalOriginal('server-retention-receipt', { eventId: 'e-1', verified: false }, 'e-1'), false);
  assert.equal(RT.mayRemoveLocalOriginal('server-retention-receipt', { eventId: 'e-2', verified: true }, 'e-1'), false);
  assert.equal(RT.mayRemoveLocalOriginal('server-retention-receipt', null, 'e-1'), false);
});

test('C-C13 read and print requests stay on one version and an acknowledgement belongs to its version; printing another version, claiming paper output from print() and carrying an old ACK to a new version are refused', async () => {
  const srv = await approvedUnit(T0, 'r1');
  const v1 = srv.facts.publishedVersion;
  await run(srv, 'r1', 'amend', { at: plus(T0, H) });
  const v2 = srv.facts.publishedVersion;
  const ctx = { actor: actor('r2'), roleAllowed: true, study: study(), facts: srv.facts, archive: null, resume: null, retained: { record: srv.record, at: plus(T0, 2 * H) }, ingress, now: plus(T0, 2 * H) };
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
  // The offline print observation is a client report only.
  const off = server();
  await run(off, 'r1', 'start', { at: plus(T0, -H) });
  const grant = grantFor(off, 'r1', plus(T0, -30 * MIN));
  const access = offlineEntry(off, 'r1', { signedAt: T0, grant }).access;
  const printed = { ...access, action: 'print-done', relatedEventId: 'print-opened-1', physicalOutput: 'not-observed' };
  allowed(() => NP.parseOfflineObservation(printed));
  assert.throws(() => NP.parseOfflineObservation({ ...printed, physicalOutput: 'printed' }), { code: 'PrintCompletionRefused' });
  assert.throws(() => NP.parseOfflineObservation({ ...access, action: 'print-done', relatedEventId: 'p', physicalOutput: null }), { code: 'PrintCompletionRefused' });
});

test('C-C14 the C1 declaration matches the files and collected cases exactly; missing, duplicate or undeclared files, existing single-writer paths and not-run cases counted as passed are refused', () => {
  const unit = declaration();
  assert.deepEqual(Object.keys(unit).sort(), ['base_sha', 'candidate_cases', 'cases', 'consumers', 'dependencies', 'deployment', 'expected', 'forbidden_single_writer', 'live',
    'migrations', 'models', 'mutants', 'order', 'owned_paths', 'records', 'req_risk_test', 'restore', 'round', 'routes', 'unit'].sort());
  assert.equal(unit.round, 'C1');
  const owned = unit.owned_paths;
  assert.equal(owned.length, 20);
  assert.equal(new Set(owned).size, 20);
  for (const file of owned) assert(fs.statSync(path.join(root, file)).isFile(), file);
  assert.deepEqual(owned.filter(p => unit.forbidden_single_writer.includes(p)), []);
  for (const dir of ['api/src/emr-report', 'api/src/emr-signature', 'tests/emr/c']) {
    const present = fs.readdirSync(path.join(root, dir), { withFileTypes: true }).filter(e => !(e.isDirectory() && e.name === '__pycache__')).map(e => dir + '/' + e.name);
    assert.deepEqual(present.filter(p => !owned.includes(p)), [], dir);
  }
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
  assert.deepEqual(collected('tests/emr/c/offline_queue_test.cjs'), unit.cases.queue);
  assert.deepEqual(unit.expected, { contract: 14, queue: 8, dom: 6, total: 28 });
  assert.equal(unit.cases.contract.length + unit.cases.queue.length + unit.cases.dom.length, unit.expected.total);
  for (const empty of [unit.routes.active, unit.models.active, unit.records.active, unit.migrations.active, unit.live.active, unit.candidate_cases]) assert.deepEqual(empty, []);
  // The exact-selection judge accepts only every declared case passing once.
  const ids = ['C-C01', 'C-Q01'];
  const tap = lines => 'TAP version 13\n' + lines.join('\n') + '\n1..' + lines.length + '\n';
  assert.equal(judgeTap(tap(['ok 1 - C-C01 a', 'ok 2 - C-Q01 b']), ids).ok, true);
  for (const lines of [['ok 1 - C-C01 a', 'ok 2 - C-Q01 b # SKIP'], ['ok 1 - C-C01 a'], ['ok 1 - C-C01 a', 'ok 2 - C-C01 a', 'ok 3 - C-Q01 b'],
    ['ok 1 - C-C01 a', 'not ok 2 - C-Q01 b'], ['ok 1 - C-C01 a', 'ok 2 - C-Q01 b', 'ok 3 - C-C99 extra'], ['ok 1 - C-C01 a', 'ok 2 - C-Q01 b # TODO later']])
    assert.equal(judgeTap(tap(lines), ids).ok, false, lines.join('|'));
});
