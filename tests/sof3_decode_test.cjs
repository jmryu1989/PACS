// REQ-MG-SOF3-DECODE -> RISK-MG-SOF3-PIXEL, RISK-MG-SOF3-FALLBACK, RISK-CODEC-SUPPLY ->
// TEST-MG-SOF3-EQUALITY, TEST-MG-SOF3-FALLBACK, TEST-SOF3-WASM-REPRODUCIBLE.
// The shipped artifact, host glue, decode worker and viewer pool run here unchanged: the worker script executes in a
// vm context behind a Worker stand-in (structured clone with transfer, asynchronous delivery), with the real wasm.
// Expected samples are the encoder input (seed formula, mirrored in scripts/sof3/make_test_cases.py, where every
// codestream was also decoded equal through pydicom + GDCM). No timing is asserted.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const LITE = path.join(ROOT, 'worklist-v0/hpacs-lite');
const wasm = fs.readFileSync(path.join(LITE, 'kin-sof3.wasm'));
const KinSof3 = require(path.join(LITE, 'kin-sof3.js'));
const cases = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/sof3_cases.json'), 'utf8')).cases;
const byName = Object.fromEntries(cases.map(c => [c.name, c]));
const codestream = frame => new Uint8Array(Buffer.from(frame.codestream, 'base64'));
const LE = '1.2.840.10008.1.2.1';

function expected({ rows, columns, precision, components }, seed) {
  const mask = 2 ** precision - 1, out = new Uint16Array(rows * columns * components);
  let state = seed >>> 0;
  for (let i = 0; i < out.length; i++) {
    state = (state ^ (state << 13)) >>> 0; state = (state ^ (state >>> 17)) >>> 0; state = (state ^ (state << 5)) >>> 0;
    const pixel = Math.floor(i / components), x = pixel % columns, y = Math.floor(pixel / columns);
    out[i] = ((x * 37 + y * 101) * (Math.floor(mask / 512) + 1) + (state >>> 26)) & mask;
  }
  out[0] = mask; out[1] = 0;
  return out;
}
const firstDifference = (actual, wanted) => {
  if (actual.length !== wanted.length) return 'length ' + actual.length + ' != ' + wanted.length;
  for (let i = 0; i < wanted.length; i++) if (actual[i] !== wanted[i]) return 'sample ' + i + ': ' + actual[i] + ' != ' + wanted[i];
  return null;
};
const greyCases = cases.filter(c => c.components === 1);

test('the committed artifact is the recorded build and imports nothing beyond its WASI stubs and error hook', () => {
  const recorded = fs.readFileSync(path.join(LITE, 'kin-sof3.wasm.sha256'), 'ascii').split(/\s+/)[0];
  assert.equal(crypto.createHash('sha256').update(wasm).digest('hex'), recorded);
  const module = new WebAssembly.Module(wasm);
  assert.deepEqual(WebAssembly.Module.imports(module).map(i => i.module + '.' + i.name).sort(), [
    'env.kin_fail', 'wasi_snapshot_preview1.environ_get', 'wasi_snapshot_preview1.environ_sizes_get',
    'wasi_snapshot_preview1.fd_close', 'wasi_snapshot_preview1.fd_seek', 'wasi_snapshot_preview1.fd_write',
    'wasi_snapshot_preview1.proc_exit']);
});

test('every greyscale 2-D and multi-frame codestream decodes to the encoder input, through one long-lived instance', async () => {
  const decoder = await KinSof3.create(new WebAssembly.Module(wasm));
  let frames = 0;
  for (const item of greyCases) for (const frame of item.frames) {
    const { pixels, precision } = decoder.decode(codestream(frame), item);
    assert.equal(precision, item.precision, item.name);
    assert.equal(firstDifference(pixels, expected(item, frame.seed)), null, item.name + ' seed ' + frame.seed);
    frames++;
  }
  assert.ok(new Set(greyCases.map(c => c.precision)).size >= 5 && greyCases.some(c => c.predictor !== 1) && frames >= 11);
  assert.equal(decoder.broken, false);
});

