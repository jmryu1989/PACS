/* D1880 memory-only preload, viewer side (design fable-design-preload-memory-20261027 §4.1 item 3, §4.5, §4.6), and the
 * viewer's openings of a study (opening contract consult-preload-opening-contract-20261029).
 *
 * The viewer's session transport sends every protected request through one fetch (viewer-session.js); this wraps that
 * fetch, under the transport, so a request reaches it only after the transport admitted it for the live session and
 * bound it (`X-KIN-Session`).
 *
 * Openings. Every image read this viewer sends names the opening it belongs to (`X-KIN-View-Opening`), and the server
 * records the first read of each opening of a study as that opening's 열람 (user-view), durable before its first byte
 * (image-delivery-record.ts). An opening is an entry into a study, known only to this document's memory:
 *   · this document - a new window or tab, a reload, a typed URL - is a new opening of every study it shows;
 *   · a patient tab showing studies again (`reenter`, viewer-patient-tabs.js) and a return to this page from the
 *     browser's back/forward cache are new openings of the studies they show. Pixels this document still holds from an
 *     earlier visit - the image cache, the page the browser kept - could show without any read, so each such study is
 *     read live for the new opening first, and only then is the scope shown;
 *   · focus, scrolling, cine, a layout change, a repeated or retried read, the server closing an idle delivery and a
 *     preload are none: they keep the opening, and a preload has none at all. A read of a study shown before the scope
 *     changed keeps that study's opening.
 *
 * Preload memory. A WADO-RS frame read of a study the preload worker holds is answered from the worker's memory - but
 * never before the study passed one live read for its current opening:
 *   · the first frame read of a held study goes to the network as it is, marked `X-KIN-Preload: check`. It passes the
 *     same gate as every frame read (institution, StudyAccess, split UID), records the opening, and the server answers
 *     the archive's current revision of the study. Only when that equals the revision the held copy was read under do
 *     later frames come from memory - from that copy only: the worker refuses a frame of another copy (one fetched again
 *     after Clear All or Retry), and the viewer checks again before it takes any of the new one. Otherwise the held
 *     study is dropped (Evicted) and the viewer stays on the network. A new opening of the study checks again.
 *   · the worker answers only for the session that filled it; any other session reads from the network.
 *   · anything else - metadata, a frame of a study not held, a frame the worker has not fetched yet, a request with a
 *     query - goes to the network unchanged.
 *
 * While this viewer reads images or metadata from the network - until the answer's body has ended, not only its
 * headers - it tells the worker, which starts no new preload fetch meanwhile (reading comes first, Minhoon P0 item 1).
 */
