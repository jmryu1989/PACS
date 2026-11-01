'use strict';
// REQ-MG-PRELOAD-CACHE -> RISK-PRELOAD-STARVES-READING / RISK-PRELOAD-CROSS-SESSION / RISK-PRELOAD-UNRECORDED-VIEW
// -> TEST-MG-PRELOAD-WORKER: the preload SharedWorker (worklist-v0/hpacs-lite/preload-worker.js) run as written, in a VM
// context with the browser APIs it uses, against a scripted server. What is checked is the worker's contract: every byte
// is an ordinary bound frame read (gate and 열람 record are the server's), reading pauses the queue, a session never sees
// another session's store, and an ended session drops its key and keeps ciphertext.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');

const DIR = path.join(__dirname, '..', 'worklist-v0', 'hpacs-lite');
const STUDY = '1.2.840.9.1', OTHER = '1.2.840.9.2';
const PART = 'multipart/related; type="application/octet-stream"; boundary=b1';
const multipart = payload => Buffer.concat([Buffer.from('--b1\r\nContent-Type: application/octet-stream\r\n\r\n'),
  Buffer.from(payload), Buffer.from('\r\n--b1--')]);
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(check, what) {
  for (let i = 0; i < 400; i++) { if (check()) return; await tick(); }
  assert.fail('timed out waiting for ' + what);
}

/** The metadata of a study: one two-frame object and one single-frame object, and a non-image object. */
function metadata(study) {
  const item = (series, sop, frames) => ({ '0020000E': { Value: [series] }, '00080018': { Value: [sop] },
    ...(frames ? { '00280008': { Value: [frames] } } : {}), '7FE00010': { BulkDataURI: 'x' } });
  return [item(study + '.1', study + '.1.1', 2), item(study + '.2', study + '.2.1', null),
    { '0020000E': { Value: [study + '.3'] }, '00080018': { Value: [study + '.3.1'] } }];
}

// The adapter double proves control flow only. preload_disk_browser_test.cjs exercises real Chromium IndexedDB.
function memoryDisk() {
  const frames = new Map(), studies = new Map(), deleted = [];
  return { frames, studies, deleted,
    async list() { return { frames: structuredClone([...frames.values()]), studies: structuredClone([...studies.values()]) }; },
    async get(id) { return structuredClone(frames.get(id) || null); },
    async write(puts = {}, deletes = {}) {
      for (const [name, map] of [['frames', frames], ['studies', studies]]) {
        for (const id of deletes[name] || []) { map.delete(id); deleted.push(id); }
        for (const value of puts[name] || []) map.set(value.entryId || value.manifestId, structuredClone(value));
      }
    },
    async sweep(now) { let removed=0; for (const map of [frames, studies]) for (const [id, value] of map) if (value.expiresAt <= now) { map.delete(id); deleted.push(id); removed++; } return removed; },
    async estimate() { return {usage: [...frames.values(), ...studies.values()].reduce((n,r)=>n+r.ct.byteLength,0), quota: Infinity}; },
  };
}
const { webcrypto, randomBytes } = require('node:crypto');
const KEY = randomBytes(32), SERVER_START = Date.parse('2026-10-30T00:00:00Z');
function boot({ diskGb = 0.25, respond, disk = memoryDisk(), skew = 0, keyResponse, unavailableDisk = false } = {}) {
  const requests = [], timers = [], imports = [], decryptKeys = [];
  let clock = SERVER_START;
  const me = () => new Response(JSON.stringify({ kind: 'member', preloadDiskGb: diskGb }), { headers: { 'Content-Type': 'application/json' } });
  const images = respond || (async url => {
    const study = /\/studies\/([0-9.]+)\//.exec(url)[1];
    if (url.endsWith('/metadata')) return new Response(JSON.stringify(metadata(study)), { headers: { 'Content-Type': 'application/dicom+json' } });
    const body = zlib.gzipSync(Buffer.from('--b1\r\nContent-Type: application/octet-stream\r\n\r\nframe ' + url + '\r\n--b1--'));
    return new Response(body, { headers: { Date: new Date(clock).toUTCString(), 'Content-Length': String(body.length), 'Content-Type': 'application/gzip', 'X-KIN-Part-Type': PART, 'X-KIN-Study-Revision': 'orthanc-study:s@1' } });
  });
  const server = (url, init) => url === '/api/me' ? me() : url === '/api/preload/cache-key'
    ? keyResponse ? keyResponse(init) : new Response(JSON.stringify({keyId:'key-A', key:KEY.toString('base64'),serverTime:new Date(clock).toISOString()})) : images(url, init);
  let gate = null;
  const context = {
    navigator: {storage:{estimate:()=>disk.estimate()}}, Blob, Response, DecompressionStream, AbortController, URL, Headers, setTimeout, console,
    TextEncoder, TextDecoder, atob, Uint8Array, Date: class extends Date { static now(){return clock+skew;} },
    crypto: { randomUUID:()=>webcrypto.randomUUID(), getRandomValues:b=>webcrypto.getRandomValues(b),
      subtle: { encrypt:(...a)=>webcrypto.subtle.encrypt(...a),
        decrypt:(...a)=> { decryptKeys.push(a[1]); return webcrypto.subtle.decrypt(...a); },
        importKey: async (...args)=> { const key = await webcrypto.subtle.importKey(...args); imports.push({raw:args[1], key}); return key; } } },
    setInterval: fn => { timers.push(fn); return 1; },
    fetch: async (url, init) => {
      requests.push({ url, init });
      if (gate && !url.startsWith('/api/')) await gate;
      if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return server(url, init);
    },
    importScripts: (...names) => {
      for (const name of names) vm.runInContext(fs.readFileSync(path.join(DIR, name), 'utf8'), context);
      context.KinPreloadDisk = {...context.KinPreloadDisk, create:()=>unavailableDisk ? {...disk,list:async()=>{throw new Error('blocked');}} : disk};
    },
  };
  context.self = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(DIR, 'preload-worker.js'), 'utf8'), context);
  const connect = () => {
    const port = { received: [], postMessage(message) { this.received.push(structuredClone(message)); }, start() {} };
    context.onconnect({ ports: [port] });
    port.send = data => port.onmessage({ data });
    port.state = () => [...port.received].reverse().find(m => m.type === 'state');
    port.ask = async data => {
      const id = Math.random(); port.send({ ...data, id });
      await until(() => port.received.some(m => m.type === 'reply' && m.id === id), data.type + ' reply');
      return port.received.find(m => m.type === 'reply' && m.id === id);
    };
    return port;
  };
  const reads = () => requests.filter(r => !r.url.startsWith('/api/'));
  return { requests, reads, connect, disk, imports, decryptKeys, advance:ms=>{clock+=ms;}, sweep:()=>timers.forEach(fn=>fn()),
    hold: () => { let open; gate = new Promise(resolve => { open = resolve; }); return () => { gate = null; open(); }; } };
}

