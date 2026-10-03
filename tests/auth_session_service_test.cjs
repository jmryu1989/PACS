'use strict';
/* TEST-S7-U5 compiled session service (AS-01..AS-12, test-plan section 2): the access records of login, logout, account
 * switch, idle expiry, refusal of a refresh and the sweep, over the compiled controller, guard and lifecycle of the kin-api
 * image, a real disposable PostgreSQL and an in-process fake Keycloak.
 *
 * REQ-S7-U5-AUTH-AUDIT -> RISK-S7-U5-SECRET-IN-LOG / RISK-S7-U5-CROSS-INSTITUTION / RISK-S7-U5-SWEEP-SILENT
 *   -> TEST-S7-U5 (this file; TEST-S7-U5-LIVE is tests/auth_audit_live.py).
 * Contracts: the session lifecycle contract (scenario-table section 0.A, Astra S7-U5-SPEC-F01, outcome table RT-01..RT-15)
 * and the DB failure boundary contract (section 0.B, S7-U5-SPEC-F02). The expected values are the contract's literals,
 * never read back from the implementation.
 *
 * Why compiled and not live: the sweep is an hourly timer with no route, and the races, the audit-write failures and the
 * late Keycloak answers cannot be timed on a live stack without test hooks (D73). So: the product's own Nest lifecycle hook
 * (onModuleInit) under node:test mock timers (setInterval and Date - jose's exp check and the fake Keycloak's exp use the
 * same mocked clock), two service instances over one database (two processes' worth of in-memory refresh sharing), a fake
 * Keycloak whose /token answers a case holds and releases, and a recording view of the real Prisma client per instance that
 * can hold a request before its next AuthSession write statement (before the transaction opens, never inside one) or make
 * one statement fail once with a synthetic error. The recorder keeps call names only - never where/data values, which carry
 * the token snapshot. Every error goes through the real Nest ExceptionsHandler (BaseExceptionFilter) and the real Nest
 * logger; the case reads what reaches the response (status, body, Set-Cookie, redirect) and what reaches stdout/stderr
 * (string writes are taken while a world runs; node:test's own protocol writes are buffers and pass through). Nothing here
 * calls a service method the controller or guard does not call, and nothing in the product exists for this file.
 *
 * KIN_AUTH_SESSION_DATABASE_URL names a disposable server's database kin_auth_session_test, which must hold no table when
 * this file starts: the image's migrations are applied with `prisma migrate deploy`, and between worlds only AuthSession and
 * AuditLog are emptied (AuditLog past its append-only guard as the disposable server's superuser, as the S7-U1a harness does).
 * Container only (kin-api image: /app/dist, /app/prisma, /app/node_modules). Synthetic identities only; the output names
 * cases, channels, kinds and counts, never a session id, token, cookie or marker value.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const jose = require('/app/node_modules/jose');
const { Reflector } = require('/app/node_modules/@nestjs/core');
const { ExceptionsHandler } = require('/app/node_modules/@nestjs/core/exceptions/exceptions-handler');
const { ExecutionContextHost } = require('/app/node_modules/@nestjs/core/helpers/execution-context-host');
const { InternalServerErrorException } = require('/app/node_modules/@nestjs/common');

const DATABASE = 'kin_auth_session_test';
const ISSUER = 'https://syn.test/auth/realms/kin';
const ORIGIN = 'https://syn.test';
const HOUR = 3600_000;
const IDLE = 12 * HOUR;
const START = Date.UTC(2026, 9, 3, 0, 0, 0);          // the mocked clock of every world
const AUTH_ACTIONS = ['auth.login', 'auth.logout', 'auth.session.expired'];
const ABSENT = '인증 세션이 없습니다', EXPIRED = '인증 세션이 만료되었습니다', REFUSED = '인증 세션을 갱신할 수 없습니다';
const IP = '198.51.100.7';
const A = 'syn-inst-a', B = 'syn-inst-b', Z = 'syn-inst-z';

// ── environment the compiled service reads (set before any instance is built) ──
const SECRETS = { client: 'syn-client-secret-' + randomBytes(12).toString('hex'), cookie: 'syn-cookie-secret-' + randomBytes(24).toString('hex') };
Object.assign(process.env, { KC_ISSUER: ISSUER, KC_AUDIENCE: 'kin-api', PUBLIC_ORIGIN: ORIGIN, KC_WEB_SECRET: SECRETS.client,
  KIN_COOKIE_SECRET: SECRETS.cookie });
delete process.env.AUTH_REQUIRED;

// ── the disposable database ──

let prepared = null;
function database() {
  prepared ??= (async () => {
    const url = process.env.KIN_AUTH_SESSION_DATABASE_URL;
    assert.ok(url, 'set KIN_AUTH_SESSION_DATABASE_URL to the disposable ' + DATABASE + ' database');
    assert.equal(new URL(url).pathname, '/' + DATABASE, 'refusing any database but the disposable ' + DATABASE);
    process.env.DATABASE_URL = url;
    const { PrismaService } = require('/app/dist/prisma.service');
    const base = new PrismaService();
    await base.$connect();
    const [{ tables }] = await base.$queryRawUnsafe(`SELECT count(*)::int AS tables FROM pg_tables WHERE schemaname = 'public'`);
    assert.equal(tables, 0, 'refusing a database that already holds tables: this file empties the tables it writes');
    execFileSync('/app/node_modules/.bin/prisma', ['migrate', 'deploy', '--schema', '/app/prisma/schema.prisma'],
      { cwd: '/app', env: { ...process.env, DATABASE_URL: url, HOME: os.tmpdir(), CHECKPOINT_DISABLE: '1' }, stdio: 'pipe' });
    const applied = await base.$queryRawUnsafe(`SELECT migration_name FROM _prisma_migrations
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`);
    const folders = fs.readdirSync('/app/prisma/migrations', { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
    assert.deepEqual(applied.map(row => row.migration_name).sort(), folders, 'every migration of the image applied');
    return base;
  })();
  return prepared;
}

// ── the fake Keycloak (127.0.0.1, the container's own loopback) ──

const KEYS = {};
const kc = { server: null, port: 0, held: [], waiters: [], auto: null, logoutMode: 'ok', logouts: 0, tokens: 0, codes: [] };

async function keycloak() {
  if (kc.server) return;
  for (const name of ['main', 'other']) {
    const { publicKey, privateKey } = await jose.generateKeyPair('RS256', { extractable: true });
    KEYS[name] = { kid: 'syn-' + name, publicKey, privateKey };
  }
  const jwk = { ...(await jose.exportJWK(KEYS.main.publicKey)), kid: KEYS.main.kid, alg: 'RS256', use: 'sig' };
  kc.server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const path = req.url.split('?')[0];
      const send = (status, value) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(value === undefined ? '' : JSON.stringify(value));
      };
      if (path === '/realms/kin/protocol/openid-connect/certs') return send(200, { keys: [jwk] });
      if (path === '/realms/kin/protocol/openid-connect/logout') {
        kc.logouts++;
        if (kc.logoutMode === 'drop') return req.socket.destroy();
        return send(204);
      }
      if (path === '/realms/kin/protocol/openid-connect/token') {
        kc.tokens++;
        const form = Object.fromEntries(new URLSearchParams(body));
        if (form.grant_type === 'authorization_code') kc.codes.push({ code: form.code, verifier: form.code_verifier });
        const request = {
          form,
          answer(reply) {
            if (reply === 'drop') return req.socket.destroy();
            send(reply[0], reply[1]);
          },
        };
        if (kc.auto) return request.answer(kc.auto(form));
        kc.held.push(request);
        for (const waiter of kc.waiters.splice(0)) waiter();
        return undefined;
      }
      return send(404, { error: 'not_found' });
    });
  });
  await new Promise(resolve => kc.server.listen(0, '127.0.0.1', resolve));
  kc.port = kc.server.address().port;
  process.env.KC_JWKS_URL = `http://127.0.0.1:${kc.port}/realms/kin/protocol/openid-connect/certs`;
}

/** The n-th /token request held since the world began (1-based), in arrival order. */
async function heldToken(n, label = 'a /token request') {
  // Real time: the mocked clock does not move by itself.
  const until = performance.now() + 10_000;
  while (kc.held.length < n) {
    if (performance.now() > until) throw new Error(`harness: ${label} (#${n}) never reached the fake Keycloak`);
    await new Promise(resolve => { kc.waiters.push(resolve); setTimeout(resolve, 50); });
  }
  return kc.held[n - 1];
}

const reply = {
  tokens: v => [200, { access_token: v.access, refresh_token: v.refresh, token_type: 'Bearer', expires_in: 60 }],
  reject: () => [400, { error: 'invalid_grant', error_description: 'SYN refused' }],
  drop: () => 'drop',
};

test.after(async () => {
  if (prepared) await (await prepared).$disconnect();
  if (kc.server) await new Promise(resolve => kc.server.close(resolve));
});

// ── what reaches stdout/stderr while a world runs ──

