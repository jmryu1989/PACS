'use strict';
// REQ-MG-PRELOAD-MEM -> RISK-PRELOAD-STALE-IDENTITY / RISK-PRELOAD-UNRECORDED-VIEW / RISK-PRELOAD-CROSS-SESSION
// -> TEST-MG-PRELOAD-VIEWER: the viewer's fetch under its session transport (worklist-v0/hpacs-lite/viewer-preload.js).
// No held frame reaches the viewer before the study's live check read for its current opening (gate + 열람 record on
// the server, revision compared here), and only from the copy that check was made against; a changed or refused study
// is dropped and read live. Every image read the viewer sends - by a public image route or the API's own - names its
// opening (opening contract 2026-10-29): one per document, a new one for studies shown again (patient tab, back/forward
// return) - each read live for it before what the document still holds can show, whatever form showed it (a frame, also
// queried, a rendering, a document, a preview; an object related to its study by the server's answer) - and none for
// business calls; an answer to a read asked before its study was opened again is never handed on under the new opening
// before that opening's own read; the worker hears the viewer is busy until the answer's body has ended.
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
function setup({ held = {}, network, shared = true, studies = null, page = false } = {}) {
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
          else reply(entry && entry.session === message.session ? { bytes: new TextEncoder().encode(`held ${entry.copy ?? 1} ${message.path}`).buffer, partType: entry.partType ?? PART } : { bytes: null });
        }
      } };
    }
  }
  // Every listener of a type runs (the module and its worker part both listen to pagehide/pageshow).
  const handlers = {}, listeners = {};
  const win = { location: { origin: ORIGIN, href: ORIGIN + '/ohif/viewer' + (studies ? '?StudyInstanceUIDs=' + studies.join(',') : '') },
    SharedWorker: shared ? FakeSharedWorker : undefined, Headers, Response, ReadableStream, crypto: globalThis.crypto,
    document: page ? fakeDocument() : undefined,
    addEventListener: (type, run) => { (handlers[type] ??= []).push(run); listeners[type] = event => handlers[type].forEach(h => h(event)); } };
  const send = async (url, init) => {
    sent.push({ url, init, headers: new Headers(init.headers) });
    return network ? network(url, init) : new Response('live ' + url, { headers: { 'Content-Type': PART, 'X-KIN-Study-Revision': 'rev-now' } });
  };
  const preloadFetch = attach(win, send);
  // The page's own fetch: the session transport binds the request, then this module reads it (viewer-session.js).
  win.fetch = (url, init = {}) => {
    const headers = new Headers(init.headers); headers.set('X-KIN-Session', 'sess-1');
    return preloadFetch(url, { ...init, headers });
  };
  return { fetch: preloadFetch, posted, sent, listeners, win };
}

/** Enough of a document for the back/forward return: the root's style, an alert with a button. */
function fakeDocument() {
  const element = tag => ({ tag, children: [], style: {}, attributes: {}, textContent: '', onclick: null,
    setAttribute(name, value) { this.attributes[name] = value; }, append(...nodes) { this.children.push(...nodes); },
    remove() { body.children.splice(body.children.indexOf(this), 1); } });
  const body = element('body');
  return { documentElement: element('html'), body, createElement: element };
}
const openingOf = s => s.headers.get('X-KIN-View-Opening');
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

for (const [media, syntax] of [
  ['application/octet-stream', '1.2.840.10008.1.2.1'],
  ['image/jpeg', '1.2.840.10008.1.2.4.50'],
  ['image/jls', '1.2.840.10008.1.2.4.80'],
  ['image/jp2', '1.2.840.10008.1.2.4.90'],
  ['image/dicom-rle', '1.2.840.10008.1.2.5'],
]) {
  test(`cached ${media} reaches the viewer with its exact Content-Type after the live check`, async () => {
    const partType = `multipart/related; type="${media}; transfer-syntax=${syntax}"; boundary=codec`;
    const { fetch, sent } = setup({ held: { [STUDY]: { revision: 'rev-now', session: 'sess-1', partType } } });
    await (await fetch(frameUrl(1), bound())).arrayBuffer();
    const answer = await fetch(frameUrl(2), bound());
    assert.equal(answer.headers.get('Content-Type'), partType);
    assert.equal(await answer.text(), 'held 1 ' + new URL(frameUrl(2)).pathname);
    assert.equal(sent.length, 1, 'only the live check used the network');
    assert.equal(sent[0].headers.get('X-KIN-Preload'), 'check');
  });
}