const statusOf = (port, uid) => port.state()?.studies.find(s => s.uid === uid);

test('Preload fetches metadata, then each object\'s first frame, then the rest - every read bound, no-store, stored form', async () => {
  const { requests, reads, connect } = boot();
  const list = connect();
  list.send({ type: 'hello', role: 'list' });
  list.send({ type: 'add', session: 'sess-1', studies: [{ uid: STUDY, label: 'SYN-1 · Synthetic^Patient' }] });
  await until(() => statusOf(list, STUDY)?.status === 'Ready', 'Ready');
  assert.equal(requests[0].url, '/api/preload/cache-key', 'one silent key read for the session');
  assert.equal(requests[0].init.headers['X-KIN-Session'], 'sess-1');
  assert.deepEqual(reads().map(r => r.url), [
    `/dicom-web/studies/${STUDY}/metadata`,
    `/dicom-web/studies/${STUDY}/series/${STUDY}.1/instances/${STUDY}.1.1/frames/1`,
    `/dicom-web/studies/${STUDY}/series/${STUDY}.2/instances/${STUDY}.2.1/frames/1`,
    `/dicom-web/studies/${STUDY}/series/${STUDY}.1/instances/${STUDY}.1.1/frames/2`,
  ]);
  for (const { init } of reads()) {
    assert.equal(init.headers['X-KIN-Session'], 'sess-1');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.priority, 'low');
  }
  for (const { init } of reads().slice(1)) assert.equal(init.headers['X-KIN-Preload'], 'store');
  const state = statusOf(list, STUDY);
  assert.deepEqual([state.done, state.total, state.label], [3, 3, 'SYN-1 · Synthetic^Patient']);
  assert.ok(list.state().used > 0 && list.state().used <= list.state().budget);
});

test('a viewer of the same session gets the decoded frame and the revision; another session gets nothing', async () => {
  const { connect } = boot();
  const list = connect();
  list.send({ type: 'hello', role: 'list' });
  list.send({ type: 'add', session: 'sess-1', studies: [{ uid: STUDY }] });
  await until(() => statusOf(list, STUDY)?.status === 'Ready', 'Ready');
  const viewer = connect();
  viewer.send({ type: 'hello', role: 'viewer' });
  const held = (await viewer.ask({ type: 'query', uid: STUDY, session: 'sess-1' })).held;
  assert.equal(held.revision, 'orthanc-study:s@1');
  const frame = `/dicom-web/studies/${STUDY}/series/${STUDY}.1/instances/${STUDY}.1.1/frames/2`;
  const ask = session => viewer.ask({ type: 'frame', path: frame, session, copy: held.copy });
  const answer = await ask('sess-1');
  assert.equal(Buffer.from(answer.bytes).toString(), '--b1\r\nContent-Type: application/octet-stream\r\n\r\nframe ' + frame + '\r\n--b1--');
  assert.equal(answer.partType, PART);
  // The same frame twice: the store keeps its bytes (the first answer was handed over, not the held copy).
  assert.equal(Buffer.from((await ask('sess-1')).bytes).length, answer.bytes.byteLength);
  assert.equal((await viewer.ask({ type: 'query', uid: STUDY, session: 'sess-2' })).held, null);
  assert.equal((await ask('sess-2')).bytes, null);
  assert.equal((await viewer.ask({ type: 'frame', path: frame, session: 'sess-1' })).bytes, null, 'a frame read names the copy it checked');
});

test('reading comes first: while a viewer loads from the network, no new preload fetch starts', async () => {
  const { reads, connect } = boot();
  const viewer = connect();
  viewer.send({ type: 'hello', role: 'viewer' });
  viewer.send({ type: 'busy', busy: true });
  const list = connect();
  list.send({ type: 'hello', role: 'list' });
  list.send({ type: 'add', session: 'sess-1', studies: [{ uid: STUDY }] });
  await until(() => list.state()?.budget, 'prerequisites');
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(reads().length, 0, 'no preload request while the viewer is busy');
  assert.equal(statusOf(list, STUDY).status, 'Queued');
  viewer.send({ type: 'busy', busy: false });
  await until(() => statusOf(list, STUDY)?.status === 'Ready', 'Ready after the viewer went idle');
  // A viewer window that leaves while busy does not park the queue.
  viewer.send({ type: 'busy', busy: true });
  list.send({ type: 'add', session: 'sess-1', studies: [{ uid: OTHER }] });
  await until(() => statusOf(list, OTHER)?.status === 'Queued', 'second study queued');
  viewer.send({ type: 'bye' });
  await until(() => statusOf(list, OTHER)?.status === 'Ready', 'second study Ready after bye');
});

