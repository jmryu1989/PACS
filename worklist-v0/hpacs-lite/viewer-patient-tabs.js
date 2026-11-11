window.KinViewerPatientTabs = (() => {
  // Document-local tabs survive the stock router's mode teardown. Clinical
  // controllers still enter/exit normally for each URL; no second grid exists.
  const tabs = [], listeners = new Set();
  let current = null, explicitlyClosed = false, session, services, refreshChrome, host, status, sequence = 0, pending = false, mounted = false;
  let controller, pendingHref, restoreSubscription, dataSubscription, dataReady, mountEpoch = 0, focusAfterMount = false;
  const text = value => typeof value === 'object' && value !== null
    ? String(value.Alphabetic || value.Ideographic || value.Phonetic || '') : String(value ?? '');
  const studies = href => (new URL(href, location.origin).searchParams.get('StudyInstanceUIDs') || '').split(',').filter(Boolean);
  const snapshot = () => current ? { key: current.key, studyUIDs: [...current.studies], patient: { ...current.patient }, sequence } : null;
  const publish = () => { const value = snapshot(); listeners.forEach(listener => listener(value)); };
  function refresh() {
    const header = document.getElementById('kin-viewer-brand')?.closest('.bg-secondary-dark.z-20');
    if (host && header && host.parentElement !== header.parentElement) header.parentElement.prepend(host);
    restore();
  }
  function guard(coverage = false) {
    const states = [window.kinViewerHistoryWorkspaceState?.(), window.kinViewerJobWorkspaceState?.()];
    if (states.some(state => state?.busy || state?.dirty) || document.querySelector('dialog[open]') || window.kinMprMarks?.dirty?.()) {
      if (status) status.textContent = '저장·편집을 마친 뒤 환자를 전환하세요. 현재 화면을 유지합니다.';
      return false;
    }
    return !coverage || window.kinViewerFrameCoverageConfirm?.(message => window.confirm(message)) === true;
  }
  // C-R01-139: leaving the tab of a study whose report text the reading screen has not had confirmed by the server is
  // leaving that study. Before a tab is left, this window asks every live reading screen of its own session
  // ('kin-report-unconfirmed', feature-mounts.js) to save the text of the tab's studies through its own study-move gate
  // (leaveStudyGate) and switches only when every one answered and none still holds such text or refused. Otherwise it
  // stays and says so, with Retry (save again), Check (ask again; nothing is written) and Stay (close the message).
  // There is no "leave anyway", as in the reading screen's own notice. A reading screen is live while it holds the Web
  // Lock `kin-report-reader:<session>:<document>` (the browser drops it when that page closes or crashes); one that does
  // not answer is never taken as saved. Opens the reading screen itself asks for (viewer-launch.js) passed its gate.
  const announced = new Map(), waits = new Map();
  let link = null, leaving = null;
  const LEAVE_WAIT_MS = 4000, CHECK_WAIT_MS = 1500, BUSY_SHOWN_MS = 250, READER = 'kin-report-reader:';
  function ownSession() {
    try {
      const gate = window.KinWorkContext;
      return gate && ['active', 'preparing'].includes(gate.state()) ? gate.session() || null : null;
    } catch (_) { return null; }
  }
  function reportLink() {
    if (link) return link;
    try { link = new BroadcastChannel('kin-report-unconfirmed'); link.unref?.(); } catch (_) { link = null; return null; }
    link.onmessage = event => {
      const m = event.data;
      if (!m || typeof m.id !== 'string' || typeof m.session !== 'string' || m.session !== ownSession()) return;
      if (m.type === 'gone') { announced.delete(m.id); return; }
      announced.set(m.id, m.session);
      const wait = m.type === 'answer' && typeof m.request === 'string' ? waits.get(m.request) : null;
      if (wait && wait.ids.has(m.id)) { wait.answers.set(m.id, m); if ([...wait.ids].every(id => wait.answers.has(id))) wait.finish(); }
    };
    const session = ownSession();
    if (session) link.postMessage({ type: 'hello', session });
    return link;
  }
  // The reading screens of this session that are open now: by their Web Locks, or (no lock manager) by their announcements.
  async function liveReaders(session) {
    const prefix = READER + session + ':';
    try {
      if (navigator.locks?.query) {
        const { held = [] } = await navigator.locks.query();
        return new Set(held.map(lock => lock.name).filter(name => typeof name === 'string' && name.startsWith(prefix))
          .map(name => name.slice(prefix.length)));
      }
    } catch (_) {}
    return new Set([...announced].filter(([, owner]) => owner === session).map(([id]) => id));
  }
  // Each live reading screen's answer for these studies; one that does not answer within `ms` is missing from the map.
  async function ask(type, uids, ms) {
    const session = ownSession(), channel = reportLink();
    if (!session || !channel) return { ids: new Set(), answers: new Map() };
    const ids = await liveReaders(session);
    if (!ids.size) return { ids, answers: new Map() };
    const request = Date.now().toString(36) + Math.random().toString(36).slice(2);
    return new Promise(resolve => {
      const wait = { ids, answers: new Map(), finish() { clearTimeout(timer); waits.delete(request); resolve(wait); } };
      const timer = setTimeout(() => wait.finish(), ms);
      waits.set(request, wait);
      try { channel.postMessage({ type, request, uids, session }); } catch (_) { wait.finish(); }
    });
  }
  const REASONS = { unknown: '저장 결과를 확인하지 못했습니다',
    conflict: '서버의 초안이 판독 화면의 글과 다릅니다. 판독 화면에서 Keep This Text 또는 Load Server Draft를 고르세요',
    composing: '판독 화면의 글자 조합(한글 입력)이 끝나지 않았습니다', stale: '판독 화면의 검사나 작업이 바뀌었습니다',
    held: '판독 화면에 아직 저장이 확인되지 않은 글이 있습니다' };
  // Why the tab is kept: null only when every live reading screen answered, none refused and none holds the tab's text.
  function kept({ ids, answers }) {
    if ([...ids].some(id => !answers.has(id))) return '판독 화면의 응답이 없습니다';
    for (const m of answers.values()) {
      const result = m.result;
      if (result && !['clear', 'saved'].includes(result.status))
        return result.reason || REASONS[result.status] || '서버가 저장을 받지 않았습니다';
      if (!Array.isArray(m.held) || m.held.length) return REASONS.held;
    }
    return null;
  }
  // An answer tells the moment it was given. Before moving on a clear one, the reading screens are read once more
  // (nothing is written): text typed while that answer was on its way keeps this tab.
  async function settled(tab, first) {
    const reason = kept(first);
    return reason === null ? kept(await ask('check', tab.studies, CHECK_WAIT_MS)) : reason;
  }
  // Resolves true when the current tab may be left now; otherwise the message is shown and this window stays.
  async function leave() {
    const tab = current;
    if (!tab) { endLeave(); return true; }
    if (leaving?.busy) return false;
    const notice = leaving = { tab, go: leaving?.tab === tab ? leaving.go : null, busy: 'save', reason: '', shown: !!leaving?.shown };
    // An ordinary switch is answered at once; the saving line shows only when the reading screen's save takes time.
    const shown = setTimeout(() => { if (leaving === notice) { notice.shown = true; renderLeave(); } }, BUSY_SHOWN_MS);
    const reason = await settled(tab, await ask('save', tab.studies, LEAVE_WAIT_MS));
    clearTimeout(shown);
    if (leaving !== notice || current !== tab) return false;
    if (reason === null) { endLeave(); return true; }
    Object.assign(notice, { busy: null, reason, shown: true }); renderLeave();
    return false;
  }
  // `go` continues the move the message holds, without passing the gate again (the answer just given is its gate).
  async function gated(go) {
    if (!await leave()) { if (leaving) leaving.go = go; return false; }
    return go();
  }
  async function resume(kind) {
    const notice = leaving;
    if (!notice || notice.busy || current !== notice.tab || !notice.go) return;
    if (kind === 'save') { if (await leave()) notice.go(); return; }
    notice.busy = 'check'; renderLeave();
    const reason = await settled(notice.tab, await ask('check', notice.tab.studies, CHECK_WAIT_MS));
    if (leaving !== notice || current !== notice.tab) return;
    if (reason === null) { endLeave(); notice.go(); return; }
    Object.assign(notice, { busy: null, reason }); renderLeave();
  }
  function endLeave() { leaving = null; renderLeave(); }
  function renderLeave() {
    const box = host?.querySelector('.kin-patient-leave');
    if (!box) return;
    if (leaving && leaving.tab !== current) leaving = null;
    const notice = leaving?.shown ? leaving : null;
    box.hidden = !notice; box.replaceChildren();
    if (!notice) return;
    const name = notice.tab.patient.name, strong = document.createElement('b');
    strong.textContent = '● ' + (notice.busy ? 'Saving' : 'Save Not Confirmed');
    box.append(strong, notice.busy ? ` — ${name}의 판독문 저장을 판독 화면에서 확인하는 중입니다. 환자를 아직 바꾸지 않았습니다.`
      : ` — ${name}의 판독문 저장이 확인되지 않아 환자를 바꾸지 않았습니다 (${notice.reason}). 쓰던 글은 판독 화면에 그대로 있습니다.`);
    for (const [label, title, action] of [
      ['Retry', '판독 화면에서 쓰던 글을 다시 저장하고, 저장되면 이동합니다', () => resume('save')],
      ['Check', '판독 화면의 저장 상태를 다시 확인하고(저장하지 않습니다), 확인되면 이동합니다', () => resume('check')],
      ['Stay', '이 환자에 머뭅니다 (안내만 닫습니다)', () => { endLeave(); host?.querySelector('[aria-selected=true]')?.focus(); }]]) {
      const control = document.createElement('button'); control.type = 'button'; control.textContent = label; control.title = title;
      control.disabled = !!notice.busy && label !== 'Stay'; control.onclick = action; box.append(control);
    }
  }
  async function switchTo(tab) {
    return tab === current ? open(tab.href) : gated(() => open(tab.href));
  }
  function capture() {
    if (!current) return;
    const state = services.viewportGridService.getState(), cells = [...state.viewports.values()];
    // Restore the supported regular stack grid, including its image/camera.
    // Other native modes reopen through their normal mode/HP initialization.
    if (state.layout.layoutType !== 'grid' || cells.length !== state.layout.numRows * state.layout.numCols) { current.view = null; return; }
    const views = cells.map(cell => {
      const v = services.cornerstoneViewportService.getCornerstoneViewport(cell.viewportId);
      const sets = (cell.displaySetInstanceUIDs || []).map(id => services.displaySetService.getDisplaySetByUID(id));
      if (sets.length && (v?.type !== 'stack' || sets.length !== 1)) return null;
      return { series: sets[0]?.SeriesInstanceUID, study: sets[0]?.StudyInstanceUID,
        image: v?.getCurrentImageId?.(), index: v?.getCurrentImageIdIndex?.(),
        size: v?.canvas && [v.canvas.width, v.canvas.height],
        camera: structuredClone(v?.getCamera?.()), presentation: structuredClone(v?.getViewPresentation?.({ pan: true, zoom: true })), properties: structuredClone(v?.getProperties?.()) };
    });
    current.view = views.every(Boolean) ? { rows: state.layout.numRows, cols: state.layout.numCols,
      active: cells.findIndex(cell => cell.viewportId === state.activeViewportId), cells: views } : null;
  }
  function restore() {
    const tab = current, saved = tab?.view;
    if (!saved || !tab.restorePending) return;
    // Let the stock route finish creating its first viewport before replacing
    // its initial layout; display-set events arrive before that layout exists.
    const started = [...services.viewportGridService.getState().viewports.keys()].some(id => {
      const rendered = window.KinViewerInfoBar.identity(services, id).instance;
      return rendered && tab.studies.includes(rendered.StudyInstanceUID) &&
        dataReady?.has(id);
    });
    if (!started) return;
    const sets = services.displaySetService.getActiveDisplaySets();
    const matches = saved.cells.map(cell => {
      if (!cell.series) return [];
      const same = sets.filter(set => set.StudyInstanceUID === cell.study && set.SeriesInstanceUID === cell.series);
      // A series the viewer split into several display sets returns to the one holding the image this cell showed.
      return same.length > 1 ? same.filter(set => !!cell.image && set.images?.some(image => image?.imageId === cell.image)) : same;
    });
    if (matches.some((match, i) => saved.cells[i].series && match.length !== 1)) return;
    tab.restorePending = false;
    const ids = saved.cells.map(() => 'kin-tab-' + crypto.randomUUID());
    const epoch = mountEpoch, restored = new Set(), ready = new Set();
    const onImage = async () => {
      if (current !== tab || epoch !== mountEpoch || !mounted) return;
      for (let index = 0; index < ids.length; index++) {
        if (restored.has(index)) continue;
        const cell = saved.cells[index], v = services.cornerstoneViewportService.getCornerstoneViewport(ids[index]);
        if (!cell.image) { restored.add(index); continue; }
        if (!ready.has(ids[index])) continue;
        const imageIndex = v?.getImageIds?.().indexOf(cell.image);
        if (imageIndex == null || imageIndex < 0 || !v.getCurrentImageId?.()) continue;
        restored.add(index);
        // The pinned setter does not retarget the next wheel/arrow step.
        clearTimeout(v.debouncedTimeout);
        v.targetImageIdIndex = imageIndex;
        if (v.getCurrentImageId() !== cell.image) await v.setImageIdIndex(imageIndex);
        await new Promise(requestAnimationFrame);
        if (current !== tab || epoch !== mountEpoch || !mounted) return;
        // Complete the info/series chrome before fitting the recreated canvas.
        // Loading headings have a different height from the real patient label.
        refreshChrome();
        if (cell.properties) v.setProperties(cell.properties);
        if (cell.camera) v.setCamera({ flipHorizontal: cell.camera.flipHorizontal, flipVertical: cell.camera.flipVertical });
        if (cell.size?.[0] === v.canvas.width && cell.size?.[1] === v.canvas.height) {
          const { flipHorizontal, flipVertical, ...camera } = cell.camera;
          v.setCamera(camera);
        } else if (cell.presentation) v.setViewPresentation(cell.presentation);
        v.render();
      }
      if (restored.size === ids.length) subscription.unsubscribe();
    };
    restoreSubscription?.();
    // As in the existing stack restore adapter, native viewport data is the
    // readiness boundary. Its first image event precedes native presentation
    // restoration; applying a camera there is subsequently overwritten.
    const subscription = services.cornerstoneViewportService.subscribe(
      services.cornerstoneViewportService.EVENTS.VIEWPORT_DATA_CHANGED, ({ viewportId }) => {
        if (!ids.includes(viewportId)) return;
        ready.add(viewportId);
        queueMicrotask(() => onImage().catch(error => { if (mounted && epoch === mountEpoch) status.textContent = error.message; }));
      });
    restoreSubscription = () => subscription.unsubscribe();
    services.viewportGridService.setLayout({ numRows: saved.rows, numCols: saved.cols, activeViewportId: ids[saved.active],
      isHangingProtocolLayout: false, findOrCreateViewport: index => ({ displaySetInstanceUIDs: matches[index].map(set => set.displaySetInstanceUID),
        displaySetOptions: [{}], viewportOptions: { viewportId: ids[index], viewportType: 'stack', toolGroupId: 'default', allowUnmatchedView: true,
          presentationIds: { positionPresentationId: ids[index], lutPresentationId: ids[index] },
          ...(saved.cells[index].image ? { initialImageOptions: { index: saved.cells[index].index, useOnce: true } } : {}) } }) });
  }
  function render() {
    if (!host) return;
    const list = host.querySelector('[role=tablist]'); list.replaceChildren();
    for (const tab of tabs) {
      const row = document.createElement('div'); row.className = 'kin-patient-tab';
      const button = document.createElement('button'); button.type = 'button'; button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(tab === current)); button.tabIndex = tab === current ? 0 : -1;
      const p = tab.patient; button.textContent = [p.name, p.id, p.age, p.sex].join(' | ');
      button.onclick = () => switchTo(tab);
      button.onkeydown = event => {
        const index = tabs.indexOf(tab);
        const next = event.key === 'ArrowRight' ? tabs[(index + 1) % tabs.length] : event.key === 'ArrowLeft' ? tabs[(index + tabs.length - 1) % tabs.length] : event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : null;
        if (next) { event.preventDefault(); focusAfterMount = next !== current; switchTo(next).then(ok => {
          if (ok) host?.querySelector('[aria-selected=true]')?.focus(); else focusAfterMount = false;
        }); }
        if (event.key === 'Delete') { event.preventDefault(); focusAfterMount = tabs.length > 1; close(tab).then(ok => {
          if (ok) host?.querySelector('[aria-selected=true]')?.focus(); else focusAfterMount = false;
        }); }
      };
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×';
      remove.setAttribute('aria-label', 'Close ' + p.name + ' ' + p.id); remove.onclick = () => close(tab);
      row.append(button, remove); list.append(row);
    }
    document.body.classList.toggle('kin-viewer-empty', explicitlyClosed && !current && !pending);
    renderLeave();
  }
  async function resolve(href, signal) {
    const wanted = studies(href), found = new Map();
    if (session.state() === 'unconfirmed') await session.decide();
    const endpoint = session.readOnly() ? '/api/clinician/studies' : '/api/studies';
    // Match only the open studies through the existing scoped endpoint. The
    // source UID lookup accepts at most 100 UIDs per request.
    for (let offset = 0; offset < wanted.length; offset += 100) {
      const query = new URLSearchParams({ uids: wanted.slice(offset, offset + 100).join(',') });
      const response = await fetch(endpoint + '?' + query, { credentials: 'same-origin', signal });
      if (!response.ok) throw new Error('환자 정보를 불러오지 못했습니다. 영상은 계속 볼 수 있습니다. 다시 시도하세요.');
      const result = await response.json();
      for (const row of result.studies || []) if (wanted.includes(row.uid)) found.set(row.uid, row);
    }
    const rows = wanted.map(uid => found.get(uid));
    if (!rows.length || rows.some(row => !row?.sourcePatientKey) || rows.some(row => row.sourcePatientKey !== rows[0].sourcePatientKey))
      throw new Error('같은 환자의 검사인지 확인할 수 없어 현재 화면을 유지합니다.');
    const row = rows[0], born = String(row.birth || '').replace(/-/g, ''), date = String(row.date || '').replace(/-/g, '');
    const years = /^\d{8}$/.test(born) && /^\d{8}$/.test(date) ? Math.floor((Number(date) - Number(born)) / 10000) : -1;
    return { key: row.sourcePatientKey, href: new URL(href, location.origin).href, studies: wanted,
      patient: { name: text(row.name) || 'Unknown', id: text(row.id) || 'Unknown', age: years >= 0 ? years + 'Y' : 'Unknown', sex: text(row.sex) || 'Unknown' } };
  }
  function navigate(tab, opening) {
    // The tab's new opening is taken before its scope is exposed, so every read it starts names that opening.
    opening.commit();
    tab.restorePending = !!tab.view;
    current = tab; explicitlyClosed = false; pending = false; render(); publish();
    if (location.href === tab.href) { restore(); return; }
    // The pinned BrowserRouter consumes the native popstate event. Its route
    // lifecycle tears down study-scoped extensions before new pixels mount.
    document.body.classList.add('kin-patient-switching');
    // Tabs own their navigation; avoid adding browser-back entries that could
    // bypass the existing unsaved-work guard.
    history.replaceState(history.state, '', tab.href);
    window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
  }
  async function open(href, { signal } = {}) {
    if (signal?.aborted) return false;
    const url = new URL(href, location.origin);
    if (url.origin !== location.origin || url.pathname !== '/ohif/viewer') return false;
    if (current && JSON.stringify(studies(href)) === JSON.stringify(current.studies)) {
      if (pending) { sequence++; controller?.abort(); pending = false; render(); publish(); }
      return true;
    }
    if (!guard()) return false;
    const ticket = ++sequence; controller?.abort(); controller = new AbortController(); pending = true; pendingHref = url.href;
    // A caller can close or replace its composition while patient resolution is pending.
    // Cancel only that admission; a newer patient request owns its own controller and sequence.
    const cancel = () => {
      if (ticket !== sequence) return;
      sequence++; controller.abort(); pending = false; render(); publish();
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const resolved = await resolve(url.href, controller.signal);
      if (signal?.aborted || ticket !== sequence || !guard(true)) return false;
      // Showing these studies is a new opening of each (opening contract 2026-10-29). One this document showed before is
      // read live for it first, so its 열람 is recorded before pixels still held here can show; when it cannot be, the
      // current screen stays. A same-scope Open returned above and keeps its opening.
      const opening = await (window.KinViewerSessionBoundary?.reenter(resolved.studies, controller.signal) ?? { commit() {} });
      if (signal?.aborted || ticket !== sequence) return false;
      if (!opening) { status.textContent = '영상 열람 기록을 저장하지 못해 환자를 전환하지 않았습니다. 다시 시도하세요.'; return false; }
      capture();
      let tab = tabs.find(tab => tab.key === resolved.key);
      if (!tab) { tab = resolved; tabs.push(tab); }
      else if (JSON.stringify(tab.studies) !== JSON.stringify(resolved.studies)) {
        // A patient can have several examinations. Preserve the tab identity,
        // but never restore the previous examination over the requested one.
        Object.assign(tab, resolved, { view: null });
      }
      navigate(tab, opening); return true;
    } catch (error) { if (ticket === sequence && error.name !== 'AbortError') status.textContent = error.message; return false; }
    finally {
      signal?.removeEventListener('abort', cancel);
      // A refused lookup/confirmation/opening still advanced the generation.
      // Consumers must adopt the retained tab once this admission has ended.
      if (ticket === sequence && pending) { pending = false; render(); publish(); }
    }
  }
  async function close(tab, left = false) {
    // Closing a tab also cancels a lookup started by selecting that tab, so
    // its delayed response cannot reopen it after the user's close action.
    if (pending && pendingHref === tab.href) { sequence++; controller?.abort(); pending = false; }
    if (tab === current) {
      if (!guard()) return false;
      if (!left) return gated(() => close(tab, true));
      if (tab !== current || !tabs.includes(tab)) return false;
      const next = tabs[tabs.indexOf(tab) + 1] || tabs[tabs.indexOf(tab) - 1];
      if (next && !await open(next.href)) return false;
      if (!next && !guard(true)) return false;
      if (!next) { sequence++; controller?.abort(); current = null; explicitlyClosed = true; publish(); }
    }
    tabs.splice(tabs.indexOf(tab), 1); render(); return true;
  }
  async function mount(options) {
    services = options.services; session = options.session; refreshChrome = options.refreshChrome; mounted = true; const epoch = ++mountEpoch;
    dataReady = new Set();
    dataSubscription = services.cornerstoneViewportService.subscribe(
      services.cornerstoneViewportService.EVENTS.VIEWPORT_DATA_CHANGED, ({ viewportId }) => {
        dataReady.add(viewportId);
        // getViewportData is assigned before setStack completes. Replacing its
        // viewport then leaves the pending image callback with a dead renderer.
        queueMicrotask(() => { if (mounted && epoch === mountEpoch) restore(); });
      });
    host = document.createElement('section'); host.className = 'kin-patient-tabs'; host.dataset.kinUxOwned = '';
    const list = document.createElement('div'); list.setAttribute('role', 'tablist'); list.setAttribute('aria-label', 'Patients');
    status = document.createElement('span'); status.setAttribute('role', 'status');
    const empty = document.createElement('p'); empty.className = 'kin-patient-empty'; empty.textContent = 'No Patient — 목록에서 검사를 여세요.';
    const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry Patient'; retry.hidden = true;
    const leaveBox = document.createElement('div'); leaveBox.className = 'kin-patient-leave'; leaveBox.setAttribute('role', 'alert'); leaveBox.hidden = true;
    host.append(list, status, leaveBox, retry, empty); refresh(); reportLink();
    window.kinViewerOpenPatient = open;
    async function loadPatient() {
      const ticket = sequence;
      retry.hidden = true;
      try {
      const resolved = current?.href === location.href ? current : await resolve(location.href);
      if (!mounted || epoch !== mountEpoch || ticket !== sequence) return;
      let tab = tabs.find(tab => tab.key === resolved.key);
      if (!tab) { tab = resolved; tabs.push(tab); }
      current = tab; explicitlyClosed = false; status.textContent = ''; render(); publish(); restore();
      if (focusAfterMount) { host.querySelector('[aria-selected=true]')?.focus(); focusAfterMount = false; }
      document.body.classList.remove('kin-patient-switching');
      } catch (error) {
        if (mounted && epoch === mountEpoch && ticket === sequence) {
          render(); status.textContent = error.message; retry.hidden = false;
          document.body.classList.remove('kin-patient-switching');
        }
      }
    }
    retry.onclick = loadPatient;
    await loadPatient();
  }
  function dispose() {
    mounted = false; mountEpoch++; dataSubscription?.unsubscribe(); dataSubscription = null; dataReady = null; restoreSubscription?.(); restoreSubscription = null; host?.remove(); host = null;
  }
  return { mount, dispose, refresh, open, guard, snapshot, resolve,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    end() { sequence++; controller?.abort(); tabs.length = 0; current = null; explicitlyClosed = false; focusAfterMount = false; publish(); dispose(); delete window.kinViewerOpenPatient;
      leaving = null; announced.clear(); for (const wait of [...waits.values()]) wait.finish(); link?.close(); link = null; } };
})();
