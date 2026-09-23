// TEST-S3-ASR-U4-HOST (pure). The shipped host adapter over the shipped session core and capture
// module, with fake media, fetch, timers and editor. Control flow only: no browser, device, network,
// engine or speech. Real Chromium capture is U4b; page integration is report_dictation_host_dom_test.py.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../worklist-v0/hpacs-lite/dictation.js');
const Session = require('../worklist-v0/hpacs-lite/dictation-session.js');
const Capture = require('../worklist-v0/hpacs-lite/dictation-capture.js');

const CAP = Object.freeze({ available: true, maxBytes: 1048576, timeoutMs: 120000, languagePin: 'auto',
  enginePin: 'whisper.cpp@927cfce34f31707e17f2bff35c349632fb9e2c3a',
  modelPin: 'ggml-small@sha256:1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b' });
const UID = '1.2.3/4';
const REPLY = text => JSON.stringify({ text, enginePin: CAP.enginePin, modelPin: CAP.modelPin, languagePin: 'auto', seconds: 0.25 });
const CANCELLED = '취소됨(엔진 상태 미확인) — 판독문은 그대로입니다';
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
/** SHA-256 runs off the main thread; wait for the observable condition, never for a guessed count. */
async function until(predicate, what) {
  for (let i = 0; i < 500; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 2)); }
  assert.fail('timed out waiting for ' + what);
}

function track() {
  return { readyState: 'live', stops: 0, listeners: new Map(),
    addEventListener(name, fn) { this.listeners.set(name, fn); }, removeEventListener(name) { this.listeners.delete(name); },
    stop() { this.readyState = 'ended'; this.stops += 1; } };
}
function fakeMedia({ denied = false, media = null, secure = true, gum = true, rate = 16000 } = {}) {
  const tracks = [track()];
  const stream = { getTracks: () => tracks, getAudioTracks: () => tracks };
  const rec = { tracks, stream, gumCalls: 0, contexts: [], commands: [] };
  class Context {
    constructor(options) { rec.contexts.push(this); this.options = options; this.sampleRate = rate; this.destination = {};
      this.audioWorklet = { addModule: async path => { rec.module = path; } }; }
    async resume() {}
    async close() { this.closed = true; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  }
  class Worklet {
    constructor(_context, name, options) { rec.node = this; rec.name = name; rec.options = options;
      this.port = { postMessage: msg => rec.commands.push(msg), close() {} }; }
    connect() {} disconnect() {}
  }
  rec.env = { isSecureContext: secure, AudioContext: Context, AudioWorkletNode: Worklet,
    navigator: { mediaDevices: gum ? { getUserMedia: async constraints => {
      rec.gumCalls += 1; rec.constraints = constraints;
      if (media) return media();
      if (denied) { const e = new Error('denied'); e.name = 'NotAllowedError'; throw e; }
      return stream;
    } } : {} } };
  rec.deliver = bytes => rec.node.port.onmessage({ data: { type: 'pcm', buffer: Uint8Array.from(bytes).buffer } });
  rec.allEnded = () => tracks.every(t => t.readyState === 'ended') && rec.contexts.every(c => c.closed);
  return rec;
}
function fakeFetch() {
  const net = { calls: [] };
  net.fetch = (url, init) => {
    const call = { url, init, sent: Buffer.from(init.body), aborted: false };
    net.calls.push(call);
    return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => { call.aborted = true; reject(new DOMException('aborted', 'AbortError')); });
      call.respond = (status, raw) => resolve({ status, ok: status >= 200 && status < 300, text: async () => raw });
      call.reject = error => reject(error);
    });
  };
  return net;
}
function fakeTimers() {
  const t = { pending: [] };
  t.set = (fn, ms) => { const id = t.pending.length + 1; t.pending.push({ id, fn, ms, cleared: false }); return id; };
  t.clear = id => { const e = t.pending.find(x => x.id === id); if (e) e.cleared = true; };
  t.live = () => t.pending.filter(x => !x.cleared);
  t.fire = () => { for (const e of t.live()) { e.cleared = true; e.fn(); } };
  return t;
}
function editor() {
  const e = { blocked: false, uid: UID, selectionSeq: 1, baseVersion: 3, field: 'findings', refuse: false, busy: false,
    values: { findings: '첫 줄\n둘째 줄', conclusion: '', recommendation: '' }, caret: { start: 4, end: 4 }, inserts: [] };
  e.readContext = field => {
    const f = field ?? e.field;
    return { blocked: e.blocked, uid: e.uid, selectionSeq: e.selectionSeq, baseVersion: e.baseVersion, field: f,
      value: e.values[f], caret: { ...e.caret } };
  };
  e.insert = ins => {
    e.inserts.push(ins);
    if (e.refuse === 'throw') throw new Error('boom');
    if (e.refuse) return false;
    const v = e.values[ins.field];
    e.values[ins.field] = v.slice(0, ins.caret.end) + ins.text + v.slice(ins.caret.end);
    return true;
  };
  return e;
}
/** The shipped session, with fail() observed so "one failure, one transition" is countable. */
function spySession() {
  const spy = { fails: [] };
  spy.create = options => {
    const inner = Session.create(options);
    return { ...inner, fail: (token, reason) => {
      const res = inner.fail(token, reason);
      spy.fails.push({ reason, moved: res.reason !== 'stale' });
      return res;
    } };
  };
  return spy;
}
function setup({ capability = CAP, media = {}, capture = Capture } = {}) {
  const m = fakeMedia(media), ed = editor(), net = fakeFetch(), timers = fakeTimers(), spy = spySession();
  let logouts = 0;
  const c = D.createController({ session: spy, capture, env: m.env, apiBase: '/api', fetch: net.fetch,
    // The start gate is the editor gate plus the server connection (main.html dictationBlock).
    readContext: ed.readContext, insert: ed.insert, block: () => (ed.blocked ? '막힘' : ed.serverDown ? '서버 없음' : null),
    busy: () => ed.busy, placement: (pin, text) => `${pin.field}@${pin.caret.end}:${text.length}`,
    onUnauthorized: () => { logouts += 1; }, timers });
  c.setServerCapability(capability);
  return { c, m, ed, net, timers, spy, logouts: () => logouts };
}
async function toUpload(t) {
  await t.c.start();
  assert.equal(t.c.snapshot().state, 'recording');
  t.c.stop(); await flush();
  t.m.deliver([1, 0, 255, 127]); await flush();
  assert.equal(t.net.calls.length, 1);
  return t.net.calls[0];
}
async function toReview(t, text = ' 좌상엽 결절.\n') {
  const call = await toUpload(t);
  call.respond(200, REPLY(text)); await flush();
  assert.equal(t.c.snapshot().state, 'review');
  return call;
}

