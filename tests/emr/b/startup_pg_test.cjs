'use strict';
/* EMR-B2 (c) over a disposable PostgreSQL and the real state service (C-P01..C-P11; the preserved P00..P12 mapping of
 * the r2 suite). Runs inside the compiled API image (/app/dist) as the API user (UID 1001, group 2001) with the
 * provisioned and migrated database at KIN_EMR_B2_RUNTIME_URL (the runtime role) and KIN_EMR_B2_INSTALLER_URL (the
 * installer: the observer's own connection and the refusal case), the read-only API IPC volume at the parent of
 * KIN_EMR_STATE_SOCKET, and the orchestrator's control directory KIN_EMR_B2_CONTROL (bind-mounted, shared with the host
 * test that owns the service container). Every API start is the real main.ts in its own process (startup_fixture.cjs,
 * db: 'pg': no client, SQL, Prisma or state-client substitution; only observed). The service is the real
 * `state-serve-v3` entry in its own container (startup_fixture.cjs --service, UID 1000, the state and IPC volumes), which
 * the orchestrator starts, stops, terminates and restarts on this suite's requests; the suite never has the state
 * volume, the reader credential or a writable socket parent.
 *
 * Control protocol: a request file `req-<n>.json` {action, ...} answered by `res-<n>.json`; actions `service-start`
 * {label, scenario} (ready | exited), `service-stop` {signal: TERM|KILL} (exit code, last lines), `service-wait`,
 * `volume-hashes` (sha256 of every file of the state volume, read by the orchestrator from a stopped service).
 * Service events are the lines of `service-events.jsonl`, written by the service fixture.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const startup = require('./startup_fixture.cjs');
const { PrismaClient } = require('/app/node_modules/@prisma/client');

const RUNTIME = process.env.KIN_EMR_B2_RUNTIME_URL, INSTALLER = process.env.KIN_EMR_B2_INSTALLER_URL;
const CONTROL = process.env.KIN_EMR_B2_CONTROL, SOCKET = process.env.KIN_EMR_STATE_SOCKET, INSTANCE = process.env.KIN_EMR_INSTANCE_ID;
const env = (overrides = {}) => startup.environment(startup.stateDirectory('unused'), {
  DATABASE_URL: RUNTIME, KIN_EMR_STATE_SOCKET: SOCKET, KIN_EMR_INSTANCE_ID: INSTANCE, ...overrides });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
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
const LINE = /^\[KIN API\] 기동 실패\(([a-z]+)(?:\/([A-Za-z0-9_]+))?\): [^\n]+\. 기동을 중단합니다\.$/;
const STOP_LINE = /^\[KIN API\] 종료 실패\(([a-z]+)\): [^\n]+\. 프로세스를 끝냅니다\.$/;
const closed = result => { assert.deepEqual([result.code, result.stderrLines.length], [1, 1], result.stderr); return LINE.exec(result.stderrLines[0]).slice(1, 3); };
const evidence = (cell, body) => console.log('B2C_PG_EVIDENCE ' + JSON.stringify({ cell, ...body }));

// ── the orchestrator (host) ──
let sequence = 0;
async function control(request, timeoutMs = 180000) {
  const id = String(++sequence).padStart(4, '0');
  const file = path.join(CONTROL, 'req-' + id + '.json'), reply = path.join(CONTROL, 'res-' + id + '.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify({ id, ...request })); fs.renameSync(file + '.tmp', file);
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(reply)) { if (Date.now() > deadline) throw new Error('orchestrator did not answer ' + JSON.stringify(request)); await sleep(100); }
  await sleep(50);
  return JSON.parse(fs.readFileSync(reply, 'utf8'));
}
const serviceEvents = label => {
  const file = path.join(CONTROL, 'service-events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(event => !label || event.label === label);
};
const waitServiceEvent = async (label, what, timeoutMs = 60000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = serviceEvents(label).find(event => event.what === what);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`service event ${what} (${label}) not observed: ` + JSON.stringify(serviceEvents(label).map(e => e.what)));
    await sleep(100);
  }
};
const release = (label, point) => fs.writeFileSync(path.join(CONTROL, 'release-' + label + '-' + point), '');
let serviceLabel = null, serviceGeneration = 0;
async function startService(scenario = {}) {
  const label = 'svc-' + String(++serviceGeneration).padStart(3, '0');
  const reply = await control({ action: 'service-start', label, scenario: { ...scenario, label } });
  serviceLabel = label;
  return { label, ...reply };
}
const stopService = (signal = 'TERM') => control({ action: 'service-stop', signal });
const volumeHashes = () => control({ action: 'volume-hashes' });

// ── the observer: its own installer connection; it never supplies SQL outcomes to the API ──
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
/** One API start that stops itself once listening (after `during(child, event)`); returns the run and the session. */
async function apiOnce(scenario = {}, during = null, timeoutMs = 120000) {
  let session = null;
  const result = await startup.run({ db: 'pg', ...scenario }, { env: env(), timeoutMs, onEvent: async (event, child, events) => {
    if (event.what === 'session') session = event;
    if (during) await during(event, child, events);
  } });
  return { result, session };
}

