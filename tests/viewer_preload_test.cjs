'use strict';
// REQ-MG-PRELOAD-MEM -> RISK-PRELOAD-STALE-IDENTITY / RISK-PRELOAD-UNRECORDED-VIEW / RISK-PRELOAD-CROSS-SESSION
// -> TEST-MG-PRELOAD-VIEWER: the viewer's fetch under its session transport (worklist-v0/hpacs-lite/viewer-preload.js).
// No held frame reaches the viewer before the study's live check read in this document (gate + 열람 record on the
// server, revision compared here); a changed or refused study is dropped and read live.
const test = require('node:test');
const assert = require('node:assert/strict');
const { attach } = require('../worklist-v0/hpacs-lite/viewer-preload.js');

const ORIGIN = 'https://kin.test';
const STUDY = '1.2.840.9.1';
const PART = 'multipart/related; type="application/octet-stream"; boundary=b1';
const frameUrl = (n, study = STUDY) => `${ORIGIN}/dicom-web/studies/${study}/series/${study}.1/instances/${study}.1.1/frames/${n}`;
const bound = (extra = {}) => ({ method: 'GET', headers: new Headers({ 'X-KIN-Session': 'sess-1', Accept: PART, ...extra }) });

/** A window with a scripted preload worker: `held` maps study -> { revision, session }; frames answer their path. */
function setup({ held = {}, network } = {}) {
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
          reply({ held: entry && entry.session === message.session ? { revision: entry.revision } : null });
        } else if (message.type === 'frame') {
          const uid = /studies\/([0-9.]+)\//.exec(message.path)[1], entry = held[uid];
          reply(entry && entry.session === message.session ? { bytes: new TextEncoder().encode('held ' + message.path).buffer, partType: PART } : { bytes: null });
        }
      } };
    }
  }
  const listeners = {};
  const win = { location: { origin: ORIGIN, href: ORIGIN + '/ohif/viewer' }, SharedWorker: FakeSharedWorker, Headers, Response,
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
  assert.equal(sent[0].headers.get('X-KIN-Session'), 'sess-1', 'the transport\'s binding is kept');
  assert.ok(posted.some(m => m.type === 'open' && m.uid === STUDY));
  const second = await fetch(frameUrl(2), bound());
  assert.equal(sent.length, 1, 'no network read for a held frame after the check');
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('Content-Type'), PART);
  assert.equal(await second.text(), 'held ' + new URL(frameUrl(2)).pathname);
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
  await Promise.all([one, two]);
  assert.deepEqual(posted.filter(m => m.type === 'busy').map(m => m.busy), [true, false]);
  await fetch(`${ORIGIN}/api/me`, bound());
  assert.equal(posted.filter(m => m.type === 'busy').length, 2, 'business API calls are not image loading');
});