test('capability: only the exact bootstrap shape is available, and malformed means unavailable', () => {
  assert.deepEqual(D.parseCapability(CAP), CAP);
  const off = [null, undefined, [], 'x', { ...CAP, available: 1 }, { ...CAP, available: 'true' },
    { ...CAP, maxBytes: 45 }, { ...CAP, maxBytes: 1048577 }, { ...CAP, maxBytes: 1.5 }, { ...CAP, maxBytes: '1048576' },
    { ...CAP, timeoutMs: 0 }, { ...CAP, timeoutMs: 240001 }, { ...CAP, languagePin: '' }, { ...CAP, enginePin: 7 },
    { ...CAP, modelPin: 'x'.repeat(257) }, { available: true }];
  for (const value of off) assert.equal(D.parseCapability(value).available, false, JSON.stringify(value));
});

test('browser capability needs a secure context, getUserMedia and the capture module; reading never prompts', () => {
  const m = fakeMedia();
  assert.equal(D.browserCapable(m.env, Capture), true);
  assert.equal(m.gumCalls, 0, 'deciding capability must not ask for the microphone');
  for (const env of [{ ...m.env, isSecureContext: false }, { ...m.env, isSecureContext: 'true' },
                     { ...m.env, navigator: {} }, { ...m.env, navigator: { mediaDevices: { getUserMedia: 1 } } },
                     { ...m.env, AudioWorkletNode: undefined }, null])
    assert.equal(D.browserCapable(env, Capture), false);
  assert.equal(D.browserCapable(m.env, null), false);
  assert.equal(D.browserCapable(m.env, { available: () => { throw new Error('x'); } }), false);
});