test('a study the worker does not hold is read live, unchanged', async () => {
  const { fetch, sent, posted } = setup();
  const answer = await fetch(frameUrl(1), bound());
  assert.equal(await answer.text(), 'live ' + frameUrl(1));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].headers.get('X-KIN-Preload'), null);
  assert.match(openingOf(sent[0]) ?? '', /^[0-9a-f-]{36}$/, 'the viewer\'s read names its opening, not a fetch');
  await fetch(frameUrl(2), bound());
  assert.equal(sent.length, 2, 'later frames of a study not held stay live');
  assert.equal(openingOf(sent[1]), openingOf(sent[0]), 'the reads of one opening name the same one');
  assert.equal(posted.filter(m => m.type === 'query').length, 1, 'the worker is asked once per study and document');
});

test('a held study: the first frame read is the live check, then frames come from memory', async () => {
  const { fetch, sent, posted, listeners } = setup({ held: { [STUDY]: { revision: 'rev-now', session: 'sess-1' } } });
  const first = await fetch(frameUrl(1), bound());
  assert.equal(await first.text(), 'live ' + frameUrl(1), 'the check read\'s own answer is the first frame');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].headers.get('X-KIN-Preload'), 'check');
  assert.ok(openingOf(sent[0]), 'the check read names the opening it records');
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

test('without a SharedWorker every image read still names its opening; business calls name none', async () => {
  const { fetch, sent } = setup({ shared: false });
  await fetch(frameUrl(1), bound());
  await fetch(`${ORIGIN}/dicom-web/studies/${STUDY}/metadata`, bound());
  await fetch(`${ORIGIN}/api/me`, bound());
  const [frame, metadata, business] = sent.map(openingOf);
  assert.ok(frame);
  assert.deepEqual([metadata, business], [frame, null]);
  assert.ok(sent.every(s => s.headers.get('X-KIN-Session') === 'sess-1'));
});

test('review R1: every image read of one document names one opening - queried renderings too; another document of the same session is another opening, also of a study it reads from memory', async () => {
  const held = { [STUDY]: { revision: 'rev-now', session: 'sess-1' } };
  const a = setup({ held });
  await a.fetch(frameUrl(1), bound());                                     // the check read
  await a.fetch(frameUrl(2), bound());                                     // from memory
  await a.fetch(frameUrl(2) + '?accept=x', bound());                       // a query: live, never from memory
  await a.fetch(`${ORIGIN}/instances/0a1b2c3d-4e5f6071-8293a4b5-c6d7e8f9-0a1b2c3d/frames/1/rendered?width=64`, bound());
  await a.fetch(`${ORIGIN}/api/me`, bound());
  const names = a.sent.map(openingOf);
  assert.deepEqual(names.slice(0, 3), Array(3).fill(names[0]), 'one opening for every image read of the document');
  assert.equal(names[3], null, 'business calls name none');
  a.listeners.pagehide();
  // The viewer closed and the study opened again at once, in a fresh document: a new opening, with its own check.
  const b = setup({ held });
  await b.fetch(frameUrl(1), bound());
  assert.equal(b.sent[0].headers.get('X-KIN-Preload'), 'check');
  assert.ok(openingOf(b.sent[0]) && openingOf(b.sent[0]) !== names[0], 'the reopen is another opening');
});

