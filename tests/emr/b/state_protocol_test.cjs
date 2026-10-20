/* REQ-B2C-03/06/08 -> RISK-B2C-CAPABILITY-LEAK/FALSE-ROLLBACK-OR-DUPLICATE/STALE-EPOCH-DEADLOCK -> C-S04 (client/codec subset).
 * Actual worker and local sockets, synthetic peer at the service boundary. Windows named pipes do not support the
 * request half-close (the peer sees EOF before its reply); only the test worker's address is mapped to loopback TCP.
 * Linux uses the unmodified worker over Unix sockets. This is not service dispatcher, Linux ACL,
 * PG, durability or receipt acceptance. Assertions inspect data, pending settlement and peer execution, never source form.
 */
const assert = require('node:assert/strict');
const { test, beforeEach, after } = require('node:test');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { randomUUID, randomBytes } = require('node:crypto');
const root = path.resolve(__dirname, '../../..');
const declaration = JSON.parse(fs.readFileSync(path.join(root, 'emr/units/b.json'), 'utf8')).b2c;
const executed = [];
beforeEach(t => { executed.push(t.name.split(' ')[0]); });
const ts = require(path.join(root, 'api/node_modules/typescript'));
const build = fs.mkdtempSync(path.join(os.tmpdir(), 'emr-c-wire-'));
for (const name of ['emr-contract/validation', 'emr-runtime/limits', 'emr-runtime/journal-file',
  'emr-runtime/state-protocol', 'emr-runtime/state-client', 'emr-runtime/state-client-worker']) {
  const source = path.join(root, 'api/src', name + '.ts'), output = path.join(build, name + '.js');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const compiled = ts.transpileModule(fs.readFileSync(source, 'utf8'), {
    fileName: source, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true,
  });
  assert.equal(compiled.diagnostics.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0, 'fixture must compile');
  fs.writeFileSync(output, compiled.outputText);
}
if (process.platform === 'win32') {
  const worker = path.join(build, 'emr-runtime/state-client-worker.js');
  const addressAdapter = `const testNet = require('node:net'), testConnect = testNet.createConnection;
testNet.createConnection = function(options, ...args) {
  const port = /kin-emr-test-[0-9a-f-]+-port-(\\d+)$/.exec(options.path || '');
  if (!port) throw new Error('Unmapped synthetic address');
  const { path: ignored, ...rest } = options;
  return testConnect.call(this, { ...rest, host: '127.0.0.1', port: Number(port[1]) }, ...args);
};\n`;
  fs.writeFileSync(worker, addressAdapter + fs.readFileSync(worker, 'utf8'));
}
after(() => {
  fs.rmSync(build, { recursive: true, force: true });
  assert.deepEqual(executed.slice().sort(), declaration.local_wire_cases.slice().sort(), 'each declared local case must run exactly once');
});
const P = require(path.join(build, 'emr-runtime/state-protocol'));
const L = require(path.join(build, 'emr-runtime/limits'));
assert.deepEqual(declaration.protocol, { version: P.STATE_PROTOCOL_VERSION, max_frame_bytes_including_lf: L.EMR_STATE_FRAME_MAX_BYTES,
  operation_timeout_ms: L.EMR_STATE_IPC_TIMEOUT_MS, max_sessions: L.EMR_STATE_MAX_SESSIONS, max_live_scopes: L.EMR_STATE_MAX_SCOPES,
  max_active_operations: L.EMR_STATE_MAX_OPERATIONS, verification_concurrency: L.EMR_STATE_VERIFY_CONCURRENCY,
  drain_timeout_ms: L.EMR_DRAIN_TIMEOUT_MS, cleanup_timeout_ms: L.EMR_CLEANUP_TIMEOUT_MS });
