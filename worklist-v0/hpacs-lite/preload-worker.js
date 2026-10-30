/* D1890: only ciphertext survives the worker. A viewer still needs its live check and durable user-view root. */
'use strict';
importScripts('preload-store.js', 'preload-disk.js');
const Model = self.KinPreloadStore, Disk = self.KinPreloadDisk, disk = Disk.create();
const FRAME_ACCEPT = ['application/octet-stream', 'image/jpeg', 'image/jls', 'image/jp2', 'image/dicom-rle']
  .map(type => 'multipart/related; type="' + type + '"; transfer-syntax=*').join(', ');
const MESSAGES = Object.freeze({
  unavailable: '이 브라우저의 보관 저장소를 사용할 수 없습니다. 다시 시도하세요.',
  unset: '이 기관에서 미리 받기에 쓸 저장 용량을 아직 정하지 않아 미리 받기를 할 수 없습니다. 관리자에게 문의하세요.',
  key: '이 계정으로는 미리 받기를 쓸 수 없습니다',
  cleared: '미리 받은 영상을 비웠습니다.',
  denied: '검사 접근이 거절되었습니다. 접근 권한을 확인하세요.',
  missing: '영상을 찾을 수 없습니다.',
  busy: '서버가 바쁘거나 응답하지 않았습니다. 다시 시도하세요.',
  network: '서버에 연결하지 못했습니다. 다시 시도하세요.',
  changed: '미리 받는 동안 검사 내용이 바뀌었습니다. 다시 시도하세요.',
  empty: '이 검사에는 미리 받을 영상이 없습니다.',
  size: '검사가 미리 받기 저장 용량보다 커서 받을 수 없습니다. 판독 때 바로 엽니다.',
  malformed: '서버 응답을 해석하지 못했습니다. 다시 시도하세요.',
  corrupt: '보관한 영상이 손상되어 지웠습니다. 다시 받으려면 Retry를 누르세요.',
  space: '저장 공간이 비기를 기다립니다.',
});
const ports = new Map(), manifests = new Map();
let session = null, epoch = 0, key = null, keyId = null, offset = null, settings = null, unavailable = null;
const now = () => Date.now() + (offset ?? 0);
let store = Model.create(null, now), running = false, controller = null, keyController = null, idleWaiters = [];
let serial = Promise.resolve(), diskUsed = 0;
// Mutations share one queue. Network reads never hold it, so reading and logout can interrupt downloads.
function locked(task) { const run = serial.then(task); serial = run.catch(() => {}); return run; }
class Stop extends Error { constructor(reason) { super(reason); this.reason = reason; } }
function broadcast() {
  const state = { type: 'state', session, unavailable, ...store.snapshot(), used: diskUsed };
  for (const [port, info] of ports) if (info.role === 'list') { try { port.postMessage(state); } catch (_) {} }
}
function busy() { return [...ports.values()].some(info => info.busy); }
function settleIdle() { if (!busy()) for (const resolve of idleWaiters.splice(0)) resolve(); }
function idle() { return busy() ? new Promise(resolve => idleWaiters.push(resolve)) : Promise.resolve(); }
function changeSession(next) {
  epoch++; controller?.abort(); keyController?.abort();
  session = next; key = null; keyId = null; settings = null; unavailable = null;
  store = Model.create(null, now); manifests.clear(); diskUsed = 0;
  for (const info of ports.values()) info.opens.clear();
  for (const resolve of idleWaiters.splice(0)) resolve();
  broadcast();
}
async function get(url, headers, signal, bound = session) {
  let response;
  try { response = await fetch(url, { headers: { ...headers, 'X-KIN-Session': bound }, cache: 'no-store',
    credentials: 'same-origin', priority: 'low', signal }); }
  catch (_) { throw new Stop(signal?.aborted ? null : MESSAGES.network); }
  const serverDate = Date.parse(response.headers.get('Date'));
  if (bound === session && offset === null && Number.isFinite(serverDate)) offset = serverDate - Date.now();
  if (response.ok) return response;
  const code = response.headers.get('X-KIN-Auth-Code');
  try { await response.body?.cancel(); } catch (_) {}
  if (response.status === 401 || response.status === 428 || ['AUTH_SESSION_ENDED', 'AUTH_SESSION_MISMATCH'].includes(code)) throw new Stop('ended');
  if (url === '/api/preload/cache-key' && [403, 404].includes(response.status)) throw new Stop(MESSAGES.key);
  if (response.status === 403) throw new Stop(MESSAGES.denied);
  if (response.status === 404) throw new Stop(MESSAGES.missing);
  throw new Stop(MESSAGES.busy);
}
const recordBytes = record => record.bytes ?? record.ct.byteLength;
async function inventory() {
  const records = await disk.list();
  diskUsed = [...records.frames, ...records.studies].reduce((n, r) => n + recordBytes(r), 0);
  return records;
}
async function erase(uid, reason, failed = false) {
  const mine = epoch;
  const ids = failed ? store.fail(uid, reason) : store.evict(uid, reason);
  const id = manifests.get(uid); manifests.delete(uid);
  await disk.write({}, { frames: ids, studies: id ? [id] : [] });
  await inventory();
  if (failed && mine === epoch && key && store.get(uid)?.expiresAt > now()) await persist(uid);
}
async function sweep() {
  // The first key response establishes server time. No cached answer is possible before this initialization.
  if (offset === null) return;
  const expired = store.entries().filter(s => s.expiresAt <= now());
  const ids = store.expire(now());
  const studies = expired.map(s => manifests.get(s.uid)).filter(Boolean);
  for (const s of expired) manifests.delete(s.uid);
  if (ids.length || studies.length) await disk.write({}, { frames: ids, studies });
  const removed = await disk.sweep(now());
  if (ids.length || studies.length || removed) { await inventory(); store.wake(); }
  if (expired.length) broadcast();
}
async function envelope(uid) {
  const study = store.get(uid);
  let manifestId = manifests.get(uid);
  if (!manifestId) { manifestId = crypto.randomUUID(); manifests.set(uid, manifestId); }
  const value = await Disk.seal(key, new TextEncoder().encode(JSON.stringify(store.manifest(uid))), Disk.studyAAD(keyId, manifestId));
  return { manifestId, keyId, expiresAt: study.expiresAt, ...value };
}
async function room(extra, uid) {
  const mine = epoch;
  await sweep();
  const fits = async () => {
    const estimate = await disk.estimate();
    return mine === epoch && store.budget() !== null && diskUsed + extra <= store.budget()
      && !(Number.isFinite(estimate.quota) && Number.isFinite(estimate.usage) && estimate.usage + extra > estimate.quota);
  };
  if (await fits()) return true;
  const records = await inventory();
  if (mine !== epoch) return false;
  // Foreign records remain opaque. Expiry is the only ordering fact required to reclaim them.
  for (const record of [...records.frames, ...records.studies].filter(r => r.keyId !== keyId).sort((a, b) => a.expiresAt - b.expiresAt)) {
    if (mine !== epoch) return false;
    await disk.write({}, record.entryId ? { frames: [record.entryId] } : { studies: [record.manifestId] });
    await inventory();
    if (await fits()) return true;
  }
  for (const victim of store.evictable(uid)) {
    if (mine !== epoch) return false;
    await erase(victim.uid, '저장 공간을 비우려고 이미 본 검사를 지웠습니다. 다시 받으려면 Retry를 누르세요.');
    if (await fits()) return true;
  }
  return false;
}
async function persist(uid) {
  if (!key || !store.get(uid)) return false;
  const mine = epoch, record = await envelope(uid);
  const prior = (await inventory()).studies.find(r => r.manifestId === record.manifestId);
  if (!await room(Math.max(0, recordBytes(record) - (prior ? recordBytes(prior) : 0)), uid)) return false;
  if (mine !== epoch || !key || store.get(uid)?.expiresAt <= now()) return false;
  await disk.write({ studies: [record] }); await inventory(); return true;
}
function prerequisites() {
  if (settings) return settings;
  const mine = epoch, bound = session;
  keyController = new AbortController(); const signal = keyController.signal;
  const asked = (async () => {
    try {
      const response = await get('/api/preload/cache-key', { Accept: 'application/json' }, signal, bound);
      const answer = await response.json();
      const raw = Uint8Array.from(atob(answer.key), c => c.charCodeAt(0));
      if (raw.length !== 32 || !Number.isFinite(Date.parse(answer.serverTime)) || typeof answer.keyId !== 'string') { raw.fill(0); throw new Stop(MESSAGES.key); }
      const imported = await Disk.importKey(raw);
      if (mine !== epoch) return MESSAGES.key;
      const clockOffset = Date.parse(answer.serverTime) - Date.now();
      const me = await (await get('/api/me', { Accept: 'application/json' }, signal, bound)).json();
      if (mine !== epoch) return MESSAGES.key;
      await locked(async () => {
        if (mine !== epoch) return;
        key = imported; keyId = answer.keyId; offset = clockOffset;
        store.setBudget(Model.budgetFor(me.preloadDiskGb));
        // Restore before sweeping so this session can show the expired row's reason and Retry.
        const records = await inventory(), frames = new Map(records.frames.map(r => [r.entryId, r]));
        for (const record of records.studies.filter(r => r.keyId === keyId)) {
          try {
            const value = JSON.parse(new TextDecoder().decode(await Disk.open(key, record, Disk.studyAAD(keyId, record.manifestId))));
            if (mine !== epoch) return;
            if (!/^[0-9.]{1,64}$/.test(value.uid) || !value.frames || !Number.isFinite(value.queuedAt)) throw new Error('manifest');
            store.restore(value, frames); manifests.set(value.uid, record.manifestId);
            if (Object.values(value.frames).some(id => !frames.has(id))) await erase(value.uid, MESSAGES.missing);
          } catch (_) { await disk.write({}, { studies: [record.manifestId] }); }
        }
        if (mine !== epoch) return;
        const referenced = new Set(store.entries().flatMap(s => [...s.frames.values()].map(f => f.entryId)));
        await disk.write({}, { frames: records.frames.filter(r => r.keyId === keyId && !referenced.has(r.entryId)).map(r => r.entryId) });
        await sweep();
      });
      return store.budget() === null ? MESSAGES.unset : null;
    } catch (error) {
      if (mine !== epoch) return MESSAGES.key;
      if (error.reason === 'ended') { changeSession(null); return MESSAGES.key; }
      key = null; keyId = null; store.setBudget(null);
      await locked(sweep).catch(() => {});
      return error instanceof Stop ? error.reason || MESSAGES.network : MESSAGES.unavailable;
    }
  })().then(reason => {
    if (mine === epoch) { unavailable = reason; broadcast(); }
    // Successful sessions issue once. A failed setup can recover through the existing Retry control.
    if (reason && settings === asked) settings = null;
    return reason;
  });
  settings = asked; return asked;
}
const tag = (item, name) => item?.[name]?.Value?.[0];
function objects(metadata) {
  if (!Array.isArray(metadata)) throw new Stop(MESSAGES.malformed);
  return metadata.flatMap(item => {
    const series = tag(item, '0020000E'), sop = tag(item, '00080018'), frames = Number(tag(item, '00280008') ?? 1);
    return item?.['7FE00010'] && /^[0-9.]{1,64}$/.test(series) && /^[0-9.]{1,64}$/.test(sop) && Number.isInteger(frames) && frames > 0
      ? [{ series, sop, frames }] : [];
  });
}
function framePaths(uid, list) {
  const base = o => `/dicom-web/studies/${uid}/series/${o.series}/instances/${o.sop}/frames/`;
  return { first: list.map(o => base(o) + 1), rest: list.flatMap(o => Array.from({ length: o.frames - 1 }, (_, i) => base(o) + (i + 2))) };
}
async function download(study, mine) {
  const uid = study.uid, bound = session, live = () => mine === epoch && store.get(uid) === study;
  controller = new AbortController(); const signal = controller.signal;
  await idle(); if (!live() || !store.start(uid)) return;
  broadcast();
  const list = objects(await (await get(`/dicom-web/studies/${uid}/metadata`, { Accept: 'application/dicom+json' }, signal, bound)).json());
  if (!live()) return;
  if (!list.length) throw new Stop(MESSAGES.empty);
  const { first, rest } = framePaths(uid, list);
  if (!store.start(uid, first.length + rest.length)) return;
  let firstBytes = 0;
  for (const [index, path] of [...first, ...rest].entries()) {
    await idle(); if (!live() || study.status !== 'Downloading') return;
    const kept = store.frame(path);
    if (kept) { if (index < first.length) firstBytes += kept.bytes * list[index].frames; continue; }
    const response = await get(path, { Accept: FRAME_ACCEPT, 'X-KIN-Preload': 'store' }, signal, bound);
    const revision = response.headers.get('X-KIN-Study-Revision');
    const type = response.headers.get('Content-Type') || '';
    if (!/^application\/gzip\b|^multipart\/related\b/i.test(type)) throw new Stop(MESSAGES.malformed);
    let data;
    try { data = await response.arrayBuffer(); } catch (_) { throw new Stop(signal.aborted ? null : MESSAGES.network); }
    const length = response.headers.get('Content-Length');
    if (!data.byteLength || (length !== null && Number(length) !== data.byteLength)) throw new Stop(MESSAGES.network);
    // Reject unusable multipart headers before persisting a copy the viewer cannot read.
    try { partType(await decoded(data)); } catch (_) { throw new Stop(MESSAGES.malformed); }
    if (!live()) return;
    const result = await locked(async () => {
      if (!live() || !key || study.status !== 'Downloading') return 'gone';
      await sweep(); if (!live() || study.status !== 'Downloading') return 'gone';
      if (!revision || (study.revision !== null && study.revision !== revision)) throw new Stop(MESSAGES.changed);
      const previousFetched = study.fetchedAt, previousExpiry = study.expiresAt;
      const fetched = Date.parse(response.headers.get('Date'));
      store.fetched(uid, Number.isFinite(fetched) ? fetched : now());
      if (study.expiresAt <= now()) { await sweep(); return 'gone'; }
      const entryId = crypto.randomUUID();
      const sealed = await Disk.seal(key, data, Disk.frameAAD(keyId, uid, path, revision, study.copy));
      if (!live() || !key) return 'gone';
      const frame = { entryId, keyId, expiresAt: study.expiresAt, bytes: sealed.ct.byteLength, ...sealed };
      // Include manifest growth in both caps; labels and frame maps also consume disk.
      const oldRevision = study.revision;
      study.frames.set(path, { entryId, bytes: frame.bytes }); study.bytes += frame.bytes; study.revision = revision;
      const manifest = await envelope(uid);
      study.frames.delete(path); study.bytes -= frame.bytes; study.revision = oldRevision;
      const old = (await inventory()).studies.find(r => r.manifestId === manifest.manifestId);
      const extra = frame.bytes + Math.max(0, recordBytes(manifest) - (old ? recordBytes(old) : 0));
      if (study.bytes + frame.bytes + recordBytes(manifest) > store.budget()) throw new Stop(MESSAGES.size);
      if (!await room(extra, uid)) {
        if (!live()) return 'gone';
        const read = study.frames.size + 1;
        if ((study.bytes + frame.bytes) / read * study.total + recordBytes(manifest) > store.budget()) throw new Stop(MESSAGES.size);
        study.fetchedAt = previousFetched; study.expiresAt = previousExpiry;
        study.status = 'Queued'; study.waiting = true; study.reason = MESSAGES.space;
        await persist(uid); return 'full';
      }
      if (!live() || !key || study.status !== 'Downloading') return 'gone';
      try { await disk.write({ frames: [frame], studies: [manifest] }); }
      catch (error) {
        if (error.name !== 'QuotaExceededError') throw error;
        study.fetchedAt = previousFetched; study.expiresAt = previousExpiry;
        study.status = 'Queued'; study.waiting = true; study.reason = MESSAGES.space; return 'full';
      }
      if (!live()) return 'gone';
      const outcome = store.put(uid, path, { entryId, bytes: frame.bytes }, revision);
      if (outcome !== 'stored') await disk.write({}, { frames: [entryId] });
      await inventory(); return outcome;
    });
    if (result === 'full' || result === 'gone') return result;
    if (index < first.length) {
      firstBytes += (data.byteLength + 16) * list[index].frames;
      if (index === first.length - 1 && !store.estimate(uid, firstBytes)) throw new Stop(MESSAGES.size);
    }
    broadcast();
  }
  await locked(async () => { if (live()) { store.ready(uid); await persist(uid); } });
}
async function pump() {
  if (running) return;
  running = true;
  try {
    while (session && key && store.budget() !== null) {
      const study = store.next(); if (!study) return;
      const mine = epoch;
      try { if (await download(study, mine) === 'full') return; }
      catch (error) {
        if (mine !== epoch) continue;
        if (error.reason === 'ended') { changeSession(null); return; }
        await locked(async () => { if (mine === epoch && study.status === 'Downloading') await erase(study.uid, error.reason || MESSAGES.unavailable, true); });
      } finally { if (mine === epoch) controller = null; broadcast(); }
    }
  } finally { running = false; }
}
async function decoded(data) {
  const bytes = new Uint8Array(data);
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return data;
  return new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}
