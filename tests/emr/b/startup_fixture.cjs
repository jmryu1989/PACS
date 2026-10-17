'use strict';
/* EMR-B2-BASE test helper (TEST-B2SH-01, 02, 04-07): the real API start in its own child process.
 *
 * Parent side: `run(scenario, options)` starts `node startup_fixture.cjs <scenario>` with the scenario's environment and
 * returns its exit code or signal, stdout, stderr and the ordered events the child reported over the IPC channel (never
 * over stdout/stderr, whose bytes are part of what the cases judge). Each child is a separate process, so A's one-time
 * composition, the writer fence and Nest's logger never cross cases or the contract suite's own process.
 *
 * Child side: it loads the real compiled modules - /app/dist in the API image, else api/src through
 * tests/service_test_loader.cjs - observes the product calls by wrapping exports of the loaded modules, applies the
 * scenario's test-side substitutions, and then requires the real main.ts, whose bootstrap runs unchanged. Substitutions
 * are test-side only and named by the scenario: `db: 'memory'` replaces the two database clients (the dedicated
 * EmrLedgerClient by a fake answering the runtime-role catalog, PrismaLedgerSql by the in-memory empty-ledger model the B
 * contract cases use, the ordinary PrismaService by a fake whose reads are empty) so the start runs without PostgreSQL;
 * `db: 'pg'` keeps every product class (tests/emr/b/startup_pg_test.cjs over a disposable database). The fence, the
 * failure journal, the seal and their recovery are always the product's own (Linux: /usr/bin/flock). A listener on port
 * 3000 is moved to 127.0.0.1 and the scenario's port (0 = any). There is no product reset, binding or test switch.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');

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
    KIN_EMR_STATE_DIR: state, KIN_EMR_PROXY_HOST: 'proxy',
    KC_ISSUER: 'http://127.0.0.1:1/auth/realms/kin', KC_JWKS_URL: 'http://127.0.0.1:1/certs', KC_AUDIENCE: 'kin-api',
    KC_WEB_SECRET: 'synthetic-web-secret', KIN_COOKIE_SECRET: 'synthetic-cookie-secret', PUBLIC_ORIGIN: 'http://127.0.0.1:3000',
    ORTHANC_URL: 'http://127.0.0.1:1', ORTHANC_USER: 'synthetic', ORTHANC_PASS: 'synthetic-orthanc-pass',
    KC_ADMIN_URL: 'http://127.0.0.1:1/auth', KC_REALM: 'kin', KC_CLIENT_ID: 'kin-api', KC_CLIENT_SECRET: 'synthetic-client-secret',
  };
  const env = { ...base, ...overrides };
  for (const [key, value] of Object.entries(env)) if (value === undefined || value === null) delete env[key];
  return env;
}

/**
 * Run one scenario. `options.env` is the child's whole environment; `options.onEvent(event, child, events)` may act on an
 * event (send a request, signal the child); the result resolves when the child exits or after `options.timeoutMs`.
 */
function run(scenario, options = {}) {
  return new Promise(resolve => {
    const started = performance.now();
    const child = spawn(process.execPath, [__filename, JSON.stringify(scenario)],
      { env: options.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    const events = [], out = [], err = [];
    let timedOut = false, stderrAt = null;
    // A command sent after the child ended is recorded, never thrown into the parent's own test.
    child.on('error', error => events.push({ what: 'parent-error', message: String(error && error.code) }));
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => { if (stderrAt === null) stderrAt = performance.now(); err.push(chunk); });
    child.on('message', event => {
      events.push(event);
      if (options.onEvent) Promise.resolve().then(() => options.onEvent(event, child, events)).catch(error => events.push({ what: 'parent-error', message: String(error && error.message) }));
    });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, options.timeoutMs ?? 40000);
    child.on('exit', (code, signal) => {
      const exitedAt = performance.now();
      // Let the pipes drain: an exit can precede the last chunk.
      setTimeout(() => {
        clearTimeout(timer);
        const stdout = Buffer.concat(out).toString('utf8'), stderr = Buffer.concat(err).toString('utf8');
        resolve({ code, signal, timedOut, stdout, stderr, events, names: events.map(event => event.what),
          stderrLines: stderr.split(/\r?\n/).filter(line => line !== ''),
          millisAfterStderr: stderrAt === null ? null : exitedAt - stderrAt, millis: exitedAt - started });
      }, 50);
    });
  });
}

// ═══════════════════════════════════════════════ child side ═══════════════════════════════════════════════

