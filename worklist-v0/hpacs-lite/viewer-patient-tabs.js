window.KinViewerPatientTabs = (() => {
  // Document-local tabs survive the stock router's mode teardown. Clinical
  // controllers still enter/exit normally for each URL; no second grid exists.
  const tabs = [], listeners = new Set();
  let current = null, services, refreshChrome, host, status, sequence = 0, pending = false, mounted = false;
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
    if (states.some(state => !state || state.busy || state.dirty) || document.querySelector('dialog[open]') || window.kinMprMarks?.dirty?.()) {
      if (status) status.textContent = '저장·편집을 마친 뒤 환자를 전환하세요. 현재 화면을 유지합니다.';
      return false;
    }
    return !coverage || window.kinViewerFrameCoverageConfirm?.(message => window.confirm(message)) === true;
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
    const matches = saved.cells.map(cell => cell.series ? sets.filter(set => set.StudyInstanceUID === cell.study && set.SeriesInstanceUID === cell.series) : []);
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
        if (v.getCurrentImageId() !== cell.image) await v.setImageIdIndex(imageIndex);
        await new Promise(requestAnimationFrame);
        if (current !== tab || epoch !== mountEpoch || !mounted) return;
        // Complete the info/series chrome before fitting the recreated canvas.
        // Loading headings have a different height from the real patient label.
        refreshChrome();
        services.cornerstoneViewportService.resize(true);
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
      button.onclick = () => open(tab.href);
      button.onkeydown = event => {
        const index = tabs.indexOf(tab);
        const next = event.key === 'ArrowRight' ? tabs[(index + 1) % tabs.length] : event.key === 'ArrowLeft' ? tabs[(index + tabs.length - 1) % tabs.length] : event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : null;
        if (next) { event.preventDefault(); focusAfterMount = next !== current; open(next.href).then(ok => {
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
    document.body.classList.toggle('kin-viewer-empty', !current && !pending);
  }
  async function resolve(href, signal) {
    const wanted = studies(href), response = await fetch('/api/studies', { credentials: 'same-origin', signal });
    if (!response.ok) throw new Error('환자 정보를 불러오지 못했습니다. 다시 시도하세요.');
    const result = await response.json(), rows = wanted.map(uid => result.studies?.find(row => row.uid === uid));
    if (!rows.length || rows.some(row => !row?.sourcePatientKey) || rows.some(row => row.sourcePatientKey !== rows[0].sourcePatientKey))
      throw new Error('같은 환자의 검사인지 확인할 수 없어 현재 화면을 유지합니다.');
    const row = rows[0], born = String(row.birth || '').replace(/-/g, ''), date = String(row.date || '').replace(/-/g, '');
    const years = /^\d{8}$/.test(born) && /^\d{8}$/.test(date) ? Math.floor((Number(date) - Number(born)) / 10000) : -1;
    return { key: row.sourcePatientKey, href: new URL(href, location.origin).href, studies: wanted,
      patient: { name: text(row.name) || 'Unknown', id: text(row.id) || 'Unknown', age: years >= 0 ? years + 'Y' : 'Unknown', sex: text(row.sex) || 'Unknown' } };
  }
  function navigate(tab) {
    tab.restorePending = !!tab.view;
    current = tab; pending = false; render(); publish();
    if (location.href === tab.href) { restore(); return; }
    // The pinned BrowserRouter consumes the native popstate event. Its route
    // lifecycle tears down study-scoped extensions before new pixels mount.
    document.body.classList.add('kin-patient-switching');
    // Tabs own their navigation; avoid adding browser-back entries that could
    // bypass the existing unsaved-work guard.
    history.replaceState(history.state, '', tab.href);
    window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
  }
  async function open(href) {
    const url = new URL(href, location.origin);
    if (url.origin !== location.origin || url.pathname !== '/ohif/viewer') return false;
    if (current && JSON.stringify(studies(href)) === JSON.stringify(current.studies)) {
      if (pending) { sequence++; controller?.abort(); pending = false; render(); publish(); }
      return true;
    }
    if (!guard()) return false;
    const ticket = ++sequence; controller?.abort(); controller = new AbortController(); pending = true; pendingHref = url.href;
    try {
      const resolved = await resolve(url.href, controller.signal);
      if (ticket !== sequence || !guard(true)) return false;
      capture();
      let tab = tabs.find(tab => tab.key === resolved.key);
      if (!tab) { tab = resolved; tabs.push(tab); }
      else if (JSON.stringify(tab.studies) !== JSON.stringify(resolved.studies)) {
        // A patient can have several examinations. Preserve the tab identity,
        // but never restore the previous examination over the requested one.
        Object.assign(tab, resolved, { view: null });
      }
      navigate(tab); return true;
    } catch (error) { if (ticket === sequence && error.name !== 'AbortError') status.textContent = error.message; return false; }
    finally { if (ticket === sequence) { pending = false; render(); } }
  }
  async function close(tab) {
    // Closing a tab also cancels a lookup started by selecting that tab, so
    // its delayed response cannot reopen it after the user's close action.
    if (pending && pendingHref === tab.href) { sequence++; controller?.abort(); pending = false; }
    if (tab === current) {
      if (!guard()) return false;
      const next = tabs[tabs.indexOf(tab) + 1] || tabs[tabs.indexOf(tab) - 1];
      if (next && !await open(next.href)) return false;
      if (!next && !guard(true)) return false;
      if (!next) { sequence++; controller?.abort(); current = null; publish(); }
    }
    tabs.splice(tabs.indexOf(tab), 1); render(); return true;
  }
  async function mount(options) {
    services = options.services; refreshChrome = options.refreshChrome; mounted = true; const epoch = ++mountEpoch;
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
    host.append(list, status, retry, empty); refresh();
    window.kinViewerOpenPatient = open;
    async function loadPatient() {
      const ticket = sequence;
      retry.hidden = true;
      try {
      const resolved = await resolve(location.href);
      if (!mounted || epoch !== mountEpoch || ticket !== sequence) return;
      let tab = tabs.find(tab => tab.key === resolved.key);
      if (!tab) { tab = resolved; tabs.push(tab); }
      current = tab; status.textContent = ''; render(); publish(); restore();
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
  return { mount, dispose, refresh, open, guard, snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    end() { sequence++; controller?.abort(); tabs.length = 0; current = null; focusAfterMount = false; publish(); dispose(); delete window.kinViewerOpenPatient; } };
})();
