'use strict';
// REQ-MG-PRELOAD-MEM -> RISK-PRELOAD-STARVES-READING / RISK-PRELOAD-CROSS-SESSION / RISK-PRELOAD-UNRECORDED-VIEW
// -> TEST-MG-PRELOAD-WORKER: the preload SharedWorker (worklist-v0/hpacs-lite/preload-worker.js) run as written, in a VM
// context with the browser APIs it uses, against a scripted server. What is checked is the worker's contract: every byte
// is an ordinary bound frame read (gate and 열람 record are the server's), reading pauses the queue, a session never sees
// another session's store, and an ended session empties it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');

const DIR = path.join(__dirname, '..', 'worklist-v0', 'hpacs-lite');
const STUDY = '1.2.840.9.1', OTHER = '1.2.840.9.2';
const PART = 'multipart/related; type="application/octet-stream"; boundary=b1';
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

function boot({ deviceMemory = 8, respond } = {}) {
  const requests = [];
  const server = respond || (async url => {
    const study = /\/studies\/([0-9.]+)\//.exec(url)[1];
    if (url.endsWith('/metadata')) return new Response(JSON.stringify(metadata(study)), { headers: { 'Content-Type': 'application/dicom+json' } });
    const body = zlib.gzipSync(Buffer.from('--b1\r\nframe ' + url + '\r\n--b1--'));
    return new Response(body, { headers: { 'Content-Type': 'application/gzip', 'X-KIN-Part-Type': PART, 'X-KIN-Study-Revision': 'orthanc-study:s@1' } });
  });
  let gate = null;
  const context = {
    navigator: { deviceMemory }, Blob, Response, DecompressionStream, AbortController, URL, Headers, setTimeout, console,
    fetch: async (url, init) => {
      requests.push({ url, init });
      if (gate) await gate;
      if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return server(url, init);
    },
    importScripts: (...names) => { for (const name of names) vm.runInContext(fs.readFileSync(path.join(DIR, name), 'utf8'), context); },
  };
  context.self = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(DIR, 'preload-worker.js'), 'utf8'), context);
  const connect = () => {
    const port = { received: [], postMessage(message) { this.received.push(message); }, start() {} };
    context.onconnect({ ports: [port] });
    port.send = data => port.onmessage({ data });
    port.state = () => [...port.received].reverse().find(m => m.type === 'state');
    port.ask = async data => {
      const id = Math.random();
      port.send({ ...data, id });
      await until(() => port.received.some(m => m.type === 'reply' && m.id === id), data.type + ' reply');
      return port.received.find(m => m.type === 'reply' && m.id === id);
    };
    return port;
  };
  return { requests, connect, hold: () => { let open; gate = new Promise(resolve => { open = resolve; }); return () => { gate = null; open(); }; } };
}

const statusOf = (port, uid) => port.state()?.studies.find(s => s.uid === uid);

test('Preload fetches metadata, then each object\'s first frame, then the rest - every read bound, no-store, stored form', async () => {
  const { requests, connect } = boot();
  const list = connect();
  list.send({ type: 'hello', role: 'list' });
  list.send({ type: 'add', session: 'sess-1', studies: [{ uid: STUDY, label: 'SYN-1 · Synthetic^Patient' }] });
  await until(() => statusOf(list, STUDY)?.status === 'Ready', 'Ready');
  assert.deepEqual(requests.map(r => r.url), [
    `/dicom-web/studies/${STUDY}/metadata`,
    `/dicom-web/studies/${STUDY}/series/${STUDY}.1/instances/${STUDY}.1.1/frames/1`,
    `/dicom-web/studies/${STUDY}/series/${STUDY}.2/instances/${STUDY}.2.1/frames/1`,
    `/dicom-web/studies/${STUDY}/series/${STUDY}.1/instances/${STUDY}.1.1/frames/2`,
  ]);
  for (const { init } of requests) {
    assert.equal(init.headers['X-KIN-Session'], 'sess-1');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.priority, 'low');
  }
  for (const { init } of requests.slice(1)) assert.equal(init.headers['X-KIN-Preload'], 'store');
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
  assert.equal((await viewer.ask({ type: 'query', uid: STUDY, session: 'sess-1' })).held.revision, 'orthanc-study:s@1');
  const frame = `/dicom-web/studies/${STUDY}/series/${STUDY}.1/instances/${STUDY}.1.1/frames/2`;
  const answer = await viewer.ask({ type: 'frame', path: frame, session: 'sess-1' });
  assert.equal(Buffer.from(answer.bytes).toString(), '--b1\r\nframe ' + frame + '\r\n--b1--');
  assert.equal(answer.partType, PART);
  // The same frame twice: the store keeps its bytes (the first answer was handed over, not the held copy).
  assert.equal(Buffer.from((await viewer.ask({ type: 'frame', path: frame, session: 'sess-1' })).bytes).length, answer.bytes.byteLength);
  assert.equal((await viewer.ask({ type: 'query', uid: STUDY, session: 'sess-2' })).held, null);
  assert.equal((await viewer.ask({ type: 'frame', path: frame, session: 'sess-2' })).bytes, null);
});

