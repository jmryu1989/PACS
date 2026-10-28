/* D1880 memory-only preload (Minhoon P0 item 1): the one SharedWorker the worklist and every viewer window of this
 * browser connect to (design fable-design-preload-memory-20261027 §4.1). It lives while any of them is open and its
 * memory ends with it; it writes nothing to disk (no Cache Storage, IndexedDB, OPFS; every fetch is `no-store`).
 *
 * The worklist queues studies (Preload on a multi-selection); the worker fetches each study's frames, one at a time and
 * at low priority, through the same frame route as the viewer - the same gate and the same 열람 record of the study
 * delivery (D1877) as any other image read - and keeps them in preload-store.js. A viewer that opens a held study checks
 * it live first (viewer-preload.js) and then takes frames from here instead of the network.
 *
 * Reading comes first: while a viewer is loading images from the network, the queue does not start another fetch.
 * Every request carries the session the worklist gave; a store filled under one session is never handed to another,
 * and a session that ended empties it.
 */
'use strict';
importScripts('preload-store.js');

const FRAME_ACCEPT = 'multipart/related; type="application/octet-stream"; transfer-syntax=*';
const ENDED_CODES = ['AUTH_SESSION_ENDED', 'AUTH_SESSION_MISMATCH'];
const MESSAGES = Object.freeze({
  unavailable: '이 브라우저가 메모리 크기를 알려 주지 않아 미리 받기를 할 수 없습니다.',
  ended: '세션이 끝나 미리 받은 영상을 비웠습니다.',
  cleared: '미리 받은 영상을 비웠습니다.',
  denied: '검사 접근이 거절되었습니다. 접근 권한을 확인하세요.',
  missing: '영상을 찾을 수 없습니다.',
  busy: '서버가 바쁘거나 응답하지 않았습니다. 다시 시도하세요.',
  network: '서버에 연결하지 못했습니다. 다시 시도하세요.',
  changed: '미리 받는 동안 검사 내용이 바뀌었습니다. 다시 시도하세요.',
  empty: '이 검사에는 미리 받을 영상이 없습니다.',
  size: '검사가 미리 받기 메모리보다 커서 받을 수 없습니다. 판독 때 바로 엽니다.',
  malformed: '서버 응답을 해석하지 못했습니다. 다시 시도하세요.',
});

const store = self.KinPreloadStore.create(self.KinPreloadStore.budgetFor(self.navigator?.deviceMemory));
const ports = new Map();   // port -> { role, busy, opens: Map(uid -> count) }
let session = null, epoch = 0, running = false, controller = null;
let idleWaiters = [];

class Stop extends Error { constructor(reason) { super(reason); this.reason = reason; } }

function broadcast() {
  const state = { type: 'state', session, ...store.snapshot() };
  for (const [port, info] of ports) if (info.role === 'list') { try { port.postMessage(state); } catch (_) {} }
}

function busy() { for (const info of ports.values()) if (info.busy) return true; return false; }
function settleIdle() { if (busy()) return; const waiters = idleWaiters; idleWaiters = []; for (const run of waiters) run(); }
/** Resolves when no viewer is loading from the network. */
function idle() { return busy() ? new Promise(resolve => idleWaiters.push(resolve)) : Promise.resolve(); }

/** Everything goes: another session, an ended one, or Clear All. A fetch in flight is cut; nothing of it is kept. */
function clearAll(reason, next = null) {
  epoch++;
  controller?.abort();
  store.clear(reason);
  session = next;
  // A fetch loop parked behind a viewer that never said it finished (a crashed window) ends here too.
  const waiters = idleWaiters; idleWaiters = []; for (const run of waiters) run();
  broadcast();
}

async function get(url, headers, signal) {
  let response;
  try {
    response = await fetch(url, { headers: { ...headers, 'X-KIN-Session': session }, cache: 'no-store',
      credentials: 'same-origin', priority: 'low', signal });
  } catch (error) {
    if (signal.aborted) throw new Stop(null);
    throw new Stop(MESSAGES.network);
  }
  if (response.ok) return response;
  const code = response.headers.get('X-KIN-Auth-Code');
  try { await response.body?.cancel(); } catch (_) {}
  if (response.status === 401 || response.status === 428 || ENDED_CODES.includes(code)) throw new Stop('ended');
  if (response.status === 403) throw new Stop(MESSAGES.denied);
  if (response.status === 404) throw new Stop(MESSAGES.missing);
  if (response.status === 429 || response.status >= 500) throw new Stop(MESSAGES.busy);
  throw new Stop(`요청을 완료하지 못했습니다(${response.status}).`);
}

