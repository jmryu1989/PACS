/* REQ-B2C-01/02/03/06/07/08/09 -> the frozen RISK-B2C rows -> C-S02/S03/S04/S05 component subsets.
 * Actual dispatcher, AccessSeal, journal/WAL and sockets; a committed-fact SQL model supplies the DB boundary.
 * This does not certify Linux flock/UIDs, PG transactions, process signals, the executable root or deployment.
 * Assertions observe authority, durable bytes, returned proofs and operation settlement, never private source form.
 */
const assert = require('node:assert/strict');
const { test: nodeTest, beforeEach, after } = require('node:test');
const fs = require('node:fs'), path = require('node:path'), net = require('node:net'), os = require('node:os');
const { randomUUID, createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
// EMR_STATE_FORMAT=4 runs the same service cases over the v4 owner view (KIN-EMR-STATE-V4); v3 is the default.
const FORMAT = process.env.EMR_STATE_FORMAT === '4' ? 4 : 3;
const sourceRoot = process.env.EMR_B2C_SOURCE_ROOT || root;
const ts = require(path.join(root, 'api/node_modules/typescript'));
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021,
    experimentalDecorators: true, esModuleInterop: true },
}).outputText, file);
const load = name => require(path.join(sourceRoot, 'api/src', name + '.ts'));
const { ProtectedStateService } = load('emr-runtime/state-service');
const { StateCoordinator } = load('emr-runtime/coordinator');
const { FailureJournal } = load('emr-runtime/failure-journal');
const { AccessSeal } = load('emr-runtime/seal');
const { executeExternal } = load('emr-runtime/external-writer');
const C = load('emr-runtime/contract'), A = load('emr-contract/access-event');
const P = load('emr-runtime/state-protocol'), L = load('emr-runtime/limits');
const declaration = JSON.parse(fs.readFileSync(path.join(root, 'emr/units/b.json'))).b2c;
const selectedCases = process.env.EMR_SERVICE_CASES ? process.env.EMR_SERVICE_CASES.split(',') : declaration.local_service_cases;
// A cell may carry `{ skip: reason }` (a v3-layout cell under EMR_STATE_FORMAT=4): it is reported skipped, never run.
const skipped = new Set();
const test = (name, options, body) => {
  if (typeof options === 'function') { body = options; options = {}; }
  const id = name.split(' ')[0];
  if (!selectedCases.includes(id)) return;
  if (options.skip) { skipped.add(id); nodeTest(name, { skip: options.skip }, body); return; }
  nodeTest(name, body);
};
const executed = [];
const childInput = process.argv.indexOf('--terminal-child');
if (childInput === -1) {
  beforeEach(t => executed.push(t.name.split(' ')[0]));
  assert.equal(new Set(selectedCases).size, selectedCases.length);
  assert.equal(selectedCases.every(id => declaration.local_service_cases.includes(id)), true);
  after(() => assert.deepEqual(executed, declaration.local_service_cases.filter(id => selectedCases.includes(id) && !skipped.has(id))));
  console.log('SERVICE_SELECTION ' + JSON.stringify(selectedCases) + (process.env.EMR_STATE_FORMAT === '4' ? ' FORMAT 4' : ''));
}
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const known = value => ({ status: 'known', value });
function event(change = true) {
  return { formatVersion: 1, surface: change ? 'POST studies/:uid/report/commit' : 'GET studies/:uid/report/versions',
    eventId: randomUUID(), userId: known({ id: randomUUID(), issuer: 'https://identity.example.test', subject: 'synthetic' }),
    rolesAtTime: known(['radiologist']), actingInstitution: known('hospital-a'), managingInstitution: known('hospital-a'),
    occurredAt: '2026-10-09T00:00:00.000Z', trustedProxyIp: known({ address: '192.0.2.1', source: 'trusted-proxy' }), cause: 'user-view',
    context: { basis: 'assigned-reading', studyId: 'study-1', relatedStudyId: null, reason: null }, executor: 'member',
    targets: [{ kind: 'report-version', patientLinkSnapshot: known({ linkId: 'link-1', patientId: 'SYN-1', assigningAuthority: 'hospital-a' }),
      studyId: known('study-1'), recordId: known('report-1'), versionId: known('version-1') }],
    action: change ? 'approve-sign' : 'provide-prepared', result: change ? 'succeeded' : 'prepared', requestId: 'request-1',
    auditLinkId: A.newAuditLinkId(), relatedEventId: null };
}
function model(initial) {
  const streams = initial ?? Object.fromEntries(['viewing', 'history'].map(s => [s, { chainId: randomUUID(), rows: [], markers: [] }]));
  const sql = {
    snapshot: async work => work(sql), withWriterFence: async work => work(sql),
    tail: async stream => { const s = streams[stream], last = s.rows.at(-1); return { chainId: s.chainId, sequence: last?.sequence ?? 0, hash: last?.hash ?? '0'.repeat(64) }; },
    entriesAfter: async (s, n, limit) => structuredClone(streams[s].rows.filter(r => r.sequence > n).slice(0, limit)),
    markerForSlot: async (s, n) => structuredClone(streams[s].markers.find(m => m.sequence === n) ?? null),
    markerForAttempt: async (s, id) => structuredClone(streams[s].markers.find(m => m.attemptId === id) ?? null),
    entryForEvent: async (s, id) => structuredClone(streams[s].rows.find(r => r.eventId === id) ?? null),
  };
  sql.verificationPage = async (s, n, count) => ({ tail: await sql.tail(s), first: (await sql.entriesAfter(s, 0, 1))[0] ?? null,
    entries: await Promise.all((await sql.entriesAfter(s, n, count)).map(async entry => ({ entry, marker: await sql.markerForSlot(s, entry.sequence) }))) });
  return { streams, sql };
}
async function fixture(t, options = {}) {
  const stateRoot = path.join(root, 'tmp/emr-b2-c-3/component-state'); fs.mkdirSync(stateRoot, { recursive: true });
  const directory = options.directory ?? fs.mkdtempSync(path.join(stateRoot, 'state-'));
  fs.chmodSync(directory, 0o700);
  const database = options.model ?? model();
  const coordinator = new StateCoordinator(directory, executeExternal, { format: options.format ?? FORMAT });
  const journal = new FailureJournal(directory, coordinator), seal = new AccessSeal(directory, database.sql, journal);
  const pair = { instanceId: options.pair?.instanceId ?? 'synthetic-copy', chains: Object.fromEntries(Object.entries(database.streams).map(([s, v]) => [s, v.chainId])),
    database: options.pair?.database ?? { database: 'isolated', oid: 10001, address: '127.0.0.1', port: 5432 } };
  const service = new ProtectedStateService({ coordinator, journal, seal, sql: database.sql, pair, copy: options.copy ?? null });
  const peers = [];
  t.after(async () => { service.close(); for (const socket of peers) socket.destroy(); await service.drained(); coordinator.close(); });
  if (!options.cold) await service.start();
  const hello = async (role = 'api', clientInstanceId = randomUUID()) => {
    const socket = new net.Socket(); peers.push(socket);
    const request = { v: 1, requestId: randomUUID(), serviceEpoch: null, session: null, workId: null,
      operation: 'hello', value: { protocol: 1, clientInstanceId } };
    const reply = await service.dispatch(role, request, socket);
    if (!reply.ok) return { reply, socket, request };
    const identity = { clientInstanceId, chains: pair.chains };
    const session = reply.result.session;
    const req = (operation, value = {}, workId = null) => ({ v: 1, requestId: randomUUID(), serviceEpoch: service.serviceEpoch,
      session, workId, operation, value: { ...identity, ...value } });
    const call = (operation, value, workId) => service.dispatch(role, req(operation, value, workId), socket);
    const work = async () => {
      const workId = randomUUID(), began = await call('begin', {}, workId); assert.equal(began.ok, true);
      const scope = began.result.scope;
      return { workId, scope, req: (op, value) => req(op, { scope, ...value }, workId),
        call: (op, value) => call(op, { scope, ...value }, workId) };
    };
    return { reply, socket, request, identity, call, req, work };
  };
  const reserve = async (work, input = event()) => {
    const attemptId = randomUUID(), bundleId = randomUUID(), bindings = [], rows = [];
    for (const stream of A.accessStreams(input)) {
      const canonical = C.canonicalPayload(input, undefined, stream), tail = await database.sql.tail(stream);
      const binding = { stream, chainId: tail.chainId, attemptId, bundleId, kind: stream === 'viewing' ? 'access' : 'history',
        eventId: input.eventId, sequence: tail.sequence + 1, previousHash: tail.hash,
        hash: C.entryHash(tail.sequence + 1, tail.hash, canonical.text), contentSha256: canonical.contentSha256 };
      const reply = await work.call('reserve', { binding, prefix: null }); assert.equal(reply.ok, true, 'fresh valid reserve must succeed');
      bindings.push(reply.result); rows.push({ sequence: binding.sequence, previousHash: binding.previousHash,
        hash: binding.hash, kind: binding.kind, statutoryAct: A.statutoryAct(input), eventId: input.eventId,
        payload: canonical.text, contentSha256: canonical.contentSha256, storedAt: '2026-10-19T00:00:00.000Z' });
    }
    const bundle = { eventId: input.eventId, requiredStreams: [...A.accessStreams(input)], bindings };
    const commit = () => { bindings.forEach((b, i) => { database.streams[b.stream].rows.push(rows[i]); database.streams[b.stream].markers.push(b); }); };
    return { bundle, commit, rows };
  };
  return { service, hello, reserve, database, seal, journal, coordinator, directory, pair };
}

const reservation = ({ generation, proofDigest, ...binding }) => binding;
const sha256 = value => createHash('sha256').update(value).digest('hex');
function stateObservation(f) {
  const state = f.coordinator.call('read');
  return { revision: state.revision, generation: state.generation, stateSha256: sha256(JSON.stringify(state)),
    intents: Object.keys(state.intents).length, slots: Object.keys(state.slots).length,
    terminals: Object.keys(state.terminal).length };
}
function directoryHashes(directory) {
  const found = {};
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) for (const [name, hash] of Object.entries(directoryHashes(file))) found[entry.name + '/' + name] = hash;
    else if (entry.isFile()) found[entry.name] = sha256(fs.readFileSync(file));
  }
  return found;
}
async function complete(f, work, acknowledge = false) {
  const item = await f.reserve(work); item.commit();
  const proof = await work.call('confirm-bundle', item.bundle); assert.equal(proof.ok, true, 'new complete event seals');
  if (acknowledge) assert.equal((await work.call('acknowledge', { proof: proof.result, bindings: item.bundle.bindings })).ok, true,
    'exact full-proof acknowledgement must be accepted');
  return { ...item, proof: proof.result };
}
async function replayObservation(f, work, binding) {
  const before = stateObservation(f);
  const reply = await work.call('reserve', { binding: reservation(binding), prefix: null });
  const after = stateObservation(f);
  return { before, reply, after };
}
function assertExcluded(observation) {
  // Refusal alone is insufficient: a mutation followed by an error must also fail.
  assert.equal(observation.after.stateSha256, observation.before.stateSha256, 'terminal replay must not mutate durable state');
  assert.equal(observation.reply.ok, false, 'terminal reserve must refuse');
  assert.equal(observation.reply.error.code, 'CONFLICT', 'terminal refusal is a typed conflict');
}
async function terminalChild(input) {
  const cleanup = [], t = { after: fn => cleanup.push(fn) };
  try {
    if (input.phase === 'inspect' || input.phase === 'integrity') {
      const before = directoryHashes(input.directory);
      try {
        const f = await fixture(t, { directory: input.directory, model: model(input.database), cold: true });
        const state = f.coordinator.call('read');
        let error = null;
        if (input.phase === 'integrity') try { await f.service.start(); } catch (failure) { error = failure.code; }
        return { pid: process.pid, before, after: directoryHashes(f.directory), state, error, phase: f.service.state };
      } catch (failure) {
        if (input.phase !== 'integrity') throw failure;
        return { pid: process.pid, before, after: directoryHashes(input.directory), error: failure.code, phase: 'failed' };
      }
    }
    const f = await fixture(t, ['seed', 'historical-seed'].includes(input.phase) ? {} :
      { directory: input.directory, model: model(input.database) });
    const peer = await f.hello(), work = await peer.work();
    // Explicit diagnostic child modes preserve the open historical-proof evidence.
    // These are not selected passing acceptance cases and do not run a real SQL expiry.
    if (input.phase === 'historical-seed') {
      const original = await f.reserve(work, event(input.twoStreams)); original.commit();
      let proof = input.neverConfirmed ? null : await work.call('confirm-bundle', original.bundle);
      if (proof) assert.equal(proof.ok, true, 'original complete proof exists before expiry');
      if (input.acknowledge) assert.equal((await work.call('acknowledge',
        { proof: proof.result, bindings: original.bundle.bindings })).ok, true);
      // Advancing seals must not change the first canonical proof's coverage.
      if (input.advance) await complete(f, work);
      const retention = await (await f.hello('retention')).work();
      const prepared = await retention.call('expiry-prefix', { through: 1 });
      assert.equal(prepared.ok, true, 'deletion requires durable complete bundle evidence');
      const prefix = prepared.result;
      const payload = C.checkpointPayload('2036-10-19T00:00:00.000Z', 1, 1, prefix.anchor.hash);
      const sequence = prefix.seal.sequence + 1;
      const binding = { stream: 'viewing', chainId: prefix.seal.chainId, attemptId: randomUUID(), bundleId: randomUUID(),
        kind: 'expiry', eventId: null, sequence, previousHash: prefix.seal.hash,
        hash: C.entryHash(sequence, prefix.seal.hash, payload), contentSha256: sha256(payload) };
      const reserved = await retention.call('reserve', { binding, prefix });
      assert.equal(reserved.ok, true, 'issued prefix reserves before synthetic expiry commit');
      f.database.streams.viewing.rows = [...f.database.streams.viewing.rows.filter(r => r.sequence > 1),
        { sequence, previousHash: binding.previousHash, hash: binding.hash,
        kind: 'expiry', statutoryAct: null, eventId: null, payload, contentSha256: binding.contentSha256,
        storedAt: '2036-10-19T00:00:00.000Z' }];
      f.database.streams.viewing.markers = [...f.database.streams.viewing.markers.filter(m => m.sequence > 1), reserved.result];
      const expiry = await retention.call('confirm-bundle', { eventId: null, requiredStreams: ['viewing'], bindings: [reserved.result] });
      assert.equal(expiry.ok, true, 'valid retained-prefix checkpoint publishes');
      if (!proof) proof = await work.call('confirm-bundle', original.bundle);
      assert.equal(proof.ok, true, 'never-confirmed original remains provable after source deletion');
      f.coordinator.call('compact', { force: true });
      return { pid: process.pid, directory: f.directory, database: f.database.streams, bundle: original.bundle,
        originalProof: proof.result, expiryProof: expiry.result, state: f.coordinator.call('read'), files: directoryHashes(f.directory) };
    }
    if (input.phase === 'historical-reopen') {
      const before = directoryHashes(f.directory);
      const lookups = [];
      for (let i = 0; i < 2; i++) lookups.push(await work.call('lookup-outcome', input.bundle));
      const confirmation = await work.call('confirm-bundle', input.bundle);
      const ack = input.exerciseAck ? await work.call('acknowledge', { proof: input.originalProof, bindings: input.bundle.bindings }) : null;
      const retry = input.exerciseAck ? await work.call('acknowledge', { proof: input.originalProof, bindings: input.bundle.bindings }) : null;
      const exclusions = [];
      for (const binding of input.bundle.bindings) exclusions.push(await replayObservation(f, work, binding));
      return { pid: process.pid, phase: f.service.state, lookups, confirmation,
        ack, retry, exclusions, state: f.coordinator.call('read'), before, after: directoryHashes(f.directory) };
    }
    if (input.phase === 'seed') {
      const original = await complete(f, work, true);
      await complete(f, work);
      return { directory: f.directory, database: f.database.streams, bundle: original.bundle, proof: original.proof,
        epoch: f.service.serviceEpoch, pid: process.pid, observation: stateObservation(f) };
    }
    const old = work.req('reserve', { binding: reservation(input.bundle.bindings[0]), prefix: null });
    old.serviceEpoch = input.epoch;
    const stale = await f.service.dispatch('api', old, peer.socket);
    // D1660: a later acknowledged event compacts the checkpoint in this new process; attempts that
    // recovery settled negative (aborted, slot free above the frontier) must stay excluded after it.
    if (input.acknowledgeBeforeReplay) await complete(f, work, true);
    const observations = [];
    // The settled-negative attempt first: its slot is free above the frontier, so only its terminal identity excludes it.
    for (const binding of input.abortedBindings ?? []) observations.push(await replayObservation(f, work, binding));
    for (const binding of input.bundle.bindings) observations.push(await replayObservation(f, work, binding));
    const proof = await work.call('lookup-outcome', input.bundle);
    return { directory: f.directory, database: f.database.streams, bundle: input.bundle,
      epoch: f.service.serviceEpoch, pid: process.pid, stale, observations, proof, observation: stateObservation(f) };
  } finally {
    for (const fn of cleanup.reverse()) await fn();
  }
}
function childPhase(directory, phase, input = {}) {
  const config = path.join(directory, phase + '-input.json'), output = path.join(directory, phase + '-output.json');
  fs.writeFileSync(config, JSON.stringify({ ...input,
    phase: ['seed', 'inspect', 'integrity', 'historical-seed', 'historical-reopen'].includes(phase) ? phase : 'replay', output }));
  const child = spawnSync(process.execPath, ['--max-old-space-size=3072', __filename, '--terminal-child', config],
    { env: process.env, encoding: 'utf8', timeout: 60000 });
  fs.writeFileSync(path.join(directory, phase + '-stdout.log'), child.stdout ?? '');
  fs.writeFileSync(path.join(directory, phase + '-stderr.log'), child.stderr ?? '');
  assert.equal(child.error?.code ?? null, null, 'child completes within its budget');
  assert.equal(child.status, 0, 'child setup and product execution complete: ' + String(child.stderr).slice(-1000));
  return JSON.parse(fs.readFileSync(output, 'utf8'));
}

