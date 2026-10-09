// REQ-LEGAL-D20 -> RISK-ASR-EXTERNAL-AUDIO -> TEST-ASR-DESTINATION.
// Pure configuration/transport contract: synthetic WAV and fake DNS/socket boundary,
// never a real DNS lookup, engine, patient audio or outbound network connection.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { isIP } = require('node:net');
const { Logger } = require('/app/node_modules/@nestjs/common');
const { AsrService, asrConfiguration, ASR_ENGINE_PIN, ASR_MODEL_PIN } = require('/app/dist/asr.service');
const saved = { ...process.env };
afterEach(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); });
function config(url) {
  Object.assign(process.env, { KIN_ASR_URL: url, KIN_ASR_ENGINE: ASR_ENGINE_PIN, KIN_ASR_MODEL: ASR_MODEL_PIN,
    KIN_ASR_LANGUAGE: 'ko', KIN_ASR_TIMEOUT_MS: '1000' });
}
function wav() {
  const b = Buffer.alloc(48); b.write('RIFF'); b.writeUInt32LE(40, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(4, 40); return b;
}
function boundary(t, answers = [{ address: '172.20.0.7', family: 4 }], status = 200) {
  const wire = [], logs = [], lookups = [];
  t.mock.method(Logger, 'error', (...args) => logs.push(args));
  t.mock.method(global, 'fetch', async () => assert.fail('uncontrolled fetch'));
  t.mock.method(dns, 'lookup', (host, options, callback) => {
    lookups.push(host);
    queueMicrotask(() => callback(answers instanceof Error ? answers : null, answers));
  });
  function request(url, options, received) {
    const req = new EventEmitter();
    req.end = body => {
      const connect = (error, addresses, family) => {
        if (error) { req.emit('error', error); return; }
        wire.push({ url: url.href, options, body, addresses, family });
        const res = Readable.from([Buffer.from('{"text":" 합성 판독\\n"}')]);
        res.statusCode = status; res.headers = { 'content-type': 'application/json', location: 'https://public.example/inference' };
        received(res);
      };
      const host = url.hostname.replace(/^\[|\]$/g, '');
      queueMicrotask(() => {
        if (isIP(host)) connect(null, host, isIP(host));
        else options.lookup(host, { all: true }, connect);
      });
    };
    return req;
  }
  t.mock.method(http, 'request', request); t.mock.method(https, 'request', request);
  return { wire, logs, lookups };
}
const refused = error => error.getResponse().code === 'DICTATION_NOT_CONFIGURED';
const transcribe = () => new AsrService().transcribe(wav(), new AbortController().signal);

test('D20-local: service names and every allowed IP range preserve inference', async t => {
  const b = boundary(t);
  const hosts = ['engine', 'kin-asr-engine-u3', '10.0.0.1', '10.255.255.254', '172.16.0.1', '172.31.255.254',
    '192.168.0.1', '127.0.0.1', '169.254.1.2', '[::1]', '[fc00::1]', '[fdff::1]', '[fe80::1]',
    '[febf::1]', '[::ffff:192.168.1.2]'];
  for (const scheme of ['http', 'https']) for (const host of hosts) {
    config(`${scheme}://${host}:8080/inference`);
    assert.equal(asrConfiguration().available, true, host);
    assert.equal((await transcribe()).text, ' 합성 판독\n', host);
  }
  assert.equal(b.wire.length, hosts.length * 2);
  assert.equal(b.logs.length, 0);
});

test('D20-public: public, boundary, mapped and normalized IPs refuse before sending', async t => {
  const b = boundary(t);
  for (const host of ['8.8.8.8', '9.255.255.255', '11.0.0.0', '172.15.255.255', '172.32.0.0',
    '192.167.255.255', '192.169.0.0', '100.64.0.1', '0.0.0.0', '224.0.0.1', '169.253.255.255',
    '169.255.0.0', '[::]', '[2001:4860:4860::8888]', '[2001:db8::1]', '[fec0::1]', '[ff02::1]',
    '[::ffff:8.8.8.8]', '134744072', '0x08080808', '010.010.010.010']) {
    config(`http://${host}/inference`);
    assert.equal(asrConfiguration().available, false, host);
    await assert.rejects(transcribe(), refused, host);
  }
  assert.equal(b.wire.length, 0, 'public address sent audio');
  assert.equal(b.lookups.length, 0);
});

test('D20-url: public names, suffix and credential/port/path tricks fail closed', async t => {
  const b = boundary(t);
  for (const url of ['https://speech.example/inference', 'http://engine.example/inference',
    'http://engine.local/inference', 'http://engine./inference', 'http://user:secret@engine/inference',
    'http://10.0.0.1@public.example/inference', 'http://public.example@10.0.0.1/inference',
    'http://engine:0/inference', 'http://engine:65536/inference', 'http://engine:80:443/inference',
    'http://engine/inference?secret', 'http://engine/inference#secret', 'http://engine/inference?',
    'http://engine/other', 'file:///inference', 'ftp://engine/inference', 'http:\\engine/inference',
    'http://eng\nine/inference', 'http://[fe80::1%25eth0]/inference']) {
    config(url);
    assert.equal(asrConfiguration().available, false, url);
    await assert.rejects(transcribe(), refused, url);
  }
  assert.equal(b.wire.length, 0, 'invalid URL sent audio');
  assert.ok(b.logs.length > 0);
  const logged = JSON.stringify(b.logs);
  assert.match(logged, /KIN_ASR_URL/);
  assert.equal(logged.includes('secret'), false, 'operator log leaked configuration contents');
});

test('D20-dns: a compose-shaped name resolving to public or mixed addresses sends nothing', async t => {
  for (const answers of [[{ address: '8.8.8.8', family: 4 }],
    [{ address: '10.0.0.1', family: 4 }, { address: '2001:4860::1', family: 6 }],
    [], new Error('synthetic DNS failure')]) {
    const b = boundary(t, answers); config('https://engine:8443/inference');
    await assert.rejects(transcribe(), refused);
    assert.equal(b.wire.length, 0, 'DNS refusal sent audio');
    assert.ok(b.logs.length > 0, 'missing operator configuration error');
    t.mock.restoreAll();
  }
});

test('D20-pin: socket receives checked DNS answers once and rechecks on the next request', async t => {
  const answers = [{ address: '10.0.0.2', family: 4 }, { address: 'fd00::2', family: 6 }];
  const b = boundary(t, answers); config('https://engine:8443/inference');
  await transcribe();
  assert.deepEqual(b.wire[0].addresses, answers);
  assert.deepEqual(b.lookups, ['engine'], 'second DNS lookup can rebind');
  assert.notEqual(b.wire[0].options.rejectUnauthorized, false, 'TLS verification must remain enabled');
  answers.splice(0, answers.length, { address: '8.8.8.8', family: 4 });
  await assert.rejects(transcribe(), refused);
  assert.equal(b.wire.length, 1, 'changed DNS answer sent another audio request');
});

test('D20-protocol: multipart audio identity, no credentials and redirect refusal', async t => {
  const b = boundary(t); config('http://engine/inference');
  await transcribe();
  const sent = b.wire[0];
  const parsed = await new Response(sent.body, { headers: sent.options.headers }).formData();
  assert.deepEqual([...parsed.keys()], ['file', 'response_format', 'language']);
  assert.deepEqual(Buffer.from(await parsed.get('file').arrayBuffer()), wav());
  assert.equal(parsed.get('response_format'), 'json'); assert.equal(parsed.get('language'), 'ko');
  assert.deepEqual(Object.keys(sent.options.headers).sort(), ['content-length', 'content-type']);
  t.mock.restoreAll();
  const redirect = boundary(t, [{ address: '10.0.0.1', family: 4 }], 307);
  await assert.rejects(transcribe(), e => e.getResponse().code === 'DICTATION_ENGINE_FAILED');
  assert.equal(redirect.wire.length, 1, 'redirect followed');
});