const realWrite = { out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
const capture = { on: false, texts: [] };
function take(channel) {
  return (chunk, ...rest) => {
    if (capture.on && typeof chunk === 'string') { capture.texts.push([channel, chunk]); const done = rest.find(r => typeof r === 'function'); if (done) done(); return true; }
    return (channel === 'stdout' ? realWrite.out : realWrite.err)(chunk, ...rest);
  };
}
process.stdout.write = take('stdout');
process.stderr.write = take('stderr');
const report = line => realWrite.err('S7-U5-AUTH-SESSION ' + line + '\n');

// ── judges (AS-11 tests them first) ──

/** Kinds of secret or marker found in texts: the value itself never leaves this function. */
function secretHits(texts, secrets) {
  const found = new Set();
  for (const text of texts) {
    if (typeof text !== 'string' || !text) continue;
    for (const [kind, value] of secrets) {
      if (!value || value.length < 6) continue;
      if (text.includes(value) || text.includes(encodeURIComponent(value))) found.add(kind);
    }
  }
  return [...found].sort();
}

/** The secret entries of one value: the value, and for a JWT each of its dot-separated pieces. */
function secretEntries(kind, value) {
  const out = [[kind, value]];
  if (typeof value === 'string' && value.split('.').length === 3) value.split('.').forEach((piece, n) => out.push([kind + '-piece' + n, piece]));
  return out;
}

const DETAIL_KEYS = {
  'auth.login:success': ['dataSubject', 'institution', 'ip', 'outcome'],
  'auth.login:failure': ['cause', 'dataSubject', 'institution', 'ip', 'outcome'],
  'auth.logout': ['cause', 'dataSubject', 'institution', 'ip'],
  'auth.session.expired': ['cause', 'dataSubject', 'institution', 'ip'],
};
const shapeOf = row => row.action === 'auth.login' ? 'auth.login:' + row.detail.outcome : row.action;

/** [action, cause or outcome, institution] of every auth row, sorted: order of commits is not the contract. */
const summary = rows => rows.map(r => [r.action, r.detail.cause ?? r.detail.outcome, r.detail.institution]).sort();

// ── a world: one empty database state, a fresh fake Keycloak state, two service instances ──

const { AuthService } = require('/app/dist/auth.service');
const { AuthGuard } = require('/app/dist/auth.guard');
const { AuthController } = require('/app/dist/auth.controller');

class SynProtectedController { read() {} }

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

async function world(t, { now = START } = {}) {
  const base = await database();
  await keycloak();
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now });
  await base.$executeRawUnsafe('TRUNCATE "AuthSession"');
  await base.$transaction([base.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    base.$executeRawUnsafe(`TRUNCATE "AuditLog" RESTART IDENTITY`)]);
  const [{ left }] = await base.$queryRawUnsafe(`SELECT (SELECT count(*) FROM "AuditLog") + (SELECT count(*) FROM "AuthSession") AS left`);
  assert.equal(Number(left), 0, 'every world starts with no session and no audit row');
  Object.assign(kc, { held: [], waiters: [], auto: null, logoutMode: 'ok', logouts: 0, tokens: 0, codes: [] });

  const w = { t, base, calls: [], gates: [], faults: [], secrets: [], labels: new Map(), rejections: [] };
  w.secret = (kind, value) => { for (const entry of secretEntries(kind, value)) w.secrets.push(entry); };
  w.secret('client-secret', SECRETS.client);
  w.secret('cookie-secret', SECRETS.cookie);

  // A gate holds an instance before it runs the named point; a fault makes the named point throw once.
  w.gate = (inst, point) => {
    const gate = { inst, point, used: false, arrived: deferred(), release: deferred() };
    w.gates.push(gate);
    return { arrived: () => within(gate.arrived.promise, `${inst} reaching ${point}`), release: () => gate.release.resolve() };
  };
  w.fault = (inst, point, error) => { w.faults.push({ inst, point, error }); };
  async function hit(inst, point) {
    w.calls.push(inst + ':' + point);
    const gate = w.gates.find(g => g.inst === inst && g.point === point && !g.used);
    if (gate) { gate.used = true; gate.arrived.resolve(); await gate.release.promise; }
    const n = w.faults.findIndex(f => f.inst === inst && f.point === point);
    if (n >= 0) { const [fault] = w.faults.splice(n, 1); throw fault.error; }
  }
  // Points: read, sweepRead, store (a refresh's token write), touch, tx.open, tx.delete, tx.create, tx.audit, audit.
  const pointOf = (scope, model, method, args) => {
    if (model === 'auditLog') return scope === 'tx' ? 'tx.audit' : 'audit';
    if (scope === 'tx') return method === 'deleteMany' ? 'tx.delete' : method === 'create' ? 'tx.create' : 'tx.' + method;
    if (method === 'findUnique') return 'read';
    if (method === 'findMany') return 'sweepRead';
    if (method === 'updateMany') return Object.keys(args?.data ?? {}).join() === 'lastSeenAt' ? 'touch' : 'store';
    return method;
  };
  const delegate = (inst, client, model, scope) => new Proxy({}, { get(_target, method) {
    const real = client[model][method];
    if (typeof real !== 'function') return real;
    return async args => { await hit(inst, pointOf(scope, model, method, args)); return real.call(client[model], args); };
  } });
  const recorder = inst => new Proxy({}, { get(_target, key) {
    if (key === '$transaction') return async (fn, options) => {
      await hit(inst, 'tx.open');
      return base.$transaction(async tx => {
        w.calls.push(inst + ':tx:start');
        const view = new Proxy({}, { get(_t, k) { return k === 'authSession' || k === 'auditLog' ? delegate(inst, tx, k, 'tx') : tx[k]; } });
        const out = await fn(view);
        w.calls.push(inst + ':tx:end');
        return out;
      }, options);
    };
    if (key === 'authSession' || key === 'auditLog') return delegate(inst, base, key, 'root');
    const value = base[key];
    return typeof value === 'function' ? value.bind(base) : value;
  } });
  const make = name => {
    const service = new AuthService(recorder(name));
    return { name, service, guard: new AuthGuard(new Reflector(), service), controller: new AuthController(service), handled: 0 };
  };
  w.I1 = make('I1');
  w.I2 = make('I2');

  // The real Nest exception path, with only its transport replaced by an in-memory response.
  const adapter = {
    reply(res, body, status) { res.statusCode = status; res.body = body; res.sent = true; },
    isHeadersSent: res => !!res.sent,
    end(res) { res.sent = true; },
  };
  w.exceptions = new ExceptionsHandler(adapter);

  /** One request through the compiled guard and controller (or the protected test handler). */
  w.call = async (inst, kind, { sid, cookie, ip = IP, headers = {}, query = {}, bearer } = {}) => {
    const routes = {
      get: ['GET', '/api/syn/protected', SynProtectedController, SynProtectedController.prototype.read],
      logout: ['POST', '/api/auth/logout', AuthController, AuthController.prototype.logout],
      login: ['GET', '/api/auth/login', AuthController, AuthController.prototype.login],
      register: ['GET', '/api/auth/register', AuthController, AuthController.prototype.register],
      callback: ['GET', '/api/auth/callback', AuthController, AuthController.prototype.callback],
    };
    const [method, path, cls, handler] = routes[kind];
    const cookies = [sid ? 'kin_sid=' + encodeURIComponent(sid) : null, cookie ?? null].filter(Boolean).join('; ');
    const req = { method, originalUrl: path, url: path, query, headers: {
      ...(cookies ? { cookie: cookies } : {}), ...(ip === null ? {} : { 'x-real-ip': ip }),
      ...(kind === 'logout' ? { 'x-kin-csrf': '1' } : {}), ...(bearer ? { authorization: 'Bearer ' + bearer } : {}), ...headers } };
    const res = { req, setCookies: [], statusCode: null, body: undefined, location: null, sent: false,
      append(name, value) { if (name === 'Set-Cookie') this.setCookies.push(value); },
      redirect(status, url) { this.statusCode = status; this.location = url; this.sent = true; },
      status(code) { this.statusCode = code; return this; },
      send(body) { this.body = body; this.sent = true; return this; } };
    try {
      await inst.guard.canActivate(new ExecutionContextHost([req, res], cls, handler));
      if (kind === 'get') { inst.handled++; res.status(200).send({ ok: true }); }
      else if (kind === 'logout') await inst.controller.logout(req, res);
      else if (kind === 'login') await inst.controller.login(req, res, query.prompt);
      else if (kind === 'register') await inst.controller.register(req, res);
      else await inst.controller.callback(req, res, query.code, query.state, query.error);
    } catch (error) {
      w.exceptions.next(error, new ExecutionContextHost([req, res]));
    }
    const set = name => res.setCookies.filter(c => c.startsWith(name + '='));
    const sidCookie = set('kin_sid'), pending = set('kin_pending');
    const value = c => decodeURIComponent(c.slice(c.indexOf('=') + 1, c.indexOf(';')));
    const out = {
      status: res.statusCode, body: res.body, location: res.location,
      expired: sidCookie.some(c => c.startsWith('kin_sid=;') && /Max-Age=0/.test(c)),
      newSid: sidCookie.filter(c => !/Max-Age=0/.test(c)).map(value)[0] ?? null,
      pending: pending.filter(c => !/Max-Age=0/.test(c)).map(value)[0] ?? null,
      sidCookies: sidCookie.length, texts: [JSON.stringify(res.body ?? null), res.location ?? '', ...res.setCookies],
    };
    out.cookie = out.expired ? (out.pending ? 'E+P' : 'E') : out.newSid ? 'S' : 'K';
    if (out.newSid) w.secret('sid', out.newSid);
    if (out.pending) w.secret('pending', out.pending);
    w.responses.push(out.texts);
    return out;
  };
  w.responses = [];

  /** A token version: a signed access token (RS256, the fake Keycloak's key) and an opaque refresh token. */
  w.issue = async (label, { sub, groups = [A], email, roles = ['radiologist'], expIn = HOUR / 1000, key = 'main', same } = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const jti = label + '-' + randomUUID();
    const access = await new jose.SignJWT({ email: email ?? sub + '@synthetic.test', groups, realm_access: { roles }, azp: 'kin-bff', jti })
      .setProtectedHeader({ alg: 'RS256', kid: KEYS[key].kid }).setIssuer(ISSUER).setAudience('kin-api').setSubject(sub)
      .setIssuedAt(now).setExpirationTime(same?.exp ?? now + expIn).sign(KEYS[key].privateKey);
    const v = { label, sub, access, refresh: 'syn-rt-' + randomUUID(), jti, exp: same?.exp ?? now + expIn };
    w.labels.set(jti, label);
    w.secret('access', v.access);
    w.secret('refresh', v.refresh);
    return v;
  };
  /** A session row put by the harness (never the race's own version: those the product stores). */
  w.session = async (v, { lastSeenAt = new Date(), atExpiresAt = new Date(v.exp * 1000 - 30_000) } = {}) => {
    const sid = randomBytes(32).toString('base64url');
    w.secret('sid', sid);
    await base.authSession.create({ data: { sid, sub: v.sub, accessToken: v.access, refreshToken: v.refresh, atExpiresAt, lastSeenAt } });
    return sid;
  };
  /** The version label left in the session (or null), compared by jti - no token value is printed. */
  w.version = async sid => {
    const row = await base.authSession.findUnique({ where: { sid } });
    return row ? w.labels.get(jose.decodeJwt(row.accessToken).jti) ?? 'unknown' : null;
  };
  w.lastSeen = async sid => (await base.authSession.findUnique({ where: { sid } }))?.lastSeenAt.getTime() ?? null;
  w.sessions = async () => base.authSession.count();
  w.rows = async () => (await base.auditLog.findMany({ where: { action: { in: AUTH_ACTIONS } }, orderBy: { id: 'asc' } }))
    .map(r => ({ actor: r.actor, action: r.action, target: r.target, detail: JSON.parse(r.detail) }));
  w.ends = async () => summary((await w.rows()).filter(r => r.action !== 'auth.login'));
  w.tick = ms => t.mock.timers.tick(ms);

  /** Waits (real time) until the predicate on the database holds: a sweep has no response to wait for. */
  w.until = async (what, predicate) => {
    const until = performance.now() + 10_000;
    for (;;) {
      if (await predicate()) return;
      if (performance.now() > until) throw new Error('harness: ' + what + ' not observed within 10 s');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };

  capture.on = true;
  capture.texts = [];
  /** World end (AS-10 a): every auth row has its exact key set; no secret in rows, responses or captured output. */
  w.finish = async (name, { output = [] } = {}) => {
    capture.on = false;
    const rows = await w.rows();
    for (const row of rows) {
      assert.deepEqual(Object.keys(row.detail).sort(), DETAIL_KEYS[shapeOf(row)], `${name}: detail keys of ${row.action}`);
      assert.equal(row.detail.dataSubject, null, `${name}: dataSubject is recorded as null`);
    }
    const raw = await base.auditLog.findMany({ where: { action: { in: AUTH_ACTIONS } } });
    const columns = raw.flatMap(r => [r.actor, r.action, r.target, r.detail]);
    const outputTexts = capture.texts.map(([, text]) => text);
    // Responses carry the session and pending cookies and the Keycloak redirect by design; they are checked for the
    // DB error markers (AS-10 b), not for the secrets they are meant to hand the browser.
    const hits = { rows: secretHits(columns, w.secrets), output: secretHits(outputTexts, w.secrets) };
    const extra = output.length ? secretHits(outputTexts, output) : [];
    report(JSON.stringify({ case: name, rows: rows.length, hits: [...hits.rows, ...hits.output, ...extra],
      captured: capture.texts.length }));
    assert.deepEqual(hits, { rows: [], output: [] }, `${name}: secrets found (kinds only)`);
    assert.deepEqual(extra, [], `${name}: markers found in the output (kinds only)`);
    return capture.texts;
  };
  return w;
}

async function within(promise, what, ms = 10_000) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('harness: ' + what + ' did not happen')), ms); });
  try { return await Promise.race([promise, timeout]); }
  finally { clearTimeout(timer); }
}

/** A full browser login through the compiled controller: login -> fake Keycloak code -> callback. */
async function login(w, inst, v, { ip = IP, prompt } = {}) {
  const begin = await w.call(inst, 'login', { query: prompt ? { prompt } : {} });
  assert.equal(begin.status, 302);
  const state = new URL(begin.location).searchParams.get('state');
  w.secret('state', state);
  const code = 'syn-code-' + randomUUID();
  w.secret('code', code);
  kc.auto = form => form.grant_type === 'authorization_code' ? reply.tokens(v) : reply.reject();
  const done = await w.call(inst, 'callback', { cookie: 'kin_pending=' + encodeURIComponent(begin.pending), ip, query: { code, state } });
  kc.auto = null;
  for (const entry of kc.codes) w.secret('verifier', entry.verifier);
  return { begin, done, state, pending: begin.pending };
}

const rowsOf = (rows, target) => rows.filter(r => r.target === target);

// ── AS-11: the judges themselves ──

test('AS-11 the judges: secret hits, output channels, row sets and session versions', async () => {
  const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzeW4ifQ.c2lnbmF0dXJlLXN5bg';
  const secrets = [...secretEntries('access', jwt), ['sid', 'SYN-SID-0123456789'], ['marker', 'SYN-MARK-MSG-X']];
  assert.deepEqual(secretHits(['a SYN-SID-0123456789 b'], secrets), ['sid']);
  assert.deepEqual(secretHits([encodeURIComponent('x/SYN-SID-0123456789+')], secrets), ['sid']);
  assert.deepEqual(secretHits(['only eyJzdWIiOiJzeW4ifQ here'], secrets), ['access-piece1']);
  assert.deepEqual(secretHits(['SYN-MARK-MSG-X'], secrets), ['marker']);
  assert.deepEqual(secretHits(['nothing of the kind', '', null], secrets), []);
  // The channel collector takes string writes of stdout and stderr and passes buffers through.
  capture.on = true;
  capture.texts = [];
  process.stdout.write('SYN-MARK-MSG-X on stdout\n');
  process.stderr.write('clean stderr\n');
  capture.on = false;
  assert.deepEqual(capture.texts.map(([channel, text]) => [channel, secretHits([text], secrets)]),
    [['stdout', ['marker']], ['stderr', []]]);
  // Row-set comparison: one missing, one extra, one field different are mismatches; order alone is not.
  const rows = [{ action: 'auth.logout', detail: { cause: 'logout', institution: A } },
    { action: 'auth.session.expired', detail: { cause: 'idle', institution: B } }];
  assert.deepEqual(summary(rows), summary([...rows].reverse()));
  assert.notDeepEqual(summary(rows), summary(rows.slice(1)));
  assert.notDeepEqual(summary(rows), summary([...rows, rows[0]]));
  assert.notDeepEqual(summary(rows), summary([rows[0], { ...rows[1], detail: { cause: 'idle', institution: A } }]));
  // Detail key sets.
  assert.deepEqual(Object.keys({ institution: A, ip: IP, dataSubject: null, cause: 'logout' }).sort(), DETAIL_KEYS['auth.logout']);
  assert.notDeepEqual(Object.keys({ institution: A, ip: IP, dataSubject: null, cause: 'logout', sid: 'x' }).sort(), DETAIL_KEYS['auth.logout']);
});