test('P00 the disposable database, the service control and the socket are given (no silent pass without them)', () => {
  assert.match(RUNTIME ?? '', /^postgresql:\/\/kin_runtime[:@]/);
  assert.match(INSTALLER ?? '', /^postgresql:\/\/postgres[:@]/);
  assert.ok(CONTROL && fs.statSync(CONTROL).isDirectory(), 'control directory');
  assert.equal(path.dirname(SOCKET), '/run/kin-emr-api');
  assert.equal(startup.SIGNAL_MODE, 'kill', 'the OS signal is what this suite proves');
  assert.equal(process.getuid(), 1001);
  assert.throws(() => fs.readdirSync('/var/lib/kin-emr'), e => e.code === 'EACCES' || e.code === 'ENOENT', 'no state volume here');
});

test('C-P01 the API start requires a ready service; an API-only restart keeps the service epoch and recovery count; without the service no API work', { timeout: 300000 }, async () => {
  // Absent service: closed at the session phase, no application.
  const absent = await startup.run({ db: 'pg' }, { env: env(), timeoutMs: 90000 });
  assert.deepEqual(closed(absent), ['session', 'UNAVAILABLE']);
  assert(!absent.names.includes('create') && !absent.names.includes('bind'), 'no application without the service');
  // The service, fresh pair: one recovery of nothing.
  const service = await startService();
  assert.equal(service.ready, true, JSON.stringify(service));
  const recovered = await waitServiceEvent(service.label, 'recovered');
  assert.deepEqual([recovered.recovered, recovered.notCommitted], [0, 0]);
  // First API: listens, serves, records one standalone fact, stops.
  const first = await apiOnce({}, async (event, child) => {
    if (event.what === 'listening') { child.send({ cmd: 'record-work', eventId: randomUUID() }); }
    if (event.what === 'append-done') child.send('status');
    if (event.what === 'status') startup.stop(child, 'SIGTERM');
  });
  assert.deepEqual([first.result.code, first.result.stderrLines], [0, []], first.result.stderr);
  inOrder(first.result.names, ['start', 'client', 'connect', 'connected', 'role', 'state-client', 'session', 'compose', 'ready', 'create', 'created', 'init', 'initialized', 'bind', 'listening', 'work-begun', 'append-done', 'work-ended', 'status', 'owner-interrupt', 'server-close', 'owner-close', 'disconnect', 'exit']);
  const firstStatus = first.result.events.find(e => e.what === 'status').status;
  assert.equal(firstStatus.state, 'ready');
  // Second API over the same service: the same epoch, no new recovery.
  const second = await apiOnce({}, (event, child) => { if (event.what === 'listening') child.send('status'); if (event.what === 'status') startup.stop(child, 'SIGTERM'); });
  assert.equal(second.result.code, 0, second.result.stderr);
  assert.equal(second.session.serviceEpoch, first.session.serviceEpoch, 'API-only restart keeps the service epoch');
  assert.equal(count(serviceEvents(service.label).map(e => e.what), 'recovery'), 1, 'no recovery for an API restart');
  // The service stops while an API serves: the API ends nonzero by its own loss detection; a fresh API refuses.
  const lost = await apiOnce({}, async (event, child) => {
    if (event.what === 'listening') { const stopped = await stopService('TERM'); child.send({ cmd: 'begin' }); evidence('C-P01-stop', stopped); }
  }, 90000);
  assert.equal(lost.result.code, 1, lost.result.stderr);
  assert(!lost.result.names.includes('append-done'), 'no work after the loss');
  const again = await startup.run({ db: 'pg' }, { env: env(), timeoutMs: 90000 });
  assert.deepEqual(closed(again), ['session', 'UNAVAILABLE']);
  // The recovered service: a new epoch; an old-epoch client cannot be reused (its process is gone); the fresh API starts.
  const next = await startService();
  assert.equal(next.ready, true);
  const fresh = await apiOnce({}, (event, child) => { if (event.what === 'listening') startup.stop(child, 'SIGTERM'); });
  assert.equal(fresh.result.code, 0, fresh.result.stderr);
  assert.notEqual(fresh.session.serviceEpoch, first.session.serviceEpoch, 'a restarted service is a new epoch');
  evidence('C-P01', { firstEpoch: first.session.serviceEpoch, nextEpoch: fresh.session.serviceEpoch, firstStatus, serviceEvents: serviceEvents().map(e => [e.label, e.what]) });
});

