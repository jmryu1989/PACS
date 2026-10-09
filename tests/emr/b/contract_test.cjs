/* EMR-B1 contract cases C01-C10 (REQ-EMR-01/02/06/07/19/20 -> RISK-EMR-* -> TEST-EMR-B-C01..C10).
 *
 * Pure: the A contract, the B runtime modules (api/src/emr-runtime) and the unit declaration, compiled with the installed
 * TypeScript like tests/emr_contract_test.cjs. The ledger store runs its real logic (snapshot, deadline, intent, append,
 * read-back, seal, receipt, settlement) over an in-memory reference model of the schema functions; what the database
 * itself enforces (roles, locks, placement, triggers, the SQL hash) is the live suite tests/emr/b/live.py. Assertions are
 * on returned/stored facts, error codes and order of effects - never on implementation text. Synthetic data only.
 *
 * With `--emr-b-live <operation> <json>` this file is instead the live suite's driver inside the production API image: it
 * runs one operation of the compiled /app/dist store against the database named by DATABASE_URL and prints one JSON line.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');

if (process.argv.includes('--emr-b-live')) {
  liveDriver().then(result => { process.stdout.write('EMR_B_RESULT ' + JSON.stringify(result) + '\n'); process.exit(0); },
    error => { process.stdout.write('EMR_B_RESULT ' + JSON.stringify({ error: errorCode(error), name: error?.name ?? null, problems: error?.problems ?? null }) + '\n'); process.exit(0); });
} else {
  contractSuite();
}

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
    executor: 'member', affectedIdentity: known(who), session: known('authref:' + randomUUID()), targets: [], action: 'auth.login',
    result: 'succeeded', auth: { endCause: null, failureCause: null, trigger: null }, requestId: 'request-' + randomUUID(),
    auditLinkId: A.newAuditLinkId(), relatedEventId: null, ...overrides };
}
function provideEvent(A, overrides = {}) {
  return { formatVersion: 1, surface: 'GET studies/:uid/report/versions', eventId: 'provide-' + randomUUID(), userId: known(member()),
    rolesAtTime: known(['radiologist']), actingInstitution: known('hospital-a'), managingInstitution: known('hospital-a'),
    occurredAt: '2026-10-09T00:00:00.000Z', trustedProxyIp: known({ address: '192.0.2.1', source: 'trusted-proxy' }), cause: 'user-view',
    executor: 'member', targets: [{ kind: 'report-version', patientLinkSnapshot: known({ linkId: 'link-1', patientId: 'SYN-1', assigningAuthority: 'hospital-a' }),
      studyId: known('study-1'), recordId: known('report-1'), versionId: known('version-1') }],
    action: 'provide-prepared', result: 'prepared', requestId: 'request-1', auditLinkId: A.newAuditLinkId(), relatedEventId: null, ...overrides };
}

// ════════════════════════════════════════ live driver (inside the production image) ════════════════════════════════════════

async function liveDriver() {
  const [operation, raw] = process.argv.slice(process.argv.indexOf('--emr-b-live') + 1);
  const args = raw ? JSON.parse(raw) : {};
  const dist = '/app/dist';
  const A = require(dist + '/emr-contract/access-event');
  const M = require(dist + '/emr-contract/composition');
  const D = require(dist + '/emr-contract/lawful-defaults');
  const CTX = require(dist + '/emr-runtime/context');
  const RT = require(dist + '/emr-runtime/store');
  const C = require(dist + '/emr-runtime/contract');
  const { FailureJournal } = require(dist + '/emr-runtime/failure-journal');
  const { AccessSeal } = require(dist + '/emr-runtime/seal');
  const { verifyRuntimeConnection } = require(dist + '/emr-runtime/manifest');
  const { PrismaClient } = require('/app/node_modules/@prisma/client');
  M.composeEmrAdapters(CTX.runtimeAdapters);
  const url = args.url ?? process.env.DATABASE_URL;
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  await prisma.$connect();
  try {
    if (operation === 'verify-runtime') return await verifyRuntimeConnection(prisma);
    if (operation === 'expire') return await RT.expireAccessPrefix(prisma, args.now ?? new Date().toISOString());
    if (operation === 'civil') return args.at.map(at => D.civilPeriodEnd(at, 2));
    const state = process.env.KIN_EMR_STATE_DIR;
    const sql = new RT.PrismaLedgerSql(prisma);
    const journal = new FailureJournal(state);
    const seal = new AccessSeal(state, sql, journal);
    const store = new RT.AccessLedgerStore(prisma, sql, seal, journal);
    if (operation === 'recover') return await seal.recover();
    if (operation === 'seal') return seal.read();
    if (operation === 'journal') return journal.all().map(record => ({ id: record.id, kind: record.kind, body: record.body }));
    if (operation === 'tail') return await sql.tail();
    if (operation === 'entries') {
      const entries = [];
      for (let after = 0; ;) { const page = await sql.entriesAfter(after, 1000); entries.push(...page); if (page.length < 1000) break; after = page.at(-1).sequence; }
      return entries;
    }
    if (operation === 'append') {
      // Standalone facts; `concurrent` appends at once from one process.
      const events = (args.events ?? []).length ? args.events : Array.from({ length: args.count ?? 1 }, () => authEvent(A, args.overrides ?? {}));
      const run = async event => { try { return { eventId: event.eventId, receipt: await store.append(event) }; } catch (error) { return { eventId: event.eventId, error: errorCode(error) }; } };
      const results = args.concurrent ? await Promise.all(events.map(run)) : await sequential(events, run);
      return { results, events };
    }
    if (operation === 'business') {
      // A business change (the legacy AuditLog row) and its ledger fact in one transaction; `fail` injects a failure.
      const event = args.event ?? authEvent(A);
      let appended;
      try {
        appended = await prisma.$transaction(async tx => {
          const [row] = await tx.$queryRaw`INSERT INTO "AuditLog" (actor, action, target, detail) VALUES ('SYNTHETIC-emr-b', 'auth.login', 'SYNTHETIC-sub', ${'{"synthetic":true}'}) RETURNING id`;
          if (args.fail === 'business-before-append') throw Object.assign(new Error('synthetic business refusal'), { code: 'SyntheticBusinessRefusal' });
          const made = await store.appendInTransaction(tx, event);
          await store.recordProjection(tx, event.eventId, row.id);
          if (args.fail === 'business-after-append') throw Object.assign(new Error('synthetic business refusal'), { code: 'SyntheticBusinessRefusal' });
          if (args.exit === 'before-commit') process.exit(0);
          return made;
        }, { timeout: 15000, maxWait: 10000 });
      } catch (error) {
        let settled = null;
        try { await store.settle(event, error); } catch (settleError) { settled = errorCode(settleError); }
        return { eventId: event.eventId, error: errorCode(error), settled };
      }
      if (args.exit === 'after-commit') process.exit(0);
      try { return { eventId: event.eventId, receipt: await store.confirm(appended) }; }
      catch (error) { return { eventId: event.eventId, committed: true, error: errorCode(error) }; }
    }
    if (operation === 'provide') {
      // A's first-byte rule with B's receipt: what had happened by the time the body callback ran.
      const event = args.event ?? provideEvent(A);
      const order = [];
      try {
        const body = await C.provideAfterReceipt(store, event, async receipt => {
          const stored = await sql.entryForEvent(event.eventId);
          const sealed = seal.read();
          order.push({ body: true, stored: !!stored, sealedThrough: sealed === 'absent' ? null : sealed.sequence, entry: stored?.sequence ?? null, receipt });
          return 'SYNTHETIC body';
        });
        return { eventId: event.eventId, body, order };
      } catch (error) { return { eventId: event.eventId, error: errorCode(error), order }; }
    }
    if (operation === 'holds') {
      // Register the given hold facts (placed, then released ones) and reload them through the composed readers.
      await prisma.$transaction(async tx => {
        for (const hold of args.place ?? []) await store.recordHold(tx, hold);
        for (const hold of args.release ?? []) await store.recordHoldRelease(tx, hold);
      });
      return await reload(args);
    }
    if (operation === 'reload') return await reload(args);
    if (operation === 'identity') {
      return await prisma.$transaction(async tx => Promise.all((args.pairs ?? []).map(([issuer, subject]) => store.resolveIdentity(tx, issuer, subject))));
    }
    throw Object.assign(new Error('unknown driver operation'), { code: 'UnknownOperation' });
    async function reload(request) {
      return prisma.$transaction(async tx => {
        const scope = CTX.transactionScope();
        const snapshot = await store.snapshot(tx, scope, { recordIds: request.recordIds ?? [], clauseIds: request.clauseIds ?? [] });
        return CTX.withSnapshot(scope, snapshot, () => (request.recordIds ?? []).map(id => {
          try { return { recordId: id, holds: D.reloadLegalHolds(id).map(h => ({ holdId: h.holdId, released: h.release !== null, version: h.basis.clause.version, at: h.at })) }; }
          catch (error) { return { recordId: id, error: errorCode(error) }; }
        }));
      });
    }
  } finally {
    await prisma.$disconnect();
  }
}
async function sequential(items, run) { const out = []; for (const item of items) out.push(await run(item)); return out; }

// ═══════════════════════════════════════════════ contract cases C01-C10 ═══════════════════════════════════════════════

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
  const J = load('emr-runtime/failure-journal.ts'), S = load('emr-runtime/seal.ts'), MF = load('emr-runtime/manifest.ts');
  const declaration = JSON.parse(fs.readFileSync(path.join(root, 'emr/units/b.json'), 'utf8'));
  const python = process.env.KIN_EMR_PYTHON || 'python3';

  // Composition happens once per process. Legal, clinical and stored-access facts are the B runtime readers themselves;
  // terminal-queue rows (C's future storage) and purpose ends (C's) are synthetic facts held by this test.
  const terminalRows = new Map(), purposeEnds = new Map(), signedResults = new Map(), intentFacts = new Map();
  M.composeEmrAdapters({
    stored: { load: (recordId, eventId) => terminalRows.has(recordId + ':' + eventId) ? structuredClone(terminalRows.get(recordId + ':' + eventId))
      : CTX.runtimeAdapters.stored.load(recordId, eventId) },
    legal: CTX.runtimeAdapters.legal,
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
  const ledgerError = (code, message) => Object.assign(new Error(message ?? code), { code: 'P2010', meta: { code } });

  /** An in-memory reference model of schema emr_access's functions, with per-transaction staging and rollback. */
  class MemoryLedger {
    constructor() { this.chainId = randomUUID(); this.head = { sequence: 0, hash: '0'.repeat(64) }; this.entries = []; this.holdRowsList = []; this.requests = []; this.clauses = []; this.down = false; }
    begin() { return { staged: [], head: null, holds: [], requests: [] }; }
    commit(tx) { this.entries.push(...tx.staged); if (tx.head) this.head = tx.head; this.holdRowsList.push(...tx.holds); this.requests.push(...tx.requests); }
    visible(tx) { return tx ? [...this.entries, ...tx.staged] : this.entries; }
    guard() { if (this.down) throw Object.assign(new Error("Can't reach database server"), { code: 'P1001' }); }
    append(tx, eventId, payload, expiresAt) {
      this.guard();
      const doc = JSON.parse(payload);
      if (doc.kind !== 'access' || doc.event.eventId !== eventId || expiresAt !== D.civilPeriodEnd(doc.event.occurredAt, 2)) throw ledgerError('EB003');
      const existing = this.visible(tx).find(e => e.eventId === eventId);
      const head = tx.head ?? this.head;
      if (existing) {
        if (existing.payload !== payload) throw ledgerError('EB002');
        return { chainId: this.chainId, sequence: existing.sequence, previousHash: existing.previousHash, hash: existing.hash, storedAt: existing.storedAt, replay: true };
      }
      const sequence = head.sequence + 1, hash = C.entryHash(sequence, head.hash, payload), storedAt = new Date().toISOString();
      tx.staged.push({ sequence, previousHash: head.hash, hash, kind: 'access', eventId, payload, contentSha256: createHash('sha256').update(payload).digest('hex'), storedAt, expiresAt });
      tx.head = { sequence, hash };
      return { chainId: this.chainId, sequence, previousHash: head.hash, hash, storedAt, replay: false };
    }
    checkpoint(through, at) {
      const anchor = this.entries.find(e => e.sequence === through);
      const count = this.entries.filter(e => e.sequence <= through).length;
      this.entries = this.entries.filter(e => e.sequence > through);
      const payload = C.checkpointPayload(at, through, count, anchor.hash), sequence = this.head.sequence + 1;
      const hash = C.entryHash(sequence, this.head.hash, payload);
      this.entries.push({ sequence, previousHash: this.head.hash, hash, kind: 'expiry', eventId: null, payload, contentSha256: createHash('sha256').update(payload).digest('hex'), storedAt: at, expiresAt: D.civilPeriodEnd(at, 2) });
      this.head = { sequence, hash };
    }
    stored(e) { return { sequence: e.sequence, previousHash: e.previousHash, hash: e.hash, kind: e.kind, eventId: e.eventId, payload: e.payload, contentSha256: e.contentSha256, storedAt: e.storedAt }; }
  }
  function memorySql(ledger) {
    return {
      tail: async () => { ledger.guard(); return { chainId: ledger.chainId, ...ledger.head }; },
      entriesAfter: async (after, limit) => { ledger.guard(); return ledger.entries.filter(e => e.sequence > after).sort((a, b) => a.sequence - b.sequence).slice(0, limit).map(e => ledger.stored(e)); },
      entryForEvent: async eventId => { ledger.guard(); const e = ledger.entries.find(x => x.eventId === eventId); return e ? ledger.stored(e) : null; },
      placement: async () => [],
    };
  }
  class MemoryStore extends RT.AccessLedgerStore {
    constructor(ledger, seal, journal) {
      super({ $transaction: async work => { const tx = ledger.begin(); const value = await work(tx); ledger.commit(tx); return value; } }, memorySql(ledger), seal, journal);
      this.ledger = ledger;
    }
    async appendRow(tx, eventId, payload, expiresAt) { return this.ledger.append(tx, eventId, payload, expiresAt); }
    async holdRows(tx, recordId) { this.ledger.guard(); return [...this.ledger.holdRowsList, ...(tx.holds ?? [])].filter(r => r.recordId === recordId).map(({ holdId, phase, body }) => ({ holdId, phase, body })); }
    async placeHoldRow(tx, holdId, recordId, body) { tx.holds.push({ holdId, phase: 'placed', recordId, body }); }
    async releaseHoldRow(tx, holdId, body) { const placed = [...this.ledger.holdRowsList, ...tx.holds].find(r => r.holdId === holdId && r.phase === 'placed'); tx.holds.push({ holdId, phase: 'released', recordId: placed.recordId, body }); }
    async requestRows(tx, kind, requestId) { return this.ledger.requests.filter(r => r.kind === kind && r.requestId === requestId).map(({ phase, body }) => ({ phase, body })); }
    async dutyRequestRow(tx, kind, requestId, phase, body) { tx.requests.push({ kind, requestId, phase, body }); }
    async clauseRows(tx, clauseId) { return this.ledger.clauses.filter(c => c.clauseId === clauseId).map(({ clauseId: _, ...row }) => row); }
    async entryRow(tx, eventId) { const e = this.ledger.visible(tx).find(x => x.eventId === eventId); return e ? this.ledger.stored(e) : null; }
  }
  /** A started server's ledger: its seal is created by the start-up recovery over the empty chain, as in production. */
  async function world() {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'emr-b-state-'));
    const ledger = new MemoryLedger(), journal = new J.FailureJournal(state);
    const seal = new S.AccessSeal(state, memorySql(ledger), journal);
    assert.deepEqual(await seal.recover(), { seal: seal.read(), recovered: 0, notCommitted: 0 });
    return { state, ledger, journal, seal, store: new MemoryStore(ledger, seal, journal),
      restart() { const j = new J.FailureJournal(state); const s = new S.AccessSeal(state, memorySql(ledger), j); return { journal: j, seal: s, store: new MemoryStore(ledger, s, j) }; },
      cleanup() { fs.rmSync(state, { recursive: true, force: true }); } };
  }
  const code = (work, expected) => assert.throws(work, error => error?.code === expected || String(error?.message).includes(expected), expected);
  const rejects = (promise, expected) => assert.rejects(promise, error => error?.code === expected || String(error?.message).includes(expected), expected);

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  test('C01 v2 authentication facts: v1 unchanged; online-auth admits verified success and verified refusal, refuses a clinical write, a mismatched result, an extra key and an audit-namespace credential', () => {
    // v1: same parse, same fields, same chain bytes as A built them.
    const v1 = A.parseAccessEvent(provideEvent(A));
    assert.deepEqual(Object.keys(v1), ['formatVersion', 'surface', 'eventId', 'userId', 'rolesAtTime', 'actingInstitution', 'managingInstitution', 'occurredAt',
      'trustedProxyIp', 'cause', 'executor', 'targets', 'action', 'result', 'requestId', 'auditLinkId', 'relatedEventId']);
    const sealed = A.sealAccessEvent(A.ACCESS_CHAIN_GENESIS, v1);
    assert.equal(sealed.hash, C.entryHash(1, A.ACCESS_CHAIN_GENESIS.hash, JSON.stringify({ kind: 'access', event: v1 })));
    assert(A.verifyAccessChain(A.ACCESS_CHAIN_GENESIS, [sealed], { sequence: 1, hash: sealed.hash }));
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
    // Its own two-year clock from A, read under a snapshot (no hold on a new event).
    const event = authEvent(A);
    assert.equal(inSnapshot(noHolds(event.eventId), () => C.accessExpiry(event)), D.civilPeriodEnd(event.occurredAt, 2));
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

  test('C03 the observed ingress address and the in-process service; an untrusted forwarded header or an omitted success address is refused', () => {
    const proxies = new Set(['172.18.0.5']);
    assert.deepEqual(C.ingressAddress('172.18.0.5', { 'x-real-ip': '192.0.2.10' }, proxies), known({ address: '192.0.2.10', source: 'trusted-proxy' }));
    assert.equal(C.ingressAddress('::ffff:172.18.0.5', { 'x-real-ip': '2001:db8::7' }, proxies).value.address, '2001:db8::7');
    for (const [peer, headers] of [
      ['203.0.113.9', { 'x-real-ip': '192.0.2.10' }],            // a direct caller choosing its address
      ['203.0.113.9', { 'x-forwarded-for': '192.0.2.10' }],
      ['172.18.0.5', { 'x-forwarded-for': '192.0.2.10' }],       // only nginx's overwritten X-Real-IP counts
      ['172.18.0.5', { 'x-real-ip': '192.0.2.10, 198.51.100.1' }],
      ['172.18.0.5', { 'x-real-ip': ['192.0.2.10'] }], ['172.18.0.5', { 'x-real-ip': 'attacker' }], ['172.18.0.5', {}],
      [null, { 'x-real-ip': '192.0.2.10' }], ['', { 'x-real-ip': '192.0.2.10' }],
    ]) assert.deepEqual(C.ingressAddress(peer, headers, proxies), unresolved('not-observed'), JSON.stringify([peer, headers]));
    // A member's success needs the observed address; only an in-process service job has none.
    assert.throws(() => A.parseAccessEvent(authEvent(A, { trustedProxyIp: C.ingressAddress('203.0.113.9', { 'x-real-ip': '192.0.2.10' }, proxies) })));
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
    // One ID, one content: a resend is the same fact; another content under the ID is refused and stored once.
    const w = await world();
    try {
      const first = original();
      const receipt = await w.store.append(first);
      assert.deepEqual(await w.store.append(structuredClone(first)), receipt);
      await rejects(w.store.append({ ...first, offline: { ...facts }, targets: [{ ...first.targets[0], versionId: known('version-3') }] }), 'AccessEventIdConflict');
      assert.equal(w.ledger.entries.filter(e => e.eventId === first.eventId).length, 1);
      assert.equal(JSON.parse(w.ledger.entries[0].payload).event.occurredAt, facts.signedAt);
    } finally { w.cleanup(); }
  });

  test('C05 the body follows the commit receipt only; a provisional, enqueued or other event\'s receipt and any failure send zero bytes', async () => {
    const w = await world();
    try {
      const event = provideEvent(A), seen = [];
      const body = await C.provideAfterReceipt(w.store, event, async receipt => {
        const entry = w.ledger.entries.find(e => e.eventId === event.eventId), sealed = w.seal.read();
        seen.push({ committed: !!entry, sealedThrough: sealed.sequence, entry: entry?.sequence, receipt: receipt.eventId });
        return 'SYNTHETIC body';
      });
      assert.equal(body, 'SYNTHETIC body');
      assert.deepEqual(seen, [{ committed: true, sealedThrough: 1, entry: 1, receipt: event.eventId }]);
      let bytes = 0;
      const send = async () => { bytes++; return 'body'; };
      // A provisional append, a receipt-shaped object nobody minted, another event's receipt, and a store failure.
      const provisional = { append: async e => w.ledger.begin() && (await w.store.appendInTransaction(w.ledger.begin(), e)) };
      await assert.rejects(C.provideAfterReceipt(provisional, provideEvent(A), send));
      await rejects(C.provideAfterReceipt({ append: async e => ({ eventId: e.eventId, durableAt: new Date().toISOString() }) }, provideEvent(A), send), 'DurableReceiptRefused');
      const other = await w.store.append(provideEvent(A));
      await assert.rejects(C.provideAfterReceipt({ append: async () => other }, provideEvent(A), send), /mismatch/);
      w.ledger.down = true;
      await assert.rejects(C.provideAfterReceipt(w.store, provideEvent(A), send));
      w.ledger.down = false;
      assert.equal(bytes, 0, 'no body byte without its own durable receipt');
      // The seal cannot be written: committed, but no receipt and no body; the resend seals it once, with no second entry.
      const stuck = provideEvent(A);
      const sealFile = path.join(w.state, 'seal', 'tail.json');
      fs.chmodSync(path.join(w.state, 'seal'), 0o500);
      const sealDir = path.join(w.state, 'seal');
      const real = fs.renameSync;
      fs.renameSync = (from, to) => { if (to === sealFile) throw Object.assign(new Error('EROFS'), { code: 'EROFS' }); return real(from, to); };
      try { await rejects(C.provideAfterReceipt(w.store, stuck, send), 'SealUnavailable'); } finally { fs.renameSync = real; fs.chmodSync(sealDir, 0o700); }
      assert.equal(bytes, 0);
      assert.equal(w.ledger.entries.filter(e => e.eventId === stuck.eventId).length, 1, 'the commit stands; it was never reported');
      assert.equal(await C.provideAfterReceipt(w.store, stuck, send), 'body');
      assert.equal(bytes, 1);
      assert.equal(w.ledger.entries.filter(e => e.eventId === stuck.eventId).length, 1);
    } finally { w.cleanup(); }
  });

  test('C06 the stored chain against its trusted tail; a deleted middle or tail, a repeated sequence and an unsealed gap are found', async () => {
    const w = await world();
    try {
      const events = Array.from({ length: 5 }, () => authEvent(A));
      for (const event of events) await w.store.append(event);
      const entries = w.ledger.entries.map(e => w.ledger.stored(e)), tail = { sequence: 5, hash: w.ledger.head.hash };
      assert.equal(C.chainViolation(A.ACCESS_CHAIN_GENESIS, entries, tail), null);
      // The same bytes A chains: re-seal each parsed payload with A and compare every hash.
      let previous = A.ACCESS_CHAIN_GENESIS;
      for (const entry of entries) { const sealed = A.sealAccessEvent(previous, JSON.parse(entry.payload).event); assert.equal(sealed.hash, entry.hash); previous = { sequence: sealed.sequence, hash: sealed.hash }; }
      assert.deepEqual(w.seal.read() && { sequence: w.seal.read().sequence, hash: w.seal.read().hash }, tail);
      assert.deepEqual((await w.restart().seal.recover()).recovered, 0);
      const drop = (list, sequence) => list.filter(e => e.sequence !== sequence);
      assert.equal(C.chainViolation(A.ACCESS_CHAIN_GENESIS, drop(entries, 3), tail), 'missing-entry');
      assert.equal(C.chainViolation(A.ACCESS_CHAIN_GENESIS, drop(entries, 5), tail), 'missing-tail');
      assert.equal(C.chainViolation(A.ACCESS_CHAIN_GENESIS, [...entries.slice(0, 3), entries[2], ...entries.slice(3)], tail), 'repeated-sequence');
      assert.equal(C.chainViolation(A.ACCESS_CHAIN_GENESIS, entries.map(e => e.sequence === 2 ? { ...e, payload: e.payload.replace('radiologist', 'admin') } : e), tail), 'changed-entry');
      assert.equal(C.chainViolation(A.ACCESS_CHAIN_GENESIS, entries, { sequence: 5, hash: 'cd'.repeat(32) }), 'tail-hash');
      assert.equal(C.retainedAnchor(entries.slice(2)), null, 'a missing start without a checkpoint is a deletion');
      // The database end behind the trusted tail (a deleted tail) refuses start.
      const saved = w.ledger.entries.slice(), head = { ...w.ledger.head };
      w.ledger.entries = saved.slice(0, 4); w.ledger.head = { sequence: 4, hash: saved[3].hash };
      await rejects(w.restart().seal.recover(), 'LedgerBehindSeal');
      w.ledger.entries = saved.filter(e => e.sequence !== 3); w.ledger.head = head;
      await rejects(w.restart().seal.recover(), 'LedgerChainBroken');
      w.ledger.entries = saved; w.ledger.head = head;
      // A commit without its seal: an explained entry is recovered once; an unexplained one refuses start.
      const pending = authEvent(A), tx = w.ledger.begin();
      await w.store.appendInTransaction(tx, pending); w.ledger.commit(tx);
      const restarted = w.restart(), recovered = await restarted.seal.recover();
      assert.equal(recovered.recovered, 1); assert.equal(restarted.seal.read().sequence, 6);
      assert(restarted.journal.all().some(r => r.kind === 'seal-recovered' && r.body.toSequence === 6));
      const forged = authEvent(A), forgedTx = w.ledger.begin();
      w.ledger.append(forgedTx, forged.eventId, C.canonicalPayload(forged).text, D.civilPeriodEnd(forged.occurredAt, 2)); w.ledger.commit(forgedTx);
      await rejects(w.restart().seal.recover(), 'UnsealedEntryUnexplained');
      w.ledger.entries.pop(); w.ledger.head = { sequence: 6, hash: w.ledger.entries.at(-1).hash };
      // A damaged or missing seal is never rebuilt from the database end.
      const sealFile = path.join(w.state, 'seal', 'tail.json'), good = fs.readFileSync(sealFile, 'utf8');
      fs.writeFileSync(sealFile, good.replace(/"sequence":6/, '"sequence":7'));
      await rejects(w.restart().seal.recover(), 'SealCorrupt');
      fs.rmSync(sealFile);
      await rejects(w.restart().seal.recover(), 'SealMissing');
      assert.equal(fs.existsSync(sealFile), false);
    } finally { w.cleanup(); }
  });

  test('C07 independent expired prefix and its checkpoint; an unexpired, held or middle deletion and a read-extended clock are refused', async () => {
    const at = '2031-01-01T00:00:00.000Z';
    const row = (sequence, expiresAt, held = false) => ({ sequence, hash: createHash('sha256').update(String(sequence)).digest('hex'), expiresAt, held });
    const old = '2028-01-01T00:00:00.000Z', fresh = '2032-01-01T00:00:00.000Z';
    assert.deepEqual(C.planExpiryPrefix([row(1, old), row(2, old), row(3, fresh), row(4, old)], at), { through: 2, hash: row(2, old).hash, count: 2 });
    assert.equal(C.planExpiryPrefix([row(1, fresh), row(2, old)], at), null, 'an unexpired first entry keeps everything after it');
    assert.equal(C.planExpiryPrefix([row(1, old, true), row(2, old)], at), null, 'a held entry is never deleted');
    assert.equal(C.planExpiryPrefix([row(1, old), row(2, old, true), row(3, old)], at).through, 1);
    code(() => C.planExpiryPrefix([row(1, old), row(3, old)], at), 'RetentionViewIncomplete');
    // Each event's own two-year boundary from A (Asia/Seoul civil days); reading it again changes nothing.
    for (const [occurred, end] of [['2026-10-05T00:00:00.000Z', '2028-10-05T15:00:00.000Z'], ['2024-02-28T15:00:00.000Z', '2026-02-28T15:00:00.000Z'],
      ['2026-10-04T15:00:00.000Z', '2028-10-04T15:00:00.000Z']]) {
      const event = authEvent(A, { occurredAt: occurred });
      assert.equal(inSnapshot(noHolds(event.eventId), () => C.accessExpiry(event)), end);
      assert.equal(inSnapshot(noHolds(event.eventId), () => C.accessExpiry(event)), end);
    }
    // The checkpoint bytes are A's expiry entry: same payload, same hash; the chain continues across the deleted prefix.
    const w = await world();
    try {
      for (let n = 0; n < 4; n++) await w.store.append(authEvent(A, { occurredAt: '2020-01-0' + (n + 1) + 'T00:00:00.000Z' }));
      const through = w.ledger.entries[1], previous = { ...w.ledger.head };
      const expected = A.sealAccessExpiry(previous, { sequence: through.sequence, hash: through.hash }, 2, at);
      assert.equal(C.checkpointPayload(at, 2, 2, through.hash), JSON.stringify(expected.payload));
      w.ledger.checkpoint(2, at);
      assert.equal(w.ledger.entries.at(-1).hash, expected.hash);
      const entries = w.ledger.entries.map(e => w.ledger.stored(e));
      assert.deepEqual(C.retainedAnchor(entries), { sequence: 2, hash: through.hash });
      assert.equal(C.chainViolation(C.retainedAnchor(entries), entries, w.ledger.head), null);
      assert.equal((await w.restart().seal.recover()).recovered, 1, 'the retention checkpoint is sealed like any committed entry');
      // A middle entry removed without its checkpoint is a deletion, not an expiry.
      const middle = entries.filter(e => e.sequence !== 4);
      assert.equal(C.chainViolation(C.retainedAnchor(middle), middle, w.ledger.head), 'missing-entry');
      code(() => A.sealAccessExpiry(previous, { sequence: 9, hash: through.hash }, 2, at), 'Invalid expired prefix');
    } finally { w.cleanup(); }
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
    // Release facts are stored only as the exact placement plus its release.
    const w = await world();
    try {
      const tx = w.ledger.begin();
      await w.store.recordHold(tx, lifted); w.ledger.commit(tx);
      const tx2 = w.ledger.begin();
      await rejects(w.store.recordHoldRelease(tx2, { ...released, basis: { ...released.basis, scope: ['other'] } }), 'HoldReleaseBindingRefused');
      await rejects(w.store.recordHold(tx2, released), 'HoldReleaseBindingRefused');
      await w.store.recordHoldRelease(tx2, released); w.ledger.commit(tx2);
      const scope = CTX.transactionScope(), stored = await w.store.snapshot(w.ledger.begin(), scope, { recordIds: [recordId], clauseIds: ['synthetic-law:article-1'] });
      w.ledger.clauses.push({ clauseId: 'synthetic-law:article-1', ...v1 });
      const reread = await w.store.snapshot(w.ledger.begin(), scope, { recordIds: [recordId], clauseIds: ['synthetic-law:article-1'] });
      assert.deepEqual(CTX.withSnapshot(scope, reread, () => D.reloadLegalHolds(recordId)).map(h => [h.holdId, h.release?.reason ?? null]), [['hold-lifted', 'order-ended']]);
      code(() => CTX.withSnapshot(scope, stored, () => D.reloadLegalHolds(recordId)), 'HoldClauseRequired');
    } finally { w.cleanup(); }
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
    assert.equal(D.retentionDeadline(retained), D.civilPeriodEnd(signedAt, 10), 'from the actual signing time');
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
    assert.equal(D.retentionDeadline(retained), D.civilPeriodEnd(signedAt, 10));
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

  test('C10 declaration, selection and catalog agree exactly; a missing or doubled owner, an unclassified table, a dropped migration, a collection mismatch and a false exit are refused', () => {
    // The declaration against the contract and the runtime manifest, both ways.
    assert.deepEqual(declaration.models.sql, Cl.SQL_STORAGE_CLASSIFICATION);
    assert.deepEqual([...declaration.deployment.tables].sort(), [...MF.EMR_STORAGE.tables].sort());
    assert.deepEqual(Object.keys(Cl.SQL_STORAGE_CLASSIFICATION).map(n => n.replace('emr_access.', '')).sort(), [...MF.EMR_STORAGE.tables].sort());
    assert.deepEqual(declaration.deployment.roles, MF.EMR_STORAGE.roles);
    assert.equal(declaration.deployment.schema, MF.EMR_STORAGE.schema); assert.equal(declaration.deployment.tablespace, MF.EMR_STORAGE.tablespace);
    for (const [key, list] of [['runtime_functions', 'runtimeFunctions'], ['reader_functions', 'readerFunctions'], ['retention_functions', 'retentionFunctions']])
      assert.deepEqual([...declaration.deployment[key]].sort(), [...MF.EMR_STORAGE[list]].sort(), key);
    assert.deepEqual(declaration.routes.internal_surfaces, Object.keys(R.INTERNAL_SURFACES));
    assert.deepEqual(declaration.records.terminal_models, Cl.TERMINAL_RECORD_BOUNDARY.models);
    for (const kind of declaration.records.kinds_added) assert(Cl.RECORD_CLASSIFICATION[kind], kind);
    for (const kinds of Object.values(Cl.SQL_STORAGE_CLASSIFICATION)) for (const kind of kinds) assert(Cl.RECORD_CLASSIFICATION[kind], kind);
    const migrations = fs.readdirSync(path.join(api, 'prisma/migrations'), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
    assert.equal(migrations.length, declaration.migrations.count); assert.equal(migrations.at(-1), declaration.migrations.added.at(-1));
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
        ['missing-owner', d => d.owned_paths.B1.push('api/src/emr-runtime/missing.ts'), 'owned-path-missing'],
        ['doubled-owner', d => d.owned_paths['B1-B2'].push(d.owned_paths.B1[0]), 'owned-path-duplicated'],
        ['dropped-migration', d => { d.migrations.count -= 1; }, 'migration-count'],
        ['renamed-migration', d => { d.migrations.added = ['20261008120000_emr_b_renamed']; }, 'migration-missing'],
        ['missing-live-case', d => { d.cases.live.B1.pop(); }, 'live-cases-differ'],
        ['extra-live-case', d => { d.cases.live.B1.push('test_b99_undeclared'); }, 'live-cases-differ'],
        ['candidate-case', d => { d.candidate_cases[0].case = 'EmrBLedgerLive.test_b99_absent'; }, 'candidate-case-missing'],
        ['profile', d => { d.cases.live.profile_suites[0][2] = 'ci-emr-b-other'; }, 'profile-differs'],
        ['keys', d => { delete d.restore; }, 'declaration-keys'],
        ['unclassified-table', d => { d.deployment.tables.push('syn_unclassified'); }, 'catalog-tables-differ'],
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
