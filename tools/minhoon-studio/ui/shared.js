'use strict';
// Shared by the chat window (studio.html) and the product window (product.html): the studio API call, per-browser
// storage, the channel between the two windows and the screen list. Both pages are same-origin, so a
// BroadcastChannel carries reloads, picks and the connection heartbeat without any new server endpoint.
(() => {
  const CHANNEL = 'minhoon-studio';
  const PRODUCT_WINDOW = 'minhoon-studio-product';
  const VIEWER_STUDY = '2.25.202610270003';
  const DEFAULT_SCREEN = '/worklist/hpacs-lite/main.html';
  const SCREENS = [
    ['/worklist/hpacs-lite/main.html', 'Worklist · 판독'],
    ['/worklist/hpacs-lite/clinician.html', 'Clinician'],
    ['/worklist/hpacs-lite/admin.html', 'Admin'],
    ['/worklist/hpacs-lite/index.html', 'Login 화면'],
    ['viewer', 'Viewer (CT 표본)'],
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

  function screenUrl(value) {
    return value === 'viewer' ? `/ohif/viewer?StudyInstanceUIDs=${VIEWER_STUDY}` : value;
  }

  // The clinician role has no reading worklist; its home is the clinician screen.
  function screenForRole(screen, role) {
    return role === 'clinician' && String(screen).includes('main.html') ? '/worklist/hpacs-lite/clinician.html' : screen;
  }

  function channel() {
    try { return new BroadcastChannel(CHANNEL); } catch { return null; }
  }

  // Alt+<letter> by physical key, so the Korean IME state does not matter; the product uses Ctrl+Alt chords only.
  const isShortcut = (e, code) => e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === code;

  window.Studio = { api, store, el, channel, screenUrl, screenForRole, isShortcut, SCREENS, DEFAULT_SCREEN, PRODUCT_WINDOW,
    PICK_KEY: 'KeyG', CHAT_KEY: 'KeyS' };
})();
