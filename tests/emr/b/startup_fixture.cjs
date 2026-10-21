'use strict';
/* EMR-B2 (c) test helper (C-A01/C-A02 child-process cases; adapted from the frozen r2 fixture): the real API start in its
 * own child process.
 *
 * Parent side: `run(scenario, options)` starts `node startup_fixture.cjs <scenario>` with the scenario's environment. The
 * child's stdout, stderr and the events it reports over the IPC channel (never over stdout/stderr, whose bytes are part of
 * what the cases judge) are streamed to files in a run directory; the parent keeps only a bounded summary: exit code or
 * signal, the first 64 KiB of each stream and its byte count, and at most 400 events (an overflow is reported, never
 * dropped silently). Each child is a separate process, so the launcher's one-per-process latch, A's one-time composition
 * and Nest's logger never cross cases or the contract suite's own process. `stop(child, signal)` sends SIGTERM/SIGINT:
 * the OS signal on Linux, else the child's own `process.emit` (Windows has no OS signal delivery to a handler; the parent
 * reports which it used - the OS-signal evidence is the Linux run).
 *
 * Child side: it loads the real compiled modules - /app/dist in the API image, else api/src through
 * tests/service_test_loader.cjs - observes the product calls by wrapping exports of the loaded modules, applies the
 * scenario's test-side substitutions, and then requires the real main.ts, whose bootstrap and launcher run unchanged.
 * Substitutions are test-side only and named by the scenario: `db: 'memory'` replaces the two database clients (the
 * dedicated EmrLedgerClient by a fake answering the runtime-role catalog and the database identity, PrismaLedgerSql by
 * an empty two-chain model, the ordinary PrismaService by a fake whose reads are empty, the store's append by a timed
 * fake receipt) so the start runs without PostgreSQL. The protected-state service the API is a client of (EMR-B2 c) is
 * the actual ProtectedStateService, AccessSeal, failure journal and external writer in this same child over that model
 * and a fresh state directory; only the socket/worker transport is replaced: the API's StateClient is a fake that
 * dispatches the same typed frames to that service in-process (`service: 'absent'` makes the session fail;
 * `lose-service` over IPC drops it after readiness). `hold: 'connect' | 'role' | 'create' | 'init' | 'listen'` pauses
 * the start inside that wait until the parent sends `release` (with `outcome: 'reject'` the held step then fails). A
 * listener on port 3000 is moved to 127.0.0.1 and the scenario's port (0 = any). There is no product reset, binding or
 * test switch.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const HEAD_BYTES = 64 * 1024, MAX_EVENTS = 400;
/** How a stop signal reaches the child on this host: the OS signal, or the child's own process.emit over IPC. */
const SIGNAL_MODE = process.platform === 'linux' ? 'kill' : 'emit';

/** A fresh protected state directory (0700) as the service's volume would be; the API never receives it. */
function stateDirectory(label = 'state') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `emr-c-${label}-`));
  fs.chmodSync(dir, 0o700);
  return dir;
}

/** The API's environment for a scenario: production-shaped, synthetic, nothing reachable; the client endpoint path is
 * absolute on this host (the fake client never opens it) and the service's state directory travels in KIN_TEST_STATE
 * for the in-child service alone - the API's own configuration refuses KIN_EMR_STATE_DIR. */
function environment(state, overrides = {}) {
  const base = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR, HOME: process.env.HOME,
    NODE_OPTIONS: '--max-old-space-size=3072',
    DEPLOYMENT_MODE: 'production', AUTH_REQUIRED: 'true',
    DATABASE_URL: 'postgresql://kin_runtime:Synthetic-Fixture-Secret-0001@127.0.0.1:1/kin?connect_timeout=2',
    KIN_EMR_STATE_SOCKET: path.resolve(os.tmpdir(), 'kin-emr-api', 'writer.sock'), KIN_EMR_INSTANCE_ID: 'synthetic-startup-fixture',
    KIN_TEST_STATE: state,
    KC_ISSUER: 'http://127.0.0.1:1/auth/realms/kin', KC_JWKS_URL: 'http://127.0.0.1:1/certs', KC_AUDIENCE: 'kin-api',
    KC_WEB_SECRET: 'synthetic-web-secret', KIN_COOKIE_SECRET: 'synthetic-cookie-secret', PUBLIC_ORIGIN: 'http://127.0.0.1:3000',
    ORTHANC_URL: 'http://127.0.0.1:1', ORTHANC_USER: 'synthetic', ORTHANC_PASS: 'synthetic-orthanc-pass',
    KC_ADMIN_URL: 'http://127.0.0.1:1/auth', KC_REALM: 'kin', KC_CLIENT_ID: 'kin-api', KC_CLIENT_SECRET: 'synthetic-client-secret',
  };
  const env = { ...base, ...overrides };
  for (const [key, value] of Object.entries(env)) if (value === undefined || value === null) delete env[key];
  return env;
}

/** The first HEAD_BYTES of a file as text, and its size. */
function head(file) {
  const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  if (!size) return { text: '', bytes: 0 };
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(size, HEAD_BYTES));
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return { text: buffer.subarray(0, read).toString('utf8'), bytes: size };
  } finally { fs.closeSync(fd); }
}

/** A stop signal to the child (see SIGNAL_MODE); returns the mode used. */
function stop(child, signal = 'SIGTERM') {
  if (SIGNAL_MODE === 'kill') child.kill(signal);
  else if (child.connected) child.send({ cmd: 'signal', signal });
  return SIGNAL_MODE;
}

/** The synthetic service-job event the probe appends (scripts/ops_emr_probe.py probe_event): an in-process system
 * surface whose route contract admits a service job, no patient target. */