if (childInput !== -1) {
  const input = JSON.parse(fs.readFileSync(process.argv[childInput + 1], 'utf8'));
  terminalChild(input).then(result => fs.writeFileSync(input.output, JSON.stringify(result, null, 2) + '\n'),
    error => { process.stderr.write(String(error.stack) + '\n'); process.exitCode = 1; });
} else {
test('C-S02.D01 explicit local owner and no implicit journal promotion', async () => {
  const absent = path.join(root, 'tmp/emr-b2-c-2/absent-' + randomUUID());
  assert.throws(() => new FailureJournal(absent), { code: 'FailureJournalUnavailable' });
  assert.equal(fs.existsSync(absent), false);
});
test('C-S03.D02 non-ready reserve never waits for exclusive recovery and stop never becomes ready', async t => {
  const f = await fixture(t, { cold: true }), entered = deferred(), release = deferred();
  f.database.sql.withWriterFence = async work => { entered.resolve(); await release.promise; return work(f.database.sql); };
  const start = f.service.start(); const rejected = assert.rejects(start, { code: 'STOPPING' });
  await entered.promise;
  const peer = await f.hello(); assert.equal(peer.reply.error.code, 'NOT_READY');
  f.service.quiesce(); release.resolve(); await rejected;
  assert.equal(f.service.state, 'stopping'); assert.equal((await f.hello()).reply.error.code, 'STOPPING');
});
test('C-S04.D03 forged role, method, session, epoch, chain and scope execute no writer operation', async t => {
  const f = await fixture(t), peer = await f.hello(), work = await peer.work();
  const before = f.coordinator.call('read').revision;
  for (const operation of ['recoverAtStart', 'compare-and-set', 'stop', 'update']) {
    await assert.rejects(f.service.dispatch('api', { ...work.req('end'), operation }, peer.socket), { code: 'PROTOCOL' });
  }
  await assert.rejects(f.service.dispatch('api', { ...work.req('end'), role: 'retention' }, peer.socket), { code: 'PROTOCOL' });
  assert.equal((await f.service.dispatch('retention', work.req('journal-find', { id: 'x' }), peer.socket)).error.code, 'SESSION');
  for (const [field, value, code] of [['serviceEpoch', randomUUID(), 'EPOCH'], ['session', '0'.repeat(64), 'SESSION'], ['workId', randomUUID(), 'SCOPE']]) {
    assert.equal((await f.service.dispatch('api', { ...work.req('journal-find', { id: 'x' }), [field]: value }, peer.socket)).error.code, code);
  }
  const bad = work.req('journal-find', { id: 'x' }); bad.value.chains = { ...bad.value.chains, history: randomUUID() };
  assert.equal((await f.service.dispatch('api', bad, peer.socket)).error.code, 'CONFLICT');
  const staleWrite = work.req('journal-record', { id: 'stale-epoch', kind: 'ledger-unavailable', body: { eventId: 'synthetic', cause: 'commit-unknown' } });
  staleWrite.serviceEpoch = randomUUID();
  const refused = await f.service.dispatch('api', staleWrite, peer.socket);
  assert.equal(refused.ok, false, 'an old epoch must not gain mutation authority');
  assert.equal(f.journal.find('stale-epoch'), undefined, 'the old work created no durable journal record');
  assert.equal(f.coordinator.call('read').revision, before);
});
test('C-S05.D04 reserve and journal replay retain the first durable identity and conflict refuses', async t => {
  const f = await fixture(t), peer = await f.hello(), work = await peer.work(), reserved = await f.reserve(work, event(false));
  const original = reserved.bundle.bindings[0], { generation, proofDigest, ...binding } = original;
  assert.deepEqual((await work.call('reserve', { binding, prefix: null })).result, original);
  assert.equal(f.coordinator.call('read').intents['viewing:' + binding.attemptId].owner, peer.identity.clientInstanceId);
  const other = await (await f.hello()).work();
  assert.equal((await other.call('reserve', { binding, prefix: null })).ok, false);
  // The foreign reserve refusal is fail-closed; inspect idempotency in a fresh service fixture.
  const j = await fixture(t), jw = await (await j.hello()).work();
  const record = { id: randomUUID(), kind: 'ledger-unavailable', body: { eventId: randomUUID(), cause: 'commit-unknown' } };
  const a = await jw.call('journal-record', record), b = await jw.call('journal-record', record);
  assert.equal(a.ok, true); assert.deepEqual(b.result, a.result);
  assert.equal((await jw.call('journal-record', { ...record, body: { ...record.body, cause: 'seal-unavailable' } })).error.code, 'CONFLICT');
  assert.equal(j.journal.all().length, 1);
});
test('C-S04.D05 complete independent stored classification rejects an omitted history stream', async t => {
  const f = await fixture(t), work = await (await f.hello()).work(), pending = await f.reserve(work); pending.commit();
  const omitted = { ...pending.bundle, requiredStreams: ['viewing'], bindings: [pending.bundle.bindings[0]] };
  assert.equal((await work.call('confirm-bundle', omitted)).error.code, 'CONFLICT');
  const proof = await work.call('confirm-bundle', pending.bundle); assert.equal(proof.ok, true);
  assert.deepEqual(proof.result.requiredStreams, ['viewing', 'history']);
  assert.deepEqual(proof.result.entries.map(e => e.sealed.sequence), [1, 1]);
  assert.deepEqual((await work.call('confirm-bundle', pending.bundle)).result, proof.result);
  assert.equal((await work.call('acknowledge', { proof: proof.result, bindings: pending.bundle.bindings })).ok, true);
});
test('C-S05.D06 live absence and caller journal negatives remain unresolved; recovery alone proves absence', async t => {
  const f = await fixture(t), work = await (await f.hello()).work(), pending = await f.reserve(work, event(false));
  assert.equal((await work.call('lookup-outcome', pending.bundle)).result.outcome, 'unresolved');
  const b = pending.bundle.bindings[0];
  assert.equal((await work.call('journal-record', { id: `commit-not-found:viewing:${b.attemptId}`, kind: 'commit-not-found',
    body: { eventId: b.eventId, contentSha256: b.contentSha256 } })).ok, true);
  assert.equal((await work.call('lookup-outcome', pending.bundle)).result.outcome, 'unresolved');
  f.service.close(); await f.service.drained(); f.coordinator.close();
  const next = await fixture(t, { directory: f.directory, model: f.database }), nw = await (await next.hello()).work();
  assert.equal((await nw.call('lookup-outcome', pending.bundle)).result.outcome, 'fenced-not-committed');
  const { generation, proofDigest, ...reservation } = b;
  assert.equal((await nw.call('reserve', { binding: reservation, prefix: null })).error.code, 'CONFLICT');
});
test('C-S04.D07 end revokes admission and joins every already-started verification', async t => {
  const f = await fixture(t), peer = await f.hello(), work = await peer.work(), pending = await f.reserve(work); pending.commit();
  const entered = deferred(), release = deferred(), snapshot = f.database.sql.snapshot;
  f.database.sql.snapshot = async fn => { entered.resolve(); await release.promise; return snapshot(fn); };
  const confirm = work.call('confirm-bundle', pending.bundle); await entered.promise;
  let ended = false; const end = work.call('end').then(value => { ended = true; return value; });
  const endAgain = work.call('end');
  await tick(); assert.equal(ended, false);
  assert.equal((await work.call('journal-find', { id: 'unstarted' })).error.code, 'SCOPE');
  assert.equal((await peer.call('status')).result.scopes, 1);
  release.resolve(); assert.equal((await confirm).ok, true);
  assert.equal((await end).result.status, 'ended'); assert.equal((await endAgain).result.status, 'already-ended');
  assert.equal((await peer.call('status')).result.scopes, 0);
  assert.equal((await work.call('end')).result.status, 'already-ended');
});
test('C-S04.D08 verification saturation leaves reserve independent and bounded', async t => {
  const f = await fixture(t), peer = await f.hello(), work = await peer.work(), pending = await f.reserve(work); pending.commit();
  const release = deferred(), entered = deferred(), snapshot = f.database.sql.snapshot; let count = 0;
  f.database.sql.snapshot = async fn => { if (++count === L.EMR_STATE_VERIFY_CONCURRENCY) entered.resolve(); await release.promise; return snapshot(fn); };
  const confirms = Array.from({ length: L.EMR_STATE_VERIFY_CONCURRENCY }, () => work.call('confirm-bundle', pending.bundle));
  await entered.promise;
  assert.equal((await work.call('confirm-bundle', pending.bundle)).error.code, 'OVERLOADED');
  const b = pending.bundle.bindings[0], { generation, proofDigest, ...binding } = b;
  assert.equal((await work.call('reserve', { binding, prefix: null })).result.generation, b.generation);
  release.resolve(); for (const result of await Promise.all(confirms)) assert.equal(result.ok, true);
});
test('C-S04.D09 session, live scope and active operation bounds refuse before dispatch', async t => {
  const f = await fixture(t), peers = [];
  for (let i = 0; i < L.EMR_STATE_MAX_SESSIONS; i++) peers.push(await f.hello());
  assert.equal((await f.hello()).reply.error.code, 'OVERLOADED');
  const works = [];
  for (let i = 0; i < L.EMR_STATE_MAX_SCOPES; i++) works.push(await peers[0].work());
  assert.equal((await peers[0].call('begin', {}, randomUUID())).error.code, 'OVERLOADED');
  const calls = Array.from({ length: L.EMR_STATE_MAX_OPERATIONS }, (_, i) => works[i].call('journal-find', { id: 'missing' }));
  assert.equal((await works.at(-1).call('journal-find', { id: 'not-admitted' })).error.code, 'OVERLOADED');
  for (const result of await Promise.all(calls)) assert.equal(result.ok, true);
  assert.equal((await works[0].call('end')).ok, true);
  assert.equal((await peers[0].call('begin', {}, randomUUID())).ok, true);
});
test('C-S03.D10 quiesce and control loss forbid new scopes while owned work settles', async t => {
  const f = await fixture(t), peer = await f.hello(), work = await peer.work();
  f.service.quiesce();
  assert.equal((await peer.call('begin', {}, randomUUID())).error.code, 'STOPPING');
  assert.equal((await f.hello()).reply.error.code, 'STOPPING');
  assert.equal((await work.call('journal-find', { id: 'missing' })).ok, true);
  peer.socket.destroy(); await tick();
  assert.equal((await work.call('journal-find', { id: 'missing' })).error.code, 'SESSION');
  await f.service.drained();
});
test('C-S05.D11 service recovery preserves unacknowledged complete attempt bindings', async t => {
  const f = await fixture(t), work = await (await f.hello()).work(), pending = await f.reserve(work); pending.commit();
  assert.equal((await work.call('confirm-bundle', pending.bundle)).ok, true);
  f.service.close(); await f.service.drained(); f.coordinator.close();
  const next = await fixture(t, { directory: f.directory, model: f.database }), nw = await (await next.hello()).work();
  for (const b of pending.bundle.bindings) assert.equal(next.coordinator.call('read').terminal[b.stream + ':' + b.attemptId].binding.hash, b.hash);
  const outcome = await nw.call('lookup-outcome', pending.bundle);
  assert.equal(outcome.result.outcome, 'committed-and-sealed');
  assert.equal(outcome.result.proof.serviceEpoch, f.service.serviceEpoch, 'canonical proof keeps its original publication epoch');
  assert.equal(outcome.serviceEpoch, next.service.serviceEpoch, 'current response still requires current admission');
});
test('C-S04.D12 actual sockets wait for EOF, reject trailing frames and invalidate a lost control', async t => {
  const f = await fixture(t), peer = await f.hello(), work = await peer.work();
  const server = net.createServer({ allowHalfOpen: true }, socket => f.service.accept('api', socket));
  // Windows test uses TCP only because named pipes do not support the wire's half-close.
  // Linux executes the unchanged service accept path on a Unix socket.
  const endpoint = process.platform === 'win32' ? { host: '127.0.0.1', port: 0 } : path.join(os.tmpdir(), 'emr-c-' + randomUUID() + '.sock');
  await new Promise(resolve => server.listen(endpoint, resolve));
  const connect = () => net.createConnection(process.platform === 'win32' ? { host: '127.0.0.1', port: server.address().port } : endpoint);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = work.req('journal-record', { id: 'socket-record', kind: 'ledger-unavailable', body: { eventId: 'synthetic', cause: 'commit-unknown' } });
  const socket = connect(); socket.on('error', () => {});
  const closed = new Promise(resolve => socket.on('close', resolve));
  socket.write(P.encodeStateFrame(request)); await tick();
  assert.equal(f.journal.find('socket-record'), undefined);
  socket.end(P.encodeStateFrame(request)); await closed;
  assert.equal(f.journal.find('socket-record'), undefined);
  const valid = connect(), parts = []; valid.on('data', part => parts.push(part));
  const finished = new Promise((resolve, reject) => { valid.on('end', resolve); valid.on('error', reject); });
  valid.end(P.encodeStateFrame(request)); await finished;
  const response = P.parseStateResponse(JSON.parse(Buffer.concat(parts).toString()), request);
  assert.equal(response.ok, true); assert.equal(f.journal.find('socket-record').id, 'socket-record');
});
test('C-S05.D13 a lost durable journal reply replays the original record without duplication', async t => {
  const f = await fixture(t), peer = await f.hello(), work = await peer.work(), written = deferred();
  let serverPeer;
  const server = net.createServer({ allowHalfOpen: true }, socket => { serverPeer = socket; f.service.accept('api', socket); });
  const endpoint = process.platform === 'win32' ? { host: '127.0.0.1', port: 0 } : path.join(os.tmpdir(), 'emr-c-' + randomUUID() + '.sock');
  await new Promise(resolve => server.listen(endpoint, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const record = f.journal.record.bind(f.journal);
  f.journal.record = (...args) => { const result = record(...args); serverPeer.destroy(); written.resolve(result); return result; };
  const socket = net.createConnection(process.platform === 'win32' ? { host: '127.0.0.1', port: server.address().port } : endpoint);
  let replyBytes = 0; socket.on('data', bytes => { replyBytes += bytes.length; }); socket.on('error', () => {});
  const closed = new Promise(resolve => socket.once('close', resolve));
  const value = { id: randomUUID(), kind: 'ledger-unavailable', body: { eventId: randomUUID(), cause: 'commit-unknown' } };
  socket.end(P.encodeStateFrame(work.req('journal-record', value)));
  const original = await written.promise; await closed; assert.equal(replyBytes, 0);
  f.journal.record = record;
  const replay = await work.call('journal-record', value);
  assert.equal(replay.ok, true); assert.deepEqual(replay.result, original); assert.equal(f.journal.all().length, 1);
});
test('C-S05.D14 acknowledgement checks the actual full proof frontier before cleanup', async t => {
  const f = await fixture(t), work = await (await f.hello()).work(), pending = await f.reserve(work); pending.commit();
  const reply = await work.call('confirm-bundle', pending.bundle); assert.equal(reply.ok, true);
  const forged = structuredClone(reply.result); forged.entries[0].sealed.sequence += 1; forged.entries[0].sealed.hash = '1'.repeat(64);
  assert.equal((await work.call('acknowledge', { proof: forged, bindings: pending.bundle.bindings })).error.code, 'CONFLICT');
  for (const b of pending.bundle.bindings) assert.equal(f.coordinator.call('read').terminal[b.stream + ':' + b.attemptId].binding.hash, b.hash);
});
test('C-S04.D15 a rejected peer cannot retire a scope with another verification still running', async t => {
  const f = await fixture(t), peer = await f.hello(), work = await peer.work(), pending = await f.reserve(work); pending.commit();
  const entered = deferred(), release = deferred(), snapshot = f.database.sql.snapshot; let count = 0;
  f.database.sql.snapshot = async fn => {
    if (++count === 1) throw new P.StateProtocolError('UNAVAILABLE', 'unknown');
    entered.resolve(); await release.promise; return snapshot(fn);
  };
  const rejected = work.call('confirm-bundle', pending.bundle), held = work.call('confirm-bundle', pending.bundle);
  await entered.promise; assert.equal((await rejected).ok, false);
  let ended = false; const end = work.call('end').then(() => { ended = true; });
  await tick(); assert.equal(ended, false); assert.equal((await peer.call('status')).result.scopes, 1);
  release.resolve(); assert.equal((await held).ok, true); await end;
});

test('D1641-T01 ack and later publication exclude attempts in the same epoch and two new processes', async t => {
  const f = await fixture(t), work = await (await f.hello()).work();
  const original = await complete(f, work, true); await complete(f, work);
  const fresh = await (await f.hello()).work();
  const sameEpoch = [];
  for (const binding of original.bundle.bindings) sameEpoch.push(await replayObservation(f, fresh, binding));
  const evidence = fs.mkdtempSync(path.join(path.dirname(f.directory), 'restart-'));
  const seed = childPhase(evidence, 'seed');
  const second = childPhase(evidence, 'restart-1', seed);
  for (const observation of second.observations) assertExcluded(observation);
  const third = childPhase(evidence, 'restart-2', second);
  assert.notEqual(seed.epoch, second.epoch); assert.notEqual(second.epoch, third.epoch);
  assert.notEqual(seed.pid, second.pid); assert.notEqual(second.pid, third.pid);
  for (const next of [second, third]) assert.equal(next.stale.error.code, 'EPOCH');
  for (const observation of [...sameEpoch, ...second.observations, ...third.observations]) assertExcluded(observation);
  for (const next of [second, third]) {
    assert.equal(next.proof.result.outcome, 'committed-and-sealed');
    assert.deepEqual(next.proof.result.proof.entries.map(({ sealed, ...b }) => b), seed.bundle.bindings);
  }
});

test('D1641-T02 terminal identity survives new admission identities and mutable binding changes', async t => {
  const f = await fixture(t), work = await (await f.hello()).work();
  const original = await complete(f, work, true); await complete(f, work);
  const fresh = await (await f.hello()).work();
  // The legitimate second stream shares the attempt/bundle; it is a positive control.
  const next = await complete(f, fresh); assert.equal(next.bundle.bindings.length, 2);
  const binding = original.bundle.bindings[0], observations = [];
  for (const patch of [{}, { bundleId: randomUUID() }, { eventId: randomUUID() }, { sequence: binding.sequence + 10 },
    { hash: '1'.repeat(64) }, { previousHash: '2'.repeat(64) }, { contentSha256: '3'.repeat(64) }]) {
    observations.push(await replayObservation(f, fresh, { ...binding, ...patch }));
  }
  const foreign = fresh.req('reserve', { binding: { ...reservation(binding), chainId: randomUUID() }, prefix: null });
  await assert.rejects(f.service.dispatch('api', foreign, new net.Socket()), { code: 'PROTOCOL' });
  for (const observation of observations) assertExcluded(observation);
});

test('D1641-T03 committed aborted and superseded identities stay terminal while a free slot is reusable', async t => {
  const f = await fixture(t), work = await (await f.hello()).work();
  const abandoned = await f.reserve(work, event(false));
  // A later holder of the same SQL slot supersedes the first attempt; it does not commit that attempt.
  const replacement = await f.reserve(work, event(false)); replacement.commit();
  assert.equal((await work.call('confirm-bundle', replacement.bundle)).ok, true);
  const pending = await f.reserve(work, event(false));
  f.service.close(); await f.service.drained(); f.coordinator.close();
  const restarted = await fixture(t, { directory: f.directory, model: f.database });
  const current = await (await restarted.hello()).work();
  for (const item of [abandoned, pending]) assertExcluded(await replayObservation(restarted, current, item.bundle.bindings[0]));
  assert.equal((await current.call('lookup-outcome', pending.bundle)).result.outcome, 'fenced-not-committed');
  assert.equal((await current.call('lookup-outcome', abandoned.bundle)).result.outcome, 'unresolved');
  const committed = await complete(restarted, current, true); await complete(restarted, current);
  assert.equal(committed.bundle.bindings[0].sequence, pending.bundle.bindings[0].sequence, 'a different attempt can use the aborted slot');
  for (const binding of committed.bundle.bindings) assertExcluded(await replayObservation(restarted, current, binding));
});

test('D1641-T04 a lost reserve result replays only the live pending binding and no new epoch work', async t => {
  const f = await fixture(t), work = await (await f.hello()).work(), pending = await f.reserve(work);
  // The caller discards the first result; durable state remains the retry authority.
  for (const binding of pending.bundle.bindings) {
    const before = stateObservation(f), replay = await work.call('reserve', { binding: reservation(binding), prefix: null });
    assert.deepEqual(replay.result, binding, 'live retry returns the original generation');
    assert.equal(stateObservation(f).stateSha256, before.stateSha256, 'live retry performs no durable mutation');
  }
  pending.commit();
  const proof = await work.call('confirm-bundle', pending.bundle); assert.equal(proof.ok, true);
  assert.equal((await work.call('acknowledge', { proof: proof.result, bindings: pending.bundle.bindings })).ok, true);
  await complete(f, work);
  for (const binding of pending.bundle.bindings) assertExcluded(await replayObservation(f, work, binding));
});

test('D1641-T05 missing lost duplicate and invalid acknowledgements never erase terminal exclusion', async t => {
  for (const mode of ['none', 'lost', 'duplicate', 'forged', 'partial']) {
    const f = await fixture(t), work = await (await f.hello()).work(), original = await complete(f, work);
    const value = { proof: original.proof, bindings: original.bundle.bindings };
    if (mode === 'lost' || mode === 'duplicate') {
      assert.equal((await work.call('acknowledge', value)).ok, true, 'exact full-proof acknowledgement must be accepted');
      if (mode === 'duplicate') assert.equal((await work.call('acknowledge', value)).ok, true, 'exact full-proof acknowledgement must be accepted');
    }
    if (mode === 'forged') {
      const forged = structuredClone(value); forged.proof.entries[0].sealed.hash = 'f'.repeat(64);
      await assert.rejects(work.call('acknowledge', forged), { code: 'PROTOCOL' });
    }
    if (mode === 'partial') {
      const partial = { proof: { ...value.proof, requiredStreams: ['viewing'], entries: [value.proof.entries[0]] },
        bindings: [value.bindings[0]] };
      assert.equal((await work.call('acknowledge', partial)).ok, false);
    }
    await complete(f, work);
    for (const binding of original.bundle.bindings) assertExcluded(await replayObservation(f, work, binding));
    assert.equal((await work.call('lookup-outcome', original.bundle)).result.outcome, 'committed-and-sealed');
  }
});

test('D1641-T06 actual WAL checkpoint compaction preserves exclusion through a new process', { skip: FORMAT === 4 && 'v3 checkpoint/WAL bytes (compaction); v4: V4-T05' }, async t => {
  const f = await fixture(t), work = await (await f.hello()).work(), original = await complete(f, work, true);
  const checkpoint = path.join(f.directory, 'seal/settlement.json');
  const firstRevision = JSON.parse(fs.readFileSync(checkpoint)).state.revision;
  const started = process.hrtime.bigint();
  let count = 1;
  while (JSON.parse(fs.readFileSync(checkpoint)).state.revision === firstRevision && count < 3000) {
    await complete(f, work, true); count++;
  }
  const compacted = JSON.parse(fs.readFileSync(checkpoint)).state;
  assert.ok(compacted.revision > firstRevision, 'normal publication must actually trigger checkpoint compaction');
  const measurements = { directory: f.directory, events: count, terminals: stateObservation(f).terminals,
    elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
    checkpointBytes: fs.statSync(checkpoint).size, walBytes: fs.statSync(path.join(f.directory, 'seal/settlement.jsonl')).size };
  fs.writeFileSync(path.join(path.dirname(f.directory), path.basename(f.directory) + '-compaction.json'), JSON.stringify(measurements, null, 2) + '\n');
  console.log('TERMINAL_COMPACTION ' + JSON.stringify(measurements));
  // A reservation whose COMMIT never happens, above the slot the next event will take: the new process
  // settles it negative (terminal aborted, slot free), then compacts again on its own acknowledgement.
  const tail = await f.database.sql.tail('viewing'), pending = {
    ...reservation(original.bundle.bindings[0]), attemptId: randomUUID(), bundleId: randomUUID(), eventId: randomUUID(),
    sequence: tail.sequence + 2, previousHash: 'a'.repeat(64), hash: 'b'.repeat(64) };
  assert.equal((await work.call('reserve', { binding: pending, prefix: null })).ok, true, 'fresh valid reserve must succeed');
  f.service.close(); await f.service.drained(); f.coordinator.close();
  const evidence = fs.mkdtempSync(path.join(path.dirname(f.directory), 'compacted-'));
  const next = childPhase(evidence, 'restart', { directory: f.directory, database: f.database.streams,
    bundle: original.bundle, epoch: f.service.serviceEpoch, abortedBindings: [pending], acknowledgeBeforeReplay: true });
  for (const observation of next.observations) assertExcluded(observation);
  assert.equal(next.observation.terminals, 2 * (count + 1) + 1, 'compaction retains every acknowledged and settled stream identity');
});

test('D1641-T06F publication flush failures never acknowledge success or erase terminal exclusion', { skip: FORMAT === 4 && 'v3 WAL/tail inode fault injection; v4: V4-T04' }, async t => {
  // Inject at the real write/flush boundary. A missing flush makes the failure injection
  // ineffective and wrongly permits confirmation, which is the mutant's behavioral kill.
  for (const target of ['wal', 'tail']) {
    const g = await fixture(t), gw = await (await g.hello()).work();
    const old = await complete(g, gw, true), pending = await g.reserve(gw); pending.commit();
    const inode = fs.statSync(path.join(g.directory, target === 'wal' ? 'seal/settlement.jsonl' : 'seal/tail.json')).ino;
    const sync = fs.fdatasyncSync;
    let injected = 0, result;
    fs.fdatasyncSync = fd => {
      if (fs.fstatSync(fd).ino === inode) { injected++; throw Object.assign(new Error('synthetic flush failure'), { code: 'EIO' }); }
      return sync(fd);
    };
    try { result = await gw.call('confirm-bundle', pending.bundle); } finally { fs.fdatasyncSync = sync; }
    assert.equal(result.ok, false, 'a failed terminal publication flush must never return durable success');
    assert.ok(injected > 0, 'the actual publication flush cutpoint was reached');
    g.service.close(); await g.service.drained(); g.coordinator.close();
    const restored = await fixture(t, { directory: g.directory, model: g.database });
    const rw = await (await restored.hello()).work();
    for (const b of old.bundle.bindings) assertExcluded(await replayObservation(restored, rw, b));
    assert.equal((await rw.call('lookup-outcome', pending.bundle)).result.outcome, 'committed-and-sealed');
  }
});

test('D1641-T08 a quiesced paired component copy retains terminal exclusion without touching its source', async t => {
  const f = await fixture(t), work = await (await f.hello()).work(), original = await complete(f, work, true);
  await complete(f, work);
  f.service.close(); await f.service.drained(); f.coordinator.close();
  const before = directoryHashes(f.directory), copy = f.directory + '-copy';
  fs.cpSync(f.directory, copy, { recursive: true, errorOnExist: true });
  const evidence = fs.mkdtempSync(path.join(path.dirname(f.directory), 'copy-'));
  const next = childPhase(evidence, 'restart', { directory: copy, database: structuredClone(f.database.streams),
    bundle: original.bundle, epoch: f.service.serviceEpoch });
  assert.equal(JSON.stringify(directoryHashes(f.directory)), JSON.stringify(before), 'copy recovery leaves every source byte unchanged');
  for (const observation of next.observations) assertExcluded(observation);
  assert.equal(next.proof.result.outcome, 'committed-and-sealed');
});

test('D1641-T09 acknowledged identity accumulation survives capacity refusal and recovery', { skip: FORMAT === 4 && 'v3 WAL inode fault injection; v4: V4-T04' }, async t => {
  const f = await fixture(t), work = await (await f.hello()).work(), originals = [];
  for (let i = 0; i < 32; i++) originals.push(await complete(f, work, true));
  assert.equal(stateObservation(f).terminals, 64, 'acknowledged identities are never count-evicted');
  const oldWrite = fs.writeFileSync, logInode = fs.statSync(path.join(f.directory, 'seal/settlement.jsonl')).ino;
  const prior = stateObservation(f), next = { ...reservation(originals[0].bundle.bindings[0]),
    attemptId: randomUUID(), bundleId: randomUUID(), eventId: randomUUID(), sequence: 33 };
  let writes = 0, reply;
  fs.writeFileSync = (file, ...args) => {
    if (typeof file === 'number' && fs.fstatSync(file).ino === logInode) {
      writes++; throw Object.assign(new Error('synthetic full device'), { code: 'ENOSPC' });
    }
    return oldWrite(file, ...args);
  };
  try { reply = await work.call('reserve', { binding: next, prefix: null }); } finally { fs.writeFileSync = oldWrite; }
  assert.equal(writes, 1); assert.equal(reply.ok, false, 'capacity failure cannot acknowledge a reservation');
  assert.equal(stateObservation(f).stateSha256, prior.stateSha256, 'capacity failure never evicts old terminal evidence');
  f.service.close(); await f.service.drained(); f.coordinator.close();
  const restored = await fixture(t, { directory: f.directory, model: f.database }), rw = await (await restored.hello()).work();
  for (const item of originals) for (const b of item.bundle.bindings) assertExcluded(await replayObservation(restored, rw, b));
});

// D1650: phase/origin/body/destination/persistence equivalence classes. Existing
// D1641 cases retain ack, terminal phases, compaction, copy and durability coverage.
// SQL facts here are synthetic; concurrency means dispatched promises, not PG locks.
async function unchangedReserve(f, work, binding, prefix = null, expected = 'CONFLICT') {
  const before = directoryHashes(f.directory), state = stateObservation(f);
  let reply;
  try { reply = await work.call('reserve', { binding, prefix }); }
  catch (error) { reply = { ok: false, error: { code: error.code } }; }
  assert.equal(JSON.stringify(directoryHashes(f.directory)), JSON.stringify(before), 'conflict must preserve every protected byte');
  assert.equal(stateObservation(f).stateSha256, state.stateSha256, 'conflict must preserve reservation state');
  assert.equal(reply.ok, false, 'conflicting or foreign-origin reserve must refuse');
  assert.equal(reply.error.code, expected, 'ordinary conflict must stay typed');
  assert.equal(f.service.state, 'ready', 'ordinary conflict must leave service usable');
  return reply;
}
async function expiryFixture(t) {
  const f = await fixture(t), work = await (await f.hello()).work();
  for (let i = 0; i < 2; i++) {
    const item = await f.reserve(work, event(false)); item.commit();
    assert.equal((await work.call('confirm-bundle', item.bundle)).ok, true);
  }
  const retention = await (await f.hello('retention')).work();
  const prefix = (await retention.call('expiry-prefix', { through: 1 })).result;
  const tail = await f.database.sql.tail('viewing');
  const payload = C.checkpointPayload('2036-10-19T00:00:00.000Z', prefix.anchor.sequence, prefix.count, prefix.anchor.hash);
  const binding = { stream: 'viewing', chainId: tail.chainId, attemptId: randomUUID(), bundleId: randomUUID(),
    kind: 'expiry', eventId: null, sequence: tail.sequence + 1, previousHash: tail.hash,
    hash: C.entryHash(tail.sequence + 1, tail.hash, payload), contentSha256: sha256(payload) };
  const reply = await retention.call('reserve', { binding, prefix });
  assert.equal(reply.ok, true, 'fresh expiry with issued prefix succeeds');
  return { f, retention, prefix, binding, reserved: reply.result, payload };
}
test('D1650-T01 exact pending replay ignores JSON ordering and transport ID with no DB or file change', async t => {
  const f = await fixture(t), work = await (await f.hello()).work(), item = await f.reserve(work);
  const before = directoryHashes(f.directory);
  for (const method of Object.keys(f.database.sql)) f.database.sql[method] = async () => { throw new Error('reserve queried DB'); };
  for (const binding of item.bundle.bindings) {
    const reordered = Object.fromEntries(Object.entries(reservation(binding)).reverse());
    const replies = await Promise.all(Array.from({ length: 4 }, () => work.call('reserve', { binding: reordered, prefix: null })));
    for (const reply of replies) assert.equal(JSON.stringify(reply.result), JSON.stringify(binding), 'exact replay returns original outputs');
  }
  assert.equal(JSON.stringify(directoryHashes(f.directory)), JSON.stringify(before), 'exact replay is write-free');
  assert.notEqual(item.bundle.bindings[0].generation, item.bundle.bindings[1].generation, 'same attempt permits independent stream generations');
  assert.notEqual(item.bundle.bindings[0].contentSha256, item.bundle.bindings[1].contentSha256, 'stream content is independent');
});
for (const occupied of [false, true]) test(`${occupied ? 'D1650-D17-V1' : 'D1650-D17'} moved pending identity refuses before destination mutation`, async t => {
  const f = await fixture(t), work = await (await f.hello()).work(), item = await f.reserve(work, event(false));
  const original = item.bundle.bindings[0], binding = { ...reservation(original), sequence: 2, previousHash: original.hash };
  binding.hash = C.entryHash(2, binding.previousHash, item.rows[0].payload);
  if (occupied) {
    const victim = { ...binding, attemptId: randomUUID(), bundleId: randomUUID() };
    assert.equal((await work.call('reserve', { binding: victim, prefix: null })).ok, true);
  }
  await unchangedReserve(f, work, binding);
  const evidence = fs.mkdtempSync(path.join(path.dirname(f.directory), 'identity-reopen-'));
  const disk = childPhase(evidence, 'inspect', { directory: f.directory, database: f.database.streams });
  assert.notEqual(disk.pid, process.pid);
  assert.equal(Object.values(disk.state.slots).filter(b => b.attemptId === original.attemptId).length, 1, 'one durable binding per stream attempt');
  assert.equal(JSON.stringify(disk.before), JSON.stringify(disk.after), 'disk inspection preserves bytes');
});
test('D1650-T03 every immutable body field and malformed stream role combination refuses write-free', async t => {
  const f = await fixture(t), work = await (await f.hello()).work(), item = await f.reserve(work, event(false));
  const original = reservation(item.bundle.bindings[0]);
  const variations = [
    ['bundleId', randomUUID(), 'CONFLICT'], ['eventId', randomUUID(), 'CONFLICT'],
    ['sequence', 2, 'CONFLICT'], ['previousHash', 'a'.repeat(64), 'CONFLICT'],
    ['hash', 'b'.repeat(64), 'CONFLICT'], ['contentSha256', 'c'.repeat(64), 'CONFLICT'],
    ['chainId', randomUUID(), 'PROTOCOL'], ['kind', 'history', 'PROTOCOL'],
    ['eventId', null, 'PROTOCOL'], ['stream', 'history', 'PROTOCOL'],
  ];
  for (const [field, value, code] of variations) await unchangedReserve(f, work, { ...original, [field]: value }, null, code);
  await unchangedReserve(f, work, { ...original, kind: 'expiry', eventId: null }, null, 'FORBIDDEN');
  const retry = await work.call('reserve', { binding: original, prefix: null });
  assert.equal(retry.ok, true, 'valid work remains usable after all conflicts');
  item.commit(); assert.equal((await work.call('confirm-bundle', item.bundle)).ok, true);
  await complete(f, work);
});
test('D1650-D17-V2 expiry original prefix remains replayable while changed prefix refuses', async t => {
  const { f, retention, prefix, binding, reserved } = await expiryFixture(t);
  const newer = (await retention.call('expiry-prefix', { through: 2 })).result;
  await unchangedReserve(f, retention, binding, newer);
  for (const changed of [
    { ...prefix, seal: { ...prefix.seal, chainId: randomUUID() } },
    { ...prefix, seal: { ...prefix.seal, sequence: 3 } },
    { ...prefix, seal: { ...prefix.seal, hash: 'a'.repeat(64) } },
    { ...prefix, anchor: { ...prefix.anchor, hash: 'b'.repeat(64) } },
    { ...prefix, count: 0 },
  ]) await unchangedReserve(f, retention, binding, changed);
  await unchangedReserve(f, retention, binding, null, 'PROTOCOL');
  const before = directoryHashes(f.directory);
  const replay = await retention.call('reserve', { binding, prefix });
  assert.equal(JSON.stringify(replay.result), JSON.stringify(reserved), 'original expiry proof survives newer scope prefix');
  assert.equal(JSON.stringify(directoryHashes(f.directory)), JSON.stringify(before), 'exact expiry replay is write-free');
  await unchangedReserve(f, retention, { ...binding, attemptId: randomUUID() }, prefix);
});
test('D1650-D17-V3 pending replay is pinned to original live work session and epoch', async t => {
  for (const mode of ['new-work', 'ended-work', 'new-session', 'lost-control', 'foreign-client', 'old-epoch']) {
    const f = await fixture(t), peer = await f.hello(), work = await peer.work(), item = await f.reserve(work, event(false));
    let other;
    if (mode === 'ended-work') await work.call('end');
    if (mode === 'lost-control') peer.socket.emit('end');
    if (['new-work', 'ended-work'].includes(mode)) other = await peer.work();
    else if (mode === 'old-epoch') other = { call: (op, value) => f.service.dispatch('api',
      { ...work.req(op, value), serviceEpoch: randomUUID() }, peer.socket) };
    else other = await (await f.hello('api', mode === 'foreign-client' ? randomUUID() : peer.identity.clientInstanceId)).work();
    for (const conflict of [false, true]) {
      const binding = reservation(item.bundle.bindings[0]);
      if (conflict) { binding.sequence++; binding.hash = 'b'.repeat(64); }
      await unchangedReserve(f, other, binding, null, mode === 'old-epoch' ? 'EPOCH' : 'CONFLICT');
    }
  }
});
test('D1650-T08 contradictory identity records refuse startup before recovery writes', { skip: FORMAT === 4 && 'v3 checkpoint envelope tampering; v4: V4-T03/V4-T06' }, async t => {
  for (const mode of ['duplicate-slot', 'orphan-intent', 'orphan-slot', 'wrong-intent', 'wrong-proof', 'terminal-conflict']) {
    const { f, binding } = await expiryFixture(t);
    const id = 'viewing:' + binding.attemptId;
    f.coordinator.call('compact', { force: true });
    f.service.close(); await f.service.drained(); f.coordinator.close();
    // Deliberate damaged disk input, not an accepted writer transition.
    const file = path.join(f.directory, 'seal/settlement.json'), envelope = JSON.parse(fs.readFileSync(file));
    const state = envelope.state;
    {
      if (mode === 'duplicate-slot') state.slots['viewing:4'] = { ...state.slots['viewing:3'], sequence: 4, generation: ++state.generation };
      if (mode === 'orphan-intent') delete state.slots['viewing:3'];
      if (mode === 'orphan-slot') delete state.intents[id];
      if (mode === 'wrong-intent') state.intents[id].contentSha256 = 'e'.repeat(64);
      if (mode === 'wrong-proof') state.proofs[id].count = 0;
      if (mode === 'terminal-conflict') state.terminal[id] = { phase: 'aborted', generation: state.generation, binding: state.slots['viewing:3'] };
    }
    envelope.digest = sha256(JSON.stringify(state)); fs.writeFileSync(file, JSON.stringify(envelope));
    const evidence = fs.mkdtempSync(path.join(path.dirname(f.directory), 'integrity-'));
    const disk = childPhase(evidence, 'integrity', { directory: f.directory, database: f.database.streams });
    assert.equal(disk.phase, 'failed', 'contradictory attempt state must refuse readiness');
    assert.equal(JSON.stringify(disk.after), JSON.stringify(disk.before), 'integrity refusal preserves original evidence');
  }
});
test('D1650-T08A retained sealed expiry alias loads and remains terminal', async t => {
  const { f, retention, reserved, payload } = await expiryFixture(t);
  const s = f.database.streams.viewing;
  s.rows.push({ sequence: reserved.sequence, previousHash: reserved.previousHash, hash: reserved.hash, kind: 'expiry',
    statutoryAct: null, eventId: null, payload, contentSha256: reserved.contentSha256, storedAt: '2026-10-19T00:00:00.000Z' });
  s.markers.push(reserved);
  const bundle = { eventId: null, requiredStreams: ['viewing'], bindings: [reserved] };
  assert.equal((await retention.call('confirm-bundle', bundle)).ok, true, 'expiry publication succeeds');
  f.service.close(); await f.service.drained(); f.coordinator.close();
  const restarted = await fixture(t, { directory: f.directory, model: f.database, cold: true });
  try { await restarted.service.start(); } catch { /* The observed readiness is the acceptance result. */ }
  assert.equal(restarted.service.state, 'ready', 'byte-identical terminal expiry alias remains valid');
});

// D1655 amendment: retained evidence has no patient payload, but remains linkable
// metadata. SQL deletion is a model boundary here; actual expiry/COMMIT is a PG gate.
test('D1655-T01 canonical historical proof and exact ack survive expiry and another process', async t => {
  const base = path.join(root, 'tmp/emr-b2-c-6/historical'); fs.mkdirSync(base, { recursive: true });
  for (const twoStreams of [false, true]) for (const mode of ['never-confirmed', 'lost-confirm', 'lost-ack']) {
    const dir = fs.mkdtempSync(path.join(base, `${twoStreams ? 'two' : 'view'}-${mode}-`));
    const seed = childPhase(dir, 'historical-seed', { twoStreams, neverConfirmed: mode === 'never-confirmed',
      acknowledge: mode === 'lost-ack', advance: true });
    const reopened = childPhase(dir, 'historical-reopen', { ...seed, exerciseAck: true });
    assert.notEqual(seed.pid, reopened.pid, 'historical evidence is read by a new process');
    assert.equal(reopened.phase, 'ready');
    for (const result of [...reopened.lookups.map(r => r.result?.proof), reopened.confirmation.result]) {
      assert.equal(JSON.stringify(result), JSON.stringify(seed.originalProof), 'expiry and restart preserve the exact canonical proof');
    }
    assert.equal(reopened.ack.ok, true, 'original full proof can be acknowledged after expiry');
    assert.equal(reopened.ack.result.status, mode === 'lost-ack' ? 'already-acknowledged' : 'acknowledged');
    assert.equal(reopened.retry.result.status, 'already-acknowledged', 'new request ID repeats the exact lost ack');
    assert.equal(seed.database.viewing.rows.some(r => r.eventId === seed.bundle.eventId), false, 'original viewing payload is actually absent');
    assert.equal(JSON.stringify(reopened.state.bundles).includes('SYN-1'), false, 'no patient payload in attestation');
    assert.equal(JSON.stringify(reopened.state.bundles).includes('192.0.2.1'), false, 'no access IP in attestation');
  }
});

test('D1655-T02 concurrent first publication and later coverage agree on one full proof', async t => {
  const f = await fixture(t), work = await (await f.hello()).work(), item = await f.reserve(work); item.commit();
  const results = await Promise.all(Array.from({ length: 2 }, () => work.call('confirm-bundle', item.bundle)));
  assert.equal(results.every(r => r.ok), true, 'all complete concurrent confirms succeed');
  assert.equal(new Set(results.map(r => JSON.stringify(r.result))).size, 1, 'first publication has one canonical winner');
  const original = results[0].result;
  await complete(f, work);
  assert.equal(JSON.stringify((await work.call('confirm-bundle', item.bundle)).result), JSON.stringify(original), 'later seals never rewrite a proof');
  const partial = { eventId: item.bundle.eventId, requiredStreams: ['viewing'], bindings: [item.bundle.bindings[0]] };
  const before = directoryHashes(f.directory);
  assert.equal((await work.call('confirm-bundle', partial)).error.code, 'CONFLICT', 'retained proof rejects an omitted stream');
  const changed = structuredClone(original); changed.serviceEpoch = randomUUID();
  assert.equal((await work.call('acknowledge', { proof: changed, bindings: item.bundle.bindings })).error.code, 'CONFLICT', 'ack binds the original proof epoch');
  assert.equal(JSON.stringify(directoryHashes(f.directory)), JSON.stringify(before), 'invalid proof requests are write-free');
  assert.equal((await work.call('acknowledge', { proof: original, bindings: item.bundle.bindings })).ok, true);
});

test('D1655-T03 expiry refuses before deletion when bundle publication cannot become durable', { skip: FORMAT === 4 && 'v3 WAL storage cuts; v4: V4-T04' }, async t => {
  for (const fault of ['EIO', 'ENOSPC']) {
    const f = await fixture(t), work = await (await f.hello()).work(), item = await f.reserve(work); item.commit();
    // Both stream seals complete but no aggregate proof has ever been requested.
    for (const b of item.bundle.bindings) await f.seal.advance(b.stream, { sequence: b.sequence, hash: b.hash });
    const retention = await (await f.hello('retention')).work();
    const old = fs.fdatasyncSync, inode = fs.statSync(path.join(f.directory, 'seal/settlement.jsonl')).ino;
    let injected = 0, result;
    fs.fdatasyncSync = fd => {
      if (fs.fstatSync(fd).ino === inode) { injected++; throw Object.assign(new Error('synthetic durability failure'), { code: fault }); }
      return old(fd);
    };
    try { result = await retention.call('expiry-prefix', { through: 1 }); } finally { fs.fdatasyncSync = old; }
    assert.ok(injected > 0, 'expiry must publish aggregate evidence before authorizing deletion');
    assert.equal(result.ok, false, 'failed evidence publication cannot authorize expiry');
    assert.equal(f.database.streams.viewing.rows[0].eventId, item.bundle.eventId, 'failed preparation retains source payload');
    f.service.close(); await f.service.drained(); f.coordinator.close();
    const recovered = await fixture(t, { directory: f.directory, model: f.database });
    const retry = await (await recovered.hello('retention')).work();
    assert.equal((await retry.call('expiry-prefix', { through: 1 })).ok, true, 'fresh recovery can retry the unfinished expiry');
  }
});

test('D1655-T04 unsupported formats and missing initialization provenance refuse without repair', { skip: FORMAT === 4 && 'v3 checkpoint envelope versions; v4: V4-T01/V4-T09' }, async t => {
  for (const mode of ['v1', 'v2-pruned', 'future', 'missing', 'mixed-wal']) {
    const f = await fixture(t);
    f.coordinator.call('compact', { force: true });
    f.service.close(); await f.service.drained(); f.coordinator.close();
    const file = path.join(f.directory, 'seal/settlement.json');
    if (mode === 'missing') fs.unlinkSync(file);
    else if (mode === 'mixed-wal') {
      const body = { version: 2, revision: 2, generation: 1, patch: {}, publishing: false };
      fs.writeFileSync(path.join(f.directory, 'seal/settlement.jsonl'), JSON.stringify({ ...body, digest: sha256(JSON.stringify(body)) }) + '\n');
    } else {
      const envelope = JSON.parse(fs.readFileSync(file));
      envelope.state.version = mode === 'v1' ? 1 : mode === 'v2-pruned' ? 2 : 4;
      envelope.digest = sha256(JSON.stringify(envelope.state)); fs.writeFileSync(file, JSON.stringify(envelope));
    }
    // A reader must reject format/provenance before repairing an unrelated torn journal.
    fs.mkdirSync(path.join(f.directory, 'journal'), { recursive: true });
    fs.writeFileSync(path.join(f.directory, 'journal/failure-journal.jsonl'), '{"torn":');
    const before = directoryHashes(f.directory);
    let error = null;
    try { await fixture(t, { directory: f.directory, model: f.database }); } catch (e) { error = e.code; }
    assert.equal(error, mode === 'missing' ? 'SealMissing' : 'SealUnsupportedFormat', 'unsupported lineage never becomes ready');
    assert.equal(JSON.stringify(directoryHashes(f.directory)), JSON.stringify(before), 'unsupported sources remain byte-for-byte available to capture');
  }
});

test('D1655-T05 missing references and contradictory publication refuse before recovery mutation', { skip: FORMAT === 4 && 'v3 checkpoint envelope tampering; v4: V4-T03' }, async t => {
  for (const mode of ['missing-terminal', 'wrong-bundle', 'missing-lineage', 'wrong-ack-digest']) {
    const f = await fixture(t), work = await (await f.hello()).work(), item = await complete(f, work, mode === 'wrong-ack-digest');
    f.coordinator.call('compact', { force: true });
    f.service.close(); await f.service.drained(); f.coordinator.close();
    const file = path.join(f.directory, 'seal/settlement.json'), envelope = JSON.parse(fs.readFileSync(file));
    const terminal = 'viewing:' + item.bundle.bindings[0].attemptId;
    if (mode === 'missing-terminal') delete envelope.state.terminal[terminal];
    if (mode === 'wrong-bundle') envelope.state.terminal[terminal].binding.bundleId = randomUUID();
    if (mode === 'missing-lineage') envelope.state.lineage = null;
    if (mode === 'wrong-ack-digest') Object.values(envelope.state.bundles)[0].proofSha256 = 'f'.repeat(64);
    envelope.digest = sha256(JSON.stringify(envelope.state)); fs.writeFileSync(file, JSON.stringify(envelope));
    const before = directoryHashes(f.directory);
    await assert.rejects(fixture(t, { directory: f.directory, model: f.database }), e => e.code === 'SealCorrupt', 'incomplete publication is not receipt authority');
    assert.equal(JSON.stringify(directoryHashes(f.directory)), JSON.stringify(before), 'corrupt publication preserves source bytes');
  }
});

test('D1655-T06 exact ack minimizes duplicates and preserves proof lookup and exclusion', async t => {
  const f = await fixture(t), work = await (await f.hello()).work(), item = await complete(f, work);
  const before = f.coordinator.call('read'), stored = JSON.stringify(before.bundles);
  const value = { proof: item.proof, bindings: item.bundle.bindings };
  assert.equal((await work.call('acknowledge', value)).result.status, 'acknowledged');
  const after = f.coordinator.call('read');
  assert.ok(Buffer.byteLength(JSON.stringify(after.bundles)) < Buffer.byteLength(stored), 'exact ack reduces retained duplicate metadata');
  for (const b of item.bundle.bindings) assert.equal(after.terminal[b.stream + ':' + b.attemptId].owner, undefined, 'completed delivery drops the caller identity link');
  const afterAck = directoryHashes(f.directory);
  assert.equal(JSON.stringify((await work.call('confirm-bundle', item.bundle)).result), JSON.stringify(item.proof), 'post-ack confirm preserves its full proof contract');
  assert.equal(JSON.stringify(directoryHashes(f.directory)), JSON.stringify(afterAck), 'post-ack confirm is read-only');
  assert.equal((await work.call('acknowledge', value)).result.status, 'already-acknowledged');
  for (const b of item.bundle.bindings) assertExcluded(await replayObservation(f, work, b));
  // The durable contract of an acknowledgement (D1682 item 4): the acknowledged minimal representation is what a fresh
  // admission of the files reads (checkpoint plus WAL), the full published attestation is no longer the current
  // record, and the superseded bytes leave the active WAL/checkpoint at the amortized reclamation - never by a
  // whole-checkpoint rewrite per acknowledgement.
  const inspector = (directory) => load('emr-runtime/external-writer').inspectExternal(directory, undefined, FORMAT);
  const admitted = inspector(f.directory).state;
  assert.equal(admitted.version, 3);
  assert.equal(JSON.stringify(admitted.bundles), JSON.stringify(after.bundles), 'a fresh admission of the files reads the minimized representation');
  if (FORMAT === 4) {
    // The v4 root is the acknowledged representation at once (copy-on-write): a fresh admission of the selected root
    // reads it; reclamation is pack GC, never a rewrite.
    f.coordinator.call('compact', { force: true });
    assert.equal(JSON.stringify(inspector(f.directory).state.bundles), JSON.stringify(after.bundles), 'reclamation keeps the acknowledged representation in the selected root');
  } else {
    const walBefore = fs.statSync(path.join(f.directory, 'seal/settlement.jsonl')).size;
    f.coordinator.call('compact', { force: true });
    const checkpoint = JSON.parse(fs.readFileSync(path.join(f.directory, 'seal/settlement.json')));
    assert.equal(checkpoint.state.version, 3);
    assert.equal(JSON.stringify(checkpoint.state.bundles), JSON.stringify(after.bundles), 'reclamation installs the minimized representation in the checkpoint');
    assert.equal(fs.statSync(path.join(f.directory, 'seal/settlement.jsonl')).size, 0, 'reclamation removes the superseded full representation from the active WAL');
    assert.ok(walBefore >= 0, 'the WAL before reclamation is measured, not prescribed');
  }
  assert.equal(JSON.stringify((await work.call('confirm-bundle', item.bundle)).result), JSON.stringify(item.proof), 'post-reclamation confirm preserves its full proof contract');
  assert.equal((await work.call('acknowledge', value)).result.status, 'already-acknowledged', 'post-reclamation exact ack retry is repeatable');
});

// REQ-B2C-06/07/09 -> FALSE-ROLLBACK-OR-DUPLICATE / UNRECORDED-BODY /
// PREMATURE-RETIREMENT -> C-P07/P08/P10. These are syscall failures, not simulated
// power loss: bytes that reached the OS remain readable. Linux durability is a separate gate.
async function storageFailure(directory, cut, code, operation) {
  const wal = path.join(directory, 'seal/settlement.jsonl');
  const checkpoint = path.join(directory, 'seal/settlement.json');
  const inode = fs.statSync(wal).ino;
  const originals = Object.fromEntries(['writeFileSync', 'fdatasyncSync', 'renameSync', 'openSync'].map(k => [k, fs[k]]));
  let hits = 0, walFlushes = 0;
  const fail = () => { hits++; throw Object.assign(new Error('synthetic storage interruption'), { code }); };
  const isWal = fd => typeof fd === 'number' && fs.fstatSync(fd).ino === inode;
  fs.writeFileSync = (file, data, ...args) => {
    if (isWal(file) && cut === 'wal-write') fail();
    if (isWal(file) && cut === 'wal-torn-write') {
      const bytes = Buffer.from(data);
      originals.writeFileSync(file, bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))), ...args);
      fail();
    }
    return originals.writeFileSync(file, data, ...args);
  };
  fs.fdatasyncSync = fd => {
    if (isWal(fd)) {
      walFlushes++;
      if (cut === 'wal-flush' || cut === 'compact-flush' && walFlushes === 1) fail();
      const result = originals.fdatasyncSync(fd);
      if (cut === 'wal-flushed') fail();
      return result;
    }
    return originals.fdatasyncSync(fd);
  };
  fs.renameSync = (from, to) => {
    if (to === checkpoint && cut === 'checkpoint-rename') fail();
    const result = originals.renameSync(from, to);
    if (to === checkpoint && cut === 'checkpoint-renamed') fail();
    return result;
  };
  fs.openSync = (file, flags, ...args) => {
    if (file === wal && flags === 'w' && cut === 'wal-reset') fail();
    const fd = originals.openSync(file, flags, ...args);
    if (file === wal && flags === 'w' && cut === 'wal-reset-done') { fs.closeSync(fd); fail(); }
    return fd;
  };
  let reply;
  try { reply = await operation(); }
  finally { for (const [name, original] of Object.entries(originals)) fs[name] = original; }
  return { reply, hits };
}