test('reenter: a study this document showed is read live for the new opening before anything shows, never from memory; one not shown here is not read; commit makes it the study\'s opening and its held copy is checked again', async () => {
  const OTHER = '1.2.840.9.2', LEFT = '1.2.840.9.3';
  const { fetch, sent } = setup({ held: { [STUDY]: { revision: 'rev-now', session: 'sess-1' } } });
  await fetch(frameUrl(1), bound());
  await fetch(frameUrl(2), bound());
  await fetch(frameUrl(1, LEFT), bound());                                 // a study of the scope being left
  const first = openingOf(sent[0]);
  assert.equal(sent.length, 2, 'the check read and the live study only');
  const entry = await fetch.reenter([STUDY, OTHER]);
  assert.ok(entry);
  const barrier = sent.slice(2);
  assert.equal(barrier.length, 1, 'one live read, of the study shown before; the other has no pixels here to show');
  assert.equal(barrier[0].url, frameUrl(2), 'its last frame read');
  assert.equal(barrier[0].headers.get('X-KIN-Preload'), null);
  assert.equal(barrier[0].headers.get('X-KIN-Session'), 'sess-1', 'bound by the session transport');
  assert.equal(barrier[0].headers.get('Accept'), PART);
  const next = openingOf(barrier[0]);
  assert.ok(next && next !== first);
  // Until the scope is shown, the current opening holds.
  await fetch(frameUrl(3), bound());
  assert.equal(sent.length, 3, 'still from memory under the earlier check');
  entry.commit();
  await fetch(frameUrl(4), bound());
  assert.deepEqual([sent[3].headers.get('X-KIN-Preload'), openingOf(sent[3])], ['check', next], 'checked again for the new opening');
  await fetch(frameUrl(5), bound());
  assert.equal(sent.length, 4, 'then from memory');
  await fetch(frameUrl(1, OTHER), bound());
  await fetch(frameUrl(2, LEFT), bound());
  await fetch(`${ORIGIN}/instances/0a1b2c3d-4e5f6071-8293a4b5-c6d7e8f9-0a1b2c3d/preview`, bound());
  assert.deepEqual(sent.slice(4).map(openingOf), [next, first, next],
    'the entered studies and the scope\'s unnamed reads take the new opening; a late read of a study left keeps its own');
});

test('reenter: a read that fails or is refused answers null and changes nothing; an entry never committed changes nothing; a study whose reads all failed showed nothing and is not read', async () => {
  let status = 503;
  const { fetch, sent } = setup({ network: async url => new Response('x ' + url, { status, headers: { 'Content-Type': PART } }) });
  assert.equal((await fetch(frameUrl(1), bound())).status, 503);
  assert.ok(await fetch.reenter([STUDY]), 'nothing of the study showed here: its own first read records it');
  assert.equal(sent.length, 1, 'no read again for a study whose only read failed');
  status = 200;
  await fetch(frameUrl(1), bound());
  const first = openingOf(sent.at(-1));
  for (const failing of [503, 401]) {
    status = failing;
    assert.equal(await fetch.reenter([STUDY]), null, String(failing));
  }
  status = 200;
  assert.ok(await fetch.reenter([STUDY]), 'recorded, but the tab never showed');
  await fetch(frameUrl(2), bound());
  assert.equal(openingOf(sent.at(-1)), first, 'the opening is unchanged');
  let cut = false;
  const thrown = setup({ network: async url => { if (cut) throw new TypeError('network'); return new Response('x ' + url, { headers: { 'Content-Type': PART } }); } });
  await thrown.fetch(frameUrl(1), bound());
  cut = true;
  assert.equal(await thrown.fetch.reenter([STUDY]), null, 'a read that does not reach the server records nothing');
});

