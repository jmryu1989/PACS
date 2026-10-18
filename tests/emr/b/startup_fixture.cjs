'use strict';
/* EMR-B2 (d) test helper (TEST-B2R-02/03/04/05): the real API start in its own child process.
 *
 * Parent side: `run(scenario, options)` starts `node startup_fixture.cjs <scenario>` with the scenario's environment. The
 * child's stdout, stderr and the events it reports over the IPC channel (never over stdout/stderr, whose bytes are part of
 * what the cases judge) are streamed to files in a run directory; the parent keeps only a bounded summary: exit code or
 * signal, the first 64 KiB of each stream and its byte count, and at most 400 events (an overflow is reported, never
 * dropped silently). Each child is a separate process, so the launcher's one-per-process latch, A's one-time composition,
 * the writer fence and Nest's logger never cross cases or the contract suite's own process. `stop(child, signal)` sends
 * SIGTERM/SIGINT: the OS signal on Linux, else the child's own `process.emit` (Windows has no OS signal delivery to a
 * handler; the parent reports which it used - the OS-signal evidence is the Linux run).
 *
 * Child side: it loads the real compiled modules - /app/dist in the API image, else api/src through
 * tests/service_test_loader.cjs - observes the product calls by wrapping exports of the loaded modules, applies the
 * scenario's test-side substitutions, and then requires the real main.ts, whose bootstrap and launcher run unchanged.
 * Substitutions are test-side only and named by the scenario: `db: 'memory'` replaces the two database clients (the
 * dedicated EmrLedgerClient by a fake answering the runtime-role catalog, PrismaLedgerSql by the in-memory empty-ledger
 * model the B contract cases use, the ordinary PrismaService by a fake whose reads are empty, the store's standalone
 * append by a timed fake receipt) so the start runs without PostgreSQL; `db: 'pg'` keeps every product class
 * (tests/emr/b/startup_pg_test.cjs over a disposable database). `state: 'inert'` replaces the writer fence, the failure
 * journal and the seal by inert doubles (a host without flock); otherwise they are the product's own (Linux:
 * /usr/bin/flock). `hold: 'connect' | 'role' | 'recovery' | 'create' | 'init' | 'listen'` pauses the start inside that
 * wait until the parent sends `release` (with `outcome: 'reject'` the held step then fails). A listener on port 3000 is
 * moved to 127.0.0.1 and the scenario's port (0 = any). There is no product reset, binding or test switch.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const HEAD_BYTES = 64 * 1024, MAX_EVENTS = 400;
/** How a stop signal reaches the child on this host: the OS signal, or the child's own process.emit over IPC. */
const SIGNAL_MODE = process.platform === 'linux' ? 'kill' : 'emit';

/** A fresh protected state directory (0700) as the deployment's volume would be. */
function stateDirectory(label = 'state') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `emr-b2-${label}-`));
  fs.chmodSync(dir, 0o700);
  return dir;
}