test('response text is exact, bounded and never trimmed; shape failures refuse', () => {
  for (const text of [' 앞 공백', '끝 LF\n', 'CR\r\nLF', 'lone \ud800 surrogate', 'x'.repeat(D.TEXT_CAP)]) {
    const v = D.readResponse(REPLY(text));
    assert.equal(v.text, text); assert.equal(D.transcriptProblem(v.text), null);
  }
  assert.equal(D.transcriptProblem('x'.repeat(D.TEXT_CAP + 1)), 'transcript-too-long');
  assert.equal(D.transcriptProblem(' \n\t　'), 'transcript-empty');
  for (const raw of ['', 'not json', '[]', 'null', '{"text":1}', JSON.stringify({ text: 'a' }),
    REPLY('a').replace('0.25', '-1'), REPLY('a').replace('0.25', '"1"'), REPLY('a').replace('"auto"', '""'),
    ' '.repeat(262145)])
    assert.equal(D.readResponse(raw), null, raw.slice(0, 40));
});

test('refusals never assume JSON: nginx 413, route codes, shared report refusals and bare statuses', () => {
  assert.deepEqual(D.refusal(413, '<html>413 Request Entity Too Large</html>'), { code: 'DICTATION_AUDIO_TOO_LARGE', message: null });
  assert.deepEqual(D.refusal(413, '{"code":"OTHER","message":"x"}'), { code: 'DICTATION_AUDIO_TOO_LARGE', message: null });
  assert.deepEqual(D.refusal(503, '{"code":"DICTATION_BUSY","message":"DICTATION_BUSY"}'), { code: 'DICTATION_BUSY', message: null });
  assert.deepEqual(D.refusal(503, '{"code":"DICTATION_NEW","message":"DICTATION_NEW"}'), { code: 'DICTATION_NEW', message: null });
  assert.deepEqual(D.refusal(409, '{"code":"REPORT_HELD","message":"다른 판독의가 판독 중입니다"}'),
    { code: 'REPORT_HELD', message: '다른 판독의가 판독 중입니다' });
  assert.deepEqual(D.refusal(502, '<html>bad gateway</html>'), { code: 'HTTP_502', message: null });
  assert.deepEqual(D.refusal(500, '{"code":"lower","message":"' + 'x'.repeat(9000) + '"}'), { code: 'HTTP_500', message: null });
  assert.equal(D.failureMessage('HTTP_502'), '음성 인식 요청이 거절되었습니다 (HTTP 502)');
  assert.equal(D.failureMessage('DICTATION_NEW'), '받아쓰기를 마치지 못했습니다');
});

test('unavailable by default and with a browser that cannot capture: pressing does nothing', async () => {
  for (const t of [setup({ capability: null }), setup({ media: { secure: false } }), setup({ media: { gum: false } })]) {
    const v = t.c.view();
    assert.equal(v.visible, false);
    await t.c.start(); await flush();
    assert.equal(t.m.gumCalls, 0); assert.equal(t.net.calls.length, 0);
    assert.equal(t.c.snapshot().state, 'unavailable');
    assert.equal(t.c.view().visible, false);
  }
});