test('C-P02 a second service on the same pair is refused while the first serves; a held shared transaction at reserve makes a restarting service wait, old epoch work fails, nothing is committed', { timeout: 300000 }, async () => {
  const second = await control({ action: 'service-start', label: 'svc-second', scenario: { label: 'svc-second' }, extra: true });
  assert.equal(second.ready, false, JSON.stringify(second));
  assert.notEqual(second.exit, 0, 'the second owner exits nonzero');
  assert.ok(/EMR_STATE_FAILED|EMR_STATE_INCOMPLETE/.test(second.tail), second.tail);
  assert.equal((await control({ action: 'service-wait', label: serviceLabel })).running, true, 'the first still serves');
  const held = randomUUID();
  const observer = new PrismaClient({ datasources: { db: { url: INSTALLER } } });
  try {
    let restart = null;
    const run = await apiOnce({ holdTransaction: true }, async (event, child) => {
      if (event.what === 'listening') child.send({ cmd: 'record-transaction', eventId: held, change: true });
      if (event.what === 'transaction-held') {
        // The reservation is bound; the transaction (its shared writer fence) stays open. Restart the service now.
        restart = control({ action: 'service-restart', label: 'svc-' + String(++serviceGeneration).padStart(3, '0'), scenario: {} });
        await sleep(3000);
        child.send({ cmd: 'release' });
      }
    }, 180000);
    const restarted = await restart; serviceLabel = restarted.label;
    assert.equal(restarted.ready, true, JSON.stringify(restarted));
    const recovered = await waitServiceEvent(restarted.label, 'recovered');
    assert(!run.result.names.includes('transaction-done'), 'the old-epoch confirm never minted a receipt');
    assert.equal(run.result.code, 1, run.result.stderr);
    const rows = await persisted(observer, held);
    // The held transaction either completed at the database (then the new epoch's recovery seals its bound markers)
    // or rolled back (then the recovery settles the open reservations as not committed); never a live
    // absent => not-committed shortcut, never a receipt from the old epoch, never a cyclic wait.
    const streams = rows.entries.length;
    if (streams === 0) {
      assert.deepEqual([rows.business.length, rows.markers.length], [0, 0], 'rolled back: no business row, entry or marker');
      assert.deepEqual([recovered.recovered, recovered.notCommitted], [0, 2], 'the recovery settled both open reservations as not committed');
    } else {
      assert.deepEqual([rows.business.length, streams, rows.markers.length], [1, 2, 2], 'completed: business row, both entries and both markers');
      assert.deepEqual([recovered.recovered, recovered.notCommitted], [2, 0], 'the recovery sealed both bound reservations');
    }
    evidence('C-P02', { second, recovered, outcome: streams === 0 ? 'rolled-back' : 'completed', apiNames: run.result.names, apiCode: run.result.code });
  } finally { await observer.$disconnect(); }
});

