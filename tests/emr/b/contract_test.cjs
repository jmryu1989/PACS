/* EMR-B1 contract cases C01-C10 and C13-C18 (REQ-EMR-01/02/06/07/19/20 -> RISK-EMR-* -> TEST-EMR-B-C01..C10).
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
  liveDriver().then(result => { fs.writeSync(1, 'EMR_B_RESULT ' + JSON.stringify(result) + '\n'); process.exit(0); },
    error => { fs.writeSync(1, 'EMR_B_RESULT ' + JSON.stringify({ error: errorCode(error), name: error?.name ?? null, problems: error?.problems ?? null }) + '\n'); process.exit(0); });
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
  const url = args.url ?? process.env.DATABASE_URL;
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  await prisma.$connect();
  try {
    if (operation === 'verify-runtime') return await verifyRuntimeConnection(prisma);
    if (operation === 'expire') {
      const reader = new PrismaClient({ datasources: { db: { url: process.env.EMR_READER_URL } } });
      try {
        const journal = new FailureJournal(process.env.KIN_EMR_STATE_DIR);
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
        fs.chmodSync(path.join(state,'seal'),0o500);
        return result;
      },
    } : prisma;
    const store = new RT.AccessLedgerStore(transactions, sql, seal, journal);
    // The viewing stream's seal flattened beside both streams, so a caller reads the stream every event is in directly.
    const flat = s => s === 'absent' ? 'absent' : { ...s.streams.viewing, streams: s.streams, sealedAt: s.sealedAt };
    if (operation === 'recover') { const r = await seal.recoverAtStart(); return { ...r, seal: flat(r.seal) }; }
    // A process that writes ledger facts is a started server: its start-up check runs first (B2 calls it before listen).
    if (['append', 'business', 'writer-fence'].includes(operation)) await seal.recoverAtStart();
    if (operation === 'seal') return flat(seal.read());
    if (operation === 'journal-add') return journal.record(args.id, 'append-rolled-back', { eventId: args.id, cause: 'business-rollback' });
    if (operation === 'journal') return journal.all().map(record => ({ id: record.id, kind: record.kind, body: record.body }));
    const stream = args.stream ?? 'viewing';
    if (operation === 'writer-fence') {
      let release, staged, provisional;
      const held = new Promise(resolve => { release = resolve; });
      const ready = new Promise(resolve => { staged = resolve; });
      const writing = prisma.$transaction(async tx => {
        provisional = await store.appendInTransaction(tx, authEvent(A));
        staged(); await held;
      }, { timeout: 15000 });
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
      const run = async event => { try { return { eventId: event.eventId, receipt: await store.append(event) }; } catch (error) { return { eventId: event.eventId, error: errorCode(error) }; } };
      const results = args.concurrent ? await Promise.all(events.map(run)) : await sequential(events, run);
      return { results, events };
    }
    if (operation === 'business') {
      // A business change (the legacy AuditLog row) and its ledger fact in one transaction; `fail` injects a failure.
      const event = args.event ?? authEvent(A);
      let appended, transaction, callbackFailed = false;
      try {
        appended = await prisma.$transaction(async tx => {
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
        }, { timeout: 15000, maxWait: 10000 });
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
  const J = {...J0, FailureJournal: class extends J0.FailureJournal { constructor(dir) { super(dir, new CO.StateCoordinator(dir, EW.executeExternal)); } }};
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
      snapshot: async work => work(sql), withWriterFence: async work => work(sql),
      markerForSlot: async (stream, sequence) => ledger.markers.find(m => m.stream === stream && m.sequence === sequence) ?? null,
      markerForAttempt: async (stream, attemptId) => ledger.markers.find(m => m.stream === stream && m.attemptId === attemptId) ?? null,
      tail: async stream => { ledger.guard(); return { chainId: ledger.streams[stream].chainId, ...ledger.streams[stream].head }; },
      entriesAfter: async (stream, after, limit) => { ledger.guard(); return ledger.streams[stream].entries.filter(e => e.sequence > after).sort((a, b) => a.sequence - b.sequence).slice(0, limit).map(e => ledger.stored(e)); },
      entryForEvent: async (stream, eventId) => { ledger.guard(); const e = ledger.streams[stream].entries.find(x => x.eventId === eventId); return e ? ledger.stored(e) : null; },
      placement: async () => [],
    };
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
      const open=authEvent(A),tx=w.ledger.begin();await w.store.appendInTransaction(tx,open);
      const own=authEvent(A);assert.equal((await w.store.append(own)).eventId,own.eventId);
      assert(!w.journal.all().some(r=>r.kind==='commit-not-found'));
      await w.restart().seal.recoverAtStart();
      await stageExpiry(w,2,'2036-01-01T00:00:00.000Z'); await w.seal.advance('viewing',w.ledger.head);
      assert.equal((await w.restart().seal.recoverAtStart()).recovered,0);
    } finally {w.cleanup();}
  });

  async function stageExpiry(w,through,at) {
    const attemptId=randomUUID(),bundleId=randomUUID(),prefix=await w.seal.expiryPrefix(through);
    w.seal.recordIntent('viewing',attemptId,null,null,bundleId);w.ledger.checkpoint(through,at);
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
