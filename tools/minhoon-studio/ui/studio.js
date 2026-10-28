'use strict';
// The studio chat window. Two layouts (per browser, remembered):
//  - 두 창 (default): this window is chat only; the product runs in its own window (product.html) at its real size
//    and is driven over the same-origin BroadcastChannel (open screen, reload after a change/undo, picks).
//  - 한 창 (겹쳐 보기): the product fills this window and the chat slides over it without resizing it.
// All text from the server is rendered with textContent; chat and file content are never treated as markup.
(() => {
  const { api, store, el, channel, productScreen, screenForRole, viewerRect, isShortcut, SCREENS, DEFAULT_SCREEN, ADMIN_SCREEN,
    PRODUCT_WINDOW, VIEWER_WINDOW, VIEWER_URL, PICK_KEY, CHAT_KEY } = window.Studio;
  const $ = id => document.getElementById(id);
  const messages = $('messages');
  const input = $('input');
  const layout = store.get('studio-layout', 'two') === 'overlay' ? 'overlay' : 'two';
  document.body.dataset.layout = layout;
  const state = { mode: 'edit', me: null, live: new Map(), errors: [], missing: [], picks: [], jobsWaiting: new Set(), timings: {},
    product: { seen: 0, page: '', study: null, errors: [], pickActive: false, typing: false },
    suggestion: null, previewing: null, previewClick: null, suggestAsked: false, seen: new Set(),
    rev: 0, activity: { pending: 0, typing: [] } };
  // This tab's name on the event stream and in presence reports (the server prepares a suggestion only while no tab
  // reports typing).
  const TAB = Math.random().toString(36).slice(2, 12);
  const PLACEHOLDER = {
    edit: '예) 판독문 입력칸을 더 크게 해 주세요 / (고르기로 버튼을 찍고) 이거 오른쪽 끝으로 옮겨 주세요',
    ask: '예) Related Report는 어떻게 동작해요? / 제 피드백 3번은 어디까지 됐어요?',
  };

  for (const [value, label] of SCREENS) { const o = el('option', '', label); o.value = value; $('screen').append(o); }

  // ── tiny safe formatter: newlines kept by CSS, **bold** and `code` only ──
  function richText(text) {
    const frag = document.createDocumentFragment();
    const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
    let last = 0, m;
    const s = String(text || '');
    while ((m = re.exec(s))) {
      if (m.index > last) frag.append(s.slice(last, m.index));
      const token = m[0];
      const node = document.createElement(token.startsWith('**') ? 'strong' : 'code');
      node.textContent = token.startsWith('**') ? token.slice(2, -2) : token.slice(1, -1);
      frag.append(node);
      last = m.index + token.length;
    }
    if (last < s.length) frag.append(s.slice(last));
    return frag;
  }

  function scrollDown() { messages.scrollTop = messages.scrollHeight; }

  function renderEntry(entry) {
    if (entry.jobId && state.live.has(entry.jobId) && entry.role !== 'user') {
      state.live.get(entry.jobId).remove();
      state.live.delete(entry.jobId);
    }
    const li = el('li', `msg ${entry.role}${entry.meta && entry.meta.failed ? ' failed' : ''}`);
    const who = el('div', 'who', entry.role === 'user' ? (entry.displayName || entry.user) : entry.role === 'assistant' ? '스튜디오' : '안내');
    who.append(el('span', 'mode', entry.mode === 'ask' ? '물어보기' : '바꾸기'));
    who.append(' ' + new Date(entry.t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }));
    const text = el('div', 'text');
    text.append(richText(entry.text));
    li.append(who, text);
    const meta = entry.meta || {};
    if (entry.role === 'user' && Array.isArray(meta.picks) && meta.picks.length) li.append(el('div', 'meta', `고른 곳: ${meta.picks.join(', ')}`));
    if (entry.role === 'assistant' && meta.changed && meta.sha) {
      const row = el('div', 'meta');
      row.append(el('span', 'applied', '반영됨'));
      if (meta.files) row.append(el('span', '', meta.files.filter(f => !/bundle\.js$|config\/ohif\.js$/.test(f)).map(f => f.split('/').pop()).join(', ')));
      const timing = state.timings[entry.jobId];
      if (timing) row.append(el('span', '', timing));
      const view = el('button', '', '변경 보기'); view.type = 'button'; view.onclick = () => showChange(meta.sha);
      const undo = el('button', '', '되돌리기'); undo.type = 'button'; undo.onclick = () => doUndo(meta.sha);
      row.append(view, undo);
      li.append(row);
    }
    if (meta.blocked && meta.blocked.length) li.append(el('div', 'meta', `허용 밖이라 되돌린 파일: ${meta.blocked.join(', ')}`));
    if (meta.errors && meta.errors.length) li.append(el('div', 'meta', `검사 오류: ${meta.errors[0]}`));
    messages.append(li);
    scrollDown();
  }

  function liveBubble(jobId, mode) {
    let li = state.live.get(jobId);
    if (!li) {
      li = el('li', 'msg assistant live');
      const who = el('div', 'who', '스튜디오'); who.append(el('span', 'mode', mode === 'ask' ? '물어보기' : '바꾸기'));
      li.append(who, el('div', 'text', '…'), el('div', 'meta tools'));
      messages.append(li);
      state.live.set(jobId, li);
    }
    return li;
  }

  // ── job progress line ──
  const jobLine = $('job-line');
  let tick = null;
  function showJob(ev) {
    const label = { queued: '차례를 기다리는 중', running: ev.mode === 'ask' ? '찾아보는 중' : '고치는 중', building: '빌드·검사 중', repairing: '오류를 고치는 중',
      applied: '반영됨', done: '끝', failed: '실패' }[ev.state] || ev.state;
    if (['applied', 'done', 'failed'].includes(ev.state)) {
      state.jobsWaiting.delete(ev.id);
      if (!state.jobsWaiting.size) { jobLine.hidden = true; clearInterval(tick); tick = null; }
      renderSuggestion();
      return;
    }
    if (!state.jobsWaiting.has(ev.id)) { state.jobsWaiting.add(ev.id); renderSuggestion(); }
    jobLine.hidden = false;
    jobLine.dataset.label = label;
    jobLine.dataset.started = jobLine.dataset.started && state.jobsWaiting.size > 1 ? jobLine.dataset.started : String(Date.now());
    const paint = () => {
      const secs = Math.round((Date.now() - Number(jobLine.dataset.started)) / 1000);
      jobLine.textContent = `${jobLine.dataset.label}… ${secs}초`;
    };
    paint();
    if (!tick) tick = setInterval(paint, 1000);
  }

  // ── events from the server ──
  function connect() {
    const source = new EventSource('/studio-api/events?tab=' + TAB);
    source.onmessage = event => {
      let ev; try { ev = JSON.parse(event.data); } catch { return; }
      if (ev.type === 'chat') renderEntry(ev.entry);
      else if (ev.type === 'job') {
        showJob(ev);
        if (ev.state === 'delta') {
          const li = liveBubble(ev.id, ev.mode);
          li.querySelector('.text').textContent = ev.text || '…';
          scrollDown();
        } else if (ev.state === 'tool') {
          liveBubble(ev.id, ev.mode).querySelector('.tools').textContent = ev.summary;
        } else if (ev.state === 'applied' && ev.timings) {
          state.timings[ev.id] = `요청→적용 ${(ev.timings.totalToReloadSentMs / 1000).toFixed(1)}초`;
        }
      } else if (ev.type === 'reload') {
        // Every studio tab of this browser relays the same server event with the same nonce, so the product window
        // reloads once per event; two separate events (two resets) are two reloads.
        const nonce = ev.eventId || `${ev.reason}|${ev.sha || ''}|${ev.jobId || ''}`;
        target.reload({ reason: ev.reason, jobId: ev.jobId || null, sha: ev.sha || null }, nonce);
        viewer.reload(nonce);
        refreshState().catch(() => {});
      } else if (ev.type === 'missing') {
        if (!state.missing.some(m => m.method === ev.method && m.path === ev.path)) state.missing.push(ev);
        $('missing').hidden = false; $('missing').querySelector('b').textContent = state.missing.length;
      } else if (ev.type === 'digest') {
        refreshState();
      } else if (ev.type === 'suggestion') {
        suggestionEvent(ev);
      } else if (ev.type === 'activity') {
        if (fresh(ev.rev)) { state.activity = ev.activity; renderSuggestion(); }
      } else if (ev.type === 'hello' && ev.suggest) {
        applySuggestionState(ev.suggest);
      }
    };
    source.onerror = () => { /* EventSource reconnects by itself */ };
  }

  function setErrors(errors) {
    state.errors = errors;
    $('errors').hidden = !errors.length; $('errors').querySelector('b').textContent = errors.length;
  }

  function noteReload(info) {
    if (info.reason === 'preview') previewShown(info);
    if (info.jobId && state.timings[info.jobId]) {
      state.timings[info.jobId] += info.readyKind !== 'timeout' ? ` · 화면 새로고침 ${(info.reloadMs / 1000).toFixed(1)}초` : ' · 화면 준비 시간 초과';
    }
  }

  // ── picks (chips above the input): the product window's, then each viewer popup's (in the order they were first
  // heard). Every window is told how many the others hold, so the one limit (StudioPick.MAX) is kept where he picks
  // and everything shown here is what is sent. ──
  const MAX_PICKS = window.StudioPick.MAX;
  const pickSets = { product: [], viewers: new Map() }; // viewer window id -> its picks
  const pickCounts = () => {
    const counts = { product: pickSets.product.length };
    for (const [win, picks] of pickSets.viewers) counts[`viewer:${win}`] = picks.length;
    return counts;
  };
  function setPicks(picks, from = 'product', win = '') {
    if (from === 'viewer') pickSets.viewers.set(win, picks); else pickSets.product = picks;
    const many = [...pickSets.viewers.values()].filter(list => list.length).length > 1;
    const all = pickSets.product.map(p => [p, 'product', '', '']);
    let n = 0;
    for (const [w, list] of pickSets.viewers) {
      if (!list.length) continue;
      n++;
      for (const p of list) all.push([p, 'viewer', w, many ? ` ${n}` : '']);
    }
    state.picks = all.map(([p]) => p);
    const chips = $('chips');
    chips.replaceChildren();
    all.forEach(([p, source, w, which], i) => {
      const chip = el('span', p.lost ? 'chip lost' : 'chip');
      chip.title = `${p.selector}\n${p.page || ''}${p.lost ? `\n지금 ${source === 'viewer' ? '영상 창' : '제품 화면'}에서 이 요소를 찾을 수 없습니다(목록이 바뀌었거나 다른 화면). 빼고 다시 골라 주세요.` : ''}`;
      const image = p.image && p.image.seriesDescription ? ` · ${p.image.seriesDescription}${p.image.slice ? ` ${p.image.slice}` : ''}` : '';
      chip.append(el('b', '', String(i + 1)), `${source === 'viewer' ? ` 영상 창${which}` : ''} ${p.tag} ${p.text ? `"${p.text.length > 28 ? p.text.slice(0, 27) + '…' : p.text}"` : ''}${image}`);
      if (p.lost) chip.append(el('span', 'lost-note', ' · 화면에서 찾을 수 없음'));
      const x = el('button', 'x', '×'); x.type = 'button'; x.title = '빼기';
      x.onclick = () => (source === 'viewer' ? viewer.pickRemove(p.id, w) : target.pickRemove(p.id));
      chip.append(x);
      chips.append(chip);
    });
    // Two windows picking at the same moment can pass the limit together: said here, and sending waits for one less.
    $('picks-over').hidden = all.length <= MAX_PICKS;
    $('picks-over').textContent = ` · ${all.length}개: 한 번에 ${MAX_PICKS}개까지 보낼 수 있습니다. ${all.length - MAX_PICKS}개를 빼 주세요.`;
    $('picks').hidden = !all.length;
    viewer.counts(pickCounts());
  }
  function clearPicks() { target.pickClear(); viewer.pickClear(); }
  $('picks-clear').onclick = () => clearPicks();

  const viewerPicking = () => [...viewerWins.values()].some(v => v.pickActive);
  function setPickMode(on, from = 'product') {
    if (from !== 'viewer') state.product.pickActive = on;
    const any = state.product.pickActive || viewerPicking();
    $('pick').classList.toggle('on', any);
    $('pick').textContent = any ? '고르는 중' : '고르기';
  }

  // ── the viewer popups: OHIF with the studio's viewer-studio.js (static.js adds it), in both layouts. They are
  // reached over the channel, not through window handles, so a refreshed or reopened chat still reloads and picks in
  // them. Each popup names itself (win): closing one drops only its own picks. ──
  const viewerWins = new Map(); // win -> { seen, pickActive }
  const viewer = (() => {
    const bc = channel();
    const post = message => { if (bc) bc.postMessage({ from: 'chat', ...message }); };
    if (bc) bc.onmessage = ({ data: m }) => {
      if (!m || m.from !== 'viewer') return;
      const w = typeof m.win === 'string' ? m.win : '';
      if (m.type === 'viewer-bye') {
        viewerWins.delete(w); pickSets.viewers.delete(w);
        setPicks(pickSets.product); setPickMode(state.product.pickActive);
        return;
      }
      const v = viewerWins.get(w) || { seen: 0, pickActive: false };
      viewerWins.set(w, v);
      v.seen = Date.now();
      if (Array.isArray(m.picks)) setPicks(m.picks, 'viewer', w);
      if ('pickActive' in m && !!m.pickActive !== v.pickActive) { v.pickActive = !!m.pickActive; setPickMode(state.product.pickActive); }
    };
    setInterval(() => post({ type: 'viewer-hb' }), 2000);
    post({ type: 'viewer-ping' });
    return {
      connected: () => [...viewerWins.values()].some(v => Date.now() - v.seen < 5000),
      reload: nonce => post({ type: 'viewer-reload', nonce }),
      pick: on => post({ type: 'viewer-pick', on }),
      pickRemove: (id, w) => post({ type: 'viewer-pick-remove', id, win: w }),
      pickClear: () => post({ type: 'viewer-picks-clear' }),
      // Read by the product window and every viewer popup (the same channel): how many the other windows hold.
      counts: counts => post({ type: 'pick-counts', counts }),
    };
  })();

  // 고르기 from the chat: every open product window picks. With the viewer open the product window is not brought
  // forward — it would cover the viewer popup he is about to pick in.
  function togglePick(on = !(state.product.pickActive || viewerPicking())) {
    if (viewer.connected()) {
      viewer.pick(on);
      if (target.connected()) target.pick(on, false);
      return;
    }
    target.pick(on);
  }

  // ── the product: in this window (overlay) or in the product window (two windows) ──
  let target;
  if (layout === 'overlay') target = overlayTarget();
  else target = productWindowTarget();

  function overlayTarget() {
    $('studio').classList.add('overlay');
    const mirror = window.StudioMirror($('mirror'), {
      onErrors: setErrors,
      onPending: ev => { $('mirror-banner').hidden = !ev; },
      onReloaded: noteReload,
      onWindow: win => win.addEventListener('keydown', keys, true),
      heldField: () => pick.heldField(),
    });
    let reopen = false;
    const pick = window.StudioPick($('mirror'), {
      room: () => MAX_PICKS - [...pickSets.viewers.values()].reduce((n, list) => n + list.length, 0),
      meta: () => ({ screen: $('screen').selectedOptions[0] && $('screen').selectedOptions[0].textContent, role: state.me && state.me.role }),
      onChange: setPicks,
      // Picking needs the whole product visible: the chat steps aside and comes back with the picks.
      onMode: on => {
        setPickMode(on);
        $('pick-local').classList.toggle('on', on);
        if (on) { reopen = overlayOpen(); setOverlay(false); } else if (reopen) setOverlay(true);
      },
    });
    $('pick-local').onclick = () => pick.toggle();
    $('apply-now').onclick = () => mirror.applyPending();
    const overlayOpen = () => $('studio').classList.contains('open');
    function setOverlay(open) {
      $('studio').classList.toggle('open', open);
      $('overlay-open').hidden = open;
      store.set('studio-overlay-open', open ? '1' : '0');
      if (open) input.focus();
    }
    $('overlay-open').onclick = () => setOverlay(true);
    $('overlay-close').onclick = () => setOverlay(false);
    setOverlay(store.get('studio-overlay-open', '1') === '1');
    function keys(e) {
      if (pick.onKey(e)) return;
      if (isShortcut(e, PICK_KEY)) { e.preventDefault(); e.stopPropagation(); pick.toggle(); }
      else if (isShortcut(e, CHAT_KEY)) { e.preventDefault(); e.stopPropagation(); setOverlay(!overlayOpen()); }
    }
    window.addEventListener('keydown', keys, true);
    $('preview-stop').onclick = () => stopPreview();
    $('preview-apply').onclick = () => { if (state.previewing) applySuggestion(state.previewing); };
    setInterval(() => { const now = mirror.typing(); if (now !== state.product.typing) { state.product.typing = now; typingChanged(); } }, 2000);
    return {
      show: () => setOverlay(false),
      preview: p => { $('preview-banner').hidden = !p; $('preview-title').textContent = p ? p.title : ''; },
      connected: () => true,
      open: (screen, role) => mirror.open(screenForRole(screen, role)),
      reload: ev => mirror.request(ev),
      manualReload: () => mirror.reload(),
      context: async () => mirror.context(),
      pick: on => pick.toggle(on),
      pickRemove: id => pick.remove(id),
      pickClear: () => pick.clear(),
    };
  }

  function productWindowTarget() {
    const bc = channel();
    const post = message => { if (bc) bc.postMessage({ from: 'chat', ...message }); };
    const replies = new Map();
    let ref = null;
    let pickWanted = 0; // when 고르기 was asked for with no product window: start it as soon as the window answers
    let linkHint = null; // { text, until }: a short note in the connection line
    if (bc) bc.onmessage = ({ data: m }) => {
      if (!m || m.from !== 'product') return;
      const p = state.product;
      p.seen = m.type === 'bye' ? 0 : Date.now();
      if (m.type !== 'bye' && pickWanted) {
        if (Date.now() - pickWanted < 30000) post({ type: 'pick', on: true });
        pickWanted = 0;
      }
      if ('page' in m) { p.page = m.page; p.study = m.study; }
      // The controls describe what the product window shows, whichever chat tab changed it.
      if (typeof m.screen === 'string' && [...$('screen').options].some(o => o.value === m.screen)) $('screen').value = m.screen;
      if (m.role && !roleChanging && [...$('role').options].some(o => o.value === m.role)) { roleSeq++; $('role').value = m.role; if (state.me) state.me.role = m.role; }
      if (m.type === 'focused' && !m.ok && m.ask === focusAsk) linkHint = { text: '제품 화면은 이미 열려 있습니다. "… — 스튜디오" 탭을 눌러 주세요.', until: Date.now() + 8000 };
      if (Array.isArray(m.errors)) setErrors(m.errors);
      if ('typing' in m && !!m.typing !== p.typing) { p.typing = !!m.typing; typingChanged(); }
      // Ended from the product window's banner (it reloads itself and the viewer).
      if (m.type === 'preview' && !m.id && state.previewing) { transitioned(); state.previewing = null; renderSuggestion(); }
      if (Array.isArray(m.picks)) setPicks(m.picks);
      if ('pickActive' in m) setPickMode(!!m.pickActive);
      if (m.type === 'pick-mode') setPickMode(m.on);
      if (m.type === 'reloaded') noteReload(m);
      if (m.type === 'context' && replies.has(m.ask)) { replies.get(m.ask)(m); replies.delete(m.ask); }
      paintLink();
    };
    // Heartbeat both ways; the product window answers a ping at once, so the status is right within a second.
    setInterval(() => { post({ type: 'hb' }); paintLink(); }, 2000);
    post({ type: 'ping' });

    function connected() { return Date.now() - state.product.seen < 5000; }
    function paintLink() {
      const on = connected();
      $('link-dot').classList.toggle('on', on);
      $('link-text').textContent = on && linkHint && Date.now() < linkHint.until ? linkHint.text
        : on ? `제품 화면 연결됨${state.product.page ? ' · ' + state.product.page.split('?')[0].split('/').pop() : ''}` : '제품 화면이 열려 있지 않습니다';
      $('open-product').textContent = on ? '제품 화면 앞으로' : '제품 화면 열기';
      $('open-product').classList.toggle('attention', !on);
    }

    // A fixed window name: an open product window is reused (and brought forward) instead of opening a second one.
    // No window features: the product is used in an ordinary Chrome tab (tab strip, bookmarks bar), so the studio
    // opens it the same way and shows the same height; he drags the tab to the landscape monitor and maximises it.
    // A product window this tab did not open (another chat tab, or this tab before a reload) answers on the channel
    // but window.open cannot reach it from here — it would open a second product window — so it is asked to come
    // forward itself, and if the browser does not allow that the chat says where it is.
    let focusAsk = '';
    function openProduct() {
      if (ref && !ref.closed) { try { ref.focus(); } catch { /* not ours */ } return ref; }
      if (connected()) {
        focusAsk = Math.random().toString(36).slice(2);
        post({ type: 'focus', ask: focusAsk });
        return null;
      }
      let w = null;
      try { w = window.open('', PRODUCT_WINDOW); } catch { w = null; }
      if (!w) { alert('브라우저가 새 창을 막았습니다. 주소창 오른쪽의 팝업 차단 표시에서 이 사이트를 허용해 주세요.'); return null; }
      let blank = false;
      try { blank = w.location.href === 'about:blank'; } catch { blank = false; }
      if (blank) w.location.href = '/studio/product.html';
      try { w.focus(); } catch { /* another window */ }
      ref = w;
      return w;
    }
    $('open-product').onclick = () => openProduct();
    paintLink();

    return {
      show: () => openProduct(),
      preview: p => post({ type: 'preview', id: p ? p.id : null, title: p ? p.title : '' }),
      connected,
      open: (screen, role) => post({ type: 'open', screen, role }),
      reload: (ev, nonce) => post({ type: 'reload', ev, nonce }),
      manualReload: () => post({ type: 'reload', ev: { reason: 'manual' }, nonce: `manual|${Date.now()}|${Math.random()}` }),
      // Ask the product window for its page and selected study right now; fall back to the last heartbeat.
      context: () => new Promise(resolve => {
        const fallback = { page: state.product.page, study: state.product.study, errors: state.errors.slice(-5) };
        if (!connected()) { resolve(fallback); return; }
        const ask = Math.random().toString(36).slice(2);
        const timer = setTimeout(() => { replies.delete(ask); resolve(fallback); }, 500);
        replies.set(ask, m => { clearTimeout(timer); resolve({ page: m.page, study: m.study, errors: (m.errors || []).slice(-5) }); });
        post({ type: 'context', ask });
      }),
      pick: (on, forward = true) => {
        if (!connected()) {
          if (on === false) return;
          pickWanted = openProduct() ? Date.now() : 0;
          return;
        }
        post({ type: 'pick', on });
        if (forward && (on === true || (on === undefined && !state.product.pickActive))) openProduct(); // bring it forward to pick in
      },
      pickRemove: id => post({ type: 'pick-remove', id }),
      pickClear: () => post({ type: 'picks-clear' }),
    };
  }

  // Alt+G from the chat window starts picking in the product (two windows) or here (overlay; handled above).
  if (layout === 'two') window.addEventListener('keydown', e => { if (isShortcut(e, PICK_KEY)) { e.preventDefault(); togglePick(); } });
  $('pick').onclick = () => togglePick();

  // ── chat ──
  function setMode(mode) {
    state.mode = mode;
    for (const b of document.querySelectorAll('.tabs button[data-mode]')) { b.classList.toggle('on', b.dataset.mode === mode); b.setAttribute('aria-selected', String(b.dataset.mode === mode)); }
    input.placeholder = PLACEHOLDER[mode];
  }
  for (const b of document.querySelectorAll('.tabs button[data-mode]')) b.onclick = () => setMode(b.dataset.mode);

  async function sendMessage() {
    const text = input.value.trim();
    if (!text) return;
    if (state.picks.length > MAX_PICKS) { alert(`고른 곳이 ${state.picks.length}개입니다. 한 번에 ${MAX_PICKS}개까지 보낼 수 있으니 ${state.picks.length - MAX_PICKS}개를 빼고 보내 주세요.`); return; }
    const product = await target.context();
    const picks = state.picks.map(({ id, ...rest }) => rest);
    const context = { page: product.page, study: product.study, errors: product.errors || [], picks,
      missing: state.missing.slice(-8).map(m => `${m.method} ${m.path}`) };
    input.value = '';
    typingChanged();
    try {
      await api('chat', { json: { mode: state.mode, text, context } });
      if (picks.length) clearPicks();
      endPreviewHere(); // the server ended this browser's preview: his own request is about his screen
    } catch (error) { input.value = text; alert('보내지 못했습니다: ' + error.message); }
  }
  input.addEventListener('input', () => typingChanged());
  $('composer').addEventListener('submit', e => { e.preventDefault(); sendMessage(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); }
  });

  // ── actions ──
  async function doUndo(sha, withLater = false) {
    try { await api('undo', { json: { ...(sha ? { sha } : {}), withLater } }); endPreviewHere(); refreshState(); }
    catch (error) {
      const body = error.body || {};
      if (body.code === 'later-changes' && body.later && !withLater) {
        const list = body.later.map(c => `- ${c.subject}`).join('\n');
        if (confirm(`${error.message}\n\n함께 되돌릴 변경:\n${list}\n\n모두 되돌릴까요?`)) return doUndo(sha, true);
        return;
      }
      alert(error.message + (body.errors && body.errors.length ? `\n\n${body.errors[0]}` : ''));
    }
  }
  $('undo').onclick = () => doUndo();
  $('reload').onclick = () => target.manualReload();
  // The role comes from the control, not from state.me: right after a chat reload the product window may answer
  // (and the role may be changed) before the first state read has finished.
  function openScreen(value, role = $('role').value || (state.me && state.me.role)) {
    store.set('studio-screen', value);
    target.open(value, role);
  }

  // The product never shows its viewer inside the worklist window: viewer-launch.js opens it as a sized popup
  // (popup=yes, the last viewer rectangle or the default one). The Viewer choice opens the same kind of window; the
  // product window keeps its screen. Reloads and picks reach the viewer over the channel (viewer above).
  let viewerRef = null;
  function openViewer() {
    if (viewerRef && !viewerRef.closed) { try { viewerRef.focus(); } catch { /* not ours */ } return; }
    const r = viewerRect();
    let w = null;
    try { w = window.open(VIEWER_URL, VIEWER_WINDOW, `popup=yes,width=${r.width},height=${r.height},left=${r.left},top=${r.top},resizable=yes,scrollbars=yes`); } catch { w = null; }
    if (!w) { alert('브라우저가 영상 창을 막았습니다. 주소창 오른쪽의 팝업 차단 표시에서 이 사이트를 허용해 주세요.'); return; }
    viewerRef = w;
  }
  $('screen').onchange = e => {
    if (e.target.value !== 'viewer') { openScreen(e.target.value); return; }
    e.target.value = productScreen(store.get('studio-screen', DEFAULT_SCREEN));
    openViewer();
  };
  // Admin opens the admin screen and leaving admin goes back to the worklist; otherwise the chosen screen stays
  // (clinician maps to its own home).
  // While the change is on its way, a product report from before it (a snapshot still naming the old role) must not
  // put the old role back: the screen opens with the role chosen here, and the product's next report agrees.
  $('role').onchange = async e => {
    const role = e.target.value;
    roleSeq++; roleChanging++;
    try {
      await api('role', { json: { role } }); roleSeq++; if (state.me) state.me.role = role;
      if (role === 'admin') $('screen').value = ADMIN_SCREEN;
      else if ($('screen').value === ADMIN_SCREEN) $('screen').value = DEFAULT_SCREEN;
      openScreen($('screen').value, role);
    } catch (error) { alert(error.message); }
    finally { roleChanging--; }
  };
  $('model').onchange = async e => {
    try { await api('model', { json: { choice: e.target.value } }); } catch (error) { alert(error.message); refreshState(); }
  };
  $('layout').value = layout;
  $('layout').onchange = e => { store.set('studio-layout', e.target.value); location.reload(); };
  $('logout').onclick = async () => { await api('logout', { method: 'POST' }).catch(() => {}); location.replace('/studio/login.html'); };

  const panel = $('panel');
  function openPanel(title, build) {
    $('panel-title').textContent = title;
    const body = $('panel-body');
    body.replaceChildren();
    build(body);
    if (!panel.open) panel.showModal();
  }
  $('panel-close').onclick = () => panel.close();

  async function showChange(sha) {
    const patch = await api('changes/' + sha);
    openPanel('변경 내용', body => body.append(el('pre', '', patch)));
  }

  async function showChanges() {
    const log = await api('changes');
    openPanel('적용한 변경 (최근 순)', body => {
      if (!log.length) { body.append(el('p', 'muted', '아직 적용한 변경이 없습니다.')); return; }
      const table = el('table');
      const head = el('tr'); for (const h of ['시각', '누가', '요청', '파일', '']) head.append(el('th', '', h));
      table.append(head);
      for (const c of log) {
        const tr = el('tr');
        tr.append(el('td', '', new Date(c.time).toLocaleString('ko-KR')), el('td', '', c.trailers['Studio-User'] || ''),
          el('td', '', (c.trailers['Studio-Kind'] === 'revert' ? '↩ ' : '') + c.subject + (c.reverted ? ' (되돌림)' : '')),
          el('td', '', c.files.filter(f => !/bundle\.js$|config\/ohif\.js$/.test(f)).map(f => f.split('/').pop()).join(', ')));
        const td = el('td');
        const view = el('button', '', '보기'); view.type = 'button'; view.onclick = () => showChange(c.sha); td.append(view);
        if (c.trailers['Studio-Kind'] === 'change' && !c.reverted) { const u = el('button', '', '되돌리기'); u.type = 'button'; u.onclick = () => { panel.close(); doUndo(c.sha); }; td.append(' ', u); }
        tr.append(td); table.append(tr);
      }
      body.append(table);
    });
  }
  $('changes').onclick = showChanges;

  function renderValue(value) {
    if (value === null || value === undefined) return el('span', 'muted', '—');
    if (typeof value !== 'object') return el('span', '', String(value));
    if (Array.isArray(value)) {
      if (!value.length) return el('span', 'muted', '없음');
      const ul = el('ul');
      for (const item of value) { const li = el('li'); li.append(renderValue(item)); ul.append(li); }
      return ul;
    }
    const box = el('div');
    for (const [k, v] of Object.entries(value)) {
      const line = el('div');
      const key = el('b', '', k + ': ');
      if (/eta|estimate|forecast/i.test(k)) key.append(el('span', 'tag est', '추정'));
      line.append(key, renderValue(v));
      box.append(line);
    }
    return box;
  }

  $('status').onclick = async () => {
    const view = await api('status');
    openPanel('개발 현황 (status.json)', body => {
      if (!view.present) { body.append(el('p', 'muted', view.message)); return; }
      body.append(el('p', view.overdue ? 'error' : 'muted', `발행 ${view.publishedAt} · ${view.ageHours}시간 전${view.overdue ? ' · 다음 예정 발행이 지났습니다(갱신 지연)' : ''}`));
      for (const [key, value] of Object.entries(view.status)) {
        if (['published_at', 'next_publication'].includes(key)) continue;
        body.append(el('h3', '', key));
        body.append(renderValue(value));
      }
    });
  };

  $('done').onclick = async () => {
    if (!confirm('오늘 요청과 변경을 정리해 지휘자에게 넘길까요? (계속 쓸 수 있습니다)')) return;
    try { const d = await api('digest', { method: 'POST' }); showDigest(d.day); } catch (error) { alert(error.message); }
  };
  async function showDigest(day) {
    const md = await api('digests/' + day);
    openPanel(`하루 인계 ${day}`, body => body.append(el('pre', '', md)));
  }
  $('digests').onclick = async () => {
    const days = await api('digests');
    openPanel('지난 인계', body => {
      if (!days.length) { body.append(el('p', 'muted', '아직 없습니다.')); return; }
      for (const day of days) { const b = el('button', '', day); b.type = 'button'; b.onclick = () => showDigest(day); body.append(b, ' '); }
    });
  };
  $('records').onclick = async () => {
    const list = await api('records');
    openPanel('이견·넘긴 질문', body => {
      if (!list.length) { body.append(el('p', 'muted', '아직 없습니다.')); return; }
      for (const r of list.slice().reverse()) {
        const box = el('div', 'record');
        box.append(el('div', 'muted', `${new Date(r.t).toLocaleString('ko-KR')} · ${r.user} · ${r.kind === 'disagreement' ? '이견' : r.kind === 'question' ? '넘긴 질문' : r.kind}`));
        box.append(renderValue(Object.fromEntries(Object.entries(r).filter(([k]) => !['t', 'user', 'kind', 'jobId', 'mode'].includes(k)))));
        body.append(box);
      }
    });
  };
  $('metrics').onclick = async () => {
    const list = await api('metrics');
    const reloads = new Map(list.filter(m => m.kind === 'reload-ready').map(m => [m.jobId, m]));
    openPanel('반영 시간 기록', body => {
      const table = el('table');
      const head = el('tr'); for (const h of ['시각', '요청', 'Claude', '빌드', '마지막 수정→신호', '화면 새로고침', '마지막 수정→화면 준비', '요청→신호']) head.append(el('th', '', h));
      table.append(head);
      const s = ms => (Number.isFinite(ms) ? (ms / 1000).toFixed(1) + '초' : '—');
      for (const m of list.filter(x => x.kind !== 'reload-ready' && x.changed).reverse()) {
        const t = m.timings || {}; const r = reloads.get(m.jobId);
        // A reload that hit the 30 s limit never showed the screen: say so instead of reporting it as a ready time.
        const timedOut = r && r.readyKind === 'timeout';
        const tr = el('tr');
        tr.append(el('td', '', new Date(m.t).toLocaleTimeString('ko-KR')), el('td', '', m.text), el('td', '', s(t.claudeMs)), el('td', '', s(t.buildMs)),
          el('td', '', s(t.lastEditToReloadSentMs)), el('td', timedOut ? 'error' : '', timedOut ? '시간 초과' : s(r && r.reloadMs)),
          el('td', timedOut ? 'error' : '', timedOut ? '준비 안 됨' : s(r && Number.isFinite(t.lastEditToReloadSentMs) ? t.lastEditToReloadSentMs + r.reloadMs : NaN)),
          el('td', '', s(t.totalToReloadSentMs)));
        table.append(tr);
      }
      body.append(table);
    });
  };
  $('claude').onclick = async () => {
    const s = await api('claude');
    openPanel('Claude 상태', body => body.append(renderValue(s)));
  };
  $('reset-mock').onclick = async () => {
    if (!confirm('합성 자료(초안·판독 상태)를 처음 상태로 되돌릴까요? 화면 코드 변경은 그대로입니다.')) return;
    await api('mock/reset', { method: 'POST' });
  };
  $('missing').onclick = () => openPanel('스튜디오에 가짜 응답이 없는 요청', body => {
    body.append(el('p', 'muted', '이 요청들은 501(스튜디오 미지원)로 답했습니다. 필요하면 바꾸기에서 "이 화면에 가짜 자료를 넣어 주세요"라고 말하면 됩니다.'));
    body.append(renderValue(state.missing.map(m => `${m.method} ${m.path}`)));
  });
  $('errors').onclick = () => openPanel('제품 화면의 JavaScript 오류', body => body.append(renderValue(state.errors)));

  // ── 스튜디오로 할 수 있는 것: example cards; a click fills the input (he presses send) or points at the control ──
  function flash(node) { node.classList.add('flash'); node.focus(); setTimeout(() => node.classList.remove('flash'), 2400); }
  const SHOWCASE = [
    { title: '가리키고 말하기', body: '고르기를 누르고 제품 화면이나 영상 창에서 버튼·칸·영상을 클릭한 뒤 "이거"라고 말하면 정확히 그것을 고칩니다. 클릭해도 그 버튼은 눌리지 않습니다.',
      mode: 'edit', text: '이거 조금 더 크게, 오른쪽 끝으로 옮겨 주세요', pick: true },
    { title: '여러 곳을 한 번에', body: '여러 개를 연달아 고르면 한 번에 같이 바꿉니다. 다시 클릭하면 빠지고, Esc는 모두 지웁니다.',
      mode: 'edit', text: '이것들을 같은 크기와 같은 색으로 맞춰 주세요', pick: true },
    { title: '모든 화면을 한꺼번에', body: '색·글꼴·글자 크기·간격을 Worklist, Clinician, Admin, Login 화면에 한 번에 적용합니다.',
      mode: 'edit', text: 'Worklist, Clinician, Admin, Login 화면 모두 기본 글자를 한 단계 키우고 줄 간격을 조금 넓혀 주세요' },
    { title: '예전 변경 하나만 되돌리기', body: '기록에서 아무 변경이나 골라 되돌립니다. 그 뒤에 쌓인 변경이 있으면 먼저 물어봅니다.',
      action: () => showChanges() },
    { title: '"왜 이렇게 되어 있어?"', body: '어느 화면이든 이유를 물으면 코드와 결정 기록에서 근거를 찾아 출처와 함께 답합니다. 근거가 없으면 "미확인"이라고 말합니다.',
      mode: 'ask', text: 'Related Report는 왜 지금처럼 동작해요? 근거(코드·결정)도 알려 주세요' },
    { title: '개발 현황 묻기', body: '작업 묶음, 날짜(추정은 추정이라고), 비용·사용량, 선생님 답을 기다리는 것을 현황 자료에서 답합니다. 자료에 없는 날짜는 지어내지 않고 지휘자에게 넘깁니다.',
      mode: 'ask', text: '제 피드백 12건은 지금 어디까지 왔어요? 저한테 답을 기다리는 것도 있어요?' },
    { title: '새 기능 시안을 바로', body: '없는 기능을 말하면 가짜 자료로 움직이는 시안을 그 자리에서 만들어 제품 화면에 띄웁니다. 실제 서버 작업은 지휘자 검토 뒤입니다.',
      mode: 'edit', text: 'Worklist 위쪽에 "오늘 내 판독" 개수를 보여 주는 작은 카운터를 새로 만들어 주세요. 가짜 자료로 시안만요' },
    { title: '역할 바꿔 보기', body: '역할을 임상의·관리자·기사로 바꾸면 그 사람이 보는 화면으로 바로 바뀝니다.',
      action: () => flash($('role')) },
    { title: '관리자 화면 둘러보기', body: '역할을 관리자로 바꾸고 Admin 화면을 엽니다. 회원 승인·역할·임시 비밀번호, 서명 키, 열람 제한, 게이트웨이, 운영 지표, 감사 기록을 합성 자료로 직접 눌러 볼 수 있습니다.',
      action: () => tryAdmin() },
    { title: 'AI가 근거를 대고 반대', body: '환자 안전이나 법에 걸리는 요청은 이유를 먼저 말하고, 같은 목적을 안전하게 이루는 대안을 만들어 보여 줍니다. 이견은 지휘자에게 기록됩니다.',
      mode: 'edit', text: 'Worklist에서 환자 이름(Name) 열을 없애 주세요. 공간이 아까워요' },
    { title: '먼저 제안하기', body: '쉬는 동안(입력·변경 중이 아닐 때) 스튜디오가 지금 화면·최근 요청·선생님 피드백을 보고 개선안이나 비판 하나를 근거와 함께 미리 만들어 둡니다. "제안: …" 줄에서 미리보기(한 번 누르면 제품 화면에 바로), 적용(기록에 남고 되돌리기 가능), 다른 제안, 됐어요. 넘긴 제안은 다시 내지 않고, 모든 제안과 답은 하루 인계에 실립니다.',
      action: () => askSuggestion() },
    { title: '하루 인계', body: '"오늘 끝"을 누르면(또는 1시간 쉬면) 오늘 요청·변경·이견·넘긴 질문이 정리되어 지휘자가 가져갑니다.',
      action: () => flash($('done')) },
  ];
  // The product window is opened inside the click (a later open would be blocked); a window that loads before the
  // role change lands still gets the admin screen from the remembered screen and the open message that follows.
  function tryAdmin() {
    store.set('studio-screen', ADMIN_SCREEN);
    $('screen').value = ADMIN_SCREEN;
    target.show();
    $('role').value = 'admin';
    $('role').onchange({ target: $('role') });
  }

  function showShowcase() {
    openPanel('스튜디오로 할 수 있는 것', body => {
      body.append(el('p', 'muted', '카드를 누르면 예시 문장이 입력칸에 들어갑니다. 고쳐서 보내기만 누르세요. 마음에 안 들면 언제든 되돌리기.'));
      const grid = el('div', 'cards');
      for (const card of SHOWCASE) {
        const b = el('button', 'card'); b.type = 'button';
        b.append(el('strong', '', card.title), el('span', '', card.body));
        if (card.text) b.append(el('em', '', `"${card.text}"`));
        b.onclick = () => {
          panel.close();
          if (card.action) { card.action(); return; }
          setMode(card.mode);
          input.value = card.text;
          input.focus();
          if (card.pick) togglePick(true);
        };
        grid.append(b);
      }
      body.append(grid);
    });
  }
  $('showcase').onclick = showShowcase;

  // ── 먼저 제안하기: one suggestion at a time, shown only while nobody types in any studio tab and no request is
  // queued or running: the server's queue and typing tabs (sent with the first event, every snapshot and every
  // change), plus this tab's own typing, which it knows before the server does ──
  function typingNow() { return !!input.value.trim() || !!state.product.typing; }
  function studioBusy() {
    const a = state.activity;
    return typingNow() || a.pending > 0 || a.typing.some(tab => tab !== TAB);
  }
  // Server snapshots carry the server's change number: one older than what this tab already shows is dropped.
  function fresh(rev) {
    if (typeof rev !== 'number') return true;
    if (rev < state.rev) return false;
    state.rev = rev;
    return true;
  }
  // A snapshot asked for before this tab's own preview, answer or apply finished is older than it (the server answers
  // in any order): only the newest request may apply its answer (review d90ea5f F7: a late presence answer brought a
  // declined card back).
  let snapSeq = 0, appliedSeq = 0;
  function transitioned() { appliedSeq = ++snapSeq; }
  async function readSuggestions(request) {
    const mine = ++snapSeq;
    const s = await request();
    if (mine < appliedSeq) return;
    appliedSeq = mine;
    applySuggestionState(s);
  }
  let lastTyping = null;
  function typingChanged() {
    renderSuggestion();
    if (typingNow() !== lastTyping) reportPresence();
  }
  async function reportPresence() {
    lastTyping = typingNow();
    const product = state.product;
    try {
      await readSuggestions(() => api('presence', { json: { tab: TAB, typing: lastTyping, page: product.page || '', study: product.study || '', role: $('role').value } }));
    } catch { /* the next report */ }
  }
  function applySuggestionState(s) {
    if (!s || !fresh(s.rev)) return;
    if (s.activity) state.activity = s.activity;
    state.suggestion = s.current && ['ready', 'preparing'].includes(s.current.status) ? s.current : null;
    if (state.previewing && s.previewing !== state.previewing) endPreviewHere();
    else if (s.previewing && state.suggestion && !state.previewing) {
      state.previewing = s.previewing; // opened in another tab of this browser, or before a reload
      target.preview({ id: state.suggestion.id, title: state.suggestion.title });
    }
    renderSuggestion();
  }
  function suggestionEvent(ev) {
    const item = ev.item;
    if (!item || !fresh(ev.rev)) return;
    if (ev.activity) state.activity = ev.activity;
    if (['ready', 'preparing'].includes(item.status)) {
      state.suggestion = item;
      if (item.status === 'ready') state.suggestAsked = false;
      // Rebuilt on top of a change made meanwhile: the preview on screen (product and viewer) is the old one.
      if (ev.rebased && state.previewing === item.id) reloadBoth({ reason: 'preview-rebased' }, `preview-rebased|${item.id}|${ev.rev}`);
    } else {
      if (state.suggestion && state.suggestion.id === item.id) state.suggestion = null;
      if (state.previewing === item.id) endPreviewHere();
      if (state.suggestAsked && ['none', 'failed'].includes(item.status)) {
        state.suggestAsked = false;
        $('suggest-wait').textContent = item.status === 'none' ? '지금은 근거 있는 제안이 없어요. 화면을 더 쓰시면 다시 찾아볼게요.'
          : `제안을 만들지 못했어요(${item.error || '오류'}). 하루 인계에 기록했습니다.`;
        $('suggest-wait').hidden = false;
        setTimeout(() => { if (!state.suggestAsked) $('suggest-wait').hidden = true; }, 8000);
      }
    }
    renderSuggestion();
  }
  const GROUND = { screen: '화면', feedback: '피드백', practice: '판독 관행' };
  function renderSuggestion() {
    const s = state.suggestion;
    const ready = !!s && s.status === 'ready';
    // Never while anyone types or a request runs (D5), also during a preview: its banner in the product window keeps
    // 원래대로 and 적용 reachable.
    const show = ready && !studioBusy();
    $('suggest').hidden = !show;
    if (state.suggestAsked && !ready) { $('suggest-wait').textContent = '다음 제안을 준비하고 있어요…'; $('suggest-wait').hidden = false; }
    else if (ready) $('suggest-wait').hidden = true;
    if (!show) return;
    $('suggest-title').textContent = s.title;
    $('suggest-title').title = s.title;
    const grounds = (s.grounds || []).map(g => `- ${GROUND[g.kind] || g.kind} ${g.ref}${g.quote ? ` "${g.quote}"` : ''}`);
    $('suggest-detail').textContent = `${s.kind === 'critique' ? '[비판] ' : ''}${s.why || ''}\n근거:\n${grounds.join('\n')}`
      + (s.files && s.files.length ? `\n바뀌는 파일: ${s.files.map(f => f.split('/').pop()).join(', ')}` : '');
    const previewing = state.previewing === s.id;
    $('suggest-preview').textContent = previewing ? '원래대로' : '미리보기';
    $('suggest-preview').classList.toggle('on', previewing);
    if (!state.seen.has(s.id)) { state.seen.add(s.id); api(`suggestions/${s.id}/seen`, { json: {} }).catch(() => {}); }
  }
  $('suggest-why').onclick = () => { $('suggest-detail').hidden = !$('suggest-detail').hidden; };
  $('suggest-preview').onclick = () => (state.previewing ? stopPreview() : startPreview());
  $('suggest-apply').onclick = () => { if (state.suggestion) applySuggestion(state.suggestion.id); };
  $('suggest-next').onclick = () => answerSuggestion('skipped');
  $('suggest-no').onclick = () => answerSuggestion('declined');

  async function startPreview() {
    const s = state.suggestion;
    if (!s || s.status !== 'ready') return;
    const clicked = Date.now();
    try { await api(`suggestions/${s.id}/preview`, { json: {} }); } catch (error) { alert(error.message); return; }
    transitioned();
    state.previewing = s.id;
    target.preview({ id: s.id, title: s.title });
    renderSuggestion();
    $('suggest-note').textContent = '미리보기 여는 중…';
    // An open viewer is served from the preview copy too (config/ohif) once it reloads.
    viewer.reload(`preview|${s.id}|${clicked}`);
    if (target.connected()) {
      state.previewClick = { id: s.id, clicked };
      target.reload({ reason: 'preview' }, `preview|${s.id}|${clicked}`);
    } else { $('suggest-note').textContent = ''; target.show(); } // the product window opens on the preview (its banner says so)
  }
  // The product window and an open viewer show the same copy: both reload when it changes.
  function reloadBoth(ev, nonce) { target.reload(ev, nonce); viewer.reload(nonce); }
  // The product window reports the preview's screen as usable: click -> usable is what he waits for.
  function previewShown(info) {
    const click = state.previewClick;
    if (!click) return;
    state.previewClick = null;
    const clickToReadyMs = Date.now() - click.clicked;
    $('suggest-note').textContent = info.readyKind === 'timeout' ? '미리보기 화면 준비 시간 초과' : `미리보기 ${(clickToReadyMs / 1000).toFixed(1)}초`;
    api(`suggestions/${click.id}/preview-ready`, { json: { clickToReadyMs, reloadMs: info.reloadMs, readyKind: info.readyKind } }).catch(() => {});
  }
  async function stopPreview() {
    await api('suggestions/preview/stop', { method: 'POST' }).catch(() => {});
    endPreviewHere();
  }
  // The server has already cleared (or no longer honours) this browser's preview: show the real screen again.
  function endPreviewHere() {
    if (!state.previewing) return;
    transitioned();
    state.previewing = null;
    state.previewClick = null;
    $('suggest-note').textContent = '';
    target.preview(null);
    reloadBoth({ reason: 'preview-end' }, `preview-end|${Date.now()}|${Math.random()}`);
    renderSuggestion();
  }
  async function applySuggestion(id) {
    $('suggest-apply').disabled = true;
    try {
      const r = await api(`suggestions/${id}/apply`, { json: {} });
      transitioned();
      const wasPreviewing = state.previewing === id;
      state.previewing = null; state.previewClick = null; $('suggest-note').textContent = '';
      target.preview(null);
      // Applied from the preview: the studio's reload event shows it. Rebuilt as an edit: leave the preview now.
      if (r.via === 'edit') {
        if (wasPreviewing) reloadBoth({ reason: 'preview-end' }, `preview-end|${Date.now()}|${Math.random()}`);
        renderEntry({ role: 'system', mode: 'edit', t: new Date().toISOString(), text: '그사이 화면이 바뀌어 미리 만든 그대로는 맞지 않습니다. 같은 제안을 지금 화면에 다시 만들고 있습니다.' });
      }
    } catch (error) { alert(error.message); }
    finally { $('suggest-apply').disabled = false; renderSuggestion(); }
  }
  async function answerSuggestion(answer) {
    const s = state.suggestion;
    if (!s) return;
    try {
      await api(`suggestions/${s.id}/answer`, { json: { answer } });
      transitioned();
      if (answer === 'skipped') state.suggestAsked = true;
      // Answered here: gone from this card now, whatever the event stream or an older snapshot says later.
      if (state.suggestion && state.suggestion.id === s.id) state.suggestion = null;
      endPreviewHere();
    } catch (error) { alert(error.message); }
    renderSuggestion();
  }
  async function askSuggestion() {
    if (state.suggestion && state.suggestion.status === 'ready') { renderSuggestion(); if (!$('suggest').hidden) flash($('suggest')); return; }
    state.suggestAsked = true;
    renderSuggestion();
    try { await readSuggestions(() => api('suggestions/next', { json: {} })); } catch (error) { alert(error.message); }
  }

  // A state answer carries the role as it was when the request started; a role the product window reported or he
  // chose meanwhile (another tab may have changed it) is newer and stays.
  let roleSeq = 0, roleChanging = 0;
  async function refreshState() {
    const seq = roleSeq;
    const s = await api('state');
    reportPresence();
    if (seq !== roleSeq && state.me) s.role = state.me.role;
    state.me = s;
    $('who').textContent = s.displayName;
    $('role').value = s.role;
    $('undo').disabled = !s.sandbox.undoable;
    if (s.claude.choice) $('model').value = s.claude.choice;
    return s;
  }

  (async () => {
    setMode('edit');
    const s = await refreshState();
    const screen = productScreen(store.get('studio-screen', DEFAULT_SCREEN));
    $('screen').value = screen;
    if (layout === 'overlay') target.open(screen, s.role);
    const history = await api('history');
    for (const entry of history) renderEntry(entry);
    connect();
    await readSuggestions(() => api('suggestions')).catch(() => {});
    setInterval(() => refreshState().catch(() => {}), 30000);
    if (!history.length) {
      renderEntry({ role: 'system', mode: 'edit', t: new Date().toISOString(), text: layout === 'two'
        ? '"제품 화면 열기"를 누르면 제품 화면이 새 탭으로 열립니다(실제 제품처럼 탭·북마크바가 있는 보통 Chrome 창). 그 탭을 가로 모니터로 끌어다 놓고 최대화하세요. 여기 바꾸기에서 "이 버튼을 오른쪽으로" 처럼 말하거나, 고르기로 화면을 찍고 "이거"라고 말하면 몇 초~1분 안에 제품 화면이 바뀝니다. 마음에 안 들면 되돌리기. 물어보기에서는 제품과 개발 현황을 물을 수 있습니다.'
        : '제품 화면 위에 대화가 겹쳐 열립니다(Alt+S로 열고 닫기, 제품 화면 크기는 그대로). 바꾸기에서 말하거나 고르기로 화면을 찍고 "이거"라고 말하면 제품 화면이 바뀝니다. 마음에 안 들면 되돌리기.' });
    }
    // First visit of this person in this browser: show what the studio can do.
    const seenKey = `studio-showcase-seen:${s.user}`;
    if (!store.get(seenKey)) { store.set(seenKey, '1'); showShowcase(); }
  })().catch(error => { if (error.message !== 'login') alert('스튜디오를 열지 못했습니다: ' + error.message); });
})();