test('C-P03 a service that dies during recovery publishes no readiness; the restart over the same pair recovers; a wrong-pair start refuses before mutation', { timeout: 300000 }, async () => {
  await stopService('TERM');
  const before = await volumeHashes();
  const label = 'svc-' + String(++serviceGeneration).padStart(3, '0');
  const starting = control({ action: 'service-start', label, scenario: { label, hold: ['recovery'] }, waitFor: 'held' });
  await waitServiceEvent(label, 'held', 90000);
  const duringRecovery = await startup.run({ db: 'pg' }, { env: env(), timeoutMs: 60000 });
  assert.equal(duringRecovery.code, 1, 'no API readiness while the recovery is incomplete');
  assert(!duringRecovery.names.includes('create'));
  const killed = await control({ action: 'service-stop', signal: 'KILL' });
  await starting;
  const after = await volumeHashes();
  assert.deepEqual(after.hashes, before.hashes, 'an interrupted recovery of nothing changed no byte');
  const wrong = await control({ action: 'service-start', label: 'svc-wrong', scenario: { label: 'svc-wrong' }, instanceId: 'another-synthetic-pair' });
  assert.equal(wrong.ready, false, JSON.stringify(wrong));
  assert.deepEqual((await volumeHashes()).hashes, before.hashes, 'the wrong pair changed no byte');
  const next = await startService(); serviceLabel = next.label;
  assert.equal(next.ready, true);
  evidence('C-P03', { killed, wrong, bytesUnchanged: true });
});

test('C-P04 one public projected transaction updates a synthetic business row and appends both streams; callback rejection is all-or-none', { timeout: 300000 }, async () => {
  const good = randomUUID(), bad = randomUUID();
  const observer = new PrismaClient({ datasources: { db: { url: INSTALLER } } });
  try {
    const run = await apiOnce({}, (event, child) => {
      if (event.what === 'listening') child.send({ cmd: 'record-transaction', eventId: good, change: true });
      if (event.what === 'transaction-done') child.send({ cmd: 'record-transaction', eventId: bad, change: true, fail: true });
      if (event.what === 'transaction-settled') startup.stop(child, 'SIGTERM');
    }, 180000);
    assert.equal(run.result.code, 0, run.result.stderr);
    const done = run.result.events.find(e => e.what === 'transaction-done'), settled = run.result.events.find(e => e.what === 'transaction-settled');
    assert.deepEqual([done.same, done.entries, settled.callbackFailed], [true, 2, true]);
    const committed = await persisted(observer, good), rejected = await persisted(observer, bad);
    assert.deepEqual(committed.entries.map(r => r.stream), ['history', 'viewing']);
    assert.deepEqual(committed.markers.map(r => r.stream), ['history', 'viewing']);
    assert.deepEqual([...new Set(committed.markers.map(r => r.transaction_id))], committed.businessTransactions.map(r => r.transaction_id), 'business and both markers share the real PG transaction');
    assert.deepEqual([rejected.entries.length, rejected.markers.length], [0, 0], 'the rejected callback left no entry or marker');
    evidence('C-P04', { committed, rejected });
  } finally { await observer.$disconnect(); }
});