test('back/forward: the kept page is hidden on leaving and shown only after the return\'s opening is recorded; when it cannot be, it stays hidden with a Retry', async () => {
  let status = 200;
  const s = setup({ studies: [STUDY], page: true, held: { [STUDY]: { revision: 'rev-now', session: 'sess-1' } },
    network: async url => new Response('live ' + url, { status, headers: { 'Content-Type': PART, 'X-KIN-Study-Revision': 'rev-now' } }) });
  await s.fetch(frameUrl(1), bound());
  const first = openingOf(s.sent[0]), root = s.win.document.documentElement;
  s.listeners.pagehide({ persisted: false });
  assert.equal(root.style.visibility, undefined, 'a page that is not kept is not touched');
  s.listeners.pageshow({ persisted: false });
  await tick();
  assert.equal(s.sent.length, 1, 'an ordinary show is no return');
  s.listeners.pagehide({ persisted: true });
  assert.equal(root.style.visibility, 'hidden');
  status = 503;
  s.listeners.pageshow({ persisted: true });
  await tick();
  assert.equal(root.style.visibility, 'hidden', 'no record, no pixels');
  const [alert] = s.win.document.body.children;
  assert.equal(alert.attributes.role, 'alert');
  assert.match(alert.children[0].textContent, /열람 기록/);
  const retry = alert.children[1];
  assert.equal(retry.textContent, 'Retry');
  status = 200;
  retry.onclick();
  await tick();
  assert.equal(root.style.visibility, '', 'shown after the return\'s opening was recorded');
  assert.equal(s.win.document.body.children.length, 0, 'the notice is gone');
  const reads = s.sent.slice(1);
  assert.deepEqual(reads.map(r => r.headers.get('X-KIN-Preload')), [null, null], 'live reads, never from memory');
  const next = openingOf(reads[1]);
  assert.ok(next && next !== first && openingOf(reads[0]) !== first);
  await s.fetch(frameUrl(2), bound());
  assert.deepEqual([s.sent.at(-1).headers.get('X-KIN-Preload'), openingOf(s.sent.at(-1))], ['check', next], 'the held copy is checked for the return');
});

const OBJECT_ID = '0a1b2c3d-4e5f6071-8293a4b5-c6d7e8f9-0a1b2c3d', OTHER_OBJECT = '1b2c3d4e-5f607182-93a4b5c6-d7e8f90a-1b2c3d4e';
const objectUrl = (kind, id = OBJECT_ID) => `${ORIGIN}/instances/${id}/${kind}`;
/** The server's image answers: an answer of a stored object names the study it recorded (`studyOf` the object ID). */
const answering = (studyOf = () => STUDY) => async url => {
  const object = /\/instances\/([0-9a-f-]+)\//.exec(new URL(url).pathname)?.[1];
  return new Response('live ' + url, { headers: { 'Content-Type': PART, ...(object ? { 'X-KIN-Study-UID': studyOf(object) } : {}) } });
};

test('review R1 of f455ba2: a study shown only by a queried frame, a rendering, a document or a preview is read live again for a new opening, and for a back/forward return before the kept page shows - with and without a worker', async () => {
  const forms = [frameUrl(1) + '?accept=x', frameUrl(1).replace('/frames/1', '/rendered'), objectUrl('pdf'), objectUrl('preview'),
    objectUrl('frames/1/rendered?width=64')];
  for (const shared of [false, true]) for (const url of forms) {
    const label = `${shared ? 'worker' : 'no worker'} ${new URL(url).pathname}${new URL(url).search}`;
    const s = setup({ shared, studies: [STUDY], page: true, network: answering() });
    assert.equal((await s.fetch(url, bound())).status, 200);
    const first = openingOf(s.sent[0]), root = s.win.document.documentElement;
    const entry = await s.fetch.reenter([STUDY]);
    assert.ok(entry, label);
    assert.equal(s.sent.length, 2, label + ': one live read before the scope shows');
    const again = s.sent[1];
    assert.equal(again.url, url, label + ': the read that showed the study');
    assert.equal(again.headers.get('X-KIN-Preload'), null, label);
    const next = openingOf(again);
    assert.ok(next && next !== first, label + ': named with the new opening');
    entry.commit();
    s.listeners.pagehide({ persisted: true });
    assert.equal(root.style.visibility, 'hidden', label);
    s.listeners.pageshow({ persisted: true });
    await tick();
    assert.equal(s.sent.length, 3, label + ': the return reads it live again');
    assert.equal(s.sent[2].url, url, label);
    assert.ok(![first, next, null].includes(openingOf(s.sent[2])), label + ': under the return\'s own opening');
    assert.equal(root.style.visibility, '', label + ': shown once that read was answered');
  }
});

