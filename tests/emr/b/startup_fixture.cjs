'use strict';
/* EMR-B2-BASE test helper (TEST-B2SH-01, 04-07): the real API start in its own child process.
 *
 * Parent side: `run(scenario, options)` starts `node startup_fixture.cjs <scenario>` with the scenario's environment. The
 * child's stdout, stderr and the events it reports over the IPC channel (never over stdout/stderr, whose bytes are part of
 * what the cases judge) are streamed to files in a run directory; the parent keeps only a bounded summary: exit code or
 * signal, the first 64 KiB of each stream and its byte count, and at most 400 events (an overflow is reported, never
 * dropped silently). Each child is a separate process, so A's one-time composition, the writer fence and Nest's logger
 * never cross cases or the contract suite's own process.
 *
 * Child side: it loads the real compiled modules - /app/dist in the API image, else api/src through
 * tests/service_test_loader.cjs - observes the product calls by wrapping exports of the loaded modules, applies the
 * scenario's test-side substitutions, and then requires the real main.ts, whose bootstrap runs unchanged. Substitutions
 * are test-side only and named by the scenario: `db: 'memory'` replaces the two database clients (the dedicated
 * EmrLedgerClient by a fake answering the runtime-role catalog, PrismaLedgerSql by the in-memory empty-ledger model the B
 * contract cases use, the ordinary PrismaService by a fake whose reads are empty) so the start runs without PostgreSQL;
 * `db: 'pg'` keeps every product class (tests/emr/b/startup_pg_test.cjs over a disposable database). The fence, the
 * failure journal, the seal and their recovery are always the product's own (Linux: /usr/bin/flock). `hold: 'connect' |
 * 'role' | 'recovery'` pauses the start inside that wait until the parent sends 'release' (a shutdown during the start).
 * A listener on port 3000 is moved to 127.0.0.1 and the scenario's port (0 = any). There is no product reset, binding or
 * test switch.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const HEAD_BYTES = 64 * 1024, MAX_EVENTS = 400;

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
          events, names: events.map(event => event.what), overflow,
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
  // Every event reaches the parent before the process ends: main's process.exit and Nest's re-raised signal wait for the
  // IPC channel to take a last message (bounded, so a broken channel never keeps the process alive).
  const finish = end => {
    if (!process.send || !process.connected) return end();
    const fallback = setTimeout(end, 1000);
    process.send({ what: 'ending', at: performance.now() }, () => { clearTimeout(fallback); end(); });
  };
  const exit = process.exit.bind(process), kill = process.kill.bind(process);
  process.exit = code => finish(() => exit(code));
  process.kill = (pid, signal) => (pid === process.pid ? finish(() => kill(pid, signal)) : kill(pid, signal));
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
  // A start that waits at `scenario.hold` until the parent releases it (a stop signal arrives meanwhile).
  let release = null;
  const released = new Promise(resolve => { release = resolve; });
  const hold = async point => {
    if (scenario.hold !== point) return;
    send('held', { point });
    await released;
    send('released', { point });
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
  const sealModule = load('emr-runtime/seal');
  const storeModule = load('emr-runtime/store');
  const manifest = load('emr-runtime/manifest');
  const application = load('emr-runtime/application');
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
      await hold('connect');
      await super.$connect();
      send('connected');
    }
    async $disconnect() { send('disconnect'); return super.$disconnect(); }
  }
  clientModule.EmrLedgerClient = ObservedLedgerClient;
  const verify = manifest.verifyRuntimeConnection;
  manifest.verifyRuntimeConnection = async db => { send('role'); await hold('role'); return verify(db); };

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
  const RealCoordinator = coordinatorModule.StateCoordinator;
  coordinatorModule.StateCoordinator = class ObservedCoordinator extends RealCoordinator {
    constructor(...args) { super(...args); send('fence', { owner: this.holdsWriterFence }); }
  };
  const recover = sealModule.AccessSeal.prototype.recoverAtStart;
  sealModule.AccessSeal.prototype.recoverAtStart = async function () {
    send('recovery');
    if (scenario.recovery === 'refuse') throw new sealModule.SealRefused('SealCorrupt', 'postgresql://kin_runtime:Leaked-Secret-0004@db/kin');
    const result = await recover.call(this);
    await hold('recovery');
    send('recovered', { recovered: result.recovered, notCommitted: result.notCommitted });
    return result;
  };
  const compose = composition.composeEmrAdapters;
  if (scenario.precompose) compose(context.runtimeAdapters);
  composition.composeEmrAdapters = adapters => {
    send('compose', { base: adapters === context.runtimeAdapters });
    return compose(adapters);
  };

  // ── the owner and its Nest holder ──
  const Owner = application.EmrRuntimeOwner, Holder = application.EmrApplicationRuntime;
  let runtime = null;
  const start = Owner.prototype.start;
  Owner.prototype.start = async function () {
    send('start');
    try {
      await start.call(this);
      send('ready');
    } catch (error) {
      send('start-failed', { phase: error?.phase ?? null, interrupted: error?.interrupted ?? null, code: error?.failure?.code ?? error?.code ?? null });
      throw error;
    }
  };
  const close = Owner.prototype.close;
  Owner.prototype.close = function () { send('owner-close'); return close.call(this); };
  const holderStart = Holder.prototype.start;
  Holder.prototype.start = function () { runtime = this; return holderStart.call(this); };
  const shutdown = Holder.prototype.onApplicationShutdown;
  Holder.prototype.onApplicationShutdown = function () { send('runtime-onApplicationShutdown'); return shutdown.call(this); };
  const authInit = auth.AuthService.prototype.onModuleInit;
  auth.AuthService.prototype.onModuleInit = function () { send('auth-init'); return authInit.call(this); };

  // ── Nest and the HTTP server ──
  let app = null;
  const create = core.NestFactory.create.bind(core.NestFactory);
  core.NestFactory.create = async (...args) => {
    app = await create(...args);
    send('created');
    // A synthetic request that is still running when SIGTERM arrives (test-side, before main's own middleware).
    if (scenario.slowMillis) app.use('/syn-slow', (req, res) => {
      send('slow-begin');
      res.on('finish', () => send('slow-done'));
      setTimeout(() => res.end('slow-ok'), scenario.slowMillis);
    });
    return app;
  };
  const init = NestApplication.prototype.init;
  NestApplication.prototype.init = async function () { send('init'); const result = await init.call(this); send('initialized'); return result; };
  const listen = http.Server.prototype.listen;
  http.Server.prototype.listen = function (...args) {
    if (args[0] === 3000) {
      send('bind', { port: 3000 });
      args[0] = scenario.port ?? 0;
      if (typeof args[1] === 'string') args[1] = '127.0.0.1';
      this.once('listening', () => send('listening', { port: this.address().port }));
    }
    return listen.apply(this, args);
  };
  const serverClose = http.Server.prototype.close;
  http.Server.prototype.close = function (callback) {
    if (!this.listening) return serverClose.call(this, callback);
    send('server-close');
    return serverClose.call(this, (...result) => { send('server-closed'); if (callback) callback(...result); });
  };

  // ── what the scenario checks or asks once the server listens (or while the start is held) ──
  process.on('message', async command => {
    try {
      if (command === 'release') release();
      else if (command === 'resources') {
        const first = runtime.requireResources(), second = runtime.requireResources();
        send('resources', { same: first === second, frozen: Object.isFrozen(first), keys: Object.keys(first).sort(),
          client: first.db === clients[0], clients: clients.length, ledger: first.ledger === stores[0], stores: stores.length,
          base: first.adapters === context.runtimeAdapters, ordinarySeparate: app.get(prismaModule.PrismaService) !== first.db,
          poolSize: first.db.emrAppendPoolSize });
      } else if (command === 'modules') {
        send('modules', { clinical: Object.keys(require.cache).map(name => name.replaceAll('\\', '/'))
          .filter(name => /\/(emr-clinical|emr-signature)\//.test(name)) });
      } else if (command === 'reenter') {
        const code = async work => { try { await work(); return 'accepted'; } catch (error) { return error?.code ?? error?.name ?? 'Error'; } };
        const resources = runtime.requireResources();
        send('reenter-ready', { again: await code(() => runtime.start()), same: runtime.requireResources() === resources });
        await app.close();
        send('reenter-stopped', { resources: await code(() => runtime.requireResources()), again: await code(() => runtime.start()) });
        process.exit(0);
      }
    } catch (error) { send('command-error', { code: error?.code ?? error?.name ?? 'Error' }); }
  });
  load('main');
}

if (require.main === module) child(JSON.parse(process.argv[2] || '{}'));

module.exports = { run, environment, stateDirectory };