const { StateClient } = require(path.join(build, 'emr-runtime/state-client'));
const epoch = randomUUID(), session = randomBytes(32).toString('hex'), scopeToken = randomBytes(32).toString('hex');
const chains = { viewing: randomUUID(), history: randomUUID() };
const clientInstanceId = randomUUID(), workId = randomUUID();
const identity = { clientInstanceId, chains }, scoped = { ...identity, scope: scopeToken };
const hash = c => c.repeat(64);
const one = { stream: 'viewing', chainId: chains.viewing, attemptId: randomUUID(), bundleId: randomUUID(), kind: 'access',
  eventId: 'synthetic-event', sequence: 1, previousHash: hash('0'), hash: hash('1'), contentSha256: hash('2'), generation: 1, proofDigest: null };
const two = { ...one, stream: 'history', chainId: chains.history, kind: 'history', attemptId: randomUUID(), hash: hash('3'), generation: 2 };
const bundle = { eventId: one.eventId, requiredStreams: ['viewing', 'history'], bindings: [one, two] };
const sealed = b => ({ ...b, sealed: { chainId: b.chainId, sequence: b.sequence, hash: b.hash } });
const proof = { v: 1, serviceEpoch: epoch, eventId: one.eventId, requiredStreams: bundle.requiredStreams, entries: [sealed(one), sealed(two)] };
const reservation = (({ generation, proofDigest, ...rest }) => rest)(one);
const prefix = { seal: { chainId: chains.viewing, sequence: 1, hash: hash('1') }, anchor: { sequence: 1, hash: hash('1') }, count: 1 };
const journal = { id: 'rollback:synthetic', kind: 'append-rolled-back', body: { eventId: one.eventId, cause: 'business-rollback' } };
const values = {
  hello: { protocol: 1, clientInstanceId }, begin: identity, reserve: { ...scoped, binding: reservation, prefix: null },
  'confirm-bundle': { ...scoped, ...bundle }, 'lookup-outcome': { ...scoped, ...bundle },
  'journal-record': { ...scoped, ...journal }, 'journal-find': { ...scoped, id: journal.id },
  acknowledge: { ...scoped, proof, bindings: [one, two] }, 'expiry-prefix': { ...scoped, through: 1 }, end: scoped, status: identity,
};
const helloResult = { ready: true, session, instanceId: 'synthetic-pair', chains,
  database: { database: 'synthetic', oid: 42, address: '127.0.0.1', port: 5432 } };
const results = { hello: helloResult, begin: { scope: scopeToken }, reserve: one, 'confirm-bundle': proof,
  'lookup-outcome': { outcome: 'committed-and-sealed', proof }, 'journal-record': { ...journal, at: '2026-10-19T00:00:00.000Z' },
  'journal-find': null, acknowledge: { status: 'acknowledged' }, 'expiry-prefix': prefix, end: { status: 'ended' },
  status: { state: 'ready', chains, sealed: { viewing: prefix.seal, history: { ...prefix.seal, chainId: chains.history } },
    sessions: 1, scopes: 0, operations: 0, journalRecords: 0, pending: 0 } };
