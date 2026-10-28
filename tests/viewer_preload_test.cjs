'use strict';
// REQ-MG-PRELOAD-MEM -> RISK-PRELOAD-STALE-IDENTITY / RISK-PRELOAD-UNRECORDED-VIEW / RISK-PRELOAD-CROSS-SESSION
// -> TEST-MG-PRELOAD-VIEWER: the viewer's fetch under its session transport (worklist-v0/hpacs-lite/viewer-preload.js).
// No held frame reaches the viewer before the study's live check read in this document (gate + 열람 record on the
// server, revision compared here), and only from the copy that check was made against; a changed or refused study is
// dropped and read live. Every image read the viewer sends is marked as the viewer's (the opening's 열람, D1880), and the
// worker hears the viewer is busy until the answer's body has ended.
const test = require('node:test');
const assert = require('node:assert/strict');
const { attach } = require('../worklist-v0/hpacs-lite/viewer-preload.js');

const ORIGIN = 'https://kin.test';
const STUDY = '1.2.840.9.1';
const PART = 'multipart/related; type="application/octet-stream"; boundary=b1';
const frameUrl = (n, study = STUDY) => `${ORIGIN}/dicom-web/studies/${study}/series/${study}.1/instances/${study}.1.1/frames/${n}`;
const bound = (extra = {}) => ({ method: 'GET', headers: new Headers({ 'X-KIN-Session': 'sess-1', Accept: PART, ...extra }) });

/** A window with a scripted preload worker: `held` maps study -> { revision, session, copy }; frames answer their path
 * from the held copy only, as preload-worker.js does (another copy: `stale`). */
function setup({ held = {}, network, shared = true } = {}) {
  const posted = [], sent = [];
  class FakeSharedWorker {
    constructor(url, options) {
      assert.equal(url, '/worklist/hpacs-lite/preload-worker.js');
      assert.equal(options.name, 'kin-preload');
      const port = this.port = { start() {}, postMessage(message) {
        posted.push(message);
        const reply = value => queueMicrotask(() => port.onmessage({ data: { type: 'reply', id: message.id, ...value } }));
        if (message.type === 'query') {
          const entry = held[message.uid];
          reply({ held: entry && entry.session === message.session ? { revision: entry.revision, copy: entry.copy ?? 1 } : null });
        } else if (message.type === 'frame') {
          const uid = /studies\/([0-9.]+)\//.exec(message.path)[1], entry = held[uid];
          if (entry && entry.session === message.session && (entry.copy ?? 1) !== message.copy) reply({ bytes: null, stale: true });
          else reply(entry && entry.session === message.session ? { bytes: new TextEncoder().encode(`held ${entry.copy ?? 1} ${message.path}`).buffer, partType: PART } : { bytes: null });
        }
      } };
    }
  }
  const listeners = {};
  const win = { location: { origin: ORIGIN, href: ORIGIN + '/ohif/viewer' }, SharedWorker: shared ? FakeSharedWorker : undefined,
    Headers, Response, ReadableStream,
    addEventListener: (type, run) => { listeners[type] = run; } };
  const send = async (url, init) => {
    sent.push({ url, init, headers: new Headers(init.headers) });
    return network ? network(url, init) : new Response('live ' + url, { headers: { 'Content-Type': PART, 'X-KIN-Study-Revision': 'rev-now' } });
  };
  return { fetch: attach(win, send), posted, sent, listeners };
}

test('a study the worker does not hold is read live, unchanged', async () => {
  const { fetch, sent, posted } = setup();
  const answer = await fetch(frameUrl(1), bound());
  assert.equal(await answer.text(), 'live ' + frameUrl(1));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].headers.get('X-KIN-Preload'), null);
  assert.equal(sent[0].headers.get('X-KIN-Image-Use'), 'view', 'the viewer\'s read is the opening\'s, not a fetch');
  await fetch(frameUrl(2), bound());
  assert.equal(sent.length, 2, 'later frames of a study not held stay live');
  assert.equal(posted.filter(m => m.type === 'query').length, 1, 'the worker is asked once per study and document');
});

test('a held study: the first frame read is the live check, then frames come from memory', async () => {
  const { fetch, sent, posted, listeners } = setup({ held: { [STUDY]: { revision: 'rev-now', session: 'sess-1' } } });
  const first = await fetch(frameUrl(1), bound());
  assert.equal(await first.text(), 'live ' + frameUrl(1), 'the check read\'s own answer is the first frame');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].headers.get('X-KIN-Preload'), 'check');
  assert.equal(sent[0].headers.get('X-KIN-Image-Use'), 'view', 'the check read is the opening read');
  assert.equal(sent[0].headers.get('X-KIN-Session'), 'sess-1', 'the transport\'s binding is kept');
  assert.ok(posted.some(m => m.type === 'open' && m.uid === STUDY));
  const second = await fetch(frameUrl(2), bound());
  assert.equal(sent.length, 1, 'no network read for a held frame after the check');
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('Content-Type'), PART);
  assert.equal(await second.text(), 'held 1 ' + new URL(frameUrl(2)).pathname);
  // Leaving the window releases the study (it may be evicted once closed everywhere).
  listeners.pagehide();
  assert.equal(posted.at(-1).type, 'bye');
});