function serviceEvent(eventId) {
  const notApplicable = { status: 'not-applicable', reason: 'non-record-target' };
  return { formatVersion: 1, surface: 'GET health', eventId,
    userId: { status: 'known', value: { id: '7c1f3a52-0000-4000-8000-00000000000a', issuer: 'urn:kin:release-probe', subject: 'startup-fixture' } },
    rolesAtTime: { status: 'known', value: ['release-probe'] }, actingInstitution: { status: 'known', value: 'synthetic-institution' },
    managingInstitution: { status: 'known', value: 'synthetic-institution' }, occurredAt: new Date().toISOString(),
    trustedProxyIp: { status: 'not-applicable', reason: 'in-process-service' }, cause: 'service-job',
    context: { basis: 'service-job', studyId: 'SYNTHETIC-startup-fixture', relatedStudyId: null, reason: null }, executor: 'service',
    targets: [{ kind: 'system-operation', patientLinkSnapshot: notApplicable, studyId: notApplicable, recordId: notApplicable, versionId: notApplicable }],
    action: 'provide-prepared', result: 'prepared', requestId: 'startup-fixture-' + eventId, auditLinkId: 'audit:' + require('node:crypto').randomUUID(), relatedEventId: null };
}

/** A synthetic change event (both streams: the viewing fact and the history of a signed report version). */
function changeEvent(eventId) {
  const known = value => ({ status: 'known', value });
  return { ...serviceEvent(eventId), surface: 'POST studies/:uid/report/commit', rolesAtTime: known(['radiologist']),
    trustedProxyIp: known({ address: '192.0.2.10', source: 'trusted-proxy' }), cause: 'user-view', executor: 'member',
    context: { basis: 'assigned-reading', studyId: 'SYNTHETIC-' + eventId, relatedStudyId: null, reason: null },
    targets: [{ kind: 'report-version', patientLinkSnapshot: known({ linkId: 'synthetic-link', patientId: 'SYNTHETIC', assigningAuthority: 'synthetic-institution' }),
      studyId: known('SYNTHETIC-' + eventId), recordId: known('synthetic-record-' + eventId), versionId: known('synthetic-version-' + eventId) }],
    action: 'approve-sign', result: 'succeeded' };
}

/**
 * Run one scenario. `options.env` is the child's whole environment; `options.onEvent(event, child, events)` may act on an
 * event (send a request or a command, signal the child); the result resolves when the child exits or after
 * `options.timeoutMs`. The run directory (stdout.log, stderr.log, events.jsonl) is removed afterwards unless
 * KIN_EMR_B2_KEEP_RUNS is set; its path is in the result either way.
 */