test('D1655-T07 aggregate proof storage failures preserve unknown outcome and exact restart recovery', { skip: FORMAT === 4 && 'v3 WAL storage cuts; v4: V4-T04' }, async t => {
  for (const twoStreams of [false, true]) for (const code of ['EIO', 'ENOSPC'])
    for (const cut of ['wal-write', 'wal-torn-write', 'wal-flush', 'wal-flushed']) {
      const f = await fixture(t), work = await (await f.hello()).work();
      const item = await f.reserve(work, event(twoStreams)); item.commit();
      // Isolate aggregate publication after every required stream already sealed.
      for (const b of item.bundle.bindings) await f.seal.advance(b.stream, { sequence: b.sequence, hash: b.hash });
      const database = JSON.stringify(f.database.streams);
      const failed = await storageFailure(f.directory, cut, code, () => work.call('confirm-bundle', item.bundle));
      assert.equal(failed.reply.ok, false, 'failed aggregate publication never returns a complete proof');
      assert.ok(failed.hits > 0, 'aggregate publication reaches the selected storage cut');
      assert.equal(failed.reply.error.outcome, 'unknown', 'a storage error cannot prove rollback');
      assert.equal(JSON.stringify(f.database.streams), database, 'publication failure preserves committed rows and markers');
      f.service.close(); await f.service.drained(); f.coordinator.close();
      const evidence = fs.mkdtempSync(path.join(path.dirname(f.directory), 'proof-failure-'));
      const next = childPhase(evidence, 'historical-reopen', { directory: f.directory,
        database: f.database.streams, bundle: item.bundle });
      assert.notEqual(next.pid, process.pid, 'recovery executes in a new process');
      assert.equal(next.phase, 'ready');
      assert.equal(next.confirmation.ok, true, 'exact committed bundle remains provable after restart');
      assert.equal(JSON.stringify(next.confirmation.result.entries.map(({ sealed, ...b }) => b)),
        JSON.stringify(item.bundle.bindings), 'recovery preserves every original binding');
      assert.equal(JSON.stringify(next.confirmation.result.requiredStreams), JSON.stringify(item.bundle.requiredStreams));
      for (const lookup of next.lookups) {
        assert.equal(lookup.result.outcome, 'committed-and-sealed');
        assert.equal(JSON.stringify(lookup.result.proof), JSON.stringify(next.confirmation.result), 'first recovered proof stays canonical');
      }
      for (const observation of next.exclusions) assertExcluded(observation);
      console.log('ATTESTATION_FAILURE ' + JSON.stringify({ twoStreams, code, cut, directory: f.directory, evidence }));
    }
});

