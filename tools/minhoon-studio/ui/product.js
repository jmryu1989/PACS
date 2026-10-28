'use strict';
// The product window (two-window mode): only the product screen at its real size. The studio chat window drives it
// over the shared BroadcastChannel — open a screen, reload after an applied change or undo, pick elements — and
// this window reports back its page, selected study, JavaScript errors, picks and reload timings.
(() => {
  const { api, store, channel, screenForRole, isShortcut, SCREENS, DEFAULT_SCREEN, PICK_KEY } = window.Studio;
  const $ = id => document.getElementById(id);
  const bc = channel();
  const me = { role: null, screen: store.get('studio-screen', DEFAULT_SCREEN) };
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
  });
  const pick = window.StudioPick($('product'), {
    meta: () => ({ screen: screenLabel(), role: me.role }),
    onChange: picks => post({ type: 'picks', picks }),
    onMode: on => { $('pick').classList.toggle('on', on); post({ type: 'pick-mode', on }); },
  });

  function snapshot() {
    return { ...mirror.context(), picks: pick.list(), pickActive: pick.active, screen: me.screen, role: me.role };
  }

  function open(screen, role) {
    if (role) me.role = role;
    me.screen = screen || me.screen;
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
    } else if (m.type === 'pick') pick.toggle(m.on);
    else if (m.type === 'pick-remove') pick.remove(m.id);
    else if (m.type === 'picks-clear') pick.clear();
  };

  // Connection dot: green while a studio chat window is heard from (it sends a heartbeat every 2 s).
  function paintLink() {
    const on = Date.now() - chatSeen < 5000;
    $('link').classList.toggle('on', on);
    $('link').title = on ? '스튜디오 대화 창과 연결됨: 바꾼 내용이 이 창에 바로 반영됩니다.' : '스튜디오 대화 창과 연결 안 됨: 대화 창(스튜디오)을 열어 두세요.';
  }
  setInterval(() => { paintLink(); post({ type: 'hb' }); }, 2000);
  window.addEventListener('pagehide', () => post({ type: 'bye' }));

  (async () => {
    try { const s = await api('state'); me.role = s.role; } catch (error) { if (error.message === 'login') return; }
    open(me.screen, me.role);
    post({ type: 'hello', ...snapshot() });
    paintLink();
  })();
})();
