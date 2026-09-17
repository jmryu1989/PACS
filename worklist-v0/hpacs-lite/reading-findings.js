/* Image Findings in the worklist and Reading Workspace (S2-B1). Read-only: create/edit/hide stay in
 * the viewer's Findings section and nothing here writes a report. All decisions live in
 * finding-command.js; this file reads the worklist session and the target documents (every
 * cross-window read guarded) and renders with textContent. Control names English, messages Korean. */
window.KinReadingFindings = function (app) {
  'use strict';
  const command = window.kinFindingCommand, links = window.kinFindingLinkModel;
  const header = document.querySelector('#reltabs'), region = document.querySelector('.related-p');
  if (!command || !links || !header || !region) throw new Error('Image Findings unavailable');
  // S2-L: this panel, its command module and the link model must be the same record-format version.
  if (links.SCHEMA !== 2 || command.SCHEMA !== 2) throw new Error(links.MODULE_MISMATCH_TEXT || '화면 구성 요소 판이 다릅니다. 새로고침하세요.');
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
  node('p', '선택한 판독 대상 검사에 저장된 소견입니다(읽기 전용). 작성·수정·숨김은 영상 화면의 Findings에서 하며 판독문에는 기록되지 않습니다. ' +
    '같은 환자의 비교 검사 하나의 표식을 함께 연결한 소견은 그 비교 검사를 볼 수 있을 때만 표시됩니다.', panel);
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

  let ended = false, last = null, shownRows = null, retryShown = false, lastFocusLoad = 0, labels = 0, oldApi = false;
  const guarded = (fn, fallback) => { try { return fn(); } catch (_) { return fallback; } };
  const owner = () => guarded(() => app.owner() || null, null);
  const sub = () => guarded(() => app.sub() || null, null);
  const current = () => guarded(() => app.current() || null, null);
  const live = () => !ended && guarded(() => app.allowed() === true, false) && !!owner() && !!sub();
  // R5: the list read names the record format this panel reads (the worklist's shared request function has no header option),
  // same-origin like the viewer's findings reads. A 401 is handed to that shared function, which ends the session as it always
  // does. Only a successful answer without the API's own header marks an older API; this panel never writes either way.
  async function listRead(path) {
    const response = await fetch('/api' + path, { method: 'GET', credentials: 'same-origin', cache: 'no-store',
      headers: { 'X-KIN-CSRF': '1', [links.SCHEMA_HEADER]: String(links.SCHEMA) } });
    if (response.status === 401) return app.api('GET', path);
    const data = await response.json().catch(() => null);
    if (!response.ok || !data) throw { status: response.status, code: data && data.code };
    oldApi = links.schemaOf(response) !== String(links.SCHEMA);
    return data;
  }
  const store = command.createListStore({ fetch: listRead, changed: () => render() });
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
    // historyScope/image are the comparison arrival readback (S2-B2), copied as primitives, never identity facts.
    const shown = links.plainState(h);
    const location = w.kinViewerJobLocation;
    return { historyPresent: !!h && typeof h === 'object', ended: !!h && h.ended === true, suspended: !!h && h.suspended === true,
      subject: h && typeof h.subject === 'string' ? h.subject : null, modal: modalIn(doc), navigate: typeof w.kinViewerHistoryNavigate === 'function',
      activate: typeof w.kinViewerHistoryActivate === 'function', historyScope: shown ? shown.scope : null, image: shown ? shown.image : null,
      location: !!location && location.version === 1 && typeof location.restore === 'function' };
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
  // The chosen document's history, activation and navigation for a comparison source, each read at call time.
  function envOf(current) {
    return {
      state: () => { const w = current(), fn = w.kinViewerHistoryState; return typeof fn === 'function' ? fn.call(w) : null; },
      activate: study => { const w = current(), fn = w.kinViewerHistoryActivate; return typeof fn === 'function' ? fn.call(w, study) : { ok: false, reason: 'tool-missing' }; },
      navigate: target => invokeIn(current(), target),
    };
  }
  // A saved location is restored by the chosen document's own kinViewerJobLocation, read at the call.
  function restoreIn(w, request) {
    const location = w.kinViewerJobLocation;
    if (!location || location.version !== 1 || typeof location.restore !== 'function') return { state: 'refused', reason: 'tool-missing' };
    return location.restore.call(location, request);
  }
  // Plain snapshot for chooseTarget plus the live references behind it; `comparison` is the row's other study and `exact` a saved
  // location's ordered study set.
  function choose(study, comparison, exact) {
    const plain = { uid: study, comparison: comparison || null, exact: exact || null, workspace: null, windows: [] }, popups = new Map(), slots = new Map();
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
        restore: request => restoreIn(frame.contentWindow, request),
        env: () => envOf(() => frame.contentWindow), focus: () => guarded(() => { frame.focus(); frame.contentWindow.focus(); }) };
    }
    if (choice.kind === 'window') {
      const popup = popups.get(choice.index), index = choice.index;
      return { kind: 'window', index, label: '영상 창 ' + (index + 1), probe: () => windowView(popup, index), invoke: target => invokeIn(popup, target),
        restore: request => restoreIn(popup, request), env: () => envOf(() => popup), focus: () => guarded(() => popup.focus()) };
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
    // A saved location opens only in a viewer showing exactly its studies (S2-L2b); a comparison 2D source only in a viewer that
    // shows both studies (S2-B2).
    const located = !!source && source.kind === 'job';
    const comparison = source && !located && source.studyUid !== st.uid ? row.comparison : null;
    setResult(located ? '저장 작업 복원 중…' : '영상 이동 중… 결과를 확인하고 있습니다.', 'pending', false);
    await commands.run({
      expected: { owner: live() ? owner() : null, sub: sub(), uid: st.uid, generation: st.generation },
      source: source || null, comparison,
      choose: () => choose(st.uid, comparison, located ? source.studies : null),
      announce: (value, choice) => {
        if (located) {
          const state = value.state === 'restored' ? 'ok' : value.reason || value.state || 'failed';
          setResult(command.locationText(value, source, choice ? choice.label : ''), state, !value.ok && command.retryable(value.reason) && value.state !== 'rolled-back' && value.state !== 'screen-unknown');
          if (value.ok && choice) choice.focus();
        } else if (value.ok) { setResult(command.arrivalText(value, choice.label, source), 'ok', false); choice.focus(); }
        else setResult(command.resultText(value), value.reason, command.retryable(value.reason));
        // The comparison history refused after activation: re-read the list so no withdrawn row stays shown.
        if (comparison && value.reason === 'busy' && value.phase !== 'before' && live()) store.load();
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
      // Version 2: the user's own lesion characteristics, labelled; never interpreted or mapped to a vocabulary.
      if (row.characteristics) {
        const line = node('p', 'Characteristics (병변 특성): ' + row.characteristics, article);
        line.className = 'reading-findings-characteristics'; line.dataset.kinCharacteristics = '';
      }
      node('p', (row.author || '작성자 미확인') + ' · r' + row.revision + ' · ' + row.updated + (row.hidden ? ' · Hidden' : ''), article).className = 'reading-findings-meta';
      const sources = node('ul', '', article); sources.dataset.kinSources = '';
      row.sources.forEach((s, i) => {
        const job = s.kind === 'job';
        const item = node('li', '', sources); item.dataset.linkState = s.linkState;
        if (job) { item.dataset.jobId = s.jobId; item.dataset.sourceKind = s.mark ? 'point' : 'view'; } else item.dataset.itemId = s.itemId;
        const label = node('span', (i === row.primary ? '★ ' : '') + s.description + ' · ', item); label.id = 'reading-findings-label-' + (++labels);
        const badge = node('strong', s.linkLabel, item); badge.dataset.kinLinkState = s.linkState;
        if ((s.linkState === 'revised' || s.linkState === 'metadata-changed') && s.headRevision) node('span', ' (현재 r' + s.headRevision + ')', item);
        if (s.linkState !== 'current') node('span', ' · ' + s.linkText, item);
        item.dataset.sourceStudy = s.foreign ? 'comparison' : 'current';
        if (job) node('span', s.foreign ? ' · 저장 작업의 두 검사를 같은 순서로 표시하는 영상 화면에서만 엽니다' : ' · 이 검사만 표시하는 영상 화면에서만 엽니다', item);
        else if (s.foreign) node('span', ' · 비교 검사 영상(선택한 검사와 이 비교 검사를 함께 표시하는 화면으로만 이동)', item);
        const target = button(job ? (s.mark ? 'Go to 3D Point' : 'Open Saved View') : 'Go to Image', () => go(row.id, i), item);
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
    status.textContent = ended ? '로그인이 종료되었습니다. 다시 로그인한 뒤 확인하세요.' : !live() ? '로그인과 서버 연결을 확인한 뒤 소견을 확인하세요.'
      : st.message + (oldApi && st.status === 'ready' ? ' · ' + links.OLD_API_TEXT : '');
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