function run(scenario, options = {}) {
  return new Promise(resolve => {
    const started = performance.now();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emr-c-run-'));
    const child = spawn(process.execPath, [__filename, JSON.stringify(scenario)],
      { env: options.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    const stdout = fs.createWriteStream(path.join(dir, 'stdout.log')), stderr = fs.createWriteStream(path.join(dir, 'stderr.log'));
    const journal = fs.createWriteStream(path.join(dir, 'events.jsonl'));
    const events = [];
    let timedOut = false, stderrAt = null, overflow = 0;
    const record = event => {
      journal.write(JSON.stringify(event) + '\n');
      if (events.length < MAX_EVENTS) events.push(event); else overflow++;
    };
    child.on('error', error => record({ what: 'parent-error', message: String(error && error.code) }));
    child.stdout.pipe(stdout, { end: false });
    child.stderr.on('data', () => { if (stderrAt === null) stderrAt = performance.now(); });
    child.stderr.pipe(stderr, { end: false });
    child.on('message', event => {
      record(event);
      if (options.onEvent) Promise.resolve().then(() => options.onEvent(event, child, events))
        .catch(error => record({ what: 'parent-error', message: String(error && error.message).slice(0, 500) }));
    });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, options.timeoutMs ?? 40000);
    child.on('close', (code, signal) => {
      const exitedAt = performance.now();
      clearTimeout(timer);
      let pending = 3;
      const done = () => {
        if (--pending) return;
        const out = head(path.join(dir, 'stdout.log')), err = head(path.join(dir, 'stderr.log'));
        if (!process.env.KIN_EMR_B2_KEEP_RUNS) fs.rmSync(dir, { recursive: true, force: true });
        resolve({ code, signal, timedOut, dir, stdout: out.text, stdoutBytes: out.bytes, stderr: err.text, stderrBytes: err.bytes,
          events, names: events.map(event => event.what), overflow, signalMode: SIGNAL_MODE,
          stderrLines: err.text.split(/\r?\n/).filter(line => line !== ''),
          millisAfterStderr: stderrAt === null ? null : exitedAt - stderrAt, millis: exitedAt - started });
      };
      for (const stream of [stdout, stderr, journal]) stream.end(done);
    });
  });
}

// ═══════════════════════════════════════════════ child side ═══════════════════════════════════════════════

function child(scenario) {
  const http = require('node:http');
  const net = require('node:net');
  const { randomUUID } = require('node:crypto');
  const send = (what, extra = {}) => { if (process.send && process.connected) process.send({ what, at: performance.now(), ...extra }); };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let app = null;
  const finish = end => {
    if (!process.send || !process.connected) return end();
    const fallback = setTimeout(end, 1000);
    process.send({ what: 'ending', at: performance.now() }, () => { clearTimeout(fallback); end(); });
  };
  const exit = process.exit.bind(process);
  process.exit = code => {
    let serverErrorListeners = null;
    try { serverErrorListeners = app ? app.getHttpServer().listenerCount('error') : null; } catch { serverErrorListeners = 'unreadable'; }
    send('exit', { code: code ?? process.exitCode ?? 0, serverErrorListeners });
    finish(() => exit(code));
  };
  if (!fs.existsSync('/app/dist/app.module.js')) {
    const loader = path.join(__dirname, '..', '..', 'service_test_loader.cjs');
    require(loader);
    const { createHash } = require('node:crypto');
    const cache = path.join(os.tmpdir(), 'emr-c-startup-ts-' + createHash('sha256').update(fs.readFileSync(loader)).digest('hex').slice(0, 16));
    fs.mkdirSync(cache, { recursive: true });
    const transpile = require.extensions['.ts'];
    require.extensions['.ts'] = (module, file) => {
      const target = path.join(cache, createHash('sha256').update(file + '\0' + fs.readFileSync(file, 'utf8')).digest('hex') + '.js');
      if (fs.existsSync(target)) {
        module.paths.push(path.resolve(__dirname, '..', '..', '..', 'api', 'node_modules'));
        return module._compile(fs.readFileSync(target, 'utf8'), file);
      }
      const compile = module._compile;
      module._compile = (code, filename) => {
        const temporary = target + '.' + process.pid;
        fs.writeFileSync(temporary, code);
        fs.renameSync(temporary, target);
        return compile.call(module, code, filename);
      };
      return transpile(module, file);
    };
  }
  const load = name => require('/app/dist/' + name);
  /** An error whose every field carries what must never be printed: a credential URL, SQL, a newline. */
  const leak = (code = 'P1001') => Object.assign(new Error('postgresql://kin_runtime:Leaked-Secret-0002@db:5432/kin\nSELECT secret FROM "AuditLog"'),
    { name: 'Leaked\nName', code, errorCode: code, stack: 'Leaked stack\n  at secret (postgresql://kin:Leaked-Secret-0003@db/kin)' });
  const failure = what => (scenario.leakCode ? leak(scenario.leakCode) : what);
  const clients = [];
  let release = null;
  const released = new Promise(resolve => { release = resolve; });
  const hold = async (point, reject) => {
    if (scenario.hold !== point) return;
    send('held', { point });
    const outcome = await released;
    send('released', { point, outcome });
    if (outcome === 'reject') throw reject();
  };

  const prismaModule = load('prisma.service');
  if (scenario.db === 'memory') {
    const defaults = { findUnique: null, findFirst: null, findMany: [], count: 1, aggregate: {}, groupBy: [],
      upsert: {}, create: {}, update: {}, delete: {}, createMany: { count: 0 }, updateMany: { count: 0 }, deleteMany: { count: 0 } };
    class PrismaService {
      constructor() {
        const delegate = model => new Proxy({}, { get: (_, method) => (method === 'then' || typeof method !== 'string' ? undefined : async () => {
          if (model === 'memberRightsImport' && method === 'findUnique') return { id: 'realm-v1' };
          return Object.prototype.hasOwnProperty.call(defaults, method) ? structuredClone(defaults[method]) : null;
        }) });
        return new Proxy(this, { get: (target, key) => (key in target || typeof key !== 'string' || key === 'then' ? target[key]
          : key.startsWith('$') ? async () => [] : delegate(key)) });
      }
      async onModuleInit() { send('prisma-init'); if (scenario.init === 'fail') throw failure(leak('P1001')); }
      async onModuleDestroy() {
        send('destroy');
        if (scenario.slowDestroy) await sleep(scenario.slowDestroy);
        if (scenario.destroyThrow) { send('destroy-throw'); throw leak('SYN_DESTROY'); }
        send('destroy-done');
      }
      async onApplicationShutdown() { send('prisma-shutdown'); }
      async $connect() {}
      async $disconnect() {}
      async $transaction(work) { return typeof work === 'function' ? work(this) : Promise.all(work); }
    }
    prismaModule.PrismaService = PrismaService;
  }
  const orthancModule = load('orthanc.service');
  if (scenario.create === 'fail') {
    class OrthancService { constructor() { throw leak('Leaked\nCode'); } }
    orthancModule.OrthancService = OrthancService;
  }
  const core = require('/app/node_modules/@nestjs/core');
  const { NestApplication } = require('/app/node_modules/@nestjs/core/nest-application');
  const composition = load('emr-contract/composition');
  const validation = load('emr-contract/validation');
  const access = load('emr-contract/access-event');
  const context = load('emr-runtime/context');
  const admission = load('emr-runtime/admission');
  const clientModule = load('emr-runtime/client');
  const coordinatorModule = load('emr-runtime/coordinator');
  const journalModule = load('emr-runtime/failure-journal');
  const sealModule = load('emr-runtime/seal');
  const storeModule = load('emr-runtime/store');
  const manifest = load('emr-runtime/manifest');
  const writer = load('emr-runtime/external-writer');
  const stateService = load('emr-runtime/state-service');
  const protocol = load('emr-runtime/state-protocol');
  const stateClientModule = load('emr-runtime/state-client');
  const remoteState = load('emr-runtime/remote-state');

  // ── the database identity and the two empty chains both sides observe (memory): one fixed synthetic pair ──
  const chains = { viewing: '7c1f3a52-0000-4000-8000-000000000001', history: '7c1f3a52-0000-4000-8000-000000000002' };
  const identity = { database: 'synthetic', oid: 42, address: '127.0.0.1', port: 5432 };

  // ── the dedicated ledger client: a fake answering the runtime-role catalog and the database identity (memory) ──
  const RealClient = clientModule.EmrLedgerClient;
  class FakeLedgerClient {
    constructor(url) {
      const pool = admission.appendPoolConfiguration(url);
      this.emrAppendPoolSize = pool.poolSize;
      this.connectionLimit = Number(new URL(pool.url).searchParams.get('connection_limit'));
    }
    async $connect() {
      if (scenario.connectMillis) await sleep(scenario.connectMillis);
      if (scenario.connect === 'refuse') throw failure(leak('P1001'));
    }
    async $disconnect() {
      if (scenario.disconnect === 'hang') return new Promise(() => {});
      if (scenario.disconnect === 'throw') throw leak('P1017');
    }
    async $queryRaw(strings) {
      const text = Array.isArray(strings) ? strings.join('?') : String(strings);
      const refused = scenario.role === 'refused';
      if (text.includes('current_user::text AS name')) return [{ name: refused ? 'postgres' : 'kin_runtime', rolsuper: refused,
        rolcreaterole: refused, rolcreatedb: refused, rolreplication: refused, rolbypassrls: refused, memberships: 0, owned: 0, owned_schemas: 0 }];
      if (text.includes('AS reachable')) return [{ reachable: 0 }];
      if (text.includes('to_regclass')) return [{ present: true }];
      if (text.includes('has_table_privilege')) return [{ direct_write: false, append: true, expire: false, clauses: false, create_ledger: false, create_public: false }];
      if (text.includes('storage_placement')) return manifest.EMR_STORAGE.tables.map(relation => ({ relation, relkind: 'r', tablespace: manifest.EMR_STORAGE.tablespace }));
      if (text.includes('current_database()')) return [{ ...identity }];
      throw new Error('unexpected fixture query');
    }
    async $transaction(work) { return work(this); }
  }
  const Base = scenario.db === 'memory' ? FakeLedgerClient : RealClient;
  class ObservedLedgerClient extends Base {
    constructor(url) {
      super(url);
      clients.push(this);
      send('client', { poolSize: this.emrAppendPoolSize, connectionLimit: Number(new URL(admission.appendPoolConfiguration(url).url).searchParams.get('connection_limit')) });
    }
    async $connect() {
      send('connect');
      await hold('connect', () => failure(leak('P1001')));
      await super.$connect();
      send('connected');
    }
    async $disconnect() { send('disconnect'); return super.$disconnect(); }
  }
  clientModule.EmrLedgerClient = ObservedLedgerClient;
  const verify = manifest.verifyRuntimeConnection;
  manifest.verifyRuntimeConnection = async db => { send('role'); await hold('role', () => failure(leak('SYN_ROLE'))); return verify(db); };

  // ── the ledger SQL (memory): two empty chains of fixed identity, as a new database holds them ──
  let memorySql = null;
  if (scenario.db === 'memory') {
    class MemoryLedgerSql {
      async identity() { return { ...identity }; }
      async snapshot(work) { return work(this); }
      async withWriterFence(work) { send('writer-fence'); return work(this); }
      async markerForSlot() { return null; }
      async markerForAttempt() { return null; }
      async tail(stream) { return { chainId: chains[validation.choice(stream, access.ACCESS_STREAMS)], sequence: 0, hash: '0'.repeat(64) }; }
      async entriesAfter() { return []; }
      async verificationPage(stream) { return { tail: await this.tail(stream), first: null, entries: [] }; }
      async entryForEvent() { return null; }
      async placement() { return []; }
    }
    storeModule.PrismaLedgerSql = MemoryLedgerSql;
    memorySql = new MemoryLedgerSql();
  }
  const RealStore = storeModule.AccessLedgerStore;
  const stores = [];
  // Crash cuts (pg): the request of /syn-atomic, the PG backend of its transaction, and the observed points where the
  // parent kills this whole process (P07 reserve-complete, P08 commit-complete, P09 withheld COMMIT acknowledgement,
  // P10 commit-entry with the backend terminated by the observer, P12 receipt-complete).
  let crashRequest = null, backendPid = null;
  const statusNow = async () => { try { return runtime ? await runtime.status() : null; } catch (error) { return { unavailable: error?.code ?? 'Error' }; } };
  const cut = async (point, extra = {}) => { send('crash-cut', { point, backendPid, eventId: crashRequest?.event.eventId, businessKey: crashRequest?.businessKey, ...extra }); await released; };
  storeModule.AccessLedgerStore = class ObservedLedgerStore extends RealStore {
    constructor(db, sql, state, journal, poolSize) {
      super(db, sql, state, journal, poolSize);
      stores.push(this);
      send('ledger', { sameClient: db === clients[clients.length - 1], poolSize, remote: !(state instanceof sealModule.AccessSeal) });
      if (scenario.crashCut && db._engine && typeof db._engine.transaction === 'function') {
        const transaction = db._engine.transaction.bind(db._engine);
        db._engine.transaction = async (action, ...args) => {
          if (action === 'commit' && crashRequest && scenario.crashCut === 'P10') await cut('commit-entry');
          const value = await transaction(action, ...args);
          if (action === 'commit' && crashRequest) {
            send('pg-commit-complete', { eventId: crashRequest.event.eventId });
            if (scenario.crashCut === 'P08') await cut('commit-complete');
            if (scenario.crashCut === 'P09') throw Object.assign(Error('successful COMMIT acknowledgement withheld'), { code: 'P1017' });
          }
          return value;
        };
      }
    }
    withAppendTransaction(callback) {
      return super.withAppendTransaction(async tx => {
        if (crashRequest) { const [row] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`; backendPid = row.pid; }
        return callback(tx);
      });
    }
    async appendWithin(scope, tx, input, served) {
      const result = await super.appendWithin(scope, tx, input, served);
      if (crashRequest && input.eventId === crashRequest.event.eventId) {
        send('append-reserved', { entries: result.entries.map(entry => ({ stream: entry.stream, sequence: entry.sequence, attemptId: entry.attemptId })) });
        if (scenario.crashCut === 'P07') await cut('reserve-complete');
      }
      return result;
    }
  };
  if (scenario.holdConfirm) {
    // The confirm of that one event (the service's complete proof, then the receipt) held: in flight when the stop arrives.
    const confirm = remoteState.RemoteLedgerScope.prototype.confirm;
    remoteState.RemoteLedgerScope.prototype.confirm = async function (appended) {
      if (appended.eventId === scenario.holdConfirm) {
        send('confirm-held', { eventId: appended.eventId });
        await released;
        send('confirm-released', { eventId: appended.eventId });
      }
      return confirm.call(this, appended);
    };
  }
  if (scenario.db === 'memory') {
    // A standalone append without SQL: a timed fake receipt over the live remote scope (the scope itself is the
    // service's), so the drain of begun recording work is observable.
    storeModule.AccessLedgerStore.prototype.appendWithin = async function (_scope, _tx, input) {
      send('append-begin', { eventId: input.eventId });
      await sleep(scenario.appendMillis ?? 300);
      send('append-end', { eventId: input.eventId });
      return Object.freeze({ provisional: true, eventId: input.eventId, entries: [] });
    };
    remoteState.RemoteLedgerScope.prototype.confirm = async function (appended) { return Object.freeze({ eventId: appended.eventId, durableAt: new Date().toISOString() }); };
  }

  // ── the protected-state service of this child (the API's counterpart): actual dispatcher, seal and writer ──
  // (memory only: with `db: 'pg'` the real StateClient reaches the real service process over its Unix socket.)
  const peers = [];
  if (scenario.db !== 'pg') {
  const serviceDirectory = process.env.KIN_TEST_STATE || stateDirectory('service');
  const instanceId = process.env.KIN_EMR_INSTANCE_ID;
  const coordinator = new coordinatorModule.StateCoordinator(serviceDirectory, writer.executeExternal);
  const journal = new journalModule.FailureJournal(serviceDirectory, coordinator);
  const seal = new sealModule.AccessSeal(serviceDirectory, memorySql, journal);
  const pair = { instanceId, chains: { ...chains }, database: { ...identity } };
  const service = new stateService.ProtectedStateService({ coordinator, journal, sql: memorySql, seal, pair }, () => send('service-failed'));
  const serviceStarted = scenario.service === 'absent' ? Promise.resolve() : service.start().then(() => send('service-ready'), error => send('service-start-failed', { code: error?.code ?? 'Error' }));
  // The API's client of that service: the same typed frames, dispatched in-process (no socket, worker or UID here).
  stateClientModule.StateClient = class FakeStateClient {
    constructor(endpoint) {
      this.role = typeof endpoint === 'object' && endpoint ? endpoint.role : 'api';
      this.loss = new AbortController();
      this.socket = new net.Socket(); peers.push(this.socket);
      send('state-client', { path: typeof endpoint === 'object' && endpoint ? endpoint.path : endpoint, role: this.role });
    }
    get unavailable() { return this.loss.signal; }
    async openSession(clientInstanceId) {
      await serviceStarted;
      if (scenario.service === 'absent') throw new protocol.StateProtocolError('UNAVAILABLE', 'unavailable');
      const hello = await service.dispatch(this.role, { v: 1, requestId: randomUUID(), serviceEpoch: null, session: null, workId: null,
        operation: 'hello', value: { protocol: 1, clientInstanceId } }, this.socket);
      if (!hello.ok) throw new protocol.StateProtocolError(hello.error.code, hello.error.outcome);
      this.session = { ...hello.result, serviceEpoch: hello.serviceEpoch, clientInstanceId };
      send('session', { instanceId: hello.result.instanceId });
      return this.session;
    }
    async callAsync(operation, workId, value) {
      if (this.loss.signal.aborted) throw new protocol.StateProtocolError('UNAVAILABLE', 'unavailable');
      const request = protocol.parseStateRequest({ v: 1, requestId: randomUUID(), serviceEpoch: this.session.serviceEpoch, session: this.session.session, workId, operation, value }, this.role);
      const response = await service.dispatch(this.role, request, this.socket);
      if (!response.ok) throw new protocol.StateProtocolError(response.error.code, response.error.outcome);
      return response.result;
    }
    lose() { this.loss.abort(new protocol.StateProtocolError('UNAVAILABLE', 'unavailable')); }
    async close() { send('state-client-close'); this.socket.destroy(); }
  };
  } else {
    const RealStateClient = stateClientModule.StateClient;
    stateClientModule.StateClient = class ObservedStateClient extends RealStateClient {
      constructor(endpoint) {
        super(endpoint);
        peers.push(this);
        send('state-client', { path: typeof endpoint === 'object' && endpoint ? endpoint.path : endpoint, role: typeof endpoint === 'object' && endpoint ? endpoint.role : 'api', real: true });
      }
      async openSession(clientInstanceId) {
        const session = await super.openSession(clientInstanceId);
        send('session', { instanceId: session.instanceId, serviceEpoch: session.serviceEpoch });
        return session;
      }
      close() { send('state-client-close'); return super.close(); }
    };
  }
  const stateClients = () => peers;

  const compose = composition.composeEmrAdapters;
  if (scenario.precompose) compose(context.runtimeAdapters);
  composition.composeEmrAdapters = adapters => {
    send('compose', { base: adapters === context.runtimeAdapters });
    return compose(adapters);
  };

  // ── the client runtime (the owner's counterpart in c) ──
  const application = load('emr-runtime/application');
  const recordPort = load('emr-runtime/record-port');
  const launcher = load('emr-runtime/launcher');
  const auth = load('auth.service');
  const Runtime = application.EmrApiClientRuntime;
  let runtime = null;
  const start = Runtime.prototype.start;
  Runtime.prototype.start = async function () {
    runtime = this;
    send('start');
    try {
      await start.call(this);
      send('ready');
      await hold('ready', () => leak('SYN_READY'));
    } catch (error) {
      send('start-failed', { phase: error?.phase ?? null, interrupted: error?.interrupted ?? null, code: error?.failure?.code ?? error?.code ?? null });
      throw error;
    }
  };
  const close = Runtime.prototype.close;
  Runtime.prototype.close = function () { send('owner-close'); return close.call(this); };
  const interrupt = Runtime.prototype.interrupt;
  Runtime.prototype.interrupt = function () { send('owner-interrupt'); return interrupt.call(this); };
  const authInit = auth.AuthService.prototype.onModuleInit;
  auth.AuthService.prototype.onModuleInit = function () { send('auth-init'); return authInit.call(this); };

  // ── Nest and the HTTP server ──
  let port = null;
  const portOf = () => port ?? (port = app.get(recordPort.EMR_RECORD_PORT));
  const create = core.NestFactory.create.bind(core.NestFactory);
  core.NestFactory.create = async (...args) => {
    send('create');
    if (scenario.lifecycleStage) {
      const hooks = ['onModuleInit', 'onApplicationBootstrap', 'onModuleDestroy', 'beforeApplicationShutdown', 'onApplicationShutdown'];
      const slow = Object.fromEntries(hooks.map(hook => [hook, async () => {
        send('peer-start', { hook });
        if (hook === scenario.lifecycleStage && scenario.hungHook) await new Promise(() => {});
        await sleep(80);
        send('peer-end', { hook });
      }]));
      const fast = Object.fromEntries(hooks.map(hook => [hook, () => {
        send('peer-fast', { hook });
        if (hook === scenario.lifecycleStage && !scenario.hungHook) throw Error('synthetic hook rejection');
      }]));
      args[0].providers.push({ provide: 'r2-slow', useValue: slow }, { provide: 'r2-fast', useValue: fast });
    }
    const created = await create(...args);
    app = created;
    send('created');
    if (scenario.observeAdmission) created.use((req, _res, next) => { send('http-entry', { url: req.url }); next(); });
    if (scenario.crashEvent) created.use('/syn-atomic', async (_req, res) => {
      // One public projected transaction: a synthetic business row and the event's streams, all-or-none; the receipt
      // only after the actual COMMIT and the service's complete proof; nothing of the body before it.
      const event = scenario.crashEvent, businessKey = 'r2-' + event.eventId;
      crashRequest = { event, businessKey };
      const work = portOf().begin();
      let token, callbackFailed = false;
      send('work-begun', { eventId: event.eventId });
      try {
        const provisional = await work.transaction(async tx => {
          token = tx;
          try {
            await tx.institution.upsert({ where: { id: businessKey }, create: { id: businessKey, name: 'Synthetic EMR B2' }, update: {} });
            return await work.appendInTransaction(tx, event);
          } catch (error) { callbackFailed = true; throw error; }
        });
        const receipt = await work.confirm(provisional);
        send('receipt-ready', { eventId: receipt.eventId, status: await statusNow() });
        if (scenario.crashCut === 'P12') await cut('receipt-complete');
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(receipt));
      } catch (error) {
        try { if (token) await work.settleTransaction(token, event, error, callbackFailed); else await work.settle(event, error); }
        catch (settling) { send('settle-failed', { code: settling?.code ?? settling?.name ?? 'Error' }); }
        send('crash-settled', { callbackFailed, code: error?.code ?? error?.name ?? 'Error', status: await statusNow() });
        // These ambiguous responses are deliberately withheld; the parent kills only after persisted settlement.
        if (scenario.crashCut === 'P09' || scenario.crashCut === 'P10') await released.then(() => new Promise(() => {}));
        res.statusCode = 503; res.end('unknown');
      } finally { work.end(); send('work-ended'); }
    });
    if (scenario.slowMillis) created.use('/syn-slow', (req, res) => {
      send('slow-begin');
      res.on('finish', () => send('slow-done'));
      setTimeout(() => res.end('slow-ok'), scenario.slowMillis);
    });
    created.use('/syn-record', (req, res) => {
      let work;
      try { work = portOf().begin(); } catch (error) { send('begin-refused', { code: error?.code ?? 'Error' }); res.statusCode = 503; return res.end('refused'); }
      send('work-begun');
      res.on('finish', () => {
        send('post-finish-append');
        const eventId = randomUUID();
        work.append(serviceEvent(eventId)).then(receipt => send('append-done', { eventId: receipt.eventId, same: receipt.eventId === eventId }),
          error => send('append-failed', { code: error?.code ?? error?.name ?? 'Error' }))
          .finally(() => { work.end(); send('work-ended'); });
      });
      setTimeout(() => res.end('recorded'), scenario.recordMillis ?? 0);
    });
    try { await hold('create', () => leak('SYN_CREATE')); }
    catch (error) { app = null; await created.close().catch(() => {}); throw error; }
    return created;
  };
  const init = NestApplication.prototype.init;
  NestApplication.prototype.init = async function () {
    send('init');
    if (scenario.initWork) {
      const work = this.get(recordPort.EMR_RECORD_PORT).begin();
      send('init-work-begun');
      work.append(serviceEvent(randomUUID()))
        .then(() => send('init-work-appended'), error => send('init-work-failed', { code: error?.code ?? 'Error' }))
        .finally(() => { work.end(); send('init-work-ended'); });
    }
    const result = await init.call(this);
    send('initialized');
    await hold('init', () => leak('SYN_INIT'));
    return result;
  };
  const flush = NestApplication.prototype.flushLogs;
  NestApplication.prototype.flushLogs = function () { send('flush'); return flush.call(this); };
  const listen = http.Server.prototype.listen;
  http.Server.prototype.listen = function (...args) {
    const options = args[0];
    if (options && typeof options === 'object' && options.port === 3000) {
      send('bind', { port: 3000, host: options.host, signal: options.signal instanceof AbortSignal });
      args[0] = { ...options, port: scenario.port ?? 0, host: '127.0.0.1' };
      this.once('listening', () => send('listening', { port: this.address().port, errorListeners: this.listenerCount('error') }));
    }
    return listen.apply(this, args);
  };
  if (scenario.hold === 'listen' || scenario.delayListen) {
    const dns = require('node:dns'), lookup = dns.lookup;
    let delayed = false;
    dns.lookup = function (host, ...rest) {
      if (host !== '127.0.0.1' || delayed) return lookup.call(this, host, ...rest);
      delayed = true;
      send('listen-dns');
      const wait = scenario.hold === 'listen' ? hold('listen', () => leak('SYN_LISTEN')) : sleep(scenario.delayListen);
      wait.then(() => { send('listen-dns-returned'); lookup.call(this, host, ...rest); }, () => send('listen-dns-rejected'));
    };
  }
  const serverClose = http.Server.prototype.close;
  http.Server.prototype.close = function (callback) {
    if (!this.listening) return serverClose.call(this, callback);
    send('server-close');
    return serverClose.call(this, (...result) => { send('server-closed'); if (callback) callback(...result); });
  };

  process.on('message', async command => {
    const cmd = typeof command === 'string' ? command : command?.cmd;
    try {
      if (cmd === 'release') release(command?.outcome ?? 'resolve');
      else if (cmd === 'signal') process.emit(command.signal, command.signal);
      else if (cmd === 'release-then-signal') { release(command.outcome ?? 'resolve'); process.emit(command.signal, command.signal); }
      else if (cmd === 'lose-service') {
        // The control session drops (the service went away): the API's own loss handler, nothing else.
        if (runtime && runtime.client) runtime.client.lose();
        send('service-lost-sent');
      } else if (cmd === 'begin') {
        try { const work = portOf().begin(); send('begin', { ok: true, keys: Object.keys(work).sort() }); work.end(); }
        catch (error) { send('begin', { ok: false, code: error?.code ?? 'Error' }); }
      } else if (cmd === 'port-facts') {
        const forbidden = ['seal', 'journal', 'coordinator', 'db', 'sql', 'store', 'ledger', 'client', 'recoverAtStart', 'recover', 'start',
          'close', 'interrupt', 'compose', 'requireResources', 'withWriterFence', 'constructor', '__proto__', 'session', 'remote', 'status'];
        const given = portOf();
        const work = given.begin();
        send('port-facts', { same: app.get(recordPort.EMR_RECORD_PORT) === given, keys: Object.keys(given), prototypeNull: Object.getPrototypeOf(given) === null,
          frozen: Object.isFrozen(given), present: forbidden.filter(key => key in given), workKeys: Object.keys(work).sort(),
          workPrototypeNull: Object.getPrototypeOf(work) === null, workPresent: forbidden.filter(key => key in work),
          clients: clients.length, stores: stores.length, stateClients: stateClients().length, ordinarySeparate: app.get(prismaModule.PrismaService) !== clients[0] });
        work.end();
      } else if (cmd === 'launch-again') {
        const again = await launcher.launchApi({ env: process.env, root: () => class {}, configure: () => {} }).then(() => 'started', error => error?.code ?? 'Error');
        send('launch-again', { again });
      } else if (cmd === 'modules') {
        send('modules', { clinical: Object.keys(require.cache).map(name => name.replaceAll('\\', '/'))
          .filter(name => /\/(emr-clinical|emr-signature)\//.test(name)) });
      } else if (cmd === 'record-work') {
        const work = portOf().begin();
        const eventId = command.eventId ?? randomUUID();
        send('work-begun', { eventId });
        work.append(serviceEvent(eventId)).then(receipt => send('append-done', { eventId: receipt.eventId, same: receipt.eventId === eventId }),
          error => send('append-failed', { code: error?.code ?? error?.name ?? 'Error' }))
          .finally(() => { work.end(); send('work-ended'); });
      } else if (cmd === 'record-transaction') {
        // Real business transaction through the port (pg): a business statement and the fact in one transaction, the
        // receipt after the commit; with `fail`, the callback throws after the append and the attempt is settled.
        const work = portOf().begin();
        const eventId = command.eventId ?? randomUUID();
        let transaction = null, callbackFailed = false;
        const event = command.change ? changeEvent(eventId) : serviceEvent(eventId);
        try {
          const appended = await work.transaction(async tx => {
            transaction = tx;
            await tx.institution.findMany({ take: 1, select: { id: true } });
            try {
              const provisional = await work.appendInTransaction(tx, event);
              if (command.fail) throw new Error('synthetic-business-failure');
              // `holdTransaction`: the transaction stays open (its fact reserved, not committed) until the parent releases it.
              if (scenario.holdTransaction) { send('transaction-held', { eventId }); await released; send('transaction-released'); }
              return provisional;
            } catch (error) { callbackFailed = true; throw error; }
          });
          const receipt = await work.confirm(appended);
          send('transaction-done', { eventId: receipt.eventId, same: receipt.eventId === eventId, entries: appended.entries.length });
        } catch (error) {
          try { await work.settleTransaction(transaction, event, error, callbackFailed); }
          catch (settling) { send('settle-failed', { code: settling?.code ?? settling?.name ?? 'Error' }); }
          send('transaction-settled', { callbackFailed, code: error?.code ?? error?.message ?? 'Error', status: await statusNow() });
        } finally { work.end(); send('work-ended'); }
      } else if (cmd === 'status') {
        send('status', { status: await statusNow() });
      }
    } catch (error) { send('command-error', { cmd, code: error?.code ?? error?.name ?? 'Error', message: String(error?.message ?? '').slice(0, 200) }); }
  });
  load('main');
}

// ═══════════════════════════════════════ the state service (pg, image) ═══════════════════════════════════════

/**
 * `node startup_fixture.cjs --service '<scenario>'`: the real `state-serve-v3` entry (launchStateService over this
 * process's environment, UID 1000 in the image) with its seal observed. Events go to the file named by
 * KIN_EMR_B2_SERVICE_EVENTS (one JSON line each; a bind-mounted control directory the observer reads), never to
 * stdout, whose EMR_STATE_READY/CLOSED/INCOMPLETE lines are the product's. `hold: [points]` pauses inside that step
 * until the file `<control>/release-<label>-<point>` exists; `cut: 'viewing-sealed'` with `cutEvent` blocks after
 * that event's viewing seal advanced and before its history seal (the observer then kills this process); `storage:
 * {cut, eventId}` injects one syscall failure into the seal's WAL/checkpoint write path while that event is confirmed
 * (wal-flush | wal-torn-write | checkpoint-rename), as state_service_test's storageFailure does.
 */
function serviceChild(scenario) {
  const events = process.env.KIN_EMR_B2_SERVICE_EVENTS;
  const control = path.dirname(events);
  const label = scenario.label || 'service';
  const send = (what, extra = {}) => { try { fs.appendFileSync(events, JSON.stringify({ what, at: Date.now(), pid: process.pid, label, ...extra }) + '\n'); } catch {} };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const hold = async point => {
    if (!(scenario.hold || []).includes(point)) return;
    send('held', { point });
    const file = path.join(control, 'release-' + label + '-' + point);
    while (!fs.existsSync(file)) await sleep(50);
    send('released', { point });
  };
  const load = name => require('/app/dist/' + name);
  const sealModule = load('emr-runtime/seal');
  // Diagnostics of a start that the product closes silently: every coordinator operation but reads, the database
  // connection, and a recovery that throws, with their error codes (never values).
  const coordinatorModule = load('emr-runtime/coordinator');
  const coordinatorCall = coordinatorModule.StateCoordinator.prototype.call;
  coordinatorModule.StateCoordinator.prototype.call = function (operation, ...args) {
    try {
      const result = coordinatorCall.call(this, operation, ...args);
      if (operation !== 'read') send('coordinator', { operation, ok: true });
      return result;
    } catch (error) { send('coordinator', { operation, ok: false, code: error?.code ?? error?.name ?? 'Error', outcome: error?.outcome ?? null }); throw error; }
  };
  const { PrismaClient } = require('/app/node_modules/@prisma/client');
  const connect = PrismaClient.prototype.$connect;
  PrismaClient.prototype.$connect = async function () {
    try { const result = await connect.call(this); send('db-connect', { ok: true }); return result; }
    catch (error) { send('db-connect', { ok: false, code: error?.code ?? error?.name ?? 'Error' }); throw error; }
  };
  const recover = sealModule.AccessSeal.prototype.recoverAtStart;
  sealModule.AccessSeal.prototype.recoverAtStart = async function (...args) {
    send('recovery', { serviceEpoch: args[1] ?? null });
    await hold('recovery');
    let result;
    try { result = await recover.apply(this, args); }
    catch (error) { send('recovery-failed', { code: error?.code ?? error?.name ?? 'Error' }); throw error; }
    send('recovered', { recovered: result.recovered, notCommitted: result.notCommitted, streams: result.streams, serviceEpoch: args[1] ?? null });
    await hold('recovered');
    return result;
  };
  let faultArmed = false;
  const advance = sealModule.AccessSeal.prototype.advanceReceipt;
  sealModule.AccessSeal.prototype.advanceReceipt = async function (stream, attemptId, eventId, entry) {
    if (scenario.storage && eventId === scenario.storage.eventId) faultArmed = true;
    const value = await advance.call(this, stream, attemptId, eventId, entry);
    send('advanced', { stream, eventId });
    if (scenario.cut === 'viewing-sealed' && stream === 'viewing' && eventId === scenario.cutEvent) {
      send('viewing-sealed', { eventId });
      await new Promise(() => {});
    }
    return value;
  };
  if (scenario.storage) {
    const originals = { writeFileSync: fs.writeFileSync, fdatasyncSync: fs.fdatasyncSync, renameSync: fs.renameSync };
    let hits = 0;
    const wal = name => typeof name === 'string' && name.endsWith('seal/settlement.jsonl');
    const isWal = fd => { try { return typeof fd === 'number' && fs.readlinkSync('/proc/self/fd/' + fd).endsWith('seal/settlement.jsonl'); } catch { return false; } };
    const fail = () => { hits++; send('storage-fault', { cut: scenario.storage.cut, hits }); throw Object.assign(new Error('synthetic storage interruption'), { code: 'EIO' }); };
    fs.writeFileSync = (file, data, ...args) => {
      if (faultArmed && hits === 0 && (wal(file) || isWal(file)) && scenario.storage.cut === 'wal-torn-write') {
        const bytes = Buffer.from(data);
        originals.writeFileSync(file, bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))), ...args);
        fail();
      }
      return originals.writeFileSync(file, data, ...args);
    };
    fs.fdatasyncSync = fd => {
      if (faultArmed && hits === 0 && isWal(fd) && scenario.storage.cut === 'wal-flush') fail();
      return originals.fdatasyncSync(fd);
    };
    fs.renameSync = (from, to) => {
      if (faultArmed && hits === 0 && typeof to === 'string' && to.endsWith('seal/settlement.json') && scenario.storage.cut === 'checkpoint-rename') fail();
      return originals.renameSync(from, to);
    };
  }
  send('launch', { argv: process.argv.slice(2), uid: process.getuid?.() ?? null });
  load('emr-runtime/state-service').launchStateService(process.env).then(code => { send('exit', { code }); process.exit(code); }, error => {
    send('failed', { code: error?.code ?? error?.name ?? 'Error' });
    process.stderr.write('EMR_STATE_FAILED\n');
    process.exit(1);
  });
}

if (require.main === module) {
  if (process.argv[2] === '--service') serviceChild(JSON.parse(process.argv[3] || '{}'));
  else child(JSON.parse(process.argv[2] || '{}'));
}

module.exports = { run, environment, stateDirectory, stop, serviceEvent, changeEvent, SIGNAL_MODE };