test('review R1 of f455ba2: an object\'s answer relates it to its study - each study of a scope is read again for its own entry only, a study keeps its opening, and its frame read is the one read again', async () => {
  const OTHER = '1.2.840.9.2';
  const s = setup({ shared: false, studies: [STUDY, OTHER], network: answering(id => id === OBJECT_ID ? STUDY : OTHER) });
  await s.fetch(objectUrl('pdf'), bound());                                 // STUDY's document
  await s.fetch(objectUrl('preview', OTHER_OBJECT), bound());               // OTHER's preview
  const first = openingOf(s.sent[0]);
  const entry = await s.fetch.reenter([OTHER]);
  assert.deepEqual(s.sent.slice(2).map(r => r.url), [objectUrl('preview', OTHER_OBJECT)], 'only the entered study is read again');
  const next = openingOf(s.sent[2]);
  entry.commit();
  await s.fetch(objectUrl('pdf'), bound());
  await s.fetch(objectUrl('preview', OTHER_OBJECT), bound());
  assert.deepEqual(s.sent.slice(3).map(openingOf), [first, next], 'a late read of the study left keeps its opening');
  // A study shown by a frame and by its preview: the frame is read again, once.
  const f = setup({ shared: false, network: answering() });
  await f.fetch(frameUrl(1), bound());
  await f.fetch(objectUrl('preview'), bound());
  await f.fetch.reenter([STUDY]);
  assert.deepEqual(f.sent.slice(2).map(r => r.url), [frameUrl(1)]);
  // An object read no answer placed stands for the studies shown when it was made.
  const u = setup({ shared: false, studies: [STUDY], network: async url => new Response('x ' + url, { headers: { 'Content-Type': 'application/pdf' } }) });
  await u.fetch(objectUrl('pdf'), bound());
  await u.fetch.reenter([OTHER]);
  assert.equal(u.sent.length, 1, 'not for another study');
  await u.fetch.reenter([STUDY]);
  assert.deepEqual(u.sent.slice(1).map(r => r.url), [objectUrl('pdf')]);
  // Descriptions show no pixels: never the read a new opening reads again.
  const d = setup({ shared: false, network: answering() });
  await d.fetch(`${ORIGIN}/dicom-web/studies/${STUDY}/metadata`, bound());
  await d.fetch(objectUrl('tags'), bound());
  assert.ok(await d.fetch.reenter([STUDY]));
  assert.equal(d.sent.length, 2, 'nothing read again');
});

test('back/forward: the kept page also reads again a study it showed beside its address\'s (a comparison read under the scope)', async () => {
  const PRIOR = '1.2.840.9.4';
  const s = setup({ shared: false, studies: [STUDY], page: true });
  await s.fetch(frameUrl(1), bound());
  await s.fetch(frameUrl(1, PRIOR), bound());
  s.listeners.pagehide({ persisted: true });
  s.listeners.pageshow({ persisted: true });
  await tick();
  assert.deepEqual(s.sent.slice(2).map(r => r.url).sort(), [frameUrl(1), frameUrl(1, PRIOR)].sort());
  assert.equal(s.win.document.documentElement.style.visibility, '');
});