test('reading comes first after metadata: frame reads pause until the viewer is idle', async () => {
  const { reads, connect, hold } = boot();
  const viewer = connect();
  viewer.send({ type: 'hello', role: 'viewer' });
  const list = connect();
  list.send({ type: 'hello', role: 'list' });
  const release = hold();
  list.send({ type: 'add', session: 'sess-1', studies: [{ uid: STUDY }] });
  await until(() => reads().length === 1, 'metadata request');
  viewer.send({ type: 'busy', busy: true });
  release();
  try {
    for (let i = 0; i < 20; i++) await tick();
    assert.equal(reads().length, 1, 'metadata may finish but no frame starts while reading');
    assert.equal(statusOf(list, STUDY).status, 'Downloading');
  } finally {
    viewer.send({ type: 'busy', busy: false });
  }
  await until(() => statusOf(list, STUDY)?.status === 'Ready', 'Ready after reading');
  assert.equal(reads().length, 4, 'all frames resume');
});

test('reading comes first in the middle of a study: after a frame, the next one waits until the viewer is idle', async () => {
  const { reads, connect, hold } = boot();
  const viewer = connect();
  viewer.send({ type: 'hello', role: 'viewer' });
  const list = connect();
  list.send({ type: 'hello', role: 'list' });
  let release = hold();
  list.send({ type: 'add', session: 'sess-1', studies: [{ uid: STUDY }] });
  await until(() => reads().length === 1, 'metadata request');
  release(); release = hold();
  await until(() => reads().length === 2, 'first frame request');
  viewer.send({ type: 'busy', busy: true });
  release();
  try {
    await until(() => statusOf(list, STUDY)?.done === 1, 'the first frame stored');
    for (let i = 0; i < 20; i++) await tick();
    assert.equal(reads().length, 2, 'the first frame finishes but no later frame starts while reading');
    assert.equal(statusOf(list, STUDY).status, 'Downloading');
  } finally {
    viewer.send({ type: 'busy', busy: false });
  }
  await until(() => statusOf(list, STUDY)?.status === 'Ready', 'Ready after reading');
  assert.equal(reads().length, 4, 'the rest resumes');
});

test('a session that ended on the server empties the store; a new session never sees the old one', async () => {
  let refuse = false;
  const { connect } = boot({ respond: async url => {
    if (refuse) return new Response('{}', { status: 401, headers: { 'X-KIN-Auth-Code': 'AUTH_SESSION_ENDED' } });
    const study = /\/studies\/([0-9.]+)\//.exec(url)[1];
    if (url.endsWith('/metadata')) return new Response(JSON.stringify(metadata(study)));
    return new Response(zlib.gzipSync(multipart('x')), { headers: { 'Content-Type': 'application/gzip', 'X-KIN-Part-Type': PART, 'X-KIN-Study-Revision': 'r' } });
  } });
  const list = connect();
  list.send({ type: 'hello', role: 'list' });
  list.send({ type: 'add', session: 'sess-1', studies: [{ uid: STUDY }] });
  await until(() => statusOf(list, STUDY)?.status === 'Ready', 'Ready');
  refuse = true;
  list.send({ type: 'add', session: 'sess-1', studies: [{ uid: OTHER }] });
  await until(() => list.state()?.session === null, 'key dropped on AUTH_SESSION_ENDED');
  assert.equal(list.state().used, 0);
  assert.equal(list.state().studies.length, 0);
  // Another login: whatever is held under the old session goes before the new session's queue starts.
  refuse = false;
  list.send({ type: 'retry', uid: STUDY });
  await tick();
  list.send({ type: 'add', session: 'sess-2', studies: [{ uid: OTHER }] });
  await until(() => statusOf(list, OTHER)?.status === 'Ready', 'Ready under the new session');
  const viewer = connect();
  viewer.send({ type: 'hello', role: 'viewer' });
  assert.equal((await viewer.ask({ type: 'query', uid: OTHER, session: 'sess-1' })).held, null);
  // The worklist reports its session ended: nothing stays.
  list.send({ type: 'session', session: null });
  await tick();
  assert.equal(list.state().used, 0);
  assert.equal(list.state().studies.length, 0);
});

test('Clear All while a study\'s metadata is read leaves it Evicted; a window that said goodbye can come back', async () => {
  const { reads, connect, hold } = boot();
  const list = connect();
  list.send({ type: 'hello', role: 'list' });
  const release = hold();
  list.send({ type: 'add', session: 'sess-1', studies: [{ uid: STUDY }] });
  await until(() => reads().length === 1, 'metadata read started');
  list.send({ type: 'clear' });
  release();
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(statusOf(list, STUDY).status, 'Evicted');
  assert.equal(reads().length, 1, 'no frame read after the clear');
  list.send({ type: 'bye' });
  list.send({ type: 'hello', role: 'list' });
  list.send({ type: 'retry', uid: STUDY });
  await until(() => statusOf(list, STUDY)?.status === 'Ready', 'Ready after coming back');
});

test('a refused, missing or changing study fails with a reason and Retry; a browser without usable disk gets no preload', async () => {
  let revision = 0;
  const { connect } = boot({ respond: async (url) => {
    const study = /\/studies\/([0-9.]+)\//.exec(url)[1];
    if (study === OTHER) return new Response('{}', { status: 403 });
    if (url.endsWith('/metadata')) return new Response(JSON.stringify(metadata(study)));
    return new Response(zlib.gzipSync(multipart('x')), { headers: { 'Content-Type': 'application/gzip', 'X-KIN-Part-Type': PART, 'X-KIN-Study-Revision': 'r' + (++revision) } });
  } });
  const list = connect();
  list.send({ type: 'hello', role: 'list' });
  list.send({ type: 'add', session: 'sess-1', studies: [{ uid: STUDY }, { uid: OTHER }] });
  await until(() => statusOf(list, OTHER)?.status === 'Failed' && statusOf(list, STUDY)?.status === 'Failed', 'both failed');
  assert.match(statusOf(list, STUDY).reason, /바뀌었습니다/);
  assert.match(statusOf(list, OTHER).reason, /거절/);
  assert.equal(list.state().studies.reduce((n,s)=>n+s.bytes,0), 0, 'failed frames removed; encrypted reasons remain');

  const bare = boot({ unavailableDisk: true }).connect();
  bare.send({ type: 'hello', role: 'list' });
  bare.send({ type: 'add', session: 'sess-1', studies: [{ uid: STUDY }] });
  await until(() => statusOf(bare, STUDY)?.status === 'Failed', 'failed without usable disk');
  assert.match(statusOf(bare, STUDY).reason, /저장소/);
  assert.equal(bare.state().budget, null);
});

