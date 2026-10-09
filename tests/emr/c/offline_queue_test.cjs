/* EMR-C1 offline queue tests C-Q01..C-Q08 (order §7): REQ-EMR-02/03/07/12/13/14/17 -> RISK-EMR-* -> TEST C-Qnn.
 * Runs the real queue model (api/src/emr-report/offline-queue.ts) over an explicit synthetic durable-store port with
 * fault injection, and sends to a synthetic server that runs the real reconcile + commit planning. The store port stands
 * in for the C-NATIVE protected store: these cases prove the queue's state rules, not real disk durability, encryption
 * or crash safety, which remain C-NATIVE T1-T5 acceptance. No product string or internal name is pinned.
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..', '..', '..');
const api = path.join(root, 'api');
const ts = require(path.join(api, 'node_modules/typescript'));
const config = ts.readConfigFile(path.join(api, 'tsconfig.json'), ts.sys.readFile);
assert.equal(config.error, undefined);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, api);
const previousLoader = require.extensions['.ts'];
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'),
  { compilerOptions: parsed.options, fileName: filename }).outputText, filename);
const load = name => require(path.join(api, 'src', name + '.ts'));
const M = load('emr-contract/composition'), C = load('emr-contract/classification'), L = load('emr-contract/report-lifecycle');
const CV = load('emr-signature/canonical-v2'), K = load('emr-signature/keys'), V = load('emr-signature/verify'), NP = load('emr-signature/native-port');
const CMD = load('emr-report/commands'), G = load('emr-report/offline-grant'), Q = load('emr-report/offline-queue'), REC = load('emr-report/reconcile');
if (previousLoader) require.extensions['.ts'] = previousLoader; else delete require.extensions['.ts'];

const storedRows = new Map();
const caps = M.composeEmrAdapters({
  stored: { load: (id, eventId) => storedRows.get(id + ':' + eventId) },
  legal: { load: () => undefined, listHolds: id => ({ recordId: id, holdIds: [], complete: true }) },
  purpose: { load: () => undefined, loadSignedResult: () => undefined },
  clinical: { loadStudy: () => undefined, loadReportPatient: () => undefined },
});
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const ms = s => Date.parse(s), iso = n => new Date(n).toISOString(), plus = (s, d) => iso(ms(s) + d);
const MIN = 60000, H = 3600000;
const T0 = '2026-10-05T01:00:00.000Z', ISS = 'https://identity.example.test', STUDY = '1.2.840.99999.2';
const patient = { linkId: 'link-q', patientId: 'SYN-Q', assigningAuthority: 'hospital-a' };
const who = id => ({ id, issuer: ISS, subject: 'sub-' + id });
const actor = (id, over = {}) => ({ identity: who(id), identityRegistrationId: 'reg-' + id, kind: 'member', roles: ['radiologist'], institutionId: 'inst-a',
  canSign: true, canCancel: true, rightsVersion: 'rights-1', sessionState: 'active', ...over });
const study = () => ({ studyId: STUDY, patient: { ...patient }, managingInstitutionId: 'inst-a', readingInstitutionIds: ['inst-a'], assignment: { readerId: null, generation: 0 } });
const ingress = { requestId: 'request-q', ip: { status: 'known', value: { address: '192.0.2.20', source: 'trusted-proxy' } } };
let counter = 0;
const next = prefix => `${prefix}-${++counter}`;

// Explicit test-only values; the product values of epsilon/Q/J/H are measured on devices (D603) and are not known here.
const keyRows = new Map(), privateKeys = new Map(), anchorRows = new Map(), grantRows = new Map();
const keyPolicy = { acceptedEvidence: ['test-software'] }, timePolicy = { epsilonMs: 2000, reviewRef: 'test-only:not-a-product-value' };
const ports = { keys: { load: kid => keyRows.get(kid) ?? null, holderOf: t => [...keyRows.values()].find(r => K.jwkThumbprint(r.publicKey) === t)?.kid ?? null },
  keyPolicy, anchors: { load: id => anchorRows.get(id) ?? null }, timePolicy };
const offlinePolicy = { imageBytesQ: 10_000_000, reserveBytesJ: 1_000_000, disconnectedHoursH: 12, epsilonMs: 2000, reviewRef: 'test-only:not-a-product-value' };
for (const id of ['r1', 'r2']) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }), jwk = publicKey.export({ format: 'jwk' });
  keyRows.set('kid-' + id, K.registerDeviceKey({ kid: 'kid-' + id, deviceId: 'dev-' + id, osUserId: 'os-' + id, publicKey: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
    evidence: { kind: 'test-software', evidenceId: 'evidence-' + id }, at: '2026-09-01T00:00:00.000Z', actorId: 'registrar-1' },
    { identity: who(id), identityRegistrationId: 'reg-' + id, institutionId: 'inst-a', canSign: true, verifiedAt: '2026-09-01T00:00:00.000Z' }, keyPolicy, ports.keys));
  privateKeys.set('kid-' + id, privateKey);
}
const ownerOf = id => ({ issuer: ISS, subject: 'sub-' + id, institutionId: 'inst-a', deviceId: 'dev-' + id, osUserId: 'os-' + id });
const sessionOf = (id, state = 'active') => ({ state, ...ownerOf(id) });

// ---- the synthetic server: real planning (reconcile + executeCommit), synthetic storage ----
function server() {
  const srv = { facts: L.newReportFacts(next('report'), STUDY), record: null, receipts: new Map(), commits: [], submitted: [] };
  return srv;
}
function claim(srv, id, at) {
  srv.facts = L.transitionReport(srv.facts, { action: 'start', actor: { id, kind: 'member', roles: ['radiologist'], canReadStudy: true, canSign: true, canCancel: true },
    at, expectedClaimGeneration: srv.facts.claimGeneration, expectedPublishedVersionId: null }).facts;
}
function grantFor(srv, id, issuedAt) {
  const key = keyRows.get('kid-' + id), part = name => ({ part: name, sha256: sha(name), verifiedSha256: sha(name), bytes: 10 });
  const readiness = G.offlineReadiness({ manifestId: 'm', studies: [{ studyId: STUDY, role: 'current', parts: G.MANIFEST_PARTS.map(part) }], requiredComparisonIds: [] },
    offlinePolicy, { bytes: offlinePolicy.reserveBytesJ });
  const issued = G.issueOfflineGrant({ grantId: next('grant'), deviceId: key.deviceId, kid: key.kid, studies: [{ studyId: STUDY, recordId: srv.facts.recordId,
    claimGeneration: srv.facts.claimGeneration, role: 'current' }], actions: ['approve-sign', 'amend', 'addendum'], issuedAt, anchorId: 'grant-anchor' }, actor(id), key, offlinePolicy, readiness);
  grantRows.set(issued.grant.grantId, issued.grant);
  return issued;
}
function entry(srv, id, o) {
  const action = o.action ?? 'approve-sign', key = keyRows.get('kid-' + id), signedAt = o.signedAt;
  const anchorId = next('anchor'), serverTime = plus(signedAt, -H);
  anchorRows.set(anchorId, { anchorId, deviceId: key.deviceId, bootId: 'boot-1', serverTime, validUntil: plus(serverTime, 48 * H) });
  const basis = { anchorId, anchorServerTime: serverTime, anchorValidUntil: plus(serverTime, 48 * H), anchorBootId: 'boot-1', anchorTickMs: 1000,
    signBootId: o.signBoot ?? 'boot-1', signTickMs: 1000 + H, wallClockEvents: [], interval: { earliest: plus(signedAt, -2000), latest: plus(signedAt, 2000) } };
  const previous = o.previous !== undefined ? o.previous : action === 'approve-sign' ? null : srv.facts.bodyVersion;
  const p = { formatVersion: 'emr-signature/2', text: { kind: 'report', findings: o.findings ?? 'SYN Q 소견', conclusion: '', recommendation: '' }, patient: { ...patient },
    managingInstitutionId: 'inst-a', actingInstitutionId: 'inst-a', studyId: STUDY, recordKind: 'report-version', recordId: srv.facts.recordId, versionId: next('version'),
    previousVersion: previous, attachments: [], author: who(id), signer: who(id), identityRegistrationId: 'reg-' + id, action, reason: null,
    eventId: o.eventId ?? next('event'), deviceId: key.deviceId, kid: key.kid, grant: { grantId: o.grant.grant.grantId, digest: o.grant.digest },
    claimGeneration: o.claimGeneration ?? srv.facts.claimGeneration, draftRevision: null, deviceSequence: o.sequence ?? 1, predecessorEventId: o.predecessor ?? null,
    signedAt, timeBasis: basis };
  const header = CV.protectedHeaderV2(key.kid).toString('base64url'), body = CV.canonicalPayloadV2(p).toString('base64url');
  const envelope = { protected: header, payload: body,
    signature: crypto.sign('sha256', Buffer.from(header + '.' + body), { key: privateKeys.get(key.kid), dsaEncoding: 'ieee-p1363' }).toString('base64url') };
  return { formatVersion: 'emr-offline-queue/1', eventId: p.eventId, owner: ownerOf(id), deviceSequence: p.deviceSequence, predecessorEventId: p.predecessorEventId, envelope,
    access: { formatVersion: 'emr-offline-access/1', eventId: p.eventId, relatedEventId: null, deviceId: key.deviceId, deviceSequence: p.deviceSequence, kid: key.kid, identity: who(id),
      actingInstitutionId: 'inst-a', managingInstitutionId: 'inst-a', action, target: { patient: { ...patient }, studyId: STUDY, recordId: p.recordId, versionId: p.versionId },
      occurredAt: signedAt, timeBasis: basis, ip: { status: 'unresolved', reason: 'not-observed' }, network: 'offline', physicalOutput: null },
    baseVersionId: previous ? previous.versionId : null };
}
function retainedFor(srv, sig) {
  const p = sig.payload, recordId = srv.facts.recordId, prev = srv.record ? srv.record.parts[srv.record.parts.length - 1] : null, eventId = 'stored:' + p.versionId;
  storedRows.set(recordId + ':' + eventId, { recordId, model: 'ReportVersion', row: {}, event: { eventId, recordId, versionId: p.versionId, sha256: sig.versionSha256,
    contentSha256: sha('content:' + sig.versionSha256), at: p.signedAt, act: p.action === 'approve-sign' ? 'entry' : p.action === 'addendum' ? 'additional-entry' : 'correction',
    signature: { versionId: p.versionId, sha256: sig.versionSha256, signedAt: p.signedAt, verified: true },
    predecessor: prev ? { recordId, partId: prev.partId, sha256: prev.evidence.event.sha256 } : null, components: [], processing: null } });
  return { record: srv.record, source: C.resolveStoredRecord(caps.stored, recordId, eventId),
    graph: srv.record ? { records: [srv.record], references: [], complete: true, revision: 'r', checkedAt: p.signedAt } : null, archive: null };
}
/** A transport to the synthetic server. `lose` drops the answer after the server acted (response loss). */
function transport(srv, { receivedAt = plus(T0, 2 * H), lose = 0, fail = null, ended = false, commitFault = null } = {}) {
  let toLose = lose;
  return { async submit(e) {
    srv.submitted.push(e.eventId);
    if (ended) throw { kind: 'http', status: 401, code: 'AUTH_SESSION_ENDED' };
    if (fail) throw fail;
    const p = JSON.parse(Buffer.from(e.envelope.payload, 'base64url').toString('utf8'));
    let retained = null;
    try { retained = retainedFor(srv, V.verifySignatureV2(e.envelope, ports, { osUserId: e.owner.osUserId })); } catch { retained = null; }
    const predecessor = p.predecessorEventId === null ? null : { eventId: p.predecessorEventId, committed: srv.receipts.has(p.predecessorEventId) };
    const decision = REC.reconcileOfflineEvent({ actor: actor(p.signer.id), study: study(), facts: srv.facts, author: who(p.author.id), ownDraftRevision: null, attachments: [],
      retained, receivedAt, ingress, verification: ports, grants: { load: id => grantRows.get(id) ?? null }, existingReceipt: srv.receipts.get(e.eventId) ?? null,
      predecessor, adoptDivergedDraft: false }, e);
    let response = decision.response;
    if (decision.kind === 'commit') {
      const store = { async findReceipt(id) { return srv.receipts.get(id) ?? null; }, async commit(plan) {
        if (commitFault) throw Object.assign(new Error('synthetic'), { code: commitFault });
        const receipt = { eventId: plan.eventId, contentDigest: plan.contentDigest, recordId: plan.recordId, versionId: plan.version.ref.versionId, committedAt: receivedAt,
          publishedAt: plan.publish ? receivedAt : null, ledgerReceipts: plan.ledger.map(x => ({ eventId: x.event.eventId, durableAt: receivedAt })) };
        srv.facts = plan.facts; srv.record = plan.retention ?? srv.record; srv.receipts.set(plan.eventId, receipt); srv.commits.push(plan.eventId); return receipt;
      } };
      const result = await CMD.executeCommit(decision.plan, store, { async record(f) { return { journalId: 'j-' + f.eventId, durableAt: f.at }; } }, () => receivedAt);
      response = REC.commitResponse(decision.plan, result);
    }
    if (toLose > 0) { toLose--; throw { kind: 'network' }; }
    return response;
  } };
}