/** What the compiled guard decides from one access token (Bearer): req.actor, req.sub, req.institution. */
async function guardView(w, access) {
  const req = { method: 'GET', originalUrl: '/api/syn/protected', url: '/api/syn/protected', headers: { authorization: 'Bearer ' + access } };
  try {
    await w.I1.guard.canActivate(new ExecutionContextHost([req, { req }], SynProtectedController, SynProtectedController.prototype.read));
  } catch (_) { /* a PENDING or INVALID member is refused after the guard has read the token */ }
  return { actor: req.actor, sub: req.sub, institution: req.institution ?? null };
}

const past = (ms = 1000) => new Date(Date.now() - ms);

// ── AS-01..AS-07 ──

test('AS-01 a login writes its session and one success row in one transaction', async t => {
  const w = await world(t);
  const v = await w.issue('ma', { sub: 'syn-sub-ma', groups: ['/' + A], email: 'syn-ma@synthetic.test' });
  const first = await login(w, w.I1, v);
  assert.deepEqual([first.done.status, first.done.location, !!first.done.newSid],
    [302, ORIGIN + '/worklist/hpacs-lite/main.html', true]);
  assert.equal(await w.sessions(), 1);
  assert.deepEqual(await w.rows(), [{ actor: 'syn-ma@synthetic.test', action: 'auth.login', target: 'syn-sub-ma',
    detail: { institution: A, ip: IP, dataSubject: null, outcome: 'success' } }]);
  const start = w.calls.indexOf('I1:tx:start');
  assert.deepEqual(w.calls.slice(start, w.calls.indexOf('I1:tx:end', start) + 1),
    ['I1:tx:start', 'I1:tx.create', 'I1:tx.audit', 'I1:tx:end'], 'the session and its row in one transaction');
  // Preserving pair: the same member again - a session and a row per login.
  await login(w, w.I1, await w.issue('ma2', { sub: 'syn-sub-ma', groups: ['/' + A], email: 'syn-ma@synthetic.test' }));
  assert.equal(await w.sessions(), 2);
  assert.deepEqual(summary(await w.rows()), [['auth.login', 'success', A], ['auth.login', 'success', A]]);
  await w.finish('AS-01');
});

test('AS-02 the record-time institution is the token\'s one group, as the guard decides it, on login, logout and idle', async t => {
  const w = await world(t);
  const vectors = [['one group with a slash', ['/' + A], ['radiologist'], A], ['no group (PENDING)', [], ['radiologist'], null],
    ['two groups (INVALID)', [A, B], ['radiologist'], null], ['one group, no role (INVALID)', [A], [], A], ['a number', [7], ['radiologist'], null],
    ['one group without a slash', [B], ['radiologist'], B]];
  let n = 0;
  for (const [label, groups, roles, expected] of vectors) {
    const sub = 'syn-sub-v' + (++n);
    const v = await w.issue('login-' + n, { sub, groups, roles });
    assert.equal((await guardView(w, v.access)).institution, expected, label + ': the guard rule');
    await login(w, w.I1, v);
    const out = await w.call(w.I1, 'logout', { sid: await w.session(await w.issue('out-' + n, { sub, groups, roles })) });
    assert.equal(out.status, 204, label);
    const idle = await w.call(w.I1, 'get', { sid: await w.session(await w.issue('idle-' + n, { sub, groups, roles }),
      { lastSeenAt: past(IDLE + 60_000) }) });
    assert.equal(idle.status, 401, label);
    assert.deepEqual(rowsOf(await w.rows(), sub).map(r => [r.action, r.detail.cause ?? r.detail.outcome, r.detail.institution]),
      [['auth.login', 'success', expected], ['auth.logout', 'logout', expected], ['auth.session.expired', 'idle', expected]], label);
  }
  await w.finish('AS-02');
});

test('AS-03 a failed login of a login this server started leaves one failure row; anything else none', async t => {
  const w = await world(t);
  const count = async () => (await w.rows()).length;
  const begin = async () => {
    const out = await w.call(w.I1, 'login');
    const state = new URL(out.location).searchParams.get('state');
    w.secret('state', state);
    return { pending: 'kin_pending=' + encodeURIComponent(out.pending), state };
  };
  const failure = cause => ({ actor: 'unknown', action: 'auth.login', target: '',
    detail: { institution: null, ip: IP, dataSubject: null, outcome: 'failure', cause } });
  const last = async () => (await w.rows()).at(-1);
  let p = await begin();
  let out = await w.call(w.I1, 'callback', { cookie: p.pending, query: { error: 'access_denied', state: p.state } });
  assert.equal(out.location, ORIGIN + '/worklist/hpacs-lite/index.html?auth_error=access_denied');
  assert.deepEqual(await last(), failure('provider_error'));
  p = await begin();
  await w.call(w.I1, 'callback', { cookie: p.pending, query: { error: 'temporarily_unavailable', state: p.state } });
  assert.deepEqual(await last(), failure('provider_error'), 'another error value: the same row, no error text');
  p = await begin();
  out = await w.call(w.I1, 'callback', { cookie: p.pending, query: { code: 'syn-code-x', state: 'syn-other-state' } });
  assert.equal(out.status, 400);
  assert.deepEqual(await last(), failure('state_mismatch'));
  p = await begin();
  out = await w.call(w.I1, 'callback', { cookie: p.pending, query: { state: p.state } });
  assert.equal(out.location, ORIGIN + '/worklist/hpacs-lite/index.html?auth_error=stale');
  assert.deepEqual(await last(), failure('no_code'));
  p = await begin();
  kc.auto = () => reply.reject();
  out = await w.call(w.I1, 'callback', { cookie: p.pending, query: { code: 'syn-code-y', state: p.state } });
  assert.equal(out.location, ORIGIN + '/worklist/hpacs-lite/index.html?auth_error=login_failed');
  assert.deepEqual(await last(), failure('exchange_failed'));
  // A token the fake Keycloak signed with another key: verification fails, and its email and groups are not used.
  const forged = await w.issue('forged', { sub: 'syn-sub-forged', groups: [A], email: 'syn-forged@synthetic.test', key: 'other' });
  p = await begin();
  kc.auto = () => reply.tokens(forged);
  out = await w.call(w.I1, 'callback', { cookie: p.pending, query: { code: 'syn-code-z', state: p.state } });
  kc.auto = null;
  assert.equal(out.location, ORIGIN + '/worklist/hpacs-lite/index.html?auth_error=login_failed');
  assert.deepEqual(await last(), failure('token_invalid'));
  assert.equal(await w.sessions(), 0);
  const before = await count();
  // No row without a login this server started: no pending, a forged signature, an expired one.
  for (const query of [{ error: 'access_denied' }, { code: 'syn-c', state: 'syn-s' }, {}])
    await w.call(w.I1, 'callback', { query });
  p = await begin();
  const tampered = p.pending.slice(0, -2) + (p.pending.endsWith('A') ? 'BB' : 'AA');
  await w.call(w.I1, 'callback', { cookie: tampered, query: { error: 'access_denied', state: p.state } });
  p = await begin();
  w.tick(11 * 60_000);
  await w.call(w.I1, 'callback', { cookie: p.pending, query: { error: 'access_denied', state: p.state } });
  await w.call(w.I1, 'callback', { cookie: p.pending, query: { code: 'syn-c', state: p.state } });
  // A browser that already has a session: a callback without code is not a login event.
  const sid = await w.session(await w.issue('has', { sub: 'syn-sub-has' }));
  out = await w.call(w.I1, 'callback', { sid, query: {} });
  assert.equal(out.location, ORIGIN + '/worklist/hpacs-lite/main.html');
  assert.equal(await count(), before, 'no pending, a forged or expired pending, or a session callback: no row');
  await w.finish('AS-03');
});

test('AS-04 logout: one row from the ended session, Bearer none, overlap one, a guard end its own cause', async t => {
  const w = await world(t);
  // (a) the row's actor, target and institution are the stored token's - the guard's own reading of it.
  const va = await w.issue('a', { sub: 'syn-sub-a', groups: [A] });
  let out = await w.call(w.I1, 'logout', { sid: await w.session(va) });
  assert.deepEqual([out.status, out.cookie], [204, 'E']);
  const seen = await guardView(w, va.access);
  assert.deepEqual(rowsOf(await w.rows(), 'syn-sub-a'), [{ actor: seen.actor, action: 'auth.logout', target: seen.sub,
    detail: { institution: seen.institution, ip: IP, dataSubject: null, cause: 'logout' } }]);
  // (b) Keycloak's logout endpoint cuts the connection: the local end still happens, Keycloak was asked once.
  kc.logoutMode = 'drop';
  const logouts = kc.logouts;
  out = await w.call(w.I1, 'logout', { sid: await w.session(await w.issue('b', { sub: 'syn-sub-b', groups: [B] })) });
  kc.logoutMode = 'ok';
  assert.deepEqual([out.status, out.cookie, kc.logouts - logouts], [204, 'E', 1]);
  assert.deepEqual(summary(rowsOf(await w.rows(), 'syn-sub-b')), [['auth.logout', 'logout', B]]);
  // (c) two logouts of one session overlap (RT-12), in both orders: the one that deleted writes the row.
  for (const [first, second, sub] of [[w.I1, w.I2, 'syn-sub-c1'], [w.I2, w.I1, 'syn-sub-c2']]) {
    const sid = await w.session(await w.issue(sub, { sub, groups: [A] }));
    const gate = w.gate(first.name, 'tx.open');
    const held = w.call(first, 'logout', { sid });
    await gate.arrived();
    const won = await w.call(second, 'logout', { sid });
    gate.release();
    const lost = await held;
    assert.deepEqual([won.status, won.cookie, lost.status, lost.cookie], [204, 'E', 204, 'E'], sub);
    const after = await w.call(first, 'logout', { sid });
    assert.deepEqual([after.status, after.body?.message, after.cookie], [401, ABSENT, 'E'], sub + ': a later logout meets the absence in the guard');
    assert.deepEqual(summary(rowsOf(await w.rows(), sub)), [['auth.logout', 'logout', A]], sub);
  }
  // (d) Bearer: no session, no row.
  const bearer = await w.issue('bearer', { sub: 'syn-sub-bearer', groups: [A] });
  out = await w.call(w.I1, 'logout', { bearer: bearer.access });
  assert.deepEqual([out.status, out.cookie], [204, 'K']);
  assert.deepEqual(rowsOf(await w.rows(), 'syn-sub-bearer'), []);
  // (e) the guard ends the session before the controller: its own cause, no logout row.
  kc.auto = () => reply.reject();
  out = await w.call(w.I1, 'logout', { sid: await w.session(await w.issue('e1', { sub: 'syn-sub-e1', groups: [A] }), { atExpiresAt: past() }) });
  kc.auto = null;
  assert.deepEqual([out.status, out.body?.message, out.cookie], [401, REFUSED, 'E']);
  out = await w.call(w.I1, 'logout', { sid: await w.session(await w.issue('e2', { sub: 'syn-sub-e2', groups: [B] }), { lastSeenAt: past(13 * HOUR) }) });
  assert.deepEqual([out.status, out.body?.message, out.cookie], [401, EXPIRED, 'E']);
  assert.deepEqual(summary([...rowsOf(await w.rows(), 'syn-sub-e1'), ...rowsOf(await w.rows(), 'syn-sub-e2')]),
    [['auth.session.expired', 'idle', B], ['auth.session.expired', 'refresh_failed', A]]);
  assert.equal(w.I1.handled + w.I2.handled, 0);
  await w.finish('AS-04');
});

