/* D1880 memory-only preload, viewer side (design fable-design-preload-memory-20261027 §4.1 item 3, §4.5, §4.6).
 *
 * The viewer's session transport sends every protected request through one fetch (viewer-session.js); this wraps that
 * fetch, under the transport, so a request reaches it only after the transport admitted it for the live session and
 * bound it (`X-KIN-Session`). A WADO-RS frame read of a study the preload worker holds is answered from the worker's
 * memory - but never before the study passed one live read in this document:
 *
 *   · the first frame read of a held study goes to the network as it is, marked `X-KIN-Preload: check`. It passes the
 *     same gate as every frame read (institution, StudyAccess, split UID) and opens the study delivery's 열람 record
 *     (D1877) - so opening a preloaded study is recorded when it is opened - and the server answers the archive's
 *     current revision of the study. Only when that equals the revision the held frames were read under do later frames
 *     come from memory; otherwise the held study is dropped (Evicted) and the viewer stays on the network.
 *   · the worker answers only for the session that filled it; any other session reads from the network.
 *   · anything else - metadata, a frame of a study not held, a frame the worker has not fetched yet, a request with a
 *     query - goes to the network unchanged.
 *
 * While this viewer waits on the network for images or metadata, it tells the worker, which starts no new preload fetch
 * until the viewer's requests are answered (reading comes first, Minhoon P0 item 1).
 */
(function (root) {
  'use strict';
  const WORKER_URL = '/worklist/hpacs-lite/preload-worker.js', WORKER_NAME = 'kin-preload';
  const FRAME = /^\/dicom-web\/studies\/([0-9.]{1,64})\/series\/[0-9.]{1,64}\/instances\/[0-9.]{1,64}\/frames\/[0-9]+$/;
  const MEDIA = /^\/(?:dicom-web|instances)\//;
  const CHANGED = '열 때 확인한 검사 정보가 미리 받을 때와 달라 미리 받은 영상을 버렸습니다.';
  const DENIED = '열 때 검사 접근이 거절되어 미리 받은 영상을 버렸습니다.';

  function attach(win, send) {
    if (typeof win.SharedWorker !== 'function') return send;
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

    // Busy from the request until its answer's headers: a stalled body can never park the preload queue for good.
    async function network(url, init) {
      if (inflight++ === 0) post({ type: 'busy', busy: true });
      try { return await send(url, init); }
      finally { if (--inflight === 0) post({ type: 'busy', busy: false }); }
    }

    /** The study's check, once per document: null when nothing is held, else the live check read's own response. */
    function check(uid, session, url, init) {
      const entry = { state: 'checking', done: null };
      studies.set(uid, entry);
      entry.done = (async () => {
        const { held } = await ask({ type: 'query', uid, session });
        if (!held?.revision) { entry.state = 'live'; return null; }
        const headers = new win.Headers(init.headers);
        headers.set('X-KIN-Preload', 'check');
        let response;
        try { response = await network(url, { ...init, headers }); }
        catch (error) { studies.delete(uid); throw error; }   // cut or failed: the next frame read checks again
        if (response.ok && response.headers.get('X-KIN-Study-Revision') === held.revision) {
          entry.state = 'held';
          opened.add(uid);
          post({ type: 'open', uid });
        } else {
          entry.state = 'live';
          if (response.ok || [403, 404].includes(response.status)) post({ type: 'evict', uid, reason: response.ok ? CHANGED : DENIED });
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
        return response || network(url, init);
      }
      if (entry.state === 'checking') { try { await entry.done; } catch (_) {} }
      if (entry.state === 'held' && !init.signal?.aborted) {
        const { bytes, partType } = await ask({ type: 'frame', path, session });
        if (bytes) return new win.Response(bytes, { status: 200, headers: { 'Content-Type': partType } });
      }
      return network(url, init);
    }

    // A window leaving releases its studies (they may be evicted once no viewer shows them) and its busy mark; a page
    // restored from the back/forward cache shows them again.
    win.addEventListener('pagehide', () => { if (port) post({ type: 'bye' }); });
    win.addEventListener('pageshow', event => {
      if (!event.persisted || !port) return;
      post({ type: 'hello', role: 'viewer' });
      for (const uid of opened) post({ type: 'open', uid });
    });

    return function preloadFetch(url, init = {}) {
      let path = null;
      try {
        const target = new URL(typeof url === 'string' || url instanceof URL ? url : url.url, win.location.href);
        if (target.origin === win.location.origin && !target.search) path = target.pathname;
      } catch (_) {}
      const method = String(init.method || 'GET').toUpperCase();
      const uid = path && method === 'GET' ? FRAME.exec(path)?.[1] : null;
      if (uid && !broken) return frame(uid, path, url, init);
      return path && MEDIA.test(path) && !broken ? network(url, init) : send(url, init);
    };
  }

  const api = Object.freeze({ attach });
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KinViewerPreload = api;
})(typeof window === 'object' ? window : null);