/** The protected store stand-in: rows keyed by eventId per owner, with explicit faults. */
function memoryStore({ putFault = null, receiptOverride = null, reserveFault = false, reserveBytes = null, leakOther = null } = {}) {
  const rows = new Map(), calls = [];
  return { rows, calls,
    async reserve(bytes) { calls.push('reserve'); if (reserveFault) throw new Error('disk full'); return { reservationId: 'res-1', bytes: reserveBytes ?? bytes }; },
    async put(e, digest) {
      calls.push('put:' + e.eventId);
      if (putFault === 'before-write') throw Object.assign(new Error('disk full'), { code: 'StoreFull' });
      rows.set(e.eventId, { entry: JSON.parse(JSON.stringify(e)), digest, state: 'pending' });
      if (putFault === 'after-write') throw Object.assign(new Error('crash'), { code: 'Crash' });
      return receiptOverride ? receiptOverride(e, digest) : { eventId: e.eventId, entryId: 'entry-' + e.eventId, digest, durableAt: T0 };
    },
    async list(owner) {
      const own = [...rows.values()].filter(r => r.entry.owner.subject === owner.subject && r.entry.owner.osUserId === owner.osUserId).map(r => JSON.parse(JSON.stringify(r)));
      return leakOther ? [...own, ...leakOther] : own;
    },
    async setState(eventId, state) { calls.push(`state:${eventId}:${state}`); rows.get(eventId).state = state; },
    async remove(eventId) { calls.push('remove:' + eventId); rows.delete(eventId); },
  };
}
const states = list => Object.fromEntries(list.map(x => [x.eventId, x.state]));
/** An expected-success send: a rejection is an assertion failure of the case, not an unrelated error. */
const sent = async (queue, t, session) => { let value; await assert.doesNotReject(async () => { value = await queue.send(t, session); }); return value; };

