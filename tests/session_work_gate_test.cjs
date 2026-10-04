// U5S-REQ-11/12/13 -> U5S-RISK-APPLY, U5S-RISK-SESSION, U5S-RISK-DRAFT -> TEST-U5S-GATE.
//
// The shipped modules, loaded as they are: worklist-v0/hpacs-lite/work-context.js (the apply gate) and
// session-transport.js (request admission, the captured X-KIN-Session, the one deadline over headers and body,
// cancellation, authentication failures attributed to the request's session). Every case drives the public contract
// only - capture/commit and the lifecycle, selection, edit and preparation transitions - and observes what an effect did
// or what reached the network. Nothing asserts a source string or an internal name.
//
//   GATE-01..09  a stale effect never runs: before activation, across a preparation, its cancellation (a new work
//                epoch), the end of the session, a replacement login, study A -> B -> A and an edit; the preparation
//                context is the only thing that commits while preparing and is dead once it is cancelled, replaced or
//                the session ends; an effect cannot defer work (async, generator, returned promise).
//   SEND-01..10  a request leaves only for an admitted context and always carries that context's session; the deadline
//                covers headers and body; a read whose context went stale is aborted, a write is not (its answer comes
//                back and the gate refuses its effect); 401 and binding refusals are reported for the request's session.
//
// Run with: node --test tests/session_work_gate_test.cjs
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { test, mock } = require('node:test');

const lite = join(__dirname, '../worklist-v0/hpacs-lite');
const KinWorkContext = require(join(lite, 'work-context.js'));
const KinSessionTransport = require(join(lite, 'session-transport.js'));

/** A session authority as the gate sees one: it replays its state on subscription and announces each transition. */
function authority() {
  let listener = null, now = { state: 'unknown', session: null };
  return {
    onLifecycle(next) { listener = next; next(now); },
    say(state, session = null) { now = { state, session }; listener(now); },
  };
}

function activeGate(session = 'S1') {
  const gate = KinWorkContext.create(), source = authority();
  gate.follow(source);
  source.say('active', session);
  return { gate, source };
}

/** Runs commit and reports what the effect did: how many times it ran and whether it ran before commit returned. */
function attempt(gate, context) {
  let runs = 0;
  const accepted = gate.commit(context, () => { runs += 1; });
  return { accepted, runs };
}

const SCOPES = ['document', 'study', 'editor'];
const settle = () => new Promise(resolve => setImmediate(resolve));

test('GATE-01 before a session is confirmed no work effect runs, and what was captured then stays dead', () => {
  const gate = KinWorkContext.create(), source = authority();
  gate.follow(source);
  assert.equal(gate.state(), 'unknown');
  const early = SCOPES.map(scope => gate.capture(scope));
  for (const context of early) assert.deepEqual(attempt(gate, context), { accepted: false, runs: 0 });
  source.say('active', 'S1');
  assert.equal(gate.state(), 'active');
  for (const context of early) assert.deepEqual(attempt(gate, context), { accepted: false, runs: 0 }, 'captured before the session');
  for (const scope of SCOPES) assert.deepEqual(attempt(gate, gate.capture(scope)), { accepted: true, runs: 1 });
});

test('GATE-02 the context is an immutable value with explicit null study fields for document work', () => {
  const { gate } = activeGate();
  gate.select('1.2.3');
  const document = gate.capture('document'), study = gate.capture('study'), editor = gate.capture('editor');
  assert.deepEqual({ ...document }, { session: 'S1', workEpoch: document.workEpoch, uid: null, selectionSeq: null });
  assert.deepEqual(Object.keys(study), ['session', 'workEpoch', 'uid', 'selectionSeq']);
  assert.equal(study.uid, '1.2.3');
  assert.deepEqual(Object.keys(editor), ['session', 'workEpoch', 'uid', 'selectionSeq', 'editRevision']);
  for (const context of [document, study, editor]) {
    assert.ok(Object.isFrozen(context));
    assert.throws(() => { 'use strict'; context.workEpoch = 99; }, TypeError);
  }
  // A look-alike built from the current values is not a context the gate issued.
  assert.deepEqual(attempt(gate, { ...study }), { accepted: false, runs: 0 });
  assert.deepEqual(attempt(gate, null), { accepted: false, runs: 0 });
  assert.throws(() => gate.capture('everything'), TypeError);
});