test('AS-05 an account switch or a registration ends the browser session with one account_switch row', async t => {
  const w = await world(t);
  for (const [kind, query, sub, options] of [['login', { prompt: 'login' }, 'syn-sub-s1', {}],
    ['register', {}, 'syn-sub-s2', {}], ['login', { prompt: 'login' }, 'syn-sub-s3', { lastSeenAt: past(13 * HOUR) }]]) {
    const sid = await w.session(await w.issue(sub, { sub, groups: [B] }), options);
    const out = await w.call(w.I1, kind, { sid, query });
    assert.deepEqual([out.status, out.cookie, out.location.startsWith(ISSUER + '/protocol/openid-connect/auth?')], [302, 'E+P', true], sub);
    assert.equal(await w.version(sid), null, sub);
    assert.deepEqual(summary(rowsOf(await w.rows(), sub)), [['auth.logout', 'account_switch', B]], sub + ': account_switch even when idle');
  }
  const before = (await w.rows()).length;
  for (const sid of [undefined, 'syn-unknown-sid-' + randomUUID()]) {
    const out = await w.call(w.I1, 'login', { sid, query: { prompt: 'login' } });
    assert.deepEqual([out.status, !!out.pending], [302, true]);
  }
  assert.equal((await w.rows()).length, before, 'no cookie or an absent session: no row');
  await w.finish('AS-05');
});

test('AS-06 idle: one row at the end, none at exactly twelve hours or before', async t => {
  const w = await world(t);
  const sid = await w.session(await w.issue('i1', { sub: 'syn-sub-i1', groups: [A] }), { lastSeenAt: past(IDLE + 1000) });
  let out = await w.call(w.I1, 'get', { sid });
  assert.deepEqual([out.status, out.body?.message, out.cookie], [401, EXPIRED, 'E']);
  assert.deepEqual(rowsOf(await w.rows(), 'syn-sub-i1').map(r => r.detail), [{ institution: A, ip: IP, dataSubject: null, cause: 'idle' }]);
  // Two requests of one idle session overlap (RT-12): one row.
  const sid2 = await w.session(await w.issue('i2', { sub: 'syn-sub-i2', groups: [B] }), { lastSeenAt: past(IDLE + 1000) });
  const gate = w.gate('I1', 'tx.open');
  const held = w.call(w.I1, 'get', { sid: sid2 });
  await gate.arrived();
  const won = await w.call(w.I2, 'get', { sid: sid2 });
  gate.release();
  const lost = await held;
  assert.deepEqual([won.status, won.cookie, lost.status, lost.body?.message, lost.cookie], [401, 'E', 401, EXPIRED, 'E']);
  assert.deepEqual(summary(rowsOf(await w.rows(), 'syn-sub-i2')), [['auth.session.expired', 'idle', B]]);
  // Exactly twelve hours is the cutoff itself and not idle; 11 h 59 min neither.
  for (const [sub, age] of [['syn-sub-i3', IDLE], ['syn-sub-i4', IDLE - 60_000]]) {
    out = await w.call(w.I1, 'get', { sid: await w.session(await w.issue(sub, { sub, groups: [A] }), { lastSeenAt: past(age) }) });
    assert.deepEqual([out.status, out.cookie], [200, 'K'], sub);
    assert.deepEqual(rowsOf(await w.rows(), sub), [], sub);
  }
  out = await w.call(w.I1, 'get', { sid: 'syn-unknown-' + randomUUID() });
  assert.deepEqual([out.status, out.body?.message, out.cookie], [401, ABSENT, 'E']);
  assert.equal((await w.rows()).length, 2);
  await w.finish('AS-06');
});

test('AS-07 refresh: a refusal ends the session once, a success adds no row and is not refreshed again', async t => {
  const w = await world(t);
  for (const [sub, answer] of [['syn-sub-r1', () => reply.reject()], ['syn-sub-r2', () => reply.drop()]]) {
    kc.auto = answer;
    const out = await w.call(w.I1, 'get', { sid: await w.session(await w.issue(sub, { sub, groups: [A] }), { atExpiresAt: past() }) });
    assert.deepEqual([out.status, out.body?.message, out.cookie], [401, REFUSED, 'E'], sub);
    assert.deepEqual(summary(rowsOf(await w.rows(), sub)), [['auth.session.expired', 'refresh_failed', A]], sub);
  }
  // A success answer whose token fails verification is a refusal too (an external failure).
  const forged = await w.issue('r3-next', { sub: 'syn-sub-r3', groups: [A], key: 'other' });
  kc.auto = () => reply.tokens(forged);
  let out = await w.call(w.I1, 'get', { sid: await w.session(await w.issue('r3', { sub: 'syn-sub-r3', groups: [A] }), { atExpiresAt: past() }) });
  kc.auto = null;
  assert.deepEqual([out.status, out.body?.message], [401, REFUSED]);
  assert.deepEqual(summary(rowsOf(await w.rows(), 'syn-sub-r3')), [['auth.session.expired', 'refresh_failed', A]]);
  // Two requests of one instance on the same snapshot share one /token request.
  kc.held = [];
  let tokens = kc.tokens;
  const sid4 = await w.session(await w.issue('r4', { sub: 'syn-sub-r4', groups: [B] }), { atExpiresAt: past() });
  const both = [w.call(w.I1, 'get', { sid: sid4 }), w.call(w.I1, 'get', { sid: sid4 })];
  (await heldToken(1, 'the shared refresh')).answer(reply.reject());
  const shared = await Promise.all(both);
  assert.deepEqual([shared.map(o => [o.status, o.cookie]), kc.tokens - tokens], [[[401, 'E'], [401, 'E']], 1]);
  assert.deepEqual(summary(rowsOf(await w.rows(), 'syn-sub-r4')), [['auth.session.expired', 'refresh_failed', B]]);
  // Two instances, both refused (RT-04): one row, two 401s.
  kc.held = [];
  const sid5 = await w.session(await w.issue('r5', { sub: 'syn-sub-r5', groups: [A] }), { atExpiresAt: past() });
  const r1 = w.call(w.I1, 'get', { sid: sid5 });
  const k1 = await heldToken(1);
  const r2 = w.call(w.I2, 'get', { sid: sid5 });
  const k2 = await heldToken(2);
  k1.answer(reply.reject());
  k2.answer(reply.reject());
  const pair = await Promise.all([r1, r2]);
  assert.deepEqual(pair.map(o => [o.status, o.cookie]), [[401, 'E'], [401, 'E']]);
  assert.deepEqual(summary(rowsOf(await w.rows(), 'syn-sub-r5')), [['auth.session.expired', 'refresh_failed', A]]);
  // A success is stored once and adopted: no row, one /token although its stored atExpiresAt is already past.
  const next = await w.issue('r6-next', { sub: 'syn-sub-r6', groups: [A], expIn: 20 });
  kc.auto = () => reply.tokens(next);
  tokens = kc.tokens;
  const sid6 = await w.session(await w.issue('r6', { sub: 'syn-sub-r6', groups: [A] }), { atExpiresAt: past() });
  out = await w.call(w.I1, 'get', { sid: sid6 });
  kc.auto = null;
  assert.deepEqual([out.status, out.cookie, await w.version(sid6), kc.tokens - tokens], [200, 'K', 'r6-next', 1]);
  assert.deepEqual(rowsOf(await w.rows(), 'syn-sub-r6'), []);
  await w.finish('AS-07');
});

// ── AS-08: the sweep, through the product's own lifecycle hook and its real hourly timer ──

test('AS-08 (a) the hourly sweep ends every idle session with one sweep row; (c) 13 h idle never reaches Keycloak; (d) an idle request first leaves the sweep nothing', async t => {
  const w = await world(t);
  w.I2.service.onModuleInit();
  try {
    for (const [sub, inst] of [['syn-sub-w1', A], ['syn-sub-w2', B], ['syn-sub-w3', Z]])
      await w.session(await w.issue(sub, { sub, groups: [inst] }), { lastSeenAt: past(13 * HOUR) });
    // At the first run (one hour on) this one is exactly twelve hours old: the cutoff itself, not idle.
    const recent = await w.session(await w.issue('w4', { sub: 'syn-sub-w4', groups: [A] }), { lastSeenAt: past(11 * HOUR) });
    w.tick(HOUR);
    await w.until('the first sweep run', async () => w.calls.filter(c => c === 'I2:tx:end').length === 3);
    assert.deepEqual([await w.sessions(), await w.version(recent)], [1, 'w4']);
    const rows = await w.rows();
    assert.deepEqual(summary(rows), [['auth.session.expired', 'sweep', A], ['auth.session.expired', 'sweep', B],
      ['auth.session.expired', 'sweep', Z]]);
    assert.deepEqual(rows.map(r => r.detail.ip), [null, null, null], 'a sweep has no request address');
    assert.deepEqual(rows.map(r => r.target).sort(), ['syn-sub-w1', 'syn-sub-w2', 'syn-sub-w3']);
    // The boundary session would be a target of the next run; it is taken away so that (d) has one target.
    await w.base.authSession.deleteMany({ where: { sid: recent } });
    // (c) the control: a 13 h idle session with an expired token ends idle in the guard, before any refresh.
    const tokens = kc.tokens;
    const out = await w.call(w.I1, 'get', { sid: await w.session(await w.issue('w5', { sub: 'syn-sub-w5', groups: [B] }),
      { lastSeenAt: past(13 * HOUR), atExpiresAt: past() }) });
    assert.deepEqual([out.status, out.body?.message, out.cookie, kc.tokens - tokens], [401, EXPIRED, 'E', 0]);
    assert.deepEqual(summary(rowsOf(await w.rows(), 'syn-sub-w5')), [['auth.session.expired', 'idle', B]]);
    // (d) the sweep has read a target and waits before its delete; the target's own request ends it idle first.
    const sid6 = await w.session(await w.issue('w6', { sub: 'syn-sub-w6', groups: [A] }), { lastSeenAt: past(13 * HOUR) });
    const gate = w.gate('I2', 'tx.open');
    w.tick(HOUR);
    await gate.arrived();
    const idle = await w.call(w.I1, 'get', { sid: sid6 });
    assert.deepEqual([idle.status, idle.body?.message], [401, EXPIRED]);
    const ended = w.calls.filter(c => c === 'I2:tx:end').length;
    gate.release();
    await w.until('the held sweep delete', async () => w.calls.filter(c => c === 'I2:tx:end').length === ended + 1);
    assert.deepEqual(summary(rowsOf(await w.rows(), 'syn-sub-w6')), [['auth.session.expired', 'idle', A]]);
  } finally {
    w.I2.service.onModuleDestroy();
  }
  await w.finish('AS-08');
});

// ── AS-09: the DB failure boundary ──

/** A synthetic database error: distinct markers in its message, name, code, meta, cause and stack (no real data). */
function dbError(tag) {
  const error = new Error('SYN-MARK-MSG-' + tag);
  error.name = 'SYN-MARK-NAME-' + tag;
  error.code = 'SYN-MARK-CODE-' + tag;
  error.meta = { modelName: 'SYN-MARK-META-' + tag };
  error.cause = new Error('SYN-MARK-CAUSE-' + tag);
  error.stack = 'SYN-MARK-STACK-' + tag + '\n    at synthetic (synthetic.js:1:1)';
  return error;
}
const markers = tag => ['MSG', 'NAME', 'CODE', 'META', 'CAUSE', 'STACK'].map(kind => ['marker-' + kind.toLowerCase(), `SYN-MARK-${kind}-${tag}`]);
const storageFailure = out => out.status === 500 && out.body?.code === 'AUTH_STORAGE_FAILURE'
  && typeof out.body?.message === 'string' && Object.keys(out.body).sort().join() === 'code,message';