function request(operation, value = values[operation]) {
  return { v: 1, requestId: randomUUID(), serviceEpoch: operation === 'hello' ? null : epoch,
    session: operation === 'hello' ? null : session, workId: ['hello', 'status'].includes(operation) ? null : workId, operation, value };
}
function response(r, result = results[r.operation]) { return { v: 1, requestId: r.requestId, serviceEpoch: epoch, ok: true, result }; }
function refuses(fn, code = 'PROTOCOL') { assert.throws(fn, e => e instanceof P.StateProtocolError && e.code === code); }
const copy = value => JSON.parse(JSON.stringify(value));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('C-S04.W01 closed operation data, roles, bindings, journal and response shapes', () => {
  for (const operation of P.STATE_OPERATIONS) {
    const r = request(operation), role = operation === 'expiry-prefix' ? 'retention' : 'api';
    assert.deepEqual(P.parseStateRequest(r, role), r);
    assert.deepEqual(P.parseStateResponse(response(r), r).result, results[operation]);
    refuses(() => P.parseStateRequest({ ...r, path: '/var/lib/kin-emr' }, role));
    refuses(() => P.parseStateRequest({ ...r, value: { ...r.value, role: 'retention' } }, role));
    refuses(() => P.parseStateResponse({ ...response(r), debug: 'raw-error' }, r));
  }
  for (const operation of ['recoverAtStart', 'fence', 'acquire', 'unlock', 'start', 'stop', 'close-service', 'compose',
    'upgrade', 'compact', 'update', 'compare-and-set', 'read', 'owner-alive', '__proto__']) {
    refuses(() => P.parseStateRequest({ ...request('status'), operation }, 'api'));
  }
  refuses(() => P.parseStateRequest(request('expiry-prefix'), 'api'), 'FORBIDDEN');
  const expiry = { ...request('reserve'), value: { ...scoped, binding: { ...reservation, kind: 'expiry', eventId: null }, prefix } };
  assert.equal(P.parseStateRequest(expiry, 'retention').value.binding.kind, 'expiry');
  refuses(() => P.parseStateRequest(expiry, 'api'), 'FORBIDDEN');
  const checkpoint = { ...one, kind: 'expiry', eventId: null, proofDigest: hash('4') };
  const expiryConfirm = request('confirm-bundle', { ...scoped, eventId: null, requiredStreams: ['viewing'], bindings: [checkpoint] });
  assert.equal(P.parseStateRequest(expiryConfirm, 'retention').value.eventId, null);
  refuses(() => P.parseStateRequest(expiryConfirm, 'api'), 'FORBIDDEN');
  assert.equal(P.parseStateResponse(response(expiryConfirm, { v: 1, serviceEpoch: epoch, eventId: null,
    requiredStreams: ['viewing'], entries: [sealed(checkpoint)] }), expiryConfirm).result.entries.length, 1);
  for (const delta of [{ v: 2 }, { session: null }, { workId: null }, { serviceEpoch: null }, { requestId: 'not-a-uuid' }])
    refuses(() => P.parseStateRequest({ ...request('begin'), ...delta }, 'api'));
  refuses(() => P.parseStateRequest(request('journal-record', { ...values['journal-record'], body: { ...journal.body, password: 'synthetic' } }), 'api'));
});

test('C-S04.W02 full two-stream proof, durable coverage and correlation cannot degrade to status', () => {
  const r = request('confirm-bundle');
  for (const mutate of [p => p.entries.pop(), p => p.entries.push(p.entries[0]), p => p.requiredStreams.reverse(),
    p => p.entries[1].stream = 'viewing', p => p.entries[1].sealed.sequence = 0, p => p.entries[1].sealed.hash = hash('f'),
    p => p.entries[1].sealed.chainId = randomUUID(), p => p.eventId = 'other', p => p.serviceEpoch = randomUUID()]) {
    const changed = copy(proof); mutate(changed); refuses(() => P.parseStateResponse(response(r, changed), r));
  }
  for (const delta of [{ requestId: randomUUID() }, { v: 2 }, { ok: 'true' }, { result: results.status }])
    refuses(() => P.parseStateResponse({ ...response(r), ...delta }, r));
  refuses(() => P.parseStateResponse({ ...response(r), serviceEpoch: randomUUID() }, r), 'EPOCH');
  const unknown = { v: 1, requestId: r.requestId, serviceEpoch: epoch, ok: false, error: { code: 'TIMEOUT', outcome: 'unknown' } };
  assert.equal(P.parseStateResponse(unknown, r).error.outcome, 'unknown');
  refuses(() => P.parseStateResponse({ ...unknown, error: { ...unknown.error, message: 'connection-string' } }, r));
  refuses(() => P.parseStateResponse({ ...unknown, error: { code: 'arbitrary', outcome: 'not-committed' } }, r));
});