test('GATE-03 an effect runs synchronously exactly once, and cannot defer work', () => {
  const { gate } = activeGate();
  const order = [];
  const context = gate.capture('document');
  order.push('before');
  assert.equal(gate.commit(context, () => { order.push('effect'); }), true);
  order.push('after');
  assert.deepEqual(order, ['before', 'effect', 'after']);

  let ran = 0;
  assert.throws(() => gate.commit(context, async () => { ran += 1; }), TypeError, 'an async effect is refused before it runs');
  assert.throws(() => gate.commit(context, function* () { ran += 1; }), TypeError, 'a generator effect is refused before it runs');
  assert.equal(ran, 0);
  assert.throws(() => gate.commit(context, () => Promise.resolve()), TypeError, 'an effect that hands back a promise is not complete');
  assert.throws(() => gate.commit(context, 'not a function'), TypeError);
  // A stale context is refused before the effect is even looked at as work.
  gate.select('1.2.9');
  const stale = gate.capture('study');
  gate.select('1.2.10');
  assert.equal(gate.commit(stale, () => { ran += 1; }), false);
  assert.equal(ran, 0);
});

test('GATE-04 study A -> B -> A: the first A is not the second A; document work is untouched by selection', () => {
  const { gate } = activeGate();
  gate.select('A');
  const document = gate.capture('document'), firstA = gate.capture('study'), editorA = gate.capture('editor');
  gate.select('B');
  const onB = gate.capture('study');
  assert.deepEqual(attempt(gate, firstA), { accepted: false, runs: 0 });
  gate.select('A');
  assert.equal(gate.selection().uid, 'A');
  assert.deepEqual(attempt(gate, firstA), { accepted: false, runs: 0 }, 'back on A, the earlier selection of A is still stale');
  assert.deepEqual(attempt(gate, editorA), { accepted: false, runs: 0 });
  assert.deepEqual(attempt(gate, onB), { accepted: false, runs: 0 });
  assert.deepEqual(attempt(gate, document), { accepted: true, runs: 1 });
  assert.deepEqual(attempt(gate, gate.capture('study')), { accepted: true, runs: 1 });
});

test('GATE-05 an edit stales editor effects only', () => {
  const { gate } = activeGate();
  gate.select('A');
  const document = gate.capture('document'), study = gate.capture('study'), editor = gate.capture('editor');
  gate.edited();
  assert.deepEqual(attempt(gate, editor), { accepted: false, runs: 0 }, 'the text changed while the work was out');
  assert.deepEqual(attempt(gate, study), { accepted: true, runs: 1 });
  assert.deepEqual(attempt(gate, document), { accepted: true, runs: 1 });
  assert.deepEqual(attempt(gate, gate.capture('editor')), { accepted: true, runs: 1 });
});