test('a study that could not fit alone in the disk cap fails with the size reason, its bytes go, and the next study loads', async () => {
  // Synthetic cap includes ciphertext and manifest growth; A is too large and B fits.
  const random = n => require('node:crypto').randomBytes(n);
  const { reads, connect } = boot({ diskGb: 1500 / 1024 ** 3, respond: async url => {
    const study = /\/studies\/([0-9.]+)\//.exec(url)[1];
    if (url.endsWith('/metadata')) return new Response(JSON.stringify(metadata(study)));
    const body = study === STUDY ? zlib.gzipSync(multipart(random(600)), { level: 0 }) : zlib.gzipSync(multipart('x'));
    return new Response(body, { headers: { 'Content-Type': 'application/gzip', 'X-KIN-Part-Type': PART, 'X-KIN-Study-Revision': 'r' } });
  } });
  const list = connect();
  list.send({ type: 'hello', role: 'list' });
  list.send({ type: 'add', session: 'sess-1', studies: [{ uid: STUDY }, { uid: OTHER }] });
  await until(() => statusOf(list, STUDY)?.status === 'Failed' && statusOf(list, OTHER)?.status === 'Ready', 'A failed, B ready');
  assert.match(statusOf(list, STUDY).reason, /저장 용량보다 커서/);
  assert.equal(statusOf(list, STUDY).bytes, 0);
  assert.ok(list.state().used > statusOf(list, OTHER).bytes, 'B frames plus encrypted manifest');
  assert.ok(reads().some(r => r.url.includes(OTHER + '/series')), 'B\'s frames were requested');
});

test('Retry when this worker cannot preload keeps the study Failed with the reason and fetches nothing', async () => {
  for (const [options, reason] of [[{ unavailableDisk: true }, /저장소/], [{ diskGb: null }, /저장 용량/]]) {
    const { reads, connect } = boot(options);
    const list = connect();
    list.send({ type: 'hello', role: 'list' });
    list.send({ type: 'add', session: 'sess-1', studies: [{ uid: STUDY }] });
    await until(() => statusOf(list, STUDY)?.status === 'Failed', 'failed');
    assert.match(statusOf(list, STUDY).reason, reason);
    const states = list.received.length;
    list.send({ type: 'retry', uid: STUDY });
    await until(() => list.received.length > states, 'an answer to the Retry');
    for (let i = 0; i < 20; i++) await tick();
    assert.equal(statusOf(list, STUDY).status, 'Failed', 'not a Queued that never moves');
    assert.match(statusOf(list, STUDY).reason, reason);
    assert.equal(reads().length, 0, 'nothing fetched');
    assert.match(list.state().unavailable, reason, 'the panel says why');
  }
});

test('a viewer is answered from the copy it checked only: after Clear All and Retry the new copy is refused as stale', async () => {
  let revision = 'r1';
  const { connect } = boot({ respond: async url => {
    const study = /\/studies\/([0-9.]+)\//.exec(url)[1];
    if (url.endsWith('/metadata')) return new Response(JSON.stringify(metadata(study)));
    return new Response(zlib.gzipSync(Buffer.from('--b1\r\nContent-Type: application/octet-stream\r\n\r\nframe-' + revision + '\r\n--b1--')), { headers: { 'Content-Type': 'application/gzip', 'X-KIN-Part-Type': PART, 'X-KIN-Study-Revision': revision } });
  } });
  const list = connect();
  list.send({ type: 'hello', role: 'list' });
  list.send({ type: 'add', session: 'sess-1', studies: [{ uid: STUDY }] });
  await until(() => statusOf(list, STUDY)?.status === 'Ready', 'Ready r1');
  const viewer = connect();
  viewer.send({ type: 'hello', role: 'viewer' });
  const checked = (await viewer.ask({ type: 'query', uid: STUDY, session: 'sess-1' })).held;
  const frame = `/dicom-web/studies/${STUDY}/series/${STUDY}.1/instances/${STUDY}.1.1/frames/2`;
  assert.equal(Buffer.from((await viewer.ask({ type: 'frame', path: frame, session: 'sess-1', copy: checked.copy })).bytes).toString(), '--b1\r\nContent-Type: application/octet-stream\r\n\r\nframe-r1\r\n--b1--');
  list.send({ type: 'clear' });
  await until(() => statusOf(list, STUDY)?.status === 'Evicted', 'clear completed');
  revision = 'r2';
  list.send({ type: 'retry', uid: STUDY });
  await until(() => statusOf(list, STUDY)?.status === 'Ready', 'Ready r2');
  const stale = await viewer.ask({ type: 'frame', path: frame, session: 'sess-1', copy: checked.copy });
  assert.deepEqual([stale.bytes, stale.stale], [null, true], 'no r2 byte under the r1 check');
  const now = (await viewer.ask({ type: 'query', uid: STUDY, session: 'sess-1' })).held;
  assert.equal(now.revision, 'r2');
  assert.notEqual(now.copy, checked.copy);
  assert.equal(Buffer.from((await viewer.ask({ type: 'frame', path: frame, session: 'sess-1', copy: now.copy })).bytes).toString(), '--b1\r\nContent-Type: application/octet-stream\r\n\r\nframe-r2\r\n--b1--');
});

const FRAME = `/dicom-web/studies/${STUDY}/series/${STUDY}.1/instances/${STUDY}.1.1/frames/1`;
async function ready(h, uid=STUDY) {
  const list=h.connect(); list.send({type:'hello',role:'list'});
  list.send({type:'add',session:'sess-A',studies:[{uid,label:'SYN-123 · Synthetic^Patient'}]});
  await until(()=>statusOf(list,uid)?.status==='Ready','Ready'); return list;
}
const query = (p, session='sess-A', uid=STUDY) => p.ask({type:'query',session,uid});