test('AS-09 a DB failure on any path is a fixed 500 with nothing committed and no cookie change; once fixed, exactly one transition commits', async t => {
  const w = await world(t);
  let n = 0;
  const sub = () => 'syn-sub-f' + (++n);
  // (1) login: the session and its success row roll back together; the failure row is tried apart.
  for (const point of ['tx.create', 'tx.audit']) {
    const s = sub();
    w.fault('I1', point, dbError('login-' + point));
    const done = (await login(w, w.I1, await w.issue(s, { sub: s, groups: [A] }))).done;
    assert.deepEqual([done.status, done.location, done.newSid], [302, ORIGIN + '/worklist/hpacs-lite/index.html?auth_error=login_failed', null], point);
    assert.deepEqual(summary(rowsOf(await w.rows(), s)), [['auth.login', 'session_failed', A]], point);
    assert.equal(rowsOf(await w.rows(), s)[0].detail.outcome, 'failure', point);
    assert.equal(await w.sessions(), 0, point);
    const again = (await login(w, w.I1, await w.issue(s + '-again', { sub: s, groups: [A] }))).done;
    assert.equal(again.status, 302);
    assert.deepEqual(summary(rowsOf(await w.rows(), s)), [['auth.login', 'session_failed', A], ['auth.login', 'success', A]], point);
    await w.base.authSession.deleteMany({});
  }
  // (2) logout: 500, the session kept, no row, no cookie; Keycloak was asked once. Retried: 204 and one logout row.
  for (const point of ['tx.delete', 'tx.audit']) {
    const s = sub(), v = await w.issue(s, { sub: s, groups: [B] }), sid = await w.session(v), logouts = kc.logouts;
    w.fault('I1', point, dbError('logout-' + point));
    const out = await w.call(w.I1, 'logout', { sid });
    assert.ok(storageFailure(out), point);
    assert.deepEqual([out.cookie, await w.version(sid), kc.logouts - logouts], ['K', s, 1], point);
    assert.deepEqual(rowsOf(await w.rows(), s), [], point);
    const retry = await w.call(w.I1, 'logout', { sid });
    assert.deepEqual([retry.status, retry.cookie], [204, 'E'], point);
    assert.deepEqual(summary(rowsOf(await w.rows(), s)), [['auth.logout', 'logout', B]], point);
  }
  // ... and when Keycloak has meanwhile refused the session, the retry ends it in the guard: refresh_failed, no logout row.
  {
    const s = sub(), sid = await w.session(await w.issue(s, { sub: s, groups: [A], expIn: 60 }));
    w.fault('I1', 'tx.delete', dbError('logout-kc'));
    assert.ok(storageFailure(await w.call(w.I1, 'logout', { sid })));
    w.tick(45_000);
    kc.auto = () => reply.reject();
    const retry = await w.call(w.I1, 'logout', { sid });
    kc.auto = null;
    assert.deepEqual([retry.status, retry.body?.message, retry.cookie], [401, REFUSED, 'E']);
    assert.deepEqual(summary(rowsOf(await w.rows(), s)), [['auth.session.expired', 'refresh_failed', A]]);
  }
  // (3) account switch and registration: 500, no pending cookie, no redirect, the session kept; then 302 and one row.
  for (const [kind, query, point] of [['login', { prompt: 'login' }, 'tx.delete'], ['register', {}, 'tx.audit']]) {
    const s = sub(), sid = await w.session(await w.issue(s, { sub: s, groups: [B] }));
    w.fault('I2', point, dbError('switch-' + point));
    const out = await w.call(w.I2, kind, { sid, query });
    assert.ok(storageFailure(out), kind);
    assert.deepEqual([out.cookie, out.pending, out.location, await w.version(sid)], ['K', null, null, s], kind);
    assert.deepEqual(rowsOf(await w.rows(), s), [], kind);
    const retry = await w.call(w.I2, kind, { sid, query });
    assert.deepEqual([retry.status, retry.cookie, await w.version(sid)], [302, 'E+P', null], kind);
    assert.deepEqual(summary(rowsOf(await w.rows(), s)), [['auth.logout', 'account_switch', B]], kind);
  }
  // (4) idle: 500 before the handler, no cookie change; then 401 and one idle row.
  for (const point of ['tx.delete', 'tx.audit']) {
    const s = sub(), sid = await w.session(await w.issue(s, { sub: s, groups: [A] }), { lastSeenAt: past(13 * HOUR) });
    w.fault('I1', point, dbError('idle-' + point));
    const handled = w.I1.handled;
    const out = await w.call(w.I1, 'get', { sid });
    assert.ok(storageFailure(out), point);
    assert.deepEqual([out.cookie, w.I1.handled - handled, await w.version(sid)], ['K', 0, s], point);
    const retry = await w.call(w.I1, 'get', { sid });
    assert.deepEqual([retry.status, retry.body?.message, retry.cookie], [401, EXPIRED, 'E'], point);
    assert.deepEqual(summary(rowsOf(await w.rows(), s)), [['auth.session.expired', 'idle', A]], point);
  }
  // (5) a refused refresh whose end fails: 500 (not 401), the session as it was; retried with Keycloak still refusing:
  // 401 and exactly one refresh_failed row; retried with Keycloak answering: authenticated, a new version, no row.
  for (const [point, retryAnswer] of [['tx.delete', 'reject'], ['tx.audit', 'tokens']]) {
    const s = sub(), sid = await w.session(await w.issue(s, { sub: s, groups: [B] }), { atExpiresAt: past() });
    const next = await w.issue(s + '-next', { sub: s, groups: [B] });
    kc.auto = () => reply.reject();
    w.fault('I1', point, dbError('refused-' + point));
    const handled = w.I1.handled;
    const out = await w.call(w.I1, 'get', { sid });
    assert.ok(storageFailure(out), point);
    assert.deepEqual([out.cookie, w.I1.handled - handled, await w.version(sid)], ['K', 0, s], point);
    assert.deepEqual(rowsOf(await w.rows(), s), [], point);
    kc.auto = () => retryAnswer === 'reject' ? reply.reject() : reply.tokens(next);
    const retry = await w.call(w.I1, 'get', { sid });
    kc.auto = null;
    if (retryAnswer === 'reject') {
      assert.deepEqual([retry.status, retry.body?.message, retry.cookie, await w.version(sid)], [401, REFUSED, 'E', null], point);
      assert.deepEqual(summary(rowsOf(await w.rows(), s)), [['auth.session.expired', 'refresh_failed', B]], point);
    } else {
      assert.deepEqual([retry.status, retry.cookie, await w.version(sid)], [200, 'K', s + '-next'], point);
      assert.deepEqual(rowsOf(await w.rows(), s), [], point);
    }
  }
  // (6) storing a successful refresh fails: 500, not refresh_failed, the old version kept; the next request decides anew.
  for (const nextAnswer of ['reject', 'accept']) {
    const s = sub(), sid = await w.session(await w.issue(s, { sub: s, groups: [A] }), { atExpiresAt: past() });
    const next = await w.issue(s + '-next', { sub: s, groups: [A] }), later = await w.issue(s + '-later', { sub: s, groups: [A] });
    kc.auto = () => reply.tokens(next);
    w.fault('I1', 'store', dbError('store-' + nextAnswer));
    const out = await w.call(w.I1, 'get', { sid });
    assert.ok(storageFailure(out), nextAnswer);
    assert.deepEqual([out.cookie, await w.version(sid)], ['K', s], nextAnswer);
    kc.auto = () => nextAnswer === 'reject' ? reply.reject() : reply.tokens(later);
    const retry = await w.call(w.I1, 'get', { sid });
    kc.auto = null;
    if (nextAnswer === 'reject') {
      assert.deepEqual([retry.status, retry.body?.message, retry.cookie], [401, REFUSED, 'E']);
      assert.deepEqual(summary(rowsOf(await w.rows(), s)), [['auth.session.expired', 'refresh_failed', A]]);
    } else {
      assert.deepEqual([retry.status, await w.version(sid)], [200, s + '-later']);
      assert.deepEqual(rowsOf(await w.rows(), s), []);
    }
  }
  // (7) the sweep: one target's end fails and rolls back alone; the others end; the next run ends it.
  w.I2.service.onModuleInit();
  try {
    const before = (await w.rows()).length;
    const subs = [];
    for (const inst of [A, B, Z]) { const s = sub(); subs.push(s); await w.session(await w.issue(s, { sub: s, groups: [inst] }), { lastSeenAt: past(13 * HOUR) }); }
    w.fault('I2', 'tx.delete', dbError('sweep'));
    const opened = w.calls.filter(c => c === 'I2:tx.open').length;
    w.tick(HOUR);
    const left = async () => w.base.authSession.count({ where: { sub: { in: subs } } });
    await w.until('the sweep run with one failure', async () => w.calls.filter(c => c === 'I2:tx.open').length === opened + 3
      && (await w.rows()).length === before + 2);
    assert.equal(await left(), 1);
    assert.ok(capture.texts.some(([, text]) => /auth_storage category=sweep_target/.test(text)), 'a fixed category is logged');
    w.tick(HOUR);
    await w.until('the next sweep run', async () => (await w.rows()).length === before + 3);
    assert.equal(await left(), 0);
    assert.deepEqual(summary((await w.rows()).filter(r => subs.includes(r.target))),
      [['auth.session.expired', 'sweep', A], ['auth.session.expired', 'sweep', B], ['auth.session.expired', 'sweep', Z]]);
  } finally {
    w.I2.service.onModuleDestroy();
  }
  assert.equal(w.faults.length, 0, 'every injected failure was reached');
  await w.finish('AS-09', { output: ['login-tx.create', 'login-tx.audit', 'logout-tx.delete', 'logout-tx.audit', 'logout-kc',
    'switch-tx.delete', 'switch-tx.audit', 'idle-tx.delete', 'idle-tx.audit', 'refused-tx.delete', 'refused-tx.audit',
    'store-reject', 'store-accept', 'sweep'].flatMap(markers) });
});

// ── AS-10: fields, secrets and the output boundary ──

test('AS-10 (a) the address is the proxy\'s X-Real-IP only; every row has its exact keys and no secret (checked at every world end)', async t => {
  const w = await world(t);
  const cases = [['syn-sub-p1', { ip: IP, headers: { 'x-forwarded-for': '203.0.113.8, ' + IP } }, IP],
    ['syn-sub-p2', { ip: 'not-an-ip' }, null], ['syn-sub-p3', { ip: '2001:db8::7' }, '2001:db8::7'], ['syn-sub-p4', { ip: null }, null]];
  for (const [s, request, expected] of cases) {
    const out = await w.call(w.I1, 'logout', { sid: await w.session(await w.issue(s, { sub: s, groups: [A] })), ...request });
    assert.equal(out.status, 204, s);
    assert.deepEqual(rowsOf(await w.rows(), s).map(r => r.detail.ip), [expected], s);
  }
  await w.finish('AS-10a');
});

test('AS-10 (b) synthetic DB error markers never reach a response, the logger, stdout/stderr or a timer rejection', async t => {
  const w = await world(t);
  const rejections = [];
  const onRejection = reason => rejections.push(String(reason?.stack ?? reason));
  process.on('unhandledRejection', onRejection);
  const scenarios = [];
  const run = async (tag, body) => {
    const from = capture.texts.length, answers = w.responses.length;
    await body(tag);
    scenarios.push({ tag, output: capture.texts.slice(from).map(([, text]) => text), responses: w.responses.slice(answers).flat() });
  };
  try {
    const session = async (tag, options = {}) => w.session(await w.issue(tag, { sub: 'syn-sub-' + tag, groups: [A] }), options);
    await run('guard-read', async tag => { const sid = await session(tag); w.fault('I1', 'read', dbError(tag)); assert.ok(storageFailure(await w.call(w.I1, 'get', { sid }))); });
    await run('logout-delete', async tag => { const sid = await session(tag); w.fault('I1', 'tx.delete', dbError(tag)); assert.ok(storageFailure(await w.call(w.I1, 'logout', { sid }))); });
    await run('logout-audit', async tag => { const sid = await session(tag); w.fault('I1', 'tx.audit', dbError(tag)); assert.ok(storageFailure(await w.call(w.I1, 'logout', { sid }))); });
    await run('switch-read', async tag => { const sid = await session(tag); w.fault('I1', 'read', dbError(tag)); assert.ok(storageFailure(await w.call(w.I1, 'login', { sid, query: { prompt: 'login' } }))); });
    await run('switch-audit', async tag => { const sid = await session(tag); w.fault('I1', 'tx.audit', dbError(tag)); assert.ok(storageFailure(await w.call(w.I1, 'register', { sid }))); });
    await run('idle-delete', async tag => { const sid = await session(tag, { lastSeenAt: past(13 * HOUR) }); w.fault('I1', 'tx.delete', dbError(tag)); assert.ok(storageFailure(await w.call(w.I1, 'get', { sid }))); });
    await run('refused-audit', async tag => {
      const sid = await session(tag, { atExpiresAt: past() });
      kc.auto = () => reply.reject();
      w.fault('I1', 'tx.audit', dbError(tag));
      const out = await w.call(w.I1, 'get', { sid });
      kc.auto = null;
      assert.ok(storageFailure(out));
    });
    await run('store', async tag => {
      const sid = await session(tag, { atExpiresAt: past() }), next = await w.issue(tag + '-next', { sub: 'syn-sub-' + tag, groups: [A] });
      kc.auto = () => reply.tokens(next);
      w.fault('I1', 'store', dbError(tag));
      const out = await w.call(w.I1, 'get', { sid });
      kc.auto = null;
      assert.ok(storageFailure(out));
    });
    await run('touch', async tag => { const sid = await session(tag, { lastSeenAt: past(10 * 60_000) }); w.fault('I1', 'touch', dbError(tag)); assert.ok(storageFailure(await w.call(w.I1, 'get', { sid }))); });
    await run('login-both', async tag => {
      w.fault('I1', 'tx.create', dbError(tag));
      w.fault('I1', 'audit', dbError(tag + '-row'));
      const done = (await login(w, w.I1, await w.issue(tag, { sub: 'syn-sub-' + tag, groups: [A] }))).done;
      assert.equal(done.location, ORIGIN + '/worklist/hpacs-lite/index.html?auth_error=login_failed');
    });
    await run('callback-read', async tag => { const sid = await session(tag); w.fault('I1', 'read', dbError(tag)); assert.ok(storageFailure(await w.call(w.I1, 'callback', { sid, query: {} }))); });
    w.I2.service.onModuleInit();
    try {
      await run('sweep-read', async tag => {
        await session(tag, { lastSeenAt: past(13 * HOUR) });
        w.fault('I2', 'sweepRead', dbError(tag));
        w.tick(HOUR);
        await w.until('the failed sweep read', async () => !w.faults.length);
        await new Promise(resolve => setTimeout(resolve, 100));
      });
      await run('sweep-target', async tag => {
        const targets = await w.base.authSession.count({ where: { lastSeenAt: { lt: new Date(Date.now() + HOUR - IDLE) } } });
        const opened = w.calls.filter(c => c === 'I2:tx.open').length;
        w.fault('I2', 'tx.delete', dbError(tag));
        w.tick(HOUR);
        await w.until('the sweep over every target', async () => !w.faults.length
          && w.calls.filter(c => c === 'I2:tx.open').length === opened + targets);
        await new Promise(resolve => setTimeout(resolve, 100));
      });
    } finally {
      w.I2.service.onModuleDestroy();
    }
    assert.equal(w.faults.length, 0, 'every injected failure was reached');
    for (const scenario of scenarios) {
      const secrets = [...markers(scenario.tag), ...markers(scenario.tag + '-row')];
      const found = { responses: secretHits(scenario.responses, secrets), output: secretHits(scenario.output, secrets) };
      report(JSON.stringify({ case: 'AS-10b', scenario: scenario.tag, ...found }));
      assert.deepEqual(found, { responses: [], output: [] }, scenario.tag);
    }
    assert.deepEqual(secretHits(rejections, scenarios.flatMap(s => markers(s.tag))), [], 'timer rejections');
    // Negative control: the same Nest path handed the raw synthetic error prints its markers - the collector sees them.
    const host = (req = { headers: {} }) => new ExecutionContextHost([req, { req, sent: false }]);
    let from = capture.texts.length;
    w.exceptions.next(dbError('negative'), host());
    const negative = secretHits(capture.texts.slice(from).map(([, text]) => text), markers('negative'));
    assert.ok(negative.includes('marker-msg') && negative.includes('marker-stack'), 'the raw error reaches the logger: ' + negative.join());
    // Positive control: the service's fixed answer passes the same path with nothing to find.
    from = capture.texts.length;
    w.exceptions.next(new InternalServerErrorException({ code: 'AUTH_STORAGE_FAILURE', message: 'SYN fixed' }), host());
    assert.deepEqual(secretHits(capture.texts.slice(from).map(([, text]) => text), markers('negative')), []);
    report(JSON.stringify({ case: 'AS-10b', control: 'negative', found: negative }));
  } finally {
    process.off('unhandledRejection', onRejection);
  }
  await w.finish('AS-10b');
});