test('GATE-06 a preparation blocks ordinary work; cancelling it is a new work epoch that revives nothing', () => {
  const { gate } = activeGate();
  gate.select('A');
  const before = SCOPES.map(scope => gate.capture(scope));
  const epoch = before[0].workEpoch;
  const preparation = gate.prepare({ owner: { institution: 'I', sub: 'U', author: 'u@x' }, expectedRevision: 'r1',
    snapshot: { findings: 'F' } });
  assert.equal(gate.state(), 'preparing');
  assert.equal(gate.session(), 'S1', 'preparing claims no termination');
  for (const context of before) assert.deepEqual(attempt(gate, context), { accepted: false, runs: 0 });
  // Work that tries to start during the preparation gets a context that never commits - then or later.
  const during = SCOPES.map(scope => gate.capture(scope));
  for (const context of during) assert.deepEqual(attempt(gate, context), { accepted: false, runs: 0 });
  assert.deepEqual(attempt(gate, preparation), { accepted: true, runs: 1 }, 'the preparation commits its own outcome');

  assert.equal(gate.cancelPreparation(preparation), true);
  assert.equal(gate.state(), 'active');
  assert.ok(gate.capture('document').workEpoch > epoch, 'cancellation returns to active with a new work epoch');
  for (const context of [...before, ...during, preparation])
    assert.deepEqual(attempt(gate, context), { accepted: false, runs: 0 }, 'nothing from before the cancellation applies');
  for (const scope of SCOPES) assert.deepEqual(attempt(gate, gate.capture(scope)), { accepted: true, runs: 1 });
  assert.equal(gate.cancelPreparation(preparation), false, 'a cancelled preparation cannot be cancelled again');
});

test('GATE-07 the preparation permission is one live, frozen capture: not reusable, not forgeable, not alterable', () => {
  const { gate, source } = activeGate();
  gate.select('A');
  const text = { findings: 'SYN typed', citations: ['c1'] };
  const first = gate.prepare({ owner: { institution: 'I', sub: 'U', author: 'u@x' }, expectedRevision: 'r1', snapshot: text });
  text.findings = 'changed after the capture';
  text.citations.push('c2');
  assert.deepEqual(first.snapshot, { findings: 'SYN typed', citations: ['c1'] }, 'the snapshot is the text at the capture');
  assert.ok(Object.isFrozen(first.snapshot) && Object.isFrozen(first.snapshot.citations) && Object.isFrozen(first.owner));
  assert.deepEqual(attempt(gate, { ...first }), { accepted: false, runs: 0 }, 'a copy with the same id is not the permission');
  assert.deepEqual(attempt(gate, Object.freeze({ ...first, snapshot: { findings: 'other' } })), { accepted: false, runs: 0 });

  // A retry with another expected revision is a new preparation; the earlier permission ends there.
  const second = gate.prepare({ owner: first.owner, expectedRevision: 'r2', snapshot: first.snapshot });
  assert.notEqual(second.preparation, first.preparation);
  assert.deepEqual(attempt(gate, first), { accepted: false, runs: 0 });
  assert.deepEqual(attempt(gate, second), { accepted: true, runs: 1 });
  assert.equal(gate.cancelPreparation(first), false, 'an old permission cancels nothing');
  assert.equal(gate.state(), 'preparing');

  // Authentication loss retires it at once.
  source.say('ending', 'S1');
  assert.equal(gate.state(), 'ending');
  assert.deepEqual(attempt(gate, second), { accepted: false, runs: 0 });
  assert.equal(gate.cancelPreparation(second), false, 'an ended session is not reopened by cancelling the preparation');
  assert.equal(gate.prepare({ snapshot: {} }), null, 'no preparation starts outside work');
  assert.equal(gate.state(), 'ending');
});

test('GATE-08 the end of the session is final for the document: no late notice, cleared record or second identity reopens it', () => {
  for (const closed of ['ending', 'unconfirmed', 'confirmed']) {
    const { gate, source } = activeGate();
    gate.select('A');
    const before = SCOPES.map(scope => gate.capture(scope));
    source.say(closed, 'S1');
    assert.equal(gate.state(), closed);
    for (const context of before) assert.deepEqual(attempt(gate, context), { accepted: false, runs: 0 });
    for (const scope of SCOPES) assert.deepEqual(attempt(gate, gate.capture(scope)), { accepted: false, runs: 0 });
    // The same session announced active again (a delayed completion), and another login: neither reopens work, and the
    // closed state the notices speak of stays what it was.
    source.say('active', 'S1');
    assert.equal(gate.state(), closed);
    source.say('active', 'S2');
    assert.equal(gate.state(), closed);
    assert.equal(gate.session(), 'S1');
    for (const scope of SCOPES) assert.deepEqual(attempt(gate, gate.capture(scope)), { accepted: false, runs: 0 });
    source.say('unknown');
    assert.equal(gate.state(), 'unknown');
    for (const context of before) assert.deepEqual(attempt(gate, context), { accepted: false, runs: 0 });
    for (const scope of SCOPES) assert.deepEqual(attempt(gate, gate.capture(scope)), { accepted: false, runs: 0 });
  }
});