(function (root) {
  'use strict';
  const WORKER_URL = '/worklist/hpacs-lite/preload-worker.js', WORKER_NAME = 'kin-preload';
  const FRAME = /^\/dicom-web\/studies\/([0-9.]{1,64})\/series\/[0-9.]{1,64}\/instances\/[0-9.]{1,64}\/frames\/[0-9]+$/;
  const MEDIA = /^\/(?:dicom-web|instances)\//;
  const STUDY = /^\/dicom-web\/studies\/([0-9.]{1,64})(?:\/|$)/;
  const OPENING = 'X-KIN-View-Opening';
  const CHANGED = '열 때 확인한 검사 정보가 미리 받을 때와 달라 미리 받은 영상을 버렸습니다.';
  const DENIED = '열 때 검사 접근이 거절되어 미리 받은 영상을 버렸습니다.';
  const UNRECORDED = '영상 열람 기록을 저장하지 못해 영상을 다시 표시하지 않았습니다. 연결을 확인한 뒤 다시 시도하세요.';
  // A status whose answer has no body (fetch spec "null body status"): nothing to wait for after its headers.
  const NULL_BODY = [101, 103, 204, 205, 304];

  function attach(win, send) {
    /** The same-origin URL of a request, else null. */
    function target(url) {
      try {
        const parsed = new URL(typeof url === 'string' || url instanceof URL ? url : url.url, win.location.href);
        return parsed.origin === win.location.origin ? parsed : null;
      } catch (_) { return null; }
    }
    /** The study of a WADO-RS frame GET without a query - the reads the worker can answer - else null. */
    const frameStudy = (url, init) => url && !url.search && String(init.method || 'GET').toUpperCase() === 'GET'
      ? FRAME.exec(url.pathname)?.[1] ?? null : null;
    /** The study a DICOMweb read names, whatever its form; an `/instances/` read names none here (the server knows it). */
    const studyOf = url => STUDY.exec(url.pathname)?.[1] ?? null;

    // The opening of the scope shown now, and each study's opening once this document read it: a study keeps its
    // opening when the scope moves on, so its late reads never open it again under the next scope's opening.
    let scopeOpening = win.crypto.randomUUID();
    const openings = new Map(), lastRead = new Map(), checks = new Map();
    function openingOf(uid) {
      if (!uid) return scopeOpening;
      if (!openings.has(uid)) openings.set(uid, scopeOpening);
      return openings.get(uid);
    }
    function viewed(init, uid, extra = {}) {
      const headers = new win.Headers(init.headers);
      if (!headers.has(OPENING)) headers.set(OPENING, openingOf(uid));
      for (const [name, value] of Object.entries(extra)) headers.set(name, value);
      return { ...init, headers };
    }
    function remember(uid, url, init) {
      if (uid) lastRead.set(uid, { url: String(typeof url === 'string' || url instanceof URL ? url : url.url),
        accept: new win.Headers(init.headers).get('Accept') });
    }

    /**
     * A new opening of `uids`. Each of them this document has shown before is read live for it first - its 열람 is then
     * recorded before the pixels this document still holds can show again; a study never shown here has no such pixels,
     * and its own first read records it. The opening is taken by `commit()` when the scope is shown; an entry abandoned
     * before that leaves every opening as it was. Null when an opening could not be recorded: the scope is not shown.
     */
    async function reenter(uids, signal) {
      const next = win.crypto.randomUUID(), wanted = [...new Set(uids)];
      for (const uid of wanted) {
        const read = lastRead.get(uid);
        if (!read) continue;
        try {
          const headers = { [OPENING]: next, ...(read.accept ? { Accept: read.accept } : {}) };
          const response = await win.fetch(read.url, { headers, signal });
          await response.arrayBuffer();
          if (!response.ok) return null;
        } catch (_) { return null; }
      }
      return { commit() {
        // The next frame read of a held study checks the copy again, for this opening.
        for (const uid of wanted) { openings.set(uid, next); checks.delete(uid); }
        scopeOpening = next;
      } };
    }

    // A return from the back/forward cache is a new opening of the studies the page shows: what the browser kept stays
    // hidden from the moment the page is left until the return's opening is recorded. A plain visibility change is not
    // a return and keeps the opening.
    let notice = null;
    const page = () => win.document?.documentElement ?? null;
    function scope() {
      try { return (new URL(win.location.href).searchParams.get('StudyInstanceUIDs') || '').split(',').filter(Boolean); }
      catch (_) { return []; }
    }
    async function returned() {
      notice?.remove(); notice = null;
      const entry = await reenter(scope());
      if (entry) { entry.commit(); if (page()) page().style.visibility = ''; return; }
      const doc = win.document;
      notice = doc.createElement('section'); notice.setAttribute('role', 'alert');
      notice.style.cssText = 'visibility:visible;position:fixed;inset:30% 20% auto;z-index:10000;background:#18212b;color:white;padding:24px';
      const text = doc.createElement('p'); text.textContent = UNRECORDED;
      const retry = doc.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry';
      retry.onclick = () => { void returned(); };
      notice.append(text, retry); doc.body.append(notice);
    }
    win.addEventListener('pagehide', event => { if (event?.persisted && page()) page().style.visibility = 'hidden'; });
    win.addEventListener('pageshow', event => { if (event?.persisted) void returned(); });

    let read;
    if (typeof win.SharedWorker !== 'function') {
      read = (url, init) => {
        const parsed = target(url);
        if (!parsed || !MEDIA.test(parsed.pathname)) return send(url, init);
        remember(frameStudy(parsed, init), url, init);
        return send(url, viewed(init, studyOf(parsed)));
      };
    } else read = withWorker(win, send, { target, frameStudy, studyOf, viewed, remember, checks });

    function preloadFetch(url, init = {}) { return read(url, init); }
    preloadFetch.reenter = reenter;
    return preloadFetch;
  }

  /** The preload worker's memory under the viewer's reads (see the head of this file). */
  function withWorker(win, send, { target, frameStudy, studyOf, viewed, remember, checks }) {
    let port = null, broken = false, nextId = 0, inflight = 0;
    const pending = new Map(), opened = new Set();

    function connect() {
      if (port || broken) return port;
      try {
        const worker = new win.SharedWorker(WORKER_URL, { name: WORKER_NAME });
        port = worker.port;
        port.onmessage = event => {
          const message = event.data;
          if (message?.type !== 'reply' || !pending.has(message.id)) return;
          const resolve = pending.get(message.id); pending.delete(message.id); resolve(message);
        };
        worker.onerror = () => {
          broken = true; port = null;
          for (const resolve of pending.values()) resolve({});
          pending.clear();
        };
        port.start();
        port.postMessage({ type: 'hello', role: 'viewer' });
      } catch (_) { broken = true; port = null; }
      return port;
    }
    const post = message => { try { connect()?.postMessage(message); } catch (_) {} };
    function ask(message) {
      const target = connect();
      if (!target) return Promise.resolve({});
      return new Promise(resolve => { const id = ++nextId; pending.set(id, resolve); target.postMessage({ ...message, id }); });
    }

    function done() { if (--inflight === 0) post({ type: 'busy', busy: false }); }
    /**
     * A network read, busy from the request until its body has ended, failed or been cancelled. The body is passed on
     * as it arrives (not buffered). A failure answer is released at its headers: the viewer may never read its body.
     */
    async function network(url, init) {
      if (inflight++ === 0) post({ type: 'busy', busy: true });
      let response;
      try { response = await send(url, init); }
      catch (error) { done(); throw error; }
      if (!response.ok || !response.body || NULL_BODY.includes(response.status)) { done(); return response; }
      const reader = response.body.getReader();
      let open = true;
      const end = () => { if (open) { open = false; done(); } };
      const body = new win.ReadableStream({
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) { end(); controller.close(); } else controller.enqueue(chunk.value);
          } catch (error) { end(); controller.error(error); }
        },
        cancel(reason) { end(); return reader.cancel(reason); },
      });
      return new win.Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    }

    /** The study's check for its current opening: null when nothing is held, else the live check read's own response. */
    function check(uid, session, url, init) {
      const entry = { state: 'checking', done: null, copy: null };
      checks.set(uid, entry);
      entry.done = (async () => {
        const { held } = await ask({ type: 'query', uid, session });
        if (!held?.revision) { entry.state = 'live'; return null; }
        let response;
        try { response = await network(url, viewed(init, uid, { 'X-KIN-Preload': 'check' })); }
        catch (error) { if (checks.get(uid) === entry) checks.delete(uid); throw error; }   // cut or failed: the next frame read checks again
        const now = response.headers.get('X-KIN-Study-Revision');
        if (response.ok && now === held.revision) {
          entry.state = 'held'; entry.copy = held.copy;
          if (!opened.has(uid)) { opened.add(uid); post({ type: 'open', uid }); }
        } else {
          // No revision answered (the archive could not say) proves nothing either way: live now, the held copy stays.
          entry.state = 'live';
          if (response.ok && now) post({ type: 'evict', uid, reason: CHANGED });
          else if ([403, 404].includes(response.status)) post({ type: 'evict', uid, reason: DENIED });
        }
        return response;
      })();
      return entry.done;
    }

    async function frame(uid, path, url, init) {
      const session = new win.Headers(init.headers).get('X-KIN-Session');
      const entry = checks.get(uid);
      if (!entry) {
        const response = await check(uid, session, url, init);
        return response || network(url, viewed(init, uid));
      }
      if (entry.state === 'checking') { try { await entry.done; } catch (_) {} }
      if (entry.state === 'held' && !init.signal?.aborted) {
        const { bytes, partType, stale } = await ask({ type: 'frame', path, session, copy: entry.copy });
        if (bytes) return new win.Response(bytes, { status: 200, headers: { 'Content-Type': partType } });
        // The worker now holds another copy of the study than the one checked: none of it before a check of its own.
        if (stale && checks.get(uid) === entry) checks.delete(uid);
      }
      return network(url, viewed(init, uid));
    }

    // A window leaving releases its studies (they may be evicted once no viewer shows them) and its busy mark; a page
    // restored from the back/forward cache shows them again.
    win.addEventListener('pagehide', () => { if (port) post({ type: 'bye' }); });
    win.addEventListener('pageshow', event => {
      if (!event?.persisted || !port) return;
      post({ type: 'hello', role: 'viewer' });
      for (const uid of opened) post({ type: 'open', uid });
      if (inflight > 0) post({ type: 'busy', busy: true });
    });

    return function (url, init) {
      const parsed = target(url);
      if (!parsed || !MEDIA.test(parsed.pathname)) return send(url, init);
      // A new opening's own live read (`reenter`) names its opening already: never from memory, never a check.
      if (new win.Headers(init.headers).has(OPENING)) return broken ? send(url, init) : network(url, init);
      const uid = frameStudy(parsed, init);
      remember(uid, url, init);
      if (uid && !broken) return frame(uid, parsed.pathname, url, init);
      return broken ? send(url, viewed(init, studyOf(parsed))) : network(url, viewed(init, studyOf(parsed)));
    };
  }

  const api = Object.freeze({ attach });
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KinViewerPreload = api;
})(typeof window === 'object' ? window : null);
