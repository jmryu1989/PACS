/* B2 PG replacement contracts: REQ-B2R-01..07 -> RISK-B2R-01..07.
 * Pure event/retention/context decisions use their public boundaries. PostgreSQL
 * atomicity, authority and durable publication run against the production image
 * in pg_ledger_restore_test.py. Superseded chain/seal/reference-engine cases are
 * disposed explicitly in emr/units/b.json, not treated as passing PG evidence.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
function errorCode(error) {
  if (!error) return 'unknown';
  if (typeof error.code === 'string' && /^[A-Z][A-Za-z]+$/.test(error.code)) return error.code;
  const ledger = /\bCode: `(EB\d{3}|\d{2}[0-9A-Z]{3})`/.exec(String(error.message ?? ''));
  if (ledger) return ledger[1];
  if (error.meta?.code) return String(error.meta.code);
  if (typeof error.code === 'string') return error.code;
  return error.name ?? 'Error';
}

// ── synthetic events (shared by both modes) ──
const known = value => ({ status: 'known', value });
const unresolved = reason => ({ status: 'unresolved', reason });
let counter = 0;
function member(subject = 'sub-' + (++counter), issuer = 'https://identity.example.test') {
  return { id: randomUUID(), issuer, subject };
}
function authEvent(A, overrides = {}) {
  const who = overrides.who ?? member();
  delete overrides.who;
  return { formatVersion: 2, branch: 'online-auth', surface: 'GET auth/callback', eventId: randomUUID(), userId: known(who),
    rolesAtTime: known(['radiologist']), rightsVersion: known(3), actingInstitution: known('hospital-a'), managingInstitution: known('hospital-a'),
    occurredAt: '2026-10-09T00:00:00.000Z', trustedProxyIp: known({ address: '192.0.2.10', source: 'trusted-proxy' }), cause: 'user-view',
    context: { basis: overrides.cause === 'service-job' ? 'service-job' : 'authentication', studyId: null, relatedStudyId: null, reason: null },
    executor: 'member', affectedIdentity: known(who), session: known('authref:' + randomUUID()), targets: [], action: 'auth.login',
    result: 'succeeded', auth: { endCause: null, failureCause: null, trigger: null }, requestId: 'request-' + randomUUID(),
    auditLinkId: A.newAuditLinkId(), relatedEventId: null, ...overrides };
}
function provideEvent(A, overrides = {}) {
  return { formatVersion: 1, surface: 'GET studies/:uid/report/versions', eventId: 'provide-' + randomUUID(), userId: known(member()),
    rolesAtTime: known(['radiologist']), actingInstitution: known('hospital-a'), managingInstitution: known('hospital-a'),
    occurredAt: '2026-10-09T00:00:00.000Z', trustedProxyIp: known({ address: '192.0.2.1', source: 'trusted-proxy' }), cause: 'user-view',
    context: { basis: 'assigned-reading', studyId: 'study-1', relatedStudyId: null, reason: null }, executor: 'member', targets: [{ kind: 'report-version', patientLinkSnapshot: known({ linkId: 'link-1', patientId: 'SYN-1', assigningAuthority: 'hospital-a' }),
      studyId: known('study-1'), recordId: known('report-1'), versionId: known('version-1') }],
    action: 'provide-prepared', result: 'prepared', requestId: 'request-1', auditLinkId: A.newAuditLinkId(), relatedEventId: null, ...overrides };
}

function contractSuite() {
  const assert = require('node:assert/strict');
  const { test } = require('node:test');
  const { spawnSync } = require('node:child_process');
  const root = path.resolve(__dirname, '..', '..', '..');
  const api = path.join(root, 'api');
  const ts = require(path.join(api, 'node_modules/typescript'));
  const config = ts.readConfigFile(path.join(api, 'tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, api);
  // Kept for the whole run: A's composition resolves './access-event' lazily, when the first access record is made.
  require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'),
    { compilerOptions: parsed.options, fileName: filename }).outputText, filename);
  const load = name => require(path.join(api, 'src', name));
  const M = load('emr-contract/composition.ts'), Cl = load('emr-contract/classification.ts'), R = load('emr-contract/routes.ts');
  const D = load('emr-contract/lawful-defaults.ts'), A = load('emr-contract/access-event.ts'), V = load('emr-contract/validation.ts');
  const C = load('emr-runtime/contract.ts'), CTX = load('emr-runtime/context.ts'), RT = load('emr-runtime/store.ts');
  const MF = load('emr-runtime/manifest.ts');
  const declaration = JSON.parse(fs.readFileSync(path.join(root, 'emr/units/b.json'), 'utf8'));
  const python = process.env.KIN_EMR_PYTHON || 'python3';

  // Composition happens once per process. Legal, clinical and stored-access facts are the B runtime readers themselves;
  // terminal-queue rows (C's future storage) and purpose ends (C's) are synthetic facts held by this test.
  const terminalRows = new Map(), purposeEnds = new Map(), signedResults = new Map(), intentFacts = new Map();
  const claimDuties = new Map();
  M.composeEmrAdapters({
    stored: { load: (recordId, eventId) => terminalRows.has(recordId + ':' + eventId) ? structuredClone(terminalRows.get(recordId + ':' + eventId))
      : CTX.runtimeAdapters.stored.load(recordId, eventId) },
    legal: { ...CTX.runtimeAdapters.legal, loadStatutoryDuty: id => claimDuties.get(id) },
    purpose: { load: id => purposeEnds.get(id), loadSignedResult: (id, vid) => signedResults.get(id + ':' + vid), loadIntentEndingFact: id => intentFacts.get(id) },
    clinical: CTX.runtimeAdapters.clinical,
  });
  const empty = () => ({ holds: new Map(), accessRequests: new Map(), correctionRequests: new Map(), clauseVersions: new Map(), accessEvents: new Map() });
  /** Run an A decision in a snapshot holding exactly these rows (the B readers' only input). */
  function inSnapshot(rows, work) {
    const scope = CTX.transactionScope();
    return CTX.withSnapshot(scope, CTX.snapshotFromRows(scope, { ...empty(), ...rows }), work);
  }
  const noHolds = (...ids) => ({ holds: new Map(ids.map(id => [id, []])) });

  /** A change of an EMR record (D-1: recorded in both streams). */
  const changeEvent = (overrides = {}) => provideEvent(A, { eventId: 'change-' + randomUUID(), surface: 'POST studies/:uid/report/commit', action: 'approve-sign', result: 'succeeded', ...overrides });
  const code = (work, expected) => assert.throws(work, error => error?.code === expected || String(error?.message).includes(expected), expected);
  const rejects = (promise, expected) => assert.rejects(promise, error => error?.code === expected || String(error?.message).includes(expected), expected);

  test('C01 v2 authentication facts: v1 keeps its rules with D-18 context; online-auth admits verified success and verified refusal, refuses a clinical write, a mismatched result, an extra key and an audit-namespace credential', () => {
    // v1 retains its server-bound facts and exact retry payload.
    const v1 = A.parseAccessEvent(provideEvent(A));
    assert.deepEqual(Object.keys(v1), ['formatVersion', 'surface', 'eventId', 'userId', 'rolesAtTime', 'actingInstitution', 'managingInstitution', 'occurredAt',
      'trustedProxyIp', 'cause', 'context', 'executor', 'targets', 'action', 'result', 'requestId', 'auditLinkId', 'relatedEventId']);
    assert.deepEqual(C.canonicalPayload(v1).event, v1);
    assert.equal(C.canonicalPayload(structuredClone(v1)).contentSha256,C.canonicalPayload(v1).contentSha256);
    assert.throws(() => A.parseAccessEvent(v1, []), 'a new served manifest must still bind every target of a previously parsed event');
    // v2 verified success and refusals.
    const login = A.parseAccessEvent(authEvent(A));
    assert.equal(login.formatVersion, 2); assert.equal(login.branch, 'online-auth'); assert.deepEqual(login.targets, []);
    assert.equal(A.AUTH_STATUTORY_ACT[login.action], 'none');
    assert(Object.values(A.AUTH_STATUTORY_ACT).every(act => act === 'none'));
    const who = member();
    const verifiedRefusal = A.parseAccessEvent(authEvent(A, { who, result: 'refused', auth: { endCause: null, failureCause: 'idp-session-ended', trigger: null },
      session: unresolved('not-resolved'), rolesAtTime: unresolved('not-resolved'), rightsVersion: unresolved('not-resolved'), trustedProxyIp: unresolved('not-observed') }));
    assert.equal(verifiedRefusal.userId.status, 'known');
    const before = A.parseAccessEvent(authEvent(A, { executor: 'unauthenticated', result: 'refused', userId: unresolved('not-authenticated'),
      affectedIdentity: unresolved('not-authenticated'), rolesAtTime: unresolved('not-authenticated'), rightsVersion: unresolved('not-authenticated'),
      actingInstitution: unresolved('not-authenticated'), managingInstitution: unresolved('not-resolved'), session: unresolved('not-resolved'),
      auth: { endCause: null, failureCause: 'state-mismatch', trigger: null } }));
    assert.equal(before.userId.status, 'unresolved');
    assert.equal(A.parseAccessEvent(authEvent(A, { result: 'failed', auth: { endCause: null, failureCause: 'storage-failure', trigger: null }, session: unresolved('not-resolved') })).result, 'failed');
    // A confirmed empty role set and an unapproved member are authentication facts, not clinical success.
    assert.deepEqual(A.parseAccessEvent(authEvent(A, { rolesAtTime: known([]) })).rolesAtTime.value, []);
    assert.equal(A.parseAccessEvent(authEvent(A, { actingInstitution: { status: 'not-applicable', reason: 'not-approved' } })).actingInstitution.reason, 'not-approved');
    // Each end is its own cause; a reauthentication carries its trigger.
    const sid = 'authref:' + randomUUID();
    assert(A.parseAccessEvent(authEvent(A, { who, action: 'auth.logout', surface: 'POST auth/logout', session: known(sid), auth: { endCause: 'logout', failureCause: null, trigger: null } })));
    assert(A.parseAccessEvent(authEvent(A, { who, action: 'auth.logout', surface: 'GET auth/login', auth: { endCause: 'reauthentication', failureCause: null, trigger: 'storage-untrusted' } })));
    assert(A.parseAccessEvent(authEvent(A, { action: 'auth.entry', surface: 'POST auth/entry', relatedEventId: login.eventId })));
    const service = member('kin-api-session-sweep', 'kin:service');
    const sweep = A.parseAccessEvent(authEvent(A, { userId: known(service), affectedIdentity: known(who), executor: 'service', cause: 'service-job',
      surface: 'service:auth-session-sweep', action: 'auth.session.expired', trustedProxyIp: C.IN_PROCESS_SERVICE,
      rightsVersion: { status: 'not-applicable', reason: 'in-process-service' }, rolesAtTime: known(['session-sweep']), auth: { endCause: 'sweep', failureCause: null, trigger: null } }));
    assert.notEqual(sweep.userId.value.id, sweep.affectedIdentity.value.id);
    const admin = member();
    assert(A.parseAccessEvent(authEvent(A, { userId: known(admin), affectedIdentity: known(who), action: 'auth.logout', surface: 'PATCH admin/users/:id',
      auth: { endCause: 'isolation', failureCause: null, trigger: null } })));
    // Refused: a clinical write dressed as authentication, a mismatched result, an extra key, clinical targets, a wrong end.
    for (const bad of [
      { action: 'write' }, { action: 'approve-sign' },
      { result: 'refused' }, { result: 'succeeded', auth: { endCause: null, failureCause: 'token-invalid', trigger: null } },
      { targets: [provideEvent(A).targets[0]] },
      { surface: 'POST studies/:uid/report/commit' },
      { action: 'auth.logout', surface: 'POST auth/logout', auth: { endCause: 'sweep', failureCause: null, trigger: null } },
      { action: 'auth.logout', surface: 'POST auth/logout', affectedIdentity: known(member()), auth: { endCause: 'logout', failureCause: null, trigger: null } },
      { action: 'auth.logout', surface: 'POST auth/logout', auth: { endCause: 'logout', failureCause: null, trigger: 'switch-account' } },
      { executor: 'service', cause: 'service-job' },
      { trustedProxyIp: C.IN_PROCESS_SERVICE },
      { eventId: 'not-a-uuid' }, { formatVersion: 3 },
    ]) assert.throws(() => A.parseAccessEvent(authEvent(A, bad)), JSON.stringify(bad));
    for (const extra of [{ cookie: 'secret' }, { verified: true }, { sessionId: 'secret' }])
      assert.throws(() => A.parseAccessEvent({ ...authEvent(A), ...extra }), Object.keys(extra)[0]);
    // An audit link ID or a session reference is never a credential, and never a request correlation.
    const link = A.newAuditLinkId();
    for (const value of [link, 'AUDIT:' + randomUUID(), sid, ' authref:x']) code(() => C.refuseAuditNamespaceCredential(value), 'AuditIdentifierIsNotACredential');
    C.refuseAuditNamespaceCredential('kin_sid_' + randomUUID());
    for (const bad of [{ requestId: link }, { session: known(link) }, { session: known('kin-session-cookie-value') }])
      assert.throws(() => A.parseAccessEvent(authEvent(A, bad)), JSON.stringify(bad));
    // An authentication event is about no EMR record: no bound target, and the one retention rule ends it at the floor.
    const event = authEvent(A);
    assert.deepEqual(C.recordTargets(event), []);
    assert.deepEqual(A.accessStreams(event), ['viewing']);
    assert.equal(C.accessDeadline('viewing', { occurredAt: event.occurredAt, targets: C.recordTargets(event) }), C.accessRetentionFloor(event.occurredAt));
    const unfinished=authEvent(A,{action:'auth.logout',surface:'POST auth/login',auth:{endCause:'logout',failureCause:null,trigger:null}});
    assert.equal(A.parseAccessEvent(unfinished).surface,'POST auth/login');
    const unknown={status:'unresolved',reason:'not-resolved'};
    assert.equal(A.parseAccessEvent({...unfinished,userId:unknown,affectedIdentity:unknown}).affectedIdentity.status,'unresolved');
    assert.throws(()=>A.parseAccessEvent({...unfinished,userId:unknown,affectedIdentity:unknown,session:unknown}));
    assert.throws(()=>A.parseAccessEvent(authEvent(A,{userId:unknown,affectedIdentity:unknown})), 'Unknown original identity cannot create a login');
  });

  test('C02 one immutable identity per verified issuer and subject; namesakes stay apart; a name never joins and unverified input is never known', async () => {
    const ids = new Map();
    const resolve = async (issuer, subject) => { const key = issuer + '\0' + subject; if (!ids.has(key)) ids.set(key, randomUUID()); return ids.get(key); };
    const kimA = C.verifiedIdentityClaims('https://identity.example.test', 'sub-kim-a', 'Kim Minsu');
    const kimB = C.verifiedIdentityClaims('https://identity.example.test', 'sub-kim-b', 'Kim Minsu');
    const kimAagain = C.verifiedIdentityClaims('https://identity.example.test', 'sub-kim-a', 'Kim M.');
    const otherIssuer = C.verifiedIdentityClaims('https://other-issuer.example.test', 'sub-kim-a', 'Kim Minsu');
    const [a, b, a2, other] = await Promise.all([kimA, kimB, kimAagain, otherIssuer].map(claims => C.knownIdentity(claims, resolve)));
    assert.notEqual(a.value.id, b.value.id, 'namesakes are two members');
    assert.equal(a.value.id, a2.value.id, 'the same verified subject keeps its ID across a changed display name');
    assert.notEqual(a.value.id, other.value.id, 'another issuer is another member');
    assert.deepEqual(Object.keys(a.value), ['id', 'issuer', 'subject']);
    assert(!JSON.stringify(a).includes('Kim'), 'a display name is never part of the identity fact');
    await rejects(C.knownIdentity({ issuer: 'https://identity.example.test', subject: 'sub-kim-a', displayName: 'Kim Minsu' }, resolve), 'VerifiedIdentityRequired');
    await rejects(C.knownIdentity(kimA, async () => 'Kim Minsu'), 'IdentityBindingRefused');
    // An event cannot present an unverified actor as known, or a known actor as unauthenticated.
    assert.throws(() => A.parseAccessEvent(authEvent(A, { executor: 'unauthenticated', result: 'refused', auth: { endCause: null, failureCause: 'no-code', trigger: null }, session: unresolved('not-resolved') })));
    assert.throws(() => A.parseAccessEvent(authEvent(A, { userId: unresolved('not-authenticated') })));
  });

  test('C03 observed ingress facts remain known or explicitly unresolved; only in-process work uses no-address applicability', () => {
    const proxies = new Set(['172.18.0.5']);
    assert.deepEqual(C.ingressAddress('172.18.0.5', { 'x-real-ip': '192.0.2.10' }, proxies), known({ address: '192.0.2.10', source: 'trusted-proxy' }));
    assert.equal(C.ingressAddress('::ffff:172.18.0.5', { 'x-real-ip': '2001:db8::7' }, proxies).value.address, '2001:db8::7');
    for (const [peer, headers] of [
      ['203.0.113.9', { 'x-real-ip': '192.0.2.10' }],            // an unconfigured peer has no trusted ingress observation
      ['203.0.113.9', { 'x-forwarded-for': '192.0.2.10' }],
      ['172.18.0.5', { 'x-forwarded-for': '192.0.2.10' }],       // only nginx's overwritten X-Real-IP counts
      ['172.18.0.5', { 'x-real-ip': '192.0.2.10, 198.51.100.1' }],
      ['172.18.0.5', { 'x-real-ip': ['192.0.2.10'] }], ['172.18.0.5', { 'x-real-ip': 'not-an-address' }], ['172.18.0.5', {}],
      [null, { 'x-real-ip': '192.0.2.10' }], ['', { 'x-real-ip': '192.0.2.10' }],
    ]) assert.deepEqual(C.ingressAddress(peer, headers, proxies), unresolved('not-observed'), JSON.stringify([peer, headers]));
    // Preserve a missing observation instead of inventing an address or interrupting a doctor.
    assert.deepEqual(A.parseAccessEvent(authEvent(A, { trustedProxyIp: C.ingressAddress('203.0.113.9', { 'x-real-ip': '192.0.2.10' }, proxies) })).trustedProxyIp, unresolved('not-observed'));
    assert.throws(() => A.parseAccessEvent(authEvent(A, { trustedProxyIp: C.IN_PROCESS_SERVICE })));
    assert.throws(() => A.parseAccessEvent(authEvent(A, { trustedProxyIp: known({ address: '192.0.2.10, 198.51.100.1', source: 'trusted-proxy' }) })));
    assert(A.parseAccessEvent(authEvent(A, { result: 'refused', auth: { endCause: null, failureCause: 'provider-error', trigger: null }, session: unresolved('not-resolved'), trustedProxyIp: unresolved('not-observed') })));
  });

  test('C04 a verified offline original with its own reception; a self-declared flag, a reconnect address and another content under one ID are refused', async () => {
    const reception = authEvent(A);
    const facts = { envelopeId: 'envelope-1', deviceId: 'device-1', kid: 'device-kid-1', preAuthorizationId: 'preauth-1', signedAt: '2026-10-08T22:00:00.000Z',
      timeBasis: { anchorEventId: 'anchor-1', uncertaintyMs: 2000 }, deviceSequence: 7, targetManifestSha256: 'ab'.repeat(32) };
    const original = (overrides = {}) => ({ formatVersion: 2, branch: 'verified-offline', surface: 'POST studies/:uid/report/commit', eventId: randomUUID(),
      userId: known(member()), rolesAtTime: known(['radiologist']), actingInstitution: known('hospital-a'), managingInstitution: known('hospital-a'),
      occurredAt: facts.signedAt, trustedProxyIp: unresolved('offline'), cause: 'user-view', executor: 'member',
      context: { basis: 'assigned-reading', studyId: 'study-1', relatedStudyId: null, reason: null },
      targets: [{ kind: 'report-version', patientLinkSnapshot: known({ linkId: 'link-1', patientId: 'SYN-1', assigningAuthority: 'hospital-a' }),
        studyId: known('study-1'), recordId: known('report-1'), versionId: known('version-2') }],
      action: 'approve-sign', result: 'succeeded', offline: structuredClone(facts), requestId: 'request-offline', auditLinkId: A.newAuditLinkId(),
      relatedEventId: reception.eventId, ...overrides });
    // No verifier is composed by the product until C exists: unsupported, whatever the body says.
    code(() => A.parseAccessEvent(original()), 'OfflineVerificationUnsupported');
    code(() => A.parseAccessEvent(original({ offline: { ...facts, verified: true } })), 'OfflineVerificationUnsupported');
    // The product source composes no verifier (B2 places the one call in main.ts).
    const program = ts.createProgram(parsed.fileNames, parsed.options), checker = program.getTypeChecker();
    const resolveSymbol = symbol => symbol?.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    const contractFile = program.getSourceFiles().find(f => f.fileName.replaceAll('\\', '/').endsWith('/emr-contract/access-event.ts'));
    const composeVerifier = checker.getExportsOfModule(checker.getSymbolAtLocation(contractFile)).find(s => s.name === 'composeOfflineReceiptVerifier');
    assert(composeVerifier);
    const calls = [];
    for (const source of program.getSourceFiles().filter(f => parsed.fileNames.includes(f.fileName))) {
      const visit = node => { if (ts.isCallExpression(node) && resolveSymbol(checker.getSymbolAtLocation(node.expression)) === composeVerifier) calls.push(source.fileName); ts.forEachChild(node, visit); };
      visit(source);
    }
    assert.deepEqual(calls, []);
    // A synthetic verifier capability, composed once here, stands for C's stored verification result.
    const verified = new Map([[facts.envelopeId, structuredClone(facts)]]);
    A.composeOfflineReceiptVerifier({ verify: id => { if (!verified.has(id)) throw new Error('unknown envelope'); return structuredClone(verified.get(id)); } });
    code(() => A.composeOfflineReceiptVerifier({ verify: () => facts }), 'OfflineVerifierAlreadyComposed');
    const parsedOriginal = A.parseAccessEvent(original());
    assert.equal(parsedOriginal.occurredAt, facts.signedAt, 'the device act time, never the reception time');
    assert.equal(parsedOriginal.trustedProxyIp.reason, 'offline');
    assert.notEqual(parsedOriginal.relatedEventId, parsedOriginal.eventId);
    for (const [name, bad] of [
      ['reconnect address on the original', original({ trustedProxyIp: known({ address: '192.0.2.10', source: 'trusted-proxy' }) })],
      ['self-declared verification', original({ offline: { ...facts, verified: true } })],
      ['changed device order', original({ offline: { ...facts, deviceSequence: 8 } })],
      ['unknown envelope', original({ offline: { ...facts, envelopeId: 'forged' } })],
      ['reception time as act time', original({ occurredAt: '2026-10-09T01:00:00.000Z' })],
      ['no separate reception', original({ relatedEventId: null })],
      ['empty targets', original({ targets: [] })],
      ['server-side provision', original({ action: 'provide-prepared', result: 'prepared' })],
    ]) assert.throws(() => A.parseAccessEvent(bad), name);
  });

  test('C05 protected publication waits for its matching durable receipt and sends nothing on refusal', async () => {
    const event=provideEvent(A);let bytes=0, release;
    const waiting=new Promise(resolve=>release=resolve);
    const result=C.provideAfterReceipt({append:()=>waiting},event,async()=>{bytes++;return 'body';});
    await Promise.resolve();assert.equal(bytes,0);
    release(C.mintDurableReceipt(event.eventId,'2026-10-23T00:00:00.000Z'));
    assert.equal(await result,'body');assert.equal(bytes,1);
    for(const append of [async()=>{throw Error('storage unavailable');},async()=>({eventId:event.eventId,durableAt:'2026-10-23T00:00:00.000Z'}),
      async()=>C.mintDurableReceipt('other-event','2026-10-23T00:00:00.000Z')]){
      await assert.rejects(C.provideAfterReceipt({append},event,async()=>{bytes++;}));assert.equal(bytes,1);
    }
  });

  test('C07 civil access floors and actual history endings remain independent of later access and unrelated holds', () => {
    for(const at of ['2024-02-29T23:59:59.999Z','2026-10-31T15:00:00.000Z']){
      assert.equal(C.accessRetentionFloor(at),D.civilPeriodEnd(at,2));
      assert.equal(C.accessDeadline('viewing',{occurredAt:at,targets:[],retentionClass:'rights3y'}),D.civilPeriodEnd(at,3));
    }
    const entry={occurredAt:'2020-01-01T00:00:00.000Z',targets:[{index:0,kind:'report-version',recordId:'record',versionId:'version'}]};
    assert.equal(C.accessDeadline('history',entry),null);
    assert.equal(C.accessDeadline('history',entry,()=>null),null);
    assert.equal(C.accessDeadline('history',entry,()=> '2021-01-01T00:00:00.000Z'),C.accessRetentionFloor(entry.occurredAt));
    assert.equal(C.accessDeadline('history',entry,()=> '2030-01-01T00:00:00.000Z'),'2030-01-01T00:00:00.000Z');
  });

  test('C08 complete hold set and clause history reloaded from the snapshot; a failed read is never empty; another transaction\'s snapshot is refused', async () => {
    const recordId = 'access-' + randomUUID(), t0 = '2026-10-05T00:00:00.000Z';
    const hold = (holdId, at, version) => ({ holdId, recordId, actorId: 'custodian', at, release: null,
      basis: { type: 'court-order', clause: { law: 'synthetic-law', article: 'article-1', version }, clauseId: 'synthetic-law:article-1', authorityKind: 'court',
        managingInstitutionId: 'hospital-a', requestId: 'order-' + holdId, authorityId: 'court-1', scope: [recordId], verified: true,
        validity: { from: at, until: null, condition: 'order-in-force' } } });
    const active = hold('hold-active', t0, '2026-v1'), lifted = hold('hold-lifted', t0, '2026-v1'), later = hold('hold-later', '2026-12-01T00:00:00.000Z', '2026-v2');
    const released = { ...lifted, release: { holdId: 'hold-lifted', actorId: 'custodian', at: '2026-11-01T00:00:00.000Z', evidenceId: 'order-ended-1', authorityVerified: true, reason: 'order-ended' } };
    const rows = [['hold-active', 'placed', active], ['hold-lifted', 'placed', lifted], ['hold-lifted', 'released', released], ['hold-later', 'placed', later]]
      .map(([holdId, phase, body]) => ({ holdId, phase, body: JSON.stringify(body) }));
    const v1 = { law: 'synthetic-law', article: 'article-1', publication: '2026-v1', publishedAt: '2026-01-01', effectiveAt: '2026-01-01' };
    const v2 = { law: 'synthetic-law', article: 'article-1', publication: '2026-v2', publishedAt: '2026-11-01', effectiveAt: '2026-11-15' };
    const snap = clauses => ({ holds: new Map([[recordId, rows]]), clauseVersions: new Map([['synthetic-law:article-1', clauses]]) });
    const loaded = inSnapshot(snap([v1, v2]), () => D.reloadLegalHolds(recordId));
    assert.deepEqual(loaded.map(h => [h.holdId, h.release === null]), [['hold-active', true], ['hold-later', true], ['hold-lifted', false]]);
    assert.deepEqual(inSnapshot(snap([v1, v2]), () => CTX.runtimeAdapters.legal.listHolds(recordId)), { recordId, holdIds: ['hold-active', 'hold-later', 'hold-lifted'], complete: true });
    assert.equal(loaded.find(h => h.holdId === 'hold-lifted').release.at, '2026-11-01T00:00:00.000Z');
    // The reviewed history keeps every version: a later version never replaces the one an older hold was registered under.
    code(() => inSnapshot(snap([v2]), () => D.reloadLegalHolds(recordId)), 'HoldClauseRequired');
    code(() => inSnapshot(snap([{ ...v1, publication: '2026-v1-edited' }, v2]), () => D.reloadLegalHolds(recordId)), 'HoldClauseRequired');
    // A read that did not happen is not an empty set.
    code(() => inSnapshot({}, () => D.reloadLegalHolds(recordId)), 'HoldSetIncomplete');
    code(() => inSnapshot({}, () => CTX.runtimeAdapters.legal.listHolds(recordId)), 'EmrContextRecordMissing');
    code(() => CTX.runtimeAdapters.legal.listHolds(recordId), 'EmrContextRequired');
    code(() => CTX.snapshotFromRows(CTX.transactionScope(), { ...empty(), holds: new Map([[recordId, [rows[2]]]]) }), 'HoldSetIncomplete');
    code(() => CTX.snapshotFromRows(CTX.transactionScope(), { ...empty(), accessRequests: new Map([['r1', [{ phase: 'resolved', body: '{}' }]]]) }), 'RequestHistoryIncomplete');
    assert.equal(inSnapshot({ accessRequests: new Map([['r2', []]]) }, () => CTX.runtimeAdapters.legal.loadAccessRequest('r2')), null);
    // Another transaction's snapshot, and a nested decision under another transaction, are refused.
    const scopeA = CTX.transactionScope(), scopeB = CTX.transactionScope();
    const snapshotA = CTX.snapshotFromRows(scopeA, { ...empty(), ...snap([v1, v2]) });
    code(() => CTX.withSnapshot(scopeB, snapshotA, () => D.reloadLegalHolds(recordId)), 'EmrContextTransactionMismatch');
    code(() => CTX.withSnapshot(scopeA, snapshotA, () => CTX.withSnapshot(scopeB, CTX.snapshotFromRows(scopeB, empty()), () => 1)), 'EmrContextTransactionMismatch');
    // What B does not store is unsupported, never an empty success.
    for (const call of [() => CTX.runtimeAdapters.purpose.load('x'), () => CTX.runtimeAdapters.clinical.loadStudy('x'), () => CTX.runtimeAdapters.clinical.loadReportPatient('x'),
      () => inSnapshot({}, () => CTX.runtimeAdapters.stored.load('report-1', 'event-1'))]) code(call, 'EmrRecordUnsupported');
  });

  test('C09 the signed original and its recovery copy keep owner and original time; a private-draft end or a new authentication never restarts or erases them', async () => {
    const signedAt = '2026-10-08T22:00:00.000Z', receivedAt = '2026-10-09T03:00:00.000Z';
    const digest = text => createHash('sha256').update(text).digest('hex');
    const facts = (recordId, model, row, event) => ({ recordId, model, row: { ownerId: 'reader-1', originalEventId: 'original-event-1', state: 'pending-transmission', ...row }, event: {
      eventId: 'event:' + recordId, recordId, versionId: 'v1', sha256: digest(recordId), contentSha256: digest(recordId), at: signedAt, act: 'entry',
      signature: { versionId: 'v1', sha256: digest(recordId), signedAt, verified: true }, predecessor: null, components: [], processing: null, ...event } });
    const resolve = f => { terminalRows.set(f.recordId + ':' + f.event.eventId, f); return Cl.resolveStoredRecord(M.emrAdapters().stored, f.recordId, f.event.eventId); };
    const signed = resolve(facts('offline-1', 'TerminalSignedOriginal', { signedAt, purposeId: null }, {}));
    assert.deepEqual(signed.kinds, ['offline-signed-original']);
    const retained = inSnapshot(noHolds('offline-1'), () => D.newRetentionRecord(signed));
    // D-19: a signed original keeps its record class's period (5 years, never 진료기록부 by being signed), from signedAt.
    const originalYears = Cl.RECORD_CLASSIFICATION['offline-signed-original'].retention.years;
    assert.equal(D.retentionDeadline(retained), D.civilPeriodEnd(signedAt, originalYears), 'from the actual signing time');
    code(() => resolve(facts('offline-2', 'TerminalSignedOriginal', { signedAt, purposeId: null }, { at: receivedAt, signature: { versionId: 'v1', sha256: digest('offline-2'), signedAt: receivedAt, verified: true } })), 'TerminalOriginalTimeRefused');
    code(() => resolve(facts('offline-3', 'TerminalSignedOriginal', { signedAt, purposeId: null }, { signature: null })), 'TerminalOriginalTimeRefused');
    // An original is never a purpose record, so no draft purpose end can destroy it.
    assert.throws(() => inSnapshot(noHolds('offline-1'), () => D.newPurposeRecord(signed, ['v1'])));
    // A new authentication or a reception is not a part of the original: it never resolves as one, the clock stays.
    code(() => resolve(facts('offline-1', 'TerminalSignedOriginal', { signedAt: receivedAt, purposeId: null }, { eventId: 'event:auth', versionId: 'v2', at: receivedAt,
      act: 'access', sha256: digest('auth'), contentSha256: digest('auth'), signature: null,
      predecessor: { recordId: 'offline-1', partId: 'v1', sha256: digest('offline-1') } })), 'TerminalOriginalTimeRefused');
    const resigned = resolve(facts('offline-1', 'TerminalSignedOriginal', { signedAt: receivedAt, purposeId: null }, { eventId: 'event:resign', versionId: 'v2', at: receivedAt,
      act: 'resign', sha256: digest('resign'), contentSha256: digest('resign'), signature: { versionId: 'v2', sha256: digest('resign'), signedAt: receivedAt, verified: true },
      predecessor: { recordId: 'offline-1', partId: 'v1', sha256: digest('offline-1') } }));
    code(() => inSnapshot(noHolds('offline-1'), () => D.recordVersionAdded(retained, resigned,
      { records: [retained], references: [], complete: true, revision: 'r', checkedAt: receivedAt })), 'NewLawfulRecordEventRequired');
    assert.equal(D.retentionDeadline(retained), D.civilPeriodEnd(signedAt, originalYears));
    // The recovery copy: owned, referenced, with a purpose that ends at verified reception or the owner's discard only.
    const copyFacts = facts('recovery-1', 'TerminalRecoveryCopy', { signedAt: null, purposeId: 'purpose-recover-1' }, { act: 'creation', signature: null });
    const copy = resolve(copyFacts);
    assert.deepEqual(copy.kinds, ['recovery-working-copy']);
    code(() => resolve(facts('recovery-2', 'TerminalRecoveryCopy', { signedAt: null, purposeId: null }, { act: 'creation', signature: null })), 'TerminalPurposeRequired');
    const record = inSnapshot(noHolds('recovery-1'), () => D.newPurposeRecord(copy, ['v1']));
    assert.equal(record.ownerId, 'reader-1');
    const end = (trigger, extra = {}) => { const e = { eventId: 'end:' + trigger, recordId: 'recovery-1', trigger, actorId: 'reader-1', at: receivedAt, result: null, superseded: null, ...extra }; purposeEnds.set(e.eventId, e); return Cl && D.resolvePurposeEnd(M.emrAdapters().purpose, e.eventId); };
    const purposeStore = { append: async () => ({ durableAt: receivedAt }), withPurposeLock: async (id, at, work) => work(record) };
    const destroy = async () => ({ completedAt: receivedAt, method: 'irreversible-permanent-deletion' });
    for (const trigger of ['intent-superseded', 'result-version-signed', 'session-ended'])
      await rejects(inSnapshot(noHolds('recovery-1'), () => D.destroyAtPurposeEnd(purposeStore, record, end(trigger), receivedAt, destroy)), 'PurposeBindingRefused');
    await rejects(inSnapshot(noHolds('recovery-1'), () => D.destroyAtPurposeEnd(purposeStore, record, end('explicit-discard', { actorId: 'reader-2' }), receivedAt, destroy)), 'PurposeOwnerRefused');
    const done = await inSnapshot(noHolds('recovery-1'), () => D.destroyAtPurposeEnd(purposeStore, record, end('original-received'), receivedAt, destroy));
    assert.equal(done.phase, 'completed');
    assert.deepEqual(Cl.TERMINAL_RECORD_BOUNDARY.states, ['pending-transmission', 'received-unverified', 'verified', 'verification-refused']);
  });

  const orderAt = '2026-01-02T00:00:00.000Z';
  const procedure = (state = 'open-order', patch = {}) => ({ state, responsibleRole: 'privacy-officer', assigneeId: 'officer',
    enteredAt: orderAt, evidenceDueAt: '2026-01-05T00:00:00.000Z', escalationDecisionDueAt: '2026-01-06T00:00:00.000Z',
    finalDecisionDueAt: '2026-01-07T00:00:00.000Z', superiorRole: 'institution-head', superiorId: 'head', escalatedAt: null,
    extensions: 0, extensionLimit: 1, extensionEvidenceId: null, decision: null, ...patch });
  const orderFacts = (patch = {}) => ({ objectKind: 'order-indication', origin: 'product-authored', authorId: 'physician', authorRole: 'physician',
    requestingClinicianId: 'physician', directionSourceRef: null, examCodes: ['CT-CHEST'], source: null, feed: null, inherited: [],
    firstReceivedAt: null, firstReceiptEventId: null, duplicateOf: null, scheduledAt: null, scheduleChangeEvidenceId: null,
    status: 'closed', statusEvent: { eventId: 'order-event', actorId: 'physician', at: orderAt, reason: 'synthetic' },
    fulfilment: null, chartIncorporation: null, procedure: null, synthetic: null, ...patch });
  const orderEvent = (id = 'native', patch = {}) => ({ eventId: 'order-event', recordId: id, versionId: 'original',
    sha256: 'ab'.repeat(32), contentSha256: 'ab'.repeat(32), at: orderAt, act: 'entry',
    signature: { versionId: 'original', sha256: 'ab'.repeat(32), signedAt: orderAt, verified: true },
    predecessor: null, components: [], processing: null, ...patch });
  const resolveOrder = (facts, event = orderEvent()) => {
    terminalRows.set(event.recordId + ':' + event.eventId, { recordId: event.recordId, model: 'emr_access.order_fact', row: facts, event });
    return Cl.resolveStoredRecord(M.emrAdapters().stored, event.recordId, event.eventId);
  };
  const fulfilment = { eventId: 'fulfilled', actorId: 'technician', at: '2028-01-02T00:00:00.000Z', studyId: 'study', partial: true, reason: 'partial examination confirmed' };

  test('C15 D24 registration needs its original direction; code-only native directions keep ten years through cancellation and later adoption', () => {
    const native = orderFacts(), event = orderEvent();
    // D-24 delta 16: hiding indication text in a direct-order UI does not turn the physician's sole direction
    // into registration. Its stored authorship/code selection is still the original; no separate source exists.
    const hiddenIndication = resolveOrder(orderFacts({ examCodes: ['CT-CHEST'], directionSourceRef: null }));
    assert.deepEqual(hiddenIndication.kinds, ['order-indication']);
    code(() => resolveOrder(orderFacts({ objectKind: 'registration', directionSourceRef: null })), 'DirectionSourceRequired');
    const record = inSnapshot(noHolds('native'), () => D.newRetentionRecord(resolveOrder(native, event)));
    assert.deepEqual(record.kinds, ['order-indication']); assert.equal(D.retentionDeadline(record), '2036-01-01T15:00:00.000Z');
    assert(Cl.RECORD_CLASSIFICATION['order-indication'].signature.rule === 'required');
    assert.equal(Cl.RECORD_CLASSIFICATION['exam-clinical-info'].retention.years, 5);
    assert.equal(Cl.RECORD_CLASSIFICATION['comparison-description'].retention.years, 5);
    for (const status of ['cancelled', 'superseded', 'fulfilment-confirmed']) {
      const next = orderFacts({ status, ...(status === 'fulfilment-confirmed' ? { fulfilment } : {}), statusEvent: { ...native.statusEvent, eventId: status, at: fulfilment.at } });
      D.validateOrderTransition(native, next);
      const updated = D.refreshOrderLifecycle(record, resolveOrder(next, event));
      assert.equal(D.retentionDeadline(updated), '2036-01-01T15:00:00.000Z');
    }
    code(() => D.validateOrderTransition(native, orderFacts({ objectKind: 'exam-clinical-info' })), 'NoShorteningOfEstablishedDuty');
    const registration = orderFacts({ objectKind: 'registration', authorRole: 'registrar', status: 'open', procedure: procedure() });
    code(() => Cl.parseOrderFacts(registration), 'DirectionSourceRequired');
    registration.directionSourceRef = { kind: 'order-indication', systemId: 'pacs', recordId: 'native', versionId: 'original' };
    assert.deepEqual(resolveOrder(registration, orderEvent('registration', { act: 'creation', signature: null })).kinds, ['order']);
    const adopted = resolveOrder(orderFacts({ objectKind: 'exam-component', fulfilment }), orderEvent('adopted', { at: fulfilment.at, act: 'creation', signature: null,
      components: [{ recordId: 'native', partId: 'original', sha256: event.sha256 }] }));
    const exam = inSnapshot(noHolds('native', 'adopted'), () => D.newRetentionRecord(adopted, { records: [record], references: [], complete: true, revision: 'r1', checkedAt: fulfilment.at }));
    assert.equal(D.retentionDeadline(exam), '2033-01-01T15:00:00.000Z');
    const graph = { records: [record, exam], references: [{ fromRecordId: 'adopted', fromPartId: 'original', toRecordId: 'native', toPartId: 'original', relation: 'incorporation' }], complete: true, revision: 'r2', checkedAt: fulfilment.at };
    assert.equal(D.retentionDeadline(record, graph), '2036-01-01T15:00:00.000Z');
    const correctionAt = '2029-01-02T00:00:00.000Z';
    const correctionEvent = orderEvent('native', { eventId: 'correction', versionId: 'corrected', at: correctionAt,
      sha256: 'cd'.repeat(32), contentSha256: 'cd'.repeat(32), act: 'correction',
      signature: { versionId: 'corrected', sha256: 'cd'.repeat(32), signedAt: correctionAt, verified: true },
      predecessor: { recordId: 'native', partId: 'original', sha256: event.sha256 } });
    const correctionFacts = orderFacts({ examCodes: ['CT-ABDOMEN'], statusEvent: { ...native.statusEvent, eventId: 'correction', at: correctionAt } });
    const originalFact = C.parseOrderFact({ recordId: 'native', eventId: event.eventId, previousEventId: null, facts: native, event });
    const correctionFact = { recordId: 'native', eventId: 'correction', previousEventId: event.eventId, facts: correctionFacts, event: correctionEvent };
    assert(C.parseOrderFact(correctionFact, originalFact));
    code(() => C.parseOrderFact({ ...correctionFact, event: { ...correctionEvent, predecessor: null } }, originalFact), 'OrderHistoryIncomplete');
    code(() => C.parseOrderFact({ ...correctionFact, event }, originalFact), 'OrderClinicalVersionImmutable');
    const corrected = inSnapshot(noHolds('native'), () => D.recordVersionAdded(record, resolveOrder(correctionFacts, correctionEvent),
      { records: [record], references: [], complete: true, revision: 'corrected', checkedAt: correctionAt }));
    assert.deepEqual(corrected.parts.map(p => p.partId), ['original', 'corrected']);
    assert.equal(D.retentionDeadline(corrected), '2039-01-01T15:00:00.000Z');
    assert.equal(corrected.parts[0].startedAt, orderAt, 'correction preserves the original ten-year unit and its prior version');
    const unsigned = inSnapshot(noHolds('native'), () => D.newRetentionRecord(resolveOrder(native, { ...event, act: 'creation', signature: null })));
    assert.equal(D.retentionDeadline(unsigned), D.retentionDeadline(record), 'missing signature remains a defect with the original clock');
    const synthetic = { runId: 'seed-run', seedId: 'SEED_ORDERS-1', originalSha256: 'ab'.repeat(32), observedSha256: 'ab'.repeat(32), checkedAt: orderAt, verificationRunId: 'verified-run', linkedStudyIds: [] };
    assert(Cl.parseOrderFacts({ ...registration, synthetic }));
    for (const bad of [{ ...synthetic, observedSha256: 'cd'.repeat(32) }, { ...synthetic, linkedStudyIds: ['real-study'] }, { ...synthetic, verificationRunId: '' }])
      assert.throws(() => Cl.parseOrderFacts({ ...registration, synthetic: bad }));
    const migrated = { ...registration, origin: 'migrated', directionSourceRef: null, synthetic: null, procedure: procedure('classification-unconfirmed') };
    assert(Cl.parseOrderFacts(migrated)); code(() => resolveOrder(migrated), 'OrderClassificationUnconfirmed');
    // Identifier overlap alone is no synthetic provenance: the same seed-shaped ID can name a real original,
    // a verified test registration, or an unresolved imported row; each follows its own stored facts.
    const overlappingId = synthetic.seedId;
    const overlappingOriginal = resolveOrder(native, orderEvent(overlappingId));
    assert.deepEqual(overlappingOriginal.kinds, ['order-indication']);
    assert.equal(overlappingOriginal.row.synthetic, null);
    assert.equal(D.retentionDeadline(inSnapshot(noHolds(overlappingId), () => D.newRetentionRecord(overlappingOriginal))), '2036-01-01T15:00:00.000Z');
    assert.equal(resolveOrder({ ...registration, synthetic }, orderEvent(overlappingId, { act: 'creation', signature: null })).row.synthetic.runId, 'seed-run');
    code(() => resolveOrder(migrated, orderEvent(overlappingId, { act: 'creation', signature: null })), 'OrderClassificationUnconfirmed');
  });

  test('C16 D24 received evidence keeps independent original, adopted, chart and receipt clocks without a duplicate restart', () => {
    const event = orderEvent('received', { act: 'receipt', signature: null });
    const facts = orderFacts({ objectKind: 'received-order', origin: 'received-ris',
      source: { systemId: 'ris', recordId: 'external', versionId: 'source-v1', at: '2020-01-02T00:00:00.000Z', signatureEvidenceId: 'original-signature' },
      feed: { feedId: 'ris', installationEvidenceId: 'installation-verified', roles: ['worklist-copy', 'entrusted-original', 'exam-component'] },
      inherited: [{ kind: 'order-indication', recordId: 'external', versionId: 'source-v1', startedAt: '2020-01-02T00:00:00.000Z', evidenceId: 'supply-verified' }],
      firstReceivedAt: orderAt, firstReceiptEventId: event.eventId, fulfilment });
    const source = resolveOrder(facts, event), duties = D.orderRetentionDuties(source);
    assert.deepEqual(duties, [{ kind: 'order-indication', startedAt: '2020-01-02T00:00:00.000Z', years: 10 },
      { kind: 'order-exam-component', startedAt: orderAt, years: 5 }, { kind: 'patient-match', startedAt: fulfilment.at, years: 5 }]);
    assert.equal(D.periodStartRow(source), 'inherited');
    assert.deepEqual(D.orderRetentionDuties(resolveOrder({ ...facts, duplicateOf: event.eventId }, event)), duties);
    code(() => D.validateOrderTransition(facts, { ...facts, firstReceivedAt: fulfilment.at }), 'NoShorteningOfEstablishedDuty');
    code(() => D.validateOrderTransition(facts, { ...facts, feed: { ...facts.feed, roles: ['worklist-copy', 'exam-component'] }, inherited: [] }), 'NoShorteningOfEstablishedDuty');
    const streams = A.orderReceptionEvidence(source);
    assert.equal(streams.original.sourceAt, facts.source.at); assert.equal(streams.receipt.years, 2); assert.equal(streams.receipt.basis, 'product-policy');
    assert.deepEqual(Cl.RECORD_CLASSIFICATION['delivery-receipt'].retention.statutoryMinimum, []);
    const fact = { recordId: 'received', eventId: 'order-event', previousEventId: null, facts, event };
    const duplicate = { ...structuredClone(fact), eventId: 'resend', previousEventId: 'order-event' };
    duplicate.facts.duplicateOf = event.eventId; duplicate.facts.statusEvent = { ...facts.statusEvent, eventId: 'resend', at: fulfilment.at };
    assert(C.parseOrderFact(duplicate, C.parseOrderFact(fact)));
    code(() => C.parseOrderFact({ ...duplicate, event: { ...event, at: fulfilment.at } }, fact), 'OrderClinicalVersionImmutable');
    const fixed = inSnapshot({ ...noHolds('received'), orderFacts: new Map([['received', [fact, duplicate]]]) }, () => Cl.resolveStoredRecord(M.emrAdapters().stored, 'received', event.eventId));
    assert.equal(fixed.row.duplicateOf, event.eventId); assert.equal(fixed.event.at, orderAt);
  });

  test('C17 D24 finite review deadlines escalate without erasing duties or renewing on retries; four evidence-bound decisions close the procedure', () => {
    for (const state of ['classification-unconfirmed', 'entrusted-evidence-unconfirmed', 'linked-fulfilment-unconfirmed', 'open-order', 'unlinked-exam', 'copy-window-review', 'interface-outage', 'claim-duty-end-unconfirmed']) {
      const facts = orderFacts({ procedure: procedure(state) });
      assert.equal(D.orderProcedureState(facts, '2026-01-03T00:00:00.000Z'), 'pending');
      assert.equal(D.orderProcedureState(facts, '2026-01-05T00:00:00.000Z'), 'escalate');
      assert.equal(D.orderProcedureState(facts, '2040-01-01T00:00:00.000Z'), 'superior-decision-overdue');
      code(() => D.validateOrderTransition(facts, { ...facts, procedure: procedure(state, { evidenceDueAt: '2026-01-05T01:00:00.000Z' }) }), 'OrderProcedureDeadlineRequired');
      assert.throws(() => Cl.parseOrderFacts({ ...facts, procedure: { ...facts.procedure, finalDecisionDueAt: null } }));
    }
    const pending = orderFacts({ procedure: procedure('open-order') }), at = '2026-01-08T00:00:00.000Z';
    const record = inSnapshot(noHolds('native'), () => D.newRetentionRecord(resolveOrder(pending)));
    assert.equal(D.retentionState(record, undefined, '2040-01-01T00:00:00.000Z').destroyNotBefore, null);
    for (const route of ['classification-confirmed', 'duty-continues', 'lawful-return', 'unnecessary-operations']) {
      const decision = { route, actorId: 'head', at, evidenceId: 'decision-' + route, basisId: route === 'duty-continues' ? 'actual-legal-basis' : null,
        scope: ['native'], reviewAt: route === 'duty-continues' ? '2027-01-01T00:00:00.000Z' : null, originalPreservedEvidenceId: route === 'lawful-return' ? 'hospital-original-verified' : null };
      const next = { ...pending, procedure: { ...pending.procedure, decision } };
      if (route === 'duty-continues') {
        // No automatic destruction on an unanswered deadline, and no baseless or unreviewed indefinite retention.
        for (const missing of ['basisId', 'reviewAt', 'evidenceId'])
          assert.throws(() => Cl.parseOrderFacts({ ...next, procedure: { ...next.procedure, decision: { ...decision, [missing]: null } } }), missing);
        assert.equal(D.orderProcedureState(next, decision.reviewAt), 'escalate');
        assert.equal(D.orderProcedureState(next, '2040-01-01T00:00:00.000Z'), 'escalate', 'overdue review is never silent indefinite authorization');
      }
      D.validateOrderTransition(pending, next);
      assert.equal(D.orderProcedureState(next, at), route === 'duty-continues' ? 'duty-continues' : 'clear');
      code(() => Cl.parseOrderFacts({ ...next, procedure: { ...next.procedure, decision: { ...decision, actorId: 'officer' } } }), 'OrderDecisionAuthorityRequired');
      const updated = D.refreshOrderLifecycle(record, resolveOrder(next));
      assert.equal(D.retentionDeadline(updated), '2036-01-01T15:00:00.000Z', 'return or an operational decision never shortens an established native duty');
    }
    const extended = { ...pending, procedure: procedure('open-order', { evidenceDueAt: '2026-02-05T00:00:00.000Z', escalationDecisionDueAt: '2026-02-06T00:00:00.000Z', finalDecisionDueAt: '2026-02-07T00:00:00.000Z', extensions: 1, extensionEvidenceId: 'new-reservation' }) };
    D.validateOrderTransition(pending, extended);
    assert.throws(() => D.validateOrderTransition(extended, { ...extended, procedure: { ...extended.procedure, extensions: 2 } }));
  });

  test('C18 D24 claim duties require an actual ending event and preserve an outstanding statutory obligation past internal deadlines', () => {
    const B = load('emr-contract/legal-basis.ts');
    assert.equal(B.HOLD_DUTY_CLAUSES['nhi:96-4.1'].article, '96-4.1');
    const claim = { requestId: 'claim-1', recordIds: ['native'], startedAt: orderAt, endedAt: null, endingEventId: null,
      basisId: 'entrusted-claim-evidence', procedure: procedure('claim-duty-end-unconfirmed') };
    claimDuties.set(claim.requestId, claim);
    const hold = { holdId: 'claim-hold', recordId: 'native', actorId: 'officer', at: orderAt, release: null,
      basis: { type: 'statutory-duty', clause: { law: 'nhi', article: '96-4.1', version: 'synthetic-reviewed' }, clauseId: 'nhi:96-4.1',
        requestId: claim.requestId, authorityId: 'hospital-a', authorityKind: 'medical-institution', managingInstitutionId: 'hospital-a', scope: ['native'], verified: true,
        validity: { from: orderAt, until: null, condition: 'duty-active' } } };
    const rows = { holds: new Map([['native', [{ holdId: hold.holdId, phase: 'placed', body: JSON.stringify(hold) }]]]),
      clauseVersions: new Map([['nhi:96-4.1', [{ law: 'nhi', article: '96-4.1', publication: 'synthetic-reviewed', publishedAt: '2025-01-01', effectiveAt: '2025-01-01' }]]]) };
    const state = inSnapshot(rows, () => {
      const record = D.newRetentionRecord(resolveOrder(orderFacts()));
      return D.retentionState(record, undefined, '2040-01-01T00:00:00.000Z');
    });
    assert.equal(state.state, 'legal-hold'); assert.equal(state.destroyNotBefore, null);
    claim.endedAt = '2027-01-01T00:00:00.000Z';
    assert.throws(() => inSnapshot(rows, () => D.reloadLegalHolds('native')), 'an end timestamp with no actual ending event is refused');
  });

  // D889 §3.3 A7 -> RISK-EMR-FORGED-RECEIPT -> C20 / M38.

  test('C10 declaration, selection and catalog agree exactly; a missing or doubled owner, an unclassified table, a dropped migration, a collection mismatch and a false exit are refused', () => {
    // The declaration against the contract and the runtime manifest, both ways.
    assert.deepEqual(declaration.models.sql, Cl.SQL_STORAGE_CLASSIFICATION);
    assert.deepEqual([...declaration.deployment.tables].sort(), [...MF.EMR_STORAGE.tables].sort());
    assert.deepEqual(Object.keys(Cl.SQL_STORAGE_CLASSIFICATION).map(n => n.replace('emr_access.', '')).sort(), [...MF.EMR_STORAGE.tables].sort());
    assert.deepEqual(declaration.deployment.roles, MF.EMR_STORAGE.roles);
    assert.equal(declaration.deployment.schema, MF.EMR_STORAGE.schema); assert.equal(declaration.deployment.tablespace, MF.EMR_STORAGE.tablespace);
    assert.deepEqual(declaration.routes.internal_surfaces, Object.keys(R.INTERNAL_SURFACES));
    assert.deepEqual(declaration.records.terminal_models, Cl.TERMINAL_RECORD_BOUNDARY.models);
    for (const kind of declaration.records.kinds_added) assert(Cl.RECORD_CLASSIFICATION[kind], kind);
    for (const kinds of Object.values(Cl.SQL_STORAGE_CLASSIFICATION)) for (const kind of kinds) assert(Cl.RECORD_CLASSIFICATION[kind], kind);
    const migrations = fs.readdirSync(path.join(api, 'prisma/migrations'), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
    assert.ok(migrations.includes(declaration.migrations.latest_before));
    assert.deepEqual(migrations.slice(migrations.indexOf(declaration.migrations.latest_before) + 1), declaration.migrations.added);
    // The contract cases of this very file, collected with the installed TypeScript parser, against the declaration.
    const file = ts.createSourceFile(__filename, fs.readFileSync(__filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const collected = [];
    const visit = node => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'test' && ts.isStringLiteralLike(node.arguments[0]))
        collected.push(node.arguments[0].text.split(' ')[0]);
      ts.forEachChild(node, visit);
    };
    visit(file);
    assert.deepEqual(collected, declaration.cases.contract[declaration.round].map(c => c.split(' ')[0]));
    assert.equal(collected.length, declaration.expected.contract);
    assert.equal(declaration.mutants.length, declaration.expected.mutants);
    // The checker of the declaration (scripts/emr-compose.py) on this checkout, then each refusal on its own.
    const compose = (...args) => spawnSync(python, ['-B', path.join(root, 'scripts/emr-compose.py'), ...args], { cwd: root, encoding: 'utf8', timeout: 120000 });
    const real = compose('check', '--json');
    assert.equal(real.status, 0, real.stdout + real.stderr);
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'emr-b-declaration-'));
    try {
      const variant = (name, change) => { const copy = structuredClone(declaration); change(copy); const target = path.join(temp, name + '.json'); fs.writeFileSync(target, JSON.stringify(copy)); return target; };
      for (const [name, change, expected] of [
        ['missing-owner', d => d.owned_paths['B2-replacement'].push('api/src/emr-runtime/missing.ts'), 'owned-path-missing'],
        ['doubled-owner', d => d.owned_paths['B2-replacement'].push(d.owned_paths['B2-replacement'][0]), 'owned-path-duplicated'],
        ['dropped-migration', d => { d.migrations.added.pop(); }, 'migration-order'],
        ['reordered-ledger', d => { d.migrations.added.reverse(); }, 'migration-order'],
        ['missing-baseline', d => { d.migrations.latest_before = 'missing'; }, 'migration-baseline-missing'],
        ['renamed-migration', d => { d.migrations.added = ['20261008120000_emr_b_renamed']; }, 'migration-missing'],
        ['missing-live-case', d => { d.cases.live[d.round].pop(); }, 'live-cases-differ'],
        ['extra-live-case', d => { d.cases.live[d.round].push('test_b99_undeclared'); }, 'live-cases-differ'],
        ['candidate-case', d => { d.candidate_cases[0].case = 'EmrBLedgerLive.test_b99_absent'; }, 'candidate-case-missing'],
        ['profile', d => { d.cases.live.profile_suites[0][2] = 'ci-emr-b-other'; }, 'profile-differs'],
        ['keys', d => { delete d.restore; }, 'declaration-keys'],
        ['unclassified-table', d => { d.deployment.tables.push('syn_unclassified'); }, 'table-unclassified'],
        ['unclassified-model', d => { delete d.models.sql['emr_access.clause_version']; }, 'table-unclassified'],
      ]) {
        const result = compose('check', '--json', '--declaration', variant(name, change));
        assert.equal(result.status, 1, name);
        assert(JSON.parse(result.stdout).problems.some(p => p.startsWith(expected)), name + ': ' + result.stdout);
      }
      // record-run evidence: exactly the declared cases, each passed once, with both exits zero.
      const ids = declaration.cases.contract[declaration.round].map(c => c.split(' ')[0]);
      const evidence = (name, exit, lines) => {
        const dir = path.join(temp, 'run-' + name); fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ status: 'completed', exit_code: exit, recorder_exit_code: exit }));
        fs.writeFileSync(path.join(dir, 'stdout.log'), lines.join('\n') + '\n'); fs.writeFileSync(path.join(dir, 'stderr.log'), '');
        return dir;
      };
      const tap = list => ['TAP version 13', ...list.map((id, n) => `ok ${n + 1} - ${id} synthetic case`)];
      const judge = dir => { const r = compose('check-run', '--kind', 'node', '--cases-from', 'contract', '--run-dir', dir); return JSON.parse(r.stdout); };
      assert.deepEqual(judge(evidence('good', 0, tap(ids))), { ok: true, problems: [] });
      assert(judge(evidence('false-exit', 1, tap(ids))).problems.some(p => p.startsWith('exit-not-zero')));
      assert(judge(evidence('missing', 0, tap(ids.slice(1)))).problems.some(p => p.startsWith('case-not-passed-once')));
      assert(judge(evidence('extra', 0, tap([...ids, 'C99']))).problems.some(p => p.startsWith('undeclared-cases')));
      assert(judge(evidence('failed', 0, [...tap(ids), 'not ok 11 - C03 synthetic failure'])).problems.some(p => p.startsWith('cases-not-passed')));
      assert(judge(evidence('twice', 0, tap([...ids, ids[0]]))).problems.some(p => p.startsWith('case-not-passed-once')));
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  });
}
contractSuite();
