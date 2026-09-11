/* Hide image text inside verified native stack panes without changing image geometry. */
(function (root) {
  'use strict';
  const uid = value => typeof value === 'string' && value.length <= 64 && /^\d+(?:\.\d+)+$/.test(value);
  const patient = value => typeof value === 'string' && !!value.trim() && value.length <= 64;
  const same = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
  let controller = null, sequence = 0;

  function create(services, options = {}) {
    const doc = options.doc || root.document, win = options.root || doc?.defaultView || root;
    const ownerOf = options.owner || (() => win.kinViewerWindowOwner?.());
    const metadata = options.metadata || (imageId => win.cornerstone?.metaData?.get('instance', imageId));
    const rendered = options.rendered || (() => win.cornerstone?.Enums?.ViewportStatus?.RENDERED || 'rendered');
    const intervalMs = options.intervalMs === 0 ? 0 : Math.max(100, Math.min(1000, options.intervalMs || 250));
    let ended = false, panel = null, toggle = null, status = null, hidden = null, timer = null, channel = null, preserveStatus = false;
    const subscriptions = [], listeners = [];
    const listen = (target, event, handler, settings) => { target?.addEventListener?.(event, handler, settings); listeners.push([target, event, handler, settings]); };
    const live = () => !ended && options.live?.() !== false;
    const owner = () => { try { const value = ownerOf(); return typeof value === 'string' && value.trim() && value.length <= 1024 ? value : null; } catch (_) { return null; } };
    const busy = () => { try { return typeof win.kinViewerHistoryWorkspaceState !== 'function' || typeof win.kinViewerJobWorkspaceState !== 'function' || !!win.kinViewerHistoryWorkspaceState()?.busy || !!win.kinViewerJobWorkspaceState()?.busy; } catch (_) { return true; } };
    const dialogs = () => !!doc.querySelector?.('dialog[open],[role="dialog"][aria-modal="true"],.modal.show');
    const gridSignature = state => JSON.stringify([state.layout || null, [...state.viewports.entries()].sort(([a], [b]) => String(a).localeCompare(String(b))).map(([id, cell]) => [id, cell.x, cell.y, cell.width, cell.height, cell.displaySetInstanceUIDs])]);
    function sourceIdentity(displaySet, imageIds, values, source) {
      return JSON.stringify([displaySet.StudyInstanceUID, displaySet.SeriesInstanceUID, values[0].PatientID, imageIds,
        values.map(value => [value.StudyInstanceUID, value.SeriesInstanceUID, value.PatientID, value.SOPInstanceUID]),
        source.map(value => [value.StudyInstanceUID, value.SeriesInstanceUID, value.PatientID, value.SOPInstanceUID])]);
    }
    function inspect() {
      if (!live() || !doc?.defaultView) throw Error('현재 영상 창을 확인할 수 없습니다.');
      const boundOwner = owner(); if (!boundOwner) throw Error('현재 영상 계정을 확인할 수 없습니다.');
      if (doc.fullscreenElement) throw Error('Images Only를 종료한 뒤 다시 시도하세요.');
      if (dialogs()) throw Error('열린 대화상자를 닫은 뒤 다시 시도하세요.');
      if (busy()) throw Error('저장 또는 영상 작업이 끝난 뒤 다시 시도하세요.');
      const state = services?.viewportGridService?.getState?.();
      if (!state?.viewports?.size) throw Error('표시 중인 일반 영상 칸을 확인하세요.');
      const panes = [], wrappers = new Set();
      for (const [viewportId, cell] of state.viewports) {
        const setIds = cell?.displaySetInstanceUIDs;
        if (!Array.isArray(setIds) || setIds.length !== 1 || !setIds[0]) throw Error('모든 칸에 한 영상 묶음만 표시해야 합니다.');
        const viewport = services?.cornerstoneViewportService?.getCornerstoneViewport?.(viewportId);
        const displaySet = services?.displaySetService?.getDisplaySetByUID?.(setIds[0]);
        if (!viewport || viewport.type !== 'stack' || viewport.viewportStatus !== rendered() || !viewport.element?.isConnected || !displaySet || displaySet.displaySetInstanceUID !== setIds[0]) throw Error('불러온 일반 영상 칸에서만 Image Text를 사용할 수 있습니다.');
        const imageIds = viewport.getImageIds?.(), current = viewport.getCurrentImageId?.();
        const source = Array.isArray(displaySet.images) ? displaySet.images : Array.isArray(displaySet.instances) ? displaySet.instances : null;
        if (!Array.isArray(imageIds) || !imageIds.length || imageIds.length > 2000 || new Set(imageIds).size !== imageIds.length || !imageIds.includes(current) || !source?.length || source.length > 2000 || !uid(displaySet.StudyInstanceUID) || !uid(displaySet.SeriesInstanceUID)) throw Error('영상 원본 목록을 확인할 수 없습니다.');
        const values = imageIds.map(metadata), patientId = values[0]?.PatientID;
        if (!patient(patientId) || values.some(value => !value || value.StudyInstanceUID !== displaySet.StudyInstanceUID || value.SeriesInstanceUID !== displaySet.SeriesInstanceUID || value.PatientID !== patientId || !uid(value.SOPInstanceUID)) || source.some(value => value?.StudyInstanceUID !== displaySet.StudyInstanceUID || value?.SeriesInstanceUID !== displaySet.SeriesInstanceUID || value?.PatientID !== patientId || !uid(value?.SOPInstanceUID))) throw Error('영상의 환자 또는 원본 식별이 일치하지 않습니다.');
        const imageSops = [...new Set(values.map(value => value.SOPInstanceUID))].sort(), rawSourceSops = source.map(value => value.SOPInstanceUID), sourceSops = [...new Set(rawSourceSops)].sort();
        const wrapper = viewport.element.closest?.('[data-cy="viewport-pane"]') || viewport.element.parentElement;
        if (!same(imageSops, sourceSops) || rawSourceSops.length !== sourceSops.length || !wrapper?.isConnected || !wrapper.contains?.(viewport.element) || wrappers.has(wrapper) || !wrapper.querySelector(`.kin-viewer-identity[data-study="${displaySet.StudyInstanceUID}"]`)) throw Error('영상 식별 표시와 원본 목록을 확인하세요.');
        wrappers.add(wrapper);
        panes.push({ viewportId, cell, viewport, element: viewport.element, wrapper, displaySet, displaySetId: setIds[0], imageIds: [...imageIds], identity: sourceIdentity(displaySet, imageIds, values, source) });
      }
      return { owner: boundOwner, grid: gridSignature(state), panes, token: `kit-${++sequence}` };
    }
    function conceal(record) {
      if (record.panes.some(item => item.wrapper.hasAttribute('data-kin-image-text-hidden'))) throw Error('Image Text 표시 소유권이 충돌했습니다.');
      const style = doc.createElement('style'); style.setAttribute('data-kin-image-text-style', record.token);
      style.textContent = `[data-kin-image-text-hidden="${record.token}"] .viewport-overlay,[data-kin-image-text-hidden="${record.token}"] [data-cy^="viewport-overlay-"],[data-kin-image-text-hidden="${record.token}"] .kin-viewer-identity{visibility:hidden!important}`;
      (doc.head || doc.body || doc.documentElement).append(style); record.style = style;
      for (const item of record.panes) item.wrapper.setAttribute('data-kin-image-text-hidden', record.token);
    }
    function restore(record) {
      if (!record) return;
      for (const item of record.panes) if (item.wrapper.getAttribute('data-kin-image-text-hidden') === record.token) item.wrapper.removeAttribute('data-kin-image-text-hidden');
      if (record.style?.getAttribute('data-kin-image-text-style') === record.token) record.style.remove();
    }
    function matches(record) {
      try {
        if (!record || !live() || owner() !== record.owner || doc.fullscreenElement || dialogs() || busy()) return false;
        const state = services.viewportGridService.getState(); if (gridSignature(state) !== record.grid || state.viewports.size !== record.panes.length) return false;
        for (const pane of record.panes) {
          if (state.viewports.get(pane.viewportId) !== pane.cell || services.cornerstoneViewportService.getCornerstoneViewport(pane.viewportId) !== pane.viewport || services.displaySetService.getDisplaySetByUID(pane.displaySetId) !== pane.displaySet || pane.viewport.element !== pane.element || !pane.wrapper.contains(pane.element) || pane.wrapper.getAttribute('data-kin-image-text-hidden') !== record.token) return false;
          const imageIds = pane.viewport.getImageIds?.(), current = pane.viewport.getCurrentImageId?.(), source = Array.isArray(pane.displaySet.images) ? pane.displaySet.images : Array.isArray(pane.displaySet.instances) ? pane.displaySet.instances : null, values = imageIds?.map(metadata);
          if (!Array.isArray(imageIds) || !same(imageIds, pane.imageIds) || !imageIds.includes(current) || !source || values.some(value => !value) || sourceIdentity(pane.displaySet, imageIds, values, source) !== pane.identity) return false;
        }
        return record.style?.isConnected && record.style.getAttribute('data-kin-image-text-style') === record.token;
      } catch (_) { return false; }
    }
    function show(message) {
      const record = hidden; hidden = null; restore(record);
      if (controller === api) controller = null;
      if (toggle) { toggle.textContent = 'Hide Image Text'; toggle.disabled = false; }
      preserveStatus = true;
      refresh();
      if (status && live()) status.textContent = message || 'Image Text를 표시했습니다.';
      Promise.resolve().then(() => { preserveStatus = false; });
    }
    function observe() {
      if (!hidden) { refresh(); return; }
      if (!matches(hidden)) show('영상 구성이 바뀌어 Image Text를 표시했습니다.');
      else return;
    }
    function refresh() {
      if (!toggle || hidden) return;
      let reason = controller && controller !== api ? '다른 Image Text 작업을 먼저 종료하세요.' : '';
      try { if (!reason) inspect(); } catch (error) { reason = error.message; }
      toggle.disabled = ended || !!reason; toggle.title = reason || '현재 영상 칸의 문자 정보를 숨깁니다.';
      if (reason && status && !preserveStatus) status.textContent = reason;
    }
    function toggleText() {
      if (!panel?.isConnected || controller && controller !== api) return;
      if (hidden) { show(); return; }
      let record = null;
      try {
        record = inspect(); conceal(record); hidden = record; controller = api;
        toggle.textContent = 'Show Image Text'; status.textContent = 'Image Text를 숨겼습니다.';
      } catch (error) { restore(record); hidden = null; status.textContent = error.message; refresh(); }
    }
    function end() {
      if (ended) return; ended = true;
      if (hidden) show(); if (controller === api) controller = null;
      if (timer) win.clearInterval(timer); timer = null;
      subscriptions.splice(0).forEach(item => { try { item?.unsubscribe?.(); } catch (_) {} });
      listeners.splice(0).forEach(([target, event, handler, settings]) => target?.removeEventListener?.(event, handler, settings));
      channel?.close?.(); channel = null; panel?.remove(); panel = toggle = status = null;
    }
    function mount(host = doc.getElementById('kin-viewer-layout')) {
      if (ended || panel || !host?.isConnected) return false;
      panel = doc.createElement('section'); panel.id = 'kin-image-text';
      toggle = doc.createElement('button'); toggle.type = 'button'; toggle.id = 'kin-image-text-toggle'; toggle.textContent = 'Hide Image Text'; toggle.addEventListener('click', toggleText); panel.append(toggle);
      status = doc.createElement('p'); status.id = 'kin-image-text-status'; status.setAttribute('role', 'status'); status.textContent = 'Image Text · 영상 정보가 표시됩니다.'; panel.append(status); host.append(panel);
      listen(doc, 'fullscreenchange', observe); listen(win, 'pagehide', end);
      listen(win, 'storage', event => { if (event.key === 'kin-session-ended') end(); });
      try { channel = new win.BroadcastChannel('kin-session'); channel.onmessage = event => { if (event.data?.type === 'session-ended') end(); }; } catch (_) {}
      for (const service of [services?.viewportGridService, services?.displaySetService]) for (const event of new Set(Object.values(service?.EVENTS || {}))) try { subscriptions.push(service.subscribe(event, observe)); } catch (_) {}
      for (const event of ['PRE_STACK_NEW_IMAGE', 'STACK_NEW_IMAGE', 'IMAGE_RENDERED'].map(name => win.cornerstone?.Enums?.Events?.[name]).filter(Boolean)) listen(doc, event, observe, true);
      if (intervalMs) timer = win.setInterval(observe, intervalMs);
      refresh(); return true;
    }
    const api = { mount, stop: end, isHidden: () => !!hidden && controller === api };
    return api;
  }
  const api = { create };
  root.KinViewerImageText = api;
  root.kinViewerImageTextHidden = () => !!controller?.isHidden?.();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window === 'undefined' ? globalThis : window);