test('C-Q01 an approval is pending only after the durable write of the exact entry; a failed, partial or mismatched write is not shown as saved', async () => {
  const srv = server(); claim(srv, 'r1', plus(T0, -H));
  const grant = grantFor(srv, 'r1', plus(T0, -30 * MIN));
  const e = entry(srv, 'r1', { signedAt: T0, grant });
  const store = memoryStore(), queue = Q.createOfflineQueue({ store, owner: ownerOf('r1') });
  const ok = await queue.enqueue(e);
  assert.equal(ok.status, 'pending-offline');
  assert.equal(ok.receipt.digest, NP.queueEntryDigest(e));
  assert.deepEqual(states(await queue.recover()), { [e.eventId]: 'pending' });
  for (const options of [{ putFault: 'before-write' }, { receiptOverride: (x, d) => ({ eventId: x.eventId, entryId: 'e', digest: 'ab'.repeat(32), durableAt: T0 }) },
    { receiptOverride: x => ({ eventId: 'other', entryId: 'e', digest: NP.queueEntryDigest(x), durableAt: T0 }) }, { receiptOverride: () => null }]) {
    const failing = memoryStore(options), q = Q.createOfflineQueue({ store: failing, owner: ownerOf('r1') });
    const result = await q.enqueue(e);
    assert.equal(result.status, 'not-saved', JSON.stringify(Object.keys(options)));
  }
  const empty = memoryStore({ putFault: 'before-write' }), q2 = Q.createOfflineQueue({ store: empty, owner: ownerOf('r1') });
  assert.equal((await q2.enqueue(e)).status, 'not-saved');
  assert.deepEqual(await q2.recover(), []);
  await assert.rejects(Q.createOfflineQueue({ store: memoryStore(), owner: ownerOf('r2') }).enqueue(e), { code: 'OwnerMismatch' });
  // The runtime's answer counts only for exactly the requested payload with a durable receipt of that entry.
  const request = { payload: JSON.parse(Buffer.from(e.envelope.payload, 'base64url').toString('utf8')), access: e.access, owner: e.owner, baseVersionId: e.baseVersionId };
  const durable = { eventId: e.eventId, entryId: 'row-1', digest: NP.queueEntryDigest(e), durableAt: T0 };
  assert.equal(NP.parseSignApprovalResult({ protocol: NP.NATIVE_PROTOCOL, entry: e, durable }, request).digest, durable.digest);
  assert.throws(() => NP.parseSignApprovalResult({ protocol: NP.NATIVE_PROTOCOL, entry: e, durable: { ...durable, digest: 'ab'.repeat(32) } }, request), { code: 'DurableReceiptRequired' });
  const other = entry(srv, 'r1', { signedAt: T0, grant, findings: 'SYN 다른 서명 본문' });
  assert.throws(() => NP.parseSignApprovalResult({ protocol: NP.NATIVE_PROTOCOL, entry: other, durable: { ...durable, eventId: other.eventId, digest: NP.queueEntryDigest(other) } }, request),
    { code: 'NativeSignedOtherContent' });
  await assert.rejects(queue.enqueue({ ...e, access: { ...e.access, occurredAt: plus(T0, 1) } }), { code: 'QueueEntryInconsistent' });
});