test('D1655-T08 interrupted full-proof ack compaction preserves exact retry and permanent exclusion', { skip: FORMAT === 4 && 'v3 WAL/checkpoint cuts and reclamation; v4: V4-T04/V4-T05' }, async t => {
  // The acknowledgement's own barriers (its WAL record) and the reclamation's barriers (the amortized compaction that
  // later removes the superseded representation) are separate durable steps (D1682 item 4); each is cut in turn.
  const ackCuts = ['wal-write', 'wal-torn-write', 'wal-flush', 'wal-flushed'];
  const reclamationCuts = ['checkpoint-rename', 'checkpoint-renamed', 'wal-reset', 'wal-reset-done', 'compact-flush'];
  for (const code of ['EIO', 'ENOSPC']) for (const cut of [...ackCuts, ...reclamationCuts]) {
    const f = await fixture(t), work = await (await f.hello()).work(), item = await complete(f, work);
    const database = JSON.stringify(f.database.streams);
    if (ackCuts.includes(cut)) {
      const failed = await storageFailure(f.directory, cut, code,
        () => work.call('acknowledge', { proof: item.proof, bindings: item.bundle.bindings }));
      assert.equal(failed.reply.ok, false, 'failed ack never returns successful acknowledgement');
      assert.ok(failed.hits > 0, 'ack reaches the selected storage cut');
      assert.equal(failed.reply.error.outcome, 'unknown');
    } else {
      assert.equal((await work.call('acknowledge', { proof: item.proof, bindings: item.bundle.bindings })).result.status, 'acknowledged');
      const failed = await storageFailure(f.directory, cut, code, async () => {
        try { f.coordinator.call('compact', { force: true }); return { ok: true }; } catch (error) { return { ok: false, code: error.code }; }
      });
      assert.equal(failed.reply.ok, false, 'a failed reclamation reports failure');
      assert.ok(failed.hits > 0, 'reclamation reaches the selected storage cut');
    }
    assert.equal(JSON.stringify(f.database.streams), database, 'ack or reclamation failure preserves committed rows and markers');
    f.service.close(); await f.service.drained(); f.coordinator.close();
    const evidence = fs.mkdtempSync(path.join(path.dirname(f.directory), 'ack-failure-'));
    const next = childPhase(evidence, 'historical-reopen', { directory: f.directory,
      database: f.database.streams, bundle: item.bundle, originalProof: item.proof, exerciseAck: true });
    assert.notEqual(next.pid, process.pid, 'ack recovery executes in a new process');
    assert.equal(next.phase, 'ready');
    assert.equal(next.confirmation.ok, true);
    assert.equal(JSON.stringify(next.confirmation.result), JSON.stringify(item.proof), 'failed ack never changes the original full proof');
    assert.equal(next.ack.ok, true, 'exact full proof finishes an interrupted ack');
    assert.equal(next.ack.result.status, ['wal-write', 'wal-torn-write'].includes(cut) ? 'acknowledged' : 'already-acknowledged');
    assert.equal(next.retry.result.status, 'already-acknowledged', 'lost ack reply is safely repeatable');
    for (const observation of next.exclusions) assertExcluded(observation);
    for (const b of item.bundle.bindings) assert.equal(next.state.terminal[b.stream + ':' + b.attemptId].owner, undefined);
    // The durable contract after an interrupted ack and its exact retry: a fresh admission of the files reads the
    // acknowledged representation; its reclamation into the checkpoint is the amortized compaction, exercised here
    // explicitly (D1682 item 4: no checkpoint rewrite is prescribed per acknowledgement).
    const inspector = load('emr-runtime/external-writer').inspectExternal;
    assert.equal(inspector(f.directory).state.bundles['bundle:' + item.bundle.bindings[0].bundleId]?.phase, 'acknowledged',
      'retry leaves the acknowledged representation durable');
    const owner = new StateCoordinator(f.directory, executeExternal, { format: FORMAT });
    try {
      owner.call('compact', { force: true });
      const checkpoint = JSON.parse(fs.readFileSync(path.join(f.directory, 'seal/settlement.json')));
      assert.equal(checkpoint.state.bundles['bundle:' + item.bundle.bindings[0].bundleId]?.phase, 'acknowledged', 'reclamation installs the acknowledged checkpoint');
      assert.equal(fs.statSync(path.join(f.directory, 'seal/settlement.jsonl')).size, 0, 'reclamation finishes minimizing the active WAL');
    } finally { owner.close(); }
    console.log('ACK_FAILURE ' + JSON.stringify({ code, cut, directory: f.directory, evidence }));
  }
});