test('record -> stop -> one bounded request -> review; the report is untouched until Insert', async () => {
  const t = setup();
  const pending = t.c.start();
  assert.equal(t.c.snapshot().state, 'requesting-permission');
  assert.equal(t.c.view().controls.cancel, 'enabled', 'cancel stays reachable while permission is pending');
  await pending;
  assert.equal(t.m.gumCalls, 1); assert.equal(t.m.module, './dictation-worklet.js');
  assert.deepEqual(t.m.options.processorOptions, { maxFrames: (CAP.maxBytes - 44) / 2 });
  const pin = t.c.snapshot().pin;
  assert.deepEqual({ uid: pin.uid, selectionSeq: pin.selectionSeq, baseVersion: pin.baseVersion, field: pin.field,
    caret: { ...pin.caret } }, { uid: UID, selectionSeq: 1, baseVersion: 3, field: 'findings', caret: { start: 4, end: 4 } });
  assert.match(pin.fieldValueHash, /^[0-9a-f]{64}$/);
  t.c.stop(); t.c.stop(); await flush();
  assert.deepEqual(t.m.commands, [{ type: 'stop' }], 'a second Stop sends nothing');
  t.m.deliver([1, 0, 255, 127]); await flush();
  assert.equal(t.net.calls.length, 1);
  const call = t.net.calls[0];
  assert.equal(call.url, '/api/studies/' + encodeURIComponent(UID) + '/dictation');
  assert.deepEqual({ method: call.init.method, credentials: call.init.credentials, cache: call.init.cache,
    redirect: call.init.redirect, headers: call.init.headers },
  { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    headers: { 'Content-Type': 'audio/wav', 'X-KIN-CSRF': '1' } });
  assert.equal(call.sent.toString('ascii', 0, 4), 'RIFF'); assert.equal(call.sent.length, 48);
  assert.deepEqual([...call.sent.subarray(44)], [1, 0, 255, 127]);
  assert.ok(call.init.body.every(b => b === 0), 'the page keeps no audio once fetch() has copied it');
  assert.equal(t.timers.live()[0].ms, CAP.timeoutMs + D.CLIENT_MARGIN_MS);
  assert.ok(t.m.allEnded(), 'every track and the context are released once the recording is taken');
  assert.equal(t.c.view().status, D.STATUS.uploading);
  const text = ' 좌상엽 결절.\n';
  call.respond(200, REPLY(text)); await flush();
  const v = t.c.view();
  assert.equal(v.state, 'review'); assert.equal(v.text, text, 'exact decoded text, not trimmed');
  assert.equal(v.placement, 'findings@4:' + text.length);
  assert.match(v.meta, /언어 설정 auto\(감지된 언어 아님\)/);
  assert.doesNotMatch(v.meta, /whisper|ggml/, 'configured engine/model labels are not presented as attestation');
  assert.equal(t.timers.live().length, 0);
  assert.deepEqual(t.ed.inserts, [], 'a response alone never changes the report');
  assert.equal(t.ed.values.findings, '첫 줄\n둘째 줄');
  const res = await t.c.insert();
  assert.equal(res.inserted, true); assert.equal(res.field, 'findings');
  assert.equal(t.ed.inserts.length, 1);
  assert.equal(t.ed.inserts[0].text, text); assert.equal(t.ed.inserts[0].expectedValue, '첫 줄\n둘째 줄');
  assert.equal(t.ed.values.findings, '첫 줄\n' + text + '둘째 줄', 'at the pinned caret (after the first LF)');
  assert.equal(t.c.snapshot().state, 'inserted'); assert.equal(t.c.view().visible, false);
  assert.equal(await t.c.insert(), null, 'a second Insert has nothing to insert');
  assert.equal(t.ed.inserts.length, 1);
});

test('cancel in every phase releases everything and writes nothing; late answers are dropped', async () => {
  let grant;
  const t1 = setup({ media: { media: () => new Promise(r => { grant = r; }) } });
  const started = t1.c.start();
  await until(() => t1.m.gumCalls === 1, 'the permission request');
  t1.c.cancel(); grant(t1.m.stream); await started; await flush();
  assert.equal(t1.c.view().status, CANCELLED);
  assert.ok(t1.m.tracks.every(tr => tr.readyState === 'ended'), 'a late grant is stopped');
  assert.equal(t1.net.calls.length, 0);

  const t2 = setup(); await t2.c.start(); t2.c.cancel(); await flush();
  assert.ok(t2.m.allEnded()); assert.equal(t2.net.calls.length, 0); assert.equal(t2.c.view().status, CANCELLED);

  const t3 = setup(); const call = await toUpload(t3);
  t3.c.cancel(); await flush();
  assert.equal(call.aborted, true, 'the request is aborted');
  assert.equal(t3.c.view().status, CANCELLED, 'engine cleanup is not asserted');
  call.respond(200, REPLY('늦은 답')); await flush();
  assert.equal(t3.c.snapshot().state, 'cancelled'); assert.deepEqual(t3.ed.inserts, []);

  const t4 = setup(); await toReview(t4);
  t4.c.cancel(); await flush();
  assert.equal(t4.c.snapshot().text, ''); assert.equal(await t4.c.insert(), null); assert.deepEqual(t4.ed.inserts, []);
  t4.c.close(); assert.equal(t4.c.view().visible, false);
});