test('truncated, damaged, colour or mis-sized streams are refused and never return padded samples', async () => {
  const module = new WebAssembly.Module(wasm), item = byName['p16-sv1-2d'], bytes = codestream(item.frames[0]);
  const corrupt = bytes.slice(); corrupt.fill(0xff, 200, 260);
  const refusals = [
    ['half of the stream', bytes.slice(0, bytes.length >> 1), item, /warning/],
    ['header only', bytes.slice(0, 40), item, /codestream/],
    ['marker garbage inside the scan', corrupt, item, /codestream/],
    ['three components', codestream(byName['rgb8-sv1'].frames[0]), byName['rgb8-sv1'], /3 components/],
    ['rows and columns swapped', bytes, { rows: item.columns, columns: item.rows }, /64x40 codestream for a 40x64 frame/],
  ];
  for (const [label, input, shape, reason] of refusals) {
    const decoder = await KinSof3.create(module);
    assert.throws(() => decoder.decode(input, shape), error =>
      error.code === 'SOF3_DECODE_REJECTED' && /decoder rejected the codestream/.test(error.message) && reason.test(error.message), label);
    assert.equal(decoder.broken, true, label);
    assert.throws(() => decoder.decode(bytes, item), /discarded/, label);
  }
  // A new instance from the same compiled module is unaffected by the refusals.
  const fresh = await KinSof3.create(module);
  assert.equal(firstDifference(fresh.decode(bytes, item).pixels, expected(item, item.frames[0].seed)), null);
});

// The browser Worker contract the pool relies on: a script URL, asynchronous structured-clone messages with transfer,
// onmessage/onerror, terminate(). The worker script itself and kin-sof3.js run unchanged in their own vm context.
function workerWorld({ wasmStatus = 200, scriptError = null } = {}) {
  const created = [];
  class Worker {
    constructor(url) {
      this.url = url; this.terminated = false; created.push(this);
      const worker = this;
      const deliver = (target, data, transfer) => {
        const copy = structuredClone(data, { transfer });
        setImmediate(() => { if (!worker.terminated) target(copy); });
      };
      const scope = vm.createContext({
        console, URL, TextDecoder, WebAssembly, setTimeout, Promise,
        location: { href: 'https://viewer.test' + url },
        fetch: async target => {
          assert.equal(String(target), 'https://viewer.test/worklist/hpacs-lite/kin-sof3.wasm');
          return { ok: wasmStatus === 200, status: wasmStatus, arrayBuffer: async () => wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.length) };
        },
        importScripts: name => {
          assert.equal(name, 'kin-sof3.js');
          vm.runInContext(fs.readFileSync(path.join(LITE, name), 'utf8'), scope, { filename: name });
        },
        postMessage: (data, transfer) => deliver(message => worker.onmessage?.({ data: message }), data, transfer),
      });
      scope.self = scope;
      this.post = (data, transfer) => deliver(message => scope.onmessage({ data: message }), data, transfer);
      setImmediate(() => {
        if (scriptError) { worker.onerror?.({ message: scriptError, preventDefault() {} }); return; }
        vm.runInContext(fs.readFileSync(path.join(LITE, 'sof3-decode-worker.js'), 'utf8'), scope, { filename: 'sof3-decode-worker.js' });
      });
    }
    postMessage(data, transfer) { this.post(data, transfer); }
    terminate() { this.terminated = true; }
  }
  // The pool source is the shipped config/ohif source file, evaluated as the classic script it is.
  const page = vm.createContext({ ArrayBuffer, Uint8Array, Set, Map, Promise, Error, String });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'config/ohif/sof3-decode.js'), 'utf8'), page, { filename: 'sof3-decode.js' });
  return { created, create: options => page.kinCreateSof3Decode({ WorkerClass: Worker, workerUrl: '/worklist/hpacs-lite/sof3-decode-worker.js', ...options }) };
}

function task(item, frame, overrides = {}) {
  return {
    transferSyntax: item.transferSyntax, pixelData: codestream(frame), decodeConfig: { convertFloatPixelDataToInt: false },
    options: { preScale: { enabled: true }, targetBuffer: { type: 'Uint16Array' } },
    imageFrame: { rows: item.rows, columns: item.columns, bitsAllocated: 16, samplesPerPixel: 1, pixelRepresentation: 0, bitsStored: 16 },
    ...overrides,
  };
}

test('routed frames reach the pinned worker as Explicit VR Little Endian with the decoded samples, nothing else changed', async () => {
  const world = workerWorld(), pool = world.create({ size: 3 });
  const jobs = [];
  for (const item of greyCases) for (const frame of item.frames) jobs.push({ item, frame, task: task(item, frame) });
  const dispatched = [];
  const results = await Promise.all(jobs.map(job => pool.decode(job.task, forwarded => {
    dispatched.push(forwarded);
    return Promise.resolve({ forwarded });
  })));
  assert.equal(world.created.length, 3, 'more frames than workers share the pool');
  results.forEach(({ forwarded }, index) => {
    const { item, frame, task: original } = jobs[index];
    assert.equal(forwarded.transferSyntax, LE);
    assert.equal(Object.prototype.toString.call(forwarded.pixelData), '[object Uint8Array]');
    const samples = new Uint16Array(forwarded.pixelData.buffer, forwarded.pixelData.byteOffset, forwarded.pixelData.length / 2);
    assert.equal(firstDifference(samples, expected(item, frame.seed)), null, item.name);
    for (const key of ['imageFrame', 'options', 'decodeConfig']) assert.equal(forwarded[key], original[key], key);
    // The loader's own codestream is untouched (the fallback path would still have it).
    assert.equal(firstDifference(original.pixelData, codestream(frame)), null);
  });
  assert.equal(dispatched.length, jobs.length);
  assert.deepEqual({ ...pool.state() }, { unavailable: null, workers: 3, queued: 0, routed: jobs.length, fallbacks: 0, rejected: 0 });
  pool.stop();
  assert.ok(world.created.every(worker => worker.terminated));
});