test('reading comes first: while a viewer loads from the network, no new preload fetch starts', async () => {
  const { requests, connect } = boot();
  const viewer = connect();
  viewer.send({ type: 'hello', role: 'viewer' });
  viewer.send({ type: 'busy', busy: true });
  const list = connect();
  list.send({ type: 'hello', role: 'list' });
  list.send({ type: 'add', session: 'sess-1', studies: [{ uid: STUDY }] });
  await until(() => requests.length === 1, 'metadata');
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(requests.length, 1, 'no frame fetch while the viewer is busy');
  assert.equal(statusOf(list, STUDY).status, 'Downloading');
  viewer.send({ type: 'busy', busy: false });
  await until(() => statusOf(list, STUDY)?.status === 'Ready', 'Ready after the viewer went idle');
  // A viewer window that leaves while busy does not park the queue.
  viewer.send({ type: 'busy', busy: true });
  list.send({ type: 'add', session: 'sess-1', studies: [{ uid: OTHER }] });
  await until(() => requests.length === 5, 'metadata of the second study');
  viewer.send({ type: 'bye' });
  await until(() => statusOf(list, OTHER)?.status === 'Ready', 'second study Ready after bye');
});

test('a session that ended on the server empties the store; a new session never sees the old one', async () => {
  let refuse = false;
  const { connect } = boot({ respond: async url => {
    if (refuse) return new Response('{}', { status: 401, headers: { 'X-KIN-Auth-Code': 'AUTH_SESSION_ENDED' } });
    const study = /\/studies\/([0-9.]+)\//.exec(url)[1];
    if (url.endsWith('/metadata')) return new Response(JSON.stringify(metadata(study)));
    return new Response(zlib.gzipSync(Buffer.from('x')), { headers: { 'Content-Type': 'application/gzip', 'X-KIN-Part-Type': PART, 'X-KIN-Study-Revision': 'r' } });
  } });
  const list = connect();
  list.send({ type: 'hello', role: 'list' });
  list.send({ type: 'add', session: 'sess-1', studies: [{ uid: STUDY }] });
  await until(() => statusOf(list, STUDY)?.status === 'Ready', 'Ready');
  refuse = true;
  list.send({ type: 'add', session: 'sess-1', studies: [{ uid: OTHER }] });
  await until(() => statusOf(list, STUDY)?.status === 'Evicted', 'cleared on AUTH_SESSION_ENDED');
  assert.equal(list.state().used, 0);
  assert.match(statusOf(list, STUDY).reason, /세션/);
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
  assert.equal(statusOf(list, OTHER).status, 'Evicted');
});

test('Clear All while a study\'s metadata is read leaves it Evicted; a window that said goodbye can come back', async () => {
  const { requests, connect, hold } = boot();
  const list = connect();
  list.send({ type: 'hello', role: 'list' });
  const release = hold();
  list.send({ type: 'add', session: 'sess-1', studies: [{ uid: STUDY }] });
  await until(() => requests.length === 1, 'metadata read started');
  list.send({ type: 'clear' });
  release();
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(statusOf(list, STUDY).status, 'Evicted');
  assert.equal(requests.length, 1, 'no frame read after the clear');
  list.send({ type: 'bye' });
  list.send({ type: 'hello', role: 'list' });
  list.send({ type: 'retry', uid: STUDY });
  await until(() => statusOf(list, STUDY)?.status === 'Ready', 'Ready after coming back');
});

test('a refused, missing or changing study fails with a reason and Retry; a browser without memory facts gets no preload', async () => {
  let revision = 0;
  const { connect } = boot({ respond: async (url) => {
    const study = /\/studies\/([0-9.]+)\//.exec(url)[1];
    if (study === OTHER) return new Response('{}', { status: 403 });
    if (url.endsWith('/metadata')) return new Response(JSON.stringify(metadata(study)));
    return new Response(zlib.gzipSync(Buffer.from('x')), { headers: { 'Content-Type': 'application/gzip', 'X-KIN-Part-Type': PART, 'X-KIN-Study-Revision': 'r' + (++revision) } });
  } });
  const list = connect();
  list.send({ type: 'hello', role: 'list' });
  list.send({ type: 'add', session: 'sess-1', studies: [{ uid: STUDY }, { uid: OTHER }] });
  await until(() => statusOf(list, OTHER)?.status === 'Failed' && statusOf(list, STUDY)?.status === 'Failed', 'both failed');
  assert.match(statusOf(list, STUDY).reason, /바뀌었습니다/);
  assert.match(statusOf(list, OTHER).reason, /거절/);
  assert.equal(list.state().used, 0);

  const bare = boot({ deviceMemory: null }).connect();
  bare.send({ type: 'hello', role: 'list' });
  bare.send({ type: 'add', session: 'sess-1', studies: [{ uid: STUDY }] });
  await until(() => statusOf(bare, STUDY)?.status === 'Failed', 'failed without memory facts');
  assert.match(statusOf(bare, STUDY).reason, /메모리 크기/);
  assert.equal(bare.state().budget, null);
});
