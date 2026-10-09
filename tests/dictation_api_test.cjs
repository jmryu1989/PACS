// Hosted compiled API, synthetic byte arrays and injected ASR transport: no engine/DB/audio files.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const transport = require('/app/dist/asr-destination');
const { AsrService, asrConfiguration, ASR_ENGINE_PIN, ASR_MODEL_PIN, ASR_RESPONSE_CAP } = require('/app/dist/asr.service');
const { DictationController, dictationDisconnect } = require('/app/dist/dictation.controller');
const { dictationParser } = require('/app/dist/dictation-parser');
const { PacsService } = require('/app/dist/pacs.service');
const originalFetch = transport.asrFetch;
const originalEnv = { ...process.env };
afterEach(() => { transport.asrFetch = originalFetch; for (const k of Object.keys(process.env)) if (!(k in originalEnv)) delete process.env[k]; Object.assign(process.env, originalEnv); });
function configure(extra = {}) {
  Object.assign(process.env, { KIN_ASR_URL: 'http://engine/inference', KIN_ASR_ENGINE: ASR_ENGINE_PIN,
    KIN_ASR_MODEL: ASR_MODEL_PIN, KIN_ASR_LANGUAGE: 'ko', KIN_ASR_TIMEOUT_MS: '1000' }, extra);
}
function wav() {
  const b = Buffer.alloc(48); b.write('RIFF'); b.writeUInt32LE(40, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(4, 40); return b;
}
const signal = () => new AbortController().signal;
const code = expected => e => e.getResponse().code === expected;
function channel() {
  const req = Object.assign(new EventEmitter(), { body: wav(), roles: ['radiologist'], sub: 'synthetic-sub',
    actor: 'synthetic-actor', institution: 'synthetic-institution', kind: 'member', complete: true, aborted: false });
  const res = Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false });
  return { req, res };
}
test('configuration is optional, strictly pinned, bounded and keeps URL private', () => {
  delete process.env.KIN_ASR_URL; assert.equal(new AsrService().capability().available, false);
  configure(); assert.equal(asrConfiguration().available, true); assert.equal('url' in new AsrService().capability(), false);
  for (const [name, value] of [['KIN_ASR_MAX_BYTES', '1048577'], ['KIN_ASR_TIMEOUT_MS', '240001'],
    ['KIN_ASR_MODEL', 'unattested'], ['KIN_ASR_ENGINE', 'other'], ['KIN_ASR_URL', 'http://user:secret@engine/inference'],
    ['KIN_ASR_URL', 'http://engine/inference?patient=secret'], ['KIN_ASR_URL', 'file:///inference'], ['KIN_ASR_LANGUAGE', 'detect_language']]) {
    configure({ KIN_ASR_MAX_BYTES: '1048576', [name]: value }); assert.equal(asrConfiguration().available, false, name);
  }
});
test('multipart allowlist, exact WAV identity, exact transcript including trailing LF', async () => {
  configure(); const bytes = wav(); const text = ' 합성 검사\r\n'; let called = 0;
  transport.asrFetch = async (url, options) => {
    called++; assert.equal(url, 'http://engine/inference'); assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit'); assert.equal(options.headers, undefined);
    assert.deepEqual([...options.body.keys()], ['file', 'response_format', 'language']);
    assert.equal(options.body.get('file').name, 'dictation.wav');
    assert.deepEqual(Buffer.from(await options.body.get('file').arrayBuffer()), bytes);
    assert.equal(options.body.get('response_format'), 'json'); assert.equal(options.body.get('language'), 'ko');
    return new Response(JSON.stringify({ text }));
  };
  const result = await new AsrService().transcribe(bytes, signal());
  assert.equal(result.text, text); assert.equal(result.seconds, 2 / 16000); assert.equal(called, 1);
});
test('invalid audio and pre-aborted channel never reach upstream', async () => {
  configure(); transport.asrFetch = async () => assert.fail('upstream reached'); const svc = new AsrService();
  await assert.rejects(svc.transcribe(Buffer.from('invalid'), signal()), code('DICTATION_AUDIO_INVALID'));
  await assert.rejects(svc.transcribe(Buffer.alloc(1048577), signal()), code('DICTATION_AUDIO_TOO_LARGE'));
  const abort = new AbortController(); abort.abort();
  await assert.rejects(svc.transcribe(wav(), abort.signal), code('DICTATION_ENGINE_FAILED'));
});
test('unconfigured engine never reaches upstream', async () => {
  configure({ KIN_ASR_ENGINE: 'wrong' }); transport.asrFetch = async () => assert.fail('upstream reached');
  await assert.rejects(new AsrService().transcribe(wav(), signal()), code('DICTATION_NOT_CONFIGURED'));
});
test('engine failures are generic; invalid/blank/oversize/malformed/invalid UTF8 results are rejected', async () => {
  configure();
  for (const body of ['{secret', JSON.stringify({ text: '' }), JSON.stringify({ text: ' \r\n' }),
    JSON.stringify({ text: 'x'.repeat(16385) }), JSON.stringify({ text: 3 }), Buffer.from([0xff])]) {
    transport.asrFetch = async () => new Response(body);
    await assert.rejects(new AsrService().transcribe(wav(), signal()), code('DICTATION_ENGINE_FAILED'));
  }
  transport.asrFetch = async () => new Response('SECRET', { status: 500 });
  await assert.rejects(new AsrService().transcribe(wav(), signal()), e => !JSON.stringify(e.getResponse()).includes('SECRET'));
});
test('UTF16 exact ceiling is accepted without normalization', async () => {
  configure(); const text = '😀'.repeat(8192); transport.asrFetch = async () => new Response(JSON.stringify({ text }));
  assert.equal((await new AsrService().transcribe(wav(), signal())).text, text);
});
test('upstream byte cap applies to declared and streamed bodies and cancels reader', async () => {
  configure(); const svc = new AsrService();
  transport.asrFetch = async () => new Response('{}', { headers: { 'content-length': String(ASR_RESPONSE_CAP + 1) } });
  await assert.rejects(svc.transcribe(wav(), signal()), code('DICTATION_ENGINE_FAILED'));
  let cancelled = false;
  transport.asrFetch = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(ASR_RESPONSE_CAP)); c.enqueue(new Uint8Array(1)); }, cancel() { cancelled = true; } }));
  await assert.rejects(svc.transcribe(wav(), signal()), code('DICTATION_ENGINE_FAILED')); assert.equal(cancelled, true);
});
test('busy slot covers pending body, abort frees slot, next request succeeds', async () => {
  configure(); const abort = new AbortController(); let entered;
  const ready = new Promise(r => entered = r);
  transport.asrFetch = async (_url, options) => new Response(new ReadableStream({ start(c) {
    options.signal.addEventListener('abort', () => c.error(new Error('aborted')), { once: true }); entered();
  } }));
  const svc = new AsrService(); const first = svc.transcribe(wav(), abort.signal);
  await ready;
  await assert.rejects(svc.transcribe(wav(), signal()), code('DICTATION_BUSY'));
  abort.abort(); await assert.rejects(first, code('DICTATION_ENGINE_FAILED'));
  transport.asrFetch = async () => new Response('{"text":"next"}');
  assert.equal((await svc.transcribe(wav(), signal())).text, 'next');
});
test('timeout settles KIN request and frees slot without claiming native inference stopped', async () => {
  configure({ KIN_ASR_TIMEOUT_MS: '15' }); const svc = new AsrService();
  transport.asrFetch = (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('stalled')), { once: true }));
  await assert.rejects(svc.transcribe(wav(), signal()), code('DICTATION_TIMEOUT'));
  transport.asrFetch = async () => new Response('{"text":"next"}');
  assert.equal((await svc.transcribe(wav(), signal())).text, 'next');
});
test('four disconnect cases and duplicate cleanup distinguish normal completion from loss', () => {
  const { req, res } = channel(); const c = dictationDisconnect(req, res);
  req.emit('close'); assert.equal(c.signal.aborted, false);
  res.writableEnded = true; res.emit('close'); assert.equal(c.signal.aborted, false);
  c.cleanup(); c.cleanup(); assert.equal(req.listenerCount('aborted'), 0); assert.equal(res.listenerCount('close'), 0);
  for (const event of ['aborted', 'response-close']) {
    const ch = channel(); const d = dictationDisconnect(ch.req, ch.res);
    if (event === 'aborted') ch.req.emit('aborted'); else ch.res.emit('close');
    assert.equal(d.signal.aborted, true); d.cleanup();
  }
});
test('controller rechecks gate, emits metadata-only single audit and never writes report', async () => {
  configure(); const calls = []; const ch = channel();
  const pacs = { dictationGate: async () => calls.push('gate'), dictationAudit: async (_uid, _c, detail) => calls.push(detail) };
  const asr = new AsrService(); transport.asrFetch = async () => new Response('{"text":"SECRET TRANSCRIPT"}');
  const result = await new DictationController(pacs, asr).dictate('1.2.3', ch.req, ch.res);
  assert.equal(result.text, 'SECRET TRANSCRIPT'); assert.equal(calls.length, 3);
  assert.deepEqual(calls.slice(0, 2), ['gate', 'gate']);
  assert.deepEqual(Object.keys(calls[2]).sort(), ['bytes', 'seconds', 'ms', 'engine', 'outcome'].sort());
  assert.equal(JSON.stringify(calls).includes('SECRET'), false); assert.equal(calls[2].outcome, 'success');
  assert.equal(ch.res.listenerCount('close'), 0);
});
test('gate refusal prevents inference; post-inference revocation refuses result with one audit', async () => {
  configure(); let gates = 0, audits = 0; const refusal = new Error('refused');
  const pacs = { dictationGate: async () => { if (++gates === 2) throw refusal; }, dictationAudit: async () => audits++ };
  transport.asrFetch = async () => new Response('{"text":"SECRET"}');
  let ch = channel(); await assert.rejects(new DictationController(pacs, new AsrService()).dictate('1.2.3', ch.req, ch.res), e => e === refusal);
  assert.equal(audits, 1);
  pacs.dictationGate = async () => { throw refusal; }; transport.asrFetch = async () => assert.fail('inference after refusal');
  ch = channel(); await assert.rejects(new DictationController(pacs, new AsrService()).dictate('1.2.3', ch.req, ch.res), e => e === refusal);
  assert.equal(audits, 1);
});
test('shared report gate preserves role, unverified, hold and preliminary refusals', async () => {
  // S9-U0b: the shared rules are reached through the service's public dictation gate (the controller's call) over a stub
  // store, as the real study row would answer them, not through a prototype instance with its study lookup replaced.
  let state = null;
  const db = { $executeRaw: async () => 0, $transaction: async fn => fn(db), studyState: { findUnique: async () => state } };
  const svc = new PacsService(db, {}, {}, { prepare: async () => {}, require: async () => {} });
  const caller = { actor: 'reader', roles: ['radiologist'], institution: 'synthetic', sub: 'reader-sub' };
  const study = fields => ({ uid: '1.2', institutionId: 'synthetic', teleInstitutionId: null, ...fields });
  state = study({ ss: 'Verified', rs: 'W' }); assert.equal(await svc.dictationGate('1.2', caller), undefined);
  await assert.rejects(svc.dictationGate('1.2', { ...caller, roles: ['technician'] }), e => e.getStatus() === 403);
  state = study({ ss: 'Unverified' }); await assert.rejects(svc.dictationGate('1.2', caller), e => e.getStatus() === 409);
  state = study({ ss: 'Verified', holder: 'other', heldAt: new Date().toISOString() });
  await assert.rejects(svc.dictationGate('1.2', caller), code('REPORT_HELD'));
  state = study({ ss: 'Verified', rs: 'P', preDoc: 'other', preReviewer: 'another' });
  await assert.rejects(svc.dictationGate('1.2', caller), e => e.getStatus() === 403);
  state = null; await assert.rejects(svc.dictationGate('1.2', caller), e => e.getStatus() === 404);
});
async function parse(bytes, headers = {}, path = '/api/studies/1.2/dictation') {
  const req = Readable.from([bytes]); req.headers = { 'content-type': 'audio/wav', 'content-length': String(bytes.length), ...headers };
  req.method = 'POST'; req.originalUrl = path;
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; } };
  await new Promise(resolve => dictationParser()(req, res, resolve)); return { req, res };
}
test('route parser produces exact bytes, bounds before buffering, rejects encodings and bypasses unrelated paths', async () => {
  configure(); const good = await parse(wav()); assert.deepEqual(good.req.body, wav()); assert.equal(good.res.headers['Cache-Control'], 'no-store');
  for (const headers of [{ 'content-type': 'application/json' }, { 'content-encoding': 'gzip' }]) {
    const bad = await parse(Buffer.from('SECRET'), headers); assert.equal(bad.req.dictationError.code, 'DICTATION_AUDIO_INVALID');
    assert.equal(bad.req._body, true); assert.equal(bad.req.body.length, 0);
  }
  const large = await parse(Buffer.alloc(1048577)); assert.equal(large.req.dictationError.code, 'DICTATION_AUDIO_TOO_LARGE');
  assert.equal(large.req.body.length, 0);
  const unrelated = await parse(wav(), {}, '/api/studies/1.2/report'); assert.equal(unrelated.req.body, undefined);
});

