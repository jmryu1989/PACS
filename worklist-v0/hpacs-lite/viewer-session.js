/* U5S-REQ-04/08/12. One session authority for an OHIF document without auth.js.
 * A history entry retains only its binding, never patient data or credentials. Reloading that
 * entry cannot adopt the opener's later login. The server still authorizes every bound request.
 */
(function (root) {
  'use strict';
  const RECORD = 'kinViewerSession';
  const closed = state => !['active', 'preparing'].includes(state);

  function connect(win, expectedSession = null) {
    if (win.KinViewerSessionBoundary) return win.KinViewerSessionBoundary;
    const gate = win.KinWorkContext;
    const originalFetch = win.fetch.bind(win);
    const nativeTimeout = win.setTimeout.bind(win), nativeInterval = win.setInterval.bind(win);
    const nativeReplaceState = win.history.replaceState.bind(win.history);
    const nativePushState = win.history.pushState.bind(win.history);
    const clearTimeout = win.clearTimeout.bind(win), clearInterval = win.clearInterval.bind(win);
    const nativeFrame = win.requestAnimationFrame?.bind(win), cancelFrame = win.cancelAnimationFrame?.bind(win);
    const timers = new Map(), intervals = new Map(), frames = new Map(), deferred = new Set(), workers = new Set();
    let announce, preparation = null, preparingId = null, peerPreparation = null, lockWatch = null, ended = false, cleaning = false;
    const locks = win.navigator?.locks;
    let peer = null, record = null;
    const enders = new Set(), changes = new Set();
    try { peer = win.opener || (win.parent !== win ? win.parent : null); } catch (_) {}
    try { record = win.history.state?.[RECORD] || null; } catch (_) { record = {}; }
    let peerGate = null;
    try { peerGate = peer?.KinWorkContext || null; } catch (_) {}
    const validRecord = record && typeof record.session === 'string' && record.session.length > 0 && typeof record.ended === 'boolean';
    const unresolved = record?.unresolved === true && record.ended === false;
    const expected = unresolved ? record.expected : !record ? expectedSession : null;
    let entryStopped = unresolved && record.entryStopped === true;
    let session = validRecord ? record.session : record ? null : peerGate?.session() || null;
    const needsBootstrap = unresolved || !record && !peerGate && !session;
    const heard = new Map();
    const initialEnd = record?.ended === true || !session && !needsBootstrap ||
      (peerGate?.session() === session && closed(peerGate.state()));
    const entryRecord = ending => ({ session, ended: ending, unresolved: !session && needsBootstrap && !ending,
      expected: expected || null, entryStopped });
    const remember = ending => {
      try { nativeReplaceState({ ...win.history.state, [RECORD]: entryRecord(ending) }, ''); return true; }
      catch (_) { return false; }
    };
    gate.follow({ onLifecycle(listener) {
      announce = listener;
      // Even a retained/opener binding must observe the ordered end marker before work.
      listener({ state: 'unknown', session });
    } });
    if (session) remember(initialEnd);
    // Router state changes must not erase this history entry's original session before a reload.
    for (const [name, native] of [['replaceState', nativeReplaceState], ['pushState', nativePushState]])
      win.history[name] = (state, title, url) => native({ ...state, [RECORD]: entryRecord(ended || initialEnd) }, title, url);

    function end() {
      if (ended) return;
      ended = true;
      cleaning = true;
      remember(true);
      announce({ state: 'ending', session });
      lockWatch?.controller.abort(); lockWatch = null;
      for (const timer of timers.keys()) clearTimeout(timer);
      for (const timer of intervals.keys()) clearInterval(timer);
      for (const frame of frames.keys()) cancelFrame(frame);
      for (const worker of workers) worker.terminate();
      timers.clear(); intervals.clear(); frames.clear(); workers.clear(); deferred.clear();
      // Retire producers and their owned state before removing the rendering surface.
      for (const run of [...enders]) { try { run(); } catch (_) {} }
      enders.clear();
      for (const run of [...changes]) { try { run(gate.state()); } catch (_) {} }
      cleaning = false;
      channel?.close();
      clearInterval(poll);
    }
    function authFailure(failure) {
      if (failure.session !== session) return;
      if (failure.status === 401 && failure.code === 'AUTH_SESSION_ENDED' ||
          [403, 409].includes(failure.status) && failure.code === 'AUTH_SESSION_MISMATCH') end();
    }
    const transport = win.KinSessionTransport.page({ fetch: originalFetch, authFailure });
    // S7-U5 session end: auth.js keeps the end record of each session under that session's own key
    // (`kin-session-end:<session>`, or the cookie `kin-session-end.<session>` when localStorage takes no write).
    // One reader for both copies, the later of the two as auth.js reads them. A viewer ends on the record of ITS OWN
    // session only; `leaving` (Log Out pressed, not ended - Back to Editing removes it) is not an end. A record from
    // before the per-session keys (one key, no origin) still ends the session it names.
    const END = 'kin-session-end', ENDED = ['ending', 'unconfirmed', 'confirmed'];
    const cookieEnds = () => win.document.cookie.split(';').map(part => part.trim()).filter(part => part.startsWith(END))
      .map(part => [part.slice(0, part.indexOf('=')), part.slice(part.indexOf('=') + 1)]);
    function ownEnd(id) {
      if (!id) return false;
      const cookies = new Map(cookieEnds());
      const cookie = name => cookies.has(name) ? decodeURIComponent(cookies.get(name)) : null;
      try {
        if (JSON.parse(win.localStorage.getItem(END) ?? cookie(END))?.session === id) return true;
      } catch (_) { /* An unreadable record is not evidence of an end. */ }
      const rank = status => status === 'leaving' ? 0 : status === 'ending' ? 1 : 2;
      let latest = null;
      for (const text of [win.localStorage.getItem(END + ':' + id), cookie(END + '.' + id)]) {
        let record = null;
        try { record = JSON.parse(text); } catch (_) { /* An unreadable copy is not evidence of an end. */ }
        if (!record || record.session !== id || !Number.isFinite(record.operation)) continue;
        if (!latest || record.operation > latest.operation ||
            record.operation === latest.operation && rank(record.status) > rank(latest.status)) latest = record;
      }
      return !!latest && ENDED.includes(latest.status);
    }
    // The strict rule of a window nobody handed a session (a typed URL): any end record of any session, in either copy.
    function anyEnd() {
      const ends = text => { try { return JSON.parse(text)?.status !== 'leaving'; } catch (_) { return true; } };
      const storage = win.localStorage;
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index);
        if (key === END || key?.startsWith(END + ':') && ends(storage.getItem(key))) return true;
      }
      return cookieEnds().some(([name, value]) => name === END || name.startsWith(END + '.') && ends(decodeURIComponent(value)));
    }
    async function mayStartWork(id = session) {
      if (ended) return false;
      try {
        if (ownEnd(id)) { end(); return false; }
      } catch (_) { /* An unreadable record is not evidence of an end. */ }
      if (!locks) return true;
      try {
        const snapshot = await locks.query();
        // Notices and lock grants use different browser queues. Main acquires this marker
        // before declaring an end, so a released preparation cannot be mistaken for cancel.
        if ([...snapshot.held, ...snapshot.pending].some(lock => lock.name === 'kin-session-ended:' + id)) end();
        return !ended;
      } catch (_) { return false; } // An unreadable snapshot is not permission to resume.
    }
    function preparingPeer(id) {
      try {
        const source = peer && !peer.closed ? peer.KinWorkContext : null;
        return source?.session() === session && source.state() === 'preparing' && source.preparation()?.preparation === id;
      } catch (_) { return false; }
    }
    function watchPreparation(id) {
      const watch = { controller: new win.AbortController(), released: false, unavailable: !locks,
        sawPeer: preparingPeer(id) };
      lockWatch = watch;
      if (!locks) return;
      // Main holds this exclusive lock BEFORE announcing preparation. A shared waiter is
      // notified by the browser on release, independently of either document's timers.
      locks.request('kin-preparation:' + id, { mode: 'shared', signal: watch.controller.signal }, () => {
        if (lockWatch !== watch || ended) return;
        watch.released = true;
        // The opener may have ended before its notice reaches this document. Read that
        // state before releasing any deferred work at the lock boundary.
        syncPeer();
      }).catch(() => { if (lockWatch === watch) watch.unavailable = true; });
    }
    function pause(id, watch = true) {
      if (ended || id === null || id === undefined || closed(gate.state())) return;
      if (preparation) return;
      preparingId = id;
      preparation = gate.prepare({ preparationId: id });
      if (watch) watchPreparation(id);
      for (const run of [...changes]) { try { run('preparing'); } catch (_) {} }
    }
    async function resume(id) {
      if (ended || !preparation || id !== preparingId) return;
      const paused = preparation;
      if (!await mayStartWork() || preparation !== paused || id !== preparingId) return;
      lockWatch?.controller.abort(); lockWatch = null;
      gate.cancelPreparation(preparation);
      preparation = null; preparingId = null;
      for (const run of [...changes]) { try { run('active'); } catch (_) {} }
      for (const run of [...deferred]) { deferred.delete(run); if (!ended) run(); }
    }
    function notice(data) {
      if (gate.state() === 'unknown' && data?.session) {
        if (data.type === 'session-ended' && (!expected || data.session === expected)) {
          entryStopped = true; remember(false);
        }
        const previous = heard.get(data.session);
        if (previous?.type === 'session-ended') return;
        if (data.type === 'session-ended' || data.type === 'session-preparing') heard.set(data.session, data);
        else if (data.type === 'session-resumed' && previous?.type === 'session-preparing' && previous.preparation === data.preparation)
          heard.delete(data.session);
      }
      if (!session || !data || data.session !== session) return;
      if (data.type === 'session-ended') end();
      else if (data.type === 'session-preparing') pause(data.preparation);
      else if (data.type === 'session-resumed') resume(data.preparation);
    }
    function syncPeer() {
      try {
        const source = peer && !peer.closed ? peer.KinWorkContext : null;
        if (source && source.session() === session && closed(source.state())) { end(); return; }
        if (gate.state() === 'unknown') return;
        if (source?.session() === session && source.state() === 'preparing') {
          const id = source.preparation()?.preparation;
          if (id !== peerPreparation) { peerPreparation = id; pause(id); }
        } else peerPreparation = null;
      } catch (_) { /* A closed opener is not evidence that this session ended. */ }
      if (!lockWatch) return;
      if (preparingPeer(preparingId)) lockWatch.sawPeer = true;
      else if (lockWatch.released || lockWatch.unavailable && lockWatch.sawPeer) resume(preparingId);
      // Without Web Locks and without a readable preparer, only a matching resume notice
      // can safely unpause. Silence is not evidence of cancellation.
    }
    let channel = null;
    try { channel = new win.BroadcastChannel('kin-session'); channel.onmessage = event => notice(event.data); } catch (_) {}
    // A storage notice must retire even a viewer with no mounted extension or active request.
    win.addEventListener('storage', event => {
      if (event.key !== null && event.key !== END && event.key !== END + ':' + session) return;
      try { if (session && ownEnd(session)) end(); }
      catch (_) { /* An unreadable record is not evidence of an end. */ }
    });
    // Polling also repairs missed preparation notifications. A different peer session is never adopted.
    const poll = nativeInterval(syncPeer, 250);
    syncPeer();
    // Keep already admitted work suspended at its delivery boundary. A preparation preserves the
    // document and forbids edits; its valid incoming data can be delivered when that pause ends.
    // At a real end the owner releases resources, and none of these continuations is delivered.
    function deliver(run) {
      if (ended) return;
      if (gate.state() === 'active') run();
      else if (gate.state() === 'preparing' || gate.state() === 'unknown') deferred.add(run);
    }
    function wait(value, release) {
      return new Promise((resolve, reject) => Promise.resolve(value).then(
        result => {
          if (ended) { release?.(result); return; }
          const dispose = () => release?.(result);
          if (release) enders.add(dispose);
          deliver(() => { enders.delete(dispose); resolve(result); });
        }, error => deliver(() => reject(error))));
    }
    // Native decoders may finish after their network request. Guard delivery here, before any
    // caller can paint, update its model or touch the opener; release an undelivered bitmap.
    if (win.createImageBitmap) {
      const decode = win.createImageBitmap.bind(win);
      win.createImageBitmap = (...args) => wait(decode(...args), bitmap => bitmap.close());
    }
    if (win.HTMLImageElement?.prototype.decode) {
      const decode = win.HTMLImageElement.prototype.decode;
      win.HTMLImageElement.prototype.decode = function (...args) { return wait(decode.apply(this, args)); };
    }
    win.setTimeout = (run, ms, ...args) => {
      if (typeof run !== 'function') throw new TypeError('Viewer timers require a function');
      const tick = () => { timers.delete(id); run(...args); };
      const id = nativeTimeout(() => deliver(tick), ms);
      timers.set(id, tick); return id;
    };
    win.clearTimeout = id => { deferred.delete(timers.get(id)); timers.delete(id); clearTimeout(id); };
    win.setInterval = (run, ms, ...args) => {
      if (typeof run !== 'function') throw new TypeError('Viewer timers require a function');
      // Coalesce a repeating observation while paused; it reads the current state after resume.
      const tick = () => run(...args);
      const id = nativeInterval(() => deliver(tick), ms); intervals.set(id, tick); return id;
    };
    win.clearInterval = id => { deferred.delete(intervals.get(id)); intervals.delete(id); clearInterval(id); };
    if (nativeFrame) win.requestAnimationFrame = run => {
      let tick;
      const id = nativeFrame(time => { tick = () => { frames.delete(id); run(time); }; frames.set(id, tick); deliver(tick); });
      frames.set(id, null); return id;
    };
    if (cancelFrame) win.cancelAnimationFrame = id => { deferred.delete(frames.get(id)); frames.delete(id); cancelFrame(id); };
    if (win.Worker) {
      const NativeWorker = win.Worker;
      win.Worker = class extends NativeWorker {
        constructor(...args) {
          super(...args); workers.add(this);
          this.addEventListener('message', event => {
            if (gate.state() === 'active') return;
            event.stopImmediatePropagation();
            deliver(() => this.dispatchEvent(new win.MessageEvent('message', { data: event.data })));
          });
        }
        terminate() { workers.delete(this); super.terminate(); }
      };
    }
    const input = event => {
      if (gate.state() === 'active') return;
      if (!ended && entryNotice?.contains(event.target)) return;
      event.preventDefault(); event.stopImmediatePropagation();
    };
    for (const type of ['pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'click', 'dblclick',
      'keydown', 'keyup', 'beforeinput', 'input', 'change', 'wheel', 'touchstart', 'touchmove', 'drop', 'paste'])
      win.addEventListener(type, input, true);
    win.addEventListener('pageshow', async event => {
      if (!event.persisted) return;
      if (gate.state() === 'active') {
        // Preserve the already-adopted identity while checking a restored document.
        const id = win.crypto.randomUUID();
        pause(id, false);
        await resume(id);
      }
      syncPeer();
      if (gate.state() === 'active') {
        // A restored document retains its layout. The bound probe repairs a missed end notice;
        // an ordinary failure is local and has no authority to close or rebuild the document.
        transport.request('/api/me', { context: gate.capture('document') }).catch(() => {});
      }
    });
    win.addEventListener('beforeunload', event => { if (ended) event.stopImmediatePropagation(); }, true);
    const protectedUrl = value => {
      try {
        const url = new URL(typeof value === 'string' || value instanceof URL ? value : value.url, win.location.href);
        return url.origin === win.location.origin && /^\/(api(?:\/|$)|dicom-web(?:\/|$)|instances(?:\/|$)|statistics(?:\/|$)|system(?:\/|$))/.test(url.pathname);
      } catch (_) { return false; }
    };
    async function responseFor(response) {
      if (!response.body) return response;
      const reader = response.body.getReader();
      const body = new win.ReadableStream({
        async pull(controller) {
          try {
            const chunk = await wait(reader.read());
            if (chunk.done) controller.close(); else controller.enqueue(chunk.value);
          } catch (error) { controller.error(error); }
        },
        cancel(reason) { return reader.cancel(reason); },
      });
      return new win.Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    win.fetch = (url, init = {}) => {
      if (!protectedUrl(url)) return originalFetch(url, init);
      // Capture before a Request body's asynchronous read as well as before headers leave.
      const context = gate.capture('document');
      if (typeof win.Request === 'function' && url instanceof win.Request) {
        const request = url;
        return wait((async () => transport.fetch(request.url, {
          method: request.method, headers: Object.fromEntries(request.headers), signal: request.signal,
          cache: request.cache, credentials: request.credentials, mode: request.mode, redirect: request.redirect,
          referrer: request.referrer, referrerPolicy: request.referrerPolicy, integrity: request.integrity,
          keepalive: request.keepalive,
          ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body: await request.arrayBuffer() }),
          ...init, context, abortWhenStale: false,
        }))()).then(responseFor);
      }
      if (!gate.admits(context)) return transport.fetch(url, { ...init, context });
      return wait(transport.fetch(url, { ...init, headers: Object.fromEntries(new win.Headers(init.headers)), context,
        abortWhenStale: false })).then(responseFor);
    };
    const guarded = new WeakMap();
    // A list-opened noopener verifies the handed-over session. Only a typed URL without
    // an expected id can bootstrap an identity, and never after hearing an unresolved end.
    function entryAllowed() {
      // A handed-over window (expected session) is stopped by that session's own end only - its record or end lock
      // (mayStartWork), its notice, or /api/me answering another id (bootstrap). Another session's record, a `leaving`
      // marker and a storage that takes no write say nothing about the handed session: they do not end the window.
      if (expected) return true;
      try {
        const storage = win.localStorage, key = 'kin-viewer-entry-probe', value = win.crypto.randomUUID().padEnd(160, '.');
        storage.setItem(key, value);
        const reliable = storage.getItem(key) === value;
        storage.removeItem(key);
        return reliable && storage.getItem(key) === null && !anyEnd();
      } catch (_) { return false; }
    }
    let entryNotice = null;
    function entryMessage(message, retry) {
      entryNotice?.remove();
      entryNotice = win.document.createElement('section'); entryNotice.setAttribute('role', 'alert');
      entryNotice.style.cssText = 'position:fixed;inset:30% 20% auto;z-index:10000;background:#18212b;color:white;padding:24px';
      const text = win.document.createElement('p'); text.textContent = message; entryNotice.append(text);
      if (retry) {
        const button = win.document.createElement('button'); button.textContent = 'Retry';
        button.onclick = () => { entryNotice.remove(); entryNotice = null; retry(); }; entryNotice.append(button);
      }
      win.document.body.append(entryNotice);
    }
    function reopenFromList() {
      entryStopped = true; remember(false);
      entryMessage('이 창을 연 세션을 확인할 수 없습니다. 목록에서 뷰어를 다시 열어 주세요.');
      return new Promise(() => {});
    }
    async function activate() {
      if (!await mayStartWork()) return;
      announce({ state: 'active', session });
      syncPeer();
      notice(heard.get(session));
      if (gate.state() === 'active') for (const run of [...deferred]) { deferred.delete(run); if (!ended) run(); }
    }
    async function bootstrap() {
      if (!needsBootstrap) return activate();
      if (!remember(false)) { end(); return; }
      if (entryStopped) return reopenFromList();
      if (!entryAllowed()) { end(); return; }
      for (;;) {
        for (const delay of [0, 1000, 2000]) {
          if (delay) await new Promise(resolve => nativeTimeout(resolve, delay));
          if (ended) return;
          if (entryStopped) return reopenFromList();
          if (!entryAllowed()) { end(); return; }
          if (expected && !await mayStartWork(expected)) return;
          const controller = new win.AbortController();
          const deadline = nativeTimeout(() => controller.abort(), 10000);
          try {
            const response = await originalFetch('/api/me', { credentials: 'same-origin', cache: 'no-store',
              headers: { 'X-KIN-CSRF': '1' }, signal: controller.signal });
            let me = null;
            try { me = await response.json(); } catch (_) {}
            const code = response.headers.get('X-KIN-Auth-Code') || me?.code;
            if (!ended && entryStopped) return reopenFromList();
            if (ended || !entryAllowed() ||
                response.status === 401 && ['AUTH_CREDENTIALS_MISSING', 'AUTH_SESSION_ENDED'].includes(code) ||
                response.status === 403 && ['INSTITUTION_PENDING', 'INSTITUTION_INVALID'].includes(code)) { end(); return; }
            if (!response.ok || typeof me?.sessionId !== 'string' || !me.sessionId) continue;
            if (entryStopped || expected && me.sessionId !== expected) return reopenFromList();
            session = me.sessionId;
            if (!remember(false)) { end(); return; }
            await activate();
            return;
          } catch (_) { /* Offline, timeout and a malformed reply leave entry unknown. */ }
          finally { clearTimeout(deadline); }
        }
        if (ended) return;
        await new Promise(resolve => entryMessage('세션을 확인하지 못했습니다. 연결을 확인한 뒤 다시 시도하세요.', resolve));
      }
    }
    const api = Object.freeze({
      gate, transport, wait, ready: Promise.resolve().then(bootstrap), session: () => session,
      active: () => gate.state() === 'active',
      ended: () => ended,
      guardMethods(target, names) {
        if (!guarded.has(target)) guarded.set(target, new Set());
        for (const name of names) {
          if (guarded.get(target).has(name)) continue;
          const original = target[name];
          if (typeof original !== 'function') throw new TypeError('Missing viewer operation: ' + name);
          target[name] = function (...args) {
            if (gate.state() !== 'active' && !cleaning) throw new win.DOMException('뷰어 작업이 일시 중지되었습니다.', 'AbortError');
            return original.apply(this, args);
          };
          guarded.get(target).add(name);
        }
        return target;
      },
      onEnd(run) { if (ended) run(); else enders.add(run); return () => enders.delete(run); },
      onState(run) { changes.add(run); run(gate.state()); return () => changes.delete(run); },
      authFailure,
    });
    win.KinViewerSessionBoundary = api;
    win.KinViewerResource = win.KinViewerResources.create(win, api, protectedUrl);
    installXHR(win, api, protectedUrl);
    if (initialEnd) end();
    return api;
  }

  // DICOMweb-client and the pinned pixel loader use XHR. Protected XHRs use the same transport
  // as fetch; unrelated static resources keep native XHR. No Response methods are replaced.
  function installXHR(win, boundary, protectedUrl) {
    const Native = win.XMLHttpRequest;
    if (!Native) return;
    class BoundXHR extends win.EventTarget {
      constructor() {
        super();
        this.upload = new win.EventTarget();
        this.readyState = 0; this.status = 0; this.statusText = ''; this.response = null;
        this.responseText = ''; this.responseURL = ''; this.responseType = ''; this.timeout = 0;
        this.withCredentials = false;
        this.headers = {}; this.control = null; this.native = null; this.generation = 0; this.sending = false;
      }
      emit(type, detail = {}) {
        const event = new win.ProgressEvent(type, detail);
        this.dispatchEvent(event);
        this['on' + type]?.call(this, event);
      }
      open(method, url, async = true, user, password) {
        this.control?.abort();
        this.generation++;
        this.sending = false;
        this.method = method; this.url = url; this.headers = {}; this.readyState = 1;
        if (!protectedUrl(url)) {
          this.native = new Native(); this.native.open(method, url, async, user, password);
        } else if (async === false) throw new win.DOMException('Synchronous protected requests are unavailable', 'InvalidAccessError');
        else this.native = null;
        this.emit('readystatechange');
      }
      // XHR combines repeated values of one header, names compared without case. The pinned DICOMweb client names a
      // request's own Accept and then the data source's default one; keeping only the last made Orthanc refuse
      // series metadata (400), so no series opened on a real stack.
      setRequestHeader(name, value) {
        const known = Object.keys(this.headers).find(key => key.toLowerCase() === String(name).toLowerCase());
        if (known === undefined) this.headers[name] = String(value);
        else this.headers[known] += ', ' + value;
      }
      getResponseHeader(name) { return this.native ? this.native.getResponseHeader(name) : this.replyHeaders?.get(name) ?? null; }
      getAllResponseHeaders() { return this.native ? this.native.getAllResponseHeaders() : [...(this.replyHeaders || [])].map(([k, v]) => k + ': ' + v + '\r\n').join(''); }
      overrideMimeType(value) { this.mime = value; this.native?.overrideMimeType(value); }
      abort() {
        this.generation++; this.control?.abort(); this.native?.abort();
        if (!this.native && this.sending && this.readyState < 4 && boundary.active()) {
          this.status = 0; this.readyState = 4; this.emit('readystatechange'); this.emit('abort'); this.emit('loadend');
        }
        this.sending = false; this.readyState = 0;
      }
      send(body = null) {
        if (this.readyState !== 1 || this.sending) throw new win.DOMException('The request is not open', 'InvalidStateError');
        this.sending = true;
        if (this.native) {
          const native = this.native;
          native.responseType = this.responseType; native.timeout = this.timeout; native.withCredentials = this.withCredentials;
          for (const [name, value] of Object.entries(this.headers)) native.setRequestHeader(name, value);
          for (const name of ['readystatechange', 'loadstart', 'progress', 'load', 'error', 'timeout', 'abort', 'loadend'])
            native.addEventListener(name, event => {
              for (const key of ['readyState', 'status', 'statusText', 'response', 'responseURL']) this[key] = native[key];
              if (!native.responseType || native.responseType === 'text') this.responseText = native.responseText;
              if (native.readyState === 4) this.sending = false;
              this.emit(name, event);
            });
          native.send(body); return;
        }
        const context = boundary.gate.capture('document'), generation = this.generation;
        this.control = new win.AbortController();
        const admitted = () => generation === this.generation && !boundary.ended() && boundary.active();
        const apply = effect => { if (admitted()) effect(); };
        this.emit('loadstart');
        boundary.wait(boundary.transport.fetch(this.url, { context, method: this.method, headers: this.headers, body,
          signal: this.control.signal, deadlineMs: this.timeout, kind: 'media', abortWhenStale: false }).then(async response => ({
            status: response.status, headers: response.headers, body: await response.arrayBuffer(),
          }))).then(answer => apply(() => {
          this.status = answer.status; this.statusText = '';
          this.replyHeaders = answer.headers; this.responseURL = new URL(this.url, win.location.href).href;
          this.readyState = 2; this.emit('readystatechange');
          if (!admitted()) return;
          const bytes = answer.body;
          if (this.responseType === 'arraybuffer') this.response = bytes;
          else if (this.responseType === 'blob') this.response = new win.Blob([bytes], { type: this.mime || answer.headers.get('Content-Type') || '' });
          else {
            const text = new TextDecoder().decode(bytes);
            if (this.responseType === 'json') { try { this.response = JSON.parse(text); } catch (_) { this.response = null; } }
            else this.response = this.responseText = text;
          }
          this.readyState = 3; this.emit('readystatechange');
          if (!admitted()) return;
          this.emit('progress', { loaded: bytes.byteLength, total: bytes.byteLength, lengthComputable: true });
          if (!admitted()) return;
          this.sending = false; this.readyState = 4; this.emit('readystatechange');
          if (admitted()) this.emit('load');
          if (admitted()) this.emit('loadend');
        }), error => apply(() => {
          this.sending = false; this.status = 0; this.readyState = 4; this.emit('readystatechange');
          if (admitted()) this.emit(error.transport === 'timeout' ? 'timeout' : 'error');
          if (admitted()) this.emit('loadend');
        }));
      }
    }
    for (const [name, value] of Object.entries({ UNSENT: 0, OPENED: 1, HEADERS_RECEIVED: 2, LOADING: 3, DONE: 4 })) {
      BoundXHR[name] = value; BoundXHR.prototype[name] = value;
    }
    win.XMLHttpRequest = BoundXHR;
  }
  const api = Object.freeze({ connect });
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KinViewerSession = api;
})(typeof window === 'object' ? window : null);
