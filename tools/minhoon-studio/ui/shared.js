'use strict';
// Shared by the chat window (studio.html) and the product window (product.html): the studio API call, per-browser
// storage, the channel between the two windows and the screen list. Both pages are same-origin, so a
// BroadcastChannel carries reloads, picks and the connection heartbeat without any new server endpoint.
(() => {
  const CHANNEL = 'minhoon-studio';
  const PRODUCT_WINDOW = 'minhoon-studio-product';
  const VIEWER_WINDOW = 'minhoon-studio-viewer';
  const VIEWER_URL = '/ohif/viewer?StudyInstanceUIDs=2.25.202610270003';
  const DEFAULT_SCREEN = '/worklist/hpacs-lite/main.html';
  const ADMIN_SCREEN = '/worklist/hpacs-lite/admin.html';
  // 'viewer' is not a product-window screen: the product opens its viewer in a separate popup (studio.js openViewer).
  const SCREENS = [
    ['/worklist/hpacs-lite/main.html', 'Worklist · 판독'],
    ['/worklist/hpacs-lite/clinician.html', 'Clinician'],
    [ADMIN_SCREEN, 'Admin'],
    ['/worklist/hpacs-lite/index.html', 'Login 화면'],
    ['viewer', 'Viewer (CT 표본, 영상 창)'],
  ];

  async function api(path, options = {}) {
    const init = { ...options, headers: { ...(options.headers || {}) } };
    if (options.json !== undefined) { init.method = init.method || 'POST'; init.body = JSON.stringify(options.json); init.headers['Content-Type'] = 'application/json'; }
    if (init.method && init.method !== 'GET') init.headers['X-Studio'] = '1';
    const res = await fetch('/studio-api/' + path, init);
    if (res.status === 401) { location.replace('/studio/login.html'); throw new Error('login'); }
    const type = res.headers.get('content-type') || '';
    const body = type.includes('json') ? await res.json() : await res.text();
    if (!res.ok) { const error = new Error((body && body.error) || res.statusText); error.body = body; throw error; }
    return body;
  }

  // Storage can be off (privacy settings); the studio then just forgets choices between visits.
  const store = {
    get(key, fallback = null) { try { const v = localStorage.getItem(key); return v === null ? fallback : v; } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, String(value)); } catch { /* storage off */ } },
  };

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // A remembered screen from before the viewer became its own window falls back to the worklist.
  function productScreen(value) {
    return SCREENS.some(([v]) => v === value) && value !== 'viewer' ? value : DEFAULT_SCREEN;
  }

  // The clinician role has no reading worklist; its home is the clinician screen.
  function screenForRole(screen, role) {
    return role === 'clinician' && String(screen).includes('main.html') ? '/worklist/hpacs-lite/clinician.html' : screen;
  }

  // Where the product puts a new viewer popup: the last viewer rectangle it saved on this origin, else its default
  // (worklist-v0/hpacs-lite/viewer-placement.js readStoredOhifRect / defaultOhifRect, current screen only).
  function viewerRect() {
    try {
      const v = JSON.parse(localStorage.getItem('kin.ohif.current.rect') || 'null');
      const r = { left: Number(v && v.left), top: Number(v && v.top), width: Number(v && v.width), height: Number(v && v.height) };
      if (Object.values(r).every(Number.isFinite) && r.left > -30000 && r.top > -30000 && r.width >= 320 && r.height >= 240) return r;
    } catch { /* storage off or a bad value: use the default */ }
    const t = { left: screen.availLeft || 0, top: screen.availTop || 0, width: screen.availWidth || 1280, height: screen.availHeight || 720 };
    const width = Math.min(t.width, Math.max(640, Math.min(1600, t.width - 80)));
    const height = Math.min(t.height, Math.max(600, Math.min(1000, t.height - 80)));
    return { left: Math.min(t.left + 40, t.left + t.width - width), top: Math.min(t.top + 40, t.top + t.height - height), width, height };
  }

  function channel() {
    try { return new BroadcastChannel(CHANNEL); } catch { return null; }
  }

  // Alt+<letter> by physical key, so the Korean IME state does not matter; the product uses Ctrl+Alt chords only.
  const isShortcut = (e, code) => e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === code;

  window.Studio = { api, store, el, channel, productScreen, screenForRole, viewerRect, isShortcut, SCREENS, DEFAULT_SCREEN, ADMIN_SCREEN,
    PRODUCT_WINDOW, VIEWER_WINDOW, VIEWER_URL, PICK_KEY: 'KeyG', CHAT_KEY: 'KeyS' };
})();
