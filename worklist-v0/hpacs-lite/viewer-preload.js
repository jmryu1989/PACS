/* D1880 memory-only preload, viewer side (design fable-design-preload-memory-20261027 §4.1 item 3, §4.5, §4.6).
 *
 * The viewer's session transport sends every protected request through one fetch (viewer-session.js); this wraps that
 * fetch, under the transport, so a request reaches it only after the transport admitted it for the live session and
 * bound it (`X-KIN-Session`). Every image read this viewer sends to the network is marked `X-KIN-Image-Use: view`: it
 * opens the study for the person, and the server records that opening's 열람 (user-view) apart from the memory preload's
 * own transfer of the study (image-delivery-record.ts DeliveryUse) - a preload that is never opened is never an opening,
 * and an opening right after a preload is still recorded, before its first byte. A WADO-RS frame read of a study the
 * preload worker holds is answered from the worker's memory - but never before the study passed one live read in this
 * document:
 *
 *   · the first frame read of a held study goes to the network as it is, marked `X-KIN-Preload: check`. It passes the
 *     same gate as every frame read (institution, StudyAccess, split UID), records the opening, and the server answers
 *     the archive's current revision of the study. Only when that equals the revision the held copy was read under do
 *     later frames come from memory - from that copy only: the worker refuses a frame of another copy (one fetched again
 *     after Clear All or Retry), and the viewer checks again before it takes any of the new one. Otherwise the held
 *     study is dropped (Evicted) and the viewer stays on the network.
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
  const CHANGED = '열 때 확인한 검사 정보가 미리 받을 때와 달라 미리 받은 영상을 버렸습니다.';
  const DENIED = '열 때 검사 접근이 거절되어 미리 받은 영상을 버렸습니다.';
  // A status whose answer has no body (fetch spec "null body status"): nothing to wait for after its headers.
  const NULL_BODY = [101, 103, 204, 205, 304];

  function attach(win, send) {
    /** The same-origin path of a request without a query, else null. */
    function pathOf(url) {
      try {
        const target = new URL(typeof url === 'string' || url instanceof URL ? url : url.url, win.location.href);
        return target.origin === win.location.origin && !target.search ? target.pathname : null;
      } catch (_) { return null; }
    }
    /** The study of a WADO-RS frame GET, else null. */
    const frameStudy = (path, init) => path && String(init.method || 'GET').toUpperCase() === 'GET' ? FRAME.exec(path)?.[1] ?? null : null;
    function viewed(init, extra = {}) {
      const headers = new win.Headers(init.headers);
      headers.set('X-KIN-Image-Use', 'view');
      for (const [name, value] of Object.entries(extra)) headers.set(name, value);
      return { ...init, headers };
    }

    if (typeof win.SharedWorker !== 'function') {
      return (url, init = {}) => MEDIA.test(pathOf(url) || '') ? send(url, viewed(init)) : send(url, init);
    }
    let port = null, broken = false, nextId = 0, inflight = 0;
    const pending = new Map(), studies = new Map(), opened = new Set();

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

    /** The study's check: null when nothing is held, else the live check read's own response. */
    function check(uid, session, url, init) {
      const entry = { state: 'checking', done: null, copy: null };
      studies.set(uid, entry);
      entry.done = (async () => {
        const { held } = await ask({ type: 'query', uid, session });
        if (!held?.revision) { entry.state = 'live'; return null; }
        let response;
        try { response = await network(url, viewed(init, { 'X-KIN-Preload': 'check' })); }
        catch (error) { studies.delete(uid); throw error; }   // cut or failed: the next frame read checks again
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
      const entry = studies.get(uid);
      if (!entry) {
        const response = await check(uid, session, url, init);
        return response || network(url, viewed(init));
      }
      if (entry.state === 'checking') { try { await entry.done; } catch (_) {} }
      if (entry.state === 'held' && !init.signal?.aborted) {
        const { bytes, partType, stale } = await ask({ type: 'frame', path, session, copy: entry.copy });
        if (bytes) return new win.Response(bytes, { status: 200, headers: { 'Content-Type': partType } });
        // The worker now holds another copy of the study than the one checked: none of it before a check of its own.
        if (stale && studies.get(uid) === entry) studies.delete(uid);
      }
      return network(url, viewed(init));
    }

    // A window leaving releases its studies (they may be evicted once no viewer shows them) and its busy mark; a page
    // restored from the back/forward cache shows them again.
    win.addEventListener('pagehide', () => { if (port) post({ type: 'bye' }); });
    win.addEventListener('pageshow', event => {
      if (!event.persisted || !port) return;
      post({ type: 'hello', role: 'viewer' });
      for (const uid of opened) post({ type: 'open', uid });
      if (inflight > 0) post({ type: 'busy', busy: true });
    });

    return function preloadFetch(url, init = {}) {
      const path = pathOf(url), uid = frameStudy(path, init);
      if (uid && !broken) return frame(uid, path, url, init);
      if (!path || !MEDIA.test(path)) return send(url, init);
      return broken ? send(url, viewed(init)) : network(url, viewed(init));
    };
  }

  const api = Object.freeze({ attach });
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KinViewerPreload = api;
})(typeof window === 'object' ? window : null);