// The unchanged WADO body authenticates both the delimiter and the part's codec/syntax, including after restart.
function partType(bytes) {
  const data = new Uint8Array(bytes);
  let end = 0;
  while (end + 3 < data.length && !(data[end] === 13 && data[end + 1] === 10 && data[end + 2] === 13 && data[end + 3] === 10)) end++;
  if (end + 3 >= data.length) throw new Error('multipart headers');
  const first = new TextDecoder().decode(data.subarray(0, end));
  const boundary = /^(?:\r\n)?--([^\r\n]+)\r\n/.exec(first)?.[1];
  if (!boundary || !/^[0-9A-Za-z'()+_,./:=? -]+$/.test(boundary) || boundary.endsWith(' ')) throw new Error('multipart boundary');
  const types = [...first.replace(/\r\n[ \t]+/g, ' ').matchAll(/^content-type:[ \t]*([^\r\n]+)$/gim)];
  const type = types[0]?.[1].trim();
  if (types.length !== 1 || !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(?:[ \t]*;[^\r\n]*)?$/.test(type || '') || /[\x00-\x08\x0a-\x1f\x7f]/.test(type)) throw new Error('multipart content type');
  const quotedType = type.replace(/["\\]/g, '\\$&');
  const delimiter = /^[\w'+.-]+$/.test(boundary) ? boundary : `"${boundary}"`;
  return `multipart/related; type="${quotedType}"; boundary=${delimiter}`;
}
function release(port) {
  const info = ports.get(port); if (!info) return;
  for (const [uid, count] of info.opens) for (let i = 0; i < count; i++) store.close(uid);
  info.opens.clear(); info.busy = false; settleIdle(); store.wake(); void pump();
}
async function handle(port, message, mine) {
  let info = ports.get(port);
  if (!info) { info = { role: null, busy: false, opens: new Map() }; ports.set(port, info); }
  const reply = value => port.postMessage({ type: 'reply', id: message.id, ...value }, value.bytes ? [value.bytes] : []);
  if (message.type === 'hello') { info.role = message.role === 'viewer' ? 'viewer' : 'list'; broadcast(); return; }
  if (message.type === 'busy') { info.busy = message.busy === true; settleIdle(); return; }
  if (message.type === 'bye') { release(port); ports.delete(port); broadcast(); return; }
  if (message.type === 'session' || message.type === 'add') {
    if (!session || mine !== epoch) return;
    const reason = await prerequisites(); if (mine !== epoch) return;
    await locked(async () => {
      if (mine !== epoch) return;
      if (message.type === 'add') {
        const list = (Array.isArray(message.studies) ? message.studies : []).filter(s => /^[0-9.]{1,64}$/.test(s?.uid));
        const added = store.add(list.map(s => ({ uid: s.uid, label: typeof s.label === 'string' ? s.label.slice(0, 200) : null })));
        for (const uid of added) {
          if (reason) store.fail(uid, reason);
          else if (!await persist(uid)) { store.get(uid).waiting = true; store.get(uid).reason = MESSAGES.space; }
        }
      }
      broadcast();
    });
    void pump(); return;
  }
  if (message.type === 'query' || message.type === 'frame') {
    if (settings) await settings;
    await locked(async () => {
      if (mine !== epoch || !session || message.session !== session || !key || unavailable) { reply(message.type === 'query' ? { held: null } : { bytes: null }); return; }
      try {
        await sweep();
        const uid = message.type === 'query' ? message.uid : Model.studyOfPath(message.path), held = store.held(uid);
        if (message.type === 'query') { reply({ held: held ? { revision: held.revision, copy: held.copy } : null }); return; }
        if (held && held.copy !== message.copy) { reply({ bytes: null, stale: true }); return; }
        const frame = held && store.frame(message.path); if (!frame) { reply({ bytes: null }); return; }
        const record = await disk.get(frame.entryId);
        if (!record) { await disk.list(true); await erase(uid, MESSAGES.missing); reply({ bytes: null }); broadcast(); return; }
        try {
          const bytes = await decoded(await Disk.open(key, record, Disk.frameAAD(keyId, uid, message.path, held.revision, held.copy)));
          if (mine !== epoch || !key || !store.held(uid)) { reply({ bytes: null }); return; }
          reply({ bytes, partType: partType(bytes) });
        } catch (_) { if (mine === epoch) await erase(uid, MESSAGES.corrupt); reply({ bytes: null }); broadcast(); }
      } catch (_) { reply(message.type === 'query' ? { held: null } : { bytes: null }); }
    }); return;
  }
  if (message.type === 'retry' && session && (!key || unavailable)) await prerequisites();
  await locked(async () => {
    if (mine !== epoch) return;
    switch (message.type) {
      case 'retry':
        if (!key || unavailable) { store.fail(message.uid, unavailable || MESSAGES.key); break; }
        if (store.retry(message.uid)) await persist(message.uid);
        break;
      case 'clear':
        controller?.abort();
        for (const s of store.entries()) await erase(s.uid, MESSAGES.cleared);
        break;
      case 'remove': await erase(message.uid, MESSAGES.cleared); store.remove(message.uid); break;
      case 'evict': await erase(message.uid, typeof message.reason === 'string' ? message.reason.slice(0, 200) : MESSAGES.changed); break;
      case 'open':
        if (session && (!message.session || message.session === session)) {
          store.open(message.uid); info.opens.set(message.uid, (info.opens.get(message.uid) || 0) + 1);
        }
        break;
    }
    if (['remove', 'clear', 'evict'].includes(message.type)) store.wake();
    broadcast();
  });
  void pump();
}
setInterval(() => { void locked(async () => { await sweep(); broadcast(); }).then(() => pump()).catch(() => {}); }, 10 * 60 * 1000);
self.onconnect = event => {
  const port = event.ports[0]; ports.set(port, { role: null, busy: false, opens: new Map() });
  port.onmessage = e => {
    const message = e.data;
    if (message?.type === 'session' || message?.type === 'add') {
      const next = typeof message.session === 'string' && message.session ? message.session : null;
      if (next !== session) changeSession(next);
    }
    void handle(port, message, epoch).catch(() => { unavailable = MESSAGES.unavailable; broadcast(); });
  };
  port.start();
};