test('D1655-T09 historical evidence rejects changed identity and incomplete streams after source expiry', async t => {
  const base = path.join(root, 'tmp/emr-b2-c-11/historical-conflicts'); fs.mkdirSync(base, { recursive: true });
  for (const twoStreams of [false, true]) for (const acknowledge of [false, true]) {
    const evidence = fs.mkdtempSync(path.join(base, 'seed-'));
    const seed = childPhase(evidence, 'historical-seed', { twoStreams, acknowledge, advance: true });
    const f = await fixture(t, { directory: seed.directory, model: model(seed.database) });
    const work = await (await f.hello()).work(), before = directoryHashes(f.directory);
    assert.equal(f.database.streams.viewing.rows.some(r => r.eventId === seed.bundle.eventId), false);
    const changes = [
      b => { b.eventId = randomUUID(); for (const q of b.bindings) q.eventId = b.eventId; },
      b => { const id = randomUUID(); for (const q of b.bindings) q.bundleId = id; },
      b => { b.bindings[0].attemptId = randomUUID(); },
      b => { b.bindings[0].generation++; },
      b => { b.bindings[0].hash = 'f'.repeat(64); },
      b => { b.bindings[0].contentSha256 = 'e'.repeat(64); },
      b => { b.bindings[0].sequence++; },
    ];
    if (twoStreams) changes.push(b => { b.requiredStreams = ['viewing']; b.bindings = b.bindings.slice(0, 1); });
    for (const change of changes) {
      const changed = structuredClone(seed.bundle); change(changed);
      const confirmation = await work.call('confirm-bundle', changed);
      assert.equal(confirmation.ok, false, 'historical proof cannot authorize a changed or incomplete bundle');
      // An unknown bundle ID has no retained evidence and may be unresolved; it is never a receipt.
      assert.ok(['CONFLICT', 'UNAVAILABLE'].includes(confirmation.error.code),
        'historical conflict remains a typed nonfatal refusal: ' + confirmation.error.code);
      const lookup = await work.call('lookup-outcome', changed);
      assert.equal(lookup.ok, true);
      assert.ok(['conflict', 'unresolved'].includes(lookup.result.outcome), 'changed identity is never committed or fenced negative');
      assert.equal(JSON.stringify(directoryHashes(f.directory)), JSON.stringify(before), 'historical conflicts preserve protected bytes');
    }
    for (const field of ['serviceEpoch', 'generation', 'sealed']) {
      const changed = structuredClone(seed.originalProof);
      if (field === 'serviceEpoch') changed.serviceEpoch = randomUUID();
      else if (field === 'generation') changed.entries[0].generation++;
      else { changed.entries[0].sealed.sequence++; changed.entries[0].sealed.hash = 'f'.repeat(64); }
      // Keep the wire internally consistent so the stored-proof comparison is exercised.
      // A mismatched proof/binding pair is separately refused by protocol admission.
      if (field === 'generation') await assert.rejects(
        work.call('acknowledge', { proof: changed, bindings: seed.bundle.bindings }), { code: 'PROTOCOL' });
      const reply = await work.call('acknowledge', { proof: changed,
        bindings: changed.entries.map(({ sealed, ...binding }) => binding) });
      assert.equal(reply.ok, false, 'historical ack requires the exact original full proof');
      assert.equal(reply.error.code, 'CONFLICT');
      assert.equal(JSON.stringify(directoryHashes(f.directory)), JSON.stringify(before));
    }
    assert.equal(f.service.state, 'ready', 'ordinary historical conflicts do not stop healthy work');
    assert.equal(JSON.stringify((await work.call('confirm-bundle', seed.bundle)).result), JSON.stringify(seed.originalProof));
    assert.equal((await work.call('acknowledge', { proof: seed.originalProof, bindings: seed.bundle.bindings })).ok, true);
    for (const binding of seed.bundle.bindings) assertExcluded(await replayObservation(f, work, binding));
    console.log('HISTORICAL_CONFLICTS ' + JSON.stringify({ twoStreams, acknowledge, bundleChanges: changes.length, proofChanges: 3, evidence }));
  }
});

// D1656-T01/T04/T06: read-only format admission precedes any journal owner.
// Linux image/mount/fence and initialization-provenance acceptance remain separate.
test('D1656-T01 complete incompatible WAL and wrong pairs refuse before torn journal repair', { skip: FORMAT === 4 && 'v3 WAL record tampering; v4: V4-T04/V4-T06' }, async t => {
  for (const mode of ['mixed-wal', 'malformed-old-wal', 'invalid-old-value', 'invalid-old-tail',
    'foreign-old-binding', 'future-old-generation', 'invalid-deletion-key',
    'invalid-identity', 'wrong-pair', 'missing-lineage', 'invalid-checkpoint-tail', 'invalid-checkpoint-revision']) {
    const f = await fixture(t), work = await (await f.hello()).work();
    await complete(f, work); f.coordinator.call('compact', { force: true });
    f.service.close(); await f.service.drained(); f.coordinator.close();
    const admitted = new StateCoordinator(f.directory, executeExternal, { format: FORMAT });
    t.after(() => admitted.close());
    const file = path.join(f.directory, 'seal/settlement.json'), envelope = JSON.parse(fs.readFileSync(file));
    const journal = path.join(f.directory, 'journal'); fs.mkdirSync(journal, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(journal, 'failure-journal.jsonl'), '{"incomplete":', { mode: 0o600 });
    if (['mixed-wal', 'malformed-old-wal', 'invalid-old-value', 'invalid-old-tail',
      'foreign-old-binding', 'future-old-generation', 'invalid-deletion-key'].includes(mode)) {
      // Even a record covered by a checkpoint must have the supported complete schema.
      const body = { version: 3, revision: 1, generation: 1, patch: {}, publishing: false };
      if (mode === 'mixed-wal') body.version = 2;
      if (mode === 'malformed-old-wal') body.unexpected = true;
      if (mode === 'invalid-old-value') body.patch = { retired: { viewing: 'corrupt' } };
      if (mode === 'invalid-old-tail') { body.publishing = true; body.tail = { streams: {} }; }
      if (mode === 'foreign-old-binding') {
        const [id, terminal] = Object.entries(envelope.state.terminal)[0];
        const foreign = structuredClone(terminal); foreign.binding.chainId = randomUUID();
        body.generation = envelope.state.generation; body.patch = { terminal: { [id]: foreign } };
      }
      if (mode === 'future-old-generation') body.generation = envelope.state.generation + 1;
      if (mode === 'invalid-deletion-key') body.patch = { retired: { unsupported: null } };
      fs.writeFileSync(path.join(f.directory, 'seal/settlement.jsonl'), JSON.stringify({ ...body, digest: sha256(JSON.stringify(body)) }) + '\n');
    }
    if (mode === 'invalid-identity') Object.values(envelope.state.terminal)[0].binding.chainId = randomUUID();
    if (mode === 'missing-lineage') envelope.state.lineage = null;
    if (mode === 'invalid-checkpoint-tail') envelope.state.tail.streams.viewing.hash = 'corrupt';
    if (mode === 'invalid-checkpoint-revision') envelope.state.revision = 0;
    // A pending tail publication must not cause a write ahead of complete WAL validation.
    envelope.publishing = true; envelope.digest = sha256(JSON.stringify(envelope.state));
    fs.writeFileSync(file, JSON.stringify(envelope));
    const before = directoryHashes(f.directory);
    let error;
    try {
      const inspector = load('emr-runtime/external-writer').inspectExternal;
      inspector(f.directory, mode === 'wrong-pair' ? { ...f.pair, instanceId: 'other-copy' } : f.pair);
      new FailureJournal(f.directory, new StateCoordinator(f.directory, executeExternal, { format: FORMAT }));
    } catch (e) { error = e.code; }
    assert.ok(error, 'incompatible pair must refuse before an owner operation');
    assert.equal(JSON.stringify(directoryHashes(f.directory)), JSON.stringify(before), 'admission must preserve all protected bytes and entries');
    assert.throws(() => mode === 'wrong-pair' ? admitted.call('admit-pair', { ...f.pair, instanceId: 'other-copy' }) :
      admitted.call('journal-load'), 'an existing owner must revalidate before journal access');
    assert.equal(JSON.stringify(directoryHashes(f.directory)), JSON.stringify(before), 'existing-owner refusal must precede journal repair');
  }
});

test('D1656-T07 a v3 private copy paired with another physical database is admitted only under the launch-scoped source-to-target mapping; origin lineage, proofs and exclusions survive and the source is never written', async t => {
  const f = await fixture(t), work = await (await f.hello()).work();
  const original = await complete(f, work, true), pending = await f.reserve(work, event(false));
  f.service.close(); await f.service.drained(); f.coordinator.close();
  const before = directoryHashes(f.directory), copy = f.directory + '-private';
  fs.cpSync(f.directory, copy, { recursive: true, errorOnExist: true });
  const restored = () => model(structuredClone(f.database.streams));
  const target = { instanceId: 'private-copy', database: { database: 'restored', oid: 20002, address: '10.0.0.2', port: 5433 } };
  const targetPair = { ...target, chains: f.pair.chains }, mapping = { source: f.pair, target: targetPair };
  const copyBytes = directoryHashes(copy);
  // Without the mapping the copy is a wrong pair; a mapping whose source is not the stored origin, or whose target is
  // not the observed database, is refused as well - all before any recovery write.
  for (const [label, options] of [
    ['no mapping', { pair: target }],
    ['wrong source', { pair: target, copy: { source: { ...f.pair, instanceId: 'other-origin' }, target: targetPair } }],
    ['wrong target', { pair: { ...target, database: { ...target.database, oid: 30003 } }, copy: mapping }],
    ['original pair with a mapping', { copy: mapping }],
  ]) {
    await assert.rejects(fixture(t, { directory: copy, model: restored(), ...options }), error => error.code === 'SealChainMismatch', label);
    assert.equal(JSON.stringify(directoryHashes(copy)), JSON.stringify(copyBytes), label + ': refusal writes nothing');
  }
  assert.throws(() => load('emr-runtime/external-writer').parseCopyMapping({ source: f.pair, target: f.pair }), { code: 'SealChainMismatch' });
  // The correct mapping: ready, the service reports the target pair, the original proof and exclusions stand.
  const g = await fixture(t, { directory: copy, model: restored(), pair: target, copy: mapping });
  assert.equal(g.service.state, 'ready');
  const peer = await g.hello(), gw = await peer.work();
  assert.deepEqual([peer.reply.result.instanceId, peer.reply.result.database], [target.instanceId, target.database], 'clients observe the target pair');
  assert.equal(g.coordinator.call('read').lineage.origin.instanceId, f.pair.instanceId, 'origin lineage is not rewritten');
  const outcome = await gw.call('lookup-outcome', original.bundle);
  assert.equal(outcome.result.outcome, 'committed-and-sealed');
  assert.equal(JSON.stringify(outcome.result.proof), JSON.stringify(original.proof), 'the original canonical proof survives the copy');
  for (const b of original.bundle.bindings) assertExcluded(await replayObservation(g, gw, b));
  assert.equal((await gw.call('lookup-outcome', pending.bundle)).result.outcome, 'fenced-not-committed', 'the copy settled the pending attempt under its own fence');
  await complete(g, gw, true);
  // A client cannot supply a mapping over the wire, and the source directory was never touched.
  const forged = { v: 1, requestId: randomUUID(), serviceEpoch: null, session: null, workId: null, operation: 'hello',
    value: { protocol: 1, clientInstanceId: randomUUID(), copy: mapping } };
  await assert.rejects(g.service.dispatch('api', forged, new net.Socket()), { code: 'PROTOCOL' });
  assert.equal(JSON.stringify(directoryHashes(f.directory)), JSON.stringify(before), 'source bytes unchanged');
  // A restart of the copy needs the same mapping again: it is launch-scoped, never persisted.
  g.service.close(); await g.service.drained(); g.coordinator.close();
  await assert.rejects(fixture(t, { directory: copy, model: g.database, pair: target }), error => error.code === 'SealChainMismatch');
  const h = await fixture(t, { directory: copy, model: g.database, pair: target, copy: mapping });
  assert.equal(h.service.state, 'ready');
});

test('D1656-T04 a changed physical root cannot reuse a prior coordinator admission', async t => {
  const f = await fixture(t); f.coordinator.call('compact', { force: true });
  f.service.close(); await f.service.drained(); f.coordinator.close();
  const coordinator = new StateCoordinator(f.directory, executeExternal, { format: FORMAT });
  t.after(() => coordinator.close());
  const moved = f.directory + '-preserved'; fs.renameSync(f.directory, moved);
  t.after(() => fs.rmSync(moved, { recursive: true, force: true }));
  fs.cpSync(moved, f.directory, { recursive: true });
  const before = directoryHashes(f.directory), original = directoryHashes(moved);
  assert.throws(() => coordinator.call('read'), { code: 'SealUnavailable' }, 'replacement root must invalidate admission');
  assert.equal(JSON.stringify(directoryHashes(f.directory)), JSON.stringify(before));
  assert.equal(JSON.stringify(directoryHashes(moved)), JSON.stringify(original));
});

test('D1684-T01 a compact whole-state v3 checkpoint with history is admitted, read identically and compacted navigably', { skip: FORMAT === 4 && 'v3 compact layout admission' }, async t => {
  // The same v3 envelope written as one JSON.stringify (what initialization, older writers and inspectors produce):
  // the line-separated navigable layout is only whitespace, so an owner must admit the compact layout with its terminals
  // and bundles, serve the same proofs and exclusions, and write the navigable layout at its next compaction.
  const f = await fixture(t), work = await (await f.hello()).work();
  const acked = await complete(f, work, true), published = await complete(f, work), pending = await f.reserve(work);
  f.coordinator.call('compact', { force: true });
  const before = f.coordinator.call('read');
  f.service.close(); await f.service.drained(); f.coordinator.close();
  const file = path.join(f.directory, 'seal/settlement.json'), envelope = JSON.parse(fs.readFileSync(file));
  assert.ok(fs.readFileSync(file, 'utf8').includes('\n'), 'the compaction wrote the navigable layout');
  fs.writeFileSync(file, JSON.stringify(envelope));
  assert.equal(fs.readFileSync(file, 'utf8').includes('\n'), false, 'the compact layout under test has no member lines');
  const inspector = load('emr-runtime/external-writer').inspectExternal;
  assert.equal(JSON.stringify(inspector(f.directory).state), JSON.stringify(before), 'the compact layout reads identically');
  const g = await fixture(t, { directory: f.directory, model: f.database });
  assert.equal(g.service.state, 'ready', 'the compact layout is admitted');
  const gw = await (await g.hello()).work();
  assert.equal(JSON.stringify((await gw.call('confirm-bundle', acked.bundle)).result), JSON.stringify(acked.proof), 'acknowledged proof lookup over the compact layout');
  assert.equal((await gw.call('acknowledge', { proof: acked.proof, bindings: acked.bundle.bindings })).result.status, 'already-acknowledged');
  assert.equal(JSON.stringify((await gw.call('confirm-bundle', published.bundle)).result), JSON.stringify(published.proof), 'published proof lookup over the compact layout');
  for (const b of [...acked.bundle.bindings, ...published.bundle.bindings]) assertExcluded(await replayObservation(g, gw, b));
  // The never-committed reservation was settled negative by the restart's recovery (its intent had no marker): the
  // compact layout carried the pending identity into that settlement, which now excludes the attempt.
  for (const b of pending.bundle.bindings) assertExcluded(await replayObservation(g, gw, b));
  assert.equal(g.coordinator.call('get', { map: 'terminal', id: pending.bundle.bindings[0].stream + ':' + pending.bundle.bindings[0].attemptId })?.phase, 'aborted');
  const current = g.coordinator.call('read');
  g.coordinator.call('compact', { force: true });
  assert.ok(fs.readFileSync(file, 'utf8').includes('\n'), 'the next compaction writes the navigable layout again');
  assert.equal(JSON.stringify(g.coordinator.call('read')), JSON.stringify(current), 'the rewritten checkpoint holds the same history');
  assert.equal(JSON.stringify(inspector(f.directory).state), JSON.stringify(current), 'a fresh admission of the navigable rewrite reads the same history');
});

// ───────────── KIN-EMR-STATE-V4 cells (D1693; EMR_STATE_FORMAT=4) ─────────────
const v4Only = { skip: FORMAT !== 4 && 'v4 cell (EMR_STATE_FORMAT=4)' };
/** Start an owner whose outcome the case judges through its state (a refused start is an observation, not a harness error). */
const startObserved = async service => { try { await service.start(); } catch { /* judged through service.state */ } };
/** The next incarnation over a directory: a refused admission (the coordinator's own read-only admission) is the case's
 * observation `label` (never a harness error). */
async function reopened(t, label, options) {
  try { return await fixture(t, options); }
  catch (error) { assert.fail(label + ' (admission refused: ' + String(error && (error.code || error.message)) + ')'); }
}
function countingModel(initial) {
  // The memory SQL model with every row read recorded: what a restart actually consulted.
  const m = model(initial), reads = [];
  const entriesAfter = m.sql.entriesAfter;
  m.sql.entriesAfter = async (s, n, limit) => { reads.push({ stream: s, after: n, limit }); return entriesAfter(s, n, limit); };
  m.sql.verificationPage = async (s, n, count) => ({ tail: await m.sql.tail(s), first: (await m.sql.entriesAfter(s, 0, 1))[0] ?? null,
    entries: await Promise.all((await m.sql.entriesAfter(s, n, count)).map(async entry => ({ entry, marker: await m.sql.markerForSlot(s, entry.sequence) }))) });
  return { ...m, reads };
}
test('V4-T06 the v4 owner restarts from its DB witness: only the suffix after the verified anchor and the pending work are consulted', v4Only, async t => {
  const f = await fixture(t), work = await (await f.hello()).work();
  const done = [];
  for (let i = 0; i < 6; i++) done.push(await complete(f, work, i % 2 === 0));
  const pending = await f.reserve(work);          // reserved, never committed: pending work for the restart
  const before = f.coordinator.call('v4-status');
  assert.equal(before.format, 4);
  const witness = f.coordinator.call('view').dbWitness;
  assert.equal(witness.streams.viewing.verifiedThrough.sequence, 6, 'the witness names the verified sealed prefix');
  assert.equal(witness.streams.history.verifiedThrough.sequence, 6);
  assert.deepEqual(witness.streams.viewing.retainedStart, { sequence: 1, previousHash: '0'.repeat(64) });
  assert.equal(before.trees.find(x => x.id === 8).count, '12', 'one verified DB binding per committed slot (both streams)');
  assert.equal(before.pending, 2, 'the uncommitted reservation is pending work in both streams');
  const snapshot = stateObservation(f);
  f.service.close(); await f.service.drained(); f.coordinator.close();
  // The reservation's transaction committed while the owner was down (its reply was lost): the restart finds the
  // suffix after the witness and the markers of the pending attempt, never a row behind the verified anchor.
  pending.commit();
  const counting = countingModel(structuredClone(f.database.streams));
  const g = await fixture(t, { directory: f.directory, model: counting, cold: true });
  await startObserved(g.service);
  assert.equal(g.service.state, 'ready', 'the restart over the pending work is ready');
  for (const read of counting.reads) assert.ok((read.after === 0 && read.limit === 1) || read.after >= 6, 'restart read ' + JSON.stringify(read));
  assert.ok(counting.reads.some(r => r.after >= 6), 'the suffix after the verified anchor is consulted');
  const after = g.coordinator.call('v4-status');
  assert.equal(after.pending, 0, 'the restart settled the pending work');
  for (const b of pending.bundle.bindings) assert.equal(g.coordinator.call('get', { map: 'terminal', id: b.stream + ':' + b.attemptId })?.phase, 'committed');
  assert.equal(after.trees.find(x => x.id === 5).count, String(snapshot.terminals + 2), 'historical terminals are untouched; the recovered attempt added its two');
  assert.equal(g.coordinator.call('view').dbWitness.streams.viewing.verifiedThrough.sequence, 7, 'the witness advanced over the recovered suffix');
  assert.equal(after.trees.find(x => x.id === 8).count, '14', 'the recovered rows have their DB bindings');
  const gw = await (await g.hello()).work();
  for (const item of done) assert.equal(JSON.stringify((await gw.call('confirm-bundle', item.bundle)).result), JSON.stringify(item.proof), 'historical proofs after the fast restart');
  assert.equal((await gw.call('confirm-bundle', pending.bundle)).ok, true, 'the recovered attempt is provable');
  for (const b of done[0].bundle.bindings) assertExcluded(await replayObservation(g, gw, b));
  await complete(g, gw);
  assert.equal(g.coordinator.call('view').dbWitness.streams.viewing.verifiedThrough.sequence, 8, 'the witness advances with the next publication');
  // A contradictory record (a terminal settled for an attempt whose intent and slot are still live) is refused by the
  // touched-closure validation before any page, root or WAL byte: the selected root is unchanged.
  const live = await g.reserve(gw), liveBinding = live.bundle.bindings[0], liveKey = liveBinding.stream + ':' + liveBinding.attemptId;
  const template = g.coordinator.call('get', { map: 'terminal', id: done[0].bundle.bindings[0].stream + ':' + done[0].bundle.bindings[0].attemptId });
  const rootBefore = g.coordinator.call('v4-status');
  let contradiction = null;
  try { g.coordinator.call('patch', { changes: { terminal: { [liveKey]: { ...template, binding: liveBinding, generation: liveBinding.generation } } }, kind: 'update' }); }
  catch (error) { contradiction = error; }
  assert.ok(contradiction && contradiction.code === 'UnsealedEntryUnexplained', 'a validly checksummed contradictory record cannot publish: ' + String(contradiction && contradiction.code));
  const rootAfter = g.coordinator.call('v4-status');
  assert.deepEqual({ root: rootAfter.rootSha256, revision: rootAfter.revision }, { root: rootBefore.rootSha256, revision: rootBefore.revision }, 'the refusal published nothing');
  live.commit(); assert.equal((await gw.call('confirm-bundle', live.bundle)).ok, true, 'the live attempt completes normally after the refused contradiction');
  // A restart with nothing to recover reads nothing beyond the bounded first-row anchor probe.
  g.service.close(); await g.service.drained(); g.coordinator.close();
  const idle = countingModel(structuredClone(g.database.streams));
  const h = await fixture(t, { directory: f.directory, model: idle, cold: true });
  await startObserved(h.service); assert.equal(h.service.state, 'ready', 'the idle restart is ready');
  assert.ok(idle.reads.every(r => r.after === 0 && r.limit === 1), 'an idle restart consults no history: ' + JSON.stringify(idle.reads));
});
test('V4-T07 a witness that no longer describes the database refuses before any settlement; a changed retained anchor is revalidated', v4Only, async t => {
  const f = await fixture(t), work = await (await f.hello()).work();
  for (let i = 0; i < 3; i++) await complete(f, work, true);
  f.service.close(); await f.service.drained(); f.coordinator.close();
  const before = directoryHashes(f.directory);
  const attempt = async (mutate, expected, label) => {
    const streams = structuredClone(f.database.streams); mutate(streams);
    const g = await fixture(t, { directory: f.directory, model: model(streams), cold: true });
    let error = null;
    try { await g.service.start(); } catch (failure) { error = failure; }
    assert.equal(g.service.state, 'failed', label + ': refused readiness');
    assert.equal(error?.code, expected, label + ': ' + String(error?.message));
    assert.equal(JSON.stringify(directoryHashes(f.directory)), JSON.stringify(before), label + ': refusal wrote nothing');
  };
  await attempt(s => { s.viewing.chainId = randomUUID(); }, 'SealChainMismatch', 'another chain behind the same pair');
  await attempt(s => { s.viewing.rows.pop(); s.viewing.markers.pop(); }, 'LedgerBehindSeal', 'the database behind the sealed frontier');
  await attempt(s => { s.viewing.rows[0].previousHash = 'f'.repeat(64); }, 'LedgerChainBroken', 'a changed retained anchor is fully revalidated, not trusted');
  await attempt(s => { s.viewing.rows[2].hash = 'e'.repeat(64); }, 'LedgerChainBroken', 'a changed sealed tail row breaks the chain the witness vouches for');
});