test('C-S04.W03 byte-bounded UTF-8 framing rejects duplicates, delayed trailing data and truncation', () => {
  const value = { text: '한글🙂' }, frame = P.encodeStateFrame(value), fragmented = new P.StateFrameReader();
  for (const byte of frame) fragmented.push(Buffer.from([byte]));
  assert.deepEqual(fragmented.finish(), value);
  refuses(() => fragmented.push(Buffer.from(' ')));
  const exact = P.encodeStateFrame({ text: 'a'.repeat(L.EMR_STATE_FRAME_MAX_BYTES - 12) });
  assert.equal(exact.length, L.EMR_STATE_FRAME_MAX_BYTES);
  const reader = new P.StateFrameReader(); reader.push(exact); assert.equal(reader.finish().text.length, exact.length - 12);
  refuses(() => P.encodeStateFrame({ text: 'a'.repeat(L.EMR_STATE_FRAME_MAX_BYTES - 11) }));
  for (const raw of [Buffer.concat([frame, frame]), Buffer.concat([frame, Buffer.from('x')]),
    Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc0, 0xaf, 0x22, 0x7d, 10]), Buffer.from('{}'), Buffer.from('\ufeff{}\n')]) {
    refuses(() => { const r = new P.StateFrameReader(); r.push(raw); r.finish(); });
  }
  refuses(() => new P.StateFrameReader().push(Buffer.alloc(L.EMR_STATE_FRAME_MAX_BYTES + 1)));
});

async function peer(t, handler) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'emr-c-socket-'));
  let socketPath = path.join(directory, 'writer.sock');
  const sockets = new Set(), observed = [], controls = new Set();
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => { sockets.delete(socket); controls.delete(socket); });
    const reader = new P.StateFrameReader(); let r;
    socket.on('data', part => {
      try {
        if (!reader.push(part)) return;
        r = P.parseStateRequest(reader.finish(), 'api');
        if (r.operation === 'hello') { observed.push(r); controls.add(socket); socket.write(P.encodeStateFrame(response(r))); }
      } catch { socket.destroy(); }
    });
    socket.on('end', () => {
      if (!r || r.operation === 'hello') { socket.end(); return; }
      observed.push(r);
      handler(r, socket, () => socket.end(P.encodeStateFrame(response(r))));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject);
    server.listen(process.platform === 'win32' ? { host: '127.0.0.1', port: 0 } : socketPath, resolve); });
  if (process.platform === 'win32') socketPath = '\\\\.\\pipe\\kin-emr-test-' + randomUUID() + '-port-' + server.address().port;
  if (process.platform !== 'win32') { fs.chmodSync(directory, 0o750); fs.chmodSync(socketPath, 0o660); }
  const endpoint = { path: socketPath, role: 'api', ownerUid: process.getuid?.() ?? 1000, groupId: process.getgid?.() ?? 1000 };
  const clients = [];
  t.after(async () => {
    await Promise.allSettled(clients.map(c => c.close()));
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true });
  });
  return { observed, controls, sockets, endpoint, client() { const c = new StateClient(endpoint); clients.push(c); return c; } };
}
async function ready(c) { const hello = await c.openSession(clientInstanceId); assert.equal(hello.serviceEpoch, epoch); return hello; }

test('C-S04.W04 actual async worker remains responsive and correlates out-of-order calls', { timeout: 8000 }, async t => {
  const held = [];
  const p = await peer(t, (r, socket, answer) => held.push({ r, answer })), c = p.client();
  await ready(c);
  const a = c.callAsync('begin', randomUUID(), identity), b = c.callAsync('begin', randomUUID(), identity);
  while (held.length !== 2) await wait(5);
  let tick = false; await new Promise(resolve => setImmediate(() => { tick = true; resolve(); }));
  assert.equal(tick, true);
  held[1].answer(); assert.equal((await b).scope, scopeToken);
  held[0].answer(); assert.equal((await a).scope, scopeToken);
  assert.equal(p.observed.length, 3); assert.notEqual(held[0].r.requestId, held[1].r.requestId);
  await c.close(); await c.close();
  await assert.rejects(c.openSession(clientInstanceId), e => e.code === 'CLOSED');
  await assert.rejects(c.callAsync('begin', workId, identity), e => e.outcome === 'not-started');
});