test('GATE-08 a replacement login never runs the old session\'s effects nor adopts the new identity in this document', () => {
  const { gate, source } = activeGate('S1');
  gate.select('A');
  const old = SCOPES.map(scope => gate.capture(scope));
  source.say('active', 'S2');
  assert.equal(gate.state(), 'unknown', 'a document takes one identity only');
  assert.equal(gate.session(), null);
  for (const context of old) assert.deepEqual(attempt(gate, context), { accepted: false, runs: 0 });
  for (const scope of SCOPES) assert.deepEqual(attempt(gate, gate.capture(scope)), { accepted: false, runs: 0 });
});

test('GATE-09 lifecycle work (the closed document\'s own notices) follows the session and epoch, never opens work', () => {
  const gate = KinWorkContext.create(), source = authority();
  gate.follow(source);
  assert.throws(() => gate.follow(source), /already follows/);
  const landing = gate.capture('lifecycle');
  assert.deepEqual(attempt(gate, landing), { accepted: true, runs: 1 });
  source.say('active', 'S1');
  assert.deepEqual(attempt(gate, landing), { accepted: false, runs: 0 }, 'the entry changed what the notice was about');
  const whileActive = gate.capture('lifecycle');
  source.say('ending', 'S1');
  assert.deepEqual(attempt(gate, whileActive), { accepted: false, runs: 0 });
  // The result of the same end (requested -> unconfirmed -> requested again -> confirmed) keeps the closed notices going.
  const closing = gate.capture('lifecycle');
  source.say('unconfirmed', 'S1');
  source.say('ending', 'S1');
  source.say('confirmed', 'S1');
  assert.equal(gate.state(), 'confirmed');
  assert.deepEqual(attempt(gate, closing), { accepted: true, runs: 1 });
  assert.deepEqual(attempt(gate, gate.capture('document')), { accepted: false, runs: 0 });
});

test('GATE-09 every invalidating transition is announced synchronously with the state it led to', () => {
  const { gate, source } = activeGate();
  const seen = [];
  const stop = gate.onInvalidate(event => seen.push([event.reason, event.state]));
  gate.select('A');
  gate.edited();
  const preparation = gate.prepare({ snapshot: {} });
  gate.cancelPreparation(preparation);
  source.say('ending', 'S1');
  source.say('confirmed', 'S1');
  stop();
  source.say('unknown');
  assert.deepEqual(seen, [['select', 'active'], ['edit', 'active'], ['prepare', 'preparing'], ['cancel', 'active'],
    ['lifecycle', 'ending'], ['lifecycle', 'confirmed']]);
});

// ── transport ──

/** A network the case answers by hand. An aborted request fails the way fetch does; a held body errors on abort. */
function network() {
  const calls = [];
  function fetch(url, init) {
    return new Promise((resolve, reject) => {
      const call = { url, init, headers: init.headers, aborted: false };
      const fail = () => { call.aborted = true; reject(new DOMException('aborted', 'AbortError')); };
      init.signal.addEventListener('abort', fail);
      call.answer = (status, body, headers = {}) => resolve(new Response(body === undefined ? null : JSON.stringify(body),
        { status, headers }));
      call.answerText = (status, text) => resolve(new Response(text, { status }));
      call.drop = () => reject(new TypeError('fetch failed'));
      // Headers now, the body when the case says (or never): reading it fails on abort as a real fetch body does.
      call.headersThenBody = (status) => {
        let controller;
        const body = new ReadableStream({ start(c) {
          controller = c;
          init.signal.addEventListener('abort', () => { call.aborted = true; try { c.error(new DOMException('aborted', 'AbortError')); } catch (_) {} });
        } });
        resolve(new Response(body, { status }));
        return { push: text => controller.enqueue(new TextEncoder().encode(text)), close: () => controller.close(),
          fail: () => controller.error(new TypeError('SYN body stream failed')) };
      };
      calls.push(call);
    });
  }
  return { calls, fetch };
}

