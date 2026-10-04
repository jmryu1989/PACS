/* U5S-REQ-04/08/12. One session authority for an OHIF document without auth.js.
 * A history entry retains only its binding, never patient data or credentials. Reloading that
 * entry cannot adopt the opener's later login. The server still authorizes every bound request.
 */
(function (root) {
  'use strict';
  const RECORD = 'kinViewerSession';
  const closed = state => !['active', 'preparing'].includes(state);

  function connect(win) {
    if (win.KinViewerSessionBoundary) return win.KinViewerSessionBoundary;
    const gate = win.KinWorkContext;
    const originalFetch = win.fetch.bind(win);
    const nativeTimeout = win.setTimeout.bind(win), nativeInterval = win.setInterval.bind(win);
    const nativeReplaceState = win.history.replaceState.bind(win.history);
    const nativePushState = win.history.pushState.bind(win.history);
    const clearTimeout = win.clearTimeout.bind(win), clearInterval = win.clearInterval.bind(win);
    const nativeFrame = win.requestAnimationFrame?.bind(win), cancelFrame = win.cancelAnimationFrame?.bind(win);
    const timers = new Map(), intervals = new Map(), frames = new Map(), deferred = new Set(), workers = new Set();
    let announce, preparation = null, preparingId = null, peerPreparation = null, lease = null, ended = false, cleaning = false;
    let peer = null, record = null;
    const enders = new Set(), changes = new Set();
    try { peer = win.opener || (win.parent !== win ? win.parent : null); } catch (_) {}
    try { record = win.history.state?.[RECORD] || null; } catch (_) { record = {}; }
    let peerGate = null;
    try { peerGate = peer?.KinWorkContext || null; } catch (_) {}
    const validRecord = record && typeof record.session === 'string' && record.session.length > 0 && typeof record.ended === 'boolean';
    let session = validRecord ? record.session : record ? null : peerGate?.session() || null;
    const needsBootstrap = !record && !peerGate && !session;
    const heard = new Map();
    const initialEnd = record?.ended === true || !session && !needsBootstrap ||
      (peerGate?.session() === session && closed(peerGate.state()));
    const remember = ending => {
      try { nativeReplaceState({ ...win.history.state, [RECORD]: { session, ended: ending } }, ''); return true; }
      catch (_) { return false; }
    };
    gate.follow({ onLifecycle(listener) {
      announce = listener;
      listener({ state: initialEnd || needsBootstrap ? 'unknown' : 'active', session });
    } });
    if (session) remember(initialEnd);
    // Router state changes must not erase this history entry's original session before a reload.
    for (const [name, native] of [['replaceState', nativeReplaceState], ['pushState', nativePushState]])
      win.history[name] = (state, title, url) => native({ ...state, [RECORD]: { session, ended: ended || initialEnd } }, title, url);

    function end() {
      if (ended) return;
      ended = true;
      cleaning = true;
      remember(true);
      announce({ state: 'ending', session });
      clearTimeout(lease);
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
    function renewLease() {
      clearTimeout(lease);
      const id = preparingId;
      lease = nativeTimeout(() => { syncPeer(); resume(id); }, 6000);
    }
    function pause(id) {
      if (ended || id === null || id === undefined || closed(gate.state())) return;
      if (preparation) { if (id === preparingId) renewLease(); return; }
      preparingId = id;
      preparation = gate.prepare({ preparationId: id });
      renewLease();
      for (const run of [...changes]) { try { run('preparing'); } catch (_) {} }
    }
    function resume(id) {
      if (ended || !preparation || id !== preparingId) return;
      clearTimeout(lease); lease = null;
      gate.cancelPreparation(preparation);
      preparation = null; preparingId = null;
      for (const run of [...changes]) { try { run('active'); } catch (_) {} }
      for (const run of [...deferred]) { deferred.delete(run); if (!ended) run(); }
    }
    function notice(data) {
      if (needsBootstrap && !session && data?.session) {
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
        if (!source || source.session() !== session) return;
        if (closed(source.state())) end();
        else if (source.state() === 'preparing') {
          const id = source.preparation()?.preparation;
          // A readable but frozen opener is not a heartbeat. Only a new preparation or its
          // own repeated notice renews the lease; observing the same stale object cannot.
          if (id !== peerPreparation) { peerPreparation = id; pause(id); }
        } else if (peerPreparation !== null) { resume(peerPreparation); peerPreparation = null; }
      } catch (_) { /* A closed opener is not evidence that this session ended. */ }
    }
    let channel = null;
    try { channel = new win.BroadcastChannel('kin-session'); channel.onmessage = event => notice(event.data); } catch (_) {}
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
    win.addEventListener('pageshow', event => {
      if (!event.persisted) return;
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
    // A new noopener document follows the same entry rule as auth.js: reliable storage,
    // no end record, one bootstrap with bounded retries. A history binding NEVER
    // enters this path. Recheck records/notices after the body, before adopting its identity.
    function entryAllowed() {
      try {
        const storage = win.localStorage, key = 'kin-viewer-entry-probe', value = win.crypto.randomUUID().padEnd(160, '.');
        storage.setItem(key, value);
        const reliable = storage.getItem(key) === value;
        storage.removeItem(key);
        return reliable && storage.getItem(key) === null && storage.getItem('kin-session-end') === null &&
          !win.document.cookie.split(';').some(part => part.trim().startsWith('kin-session-end='));
      } catch (_) { return false; }
    }
    let entryNotice = null;
    async function bootstrap() {
      if (!needsBootstrap) return;
      // A reload of an unresolved entry must not start a second identity adoption.
      if (!remember(true) || !entryAllowed()) { end(); return; }
      for (;;) {
        for (const delay of [0, 1000, 2000]) {
          if (delay) await new Promise(resolve => nativeTimeout(resolve, delay));
          if (ended) return;
          if (!entryAllowed()) { end(); return; }
          const controller = new win.AbortController();
          const deadline = nativeTimeout(() => controller.abort(), 10000);
          try {
            const response = await originalFetch('/api/me', { credentials: 'same-origin', cache: 'no-store',
              headers: { 'X-KIN-CSRF': '1' }, signal: controller.signal });
            let me = null;
            try { me = await response.json(); } catch (_) {}
            const code = response.headers.get('X-KIN-Auth-Code') || me?.code;
            if (ended || !entryAllowed() ||
                response.status === 401 && ['AUTH_CREDENTIALS_MISSING', 'AUTH_SESSION_ENDED'].includes(code) ||
                response.status === 403 && ['INSTITUTION_PENDING', 'INSTITUTION_INVALID'].includes(code)) { end(); return; }
            if (!response.ok || typeof me?.sessionId !== 'string' || !me.sessionId) continue;
            if (heard.get(me.sessionId)?.type === 'session-ended') { end(); return; }
            session = me.sessionId;
            if (!remember(false)) { end(); return; }
            announce({ state: 'active', session });
            notice(heard.get(session));
            if (gate.state() === 'active') for (const run of [...deferred]) { deferred.delete(run); if (!ended) run(); }
            return;
          } catch (_) { /* Offline, timeout and a malformed reply leave entry unknown. */ }
          finally { clearTimeout(deadline); }
        }
        if (ended) return;
        // Retry the unresolved entry in this document, never by reloading/adopting a new login.
        await new Promise(resolve => {
          entryNotice = win.document.createElement('section'); entryNotice.setAttribute('role', 'alert');
          entryNotice.style.cssText = 'position:fixed;inset:30% 20% auto;z-index:10000;background:#18212b;color:white;padding:24px';
          const message = win.document.createElement('p'), button = win.document.createElement('button');
          message.textContent = '세션을 확인하지 못했습니다. 연결을 확인한 뒤 다시 시도하세요.';
          button.textContent = 'Retry';
          button.onclick = () => { entryNotice.remove(); entryNotice = null; resolve(); };
          entryNotice.append(message, button); win.document.body.append(entryNotice);
        });
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
      setRequestHeader(name, value) { this.headers[name] = value; }
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