const tag = (item, key) => item?.[key]?.Value?.[0];
/** Image objects of the study and their frame counts, from its DICOMweb metadata. Nothing else of it is kept. */
function objects(metadata) {
  if (!Array.isArray(metadata)) throw new Stop(MESSAGES.malformed);
  const list = [];
  for (const item of metadata) {
    const series = tag(item, '0020000E'), sop = tag(item, '00080018');
    if (!item?.['7FE00010'] || typeof series !== 'string' || typeof sop !== 'string') continue;
    const frames = Number(tag(item, '00280008') ?? 1);
    if (!/^[0-9.]{1,64}$/.test(series) || !/^[0-9.]{1,64}$/.test(sop) || !Number.isInteger(frames) || frames < 1) continue;
    list.push({ series, sop, frames });
  }
  return list;
}

/** First frame of every object first - the opening screen - then the rest of each object in order. */
function framePaths(uid, list) {
  const base = o => `/dicom-web/studies/${uid}/series/${o.series}/instances/${o.sop}/frames/`;
  const first = list.map(o => base(o) + 1), rest = [];
  for (const o of list) for (let n = 2; n <= o.frames; n++) rest.push(base(o) + n);
  return { first, rest };
}

async function download(study, mine) {
  const uid = study.uid;
  const live = () => mine === epoch;
  controller = new AbortController();
  const signal = controller.signal;
  if (!store.start(uid)) return 'gone';
  broadcast();
  const metadata = await (await get(`/dicom-web/studies/${uid}/metadata`, { Accept: 'application/dicom+json' }, signal)).json()
    .catch(error => { throw error instanceof Stop ? error : new Stop(MESSAGES.malformed); });
  if (!live()) return 'gone';
  const list = objects(metadata);
  if (!list.length) throw new Stop(MESSAGES.empty);
  const { first, rest } = framePaths(uid, list);
  // Cleared, removed or dropped by a viewer while the metadata was read: nothing more of it.
  if (!store.start(uid, first.length + rest.length)) return 'gone';
  let firstBytes = 0;
  for (const [index, path] of [...first, ...rest].entries()) {
    await idle();
    if (!live()) return 'gone';
    const kept = store.frame(path);
    if (kept) {
      if (index < first.length) firstBytes += kept.data.byteLength * list[index].frames;
      if (index === first.length - 1 && !store.estimate(uid, firstBytes)) throw new Stop(MESSAGES.size);
      continue;
    }
    const response = await get(path, { Accept: FRAME_ACCEPT, 'X-KIN-Preload': 'store' }, signal);
    const revision = response.headers.get('X-KIN-Study-Revision');
    const contentType = response.headers.get('Content-Type') || '';
    const gzip = /^application\/gzip\b/i.test(contentType);
    const type = gzip ? response.headers.get('X-KIN-Part-Type') : contentType;
    let data;
    try { data = await response.arrayBuffer(); }
    catch (_) { throw new Stop(signal.aborted ? null : MESSAGES.network); }
    if (!live()) return 'gone';
    if (!type || !/^multipart\/related\b/i.test(type)) throw new Stop(MESSAGES.malformed);
    const outcome = store.put(uid, path, Object.freeze({ data, gzip, type }), revision);
    if (outcome === 'changed') throw new Stop(MESSAGES.changed);
    if (outcome === 'gone') return 'gone';
    if (outcome === 'full') return 'full';
    if (index < first.length) {
      firstBytes += data.byteLength * list[index].frames;
      if (index === first.length - 1 && !store.estimate(uid, firstBytes)) throw new Stop(MESSAGES.size);
    }
    broadcast();
  }
  store.ready(uid);
  return 'ready';
}