function child(scenario) {
  const http = require('node:http');
  const send = (what, extra = {}) => { if (process.send) process.send({ what, at: performance.now(), ...extra }); };
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
    async $connect() { send('connect'); return super.$connect(); }
    async $disconnect() { send('disconnect'); return super.$disconnect(); }
  }
  clientModule.EmrLedgerClient = ObservedLedgerClient;

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
    send('recovered', { recovered: result.recovered, notCommitted: result.notCommitted });
    return result;
  };
  const compose = composition.composeEmrAdapters;
  if (scenario.precompose) compose(context.runtimeAdapters);
  let prepared = null;
  composition.composeEmrAdapters = adapters => {
    send('compose', { base: adapters === context.runtimeAdapters, clinical: !!prepared && adapters === prepared.adapters });
    return compose(adapters);
  };

  // ── the clinical plan a test factory supplies in place of main's base plan (TEST-B2SH-02) ──
  const clinicalPlan = kind => (kind === 'no-factory' ? Object.freeze({ mode: 'clinical' }) : Object.freeze({ mode: 'clinical',
    async prepare(parts) {
      send('clinical-prepare', { frozen: Object.isFrozen(parts), base: parts.adapters === context.runtimeAdapters,
        sameClient: parts.db === clients[clients.length - 1], sameLedger: parts.ledger === stores[stores.length - 1] });
      if (kind === 'prepare-reject') throw leak('P1001');
      const marker = Object.freeze({ studyId: 'clinical-fixture-study' });
      const adapters = Object.freeze({ ...parts.adapters, clinical: Object.freeze({ loadStudy: () => marker, loadReportPatient: () => marker }) });
      prepared = kind === 'prepared-invalid' ? { adapters, dispose: () => send('clinical-dispose') } : {
        adapters,
        compose() {
          send('clinical-compose');
          return { async checkReady() { send('clinical-check'); if (kind === 'check-reject') throw leak('P1001'); },
            start() { send('clinical-start'); if (kind === 'start-throw') throw leak('P1001'); },
            stop() { send('clinical-stop'); } };
        },
        dispose() { send('clinical-dispose'); },
      };
      return prepared;
    } }));
  const Runtime = application.EmrApplicationRuntime;
  let runtime = null;
  const start = Runtime.prototype.start;
  Runtime.prototype.start = async function (plan) {
    runtime = this;
    send('start', { base: plan?.mode === 'base' });
    try {
      await start.call(this, scenario.clinical ? clinicalPlan(scenario.clinical) : plan);
      send('ready');
    } catch (error) {
      send('start-failed', { phase: error?.phase ?? null });
      throw error;
    }
  };
  for (const hook of ['beforeApplicationShutdown', 'onApplicationShutdown']) {
    const original = Runtime.prototype[hook];
    Runtime.prototype[hook] = function () { send('runtime-' + hook); return original.call(this); };
  }
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
  const close = http.Server.prototype.close;
  http.Server.prototype.close = function (callback) {
    if (!this.listening) return close.call(this, callback);
    send('server-close');
    return close.call(this, (...result) => { send('server-closed'); if (callback) callback(...result); });
  };

  // ── what the scenario checks once the server listens ──
  process.on('message', async command => {
    try {
      if (command === 'resources') {
        const first = runtime.requireResources(), second = runtime.requireResources();
        send('resources', { same: first === second, frozen: Object.isFrozen(first), keys: Object.keys(first).sort(),
          client: first.db === clients[0], clients: clients.length, ledger: first.ledger === stores[0], stores: stores.length,
          base: first.adapters === context.runtimeAdapters, ordinarySeparate: app.get(prismaModule.PrismaService) !== first.db,
          poolSize: first.db.emrAppendPoolSize });
      } else if (command === 'modules') {
        send('modules', { clinical: Object.keys(require.cache).map(name => name.replaceAll('\\', '/'))
          .filter(name => /\/(emr-clinical|emr-signature)\//.test(name)) });
      } else if (command === 'readers') {
        const study = composition.emrAdapters().clinical.loadStudy('probe');
        send('readers', { clinical: study?.studyId === 'clinical-fixture-study' });
      } else if (command === 'reenter') {
        const code = async work => { try { await work(); return 'accepted'; } catch (error) { return error?.code ?? error?.name ?? 'Error'; } };
        const resources = runtime.requireResources();
        send('reenter-ready', { again: await code(() => runtime.start({ mode: 'base' })), same: runtime.requireResources() === resources });
        await app.close();
        send('reenter-stopped', { resources: await code(() => runtime.requireResources()), again: await code(() => runtime.start({ mode: 'base' })) });
        process.exit(0);
      }
    } catch (error) { send('command-error', { code: error?.code ?? error?.name ?? 'Error' }); }
  });
  load('main');
}

if (require.main === module) child(JSON.parse(process.argv[2] || '{}'));

module.exports = { run, environment, stateDirectory };