test('study switch and A->B->A end the session through refresh(); the late 200 is never inserted', async () => {
  for (const move of [e => { e.uid = 'other'; e.selectionSeq += 1; }, e => { e.selectionSeq += 2; }]) {
    const t = setup(); const call = await toUpload(t);
    move(t.ed); t.c.refresh(); await flush();
    assert.equal(t.c.snapshot().state, 'cancelled');
    assert.equal(t.c.view().status, '검사가 바뀌어 받아쓰기를 멈췄습니다 · ' + CANCELLED);
    assert.equal(call.aborted, true);
    call.respond(200, REPLY('다른 검사의 글')); await flush();
    assert.deepEqual(t.ed.inserts, []);
  }
  const r = setup(); await toReview(r);
  r.ed.selectionSeq += 2; r.c.refresh();
  assert.equal(r.c.snapshot().state, 'cancelled', 'review text of a study left behind is discarded');
});

test('outside review a changed base or a newly blocked editor releases the microphone at once', async () => {
  for (const change of [e => { e.baseVersion += 1; }, e => { e.blocked = true; }]) {
    const t = setup(); await t.c.start();
    change(t.ed); t.c.refresh(); await flush();
    assert.equal(t.c.snapshot().state, 'failed'); assert.ok(t.m.allEnded()); assert.equal(t.net.calls.length, 0);
  }
});

test('a lost connection closes an open microphone but never costs a reviewed transcript', async () => {
  const idle = setup(); idle.ed.serverDown = true; idle.c.refresh();
  assert.equal(idle.c.view().block, '서버 없음');
  await idle.c.start(); await flush();
  assert.equal(idle.m.gumCalls, 0, 'no start without the server');
  assert.equal(idle.c.view().status, D.NOTICES['editor-blocked']);

  const rec = setup(); await rec.c.start();
  rec.ed.serverDown = true; rec.c.refresh(); await flush();
  assert.equal(rec.c.snapshot().state, 'failed'); assert.ok(rec.m.allEnded());

  const up = setup(); await toUpload(up);
  up.ed.serverDown = true; up.c.refresh();
  assert.equal(up.c.snapshot().state, 'uploading', 'the request in flight decides its own outcome');

  const rev = setup(); await toReview(rev);
  rev.ed.serverDown = true; rev.c.refresh();
  assert.equal(rev.c.snapshot().state, 'review');
  assert.equal((await rev.c.insert()).inserted, true, 'inserting is local, like a template');
});

test('automatic capture cap sends once without Stop and says so', async () => {
  const t = setup(); await t.c.start();
  t.m.deliver([5, 0]); await flush();
  assert.equal(t.net.calls.length, 1); assert.deepEqual(t.m.commands, []);
  assert.equal(t.c.view().status, D.STATUS.capped);
  t.net.calls[0].respond(200, REPLY('가')); await flush();
  assert.equal(t.c.snapshot().state, 'review');
});

test('permission refusal and a device ending while stopping each count as ONE failure (callback + rejection)', async () => {
  const t = setup({ media: { denied: true } });
  const before = t.c.snapshot().asrSeq;
  await t.c.start(); await flush();
  assert.equal(t.c.snapshot().state, 'failed');
  assert.equal(t.c.snapshot().asrSeq, before + 2, 'begin + one end, nothing more');
  assert.deepEqual(t.spy.fails.filter(f => f.moved).map(f => f.reason), ['DICTATION_CAPTURE_DENIED']);
  assert.match(t.c.view().status, /^마이크 사용이 허용되지 않았습니다/);
  assert.equal(t.net.calls.length, 0);

  const u = setup(); await u.c.start(); u.c.stop(); await flush();
  u.m.tracks[0].listeners.get('ended')(); await flush();
  assert.deepEqual(u.spy.fails.filter(f => f.moved).map(f => f.reason), ['DICTATION_CAPTURE_FAILED']);
  assert.equal(u.net.calls.length, 0); assert.ok(u.m.allEnded());
});