/** The API's environment for a scenario: production-shaped, synthetic, nothing reachable. */
function environment(state, overrides = {}) {
  const base = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, HOME: process.env.HOME,
    NODE_OPTIONS: '--max-old-space-size=1024',
    DEPLOYMENT_MODE: 'production', AUTH_REQUIRED: 'true',
    DATABASE_URL: 'postgresql://kin_runtime:Synthetic-Fixture-Secret-0001@127.0.0.1:1/kin?connect_timeout=2',
    KIN_EMR_STATE_DIR: state,
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

/**
 * Run one scenario. `options.env` is the child's whole environment; `options.onEvent(event, child, events)` may act on an
 * event (send a request or a command, signal the child); the result resolves when the child exits or after
 * `options.timeoutMs`. The run directory (stdout.log, stderr.log, events.jsonl) is removed afterwards unless
 * KIN_EMR_B2_KEEP_RUNS is set; its path is in the result either way.
 */
function run(scenario, options = {}) {
  return new Promise(resolve => {
    const started = performance.now();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emr-b2-run-'));
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
    // A command sent after the child ended is recorded, never thrown into the parent's own test.
    child.on('error', error => record({ what: 'parent-error', message: String(error && error.code) }));
    // Ended by hand once the child closed, so the summary is read only after every byte reached its file.
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
  const send = (what, extra = {}) => { if (process.send && process.connected) process.send({ what, at: performance.now(), ...extra }); };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let app = null;
  // Every event reaches the parent before the process ends: the launcher's process.exit waits for the IPC channel to
  // take a last message (bounded, so a broken channel never keeps the process alive).
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
    // The loader's own transpile, kept by source hash so the many children of one run compile each file once.
    const { createHash } = require('node:crypto');
    const cache = path.join(os.tmpdir(), 'emr-b2-startup-ts-' + createHash('sha256').update(fs.readFileSync(loader)).digest('hex').slice(0, 16));
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
  // A start that waits at `scenario.hold` until the parent releases it (a stop signal arrives meanwhile); the release
  // may make the held step fail instead.
  let release = null;
  const released = new Promise(resolve => { release = resolve; });
  const hold = async (point, reject) => {
    if (scenario.hold !== point) return;
    send('held', { point });
    const outcome = await released;
    send('released', { point, outcome });
    if (outcome === 'reject') throw reject();
  };

  // The two substituted providers are replaced before any module that names them loads (their constructor tokens are
  // read when each dependent class is defined).
  const prismaModule = load('prisma.service');
  // ── the ordinary database client (memory): reads answer empty, writes nothing ──
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
      // `slowDestroy: ms`: a co-provider whose destroy hook awaits (Nest runs every destroy hook before the shutdown hooks).
      async onModuleDestroy() {
        send('destroy');
        if (scenario.slowDestroy) await sleep(scenario.slowDestroy);
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

  // ── the writer fence, the failure journal and the seal (inert): a host without flock runs the launcher's order ──
  if (scenario.state === 'inert') {
    coordinatorModule.StateCoordinator = class InertCoordinator {
      constructor(directory) { this.directory = directory; this.ownerId = 'inert-owner'; this.role = 'api'; }
      get holdsWriterFence() { return true; }
      ownerAlive() { return true; }
      call() { return undefined; }
    };
    journalModule.FailureJournal = class InertJournal {
      constructor(directory, coordinator) { this.coordinator = coordinator; this.tornBytes = 0; }
      record(id, kind, body) { return Object.freeze({ id, kind, body }); }
      all() { return []; }
      find() { return undefined; }
    };
    sealModule.AccessSeal = class InertSeal {
      async recoverAtStart() { return { seal: null, recovered: 0, notCommitted: 0, streams: {} }; }
      read() { return 'absent'; }
    };
  }
  const application = load('emr-runtime/application');
  const recordPort = load('emr-runtime/record-port');
  const launcher = load('emr-runtime/launcher');
  const auth = load('auth.service');

  // ── the dedicated ledger client: observed (pg) or a fake answering the runtime-role catalog (memory) ──
  const RealClient = clientModule.EmrLedgerClient;
  class FakeLedgerClient {
    constructor(url) {
      const pool = admission.appendPoolConfiguration(url);
      this.emrAppendPoolSize = pool.poolSize;
      this.connectionLimit = Number(new URL(pool.url).searchParams.get('connection_limit'));
    }
    async $connect() { if (scenario.connect === 'refuse') throw failure(leak('P1001')); }
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
  if (scenario.db === 'memory') {
    const chains = { viewing: '7c1f3a52-0000-4000-8000-000000000001', history: '7c1f3a52-0000-4000-8000-000000000002' };
    class MemoryLedgerSql {
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
  }
  const RealStore = storeModule.AccessLedgerStore;
  const stores = [];
  storeModule.AccessLedgerStore = class ObservedLedgerStore extends RealStore {
    constructor(db, sql, seal, journal, poolSize) {
      super(db, sql, seal, journal, poolSize);
      stores.push(this);
      send('ledger', { sameClient: db === clients[clients.length - 1], poolSize });
    }
  };
  if (scenario.db === 'memory') {
    // A standalone append without SQL: a timed fake receipt, so the drain of begun recording work is observable.
    storeModule.AccessLedgerStore.prototype.append = async function (input) {
      send('append-begin', { eventId: input.eventId });
      await sleep(scenario.appendMillis ?? 300);
      send('append-end', { eventId: input.eventId });
      return Object.freeze({ eventId: input.eventId, durableAt: new Date().toISOString() });
    };
  }
  const RealCoordinator = coordinatorModule.StateCoordinator;
  coordinatorModule.StateCoordinator = class ObservedCoordinator extends RealCoordinator {
    constructor(...args) { super(...args); send('fence', { owner: this.holdsWriterFence }); }
  };
  const recover = sealModule.AccessSeal.prototype.recoverAtStart;
  sealModule.AccessSeal.prototype.recoverAtStart = async function () {
    send('recovery');
    if (scenario.recovery === 'refuse') throw new sealModule.SealRefused('SealCorrupt', 'postgresql://kin_runtime:Leaked-Secret-0004@db/kin');
    const result = await recover.call(this);
    await hold('recovery', () => new sealModule.SealRefused('SealCorrupt', 'postgresql://kin_runtime:Leaked-Secret-0004@db/kin'));
    send('recovered', { recovered: result.recovered, notCommitted: result.notCommitted });
    return result;
  };
  if (scenario.holdConfirm) {
    // The seal's receipt advance of that one event held (pg): its confirm is in flight when the stop arrives.
    const advance = sealModule.AccessSeal.prototype.advanceReceipt;
    sealModule.AccessSeal.prototype.advanceReceipt = async function (stream, attemptId, eventId, ...rest) {
      if (eventId === scenario.holdConfirm) {
        send('confirm-held', { eventId });
        await released;
        send('confirm-released', { eventId });
      }
      return advance.call(this, stream, attemptId, eventId, ...rest);
    };
  }
  const compose = composition.composeEmrAdapters;
  if (scenario.precompose) compose(context.runtimeAdapters);
  composition.composeEmrAdapters = adapters => {
    send('compose', { base: adapters === context.runtimeAdapters });
    return compose(adapters);
  };

  // ── the owner ──
  const Owner = application.EmrRuntimeOwner;
  const start = Owner.prototype.start;
  Owner.prototype.start = async function () {
    send('start');
    try {
      await start.call(this);
      send('ready');
      // `hold: 'ready'`: the owner is ready, its start has resolved, and the launcher's turn has not come yet.
      await hold('ready', () => leak('SYN_READY'));
    } catch (error) {
      send('start-failed', { phase: error?.phase ?? null, interrupted: error?.interrupted ?? null, code: error?.failure?.code ?? error?.code ?? null });
      throw error;
    }
  };
  const close = Owner.prototype.close;
  Owner.prototype.close = function () { send('owner-close'); return close.call(this); };
  const interrupt = Owner.prototype.interrupt;
  Owner.prototype.interrupt = function () { send('owner-interrupt'); return interrupt.call(this); };
  const authInit = auth.AuthService.prototype.onModuleInit;
  auth.AuthService.prototype.onModuleInit = function () { send('auth-init'); return authInit.call(this); };
  if (scenario.db !== 'memory') {
    // The real providers' hooks observed (pg): the same `destroy` / `prisma-shutdown` marks the memory doubles send.
    const authDestroy = auth.AuthService.prototype.onModuleDestroy;
    auth.AuthService.prototype.onModuleDestroy = function () { send('destroy'); const result = authDestroy.call(this); send('destroy-done'); return result; };
    const prismaShutdown = prismaModule.PrismaService.prototype.onApplicationShutdown;
    prismaModule.PrismaService.prototype.onApplicationShutdown = function (...args) { send('prisma-shutdown'); return prismaShutdown.apply(this, args); };
  }

  // ── Nest and the HTTP server ──
  let port = null;
  const portOf = () => port ?? (port = app.get(recordPort.EMR_RECORD_PORT));
  const create = core.NestFactory.create.bind(core.NestFactory);
  core.NestFactory.create = async (...args) => {
    send('create');
    const created = await create(...args);
    app = created;
    send('created');
    // Synthetic requests (test-side, before main's own middleware): one that is still running when a stop arrives, and
    // one that begins recording work at its start and writes a record after its response finished.
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
        const eventId = require('node:crypto').randomUUID();
        work.append(serviceEvent(eventId)).then(receipt => send('append-done', { eventId: receipt.eventId, same: receipt.eventId === eventId }),
          error => send('append-failed', { code: error?.code ?? error?.name ?? 'Error' }))
          .finally(() => { work.end(); send('work-ended'); });
      });
      setTimeout(() => res.end('recorded'), scenario.recordMillis ?? 0);
    });
    // A create that fails after the stop: Nest hands no application on, so the one built here is closed here (as a
    // failed NestFactory.create leaves none behind); the launcher sees only the rejection.
    try { await hold('create', () => leak('SYN_CREATE')); }
    catch (error) { app = null; await created.close().catch(() => {}); throw error; }
    return created;
  };
  const init = NestApplication.prototype.init;
  NestApplication.prototype.init = async function () {
    send('init');
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
    // The bind's address lookup (also for an IP literal) returns later: the stop arrives while the listen is pending.
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

  // ── what the scenario checks or asks once the server listens (or while the start is held) ──
  process.on('message', async command => {
    const cmd = typeof command === 'string' ? command : command?.cmd;
    try {
      if (cmd === 'release') release(command?.outcome ?? 'resolve');
      else if (cmd === 'signal') process.emit(command.signal, command.signal);
      else if (cmd === 'release-then-signal') { release(command.outcome ?? 'resolve'); process.emit(command.signal, command.signal); }
      else if (cmd === 'begin') {
        try { const work = portOf().begin(); send('begin', { ok: true, keys: Object.keys(work).sort() }); work.end(); }
        catch (error) { send('begin', { ok: false, code: error?.code ?? 'Error' }); }
      } else if (cmd === 'port-facts') {
        const forbidden = ['seal', 'journal', 'coordinator', 'db', 'sql', 'store', 'ledger', 'client', 'recoverAtStart', 'recover', 'start',
          'close', 'interrupt', 'compose', 'requireResources', 'withWriterFence', 'constructor', '__proto__'];
        const given = portOf();
        const work = given.begin();
        send('port-facts', { same: app.get(recordPort.EMR_RECORD_PORT) === given, keys: Object.keys(given), prototypeNull: Object.getPrototypeOf(given) === null,
          frozen: Object.isFrozen(given), present: forbidden.filter(key => key in given), workKeys: Object.keys(work).sort(),
          workPrototypeNull: Object.getPrototypeOf(work) === null, workPresent: forbidden.filter(key => key in work),
          clients: clients.length, stores: stores.length, ordinarySeparate: app.get(prismaModule.PrismaService) !== clients[0] });
        work.end();
      } else if (cmd === 'launch-again') {
        const again = await launcher.launchApi({ env: process.env, root: () => class {}, configure: () => {} }).then(() => 'started', error => error?.code ?? 'Error');
        send('launch-again', { again });
      } else if (cmd === 'modules') {
        send('modules', { clinical: Object.keys(require.cache).map(name => name.replaceAll('\\', '/'))
          .filter(name => /\/(emr-clinical|emr-signature)\//.test(name)) });
      } else if (cmd === 'record-work') {
        // Real ledger work through the port (pg): one standalone fact, then the stop may arrive while it confirms.
        const work = portOf().begin();
        const eventId = command.eventId ?? require('node:crypto').randomUUID();
        send('work-begun', { eventId });
        work.append(serviceEvent(eventId)).then(receipt => send('append-done', { eventId: receipt.eventId, same: receipt.eventId === eventId }),
          error => send('append-failed', { code: error?.code ?? error?.name ?? 'Error' }))
          .finally(() => { work.end(); send('work-ended'); });
      } else if (cmd === 'record-transaction') {
        // Real business transaction through the port (pg): a business statement and the fact in one transaction, the
        // receipt after the commit; with `fail`, the callback throws after the append and the attempt is settled.
        const work = portOf().begin();
        const eventId = command.eventId ?? require('node:crypto').randomUUID();
        let transaction = null, callbackFailed = false;
        const event = serviceEvent(eventId);
        try {
          const appended = await work.transaction(async tx => {
            transaction = tx;
            await tx.$queryRaw`SELECT 1 AS business_statement`;
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
          await work.settleTransaction(transaction, event, error, callbackFailed);
          send('transaction-settled', { callbackFailed, code: error?.code ?? error?.message ?? 'Error' });
        } finally { work.end(); send('work-ended'); }
      }
    } catch (error) { send('command-error', { cmd, code: error?.code ?? error?.name ?? 'Error', message: String(error?.message ?? '').slice(0, 200) }); }
  });
  load('main');
}

if (require.main === module) child(JSON.parse(process.argv[2] || '{}'));

module.exports = { run, environment, stateDirectory, stop, serviceEvent, SIGNAL_MODE };