// ── AS-12: the outcome table RT-01..RT-15, one timeline each (scenario-table section 0.A) ──
// Each timeline holds Keycloak's /token answers (heldToken) and/or an instance before its next AuthSession write
// (w.gate), asserts the state at the hold where the contract names one, and ends with the remaining session (its version
// label), each request's public result, the exact set of end rows (action, cause, institution) and the cookie letters
// (K kept, E expired, E+P expired with a new pending). Rows are counted per account (target), login rows apart.

const chainAnswers = map => form => map.has(form.refresh_token) ? reply.tokens(map.get(form.refresh_token)) : reply.reject();
const endsOf = async (w, sub) => summary(rowsOf(await w.rows(), sub).filter(r => r.action !== 'auth.login'));

test('AS-12 T1 (RT-01, X-11) and its sequential attribution variants (X-18)', async t => {
  const w = await world(t);
  const s = 'syn-sub-t1';
  const v1 = await w.issue('t1-v1', { sub: s, groups: [A] }), v2 = await w.issue('t1-v2', { sub: s, groups: [B] });
  const sid = await w.session(v1, { atExpiresAt: past(), lastSeenAt: past(10 * 60_000) });
  const r1 = w.call(w.I1, 'get', { sid });
  const k1 = await heldToken(1, 'I1 refresh');
  const r2 = w.call(w.I2, 'get', { sid });
  const k2 = await heldToken(2, 'I2 refresh');
  k2.answer(reply.tokens(v2));
  const o2 = await r2;
  assert.deepEqual([o2.status, await w.version(sid)], [200, 't1-v2'], 'I2 stored and touched v2');
  k1.answer(reply.reject());
  const o1 = await r1;
  assert.deepEqual([o1.status, o1.cookie, o2.cookie, await w.version(sid), await endsOf(w, s)], [200, 'K', 'K', 't1-v2', []]);
  // X-18: after a completed refresh v1 (A) -> v2 (B), every way of ending the session records B.
  const chain = new Map();
  kc.auto = chainAnswers(chain);
  w.I2.service.onModuleInit();
  try {
    for (const [end, row] of [['switch', ['auth.logout', 'account_switch', B]], ['logout', ['auth.logout', 'logout', B]],
      ['idle', ['auth.session.expired', 'idle', B]], ['sweep', ['auth.session.expired', 'sweep', B]]]) {
      const sub = 'syn-sub-t1-' + end;
      const a = await w.issue(sub + '-a', { sub, groups: [A] }), b = await w.issue(sub + '-b', { sub, groups: [B] });
      chain.set(a.refresh, b);
      const sidX = await w.session(a, { atExpiresAt: past() });
      assert.deepEqual([(await w.call(w.I1, 'get', { sid: sidX })).status, await w.version(sidX)], [200, sub + '-b']);
      if (end === 'switch') await w.call(w.I1, 'login', { sid: sidX, query: { prompt: 'login' } });
      else if (end === 'logout') await w.call(w.I1, 'logout', { sid: sidX });
      else {
        await w.base.authSession.update({ where: { sid: sidX }, data: { lastSeenAt: past(13 * HOUR) } });
        if (end === 'idle') await w.call(w.I1, 'get', { sid: sidX });
        else { w.tick(HOUR); await w.until('the sweep', async () => (await w.version(sidX)) === null); }
      }
      assert.deepEqual(await endsOf(w, sub), [row], end);
    }
  } finally {
    w.I2.service.onModuleDestroy();
    kc.auto = null;
  }
  await w.finish('AS-12 T1');
});

test('AS-12 T1b (RT-02, X-28): two successes cross; the later one is discarded, in both arrival orders', async t => {
  const w = await world(t);
  for (const order of ['I2 first', 'I1 first']) {
    kc.held = [];
    const s = 'syn-sub-t1b-' + order.split(' ')[0];
    const v1 = await w.issue(s + '-v1', { sub: s, groups: [A] }), v2 = await w.issue(s + '-v2', { sub: s, groups: [B] });
    const v2p = await w.issue(s + '-v2p', { sub: s, groups: [A] });
    const sid = await w.session(v1, { atExpiresAt: past() });
    const r1 = w.call(w.I1, 'get', { sid });
    const k1 = await heldToken(1);
    const r2 = w.call(w.I2, 'get', { sid });
    const k2 = await heldToken(2);
    let o1, o2;
    if (order === 'I2 first') { k2.answer(reply.tokens(v2)); o2 = await r2; k1.answer(reply.tokens(v2p)); o1 = await r1; }
    else { k1.answer(reply.tokens(v2p)); o1 = await r1; k2.answer(reply.tokens(v2)); o2 = await r2; }
    assert.deepEqual([o1.status, o2.status, o1.cookie, o2.cookie, await w.version(sid), await endsOf(w, s)],
      [200, 200, 'K', 'K', order === 'I2 first' ? s + '-v2' : s + '-v2p', []], order);
  }
  await w.finish('AS-12 T1b');
});

test('AS-12 T2 (RT-03, X-12): a refusal ends v1 first; a late success or refusal adds nothing and revives nothing', async t => {
  const w = await world(t);
  for (const late of ['success', 'refusal']) {
    kc.held = [];
    const s = 'syn-sub-t2-' + late;
    const v1 = await w.issue(s + '-v1', { sub: s, groups: [A] }), v2 = await w.issue(s + '-v2', { sub: s, groups: [B] });
    const sid = await w.session(v1, { atExpiresAt: past() });
    const r1 = w.call(w.I1, 'get', { sid });
    const k1 = await heldToken(1);
    const r2 = w.call(w.I2, 'get', { sid });
    const k2 = await heldToken(2);
    k1.answer(reply.reject());
    const o1 = await r1;
    assert.deepEqual([o1.status, o1.body?.message, o1.cookie], [401, REFUSED, 'E'], late);
    k2.answer(late === 'success' ? reply.tokens(v2) : reply.reject());
    const o2 = await r2;
    assert.deepEqual([o2.status, o2.body?.message, o2.cookie, await w.version(sid), await endsOf(w, s)],
      [401, REFUSED, 'E', null, [['auth.session.expired', 'refresh_failed', A]]], late);
  }
  await w.finish('AS-12 T2');
});

test('AS-12 T3 (RT-05, X-13): a logout ends v2 while v1\'s refresh is held; the late answer revives nothing', async t => {
  const w = await world(t);
  for (const late of ['success', 'refusal']) {
    kc.held = [];
    kc.auto = null;
    const s = 'syn-sub-t3-' + late;
    const v1 = await w.issue(s + '-v1', { sub: s, groups: [A] }), v2 = await w.issue(s + '-v2', { sub: s, groups: [B] });
    const v2p = await w.issue(s + '-v2p', { sub: s, groups: [A] });
    const sid = await w.session(v1, { atExpiresAt: past() });
    const r1 = w.call(w.I1, 'get', { sid });
    const k1 = await heldToken(1, 'R1 refresh');
    kc.auto = chainAnswers(new Map([[v1.refresh, v2]]));
    const out = await w.call(w.I2, 'logout', { sid });
    kc.auto = null;
    assert.deepEqual([out.status, out.cookie, await endsOf(w, s)], [204, 'E', [['auth.logout', 'logout', B]]], late);
    k1.answer(late === 'success' ? reply.tokens(v2p) : reply.reject());
    const o1 = await r1;
    assert.deepEqual([o1.status, o1.body?.message, o1.cookie, await w.version(sid), await endsOf(w, s)],
      [401, REFUSED, 'E', null, [['auth.logout', 'logout', B]]], late);
  }
  await w.finish('AS-12 T3');
});

test('AS-12 T4 (RT-05, X-14): an account switch or registration ends v1 while its refresh is held', async t => {
  const w = await world(t);
  for (const [kind, query, late] of [['login', { prompt: 'login' }, 'success'], ['login', { prompt: 'login' }, 'refusal'],
    ['register', {}, 'success'], ['register', {}, 'refusal']]) {
    kc.held = [];
    const s = `syn-sub-t4-${kind}-${late}`;
    const v1 = await w.issue(s + '-v1', { sub: s, groups: [A] }), v2 = await w.issue(s + '-v2', { sub: s, groups: [B] });
    const sid = await w.session(v1, { atExpiresAt: past() });
    const r1 = w.call(w.I1, 'get', { sid });
    const k1 = await heldToken(1);
    const out = await w.call(w.I2, kind, { sid, query });
    assert.deepEqual([out.status, out.cookie, await endsOf(w, s)], [302, 'E+P', [['auth.logout', 'account_switch', A]]], s);
    k1.answer(late === 'success' ? reply.tokens(v2) : reply.reject());
    const o1 = await r1;
    assert.deepEqual([o1.status, o1.cookie, await w.version(sid), await endsOf(w, s)],
      [401, 'E', null, [['auth.logout', 'account_switch', A]]], s);
  }
  await w.finish('AS-12 T4');
});

