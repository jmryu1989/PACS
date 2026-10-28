'use strict';
// The product window (two-window mode): only the product screen at its real size. The studio chat window drives it
// over the shared BroadcastChannel — open a screen, reload after an applied change or undo, pick elements — and
// this window reports back its page, selected study, JavaScript errors, picks and reload timings.
(() => {
  const { api, store, channel, productScreen, screenForRole, isShortcut, SCREENS, DEFAULT_SCREEN, PICK_KEY } = window.Studio;
  const $ = id => document.getElementById(id);
  const bc = channel();
  const me = { role: null, screen: productScreen(store.get('studio-screen', DEFAULT_SCREEN)) };
  const seen = new Map(); // reload nonce -> time, so two chat tabs relaying the same event reload once
  let chatSeen = 0;

  const post = message => { if (bc) bc.postMessage({ from: 'product', ...message }); };
  const screenLabel = () => (SCREENS.find(([value]) => value === me.screen) || [null, me.screen])[1];

  const mirror = window.StudioMirror($('product'), {
    onErrors: errors => post({ type: 'errors', errors }),
    onPending: ev => { $('pending').hidden = !ev; },
    onReloaded: info => post({ type: 'reloaded', ...info }),
    onWindow: win => win.addEventListener('keydown', keys, true),
    onTitle: title => { document.title = `${title} — 스튜디오`; },
    onLoad: () => post({ type: 'state', ...snapshot() }),
    heldField: () => pick.heldField(),
  });
  const pick = window.StudioPick($('product'), {
    meta: () => ({ screen: screenLabel(), role: me.role }),
    onChange: picks => post({ type: 'picks', picks }),
    onMode: on => { $('pick').classList.toggle('on', on); post({ type: 'pick-mode', on }); },
  });

  function snapshot() {
    return { ...mirror.context(), picks: pick.list(), pickActive: pick.active, screen: me.screen, role: me.role, typing: mirror.typing(), preview };
  }

  // A suggestion preview in this browser (the server serves the preview copy while its cookie is set): the banner says
  // so, so a preview is never mistaken for the applied screen. 적용 / 원래대로 work from here as from the chat card.
  let preview = null; // { id, title }
  function setPreview(p) {
    preview = p && p.id ? { id: p.id, title: p.title || '' } : null;
    $('preview-banner').hidden = !preview;
    $('preview-title').textContent = preview ? preview.title : '';
  }
  // Leaving the preview here: this window and an open viewer (it may run the preview's config/ohif) show the studio
  // screen again.
  function previewEnded() {
    mirror.reload({ reason: 'preview-end' });
    post({ type: 'viewer-reload', nonce: `preview-end|${Date.now()}|${Math.random()}` });
  }
  $('preview-stop').onclick = async () => {
    await api('suggestions/preview/stop', { method: 'POST' }).catch(() => {});
    setPreview(null); post({ type: 'preview', id: null });
    previewEnded();
  };
  $('preview-apply').onclick = async () => {
    if (!preview) return;
    const id = preview.id;
    $('preview-apply').disabled = true;
    try {
      const r = await api(`suggestions/${id}/apply`, { json: {} });
      setPreview(null); post({ type: 'preview', id: null, applied: id });
      // Applied from the preview: the studio's reload event shows it. Rebuilt as an edit: show the screen as it is now.
      if (r.via === 'edit') previewEnded();
    } catch (error) { alert(error.message); setPreview(null); previewEnded(); }
    finally { $('preview-apply').disabled = false; }
  };

  // The chosen screen is remembered as chosen (Worklist), not as shown for the role (Clinician), so switching the
  // role back after a reload returns to the Worklist.
  function open(screen, role) {
    if (role) me.role = role;
    me.screen = screen ? productScreen(screen) : me.screen;
    store.set('studio-screen', me.screen);
    mirror.open(screenForRole(me.screen, me.role));
  }

  // Shortcuts work whether the focus is in this page or inside the product frame.
  function keys(e) {
    if (pick.onKey(e)) return;
    if (isShortcut(e, PICK_KEY)) { e.preventDefault(); e.stopPropagation(); pick.toggle(); }
  }
  window.addEventListener('keydown', keys, true);
  $('pick').onclick = () => pick.toggle();
  $('apply-now').onclick = () => mirror.applyPending();

  if (bc) bc.onmessage = ({ data: m }) => {
    if (!m || m.from !== 'chat') return;
    chatSeen = Date.now(); paintLink();
    if (m.type === 'ping') post({ type: 'hello', ...snapshot() });
    else if (m.type === 'context') post({ type: 'context', ask: m.ask, ...snapshot() });
    else if (m.type === 'open') open(m.screen, m.role);
    else if (m.type === 'reload') {
      const now = Date.now();
      for (const [key, t] of seen) if (now - t > 15000) seen.delete(key);
      if (m.nonce && seen.has(m.nonce)) return;
      if (m.nonce) seen.set(m.nonce, now);
      mirror.request(m.ev || {});
    } else if (m.type === 'preview') setPreview(m.id ? m : null);
    else if (m.type === 'pick') { pick.toggle(m.on); post({ type: 'pick-mode', on: pick.active }); }
    else if (m.type === 'focus') {
      // Asked by a chat tab that has no handle to this window; browsers may refuse a focus without a click here.
      try { window.focus(); } catch { /* refused */ }
      setTimeout(() => post({ type: 'focused', ask: m.ask, ok: document.hasFocus() }), 300);
    } else if (m.type === 'pick-remove') pick.remove(m.id);
    else if (m.type === 'picks-clear') pick.clear();
  };

  // Connection dot: green while a studio chat window is heard from (it sends a heartbeat every 2 s).
  function paintLink() {
    const on = Date.now() - chatSeen < 5000;
    $('link').classList.toggle('on', on);
    $('link').title = on ? '스튜디오 대화 창과 연결됨: 바꾼 내용이 이 창에 바로 반영됩니다.' : '스튜디오 대화 창과 연결 안 됨: 대화 창(스튜디오)을 열어 두세요.';
  }
  setInterval(() => { paintLink(); post({ type: 'hb', typing: mirror.typing() }); }, 2000);
  window.addEventListener('pagehide', () => post({ type: 'bye' }));

  (async () => {
    try { const s = await api('state'); me.role = s.role; } catch (error) { if (error.message === 'login') return; }
    // A preview opened before this window (re)loaded is still on: the cookie outlives the page.
    try { const s = await api('suggestions'); if (s.previewing && s.current && s.current.id === s.previewing) setPreview(s.current); } catch { /* no banner */ }
    open(me.screen, me.role);
    post({ type: 'hello', ...snapshot() });
    paintLink();
  })();
})();