test('C-Q02 after a restart intact entries resume in order; a damaged entry is detected, kept and not sent, and later entries wait behind it', async () => {
  const srv = server(); claim(srv, 'r1', plus(T0, -H));
  const grant = grantFor(srv, 'r1', plus(T0, -30 * MIN));
  const store = memoryStore();
  const entries = [1, 2, 3].map(n => entry(srv, 'r1', { signedAt: plus(T0, n * MIN), grant, sequence: n }));
  const first = Q.createOfflineQueue({ store, owner: ownerOf('r1') });
  for (const e of entries) assert.equal((await first.enqueue(e)).status, 'pending-offline');
  const restarted = Q.createOfflineQueue({ store, owner: ownerOf('r1') });
  assert.deepEqual(Object.values(states(await restarted.recover())), ['pending', 'pending', 'pending']);
  store.rows.get(entries[1].eventId).entry.access.occurredAt = plus(T0, 59 * MIN);
  const recovered = states(await restarted.recover());
  assert.deepEqual([recovered[entries[0].eventId], recovered[entries[1].eventId], recovered[entries[2].eventId]], ['pending', 'corrupt', 'held']);
  const t = transport(srv);
  await sent(restarted, t, sessionOf('r1'));
  assert.deepEqual(srv.submitted, [entries[0].eventId]);
  assert(store.rows.has(entries[1].eventId) && store.rows.has(entries[2].eventId));
  const leaking = memoryStore({ leakOther: [{ entry: entry(srv, 'r2', { signedAt: T0, grant: grantFor(srv, 'r2', plus(T0, -30 * MIN)) }), digest: 'ab'.repeat(32), state: 'pending' }] });
  await assert.rejects(Q.createOfflineQueue({ store: leaking, owner: ownerOf('r1') }).recover(), { code: 'OwnerMismatch' });
});