test('AS-12 T5 (RT-07, X-15/X-16): the sweep or another request ends v1 idle while its refresh is held', async t => {
  const w = await world(t);
  // idle variants (X-16): R1 passes the idle check just before the cutoff; R2, after it, ends the session idle.
  for (const late of ['success', 'refusal']) {
    kc.held = [];
    const s = 'syn-sub-t5i-' + late;
    const v1 = await w.issue(s + '-v1', { sub: s, groups: [A] }), v2 = await w.issue(s + '-v2', { sub: s, groups: [B] });
    const sid = await w.session(v1, { lastSeenAt: new Date(Date.now() - IDLE + 10_000), atExpiresAt: past() });
    const r1 = w.call(w.I1, 'get', { sid });
    const k1 = await heldToken(1);
    w.tick(30_000);
    const o2 = await w.call(w.I2, 'get', { sid, ip: '198.51.100.9' });
    assert.deepEqual([o2.status, o2.body?.message, o2.cookie], [401, EXPIRED, 'E'], late);
    k1.answer(late === 'success' ? reply.tokens(v2) : reply.reject());
    const o1 = await r1;
    assert.deepEqual([o1.status, o1.body?.message, o1.cookie, await w.version(sid), await endsOf(w, s)],
      [401, REFUSED, 'E', null, [['auth.session.expired', 'idle', A]]], late);
    assert.deepEqual(rowsOf(await w.rows(), s).map(r => r.detail.ip), ['198.51.100.9'], 'the address of the request that ended it');
  }
  // sweep variants (X-15): the timer runs while R1's refresh is held.
  w.I2.service.onModuleInit();
  let due = Date.now() + HOUR;
  try {
    for (const late of ['success', 'refusal']) {
      kc.held = [];
      w.tick(due - 30_000 - Date.now());
      const s = 'syn-sub-t5s-' + late;
      const v1 = await w.issue(s + '-v1', { sub: s, groups: [A] }), v2 = await w.issue(s + '-v2', { sub: s, groups: [B] });
      const sid = await w.session(v1, { lastSeenAt: new Date(Date.now() - IDLE + 10_000), atExpiresAt: past() });
      const r1 = w.call(w.I1, 'get', { sid });
      const k1 = await heldToken(1);
      w.tick(30_000);
      await w.until('the sweep', async () => (await w.version(sid)) === null);
      k1.answer(late === 'success' ? reply.tokens(v2) : reply.reject());
      const o1 = await r1;
      assert.deepEqual([o1.status, o1.cookie, await endsOf(w, s)], [401, 'E', [['auth.session.expired', 'sweep', A]]], late);
      assert.deepEqual(rowsOf(await w.rows(), s).map(r => r.detail.ip), [null]);
      due += HOUR;
    }
  } finally {
    w.I2.service.onModuleDestroy();
  }
  await w.finish('AS-12 T5');
});

for (const fixture of ['different-exp', 'same-exp']) {
  test(`AS-08 (b) = AS-12 T6 (RT-08, X-17) ${fixture}: the sweep read v1, R stored v2 and waits before its touch; the sweep deletes nothing`, async t => {
    const w = await world(t);
    w.I2.service.onModuleInit();
    const T = Date.now() + HOUR;          // the timer's next expiry
    try {
      w.tick(HOUR - 1000);                // R starts at T - 1 s
      const s = 'syn-sub-t6';
      const v1 = await w.issue('t6-v1', { sub: s, groups: [A], expIn: fixture === 'same-exp' ? 20 : HOUR / 1000 });
      const v2 = await w.issue('t6-v2', { sub: s, groups: [B], same: fixture === 'same-exp' ? v1 : undefined, expIn: 2 * HOUR / 1000 });
      // lastSeenAt = R's start - 12 h + 0.5 s: R passes the idle check; stored atExpiresAt is past, so R refreshes.
      const atExpiresAt = fixture === 'same-exp' ? new Date(v1.exp * 1000 - 30_000) : past();
      const sid = await w.session(v1, { lastSeenAt: new Date(Date.now() - IDLE + 500), atExpiresAt });
      const sweep = w.gate('I2', 'tx.open');
      const r = w.call(w.I1, 'get', { sid });
      const k = await heldToken(1, 'R refresh');
      w.tick(1500);                       // T + 0.5 s: the idle boundary and the timer expiry both pass
      await sweep.arrived();              // the sweep read v1 and waits before its delete
      const touch = w.gate('I1', 'touch');
      k.answer(reply.tokens(v2));
      await touch.arrived();              // v2 is stored (committed); R waits before its touch
      assert.deepEqual([await w.version(sid), (await w.lastSeen(sid)) < T - IDLE], ['t6-v2', true],
        'at the hold: the session is v2 and still idle for the sweep\'s cutoff');
      if (fixture === 'same-exp')
        assert.equal((await w.base.authSession.findUnique({ where: { sid } })).atExpiresAt.getTime(), atExpiresAt.getTime(), 'same stored atExpiresAt');
      const ended = w.calls.filter(c => c === 'I2:tx:end').length;
      sweep.release();
      await w.until('the sweep delete', async () => w.calls.filter(c => c === 'I2:tx:end').length === ended + 1);
      assert.deepEqual([await w.version(sid), await endsOf(w, s)], ['t6-v2', []], 'the sweep skipped the contested session');
      touch.release();
      const out = await r;
      assert.deepEqual([out.status, out.cookie, (await w.lastSeen(sid)) >= T], [200, 'K', true]);
    } finally {
      w.I2.service.onModuleDestroy();
    }
    await w.finish('AS-12 T6 ' + fixture);
  });
}

test('AS-12 T7 (RT-13, RT-14, RT-02; X-21, X-22): same-exp tokens of different versions', async t => {
  const w = await world(t);
  const flow = async (name, steps) => {
    kc.held = [];
    const s = 'syn-sub-t7' + name;
    const exp = { exp: Math.floor(Date.now() / 1000) + 20 };
    const v = {};
    for (const [label, group] of [['v1', A], ['v2', B], ['v2p', A], ['v3', B]]) v[label] = await w.issue(`${s}-${label}`, { sub: s, groups: [group], same: exp });
    const sid = await w.session(v.v1);
    const r1 = w.call(w.I1, 'get', { sid });
    const k1 = await heldToken(1);
    const r2 = w.call(w.I2, 'get', { sid });
    const k2 = await heldToken(2);
    return steps({ s, v, sid, r1, k1, r2, k2 });
  };
  // (a) v2 stored, v1's refusal: I1 refreshes v2 anew; at that hold the session is v2 with no row. Then success or refusal.
  for (const then of ['success', 'refusal']) {
    await flow('a-' + then, async ({ s, v, sid, r1, k1, r2, k2 }) => {
      k2.answer(reply.tokens(v.v2));
      assert.equal((await r2).status, 200);
      k1.answer(reply.reject());
      const k1b = await heldToken(3, 'I1\'s refresh of v2');
      assert.ok(k1b.form.refresh_token === v.v2.refresh, 'the follow-up refresh uses v2');
      assert.deepEqual([await w.version(sid), await endsOf(w, s)], [s + '-v2', []], 'at the hold');
      k1b.answer(then === 'success' ? reply.tokens(v.v3) : reply.reject());
      const o1 = await r1;
      if (then === 'success') assert.deepEqual([o1.status, await w.version(sid), await endsOf(w, s)], [200, s + '-v3', []]);
      else assert.deepEqual([o1.status, o1.cookie, await w.version(sid), await endsOf(w, s)],
        [401, 'E', null, [['auth.session.expired', 'refresh_failed', B]]]);
    });
  }
  // (b) v2 stored, then v1's late success v2' is discarded; the follow-up refresh of v2 is held with v2 in place.
  await flow('b', async ({ s, v, sid, r1, k1, r2, k2 }) => {
    k2.answer(reply.tokens(v.v2));
    await r2;
    k1.answer(reply.tokens(v.v2p));
    const k1b = await heldToken(3);
    assert.deepEqual([await w.version(sid), await endsOf(w, s)], [s + '-v2', []], 'at the hold: v2, not v2\'');
    k1b.answer(reply.tokens(v.v3));
    assert.deepEqual([(await r1).status, await w.version(sid)], [200, s + '-v3']);
  });
  // (c) the refusal first: v1 ends (A); the late success revives nothing.
  await flow('c', async ({ s, v, sid, r1, k1, r2, k2 }) => {
    k1.answer(reply.reject());
    assert.equal((await r1).status, 401);
    k2.answer(reply.tokens(v.v2));
    assert.deepEqual([(await r2).status, await w.version(sid), await endsOf(w, s)],
      [401, null, [['auth.session.expired', 'refresh_failed', A]]]);
  });
  // (d) RT-14: Keycloak gives I2 v1's own two values - not a new version; v1's refusal then ends v1 (A).
  await flow('d', async ({ s, v, sid, r1, k1, r2, k2 }) => {
    k2.answer(reply.tokens(v.v1));
    const o2 = await r2;
    k1.answer(reply.reject());
    const o1 = await r1;
    assert.deepEqual([o2.status, o2.cookie, o1.status, o1.cookie, await w.version(sid), await endsOf(w, s)],
      [200, 'K', 401, 'E', null, [['auth.session.expired', 'refresh_failed', A]]]);
  });
  await w.finish('AS-12 T7');
});

test('AS-12 T8 (RT-06, X-23): an account switch read v1; v2 (B) is stored before its delete; it ends v2 and records B', async t => {
  const w = await world(t);
  for (const [kind, query] of [['login', { prompt: 'login' }], ['register', {}]]) {
    const s = 'syn-sub-t8-' + kind;
    const v1 = await w.issue(s + '-v1', { sub: s, groups: [A] }), v2 = await w.issue(s + '-v2', { sub: s, groups: [B] });
    const sid = await w.session(v1, { atExpiresAt: past() });
    const gate = w.gate('I1', 'tx.open');
    const sw = w.call(w.I1, kind, { sid, query });
    await gate.arrived();
    kc.auto = chainAnswers(new Map([[v1.refresh, v2]]));
    const o2 = await w.call(w.I2, 'get', { sid });
    kc.auto = null;
    assert.deepEqual([o2.status, o2.cookie, await w.version(sid)], [200, 'K', s + '-v2'], kind);
    gate.release();
    const out = await sw;
    assert.deepEqual([out.status, out.cookie, await w.version(sid), await endsOf(w, s)],
      [302, 'E+P', null, [['auth.logout', 'account_switch', B]]], kind);
  }
  await w.finish('AS-12 T8');
});

/** I1 runs an end request; between each of its reads and deletes I2 refreshes the session (rounds), then `last` runs. */
async function interleavedEnds(w, { s, kind, query = {}, rounds, groups = [B], last }) {
  const versions = [];
  for (let n = 0; n <= rounds + 2; n++) versions.push(await w.issue(`${s}-v${n}`, { sub: s, groups: n ? groups : [A], expIn: 20 }));
  const chain = new Map(versions.slice(0, -1).map((v, n) => [v.refresh, versions[n + 1]]));
  kc.auto = chainAnswers(chain);
  const sid = await w.session(versions[0]);
  let gate = w.gate('I1', 'tx.open');
  const held = w.call(w.I1, kind, { sid, query });
  for (let n = 1; n <= rounds; n++) {
    await gate.arrived();
    const current = gate;
    if (n < rounds) gate = w.gate('I1', 'tx.open');
    if (n === rounds && last) await last(sid);
    else assert.equal((await w.call(w.I2, 'get', { sid })).status, 200, 'I2\'s refresh in round ' + n);
    current.release();
  }
  const out = await held;
  kc.auto = null;
  return { out, sid, versions };
}

test('AS-12 T9 (RT-15, X-24, O-10, X-33): three interleaved refreshes give an end request 409; the next request ends it', async t => {
  const w = await world(t);
  // account switch: 409, no cookie change, no pending, no redirect, the competitor's last version kept, no row.
  let s = 'syn-sub-t9-switch';
  let { out, sid } = await interleavedEnds(w, { s, kind: 'login', query: { prompt: 'login' }, rounds: 3 });
  assert.deepEqual([out.status, out.cookie, out.pending, out.location, await endsOf(w, s)], [409, 'K', null, null, []]);
  const kept = await w.version(sid);
  assert.ok(kept && kept.startsWith(s + '-v'), 'a later version remains');
  out = await w.call(w.I1, 'login', { sid, query: { prompt: 'login' } });
  assert.deepEqual([out.status, out.cookie, await w.version(sid), await endsOf(w, s)], [302, 'E+P', null, [['auth.logout', 'account_switch', B]]]);
  // logout (the guard refreshes first; the competitor keeps winning): 409, then the next logout ends it.
  s = 'syn-sub-t9-logout';
  ({ out, sid } = await interleavedEnds(w, { s, kind: 'logout', rounds: 3 }));
  assert.deepEqual([out.status, out.cookie, await endsOf(w, s)], [409, 'K', []]);
  // The next logout's guard refreshes the kept version once more (its stored atExpiresAt is past), then ends it.
  const after = await w.issue(s + '-after', { sub: s, groups: [B], expIn: 3600 });
  kc.auto = () => reply.tokens(after);
  out = await w.call(w.I1, 'logout', { sid });
  kc.auto = null;
  assert.deepEqual([out.status, out.cookie, await w.version(sid), await endsOf(w, s)], [204, 'E', null, [['auth.logout', 'logout', B]]]);
  // X-33: after the third conflict the session is already gone (I2 logged out): the end completes, 409 is not given,
  // and the row is the one of the transition that deleted it.
  for (const kind of ['login', 'logout']) {
    s = 'syn-sub-t9-absent-' + kind;
    ({ out, sid } = await interleavedEnds(w, { s, kind, query: kind === 'login' ? { prompt: 'login' } : {}, rounds: 3,
      last: async sidX => assert.equal((await w.call(w.I2, 'logout', { sid: sidX })).status, 204) }));
    assert.deepEqual([out.status, out.cookie, await w.version(sid), await endsOf(w, s)],
      [kind === 'login' ? 302 : 204, kind === 'login' ? 'E+P' : 'E', null, [['auth.logout', 'logout', B]]], kind);
  }
  await w.finish('AS-12 T9');
});