for (const [cell, cutpoint, committed, recovered] of [
  ['C-P05a/P07', 'reserve-complete', false, { viewing: 0, history: 0 }],
  ['C-P05b/P08', 'commit-complete', true, { viewing: 1, history: 1 }],
  ['C-P06a/P09', 'crash-settled', true, { viewing: 1, history: 1 }],
  ['C-P06b/P10', 'crash-settled', false, { viewing: 0, history: 0 }],
  ['C-P08/P12', 'receipt-complete', true, { viewing: 0, history: 0 }],
]) test(cell + ' whole API process ends at the observed cutpoint; business and both ledger streams are all-or-none; the service recovery resolves the observed outcome', { timeout: 420000 }, async () => {
  const crash = cell.split('/')[1];
  const event = startup.changeEvent(randomUUID()), observer = new PrismaClient({ datasources: { db: { url: INSTALLER } } });
  const seen = {};
  try {
    const result = await startup.run({ db: 'pg', crashCut: crash, crashEvent: event }, {
      env: env(), timeoutMs: 90000, onEvent: async (notice, child) => {
        if (notice.what === 'listening') seen.http = observeRequest(notice.port);
        if (notice.what === 'crash-cut' && notice.point === 'commit-entry') {
          assert.equal(crash, 'P10'); assert(Number.isInteger(notice.backendPid) && notice.backendPid > 0);
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
    if (crash === 'P09' || crash === 'P10') assert.equal(seen.cut.callbackFailed, false, 'COMMIT failure is not a callback rollback');
    if (crash === 'P09') assert(result.names.includes('pg-commit-complete'), 'genuinely successful PG commit preceded lost acknowledgement');
    if (crash === 'P10') assert(seen.terminatedPid && !result.names.includes('pg-commit-complete'));
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
    // The service restarts over the same pair: its recovery, not the API, resolves the reservation.
    await stopService('TERM');
    if (crash === 'P10') {
      // First an unreadable database: the recovery refuses and preserves every byte (no negative settlement offline).
      const hashesBefore = await volumeHashes();
      const refused = await control({ action: 'service-start', label: 'svc-unreadable-' + serviceGeneration, scenario: { label: 'svc-unreadable-' + serviceGeneration }, databasePort: 1 });
      assert.equal(refused.ready, false, JSON.stringify(refused));
      assert.deepEqual((await volumeHashes()).hashes, hashesBefore.hashes, 'unreadable verification preserves intents and journal');
      assert.deepEqual(await persisted(observer, event.eventId), before);
    }
    const service = await startService(); serviceLabel = service.label;
    assert.equal(service.ready, true, JSON.stringify(service));
    const recovery = await waitServiceEvent(service.label, 'recovered');
    assert.equal(recovery.recovered, Object.values(recovered).reduce((a, b) => a + b, 0));
    assert.equal(recovery.notCommitted, committed ? 0 : Object.keys(recovered).length);
    for (const stream of Object.keys(recovered)) assert.deepEqual(recovery.streams[stream], { recovered: recovered[stream], notCommitted: committed ? 0 : 1 });
    assert.deepEqual(await persisted(observer, event.eventId), before, 'recovery does not rewrite business/original rows');
    // Replay the exact event through the same real HTTP API, then once more after another API restart.
    let replayState;
    for (let pass = 0; pass < 2; pass++) {
      let request;
      const replay = await startup.run({ db: 'pg', crashEvent: event }, { env: env(), timeoutMs: 90000, onEvent: async (notice, child) => {
        if (notice.what === 'listening') { request = observeRequest(notice.port); await request.done; startup.stop(child); }
      } });
      assert.equal(replay.code, 0, replay.stderr); assert.equal(request.status, 200, request.bytes); assert.equal(JSON.parse(request.bytes).eventId, event.eventId);
      const after = await persisted(observer, event.eventId);
      assert.equal(after.business.length, 1); assert.deepEqual(after.entries.map(row => row.stream).sort(), ['history', 'viewing']);
      if (replayState) assert.deepEqual(after, replayState, 'second restart/replay duplicates zero');
      replayState = after;
    }
    assert.equal(count(serviceEvents(service.label).map(e => e.what), 'recovery'), 1, 'API replays cause no service recovery');
    evidence(cell, { event: event.eventId, signal: result.signal, cut: seen.cut, before, recovery, replay: replayState, http: { status: seen.http.status, bytes: seen.http.bytes, error: seen.http.error } });
  } finally { await observer.$disconnect(); }
});

test('C-P07/P11 the service ends after the viewing seal and before the history seal: no receipt or first body; the restart preserves the rows and recovers the remaining seal', { timeout: 420000 }, async () => {
  const event = startup.changeEvent(randomUUID()), observer = new PrismaClient({ datasources: { db: { url: INSTALLER } } });
  try {
    await stopService('TERM');
    const service = await startService({ cut: 'viewing-sealed', cutEvent: event.eventId }); serviceLabel = service.label;
    assert.equal(service.ready, true, JSON.stringify(service));
    const seen = {};
    const result = await startup.run({ db: 'pg', crashEvent: event }, { env: env(), timeoutMs: 120000, onEvent: async (notice, child) => {
      if (notice.what === 'listening') seen.http = observeRequest(notice.port);
      if (notice.what === 'pg-commit-complete' || (notice.what === 'append-reserved')) {
        if (!seen.watching) {
          seen.watching = true;
          await waitServiceEvent(service.label, 'viewing-sealed', 90000);
          seen.before = await persisted(observer, event.eventId);
          seen.stopped = await control({ action: 'service-stop', signal: 'KILL' });
          await sleep(500);
          child.kill('SIGKILL');
        }
      }
    } });
    assert.equal(result.signal, 'SIGKILL', JSON.stringify(result.names));
    await seen.http.done;
    assert.equal(seen.http.bytes, '', 'no aggregate receipt or first body before both seals');
    const before = await persisted(observer, event.eventId);
    assert.deepEqual(before.entries.map(r => r.stream).sort(), ['history', 'viewing'], 'the transaction committed both streams');
    const next = await startService(); serviceLabel = next.label;
    assert.equal(next.ready, true, JSON.stringify(next));
    const recovery = await waitServiceEvent(next.label, 'recovered');
    assert.deepEqual([recovery.streams.viewing.recovered, recovery.streams.history.recovered, recovery.notCommitted], [0, 1, 0], 'only the history seal remained to recover');
    assert.deepEqual(await persisted(observer, event.eventId), before, 'original rows preserved');
    let request;
    const replay = await startup.run({ db: 'pg', crashEvent: event }, { env: env(), timeoutMs: 90000, onEvent: async (notice, child) => {
      if (notice.what === 'listening') { request = observeRequest(notice.port); await request.done; startup.stop(child); }
    } });
    assert.equal(replay.code, 0, replay.stderr); assert.equal(request.status, 200, request.bytes);
    assert.deepEqual(await persisted(observer, event.eventId), before, 'the replay after the partial seal duplicates nothing');
    evidence('C-P07', { event: event.eventId, stopped: seen.stopped, before, recovery, serviceEvents: serviceEvents(service.label).map(e => e.what) });
  } finally { await observer.$disconnect(); }
});

test('C-P09 receipt and real HTTP delivery: the body follows the genuine complete receipt; a connection lost before the body changes no outcome; a stop while a confirm is in flight keeps the work until its receipt', { timeout: 300000 }, async () => {
  const held = randomUUID(), standalone = randomUUID();
  const seen = {};
  const result = await startup.run({ db: 'pg', holdConfirm: held, crashEvent: startup.changeEvent(standalone) }, { env: env(), timeoutMs: 180000, onEvent: async (event, child) => {
    if (event.what === 'listening') {
      seen.port = event.port;
      // A pre-body connection loss: the client goes away before any byte; the record still completes.
      const lost = http.get({ host: '127.0.0.1', port: event.port, path: '/syn-atomic', agent: false });
      lost.on('error', () => {}); lost.on('socket', socket => socket.once('connect', () => setTimeout(() => lost.destroy(), 20)));
      await sleep(1500);
      child.send({ cmd: 'record-work', eventId: held });
    }
    if (event.what === 'confirm-held') { seen.held = event; startup.stop(child, 'SIGTERM'); }
    if (event.what === 'owner-interrupt') { child.send('begin'); child.send({ cmd: 'release' }); }
  } });
  assert.deepEqual([result.code, result.stderrLines], [0, []], result.stderr);
  const begin = result.events.find(e => e.what === 'begin');
  assert.deepEqual([begin.ok, begin.code], [false, 'EmrRecordPortClosed']);
  const lateDone = result.events.findIndex(e => e.what === 'append-done' && e.eventId === held);
  assert(lateDone >= 0 && result.events[lateDone].same === true, 'the receipt of the work the stop found in flight is genuine');
  const at = what => result.names.indexOf(what);
  assert(at('confirm-held') < at('owner-interrupt') && at('owner-interrupt') < at('confirm-released') && at('confirm-released') < lateDone && lateDone < at('owner-close'), JSON.stringify(result.names));
  assert(result.names.includes('receipt-ready') || result.names.includes('crash-settled'), 'the request whose client left still settled: ' + JSON.stringify(result.names));
  evidence('C-P09', { names: result.names, held: seen.held });
});

test('C-P10 durability faults in the service: a WAL flush failure, a torn WAL write and a checkpoint rename failure give no durable acknowledgement; the restart preserves or recovers consistently', { timeout: 600000 }, async () => {
  const observer = new PrismaClient({ datasources: { db: { url: INSTALLER } } });
  const outcomes = [];
  try {
    for (const cut of ['wal-flush', 'wal-torn-write', 'checkpoint-rename']) {
      const eventId = randomUUID();
      await stopService('TERM');
      const service = await startService({ storage: { cut, eventId } }); serviceLabel = service.label;
      assert.equal(service.ready, true, JSON.stringify(service));
      const run = await apiOnce({}, async (event, child) => {
        if (event.what === 'listening') child.send({ cmd: 'record-transaction', eventId, change: true });
        if (event.what === 'transaction-done' || event.what === 'transaction-settled') { await sleep(500); startup.stop(child, 'SIGTERM'); }
      }, 180000);
      const fault = serviceEvents(service.label).find(e => e.what === 'storage-fault');
      const done = run.result.events.find(e => e.what === 'transaction-done'), settled = run.result.events.find(e => e.what === 'transaction-settled');
      const rows = await persisted(observer, eventId);
      const stopped = await stopService('TERM');
      const hashes = await volumeHashes();
      const next = await startService(); serviceLabel = next.label;
      assert.equal(next.ready, true, JSON.stringify(next));
      const recovery = await waitServiceEvent(next.label, 'recovered');
      const after = await persisted(observer, eventId);
      assert.deepEqual(after, rows, 'the restart rewrote no row');
      assert.ok(fault, cut + ': the fault was reached');
      // A receipt was minted only if the service's barriers all completed; otherwise the caller saw a failure.
      if (done) assert.equal(done.same, true);
      else assert.ok(settled, cut + ': the caller observed the failure');
      outcomes.push({ cut, fault, done: done ?? null, settled: settled ?? null, rows, stopped, recovery, hashes: Object.keys(hashes.hashes).length });
    }
    evidence('C-P10', { outcomes });
  } finally { await observer.$disconnect(); }
});

test('C-P11 the retained B1 regression suites run against the service path (recorded by the orchestrator; this cell only declares the mapping)', () => {
  evidence('C-P11', { declared: ['performance.py', 'performance_mutants.py', 'transaction_options_test.cjs', 'client_pool_test.cjs'], note: 'executed by the image jobs; see report acceptance' });
});