test('C-Q03 a resend after a lost answer carries the original eventId and is applied once; another entry under the same eventId is refused', async () => {
  const srv = server(); claim(srv, 'r1', plus(T0, -H));
  const grant = grantFor(srv, 'r1', plus(T0, -30 * MIN));
  const e = entry(srv, 'r1', { signedAt: T0, grant, eventId: 'event-q03' });
  const store = memoryStore(), queue = Q.createOfflineQueue({ store, owner: ownerOf('r1') });
  await queue.enqueue(e);
  assert.deepEqual(states(await sent(queue, transport(srv, { lose: 1 }), sessionOf('r1'))), { 'event-q03': 'sent-unknown' });
  assert.deepEqual(srv.commits, ['event-q03']);
  assert.deepEqual(states(await sent(queue, transport(srv), sessionOf('r1'))), { 'event-q03': 'committed' });
  assert.deepEqual(srv.submitted, ['event-q03', 'event-q03']);
  assert.deepEqual(srv.commits, ['event-q03']);
  assert.equal(srv.facts.firstApprovedAt, T0);
  const impostor = entry(srv, 'r1', { signedAt: plus(T0, MIN), grant, eventId: 'event-q03', findings: 'SYN 다른 본문', previous: null, claimGeneration: 1 });
  const store2 = memoryStore(), q2 = Q.createOfflineQueue({ store: store2, owner: ownerOf('r1') });
  await q2.enqueue(impostor);
  assert.deepEqual(states(await sent(q2, transport(srv), sessionOf('r1'))), { 'event-q03': 'refused' });
  assert.deepEqual(srv.commits, ['event-q03']);
  assert(store2.rows.has('event-q03'));
});

