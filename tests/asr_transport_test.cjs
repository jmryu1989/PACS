// REQ-LEGAL-D20 -> RISK-ASR-REBIND/REDIRECT/STUCK-SLOT -> TEST-ASR-TRANSPORT.
// Only process-owned ephemeral loopback listeners and synthetic WAV bytes; no stack,
// external DNS, engine, database, original credentials or clinical material.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const dns = require('node:dns');
const { once } = require('node:events');
const { AsrService, ASR_ENGINE_PIN, ASR_MODEL_PIN } = require('/app/dist/asr.service');
const saved = { ...process.env };
afterEach(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); });
function wav() {
  const b = Buffer.alloc(48); b.write('RIFF'); b.writeUInt32LE(40, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(4, 40); return b;
}
async function endpoint(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  Object.assign(process.env, { KIN_ASR_URL: `http://127.0.0.1:${server.address().port}/inference`,
    KIN_ASR_ENGINE: ASR_ENGINE_PIN, KIN_ASR_MODEL: ASR_MODEL_PIN, KIN_ASR_LANGUAGE: 'ko', KIN_ASR_TIMEOUT_MS: '2000' });
  return server;
}
const code = expected => e => e.getResponse().code === expected;
test('native transport connects a checked service name and preserves multipart bytes', async t => {
  let captured, lookups = 0;
  const server = await endpoint(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    captured = { headers: req.headers, body: Buffer.concat(chunks), path: req.url };
    res.end('{"text":"native synthetic"}');
  });
  process.env.KIN_ASR_URL = `http://engine:${server.address().port}/inference`;
  t.mock.method(dns, 'lookup', (host, options, callback) => {
    assert.equal(host, 'engine'); lookups++;
    queueMicrotask(() => callback(null, [{ address: '127.0.0.1', family: 4 }]));
  });
  const result = await new AsrService().transcribe(wav(), new AbortController().signal);
  assert.equal(result.text, 'native synthetic'); assert.equal(lookups, 1);
  assert.equal(captured.path, '/inference');
  assert.equal(captured.headers.host, `engine:${server.address().port}`);
  const form = await new Response(captured.body, { headers: captured.headers }).formData();
  assert.deepEqual(Buffer.from(await form.get('file').arrayBuffer()), wav());
  assert.deepEqual([...form.keys()], ['file', 'response_format', 'language']);
  await new AsrService().transcribe(wav(), new AbortController().signal);
  assert.equal(lookups, 2, 'each new request must check DNS even after a successful connection');
});
test('native redirect response never creates a follow-up request', async t => {
  let requests = 0;
  const server = await endpoint(t, (_req, res) => {
    requests++; res.writeHead(307, { location: `http://127.0.0.1:${server.address().port}/redirected` }); res.end();
  });
  await assert.rejects(new AsrService().transcribe(wav(), new AbortController().signal), code('DICTATION_ENGINE_FAILED'));
  assert.equal(requests, 1);
});
test('native stalled body retains busy slot; disconnect and timeout both permit recovery', async t => {
  let ready, stalled = true;
  await endpoint(t, (req, res) => {
    req.resume();
    if (!stalled) { res.end('{"text":"recovered"}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); ready();
  });
  const svc = new AsrService();
  for (const kind of ['disconnect', 'timeout']) {
    process.env.KIN_ASR_TIMEOUT_MS = kind === 'timeout' ? '100' : '2000';
    stalled = true;
    const entered = new Promise(resolve => { ready = resolve; });
    const abort = new AbortController();
    const pending = svc.transcribe(wav(), abort.signal);
    const rejected = assert.rejects(pending, code(kind === 'timeout' ? 'DICTATION_TIMEOUT' : 'DICTATION_ENGINE_FAILED'));
    await entered;
    await assert.rejects(svc.transcribe(wav(), new AbortController().signal), code('DICTATION_BUSY'));
    if (kind === 'disconnect') abort.abort();
    await rejected;
    stalled = false; process.env.KIN_ASR_TIMEOUT_MS = '2000';
    assert.equal((await svc.transcribe(wav(), new AbortController().signal)).text, 'recovered');
  }
});