// Both direct stored gzip and relayed multipart must retain the original codec, syntax and frame bytes.
for (const [media, syntax] of [
  ['application/octet-stream', '1.2.840.10008.1.2.1'],
  ['image/jpeg', '1.2.840.10008.1.2.4.50'],
  ['image/jls', '1.2.840.10008.1.2.4.80'],
  ['image/jp2', '1.2.840.10008.1.2.4.90'],
  ['image/dicom-rle', '1.2.840.10008.1.2.5'],
]) for (const gzip of [true, false]) {
  test(`cached ${media} (${gzip ? 'gzip' : 'multipart'}) preserves Content-Type immediately and after restart`, async () => {
    const type = `${media}; transfer-syntax=${syntax}`;
    const partType = `multipart/related; type="${type}"; boundary=b1`;
    const body = Buffer.concat([Buffer.from(`--b1\r\nContent-Location: ${FRAME}\r\nContent-Type: ${type}\r\n\r\n`),
      Buffer.from([0, 255, 1, 128]), Buffer.from('\r\n--b1--\r\n')]);
    const h = boot({ respond: async url => url.endsWith('/metadata')
      ? new Response(JSON.stringify(metadata(STUDY)))
      : new Response(gzip ? zlib.gzipSync(body) : body, { headers: {
        'Content-Type': gzip ? 'application/gzip' : partType,
        ...(gzip ? { 'X-KIN-Part-Type': partType } : {}), 'X-KIN-Study-Revision': 'r1',
      } }) });
    const list = await ready(h);
    const check = async (port, session) => {
      const held = (await query(port, session)).held;
      assert.ok(held);
      const answer = await port.ask({ type: 'frame', session, path: FRAME, copy: held.copy });
      assert.deepEqual(Buffer.from(answer.bytes), body);
      assert.equal(answer.partType, partType);
    };
    await check(list, 'sess-A');
    list.send({ type: 'session', session: null });
    const restarted = boot({ disk: h.disk }), resumed = restarted.connect();
    resumed.send({ type: 'session', session: 'sess-A2' });
    await check(resumed, 'sess-A2');
    assert.equal(restarted.reads().length, 0, 'restoration serves the persisted type without another image read');
  });
}

for (const [name, malformed] of [
  ['missing type', '--b1\r\nContent-Location: /frame\r\n\r\npixels\r\n--b1--'],
  ['duplicate type', '--b1\r\nContent-Type: image/jp2\r\nContent-Type: application/octet-stream\r\n\r\npixels\r\n--b1--'],
  ['incomplete headers', '--b1\r\nContent-Type: image/jp2'],
]) for (const gzip of [true, false]) {
  test(`preload rejects ${name} before storing a frame (${gzip ? 'gzip' : 'multipart'}) and Retry recovers`, async () => {
    let repaired = false;
    const disk = memoryDisk(), writes = [], write = disk.write;
    disk.write = async (puts = {}, deletes = {}) => {
      writes.push(...(puts.frames || []));
      return write(puts, deletes);
    };
    const h = boot({ disk, respond: async url => {
      if (url.endsWith('/metadata')) return new Response(JSON.stringify(metadata(STUDY)));
      const body = repaired ? multipart('pixels') : Buffer.from(malformed);
      return new Response(gzip ? zlib.gzipSync(body) : body, { headers: {
        'Content-Type': gzip ? 'application/gzip' : PART,
        'X-KIN-Part-Type': PART, 'X-KIN-Study-Revision': 'r1',
      } });
    } });
    const list = h.connect();
    list.send({ type: 'hello', role: 'list' });
    list.send({ type: 'add', session: 'sess-A', studies: [{ uid: STUDY }] });
    await until(() => statusOf(list, STUDY)?.status === 'Failed', 'malformed response rejected during preload');
    assert.match(statusOf(list, STUDY).reason, /서버 응답을 해석하지 못했습니다/);
    assert.equal(writes.length, 0, 'invalid frames must never reach storage, even temporarily');
    assert.equal(disk.frames.size, 0);
    assert.equal((await query(list)).held, null);
    assert.equal((await list.ask({ type: 'frame', session: 'sess-A', path: FRAME })).bytes, null);
    repaired = true;
    list.send({ type: 'retry', uid: STUDY });
    await until(() => statusOf(list, STUDY)?.status === 'Ready', 'Retry after server repair');
    const held = (await query(list)).held;
    const answer = await list.ask({ type: 'frame', session: 'sess-A', path: FRAME, copy: held.copy });
    assert.deepEqual(Buffer.from(answer.bytes), multipart('pixels'));
    assert.equal(answer.partType, PART);
  });
}

test('cached multipart headers retain a long relayed part type and reject unauthenticated types', async () => {
  const type = 'image/jp2; transfer-syntax=1.2.840.10008.1.2.4.90';
  for (const mode of ['valid', 'tampered']) {
    const body = Buffer.from(`\r\n--relay:boundary\r\nContent-Location: /${'long-path/'.repeat(150)}\r\ncOnTeNt-TyPe: ${type}\r\n\r\npixels\r\n--relay:boundary--\r\n`);
    const h = boot({ respond: async url => url.endsWith('/metadata')
      ? new Response(JSON.stringify(metadata(STUDY)))
      : new Response(body, { headers: { 'Content-Type': 'multipart/related; boundary="relay:boundary"', 'X-KIN-Study-Revision': 'r1' } }) });
    const list = await ready(h), held = (await query(list)).held;
    if (mode === 'tampered') {
      // GCM ciphertext has the plaintext's length/order before its tag. Changing only the codec bytes must fail authentication.
      const record = [...h.disk.frames.values()][0];
      new Uint8Array(record.ct)[body.indexOf('image/jp2')] ^= 1;
    }
    const answer = await list.ask({ type: 'frame', session: 'sess-A', path: FRAME, copy: held.copy });
    if (mode === 'valid') {
      assert.deepEqual(Buffer.from(answer.bytes), body);
      assert.equal(answer.partType, `multipart/related; type="${type}"; boundary="relay:boundary"`);
    } else {
      assert.equal(answer.bytes, null, mode);
      assert.equal((await query(list)).held, null, mode);
      assert.equal(h.disk.frames.size + h.disk.studies.size, 0, mode);
      assert.match(statusOf(list, STUDY).reason, /손상/, mode);
    }
  }
});

