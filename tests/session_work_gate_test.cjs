// U5S-REQ-04/06/08/09/11/12/13/15/17 (with the 2026-10-04 amendments 1-9 and section 3) -> U5S-RISK-APPLY,
// U5S-RISK-SESSION, U5S-RISK-DRAFT, U5S-RISK-SUCCESS -> TEST-U5S-GATE.
//
// The shipped modules, loaded as they are: worklist-v0/hpacs-lite/work-context.js (the apply gate),
// session-transport.js (request admission, the captured X-KIN-Session, a deadline by request kind over headers and body,
// cancellation, session-end signals attributed to the request's session), report-draft-client.js (the one draft command
// path) and auth.js (the session authority, run in a browser-shaped context this file provides). Every case drives the
// public contract only and observes what an effect did, what reached the network, or what the document was told to do.
// Nothing asserts a source string or an internal name.
//
//   GATE-01..09  a stale effect never runs: before activation, across a preparation, its cancellation (a new work
//                epoch), the end of the session, a replacement login, study A -> B -> A and an edit; the preparation
//                context is the only thing that commits while preparing and is dead once it is cancelled, replaced or
//                the session ends; an effect cannot defer work (async, generator, returned promise).
//   GATE-10      the combinations (U5S-REQ-24): every kind of completion (before the headers, after the headers and
//                before the body, between stream chunks, after decoding and before the apply, a clipboard completion, the
//                error path, the finally path) x every transition (preparation, its cancellation, the end, a replacement
//                login, a selection change, A -> B -> A, an edit) x both completion orders of two operations.
//   SEND-01..14  a request leaves only for an admitted context and always carries that context's session; the deadline
//                is the request kind's (draft 10 s, other API 60 s, media only what the caller gives) and covers headers
//                and body; a read whose context went stale is aborted, a write is not; only the server's word that the
//                session ended or was replaced is reported as a session-end signal - any other 401/403/409/428/5xx is
//                that request's failure.
//   DRAFT-01..11 the draft command path: owner + revision + whole snapshot on every command; saved only on a matching
//                envelope or a full read that shows the whole snapshot; a conflict or an unknown outcome is checked by
//                one automatic read before anyone is asked; a write is re-sent by itself only when what the server holds
//                is this document's own text (never after an unknown outcome, never over another draft, a deletion or a
//                new epoch); queued saves of one document merge.
//   DRAFT-13..14 (closure audit 2026-10-05) a write that waited behind another command asks its caller for the text at
//                its turn, after the caller heard of that command, and sends nothing when there is none; a discard whose
//                answer was lost is confirmed by one read, a commit is left to the caller's read of the report.
//   AUTH-01..08  auth.js: entry (server-confirmed session, automatic login only when the server said there is no session
//                in a document with reliable storage and no end record, with a loop guard), the entry proof, which
//                answers close a document (session ended, session replaced) and which never do, session-bound notices
//                without rebroadcast, the preparation notices for viewer documents, one logout POST.
//
// Run with: node --test tests/session_work_gate_test.cjs
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test, mock } = require('node:test');
const vm = require('node:vm');

const lite = join(__dirname, '../worklist-v0/hpacs-lite');
const KinWorkContext = require(join(lite, 'work-context.js'));
const KinSessionTransport = require(join(lite, 'session-transport.js'));
const KinReportDraftClient = require(join(lite, 'report-draft-client.js'));

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
      call.headersThenBody = (status, headers = {}) => {
        let controller;
        const body = new ReadableStream({ start(c) {
          controller = c;
          init.signal.addEventListener('abort', () => { call.aborted = true; try { c.error(new DOMException('aborted', 'AbortError')); } catch (_) {} });
        } });
        resolve(new Response(body, { status, headers }));
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
  assert.equal(new Headers(net.calls[0].headers).get('X-KIN-Session'), 'S1');
  assert.equal(new Headers(net.calls[0].headers).get('X-KIN-CSRF'), '1');
  net.calls[0].answer(200, { studies: [] });
  const answer = await done;
  assert.deepEqual({ ok: answer.ok, status: answer.status, body: answer.body, auth: answer.auth, incomplete: answer.incomplete },
    { ok: true, status: 200, body: { studies: [] }, auth: false, incomplete: false });

  // A retry of the same operation keeps the identity it was issued with.
  const again = transport.request('/api/studies', { context, method: 'PUT', json: { a: 1 }, headers: { 'X-KIN-Session': 'forged' } });
  assert.equal(new Headers(net.calls[1].headers).get('X-KIN-Session'), 'S1', 'a caller header cannot replace the captured session');
  assert.equal(net.calls[1].init.method, 'PUT');
  assert.equal(net.calls[1].init.body, '{"a":1}');
  assert.equal(new Headers(net.calls[1].headers).get('Content-Type'), 'application/json');
  net.calls[1].answer(200, {});
  await again;
  assert.equal(transport.pending(), 0);
});

for (const [name, given] of [
  ['Headers', () => new Headers({ Accept: 'multipart/related', 'Content-Type': 'application/dicom+json' })],
  ['pairs', () => [['Accept', 'multipart/related'], ['Content-Type', 'application/dicom+json']]],
  ['lower-case bindings', () => ({ Accept: 'multipart/related', 'Content-Type': 'application/dicom+json',
    'x-kin-session': 'forged', 'x-kin-csrf': 'forged' })],
]) test('SEND-12 caller ' + name + ' keep media headers and cannot override or duplicate binding', async () => {
  const { gate, net, transport } = wired('S1');
  for (const read of ['request', 'fetch']) {
    const done = read === 'fetch' ? transport.fetch('/dicom-web/studies', { headers: given() })
      : transport.request('/api/studies', { context: gate.capture('document'), headers: given() });
    const call = net.calls.at(-1), headers = new Headers(call.init.headers);
    assert.equal(headers.get('Accept'), 'multipart/related');
    assert.equal(headers.get('Content-Type'), 'application/dicom+json');
    assert.equal(headers.get('X-KIN-Session'), 'S1');
    assert.equal(headers.get('X-KIN-CSRF'), '1');
    assert.equal(headers.has('0'), false);
    call.answer(200, {});
    await done;
  }
  const json = transport.request('/api/write', { context: gate.capture('document'), method: 'POST', headers: given(), json: { value: 1 } });
  assert.equal(new Headers(net.calls.at(-1).init.headers).get('Content-Type'), 'application/json');
  net.calls.at(-1).answer(200, {});
  await json;
});

test('SEND-13 an authenticated end in headers is reported before a held error body, exactly once', async () => {
  const { gate, net, failures, transport } = wired('S1');
  const done = transport.request('/api/studies', { context: gate.capture('document') });
  const body = net.calls[0].headersThenBody(401, { 'X-KIN-Auth-Code': 'AUTH_SESSION_ENDED' });
  await new Promise(setImmediate);
  assert.deepEqual(failures, [{ session: 'S1', status: 401, code: 'AUTH_SESSION_ENDED' }]);
  body.push('{"code":"AUTH_SESSION_ENDED"}'); body.close();
  assert.equal((await done).auth, true);
  assert.equal(failures.length, 1);
});

