// Pure control-flow and byte tests. No browser, audio device, network or media files.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { MAX_BYTES, encodeWav, available, createCapture } = require('../worklist-v0/hpacs-lite/dictation-capture.js');
function inspect(bytes) {
  const b = Buffer.from(bytes); assert.equal(b.toString('ascii', 0, 4), 'RIFF'); assert.equal(b.readUInt32LE(4), b.length - 8);
  assert.equal(b.toString('ascii', 8, 16), 'WAVEfmt '); assert.equal(b.readUInt32LE(16), 16);
  assert.deepEqual([b.readUInt16LE(20), b.readUInt16LE(22), b.readUInt32LE(24), b.readUInt32LE(28), b.readUInt16LE(32), b.readUInt16LE(34)], [1, 1, 16000, 32000, 2, 16]);
  assert.equal(b.toString('ascii', 36, 40), 'data'); assert.equal(b.readUInt32LE(40), b.length - 44);
}
function fake({ media, rate = 16000, denied = false } = {}) {
  const tracks = [{ ended: false, listeners: new Map(), addEventListener(name, fn) { this.listeners.set(name, fn); },
    removeEventListener(name) { this.listeners.delete(name); }, stop() { this.ended = true; } }];
  const stream = { getTracks: () => tracks, getAudioTracks: () => tracks };
  const record = { tracks, stream };
  class Context {
    constructor() { record.context = this; this.sampleRate = rate; this.destination = {}; this.audioWorklet = { addModule: async path => { assert.equal(path, './dictation-worklet.js'); } }; }
    async resume() {}
    async close() { this.closed = true; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  }
  class Worklet {
    constructor(_context, name, options) { record.node = this; assert.equal(name, 'kin-dictation-pcm'); record.options = options; this.port = { postMessage: msg => record.command = msg, close() {} }; }
    connect() {}
    disconnect() {}
  }
  const env = { isSecureContext: true, AudioContext: Context, AudioWorkletNode: Worklet, navigator: { mediaDevices: {
    getUserMedia: media || (async constraints => { assert.equal(constraints.video, false); if (denied) { const e = new Error(); e.name = 'NotAllowedError'; throw e; } return stream; }) } } };
  record.env = env; record.deliver = pcm => record.node.port.onmessage({ data: { type: 'pcm', buffer: pcm.buffer } });
  return record;
}
test('canonical WAV exact bytes, offsets and sample values', () => {
  const source = Uint8Array.from([99, 99, 0, 128, 255, 127, 88, 88]); const view = source.subarray(2, 6);
  const encoded = encodeWav(view); inspect(encoded); assert.deepEqual([...encoded.slice(44)], [0, 128, 255, 127]); assert.equal(source[2], 0);
});
test('finite hard cap accepts maximum and refuses oversize/odd/empty/shared inputs', () => {
  inspect(encodeWav(new Uint8Array(MAX_BYTES - 44)));
  for (const input of [new Uint8Array(0), new Uint8Array(3), new Uint8Array(MAX_BYTES - 42), [], new Uint8Array(new SharedArrayBuffer(2))]) assert.throws(() => encodeWav(input));
  for (const cap of [45, MAX_BYTES + 1, Infinity, NaN]) assert.throws(() => createCapture({ maxBytes: cap }));
});
test('capability requires secure context and both browser audio APIs', () => {
  const f = fake(); assert.equal(available(f.env), true);
  for (const overrides of [{ isSecureContext: false }, { AudioContext: undefined }, { AudioWorkletNode: undefined }, { navigator: {} }]) assert.equal(available({ ...f.env, ...overrides }), false);
});
test('record-stop returns WAV once and closes every track and context', async () => {
  const f = fake(); const cap = createCapture({ env: f.env }); await cap.start(); assert.equal(cap.state, 'recording');
  const pending = cap.stop(); assert.equal(f.command.type, 'stop'); const pcm = Uint8Array.from([0, 0, 255, 127]); f.deliver(pcm);
  inspect(await pending); assert.equal(cap.state, 'consumed'); assert.equal(f.tracks.every(t => t.ended), true); assert.equal(f.context.closed, true);
  assert.deepEqual([...pcm], [0, 0, 0, 0]); await assert.rejects(cap.stop()); cap.cancel();
});
test('automatic cap completion is retrievable once and cancel discards completed bytes', async () => {
  const f = fake(); let notifications = 0; const cap = createCapture({ env: f.env, onComplete: () => notifications++ });
  await cap.start(); f.deliver(new Uint8Array(2)); assert.equal(cap.state, 'done'); assert.equal(notifications, 1); inspect(await cap.stop());
  const g = fake(); const next = createCapture({ env: g.env }); await next.start(); g.deliver(new Uint8Array(2)); next.cancel(); await assert.rejects(next.stop());
});
test('cancel while permission is pending stops late stream and never connects it', async () => {
  let grant; const media = new Promise(r => grant = r); const f = fake({ media: () => media }); const cap = createCapture({ env: f.env });
  const started = cap.start(); await new Promise(r => setImmediate(r)); cap.cancel(); grant(f.stream);
  await assert.rejects(started, /CANCELLED/); assert.equal(f.tracks.every(t => t.ended), true); assert.equal(f.node, undefined); assert.equal(f.context.closed, true);
});
test('permission denied is failed and closes context', async () => {
  const f = fake({ denied: true }); const cap = createCapture({ env: f.env }); await assert.rejects(cap.start(), /DENIED/); assert.equal(cap.state, 'failed'); assert.equal(f.context.closed, true);
});
test('device ending rejects pending stop, ends all tracks and removes listeners', async () => {
  const f = fake(); const cap = createCapture({ env: f.env }); await cap.start(); const pending = cap.stop();
  f.tracks[0].listeners.get('ended')(); await assert.rejects(pending, /FAILED/);
  assert.equal(cap.state, 'failed'); assert.equal(f.tracks[0].ended, true); assert.equal(f.tracks[0].listeners.size, 0);
});
test('actual AudioContext rate mismatch fails before acquiring microphone', async () => {
  const f = fake({ rate: 48000, media: () => assert.fail('microphone requested') }); const cap = createCapture({ env: f.env });
  await assert.rejects(cap.start(), /FORMAT/); assert.equal(f.context.closed, true);
});
test('cancel rejects a pending stop and repeated cleanup is safe', async () => {
  const f = fake(); const cap = createCapture({ env: f.env }); await cap.start(); const pending = cap.stop(); cap.cancel(); cap.cancel();
  await assert.rejects(pending, /CANCELLED/); assert.equal(cap.state, 'cancelled'); assert.equal(f.tracks[0].ended, true);
});
test('processor error and invalid empty PCM fail with no WAV result', async () => {
  for (const mode of ['error', 'empty']) { const f = fake(); const cap = createCapture({ env: f.env }); await cap.start();
    const pending = cap.stop(); if (mode === 'error') f.node.onprocessorerror(); else f.deliver(new Uint8Array(0));
    await assert.rejects(pending); assert.equal(cap.state, 'failed'); assert.equal(f.tracks[0].ended, true); }
});
function processor(maxFrames = 4, rate = 16000) {
  let Type; const messages = [];
  vm.runInNewContext(fs.readFileSync(require.resolve('../worklist-v0/hpacs-lite/dictation-worklet.js'), 'utf8'), {
    sampleRate: rate, Uint8Array, DataView, AudioWorkletProcessor: class { constructor() { this.port = { postMessage: value => messages.push(value) }; } },
    registerProcessor(name, type) { assert.equal(name, 'kin-dictation-pcm'); Type = type; }
  });
  return { instance: new Type({ processorOptions: { maxFrames } }), messages };
}
test('actual processor clamps samples, produces little endian, caps and sends only once', () => {
  const p = processor(); assert.equal(p.instance.process([[Float32Array.from([-2, -1, 0.5, 2, 0.3])]]), false);
  assert.equal(p.messages.length, 1); const b = Buffer.from(p.messages[0].buffer);
  assert.deepEqual([0, 2, 4, 6].map(i => b.readInt16LE(i)), [-32768, -32768, 16384, 32767]);
  p.instance.port.onmessage({ data: { type: 'stop' } }); assert.equal(p.messages.length, 1); assert.equal(p.instance.pcm.every(v => v === 0), true);
});
test('processor partial stop uses exact sample count, cancel never publishes PCM', () => {
  const p = processor(); assert.equal(p.instance.process([[]]), true); p.instance.process([[Float32Array.from([0.25])]]); p.instance.port.onmessage({ data: { type: 'stop' } });
  inspect(encodeWav(new Uint8Array(p.messages[0].buffer))); assert.equal(p.messages[0].buffer.byteLength, 2);
  const q = processor(); q.instance.process([[Float32Array.from([0.25])]]); q.instance.port.onmessage({ data: { type: 'cancel' } });
  assert.equal(q.instance.process([[Float32Array.from([1])]]), false); assert.equal(q.messages.length, 0); assert.equal(q.instance.pcm.every(v => v === 0), true);
});
test('processor rejects unsupported rate, multichannel or nonfinite samples', () => {
  assert.equal(processor(4, 48000).messages[0].type, 'error');
  for (const input of [[new Float32Array(1), new Float32Array(1)], [Float32Array.from([NaN])]]) {
    const p = processor(); assert.equal(p.instance.process([input]), false); assert.equal(p.messages[0].type, 'error');
  }
});
