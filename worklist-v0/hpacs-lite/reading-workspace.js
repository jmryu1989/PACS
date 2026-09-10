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
  const list = button('Worklist', () => {
    document.body.classList.toggle('reading-list-open');
    list.setAttribute('aria-expanded', String(document.body.classList.contains('reading-list-open')));
    if (document.body.classList.contains('reading-list-open')) $('#quick').focus();
    else list.focus();
  });
  list.setAttribute('aria-expanded', 'false');
  const previous = button('Previous Study', () => app.move(-1));
  const next = button('Next Study', () => app.move(1));
  const position = node('span', '', nav); position.id = 'reading-position'; position.setAttribute('role', 'status');
  const imageFocus = button('Image', () => focusPane('image'));
  const priorFocus = button('Related Report', () => focusPane('prior'));
  const reportFocus = button('Report Editor', () => focusPane('report'));
  const toolsFocus = button('Image Tools', () => focusPane('tools'));
  toolsFocus.id = 'reading-tools-focus';
  const nativeToolsFocus = button('Viewer Toolbar', () => focusPane('nativeTools'));
  nativeToolsFocus.id = 'reading-native-tools-focus';
  [[list, '1'], [imageFocus, '2'], [priorFocus, '3'], [reportFocus, '4'], [toolsFocus, '7'], [nativeToolsFocus, '9'], [previous, 'ArrowLeft'], [next, 'ArrowRight']].forEach(([b, key]) => {
    b.setAttribute('aria-keyshortcuts', 'Control+Alt+' + key);
  });
  const context = button('Study Info & Templates', () => {
    if (document.body.classList.contains('reading-context-open')) { closeContext(); context.focus(); }
    else focusPane('context');
  });
  context.setAttribute('aria-expanded', 'false');
  context.setAttribute('aria-controls', 'reading-context');
  context.setAttribute('aria-keyshortcuts', 'Control+Alt+5');
  $('.right > .rw').id = 'reading-context';
  const contextReturn = button('Back to Report', () => focusPane('report'), $('.s-clinical'));
  contextReturn.id = 'reading-context-return';
  const note = button('Image Tech Note', showNote);
  note.id = 'reading-tech-note';
  note.setAttribute('aria-keyshortcuts', 'Control+Alt+6');
  note.setAttribute('aria-describedby', 'reading-images');
  const noteRetry = button('Reconnect Note', reconnectNote);
  noteRetry.id = 'reading-note-retry'; noteRetry.hidden = true;
  let noteRetryFocus = null;
  const autoLabel = node('label', '', nav);
  const autoNote = node('input', '', autoLabel); autoNote.type = 'checkbox'; autoNote.id = 'reading-note-auto';
  autoLabel.append(document.createTextNode(' Auto-open Note'));
  autoLabel.title = '이 브라우저의 현재 계정 설정 · 연결할 때 한 번 확인하며 입력·미저장 작업 중에는 건너뜁니다';
  let autoOwner = null, autoLast = null, preferenceGeneration = 0;
  autoNote.onchange = () => {
    preferenceGeneration++;
    const wanted = autoNote.checked, previousOwner = autoOwner;
    syncAutoNote();
    if (autoOwner !== previousOwner) { app.notice('계정이 바뀌었습니다. 자동 열기 설정을 다시 확인하세요.'); return; }
    autoNote.checked = wanted; autoLast = null;
    if (!autoOwner) return;
    try { localStorage.setItem(autoOwner, autoNote.checked ? 'true' : 'false'); }
    catch (_) { app.notice('자동 열기 설정을 저장하지 못했습니다. 현재 화면에서만 적용됩니다.'); }
    maybeAutoNote();
  };
  const separate = button('Open Viewer Window', () => { if (shown && sameTarget()) app.popup(shown.uid, shown.prior, shown.series, returnLink()); });
  button('Exit Workspace', leave);
  const target = node('div', '', bar); target.id = 'reading-target';
  const shortcutHelp = node('details', '', bar); shortcutHelp.id = 'reading-shortcut-help';
  node('summary', 'Keyboard Shortcuts', shortcutHelp);
  const hints = node('div', 'Ctrl+Alt+1 목록 · 2 영상 · 3 과거 판독 · 4 작성 · 5 정보 · 6 영상 Tech 메모 · 7 작업 패널 · 9 기본 영상 도구 (Tab 이동·Enter 선택) · ←/→ 이전/다음 검사 (입력 중 이동 제외)', shortcutHelp);
  hints.id = 'reading-shortcuts';
  const shortcutButtons = {list,image:imageFocus,prior:priorFocus,report:reportFocus,context,note,tools:toolsFocus,nativeTools:nativeToolsFocus,previous,next};
  const shortcuts = KinWorkspaceShortcuts.create({host:nav,owner:app.noteOwner,allowed:app.allowed,changed:map=>{
    for(const [id,b] of Object.entries(shortcutButtons))b.setAttribute('aria-keyshortcuts',KinWorkspaceShortcuts.display(map[id]));
    hints.textContent=Object.entries(shortcutButtons).map(([id,b])=>b.textContent+' '+KinWorkspaceShortcuts.display(map[id])).join(' · ')+' (입력 중 검사 이동 제외)';
  }});
  const host = node('section'); host.id = 'reading-viewer'; host.hidden = true;
  host.setAttribute('aria-label', '영상 작업공간'); $('.split').prepend(host);
  const info = node('div', '', host); info.id = 'reading-images';
  const status = node('div', '', host); status.id = 'reading-status'; status.setAttribute('role', 'status');
  const recovery = node('div', '', host); recovery.id = 'reading-recovery'; recovery.hidden = true;
  const back = button('Return to Previous Viewer', () => { if (shown) app.select(shown.reportUid); }, recovery);
  const retry = button('Reopen Viewer', () => { if (pending) attempt(pending, false); }, recovery);
  const discard = button('Discard Viewer Changes & Open', () => {
    if (pending && confirm('이전 영상의 저장하지 않은 표식과 작업 제목·설명을 버리고 선택한 영상을 엽니다. 판독문 초안은 별도로 유지됩니다. 계속할까요?')) attempt(pending, true);
  }, recovery);
  const reportTarget = node('div'); reportTarget.id = 'reading-report-target'; reportTarget.hidden = true;
  $('.report-p').prepend(reportTarget);
  let active = false, ended = false, frame = null, shown = null, pending = null, epoch = 0, timer = null, deadline = 0, loaded = false, failed = false, lastSelection;
  const panelModel = KinReadingPanelLayout;
  let panelValues = panelModel.defaults(), panelDrag = null, panelStyleSignature = '';
  const split = $('.split'), reportColumn = $('.right'), relatedRegion = $('.related-p');
  const relatedList = $('.related-list-pane'), priorReport = $('.prior-report-pane');
  reportColumn.id = 'reading-report-column'; relatedRegion.id = 'reading-related-region';
  relatedList.id = 'reading-related-list'; priorReport.id = 'reading-prior-report';
  const relatedToggle = button('Hide Related Panel', () => setRelatedHidden(!panelValues.relatedHidden));
  relatedToggle.id = 'reading-related-toggle'; relatedToggle.setAttribute('aria-controls', relatedRegion.id);
  relatedToggle.title = '관련 검사·이전 판독문 패널을 숨기거나 복원합니다. 작성 중인 내용은 유지됩니다.';
  const panelsReset = button('Reset Panels', () => commitPanels(panelModel.defaults()));
  panelsReset.id = 'reading-panels-reset';
  panelsReset.title = '통합 작업공간의 패널 크기와 표시를 기본값으로 되돌립니다.';
  const panelHelp = node('p', '패널 경계는 드래그하거나 Tab으로 선택한 뒤 방향키로 조절합니다. Shift는 크게 이동, Home/End는 최소/최대, Enter는 해당 경계의 기본값입니다. 좁은 창의 영상·판독은 위아래로 배치하며, 숨긴 관련 패널은 Related Report로 다시 엽니다.', shortcutHelp);
  panelHelp.id = 'reading-panel-help';
  const panelSeparators = [];
  function panelGeometry() {
    const grid = relatedList.querySelector('.grid2');
    const listMin = [...relatedList.children].filter(child => child !== grid && child.getClientRects().length)
      .reduce((total, child) => total + child.getBoundingClientRect().height, 40);
    return panelModel.resolve(panelValues, { width: split.clientWidth || innerWidth, narrow: matchMedia('(max-width: 850px)').matches,
      height: innerHeight, workHeight: $('.workrow').clientHeight, listMin });
  }
  function snapshotPanels() { return panelModel.normalize(panelValues); }
  function applyPanels(value) {
    const next = panelModel.normalize(value); if (!next || ended) return false;
    cancelPanelDrag(); panelValues = next; renderPanels(); return true;
  }
  function commitPanels(value) {
    if (!active || ended || !app.allowed()) return false;
    const next = panelModel.normalize(value); if (!next) return false;
    panelValues = next; renderPanels();
    const snapshot = snapshotPanels();
    app.onPanelsChange?.(snapshot);
    return true;
  }
  function setRelatedHidden(hidden) {
    if (!active || ended || !app.allowed()) return;
    if (hidden && relatedRegion.contains(document.activeElement)) relatedToggle.focus();
    commitPanels({ ...panelValues, relatedHidden: hidden });
  }
  function renderPanels() {
    const geometry = panelGeometry(), values = geometry.effective;
    const signature = JSON.stringify([active, ended, panelValues.relatedHidden, values]);
    document.body.classList.toggle('reading-related-hidden', active && panelValues.relatedHidden);
    relatedRegion.inert = active && panelValues.relatedHidden;
    if (active && panelValues.relatedHidden) relatedRegion.setAttribute('aria-hidden', 'true');
    else relatedRegion.removeAttribute('aria-hidden');
    relatedToggle.textContent = panelValues.relatedHidden ? 'Show Related Panel' : 'Hide Related Panel';
    relatedToggle.setAttribute('aria-expanded', String(!panelValues.relatedHidden));
    relatedToggle.disabled = panelsReset.disabled = ended || !app.allowed();
    priorFocus.setAttribute('aria-controls', priorReport.id);
    for (const item of panelSeparators) {
      const key = item.kind === 'report' ? (geometry.narrow ? 'imageHeight' : 'reportWidth') : item.kind;
      const range = geometry.ranges[key], horizontal = key !== 'reportWidth';
      item.el.hidden = !active || item.kind !== 'report' && panelValues.relatedHidden;
      item.el.setAttribute('aria-orientation', horizontal ? 'horizontal' : 'vertical');
      item.el.setAttribute('aria-valuemin', String(range.min)); item.el.setAttribute('aria-valuemax', String(range.max));
      item.el.setAttribute('aria-valuenow', String(values[key]));
      item.el.setAttribute('aria-valuetext', values[key] + ' 픽셀');
      item.el.setAttribute('aria-disabled', String(ended || !app.allowed()));
      item.el.tabIndex = ended || !app.allowed() ? -1 : 0;
    }
    if (signature === panelStyleSignature) return;
    panelStyleSignature = signature;
    split.style.setProperty('--reading-report-width', values.reportWidth + 'px');
    split.style.setProperty('--reading-image-height', values.imageHeight + 'px');
    split.style.setProperty('--reading-related-height', values.relatedHeight + 'px');
    split.style.setProperty('--reading-related-list-height', values.relatedListHeight + 'px');
    if (active) redrawRetainedViewer();
  }
  function cancelPanelDrag() {
    const drag = panelDrag; if (!drag) return;
    panelDrag = null; panelValues = drag.before;
    if (drag.item.el.hasPointerCapture(drag.pointer)) drag.item.el.releasePointerCapture(drag.pointer);
    document.body.classList.remove('reading-panel-resizing'); renderPanels();
  }
  function separator(kind, id, label, controls, after) {
    const el = node('div'); el.id = id; el.className = 'reading-panel-separator'; el.hidden = true;
    el.setAttribute('role', 'separator'); el.setAttribute('aria-label', label); el.setAttribute('aria-controls', controls);
    el.setAttribute('aria-describedby', panelHelp.id); el.title = '드래그 또는 방향키로 크기 조절 · Enter: 기본값';
    after.after(el);
    const item = { kind, el }; panelSeparators.push(item);
    const keyFor = geometry => kind === 'report' ? (geometry.narrow ? 'imageHeight' : 'reportWidth') : kind;
    const allowed = () => active && !ended && app.allowed() && !modalOpen(document);
    el.addEventListener('keydown', e => {
      if (!allowed() || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
      const geometry = panelGeometry(), key = keyFor(geometry), range = geometry.ranges[key];
      const axis = key === 'reportWidth' ? ['ArrowRight', 'ArrowLeft'] : ['ArrowUp', 'ArrowDown'];
      if (![...axis, 'Home', 'End', 'Enter', 'Escape'].includes(e.key)) return;
      if (e.key === 'Escape' && !panelDrag) return;
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape') { cancelPanelDrag(); return; }
      cancelPanelDrag();
      const value = e.key === 'Enter' ? null : e.key === 'Home' ? range.min : e.key === 'End' ? range.max :
        Math.max(range.min, Math.min(range.max, geometry.effective[key] + (e.key === axis[1] ? 1 : -1) * (e.shiftKey ? 40 : 10)));
      commitPanels({ ...panelValues, [key]: value });
    });
    el.addEventListener('pointerdown', e => {
      if (!allowed() || e.button !== 0) return;
      cancelPanelDrag(); e.preventDefault(); el.focus();
      const geometry = panelGeometry(), key = keyFor(geometry);
      panelDrag = { item, key, before: snapshotPanels(), pointer: e.pointerId,
        origin: key === 'reportWidth' ? e.clientX : e.clientY, size: geometry.effective[key], narrow: geometry.narrow };
      app.onPanelsEdit?.();
      el.setPointerCapture(e.pointerId); document.body.classList.add('reading-panel-resizing');
    });
    el.addEventListener('pointermove', e => {
      const drag = panelDrag; if (!drag || drag.item !== item || drag.pointer !== e.pointerId) return;
      const geometry = panelGeometry();
      if (!allowed() || geometry.narrow !== drag.narrow) { cancelPanelDrag(); return; }
      const range = geometry.ranges[drag.key], delta = (drag.key === 'reportWidth' ? drag.origin - e.clientX : e.clientY - drag.origin);
      panelValues = { ...panelValues, [drag.key]: Math.round(Math.max(range.min, Math.min(range.max, drag.size + delta))) };
      renderPanels();
    });
    el.addEventListener('pointerup', e => {
      const drag = panelDrag; if (!drag || drag.item !== item || drag.pointer !== e.pointerId) return;
      const next = snapshotPanels(); panelDrag = null;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      document.body.classList.remove('reading-panel-resizing');
      if (allowed()) commitPanels(next); else { panelValues = drag.before; renderPanels(); }
    });
    for (const event of ['pointercancel', 'lostpointercapture']) el.addEventListener(event, () => {
      if (panelDrag?.item === item) cancelPanelDrag();
    });
  }
  separator('report', 'reading-resize-report', 'Image and Report Size', 'reading-viewer reading-report-column', host);
  separator('relatedHeight', 'reading-resize-related', 'Related Panel Height', relatedRegion.id, relatedRegion);
  separator('relatedListHeight', 'reading-resize-prior', 'Related List and Report Size', relatedList.id + ' ' + priorReport.id, relatedList);
  const panelObserver = new ResizeObserver(() => { if (active && !ended) renderPanels(); });
  panelObserver.observe(split); panelObserver.observe($('.workrow')); panelObserver.observe(relatedList);
  [...relatedList.children].filter(child => !child.classList.contains('grid2')).forEach(child => panelObserver.observe(child));
  const panelWindowResize = () => { if (panelDrag) cancelPanelDrag(); if (active && !ended) renderPanels(); };
  window.addEventListener('resize', panelWindowResize);
  const boundDocuments = new WeakSet();
  let returnChannel=null;
  function returnLink(){
    returnChannel?.close();returnChannel=null;
    if(ended||!active||!app.allowed()||!sameTarget())return null;
    const owner=app.noteOwner?.(),report=app.current(),studies=[shown.uid,...(shown.prior?[shown.prior]:[])];
    if(!owner)return null;
    try{
      const token=crypto.randomUUID(),link=new BroadcastChannel('kin-reading-return:'+token);returnChannel=link;
      link.onmessage=e=>{
        const m=e.data;if(!m||m.type!=='request'||typeof m.request!=='string'||!/^[0-9a-f-]{36}$/.test(m.request))return;
        const reply=result=>{if(returnChannel===link)link.postMessage({type:'result',request:m.request,result});};
        const matchingScope=()=>sameTarget()&&shown&&JSON.stringify([shown.uid,...(shown.prior?[shown.prior]:[])])===JSON.stringify(studies)&&Array.isArray(m.studies)&&m.studies.length===studies.length&&m.studies.every((uid,i)=>uid===studies[i])&&studies.includes(m.activeUid);
        if(ended||!app.allowed()||app.noteOwner?.()!==owner||m.owner!==owner){reply('session');return;}
        if(!active||app.current()!==report||!matchingScope()){reply('context');return;}
        if(modalOpen(document)){reply('modal');return;}
        const field=$('#findings');if(!field||!field.getClientRects().length||field.disabled||field.closest('[inert]')){reply('unavailable');return;}
        focusPane('report');window.focus();
        // A background/occluded window may not receive animation frames. Still
        // answer with the manual-selection fallback if focus was not granted.
        setTimeout(()=>{
          if(ended||!app.allowed()||app.noteOwner?.()!==owner){reply('session');return;}
          if(!active||app.current()!==report||!matchingScope()||modalOpen(document)){reply('context');return;}
          if(!field.isConnected||!field.getClientRects().length||field.disabled||field.closest('[inert]')){reply('unavailable');return;}
          reply(document.hasFocus()&&document.activeElement===field?'focused':'ready');
        },0);
      };
      return token;
    }catch(_){return null;}
  }
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
    if (which === 'image' || which === 'tools' || which === 'nativeTools') {
      if (!frame || !sameTarget() || !loaded || frame.inert) { status.textContent = '영상 연결을 확인한 뒤 이동하세요.'; return; }
      if (which === 'nativeTools') {
        try {
          if (!frame.contentWindow.kinViewerFocusNativeToolbar?.()) { status.textContent = '기본 영상 도구 연결을 확인한 뒤 이동하세요.'; return; }
          closeList();
        } catch (_) { status.textContent = '기본 영상 도구 연결을 확인한 뒤 이동하세요.'; }
        return;
      }
      let tool = null;
      if (which === 'tools') {
        try { tool = frame.contentDocument?.querySelector('#kin-workspace-dock nav button:not(:disabled)'); }
        catch (_) { status.textContent = '영상 도구 연결을 확인한 뒤 이동하세요.'; return; }
      }
      if (which === 'tools' && (!tool || !tool.getClientRects().length)) { status.textContent = '영상 도구 연결을 확인한 뒤 이동하세요.'; return; }
      closeList(); frame.focus(); frame.contentWindow.focus();
      if (tool) { tool.focus({ preventScroll: true }); tool.scrollIntoView({ block: 'nearest' }); }
    } else {
      if (which === 'report') closeContext();
      if (which === 'prior' && panelValues.relatedHidden) setRelatedHidden(false);
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
    const command = shortcuts.action(e);
    // Capture precedes the embedded viewer's fixed legacy shortcuts. After a
    // remap, the old chord must not trigger a second, differently named action.
    if (!command) {
      if(doc!==document&&KinWorkspaceShortcuts.action(KinWorkspaceShortcuts.defaults,e)){e.preventDefault();e.stopImmediatePropagation();}
      return;
    }
    e.stopImmediatePropagation();
    if (doc !== document && command === 'note') {
      const target = doc.querySelector('#kin-viewer-note-open');
      e.preventDefault(); if(target && !target.disabled)target.click(); return;
    }
    const panes = { image:'image', prior:'prior', report:'report', context:'context', tools:'tools', nativeTools:'nativeTools' };
    if (command === 'list') {
      e.preventDefault(); document.body.classList.add('reading-list-open'); list.setAttribute('aria-expanded', 'true'); $('#quick').focus();
    } else if (panes[command]) {
      e.preventDefault(); focusPane(panes[command]);
    } else if (command === 'note') {
      e.preventDefault(); showNote();
    } else if (command === 'previous' || command === 'next') {
      // Do not turn editor cursor/IME gestures into a change of patient context.
      if (e.target.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]')) return;
      e.preventDefault(); navigation();
      const b = command === 'previous' ? previous : next;
      if (!b.disabled) { b.focus(); b.click(); }
    }
  }
  const parentKeyboard = e => keyboard(e);
  document.addEventListener('keydown', parentKeyboard, true);
  function label(uid) {
    const s = app.study(uid);
    return s ? [s.name || s.patientName || '', s.patientId || s.id || '', s.date || '날짜 미확인', s.modality || '', s.desc || s.description || '', uid].filter(Boolean).join(' · ') : uid;
  }
  const sameTarget = () => shown?.reportUid === app.current();
  function noteWindow() {
    try {
      const w = frame?.contentWindow, url = new URL(w.location.href);
      if (url.origin !== window.location.origin || url.pathname !== '/ohif/viewer' ||
          url.searchParams.get('StudyInstanceUIDs') !== [shown.uid, shown.prior].filter(Boolean).join(',')) return null;
      return w;
    } catch (_) { return null; }
  }
  function noteTarget() {
    try {
      const selected = noteWindow()?.kinViewerSelectedNoteTarget?.();
      return selected && [shown.uid, shown.prior].includes(selected.uid) && app.study(selected.uid) ? selected : null;
    } catch (_) { return null; }
  }
  function updateNote() {
    syncAutoNote();
    const selected = noteTarget();
    const unavailable = ended || !active || !app.allowed() || !frame || !sameTarget() || !loaded || frame.inert;
    note.disabled = unavailable || !selected;
    const w = noteWindow(), connection = w?.kinViewerNoteConnectionState?.();
    noteRetry.hidden = !['failed', 'loading'].includes(connection);
    noteRetry.disabled = unavailable || connection !== 'failed';
    noteRetry.textContent = connection === 'loading' ? 'Connecting Note…' : 'Reconnect Note';
    if (noteRetryFocus && (!w || w !== noteRetryFocus || unavailable || connection !== 'loading')) {
      if (w === noteRetryFocus && !unavailable && connection === 'ready' &&
          (document.activeElement === noteRetry || document.activeElement === document.body)) (note.disabled ? imageFocus : note).focus({preventScroll:true});
      noteRetryFocus = null;
    }
    const label = 'Image Tech Note' + (!note.disabled ? ' · ' + app.noteLabel(selected.uid) : '');
    if (note.textContent !== label) note.textContent = label;
  }
  function reconnectNote() {
    updateNote(); if (noteRetry.disabled) return;
    const w = noteWindow();
    if (!w || typeof w.kinViewerNoteReconnect !== 'function') return;
    noteRetryFocus = document.activeElement === noteRetry ? w : null;
    w.kinViewerNoteReconnect(); updateNote();
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
  function leave() { active = false; layout(); $('#m-reading').focus(); }
  function layout() {
    if (!active) cancelPanelDrag();
    const toggle=$('#m-reading');toggle.textContent=active?'Back to Worklist':'Reading Workspace';toggle.setAttribute('aria-pressed',String(active));toggle.title=active?'기존 목록 화면으로 돌아갑니다. 작성 중인 판독문과 영상 작업은 유지됩니다.':'영상과 판독문을 함께 보는 작업공간을 엽니다.';
    // The native viewer observes its container size even while hidden. Preserve
    // that size off screen so returning from the list cannot produce a NaN camera.
    if(!active&&frame&&!host.hidden){const r=host.getBoundingClientRect();if(r.width>0&&r.height>0){host.style.setProperty('--kin-retained-width',r.width+'px');host.style.setProperty('--kin-retained-height',r.height+'px');}}
    host.classList.toggle('kin-retained-viewer',!active&&!!frame&&!!host.style.getPropertyValue('--kin-retained-width'));
    host.inert=!active;host.setAttribute('aria-hidden',String(!active));
    document.body.classList.toggle('reading', active); bar.hidden = host.hidden = reportTarget.hidden = !active;
    if (!active) {
      document.body.classList.remove('reading-list-open', 'reading-context-open');
      list.setAttribute('aria-expanded', 'false'); context.setAttribute('aria-expanded', 'false');
    }
    app.layout();
    renderPanels();
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
          window.KinViewerWorkspaceDock?.(w,{owner:app.noteOwner,allowed:()=>!ended&&app.allowed()});
          // Keyboard events do not bubble out of an iframe. Bind each real
          // viewer document once, including documents replaced by job restore.
          if (!boundDocuments.has(doc)) {
            doc.addEventListener('keydown', e => keyboard(e, doc), true); boundDocuments.add(doc);
          }
          const keyMap=shortcuts.read();
          for(const [id,selector] of Object.entries({image:'#kin-viewer-focus-2',report:'#kin-viewer-focus-4',tools:'#kin-viewer-focus-7',nativeTools:'#kin-viewer-focus-9',note:'#kin-viewer-note-open'}))doc.querySelector(selector)?.setAttribute('aria-keyshortcuts',KinWorkspaceShortcuts.display(keyMap[id]));
          const toolHint=doc.querySelector('#kin-viewer-tool-focus > p');
          if(toolHint){const key=id=>keyMap[id].replace(/^Digit|^Key/,'');toolHint.textContent='Ctrl+Alt+'+key('tools')+' 측정 도구 · 8 비교 작업 도구 · '+key('nativeTools')+' 기본 영상 도구 (Tab 이동·Enter 선택) · '+key('image')+' 선택 영상 · '+key('report')+' 판독문으로';}
          if (!loaded) {
            loaded = true; failed = false; frame.inert = false;
            if (sameTarget()) { pending = null; recovery.hidden = true; status.textContent = '영상 작업공간 연결됨'; identify(); }
          }
          // Display preferences also apply to a retained hidden viewer. Clinical
          // actions keep the active/current/visible checks in allowed().
          w.kinViewerEnablePatientCopy?.({owner:app.noteOwner,allowed:()=>!ended&&app.allowed()&&active&&sameTarget()&&currentFrame===frame&&!frame.hidden&&!frame.inert&&!modalOpen(document),toolbarAllowed:()=>!ended&&app.allowed()&&currentFrame===frame});
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
  function end() { ended = true; cancelPanelDrag(); panelObserver.disconnect(); window.removeEventListener('resize', panelWindowResize); shortcuts.end(); epoch++; returnChannel?.close();returnChannel=null;clearInterval(timer); timer = null; queueObserver.disconnect(); document.removeEventListener('keydown', parentKeyboard, true); frame?.remove(); frame = null; shown = pending = null; loaded = false; active = false; layout(); identify(); }
  let channel;
  try { channel = new BroadcastChannel('kin-session'); channel.onmessage = e => { if (e.data?.type === 'session-ended') end(); }; } catch (_) {}
  window.addEventListener('storage', e => { if (e.key === 'kin-session-ended') end(); });
  window.addEventListener('pagehide', () => { end(); channel?.close(); });
  window.addEventListener('beforeunload', e => { const s = viewerState(); if (s.busy || s.dirty) { e.preventDefault(); e.returnValue = ''; } });
  return { open, openJob, resume, exit: leave, selectionChanged, refreshNote: updateNote, active: () => active, end, snapshotPanels, applyPanels,
    preferences: { host: nav, read: () => autoNote.checked, generation: () => preferenceGeneration,
      apply: value => { syncAutoNote(); if (autoNote.disabled) return false; autoNote.checked = value; autoNote.onchange(); return true; } } };
};