// REQ-DICTATION-REFUSAL -> RISK-P-BODY/REFUSAL-AUDIT -> CORE_R11_DICTATION (D642).
test('CORE_R11_DICTATION role -> institution -> unverified -> hold -> designation; rename/recycle, audit and no-store', async () => {
  const uid = '2.25.911', original = { uid, institutionId: 'synthetic-institution', teleInstitutionId: null,
    rs: 'P', ss: 'Unverified', em: 'N', holder: 'other-holder', heldAt: new Date().toISOString(),
    preDoc: 'old-label', preDocSub: 'subject-x', preReviewer: 'old-reviewer', preReviewerSub: 'reviewer-x' };
  let state = structuredClone(original), audits = [], inference = 0;
  const db = { studyState: { findUnique: async () => structuredClone(state) },
    auditLog: { create: async ({data}) => { audits.push(data); return data; } },
    $executeRaw: async () => 0, $transaction: async fn => fn(db) };
  const access = { prepare: async () => {}, require: async () => {} };
  const pacs = new PacsService(db, {}, {}, access);
  const asr = { capability: () => ({ maxBytes: 1048576, enginePin: 'synthetic' }),
    transcribe: async () => { inference++; return {text: 'SYNTHETIC TRANSCRIPT'}; } };
  const controller = new DictationController(pacs, asr);
  const x = { sub: 'subject-x', actor: 'renamed-x', roles: ['radiologist'], institution: 'synthetic-institution' };
  async function call(c) {
    const parsed = await parse(wav()); const ch = channel();
    Object.assign(ch.req, c, { body: parsed.req.body });
    assert.equal(parsed.res.headers['Cache-Control'], 'no-store');
    const before = structuredClone(state);
    let result; try { result = { status: 200, body: await controller.dictate(uid, ch.req, ch.res) }; }
    catch (e) { result = {status: e.getStatus(), body: e.getResponse()}; }
    assert.deepEqual(state, before, 'dictation stores no report/study changes');
    return result;
  }
  let result = await call({...x, roles:['technician'], institution:'outside'});
  assert.equal(result.status,403); assert.equal(result.body.message,'판독문 저장은(는) radiologist 권한이 필요합니다');
  result = await call({...x, institution:'outside'}); assert.equal(result.status,404);
  result = await call(x); assert.equal(result.status,409); assert.equal(result.body.message,'촬영 중(미확인) 검사입니다 — 기사 확인(Verify) 뒤 판독할 수 있습니다');
  state.ss='Verified'; result=await call(x); assert.equal(result.body.code,'REPORT_HELD');
  state.holder=null; state.heldAt=null;
  result=await call({...x,sub:'subject-y',actor:'old-label'}); assert.equal(result.status,403);
  assert.equal(result.body.message,'예비 판독(RS: P) 중입니다. old-reviewer만 이어서 판독할 수 있습니다.');
  assert.ok(!JSON.stringify(result).includes('TRANSCRIPT')); assert.equal(audits.length,0); assert.equal(inference,0);
  for(const c of [x,{...x,sub:'reviewer-x',actor:'renamed-reviewer'}]) {
    result=await call(c); assert.equal(result.status,200); assert.equal(result.body.text,'SYNTHETIC TRANSCRIPT');
  }
  assert.equal(audits.length,2); assert.ok(audits.every(a=>a.action==='dictation.request'));
  for(const a of audits) assert.deepEqual(Object.keys(JSON.parse(a.detail)).sort(),['bytes','engine','ms','outcome','seconds']);
  assert.ok(!JSON.stringify(audits).includes('TRANSCRIPT'));
  state.preDocSub=null; state.preReviewerSub=null;
  assert.equal((await call({...x,sub:'legacy-sub',actor:'old-label'})).status,200);
  assert.equal((await call(x)).status,403);
  // A revocation after inference must withhold the body and still record exactly one metadata audit.
  state.preDocSub=x.sub; asr.transcribe=async()=>{state.preDocSub='someone-else';return {text:'SYNTHETIC TRANSCRIPT'};};
  const ch=channel();Object.assign(ch.req,x);const count=audits.length;
  await assert.rejects(controller.dictate(uid,ch.req,ch.res),e=>e.getStatus()===403&&!JSON.stringify(e.getResponse()).includes('TRANSCRIPT'));
  assert.equal(audits.length,count+1);
});