test('zero captured frames maps to a user message, not a transport attempt', async () => {
  const t = setup(); await t.c.start(); t.c.stop(); await flush();
  t.m.deliver([]); await flush();
  assert.equal(t.c.view().status, D.REASONS['capture-empty'] + ' — 판독문은 그대로입니다');
  assert.equal(t.net.calls.length, 0);
});

test('server and transport failures end in failed with the report unchanged', async () => {
  const cases = [
    [c => c.respond(413, '<html>too large</html>'), D.REASONS.DICTATION_AUDIO_TOO_LARGE],
    [c => c.respond(503, '{"code":"DICTATION_TIMEOUT","message":"DICTATION_TIMEOUT"}'), D.REASONS.DICTATION_TIMEOUT],
    [c => c.respond(503, '{"code":"DICTATION_ENGINE_FAILED","message":"DICTATION_ENGINE_FAILED"}'), D.REASONS.DICTATION_ENGINE_FAILED],
    [c => c.respond(409, '{"code":"REPORT_HELD","message":"다른 판독의가 판독 중입니다"}'), '다른 판독의가 판독 중입니다'],
    [c => c.respond(200, 'not json'), D.REASONS['invalid-response']],
    [c => c.respond(200, REPLY(' \n ')), D.REASONS['transcript-empty']],
    [c => c.respond(200, REPLY('x'.repeat(D.TEXT_CAP + 1))), D.REASONS['transcript-too-long']],
    [c => c.reject(new TypeError('network')), D.REASONS.network],
  ];
  for (const [answer, message] of cases) {
    const t = setup(); const call = await toUpload(t);
    answer(call); await flush();
    assert.equal(t.c.snapshot().state, 'failed', message);
    assert.equal(t.c.view().status, message + ' — 판독문은 그대로입니다');
    assert.deepEqual(t.ed.inserts, []); assert.equal(t.ed.values.findings, '첫 줄\n둘째 줄');
    assert.equal(t.timers.live().length, 0, 'the client timer is cleared');
  }
  const exact = setup(); const call = await toUpload(exact);
  call.respond(200, REPLY('x'.repeat(D.TEXT_CAP))); await flush();
  assert.equal(exact.c.snapshot().text.length, D.TEXT_CAP);
});

test('401 ends the run and signs out once; the client timeout aborts and a late answer is ignored', async () => {
  const t = setup(); const call = await toUpload(t);
  call.respond(401, ''); await flush();
  assert.equal(t.c.snapshot().state, 'failed'); assert.equal(t.logouts(), 1);

  const u = setup(); const late = await toUpload(u);
  u.timers.fire(); await flush();
  assert.equal(late.aborted, true);
  assert.equal(u.c.view().status, D.REASONS['client-timeout'] + ' — 판독문은 그대로입니다');
  late.respond(200, REPLY('늦음')); await flush();
  assert.equal(u.c.snapshot().state, 'failed'); assert.deepEqual(u.ed.inserts, []);
});