function wired(session = 'S1') {
  const { gate, source } = activeGate(session);
  const net = network(), failures = [];
  const transport = KinSessionTransport.create({ gate, fetch: net.fetch, authFailure: failed => failures.push(failed) });
  return { gate, source, net, failures, transport };
}

test('SEND-01 every request carries the session its work was captured under, and the CSRF header', async () => {
  const { gate, net, transport } = wired('S1');
  const context = gate.capture('document');
  const done = transport.request('/api/studies', { context });
  assert.equal(net.calls.length, 1);
  assert.equal(net.calls[0].headers['X-KIN-Session'], 'S1');
  assert.equal(net.calls[0].headers['X-KIN-CSRF'], '1');
  net.calls[0].answer(200, { studies: [] });
  const answer = await done;
  assert.deepEqual({ ok: answer.ok, status: answer.status, body: answer.body, auth: answer.auth, incomplete: answer.incomplete },
    { ok: true, status: 200, body: { studies: [] }, auth: false, incomplete: false });

  // A retry of the same operation keeps the identity it was issued with.
  const again = transport.request('/api/studies', { context, method: 'PUT', json: { a: 1 }, headers: { 'X-KIN-Session': 'forged' } });
  assert.equal(net.calls[1].headers['X-KIN-Session'], 'S1', 'a caller header cannot replace the captured session');
  assert.equal(net.calls[1].init.method, 'PUT');
  assert.equal(net.calls[1].init.body, '{"a":1}');
  assert.equal(net.calls[1].headers['Content-Type'], 'application/json');
  net.calls[1].answer(200, {});
  await again;
  assert.equal(transport.pending(), 0);
});

test('SEND-02 nothing is sent for a context that is not admitted, or without a session to bind', async () => {
  const { gate, source, net, transport } = wired();
  gate.select('A');
  const study = gate.capture('study');
  gate.select('B');
  await assert.rejects(transport.request('/api/x', { context: study }), error => error.transport === 'not-admitted' && error.sent === false);
  await assert.rejects(transport.request('/api/x', {}), error => error.transport === 'not-admitted');
  await assert.rejects(transport.request('/api/x', { context: { ...gate.capture('document') } }), error => error.transport === 'not-admitted');

  // During a preparation only the preparation's own context sends.
  const ordinary = gate.capture('document');
  const preparation = gate.prepare({ snapshot: { findings: 'F' } });
  await assert.rejects(transport.request('/api/x', { context: ordinary }), error => error.transport === 'not-admitted');
  await assert.rejects(transport.request('/api/x', { context: gate.capture('document') }), error => error.transport === 'not-admitted');
  assert.equal(net.calls.length, 0);
  const save = transport.request('/api/studies/A/report', { context: preparation, method: 'PUT', json: preparation.snapshot });
  assert.equal(net.calls.length, 1);
  net.calls[0].answer(200, {});
  await save;
  gate.cancelPreparation(preparation);
  await assert.rejects(transport.request('/api/studies/A/report', { context: preparation, method: 'PUT', json: {} }),
    error => error.transport === 'not-admitted', 'a retired preparation sends nothing');

  // A document with no session has nothing to bind: its lifecycle context is admitted, the request is still refused.
  const anonymous = KinWorkContext.create();
  anonymous.follow(authority());
  const other = network();
  const unbound = KinSessionTransport.create({ gate: anonymous, fetch: other.fetch });
  await assert.rejects(unbound.request('/api/me', { context: anonymous.capture('lifecycle') }),
    error => error.transport === 'unbound' && error.sent === false);
  assert.equal(other.calls.length, 0);
  source.say('confirmed', 'S1');
  await assert.rejects(transport.request('/api/x', { context: gate.capture('document') }), error => error.transport === 'not-admitted');
  assert.equal(net.calls.length, 1);
});

