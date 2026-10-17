'use strict';
/* EMR-B2-BASE over a disposable PostgreSQL (TEST-B2SH-01, 04-07, 16; validate.yml runtime step "EMR-B2 base startup
 * owner, fatal exit, stop during the start and drain over a disposable database"). Runs inside the compiled API image (/app/dist) with
 * the provisioned and migrated database at KIN_EMR_B2_RUNTIME_URL (the runtime role) and KIN_EMR_B2_INSTALLER_URL (the
 * installer, for the refusal case only). Every start is the real main.ts in its own process (startup_fixture.cjs, db:
 * 'pg': no client, SQL or Prisma substitution), on a state directory of the image's own user under /tmp.
 * P01 base order to the listener, one client and store, a second owner refused before recovery, SIGTERM with a request
 * in flight; P02 restart recovery on the same state; P03 the installer credential refused at the role check; P04 SIGTERM
 * while the start recovers: no composition, the real client released once, the process ends by the signal.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const { test } = require('node:test');
const startup = require('./startup_fixture.cjs');

const RUNTIME = process.env.KIN_EMR_B2_RUNTIME_URL, INSTALLER = process.env.KIN_EMR_B2_INSTALLER_URL;
const env = (state, overrides = {}) => startup.environment(state, { DATABASE_URL: RUNTIME, ...overrides });
const get = (port, pathname) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: pathname }, res => {
    let body = ''; res.setEncoding('utf8');
    res.on('data', chunk => { body += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
  }).on('error', reject);
});
const inOrder = (names, expected) => {
  const at = expected.map(name => names.indexOf(name));
  assert(at.every(index => index >= 0), JSON.stringify({ missing: expected.filter((_, n) => at[n] < 0), names }));
  assert.deepEqual([...at].sort((a, b) => a - b), at, JSON.stringify(names));
};
const count = (names, name) => names.filter(item => item === name).length;
const LINE = /^\[KIN API\] 기동 실패\(([a-z]+)(?:\/([A-Za-z0-9]+))?\): [^\n]+\. 기동을 중단합니다\.$/;
const closed = result => { assert.deepEqual([result.code, result.stderrLines.length], [1, 1], result.stderr); return LINE.exec(result.stderrLines[0]).slice(1, 3); };
const state = startup.stateDirectory('pg');

test('P00 the disposable database is given (no silent pass without it)', () => {
  assert.match(RUNTIME ?? '', /^postgresql:\/\/kin_runtime@/);
  assert.match(INSTALLER ?? '', /^postgresql:\/\/postgres@/);
});

test('P01 the real start over PostgreSQL: owner before init and listener, one client and store, a second owner refused, then SIGTERM with a request in flight', async () => {
  const seen = {};
  const result = await startup.run({ db: 'pg', slowMillis: 1500 }, { env: env(state), timeoutMs: 180000, onEvent: async (event, child) => {
    if (event.what === 'listening') {
      seen.port = event.port;
      seen.health = await get(event.port, '/api/health');
      seen.me = await get(event.port, '/api/me');
      seen.second = await startup.run({ db: 'pg' }, { env: env(state), timeoutMs: 120000 });
      child.send('resources');
    }
    if (event.what === 'resources') { seen.resources = event; seen.slow = get(seen.port, '/syn-slow'); }
    if (event.what === 'slow-begin') child.kill('SIGTERM');
  } });
  inOrder(result.names, ['created', 'start', 'client', 'connect', 'fence', 'ledger', 'recovery', 'recovered', 'compose', 'ready', 'init',
    'auth-init', 'initialized', 'bind', 'listening', 'slow-begin', 'server-close', 'slow-done', 'server-closed',
    'runtime-onApplicationShutdown', 'owner-close', 'disconnect']);
  for (const name of ['client', 'fence', 'recovery', 'compose', 'disconnect']) assert.equal(count(result.names, name), 1, name);
  const { health, me, resources, second } = seen;
  assert.deepEqual([health.status, JSON.parse(health.body).ok, health.headers['cache-control'], me.status], [200, true, 'no-store', 401]);
  assert.deepEqual([resources.same, resources.frozen, resources.clients, resources.stores, resources.ordinarySeparate], [true, true, 1, 1, true]);
  const client = result.events.find(e => e.what === 'client');
  assert.deepEqual([client.poolSize, client.connectionLimit, resources.poolSize], [6, 6, 6]);
  assert.deepEqual(closed(second), ['fence', 'EmrStateOwnerBusy']);
  assert.equal(second.events.find(e => e.what === 'fence').owner, false);
  assert(!second.names.includes('recovery') && !second.names.includes('bind'), 'no second recovery beside the live owner');
  const answer = await seen.slow;
  assert.deepEqual([answer.status, answer.body], [200, 'slow-ok'], 'the request in flight was answered');
  assert.deepEqual([result.signal, result.timedOut], ['SIGTERM', false]);
});

test('P02 a new process on the same state recovers it at its own start and serves again', async () => {
  let recovered = null;
  const result = await startup.run({ db: 'pg' }, { env: env(state), timeoutMs: 120000, onEvent: (event, child) => {
    if (event.what === 'recovered') recovered = event;
    if (event.what === 'listening') child.kill('SIGTERM');
  } });
  assert.deepEqual([recovered.recovered, recovered.notCommitted], [0, 0]);
  assert(fs.existsSync(state + '/seal'), 'the state of the first process is the one recovered');
  assert.deepEqual([result.signal, count(result.names, 'disconnect')], ['SIGTERM', 1]);
});

test('P03 the installer credential in production is refused at the role check: one closed line, no fence, init hook or listener', async () => {
  const dir = startup.stateDirectory('pg-role');
  const result = await startup.run({ db: 'pg' }, { env: env(dir, { DATABASE_URL: INSTALLER }), timeoutMs: 120000 });
  assert.deepEqual(closed(result), ['role', 'EmrRuntimeRefused']);
  for (const leaked of ['not-the-runtime-role', 'rolsuper', 'postgres@', '[Nest]']) assert(!(result.stdout + result.stderr).includes(leaked), leaked);
  assert(!result.names.includes('fence') && !result.names.includes('auth-init') && !result.names.includes('bind'));
  assert.equal(count(result.names, 'disconnect'), 1);
});

test('P04 SIGTERM while the start recovers over PostgreSQL ends the start there: no composition or listener, the client released once, exit by the signal', async () => {
  const dir = startup.stateDirectory('pg-held');
  const result = await startup.run({ db: 'pg', hold: 'recovery' }, { env: env(dir), timeoutMs: 120000, onEvent: (event, child) => {
    if (event.what === 'held') child.kill('SIGTERM');
    if (event.what === 'runtime-onApplicationShutdown') child.send('release');
  } });
  assert.deepEqual([result.code, result.signal, result.timedOut], [null, 'SIGTERM', false], result.stderr);
  assert.equal(result.stderrLines.length, 1, result.stderr);
  assert.deepEqual(LINE.exec(result.stderrLines[0]).slice(1, 3), ['recovery', 'EmrStartupInterrupted']);
  inOrder(result.names, ['fence', 'recovery', 'held', 'owner-close', 'runtime-onApplicationShutdown', 'released', 'disconnect', 'start-failed']);
  for (const name of ['compose', 'ready', 'init', 'bind']) assert(!result.names.includes(name), name);
  assert.equal(count(result.names, 'disconnect'), 1);
});