for (const nextSession of [null, 'sess-B']) {
  test(`R11 delayed disk read cannot use the old key after ${nextSession ? 'user switch' : 'logout'}`, async () => {
    const h = boot(), list = await ready(h);
    const held = (await query(list)).held;
    // A positive control makes the crypto spy prove actual use of the issued key.
    assert.ok((await list.ask({ type: 'frame', session: 'sess-A', path: FRAME, copy: held.copy })).bytes);
    const oldKey = h.imports[0].key;
    assert.ok(h.decryptKeys.includes(oldKey));
    h.decryptKeys.length = 0;
    const before = await h.disk.list();
    const get = h.disk.get;
    let release, started = false;
    const pending = new Promise(resolve => { release = resolve; });
    h.disk.get = async id => { started = true; await pending; return get(id); };
    const answer = list.ask({ type: 'frame', session: 'sess-A', path: FRAME, copy: held.copy });
    await until(() => started, 'disk read awaiting completion');
    list.send({ type: 'session', session: nextSession });
    release();
    assert.equal((await answer).bytes, null);
    assert.equal(h.decryptKeys.includes(oldKey), false, 'the old key is dropped before the pending read resumes');
    assert.deepEqual(await h.disk.list(), before, 'ending a session preserves ciphertext');
  });
}

test('R1 R2 R15 encrypted exact manifests and unchanged frame bodies, zeroed input and no key in window messages', async()=>{
  const h=boot(), list=await ready(h);
  assert.equal(h.imports.length,1); assert.equal(h.imports[0].key.extractable,false);
  assert.ok(h.imports[0].raw.every(b=>b===0));
  const diskKey=await webcrypto.subtle.importKey('raw',KEY,'AES-GCM',false,['decrypt']);
  const D=require('../worklist-v0/hpacs-lite/preload-disk.js');
  for(const r of h.disk.studies.values()) {
    assert.deepEqual(Object.keys(r).sort(),['manifestId','keyId','expiresAt','iv','ct'].sort());
    const m=JSON.parse(new TextDecoder().decode(await D.open(diskKey,r,D.studyAAD(r.keyId,r.manifestId))));
    assert.deepEqual(Object.keys(m).sort(),['uid','label','status','reason','revision','copy','seq','total','queuedAt','fetchedAt','bytes','frames'].sort());
    assert.equal(m.label,'SYN-123 · Synthetic^Patient');
    for(const [path,id] of Object.entries(m.frames)) {
      const f=h.disk.frames.get(id);
      assert.deepEqual(Object.keys(f).sort(),['entryId','keyId','expiresAt','bytes','iv','ct'].sort());
      const plain=await D.open(diskKey,f,D.frameAAD(r.keyId,m.uid,path,m.revision,m.copy));
      assert.equal(zlib.gunzipSync(Buffer.from(plain)).toString(),'--b1\r\nContent-Type: application/octet-stream\r\n\r\nframe '+path+'\r\n--b1--');
      assert.equal(f.expiresAt,SERVER_START+72*3600000);
    }
  }
  assert.equal(JSON.stringify(list.received).includes(KEY.toString('base64')),false);
});

test('R3 R4 R11 restart and A/B/A session changes retain ciphertext and restore only the issued key',async()=>{
  const disk=memoryDisk(), a=boot({disk}), list=await ready(a);
  const count=disk.frames.size+disk.studies.size;
  list.send({type:'session',session:null});
  assert.equal((await query(list)).held,null);
  assert.equal(disk.frames.size+disk.studies.size,count);
  const b=boot({disk,keyResponse:()=>new Response(JSON.stringify({keyId:'key-B',key:Buffer.alloc(32,7).toString('base64'),serverTime:new Date(SERVER_START).toISOString()}))});
  const other=b.connect(); other.send({type:'hello',role:'list'});other.send({type:'session',session:'sess-B'});
  assert.equal((await query(other,'sess-B')).held,null);
  assert.equal(other.state().studies.length,0); assert.equal(disk.frames.size+disk.studies.size,count);
  const again=boot({disk}), resumed=again.connect(); resumed.send({type:'hello',role:'list'});resumed.send({type:'session',session:'sess-A2'});
  const held=(await query(resumed,'sess-A2')).held; assert.ok(held);
  assert.equal(again.reads().length,0,'Ready survived without store reads');
  const answer=await resumed.ask({type:'frame',session:'sess-A2',path:FRAME,copy:held.copy});
  assert.ok(answer.bytes); assert.equal(statusOf(resumed,STUDY).status,'Ready');
});

test('R5 server-clock expiry with +6h and -6h PC clocks, startup and queued expiry',async()=>{
  for(const skew of [-6,6].map(h=>h*3600000)) {
    const h=boot({skew}),list=await ready(h);
    h.advance(72*3600000-1); assert.ok((await query(list)).held);
    h.advance(1); assert.equal((await query(list)).held,null);
    assert.equal(h.disk.frames.size,0);assert.equal(h.disk.studies.size,0);
    assert.equal(statusOf(list,STUDY).status,'Evicted');
  }
  const h=boot(),viewer=h.connect();viewer.send({type:'hello',role:'viewer'});viewer.send({type:'busy',busy:true});
  const list=h.connect();list.send({type:'hello',role:'list'});list.send({type:'add',session:'sess-A',studies:[{uid:STUDY}]});
  await until(()=>h.disk.studies.size===1,'queued persisted');
  h.advance(72*3600000);h.sweep();
  await until(()=>h.disk.studies.size===0,'queued deleted');assert.match(statusOf(list,STUDY).reason,/대기열/);
  const before=boot(),old=await ready(before);old.send({type:'session',session:null});
  const after=boot({disk:before.disk,keyResponse:()=>new Response(JSON.stringify({keyId:'key-A',key:KEY.toString('base64'),serverTime:new Date(SERVER_START+73*3600000).toISOString()}))});
  const restarted=after.connect();restarted.send({type:'hello',role:'list'});restarted.send({type:'session',session:'sess-A'});
  assert.equal((await query(restarted)).held,null);assert.equal(after.disk.frames.size+after.disk.studies.size,0);
});