test('reads that arrive during the check wait for it; only one check read leaves', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { fetch, sent } = setup({ held: { [STUDY]: { revision: 'rev-now', session: 'sess-1' } },
    network: async url => { await gate; return new Response('live ' + url, { headers: { 'X-KIN-Study-Revision': 'rev-now', 'Content-Type': PART } }); } });
  const reads = [1, 2, 3].map(n => fetch(frameUrl(n), bound()));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(sent.length, 1);
  release();
  const texts = await Promise.all(reads.map(async r => (await r).text()));
  assert.equal(sent.length, 1);
  assert.deepEqual(texts.map(t => t.split(' ')[0]), ['live', 'held', 'held']);
});

test('a different revision at opening drops the held study and stays live', async () => {
  const { fetch, sent, posted } = setup({ held: { [STUDY]: { revision: 'rev-then', session: 'sess-1' } } });
  await fetch(frameUrl(1), bound());
  const evict = posted.find(m => m.type === 'evict');
  assert.equal(evict.uid, STUDY);
  assert.match(evict.reason, /달라/);
  assert.ok(!posted.some(m => m.type === 'open'));
  assert.equal(await (await fetch(frameUrl(2), bound())).text(), 'live ' + frameUrl(2));
  assert.equal(sent.length, 2);
});

test('a refused opening drops the held study; a server failure keeps it but shows nothing from memory', async () => {
  for (const [status, dropped] of [[403, true], [404, true], [503, false]]) {
    const { fetch, sent, posted } = setup({ held: { [STUDY]: { revision: 'rev-now', session: 'sess-1' } },
      network: async () => new Response('{}', { status, headers: { 'X-KIN-Study-Revision': 'rev-now' } }) });
    assert.equal((await fetch(frameUrl(1), bound())).status, status);
    assert.equal(posted.some(m => m.type === 'evict'), dropped, String(status));
    assert.ok(!posted.some(m => m.type === 'open'), String(status));
    await fetch(frameUrl(2), bound());
    assert.equal(sent.length, 2, `${status}: nothing from memory after a failed check`);
  }
});

test('a check read the archive could not answer a revision for stays live and keeps the held copy', async () => {
  const { fetch, sent, posted } = setup({ held: { [STUDY]: { revision: 'rev-now', session: 'sess-1' } },
    network: async url => new Response('live ' + url, { headers: { 'Content-Type': PART } }) });
  assert.equal((await fetch(frameUrl(1), bound())).status, 200);
  assert.ok(!posted.some(m => m.type === 'evict' || m.type === 'open'));
  await fetch(frameUrl(2), bound());
  assert.equal(sent.length, 2, 'nothing from memory without a matching revision');
});

test('a check read that is cut is asked again by the next frame read', async () => {
  let fail = true;
  const { fetch, sent, posted } = setup({ held: { [STUDY]: { revision: 'rev-now', session: 'sess-1' } },
    network: async url => { if (fail) throw new TypeError('network'); return new Response('live ' + url, { headers: { 'X-KIN-Study-Revision': 'rev-now' } }); } });
  await assert.rejects(fetch(frameUrl(1), bound()));
  fail = false;
  await fetch(frameUrl(1), bound());
  assert.equal(sent.filter(s => s.headers.get('X-KIN-Preload') === 'check').length, 2);
  assert.ok(posted.some(m => m.type === 'open'));
});

test('another session\'s store is never used; queries, other paths and methods go to the network', async () => {
  const { fetch, sent } = setup({ held: { [STUDY]: { revision: 'rev-now', session: 'sess-OTHER' } } });
  await fetch(frameUrl(1), bound());
  await fetch(frameUrl(2), bound());
  assert.equal(sent.length, 2);
  assert.ok(sent.every(s => s.headers.get('X-KIN-Preload') === null));
  const held = setup({ held: { [STUDY]: { revision: 'rev-now', session: 'sess-1' } } });
  await held.fetch(frameUrl(1), bound());
  await held.fetch(frameUrl(2) + '?accept=x', bound());
  await held.fetch(frameUrl(2), { ...bound(), method: 'HEAD' });
  await held.fetch(`${ORIGIN}/dicom-web/studies/${STUDY}/metadata`, bound());
  assert.equal(held.sent.length, 4);
});

test('the worker hears when this viewer waits on the network for images, and when it stops', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { fetch, posted } = setup({ network: async url => { await gate; return new Response('x'); } });
  const one = fetch(`${ORIGIN}/dicom-web/studies/${STUDY}/metadata`, bound());
  const two = fetch(frameUrl(1), bound());
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(posted.filter(m => m.type === 'busy').map(m => m.busy), [true]);
  release();
  const answers = await Promise.all([one, two]);
  assert.deepEqual(posted.filter(m => m.type === 'busy').map(m => m.busy), [true], 'headers alone do not end the reading');
  for (const answer of answers) await answer.text();
  assert.deepEqual(posted.filter(m => m.type === 'busy').map(m => m.busy), [true, false]);
  await fetch(`${ORIGIN}/api/me`, bound());
  assert.equal(posted.filter(m => m.type === 'busy').length, 2, 'business API calls are not image loading');
});

