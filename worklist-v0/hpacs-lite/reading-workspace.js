/* Keep one live viewer until its unsaved work can be left explicitly. The report
 * editor remains owned by the worklist; viewing a related image cannot retarget it. */
window.KinReadingWorkspace = function (app) {
  'use strict';
  const $ = s => document.querySelector(s);
  const node = (tag, text, parent) => {
    const el = document.createElement(tag); if (text) el.textContent = text;
    if (parent) parent.append(el); return el;
  };
  const bar = node('section'); bar.id = 'reading-bar'; bar.hidden = true;
  bar.setAttribute('aria-label', '판독 작업공간 이동');
  $('.split').before(bar);
  const nav = node('div', '', bar); nav.className = 'reading-actions';
  const button = (label, action, parent = nav) => {
    const b = node('button', label, parent); b.type = 'button'; b.className = 'chip'; b.onclick = action; return b;
  };
  const list = button('검사 목록', () => {
    document.body.classList.toggle('reading-list-open');
    list.setAttribute('aria-expanded', String(document.body.classList.contains('reading-list-open')));
    if (document.body.classList.contains('reading-list-open')) $('#quick').focus();
    else list.focus();
  });
  list.setAttribute('aria-expanded', 'false');
  const previous = button('이전 검사', () => app.move(-1));
  const next = button('다음 검사', () => app.move(1));
  const position = node('span', '', nav); position.id = 'reading-position'; position.setAttribute('role', 'status');
  const imageFocus = button('영상으로', () => focusPane('image'));
  const priorFocus = button('과거 판독문', () => focusPane('prior'));
  const reportFocus = button('판독문 작성', () => focusPane('report'));
  [[list, '1'], [imageFocus, '2'], [priorFocus, '3'], [reportFocus, '4'], [previous, 'ArrowLeft'], [next, 'ArrowRight']].forEach(([b, key]) => {
    b.setAttribute('aria-keyshortcuts', 'Control+Alt+' + key);
  });
  const context = button('검사 정보·상용구', () => {
    if (document.body.classList.contains('reading-context-open')) { closeContext(); context.focus(); }
    else focusPane('context');
  });
  context.setAttribute('aria-expanded', 'false');
  context.setAttribute('aria-controls', 'reading-context');
  context.setAttribute('aria-keyshortcuts', 'Control+Alt+5');
  $('.right > .rw').id = 'reading-context';
  const contextReturn = button('정보 닫고 판독문으로', () => focusPane('report'), $('.s-clinical'));
  contextReturn.id = 'reading-context-return';
  const note = button('현재 영상 Tech 메모', showNote);
  note.id = 'reading-tech-note';
  note.setAttribute('aria-keyshortcuts', 'Control+Alt+6');
  note.setAttribute('aria-describedby', 'reading-images');
  const autoLabel = node('label', '', nav);
  const autoNote = node('input', '', autoLabel); autoNote.type = 'checkbox'; autoNote.id = 'reading-note-auto';
  autoLabel.append(document.createTextNode(' 메모 자동 열기'));
  autoLabel.title = '이 브라우저의 현재 계정 설정 · 연결할 때 한 번 확인하며 입력·미저장 작업 중에는 건너뜁니다';
  let autoOwner = null, autoLast = null;
  autoNote.onchange = () => {
    const wanted = autoNote.checked, previousOwner = autoOwner;
    syncAutoNote();
    if (autoOwner !== previousOwner) { app.notice('계정이 바뀌었습니다. 자동 열기 설정을 다시 확인하세요.'); return; }
    autoNote.checked = wanted; autoLast = null;
    if (!autoOwner) return;
    try { localStorage.setItem(autoOwner, autoNote.checked ? 'true' : 'false'); }
    catch (_) { app.notice('자동 열기 설정을 저장하지 못했습니다. 현재 화면에서만 적용됩니다.'); }
    maybeAutoNote();
  };
  const separate = button('영상 새 창', () => { if (shown && sameTarget()) app.popup(shown.uid, shown.prior, shown.series); });
  button('목록 화면으로', () => { active = false; layout(); });
  const target = node('div', '', bar); target.id = 'reading-target';
  const hints = node('div', 'Ctrl+Alt+1 목록 · 2 영상 · 3 과거 판독 · 4 작성 · 5 정보 · 6 영상 Tech 메모 · ←/→ 이전/다음 검사 (입력 중 이동 제외)', bar);
  hints.id = 'reading-shortcuts';
  const host = node('section'); host.id = 'reading-viewer'; host.hidden = true;
  host.setAttribute('aria-label', '영상 작업공간'); $('.split').prepend(host);
  const info = node('div', '', host); info.id = 'reading-images';
  const status = node('div', '', host); status.id = 'reading-status'; status.setAttribute('role', 'status');
  const recovery = node('div', '', host); recovery.id = 'reading-recovery'; recovery.hidden = true;
  const back = button('이전 영상 작업으로 돌아가기', () => { if (shown) app.select(shown.reportUid); }, recovery);
  const retry = button('영상 다시 열기', () => { if (pending) attempt(pending, false); }, recovery);
  const discard = button('미저장 영상 작업 버리고 열기', () => {
    if (pending && confirm('이전 영상의 저장하지 않은 표식과 작업 제목·설명을 버리고 선택한 영상을 엽니다. 판독문 초안은 별도로 유지됩니다. 계속할까요?')) attempt(pending, true);
  }, recovery);
  const reportTarget = node('div'); reportTarget.id = 'reading-report-target'; reportTarget.hidden = true;
  $('.report-p').prepend(reportTarget);
  let active = false, ended = false, frame = null, shown = null, pending = null, epoch = 0, timer = null, deadline = 0, loaded = false, failed = false, lastSelection;
  const boundDocuments = new WeakSet();
  const queueObserver = new MutationObserver(navigation);
  queueObserver.observe($('#rows'), { childList: true });
  function navigation() {
    const queue = app.queue(), i = queue.findIndex(s => s.uid === app.current());
    const unavailable = ended || !app.allowed() || !queue.length;
    previous.disabled = unavailable || i === 0;
    next.disabled = unavailable || i === queue.length - 1;
    position.textContent = !queue.length ? '현재 목록 0건' : i < 0 ? '현재 검사: 목록 밖 · ' + queue.length + '건' : '현재 목록 ' + (i + 1) + ' / ' + queue.length;
  }
  function closeList() {
    document.body.classList.remove('reading-list-open'); list.setAttribute('aria-expanded', 'false');
  }
  function closeContext() {
    document.body.classList.remove('reading-context-open'); context.setAttribute('aria-expanded', 'false');
    redrawRetainedViewer();
  }
  function focusPane(which) {
    if (!active || ended || !app.allowed()) return;
    if (which === 'context') {
      closeList(); document.body.classList.add('reading-context-open'); context.setAttribute('aria-expanded', 'true');
      $('#clinical').focus(); $('#clinical').scrollIntoView({ block: 'nearest' }); redrawRetainedViewer(); return;
    }
    if (which === 'image') {
      if (!frame || !sameTarget() || !loaded || frame.inert) { status.textContent = '영상 연결을 확인한 뒤 이동하세요.'; return; }
      closeList(); frame.focus(); frame.contentWindow.focus();
    } else {
      if (which === 'report') closeContext();
      const pane = $(which === 'prior' ? '.prior-report-pane' : '#findings');
      if (!pane || !pane.getClientRects().length) return;
      closeList();
      if (which === 'prior') pane.tabIndex = -1;
      pane.focus(); pane.scrollIntoView({ block: 'nearest' });
    }
  }
  function modalOpen(doc) {
    return [...doc.querySelectorAll('dialog[open],.modal.show,[role="dialog"][aria-modal="true"]')].some(el => el.getClientRects().length);
  }
  function keyboard(e, doc = document) {
    if (!active || ended || !app.allowed() || e.defaultPrevented || e.repeat || e.isComposing || e.getModifierState('AltGraph') || modalOpen(document) || modalOpen(doc)) return;
    if (doc !== document && (!sameTarget() || !loaded || frame?.hidden || frame?.inert)) return;
    if (e.key === 'Escape' && doc === document && document.body.classList.contains('reading-list-open')) {
      e.preventDefault(); closeList(); list.focus(); return;
    }
    if (e.key === 'Escape' && doc === document && document.body.classList.contains('reading-context-open') && e.target.closest?.('#reading-context')) {
      e.preventDefault(); closeContext(); context.focus(); return;
    }
    if (!e.ctrlKey || !e.altKey || e.shiftKey || e.metaKey) return;
    const panes = { Digit2: 'image', Digit3: 'prior', Digit4: 'report', Digit5: 'context' };
    if (e.code === 'Digit1') {
      e.preventDefault(); document.body.classList.add('reading-list-open'); list.setAttribute('aria-expanded', 'true'); $('#quick').focus();
    } else if (panes[e.code]) {
      e.preventDefault(); focusPane(panes[e.code]);
    } else if (e.code === 'Digit6') {
      e.preventDefault(); showNote();
    } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
      // Do not turn editor cursor/IME gestures into a change of patient context.
      if (e.target.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]')) return;
      e.preventDefault(); navigation();
      const b = e.code === 'ArrowLeft' ? previous : next;
      if (!b.disabled) { b.focus(); b.click(); }
    }
  }
  const parentKeyboard = e => keyboard(e);
  document.addEventListener('keydown', parentKeyboard);
  function label(uid) {
    const s = app.study(uid);
    return s ? [s.name || s.patientName || '', s.patientId || s.id || '', s.date || '날짜 미확인', s.modality || '', s.desc || s.description || '', uid].filter(Boolean).join(' · ') : uid;
  }
  const sameTarget = () => shown?.reportUid === app.current();
  function noteTarget() {
    try {
      const w = frame?.contentWindow, url = new URL(w.location.href);
      if (url.origin !== window.location.origin || url.pathname !== '/ohif/viewer' ||
          url.searchParams.get('StudyInstanceUIDs') !== [shown.uid, shown.prior].filter(Boolean).join(',')) return null;
      const selected = w.kinViewerSelectedNoteTarget?.();
      return selected && [shown.uid, shown.prior].includes(selected.uid) && app.study(selected.uid) ? selected : null;
    } catch (_) { return null; }
  }
  function updateNote() {
    syncAutoNote();
    const selected = noteTarget();
    note.disabled = ended || !active || !app.allowed() || !frame || !sameTarget() || !loaded || frame.inert || !selected;
    const label = '현재 영상 Tech 메모' + (!note.disabled ? ' · ' + app.noteLabel(selected.uid) : '');
    if (note.textContent !== label) note.textContent = label;
  }
  function syncAutoNote() {
    const owner = !ended && app.allowed() && app.noteOwner();
    const key = owner ? 'kin-reading-note-auto:v1:' + owner : null;
    autoNote.disabled = !key;
    if (key === autoOwner) return;
    autoOwner = key; autoLast = null; autoNote.checked = false;
    try { if (key) autoNote.checked = localStorage.getItem(key) === 'true'; } catch (_) {}
  }
  function maybeAutoNote() {
    updateNote();
    const key = shown && JSON.stringify([epoch, shown.reportUid, shown.uid]);
    if (!autoNote.checked || note.disabled || autoLast === key) return;
    // Consume this connection even when editing: never surprise the user later.
    const selected = noteTarget();
    if (!selected) return;
    autoLast = key;
    const summary = app.hasNote(selected.uid);
    if (summary === undefined) { app.notice('메모 상태가 미확인입니다. 현재 영상 Tech 메모에서 확인하세요.'); return; }
    if (!summary) return;
    if (document.visibilityState !== 'visible' || modalOpen(document)) return;
    try {
      const doc = frame.contentDocument;
      const editing = el => el?.matches('textarea,select,input:not([type="checkbox"]):not([type="button"]):not([type="submit"]),[contenteditable]:not([contenteditable="false"]),[role="textbox"]');
      const state = viewerState();
      if (modalOpen(doc) || editing(document.activeElement) || editing(doc.activeElement) || state.busy || state.dirty) return;
    } catch (_) { return; }
    if (showNote()) autoLast = key;
  }
  function showNote() {
    updateNote(); if (note.disabled) return false;
    const selected = noteTarget();
    if (!selected) { app.notice('불러온 스택 영상 칸을 선택하세요. 메모 대상을 확인할 수 없습니다.'); return false; }
    app.openNote(selected.uid); autoLast = JSON.stringify([epoch, shown.reportUid, shown.uid]); return true;
  }
  function redrawRetainedViewer() {
    const retained = frame;
    // A hidden iframe can keep its study/camera but lose its drawable canvas.
    // Ask the existing viewer to redraw after layout; never reload its document.
    requestAnimationFrame(() => {
      if (!active || ended || !loaded || retained !== frame || !sameTarget() || frame.hidden) return;
      try {
        const w = frame.contentWindow;
        w.dispatchEvent(new w.Event('resize'));
        w.cornerstone?.getRenderingEngines?.().filter(engine => engine.id !== '_thumbnails')
          .forEach(engine => engine.resize(true, true));
      } catch (_) { /* Its loading/error state is handled by the document check. */ }
    });
  }
  function layout() {
    document.body.classList.toggle('reading', active); bar.hidden = host.hidden = reportTarget.hidden = !active;
    if (!active) {
      document.body.classList.remove('reading-list-open', 'reading-context-open');
      list.setAttribute('aria-expanded', 'false'); context.setAttribute('aria-expanded', 'false');
    }
    app.layout();
    if (frame) frame.hidden = !sameTarget();
    if (frame && !frame.hidden) redrawRetainedViewer();
    separate.disabled = !frame || !sameTarget() || !loaded;
    imageFocus.disabled = separate.disabled;
    updateNote();
  }
  function identify() {
    const uid = app.current(); target.textContent = uid ? '판독 대상 · ' + label(uid) : '판독 대상을 선택하세요';
    reportTarget.textContent = target.textContent;
    info.textContent = shown && sameTarget() ? '영상 열람 · ' + label(shown.uid) + (shown.prior ? '\n비교 영상 · ' + label(shown.prior) : '') : '';
    separate.disabled = !frame || !sameTarget() || !loaded;
    imageFocus.disabled = separate.disabled;
    updateNote();
    navigation();
  }
  function viewerState() {
    if (!frame) return { busy: false, dirty: false };
    if (!loaded && frame.inert) return { busy: false, dirty: false };
    try {
      const w = frame.contentWindow;
      // A document still loading has no interactive viewer. Once a canvas exists,
      // missing guards are uncertainty, not permission to discard its state.
      const history = w.kinViewerHistoryWorkspaceState, jobs = w.kinViewerJobWorkspaceState;
      if (typeof history !== 'function' || typeof jobs !== 'function') {
        return { busy: !!w.document.querySelector('.cornerstone-canvas'), dirty: false };
      }
      const a = history(), b = jobs(); return { busy: a.busy || b.busy, dirty: a.dirty || b.dirty };
    } catch (_) {
      // A failed initial navigation can be Chromium's inaccessible error document.
      // It was inert throughout loading, so no user work could have been entered.
      return { busy: loaded, dirty: loaded };
    }
  }
  function request(uid, prior = null, series = null) {
    const valid = x => typeof x === 'string' && x.length <= 64 && /^\d+(?:\.\d+)+$/.test(x);
    if (!valid(uid) || prior !== null && !valid(prior) || series !== null && !valid(series) || !app.current()) {
      app.notice('검사·시리즈 정보를 확인할 수 없어 열지 않았습니다.'); return null;
    }
    if (!app.allowed()) { app.notice('현재 로그인과 검사 접근 상태를 확인한 뒤 영상을 여세요.'); return null; }
    return { uid, prior: prior && prior !== uid ? prior : null, series, reportUid: app.current() };
  }
  function url(r) {
    return '/ohif/viewer?StudyInstanceUIDs=' + encodeURIComponent(r.uid) + (r.prior ? ',' + encodeURIComponent(r.prior) + '&hangingProtocolId=@ohif/hpCompare' : '') +
      (r.series ? '&initialSeriesInstanceUID=' + encodeURIComponent(r.series) : '') + (r.job ? '&kinJob=' + encodeURIComponent(r.job) : '');
  }
  function attempt(r, abandon) {
    if (ended) { app.notice('영상 작업공간이 종료되었습니다. 판독문 초안을 저장한 뒤 화면을 새로고침하세요.'); return false; }
    if (!r || r.reportUid !== app.current() || !app.allowed()) return false;
    pending = r; active = true; layout(); identify();
    if (frame && !failed && JSON.stringify(shown) === JSON.stringify(r)) {
      frame.hidden = false; recovery.hidden = true; pending = null; identify(); return true;
    }
    const state = viewerState();
    if (state.busy || state.dirty && !abandon) {
      if (frame) frame.hidden = !sameTarget();
      status.textContent = state.busy ? '영상의 저장·복원 또는 상태 확인 중입니다. 작업을 확인한 뒤 다시 여세요.' : sameTarget() ? '현재 영상에 저장하지 않은 작업이 있습니다. 저장하거나 명시적으로 버린 뒤 다른 영상을 여세요.' : '이전 영상에 저장하지 않은 작업이 있습니다. 이전 검사로 돌아가 저장하거나, 명시적으로 버린 뒤 여세요.';
      recovery.hidden = false; discard.hidden = !!state.busy; back.hidden = !shown || sameTarget(); retry.hidden = false; return false;
    }
    const ticket = ++epoch; clearInterval(timer); timer = null;
    frame?.remove(); frame = node('iframe', '', host); frame.id = 'reading-frame'; frame.title = '영상 뷰어';
    frame.setAttribute('allow', 'fullscreen'); frame.referrerPolicy = 'no-referrer'; frame.inert = true;
    shown = r; loaded = false; failed = false; deadline = Date.now() + 45000; recovery.hidden = true; identify();
    status.textContent = '영상 작업공간을 불러오는 중…';
    const currentFrame = frame;
    let observedDocument, observedHref;
    function check() {
      if (ended || ticket !== epoch || currentFrame !== frame) return;
      try {
        const w = frame.contentWindow;
        const location = new URL(w.location.href), doc = w.document;
        if (location.origin === window.location.origin && location.pathname === '/ohif/viewer' &&
            (doc !== observedDocument || location.href !== observedHref)) {
          loaded = false; frame.inert = true;
          const values = (location.searchParams.get('StudyInstanceUIDs') || '').split(',');
          if (values.length < 1 || values.length > 2 || values.some(x => !/^\d+(?:\.\d+)+$/.test(x) || x.length > 64) || new Set(values).size !== values.length) throw new Error('Invalid viewer scope');
          observedDocument = doc; observedHref = location.href; failed = false; deadline = Date.now() + 45000;
          shown = { uid: values[0], prior: values[1] || null, series: location.searchParams.get('initialSeriesInstanceUID'), reportUid: r.reportUid };
          const job = location.searchParams.get('kinJob'); if (job) shown.job = job;
          if (sameTarget()) { status.textContent = '영상 작업공간을 불러오는 중…'; identify(); }
        }
        if (location.href === observedHref && doc.querySelector('.cornerstone-canvas') &&
            typeof w.kinViewerHistoryWorkspaceState === 'function' && typeof w.kinViewerJobWorkspaceState === 'function') {
          window.KinViewerWorkspaceDock?.(w);
          // Keyboard events do not bubble out of an iframe. Bind each real
          // viewer document once, including documents replaced by job restore.
          if (!boundDocuments.has(doc)) {
            doc.addEventListener('keydown', e => keyboard(e, doc)); boundDocuments.add(doc);
          }
          if (!loaded) {
            loaded = true; failed = false; frame.inert = false;
            if (sameTarget()) { pending = null; recovery.hidden = true; status.textContent = '영상 작업공간 연결됨'; identify(); }
          }
          maybeAutoNote();
          return;
        }
      } catch (_) {}
      if (!loaded && !failed && Date.now() > deadline) {
        failed = true;
        if (!sameTarget()) return;
        status.textContent = '영상 작업공간을 확인하지 못했습니다. 로그인·연결 상태를 확인하고 다시 여세요.';
        pending = shown; recovery.hidden = false; back.hidden = discard.hidden = true; retry.hidden = false;
      }
    }
    frame.onload = () => {
      if (ended || ticket !== epoch || currentFrame !== frame) return;
      loaded = false; failed = false; frame.inert = true; deadline = Date.now() + 45000; observedDocument = undefined; observedHref = undefined;
      if (sameTarget()) { info.textContent = ''; status.textContent = '영상 작업공간을 불러오는 중…'; separate.disabled = true; }
      check();
    };
    frame.src = url(r); timer = setInterval(check, 250);
    return true;
  }
  function open(uid, prior = null, series = null) { return attempt(request(uid, prior, series), false); }
  function resume(uid, prior = null) { return shown?.reportUid === app.current() && !failed ? attempt(shown, false) : open(uid, prior); }
  function openJob(uid,job) {
    const ids=job?.snapshot?.studies;
    if(job?.studyUid!==uid||!Array.isArray(ids)||ids[0]!==uid||ids.length<1||ids.length>2||typeof job.id!=='string'||!/^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.test(job.id)){app.notice('저장 보기의 검사 정보를 확인할 수 없습니다.');return false;}
    const r=request(uid,ids[1]??null);if(!r)return false;r.job=job.id;return attempt(r,false);
  }
  function selectionChanged(deferOpen = false) {
    identify(); const uid = app.current(), changed = uid !== lastSelection; lastSelection = uid;
    if (!active || ended || !changed) return;
    if (frame) frame.hidden = !sameTarget();
    document.body.classList.remove('reading-list-open'); list.setAttribute('aria-expanded', 'false');
    if (shown?.reportUid === uid && frame) {
      frame.hidden = false;
      redrawRetainedViewer();
      if (!failed) { pending = null; recovery.hidden = true; status.textContent = loaded ? '기존 영상 작업으로 돌아왔습니다.' : '영상 작업공간을 불러오는 중…'; }
      identify(); return;
    }
    if (uid && !deferOpen) open(uid, app.prior(uid));
    else { pending = null; recovery.hidden = true; status.textContent = '판독 대상을 선택하세요'; }
  }
  // Session invalidation must hide the embedded document even if its own request
  // has not yet noticed the expired account. Never reconnect it from a late load.
  function end() { ended = true; epoch++; clearInterval(timer); timer = null; queueObserver.disconnect(); document.removeEventListener('keydown', parentKeyboard); frame?.remove(); frame = null; shown = pending = null; loaded = false; active = false; layout(); identify(); }
  let channel;
  try { channel = new BroadcastChannel('kin-session'); channel.onmessage = e => { if (e.data?.type === 'session-ended') end(); }; } catch (_) {}
  window.addEventListener('storage', e => { if (e.key === 'kin-session-ended') end(); });
  window.addEventListener('pagehide', () => { end(); channel?.close(); });
  window.addEventListener('beforeunload', e => { const s = viewerState(); if (s.busy || s.dirty) { e.preventDefault(); e.returnValue = ''; } });
  return { open, openJob, resume, selectionChanged, refreshNote: updateNote, active: () => active, end };
};