test('R6 R17 refused and retired keys never serve; opaque entries are reclaimed before own unopened Ready',async()=>{
  const a=boot(),list=await ready(a);list.send({type:'session',session:null});
  const count=a.disk.frames.size+a.disk.studies.size;
  for(const status of [403,404]) {
    const refused=boot({disk:a.disk,keyResponse:()=>new Response('{}',{status,headers:{Date:new Date(SERVER_START).toUTCString()}})});
    const p=refused.connect();p.send({type:'hello',role:'list'});p.send({type:'add',session:'sess-A',studies:[{uid:STUDY}]});
    await until(()=>statusOf(p,STUDY)?.status==='Failed','refused');
    assert.match(statusOf(p,STUDY).reason,/이 계정/);assert.equal((await query(p)).held,null);
    assert.equal((await p.ask({type:'frame',session:'sess-A',path:FRAME,copy:1})).bytes,null);
    assert.equal(a.disk.frames.size+a.disk.studies.size,count);
    refused.advance(72*3600000);refused.sweep();await until(()=>a.disk.frames.size===0,'opaque expiry');
    // Refill the same synthetic owner for the next refusal.
    if(status===403) { const fresh=boot({disk:a.disk});await ready(fresh); }
  }
  const seed=boot();await ready(seed);
  const b=boot({disk:seed.disk,diskGb:1600/1024**3,keyResponse:()=>new Response(JSON.stringify({keyId:'key-B',key:Buffer.alloc(32,5).toString('base64'),serverTime:new Date(SERVER_START).toISOString()}))});
  const p=await ready(b,OTHER);
  assert.equal((await query(p,'sess-A',STUDY)).held,null);
  assert.ok([...seed.disk.frames.values()].every(r=>r.keyId==='key-B'));
  assert.equal(statusOf(p,OTHER).status,'Ready');
});

test('R7 R9 R16 evict, Clear All and corrupt frame delete real adapter records and miss thereafter',async()=>{
  for(const how of ['evict','clear','corrupt','swap','missing']) {
    const h=boot(),list=await ready(h),held=(await query(list)).held;
    if(how==='evict'||how==='clear') list.send({type:how,uid:STUDY,reason:'closed access'});
    else {
      const entries=[...h.disk.frames.values()],first=entries[0];
      if(how==='corrupt') new Uint8Array(first.ct)[0]^=1;
      if(how==='swap') {first.ct=entries[1].ct;first.iv=entries[1].iv;}
      if(how==='missing') h.disk.frames.delete(first.entryId);
      assert.equal((await list.ask({type:'frame',session:'sess-A',path:FRAME,copy:held.copy})).bytes,null);
    }
    await until(()=>h.disk.frames.size+h.disk.studies.size===0,'deleted '+how);
    assert.equal((await query(list)).held,null);
    assert.equal(list.state().studies[0].bytes,0);
  }
});

test('R9 MG-01 body error and Content-Length mismatch never produce a Ready or a stored frame',async()=>{
  for(const cut of [true,false]) {
    const h=boot({respond:async url=>{
      if(url.endsWith('/metadata'))return new Response(JSON.stringify(metadata(STUDY)));
      if(cut)return {ok:true,headers:new Headers({'Content-Type':'application/gzip'}),arrayBuffer:async()=>{throw new Error('short read');}};
      return new Response('short',{headers:{'Content-Type':'application/gzip','Content-Length':'50','X-KIN-Study-Revision':'r'}});
    }}),p=h.connect();p.send({type:'hello',role:'list'});p.send({type:'add',session:'sess-A',studies:[{uid:STUDY}]});
    await until(()=>statusOf(p,STUDY)?.status==='Failed','short failed');
    assert.match(statusOf(p,STUDY).reason,/연결/);assert.equal(h.disk.frames.size,0);
  }
});

test('R10 browser quota parks a study and never evicts an unopened Ready; R11 queued resumes after logout',async()=>{
  const disk=memoryDisk(); const h=boot({disk}),list=await ready(h);
  const before=disk.frames.size;
  disk.estimate=async()=>({usage:1000,quota:1001});
  list.send({type:'add',session:'sess-A',studies:[{uid:OTHER}]});
  await until(()=>statusOf(list,OTHER)?.waiting,'parked');
  assert.equal(disk.frames.size,before);assert.equal(statusOf(list,STUDY).status,'Ready');
  disk.estimate=async()=>({usage:0,quota:Infinity});
  // Persist a queued entry while reading is busy; restart resumes it and keeps Ready frames.
  const viewer=h.connect();viewer.send({type:'hello',role:'viewer'});viewer.send({type:'busy',busy:true});
  list.send({type:'add',session:'sess-A',studies:[{uid:'1.2.840.9.3'}]});
  await until(()=>disk.studies.size===2,'queued manifest');list.send({type:'session',session:null});
  const again=boot({disk}),p=again.connect();p.send({type:'hello',role:'list'});p.send({type:'session',session:'sess-A2'});
  await until(()=>statusOf(p,'1.2.840.9.3')?.status==='Ready','resumed queue');
  assert.equal(again.reads().some(r=>r.url.includes(STUDY+'/')),false);
});