test('busy lasts until a streaming body ends, and also ends when the body fails, is cancelled, or the read fails', async () => {
  const busy = posted => posted.filter(m => m.type === 'busy').map(m => m.busy);
  const streaming = () => {
    let controller;
    const body = new ReadableStream({ start(c) { controller = c; } });
    return { controller, response: () => new Response(body, { headers: { 'Content-Type': PART } }) };
  };
  // The body arrives in parts: busy until the last part, as the viewer consumes it.
  {
    const s = streaming();
    const { fetch, posted } = setup({ network: async () => s.response() });
    const answer = await fetch(frameUrl(1), bound());
    const reader = answer.body.getReader();
    s.controller.enqueue(new TextEncoder().encode('part 1'));
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'part 1');
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(busy(posted), [true], 'still reading: the body is open');
    s.controller.enqueue(new TextEncoder().encode('part 2'));
    s.controller.close();
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'part 2');
    assert.equal((await reader.read()).done, true);
    assert.deepEqual(busy(posted), [true, false]);
  }
  // A body that fails midway (the connection drops) releases the reading.
  {
    const s = streaming();
    const { fetch, posted } = setup({ network: async () => s.response() });
    const answer = await fetch(frameUrl(1), bound());
    s.controller.error(new TypeError('network'));
    await assert.rejects(answer.arrayBuffer());
    assert.deepEqual(busy(posted), [true, false]);
  }
  // The viewer gives up on a body (a pane re-targeted): cancelled, released.
  {
    const s = streaming();
    const { fetch, posted } = setup({ network: async () => s.response() });
    const answer = await fetch(frameUrl(1), bound());
    await answer.body.cancel();
    assert.deepEqual(busy(posted), [true, false]);
  }
  // A read that fails before any answer, and a failure answer (whose body the viewer may never read), release at once.
  {
    const { fetch, posted } = setup({ network: async () => { throw new TypeError('network'); } });
    await assert.rejects(fetch(frameUrl(1), bound()));
    assert.deepEqual(busy(posted), [true, false]);
  }
  {
    const { fetch, posted } = setup({ network: async () => new Response('{}', { status: 503 }) });
    assert.equal((await fetch(frameUrl(1), bound())).status, 503);
    assert.deepEqual(busy(posted), [true, false]);
  }
});

test('a copy fetched again after Clear All or Retry is never shown under the earlier check: it gets a check of its own', async () => {
  const held = { [STUDY]: { revision: 'rev-now', session: 'sess-1', copy: 1 } };
  let live = 'rev-now';
  const { fetch, sent, posted } = setup({ held,
    network: async url => new Response('live ' + url, { headers: { 'Content-Type': PART, 'X-KIN-Study-Revision': live } }) });
  await fetch(frameUrl(1), bound());
  assert.equal(await (await fetch(frameUrl(2), bound())).text(), 'held 1 ' + new URL(frameUrl(2)).pathname);
  // Clear All, then Retry under the archive's new revision: the worker now holds copy 2 of r2.
  held[STUDY] = { revision: 'rev-r2', session: 'sess-1', copy: 2 };
  live = 'rev-r2';
  const third = await (await fetch(frameUrl(3), bound())).text();
  assert.equal(third, 'live ' + frameUrl(3), 'the replaced copy is not used under the earlier check');
  const checks = () => sent.filter(s => s.headers.get('X-KIN-Preload') === 'check').length;
  assert.equal(checks(), 1);
  // The next read checks the new copy live; it matches the archive now, so the new copy is used from then on.
  assert.equal(await (await fetch(frameUrl(4), bound())).text(), 'live ' + frameUrl(4));
  assert.equal(checks(), 2, 'a new check read for the new copy');
  assert.equal(await (await fetch(frameUrl(5), bound())).text(), 'held 2 ' + new URL(frameUrl(5)).pathname);
  assert.equal(posted.filter(m => m.type === 'open').length, 1, 'the study is opened once in this document');
  // A new copy whose revision no longer matches the archive is dropped at its check and never shown.
  held[STUDY] = { revision: 'rev-r2', session: 'sess-1', copy: 3 };
  live = 'rev-r3';
  await fetch(frameUrl(6), bound());
  await fetch(frameUrl(7), bound());
  assert.ok(posted.some(m => m.type === 'evict' && m.uid === STUDY));
  assert.equal(await (await fetch(frameUrl(8), bound())).text(), 'live ' + frameUrl(8));
});

test('without a SharedWorker every image read still goes out marked as the viewer\'s; business calls are not marked', async () => {
  const { fetch, sent } = setup({ shared: false });
  await fetch(frameUrl(1), bound());
  await fetch(`${ORIGIN}/dicom-web/studies/${STUDY}/metadata`, bound());
  await fetch(`${ORIGIN}/api/me`, bound());
  assert.deepEqual(sent.map(s => s.headers.get('X-KIN-Image-Use')), ['view', 'view', null]);
  assert.ok(sent.every(s => s.headers.get('X-KIN-Session') === 'sess-1'));
});