/** One owned syscall failure at a v4 publication barrier (order section 3, V4-T04): page write/flush, root fsync/
 * rename, WAL prepare/complete append and flush, tail publication, selector write/rename. Bytes that reached the OS
 * stay readable; this is a syscall failure, not power loss. */
async function v4StorageFailure(directory, cut, code, operation) {
  const originals = Object.fromEntries(['openSync', 'writeSync', 'writeFileSync', 'fdatasyncSync', 'fsyncSync', 'renameSync'].map(k => [k, fs[k]]));
  const files = new Map();
  let hits = 0, walWrites = 0;
  const fail = () => { hits++; throw Object.assign(new Error('synthetic storage interruption'), { code }); };
  const kind = file => {
    if (typeof file !== 'string') return null;
    const f = file.replace(/\\/g, '/');
    if (/\/seal\/v4\/pages\/[0-9a-f]{32}\.pages$/.test(f)) return 'pack';
    if (/\/seal\/v4\/roots\/\.tmp-/.test(f)) return 'root';
    if (/\/seal\/v4\/wal\/[0-9a-f]{32}\.jsonl$/.test(f)) return 'wal';
    if (/\/seal\/tail\.json$/.test(f)) return 'tail';
    if (/\/seal\/\.tmp-/.test(f)) return 'selector';
    return null;
  };
  // Descriptors the owner opened before this cut (the current WAL segment, the open pack, the tail) are known by inode.
  const inodes = new Map();
  for (const [dir, k] of [['seal/v4/pages', 'pack'], ['seal/v4/wal', 'wal']]) {
    const full = path.join(directory, dir);
    if (fs.existsSync(full)) for (const name of fs.readdirSync(full)) inodes.set(fs.statSync(path.join(full, name)).ino, k);
  }
  if (fs.existsSync(path.join(directory, 'seal/tail.json'))) inodes.set(fs.statSync(path.join(directory, 'seal/tail.json')).ino, 'tail');
  const kindOf = fd => {
    if (typeof fd !== 'number') return kind(fd);
    if (files.has(fd)) return files.get(fd);
    try { return inodes.get(fs.fstatSync(fd).ino) ?? null; } catch { return null; }
  };
  fs.openSync = (file, flags, ...args) => { const fd = originals.openSync(file, flags, ...args); files.set(fd, kind(file)); return fd; };
  fs.writeSync = (fd, buffer, ...args) => {
    const k = kindOf(fd);
    if (k === 'pack' && cut === 'page-write') fail();
    if (k === 'pack' && cut === 'page-short-write') { originals.writeSync(fd, buffer, args[0] ?? 0, Math.floor((args[1] ?? buffer.length) / 2), args[2]); fail(); }
    if (k === 'wal') { walWrites++; if (cut === 'prepare-append' && walWrites === 1) fail(); if (cut === 'complete-append' && walWrites === 2) fail();
      if (cut === 'prepare-torn' && walWrites === 1) { originals.writeSync(fd, buffer, args[0] ?? 0, Math.floor((args[1] ?? buffer.length) / 2), args[2]); fail(); } }
    return originals.writeSync(fd, buffer, ...args);
  };
  fs.writeFileSync = (file, data, ...args) => {
    const k = kindOf(file);
    if (k === 'root' && cut === 'root-write') fail();
    if (k === 'selector' && cut === 'selector-write') fail();
    if (k === 'tail' && cut === 'tail-write') fail();
    return originals.writeFileSync(file, data, ...args);
  };
  fs.fdatasyncSync = fd => {
    const k = kindOf(fd);
    if (k === 'pack' && cut === 'page-flush') fail();
    if (k === 'wal' && cut === 'prepare-flush' && walWrites === 1) fail();
    if (k === 'wal' && cut === 'complete-flush' && walWrites === 2) fail();
    if (k === 'tail' && cut === 'tail-flush') fail();
    return originals.fdatasyncSync(fd);
  };
  fs.fsyncSync = fd => {
    const k = kindOf(fd);
    if (k === 'root' && cut === 'root-fsync') fail();
    if (k === 'selector' && cut === 'selector-fsync') fail();
    return originals.fsyncSync(fd);
  };
  fs.renameSync = (from, to) => {
    const k = kind(from);
    if (k === 'root' && cut === 'root-rename') fail();
    if (k === 'selector' && cut === 'selector-rename') fail();
    const result = originals.renameSync(from, to);
    if (k === 'selector' && cut === 'selector-renamed') fail();
    return result;
  };
  let reply;
  try { reply = await operation(); }
  finally { for (const [name, original] of Object.entries(originals)) fs[name] = original; }
  return { reply, hits };
}
const V4_CUTS = ['page-write', 'page-short-write', 'page-flush', 'root-write', 'root-fsync', 'root-rename', 'prepare-append', 'prepare-torn', 'prepare-flush',
  'tail-write', 'tail-flush', 'complete-append', 'complete-flush', 'selector-write', 'selector-fsync', 'selector-rename', 'selector-renamed'];
test('V4-T04 a syscall failure at every v4 publication barrier gives no success; the restart preserves or recovers the transition exactly', v4Only, async t => {
  for (const code of ['EIO', 'ENOSPC']) for (const cut of V4_CUTS) {
    const f = await fixture(t), work = await (await f.hello()).work();
    const earlier = await complete(f, work, true);
    const item = await f.reserve(work); item.commit();
    // The confirm publishes the sealed frontier (pages, root, prepare, tail, complete, selector) and then the attestation.
    const database = JSON.stringify(f.database.streams), beforeStatus = f.coordinator.call('v4-status');
    const failed = await v4StorageFailure(f.directory, cut, code, () => work.call('confirm-bundle', item.bundle));
    assert.ok(failed.hits > 0, cut + ': the publication reaches the barrier');
    assert.equal(failed.reply.ok, false, cut + ': no success before every durable barrier and the selector');
    assert.equal(failed.reply.error.outcome, 'unknown', cut + ': a storage error cannot prove rollback');
    assert.equal(JSON.stringify(f.database.streams), database, cut + ': committed rows and markers are preserved');
    // The failed owner view is retired; the files are the authority for the next incarnation.
    f.service.close(); await f.service.drained(); f.coordinator.close();
    const g = await reopened(t, cut + ': the restart recovers', { directory: f.directory, model: model(structuredClone(f.database.streams)), cold: true });
    await startObserved(g.service);
    assert.equal(g.service.state, 'ready', cut + ': the restart recovers');
    const status = g.coordinator.call('v4-status');
    assert.ok(Number(status.revision) >= Number(beforeStatus.revision), cut + ': the accepted root is never older');
    const gw = await (await g.hello()).work();
    assert.equal(JSON.stringify((await gw.call('confirm-bundle', earlier.bundle)).result), JSON.stringify(earlier.proof), cut + ': earlier acknowledged proof survives');
    const confirmed = await gw.call('confirm-bundle', item.bundle);
    assert.equal(confirmed.ok, true, cut + ': the interrupted bundle is provable after recovery');
    assert.equal(confirmed.result.eventId, item.bundle.eventId);
    for (const b of item.bundle.bindings) assertExcluded(await replayObservation(g, gw, b));
    assert.equal((await gw.call('acknowledge', { proof: confirmed.result, bindings: item.bundle.bindings })).ok, true, cut + ': exact ack after recovery');
    if (cut === 'prepare-torn') assert.ok(fs.existsSync(path.join(f.directory, 'seal/v4/quarantine')) && fs.readdirSync(path.join(f.directory, 'seal/v4/quarantine')).length > 0, 'the torn prefix is quarantined as exact evidence');
    // A second incarnation over the recovered files is idempotent.
    const recovered = g.coordinator.call('v4-status').revision;
    g.service.close(); await g.service.drained(); g.coordinator.close();
    const h = await fixture(t, { directory: f.directory, model: model(structuredClone(g.database.streams)), cold: true });
    await h.service.start(); assert.equal(h.service.state, 'ready', cut + ': second restart');
    assert.equal(h.coordinator.call('v4-status').revision, recovered);
  }
});
test('V4-T05 pack reclamation unlinks only packs unreachable from the selected root; retired segments and roots leave at rotation; every proof and exclusion survives', v4Only, async t => {
  const f = await fixture(t), work = await (await f.hello()).work(), done = [];
  for (let i = 0; i < 64; i++) done.push(await complete(f, work, i % 3 === 0));
  const before = f.coordinator.call('v4-status');
  t.diagnostic('after 64 completes under an open scope: ' + JSON.stringify({ packs: before.packs, accounting: before.accounting, fragmentation: before.fragmentation, revision: before.revision }));
  assert.ok(before.packs >= 1);
  // Ordinary operation reclaims as it goes (the maintained accounting, bounded slices): the pack population stays
  // near the live pages, never one pack per transition, and nothing dead waits for an operator.
  assert.equal(before.accounting.known, true, 'the liveness accounting is maintained by the owner');
  assert.equal(before.accounting.dead, 0, 'dead packs are reclaimed in the transitions that killed them');
  assert.ok(before.packs <= 20, 'packs are appended across transitions (never one per transition) and reclaimed when dead: ' + before.packs);
  // Sustained load with the scope open all along (no idle tick ever ran here): relocation runs in the transitions
  // themselves, so the pack population stays within its bound instead of growing until the load stops.
  assert.equal(before.fragmentation.due, false, 'relocation runs in the transitions themselves: ' + JSON.stringify({ packs: before.packs, fragmentation: before.fragmentation }));
  assert.ok(before.packs <= 2 * before.fragmentation.needed + 2, 'the pack population is bounded under sustained load: ' + JSON.stringify({ packs: before.packs, fragmentation: before.fragmentation }));
  const stateBefore = f.coordinator.call('read');
  const reclaimed = f.coordinator.call('compact', { force: true });
  const after = f.coordinator.call('v4-status');
  assert.ok(after.packs <= before.packs, 'reclamation never adds packs');
  assert.ok(after.packs <= 2 * after.fragmentation.needed + 2, 'relocation of the live pages out of nearly empty packs bounds the pack population: ' + JSON.stringify({ packs: after.packs, fragmentation: after.fragmentation }));
  assert.equal(after.fragmentation.due, false);
  assert.ok(Number(after.revision) >= Number(before.revision), 'relocation is a logical no-change transition of the owner');
  // The owner reads through the published root after the relocation (the superseded root's packs are gone).
  let stateAfter = null, readRefusal = null;
  try { stateAfter = f.coordinator.call('read'); } catch (error) { readRefusal = error; }
  assert.equal(readRefusal, null, 'relocation changes no member (the read after the forced compaction was refused: ' + String(readRefusal && (readRefusal.detail || readRefusal.message)) + ')');
  assert.equal(JSON.stringify(stateAfter.terminal), JSON.stringify(stateBefore.terminal), 'relocation changes no member');
  assert.equal(reclaimed.accounting, 'known', 'a forced reclamation proves reachability by traversal and rebuilds the accounting');
  for (const item of done) assert.equal(JSON.stringify((await work.call('confirm-bundle', item.bundle)).result), JSON.stringify(item.proof), 'proofs after reclamation');
  for (const b of done[5].bundle.bindings) assertExcluded(await replayObservation(f, work, b));
  f.service.close(); await f.service.drained(); f.coordinator.close();
  // The open segment is old enough to rotate at the next transition: the next owner retires it and the roots it
  // absorbed after it published the new start record and selector; the selected root alone remains.
  const segmentFile = path.join(f.directory, 'seal/v4/wal', before.wal.segment + '.jsonl'), past = new Date(Date.now() - 120_000);
  fs.utimesSync(segmentFile, past, past);
  const rootsDirectory = path.join(f.directory, 'seal/v4/roots'), absorbed = fs.readdirSync(rootsDirectory);
  assert.ok(absorbed.length > 100, 'one immutable root per transition is on disk before the rotation: ' + absorbed.length);
  const g = await reopened(t, 'restart after reclamation', { directory: f.directory, model: model(structuredClone(f.database.streams)), cold: true });
  await startObserved(g.service); assert.equal(g.service.state, 'ready', 'restart after reclamation');
  // RC-03 (S1-PRE-01/B2-S2-08): no accounting outlives an incarnation. The next one starts with it unknown (no scratch
  // file is deletion authority) and rebuilds it in bounded slices from the verified closure of a pinned root plus the
  // deltas since; nothing is unlinked before the rebuild completes.
  assert.equal(g.coordinator.call('v4-status').accounting.known, false, 'a new incarnation starts with the accounting unknown: no scratch file is deletion authority');
  assert.ok(before.descriptors <= 64 && g.coordinator.call('v4-status').descriptors <= 64, 'open pack descriptors stay within the store budget');
  const gw = await (await g.hello()).work();
  for (const item of done) assert.equal(JSON.stringify((await gw.call('confirm-bundle', item.bundle)).result), JSON.stringify(item.proof));
  await complete(g, gw);
  const rotated = g.coordinator.call('v4-status');
  assert.notEqual(rotated.wal.segment, before.wal.segment, 'the aged segment rotated');
  assert.equal(fs.existsSync(segmentFile), false, 'the retired segment is unlinked after the selector names its successor');
  const remaining = fs.readdirSync(rootsDirectory);
  assert.ok(remaining.includes(rotated.rootSha256 + '.json'), 'the selected root remains');
  assert.ok(absorbed.every(name => !remaining.includes(name)), 'every root the retired segment absorbed is gone');
  assert.ok(remaining.length <= 2 + rotated.wal.transitions, 'only the open segment\'s roots (and a pinned rebuild root) remain: ' + remaining.length);
  for (const item of done) assert.equal(JSON.stringify((await gw.call('confirm-bundle', item.bundle)).result), JSON.stringify(item.proof), 'proofs after rotation');
  for (const b of done[5].bundle.bindings) assertExcluded(await replayObservation(g, gw, b));
  const rebuilt = await rebuildLiveness(g);
  assert.equal(rebuilt.accounting.known, true, 'the accounting is rebuilt from the verified closure of a pinned root');
  assert.equal(rebuilt.accounting.dead, 0, 'packs the rebuilt accounting proves dead are reclaimed in the next slice');
  assert.ok(rebuilt.packs <= 2 * rebuilt.fragmentation.needed + 2, 'the rebuilt accounting keeps the population bound: ' + JSON.stringify({ packs: rebuilt.packs, fragmentation: rebuilt.fragmentation }));
  // A scratch file of an earlier incarnation naming the selected root with a reachable pack at zero (a crash left it
  // stale): never deletion authority - every proof is served through the pack, nothing is latched.
  await closeOwner(g);
  const selected = V4.readSelector(path.join(f.directory, 'seal/settlement.json')).body.rootSha256, reachablePack = v4LeafBelowRoot(f.directory, 5).ref.pack;
  fs.writeFileSync(path.join(f.directory, 'seal/v4/tmp/packs.json'), JSON.stringify({ root: selected, live: [[reachablePack, 0]], sweep: null }));
  const h = await reopen(t, g), hw = await (await h.hello()).work();
  // An adopted scratch would unlink the pack in the startup reclamation already: the first reads through it, then the
  // transitions after it, then the reads again.
  for (const item of done) { const reply = await hw.call('confirm-bundle', item.bundle); assert.equal(reply.ok && JSON.stringify(reply.result) === JSON.stringify(item.proof), true, 'proofs after a stale scratch named a reachable pack at zero: ' + JSON.stringify(reply.error ?? null)); }
  for (let i = 0; i < 6; i++) await complete(h, hw);
  for (const item of done) assert.equal(JSON.stringify((await hw.call('confirm-bundle', item.bundle)).result), JSON.stringify(item.proof), 'proofs after a stale scratch named a reachable pack at zero');
  assert.equal(fs.existsSync(latchFile(f.directory)), false, 'a stale scratch unlinks no reachable pack (nothing is latched)');
  assert.equal((await rebuildLiveness(h)).accounting.known, true);
  // (S1-PRE-15) Damage on a page the accounting proves dead is skipped by a relocation (healthy control); damage on a
  // live page of a candidate pack is discovered by the relocation itself and latches the owner at the discovery: no
  // deletion, no compact transition published after it. Repaired, the same proofs are served again.
  const dead = v4RelocationPages(f.directory).dead;
  flipPageByte(f.directory, dead);
  const beforeDead = h.coordinator.call('v4-status');
  h.coordinator.call('compact', { force: true });
  assert.equal(fs.existsSync(latchFile(f.directory)), false, 'a damaged page the accounting proves dead is not a discovery');
  for (const item of done) assert.equal(JSON.stringify((await hw.call('confirm-bundle', item.bundle)).result), JSON.stringify(item.proof), 'proofs after relocating around a dead damaged page');
  assert.ok(h.coordinator.call('v4-status').packs <= beforeDead.packs, 'the forced compaction reclaimed as usual');
  const live = v4RelocationPages(f.directory, false).live;   // after the forced compaction every remaining page is live
  flipPageByte(f.directory, live);
  const beforeLive = h.coordinator.call('v4-status');
  let relocation = null;
  try { h.coordinator.call('compact', { force: true }); } catch (error) { relocation = error; }
  assert.ok(relocation && relocation.code === 'SealCorrupt' && String(relocation.detail).startsWith('latched:relocate:'), 'a relocation that meets damage on a current route refuses and latches: ' + String(relocation && (relocation.detail || relocation.message)));
  const relocationLatch = JSON.parse(fs.readFileSync(latchFile(f.directory), 'utf8'));
  assert.deepEqual({ phase: relocationLatch.phase, root: relocationLatch.root }, { phase: 'relocate', root: beforeLive.rootSha256 }, 'no transition is published after a relocation discovers damage (the latch names the root the compaction started from)');
  assert.equal(V4.readSelector(path.join(f.directory, 'seal/settlement.json')).body.rootSha256, beforeLive.rootSha256, 'the selector is unchanged by the refused compaction');
  assert.ok(fs.existsSync(path.join(f.directory, 'seal/v4/pages', live.pack + '.pages')), 'the damaged pack is not unlinked');
  h.service.close(); await h.service.drained(); h.coordinator.close();
  flipPageByte(f.directory, live); fs.rmSync(latchFile(f.directory));
  const i = await reopen(t, h), iw = await (await i.hello()).work();
  for (const item of done) assert.equal(JSON.stringify((await iw.call('confirm-bundle', item.bundle)).result), JSON.stringify(item.proof), 'proofs after the repair');
  for (const b of done[5].bundle.bindings) assertExcluded(await replayObservation(i, iw, b));
});
/** Maintenance slices (what the idle tick runs) until the liveness accounting is known, then one more (the dead-pack slice). */
async function rebuildLiveness(f) {
  for (let i = 0; i < 10000; i++) { const status = f.coordinator.call('v4-status'); if (status.accounting.known) break; f.coordinator.call('compact', { slice: true }); }
  f.coordinator.call('compact', { slice: true });
  return f.coordinator.call('v4-status');
}
/** For the selected root: a live node page in the pack a relocation visits first (the smallest pack id, every pack being
 * at most half live in this small state) and a dead node page (one no current root references). */
