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
const test = (name, body) => { if (selectedCases.includes(name.split(' ')[0])) nodeTest(name, body); };
const executed = [];
const childInput = process.argv.indexOf('--terminal-child');
if (childInput === -1) {
  beforeEach(t => executed.push(t.name.split(' ')[0]));
  assert.equal(new Set(selectedCases).size, selectedCases.length);
  assert.equal(selectedCases.every(id => declaration.local_service_cases.includes(id)), true);
  after(() => assert.deepEqual(executed, declaration.local_service_cases.filter(id => selectedCases.includes(id))));
  console.log('SERVICE_SELECTION ' + JSON.stringify(selectedCases));
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
  const coordinator = new StateCoordinator(directory, executeExternal);
  const journal = new FailureJournal(directory, coordinator), seal = new AccessSeal(directory, database.sql, journal);
  const pair = { instanceId: 'synthetic-copy', chains: Object.fromEntries(Object.entries(database.streams).map(([s, v]) => [s, v.chainId])),
    database: { database: 'isolated', oid: 10001, address: '127.0.0.1', port: 5432 } };
  const service = new ProtectedStateService({ coordinator, journal, seal, sql: database.sql, pair });
  const peers = [];
  t.after(async () => { service.close(); for (const socket of peers) socket.destroy(); await service.drained(); coordinator.close(); });
  if (!options.cold) await service.start();
  const hello = async (role = 'api') => {
    const socket = new net.Socket(); peers.push(socket);
    const clientInstanceId = randomUUID();
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
  if (acknowledge) assert.equal((await work.call('acknowledge', { proof: proof.result, bindings: item.bundle.bindings })).ok, true);
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
    const f = await fixture(t, input.phase === 'seed' ? {} : { directory: input.directory, model: model(input.database) });
    const peer = await f.hello(), work = await peer.work();
    if (input.phase === 'seed') {
      const original = await complete(f, work, true);
      await complete(f, work);
      return { directory: f.directory, database: f.database.streams, bundle: original.bundle, proof: original.proof,
        epoch: f.service.serviceEpoch, pid: process.pid, observation: stateObservation(f) };
    }
    const old = work.req('reserve', { binding: reservation(input.bundle.bindings[0]), prefix: null });
    old.serviceEpoch = input.epoch;
    const stale = await f.service.dispatch('api', old, peer.socket);
    const observations = [];
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
  fs.writeFileSync(config, JSON.stringify({ ...input, phase: phase === 'seed' ? 'seed' : 'replay', output }));
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
  assert.notEqual(outcome.result.proof.serviceEpoch, f.service.serviceEpoch);
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
      await work.call('acknowledge', value);
      if (mode === 'duplicate') assert.equal((await work.call('acknowledge', value)).ok, true);
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

test('D1641-T06 actual WAL checkpoint compaction preserves exclusion through a new process', async t => {
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
  f.service.close(); await f.service.drained(); f.coordinator.close();
  const evidence = fs.mkdtempSync(path.join(path.dirname(f.directory), 'compacted-'));
  const next = childPhase(evidence, 'restart', { directory: f.directory, database: f.database.streams,
    bundle: original.bundle, epoch: f.service.serviceEpoch });
  for (const observation of next.observations) assertExcluded(observation);
  assert.equal(next.observation.terminals, 2 * count, 'compaction retains every acknowledged stream identity');
});

test('D1641-T06F publication flush failures never acknowledge success or erase terminal exclusion', async t => {
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

test('D1641-T09 acknowledged identity accumulation survives capacity refusal and recovery', async t => {
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
}
