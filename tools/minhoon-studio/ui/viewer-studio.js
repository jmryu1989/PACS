'use strict';
// The viewer popup (two windows and overlay alike): OHIF itself, top level, with this script added by the studio
// server (static.js) so the viewer the studio opens and the one the worklist opens both behave the same. It joins
// the studio channel as "viewer": 고르기 with the same shield as the product window (clicks never reach OHIF), picks
// that name their viewport and series, and the studio's reload after a change/undo/reset — whichever chat tab, also
// after the chat was refreshed. Studio elements are marked data-studio and kept off OHIF's own layout.
(() => {
  const { channel, el, isShortcut, PICK_KEY } = window.Studio;
  const bc = channel();
  const post = message => { if (bc) bc.postMessage({ from: 'viewer', ...message }); };
  document.documentElement.classList.add('studio-viewer');
  let role = null, chatSeen = 0;

  // Which image a picked element belongs to: OHIF's viewport (data-viewport-uid) and, from OHIF's own services,
  // the series it shows and the slice. Outside a viewport (toolbar, side panels) there is none.
  function imageOf(node) {
    try {
      const pane = node.closest('[data-cy="viewport-pane"]');
      const element = node.closest('[data-viewport-uid]') || (pane && pane.querySelector('[data-viewport-uid]'));
      if (!element) return null;
      const viewportId = element.getAttribute('data-viewport-uid');
      const image = { viewportId, studyInstanceUID: null, seriesInstanceUID: null, seriesNumber: null, seriesDescription: null, modality: null, slice: null };
      const s = window.services;
      const vp = s && s.viewportGridService && s.viewportGridService.getState().viewports.get(viewportId);
      const uid = vp && vp.displaySetInstanceUIDs && vp.displaySetInstanceUIDs[0];
      const ds = uid && s.displaySetService.getDisplaySetByUID(uid);
      if (ds) Object.assign(image, { studyInstanceUID: ds.StudyInstanceUID || null, seriesInstanceUID: ds.SeriesInstanceUID || null,
        seriesNumber: ds.SeriesNumber ?? null, seriesDescription: ds.SeriesDescription || null, modality: ds.Modality || null });
      try {
        const cs = s.cornerstoneViewportService.getCornerstoneViewport(viewportId);
        const total = cs.getImageIds().length;
        if (total) image.slice = `${cs.getCurrentImageIdIndex() + 1}/${total}`;
      } catch { /* not a stack viewport */ }
      return image;
    } catch { return null; }
  }

  const widget = el('div', 'studio-widget');
  widget.dataset.studio = '';
  const dot = el('span', 'dot');
  const button = el('button', '', '고르기');
  button.type = 'button';
  button.title = '고르기 (Alt+G): 바꿀 곳을 클릭해 대화 창에 보냅니다. 클릭해도 영상 창의 버튼은 눌리지 않습니다.';
  widget.append(dot, button);
  document.body.append(widget);

  const KEEP = 'studio-viewer-picks';
  const pick = window.StudioPick(window, {
    idPrefix: 'v',
    meta: node => ({ screen: 'Viewer', role, image: imageOf(node) }),
    onChange: picks => {
      try { sessionStorage.setItem(KEEP, JSON.stringify(picks)); } catch { /* storage off */ }
      post({ type: 'viewer-picks', picks });
    },
    onMode: on => { button.classList.toggle('on', on); post({ type: 'viewer-pick-mode', pickActive: on }); },
  });
  button.onclick = () => pick.toggle();
  try { pick.restore(JSON.parse(sessionStorage.getItem(KEEP) || '[]')); } catch { /* nothing kept */ }

  window.addEventListener('keydown', e => {
    if (pick.onKey(e)) return;
    if (isShortcut(e, PICK_KEY)) { e.preventDefault(); e.stopPropagation(); pick.toggle(); }
  }, true);

  // Every chat tab relays the same studio event with the same nonce: reload once per event. The nonces outlive the
  // reload (this page is the one reloading), so a relay that arrives just after it does not reload again.
  const SEEN = 'studio-viewer-reloads';
  function reloadOnce(nonce) {
    const now = Date.now();
    let seen = {};
    try { seen = JSON.parse(sessionStorage.getItem(SEEN) || '{}') || {}; } catch { seen = {}; }
    for (const [key, t] of Object.entries(seen)) if (now - t > 15000) delete seen[key];
    if (nonce && seen[nonce]) return;
    if (nonce) seen[nonce] = now;
    try { sessionStorage.setItem(SEEN, JSON.stringify(seen)); } catch { /* storage off: may reload twice */ }
    location.reload();
  }

  const hello = () => post({ type: 'viewer-hello', picks: pick.list(), pickActive: pick.active, page: location.pathname + location.search });
  if (bc) bc.onmessage = ({ data: m }) => {
    // The product window's preview banner (원래대로, 적용 rebuilt as an edit) ends a preview this viewer may show.
    if (m && m.from === 'product' && m.type === 'viewer-reload') { reloadOnce(m.nonce); return; }
    if (!m || m.from !== 'chat') return;
    chatSeen = Date.now(); paintLink();
    if (m.type === 'viewer-ping') hello();
    else if (m.type === 'viewer-reload') reloadOnce(m.nonce);
    else if (m.type === 'viewer-pick' && typeof m.on === 'boolean') { pick.toggle(m.on); post({ type: 'viewer-pick-mode', pickActive: pick.active }); }
    else if (m.type === 'viewer-pick-remove') pick.remove(m.id);
    else if (m.type === 'viewer-picks-clear') pick.clear();
  };

  function paintLink() {
    const on = Date.now() - chatSeen < 5000;
    dot.classList.toggle('on', on);
    widget.title = on ? '스튜디오 대화 창과 연결됨: 바꾼 내용이 이 창에도 바로 반영됩니다.' : '스튜디오 대화 창과 연결 안 됨: 대화 창(스튜디오)을 열어 두세요.';
  }
  setInterval(() => { paintLink(); post({ type: 'viewer-hb', pickActive: pick.active }); }, 2000);
  window.addEventListener('pagehide', () => post({ type: 'viewer-bye' }));

  fetch('/studio-api/state').then(r => (r.ok ? r.json() : null)).then(s => { if (s) role = s.role; }).catch(() => {});
  hello();
  paintLink();
})();
