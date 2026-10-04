/* U5S-REQ-08/12: browser loads cannot carry the session header. Resolve protected bytes
 * through the page transport before giving a native element any URL. The document owns
 * every resulting blob, including decoder/print blobs made by the pinned viewer. */
(function (root) {
  'use strict';
  function create(win, boundary, protectedUrl) {
    const createURL = win.URL.createObjectURL.bind(win.URL), revokeURL = win.URL.revokeObjectURL.bind(win.URL);
    const owned = new Set(), loaded = new Set(), elements = new Map();
    let disposed = false;
    win.URL.createObjectURL = blob => {
      if (disposed || boundary.ended()) throw new win.DOMException('Viewer closed', 'AbortError');
      const url = createURL(blob); owned.add(url); return url;
    };
    const release = url => { loaded.delete(url); owned.delete(url); revokeURL(url); };
    win.URL.revokeObjectURL = release;
    async function read(url, options = {}) {
      if (!protectedUrl(url)) throw new TypeError('Expected a protected resource in this origin');
      await boundary.wait();
      if (options.signal?.aborted) throw new win.DOMException('Aborted', 'AbortError');
      // Detached element loads fail explicitly; read() callers own detached use.
      // Recheck at delivery because preparation can outlive the element's attachment.
      if (options.element && !options.element.isConnected) throw new win.DOMException('Element removed', 'AbortError');
      const response = await win.fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: options.signal });
      const type = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
      if (!response.ok || options.type && (response.status !== 200 || type !== options.type)) {
        await response.body?.cancel();
        const error = new Error([401, 403].includes(response.status) ? '원본 자료 접근이 거절되었습니다. 검사 접근 권한을 확인하세요.' :
          response.status === 404 ? '원본 자료를 찾을 수 없습니다.' :
          response.ok && options.type === 'application/pdf' && type !== options.type ? '원본 자료가 PDF 형식이 아닙니다.' :
          '원본 자료 응답을 확인할 수 없습니다.');
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      const blob = await boundary.wait(response.blob());
      if (options.signal?.aborted) throw new win.DOMException('Aborted', 'AbortError');
      const result = win.URL.createObjectURL(blob); loaded.add(result); return result;
    }
    // React uses setAttribute for some media and property setters for others. Intercept both
    // before the browser sees a protected URL (a MutationObserver would be too late).
    const attributes = { IMG: ['src'], VIDEO: ['src', 'poster'], AUDIO: ['src'], SOURCE: ['src'],
      OBJECT: ['data'], IFRAME: ['src'], EMBED: ['src'] };
    const nativeSet = win.Element?.prototype.setAttribute, nativeRemove = win.Element?.prototype.removeAttribute;
    function forget(element, name) {
      const entries = elements.get(element), entry = entries?.get(name);
      if (!entry) return;
      entries.delete(name); if (!entries.size) elements.delete(element);
      entry.controller?.abort();
      if (entry.url && ![...elements.values()].some(values => [...values.values()].some(v => v.url === entry.url))) release(entry.url);
    }
    function assign(element, name, value, apply) {
      const previous = elements.get(element)?.get(name);
      if (previous?.url === String(value)) { apply(value); return; }
      forget(element, name);
      const protectedLoad = protectedUrl(value);
      // Derived frames can be shown repeatedly (batch Previous/Next, cine). Their existing
      // panel owns retirement; only fetched documents retire automatically with an element.
      if (!protectedLoad && !loaded.has(String(value))) { apply(value); return; }
      const entry = { controller: protectedLoad ? new win.AbortController() : null,
        url: protectedLoad ? null : String(value), connected: element.isConnected };
      if (!elements.has(element)) elements.set(element, new Map());
      elements.get(element).set(name, entry);
      if (!protectedLoad) { apply(value); return; }
      nativeRemove.call(element, name);
      boundary.wait(read(value, { signal: entry.controller.signal, element }), release).then(url => {
        if (elements.get(element)?.get(name) !== entry || boundary.ended()) { release(url); return; }
        entry.url = url; apply(url);
        if (element.tagName === 'SOURCE') element.parentElement?.load?.();
      }, () => {
        if (elements.get(element)?.get(name) !== entry || boundary.ended()) return;
        const removed = entry.connected && !element.isConnected;
        forget(element, name);
        if (!removed) element.dispatchEvent(new win.Event('error'));
      });
    }
    if (nativeSet) {
      win.Element.prototype.setAttribute = function (name, value) {
        const key = String(name).toLowerCase();
        if (attributes[this.tagName]?.includes(key)) return assign(this, key, value, v => nativeSet.call(this, name, v));
        return nativeSet.call(this, name, value);
      };
      win.Element.prototype.removeAttribute = function (name) { forget(this, String(name).toLowerCase()); return nativeRemove.call(this, name); };
      for (const [constructor, names] of [[win.HTMLImageElement, ['src']], [win.HTMLMediaElement, ['src']],
        [win.HTMLVideoElement, ['poster']], [win.HTMLSourceElement, ['src']], [win.HTMLObjectElement, ['data']],
        [win.HTMLIFrameElement, ['src']], [win.HTMLEmbedElement, ['src']]]) {
        for (const name of names) {
          const descriptor = constructor && Object.getOwnPropertyDescriptor(constructor.prototype, name);
          if (!descriptor?.set) continue;
          Object.defineProperty(constructor.prototype, name, { ...descriptor,
            set(value) { assign(this, name, value, v => descriptor.set.call(this, v)); } });
        }
      }
    }
    const observer = win.MutationObserver && new win.MutationObserver(records => {
      for (const [element, entries] of elements) for (const [name, entry] of entries) {
        // Removal records also retain an element attached and removed in the same task.
        if (records.some(record => [...record.removedNodes].some(node => node === element || node.contains(element)))) entry.connected = true;
        if (element.isConnected) entry.connected = true;
        else if (entry.connected) forget(element, name);
      }
    });
    observer?.observe(win.document, { childList: true, subtree: true });
    const dispose = () => {
      disposed = true;
      observer?.disconnect();
      for (const [element, entries] of elements) for (const name of [...entries.keys()]) {
        nativeRemove.call(element, name); forget(element, name);
      }
      for (const url of [...owned]) release(url);
    };
    boundary.onEnd(dispose);
    win.addEventListener?.('pagehide', event => { if (!event.persisted) dispose(); });
    return Object.freeze({ read, release, has: url => owned.has(url) });
  }
  const api = { create };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KinViewerResources = api;
})(typeof window === 'object' ? window : null);