test('C-Q04 a conflicting approval stays as conflict with its original kept, and events depending on it are held instead of being sent ahead', async () => {
  const srv = server(); claim(srv, 'r1', plus(T0, -2 * H));
  const grant = grantFor(srv, 'r1', plus(T0, -2 * H + MIN));
  const approval = entry(srv, 'r1', { signedAt: plus(T0, -H), grant, sequence: 1 });
  const amend = entry(srv, 'r1', { action: 'amend', signedAt: plus(T0, -50 * MIN), grant, sequence: 2, predecessor: approval.eventId,
    previous: { recordId: srv.facts.recordId, versionId: 'my-approval', sha256: 'ab'.repeat(32) } });
  // Meanwhile another reader took over and approved on the server.
  srv.facts = L.transitionReport(srv.facts, { action: 'release', actor: { id: 'r2', kind: 'member', roles: ['radiologist'], canReadStudy: true, canSign: true, canCancel: true },
    at: plus(T0, -40 * MIN), expectedClaimGeneration: srv.facts.claimGeneration, expectedPublishedVersionId: null }).facts;
  claim(srv, 'r2', plus(T0, -35 * MIN));
  srv.facts = L.transitionReport(srv.facts, { action: 'approve', actor: { id: 'r2', kind: 'member', roles: ['radiologist'], canReadStudy: true, canSign: true, canCancel: true },
    at: plus(T0, -30 * MIN), expectedClaimGeneration: srv.facts.claimGeneration, expectedPublishedVersionId: null, version: { recordId: srv.facts.recordId, versionId: 'server-v', sha256: 'cd'.repeat(32) } }).facts;
  const before = JSON.stringify(srv.facts);
  const store = memoryStore(), queue = Q.createOfflineQueue({ store, owner: ownerOf('r1') });
  await queue.enqueue(approval); await queue.enqueue(amend);
  const result = states(await sent(queue, transport(srv), sessionOf('r1')));
  assert.equal(result[approval.eventId], 'conflict');
  assert.equal(result[amend.eventId], 'held');
  assert.deepEqual(srv.submitted, [approval.eventId]);
  assert.equal(JSON.stringify(srv.facts), before);
  assert(store.rows.has(approval.eventId) && store.rows.has(amend.eventId));
  assert.equal(store.calls.filter(c => c.startsWith('remove:')).length, 0);
});