test('AS-12 T10 (RT-06, X-25): a logout read v1\' (A); v2 (B) is stored before its delete; it ends v2 and records B', async t => {
  const w = await world(t);
  const s = 'syn-sub-t10';
  const v1 = await w.issue(s + '-v1', { sub: s, groups: [A], expIn: 20 });
  const v1p = await w.issue(s + '-v1p', { sub: s, groups: [A], expIn: 20 });
  const v2 = await w.issue(s + '-v2', { sub: s, groups: [B], expIn: 20 });
  kc.auto = chainAnswers(new Map([[v1.refresh, v1p], [v1p.refresh, v2]]));
  const sid = await w.session(v1);
  const gate = w.gate('I1', 'tx.open');
  const held = w.call(w.I1, 'logout', { sid });
  await gate.arrived();
  assert.equal(await w.version(sid), s + '-v1p', 'the logout\'s guard refreshed v1 to v1\'');
  assert.equal((await w.call(w.I2, 'get', { sid })).status, 200);
  assert.equal(await w.version(sid), s + '-v2');
  gate.release();
  const out = await held;
  kc.auto = null;
  assert.deepEqual([out.status, out.cookie, await w.version(sid), await endsOf(w, s)], [204, 'E', null, [['auth.logout', 'logout', B]]]);
  await w.finish('AS-12 T10');
});

test('AS-12 T11 (RT-15, X-26, X-33): a request whose every refresh write loses three times gets 409; the next succeeds', async t => {
  const w = await world(t);
  const run = async (s, last) => {
    kc.held = [];
    const versions = [], mine = [];
    for (let n = 0; n <= 4; n++) versions.push(await w.issue(`${s}-v${n}`, { sub: s, groups: [B], expIn: 20 }));
    for (let n = 0; n <= 4; n++) mine.push(await w.issue(`${s}-mine${n}`, { sub: s, groups: [B], expIn: 20 }));
    // Per refresh token: the first request (I1, which asks first) gets I1's answer, the second (I2) the competitor's.
    const asked = new Map();
    kc.auto = form => {
      const n = versions.findIndex(v => v.refresh === form.refresh_token);
      if (n < 0) return reply.reject();
      const times = (asked.get(n) ?? 0) + 1;
      asked.set(n, times);
      return reply.tokens(times === 1 ? mine[n] : versions[n + 1]);
    };
    const sid = await w.session(versions[0]);
    const tokens = kc.tokens, handled = w.I1.handled;
    let gate = w.gate('I1', 'store');
    const held = w.call(w.I1, 'get', { sid });
    for (let n = 1; n <= 3; n++) {
      await gate.arrived();
      const current = gate;
      if (n < 3) gate = w.gate('I1', 'store');
      if (n === 3 && last) await last(sid);
      else assert.equal((await w.call(w.I2, 'get', { sid })).status, 200, 'I2 stores first in round ' + n);
      current.release();
    }
    const out = await held;
    return { out, sid, versions, tokens: kc.tokens - tokens, handled: w.I1.handled - handled };
  };
  let s = 'syn-sub-t11';
  const { out, sid, tokens, handled } = await run(s);
  assert.deepEqual([out.status, out.cookie, handled, await w.version(sid), await endsOf(w, s), tokens],
    [409, 'K', 0, s + '-v3', [], 6], 'three lost writes: 409, the competitor\'s v3 kept, no fourth /token from I1');
  const next = await w.call(w.I1, 'get', { sid });
  kc.auto = null;
  assert.deepEqual([next.status, await w.version(sid)], [200, s + '-mine3'], 'the next request starts a new limit');
  // X-33: after the third lost write the session is gone (I2 logged out): 401, not 409.
  s = 'syn-sub-t11-absent';
  const absent = await run(s, async sidX => assert.equal((await w.call(w.I2, 'logout', { sid: sidX })).status, 204));
  kc.auto = null;
  assert.deepEqual([absent.out.status, absent.out.body?.message, absent.out.cookie, await w.version(absent.sid), await endsOf(w, s)],
    [401, REFUSED, 'E', null, [['auth.logout', 'logout', B]]]);
  await w.finish('AS-12 T11');
});

test('AS-12 T12 (RT-09, X-29): R2 judged v1 idle and waits; R stored v2 (B) - (a) touched: R2 proceeds; (b) not yet: R2 ends v2, idle B', async t => {
  const w = await world(t);
  for (const variant of ['a', 'b']) {
    kc.held = [];
    const s = 'syn-sub-t12' + variant;
    const v1 = await w.issue(s + '-v1', { sub: s, groups: [A] }), v2 = await w.issue(s + '-v2', { sub: s, groups: [B] });
    const sid = await w.session(v1, { lastSeenAt: new Date(Date.now() - IDLE + 500), atExpiresAt: past() });
    const r = w.call(w.I1, 'get', { sid });
    const k = await heldToken(1, 'R refresh');
    w.tick(1000);
    const gate2 = w.gate('I2', 'tx.open');
    const r2 = w.call(w.I2, 'get', { sid, ip: '198.51.100.9' });
    await gate2.arrived();
    const cutoff2 = Date.now() - IDLE;
    if (variant === 'a') {
      k.answer(reply.tokens(v2));
      assert.equal((await r).status, 200);
      assert.deepEqual([await w.version(sid), (await w.lastSeen(sid)) >= cutoff2], [s + '-v2', true], '(a) at the hold: v2, fresh');
      gate2.release();
      const o2 = await r2;
      assert.deepEqual([o2.status, o2.cookie, await w.version(sid), await endsOf(w, s)], [200, 'K', s + '-v2', []], '(a)');
    } else {
      const touch = w.gate('I1', 'touch');
      k.answer(reply.tokens(v2));
      await touch.arrived();
      assert.deepEqual([await w.version(sid), (await w.lastSeen(sid)) < cutoff2], [s + '-v2', true], '(b) at the hold: v2 stored, still idle');
      gate2.release();
      const o2 = await r2;
      assert.deepEqual([o2.status, o2.body?.message, o2.cookie, await w.version(sid), await endsOf(w, s)],
        [401, EXPIRED, 'E', null, [['auth.session.expired', 'idle', B]]], '(b) exactly one idle row, institution B');
      touch.release();
      assert.deepEqual([(await r).status, (await r).cookie], [200, 'K'], '(b) R, already adopted, completes');
    }
  }
  await w.finish('AS-12 T12');
});

test('AS-12 T13 (RT-10, X-30): a touch makes v1 fresh before a held idle or sweep delete of the same version', async t => {
  const w = await world(t);
  // idle variant
  let s = 'syn-sub-t13i';
  let sid = await w.session(await w.issue(s + '-v1', { sub: s, groups: [A] }), { lastSeenAt: new Date(Date.now() - IDLE + 500) });
  let touch = w.gate('I1', 'touch');
  let r = w.call(w.I1, 'get', { sid });
  await touch.arrived();
  w.tick(1000);
  const gate2 = w.gate('I2', 'tx.open');
  const r2 = w.call(w.I2, 'get', { sid });
  await gate2.arrived();
  touch.release();
  assert.equal((await r).status, 200);
  gate2.release();
  const o2 = await r2;
  assert.deepEqual([o2.status, o2.cookie, await w.version(sid), await endsOf(w, s)], [200, 'K', s + '-v1', []]);
  // sweep variant
  w.I2.service.onModuleInit();
  try {
    w.tick(HOUR - 500);
    s = 'syn-sub-t13s';
    sid = await w.session(await w.issue(s + '-v1', { sub: s, groups: [A] }), { lastSeenAt: new Date(Date.now() - IDLE + 300) });
    touch = w.gate('I1', 'touch');
    r = w.call(w.I1, 'get', { sid });
    await touch.arrived();
    const sweep = w.gate('I2', 'tx.open');
    w.tick(1000);
    await sweep.arrived();
    touch.release();
    assert.equal((await r).status, 200);
    const ended = w.calls.filter(c => c === 'I2:tx:end').length;
    sweep.release();
    await w.until('the sweep delete', async () => w.calls.filter(c => c === 'I2:tx:end').length === ended + 1);
    assert.deepEqual([await w.version(sid), await endsOf(w, s)], [s + '-v1', []]);
  } finally {
    w.I2.service.onModuleDestroy();
  }
  await w.finish('AS-12 T13');
});

test('AS-12 T14 (RT-11, X-31): idle or sweep ends v1 before the touch of an adopted request; that request completes', async t => {
  const w = await world(t);
  let s = 'syn-sub-t14i';
  let sid = await w.session(await w.issue(s + '-v1', { sub: s, groups: [A] }), { lastSeenAt: new Date(Date.now() - IDLE + 500) });
  let touch = w.gate('I1', 'touch');
  let r = w.call(w.I1, 'get', { sid });
  await touch.arrived();
  w.tick(1000);
  assert.equal((await w.call(w.I2, 'get', { sid })).status, 401);
  touch.release();
  let o = await r;
  assert.deepEqual([o.status, o.cookie], [200, 'K'], 'the adopted request completes');
  o = await w.call(w.I1, 'get', { sid });
  assert.deepEqual([o.status, o.body?.message, o.cookie, await endsOf(w, s)], [401, ABSENT, 'E', [['auth.session.expired', 'idle', A]]]);
  w.I2.service.onModuleInit();
  try {
    w.tick(HOUR - 500);
    s = 'syn-sub-t14s';
    sid = await w.session(await w.issue(s + '-v1', { sub: s, groups: [B] }), { lastSeenAt: new Date(Date.now() - IDLE + 300) });
    touch = w.gate('I1', 'touch');
    r = w.call(w.I1, 'get', { sid });
    await touch.arrived();
    w.tick(1000);
    await w.until('the sweep', async () => (await w.version(sid)) === null);
    touch.release();
    o = await r;
    assert.deepEqual([o.status, o.cookie], [200, 'K']);
    o = await w.call(w.I1, 'get', { sid });
    assert.deepEqual([o.status, o.body?.message, o.cookie, await endsOf(w, s)], [401, ABSENT, 'E', [['auth.session.expired', 'sweep', B]]]);
  } finally {
    w.I2.service.onModuleDestroy();
  }
  await w.finish('AS-12 T14');
});

test('AS-12 T15 (RT-12, X-32): two end transitions overlap; the one that deleted writes the one row', async t => {
  const w = await world(t);
  // (b) logout against account switch, both orders.
  for (const [first, firstKind, secondKind, row] of [['I1', 'logout', 'login', ['auth.logout', 'account_switch', A]],
    ['I1', 'login', 'logout', ['auth.logout', 'logout', A]]]) {
    const s = `syn-sub-t15-${firstKind}-held`;
    const sid = await w.session(await w.issue(s + '-v1', { sub: s, groups: [A] }));
    const gate = w.gate(first, 'tx.open');
    const query = kind => kind === 'login' ? { prompt: 'login' } : {};
    const held = w.call(w.I1, firstKind, { sid, query: query(firstKind) });
    await gate.arrived();
    const won = await w.call(w.I2, secondKind, { sid, query: query(secondKind) });
    gate.release();
    const lost = await held;
    const done = kind => kind === 'login' ? [302, 'E+P'] : [204, 'E'];
    assert.deepEqual([[won.status, won.cookie], [lost.status, lost.cookie], await endsOf(w, s)],
      [done(secondKind), done(firstKind), [row]], s);
  }
  // (c) a logout meeting the absence in the guard.
  const s = 'syn-sub-t15c';
  const sid = await w.session(await w.issue(s + '-v1', { sub: s, groups: [A] }));
  assert.equal((await w.call(w.I2, 'logout', { sid })).status, 204);
  const late = await w.call(w.I1, 'logout', { sid });
  assert.deepEqual([late.status, late.body?.message, late.cookie, await endsOf(w, s)], [401, ABSENT, 'E', [['auth.logout', 'logout', A]]]);
  // (a) a logout past its guard waits before its delete; the sweep ends the session first; the logout completes on the
  // absence and adds no row.
  w.I2.service.onModuleInit();
  try {
    const s2 = 'syn-sub-t15a';
    const sid2 = await w.session(await w.issue(s2 + '-v1', { sub: s2, groups: [A], expIn: 24 * 3600 }));
    const gate = w.gate('I1', 'tx.open');
    const held = w.call(w.I1, 'logout', { sid: sid2 });
    await gate.arrived();
    w.tick(13 * HOUR);
    await w.until('the sweep', async () => (await w.version(sid2)) === null);
    gate.release();
    const out = await held;
    assert.deepEqual([out.status, out.cookie, await endsOf(w, s2)], [204, 'E', [['auth.session.expired', 'sweep', A]]]);
  } finally {
    w.I2.service.onModuleDestroy();
  }
  await w.finish('AS-12 T15');
});