test('other syntaxes and frame shapes stay on the pinned path without starting a worker', () => {
  const world = workerWorld(), pool = world.create({}), item = byName['p16-sv1-2d'], frame = item.frames[0];
  const base = task(item, frame);
  const untouched = [
    task(item, frame, { transferSyntax: '1.2.840.10008.1.2.4.80' }), task(item, frame, { transferSyntax: '1.2.840.10008.1.2.4.90' }),
    task(item, frame, { transferSyntax: '1.2.840.10008.1.2.4.50' }), task(item, frame, { transferSyntax: LE }),
    task(item, frame, { imageFrame: { ...base.imageFrame, bitsAllocated: 8 } }),
    task(item, frame, { imageFrame: { ...base.imageFrame, samplesPerPixel: 3 } }),
    task(item, frame, { imageFrame: { ...base.imageFrame, pixelRepresentation: 1 } }),
    task(item, frame, { imageFrame: undefined }), task(item, frame, { pixelData: undefined }), undefined,
  ];
  for (const candidate of untouched) assert.equal(pool.decode(candidate, () => assert.fail('dispatched')), null);
  assert.equal(world.created.length, 0);
});

test('a refused stream rejects with the decoder reason and is never handed to the pinned decoder', async () => {
  const world = workerWorld(), pool = world.create({ size: 1 }), item = byName['p16-sv1-2d'], frame = item.frames[0];
  const truncated = task(item, frame, { pixelData: codestream(frame).slice(0, 2000) });
  await assert.rejects(pool.decode(truncated, () => assert.fail('a refused stream reached the pinned decoder')),
    error => /JPEG lossless decoder rejected the codestream: \d+ warning/.test(error.message));
  // The same worker replaces its instance and decodes the next frame correctly.
  const forwarded = await pool.decode(task(item, frame), value => value);
  assert.equal(firstDifference(new Uint16Array(forwarded.pixelData.buffer), expected(item, frame.seed)), null);
  assert.deepEqual({ ...pool.state() }, { unavailable: null, workers: 1, queued: 0, routed: 1, fallbacks: 0, rejected: 1 });
  pool.stop();
});

test('a decoder that cannot load sends queued frames down the unchanged pinned path and stays off for the page', async () => {
  for (const [label, options] of [['wasm 404', { wasmStatus: 404 }], ['worker script failed', { scriptError: 'importScripts failed' }]]) {
    const world = workerWorld(options), pool = world.create({ size: 2 }), item = byName['p12-sv1-multiframe'];
    const tasks = item.frames.concat(item.frames).map(frame => task(item, frame));
    const results = await Promise.all(tasks.map(original => pool.decode(original, forwarded => ({ forwarded }))));
    results.forEach(({ forwarded }, index) => assert.equal(forwarded, tasks[index], label + ': the original task object'));
    const state = pool.state();
    assert.match(String(state.unavailable), label === 'wasm 404' ? /HTTP 404/ : /importScripts failed/);
    assert.equal(state.fallbacks, tasks.length, label);
    assert.equal(pool.decode(task(item, item.frames[0]), () => assert.fail('decoded')), null, label + ': later frames skip the pool');
    assert.ok(world.created.every(worker => worker.terminated), label);
  }
});

test('stopping the pool returns frames still waiting to the pinned path; the next mode entry starts a new pool', async () => {
  const world = workerWorld(), pool = world.create({ size: 1 }), item = byName['p16-sv1-multiframe'];
  const tasks = item.frames.map(frame => task(item, frame));
  const pending = tasks.map(original => pool.decode(original, forwarded => ({ forwarded })));
  pool.stop();
  const results = await Promise.all(pending);
  results.forEach(({ forwarded }, index) => assert.equal(forwarded, tasks[index]));
  assert.equal(pool.state().unavailable, null);
  const again = await pool.decode(task(item, item.frames[0]), forwarded => forwarded);
  assert.equal(again.transferSyntax, LE);
  assert.equal(world.created.length, 2);
  pool.stop();
});