function v4RelocationPages(directory, needDead = true) {
  const v4 = path.join(directory, 'seal/v4'), root = V4.readRoot(v4, V4.readSelector(path.join(directory, 'seal/settlement.json')).body.rootSha256);
  const store = new V4.PackStore(v4, root.lineageSha256);
  try {
    const reachable = new Map();
    for (const d of root.trees) for (const [ref, owner] of V4.Tree.open(store, d.id, d.ref, Number(d.count)).pagesWithOwners()) reachable.set(ref.pack + ':' + ref.page, owner === null);
    const nodePacks = [...new Set([...reachable].filter(([, node]) => node).map(([id]) => id.split(':')[0]))].sort();
    const live = [...reachable].filter(([id, node]) => node && id.startsWith(nodePacks[0] + ':')).map(([id]) => ({ pack: id.split(':')[0], page: id.split(':')[1] }))[0];
    let dead = null;
    for (const pack of store.listPacks()) {
      const pages = Math.floor(fs.statSync(store.packFile(pack)).size / 65536);
      for (let page = 0; page < pages && !dead; page++) {
        if (reachable.has(pack + ':' + page)) continue;
        const bytes = store.readRaw({ pack, page: String(page), sha256: '0'.repeat(64) });
        if (bytes.readUInt16LE(10) !== 3) dead = { pack, page: String(page) };   // a dead node page (kind 1 or 2)
      }
      if (dead) break;
    }
    assert.ok(live && (dead || !needDead), 'the state has a live node page' + (needDead ? ' and a dead node page' : '') + ': ' + JSON.stringify({ live, dead }));
    return { live, dead };
  } finally { store.close(); }
}

// ─── V4-T10: the periodic complete check (order sections 2/4.3; REQ-B2C-V4-05 / RISK-B2C-V4-UNDETECTED-CORRUPTION) ───
const V4 = load('emr-runtime/checkpoint-v4');
/** A leaf page below the root of tree `treeId` in the selected root (never the root page itself, which every
 * admission verifies): bytes the fast restart does not consult. */
function v4LeafBelowRoot(directory, treeId) {
  const v4 = path.join(directory, 'seal/v4');
  const selector = V4.readSelector(path.join(directory, 'seal/settlement.json'));
  const root = V4.readRoot(v4, selector.body.rootSha256), d = root.trees[treeId - 1];
  const store = new V4.PackStore(v4, root.lineageSha256);
  try {
    const tree = V4.Tree.open(store, treeId, d.ref, Number(d.count));
    assert.ok(tree.level >= 1, 'tree ' + treeId + ' has leaves below its root (count ' + d.count + ')');
    const refs = [...tree.pages()];
    return { root: selector.body.rootSha256, ref: refs[1] };
  } finally { store.close(); }
}
/** One payload byte of a stored page changed in place (its footer and the parent's reference no longer agree). */
function flipPageByte(directory, ref) {
  const file = path.join(directory, 'seal/v4/pages', ref.pack + '.pages'), offset = Number(ref.page) * 65536 + 128 + 16;
  const fd = fs.openSync(file, 'r+'), byte = Buffer.alloc(1);
  try { fs.readSync(fd, byte, 0, 1, offset); byte[0] ^= 0x01; fs.writeSync(fd, byte, 0, 1, offset); } finally { fs.closeSync(fd); }
}
const latchFile = directory => path.join(directory, 'seal/v4/tmp/latch.json');
const hashesOutsideScratch = directory => Object.fromEntries(Object.entries(directoryHashes(directory)).filter(([name]) => !name.startsWith('seal/v4/tmp/')));
const hoursLater = (iso, hours) => new Date(Date.parse(iso) + hours * 3600_000);
/** The next owner incarnation over the same directory and the database as the previous incarnation left it. */
async function reopen(t, previous) {
  const g = await fixture(t, { directory: previous.directory, model: model(structuredClone(previous.database.streams)), cold: true });
  await startObserved(g.service); assert.equal(g.service.state, 'ready', 'the next incarnation is ready');
  return g;
}
const refusedAdmission = (t, previous) => fixture(t, { directory: previous.directory, model: model(structuredClone(previous.database.streams)), cold: true });
async function closeOwner(f) { f.service.close(); await f.service.drained(); f.coordinator.close(); }
/** Complete-check steps (one leaf per storage step) until `until(step)` holds; a refusing step is returned as
 * `{ failed }` (the case judges it), never thrown. */
async function sweepUntil(f, now, until) {
  for (let i = 0; i < 20000; i++) {
    let step;
    try { step = await f.seal.fullCheckStep(now, f.database.sql, 1); } catch (error) { return { failed: error }; }
    if (until(step)) return step;
  }
  throw new Error('the sweep did not reach the expected point');
}
async function sweepFails(f, now) {
  const result = await sweepUntil(f, now, () => false);
  return result.failed ?? null;
}
test('V4-T10 complete checking: resumable sweeps over a pinned root, no timestamp reset, overdue and clock rollback, on-use and sweep detection of untouched page and SQL row corruption, immediate latch', v4Only, async t => {
  const f = await fixture(t), work = await (await f.hello()).work(), done = [];
  for (let i = 0; i < 150; i++) done.push(await complete(f, work, i % 3 === 0));
  const start = f.coordinator.call('v4-status');
  assert.equal(start.accounting.known, true);
  assert.equal(start.sweep, null, 'no sweep is running before the first due check');
  assert.equal(start.fullCheck.checkedRoot, null, 'the initial root was fully checked at initialization');
  const initialCompletedAt = start.fullCheck.completedAt;
  // (1) A sweep pins the root it started on; closed and reopened mid-way, it resumes at the persisted cursor; the
  // owner keeps serving (a transition and a forced reclamation during the sweep); completion publishes the fact.
  const t1 = hoursLater(initialCompletedAt, 1);
  const step1 = await f.seal.fullCheckStep(t1, f.database.sql, 1);
  assert.equal(step1.done, false); assert.equal(step1.phase, 'storage'); assert.equal(step1.startedRoot, start.rootSha256, 'the sweep pins the selected root');
  assert.equal((await sweepUntil(f, t1, s => s.tree >= 5)).failed, undefined);
  const paused = f.coordinator.call('v4-status');
  assert.ok(paused.sweep && paused.sweep.tree >= 5 && paused.sweep.startedRoot === start.rootSha256, 'the sweep is in progress: ' + JSON.stringify(paused.sweep));
  assert.equal(paused.fullCheck.completedAt, initialCompletedAt, 'a partial sweep never moves the last-complete timestamp');
  await closeOwner(f);
  let g = await reopen(t, f);
  const resumed = g.coordinator.call('v4-status');
  assert.deepEqual({ root: resumed.sweep?.startedRoot, tree: resumed.sweep?.tree, phase: resumed.sweep?.phase }, { root: start.rootSha256, tree: paused.sweep.tree, phase: 'storage' }, 'the reopened owner resumes the sweep at the persisted cursor');
  assert.equal(resumed.accounting.known, false, 'the accounting is unknown until the new incarnation rebuilds it (RC-03)');
  let gw = await (await g.hello()).work();
  // Concurrent work during the sweep: enough transitions to retire whole packs whose last live pages belonged to the
  // pinned root (the sweep still reads them), plus a forced reclamation; neither may touch the pinned root's pages.
  const during = await complete(g, gw);
  for (let i = 0; i < 30; i++) await complete(g, gw, i % 2 === 0);
  // The forced reclamation proves reachability by traversing the pinned root too: a page of it already unlinked by
  // an earlier slice is the sweep's failure surfacing here.
  let forced = null;
  try { g.coordinator.call('compact', { force: true }); } catch (error) { forced = error; }
  assert.equal(forced, null, 'the sweep completes over its pinned root while the owner serves and reclaims (forced reclamation during the sweep: ' + String(forced && (forced.detail || forced.message)) + ')');
  assert.ok(fs.existsSync(path.join(f.directory, 'seal/v4/roots', start.rootSha256 + '.json')), 'the sweep root stays while the sweep runs');
  // The sweep is continued by the next incarnation (a fresh page cache: what the pinned root's pages are is decided by
  // the files, never by what an earlier incarnation happened to keep in memory), with the accounting it was handed.
  await closeOwner(g);
  const g2 = await reopen(t, g), g2w = await (await g2.hello()).work();
  assert.equal(g2.coordinator.call('v4-status').accounting.known, false, 'unknown again in the next incarnation');
  const completedAt = hoursLater(initialCompletedAt, 2);
  const finished = await sweepUntil(g2, completedAt, s => s.done === true);
  assert.equal(finished.failed, undefined, 'the sweep completes over its pinned root while the owner serves and reclaims: ' + String(finished.failed && finished.failed.message));
  assert.equal(finished.fullCheck.checkedRoot, start.rootSha256, 'the certificate names the checked snapshot, not the current root');
  assert.equal(finished.fullCheck.completedAt, completedAt.toISOString());
  assert.equal((await rebuildLiveness(g2)).accounting.known, true, 'the liveness rebuild is the owner\'s own bounded walk, independent of the sweep');
  const checked = g2.coordinator.call('v4-status');
  assert.equal(checked.sweep, null); assert.equal(checked.fullCheck.completedAt, completedAt.toISOString()); assert.equal(checked.fullCheck.checkedRoot, start.rootSha256);
  assert.notEqual(checked.rootSha256, start.rootSha256, 'the completed check is published as its own transition');
  assert.equal(JSON.stringify((await g2w.call('confirm-bundle', during.bundle)).result), JSON.stringify(during.proof), 'work accepted during the sweep is served');
  g = g2; gw = g2w;
  // (2) Age is measured from completion: overdue after the period, overdue on a clock behind it, unchanged by restart.
  assert.equal(g.coordinator.call('v4-status', { now: hoursLater(checked.fullCheck.completedAt, 23).toISOString() }).fullCheck.overdue, false);
  const late = g.coordinator.call('v4-status', { now: hoursLater(checked.fullCheck.completedAt, 25).toISOString() }).fullCheck;
  assert.deepEqual({ overdue: late.overdue, reason: late.reason }, { overdue: true, reason: 'age' }, 'the check is overdue after its period, measured from the last completion');
  const behind = g.coordinator.call('v4-status', { now: hoursLater(checked.fullCheck.completedAt, -1).toISOString() }).fullCheck;
  assert.deepEqual({ overdue: behind.overdue, reason: behind.reason }, { overdue: true, reason: 'clock-rollback' }, 'a wall clock behind the completion cannot make the check current');
  assert.equal(g.seal.fullCheckDue(hoursLater(checked.fullCheck.completedAt, 1)), false);
  assert.equal(g.seal.fullCheckDue(hoursLater(checked.fullCheck.completedAt, 25)), true);
  assert.equal(await g.service.fullCheckTick(hoursLater(checked.fullCheck.completedAt, 25)), null, 'an open work scope: the owner is not idle, the tick does nothing');
  assert.equal((await gw.call('end')).ok, true);
  assert.equal(await g.service.fullCheckTick(hoursLater(checked.fullCheck.completedAt, 1)), null, 'nothing due: the idle tick does nothing');
  const ticked = await g.service.fullCheckTick(hoursLater(checked.fullCheck.completedAt, 25));
  assert.ok(ticked && ticked.phase === 'storage', 'an overdue check starts on the idle tick (one bounded step)');
  await closeOwner(g);
  const h = await reopen(t, g);
  assert.equal(h.coordinator.call('v4-status').fullCheck.completedAt, completedAt.toISOString(), 'restart does not refresh the completion time');
  assert.equal((await sweepUntil(h, hoursLater(completedAt, 26), s => s.done === true)).failed, undefined, 'the tick-started sweep completes after the restart');
  await closeOwner(h);
  // (3) An untouched terminal leaf changed on disk: the fast restart (anchor and pending work only) is ready; the
  // first use that routes through the page refuses, fails the owner and latches the root; nothing is repaired.
  const terminalLeaf = v4LeafBelowRoot(f.directory, 5);
  flipPageByte(f.directory, terminalLeaf.ref);
  const i = await reopen(t, h);
  assert.equal(fs.existsSync(latchFile(f.directory)), false, 'unread corruption is not discovered by the fast path');
  const corrupted = hashesOutsideScratch(f.directory);   // after the restart's own bounded reclamation of dead packs
  const iw = await (await i.hello()).work();
  let refused = null;
  for (const item of done) { const reply = await iw.call('confirm-bundle', item.bundle); if (!reply.ok) { refused = reply; break; } }
  assert.ok(refused, 'a lookup through the changed page is refused');
  assert.deepEqual({ code: refused.error.code, outcome: refused.error.outcome }, { code: 'DURABILITY', outcome: 'unknown' }, 'the refusal is a durability fault, never a conflict or absence');
  assert.deepEqual({ state: i.service.state, incomplete: i.service.incomplete }, { state: 'stopping', incomplete: true }, 'the owner fails on discovered corruption (quiesced, incomplete)');
  assert.ok(fs.existsSync(latchFile(f.directory)), 'discovery latches the root');
  const onUse = JSON.parse(fs.readFileSync(latchFile(f.directory), 'utf8'));
  assert.deepEqual({ code: onUse.code, phase: onUse.phase, root: onUse.root }, { code: 'SealCorrupt', phase: 'on-use', root: terminalLeaf.root }, 'the latch records the on-use discovery against the selected root');
  assert.equal(JSON.stringify(hashesOutsideScratch(f.directory)), JSON.stringify(corrupted), 'discovery writes nothing but the latch');
  await assert.rejects(refusedAdmission(t, i), error => error.code === 'SealCorrupt' && String(error.detail).startsWith('latched:'), 'a latched root is not admitted again');
  i.service.close(); await i.service.drained(); i.coordinator.close();
  // The operator restores the page and removes the latch: the same bytes are admitted and served again.
  flipPageByte(f.directory, terminalLeaf.ref); fs.rmSync(latchFile(f.directory));
  const j = await reopen(t, i), jw = await (await j.hello()).work();
  for (const item of done.slice(0, 20)) assert.equal(JSON.stringify((await jw.call('confirm-bundle', item.bundle)).result), JSON.stringify(item.proof), 'restored page serves the original proofs');
  // (4) An untouched bundle leaf changed on disk: ready, the complete check reaches it, latches at once (no partial
  // completion, no timestamp change); a commit refuses; after the repair the sweep resumes at its cursor and completes.
  await closeOwner(j);
  const bundleLeaf = v4LeafBelowRoot(f.directory, 6);
  flipPageByte(f.directory, bundleLeaf.ref);
  const k = await reopen(t, j);
  const beforeLatch = k.coordinator.call('v4-status').fullCheck.completedAt;
  const failure = await sweepFails(k, hoursLater(completedAt, 30));
  assert.ok(failure && failure.code === 'SealCorrupt' && String(failure.detail).startsWith('latched:'), 'the sweep refuses at the changed page: ' + String(failure && failure.message));
  const latch = JSON.parse(fs.readFileSync(latchFile(f.directory), 'utf8'));
  assert.deepEqual({ code: latch.code, phase: latch.phase, tree: latch.tree }, { code: 'SealCorrupt', phase: 'storage', tree: 6 }, 'the latch names the sweep position');
  const kw = await (await k.hello()).work();
  const input = event(), canonical = C.canonicalPayload(input, undefined, 'viewing'), tail = await k.database.sql.tail('viewing');
  const commit = await kw.call('reserve', { binding: { stream: 'viewing', chainId: tail.chainId, attemptId: randomUUID(), bundleId: randomUUID(), kind: 'access', eventId: input.eventId,
    sequence: tail.sequence + 1, previousHash: tail.hash, hash: C.entryHash(tail.sequence + 1, tail.hash, canonical.text), contentSha256: canonical.contentSha256 }, prefix: null });
  assert.equal(commit.ok, false, 'no transition after the latch'); assert.equal(commit.error.code, 'DURABILITY');
  assert.deepEqual({ state: k.service.state, incomplete: k.service.incomplete }, { state: 'stopping', incomplete: true });
  await assert.rejects(refusedAdmission(t, k), error => error.code === 'SealCorrupt' && String(error.detail).startsWith('latched:'));
  k.service.close(); await k.service.drained(); k.coordinator.close();
  flipPageByte(f.directory, bundleLeaf.ref); fs.rmSync(latchFile(f.directory));
  const l = await reopen(t, k);
  const resumedAfterLatch = l.coordinator.call('v4-status');
  assert.equal(resumedAfterLatch.fullCheck.completedAt, beforeLatch, 'the latched sweep moved no timestamp');
  assert.ok(resumedAfterLatch.sweep && resumedAfterLatch.sweep.phase === 'storage' && resumedAfterLatch.sweep.tree === 6, 'the sweep resumes where it stopped: ' + JSON.stringify(resumedAfterLatch.sweep));
  const repaired = await sweepUntil(l, hoursLater(completedAt, 31), s => s.done === true);
  assert.equal(repaired.failed, undefined, 'the resumed sweep completes after the repair');
  assert.equal(repaired.fullCheck.completedAt, hoursLater(completedAt, 31).toISOString());
  // (5) A retained SQL row changed behind the verified anchor: ready (not consulted by the fast path), detected by the
  // database phase of the complete check, latched; restored, the sweep resumes in the database phase and completes.
  await closeOwner(l);
  const row = l.database.streams.viewing.rows[4], originalPayload = row.payload;
  row.payload = originalPayload.replace('"result":"succeeded"', '"result":"prepared"');
  assert.notEqual(row.payload, originalPayload);
  const m = await reopen(t, l);
  const dbFailure = await sweepFails(m, hoursLater(completedAt, 60));
  assert.ok(dbFailure && dbFailure.code === 'SealCorrupt', 'the database phase refuses the changed row: ' + String(dbFailure && dbFailure.message));
  const dbLatch = JSON.parse(fs.readFileSync(latchFile(f.directory), 'utf8'));
  assert.deepEqual({ phase: dbLatch.phase, detail: dbLatch.detail }, { phase: 'database', detail: 'viewing:' + row.sequence + ':entry-digest' }, 'the latch names the disagreeing row and clause');
  m.service.close(); await m.service.drained(); m.coordinator.close();
  row.payload = originalPayload; fs.rmSync(latchFile(f.directory));
  const n = await reopen(t, l);
  assert.equal(n.coordinator.call('v4-status').sweep?.phase, 'database', 'the sweep resumes in its database phase');
  const final = await sweepUntil(n, hoursLater(completedAt, 61), s => s.done === true);
  assert.equal(final.failed, undefined, 'the sweep completes after the row is restored');
  assert.equal(final.fullCheck.completedAt, hoursLater(completedAt, 61).toISOString());
  const nw = await (await n.hello()).work();
  for (const item of done.slice(0, 20)) assert.equal(JSON.stringify((await nw.call('confirm-bundle', item.bundle)).result), JSON.stringify(item.proof), 'proofs after the checks');
  for (const b of done[0].bundle.bindings) assertExcluded(await replayObservation(n, nw, b));
});

