/* EMR-B1 contract cases C01-C10 and C13-C21 (REQ-EMR-01/02/06/07/19/20 -> RISK-EMR-* -> TEST-EMR-B-C01..C10).
 *
 * Pure: the A contract, the B runtime modules (api/src/emr-runtime) and the unit declaration, compiled with the installed
 * TypeScript like tests/emr_contract_test.cjs. The ledger store runs its real logic (snapshot, deadline, intent, append,
 * read-back, seal, receipt, settlement) over an in-memory reference model of the schema functions; what the database
 * itself enforces (roles, locks, placement, triggers, the SQL hash) is the live suite tests/emr/b/live.py. Assertions are
 * on returned/stored facts, error codes and order of effects - never on implementation text. Synthetic data only.
 *
 * C13's file-replacement crash transport requires Linux (rename over an open descriptor).
 * The complete B contract selection therefore runs on Linux, as does the product runtime.
 * With `--emr-b-live <operation> <json>` this file is instead the live suite's driver inside the production API image: it
 * runs one operation of the compiled /app/dist store against the database named by DATABASE_URL and prints one JSON line.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');

if (process.argv.includes('--emr-b-live')) {
  // A 48-viewer read-back can exceed the pipe's single-write capacity. Exit only
  // after the complete JSON line drains, retaining every row for the assertions.
  const send = result => process.stdout.write('EMR_B_RESULT ' + JSON.stringify(result) + '\n', () => process.exit(0));
  liveDriver().then(send, error => send({ error: errorCode(error), name: error?.name ?? null, problems: error?.problems ?? null }));
} else {
  contractSuite();
}

function seedIntents(journal, values) {
  journal.coordinator.call('update', state => {
    for (const [stream, attemptId, eventId, contentSha256, bundleId] of values)
      state.intents[stream + ':' + attemptId] = { stream, attemptId, eventId, contentSha256, bundleId,
        owner: journal.coordinator.ownerId };
  });
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
  const measuredUrl = new URL(args.url ?? process.env.DATABASE_URL);
  if (!measuredUrl.searchParams.has('connection_limit')) measuredUrl.searchParams.set('connection_limit', '9');
  const rawUrl = measuredUrl.toString();
  const admission = fs.existsSync(dist + '/emr-runtime/admission.js') ? require(dist + '/emr-runtime/admission') : null;
  const pool = admission?.appendPoolConfiguration ? admission.appendPoolConfiguration(rawUrl) : { url: rawUrl, poolSize: Number(measuredUrl.searchParams.get('connection_limit')) };
  const LedgerClient = fs.existsSync(dist + '/emr-runtime/client.js') ? require(dist + '/emr-runtime/client').EmrLedgerClient : null;
  const prisma = LedgerClient ? new LedgerClient(pool.url) : new PrismaClient({ datasources: { db: { url: pool.url } } });
  prisma.emrAppendPoolSize = pool.poolSize;
  await prisma.$connect();
  try {
    if (operation === 'verify-runtime') return await verifyRuntimeConnection(prisma);
    if (operation === 'expire') {
      const reader = new PrismaClient({ datasources: { db: { url: process.env.EMR_READER_URL } } });
      try {
        const journal = FailureJournal.retention(process.env.KIN_EMR_STATE_DIR);
        const seal = new AccessSeal(process.env.KIN_EMR_STATE_DIR, new RT.PrismaLedgerSql(reader), journal);
        const retention = args.exit ? {
          $queryRaw: prisma.$queryRaw.bind(prisma),
          $transaction: async (work, options) => {
            const result = await prisma.$transaction(async tx => {
              const value = await work(tx);
              if (args.exit === 'before-commit') process.exit(0);
              return value;
            }, options);
            if (args.exit === 'after-commit') process.exit(0);
            return result;
          },
        } : prisma;
        return await RT.expireAccessPrefix(retention, seal, args.now ?? new Date().toISOString());
      } finally { await reader.$disconnect(); }
    }
    if (operation === 'civil') return args.at.map(at => C.accessRetentionFloor(at));
    const state = process.env.KIN_EMR_STATE_DIR;
    const sql = new RT.PrismaLedgerSql(prisma);
    const journal = new FailureJournal(state);
    const seal = new AccessSeal(state, sql, journal);
    const transactions = operation === 'provide' && args.sealAfterCommit ? {
      $transaction: async (work, options) => {
        const result = await prisma.$transaction(work, options);
        // Tail publication opens this file for writing after COMMIT. Making the
        // directory read-only no longer blocks an append-only settlement WAL.
        fs.chmodSync(path.join(state,'seal','tail.json'),0o400);
        return result;
      },
    } : prisma;
    const store = new RT.AccessLedgerStore(transactions, sql, seal, journal, pool.poolSize);
    // The viewing stream's seal flattened beside both streams, so a caller reads the stream every event is in directly.
    const flat = s => s === 'absent' ? 'absent' : { ...s.streams.viewing, streams: s.streams, sealedAt: s.sealedAt };
    if (operation === 'recover') { const r = await seal.recoverAtStart(); return { ...r, seal: flat(r.seal) }; }
    // A process that writes ledger facts is a started server: its start-up check runs first (B2 calls it before listen).
    if (['append', 'business', 'writer-fence', 'benchmark'].includes(operation)) {
      if (args.measure && !seal.recoverAtStart) await seal.recover(); // Round-3 baseline uses the original startup API.
      else await seal.recoverAtStart();
    }
    if (operation === 'seal') return flat(seal.read());
    if (operation === 'journal-add') return journal.record(args.id, 'append-rolled-back', { eventId: args.id, cause: 'business-rollback' });
    if (operation === 'journal') return journal.all().map(record => ({ id: record.id, kind: record.kind, body: record.body }));
    const stream = args.stream ?? 'viewing';
    if (operation === 'benchmark') return await require('./live_benchmark.cjs').run({
      prisma, store, seal, sql, Sql: RT.PrismaLedgerSql, event: () => authEvent(A) });
    if (operation === 'writer-fence') {
      let release, staged, provisional;
      const held = new Promise(resolve => { release = resolve; });
      const ready = new Promise(resolve => { staged = resolve; });
      const writing = store.withAppendTransaction(async tx => {
        provisional = await store.appendInTransaction(tx, authEvent(A));
        staged(); await held;
      });
      await Promise.race([ready, writing]);
      const recovering = seal.recoverAtStart();
      let waiting = false;
      try {
        const deadline = Date.now() + 5000;
        while (!waiting && Date.now() < deadline) {
          const [row] = await prisma.$queryRaw`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=77104 AND objid=1 AND mode='ExclusiveLock' AND NOT granted) AS waiting`;
          waiting = row.waiting;
        }
      } finally { release(); }
      await writing;
      const recovery = await recovering;
      const receipt = await store.confirm(provisional);
      const first = journal.coordinator, second = new FailureJournal(state).coordinator;
      const stale = first.call('read'), revision = stale.revision;
      stale.revision++;
      const installed = second.call('compare-and-set', {before:revision,state:stale});
      const replay = first.call('compare-and-set', {before:revision,state:stale});
      return { waiting, notCommitted: recovery.notCommitted, receipt,
        staleWriterRefused: installed.changed && !replay.changed };
    }
    if (operation === 'tail') return await sql.tail(stream);
    if (operation === 'entries') {
      const entries = [];
      for (let after = 0; ;) { const page = await sql.entriesAfter(stream, after, 1000); entries.push(...page); if (page.length < 1000) break; after = page.at(-1).sequence; }
      return entries;
    }
    if (operation === 'append') {
      // Standalone facts; `concurrent` appends at once from one process.
      const events = (args.events ?? []).length ? args.events : Array.from({ length: args.count ?? 1 }, () => authEvent(A, args.overrides ?? {}));
      if (args.measure) {
        const T = require('./throughput.cjs'), probe = T.instrument(prisma, store, seal, { headProbe: args.headProbe === true });
        try {
          const results = args.concurrent ? await Promise.all(events.map(e => probe.run(e))) : await sequential(events, e => probe.run(e));
          return { results, summary: T.summary(results), drain_groups: probe.drains };
        } finally { probe.restore(); }
      }
      const run = async event => { try { return { eventId: event.eventId, receipt: await store.append(event) }; } catch (error) { return { eventId: event.eventId, error: errorCode(error) }; } };
      const results = args.concurrent ? await Promise.all(events.map(run)) : await sequential(events, run);
      return { results, events };
    }
    if (operation === 'business') {
      // A business change (the legacy AuditLog row) and its ledger fact in one transaction; `fail` injects a failure.
      const event = args.event ?? authEvent(A);
      let appended, transaction, callbackFailed = false;
      try {
        appended = await store.withAppendTransaction(async tx => {
          transaction = tx;
          try {
          const [row] = await tx.$queryRaw`INSERT INTO "AuditLog" (actor, action, target, detail) VALUES ('SYNTHETIC-emr-b', 'auth.login', 'SYNTHETIC-sub', ${'{"synthetic":true}'}) RETURNING id`;
          if (args.fail === 'business-before-append') throw Object.assign(new Error('synthetic business refusal'), { code: 'SyntheticBusinessRefusal' });
          const made = await store.appendInTransaction(tx, event);
          await store.recordProjection(tx, event.eventId, row.id);
          if (args.fail === 'business-after-append') throw Object.assign(new Error('synthetic business refusal'), { code: 'SyntheticBusinessRefusal' });
          if (args.exit === 'before-commit') process.exit(0);
          return made;
          } catch (error) { callbackFailed = true; throw error; }
        });
      } catch (error) {
        let settled = null;
        try { await store.settleTransaction(transaction, event, error, callbackFailed); } catch (settleError) { settled = errorCode(settleError); }
        return { eventId: event.eventId, error: errorCode(error), settled };
      }
      if (args.exit === 'after-commit') process.exit(0);
      if (args.exit === 'after-viewing-seal') {
        const first = appended.entries.find(entry => entry.stream === 'viewing');
        await seal.advance('viewing', {sequence:first.sequence,hash:first.hash});
        process.exit(0);
      }
      try { return { eventId: event.eventId, receipt: await store.confirm(appended) }; }
      catch (error) { return { eventId: event.eventId, committed: true, error: errorCode(error) }; }
    }
    if (operation === 'provide') {
      // A's first-byte rule with B's receipt: what had happened by the time the body callback ran.
      const event = args.event ?? provideEvent(A);
      const order = [];
      try {
        await seal.recoverAtStart();
        const body = await C.provideAfterReceipt(store, event, async receipt => {
          const stored = await sql.entryForEvent('viewing', event.eventId);
          const sealed = seal.read();
          order.push({ body: true, stored: !!stored, sealedThrough: sealed === 'absent' ? null : sealed.streams.viewing.sequence, entry: stored?.sequence ?? null, receipt });
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
    // The one retention rule's view of each event: its record targets, and its end while no record end is known (B1).
    if (operation === 'targets') return (args.events ?? []).map(event => C.recordTargets(event));
    if (operation === 'deadline') return (args.events ?? []).map(event => Object.fromEntries(A.accessStreams(event).map(s =>
      [s, C.accessDeadline(s, { occurredAt: event.occurredAt, targets: C.recordTargets(event) }, C.RECORD_RETENTION_UNAVAILABLE)])));
    if (operation === 'identity') {
      return await prisma.$transaction(async tx => Promise.all((args.pairs ?? []).map(([issuer, subject]) => store.resolveIdentity(tx, issuer, subject))));
    }
    if (operation === 'order-facts') {
      return await prisma.$transaction(async tx => {
        for (const fact of args.facts ?? []) await store.recordOrderFact(tx, fact);
        const history = await store.orderFacts(tx, args.recordId);
        const scope = CTX.transactionScope();
        const snapshot = await store.snapshot(tx, scope, { orderRecordIds: [args.recordId], recordIds: [args.recordId] });
        return CTX.withSnapshot(scope, snapshot, () => {
          const Cl = require(dist + '/emr-contract/classification');
          const last = history.at(-1);
          const source = Cl.resolveStoredRecord(M.emrAdapters().stored, args.recordId, last.event.eventId);
          return { history, kinds: source.kinds, duties: D.orderRetentionDuties(source) };
        });
      });
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
  const J0 = load('emr-runtime/failure-journal.ts'), CO = load('emr-runtime/coordinator.ts'), EW = load('emr-runtime/external-writer.ts');
  // Constructing another fixture instance models process death/restart; live process
  // ownership and kernel locks are exercised by L03/L03b in the disposable image.
  const J = {...J0, FailureJournal: class extends J0.FailureJournal { constructor(dir) { super(dir, new CO.StateCoordinator(dir,
    request => request.operation === 'owner-alive' ? false : EW.executeExternal(request))); } }};
  const S = load('emr-runtime/seal.ts'), MF = load('emr-runtime/manifest.ts');
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
  const ledgerError = (code, message) => Object.assign(new Error(message ?? code), { code: 'P2010', meta: { code } });

  /** An in-memory reference model of schema emr_access's functions: two streams (D-1), per-transaction staging, rollback.
   * `entries`, `head` and `chainId` are the viewing stream's (the stream every event is in). */
  class MemoryLedger {
    constructor() {
      this.streams = Object.fromEntries(A.ACCESS_STREAMS.map(s => [s, { chainId: randomUUID(), head: { sequence: 0, hash: '0'.repeat(64) }, entries: [] }]));
      this.markers = []; this.holdRowsList = []; this.requests = []; this.clauses = []; this.down = false;
    }
    get entries() { return this.streams.viewing.entries; } set entries(value) { this.streams.viewing.entries = value; }
    get head() { return this.streams.viewing.head; } set head(value) { this.streams.viewing.head = value; }
    get chainId() { return this.streams.viewing.chainId; }
    begin() { return { staged: { viewing: [], history: [] }, head: {}, holds: [], requests: [], markers: [] }; }
    commit(tx) {
      for (const s of A.ACCESS_STREAMS) { this.streams[s].entries.push(...tx.staged[s]); if (tx.head[s]) this.streams[s].head = tx.head[s]; }
      this.markers.push(...tx.markers); this.holdRowsList.push(...tx.holds); this.requests.push(...tx.requests);
    }
    visible(tx, stream = 'viewing') { return tx ? [...this.streams[stream].entries, ...tx.staged[stream]] : this.streams[stream].entries; }
    guard() { if (this.down) throw Object.assign(new Error("Can't reach database server"), { code: 'P1001' }); }
    append(tx, stream, eventId, payload, act, attemptId, bundleId) {
      this.guard();
      const doc = JSON.parse(payload), kind = stream === 'history' ? 'history' : 'access';
      const targets = Array.isArray(doc.event?.targets) ? doc.event.targets.flatMap((t, index) => t.recordId?.status === 'not-applicable' ? [] : [{ index, kind: t.kind,
        recordId: t.recordId?.status === 'known' ? t.recordId.value : null, versionId: t.versionId?.status === 'known' ? t.versionId.value : null }]) : null;
      if (!A.ACCESS_STREAMS.includes(stream) || doc.kind !== kind || doc.event.eventId !== eventId || !targets ||
          !['기재', '추가기재', '수정', '열람', 'none'].includes(act) || (stream === 'history' && (!['기재', '추가기재', '수정'].includes(act) || !targets.length))) throw ledgerError('EB003');
      const chain = this.streams[stream], existing = this.visible(tx, stream).find(e => e.eventId === eventId);
      const head = tx.head[stream] ?? chain.head;
      if (existing) {
        if (existing.payload !== payload || existing.statutoryAct !== act) throw ledgerError('EB002');
        return { chainId: chain.chainId, sequence: existing.sequence, previousHash: existing.previousHash, hash: existing.hash, storedAt: existing.storedAt, replay: true };
      }
      const sequence = head.sequence + 1, hash = C.entryHash(sequence, head.hash, payload), storedAt = new Date().toISOString();
      tx.staged[stream].push({ sequence, previousHash: head.hash, hash, kind, statutoryAct: act, eventId, payload,
        contentSha256: createHash('sha256').update(payload).digest('hex'), storedAt, occurredAt: doc.event.occurredAt, targets });
      tx.head[stream] = { sequence, hash };
      if (attemptId) tx.markers.push({stream, chainId:chain.chainId, attemptId, bundleId, kind, eventId, sequence,
        previousHash:head.hash, hash, contentSha256:createHash('sha256').update(payload).digest('hex'), generation:0, proofDigest:null});
      return { chainId: chain.chainId, sequence, previousHash: head.hash, hash, storedAt, replay: false };
    }
    checkpoint(through, at) {
      const anchor = this.entries.find(e => e.sequence === through);
      const count = this.entries.filter(e => e.sequence <= through).length;
      this.entries = this.entries.filter(e => e.sequence > through);
      this.markers = this.markers.filter(m => m.stream !== "viewing" || m.sequence > through);
      const payload = C.checkpointPayload(at, through, count, anchor.hash), sequence = this.head.sequence + 1;
      const hash = C.entryHash(sequence, this.head.hash, payload);
      this.entries.push({ sequence, previousHash: this.head.hash, hash, kind: 'expiry', statutoryAct: null, eventId: null, payload, contentSha256: createHash('sha256').update(payload).digest('hex'), storedAt: at, occurredAt: at, targets: [] });
      this.head = { sequence, hash };
    }
    stored(e) { return { sequence: e.sequence, previousHash: e.previousHash, hash: e.hash, kind: e.kind, statutoryAct: e.statutoryAct, eventId: e.eventId, payload: e.payload, contentSha256: e.contentSha256, storedAt: e.storedAt }; }
  }
  function memorySql(ledger) {
    const sql = {
      snapshot: async work => { ledger.guard(); return work(sql); }, withWriterFence: async work => work(sql),
      markerForSlot: async (stream, sequence) => ledger.markers.find(m => m.stream === stream && m.sequence === sequence) ?? null,
      markerForAttempt: async (stream, attemptId) => ledger.markers.find(m => m.stream === stream && m.attemptId === attemptId) ?? null,
      tail: async stream => { ledger.guard(); return { chainId: ledger.streams[stream].chainId, ...ledger.streams[stream].head }; },
      entriesAfter: async (stream, after, limit) => { ledger.guard(); return ledger.streams[stream].entries.filter(e => e.sequence > after).sort((a, b) => a.sequence - b.sequence).slice(0, limit).map(e => ledger.stored(e)); },
      entryForEvent: async (stream, eventId) => { ledger.guard(); const e = ledger.streams[stream].entries.find(x => x.eventId === eventId); return e ? ledger.stored(e) : null; },
      placement: async () => [],
    };
    sql.verificationPage = async (stream, after, limit) => ({ tail: await sql.tail(stream), first: (await sql.entriesAfter(stream, 0, 1))[0] ?? null,
      entries: await Promise.all((await sql.entriesAfter(stream, after, limit)).map(async entry => ({ entry, marker: await sql.markerForSlot(stream, entry.sequence) }))) });
    return sql;
  }
  class MemoryStore extends RT.AccessLedgerStore {
    constructor(ledger, seal, journal) {
      super({ $transaction: async work => { const tx = ledger.begin(); const value = await work(tx); ledger.commit(tx); return value; } }, memorySql(ledger), seal, journal);
      this.ledger = ledger;
    }
    async enterWriter() {}
    async bindCommit(tx, binding) { const m=tx.markers.find(m=>m.attemptId===binding.attemptId&&m.stream===binding.stream);Object.assign(m,binding); }
    async appendRow(tx, stream, eventId, payload, act, attemptId, bundleId) { return this.ledger.append(tx, stream, eventId, payload, act, attemptId, bundleId); }
    async holdRows(tx, recordId) { this.ledger.guard(); return [...this.ledger.holdRowsList, ...(tx.holds ?? [])].filter(r => r.recordId === recordId).map(({ holdId, phase, body }) => ({ holdId, phase, body })); }
    async placeHoldRow(tx, holdId, recordId, body) { tx.holds.push({ holdId, phase: 'placed', recordId, body }); }
    async releaseHoldRow(tx, holdId, body) { const placed = [...this.ledger.holdRowsList, ...tx.holds].find(r => r.holdId === holdId && r.phase === 'placed'); tx.holds.push({ holdId, phase: 'released', recordId: placed.recordId, body }); }
    async requestRows(tx, kind, requestId) { return this.ledger.requests.filter(r => r.kind === kind && r.requestId === requestId).map(({ phase, body }) => ({ phase, body })); }
    async dutyRequestRow(tx, kind, requestId, phase, body) { tx.requests.push({ kind, requestId, phase, body }); }
    async clauseRows(tx, clauseId) { return this.ledger.clauses.filter(c => c.clauseId === clauseId).map(({ clauseId: _, ...row }) => row); }
    async entryRow(tx, eventId) { const e = this.ledger.visible(tx).find(x => x.eventId === eventId); return e ? this.ledger.stored(e) : null; }
  }
  /** A started server's ledger: its seal is created by the start-up recovery over the empty chains, as in production. */
  async function world() {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'emr-b-state-'));
    const ledger = new MemoryLedger(), journal = new J.FailureJournal(state);
    const seal = new S.AccessSeal(state, memorySql(ledger), journal);
    const started = await seal.recoverAtStart();
    assert.deepEqual([started.seal, started.recovered, started.notCommitted], [seal.read(), 0, 0]);
    return { state, ledger, journal, seal, store: new MemoryStore(ledger, seal, journal),
      restart() { const j = new J.FailureJournal(state); const s = new S.AccessSeal(state, memorySql(ledger), j); return { journal: j, seal: s, store: new MemoryStore(ledger, s, j) }; },
      cleanup() { fs.rmSync(state, { recursive: true, force: true }); } };
  }
  /** A change of an EMR record (D-1: recorded in both streams). */
  const changeEvent = (overrides = {}) => provideEvent(A, { eventId: 'change-' + randomUUID(), surface: 'POST studies/:uid/report/commit', action: 'approve-sign', result: 'succeeded', ...overrides });
  const code = (work, expected) => assert.throws(work, error => error?.code === expected || String(error?.message).includes(expected), expected);
  const rejects = (promise, expected) => assert.rejects(promise, error => error?.code === expected || String(error?.message).includes(expected), expected);

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  test('C01 v2 authentication facts: v1 keeps its rules with D-18 context; online-auth admits verified success and verified refusal, refuses a clinical write, a mismatched result, an extra key and an audit-namespace credential', () => {
    // v1: A's parse, its fields plus D-18's server-bound context, the chain bytes A builds.
    const v1 = A.parseAccessEvent(provideEvent(A));
    assert.deepEqual(Object.keys(v1), ['formatVersion', 'surface', 'eventId', 'userId', 'rolesAtTime', 'actingInstitution', 'managingInstitution', 'occurredAt',
      'trustedProxyIp', 'cause', 'context', 'executor', 'targets', 'action', 'result', 'requestId', 'auditLinkId', 'relatedEventId']);
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
    // An authentication event is about no EMR record: no bound target, and the one retention rule ends it at the floor.
    const event = authEvent(A);
    assert.deepEqual(C.recordTargets(event), []);
    assert.deepEqual(A.accessStreams(event), ['viewing']);
    assert.equal(C.accessDeadline('viewing', { occurredAt: event.occurredAt, targets: C.recordTargets(event) }), C.accessRetentionFloor(event.occurredAt));
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
        seen.push({ committed: !!entry, sealedThrough: sealed.streams.viewing.sequence, entry: entry?.sequence, receipt: receipt.eventId });
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
      const real = fs.openSync;
      let failures = 0;
      fs.openSync = (file, flags, ...args) => {
        if (file === sealFile && flags === 'r+') { failures++; throw Object.assign(new Error('EROFS'), { code: 'EROFS' }); }
        return real(file, flags, ...args);
      };
      try { await rejects(C.provideAfterReceipt(w.store, stuck, send), 'SealUnavailable'); }
      finally { fs.openSync = real; fs.chmodSync(sealDir, 0o700); }
      assert(failures > 0, 'the protected tail publication actually encountered the unavailable disk');
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
      assert.deepEqual(w.seal.read() && { sequence: w.seal.read().streams.viewing.sequence, hash: w.seal.read().streams.viewing.hash }, tail);
      assert.deepEqual((await w.restart().seal.recoverAtStart()).recovered, 0);
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
      await rejects(w.restart().seal.recoverAtStart(), 'LedgerBehindSeal');
      w.ledger.entries = saved.filter(e => e.sequence !== 3); w.ledger.head = head;
      await rejects(w.restart().seal.recoverAtStart(), 'LedgerChainBroken');
      w.ledger.entries = saved; w.ledger.head = head;
      // A commit without its seal: an explained entry is recovered once; an unexplained one refuses start.
      const pending = authEvent(A), tx = w.ledger.begin();
      await w.store.appendInTransaction(tx, pending); w.ledger.commit(tx);
      const restarted = w.restart(), recovered = await restarted.seal.recoverAtStart();
      assert.equal(recovered.recovered, 1); assert.equal(restarted.seal.read().streams.viewing.sequence, 6);
      assert(restarted.journal.all().some(r => r.kind === 'seal-recovered' && r.body.toSequence === 6));
      const forged = authEvent(A), forgedTx = w.ledger.begin();
      w.ledger.append(forgedTx, 'viewing', forged.eventId, C.canonicalPayload(forged).text, 'none'); w.ledger.commit(forgedTx);
      await rejects(w.restart().seal.recoverAtStart(), 'UnsealedEntryUnexplained');
      w.ledger.entries.pop(); w.ledger.head = { sequence: 6, hash: w.ledger.entries.at(-1).hash };
      // A damaged or missing seal is never rebuilt from the database end.
      const sealFile = path.join(w.state, 'seal', 'tail.json'), good = fs.readFileSync(sealFile, 'utf8');
      fs.writeFileSync(sealFile, good.replace(/"sequence":6/, '"sequence":7'));
      await rejects(w.restart().seal.recoverAtStart(), 'SealTailMismatch');
      fs.rmSync(sealFile);
      await rejects(w.restart().seal.recoverAtStart(), 'SealMissing');
      assert.equal(fs.existsSync(sealFile), false);
    } finally { w.cleanup(); }
  });

  test('C07 independent expired prefix and its checkpoint under the one retention rule: a viewing entry ends at the floor, a change\'s history entry lives as long as the record it changed and never ends while that end is unknown; an unexpired, held or middle deletion and a read-extended clock are refused', async () => {
    // The floor is A's civil period over A's classification period for access records - bound to the rule, never to a
    // number: the period may change in A's table alone (Asia/Seoul civil days, the first day counted, a 29 February start).
    const years = Cl.RECORD_CLASSIFICATION[C.ACCESS_RETENTION.kind].retention.years;
    assert.equal(C.ACCESS_RETENTION.years, years);
    for (const occurred of ['2026-10-05T00:00:00.000Z', '2024-02-28T15:00:00.000Z', '2024-02-28T15:00:00.001Z', '2026-10-04T15:00:00.000Z'])
      assert.equal(C.accessRetentionFloor(occurred), D.civilPeriodEnd(occurred, years));
    // Times relative to the rule: `at` is one day past the floor of `old`; `fresh` started two days after `old`.
    const day = 86400000, plus = (iso, ms) => new Date(Date.parse(iso) + ms).toISOString();
    const old = '2020-01-01T00:00:00.000Z', fresh = '2020-01-03T00:00:00.000Z', at = plus(C.accessRetentionFloor(old), day);
    assert(C.accessRetentionFloor(fresh) > at);
    const record = { index: 0, kind: 'report-version', recordId: 'report-1', versionId: 'version-1' };
    const retainedUntil = plus(at, 365 * day), endedAt = plus(old, day);
    const ends = { retained: () => retainedUntil, ended: () => endedAt };
    // Viewing stream: every entry ends at its floor - a 열람, an event about no record and a change's viewing copy alike.
    assert.equal(C.accessDeadline('viewing', { occurredAt: old, targets: [] }), C.accessRetentionFloor(old));
    assert.equal(C.accessDeadline('viewing', { occurredAt: old, targets: [record] }, ends.retained), C.accessRetentionFloor(old));
    // History stream: a change lives as long as every record it changed (its floor remainder stays in the viewing stream);
    // with no known record end it has no end at all.
    assert.equal(C.accessDeadline('history', { occurredAt: old, targets: [record] }, ends.retained), retainedUntil);
    assert.equal(C.accessDeadline('history', { occurredAt: old, targets: [record] }, ends.ended), endedAt);
    assert.equal(C.accessDeadline('history', { occurredAt: old, targets: [record] }), null);
    assert.equal(C.accessDeadline('history', { occurredAt: old, targets: [{ ...record, recordId: null }] }, ends.retained), null);
    assert.equal(C.accessDeadline('history', { occurredAt: old, targets: [] }, ends.retained), null);
    const row = (sequence, occurredAt, held = false) => ({ sequence, hash: createHash('sha256').update(String(sequence)).digest('hex'), kind: 'access', occurredAt, held });
    assert.deepEqual(C.planExpiryPrefix([row(1, old), row(2, old), row(3, fresh), row(4, old)], at), { through: 2, hash: row(2, old).hash, count: 2 });
    assert.equal(C.planExpiryPrefix([row(1, fresh), row(2, old)], at), null, 'an unexpired first entry keeps everything after it');
    assert.equal(C.planExpiryPrefix([row(1, old, true), row(2, old)], at), null, 'a held entry is never deleted');
    assert.equal(C.planExpiryPrefix([row(1, old), row(2, old, true), row(3, old)], at).through, 1);
    code(() => C.planExpiryPrefix([row(1, old), row(3, old)], at), 'RetentionViewIncomplete');
    assert.deepEqual(C.planExpiryPrefix([row(1, old), row(2, old)], at), C.planExpiryPrefix([row(1, old), row(2, old)], at), 'reading never moves an end');
    // The checkpoint bytes are A's expiry entry: same payload, same hash; the chain continues across the deleted prefix.
    const w = await world();
    try {
      for (let n = 0; n < 4; n++) await w.store.append(authEvent(A, { occurredAt: '2020-01-0' + (n + 1) + 'T00:00:00.000Z' }));
      // Nothing stored carries a deadline; an authentication event and a 열람 are viewing-only, a change is in both streams.
      const provided = provideEvent(A), changed = changeEvent();
      await w.store.append(provided); await w.store.append(changed);
      assert(A.ACCESS_STREAMS.every(s => w.ledger.streams[s].entries.every(entry => !('expiresAt' in entry) && !('expires_at' in entry))));
      assert.deepEqual(w.ledger.entries.map(e => e.statutoryAct), ['none', 'none', 'none', 'none', '열람', '기재']);
      assert.deepEqual(w.ledger.entries.slice(0, 4).map(entry => entry.targets), [[], [], [], []]);
      assert.deepEqual(w.ledger.entries[4].targets, C.recordTargets(provided));
      const [history] = w.ledger.streams.history.entries;
      assert.deepEqual([w.ledger.streams.history.entries.length, history.eventId, history.kind, history.statutoryAct], [1, changed.eventId, 'history', '기재']);
      assert.deepEqual(history.targets, [{ index: 0, kind: 'report-version', recordId: 'report-1', versionId: 'version-1' }]);
      assert.equal(w.seal.read().streams.history.sequence, 1);
      const through = w.ledger.entries[1], previous = { ...w.ledger.head };
      const expected = A.sealAccessExpiry(previous, { sequence: through.sequence, hash: through.hash }, 2, at);
      assert.equal(C.checkpointPayload(at, 2, 2, through.hash), JSON.stringify(expected.payload));
      await stageExpiry(w,2,at);
      assert.equal(w.ledger.entries.at(-1).hash, expected.hash);
      const entries = w.ledger.entries.map(e => w.ledger.stored(e));
      assert.deepEqual(C.retainedAnchor(entries), { sequence: 2, hash: through.hash });
      assert.equal(C.chainViolation(C.retainedAnchor(entries), entries, w.ledger.head), null);
      assert.equal(C.chainViolation(C.retainedAnchor(entries), entries, w.ledger.head, 'history'), 'foreign-stream', 'a viewing entry never verifies as history');
      assert.equal((await w.restart().seal.recoverAtStart()).recovered, 1, 'the retention checkpoint is sealed like any committed entry');
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

  test('C13 expiry recovery needs external proof of the deleted prefix and its trusted seal, including interrupted recovery', async () => {
    // D935: a slot-waiting request has no intent; keep the live recovery
    // counterexample at a RESERVED but still open transaction instead. An
    // unexpired job has no work and must not wait for the startup writer fence.
    {
      const w = await world(), event = authEvent(A), tx = w.ledger.begin();
      let finishWriter, completed = false, result, failure;
      const ended = new Promise(resolve => { finishWriter = resolve; });
      const fence = w.seal.sql.withWriterFence;
      let job;
      try {
        await w.store.appendInTransaction(tx, event);
        const staged = tx.staged.viewing.at(-1);
        w.seal.sql.withWriterFence = async work => { await ended; return fence(work); };
        const retention = { $queryRaw: async () => [{ sequence: staged.sequence, hash: staged.hash,
          kind: 'access', occurred_at: event.occurredAt, held: false }] };
        job = RT.expireAccessPrefix(retention, w.seal, event.occurredAt).then(value => { completed = true; result = value; }, error => { failure = error; });
        await new Promise(setImmediate);
        const noWait = completed && result === null;
        w.ledger.commit(tx); finishWriter(); await job;
        assert.equal(failure, undefined);
        assert(noWait, 'an unexpired job must finish while the unrelated reserved writer is still open');
      } finally { finishWriter(); if (job) await job; w.cleanup(); }
    }
    const checked=spawnSync(process.execPath,[path.join(__dirname,'seal_checker.cjs'),root,path.join(api,'node_modules/typescript'),'', 'named'],{encoding:'utf8',timeout:180000});
    if(checked.error||checked.status===2||checked.status===3)throw new Error('seal checker harness failed: '+checked.stderr);
      assert.equal(checked.status,0,'seal invariant behaviour: '+checked.stdout);
      // Already-applied v2 bytes must upgrade without manufacturing authority for an unsealed suffix.
      for (const suffix of [false, true]) {
        const w = await world();
        try {
          await w.store.append(authEvent(A));
          const old = w.seal.read(), canonical = {streams:old.streams,sealedAt:old.sealedAt};
          if (suffix) {
            const tx = w.ledger.begin();
            await w.store.appendInTransaction(tx, authEvent(A));w.ledger.commit(tx);
          }
          fs.unlinkSync(path.join(w.state,'seal','settlement.json'));
          fs.rmSync(path.join(w.state,'seal','settlement.jsonl'),{force:true});
          fs.writeFileSync(path.join(w.state,'seal','tail.json'),JSON.stringify({format:2,...canonical,digest:createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}));
          if (suffix) await assert.rejects(w.restart().seal.recoverAtStart(),error=>error.code==='SealTailMismatch');
          else {
            assert.equal((await w.restart().seal.recoverAtStart()).recovered,0);
            assert(C.isDurableReceipt(await w.store.append(authEvent(A))));
            assert.equal(w.seal.read().streams.viewing.sequence,2);
          }
        } finally { w.cleanup(); }
      }
    const at = '2035-01-01T00:00:00.000Z';
    for (const cut of ['before-delete', 'after-delete', 'after-seal']) {
      const w = await world();
      try {
        await w.store.append(authEvent(A)); await w.store.append(authEvent(A));
        const saved = {entries:structuredClone(w.ledger.entries),head:{...w.ledger.head},markers:structuredClone(w.ledger.markers)};
        await stageExpiry(w,1,at);
        if(cut==='before-delete') Object.assign(w.ledger,saved);
        if(cut==='after-seal') await w.seal.advance('viewing',w.ledger.head);
        const r=await w.restart().seal.recoverAtStart();
        assert.equal(r.recovered,cut==='after-delete'?1:0);
        assert.equal((await w.restart().seal.recoverAtStart()).recovered,0);
        await w.store.append(authEvent(A));
      } finally { w.cleanup(); }
    }
    for(const attack of ['missing-marker','wrong-marker','missing-proof','wrong-proof','stale-slot','different-checkpoint','chain-id','tail-replay']) {
      const w=await world();
      try {
        const oldTail=fs.readFileSync(path.join(w.state,'seal','tail.json'));
        await w.store.append(authEvent(A));await w.store.append(authEvent(A));
        await stageExpiry(w,1,at);
        const marker=w.ledger.markers.at(-1);
        if(attack==='missing-marker')w.ledger.markers.pop();
        if(attack==='wrong-marker')marker.attemptId=randomUUID();
        if(attack==='missing-proof'||attack==='wrong-proof'||attack==='stale-slot') {
          const co=w.journal.coordinator,state=co.call('read'),id='viewing:'+marker.attemptId;
          if(attack==='missing-proof')delete state.proofs[id];
          if(attack==='wrong-proof')state.proofs[id].binding.hash='f'.repeat(64);
          if(attack==='stale-slot')state.slots['viewing:'+marker.sequence].generation++;
          const before=state.revision++;co.call('compare-and-set',{before,state});
        }
        if(attack==='different-checkpoint') { const e=w.ledger.entries.at(-1);e.payload=e.payload.replace('2035','2036');e.contentSha256=createHash('sha256').update(e.payload).digest('hex');e.hash=C.entryHash(e.sequence,e.previousHash,e.payload);w.ledger.head.hash=e.hash; }
        if(attack==='chain-id')w.ledger.streams.viewing.chainId=randomUUID();
        if(attack==='tail-replay')fs.writeFileSync(path.join(w.state,'seal','tail.json'),oldTail);
        const before=structuredClone(w.ledger.entries);
        await assert.rejects(w.restart().seal.recoverAtStart(),e=>['UnsealedEntryUnexplained','SealChainMismatch','SealTailMismatch','LedgerChainBroken'].includes(e.code),attack);
        assert.deepEqual(w.ledger.entries,before,'refusal preserves DB evidence');
      } finally {w.cleanup();}
    }
    // Positive checkpoint recovery and an unrelated open request must coexist with stale-proof refusal.
    const w=await world();
    try {
      await w.store.append(authEvent(A)); await stageExpiry(w,1,at);
      // The unrelated transaction is admitted but has not acquired the head lock.
      // A reserved slot holds that lock until outcome, so another writer cannot
      // reuse it while the first transaction remains open.
      const open=authEvent(A);
      seedIntents(w.journal, [['viewing',randomUUID(),open.eventId,C.canonicalPayload(open).contentSha256,randomUUID()]]);
      const own=authEvent(A);assert.equal((await w.store.append(own)).eventId,own.eventId);
      assert(!w.journal.all().some(r=>r.kind==='commit-not-found'));
      await w.restart().seal.recoverAtStart();
      await stageExpiry(w,2,'2036-01-01T00:00:00.000Z'); await w.seal.advance('viewing',w.ledger.head);
      assert.equal((await w.restart().seal.recoverAtStart()).recovered,0);
    } finally {w.cleanup();}
  });

  async function stageExpiry(w,through,at) {
    const attemptId=randomUUID(),bundleId=randomUUID(),prefix=await w.seal.expiryPrefix(through);
    seedIntents(w.journal, [['viewing',attemptId,null,null,bundleId]]);w.ledger.checkpoint(through,at);
    const e=w.ledger.entries.at(-1);
    const binding=w.seal.reserve({stream:'viewing',chainId:w.ledger.chainId,attemptId,bundleId,kind:'expiry',eventId:null,
      sequence:e.sequence,previousHash:e.previousHash,hash:e.hash,contentSha256:e.contentSha256},prefix);
    w.ledger.markers.push(binding); return binding;
  }

  test('C14 a torn journal preserves its exact damaged bytes separately and remains appendable across repeated restarts', () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'emr-journal-r2-'));
    try {
      const first = new J.FailureJournal(state), body = { eventId: 'attempt', cause: 'business-rollback' };
      first.record('good-1', 'append-rolled-back', body);
      const file = path.join(state, 'journal', 'failure-journal.jsonl'), good = fs.readFileSync(file);
      const torn = Buffer.from('{"id":"incomplete"'); assert.equal(torn.length, 18);
      fs.appendFileSync(file, torn);
      const second = new J.FailureJournal(state);
      assert.equal(second.tornBytes, 18); assert.deepEqual(fs.readFileSync(file), good);
      const archives = fs.readdirSync(path.dirname(file)).filter(n => n.startsWith('torn-'));
      assert.equal(archives.length, 1); assert.deepEqual(fs.readFileSync(path.join(path.dirname(file), archives[0])), torn);
      second.record('good-2', 'append-rolled-back', body);
      const third = new J.FailureJournal(state);
      assert.equal(third.tornBytes, 0); third.record('good-3', 'append-rolled-back', body);
      assert.deepEqual(new J.FailureJournal(state).all().map(r => r.id), ['good-1', 'good-2', 'good-3']);
      // A coordinator that stayed alive imports another writer's records, keeps
      // idempotency/conflict semantics, and accounts for that writer's quarantine.
      assert.deepEqual(first.all().map(r => r.id), ['good-1', 'good-2', 'good-3']);
      assert.equal(first.record('good-2', 'append-rolled-back', body).id, 'good-2');
      code(() => first.record('good-2', 'append-rolled-back', { ...body, cause: 'ledger-refused' }), 'FailureJournalConflict');
      const archiveFile = path.join(path.dirname(file), 'torn-synthetic-quota.bin');
      const quotaFd = fs.openSync(archiveFile, 'wx');
      try { fs.ftruncateSync(quotaFd, J.JOURNAL_MAX_BYTES); } finally { fs.closeSync(quotaFd); }
      code(() => first.record('over-quota', 'append-rolled-back', body), 'FailureJournalFull');
      fs.unlinkSync(archiveFile); // exact owned synthetic quota fixture, before restart below
      // Interruption after archive publication but before truncation: the same archive is reused without data loss.
      fs.writeFileSync(file, Buffer.concat([good, torn]));
      assert.equal(new J.FailureJournal(state).tornBytes, 18);
      assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(n => n.startsWith('torn-')), archives);
      assert.deepEqual(fs.readFileSync(path.join(path.dirname(file), archives[0])), torn);
    } finally { fs.rmSync(state, { recursive: true, force: true }); }
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
  test('C20 replay binds sealed DB bytes through the external seal before issuing any receipt', async () => {
    for (const position of ['below', 'at']) for (const damage of ['hash', 'payload', 'content', 'link']) {
      const w = await world();
      try {
        const event = authEvent(A);
        await w.store.append(event);
        if (position === 'below') { await w.store.append(authEvent(A)); await w.store.append(authEvent(A)); }
        // The replay's new intent retires the first receipt's acknowledged binding.
        const row = w.ledger.entries[0];
        if (damage === 'hash') row.hash = 'f'.repeat(64);
        if (damage === 'link') row.previousHash = 'e'.repeat(64);
        if (damage === 'content') row.contentSha256 = 'd'.repeat(64);
        const tx = w.ledger.begin(), provisional = await w.store.appendInTransaction(tx, event);
        w.ledger.commit(tx);
        if (damage === 'payload') row.payload += ' ';
        const before = structuredClone(w.ledger.entries);
        await assert.rejects(w.store.confirm(provisional), e => ['LedgerChainBroken', 'SealTailMismatch', 'DurableReceiptRefused'].includes(e.code), `${position}/${damage}`);
        assert.deepEqual(w.ledger.entries, before, 'refusal preserves the evidence');
      } finally { w.cleanup(); }
    }
    // The other permitted A7 path is an exact, recently verified external binding.
    // Its late response does not need another available database connection.
    // A different seal instance can publish while the original COMMIT response
    // is delayed. Its exact attempt receipt remains sufficient during a DB outage.
    {
      const w = await world();
      try {
        const tx = w.ledger.begin(), provisional = await w.store.appendInTransaction(tx, authEvent(A));
        w.ledger.commit(tx);
        const helper = new S.AccessSeal(w.state, memorySql(w.ledger), w.journal);
        await helper.advance('viewing', w.ledger.head);
        w.ledger.down = true;
        const outcome = await Promise.allSettled([w.store.confirm(provisional)]);
        assert.equal(outcome[0].status, 'fulfilled', 'a helper-sealed original attempt needs no new DB read');
        assert(C.isDurableReceipt(outcome[0].value));
      } finally { w.cleanup(); }
    }
    const bound = await world();
    try {
      const tx = bound.ledger.begin(), provisional = await bound.store.appendInTransaction(tx, authEvent(A));
      bound.ledger.commit(tx); await bound.store.confirm(provisional); bound.ledger.down = true;
      assert(C.isDurableReceipt(await bound.store.confirm(provisional)), 'recent exact external binding has no new DB dependency');
    } finally { bound.cleanup(); }
    const w = await world();
    try {
      const event = authEvent(A); await w.store.append(event); await w.store.append(authEvent(A));
      const receipt = await w.store.append(event);
      assert(C.isDurableReceipt(receipt)); assert.equal(receipt.eventId, event.eventId);
      assert.equal(w.ledger.entries.length, 2, 'untampered replay remains idempotent');
    } finally { w.cleanup(); }
  });

  // D889 publication batching -> RISK-EMR-RECEIPT-DELAY / CRASH -> C21.
  test('C21 adjacent stream advances share durability barriers and recover together after each publication cut', async () => {
    // D935 merged intent/reservation: no COMMIT without this one durable record.
    // Crash recovery uses the record's exact attempt and position, including when
    // SQL staging succeeded but reservation durability failed.
    for (const failedSync of [false, true]) {
      const w = await world(), original = fs.fdatasyncSync, event = authEvent(A);
      let syncs = 0;
      try {
        const tx = w.ledger.begin();
        fs.fdatasyncSync = function (...args) {
          syncs++;
          if (failedSync) throw Object.assign(new Error('reservation durability failure'), { code: 'EIO' });
          return original.apply(this, args);
        };
        const outcome = await Promise.allSettled([w.store.appendInTransaction(tx, event)]);
        fs.fdatasyncSync = original;
        assert.equal(syncs, 1, 'intent and exact reservation require one durability barrier');
        assert.equal(w.ledger.entries.length, 0, 'staging is never a committed event');
        if (failedSync) assert.equal(outcome[0].status, 'rejected', 'no callback success before the merged record is durable');
        else {
          assert.equal(outcome[0].status, 'fulfilled');
          const state = w.restart().journal.coordinator.call('read');
          const q = state.slots['viewing:1'], intent = state.intents['viewing:' + q.attemptId];
          assert(intent, 'the reservation and intent are durably recovered together');
          assert.equal(intent.eventId, event.eventId);
          assert.equal(intent.contentSha256, q.contentSha256);
          assert.equal(intent.bundleId, q.bundleId);
          assert(q.generation > 0);
        }
        const restarted = w.restart(); await restarted.seal.recoverAtStart();
        assert.equal(Object.keys(restarted.journal.coordinator.call('read').intents).length, 0);
        assert.equal(restarted.seal.read().streams.viewing.sequence, 0);
        assert(C.isDurableReceipt(await restarted.store.append(event)), 'a crash before COMMIT permits same-event retry');
      } finally { fs.fdatasyncSync = original; w.cleanup(); }
    }
    for (const cut of [0, 1, 2, 3]) {
      const w = await world(), original = fs.fdatasyncSync;
      try {
        const tx = w.ledger.begin();
        const provisional = await w.store.appendInTransaction(tx, changeEvent()); w.ledger.commit(tx);
        let syncs = 0;
        fs.fdatasyncSync = function (...args) {
          if (++syncs === cut) throw Object.assign(new Error('synthetic publication crash'), { code: 'EIO' });
          return original.apply(this, args);
        };
        const results = await Promise.allSettled([w.store.confirm(provisional)]);
        fs.fdatasyncSync = original;
        if (cut) assert(results.every(r => r.status === 'rejected'), 'no half-published group succeeds');
        else {
          assert(results.every(r => r.status === 'fulfilled'));
          assert(C.isDurableReceipt(results[0].value), 'the actual two-stream store path issues the bound receipt');
          assert.equal(syncs, 3, 'two adjacent streams share one three-barrier publication');
        }
        const recovered = w.restart(); await recovered.seal.recoverAtStart();
        for (const s of A.ACCESS_STREAMS) assert.equal(recovered.seal.read().streams[s].hash, w.ledger.streams[s].head.hash);
      } finally { fs.fdatasyncSync = original; w.cleanup(); }
    }
  });

  test('C19 committed receipt groups preserve every binding, ignore unrelated pending work and share durable publication; publication failure sends no receipt', async () => {
    for (const fail of [false, true]) {
      const w = await world();
      try {
        const provisional = [];
        for (let n = 0; n < 48; n++) {
          const tx = w.ledger.begin(), made = await w.store.appendInTransaction(tx, authEvent(A));
          w.ledger.commit(tx); provisional.push(made);
        }
        const unrelated = randomUUID();
        seedIntents(w.journal, [['viewing', unrelated, randomUUID(), 'a'.repeat(64), randomUUID()]]);
        const originalSync = fs.fsyncSync, originalDataSync = fs.fdatasyncSync;
        let syncs = 0;
        fs.fsyncSync = function (...args) { syncs++; if (fail) throw Object.assign(new Error('synthetic unavailable disk'), { code: 'EIO' }); return originalSync.apply(this, args); };
        fs.fdatasyncSync = function (...args) { syncs++; if (fail) throw Object.assign(new Error('synthetic unavailable disk'), { code: 'EIO' }); return originalDataSync.apply(this, args); };
        let results;
        try { results = await Promise.allSettled(provisional.map(p => w.store.confirm(p))); }
        finally { fs.fsyncSync = originalSync; fs.fdatasyncSync = originalDataSync; }
        if (fail) {
          assert(results.every(r => r.status === 'rejected'), 'no receipt from an undurable group');
          const restarted = w.restart();
          await restarted.seal.recoverAtStart();
          assert.equal(restarted.seal.read().streams.viewing.sequence, 48);
        } else {
          assert(results.every(r => r.status === 'fulfilled'), 'all committed viewers progress');
          for (let n = 0; n < 48; n++) {
            assert.equal(results[n].value.eventId, provisional[n].eventId);
            assert(C.isDurableReceipt(results[n].value));
          }
          assert.equal(w.seal.read().streams.viewing.sequence, 48);
          assert(w.journal.coordinator.call('read').intents['viewing:' + unrelated], 'unrelated intent is preserved');
          assert(syncs <= 16, `receipt group disk latency budget: ${syncs} fsyncs for 48 committed viewers`);
        }
      } finally { w.cleanup(); }
    }

    for (const boundary of ['checkpoint-rename', 'log-truncate']) {
      const w = await world(), rename = fs.renameSync, open = fs.openSync;
      const ids = Array.from({ length: 20000 }, (_, n) => 'pending-' + n);
      let cut = false;
      fs.renameSync = (from, to) => {
        if (boundary === 'checkpoint-rename' && to === path.join(w.state, 'seal', 'settlement.json')) {
          cut = true; throw Object.assign(new Error('compaction crash'), { code: 'EIO' });
        }
        return rename(from, to);
      };
      fs.openSync = (file, flags, ...args) => {
        if (boundary === 'log-truncate' && file === path.join(w.state, 'seal', 'settlement.jsonl') && flags === 'w') {
          cut = true; throw Object.assign(new Error('compaction crash'), { code: 'EIO' });
        }
        return open(file, flags, ...args);
      };
      try {
        seedIntents(w.journal, ids.map(id => ['viewing', id, id, 'a'.repeat(64), randomUUID()]));
        const results = await Promise.allSettled([w.store.append(authEvent(A))]);
        assert(cut, 'publication compacts the large valid WAL at ' + boundary);
        assert(results.every(r => r.status === 'rejected'));
      } finally { fs.renameSync = rename; fs.openSync = open; }
      try {
        const restored = w.restart().journal.coordinator.call('read');
        assert.deepEqual(Object.keys(restored.intents).sort(), ids.map(id => 'viewing:' + id).sort(), 'every durable intent survives compaction interruption');
      } finally { w.cleanup(); }
    }
  });

  test('C22 bounded lanes keep two verification connections free across small pools and shared stores', async () => {
    const { appendLaneCount, appendPoolConfiguration } = load('emr-runtime/admission.ts');
    for (const value of [0, 1, 2, -1, 4.5, NaN]) assert.throws(() => appendLaneCount(value));
    for (const value of ['0', '2', '-1', '4.5', 'bad'])
      assert.throws(() => appendPoolConfiguration('postgresql://synthetic.invalid/db?connection_limit=' + value));
    for (const poolSize of [3, 4, 5, 6, 9]) {
    const capacity = Math.min(4, poolSize - 2);
    assert.equal(appendLaneCount(poolSize), capacity);
    const configured = appendPoolConfiguration('postgresql://synthetic.invalid/db?connection_limit=' + poolSize);
    assert.equal(Number(new URL(configured.url).searchParams.get('connection_limit')), poolSize);
    assert.equal(configured.poolSize, poolSize);
    // Deterministic adverse schedule: after the first COMMIT, the next writer is
    // paused until its predecessor receives a receipt. Extra head-lock waiters
    // must remain outside the connection pool. A saturated verification request
    // exhausts its virtual acquisition deadline; no wall-clock sleep is used.
    const w = await world(), raw = memorySql(w.ledger);
    let slots = poolSize, txId = 0, head = Promise.resolve(), resume, peakPoolUse = 0, peakPoolQueue = 0;
    const paused = new Promise(resolve => { resume = resolve; }), queue = [];
    const acquire = () => {
      if (slots) { slots--; peakPoolUse = Math.max(peakPoolUse, poolSize - slots); return Promise.resolve(); }
      return new Promise(resolve => { queue.push(resolve); peakPoolQueue = Math.max(peakPoolQueue, queue.length); });
    };
    const release = () => { const next = queue.shift(); if (next) next(); else slots++; };
    const query = async work => {
      await new Promise(resolve => setImmediate(resolve));
      if (!slots) throw Object.assign(new Error('verification connection deadline exhausted'), { code: 'P2028' });
      await acquire(); try { return await work(); } finally { release(); }
    };
    const pool = { $transaction: async work => {
      await acquire(); const id = ++txId, before = head; let unlock;
      head = new Promise(resolve => { unlock = resolve; });
      await before;
      try {
        if (id > 1) await paused;
        const tx = w.ledger.begin(), value = await work(tx); w.ledger.commit(tx); return value;
      } finally { unlock(); release(); }
    } };
    const sql = { ...raw, verificationPage: (...args) => query(() => raw.verificationPage(...args)),
      entryForEvent: (...args) => query(() => raw.entryForEvent(...args)),
      snapshot: work => query(() => work(raw)) };
    w.store.db = pool; w.store.sql = sql; w.seal.sql = sql; w.store.poolSize = poolSize;
    const sibling = new MemoryStore(w.ledger, w.seal, w.journal);
    sibling.db = pool; sibling.sql = sql; sibling.poolSize = poolSize;
    try {
      const first = w.store.append(authEvent(A)).finally(resume);
      const rest = Array.from({ length: 23 }, (_, i) => (i % 2 ? sibling : w.store).append(authEvent(A)));
      const results = await Promise.allSettled([first, ...rest]);
      console.info('EMR_POOL_ADMISSION ' + JSON.stringify({ pool: poolSize, lanes: capacity, concurrent: 24,
        receipts: results.filter(r => r.status === 'fulfilled').length,
        errors: results.filter(r => r.status === 'rejected').map(r => errorCode(r.reason)), peakPoolUse, peakPoolQueue }));
      assert.deepEqual(results.filter(r => r.status === 'rejected').map(r => errorCode(r.reason)), [], 'every committed request receives its receipt');
      assert.equal(w.ledger.entries.length, 24);
      assert.equal(w.seal.read().streams.viewing.sequence, 24);
      assert.equal(peakPoolQueue, 0, 'head-lock waiters never enter the pool queue');
      assert(peakPoolUse <= capacity + 1, 'two connections remain available before verification');
      assert(peakPoolUse >= capacity, 'all permitted append lanes can enter');
      const probe = require('./throughput.cjs').instrument(pool, w.store, w.seal);
      try {
        const traced = await Promise.all(Array.from({ length: 24 }, () => probe.run(authEvent(A))));
        assert(traced.every(row => row.receipt), 'instrumented requests preserve receipt behaviour');
        for (const row of traced) {
          assert.equal(row.transactions.length, 1, 'request owns only its append transaction');
          assert.equal(row.drain_groups.length, 1, 'a resolved member is not charged to the next drain group');
          assert(probe.drains.find(group => group.id === row.drain_groups[0]).eventIds.includes(row.eventId));
        }
      } finally { probe.restore(); }
    } finally { resume(); w.cleanup(); }
    }
  });

  test('C23 a cold replay beyond the named verification cap refuses before acquiring a snapshot', async () => {
    const w = await world(), { EMR_REPLAY_VERIFY_ROWS } = load('emr-runtime/limits.ts');
    try {
      const event = authEvent(A); await w.store.append(event);
      const originalHash = w.ledger.entries[0].hash;
      // A legitimate long retained chain, installed through startup verification.
      for (let i = 0; i < EMR_REPLAY_VERIFY_ROWS; i++) {
        const tx = w.ledger.begin(), e = authEvent(A), p = C.canonicalPayload(e);
        w.ledger.append(tx, 'viewing', e.eventId, p.text, 'none'); w.ledger.commit(tx);
      }
      w.journal.coordinator.call('update', state => {
        state.tail.streams.viewing = { chainId: w.ledger.chainId, ...w.ledger.head };
        state.terminal = {}; state.generation++; state.tail.generation = state.generation;
      });
      let snapshots = 0;
      const sql = memorySql(w.ledger), original = sql.snapshot;
      sql.snapshot = work => { snapshots++; return original(work); };
      const seal = new S.AccessSeal(w.state, sql, w.journal);
      await assert.rejects(seal.advance('viewing', {sequence: 1, hash: originalHash}),
        error => error.code === 'SealUnavailable' && error.detail === 'replay-verification-limit');
      assert.equal(snapshots, 0, 'far replay cannot occupy a pool slot');
    } finally { w.cleanup(); }
  });

  // ════════════════ EMR-B2-BASE: the startup owner, the fatal line and the request facts (C24-C35) ════════════════
  // C24-C29 run the real main.ts in child processes (tests/emr/b/startup_fixture.cjs): the database clients are the
  // fixture's (no PostgreSQL here; tests/emr/b/startup_pg_test.cjs runs the same starts over a disposable database), the
  // writer fence, failure journal, seal and recovery are the product's (Linux). Assertions read exit codes, the stderr
  // line's closed phase/code, the order of observed product calls and HTTP answers - never product text beyond that.
  const startup = require('./startup_fixture.cjs');
  const http = require('node:http');
  const request = (port, pathname) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathname }, res => {
      let body = ''; res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
  const LINE = /^\[KIN API\] 기동 실패\(([a-z]+)(?:\/([A-Za-z0-9]+))?\): [^\n]+\. 기동을 중단합니다\.$/;
  const SECRETS = ['Leaked', 'Secret', 'SELECT', 'postgresql://', 'synthetic-', 'not-the-runtime-role', 'rolsuper', '[Nest]', '    at '];
  /** A refused start: nonzero exit, one closed line (phase, mapped code or none), no secret, no listener unless asked. */
  function refused(result, phase, code = null, { listened = false, initialized = false } = {}) {
    assert.equal(result.timedOut, false, 'the process ended by itself');
    assert.deepEqual([result.code, result.signal], [1, null], result.stderr);
    assert.equal(result.stderrLines.length, 1, result.stderr);
    const match = LINE.exec(result.stderrLines[0]);
    assert(match, result.stderrLines[0]);
    assert.deepEqual([match[1], match[2] ?? null], [phase, code]);
    for (const secret of SECRETS) assert(!(result.stdout + result.stderr).includes(secret), secret);
    assert(!result.stdout.includes('Nest application successfully started'), 'buffered logs stay unflushed');
    assert.equal(result.names.includes('bind'), listened, 'listener');
    assert.equal(result.names.includes('auth-init'), initialized, 'init hooks and their timers');
  }
  /** The first index of each name, all present and in this order. */
  function inOrder(names, expected) {
    const at = expected.map(name => names.indexOf(name));
    assert(at.every(index => index >= 0), JSON.stringify({ missing: expected.filter((_, n) => at[n] < 0), names }));
    assert.deepEqual([...at].sort((a, b) => a - b), at, JSON.stringify(names));
  }
  const count = (names, name) => names.filter(item => item === name).length;
  const env = (state, overrides) => startup.environment(state, overrides);
  let productProgram;
  /** The product's TypeScript program (api/src) with its checker, built once for the static parts of C26 and C35. */
  function product() {
    if (!productProgram) productProgram = ts.createProgram(parsed.fileNames, parsed.options);
    const checker = productProgram.getTypeChecker();
    const resolve = symbol => (symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
    const rel = file => path.relative(root, file.fileName).replaceAll('\\', '/');
    const sources = productProgram.getSourceFiles().filter(file => parsed.fileNames.includes(file.fileName));
    const exported = (suffix, name) => resolve(checker.getExportsOfModule(checker.getSymbolAtLocation(sources.find(file => rel(file) === suffix)))
      .find(symbol => symbol.name === name));
    const ownerOf = node => {
      let at = node.parent;
      while (at && !ts.isFunctionLike(at)) at = at.parent;
      if (!at) return 'module scope';
      const owner = at.parent && ts.isClassLike(at.parent) && at.parent.name ? at.parent.name.text + '.' : '';
      return owner + (ts.isConstructorDeclaration(at) ? 'constructor' : at.name && ts.isIdentifier(at.name) ? at.name.text : 'a function expression');
    };
    return { checker, resolve, rel, sources, exported, ownerOf };
  }
  /** Where product code outside B1's own modules creates the ledger's parts or runs start-up recovery. */
  function productConstructions() {
    const { checker, resolve, rel, sources, exported, ownerOf } = product();
    const classes = new Map([['EmrLedgerClient', 'client.ts'], ['StateCoordinator', 'coordinator.ts'], ['FailureJournal', 'failure-journal.ts'],
      ['AccessSeal', 'seal.ts'], ['PrismaLedgerSql', 'store.ts'], ['AccessLedgerStore', 'store.ts']]
      .map(([name, file]) => [exported('api/src/emr-runtime/' + file, name), name]));
    const recover = checker.getPropertyOfType(checker.getDeclaredTypeOfSymbol(exported('api/src/emr-runtime/seal.ts', 'AccessSeal')), 'recoverAtStart');
    const found = [];
    for (const file of sources.filter(file => !rel(file).startsWith('api/src/emr-runtime/') || /\/(application|request-context)\.ts$/.test(rel(file)))) {
      const visit = node => {
        if (ts.isNewExpression(node)) {
          const name = classes.get(resolve(checker.getSymbolAtLocation(node.expression)));
          if (name) found.push(`${name} ${rel(file)} ${ownerOf(node)}`);
        }
        if (ts.isPropertyAccessExpression(node) && resolve(checker.getSymbolAtLocation(node.name)) === recover) found.push(`recoverAtStart ${rel(file)} ${ownerOf(node)}`);
        ts.forEachChild(node, visit);
      };
      visit(file);
    }
    return found.sort();
  }
  /** A start that reaches its listener: `after(event, child)` acts on the events; the case ends the process. */
  const listening = (scenario, environment, after) => startup.run(scenario, { env: environment, timeoutMs: 60000,
    onEvent: async (event, child, events) => { if (await after(event, child, events)) child.kill('SIGTERM'); } });

  test('C24 base start-up order: the owner starts once after the module graph and before every init hook and the listener; A is composed once with B readers', async () => {
    const state = startup.stateDirectory('c24');
    const seen = {};
    const result = await listening({ db: 'memory' }, env(state), async (event, child) => {
      if (event.what === 'listening') {
        seen.health = await request(event.port, '/api/health');
        seen.me = await request(event.port, '/api/me');
        child.send('modules');
      }
      if (event.what === 'modules') { seen.modules = event.clinical; return true; }
      return false;
    });
    try {
      inOrder(result.names, ['created', 'start', 'client', 'connect', 'fence', 'ledger', 'recovery', 'recovered', 'compose', 'ready',
        'init', 'auth-init', 'initialized', 'bind', 'listening']);
      for (const name of ['start', 'client', 'connect', 'fence', 'recovery', 'compose', 'ready', 'init', 'bind']) assert.equal(count(result.names, name), 1, name);
      assert.deepEqual(result.events.find(e => e.what === 'start').base, true, 'main asks for the base plan');
      const composed = result.events.find(e => e.what === 'compose');
      assert.deepEqual([composed.base, composed.clinical], [true, false], 'A binds B readers in base mode');
      assert(!result.names.some(name => name.startsWith('clinical-')), 'no clinical factory runs in base mode');
      assert.deepEqual(seen.modules, [], 'base mode loads no clinical or signature module');
      assert.equal(result.events.find(e => e.what === 'fence').owner, true);
      assert.equal(seen.health.status, 200);
      assert.equal(JSON.parse(seen.health.body).ok, true);
      assert.equal(seen.me.status, 401);
      for (const answer of [seen.health, seen.me]) assert.equal(answer.headers['cache-control'], 'no-store', 'the API no-store default stays');
      // Nest's buffered start-up logs appear only once the server listens.
      assert(result.stdout.includes('Nest application successfully started'));
      assert.deepEqual([result.signal, result.timedOut], ['SIGTERM', false]);
    } finally { fs.rmSync(state, { recursive: true, force: true }); }
  });

  test('C25 clinical start-up order with a test factory: prepared readers bind A once, then compose, readiness and start once; a missing or failing part stops the process', async () => {
    const state = startup.stateDirectory('c25');
    let readers = null;
    const ok = await listening({ db: 'memory', clinical: 'ok' }, env(state), async (event, child) => {
      if (event.what === 'listening') child.send('readers');
      if (event.what === 'readers') { readers = event.clinical; return true; }
      return false;
    });
    try {
      inOrder(ok.names, ['created', 'start', 'connect', 'fence', 'recovered', 'clinical-prepare', 'compose', 'clinical-compose', 'clinical-check',
        'clinical-start', 'ready', 'init', 'auth-init', 'bind', 'listening']);
      for (const name of ['clinical-prepare', 'compose', 'clinical-compose', 'clinical-check', 'clinical-start']) assert.equal(count(ok.names, name), 1, name);
      const prepare = ok.events.find(e => e.what === 'clinical-prepare');
      assert.deepEqual([prepare.frozen, prepare.base, prepare.sameClient, prepare.sameLedger], [true, true, true, true], 'the factory gets the frozen started resources');
      const composed = ok.events.find(e => e.what === 'compose');
      assert.deepEqual([composed.base, composed.clinical], [false, true], 'A binds the prepared readers, never B first');
      assert.equal(readers, true, "A's composed clinical reader is the prepared one");
      // Shutdown: background stop before the HTTP server closes; dispose, then the client, after it closed.
      inOrder(ok.names, ['listening', 'runtime-beforeApplicationShutdown', 'clinical-stop', 'server-close', 'server-closed', 'clinical-dispose', 'disconnect']);
      for (const name of ['clinical-stop', 'clinical-dispose', 'disconnect']) assert.equal(count(ok.names, name), 1, name);
    } finally { fs.rmSync(state, { recursive: true, force: true }); }
    for (const [kind, code, expect] of [
      ['no-factory', 'EmrClinicalFactoryRequired', { compose: 0, dispose: 0, client: 0 }],
      ['prepare-reject', 'P1001', { compose: 0, dispose: 0, client: 1 }],
      ['prepared-invalid', 'EmrClinicalPreparedInvalid', { compose: 0, dispose: 1, client: 1 }],
      ['check-reject', 'P1001', { compose: 1, dispose: 1, client: 1, stop: 0 }],
      ['start-throw', 'P1001', { compose: 1, dispose: 1, client: 1, stop: 1 }],
    ]) {
      const dir = startup.stateDirectory('c25-' + kind);
      try {
        const result = await startup.run({ db: 'memory', clinical: kind }, { env: env(dir), timeoutMs: 60000 });
        refused(result, 'clinical', code);
        assert(!result.names.includes('ready'), kind + ': never ready');
        assert.equal(count(result.names, 'compose'), expect.compose, kind + ': A composition');
        assert.equal(count(result.names, 'clinical-dispose'), expect.dispose, kind + ': dispose of what the factory returned');
        assert.equal(count(result.names, 'client'), expect.client, kind + ': client');
        assert.equal(count(result.names, 'disconnect'), expect.client, kind + ': its one disconnect');
        if ('stop' in expect) assert.equal(count(result.names, 'clinical-stop'), expect.stop, kind + ': stop only of a started lifecycle');
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
  });

  test('C26 one dedicated client, journal, seal, store and recovery per process with the store pool equal to the client pool; a second process on the same state is refused before any recovery', async () => {
    const state = startup.stateDirectory('c26');
    let resources = null, second = null;
    const first = await listening({ db: 'memory' }, env(state, { DATABASE_URL: 'postgresql://kin_runtime:Synthetic-Fixture-Secret-0001@127.0.0.1:1/kin?connection_limit=7' }),
      async (event, child) => {
        if (event.what === 'listening') {
          second = await startup.run({ db: 'memory' }, { env: env(state), timeoutMs: 60000 });
          child.send('resources');
        }
        if (event.what === 'resources') { resources = event; return true; }
        return false;
      });
    try {
      const { at: _, what: __, ...facts } = resources;
      assert.deepEqual(facts, { same: true, frozen: true, keys: ['adapters', 'db', 'ledger'], client: true, clients: 1, ledger: true, stores: 1,
        base: true, ordinarySeparate: true, poolSize: 7 });
      const client = first.events.find(e => e.what === 'client'), ledger = first.events.find(e => e.what === 'ledger');
      assert.deepEqual([client.poolSize, client.connectionLimit, ledger.poolSize, ledger.sameClient], [7, 7, 7, true]);
      for (const name of ['client', 'fence', 'ledger', 'recovery']) assert.equal(count(first.names, name), 1, name);
      // G-4: the second API process on the same state directory is a client of the first one's fence; it stops before recovery.
      refused(second, 'fence', 'EmrStateOwnerBusy');
      assert.equal(second.events.find(e => e.what === 'fence').owner, false);
      assert(!second.names.includes('recovery') && !second.names.includes('ledger'), 'no second recovery beside a live owner');
      assert.equal(count(second.names, 'disconnect'), 1);
    } finally { fs.rmSync(state, { recursive: true, force: true }); }
    // Without connection_limit the client gets the append pool, and the store the same capacity.
    const plain = startup.stateDirectory('c26-pool');
    try {
      const result = await listening({ db: 'memory' }, env(plain), async event => event.what === 'listening');
      const client = result.events.find(e => e.what === 'client'), ledger = result.events.find(e => e.what === 'ledger');
      assert.deepEqual([client.poolSize, client.connectionLimit, ledger.poolSize], [6, 6, 6]);
    } finally { fs.rmSync(plain, { recursive: true, force: true }); }
    // No other product code creates a client, fence, journal, seal or store, or runs recovery (installed TypeScript checker).
    const owners = productConstructions();
    assert.deepEqual(owners, ['AccessLedgerStore', 'AccessSeal', 'EmrLedgerClient', 'FailureJournal', 'PrismaLedgerSql', 'StateCoordinator', 'recoverAtStart']
      .map(name => `${name} api/src/emr-runtime/application.ts EmrApplicationRuntime.start`));
  });

  test('C27 shutdown keeps the HTTP drain, then stops background work, ends in-flight requests, disposes and disconnects once; a failed start releases only what it created, within 5 s, and deletes no state', async () => {
    const state = startup.stateDirectory('c27');
    let slow = null;
    const result = await startup.run({ db: 'memory', slowMillis: 1500 }, { env: env(state), timeoutMs: 60000, onEvent: (event, child) => {
      if (event.what === 'listening') slow = request(event.port, '/syn-slow');
      if (event.what === 'slow-begin') child.kill('SIGTERM');
    } });
    try {
      const answer = await slow;
      assert.deepEqual([answer.status, answer.body], [200, 'slow-ok'], 'the in-flight request finished');
      inOrder(result.names, ['slow-begin', 'runtime-beforeApplicationShutdown', 'server-close', 'slow-done', 'server-closed',
        'runtime-onApplicationShutdown', 'disconnect']);
      assert.equal(count(result.names, 'disconnect'), 1);
      assert(result.names.indexOf('prisma-shutdown') > result.names.indexOf('server-closed'));
      assert.deepEqual([result.signal, result.timedOut], ['SIGTERM', false], 'SIGTERM ends it without SIGKILL');
      for (const kept of ['writer.lock', 'seal', 'owners']) assert(fs.existsSync(path.join(state, kept)), kept + ' stays');
    } finally { fs.rmSync(state, { recursive: true, force: true }); }
    // A failed recovery: the client created and connected is disconnected once; the fence and journal stay on disk.
    const failed = startup.stateDirectory('c27-failed');
    try {
      const result = await startup.run({ db: 'memory', recovery: 'refuse' }, { env: env(failed), timeoutMs: 60000 });
      refused(result, 'recovery', 'SealCorrupt');
      inOrder(result.names, ['start-failed', 'runtime-onApplicationShutdown', 'disconnect']);
      assert.equal(count(result.names, 'disconnect'), 1, 'released once although app.close and main both finish the owner');
      for (const kept of ['writer.lock', 'seal', 'owners']) assert(fs.existsSync(path.join(failed, kept)), kept + ' stays');
    } finally { fs.rmSync(failed, { recursive: true, force: true }); }
    // A cleanup that never ends is cut at 5 s; one that throws is silent: neither adds a line or hides the first one.
    for (const disconnect of ['hang', 'throw']) {
      const dir = startup.stateDirectory('c27-' + disconnect);
      try {
        const result = await startup.run({ db: 'memory', connect: 'refuse', disconnect }, { env: env(dir), timeoutMs: 60000 });
        refused(result, 'connect', 'P1001');
        if (disconnect === 'hang') assert(result.millisAfterStderr >= 4500 && result.millisAfterStderr < 8000, String(result.millisAfterStderr));
        else assert(result.millisAfterStderr < 4500, String(result.millisAfterStderr));
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
  });

  test('C28 every start-up phase that fails ends the process with one closed line and no listener, timer, buffered log or secret', async () => {
    const occupied = http.createServer(() => {});
    await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
    const exposed = startup.stateDirectory('c28-exposed');
    fs.chmodSync(exposed, 0o755);
    const url = 'postgresql://kin_runtime:Synthetic-Fixture-Secret-0001@127.0.0.1:1/kin';
    try {
      for (const [name, scenario, overrides, phase, code, extra] of [
        ['create', { db: 'memory', create: 'fail' }, {}, 'create', null],
        ['no proxy', { db: 'memory' }, { KIN_EMR_PROXY_HOST: undefined }, 'config', 'EmrProxyHostRequired'],
        ['loopback proxy', { db: 'memory' }, { KIN_EMR_PROXY_HOST: '127.0.0.1' }, 'config', 'EmrProxyHostInvalid'],
        ['proxy range', { db: 'memory' }, { KIN_EMR_PROXY_HOST: '10.0.0.0/8' }, 'config', 'EmrProxyHostInvalid'],
        ['no database URL', { db: 'memory' }, { DATABASE_URL: undefined }, 'config', 'EmrDatabaseUrlRequired'],
        ['another database', { db: 'memory' }, { DATABASE_URL: 'mysql://kin_runtime:Synthetic-Fixture-Secret-0001@db/kin' }, 'config', 'EmrDatabaseUrlRequired'],
        ['small pool', { db: 'memory' }, { DATABASE_URL: url + '?connection_limit=2' }, 'config', 'EmrAppendPoolTooSmall'],
        ['relative state', { db: 'memory' }, { KIN_EMR_STATE_DIR: 'kin-emr' }, 'config', 'EmrStateDirectoryRequired'],
        ['unreachable database', { db: 'pg' }, { DATABASE_URL: url + '?connect_timeout=2' }, 'connect', 'P1001'],
        ['connect error text', { db: 'memory', connect: 'refuse', leakCode: 'Leaked\nCode' }, {}, 'connect', null],
        ['runtime role', { db: 'memory', role: 'refused' }, {}, 'role', 'EmrRuntimeRefused'],
        ['missing state', { db: 'memory' }, { KIN_EMR_STATE_DIR: path.join(os.tmpdir(), 'emr-b2-absent-' + randomUUID()) }, 'fence', 'EmrStateDirectoryRequired'],
        ['exposed state', { db: 'memory' }, { KIN_EMR_STATE_DIR: exposed }, 'fence', 'EmrStateDirectoryExposed'],
        ['seal recovery', { db: 'memory', recovery: 'refuse' }, {}, 'recovery', 'SealCorrupt'],
        ['second composition', { db: 'memory', precompose: true }, {}, 'compose', 'EmrAdaptersAlreadyComposed'],
        ['clinical factory', { db: 'memory', clinical: 'no-factory' }, {}, 'clinical', 'EmrClinicalFactoryRequired'],
        ['init hook', { db: 'memory', init: 'fail', leakCode: 'Leaked\nCode' }, {}, 'init', null, { initialized: true }],
        ['listen', { db: 'memory', port: occupied.address().port }, {}, 'listen', 'EADDRINUSE', { listened: true, initialized: true }],
      ]) {
        const dir = startup.stateDirectory('c28');
        try {
          const result = await startup.run(scenario, { env: env(dir, overrides), timeoutMs: 60000 });
          try { refused(result, phase, code, extra); } catch (error) { error.message = `${name}: ${error.message}`; throw error; }
          if (['config', 'create'].includes(phase)) assert(!result.names.includes('client'), name + ': nothing connects');
          if (!['config', 'create'].includes(phase) && scenario.db === 'memory') assert.equal(count(result.names, 'disconnect'), 1, name);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
      }
    } finally {
      occupied.close();
      fs.rmSync(exposed, { recursive: true, force: true });
    }
  });

  test('C29 the start is locked before its first await: a concurrent, repeated, post-failure or post-shutdown start is refused and nothing is composed or recovered twice', async () => {
    require(path.join(api, 'node_modules/reflect-metadata'));
    const { EmrApplicationRuntime, EmrStartupFailure } = load('emr-runtime/application.ts');
    const dir = startup.stateDirectory('c29');
    const saved = {}, values = { DATABASE_URL: 'postgresql://kin_runtime:Synthetic-Fixture-Secret-0001@127.0.0.1:1/kin?connect_timeout=1',
      KIN_EMR_STATE_DIR: dir, KIN_EMR_PROXY_HOST: 'proxy', DEPLOYMENT_MODE: undefined };
    for (const [key, value] of Object.entries(values)) { saved[key] = process.env[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    try {
      const runtime = new EmrApplicationRuntime();
      code(() => runtime.requireResources(), 'EmrRuntimeNotReady');
      let settled = false;
      // The first start's outcome is held at once, so its failure is an observed value, never an unhandled rejection.
      const first = runtime.start({ mode: 'base' }).then(() => 'started', error => error).finally(() => { settled = true; });
      await rejects(runtime.start({ mode: 'base' }), 'EmrStartupRepeated');
      assert.equal(settled, false, 'refused while the first start is still preparing');
      const failure = await first;
      assert.ok(failure instanceof EmrStartupFailure && failure.phase === 'connect', String(failure?.phase ?? failure));
      await rejects(runtime.start({ mode: 'base' }), 'EmrStartupRepeated');
      code(() => runtime.requireResources(), 'EmrRuntimeNotReady');
      await runtime.onApplicationShutdown();
      await rejects(runtime.start({ mode: 'base' }), 'EmrStartupRepeated');
    } finally {
      for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
    // After ready and after shutdown in the real process: refused, the same resources, one composition and one recovery.
    let ready = null, stopped = null;
    try {
      const result = await startup.run({ db: 'memory' }, { env: env(dir), timeoutMs: 60000, onEvent: (event, child) => {
        if (event.what === 'listening') child.send('reenter');
        if (event.what === 'reenter-ready') ready = event;
        if (event.what === 'reenter-stopped') stopped = event;
      } });
      assert.deepEqual([ready.again, ready.same], ['EmrStartupRepeated', true]);
      assert.deepEqual([stopped.resources, stopped.again], ['EmrRuntimeNotReady', 'EmrStartupRepeated']);
      for (const name of ['compose', 'recovery', 'client', 'disconnect']) assert.equal(count(result.names, name), 1, name);
      assert.equal(result.code, 0);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  // ── C30-C35: verified request facts over the real AuthGuard and AuthService (a real HTTP server on loopback, signed
  // RS256 tokens of a fixture key, an in-memory session/rights store and a fixture ledger that resolves identities) ──
  const ISSUER = 'https://identity.example.test/realms/kin';
  let authWorld = null;
  require('node:test').after(() => { if (authWorld) authWorld.close(); });
  async function authHarness() {
    if (authWorld) return authWorld;
    require(path.join(api, 'node_modules/reflect-metadata'));
    const jose = require(path.join(api, 'node_modules/jose'));
    const { Controller, Get, Post, SetMetadata } = require(path.join(api, 'node_modules/@nestjs/common'));
    const { Reflector } = require(path.join(api, 'node_modules/@nestjs/core'));
    const { ExecutionContextHost } = require(path.join(api, 'node_modules/@nestjs/core/helpers/execution-context-host'));
    const key = await jose.generateKeyPair('RS256'), stranger = await jose.generateKeyPair('RS256');
    const jwk = { ...(await jose.exportJWK(key.publicKey)), kid: 'syn-key', alg: 'RS256', use: 'sig' };
    const jwks = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })); });
    await new Promise(resolve => jwks.listen(0, '127.0.0.1', resolve));
    Object.assign(process.env, { AUTH_REQUIRED: 'true', KC_ISSUER: ISSUER, KC_JWKS_URL: `http://127.0.0.1:${jwks.address().port}/certs`,
      KC_AUDIENCE: 'kin-api', KC_WEB_SECRET: 'synthetic-web-secret', KIN_COOKIE_SECRET: 'synthetic-cookie-secret', PUBLIC_ORIGIN: 'https://pacs.example.test' });
    const { AuthService } = load('auth.service.ts'), { AuthGuard } = load('auth.guard.ts');
    const store = { rights: new Map(), sessions: new Map(), importReady: true, down: false, calls: [] };
    const read = (name, value) => async ({ where } = {}) => { store.calls.push(name); if (store.down) throw new Error('synthetic storage down'); return value(where); };
    const prisma = {
      memberRightsImport: { findUnique: read('import', () => (store.importReady ? { id: 'realm-v1' } : null)) },
      memberRights: { findUnique: read('rights', where => store.rights.get(where.sub) ?? null) },
      authSession: { findUnique: read('session', where => store.sessions.get(where.sid) ?? null), updateMany: async () => ({ count: 1 }), findMany: async () => [] },
      idpSessionEnd: { findUnique: async () => null },
    };
    const ledger = { identities: new Map(), resolves: 0, gate: null,
      async withAppendTransaction(work) { return work({ synthetic: 'transaction' }); },
      async resolveIdentity(tx, issuer, subject) {
        this.resolves++;
        if (this.gate) await this.gate;
        const id = issuer + '\n' + subject;
        if (!this.identities.has(id)) this.identities.set(id, randomUUID());
        return this.identities.get(id);
      } };
    const runtime = { trustedProxyHost: '192.0.2.10', requireResources: () => Object.freeze({ db: {}, ledger, adapters: CTX.runtimeAdapters }) };
    const service = new AuthService(prisma, {}, runtime), guard = new AuthGuard(new Reflector(), service);
    const route = (cls, name, decorator) => decorator(cls.prototype, name, Object.getOwnPropertyDescriptor(cls.prototype, name));
    class SynMember { read() {} write() {} me() {} open() {} logout() {} gateway() {} }
    Controller('syn')(SynMember);
    route(SynMember, 'read', Get('read')); route(SynMember, 'write', Post('write')); route(SynMember, 'open', Get('open'));
    route(SynMember, 'open', SetMetadata('public', true)); route(SynMember, 'logout', Post('logout')); route(SynMember, 'gateway', Get('gateway'));
    class SynSession { me() {} }
    Controller()(SynSession); route(SynSession, 'me', Get('me'));
    const routes = { '/api/syn/read': [SynMember, 'read'], '/api/syn/write': [SynMember, 'write'], '/api/syn/open': [SynMember, 'open'],
      '/api/auth/logout': [SynMember, 'logout'], '/api/gateway/syn': [SynMember, 'gateway'], '/api/syn/me': [SynSession, 'me'] };
    const inside = new Map();
    const server = http.createServer(async (req, res) => {
      req.originalUrl = req.url;
      const [cls, name] = routes[req.url];
      let verdict;
      try { verdict = { admitted: await guard.canActivate(new ExecutionContextHost([req, res], cls, cls.prototype[name])) }; }
      catch (error) { verdict = { admitted: false, status: typeof error?.getStatus === 'function' ? error.getStatus() : 500, code: error?.getResponse?.()?.code ?? null }; }
      const handler = inside.get(req.headers['x-syn-case']);
      const result = handler ? await handler(req, res, verdict) : null;
      if (!res.writableEnded) res.end(JSON.stringify({ verdict, result }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const token = (subject, claims = {}, options = {}) => {
      const jwt = new jose.SignJWT({ realm_access: { roles: ['admin'] }, groups: ['/hospital-a'], azp: 'kin-web', name: 'Synthetic Doctor', ...claims })
        .setProtectedHeader({ alg: 'RS256', kid: 'syn-key' }).setIssuer(options.issuer ?? ISSUER).setAudience(options.audience ?? 'kin-api')
        .setSubject(subject).setIssuedAt().setExpirationTime(options.expires ?? '10m');
      return jwt.sign(options.key ?? key.privateKey);
    };
    const member = (sub, overrides = {}) => store.rights.set(sub, { sub, version: 3, approved: true, suspended: false, institution: 'hospital-a',
      roles: ['radiologist'], newAuthAfter: null, ...overrides });
    const session = async (sub, claims) => {
      const sid = 's2.' + randomUUID() + '.' + randomUUID() + '.synthetic';
      store.sessions.set(sid, { sid, sub, accessToken: await token(sub, claims), refreshToken: 'synthetic-refresh', atExpiresAt: new Date(Date.now() + 600000),
        createdAt: new Date(), lastSeenAt: new Date(), entryProofHash: null, entryProofExpiresAt: null, idpSid: null, rightsVersion: 3, institution: 'hospital-a' });
      return sid;
    };
    /** One request: `cookie` sid (with its binding unless `binding: null`), or `bearer`; `handler` runs after the guard. */
    const call = (pathname, { method = 'GET', sid, bearer, binding, csrf = true, headers = {}, handler, abort } = {}) => new Promise((resolve, reject) => {
      const id = randomUUID();
      if (handler) inside.set(id, handler);
      const sent = { 'x-syn-case': id, ...headers };
      if (sid) { sent.cookie = 'kin_sid=' + encodeURIComponent(sid); if (binding !== null) sent['x-kin-session'] = binding ?? service.sessionRef(sid); }
      if (bearer) sent.authorization = 'Bearer ' + bearer;
      if (method !== 'GET' && csrf) sent['x-kin-csrf'] = '1';
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: pathname, method, headers: sent }, res => {
        let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
        res.on('end', () => { inside.delete(id); try { resolve(JSON.parse(body)); } catch { resolve({ raw: body }); } });
      });
      req.on('error', error => { inside.delete(id); if (abort) resolve({ aborted: true }); else reject(error); });
      req.end();
      if (abort) abort(req);
    });
    const facts = async req => { try { return { facts: await service.emrRequestContext.facts(req) }; } catch (error) { return { refused: error?.code ?? error?.name }; } };
    authWorld = { service, guard, store, ledger, runtime, token, member, session, call, facts, stranger, close: () => { server.close(); jwks.close(); } };
    return authWorld;
  }

  test('C30 only a member request that passed every guard check carries facts; refused, public, logout, gateway and development requests carry none and leave nothing behind', async () => {
    const w = await authHarness();
    w.member('member-a'); w.member('clinician-c', { roles: ['clinician'] }); w.member('pending-p', { institution: null });
    w.member('suspended-s', { suspended: true }); w.member('unapproved-u', { approved: false });
    const sid = await w.session('member-a');
    const take = (req, res, verdict) => w.facts(req).then(found => ({ verdict, ...found }));
    // A session member: facts from the verified payload and the DB rights (the token's own roles are not the rights).
    let { result } = await w.call('/api/syn/read', { sid, handler: take });
    assert.deepEqual(Object.keys(result.facts).sort(), ['authMethod', 'identity', 'institutionId', 'kind', 'member', 'requestId', 'rightsVersion', 'roles', 'sessionRef', 'trustedProxyIp']
      .filter(k => k !== 'member'), 'facts as JSON (member is a function)');
    assert.deepEqual([result.facts.kind, result.facts.authMethod, result.facts.sessionRef, result.facts.roles, result.facts.institutionId, result.facts.rightsVersion],
      ['member', 'session', w.service.sessionRef(sid), ['radiologist'], 'hospital-a', 3]);
    assert.deepEqual([result.facts.identity.issuer, result.facts.identity.subject], [ISSUER, 'member-a']);
    assert.deepEqual(result.facts.trustedProxyIp, { status: 'unresolved', reason: 'not-observed' }, 'a loopback peer is never the proxy');
    // A bearer member: no session reference.
    ({ result } = await w.call('/api/syn/read', { bearer: await w.token('member-a'), handler: take }));
    assert.deepEqual([result.facts.authMethod, result.facts.sessionRef, result.facts.identity.subject], ['bearer', null, 'member-a']);
    // A cookie write: facts only after CSRF passed.
    ({ result } = await w.call('/api/syn/write', { method: 'POST', sid, handler: take }));
    assert.equal(result.facts.authMethod, 'session');
    const none = async (pathname, options, status, code) => {
      const { result } = await w.call(pathname, { ...options, handler: take });
      assert.equal(result.refused, 'EmrRequestFactsRequired', JSON.stringify(result));
      if (status !== undefined) assert.deepEqual([result.verdict.admitted, result.verdict.status, result.verdict.code], [false, status, code], JSON.stringify(result.verdict));
      else assert.equal(result.verdict.admitted, true, JSON.stringify(result.verdict));
    };
    await none('/api/syn/write', { method: 'POST', sid, csrf: false }, 403, 'AUTH_CSRF_REQUIRED');
    await none('/api/syn/read', { sid, binding: null }, 428, 'AUTH_SESSION_REQUIRED');
    await none('/api/syn/read', { bearer: await w.token('member-a', {}, { key: w.stranger.privateKey }) }, 401, null);
    await none('/api/syn/read', { bearer: await w.token('member-a', {}, { issuer: 'https://other.example.test/realms/kin' }) }, 401, null);
    await none('/api/syn/read', { bearer: await w.token('member-a', {}, { audience: 'other-api' }) }, 401, null);
    await none('/api/syn/read', { bearer: await w.token('member-a', {}, { expires: Math.floor(Date.now() / 1000) - 60 }) }, 401, null);
    await none('/api/syn/read', { bearer: await w.token('pending-p') }, 403, 'INSTITUTION_PENDING');
    await none('/api/syn/read', { bearer: await w.token('unapproved-u') }, 403, 'INSTITUTION_INVALID');
    await none('/api/syn/read', { bearer: await w.token('suspended-s') }, 401, 'AUTH_SESSION_ENDED');
    await none('/api/syn/read', { bearer: await w.token('clinician-c') }, 403, 'CLINICIAN_ROUTE_DENIED');
    ({ result } = await w.call('/api/syn/me', { bearer: await w.token('clinician-c'), handler: take }));
    assert.deepEqual(result.facts.roles, ['clinician'], 'an allowed clinician route is a member path');
    await none('/api/syn/open', {});
    await none('/api/auth/logout', { method: 'POST', sid });
    await none('/api/gateway/syn', { bearer: await w.token('gateway-g', { azp: 'gw-synthetic', realm_access: { roles: ['gateway'] }, groups: ['/hospital-a'] }) });
    process.env.AUTH_REQUIRED = 'false';
    try { await none('/api/syn/read', { headers: { 'x-kin-sub': 'member-a', 'x-kin-user': 'member-a' } }); }
    finally { process.env.AUTH_REQUIRED = 'true'; }
    // Fields of req and of the request are never the facts: changed after admission, they change nothing; a second
    // capture of the same request is refused and ends the request's facts.
    ({ result } = await w.call('/api/syn/read', { sid, headers: { 'x-real-ip': '198.51.100.7', 'x-request-id': 'client-chosen',
      'x-kin-institution': 'hospital-b', 'x-kin-sub': 'member-b', 'x-kin-session': w.service.sessionRef(sid) }, handler: async (req, res) => {
      Object.assign(req, { sub: 'member-b', roles: ['admin'], institution: 'hospital-b', actor: 'someone', sessionId: 'other' });
      req.headers['x-real-ip'] = '203.0.113.1';
      const found = await w.facts(req);
      const again = (() => { try { w.service.captureEmrRequest(req, res, { issuer: ISSUER, subject: 'member-b', displayName: null, roles: ['admin'],
        institutionId: 'hospital-b', rightsVersion: 9, authMethod: 'bearer', sessionRef: null }); return 'accepted'; } catch (error) { return error.code; } })();
      return { ...found, again, after: await w.facts(req) };
    } }));
    assert.deepEqual([result.facts.identity.subject, result.facts.roles, result.facts.institutionId, result.facts.sessionRef],
      ['member-a', ['radiologist'], 'hospital-a', w.service.sessionRef(sid)]);
    assert.notEqual(result.facts.requestId, 'client-chosen');
    assert.deepEqual([result.again, result.after.refused], ['EmrRequestAlreadyCaptured', 'EmrRequestEnded']);
  });

  test('C31 facts belong to one request object for its lifetime: interleaved A/B/A and two sessions of one subject stay apart; a copy, an ended response, an abort or a late lookup gets none', async () => {
    const w = await authHarness();
    w.member('aba-a'); w.member('aba-b', { institution: 'hospital-b', roles: ['technician'] });
    const [sidA1, sidA2, sidB] = [await w.session('aba-a'), await w.session('aba-a'), await w.session('aba-b')];
    let release, later = new Promise(resolve => { release = resolve; });
    const order = [];
    const handler = label => async req => {
      if (label === 'A1') await later;
      const first = await w.facts(req), second = await w.facts(req);
      order.push(label);
      const copies = [];
      for (const copy of [{ ...req }, Object.create(req), JSON.parse(JSON.stringify({ headers: req.headers })), {}]) copies.push((await w.facts(copy)).refused);
      return { first: first.facts, same: first.facts.requestId === second.facts.requestId && first.facts.identity.id === second.facts.identity.id, copies };
    };
    const a1 = w.call('/api/syn/read', { sid: sidA1, handler: handler('A1') });
    const b = await w.call('/api/syn/read', { sid: sidB, handler: handler('B') });
    const a2 = await w.call('/api/syn/read', { sid: sidA2, handler: handler('A2') });
    release();
    const first = await a1;
    assert.deepEqual(order, ['B', 'A2', 'A1'], 'the first request completes last');
    for (const [answer, sub, institution, sid] of [[first, 'aba-a', 'hospital-a', sidA1], [b, 'aba-b', 'hospital-b', sidB], [a2, 'aba-a', 'hospital-a', sidA2]]) {
      const { result } = answer;
      assert.deepEqual([result.first.identity.subject, result.first.institutionId, result.first.sessionRef, result.same], [sub, institution, w.service.sessionRef(sid), true]);
      assert.deepEqual(result.copies, ['EmrRequestFactsRequired', 'EmrRequestFactsRequired', 'EmrRequestFactsRequired', 'EmrRequestFactsRequired']);
    }
    assert.equal(first.result.first.identity.id, a2.result.first.identity.id, 'one subject, one immutable identity');
    assert.notEqual(first.result.first.requestId, a2.result.first.requestId, 'one request ID per request');
    assert.notEqual(first.result.first.sessionRef, a2.result.first.sessionRef, 'two sessions of one subject stay apart');
    assert.deepEqual(b.result.first.roles, ['technician']);
    // Each handler below answers before it finishes; `outcome` settles when it has.
    const settle = () => { let done; const promise = new Promise(resolve => { done = resolve; }); return { promise, done }; };
    // After the response finished: neither the facts nor a member lookup of facts read before.
    const ended = settle();
    await w.call('/api/syn/read', { sid: sidA1, handler: async (req, res) => {
      const before = await w.service.emrRequestContext.facts(req);
      await new Promise(resolve => res.end('done', resolve));
      const member = await before.member('aba-b').then(() => 'accepted', error => error.code);
      ended.done({ after: (await w.facts(req)).refused, member });
    } });
    assert.deepEqual(await ended.promise, { after: 'EmrRequestEnded', member: 'EmrRequestEnded' });
    // A lookup that began before the end and resolves after it is refused.
    const late = settle();
    let unblock;
    w.ledger.gate = new Promise(resolve => { unblock = resolve; });
    try {
      await w.call('/api/syn/read', { sid: sidA1, handler: async (req, res) => {
        const pending = w.service.emrRequestContext.facts(req).then(() => 'delivered', error => error.code);
        await new Promise(resolve => res.end('done', resolve));
        unblock();
        late.done(await pending);
      } });
      assert.equal(await late.promise, 'EmrRequestEnded');
    } finally { w.ledger.gate = null; }
    // A client that went away: the request ends with its response's close.
    const aborted = settle();
    await w.call('/api/syn/read', { sid: sidA1, abort: req => setTimeout(() => req.destroy(), 100), handler: async (req, res) => {
      await new Promise(resolve => res.once('close', resolve));
      aborted.done((await w.facts(req)).refused);
    } });
    assert.equal(await aborted.promise, 'EmrRequestEnded');
  });

  test('C32 one immutable identity per verified issuer and subject; member(subject) is a current approved member of the same issuer or a closed refusal, never a minted ID', async () => {
    const w = await authHarness();
    w.member('id-a'); w.member('id-b'); w.member('id-gone', { suspended: true }); w.member('id-unapproved', { approved: false }); w.member('id-nowhere', { institution: null });
    const take = req => w.service.emrRequestContext.facts(req);
    const named = async (sub, name) => (await w.call('/api/syn/read', { bearer: await w.token(sub, { name }), handler: async req => (await take(req)).identity })).result;
    const first = await named('id-a', 'Kim Synthetic'), renamed = await named('id-a', 'Lee Synthetic'), namesake = await named('id-b', 'Kim Synthetic');
    assert.equal(first.id, renamed.id, 'a renamed subject keeps its identity');
    assert.notEqual(first.id, namesake.id, 'a namesake is another identity');
    const { result } = await w.call('/api/syn/read', { bearer: await w.token('id-a'), handler: async req => {
      const facts = await take(req), outcome = async subject => facts.member(subject).then(identity => identity, error => error.code);
      const before = w.ledger.resolves;
      const refused = {};
      for (const subject of ['id-unknown', 'id-gone', 'id-unapproved', 'id-nowhere', '', 42]) refused[String(subject)] = await outcome(subject);
      const minted = w.ledger.resolves - before;
      w.store.importReady = false; refused.pending = await outcome('id-b'); w.store.importReady = true;
      w.store.down = true; refused.down = await outcome('id-b'); w.store.down = false;
      return { b: await outcome('id-b'), refused, minted };
    } });
    assert.deepEqual([result.b.issuer, result.b.subject, result.b.id], [ISSUER, 'id-b', namesake.id], 'the same issuer, the existing identity');
    assert.deepEqual(result.refused, { 'id-unknown': 'EmrMemberRefused', 'id-gone': 'EmrMemberRefused', 'id-unapproved': 'EmrMemberRefused',
      'id-nowhere': 'EmrMemberRefused', '': 'EmrMemberRefused', 42: 'EmrMemberRefused', pending: 'EmrMemberRightsPending', down: 'EmrMemberUnavailable' });
    assert.equal(result.minted, 0, 'no identity is resolved for a refused subject');
    // Another issuer never gets facts, whatever the caller hands the capture seam.
    const { result: other } = await w.call('/api/syn/open', { handler: async (req, res) => {
      const code = (() => { try { w.service.captureEmrRequest(req, res, { issuer: 'https://other.example.test/realms/kin', subject: 'id-a', displayName: null,
        roles: ['radiologist'], institutionId: 'hospital-a', rightsVersion: 3, authMethod: 'bearer', sessionRef: null }); return 'accepted'; } catch (error) { return error.code; } })();
      return { code, facts: (await w.facts(req)).refused };
    } });
    assert.deepEqual(other, { code: 'EmrRequestIssuerRefused', facts: 'EmrRequestFactsRequired' });
  });

  test('C33 the captured rights are a copy of what the guard verified; a request that never reads its facts does no new IO, and the existing session verdicts stay', async () => {
    const w = await authHarness();
    w.member('copy-a');
    const sid = await w.session('copy-a');
    const dns = require('node:dns').promises, lookup = dns.lookup;
    let lookups = 0;
    dns.lookup = (...args) => { lookups++; return lookup.apply(dns, args); };
    try {
      const resolves = w.ledger.resolves;
      w.store.calls.length = 0;
      const { result } = await w.call('/api/syn/read', { sid, handler: async () => 'no facts read' });
      assert.equal(result, 'no facts read');
      assert.deepEqual([w.ledger.resolves - resolves, lookups], [0, 0], 'no identity or ingress work without a reader');
      assert.deepEqual([...new Set(w.store.calls)].sort(), ['import', 'rights', 'session'], 'the guard reads what it read before');
      // The rights row the guard verified, changed afterwards in the store and on req: the facts keep the copy.
      const { result: copied } = await w.call('/api/syn/read', { sid, handler: async req => {
        w.store.rights.get('copy-a').roles.push('admin');
        req.roles.push('admin');
        return (await w.facts(req)).facts.roles;
      } });
      assert.deepEqual(copied, ['radiologist']);
      w.store.rights.get('copy-a').roles.pop();
      // A changed rights version ends the session as before: no facts.
      w.member('copy-a', { version: 4 });
      const { result: stale } = await w.call('/api/syn/read', { sid, handler: (req, res, verdict) => w.facts(req).then(found => ({ verdict, ...found })) });
      assert.deepEqual([stale.verdict.admitted, stale.verdict.status, stale.verdict.code, stale.refused], [false, 401, 'AUTH_SESSION_ENDED', 'EmrRequestFactsRequired']);
    } finally { dns.lookup = lookup; }
  });

  test('C34 the ingress address is known only from a resolved proxy peer with one valid X-Real-IP; DNS is bounded and never guessed; one server request ID per request; no credential is a fact', async () => {
    const { createEmrRequestContext } = load('emr-runtime/request-context.ts');
    const net = require('node:net');
    const { mock } = require('node:test');
    const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
    const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
    const ledger = { async withAppendTransaction(work) { return work({}); }, async resolveIdentity(tx, issuer, subject) { return '00000000-0000-4000-8000-' + subject.padStart(12, '0').slice(-12); } };
    const runtime = { trustedProxyHost: 'proxy', requireResources: () => Object.freeze({ db: {}, ledger, adapters: CTX.runtimeAdapters }) };
    const world = () => {
      const lookups = [];
      const context = createEmrRequestContext({ runtime, issuer: () => ISSUER, member: async () => {}, lookup: host => { const call = deferred(); lookups.push({ host, call }); return call.promise; } });
      const exchange = (peer, headers = {}) => {
        const socket = new net.Socket();
        Object.defineProperty(socket, 'remoteAddress', { value: peer });
        const req = new http.IncomingMessage(socket); req.headers = headers;
        const res = new http.ServerResponse(req);
        context.capture(req, res, { issuer: ISSUER, subject: '7', displayName: null, roles: ['radiologist'], institutionId: 'hospital-a', rightsVersion: 1,
          authMethod: 'session', sessionRef: 'ref-7' });
        return req;
      };
      return { lookups, context, exchange };
    };
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
    try {
      const w = world();
      const ingress = async (peer, headers, answer) => {
        const pending = w.context.source.facts(w.exchange(peer, headers));
        await flush();
        if (answer) answer();
        return (await pending).trustedProxyIp;
      };
      const known = address => ({ status: 'known', value: { address, source: 'trusted-proxy' } }), unknown = { status: 'unresolved', reason: 'not-observed' };
      // Cold: the first lookup answers the proxy's address; loopback and malformed answers are never trusted.
      assert.deepEqual(await ingress('192.0.2.10', { 'x-real-ip': '198.51.100.7' }, () => {
        assert.equal(w.lookups.length, 1, 'the proxy name is looked up before any peer is trusted');
        w.lookups[0].call.resolve([{ address: '192.0.2.10' }, { address: '127.0.0.1' }, { address: '::1' }, { address: 'not-ip' }]);
      }), known('198.51.100.7'));
      assert.equal(w.lookups[0].host, 'proxy');
      // Fresh for 5 s: no new lookup; the IPv4-mapped peer is the same peer.
      mock.timers.tick(4000);
      assert.deepEqual(await ingress('::ffff:192.0.2.10', { 'x-real-ip': '198.51.100.8' }), known('198.51.100.8'));
      for (const [peer, headers] of [
        ['203.0.113.9', { 'x-real-ip': '198.51.100.7' }],                       // a direct caller
        ['127.0.0.1', { 'x-real-ip': '198.51.100.7' }],                         // loopback is never the proxy
        ['203.0.113.9', { 'x-forwarded-for': '198.51.100.7', host: 'proxy' }],  // XFF and Host are not sources
        ['192.0.2.10', { 'x-forwarded-for': '198.51.100.7' }],                  // the proxy without X-Real-IP
        ['192.0.2.10', { 'x-real-ip': '198.51.100.7, 198.51.100.9' }],          // more than one
        ['192.0.2.10', { 'x-real-ip': 'not-an-address' }],                      // not an IP
      ]) assert.deepEqual(await ingress(peer, headers), unknown, JSON.stringify([peer, headers]));
      assert.equal(w.lookups.length, 1, 'served from the fresh set');
      // Stale (5-60 s): a new lookup that has not answered gets 200 ms, then the verified set serves.
      mock.timers.tick(2000);
      const stale = w.context.source.facts(w.exchange('192.0.2.10', { 'x-real-ip': '198.51.100.7' }));
      await flush(); mock.timers.tick(200); await flush();
      assert.deepEqual((await stale).trustedProxyIp, known('198.51.100.7'));
      assert.equal(w.lookups.length, 2);
      // A lookup older than 5 s is abandoned for a new one; its late answer never replaces the newer set.
      mock.timers.tick(5001);
      const fresh = w.context.source.facts(w.exchange('192.0.2.20', { 'x-real-ip': '198.51.100.7' }));
      await flush();
      assert.equal(w.lookups.length, 3, 'a new lookup after the abandoned one');
      w.lookups[2].call.resolve([{ address: '192.0.2.20' }]);
      assert.deepEqual((await fresh).trustedProxyIp, known('198.51.100.7'));
      w.lookups[1].call.resolve([{ address: '192.0.2.10' }]);
      await flush();
      assert.deepEqual(await ingress('192.0.2.10', { 'x-real-ip': '198.51.100.7' }), unknown, 'the older answer did not replace the newer set');
      assert.deepEqual(await ingress('192.0.2.20', { 'x-real-ip': '198.51.100.7' }), known('198.51.100.7'));
      // Expired (over 60 s without a verified answer): failed and empty lookups leave no trusted peer - not the last set,
      // and not a private-range peer either.
      mock.timers.tick(61_000);
      const failing = w.context.source.facts(w.exchange('10.0.0.5', { 'x-real-ip': '198.51.100.7' }));
      await flush(); w.lookups[w.lookups.length - 1].call.reject(new Error('ENOTFOUND proxy'));
      assert.deepEqual((await failing).trustedProxyIp, unknown);
      assert.deepEqual(await ingress('192.0.2.20', { 'x-real-ip': '198.51.100.7' }, () => w.lookups[w.lookups.length - 1].call.reject(new Error('ENOTFOUND'))), unknown);
      mock.timers.tick(6000);
      const empty = w.context.source.facts(w.exchange('192.168.0.5', { 'x-real-ip': '198.51.100.7' }));
      await flush(); w.lookups[w.lookups.length - 1].call.resolve([]);
      assert.deepEqual((await empty).trustedProxyIp, unknown);
      // Cold without an answer: 500 ms, then unresolved.
      const cold = world();
      const waiting = cold.context.source.facts(cold.exchange('192.0.2.10', { 'x-real-ip': '198.51.100.7' }));
      await flush(); mock.timers.tick(499); await flush();
      let settled = false; waiting.then(() => { settled = true; }, () => { settled = true; });
      await flush();
      assert.equal(settled, false, 'still waiting within the cold bound');
      mock.timers.tick(1); await flush();
      assert.deepEqual((await waiting).trustedProxyIp, unknown);
    } finally { mock.timers.reset(); }
    // One server request ID per request, kept across reads; no header ID, token, cookie or session secret in the facts.
    const plain = world();
    const req = plain.exchange('203.0.113.9', { 'x-request-id': 'client-chosen', cookie: 'kin_sid=Synthetic-Session-Secret', authorization: 'Bearer Synthetic.Token.Value' });
    const first = plain.context.source.facts(req);
    await flush(); plain.lookups[0].call.resolve([]);
    const [one, two] = [await first, await plain.context.source.facts(req)];
    const other = plain.context.source.facts(plain.exchange('203.0.113.9'));
    await flush();
    assert.equal(one.requestId, two.requestId);
    assert.match(one.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(one.requestId, 'client-chosen');
    assert.notEqual((await other).requestId, one.requestId);
    const text = JSON.stringify(one);
    for (const secret of ['Synthetic-Session-Secret', 'Synthetic.Token.Value', 'kin_sid', 'client-chosen']) assert(!text.includes(secret), secret);
    assert(Object.isFrozen(one) && Object.isFrozen(one.roles) && Object.isFrozen(one.identity) && Object.isFrozen(one.trustedProxyIp));
  });

  test('C35 the public request and startup types are the declared ones; only AuthGuard captures, only AuthService creates the source, and neither imports clinical, signature or report code', () => {
    const { checker, resolve, rel, sources, exported, ownerOf } = product();
    const facts = exported('api/src/emr-runtime/request-context.ts', 'EmrAuthenticatedRequestFacts');
    assert.deepEqual(checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(facts)).map(p => p.name).sort(),
      ['authMethod', 'identity', 'institutionId', 'kind', 'member', 'requestId', 'rightsVersion', 'roles', 'sessionRef', 'trustedProxyIp'],
      'no signing registration, signature, patient link or verifier is a B fact');
    const source = exported('api/src/emr-runtime/request-context.ts', 'EmrAuthenticatedRequestSource');
    assert.deepEqual(checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(source)).map(p => p.name), ['facts'], 'the read port has no writer');
    const resources = exported('api/src/emr-runtime/application.ts', 'EmrStartupResources');
    assert.deepEqual(checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(resources)).map(p => p.name).sort(), ['adapters', 'db', 'ledger']);
    const service = exported('api/src/auth.service.ts', 'AuthService');
    const capture = checker.getPropertyOfType(checker.getDeclaredTypeOfSymbol(service), 'captureEmrRequest');
    const factory = exported('api/src/emr-runtime/request-context.ts', 'createEmrRequestContext');
    const calls = [];
    for (const file of sources) {
      const visit = node => {
        if (ts.isCallExpression(node)) {
          const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
          const symbol = resolve(checker.getSymbolAtLocation(callee));
          if (symbol === capture) calls.push(`captureEmrRequest ${rel(file)} ${ownerOf(node)}`);
          if (symbol === factory) calls.push(`createEmrRequestContext ${rel(file)} ${ownerOf(node)}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
    }
    assert.deepEqual(calls.sort(), ['captureEmrRequest api/src/auth.guard.ts AuthGuard.admit', 'createEmrRequestContext api/src/auth.service.ts AuthService.constructor']);
    // The startup owner and the request facts reach no clinical (D), signature (C2) or report code.
    const seen = new Set(), reached = [];
    const walk = file => {
      if (seen.has(file.fileName)) return;
      seen.add(file.fileName);
      reached.push(rel(file));
      for (const statement of file.statements) {
        const specifier = (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier;
        if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith('.')) continue;
        const target = ts.resolveModuleName(specifier.text, file.fileName, parsed.options, ts.sys).resolvedModule;
        const next = target && sources.find(candidate => path.resolve(candidate.fileName) === path.resolve(target.resolvedFileName));
        if (next) walk(next);
      }
    };
    for (const name of ['application.ts', 'request-context.ts']) walk(sources.find(file => rel(file) === 'api/src/emr-runtime/' + name));
    assert.deepEqual(reached.filter(file => /\/emr-(clinical|signature|report|image)\//.test(file)), []);
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
    // A single B rule calls A's calendar symbol. Resolve aliases with the compiler, then prove that
    // the public deadline and prefix planner both reach that rule. Renaming the intermediate function is immaterial.
    const program = ts.createProgram(parsed.fileNames, parsed.options), checker = program.getTypeChecker();
    const symbol = node => {
      const found = checker.getSymbolAtLocation(node);
      return found && (found.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(found) : found;
    };
    const source = suffix => program.getSourceFiles().find(f => f.fileName.replaceAll('\\', '/').endsWith(suffix));
    const exported = (file, name) => checker.getExportsOfModule(checker.getSymbolAtLocation(file)).find(s => s.name === name);
    const calendar = exported(source('/emr-contract/lawful-defaults.ts'), 'civilPeriodEnd');
    const contract = source('/emr-runtime/contract.ts'), edges = new Map(), callers = new Set();
    const callableOwner = resolved => {
      const declaration = resolved?.valueDeclaration;
      if (declaration && ts.isFunctionLike(declaration)) return declaration;
      if (declaration?.initializer && ts.isFunctionLike(declaration.initializer)) return declaration.initializer;
      return resolved;
    };
    for (const file of program.getSourceFiles().filter(f => f.fileName.replaceAll('\\', '/').includes('/emr-runtime/'))) {
      const visit = (node, owner) => {
        if (ts.isFunctionLike(node) && node.body) owner = node;
        if (ts.isCallExpression(node)) {
          const target = symbol(node.expression);
          if (!edges.has(owner)) edges.set(owner, new Set());
          edges.get(owner).add(callableOwner(target));
          if (target === calendar) callers.add(owner);
        }
        ts.forEachChild(node, child => visit(child, owner));
      };
      visit(file, file); // top-level initializers/calls are owners too, even without a callable declaration
    }
    assert.equal(callers.size, 1, 'one runtime access calendar rule');
    const [rule] = callers;
    const reaches = (from, seen = new Set()) => from === rule || (!seen.has(from) &&
      (seen.add(from), [...(edges.get(from) || [])].some(next => reaches(next, seen))));
    for (const name of ['accessDeadline', 'planExpiryPrefix']) assert(reaches(callableOwner(exported(contract, name))), name);
    // L05 compares the TS and PostgreSQL floor at civil boundaries and exercises deletion on both sides of that floor.
    // pg_depend cannot prove call ownership for plpgsql/string bodies and is not an oracle for that requirement.
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