test('review R2 of f455ba2: the API\'s own image routes name the opening as the public ones do, with and without a worker, and a held study read by them is checked first; business calls under /api name none', async () => {
  const api = n => frameUrl(n).replace('/dicom-web/', '/api/dicom-web/');
  for (const shared of [false, true]) {
    const s = setup({ shared, network: answering() });
    const reads = [frameUrl(1), api(2), frameUrl(3).replace('/dicom-web/', '/api/image-relay/dicom-web/'),
      `${ORIGIN}/api/image-relay/instances/${OBJECT_ID}/frames/0/rendered`, `${ORIGIN}/api/instances/${OBJECT_ID}/preview`];
    for (const url of reads) assert.equal((await s.fetch(url, bound())).status, 200);
    await s.fetch(`${ORIGIN}/api/me`, bound());
    await s.fetch(`${ORIGIN}/api/dicom/lookup`, { method: 'POST', headers: new Headers({ 'X-KIN-Session': 'sess-1', 'Content-Type': 'application/json' }), body: '{}' });
    const names = s.sent.map(openingOf);
    assert.ok(names[0]);
    assert.deepEqual(names, [...Array(reads.length).fill(names[0]), null, null], shared ? 'worker' : 'no worker');
    // Read by an API route only, the study is read again for a new opening.
    const r = setup({ shared, network: answering() });
    await r.fetch(`${ORIGIN}/api/image-relay/instances/${OBJECT_ID}/pdf`, bound());
    await r.fetch.reenter([STUDY]);
    assert.equal(r.sent.length, 2);
    assert.ok(openingOf(r.sent[1]) && openingOf(r.sent[1]) !== openingOf(r.sent[0]));
  }
  const held = setup({ held: { [STUDY]: { revision: 'rev-now', session: 'sess-1' } } });
  await held.fetch(api(1), bound());
  assert.equal(held.sent[0].headers.get('X-KIN-Preload'), 'check');
  assert.equal(await (await held.fetch(api(2), bound())).text(), 'held 1 ' + new URL(frameUrl(2)).pathname, 'then from memory');
  assert.equal(held.sent.length, 1);
});

/** A network whose first read waits for `release()`; each answer says the opening it was read under. */
function holdingFirst({ names = true, revision = null } = {}) {
  let release, first = true;
  const gate = new Promise(resolve => { release = resolve; });
  const network = async (url, init) => {
    if (first) { first = false; await gate; }
    const object = /\/instances\/([0-9a-f-]+)\//.exec(new URL(url).pathname)?.[1];
    return new Response('live ' + new Headers(init.headers).get('X-KIN-View-Opening'), { headers: { 'Content-Type': PART,
      ...(object && names ? { 'X-KIN-Study-UID': STUDY } : {}), ...(revision ? { 'X-KIN-Study-Revision': revision } : {}) } });
  };
  return { network, release: () => release() };
}

test('review R1 of 137c2b7: a first read still unanswered when its study is opened again (A -> B -> A) is not handed on - it is read again under the new opening, and that answer is the one shown; with and without a worker, whatever the form', async () => {
  const OTHER = '1.2.840.9.2';
  const forms = [frameUrl(1), frameUrl(1) + '?accept=x', objectUrl('frames/1/rendered'), objectUrl('preview')];
  for (const shared of [false, true]) for (const url of forms) for (const names of [true, false]) {
    if (!names && !url.includes('/instances/')) continue;
    const label = `${shared ? 'worker' : 'no worker'} ${new URL(url).pathname}${new URL(url).search}${names ? '' : ' (answer names no study)'}`;
    const net = holdingFirst({ names });
    const s = setup({ shared, studies: [STUDY], network: net.network });
    const pending = s.fetch(url, bound());
    await tick();
    const first = openingOf(s.sent[0]);
    (await s.fetch.reenter([OTHER])).commit();
    (await s.fetch.reenter([STUDY])).commit();
    assert.equal(s.sent.length, 1, label + ': nothing of the study answered yet, nothing to read on entry');
    net.release();
    const answer = await pending;
    assert.equal(s.sent.length, 2, label + ': the earlier opening\'s answer is read again');
    assert.equal(s.sent[1].url, url, label);
    const next = openingOf(s.sent[1]);
    assert.ok(next && next !== first, label + ': under the new opening');
    assert.equal(await answer.text(), 'live ' + next, label + ': the answer handed on is the new opening\'s read');
    await (await s.fetch(frameUrl(2), bound())).text();
    assert.equal(openingOf(s.sent.at(-1)), next, label + ': the study\'s later reads name the same opening');
    if (shared) assert.equal(s.posted.filter(m => m.type === 'busy').at(-1).busy, false, label + ': the dropped answer ends its reading');
  }
  // Only left (A -> B), or an entry never committed: the study keeps its opening, and its late answer is handed on.
  for (const enter of [[OTHER], [STUDY]]) for (const shared of [false, true]) {
    const net = holdingFirst();
    const s = setup({ shared, studies: [STUDY], network: net.network });
    const pending = s.fetch(frameUrl(1), bound());
    await tick();
    const entry = await s.fetch.reenter(enter);
    if (enter[0] === OTHER) entry.commit();
    net.release();
    assert.equal(await (await pending).text(), 'live ' + openingOf(s.sent[0]));
    assert.equal(s.sent.length, 1, `${enter} ${shared}: no read again`);
  }
});

