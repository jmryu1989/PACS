/* Image Findings in the worklist and Reading Workspace (S2-B1). Read-only: create/edit/hide stay in
 * the viewer's Findings section and nothing here writes a report. All decisions live in
 * finding-command.js; this file reads the worklist session and the target documents (every
 * cross-window read guarded) and renders with textContent. Control names English, messages Korean. */
window.KinReadingFindings = function (app) {
  'use strict';
  const command = window.kinFindingCommand;
  const header = document.querySelector('#reltabs'), region = document.querySelector('.related-p');
  if (!command || !header || !region) throw new Error('Image Findings unavailable');
  const node = (tag, value, parent) => { const el = document.createElement(tag); if (value) el.textContent = value; if (parent) parent.append(el); return el; };
  const button = (label, run, parent) => { const b = node('button', label, parent); b.type = 'button'; b.addEventListener('click', run); return b; };
  const toggle = button('Image Findings', () => show(panel.hidden), null);
  toggle.id = 'reading-findings-open'; toggle.setAttribute('aria-controls', 'reading-findings'); toggle.setAttribute('aria-expanded', 'false');
  toggle.title = '선택한 판독 대상 검사의 영상 소견(읽기 전용)과 영상 이동';
  header.append(toggle);
  // A fixed panel inside the related region: it follows that region's visibility and inertness
  // and never changes the related list, report or viewer geometry.
  const panel = node('section', '', region); panel.id = 'reading-findings'; panel.hidden = true;
  panel.setAttribute('aria-labelledby', 'reading-findings-title');
  const title = node('strong', 'Image Findings', panel); title.id = 'reading-findings-title';
  const close = button('Close Image Findings', () => { show(false); toggle.focus(); }, panel); close.id = 'reading-findings-close';
  node('p', '선택한 판독 대상 검사에 저장된 소견입니다(읽기 전용). 작성·수정·숨김은 영상 화면의 Findings에서 하며 판독문에는 기록되지 않습니다.', panel);
  const status = node('p', '', panel); status.id = 'reading-findings-status'; status.setAttribute('role', 'status');
  const controls = node('p', '', panel);
  const reload = button('Reload Findings', () => { sync(); if (live()) store.load(); }, controls);
  const hiddenLabel = node('label', '', controls);
  const hiddenBox = node('input', '', hiddenLabel); hiddenBox.type = 'checkbox'; hiddenBox.id = 'reading-findings-hidden';
  hiddenLabel.append(document.createTextNode(' Show Hidden'));
  hiddenBox.addEventListener('change', () => { sync(); if (live() && store.state().uid) store.includeHidden(hiddenBox.checked); else render(); });
  const readiness = node('p', '', panel); readiness.id = 'reading-findings-target';
  const result = node('p', '', panel); result.id = 'reading-findings-nav'; result.setAttribute('role', 'status'); result.dataset.result = '';
  const recovery = node('p', '', panel); recovery.id = 'reading-findings-recovery'; recovery.hidden = true;
  const openImage = button('Open Image', openViewer, recovery);
  const retry = button('Retry Go to Image', () => { if (last) go(last.id, last.index, last); }, recovery);
  node('p', 'Current·Revised·Hidden·Missing은 저장된 표식과의 DB 연결 상태이며 영상 원본 확인 결과가 아닙니다. 수치는 연결 당시 서버 사본입니다.', panel);
  const list = node('section', '', panel); list.id = 'reading-findings-list'; list.setAttribute('aria-label', 'Image Findings List');
  panel.addEventListener('keydown', e => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); show(false); toggle.focus(); } });

  let ended = false, last = null, shownRows = null, retryShown = false, lastFocusLoad = 0, labels = 0;
  const guarded = (fn, fallback) => { try { return fn(); } catch (_) { return fallback; } };
  const owner = () => guarded(() => app.owner() || null, null);
  const sub = () => guarded(() => app.sub() || null, null);
  const current = () => guarded(() => app.current() || null, null);
  const live = () => !ended && guarded(() => app.allowed() === true, false) && !!owner() && !!sub();
  const store = command.createListStore({ fetch: path => app.api('GET', path), changed: () => render() });
  const commands = command.createNavigator({ timeoutMs: 15000 });

  function show(open) {
    if (ended && open) return;
    panel.hidden = !open; toggle.setAttribute('aria-expanded', String(!!open));
    if (open) { sync(); const st = store.state(); if (st.uid && st.status === 'idle') store.load(); }
    render();
  }
  // Selection and session follow the worklist; a change drops any in-flight command and its message.
  function sync() {
    if (ended) return;
    const ok = live();
    if (store.context(ok ? owner() : null, ok ? current() : null)) {
      commands.cancel(); last = null; setResult('', '', false);
      if (!panel.hidden && store.state().uid) store.load();
    }
  }
  function setResult(message, state, canRetry) {
    result.textContent = message; result.dataset.result = state; retryShown = !!canRetry;
    renderRecovery();
  }

  /* ---------- reading the documents ---------- */
  function modalIn(doc) {
    return [...doc.querySelectorAll('dialog[open],.modal.show,[role="dialog"][aria-modal="true"]')].some(el => el.getClientRects().length > 0);
  }
  function viewerFacts(w, doc) {
    const state = w.kinViewerHistoryState, h = typeof state === 'function' ? state.call(w) : null;
    return { historyPresent: !!h && typeof h === 'object', ended: !!h && h.ended === true, suspended: !!h && h.suspended === true,
      subject: h && typeof h.subject === 'string' ? h.subject : null, modal: modalIn(doc), navigate: typeof w.kinViewerHistoryNavigate === 'function' };
  }
  function sessionView() {
    const st = store.state();
    return { error: false, live: live(), owner: owner(), sub: sub(), uid: st.uid, selection: current(), generation: st.generation };
  }
  const windows = () => guarded(() => { const rows = app.windows(); return Array.isArray(rows) ? rows : []; }, []);
  const windowOwner = popup => guarded(() => { const fn = popup.kinViewerWindowOwner; return typeof fn === 'function' ? fn.call(popup) : null; }, null);
  const scopeOf = href => guarded(() => window.KinViewerWindows.scope(href, location.origin), null);
  function embeddedView(frame) {
    const view = sessionView();
    try {
      const t = app.workspace.viewerTarget();
      if (!t || t.frame !== frame) return { ...view, error: true };
      return { ...view, kind: 'embedded', ref: frame, window: t.window, document: t.document, scope: t.studies.join(','), attached: true, closed: false,
        visible: !!(t.active && t.sameTarget && t.loaded && !t.inert && !t.hidden), windowOwner: null, ...viewerFacts(t.window, t.document) };
    } catch (_) { return { ...view, error: true }; }
  }
  function windowView(popup, index) {
    const view = sessionView();
    try {
      if (popup.closed) return { ...view, kind: 'window', ref: popup, closed: true, error: true };
      const doc = popup.document, scope = scopeOf(popup.location.href), row = windows().find(r => r.popup === popup);
      return { ...view, kind: 'window', ref: popup, window: popup, document: doc, scope: scope ? scope.studies.join(',') : null,
        attached: !!row && row.index === index && !row.pending, closed: false, visible: true, windowOwner: windowOwner(popup), ...viewerFacts(popup, doc) };
    } catch (_) { return { ...view, error: true }; }
  }
  // The viewer function is read from the target document at the moment of the call (review C6).
  function invokeIn(w, target) {
    const navigate = w.kinViewerHistoryNavigate;
    if (typeof navigate !== 'function') return { ok: false, reason: 'tool-missing' };
    return navigate.call(w, target);
  }
  // Plain snapshot for chooseTarget plus the live references behind it.
  function choose(study) {
    const plain = { uid: study, workspace: null, windows: [] }, popups = new Map(), slots = new Map();
    const t = guarded(() => app.workspace.viewerTarget(), null);
    if (t) plain.workspace = { active: !!t.active, sameTarget: !!t.sameTarget, loaded: !!t.loaded, inert: !!t.inert, hidden: !!t.hidden, studies: [...t.studies] };
    for (const row of windows()) {
      const scope = row && row.scope, entry = { index: row.index, attached: !!row.popup, closed: false, pending: !!row.pending,
        ready: false, owner: 'unknown', studies: scope && Array.isArray(scope.studies) ? [...scope.studies] : [] };
      if (row.popup) {
        entry.closed = guarded(() => row.popup.closed === true, true);
        entry.ready = !!(row.status && row.status.kind === 'viewer' && row.status.ready === true);
        const bound = windowOwner(row.popup);
        entry.owner = typeof bound !== 'string' || !bound ? 'unknown' : bound === owner() ? 'match' : 'other';
        popups.set(row.index, row.popup);
      } else if (scope) slots.set(row.index, scope);
      plain.windows.push(entry);
    }
    const choice = command.chooseTarget(plain);
    if (choice.kind === 'embedded') {
      const frame = t.frame;
      return { kind: 'embedded', label: '통합 작업공간', probe: () => embeddedView(frame), invoke: target => invokeIn(frame.contentWindow, target),
        focus: () => guarded(() => { frame.focus(); frame.contentWindow.focus(); }) };
    }
    if (choice.kind === 'window') {
      const popup = popups.get(choice.index), index = choice.index;
      return { kind: 'window', index, label: '영상 창 ' + (index + 1), probe: () => windowView(popup, index), invoke: target => invokeIn(popup, target),
        focus: () => guarded(() => popup.focus()) };
    }
    return choice.reason === 'unattached' ? { ...choice, slot: slots.get(choice.index) || null } : choice;
  }

  /* ---------- commands ---------- */
  // A retry passes the pin of the source first pressed; a reloaded row that no longer matches it is list-changed.
  async function go(id, index, pinned) {
    sync();
    const st = store.state(), row = st.rows.find(r => r.id === id), pin = command.pinSource(row, index, st.generation);
    const source = pin && (!pinned || command.samePin(pinned, pin)) ? row.sources[index] : null;
    last = source ? pin : null;
    setResult('영상 이동 중… 결과를 확인하고 있습니다.', 'pending', false);
    await commands.run({
      expected: { owner: live() ? owner() : null, sub: sub(), uid: st.uid, generation: st.generation },
      source: source || null,
      choose: () => choose(st.uid),
      announce: (value, choice) => {
        if (value.ok) { setResult(command.arrivalText(value, choice.label), 'ok', false); choice.focus(); }
        else setResult(command.reasonText(value.reason), value.reason, command.retryable(value.reason));
        renderReadiness();
      },
    });
  }
  // Only the existing open/re-attach paths; the user presses Go to Image again afterwards.
  function openViewer() {
    sync();
    const st = store.state();
    if (!live() || !st.uid || st.uid !== current()) { render(); return; }
    const choice = guarded(() => choose(st.uid), null);
    if (!choice || choice.kind !== 'refused' || !command.openable(choice.reason)) { renderReadiness(); return; }
    if (choice.reason === 'unattached' && choice.slot) app.popup(choice.slot.studies[0], choice.slot.studies[1] || null, choice.slot.series ?? null);
    else app.open(st.uid);
    setResult('영상 화면 열기를 요청했습니다. 영상이 표시되면 Go to Image를 다시 누르세요. 자동으로 이동하지 않습니다.', 'opening', false);
    renderReadiness();
  }

  /* ---------- rendering ---------- */
  function renderRecovery() {
    const st = store.state(), usable = live() && !!st.uid && !panel.hidden;
    const target = usable ? guarded(() => choose(st.uid), null) : null;
    openImage.hidden = !(target && target.kind === 'refused' && command.openable(target.reason));
    retry.hidden = !(usable && retryShown && last);
    recovery.hidden = openImage.hidden && retry.hidden;
    return target;
  }
  function renderReadiness() {
    const target = renderRecovery(), value = target ? command.readinessText(target) : '';
    if (readiness.textContent !== value) readiness.textContent = value;
    readiness.dataset.target = target ? (target.kind === 'refused' ? target.reason : target.kind) : '';
  }
  function rebuild(rows) {
    const active = document.activeElement, key = active && list.contains(active) ? active.dataset.focusKey : null;
    shownRows = rows; list.replaceChildren();
    let refocus = null;
    for (const row of rows) {
      const article = node('article', '', list); article.dataset.findingId = row.id; article.dataset.hidden = String(row.hidden);
      const heading = node('p', '', article); heading.className = 'reading-findings-title'; heading.id = 'reading-findings-label-' + (++labels);
      node('strong', row.title || '(제목 없음)', heading);
      if (row.text) node('p', row.text, article).className = 'reading-findings-text';
      node('p', (row.author || '작성자 미확인') + ' · r' + row.revision + ' · ' + row.updated + (row.hidden ? ' · Hidden' : ''), article).className = 'reading-findings-meta';
      const sources = node('ul', '', article); sources.dataset.kinSources = '';
      row.sources.forEach((s, i) => {
        const item = node('li', '', sources); item.dataset.itemId = s.itemId; item.dataset.linkState = s.linkState;
        const label = node('span', (i === row.primary ? '★ ' : '') + s.description + ' · ', item); label.id = 'reading-findings-label-' + (++labels);
        const badge = node('strong', s.linkLabel, item); badge.dataset.kinLinkState = s.linkState;
        if (s.linkState === 'revised' && s.headRevision) node('span', ' (현재 r' + s.headRevision + ')', item);
        if (s.linkState !== 'current') node('span', ' · ' + s.linkText, item);
        if (s.foreign) node('span', ' · 다른 검사의 영상이라 이 목록에서 이동하지 않습니다.', item);
        const target = button('Go to Image', () => go(row.id, i), item);
        target.dataset.focusKey = row.id + ':' + i; target.setAttribute('aria-describedby', heading.id + ' ' + label.id);
        if (target.dataset.focusKey === key) refocus = target;
      });
      const primary = button('Go to Primary Image', () => go(row.id, row.primary), article);
      primary.dataset.focusKey = row.id + ':primary'; primary.setAttribute('aria-describedby', heading.id);
      if (primary.dataset.focusKey === key) refocus = primary;
    }
    if (refocus) refocus.focus({ preventScroll: true });
    else if (key && list.contains(active) === false && active && !active.isConnected) toggle.focus({ preventScroll: true });
  }
  function render() {
    const st = store.state();
    if (!ended && !live() && st.uid) { sync(); return; }
    const usable = live() && !!st.uid;
    status.textContent = ended ? '로그인이 종료되었습니다. 다시 로그인한 뒤 확인하세요.' : !live() ? '로그인과 서버 연결을 확인한 뒤 소견을 확인하세요.' : st.message;
    panel.dataset.studyUid = usable ? st.uid : ''; panel.dataset.state = ended ? 'ended' : st.status;
    reload.disabled = !usable || st.loading;
    hiddenBox.disabled = !usable; hiddenBox.checked = st.includeHidden;
    toggle.disabled = ended;
    if (st.rows !== shownRows) rebuild(st.rows);
    renderReadiness();
  }

  /* ---------- lifecycle ---------- */
  const onFocus = () => {
    if (panel.hidden || !live()) return;
    sync();
    const st = store.state();
    if (!st.uid || st.loading || Date.now() - lastFocusLoad < 15000) return;
    lastFocusLoad = Date.now(); store.load();
  };
  window.addEventListener('focus', onFocus);
  // While open, readiness follows the viewers and an offline or expired worklist session clears the rows.
  const timer = setInterval(() => { if (!panel.hidden && !ended) render(); }, 1000);
  // Session invalidation clears rows and drops every in-flight list read and command at once.
  function end() {
    if (ended) return;
    ended = true; commands.cancel(); store.end(); last = null; clearInterval(timer);
    window.removeEventListener('focus', onFocus); channel?.close();
    setResult('', '', false); render();
  }
  let channel;
  try { channel = new BroadcastChannel('kin-session'); channel.onmessage = e => { if (e.data?.type === 'session-ended') end(); }; } catch (_) {}
  window.addEventListener('storage', e => { if (e.key === 'kin-session-ended') end(); });
  window.addEventListener('pagehide', end);
  render();
  return { sync, end, open: () => show(true), close: () => show(false) };
};