test('C-Q05 a disconnection keeps the queue pending, a real session end pauses it for re-authentication, another account cannot send it and the owner\'s new session resumes it', async () => {
  const srv = server(); claim(srv, 'r1', plus(T0, -H));
  const grant = grantFor(srv, 'r1', plus(T0, -30 * MIN));
  const e = entry(srv, 'r1', { signedAt: T0, grant });
  const store = memoryStore(), queue = Q.createOfflineQueue({ store, owner: ownerOf('r1') });
  await queue.enqueue(e);
  for (const fail of [{ kind: 'network' }, { kind: 'timeout' }, { kind: 'http', status: 503 }, { kind: 'http', status: 401 }])
    assert.equal(states(await sent(queue, transport(srv, { fail }), sessionOf('r1')))[e.eventId], 'sent-unknown', JSON.stringify(fail));
  assert.equal(states(await sent(queue, transport(srv, { ended: true }), sessionOf('r1')))[e.eventId], 'awaiting-reauth');
  assert(store.rows.has(e.eventId));
  assert.equal(states(await sent(queue, transport(srv), sessionOf('r1', 'ended')))[e.eventId], 'awaiting-reauth');
  const submittedBefore = srv.submitted.length;
  await assert.rejects(queue.send(transport(srv), sessionOf('r2')), { code: 'OwnerMismatch' });
  assert.equal(srv.submitted.length, submittedBefore);
  assert.deepEqual(await Q.createOfflineQueue({ store, owner: ownerOf('r2') }).recover(), []);
  assert.equal(states(await sent(queue, transport(srv), sessionOf('r1')))[e.eventId], 'committed');
  assert.equal(srv.facts.firstApprovedAt, T0);
});

test('C-Q06 events outside the grant window or with unverifiable time are not applied, and their signed originals stay in the queue', async () => {
  const srv = server(); claim(srv, 'r1', plus(T0, -H));
  const grant = grantFor(srv, 'r1', plus(T0, -30 * MIN));
  const late = entry(srv, 'r1', { signedAt: plus(grant.grant.expiresAt, MIN), grant, sequence: 1 });
  const rebooted = entry(srv, 'r1', { signedAt: T0, grant, sequence: 2, signBoot: 'boot-2' });
  const store = memoryStore(), queue = Q.createOfflineQueue({ store, owner: ownerOf('r1') });
  await queue.enqueue(late); await queue.enqueue(rebooted);
  const result = states(await sent(queue, transport(srv), sessionOf('r1')));
  assert.equal(result[late.eventId], 'refused');
  assert.equal(result[rebooted.eventId], 'held');
  assert.deepEqual(srv.commits, []);
  assert(store.rows.has(late.eventId) && store.rows.has(rebooted.eventId));
  const access = G.offlineAccess(grant.grant, 'offline', { earliest: grant.grant.expiresAt, latest: grant.grant.expiresAt });
  assert.equal(access.sign, false);
  assert.equal(access.keepUnsent, true);
  const ok = entry(srv, 'r1', { signedAt: T0, grant, sequence: 3 });
  const q2 = Q.createOfflineQueue({ store: memoryStore(), owner: ownerOf('r1') });
  await q2.enqueue(ok);
  assert.equal(states(await sent(q2, transport(srv), sessionOf('r1')))[ok.eventId], 'committed');
});