async function pump() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      if (!session || store.budget() === null) return;
      const study = store.next();
      if (!study) return;
      const mine = epoch;
      try {
        // Out of memory: the queue stops here, in order, until a viewer closes a study or the reader frees one (wake).
        if (await download(study, mine) === 'full') return;
      } catch (error) {
        if (mine !== epoch) continue;
        const reason = error instanceof Stop ? error.reason : MESSAGES.malformed;
        if (reason === 'ended') { clearAll(MESSAGES.ended); return; }
        if (reason) store.fail(study.uid, reason);
      } finally { if (mine === epoch) controller = null; broadcast(); }
    }
  } finally { running = false; }
}

/** Gunzip a held frame into a fresh buffer the viewer takes over (transferred, not copied). */
async function decoded(frame) {
  if (!frame.gzip) return frame.data.slice(0);
  const stream = new Blob([frame.data]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

function release(port) {
  const info = ports.get(port);
  if (!info) return;
  let freed = false;
  for (const [uid, count] of info.opens) for (let i = 0; i < count; i++) freed = store.close(uid) || freed;
  info.opens.clear();
  info.busy = false;
  if (freed && store.wake()) void pump();
  settleIdle();
}

async function handle(port, message) {
  // A window that said goodbye and came back (back/forward cache) is a port again.
  let info = ports.get(port);
  if (!info) { info = { role: null, busy: false, opens: new Map() }; ports.set(port, info); }
  const reply = (value, transfer = []) => port.postMessage({ type: 'reply', id: message.id, ...value }, transfer);
  switch (message?.type) {
    case 'hello':
      info.role = message.role === 'viewer' ? 'viewer' : 'list';
      if (info.role === 'list') port.postMessage({ type: 'state', session, ...store.snapshot() });
      return;
    case 'add': {
      if (typeof message.session !== 'string' || !message.session) return;
      // A store filled under another session is never handed to this one.
      if (session !== message.session) clearAll(MESSAGES.cleared, message.session);
      const list = Array.isArray(message.studies) ? message.studies.filter(s => typeof s?.uid === 'string' && /^[0-9.]{1,64}$/.test(s.uid)) : [];
      store.add(list.map(s => ({ uid: s.uid, label: typeof s.label === 'string' ? s.label.slice(0, 200) : null })));
      if (store.budget() === null) for (const s of list) store.fail(s.uid, MESSAGES.unavailable);
      broadcast();
      void pump();
      return;
    }
    case 'session':
      // The worklist's session changed or ended: nothing held under the old one stays.
      if (session !== null && message.session !== session) clearAll(MESSAGES.ended, null);
      return;
    case 'retry':
      if (store.retry(message.uid)) { broadcast(); void pump(); }
      return;
    case 'remove':
      store.remove(message.uid);
      if (store.wake()) void pump();
      broadcast();
      return;
    case 'clear':
      clearAll(MESSAGES.cleared, session);
      return;
    case 'query': {
      const held = session && message.session === session ? store.held(message.uid) : null;
      reply({ held: held && held.revision ? { revision: held.revision } : null });
      return;
    }
    case 'frame': {
      const frame = session && message.session === session ? store.frame(message.path) : null;
      if (!frame) { reply({ bytes: null }); return; }
      try { const bytes = await decoded(frame); reply({ bytes, partType: frame.type }, [bytes]); }
      catch (_) { reply({ bytes: null }); }
      return;
    }
    case 'open':
      store.open(message.uid);
      info.opens.set(message.uid, (info.opens.get(message.uid) || 0) + 1);
      broadcast();
      return;
    case 'evict':
      store.evict(message.uid, typeof message.reason === 'string' ? message.reason.slice(0, 200) : null);
      if (store.wake()) void pump();
      broadcast();
      return;
    case 'busy':
      info.busy = message.busy === true;
      settleIdle();
      return;
    case 'bye':
      release(port);
      ports.delete(port);
      broadcast();
      return;
  }
}

self.onconnect = event => {
  const port = event.ports[0];
  ports.set(port, { role: null, busy: false, opens: new Map() });
  port.onmessage = e => { void handle(port, e.data).catch(() => {}); };
  port.start();
};