test('SEND-03 one deadline covers the headers and the body', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { gate, net, transport } = wired();
  // No headers within the limit.
  const slow = transport.request('/api/slow', { context: gate.capture('document') });
  const slowSeen = assert.rejects(slow, error => error.transport === 'timeout' && error.name === 'TimeoutError' && error.sent === true);
  t.mock.timers.tick(9999);
  await settle();
  assert.equal(net.calls[0].aborted, false);
  t.mock.timers.tick(1);
  await slowSeen;
  assert.equal(net.calls[0].aborted, true);

  // Headers at once, the body never: the same clock is still running.
  const held = transport.request('/api/held', { context: gate.capture('document') });
  const heldSeen = assert.rejects(held, error => error.transport === 'timeout');
  net.calls[1].headersThenBody(200);
  await settle();
  t.mock.timers.tick(9999);
  await settle();
  assert.equal(net.calls[1].aborted, false);
  t.mock.timers.tick(1);
  await heldSeen;
  assert.equal(net.calls[1].aborted, true);

  // An answered request leaves no clock behind: a later tick aborts nothing.
  const quick = transport.request('/api/quick', { context: gate.capture('document') });
  net.calls[2].answer(200, { ok: true });
  await quick;
  t.mock.timers.tick(20000);
  assert.equal(net.calls[2].aborted, false);
  assert.equal(transport.pending(), 0);
});

test('SEND-04 a read whose context went stale is aborted; a write is not, and the gate refuses its late effect', async () => {
  for (const transition of ['select', 'prepare', 'end']) {
    const { gate, source, net, transport } = wired();
    gate.select('A');
    const context = gate.capture('study');
    const read = transport.request('/api/studies/A/report', { context });
    const write = transport.request('/api/studies/A/report', { context, method: 'PUT', json: { findings: 'F' } });
    const readSeen = assert.rejects(read, error => error.transport === 'stale' && error.name === 'AbortError' && error.sent === true);
    if (transition === 'select') gate.select('B');
    if (transition === 'prepare') gate.prepare({ snapshot: {} });
    if (transition === 'end') source.say('ending', 'S1');
    await readSeen;
    assert.equal(net.calls[0].aborted, true, transition);
    assert.equal(net.calls[1].aborted, false, 'the write may already have happened on the server; it is not cut');
    net.calls[1].answer(200, { stored: true });
    const answer = await write;
    assert.equal(answer.ok, true);
    let applied = 0;
    assert.equal(gate.commit(context, () => { applied += 1; }), false, transition);
    assert.equal(applied, 0);
  }
});

test('SEND-05 the caller can cancel, before the request leaves and while it is out', async () => {
  const { gate, net, transport } = wired();
  const early = new AbortController();
  early.abort();
  await assert.rejects(transport.request('/api/x', { context: gate.capture('document'), signal: early.signal }),
    error => error.transport === 'cancelled' && error.sent === false);
  assert.equal(net.calls.length, 0);
  const control = new AbortController();
  const out = transport.request('/api/x', { context: gate.capture('document'), signal: control.signal });
  control.abort();
  await assert.rejects(out, error => error.transport === 'cancelled' && error.sent === true);
  assert.equal(net.calls[0].aborted, true);
  const dropped = transport.request('/api/x', { context: gate.capture('document') });
  net.calls[1].drop();
  await assert.rejects(dropped, error => error.transport === 'network' && error.sent === true);
  assert.equal(transport.pending(), 0);
});