test('C-S04.W05 old epoch, wrong request, malformed/trailing response permanently stop admission', { timeout: 12000 }, async t => {
  for (const mode of ['epoch', 'request', 'result', 'duplicate', 'late-trailing']) {
    const p = await peer(t, (r, socket) => {
      const reply = response(r);
      if (mode === 'epoch') reply.serviceEpoch = randomUUID();
      if (mode === 'request') reply.requestId = randomUUID();
      if (mode === 'result') reply.result = { scope: 'not-a-token' };
      const bytes = P.encodeStateFrame(reply);
      if (mode === 'late-trailing') { socket.write(bytes); setImmediate(() => socket.end('x')); }
      else socket.end(mode === 'duplicate' ? Buffer.concat([bytes, bytes]) : bytes);
    });
    const c = p.client(); await ready(c);
    await assert.rejects(c.callAsync('begin', workId, identity), e => ['PROTOCOL', 'EPOCH'].includes(e.code) && e.outcome === 'unknown');
    await wait(10);
    assert.equal(c.unavailable.aborted, true);
    await assert.rejects(c.callAsync('begin', randomUUID(), identity), e => e.outcome === 'not-started');
    assert.equal(p.observed.length, 2); await c.close();
  }
});

test('C-S04.W06 connected timeout stays unknown; exact keyed replay uses a fresh correlation only', { timeout: 8000 }, async t => {
  let calls = 0;
  const p = await peer(t, (_r, _socket, answer) => { if (++calls === 2) answer(); }), c = p.client(); await ready(c);
  await assert.rejects(c.callAsync('reserve', workId, values.reserve), e => e.code === 'TIMEOUT' && e.outcome === 'unknown');
  assert.deepEqual(await c.callAsync('reserve', workId, values.reserve), one);
  const operations = p.observed.filter(r => r.operation === 'reserve');
  assert.equal(operations.length, 2); assert.deepEqual(operations[0].value, operations[1].value);
  assert.notEqual(operations[0].requestId, operations[1].requestId); assert.equal(c.unavailable.aborted, false);
});

test('C-S04.W07 control loss settles owned calls, never reconnects, and close joins worker exit', { timeout: 8000 }, async t => {
  let entered; const received = new Promise(resolve => { entered = resolve; });
  const p = await peer(t, () => entered()), c = p.client(); await ready(c);
  const outstanding = assert.rejects(c.callAsync('reserve', workId, values.reserve), e => e.outcome === 'unknown');
  await received; for (const socket of p.controls) socket.destroy();
  await outstanding; assert.equal(c.unavailable.aborted, true);
  await c.close(); assert.equal(p.observed.length, 2);
  await assert.rejects(c.openSession(randomUUID()), e => e.code === 'CLOSED');
});

test('C-S04.W08 overload refuses before dispatch; close settles every admitted call', { timeout: 8000 }, async t => {
  const p = await peer(t, () => {}), c = p.client(); await ready(c);
  const calls = Array.from({ length: L.EMR_STATE_MAX_OPERATIONS }, () =>
    assert.rejects(c.callAsync('begin', randomUUID(), identity), e => e.outcome === 'unknown'));
  await assert.rejects(c.callAsync('begin', randomUUID(), identity), e => e.code === 'OVERLOADED' && e.outcome === 'not-started');
  await c.close(); await Promise.all(calls);
  assert.ok(p.observed.filter(r => r.operation === 'begin').length <= L.EMR_STATE_MAX_OPERATIONS);
});

test('C-S04.W09 preconnection refusal creates no owner or protected state and cannot re-open', { timeout: 8000 }, async t => {
  const p = await peer(t, (_r, _s, answer) => answer());
  const absent = new StateClient({ ...p.endpoint, path: p.endpoint.path + '-absent' });
  t.after(() => absent.close());
  await assert.rejects(absent.openSession(clientInstanceId), e => e.code === 'UNAVAILABLE' && e.outcome === 'not-started');
  assert.equal(absent.unavailable.aborted, true); assert.equal(p.observed.length, 0);
  await assert.rejects(absent.openSession(clientInstanceId), e => e.code === 'CLOSED');
});

