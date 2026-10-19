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
const { randomUUID, createHash } = require('node:crypto');
const path = require('node:path');
const { test } = require('node:test');
const startup = require('./startup_fixture.cjs');
const { PrismaClient } = require('/app/node_modules/@prisma/client');

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
  // The recovery step returns first (`recovered`), then the start's own end begins the one release of the real client
  // (`disconnect` before `start-failed`); the launcher's owner-close joins that same release - never a second one, never
  // under the step in flight (the order Linux CI recorded on f3702c0 and C30 records with the inert doubles).
  inOrder(result.names, ['fence', 'recovery', 'held', 'owner-interrupt', 'released', 'recovered', 'disconnect', 'start-failed', 'owner-close', 'exit']);
  for (const name of ['compose', 'ready', 'create', 'init', 'bind']) assert(!result.names.includes(name), name);
  assert.equal(count(result.names, 'disconnect'), 1);
});

const state05 = startup.stateDirectory('pg-work');

test('P05 real recording work through the port: a standalone fact, a business transaction with its fact, a settled failure, then a stop while a confirm is in flight keeps the fence, drains the work, mints a genuine receipt and leaves nothing to recover', async () => {
  const dir = state05;
  const standalone = randomUUID(), business = randomUUID(), failing = randomUUID(), held = randomUUID();
  const seen = {};
  const result = await startup.run({ db: 'pg', holdConfirm: held }, { env: env(dir), timeoutMs: 180000, onEvent: async (event, child) => {
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
  // The work the stop found in flight ends after the stop, before the hooks and the release; its receipt is genuine.
  const at = what => result.names.indexOf(what);
  const lateDone = result.events.findIndex(e => e.what === 'append-done' && e.eventId === held);
  assert(lateDone >= 0 && result.events[lateDone].same === true, 'the receipt of the work the stop found in flight is genuine');
  const lastEnded = result.names.lastIndexOf('work-ended');
  assert(at('confirm-held') < at('owner-interrupt') && at('owner-interrupt') < at('confirm-released') && at('confirm-released') < lateDone
    && lateDone < lastEnded && lastEnded < at('destroy') && at('destroy') < at('prisma-shutdown') && at('prisma-shutdown') < at('owner-close')
    && at('owner-close') < at('disconnect') && at('disconnect') < at('exit'), JSON.stringify(result.names));
  assert.deepEqual([count(result.names, 'work-ended'), count(result.names, 'disconnect')], [4, 1]);
  // The restart: every fact was committed and sealed; nothing to recover, nothing not committed.
  let recovered = null;
  const again = await startup.run({ db: 'pg' }, { env: env(dir), timeoutMs: 120000, onEvent: (event, child) => {
    if (event.what === 'recovered') recovered = event;
    if (event.what === 'listening') startup.stop(child, 'SIGTERM');
  } });
  assert.deepEqual([again.code, recovered.recovered, recovered.notCommitted], [0, 0, 0]);
});

test('P06 a transaction that outlives the drain grace: the one closed line names the drain, the process ends 1, and the restart settles the attempt as not committed - distinct from a committed entry; a fresh state directory beside the non-empty ledger is refused before anything (SealMissing)', async () => {
  // The ledger now holds P05's facts. A new state directory has no seal tail that covers them: B1 refuses such a start at
  // its recovery (seal.ts recoverAtStart: absent seal, non-zero chain) before any application exists - this is what Linux
  // CI recorded on f3702c0 when this case used a fresh directory, and it is B1's rule, not a defect of the stop.
  const fresh = startup.stateDirectory('pg-grace');
  const refused = await startup.run({ db: 'pg' }, { env: env(fresh), timeoutMs: 120000 });
  assert.deepEqual(closed(refused), ['recovery', 'SealMissing']);
  assert(!refused.names.includes('ready') && !refused.names.includes('create'), 'no application beside an unexplained ledger');
  assert.equal(count(refused.names, 'disconnect'), 1);
  // The directory whose seal covers the ledger (P05's) carries the held transaction across the stop.
  const dir = state05;
  const stuck = randomUUID();
  const result = await startup.run({ db: 'pg', holdTransaction: true }, { env: env(dir), timeoutMs: 180000, onEvent: (event, child) => {
    if (event.what === 'listening') child.send({ cmd: 'record-transaction', eventId: stuck });
    if (event.what === 'transaction-held') startup.stop(child, 'SIGTERM');
  } });
  assert.deepEqual([result.code, result.signal, result.timedOut], [1, null, false], result.stderr);
  // The product prints one stop line (the first exceeded bound); the drain is it.
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

// REQ-B2R-05/07 -> RISK-B2R-DUAL-WRITER/LEDGER-REGRESSION -> TEST-B2D-06-P07..P12.
// The observer never supplies SQL outcomes to the API. P10 kills only the PID reported by the request's own transaction.
async function persisted(db, eventId) {
  return {
    business: await db.institution.findMany({ where: { id: 'r2-' + eventId }, select: { id: true, name: true } }),
    entries: await db.$queryRaw`SELECT stream, event_id, sequence::text, hash, payload::text FROM emr_access.access_entry WHERE event_id=${eventId} ORDER BY stream`,
    businessTransactions: await db.$queryRaw`SELECT xmin::text AS transaction_id FROM "Institution" WHERE id=${'r2-' + eventId}`,
    markers: await db.$queryRaw`SELECT stream, event_id, attempt_id, bundle_id, transaction_id::text, sequence::text, hash FROM emr_access.commit_marker WHERE event_id=${eventId} ORDER BY stream`,
  };
}
function observeRequest(port) {
  const result = { bytes: '', status: null, error: null };
  result.done = new Promise(resolve => {
    const request = http.get({ host: '127.0.0.1', port, path: '/syn-atomic', agent: false }, response => {
      result.status = response.statusCode;
      response.on('data', chunk => { result.bytes += chunk.toString(); });
      response.on('end', resolve); response.on('error', error => { result.error = error.code; resolve(); });
    });
    request.on('error', error => { result.error = error.code; resolve(); });
  });
  return result;
}

for (const [cell, cutpoint, committed, recovered] of [
  ['P07', 'reserve-complete', false, { viewing: 0, history: 0 }],
  ['P08', 'commit-complete', true, { viewing: 1, history: 1 }],
  ['P09', 'crash-settled', true, { viewing: 1, history: 1 }],
  ['P10', 'crash-settled', false, { viewing: 0, history: 0 }],
  ['P11', 'viewing-sealed', true, { viewing: 0, history: 1 }],
  ['P12', 'receipt-complete', true, { viewing: 0, history: 0 }],
]) test(cell + ' whole launcher crash preserves atomic business and both ledger streams and resolves the observed outcome under exclusive recovery', { timeout: 240000 }, async () => {
  const event = startup.changeEvent(randomUUID()), observer = new PrismaClient({ datasources: { db: { url: INSTALLER } } });
  const seen = {};
  try {
    const result = await startup.run({ db: 'pg', crashCut: cell, crashEvent: event }, {
      env: env(state05), timeoutMs: 60000, onEvent: async (notice, child) => {
        if (notice.what === 'listening') seen.http = observeRequest(notice.port);
        if (notice.what === 'crash-cut' && notice.point === 'commit-entry') {
          assert.equal(cell, 'P10'); assert(Number.isInteger(notice.backendPid) && notice.backendPid > 0);
          const [terminated] = await observer.$queryRaw`SELECT pg_terminate_backend(${notice.backendPid}::integer) AS terminated`;
          assert.equal(terminated.terminated, true); seen.terminatedPid = notice.backendPid;
          child.send({ cmd: 'release' });
        }
        if ((notice.what === 'crash-cut' && notice.point === cutpoint) || (notice.what === cutpoint)) {
          seen.cut = notice;
          seen.beforeKill = await persisted(observer, event.eventId);
          child.kill('SIGKILL');
        }
      },
    });
    assert.equal(result.timedOut, false, JSON.stringify({ cell, names: result.names, raw: result.dir }));
    assert.equal(result.signal, 'SIGKILL');
    assert(!result.names.includes('parent-error'), 'observed cutpoint must execute without harness error');
    assert(seen.cut, cell + ': required cut observed');
    await seen.http.done;
    assert.equal(seen.http.bytes, '', 'no success receipt/body escaped');
    assert.equal(seen.http.status, null);
    if (cell === 'P09' || cell === 'P10') {
      assert.equal(seen.cut.callbackFailed, false, 'COMMIT failure is not a callback rollback');
      assert(seen.cut.journal.some(row => row.body?.eventId === event.eventId && row.body.cause === 'commit-unknown'));
      assert.equal(Object.values(seen.cut.state.intents).filter(intent => intent.eventId === event.eventId).length, 2);
    }
    if (cell === 'P09') assert(result.names.includes('pg-commit-complete'), 'genuinely successful PG commit preceded lost acknowledgement');
    if (cell === 'P10') assert(seen.terminatedPid && !result.names.includes('pg-commit-complete'));
    const before = await persisted(observer, event.eventId);
    assert.equal(before.business.length, committed ? 1 : 0);
    assert.deepEqual(before.entries.map(row => row.stream).sort(), committed ? ['history', 'viewing'] : []);
    assert.deepEqual(before.markers.map(row => row.stream).sort(), committed ? ['history', 'viewing'] : []);
    for (const row of before.entries) assert.equal(JSON.parse(row.payload).eventId, event.eventId);
    if (committed) {
      assert.equal(new Set(before.markers.map(row => row.bundle_id)).size, 1);
      assert.equal(new Set(before.markers.map(row => row.attempt_id)).size, 1);
      assert.deepEqual([...new Set(before.markers.map(row => row.transaction_id))], before.businessTransactions.map(row => row.transaction_id), 'business and both ledger markers share the real PG transaction');
    }
    if (cell === 'P10') {
      const protectedHashes = () => fs.readdirSync(state05).sort().filter(name => fs.lstatSync(path.join(state05, name)).isFile()).map(name => [name, createHash('sha256').update(fs.readFileSync(path.join(state05, name))).digest('hex')]);
      const beforeUnavailable = protectedHashes();
      const unavailable = new URL(RUNTIME); unavailable.port = '1'; unavailable.searchParams.set('connect_timeout', '1');
      const refused = await startup.run({ db: 'pg' }, { env: env(state05, { DATABASE_URL: unavailable.toString() }), timeoutMs: 30000 });
      assert.equal(refused.code, 1); assert(!refused.names.includes('ready') && !refused.names.includes('listening'));
      assert(!refused.names.includes('recovered'), 'unreadable PG cannot prove negative settlement');
      assert.deepEqual(protectedHashes(), beforeUnavailable, 'unavailable verification preserves intents and journal');
      assert.deepEqual(await persisted(observer, event.eventId), before);
    }
    let recovery;
    const restarted = await startup.run({ db: 'pg' }, { env: env(state05), timeoutMs: 60000, onEvent(notice, child) {
      if (notice.what === 'recovered') recovery = notice;
      if (notice.what === 'listening') startup.stop(child);
    } });
    assert.equal(restarted.code, 0, restarted.stderr);
    // Each expected stream contributes independently; two-stream work is never counted as a one-entry event.
    assert.equal(recovery.recovered, Object.values(recovered).reduce((a, b) => a + b, 0));
    assert.equal(recovery.notCommitted, committed ? 0 : Object.keys(recovered).length);
    for (const stream of Object.keys(recovered)) assert.deepEqual(recovery.streams[stream], { recovered: recovered[stream], notCommitted: committed ? 0 : 1 });
    assert.deepEqual(await persisted(observer, event.eventId), before, 'recovery does not rewrite business/original rows');
    // Replay the exact event through the same real HTTP API, then restart once more and replay again.
    let replayState;
    for (let pass = 0; pass < 2; pass++) {
      let request, replayRecovery;
      const replay = await startup.run({ db: 'pg', crashEvent: event }, { env: env(state05), timeoutMs: 60000, onEvent: async (notice, child) => {
        if (notice.what === 'recovered') replayRecovery = notice;
        if (notice.what === 'listening') { request = observeRequest(notice.port); await request.done; startup.stop(child); }
      } });
      assert.equal(replay.code, 0, replay.stderr); assert.equal(request.status, 200); assert.equal(JSON.parse(request.bytes).eventId, event.eventId);
      assert.deepEqual([replayRecovery.recovered, replayRecovery.notCommitted], [0, 0]);
      const after = await persisted(observer, event.eventId);
      assert.equal(after.business.length, 1); assert.deepEqual(after.entries.map(row => row.stream).sort(), ['history', 'viewing']);
      if (replayState) assert.deepEqual(after, replayState, 'second restart/replay duplicates zero');
      replayState = after;
    }
    console.log('B2D_CRASH_EVIDENCE ' + JSON.stringify({ cell, event, signal: result.signal, raw: result.dir, cut: seen.cut,
      before, recovery, replay: replayState, http: { status: seen.http.status, bytes: seen.http.bytes, error: seen.http.error } }));
  } finally { await observer.$disconnect(); }
});