test('SEND-06 authentication failures are reported for the session the request carried', async () => {
  const { gate, source, net, failures, transport } = wired('S1');
  const context = gate.capture('document');
  const cases = [
    [401, { code: 'AUTH_SESSION_ENDED' }, {}, { session: 'S1', status: 401, code: 'AUTH_SESSION_ENDED' }],
    [401, { code: 'AUTH_CREDENTIALS_MISSING' }, {}, { session: 'S1', status: 401, code: 'AUTH_CREDENTIALS_MISSING' }],
    [401, { message: 'SYN token rejected' }, {}, { session: 'S1', status: 401, code: null }],
    [409, { code: 'AUTH_SESSION_MISMATCH' }, {}, { session: 'S1', status: 409, code: 'AUTH_SESSION_MISMATCH' }],
    [428, { code: 'AUTH_SESSION_REQUIRED' }, {}, { session: 'S1', status: 428, code: 'AUTH_SESSION_REQUIRED' }],
    // nginx's auth_request answers the protected DICOM locations: the code is a header there.
    [403, undefined, { 'X-KIN-Auth-Code': 'AUTH_SESSION_MISMATCH' }, { session: 'S1', status: 403, code: 'AUTH_SESSION_MISMATCH' }],
    [401, undefined, { 'X-KIN-Auth-Code': 'AUTH_SESSION_ENDED' }, { session: 'S1', status: 401, code: 'AUTH_SESSION_ENDED' }],
  ];
  for (const [status, body, headers, expected] of cases) {
    const pending = transport.request('/dicom-web/studies', { context, method: 'POST', json: {} });
    net.calls.at(-1).answer(status, body, headers);
    const answer = await pending;
    assert.equal(answer.auth, true, JSON.stringify(expected));
    assert.equal(answer.ok, false);
    assert.deepEqual(failures.pop(), expected);
  }
  // Not authentication failures: an ordinary access refusal, a business conflict, a server error.
  for (const [status, body] of [[403, { code: 'STUDY_FORBIDDEN' }], [403, undefined], [409, { code: 'REPORT_DRAFT_CONFLICT' }],
    [409, { code: 'REPORT_HELD', holder: 'x' }], [500, { code: 'AUTH_STORAGE_FAILURE' }], [404, undefined]]) {
    const pending = transport.request('/api/x', { context, method: 'POST', json: {} });
    net.calls.at(-1).answer(status, body);
    const answer = await pending;
    assert.equal(answer.auth, false, `${status} ${JSON.stringify(body)}`);
    assert.equal(answer.code, body?.code ?? null);
    assert.deepEqual(answer.body, body ?? null);
  }
  assert.deepEqual(failures, []);

  // A 401 that arrives after this document's session ended is still the old request's: it names S1, nothing else.
  const late = transport.request('/api/x', { context, method: 'POST', json: {} });
  source.say('confirmed', 'S1');
  net.calls.at(-1).answer(401, { code: 'AUTH_SESSION_ENDED' });
  await late;
  assert.deepEqual(failures, [{ session: 'S1', status: 401, code: 'AUTH_SESSION_ENDED' }]);
});

test('SEND-07 an explicit operation binding is carried and blamed instead of the document session', async () => {
  // A closed document's recovery, started by the person, binds the session it was given for that one operation.
  const { gate, source, net, failures, transport } = wired('S1');
  source.say('confirmed', 'S1');
  const context = gate.capture('lifecycle');
  const pending = transport.request('/api/studies/A/report', { context, session: 'S2', method: 'PUT', json: {} });
  assert.equal(net.calls[0].headers['X-KIN-Session'], 'S2');
  net.calls[0].answer(401, { code: 'AUTH_SESSION_ENDED' });
  await pending;
  assert.deepEqual(failures, [{ session: 'S2', status: 401, code: 'AUTH_SESSION_ENDED' }]);
  await assert.rejects(transport.request('/api/x', { context, session: '' }), error => error.transport === 'unbound');
});