test('SEND-14 Fetch policy survives binding, including redirect rejection on uploads', async () => {
  for (const method of ['request', 'fetch']) {
    const { gate, net, transport } = wired('S1');
    const policy = { redirect: 'error', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store',
      referrer: 'https://kin.test/worklist', referrerPolicy: 'no-referrer', integrity: 'sha256-synthetic',
      priority: 'high', keepalive: false, duplex: 'half' };
    const outer = new AbortController();
    const done = transport[method]('/api/dictation', { ...policy, context: gate.capture('document'),
      method: 'POST', body: new Blob(['synthetic audio']), signal: outer.signal });
    const call = net.calls[0];
    for (const [key, value] of Object.entries(policy)) assert.equal(call.init[key], value, key);
    assert.equal(call.init.method, 'POST');
    assert.equal(await call.init.body.text(), 'synthetic audio');
    assert.notEqual(call.init.signal, outer.signal);
    assert.equal(new Headers(call.init.headers).get('X-KIN-Session'), 'S1');
    call.drop();
    await assert.rejects(done, error => error.transport === 'network');
  }
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
  const { gate, net, transport: any } = wired();
  // A draft command's limit (10 s) is used here; SEND-11 covers which request gets which limit.
  const transport = { request: (url, init) => any.request(url, { ...init, kind: 'draft' }), pending: () => any.pending() };
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

test('SEND-06 only the server\'s word that the session ended or was replaced is a session-end signal', async () => {
  const { gate, source, net, failures, transport } = wired('S1');
  const context = gate.capture('document');
  const cases = [
    [401, { code: 'AUTH_SESSION_ENDED' }, {}, { session: 'S1', status: 401, code: 'AUTH_SESSION_ENDED' }],
    [409, { code: 'AUTH_SESSION_MISMATCH' }, {}, { session: 'S1', status: 409, code: 'AUTH_SESSION_MISMATCH' }],
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
  // One request's failure, never a session-end signal: a 401 that names no ended session (no code, no credentials), a
  // missing binding (428, or nginx's 403 for it), a busy session, a CSRF refusal, an ordinary access refusal, a business
  // conflict, a server error. Nothing is reported, and the answer keeps its status and code for the caller to show.
  for (const [status, body, headers] of [[401, { message: 'SYN token rejected' }, {}], [401, { code: 'AUTH_CREDENTIALS_MISSING' }, {}],
    [401, undefined, { 'X-KIN-Auth-Code': 'AUTH_CREDENTIALS_MISSING' }], [428, { code: 'AUTH_SESSION_REQUIRED' }, {}],
    [403, undefined, { 'X-KIN-Auth-Code': 'AUTH_SESSION_REQUIRED' }], [409, { code: 'AUTH_SESSION_BUSY' }, {}],
    [403, { code: 'AUTH_CSRF_REQUIRED' }, {}], [403, { code: 'STUDY_FORBIDDEN' }, {}], [403, undefined, {}],
    [409, { code: 'REPORT_DRAFT_CONFLICT' }, {}], [409, { code: 'REPORT_DRAFT_OWNER_CHANGED' }, {}],
    [409, { code: 'REPORT_HELD', holder: 'x' }, {}], [500, { code: 'AUTH_STORAGE_FAILURE' }, {}], [503, undefined, {}],
    [404, undefined, {}]]) {
    const pending = transport.request('/api/x', { context, method: 'POST', json: {} });
    net.calls.at(-1).answer(status, body, headers);
    const answer = await pending;
    assert.equal(answer.auth, false, `${status} ${JSON.stringify(body)} ${JSON.stringify(headers)}`);
    assert.equal(answer.status, status);
    assert.equal(answer.code, headers['X-KIN-Auth-Code'] ?? body?.code ?? null);
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
  assert.equal(new Headers(net.calls[0].headers).get('X-KIN-Session'), 'S2');
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

test('SEND-11 the deadline is the request kind\'s: a draft command 10 s, other API work 60 s, media only what the caller gives', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { gate, net, transport } = wired();
  const context = gate.capture('document');
  const out = (url, init = {}) => {
    const pending = transport.request(url, { context, ...init });
    pending.catch(() => {});
    return net.calls.at(-1);
  };
  const draft = out('/api/studies/A/report', { method: 'PUT', json: {}, kind: 'draft' });
  const list = out('/api/studies');
  const absolute = out('https://kin.test/api/prefs');
  const dicom = out('/dicom-web/studies/A/instances');
  const image = out('/instances/abc/preview', { read: 'blob' });
  const stream = out('/api/dictation/stream', { read: 'stream' });
  const bounded = out('/instances/abc/preview', { read: 'blob', deadlineMs: 30000 });
  const state = () => [draft, list, absolute, dicom, image, stream, bounded].map(call => call.aborted);
  t.mock.timers.tick(9999);
  assert.deepEqual(state(), [false, false, false, false, false, false, false]);
  t.mock.timers.tick(1);
  assert.deepEqual(state(), [true, false, false, false, false, false, false], 'only the draft command is cut at 10 s');
  t.mock.timers.tick(20000);
  assert.deepEqual(state(), [true, false, false, false, false, false, true], 'the caller\'s own limit for an image');
  t.mock.timers.tick(30000);
  assert.deepEqual(state(), [true, true, true, false, false, false, true], 'other API work is cut at 60 s');
  t.mock.timers.tick(3600000);
  assert.deepEqual(state(), [true, true, true, false, false, false, true], 'DICOM, image and stream requests carry no blanket limit');
  await assert.rejects(transport.request('/api/x', { context, kind: 'everything' }), TypeError);
  assert.deepEqual(KinSessionTransport.DEADLINES, { draft: 10000, api: 60000, media: 0 });
  for (const call of [dicom, image, stream]) call.drop();
  await settle();
});

// ── the combinations (U5S-REQ-24) ──

/** The transitions that can fall between the start of an operation and its completion. */
const TRANSITIONS = {
  prepare: ({ gate }) => { gate.prepare({ snapshot: {} }); },
  cancel: ({ gate }) => { gate.cancelPreparation(gate.prepare({ snapshot: {} })); },
  end: ({ source }) => { source.say('ending', 'S1'); },
  'login replacement': ({ source }) => { source.say('active', 'S2'); },
  'select B': ({ gate }) => { gate.select('B'); },
  'A -> B -> A': ({ gate }) => { gate.select('B'); gate.select('A'); },
  edit: ({ gate }) => { gate.edited(); },
  none: () => {},
};
/** Which scopes a transition leaves standing. Everything else must never apply. */
const SURVIVES = {
  prepare: [], cancel: [], end: [], 'login replacement': [],
  'select B': ['document'], 'A -> B -> A': ['document'], edit: ['document', 'study'], none: ['document', 'study', 'editor'],
};

/**
 * One operation of a consumer, written the way gate-api.md section 4 tells consumers to write it: capture when the work
 * starts, pass every continuation through commit. `cut` is where the transition falls. Returns what was applied.
 */
function operation(world, scope, cut, name, applied) {
  const { gate, net, transport } = world;
  const at = gate.capture(scope);
  const apply = what => gate.commit(at, () => { applied.push(`${name}:${what}`); });
  const steps = { release: null };
  const done = (async () => {
    try {
      if (cut === 'clipboard') {
        // Not a request at all: a clipboard promise (or a decoder) completing later.
        await new Promise(resolve => { steps.release = resolve; });
        apply('clipboard');
        return;
      }
      const pending = transport.request('/api/work', { context: at, method: 'POST', json: {},
        ...(cut === 'stream' ? { read: 'stream' } : {}) });
      const call = net.calls.at(-1);
      if (cut === 'headers') steps.release = () => call.answer(200, { ok: true });
      else if (cut === 'error' || cut === 'finally') steps.release = () => call.drop();
      else if (cut === 'body' || cut === 'stream') {
        const body = call.headersThenBody(200);
        steps.release = () => { body.push('{"ok":true}'); body.close(); };
        if (cut === 'stream') {
          const opened = await pending;
          body.push('first');
          await opened.stream.read();
          apply('chunk');
          steps.release = () => { body.push('second'); body.close(); };
          await opened.stream.read();
          apply('chunk after the cut');
          return;
        }
      } else if (cut === 'decoded') {
        call.answer(200, { ok: true });
        const answer = await pending;
        // The body is in hand; the decode (a later task) is what completes after the transition.
        await new Promise(resolve => { steps.release = resolve; });
        apply('decoded ' + answer.status);
        return;
      }
      await pending;
      apply('answer');
    } catch (error) {
      apply('error');
    } finally {
      if (cut === 'finally') apply('finally');
    }
  })();
  return { done, steps };
}

test('GATE-10 no kind of completion applies across a transition that staled its context, in either completion order', async () => {
  const cuts = ['headers', 'body', 'stream', 'decoded', 'clipboard', 'error', 'finally'];
  let combinations = 0;
  for (const cut of cuts) for (const [transition, change] of Object.entries(TRANSITIONS)) for (const scope of SCOPES)
    for (const order of ['first then second', 'second then first']) {
      const world = wired('S1');
      world.gate.select('A');
      const applied = [];
      const first = operation(world, scope, cut, 'first', applied);
      const second = operation(world, scope, cut, 'second', applied);
      await settle();
      await settle();
      const before = applied.splice(0);
      change(world);
      for (const one of order === 'first then second' ? [first, second] : [second, first]) {
        one.steps.release();
        await settle();
      }
      await Promise.all([first.done, second.done]);
      const label = `${cut} / ${transition} / ${scope} / ${order}`;
      if (SURVIVES[transition].includes(scope)) {
        // A write is not cut by staleness and nothing staled it: both operations complete and apply once each.
        const names = applied.map(entry => entry.split(':')[0]).sort();
        assert.deepEqual([...new Set(names)], ['first', 'second'], label);
      } else {
        assert.deepEqual(applied, [], label);
      }
      // What was applied before the transition (a stream's first chunk) was applied under the live context.
      assert.ok(before.every(entry => entry.endsWith(':chunk')), label);
      combinations += 1;
    }
  assert.equal(combinations, cuts.length * Object.keys(TRANSITIONS).length * SCOPES.length * 2);
});

// ── the draft command path (report-draft-client.js) ──

const OWNER = { institution: 'SYN-INST', sub: 'SYN-SUB', author: 'syn@synthetic.test' };
const TEXT = (findings, extra = {}) => ({ findings, conclusion: '', recommendation: '', baseVersion: 0, ...extra });

/** The server's side of one study's draft row, as wire-contract.md section 5 says it answers. */
function draftServer() {
  const server = { epoch: 'E1', rev: 0, row: null, owner: OWNER, puts: 0, reads: 0, commits: 0, discards: 0, cid: 0,
    revision: () => `${server.epoch}:${server.rev}`,
    envelope: () => ({ uid: 'A', owner: server.owner, revision: server.revision(), present: !!server.row,
      snapshot: server.row ? { ...server.row } : null, updatedAt: server.row ? '2026-10-04T00:00:00.000Z' : null }),
    /** Applies the request to the stored row and returns [status, body] - what the server would answer. */
    apply(call) {
      const method = call.init.method, body = call.init.body ? JSON.parse(call.init.body) : null;
      if (method === 'GET') { server.reads += 1; return [200, server.envelope()]; }
      if (JSON.stringify(body.expectedOwner) !== JSON.stringify(server.owner)) return [409, { code: 'REPORT_DRAFT_OWNER_CHANGED' }];
      if (body.expectedRevision !== server.revision()) return [409, { code: 'REPORT_DRAFT_CONFLICT' }];
      server.rev += 1;
      if (method === 'PUT') {
        server.puts += 1;
        const empty = !body.findings && !body.conclusion && !body.recommendation;
        const citations = [...body.citationIds];
        if (body.insert) citations.push(`cid-${++server.cid}`);
        server.row = empty ? null : { findings: body.findings, conclusion: body.conclusion, recommendation: body.recommendation,
          baseVersion: body.baseVersion, citations, structured: [...body.structureIds] };
        return [200, { ...server.envelope(), ...(body.insert ? { inserted: { cid: `cid-${server.cid}` } } : {}) }];
      }
      if (method === 'DELETE') server.discards += 1; else server.commits += 1;
      server.row = null;
      return [200, { ...server.envelope(), state: { rs: 'T', draft: null, draftRevision: server.revision() } }];
    },
    answer(call) { call.answer(...server.apply(call)); },
    /** The server stores the write; its answer reaches nobody. */
    lose(call) { server.apply(call); call.drop(); },
    /** Another document of the same reader writes first. */
    other(findings) { server.rev += 1; server.row = { ...TEXT(findings), citations: [], structured: [] }; },
  };
  return server;
}

function drafting() {
  const world = wired('S1');
  const server = draftServer();
  const client = KinReportDraftClient.create({ transport: world.transport, base: '/api' });
  client.observe('A', server.revision(), null);
  const at = () => world.gate.capture('document');
  /** Answers every request that is out, as the server would, until the given promise settles. */
  const serve = async promise => {
    let result, settled = false;
    promise.then(value => { result = value; settled = true; }, error => { result = error; settled = true; });
    for (let turn = 0; !settled && turn < 50; turn += 1) {
      await settle();
      for (const call of world.net.calls) if (!call.done) { call.done = true; server.answer(call); }
    }
    assert.ok(settled, 'the command settled');
    return result;
  };
  const next = async () => {
    for (let turn = 0; turn < 20; turn += 1) {
      const call = world.net.calls.find(one => !one.done);
      if (call) { call.done = true; return call; }
      await settle();
    }
    throw new Error('no request left the document');
  };
  return { ...world, server, client, at, serve, next };
}

test('DRAFT-01 every write carries the owner, the revision it stands on and the whole snapshot; saved only on a matching envelope', async () => {
  const { server, client, at, serve, net } = drafting();
  const saved = await serve(client.write('A', TEXT('SYN one'), { owner: OWNER, context: at() }));
  assert.equal(saved.outcome, 'saved');
  // The first command reads the stored draft once (the keep lists), then writes.
  assert.deepEqual(net.calls.map(call => call.init.method), ['GET', 'PUT']);
  assert.deepEqual(JSON.parse(net.calls[1].init.body), { expectedOwner: OWNER, expectedRevision: 'E1:0', findings: 'SYN one',
    conclusion: '', recommendation: '', baseVersion: 0, citationIds: [], structureIds: [] });
  assert.equal(new Headers(net.calls[1].headers).get('X-KIN-Session'), 'S1');
  assert.equal(client.revision('A'), 'E1:1');
  // The next write stands on the revision the first one made, without another read.
  const again = await serve(client.write('A', TEXT('SYN two'), { owner: OWNER, context: at() }));
  assert.equal(again.outcome, 'saved');
  assert.equal(JSON.parse(net.calls[2].init.body).expectedRevision, 'E1:1');
  assert.equal(net.calls.length, 3);
  assert.deepEqual(server.row.findings, 'SYN two');
});

test('DRAFT-02 a lost answer, a partial envelope or a 504: one automatic read decides - stored means saved, with no second write', async () => {
  for (const loss of ['the answer is lost', 'a 200 without the envelope', 'the proxy answers 504 after the server stored it']) {
    const { server, client, at, serve, next } = drafting();
    const writing = client.write('A', TEXT('SYN typed'), { owner: OWNER, context: at() });
    server.answer(await next());                       // the keep-list read
    const put = await next();
    if (loss === 'the answer is lost') server.lose(put);
    else { server.apply(put); put.answer(loss.startsWith('a 200') ? 200 : 504, loss.startsWith('a 200') ? { ok: true } : undefined); }
    const result = await serve(writing);
    assert.equal(result.outcome, 'saved', loss);
    assert.equal(result.confirmedByRead, true, loss);
    assert.equal(server.puts, 1, 'the write was not sent again');
    assert.equal(client.revision('A'), 'E1:1');
    assert.equal(client.uncertain('A'), false);
  }
});

test('DRAFT-03 an unknown outcome is never re-sent by itself; the next command reads the stored draft first', async () => {
  for (const reading of ['the read shows nothing stored', 'the read fails too']) {
    const { server, client, at, serve, next, net } = drafting();
    const writing = client.write('A', TEXT('SYN typed'), { owner: OWNER, context: at() });
    server.answer(await next());
    const put = await next();
    put.drop();                                        // the connection is cut; the server never had the write
    const confirm = await next();
    assert.equal(confirm.init.method, 'GET', 'the program reads before anyone is told');
    if (reading === 'the read fails too') confirm.drop(); else server.answer(confirm);
    const result = await writing;
    assert.equal(result.outcome, 'unknown', reading);
    assert.equal(server.puts, 0);
    await settle();
    assert.equal(net.calls.filter(call => call.init.method === 'PUT').length, 1, 'no write left by itself');
    assert.equal(client.uncertain('A'), true);
    // The next save: a read first, then one write of the newer text on the revision the read showed.
    const later = await serve(client.write('A', TEXT('SYN typed more'), { owner: OWNER, context: at() }));
    assert.equal(later.outcome, 'saved');
    assert.deepEqual(net.calls.slice(-2).map(call => call.init.method), ['GET', 'PUT']);
    assert.equal(server.row.findings, 'SYN typed more');
  }
});

test('DRAFT-04 another draft on the server is a conflict: the attempt is kept, nothing is re-sent, automatic writes stop until the person decides', async () => {
  const { server, client, at, serve, net } = drafting();
  await serve(client.write('A', TEXT('SYN mine'), { owner: OWNER, context: at() }));
  server.other('SYN the other tab');
  const lost = await serve(client.write('A', TEXT('SYN mine, more'), { owner: OWNER, context: at() }));
  assert.equal(lost.outcome, 'conflict');
  assert.equal(lost.latest.snapshot.findings, 'SYN the other tab', 'the stored draft was read for the person to see');
  assert.equal(lost.snapshot.findings, 'SYN mine, more', 'the attempt is kept');
  assert.equal(server.row.findings, 'SYN the other tab');
  const puts = net.calls.filter(call => call.init.method === 'PUT').length;
  // Automatic writes stop: the next ones do not reach the network.
  const calls = net.calls.length;
  assert.equal((await client.write('A', TEXT('SYN mine, even more'), { owner: OWNER, context: at() })).outcome, 'conflict');
  assert.equal((await client.commit('A', { action: 'save' }, { owner: OWNER, context: at() })).outcome, 'conflict');
  assert.equal(net.calls.length, calls);
  // The person decides (keep this text): the stored revision becomes the base, and one write goes on it.
  assert.equal(client.resolve('A'), true);
  const kept = await serve(client.write('A', TEXT('SYN mine, even more'), { owner: OWNER, context: at() }));
  assert.equal(kept.outcome, 'saved');
  assert.equal(net.calls.filter(call => call.init.method === 'PUT').length, puts + 1);
  assert.equal(JSON.parse(net.calls.at(-1).init.body).expectedRevision, 'E1:2');
});

test('DRAFT-05 a conflict with this document\'s own late write is settled without asking: the base moves and the write goes once more', async () => {
  const { server, client, at, serve, next } = drafting();
  const first = client.write('A', TEXT('SYN first'), { owner: OWNER, context: at() });
  server.answer(await next());
  const cut = await next();
  cut.drop();                                          // the browser lost the connection; the server still has the write to do
  server.answer(await next());                         // the automatic read: not stored (yet)
  assert.equal((await first).outcome, 'unknown');
  const second = client.write('A', TEXT('SYN first and second'), { owner: OWNER, context: at() });
  server.answer(await next());                         // the read before the next command: still not stored
  server.apply(cut);                                   // now the server reaches the cut-off write: E1:1 holds "SYN first"
  const result = await serve(second);
  assert.equal(result.outcome, 'saved', 'the person is not asked about their own text');
  assert.equal(server.row.findings, 'SYN first and second');
  assert.equal(server.puts, 2, 'the cut-off write and one re-sent write');
  assert.equal(client.conflict('A'), null);
});

test('DRAFT-06 a conflict over the same content converges without a second write', async () => {
  const { server, client, at, serve, net } = drafting();
  await serve(client.write('A', TEXT('SYN first'), { owner: OWNER, context: at() }));
  // This reader's other document stored the very text this one is about to save.
  server.other('SYN the same in both');
  const puts = server.puts;
  const result = await serve(client.write('A', TEXT('SYN the same in both'), { owner: OWNER, context: at() }));
  assert.equal(result.outcome, 'saved');
  assert.equal(result.confirmedByRead, true);
  assert.equal(server.puts, puts, 'the refused write was not sent again: the stored draft already is this text');
  assert.equal(client.revision('A'), 'E1:2');
  assert.equal(client.conflict('A'), null);
  // A save of text the server is already known to hold at this revision sends nothing at all.
  const calls = net.calls.length;
  assert.equal((await client.write('A', TEXT('SYN the same in both'), { owner: OWNER, context: at() })).outcome, 'saved');
  assert.equal(net.calls.length, calls);
});

test('DRAFT-07 a draft deleted elsewhere, a new epoch or another owner is never written over by itself', async () => {
  for (const change of ['discarded elsewhere', 'a new epoch (force-discard)', 'another owner']) {
    const { server, client, at, serve } = drafting();
    await serve(client.write('A', TEXT('SYN mine'), { owner: OWNER, context: at() }));
    if (change === 'discarded elsewhere') { server.rev += 1; server.row = null; }
    if (change === 'a new epoch (force-discard)') { server.epoch = 'E2'; server.rev = 0; server.row = null; }
    if (change === 'another owner') server.owner = { ...OWNER, sub: 'SYN-OTHER-SUB' };
    const puts = server.puts, stored = server.row && server.row.findings;
    const result = await serve(client.write('A', TEXT('SYN mine, more'), { owner: OWNER, context: at() }));
    assert.equal(result.outcome, change === 'another owner' ? 'owner' : 'conflict', change);
    assert.equal(server.puts, puts, 'nothing was written by a retry');
    assert.equal(server.row && server.row.findings, stored, 'the deleted draft was not resurrected, the other owner\'s row not touched');
  }
});

test('DRAFT-08 queued saves of one document merge: the waiting one is not sent, the newest goes on the confirmed revision', async () => {
  const { server, client, at, serve, next } = drafting();
  const first = client.write('A', TEXT('SYN 1'), { owner: OWNER, context: at() });
  const second = client.write('A', TEXT('SYN 12'), { owner: OWNER, context: at() });
  const third = client.write('A', TEXT('SYN 123'), { owner: OWNER, context: at() });
  server.answer(await next());
  // The first write was already waiting when the newer ones queued up: only the newest of the waiting ones is sent.
  assert.equal((await serve(first)).outcome, 'merged');
  assert.equal((await serve(second)).outcome, 'merged');
  assert.equal((await serve(third)).outcome, 'saved');
  assert.equal(server.puts, 1);
  assert.equal(server.row.findings, 'SYN 123');
  // A write already out is not merged away: the next one waits for its answer and stands on its revision.
  const out = client.write('A', TEXT('SYN 1234'), { owner: OWNER, context: at() });
  const put = await next();
  const queued = client.write('A', TEXT('SYN 12345'), { owner: OWNER, context: at() });
  server.answer(put);
  assert.equal((await out).outcome, 'saved');
  assert.equal((await serve(queued)).outcome, 'saved');
  assert.equal(server.revision(), 'E1:3');
});

test('DRAFT-09 the preservation save is bound to its capture: saved by envelope or by a full read, rebased only onto this document\'s own text', async () => {
  const capture = (server, findings, lists = { citations: [], structured: [] }) => ({ uid: 'A', owner: OWNER,
    expectedRevision: server.revision(), snapshot: { ...TEXT(findings), ...lists } });
  {
    const { server, client, gate, serve, next } = drafting();
    const permit = gate.prepare({ owner: OWNER, expectedRevision: server.revision(), snapshot: TEXT('SYN kept') });
    const base = await serve(client.base('A', { owner: OWNER, context: permit }));
    assert.deepEqual(base, { outcome: 'ready', revision: 'E1:0', lists: { citations: [], structured: [] }, stored: null });
    // The answer is lost; the read shows the whole capture stored: saved.
    const saving = client.preserve(capture(server, 'SYN kept'), { context: permit });
    server.lose(await next());
    const result = await serve(saving);
    assert.deepEqual([result.outcome, result.confirmedByRead, server.puts], ['saved', true, 1]);
    assert.equal(client.proves(server.envelope(), capture({ revision: () => 'E1:0' }, 'SYN kept')), true);
    assert.equal(client.proves(server.envelope(), capture({ revision: () => 'E1:0' }, 'SYN kept, altered')), false);
    assert.equal(client.proves({ ...server.envelope(), owner: { ...OWNER, sub: 'X' } }, capture({ revision: () => 'E1:0' }, 'SYN kept')), false);
  }
  {
    // A cut-off autosave of this document lands before the preservation: rebased, never a question.
    const { server, client, gate, at, serve, next } = drafting();
    const autosave = client.write('A', TEXT('SYN typed'), { owner: OWNER, context: at() });
    server.answer(await next());
    const cut = await next();
    cut.drop();
    server.answer(await next());
    await autosave;
    let permit = gate.prepare({ owner: OWNER, expectedRevision: null, snapshot: TEXT('SYN typed and more') });
    const base = await serve(client.base('A', { owner: OWNER, context: permit }));
    assert.equal(base.revision, 'E1:0');
    server.apply(cut);
    permit = gate.prepare({ owner: OWNER, expectedRevision: base.revision, snapshot: TEXT('SYN typed and more') });
    const first = await serve(client.preserve(capture({ revision: () => base.revision }, 'SYN typed and more'), { context: permit }));
    assert.deepEqual(first, { outcome: 'rebased', revision: 'E1:1' });
    assert.equal(server.row.findings, 'SYN typed', 'nothing was written on the moved base by itself');
    const again = await serve(client.base('A', { owner: OWNER, context: permit }));
    assert.equal(again.revision, 'E1:1');
    permit = gate.prepare({ owner: OWNER, expectedRevision: again.revision, snapshot: TEXT('SYN typed and more') });
    const second = await serve(client.preserve(capture(server, 'SYN typed and more'), { context: permit }));
    assert.equal(second.outcome, 'saved');
    assert.equal(server.row.findings, 'SYN typed and more');
  }
  {
    // Another draft is there: a conflict, and the capture is not written over it. A retired or ordinary context sends nothing.
    const { server, client, gate, at, serve, net } = drafting();
    const stale = gate.prepare({ snapshot: {} });
    const permit = gate.prepare({ owner: OWNER, expectedRevision: server.revision(), snapshot: TEXT('SYN kept') });
    await serve(client.base('A', { owner: OWNER, context: permit }));
    const mine = capture(server, 'SYN kept');
    server.other('SYN the other tab');
    const result = await serve(client.preserve(mine, { context: permit }));
    assert.equal(result.outcome, 'conflict');
    assert.equal(server.row.findings, 'SYN the other tab');
    const calls = net.calls.length;
    for (const context of [stale, at(), null])
      assert.equal((await client.preserve(capture(server, 'SYN kept'), { context })).outcome, 'unsent');
    assert.equal((await client.preserve({ ...mine, expectedRevision: null }, { context: permit })).outcome, 'refused');
    assert.equal(net.calls.length, calls, 'nothing left for a context that is not the live preparation');
  }
});

test('DRAFT-10 discard and commit carry the same preconditions; a conflict is followed only onto this document\'s own text', async () => {
  const { server, client, at, serve, next, net } = drafting();
  await serve(client.write('A', TEXT('SYN mine'), { owner: OWNER, context: at() }));
  const committed = await serve(client.commit('A', { action: 'save', findings: 'SYN mine' }, { owner: OWNER, context: at() }));
  assert.equal(committed.outcome, 'saved');
  assert.deepEqual(JSON.parse(net.calls.at(-1).init.body), { action: 'save', findings: 'SYN mine', expectedOwner: OWNER, expectedRevision: 'E1:1' });
  assert.equal(committed.state.rs, 'T');
  assert.equal(client.revision('A'), 'E1:2');
  // A commit whose answer is lost: unknown, not re-sent; the next command reads and goes on from what is stored.
  await serve(client.write('A', TEXT('SYN again'), { owner: OWNER, context: at() }));
  const lost = client.commit('A', { action: 'save' }, { owner: OWNER, context: at() });
  server.lose(await next());
  assert.equal((await lost).outcome, 'unknown');
  assert.equal(server.commits, 2);
  const after = await serve(client.write('A', TEXT('SYN after the commit'), { owner: OWNER, context: at() }));
  assert.equal(after.outcome, 'saved');
  assert.equal(server.commits, 2, 'the commit was not sent again');
  // A discard over another draft: a conflict, nothing deleted.
  server.other('SYN the other tab');
  const refused = await serve(client.discard('A', { owner: OWNER, context: at() }));
  assert.equal(refused.outcome, 'conflict');
  assert.equal(server.row.findings, 'SYN the other tab');
  assert.equal(server.discards, 0);
});

test('DRAFT-11 an older revision of the same epoch is a stale observation; an operation write is not confirmed by a read', async () => {
  const { server, client, at, serve, next } = drafting();
  await serve(client.write('A', TEXT('SYN one'), { owner: OWNER, context: at() }));
  assert.equal(client.observe('A', 'E1:0', null), false, 'a late list answer does not move the base back');
  assert.equal(client.revision('A'), 'E1:1');
  assert.equal(client.observe('A', 'E1:1', TEXT('SYN one')), true);
  assert.equal(client.observe('A', 'not a revision'), false);
  assert.equal(client.revision('A'), null);
  assert.equal((await client.write('A', TEXT('SYN x'), { owner: OWNER, context: at() })).outcome, 'refused',
    'without a base nothing is sent');
  // An insertion whose answer is lost stays unknown (its citation id is the server's to name) - and is not re-sent.
  client.observe('A', server.revision(), TEXT('SYN one'));
  const inserting = client.write('A', TEXT('SYN one, cited'), { owner: OWNER, context: at(),
    operation: { insert: { field: 'findings', insertedText: 'cited' } } });
  server.answer(await next());
  server.lose(await next());
  const result = await serve(inserting);
  assert.equal(result.outcome, 'unknown');
  assert.equal(server.puts, 2);
  // The next save keeps the citation the server made: the stored text is this document's, so nobody is asked.
  const saved = await serve(client.write('A', TEXT('SYN one, cited, more'), { owner: OWNER, context: at() }));
  assert.equal(saved.outcome, 'saved');
  assert.deepEqual(server.row.citations, ['cid-1']);
});

test('DRAFT-12 a write cut by its 10 s deadline is looked for twice at most, never re-sent, and is saved when the server finished it', async t => {
  for (const finished of ['before the second read', 'never']) {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { server, client, at, next, net } = drafting();
    const writing = client.write('A', TEXT('SYN slow'), { owner: OWNER, context: at() });
    server.answer(await next());
    const put = await next();
    t.mock.timers.tick(10000);                         // no answer within the draft deadline
    const first = await next();
    assert.equal(first.init.method, 'GET');
    server.answer(first);                              // not there yet: the server is still working on it
    await settle();
    await settle();
    assert.equal(net.calls.filter(call => !call.done).length, 0, 'the second look waits; nothing is sent meanwhile');
    if (finished === 'before the second read') server.apply(put);
    t.mock.timers.tick(3000);
    server.answer(await next());
    const result = await writing;
    assert.equal(result.outcome, finished === 'never' ? 'unknown' : 'saved', finished);
    await settle();
    assert.deepEqual(net.calls.map(call => call.init.method), ['GET', 'PUT', 'GET', 'GET'], 'two reads, one write');
    assert.equal(client.uncertain('A'), finished === 'never');
    t.mock.timers.reset();
  }
});

test('DRAFT-13 a write that waited sends what its caller has when its turn comes, or nothing; the caller hears of the command before it first', async () => {
  // The caller's text is asked for at the write's turn - after the command before it was answered and after the caller
  // was told so - not when the write was queued.
  {
    const { server, client, at, serve, next } = drafting();
    await serve(client.write('A', TEXT('SYN typed'), { owner: OWNER, context: at() }));
    const order = [];
    let unconfirmed = TEXT('SYN typed, at queue time');
    const committing = client.commit('A', { action: 'save', findings: 'SYN typed' }, { owner: OWNER, context: at() });
    committing.then(result => { order.push('the caller hears ' + result.outcome); unconfirmed = null; });
    const waiting = client.write('A', () => { order.push('the write asks'); return unconfirmed; }, { owner: OWNER, context: at() });
    const post = await next();
    assert.equal(post.init.method, 'POST');
    assert.deepEqual(order, [], 'nothing is asked while the command before it is out');
    server.answer(post);
    assert.deepEqual(await serve(waiting), { outcome: 'withdrawn' });
    assert.deepEqual(order, ['the caller hears saved', 'the write asks']);
    assert.deepEqual([server.puts, server.row, server.revision()], [1, null, 'E1:2'], 'nothing was written after the commit');
    // With text at its turn the same write goes, on the revision the commit made.
    const later = await serve(client.write('A', () => TEXT('SYN typed after the press', { baseVersion: 1 }), { owner: OWNER, context: at() }));
    assert.equal(later.outcome, 'saved');
    assert.deepEqual([server.row.findings, server.row.baseVersion, server.revision()], ['SYN typed after the press', 1, 'E1:3']);
  }
  {
    // The answer may be a promise (the caller reads something first); the write waits for it and nothing else leaves.
    const { server, client, at, serve, net } = drafting();
    let answer;
    const waiting = client.write('A', () => new Promise(resolve => { answer = resolve; }), { owner: OWNER, context: at() });
    for (let turn = 0; turn < 10 && !answer; turn += 1) {
      await settle();
      for (const call of net.calls) if (!call.done) { call.done = true; server.answer(call); }
    }
    assert.equal(server.puts, 0);
    answer(TEXT('SYN decided late'));
    assert.equal((await serve(waiting)).outcome, 'saved');
    assert.equal(server.row.findings, 'SYN decided late');
    // Queued writes still merge: the one that waited is not asked at all.
    let asked = 0;
    const first = client.write('A', () => { asked += 1; return TEXT('SYN 1'); }, { owner: OWNER, context: at() });
    const second = client.write('A', () => { asked += 1; return TEXT('SYN 12'); }, { owner: OWNER, context: at() });
    assert.deepEqual([(await serve(first)).outcome, (await serve(second)).outcome, asked, server.row.findings], ['merged', 'saved', 1, 'SYN 12']);
  }
});

test('DRAFT-14 a discard whose answer was lost is confirmed by a read; a commit is not (a missing draft row does not say the report changed)', async () => {
  {
    // The server discarded the draft; the answer was lost. One read shows the row gone after the revision sent: discarded.
    const { server, client, at, serve, next, net } = drafting();
    await serve(client.write('A', TEXT('SYN to discard'), { owner: OWNER, context: at() }));
    const calls = net.calls.length;
    const discarding = client.discard('A', { owner: OWNER, context: at() });
    server.lose(await next());
    const result = await serve(discarding);
    assert.deepEqual([result.outcome, result.confirmedByRead, result.envelope.revision, client.uncertain('A')], ['saved', true, 'E1:2', false]);
    assert.deepEqual(net.calls.slice(calls).map(call => call.init.method), ['DELETE', 'GET'], 'one read, the discard is not sent again');
    assert.equal(server.discards, 1);
  }
  {
    // The discard never reached the server: the row is still there at the revision sent - unknown, not done.
    const { server, client, at, serve, next } = drafting();
    await serve(client.write('A', TEXT('SYN kept'), { owner: OWNER, context: at() }));
    const discarding = client.discard('A', { owner: OWNER, context: at() });
    (await next()).drop();
    const result = await serve(discarding);
    assert.deepEqual([result.outcome, client.uncertain('A'), server.discards, server.row.findings], ['unknown', true, 0, 'SYN kept']);
  }
  {
    // A commit whose answer was lost stays unknown without a read here: what it changes is the report, which this path
    // cannot see. The caller is the one to read the report state before anything else is written.
    const { server, client, at, serve, next, net } = drafting();
    await serve(client.write('A', TEXT('SYN to commit'), { owner: OWNER, context: at() }));
    const calls = net.calls.length;
    const committing = client.commit('A', { action: 'save' }, { owner: OWNER, context: at() });
    server.lose(await next());
    assert.equal((await committing).outcome, 'unknown');
    await settle();
    assert.deepEqual(net.calls.slice(calls).map(call => call.init.method), ['POST']);
    assert.equal(client.uncertain('A'), true);
  }
});

// Final review part 1, blocker 2: a read whose answer this document has overtaken (it confirmed a newer state of the same
// draft while the read was out) is stale - handed back as such, never taken as the base; replace() never moves the base
// back to an older revision. A read newer than the base (another window's later write, a new epoch while this document
// stood still) is an ordinary read.
test('DRAFT-15 a read this document overtook is stale and moves nothing; replace never moves the base back; a newer read stays a read', async () => {
  const { server, client, at, serve, next, net } = drafting();
  await serve(client.write('A', TEXT('SYN one'), { owner: OWNER, context: at() }));
  // The server answers a read at E1:1; the answer is on its way while this document stores more text (E1:2).
  const reading = client.read('A', { context: at() });
  const read = await next();
  const answered = server.apply(read);
  await serve(client.write('A', TEXT('SYN two'), { owner: OWNER, context: at() }));
  read.answer(...answered);
  const late = await reading;
  assert.deepEqual([late.outcome, late.read.revision, late.revision, client.revision('A')], ['stale', 'E1:1', 'E1:2', 'E1:2']);
  assert.equal(client.replace('A', 'E1:1', TEXT('SYN one')), false, 'the late state does not take the base back');
  assert.equal(client.revision('A'), 'E1:2');
  const calls = net.calls.length;
  assert.equal((await serve(client.write('A', TEXT('SYN three'), { owner: OWNER, context: at() }))).outcome, 'saved');
  assert.deepEqual(net.calls.slice(calls).map(call => [call.init.method, call.init.body && JSON.parse(call.init.body).expectedRevision]),
    [['PUT', 'E1:2']], 'the next write stands on the stored revision');
  // Opposite side: another window writes after this document's save - a read of that is newer, not stale.
  server.other('SYN other window');
  const newer = await serve(client.read('A', { context: at() }));
  assert.deepEqual([newer.outcome, newer.read.revision], ['read', 'E1:4']);
  assert.equal(client.replace('A', 'E1:4', TEXT('SYN other window')), true);
  assert.equal(client.revision('A'), 'E1:4');
  // A new epoch read while this document stood still is a read; read while its base moved, it cannot be ordered: stale.
  server.epoch = 'E2'; server.rev = 0; server.row = null;
  assert.equal((await serve(client.read('A', { context: at() }))).outcome, 'read');
  const crossing = client.read('A', { context: at() });
  const second = await next();
  const now = server.apply(second);
  assert.equal(client.observe('A', 'E1:5', null), true);
  second.answer(...now);
  assert.deepEqual([(await crossing).outcome, client.revision('A')], ['stale', 'E1:5']);
});

// ── auth.js, as shipped, in a browser-shaped context ──

const AUTH_SOURCE = readFileSync(join(lite, 'auth.js'), 'utf8');
const SITE = 'https://kin.test';

/**
 * One browser profile: its storage, its cookie jar's KIN session (the server's side of it) and its documents. Each
 * document runs the shipped auth.js in its own context. The server answers as wire-contract.md sections 1-4 say.
 */
function browser({ storage = 'reliable' } = {}) {
  const local = new Map(), documents = [], channels = [];
  const server = { sessions: new Map(), ended: new Set(), cookie: null, serial: 0, calls: [], logouts: [], proofs: new Map(),
    answers: [],
    login(account = { sub: 'SYN-SUB', actor: 'syn@synthetic.test', institution: 'SYN-INST', roles: ['radiologist'], kind: 'member' }) {
      const id = `S${++server.serial}`;
      server.sessions.set(id, account);
      server.cookie = id;
      return id;
    },
  };
  function respond(status, body, code) {
    return new Response(body === undefined ? null : JSON.stringify(body),
      { status, headers: code ? { 'X-KIN-Auth-Code': code } : {} });
  }
  function serve(url, init) {
    const path = new URL(url).pathname, method = init.method || 'GET', bound = new Headers(init.headers).get('X-KIN-Session');
    server.calls.push([method, path, bound]);
    const scripted = server.answers.find(entry => entry.path === path && !entry.used);
    if (scripted) {
      scripted.used = true;
      if (scripted.fail) return Promise.reject(new TypeError('SYN network'));
      if (scripted.hold) return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
      return Promise.resolve(respond(scripted.status, scripted.body, scripted.code));
    }
    const refuse = (status, code) => Promise.resolve(respond(status, { code, message: 'SYN' }, code));
    if (path === '/api/auth/entry') {
      const proof = JSON.parse(init.body).proof, session = server.proofs.get(proof);
      if (!session || session !== server.cookie) return refuse(403, 'AUTH_ENTRY_REFUSED');
      server.proofs.delete(proof);
      return Promise.resolve(respond(200, { sessionId: session }));
    }
    if (server.cookie === null) return refuse(401, 'AUTH_CREDENTIALS_MISSING');
    if (bound !== null && bound !== server.cookie) return refuse(409, 'AUTH_SESSION_MISMATCH');
    if (bound === null && path !== '/api/me') return refuse(428, 'AUTH_SESSION_REQUIRED');
    if (server.ended.has(server.cookie)) return refuse(401, 'AUTH_SESSION_ENDED');
    if (path === '/api/me') return Promise.resolve(respond(200, { ...server.sessions.get(server.cookie), sessionId: server.cookie }));
    if (path === '/api/auth/logout') {
      server.logouts.push(bound);
      server.ended.add(server.cookie);
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return refuse(404, 'SYN_NOT_STUBBED');
  }
  /** A new document. `tab` is a document whose tab this one loads in (the same sessionStorage); otherwise a new tab. */
  function open(pathname = '/worklist/hpacs-lite/main.html', hash = '', tab = null) {
    const listeners = { window: {}, document: {} }, moves = [], session = tab ? tab.tabStorage : new Map();
    const doc = { moves, posts: [], hidden: false, tabStorage: session };
    const area = map => ({
      getItem(key) { if (storage === 'unreadable') throw new Error('SYN storage blocked'); return map.has(key) ? map.get(key) : null; },
      setItem(key, value) {
        if (storage === 'unreadable' || (storage === 'full' && map === local)) throw new Error('SYN storage refused');
        map.set(key, String(value));
        if (map === local) for (const other of documents) if (other !== doc) queueMicrotask(() => other.fire('storage', { key }));
      },
      removeItem(key) { if (storage === 'unreadable') throw new Error('SYN storage blocked'); map.delete(key); },
      get length() { if (storage === 'unreadable') throw new Error('SYN storage blocked'); return map.size; },
      key(index) { if (storage === 'unreadable') throw new Error('SYN storage blocked'); return [...map.keys()][index] ?? null; },
    });
    class Channel {
      constructor(name) { this.name = name; this.onmessage = null; this.doc = doc; channels.push(this); }
      postMessage(data) {
        // Copied into this file's realm so that the cases can compare it structurally.
        doc.posts.push(JSON.parse(JSON.stringify(data)));
        for (const other of channels) if (other !== this && other.name === this.name && !other.closed)
          queueMicrotask(() => { if (other.onmessage) other.onmessage({ data }); });
      }
      close() { this.closed = true; }
    }
    const location = { origin: SITE, protocol: 'https:', pathname, search: '', hash,
      replace(url) { moves.push(['replace', String(url)]); },
      get href() { return SITE + pathname; }, set href(url) { moves.push(['href', String(url)]); } };
    const context = vm.createContext({
      location, sessionStorage: area(session), localStorage: area(local),
      document: { cookie: '', get hidden() { return doc.hidden; }, addEventListener(type, listener) { (listeners.document[type] ||= []).push(listener); } },
      addEventListener(type, listener) { (listeners.window[type] ||= []).push(listener); },
      history: { state: null, replaceState(state, title, url) { location.hash = ''; doc.address = url; } },
      fetch: (url, init) => serve(url, init), BroadcastChannel: Channel, AbortController, URLSearchParams, URL, Response,
      setTimeout, clearTimeout, console,
    });
    doc.auth = vm.runInContext(AUTH_SOURCE + '\n;KinAuth', context, { filename: 'auth.js' });
    doc.fire = (type, event = {}) => { for (const listener of listeners.window[type] || []) listener(event); };
    doc.states = [];
    doc.auth.onLifecycle(event => doc.states.push(`${event.state}:${event.session}`));
    doc.state = () => doc.auth.lifecycle().state;
    // The end record of one session (its own key), or - with no session named - the one record there is.
    doc.record = session => {
      const keys = [...local.keys()].filter(key => session ? key === 'kin-session-end:' + session : key.startsWith('kin-session-end:'));
      assert.ok(keys.length <= 1, 'one end record expected, found ' + keys.length);
      return keys.length ? JSON.parse(local.get(keys[0])) : null;
    };
    documents.push(doc);
    return doc;
  }
  /** A message on a channel from outside these documents, as any same-origin document could post it. */
  function broadcast(data, name = 'kin-session') {
    for (const channel of channels) if (channel.name === name && !channel.closed)
      queueMicrotask(() => { if (channel.onmessage) channel.onmessage({ data }); });
  }
  return { server, open, local, broadcast };
}

/** Lets the document's promises and the bus's microtasks run. */
const turn = async (times = 6) => { for (let i = 0; i < times; i += 1) await settle(); };

test('AUTH-01 entry asks the server once without a binding, then every request names the session', async () => {
  const { server, open } = browser();
  const session = server.login();
  const doc = open();
  assert.equal(doc.state(), 'unknown');
  const identity = await doc.auth.init();
  assert.deepEqual([doc.state(), doc.auth.sessionId(), identity.sub], ['active', session, 'SYN-SUB']);
  assert.deepEqual(server.calls, [['GET', '/api/me', null]]);
  assert.equal(doc.auth.autoLogin(), false, 'a document at work starts no login');
  // A second document of the same session (a second tab, a viewer's opener) enters the same way: no error, no click.
  const second = open();
  await second.auth.init();
  assert.deepEqual([second.state(), second.auth.sessionId(), doc.state()], ['active', session, 'active']);
  assert.deepEqual(doc.posts.concat(second.posts), [], 'entering announces nothing');
});

test('AUTH-02 no session in a document with reliable storage and no end record: the login starts by itself, once', async () => {
  const { server, open } = browser();
  const doc = open('/worklist/hpacs-lite/index.html');
  assert.equal(await doc.auth.init(), null);
  assert.equal(doc.state(), 'unknown');
  assert.equal(doc.auth.endState(), null);
  assert.equal(doc.auth.autoLogin(), true);
  assert.deepEqual(doc.moves, [['href', SITE + '/api/auth/login']]);
  assert.equal(doc.auth.autoLogin(), false, 'one move per document');
  assert.deepEqual(server.calls, [['GET', '/api/me', null]], 'the server was asked once and nothing was replaced');
  assert.equal(doc.record(), null);
});

test('AUTH-03 the automatic login never starts over an end record, unverifiable storage, a failed confirmation or a refused entry proof', async () => {
  const cases = {
    'an explicit logout (confirmed end record)': async () => {
      const { server, open, local } = browser();
      local.set('kin-session-end:S0', JSON.stringify({ session: 'S0', operation: 1, status: 'confirmed', origin: 'logout' }));
      return { server, doc: open() };
    },
    'an unconfirmed logout': async () => {
      const { server, open, local } = browser();
      local.set('kin-session-end:S0', JSON.stringify({ session: 'S0', operation: 1, status: 'unconfirmed', reason: 'network', origin: 'logout' }));
      return { server, doc: open() };
    },
    'a record that cannot be read': async () => {
      const { server, open, local } = browser();
      local.set('kin-session-end:S0', '{broken');
      return { server, doc: open() };
    },
    'a record that does not say why the session ended (no origin)': async () => {
      const { server, open, local } = browser();
      local.set('kin-session-end:S0', JSON.stringify({ session: 'S0', operation: 1, status: 'confirmed' }));
      return { server, doc: open() };
    },
    'a record from before the per-session keys (one key, no origin)': async () => {
      const { server, open, local } = browser();
      local.set('kin-session-end', JSON.stringify({ session: 'S0', operation: 1, status: 'confirmed' }));
      return { server, doc: open() };
    },
    'storage that cannot be read': async () => { const { server, open } = browser({ storage: 'unreadable' }); return { server, doc: open() }; },
    'storage that takes no write': async () => { const { server, open } = browser({ storage: 'full' }); return { server, doc: open() }; },
    'the confirmation fails (500)': async () => {
      const { server, open } = browser();
      server.answers.push({ path: '/api/me', status: 500, body: { message: 'SYN' } });
      return { server, doc: open(), rejects: true };
    },
    'the confirmation fails (connection)': async () => {
      const { server, open } = browser();
      server.answers.push({ path: '/api/me', fail: true });
      return { server, doc: open(), rejects: true };
    },
    'a refused entry proof': async () => {
      const { server, open } = browser();
      return { server, doc: open('/worklist/hpacs-lite/main.html', '#kin-entry=SYN-USED-PROOF') };
    },
  };
  for (const [label, make] of Object.entries(cases)) {
    const { server, doc, rejects } = await make();
    if (rejects) await assert.rejects(doc.auth.init(), label); else assert.equal(await doc.auth.init(), null, label);
    assert.equal(doc.auth.autoLogin(), false, label);
    assert.deepEqual(doc.moves, [], label);
    assert.notEqual(doc.state(), 'active', label);
    if (!rejects && !label.includes('proof')) assert.deepEqual(server.calls, [], `${label}: the live session is not even read`);
  }
  // The opposite side (A005): a session the SERVER ended (expiry) or another login replaced is not the person leaving.
  // Its record holds no new document: the ordinary entry asks the server and, with no session, the login starts by
  // itself - no notice and no click every morning. A record older than the SSO lifetime is dropped.
  for (const origin of ['server_end', 'replaced']) {
    const { server, open, local } = browser();
    local.set('kin-session-end:S0', JSON.stringify({ session: 'S0', operation: Date.now() - 1000, status: origin === 'replaced' ? 'unconfirmed' : 'confirmed',
      origin, ...(origin === 'replaced' ? { reason: 'replaced' } : {}) }));
    local.set('kin-session-end:S-OLD', JSON.stringify({ session: 'S-OLD', operation: Date.now() - 13 * 3600 * 1000, status: 'confirmed', origin }));
    const doc = open('/worklist/hpacs-lite/index.html');
    assert.equal(doc.auth.endState(), null, origin);
    assert.equal(await doc.auth.init(), null, origin);
    assert.deepEqual([doc.auth.autoLogin(), doc.moves, server.calls, local.has('kin-session-end:S0'), local.has('kin-session-end:S-OLD')],
      [true, [['href', SITE + '/api/auth/login']], [['GET', '/api/me', null]], true, false], origin);
    // ... and with a live session of the browser the new document simply enters it.
    const live = browser();
    live.local.set('kin-session-end:S0', JSON.stringify({ session: 'S0', operation: Date.now() - 1000, status: 'confirmed', origin }));
    const session = live.server.login();
    const tab = live.open();
    await tab.auth.init();
    assert.deepEqual([tab.state(), tab.auth.sessionId()], ['active', session], origin);
  }
  // And a tab the automatic login just sent out comes back without a session: it is not sent again (no redirect loop).
  const { server, open } = browser();
  const first = open('/worklist/hpacs-lite/index.html');
  await first.auth.init();
  assert.equal(first.auth.autoLogin(), true);
  const back = open('/worklist/hpacs-lite/index.html', '', first);
  assert.equal(await back.auth.init(), null);
  assert.deepEqual([back.auth.autoLogin(), back.moves, back.auth.endState()], [false, [], null],
    'the same tab is not sent out again; the landing shows the login control');
  // Another tab is not held by that tab's guard, and a tab that did enter is free again the next time it has no session.
  const other = open('/worklist/hpacs-lite/index.html');
  await other.auth.init();
  assert.equal(other.auth.autoLogin(), true);
  server.login();
  const entered = open('/worklist/hpacs-lite/main.html', '', first);
  await entered.auth.init();
  assert.equal(entered.state(), 'active');
  server.cookie = null;
  const nextDay = open('/worklist/hpacs-lite/index.html', '', first);
  await nextDay.auth.init();
  assert.equal(nextDay.auth.autoLogin(), true);
});

test('AUTH-04 the entry proof is taken from the address at once, used once, and enters even where storage cannot be verified', async () => {
  for (const storage of ['reliable', 'unreadable', 'full']) {
    const { server, open } = browser({ storage });
    const session = server.login();
    server.proofs.set('SYN-PROOF', session);
    const doc = open('/worklist/hpacs-lite/main.html', '#kin-entry=SYN-PROOF');
    assert.equal(doc.address, '/worklist/hpacs-lite/main.html', 'the fragment left the address before any request');
    await doc.auth.init();
    assert.deepEqual([doc.state(), doc.auth.sessionId()], ['active', session], storage);
    assert.deepEqual(server.calls, [['POST', '/api/auth/entry', null], ['GET', '/api/me', session]], 'the bootstrap after a proof is bound');
    // The same proof again (history, a copied address): refused, nothing opens, and no login starts by itself.
    const replay = open('/worklist/hpacs-lite/main.html', '#kin-entry=SYN-PROOF');
    assert.equal(await replay.auth.init(), null);
    assert.deepEqual([replay.state(), replay.auth.endState()?.reason, replay.auth.autoLogin()], ['unknown', storage === 'reliable' ? 'entry' : replay.auth.endState().reason, false]);
    assert.equal(doc.state(), 'active');
  }
});

test('AUTH-05 which answers close a document: the session ended, the session replaced - and nothing else', async () => {
  const closing = [
    [{ status: 401, code: 'AUTH_SESSION_ENDED' }, 'confirmed', 'server_end'],
    [{ status: 409, code: 'AUTH_SESSION_MISMATCH' }, 'unconfirmed', 'replaced'],
    [{ status: 403, code: 'AUTH_SESSION_MISMATCH' }, 'unconfirmed', 'replaced'],
  ];
  for (const [failure, state, origin] of closing) {
    // A session the server ended is recorded with that origin (never as the person's logout); a replaced session
    // leaves no record - its id does not come back, and the browser's new login is not to be held by it.
    const { server, open } = browser();
    const session = server.login();
    const doc = open();
    await doc.auth.init();
    doc.auth.authFailure({ session, ...failure });
    assert.equal(doc.state(), state, JSON.stringify(failure));
    assert.equal(doc.auth.session(), null);
    assert.deepEqual(origin === 'replaced' ? doc.record(session) : [doc.record(session).status, doc.record(session).origin],
      origin === 'replaced' ? null : [state, origin]);
    assert.deepEqual(server.logouts, [], 'no logout POST: it would aim at another login, or at a session already gone');
    assert.deepEqual(doc.posts.map(post => [post.type, post.session, post.origin]), [['session-ended', session, origin]]);
  }
  const { server, open } = browser();
  const session = server.login();
  const doc = open();
  await doc.auth.init();
  const calls = server.calls.length;
  for (const failure of [{ status: 401, code: null }, { status: 401, code: 'AUTH_CREDENTIALS_MISSING' },
    { status: 428, code: 'AUTH_SESSION_REQUIRED' }, { status: 403, code: 'AUTH_SESSION_REQUIRED' },
    { status: 409, code: 'AUTH_SESSION_BUSY' }, { status: 403, code: 'AUTH_CSRF_REQUIRED' }, { status: 403, code: null },
    { status: 409, code: 'REPORT_DRAFT_OWNER_CHANGED' }, { status: 500, code: 'AUTH_STORAGE_FAILURE' }, { status: 503, code: null },
    { status: 401, code: 'AUTH_SESSION_ENDED', session: 'S-OTHER' }, { status: 409, code: 'AUTH_SESSION_MISMATCH', session: 'S-OTHER' },
    null]) {
    doc.auth.authFailure(failure && { session, ...failure });
    await turn(2);
    assert.equal(doc.state(), 'active', JSON.stringify(failure));
  }
  assert.deepEqual([doc.record(), doc.posts, server.calls.length, doc.moves], [null, [], calls, []],
    'no record, no notice, no request, no move: the screen stays as it was');
  assert.equal(doc.auth.session().sub, 'SYN-SUB');
  // The page's own evidence of a replaced account closes like a mismatch; for another session it does nothing.
  doc.auth.replaced({ session: 'S-OTHER' });
  assert.equal(doc.state(), 'active');
  doc.auth.replaced({ session });
  assert.deepEqual([doc.state(), doc.record(session), server.logouts], ['unconfirmed', null, []]);
});

test('AUTH-06 notices are session-bound and never re-posted; storage trouble and preparation notices close nothing', async () => {
  const { server, open, local, broadcast } = browser();
  const first = server.login();
  const a = open(), a2 = open();
  await a.auth.init();
  await a2.auth.init();
  const second = server.login();
  const b = open();
  await b.auth.init();
  assert.deepEqual([a.auth.sessionId(), a2.auth.sessionId(), b.auth.sessionId()], [first, first, second]);
  // Session 1's document is told its session ended (the cookie is session 2's now): it and its sibling close, B does not.
  a.auth.authFailure({ session: first, status: 409, code: 'AUTH_SESSION_MISMATCH' });
  await turn();
  assert.deepEqual([a.state(), a2.state(), b.state()], ['unconfirmed', 'unconfirmed', 'active'], 'the sibling heard a replacement: unconfirmed, not a logout in progress');
  assert.deepEqual([a.record(first), b.record(second)], [null, null], 'a replaced session leaves no record; session 2 has none');
  assert.deepEqual([a.posts.length, a2.posts.length, b.posts.length], [1, 0, 0], 'one notice, no echo');
  assert.deepEqual(server.logouts, []);
  // Notices that name no session, another session, or a preparation: nothing closes.
  for (const data of [{ type: 'session-ended' }, { type: 'session-ended', session: 'S-NOBODY', operation: 9, status: 'ending' },
    { type: 'session-ended', session: first, operation: 10, status: 'ending' },
    { type: 'session-preparing', session: second, preparation: 1 }, { type: 'session-resumed', session: second, preparation: 1 }]) {
    broadcast(data);
    await turn();
    assert.equal(b.state(), 'active', JSON.stringify(data));
  }
  assert.deepEqual(b.posts, [], 'nothing heard is posted again');
  // Storage that becomes unreadable is not an end signal for a document at work.
  for (const key of ['kin-session-end', 'kin-session-end:' + second]) {
    local.set(key, '{broken');
    b.fire('storage', { key });
    b.fire('focus');
    assert.equal(b.state(), 'active', key);
    local.delete(key);
  }
  // The preparation notices: posted for this session only while it is at work, with the preparation's number.
  b.auth.notifyPreparation('preparing', 3);
  b.auth.notifyPreparation('resumed', 3);
  b.auth.notifyPreparation('ended', 3);
  assert.deepEqual(b.posts, [{ type: 'session-preparing', session: second, preparation: 3 },
    { type: 'session-resumed', session: second, preparation: 3 }]);
  a.auth.notifyPreparation('preparing', 1);
  assert.equal(a.posts.length, 1, 'a closed document announces no preparation');
});

test('AUTH-07 one logout: the record and the notice before the network, one bound POST, one move after the server\'s answer', async () => {
  const { server, open } = browser();
  const session = server.login();
  const doc = open(), sibling = open();
  await doc.auth.init();
  await sibling.auth.init();
  const order = [];
  doc.auth.beforeLogoutPost(async bound => { order.push(['step', bound, doc.state(), doc.record().status]); });
  const leaving = doc.auth.logout();
  assert.deepEqual([doc.state(), doc.auth.session(), doc.record().session, doc.record().status, doc.record().origin],
    ['ending', null, session, 'ending', 'logout']);
  // An overlapping press shares the one end: no second record, notice or POST.
  await Promise.all([leaving, doc.auth.logout()]);
  assert.equal(doc.posts.length, 1);
  assert.deepEqual(order, [['step', session, 'ending', 'ending']]);
  assert.deepEqual(server.logouts, [session]);
  assert.deepEqual([doc.state(), doc.record().status], ['confirmed', 'confirmed']);
  assert.deepEqual(doc.moves, [['replace', SITE + '/worklist/hpacs-lite/index.html']], 'one move, right after the server confirmed');
  await turn();
  assert.notEqual(sibling.state(), 'active');
  assert.deepEqual(sibling.posts, [], 'the sibling re-posts nothing and sends no logout of its own');
  assert.deepEqual(server.logouts, [session]);
  // A new document after the confirmed end: closed, no request, no automatic login.
  const later = open('/worklist/hpacs-lite/index.html');
  const calls = server.calls.length;
  assert.equal(await later.auth.init(), null);
  assert.deepEqual([later.auth.endState().state, later.auth.autoLogin(), server.calls.length], ['confirmed', false, calls]);
});

test('AUTH-08 a logout that the server does not confirm is unconfirmed by its kind, never retried by itself, and never a confirmed end', async () => {
  const kinds = [[{ status: 409, body: { code: 'AUTH_SESSION_BUSY' }, code: 'AUTH_SESSION_BUSY' }, 'conflict'],
    [{ status: 500, body: { code: 'AUTH_STORAGE_FAILURE' }, code: 'AUTH_STORAGE_FAILURE' }, 'storage'],
    [{ status: 401, body: { code: 'AUTH_CREDENTIALS_MISSING' }, code: 'AUTH_CREDENTIALS_MISSING' }, 'credentials'],
    [{ status: 428, body: { code: 'AUTH_SESSION_REQUIRED' }, code: 'AUTH_SESSION_REQUIRED' }, 'refused'],
    [{ fail: true }, 'network']];
  for (const [answer, reason] of kinds) {
    const { server, open } = browser();
    server.login();
    const doc = open();
    await doc.auth.init();
    server.answers.push({ path: '/api/auth/logout', ...answer });
    await doc.auth.logout();
    assert.deepEqual([doc.state(), doc.record().status, doc.record().reason], ['unconfirmed', 'unconfirmed', reason]);
    assert.equal(server.calls.filter(call => call[1] === '/api/auth/logout').length, 1, 'nothing is sent again by itself');
  }
});