test('review R1 of 137c2b7: a study whose earlier read is answered while its entry reads other studies is read for the entry too, before it resolves', async () => {
  const OTHER = '1.2.840.9.2';
  let releaseFirst, releaseEntry;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; }), entryGate = new Promise(resolve => { releaseEntry = resolve; });
  const s = setup({ shared: false, studies: [STUDY, OTHER], network: async (url, init) => {
    const opening = new Headers(init.headers).get('X-KIN-View-Opening');
    if (url === frameUrl(1)) { if (s.sent.length === 1) await firstGate; }
    else if (s.sent.length > 2) await entryGate;
    return new Response('live ' + opening, { headers: { 'Content-Type': PART } });
  } });
  const pending = s.fetch(frameUrl(1), bound());                     // STUDY's first read, unanswered
  await s.fetch(frameUrl(1, OTHER), bound());                        // OTHER shown
  const entering = s.fetch.reenter([STUDY, OTHER]);
  await tick();
  assert.deepEqual(s.sent.slice(2).map(r => r.url), [frameUrl(1, OTHER)], 'the study shown is read for the entry');
  releaseFirst();
  await pending;                                                     // answered under the scope still shown: STUDY shows now
  releaseEntry();
  assert.ok(await entering);
  const reads = s.sent.slice(2);
  assert.deepEqual(reads.map(r => r.url), [frameUrl(1, OTHER), frameUrl(1)], 'then STUDY too, before the entry resolved');
  assert.equal(openingOf(reads[1]), openingOf(reads[0]));
  assert.notEqual(openingOf(reads[0]), openingOf(s.sent[0]));
});

test('review R1 of 137c2b7: memory answers of a held study in flight across its new opening are not handed on before that opening\'s own check', async () => {
  const net = holdingFirst({ revision: 'rev-now' });
  const s = setup({ held: { [STUDY]: { revision: 'rev-now', session: 'sess-1' } }, studies: [STUDY], network: net.network });
  const reads = [1, 2, 3].map(n => s.fetch(frameUrl(n), bound()));    // 1 checks; 2 and 3 wait for that check
  await tick();
  assert.equal(s.sent.length, 1);
  const first = openingOf(s.sent[0]);
  (await s.fetch.reenter([STUDY])).commit();
  net.release();
  const texts = await Promise.all(reads.map(async r => (await r).text()));
  assert.equal(s.sent.length, 2, 'one check for the new opening');
  assert.equal(s.sent[1].headers.get('X-KIN-Preload'), 'check');
  const next = openingOf(s.sent[1]);
  assert.ok(next && next !== first);
  assert.deepEqual(texts.map(t => t.split(' ')[0]).sort(), ['held', 'held', 'live'], 'the new check\'s answer, then memory');
  assert.ok(texts.includes('live ' + next), 'no answer of the earlier check is handed on');
});