// ─── V4-T11 (order section 7, A10 over v4; REQ-B2C-V4-06 / RISK-B2C-V4-PREMATURE-RETIREMENT-OR-STALL) ───
test('V4-T11 A10 over a v4 pair: the expired event stays provable with its exact ack and exclusion before and after reclamation, in a private v4 copy and in the lossless v3 export; a dependent copy keeps the source unchanged', v4Only, async t => {
  const EW = load('emr-runtime/external-writer');
  const f = await fixture(t), work = await (await f.hello()).work();
  const original = await complete(f, work, true), published = await complete(f, work);
  for (let i = 0; i < 12; i++) await complete(f, work, i % 2 === 0);
  await a10Expire(f, work);
  assert.equal(f.database.streams.viewing.rows.some(r => r.eventId === original.bundle.eventId), false, 'the original viewing payload is actually absent (lawful expiry)');
  const a10 = async (g, gw, label) => {
    const confirmed = await gw.call('confirm-bundle', original.bundle);
    assert.equal(confirmed.ok, true, label + ': the expired event remains provable');
    assert.equal(JSON.stringify(confirmed.result), JSON.stringify(original.proof), label + ': the identical canonical proof after expiry');
    const ack = await gw.call('acknowledge', { proof: original.proof, bindings: original.bundle.bindings });
    assert.equal(ack.ok && ack.result.status, 'already-acknowledged', label + ': the exact earlier ack is repeated, never a new one');
    const outcome = await gw.call('lookup-outcome', original.bundle);
    assert.equal(outcome.ok && outcome.result.outcome, 'committed-and-sealed', label + ': the original bindings stay committed');
    assert.equal(JSON.stringify((await gw.call('confirm-bundle', published.bundle)).result), JSON.stringify(published.proof), label + ': a never-acked full proof is not evicted');
    for (const b of original.bundle.bindings) assertExcluded(await replayObservation(g, gw, b));
    assert.equal(g.coordinator.call('view').retired.viewing >= 0, true);
  };
  await a10(f, work, 'before reclamation');
  // Reclamation (pack GC) minimizes nothing the retention contract keeps: the same facts after a forced reclamation and a restart.
  f.coordinator.call('compact', { force: true });
  await a10(f, work, 'after reclamation');
  await closeOwner(f);
  const g = await reopen(t, f), gw = await (await g.hello()).work();
  await a10(g, gw, 'after restart');
  await closeOwner(g);
  // A private v4 copy under the launch-scoped mapping (the restore route's shape): the same facts; the source bytes stay.
  const sourceBytes = directoryHashes(f.directory), copy = f.directory + '-v4-private';
  fs.cpSync(f.directory, copy, { recursive: true, errorOnExist: true });
  const mapping = { source: f.pair, target: { ...a10Target, chains: f.pair.chains } };
  const h = await fixture(t, { directory: copy, model: model(structuredClone(g.database.streams)), pair: a10Target, copy: mapping });
  assert.equal(h.service.state, 'ready', 'the private v4 copy is admitted under the mapping');
  assert.equal(h.coordinator.call('v4-status').format, 4);
  const hw = await (await h.hello()).work();
  await a10(h, hw, 'private v4 copy');
  await complete(h, hw);                                               // the copy takes its own work; the source is a retained dependent copy
  assert.equal(JSON.stringify(directoryHashes(f.directory)), JSON.stringify(sourceBytes), 'the source directory bytes are unchanged by the copy');
  await closeOwner(h);
  // The lossless v3 export (rollback route) of the v4 pair keeps the same facts under the unchanged v3 reader.
  const exported = f.directory + '-v3-export';
  const v4Bytes = directoryHashes(f.directory), v4Fingerprint = EW.inspectFingerprint(f.directory);
  const back = EW.exportV4ToV3(f.directory, exported, f.pair);
  assert.equal(back.target.format, 3);
  assert.equal(JSON.stringify(directoryHashes(f.directory)), JSON.stringify(v4Bytes), 'the v4 source bytes are unchanged by the export');
  assert.equal(EW.inspectFingerprint(f.directory), v4Fingerprint, 'the export writes nothing under the v4 source, not even scratch');
  const k = await fixture(t, { directory: exported, model: model(structuredClone(g.database.streams)), format: 3, cold: true });
  await startObserved(k.service); assert.equal(k.service.state, 'ready', 'the unchanged v3 reader admits the export');
  const kw = await (await k.hello()).work();
  await a10(k, kw, 'v3 export');
  assert.equal(JSON.stringify(directoryHashes(f.directory)), JSON.stringify(sourceBytes), 'the export never writes its v4 source');
});

test('V4-T08 first conversion of a healthy v3 pair into a separate v4 root and its lossless export back to a new v3 copy', { skip: FORMAT === 4 && 'runs in the v3 pass (the source is a v3 pair)' }, async t => {
  const EW = load('emr-runtime/external-writer');
  const f = await fixture(t), work = await (await f.hello()).work();
  const acked = await complete(f, work, true), published = await complete(f, work);
  await complete(f, work, true);
  await a10Expire(f, work);                       // an expiry anchor with its retained-start change
  const pending = await f.reserve(work);         // pending work travels with the conversion
  // A superseded reservation leaves a journal obligation (terminal.superseded + commit-not-found).
  const facts = await f.seal.conversionFacts(f.database.sql);
  assert.equal(facts.dbWitness.streams.viewing.verifiedThrough.sequence, f.coordinator.call('view').tail.streams.viewing.sequence);
  assert.ok(facts.dbWitness.streams.viewing.expiry, 'the expiry anchor is part of the witness');
  assert.deepEqual(facts.dbWitness.streams.viewing.retainedStart, { sequence: 2, previousHash: f.database.streams.viewing.rows[0].previousHash });
  const before = f.coordinator.call('read'), pendingKeys = pending.bundle.bindings.map(b => b.stream + ':' + b.attemptId);
  f.service.close(); await f.service.drained(); f.coordinator.close();
  const sourceBytes = directoryHashes(f.directory), target = f.directory + '-v4';
  // The target is built from the quiesced source and fully revalidated; the source is never written.
  const receipt = EW.importV3ToV4(f.directory, target, f.pair, facts);
  assert.equal(receipt.kind, 'import-v3'); assert.equal(receipt.target.format, 4); assert.equal(receipt.source.revision, before.revision);
  assert.equal(receipt.target.counts['5'], Object.keys(before.terminal).length); assert.equal(receipt.target.counts['6'], Object.keys(before.bundles).length);
  assert.equal(receipt.target.counts['7'], pendingKeys.length, 'the pending attempts are the only pending work');
  assert.equal(receipt.target.counts['8'], facts.dbBindings.length);
  assert.ok(receipt.verified.members > 0 && Object.keys(receipt.verified.trees).length === 8);
  assert.equal(JSON.stringify(directoryHashes(f.directory)), JSON.stringify(sourceBytes), 'the v3 source is byte-for-byte unchanged');
  assert.throws(() => EW.importV3ToV4(f.directory, target, f.pair, facts), { code: 'SealUnavailable' }, 'an existing target is never overwritten');
  // The entry mode names the stored format: the v3 mode refuses the v4 target and the v4 mode refuses the v3 source,
  // each before any byte of the directory changes (no lock, no journal, no repair).
  const targetBytes = directoryHashes(target);
  for (const [directory, format, label] of [[target, 3, 'the v3 entry mode over the v4 target'], [f.directory, 4, 'the v4 entry mode over the v3 source']]) {
    let refusal = null;
    try { const c = new StateCoordinator(directory, executeExternal, { format }); c.close(); } catch (error) { refusal = error; }
    assert.equal(refusal && refusal.code, 'SealUnsupportedFormat', label + ' refuses the other format');
  }
  assert.equal(JSON.stringify(directoryHashes(target)), JSON.stringify(targetBytes), 'the refused admissions changed no byte of the target');
  assert.equal(JSON.stringify(directoryHashes(f.directory)), JSON.stringify(sourceBytes), 'the refused admissions changed no byte of the source');
  // The target serves the same proofs, exclusions and pending work under the v4 owner (explicit mode 4).
  const EW4 = load('emr-runtime/external-writer');
  const v4Coordinator = new StateCoordinator(target, EW4.executeExternal, { format: 4 });
  t.after(() => v4Coordinator.close());
  const read = v4Coordinator.call('read');
  // Map key order is not state (v3 keeps insertion order, v4 sorts); members and values must be identical.
  for (const name of ['terminal', 'bundles', 'intents', 'slots', 'proofs']) assert.deepStrictEqual(read[name], before[name], 'conversion preserves ' + name);
  assert.deepStrictEqual(read.tail, before.tail); assert.deepStrictEqual(read.lineage, before.lineage);
  v4Coordinator.close();
  const g = await fixture(t, { directory: target, model: model(structuredClone(f.database.streams)), cold: true, format: 4 });
  await g.service.start(); assert.equal(g.service.state, 'ready', 'the converted target is admitted by the v4 owner');
  const gw = await (await g.hello()).work();
  for (const item of [acked, published]) assert.equal(JSON.stringify((await gw.call('confirm-bundle', item.bundle)).result), JSON.stringify(item.proof), 'proofs survive the conversion');
  assert.equal((await gw.call('acknowledge', { proof: acked.proof, bindings: acked.bundle.bindings })).result.status, 'already-acknowledged', 'the exact ack survives');
  for (const b of acked.bundle.bindings) assertExcluded(await replayObservation(g, gw, b));
  assert.equal(g.coordinator.call('v4-status').pending, 0, 'the restart settled the carried pending reservation');
  await complete(g, gw);
  // Lossless export of the current logical state (including the work accepted in v4) into a NEW v3 copy.
  const current = g.coordinator.call('read');
  g.service.close(); await g.service.drained(); g.coordinator.close();
  const exported = f.directory + '-v3-export';
  let back;
  const targetFingerprint = EW.inspectFingerprint(target);
  try { back = EW.exportV4ToV3(target, exported, f.pair); }
  catch (error) { assert.fail('the export verifies every current member, including the work accepted after the conversion (the export refused its own receipt: ' + String(error && error.code) + ')'); }
  assert.equal(EW.inspectFingerprint(target), targetFingerprint, 'the export writes nothing under the v4 source (the conversion root compares its bytes before and after)');
  assert.equal(back.kind, 'export-v3'); assert.equal(back.target.format, 3);
  assert.equal(back.verified.members, Object.keys(current.terminal).length + Object.keys(current.bundles).length + Object.keys(current.intents).length + Object.keys(current.slots).length + Object.keys(current.proofs).length, 'the export verifies every current member, including the work accepted after the conversion');
  const h = await fixture(t, { directory: exported, model: model(structuredClone(g.database.streams)), cold: true });
  await h.service.start(); assert.equal(h.service.state, 'ready', 'the unchanged v3 reader admits the exported copy');
  const exportedState = h.coordinator.call('read');
  for (const name of ['terminal', 'bundles', 'intents', 'slots', 'proofs', 'retired']) assert.deepStrictEqual(exportedState[name], current[name], 'export preserves ' + name);
  assert.deepStrictEqual(exportedState.tail, current.tail);
  const hw = await (await h.hello()).work();
  for (const item of [acked, published]) assert.equal(JSON.stringify((await hw.call('confirm-bundle', item.bundle)).result), JSON.stringify(item.proof), 'proofs survive the export');
  for (const b of acked.bundle.bindings) assertExcluded(await replayObservation(h, hw, b));
});

test('D1656-T02 closed shell dispatch rejects unchanged legacy scripts before Node', async t => {
  const shell = process.env.KIN_EMR_SHELL || 'sh';
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'emr-entry-mode-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const bin = path.join(base, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nprintf "%s\\n" "$*" > invoked.txt\n', { mode: 0o755 });
  const refs = ['8cbb23e4aead2899a26df20a18bc85f3d58b7c12', '30cedd9795a70b84b2b6a3083e76be97e08b24ad',
    '149f960d34a89b95cc9066040b5d74002a8bd37b', 'f6be60f1dda7e4d70b4c23b91419bb530161f240'];
  const scripts = refs.map(ref => {
    const result = spawnSync('git', ['show', ref + ':api/start-production.sh'], { cwd: root });
    assert.equal(result.status, 0, 'mandatory fixed legacy source must be available'); return result.stdout;
  });
  assert.equal(new Set(scripts.map(sha256)).size, 1, 'the four fixed references are one legacy shell implementation');
  const env = { ...process.env, PATH: bin.replace(/\\/g, '/') + ':' + process.env.PATH };
  for (const bytes of scripts) {
    const script = path.join(base, 'start.sh'); fs.writeFileSync(script, bytes);
    const result = spawnSync(shell, [script, 'state-serve-v3'], { cwd: base, env, timeout: 10000 });
    assert.equal(result.status, 64, 'unchanged old dispatch must refuse the v3 role');
    assert.equal(fs.existsSync(path.join(base, 'invoked.txt')), false, 'legacy refusal must not enter Node');
    assert.equal(sha256(fs.readFileSync(script)), sha256(bytes), 'fixed legacy script remains unchanged');
  }
  const script = path.join(root, 'api/start-production.sh');
  for (const args of [[], ['unknown'], ['state-serve-v3', 'extra']]) {
    const result = spawnSync(shell, [script, ...args], { cwd: base, env, timeout: 10000 });
    assert.equal(result.status, 64, 'missing, unknown and extra arguments must refuse');
    assert.equal(fs.existsSync(path.join(base, 'invoked.txt')), false);
  }
  for (const [mode, target] of [['state-serve-v3', 'dist/emr-runtime/state-service-main.js'], ['state-serve-v4', 'dist/emr-runtime/state-service-main.js'],
    ['state-convert-v4', 'dist/emr-runtime/state-service-main.js'], ['state-export-v3', 'dist/emr-runtime/state-service-main.js'], ['serve', 'dist/main.js']]) {
    const result = spawnSync(shell, [script, mode], { cwd: base, env, timeout: 10000 });
    assert.equal(result.status, 0, 'supported entry mode dispatches');
    assert.equal(fs.readFileSync(path.join(base, 'invoked.txt'), 'utf8').trim(), target);
    fs.unlinkSync(path.join(base, 'invoked.txt'));
  }
});

// A10 (retention purpose / end condition / dependent copies): a private copy of a lineage whose source payload has
// lawfully expired still serves the exact canonical proof, the exact ack retry and the permanent exclusion (RET-04/05/06
// dependent_copies.restore_copies), and a copy whose pair or dependency is wrong is refused before any byte changes
// (RET-07 restore_copies: a wrong pair stays as it was and is not ready).
const a10Target = { instanceId: 'private-copy', database: { database: 'restored', oid: 20002, address: '10.0.0.2', port: 5433 } };
async function a10Expire(f, work) {
  // The lawful expiry of the retained viewing prefix through the first event, as the historical-seed child performs it.
  const retention = await (await f.hello('retention')).work();
  const prepared = await retention.call('expiry-prefix', { through: 1 });
  assert.equal(prepared.ok, true, 'expiry requires durable complete bundle evidence');
  const prefix = prepared.result, tail = await f.database.sql.tail('viewing');
  const payload = C.checkpointPayload('2036-10-19T00:00:00.000Z', prefix.anchor.sequence, prefix.count, prefix.anchor.hash);
  const binding = { stream: 'viewing', chainId: tail.chainId, attemptId: randomUUID(), bundleId: randomUUID(),
    kind: 'expiry', eventId: null, sequence: tail.sequence + 1, previousHash: tail.hash,
    hash: C.entryHash(tail.sequence + 1, tail.hash, payload), contentSha256: sha256(payload) };
  const reserved = await retention.call('reserve', { binding, prefix });
  assert.equal(reserved.ok, true, 'issued prefix reserves before the synthetic expiry commit');
  const s = f.database.streams.viewing;
  s.rows = [...s.rows.filter(r => r.sequence > 1), { sequence: binding.sequence, previousHash: binding.previousHash, hash: binding.hash,
    kind: 'expiry', statutoryAct: null, eventId: null, payload, contentSha256: binding.contentSha256, storedAt: '2036-10-19T00:00:00.000Z' }];
  s.markers = [...s.markers.filter(m => m.sequence > 1), reserved.result];
  const expiry = await retention.call('confirm-bundle', { eventId: null, requiredStreams: ['viewing'], bindings: [reserved.result] });
  assert.equal(expiry.ok, true, 'valid retained-prefix checkpoint publishes');
}
test('A10-T01 private copy replay after payload expiry preserves canonical proof and exact ack', async t => {
  const f = await fixture(t), work = await (await f.hello()).work();
  const original = await complete(f, work, true);
  await complete(f, work);
  await a10Expire(f, work);
  assert.equal(f.database.streams.viewing.rows.some(r => r.eventId === original.bundle.eventId), false, 'original viewing payload is actually absent');
  f.coordinator.call('compact', { force: true });
  f.service.close(); await f.service.drained(); f.coordinator.close();
  const before = directoryHashes(f.directory), copy = f.directory + '-a10-private';
  fs.cpSync(f.directory, copy, { recursive: true, errorOnExist: true });
  const mapping = { source: f.pair, target: { ...a10Target, chains: f.pair.chains } };
  const g = await fixture(t, { directory: copy, model: model(structuredClone(f.database.streams)), pair: a10Target, copy: mapping });
  assert.equal(g.service.state, 'ready');
  const gw = await (await g.hello()).work();
  const confirmed = await gw.call('confirm-bundle', original.bundle);
  assert.equal(confirmed.ok, true, 'the expired event remains provable in the private copy');
  assert.equal(JSON.stringify(confirmed.result), JSON.stringify(original.proof), 'the copy returns the identical canonical proof after expiry');
  const ack = await gw.call('acknowledge', { proof: original.proof, bindings: original.bundle.bindings });
  assert.equal(ack.ok, true, 'the exact original proof is accepted by the copy');
  assert.equal(ack.result.status, 'already-acknowledged', 'the copy repeats the exact earlier ack instead of creating a new one');
  const outcome = await gw.call('lookup-outcome', original.bundle);
  assert.equal(outcome.result.outcome, 'committed-and-sealed', 'the original bindings stay committed, never fenced-not-committed');
  assert.equal(JSON.stringify(outcome.result.proof), JSON.stringify(original.proof));
  for (const b of original.bundle.bindings) assertExcluded(await replayObservation(g, gw, b));
  assert.equal(JSON.stringify(directoryHashes(f.directory)), JSON.stringify(before), 'the source directory bytes are unchanged');
});
test('A10-T02 a copy with the wrong pair or a missing dependency is refused before any mutation', { skip: FORMAT === 4 && 'v3 checkpoint envelope tampering of the copy; v4: V4-T08' }, async t => {
  const f = await fixture(t), work = await (await f.hello()).work();
  await complete(f, work, true);
  await complete(f, work);
  await a10Expire(f, work);
  f.coordinator.call('compact', { force: true });
  f.service.close(); await f.service.drained(); f.coordinator.close();
  const before = directoryHashes(f.directory), copy = f.directory + '-a10-copy', missing = f.directory + '-a10-missing';
  fs.cpSync(f.directory, copy, { recursive: true, errorOnExist: true });
  fs.cpSync(f.directory, missing, { recursive: true, errorOnExist: true });
  const restored = () => model(structuredClone(f.database.streams));
  const targetPair = { ...a10Target, chains: f.pair.chains }, mapping = { source: f.pair, target: targetPair };
  // (iii) the dependency the mapping needs: the stored lineage of the copy's checkpoint is removed (the digest is kept valid).
  const file = path.join(missing, 'seal/settlement.json'), envelope = JSON.parse(fs.readFileSync(file));
  envelope.state.lineage = null; envelope.digest = sha256(JSON.stringify(envelope.state)); fs.writeFileSync(file, JSON.stringify(envelope));
  const copyBytes = directoryHashes(copy), missingBytes = directoryHashes(missing);
  for (const [label, directory, bytes, options, code] of [
    ['(i) target is another pair than the observed database', copy, copyBytes,
      { pair: { ...a10Target, database: { ...a10Target.database, oid: 30003 } }, copy: mapping }, 'SealChainMismatch'],
    ['(ii) mapping source is not the stored origin', copy, copyBytes,
      { pair: a10Target, copy: { source: { ...f.pair, instanceId: 'other-origin' }, target: targetPair } }, 'SealChainMismatch'],
    ['(iii) missing lineage dependency', missing, missingBytes, { pair: a10Target, copy: mapping }, 'SealCorrupt'],
  ]) {
    await assert.rejects(fixture(t, { directory, model: restored(), ...options }), error => error.code === code, label);
    assert.equal(JSON.stringify(directoryHashes(directory)), JSON.stringify(bytes), label + ': refusal changes no file of the copy');
    assert.equal(JSON.stringify(directoryHashes(f.directory)), JSON.stringify(before), label + ': refusal changes no file of the source');
  }
  // The untouched copy under its correct mapping is still admitted: the refusals were about the pair and the dependency.
  const g = await fixture(t, { directory: copy, model: restored(), pair: a10Target, copy: mapping });
  assert.equal(g.service.state, 'ready');
  assert.equal(JSON.stringify(directoryHashes(f.directory)), JSON.stringify(before), 'source bytes unchanged');
});

}