test('C-Q07 queue space J is reserved before images load, and no eviction, logout, grant expiry or draft end deletes an unsent signed original; only a verified retention receipt does', async () => {
  const loads = [];
  const store = memoryStore();
  const prepared = await Q.prepareOfflineWork(store, offlinePolicy, async () => { loads.push(store.calls.slice()); });
  assert.equal(prepared.loaded, true);
  assert.deepEqual(loads, [['reserve']]);
  for (const options of [{ reserveFault: true }, { reserveBytes: 10 }]) {
    const s = memoryStore(options); let loaded = false;
    const r = await Q.prepareOfflineWork(s, offlinePolicy, async () => { loaded = true; });
    assert.equal(r.loaded, false); assert.equal(loaded, false); assert.equal(r.reserved, null);
  }
  await assert.rejects(Q.prepareOfflineWork(store, null, async () => {}), { code: 'OfflinePolicyUnreviewed' });
  const srv = server(); claim(srv, 'r1', plus(T0, -H));
  const grant = grantFor(srv, 'r1', plus(T0, -30 * MIN));
  const e = entry(srv, 'r1', { signedAt: T0, grant });
  const queue = Q.createOfflineQueue({ store, owner: ownerOf('r1') });
  await queue.enqueue(e);
  for (const cause of ['cache-evicted', 'logout', 'grant-expired', 'draft-purpose-ended']) assert.deepEqual(await queue.evict(cause), [e.eventId]);
  assert.equal(await queue.acknowledgeRetention(e.eventId, { eventId: e.eventId }, { verify: () => true }), false);
  await sent(queue, transport(srv), sessionOf('r1'));
  assert.equal(await queue.acknowledgeRetention(e.eventId, { eventId: e.eventId }, { verify: () => false }), false);
  assert(store.rows.has(e.eventId));
  assert.equal(store.calls.filter(c => c.startsWith('remove:')).length, 0);
  assert.equal(await queue.acknowledgeRetention(e.eventId, { eventId: e.eventId }, { verify: (receipt, x) => receipt.eventId === x.eventId }), true);
  assert.equal(store.rows.has(e.eventId), false);
});

test('C-Q08 at every commit, receipt and answer cut the queue keeps a state it can recover from and the server applies the event exactly once', async () => {
  const srv = server(); claim(srv, 'r1', plus(T0, -H));
  const grant = grantFor(srv, 'r1', plus(T0, -30 * MIN));
  // Cut 1: the device crashed after its write but before answering: the store is the truth after restart.
  const e = entry(srv, 'r1', { signedAt: T0, grant });
  const store = memoryStore({ putFault: 'after-write' });
  assert.equal((await Q.createOfflineQueue({ store, owner: ownerOf('r1') }).enqueue(e)).status, 'not-saved');
  const restarted = Q.createOfflineQueue({ store, owner: ownerOf('r1') });
  assert.deepEqual(states(await restarted.recover()), { [e.eventId]: 'pending' });
  // Cut 2: the server could not commit: nothing applied, the entry stays to be sent again.
  assert.equal(states(await sent(restarted, transport(srv, { commitFault: 'LedgerUnavailable' }), sessionOf('r1')))[e.eventId], 'pending');
  assert.deepEqual(srv.commits, []);
  // Cut 3: committed on the server, answer lost, device restarted before recording anything.
  assert.equal(states(await sent(restarted, transport(srv, { lose: 1 }), sessionOf('r1')))[e.eventId], 'sent-unknown');
  store.rows.get(e.eventId).state = 'pending';
  const again = Q.createOfflineQueue({ store, owner: ownerOf('r1') });
  assert.equal(states(await sent(again, transport(srv), sessionOf('r1')))[e.eventId], 'committed');
  assert.deepEqual(srv.commits, [e.eventId]);
  assert.equal(srv.facts.firstApprovedAt, T0);
  // Cut 4: a write that never became durable is never sent.
  const lost = entry(srv, 'r1', { signedAt: plus(T0, MIN), grant, sequence: 2 });
  const s2 = memoryStore({ putFault: 'before-write' });
  assert.equal((await Q.createOfflineQueue({ store: s2, owner: ownerOf('r1') }).enqueue(lost)).status, 'not-saved');
  assert.deepEqual(await sent(Q.createOfflineQueue({ store: s2, owner: ownerOf('r1') }), transport(srv), sessionOf('r1')), []);
  assert.equal(srv.submitted.includes(lost.eventId), false);
});
