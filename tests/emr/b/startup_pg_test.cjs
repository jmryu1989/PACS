'use strict';
/* EMR-B2 (d) over a disposable PostgreSQL (TEST-B2R-02/04/05/07; validate.yml runtime step "EMR-B2 (d) launcher over a
 * disposable database"). Runs inside the compiled API image (/app/dist) with the provisioned and migrated database at
 * KIN_EMR_B2_RUNTIME_URL (the runtime role) and KIN_EMR_B2_INSTALLER_URL (the installer, for the refusal case only).
 * Every start is the real main.ts - its launcher, the real Nest, the real B1 fence, journal, seal and client - in its own
 * process (startup_fixture.cjs, db: 'pg': no client, SQL or Prisma substitution), on a state directory of the image's
 * own user under /tmp, stopped by the OS signal (Linux).
 * P01 base order to the listener, one client and store, the record port by value, a second owner refused before
 * recovery while the first serves, SIGTERM with a request in flight; P02 restart recovery on the same state; P03 the
 * installer credential refused at the role check; P04 SIGTERM while the start recovers: no composition, no application,
 * the real client released once; P05 real recording work through the port - a standalone fact, a business transaction
 * with its fact, a settled failure - and a stop while a confirm is in flight: the fence is kept (a second owner refused
 * during the drain), the work drains, the receipt is genuine, and the restart recovers nothing; P06 a stop whose drain
 * grace a held transaction exceeds: the client is cut, the process ends 1 with the drain line, and the restart settles
 * the attempt as not committed (its intent without a marker) - distinct from P05's committed and sealed entry.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const startup = require('./startup_fixture.cjs');

const RUNTIME = process.env.KIN_EMR_B2_RUNTIME_URL, INSTALLER = process.env.KIN_EMR_B2_INSTALLER_URL;
const env = (state, overrides = {}) => startup.environment(state, { DATABASE_URL: RUNTIME, ...overrides });
const get = (port, pathname) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: pathname, agent: false }, res => {
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
const STOP_LINE = /^\[KIN API\] 종료 실패\(([a-z]+)\): [^\n]+\. 프로세스를 끝냅니다\.$/;
const closed = result => { assert.deepEqual([result.code, result.stderrLines.length], [1, 1], result.stderr); return LINE.exec(result.stderrLines[0]).slice(1, 3); };
const stoppedStart = (result, phase) => {
  assert.deepEqual([result.code, result.signal, result.timedOut, result.stderrLines.length], [0, null, false, 1], result.stderr);
  assert.deepEqual(LINE.exec(result.stderrLines[0]).slice(1, 3), [phase, 'EmrStartupInterrupted']);
};
const state = startup.stateDirectory('pg');

test('P00 the disposable database is given (no silent pass without it)', () => {
  assert.match(RUNTIME ?? '', /^postgresql:\/\/kin_runtime@/);
  assert.match(INSTALLER ?? '', /^postgresql:\/\/postgres@/);
  assert.equal(startup.SIGNAL_MODE, 'kill', 'the OS signal is what this suite proves');
});

test('P01 the real start over PostgreSQL: owner before create, init and listener, one client and store, the port by value, a second owner refused, then SIGTERM with a request in flight', async () => {
  const seen = {};
  const result = await startup.run({ db: 'pg', slowMillis: 1500 }, { env: env(state), timeoutMs: 180000, onEvent: async (event, child) => {
    if (event.what === 'listening') {
      seen.port = event.port;
      seen.health = await get(event.port, '/api/health');
      seen.me = await get(event.port, '/api/me');
      seen.second = await startup.run({ db: 'pg' }, { env: env(state), timeoutMs: 120000 });
      child.send('port-facts');
    }
    if (event.what === 'port-facts') { seen.facts = event; seen.slow = get(seen.port, '/syn-slow'); }
    if (event.what === 'slow-begin') startup.stop(child, 'SIGTERM');
  } });
  inOrder(result.names, ['start', 'client', 'connect', 'connected', 'fence', 'ledger', 'recovery', 'recovered', 'compose', 'ready', 'create', 'created', 'init',
    'auth-init', 'initialized', 'bind', 'listening', 'flush', 'slow-begin', 'owner-interrupt', 'server-close', 'slow-done', 'server-closed',
    'destroy', 'prisma-shutdown', 'owner-close', 'disconnect', 'exit']);
  for (const name of ['client', 'fence', 'recovery', 'compose', 'create', 'disconnect', 'owner-interrupt']) assert.equal(count(result.names, name), 1, name);
  const { health, me, facts, second } = seen;
  assert.deepEqual([health.status, JSON.parse(health.body).ok, health.headers['cache-control'], me.status], [200, true, 'no-store', 401]);
  assert.deepEqual([facts.same, facts.keys, facts.prototypeNull, facts.present, facts.workPresent, facts.clients, facts.stores, facts.ordinarySeparate],
    [true, ['begin'], true, [], [], 1, 1, true]);
  const client = result.events.find(e => e.what === 'client'), ledger = result.events.find(e => e.what === 'ledger');
  assert.deepEqual([client.poolSize, client.connectionLimit, ledger.poolSize, ledger.sameClient], [6, 6, 6, true]);
  assert.deepEqual(closed(second), ['fence', 'EmrStateOwnerBusy']);
  assert.equal(second.events.find(e => e.what === 'fence').owner, false);
  assert(!second.names.includes('recovery') && !second.names.includes('create') && !second.names.includes('bind'), 'no second recovery or application beside the live owner');
  const answer = await seen.slow;
  assert.deepEqual([answer.status, answer.body], [200, 'slow-ok'], 'the request in flight was answered');
  assert.deepEqual([result.code, result.signal, result.timedOut, result.stderrLines], [0, null, false, []], result.stderr);
  assert.equal(result.events.find(e => e.what === 'exit').code, 0);
});

test('P02 a new process on the same state recovers it at its own start and serves again', async () => {
  let recovered = null;
  const result = await startup.run({ db: 'pg' }, { env: env(state), timeoutMs: 120000, onEvent: (event, child) => {
    if (event.what === 'recovered') recovered = event;
    if (event.what === 'listening') startup.stop(child, 'SIGTERM');
  } });
  assert.deepEqual([recovered.recovered, recovered.notCommitted], [0, 0]);
  assert(fs.existsSync(state + '/seal'), 'the state of the first process is the one recovered');
  assert.deepEqual([result.code, count(result.names, 'disconnect')], [0, 1]);
});

test('P03 the installer credential in production is refused at the role check: one closed line, no fence, application, init hook or listener', async () => {
  const dir = startup.stateDirectory('pg-role');
  const result = await startup.run({ db: 'pg' }, { env: env(dir, { DATABASE_URL: INSTALLER }), timeoutMs: 120000 });
  assert.deepEqual(closed(result), ['role', 'EmrRuntimeRefused']);
  for (const leaked of ['not-the-runtime-role', 'rolsuper', 'postgres@', '[Nest]']) assert(!(result.stdout + result.stderr).includes(leaked), leaked);
  assert(!result.names.includes('fence') && !result.names.includes('create') && !result.names.includes('auth-init') && !result.names.includes('bind'));
  assert.equal(count(result.names, 'disconnect'), 1);
});

test('P04 SIGTERM while the start recovers over PostgreSQL ends the start there: no composition, no application, no listener, the client released once, exit 0 by the launcher', async () => {
  const dir = startup.stateDirectory('pg-held');
  const result = await startup.run({ db: 'pg', hold: 'recovery' }, { env: env(dir), timeoutMs: 120000, onEvent: (event, child) => {
    if (event.what === 'held') startup.stop(child, 'SIGTERM');
    if (event.what === 'owner-interrupt') child.send({ cmd: 'release' });
  } });
  stoppedStart(result, 'recovery');
  inOrder(result.names, ['fence', 'recovery', 'held', 'owner-interrupt', 'released', 'recovered', 'start-failed', 'owner-close', 'disconnect', 'exit']);
  for (const name of ['compose', 'ready', 'create', 'init', 'bind']) assert(!result.names.includes(name), name);
  assert.equal(count(result.names, 'disconnect'), 1);
});

test('P05 real recording work through the port: a standalone fact, a business transaction with its fact, a settled failure, then a stop while a confirm is in flight keeps the fence, drains the work, mints a genuine receipt and leaves nothing to recover', async () => {
  const dir = startup.stateDirectory('pg-work');
  const standalone = randomUUID(), business = randomUUID(), failing = randomUUID(), held = randomUUID();
  const seen = {};
  const result = await startup.run({ db: 'pg', holdConfirm: true, slowDestroy: 300 }, { env: env(dir), timeoutMs: 180000, onEvent: async (event, child) => {
    if (event.what === 'listening') child.send({ cmd: 'record-work', eventId: standalone });
    if (event.what === 'append-done' && event.eventId === standalone) { seen.standalone = event; child.send({ cmd: 'record-transaction', eventId: business }); }
    if (event.what === 'transaction-done') { seen.business = event; child.send({ cmd: 'record-transaction', eventId: failing, fail: true }); }
    if (event.what === 'transaction-settled') { seen.failing = event; child.send({ cmd: 'record-work', eventId: held }); }
    if (event.what === 'confirm-held') {
      startup.stop(child, 'SIGTERM');
    }
    if (event.what === 'owner-interrupt') {
      // Beside the draining owner: a second process is still refused before any recovery - the fence is kept.
      seen.second = await startup.run({ db: 'pg' }, { env: env(dir), timeoutMs: 120000 });
      child.send('begin');
      child.send({ cmd: 'release' });
    }
  } });
  assert.deepEqual([result.code, result.signal, result.timedOut, result.stderrLines], [0, null, false, []], result.stderr);
  assert.deepEqual([seen.standalone.same, seen.business.same, seen.business.entries, seen.failing.callbackFailed], [true, true, 1, true]);
  assert.deepEqual(closed(seen.second), ['fence', 'EmrStateOwnerBusy'], 'the fence is kept during the drain');
  assert(!seen.second.names.includes('recovery'), 'no recovery beside the draining owner');
  const begin = result.events.find(e => e.what === 'begin');
  assert.deepEqual([begin.ok, begin.code], [false, 'EmrRecordPortClosed']);
  inOrder(result.names, ['confirm-held', 'owner-interrupt', 'confirm-released', 'append-done', 'work-ended', 'destroy', 'prisma-shutdown', 'owner-close', 'disconnect', 'exit']);
  const late = result.events.filter(e => e.what === 'append-done').find(e => e.eventId === held);
  assert.equal(late.same, true, 'the receipt of the work the stop found in flight is genuine');
  assert.deepEqual([count(result.names, 'work-ended'), count(result.names, 'disconnect')], [4, 1]);
  // The restart: every fact was committed and sealed; nothing to recover, nothing not committed.
  let recovered = null;
  const again = await startup.run({ db: 'pg' }, { env: env(dir), timeoutMs: 120000, onEvent: (event, child) => {
    if (event.what === 'recovered') recovered = event;
    if (event.what === 'listening') startup.stop(child, 'SIGTERM');
  } });
  assert.deepEqual([again.code, recovered.recovered, recovered.notCommitted], [0, 0, 0]);
});

test('P06 a transaction that outlives the drain grace: the one closed line names the drain, the process ends 1, and the restart settles the attempt as not committed - distinct from a committed entry', async () => {
  const dir = startup.stateDirectory('pg-grace');
  const stuck = randomUUID();
  const result = await startup.run({ db: 'pg', holdTransaction: true }, { env: env(dir), timeoutMs: 180000, onEvent: (event, child) => {
    if (event.what === 'listening') child.send({ cmd: 'record-transaction', eventId: stuck });
    if (event.what === 'transaction-held') startup.stop(child, 'SIGTERM');
  } });
  assert.deepEqual([result.code, result.signal, result.timedOut], [1, null, false], result.stderr);
  assert.deepEqual(result.stderrLines.map(line => STOP_LINE.exec(line)?.[1]), ['drain'], result.stderr);
  assert(!result.names.includes('transaction-done'), 'the held transaction never committed');
  inOrder(result.names, ['transaction-held', 'owner-interrupt', 'destroy', 'owner-close', 'disconnect', 'exit']);
  const stop = result.events.find(e => e.what === 'owner-interrupt').at, hooks = result.events.find(e => e.what === 'destroy').at;
  assert(hooks - stop >= 9500 && hooks - stop < 16000, `the hooks ran after the 10 s grace: ${hooks - stop}`);
  // The restart: the attempt's intent has no commit marker - not committed, journaled, aborted; no entry recovered.
  let recovered = null;
  const again = await startup.run({ db: 'pg' }, { env: env(dir), timeoutMs: 120000, onEvent: (event, child) => {
    if (event.what === 'recovered') recovered = event;
    if (event.what === 'listening') startup.stop(child, 'SIGTERM');
  } });
  assert.deepEqual([again.code, recovered.recovered, recovered.notCommitted], [0, 0, 1]);
});