test('C-S04.W10 one control identity, no synchronous escape, local scope identity rejects before IPC', { timeout: 8000 }, async t => {
  const p = await peer(t, (_r, _s, answer) => answer()), c = p.client();
  const initial = c.openSession(clientInstanceId);
  await assert.rejects(c.openSession(randomUUID()), e => e.code === 'SESSION');
  assert.equal((await initial).clientInstanceId, clientInstanceId);
  refuses(() => c.call('compare-and-set', {}), 'FORBIDDEN');
  await assert.rejects(c.callAsync('begin', workId, { ...identity, clientInstanceId: randomUUID() }), e => e.code === 'SESSION');
  await assert.rejects(c.callAsync('begin', workId, { ...identity, chains: { ...chains, viewing: randomUUID() } }), e => e.code === 'SESSION');
  assert.equal(p.observed.length, 1);
});

test('C-S04.W11 valid-shaped replies cannot substitute another event, chain, reservation or journal', () => {
  const r = request('confirm-bundle'), other = copy(proof);
  other.eventId = 'other'; for (const e of other.entries) e.eventId = 'other';
  refuses(() => P.parseStateResponse(response(r, other), r));
  const subset = { ...copy(proof), requiredStreams: ['viewing'], entries: [copy(proof.entries[0])] };
  refuses(() => P.parseStateResponse(response(r, subset), r));
  const reserve = request('reserve');
  for (const delta of [{ attemptId: randomUUID() }, { bundleId: randomUUID() }, { contentSha256: hash('f') }, { chainId: randomUUID() }])
    refuses(() => P.parseStateResponse(response(reserve, { ...one, ...delta }), reserve));
  const record = request('journal-record');
  for (const delta of [{ id: 'other' }, { body: { ...journal.body, cause: 'ledger-refused' } }])
    refuses(() => P.parseStateResponse(response(record, { ...results['journal-record'], ...delta }), record));
  const wrong = copy(values['confirm-bundle']); wrong.bindings[0].chainId = randomUUID();
  refuses(() => P.parseStateRequest(request('confirm-bundle', wrong), 'api'));
  const ack = copy(values.acknowledge); ack.bindings[0].attemptId = randomUUID();
  refuses(() => P.parseStateRequest(request('acknowledge', ack), 'api'));
});

test('C-S04.W12 worker death settles all calls as unknown and permanently revokes the client', { timeout: 8000 }, async t => {
  const threads = require('node:worker_threads'), OriginalWorker = threads.Worker;
  let worker;
  // Observe the actual worker acquisition boundary; do not reach through private client fields.
  threads.Worker = class extends OriginalWorker { constructor(...args) { super(...args); worker = this; } };
  t.after(() => { threads.Worker = OriginalWorker; });
  let entered; const received = new Promise(resolve => { entered = resolve; });
  const p = await peer(t, () => entered()), c = p.client(); await ready(c);
  const pending = assert.rejects(c.callAsync('reserve', workId, values.reserve), e => e.outcome === 'unknown');
  await received; await worker.terminate(); await pending; await c.close();
  assert.equal(c.unavailable.aborted, true);
  await assert.rejects(c.openSession(randomUUID()), e => e.code === 'CLOSED');
  assert.equal(p.observed.length, 2);
});

test('C-S04.W13 fragmented response succeeds only after EOF; truncated response grants no result', { timeout: 8000 }, async t => {
  let release, arrived;
  const received = new Promise(resolve => { arrived = resolve; });
  const p = await peer(t, (r, socket) => {
    const bytes = P.encodeStateFrame(response(r));
    for (const byte of bytes) socket.write(Buffer.from([byte]));
    release = () => socket.end(); arrived();
  }), c = p.client(); await ready(c);
  let delivered = false;
  const result = c.callAsync('begin', workId, identity).then(v => { delivered = true; return v; });
  await received; await wait(20); assert.equal(delivered, false); release(); assert.equal((await result).scope, scopeToken);
  const broken = await peer(t, (r, socket) => socket.end(P.encodeStateFrame(response(r)).subarray(0, -1))), d = broken.client();
  await ready(d);
  await assert.rejects(d.callAsync('begin', workId, identity), e => e.code === 'PROTOCOL' && e.outcome === 'unknown');
});