test('SEND-08 a success body that cannot be read is not a success envelope', async () => {
  const { gate, net, transport } = wired();
  const context = gate.capture('document');
  const broken = transport.request('/api/x', { context });
  net.calls[0].answerText(200, '{"revision": "r2", "snapsh');
  const answer = await broken;
  assert.deepEqual({ ok: answer.ok, body: answer.body, incomplete: answer.incomplete }, { ok: true, body: null, incomplete: true });
  const empty = transport.request('/api/x', { context });
  net.calls[1].answerText(200, '');
  assert.deepEqual({ ...(await empty), headers: null }, { ok: true, status: 200, code: null, body: null, headers: null, auth: false, incomplete: false });
  // The connection dies while the body is read: that is a transport failure, not an answer.
  const cut = transport.request('/api/x', { context });
  const body = net.calls[2].headersThenBody(200);
  await settle();
  body.push('{"rev');
  body.fail();
  await assert.rejects(cut, error => error.transport === 'network' && error.sent === true);
  const text = transport.request('/api/x', { context, read: 'text' });
  net.calls[3].answerText(200, 'plain');
  assert.equal((await text).body, 'plain');
  await assert.rejects(transport.request('/api/x', { context, read: 'everything' }), TypeError);
});

test('SEND-09 a stream is read chunk by chunk under the same clock and the same staleness rule', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { gate, net, transport } = wired();
  gate.select('A');
  const context = gate.capture('study');
  const opening = transport.request('/dicom-web/studies/A/series', { context, read: 'stream', deadlineMs: 30000 });
  const body = net.calls[0].headersThenBody(200);
  const answer = await opening;
  assert.equal(transport.pending(), 1, 'the operation is open until its stream ends');
  body.push('one');
  assert.equal(new TextDecoder().decode((await answer.stream.read()).value), 'one');
  // Between two chunks the study changes: the read is cut, and what was decoded so far has no gate to pass.
  const next = answer.stream.read();
  const nextSeen = assert.rejects(next, error => error.transport === 'stale');
  gate.select('B');
  await nextSeen;
  assert.equal(net.calls[0].aborted, true);
  assert.equal(transport.pending(), 0);
  assert.equal(gate.commit(context, () => { throw new Error('a stale chunk was applied'); }), false);

  // Read to the end: the clock is released; and a stream that outlives its deadline is cut.
  const whole = transport.request('/dicom-web/x', { context: gate.capture('study'), read: 'stream', deadlineMs: 30000 });
  const second = net.calls[1].headersThenBody(200);
  const stream = (await whole).stream;
  second.push('a');
  second.close();
  assert.equal((await stream.read()).done, false);
  assert.equal((await stream.read()).done, true);
  assert.equal(transport.pending(), 0);
  const long = transport.request('/dicom-web/y', { context: gate.capture('study'), read: 'stream', deadlineMs: 30000 });
  net.calls[2].headersThenBody(200);
  const third = (await long).stream;
  const cutSeen = assert.rejects(third.read(), error => error.transport === 'timeout');
  t.mock.timers.tick(30000);
  await cutSeen;
  // The consumer may stop early; that releases the operation too.
  const partial = transport.request('/dicom-web/z', { context: gate.capture('study'), read: 'stream', deadlineMs: 30000 });
  net.calls[3].headersThenBody(200);
  await (await partial).stream.cancel();
  assert.equal(transport.pending(), 0);
});

test('SEND-10 the answer is a value: reading it later cannot be turned into an apply by the transport', async () => {
  const { gate, source, net, transport } = wired();
  const context = gate.capture('document');
  const pending = transport.request('/api/x', { context, method: 'POST', json: {} });
  net.calls[0].answer(200, { ok: true });
  const answer = await pending;
  assert.ok(Object.isFrozen(answer));
  // The session ends between the answer and its use: the value is still there, the gate is what refuses the apply.
  source.say('ending', 'S1');
  assert.deepEqual(answer.body, { ok: true });
  assert.equal(gate.commit(context, () => { throw new Error('applied after the end'); }), false);
  assert.throws(() => KinSessionTransport.create({}), TypeError, 'a transport without a gate is not built');
});