test('an edited field keeps the text, needs an explicit re-pin, and never inserts on re-pin alone', async () => {
  const t = setup(); await toReview(t, '추가 문장');
  t.ed.values.findings = '첫 줄\n둘째 줄 수정'; t.c.redraw();
  assert.equal(t.c.view().placement, D.STATUS.placementStale);
  const first = await t.c.insert();
  assert.equal(first.inserted, false); assert.equal(first.reason, 'field-changed');
  const v = t.c.view();
  assert.equal(v.state, 'review'); assert.equal(v.text, '추가 문장'); assert.equal(v.needsRepin, true);
  assert.equal(v.controls.insert, 'disabled'); assert.equal(v.controls.repin, 'enabled');
  assert.equal(v.status, D.NOTICES['field-changed']);
  assert.deepEqual(t.ed.inserts, []);
  t.ed.caret = { start: 6, end: 6 };
  await t.c.fieldClicked();
  assert.equal(t.c.snapshot().needsRepin, false);
  assert.deepEqual({ ...t.c.snapshot().pin.caret }, { start: 6, end: 6 });
  assert.deepEqual(t.ed.inserts, [], 're-pinning never inserts');
  assert.equal(t.c.view().status, D.NOTICES.repinned);
  const second = await t.c.insert();
  assert.equal(second.inserted, true);
  assert.equal(t.ed.inserts.length, 1); assert.equal(t.ed.inserts[0].expectedValue, '첫 줄\n둘째 줄 수정');
  assert.deepEqual({ ...t.ed.inserts[0].caret }, { start: 6, end: 6 });

  const idle = setup(); await toReview(idle);
  const pin = idle.c.snapshot().pin;
  idle.ed.caret = { start: 0, end: 0 };
  assert.equal(await idle.c.fieldClicked(), null, 'a click with nothing to re-pin changes nothing');
  assert.deepEqual({ ...idle.c.snapshot().pin.caret }, { ...pin.caret });
});

test('changed base, study or editor gate at Insert refuses and invalidates; nothing is written', async () => {
  for (const change of [e => { e.baseVersion += 1; }, e => { e.blocked = true; }, e => { e.selectionSeq += 1; }]) {
    const t = setup(); await toReview(t);
    change(t.ed);
    const res = await t.c.insert();
    assert.equal(res.inserted, false);
    assert.equal(t.c.snapshot().state, 'failed'); assert.equal(t.c.snapshot().text, '');
    assert.deepEqual(t.ed.inserts, []);
  }
});

test('a save in flight is transient; a refused or throwing write fails closed', async () => {
  const t = setup(); await toReview(t);
  t.ed.busy = true;
  assert.equal(await t.c.insert(), null);
  assert.equal(t.c.snapshot().state, 'review'); assert.equal(t.c.view().status, D.NOTICES['report-busy']);
  t.ed.busy = false;
  assert.equal((await t.c.insert()).inserted, true);

  for (const refuse of [true, 'throw']) {
    const u = setup(); await toReview(u); u.ed.refuse = refuse;
    const res = await u.c.insert();
    assert.equal(res.inserted, false);
    assert.equal(u.c.snapshot().state, 'failed');
    assert.equal(u.ed.values.findings, '첫 줄\n둘째 줄');
  }
});

test('capability withdrawn mid-recording and page exit both release; cleanup failure is reported', async () => {
  const t = setup(); await t.c.start();
  t.c.setServerCapability(null); await flush();
  assert.equal(t.c.snapshot().state, 'unavailable'); assert.ok(t.m.allEnded());
  assert.equal(t.c.view().status, D.REASONS.unavailable + ' — 판독문은 그대로입니다', 'the pane says why it stopped');
  t.c.close(); assert.equal(t.c.view().visible, false);

  const u = setup(); await u.c.start(); u.c.pageExit(); await flush();
  assert.equal(u.c.snapshot().state, 'cancelled'); assert.ok(u.m.allEnded());

  const throwing = { ...Capture, createCapture: options => {
    const inner = Capture.createCapture(options);
    return { start: inner.start, stop: inner.stop, get state() { return inner.state; },
      cancel: () => { inner.cancel(); throw new Error('cancel failed'); } };
  } };
  const w = setup({ capture: throwing }); await w.c.start(); w.c.cancel(); await flush();
  assert.equal(w.c.snapshot().cleanupFailed, true);
  assert.ok(w.c.view().status.endsWith(D.STATUS.cleanup));
});

test('a second Dictate press while the first is starting starts nothing', async () => {
  const t = setup();
  const a = t.c.start(), b = t.c.start();
  await Promise.all([a, b]); await flush();
  assert.equal(t.m.gumCalls, 1); assert.equal(t.m.contexts.length, 1);
});