test('R11 logout aborts an in-flight body without deleting ciphertext; the next session resumes',async()=>{
  let started=false, aborted=false;
  const disk=memoryDisk();
  const h=boot({disk,respond:async(url,init)=>{
    if(url.endsWith('/metadata'))return new Response(JSON.stringify(metadata(STUDY)));
    started=true;
    return {ok:true,headers:new Headers({'Content-Type':'application/gzip'}),arrayBuffer:()=>new Promise((resolve,reject)=>{
      init.signal.addEventListener('abort',()=>{aborted=true;reject(new Error('aborted'));},{once:true});
    })};
  }}),p=h.connect();p.send({type:'hello',role:'list'});p.send({type:'add',session:'sess-A',studies:[{uid:STUDY}]});
  await until(()=>started,'body in flight');
  const before=structuredClone([...disk.studies.values()]);
  p.send({type:'session',session:null});
  await until(()=>aborted,'fetch aborted');
  assert.deepEqual([...disk.studies.values()],before);assert.equal(disk.frames.size,0);
  assert.equal((await p.ask({type:'frame',session:'sess-A',path:FRAME,copy:1})).bytes,null);
  const again=boot({disk}),resumed=again.connect();resumed.send({type:'hello',role:'list'});resumed.send({type:'session',session:'sess-A2'});
  await until(()=>statusOf(resumed,STUDY)?.status==='Ready','interrupted queue resumed');
});

test('R6 setup Retry recovers a transient key failure and a successful session issues only once',async()=>{
  let attempts=0;
  const h=boot({keyResponse:()=>{
    if(++attempts===1)throw new Error('offline');
    return new Response(JSON.stringify({keyId:'key-A',key:KEY.toString('base64'),serverTime:new Date(SERVER_START).toISOString()}));
  }}),p=h.connect();p.send({type:'hello',role:'list'});p.send({type:'add',session:'sess-A',studies:[{uid:STUDY}]});
  await until(()=>statusOf(p,STUDY)?.status==='Failed','initial key refusal');
  p.send({type:'retry',uid:STUDY});await until(()=>statusOf(p,STUDY)?.status==='Ready','retry recovers');
  p.send({type:'session',session:'sess-A'});await query(p);
  assert.equal(attempts,2,'one failure then one successful issue, reused for the session');
});

test('R9 a reauthenticated changed manifest cannot relabel an existing frame',async()=>{
  const h=boot(),p=await ready(h);p.send({type:'session',session:null});
  const D=require('../worklist-v0/hpacs-lite/preload-disk.js');
  const testKey=await webcrypto.subtle.importKey('raw',KEY,'AES-GCM',false,['encrypt','decrypt']);
  const record=[...h.disk.studies.values()][0],aad=D.studyAAD(record.keyId,record.manifestId);
  const m=JSON.parse(new TextDecoder().decode(await D.open(testKey,record,aad)));
  m.revision='changed-revision';Object.assign(record,await D.seal(testKey,new TextEncoder().encode(JSON.stringify(m)),aad));
  const restarted=boot({disk:h.disk}),q=restarted.connect();q.send({type:'hello',role:'list'});q.send({type:'session',session:'sess-A2'});
  const held=(await query(q,'sess-A2')).held;assert.ok(held);
  assert.equal((await q.ask({type:'frame',session:'sess-A2',path:FRAME,copy:held.copy})).bytes,null);
  assert.match(statusOf(q,STUDY).reason,/손상/);
  assert.equal(h.disk.frames.size+h.disk.studies.size,0);
});

test('R10 space is reclaimed from expired entries, then the oldest foreign expiry regardless of insertion order',async()=>{
  const disk=memoryDisk();
  const issue=(id,time)=>()=>new Response(JSON.stringify({keyId:id,key:KEY.toString('base64'),serverTime:new Date(time).toISOString()}));
  const newer=boot({disk,keyResponse:issue('key-B',SERVER_START+3600000)});newer.advance(3600000);
  const b=await ready(newer,OTHER);b.send({type:'session',session:null});
  const older=boot({disk}),a=await ready(older);a.send({type:'session',session:null});
  const protectedRows=[...disk.frames.values(),...disk.studies.values()].filter(r=>r.keyId==='key-B');
  const initialBytes=[...disk.frames.values(),...disk.studies.values()].reduce((n,r)=>n+r.ct.byteLength,0);
  const oldFrame=[...disk.frames.values()].find(r=>r.keyId==='key-A');
  disk.frames.set('expired',{...structuredClone(oldFrame),entryId:'expired',keyId:'retired',expiresAt:SERVER_START-1});
  disk.deleted.length=0;
  const current=boot({disk,diskGb:(initialBytes+100)/1024**3,keyResponse:issue('key-C',SERVER_START)});
  const p=await ready(current,'1.2.840.9.3');
  assert.equal(disk.deleted[0],'expired','startup expiry precedes any space eviction');
  assert.ok(disk.deleted.some(id=>id!=='expired'),'space required a foreign eviction');
  for(const record of protectedRows)assert.deepEqual((record.entryId?disk.frames:disk.studies).get(record.entryId||record.manifestId),record,
    'the newer foreign cache survives while older entries can make room');
  assert.ok(p.state().used<=p.state().budget);
});

test('R5 R10 a queued study resumes when the periodic expiry sweep releases space',async()=>{
  const h=boot({diskGb:1800/1024**3}),p=await ready(h);
  h.advance(3600000);
  p.send({type:'add',session:'sess-A',studies:[{uid:OTHER}]});
  await until(()=>statusOf(p,OTHER)?.waiting,'second study waiting for space');
  assert.equal(statusOf(p,STUDY).status,'Ready','unopened Ready protected until expiry');
  h.advance(71*3600000);h.sweep();
  await until(()=>statusOf(p,OTHER)?.status==='Ready','space released by expiry resumes the queue');
  assert.equal(statusOf(p,STUDY).status,'Evicted');
  assert.ok(p.state().used<=p.state().budget);
});
