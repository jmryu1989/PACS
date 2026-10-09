/* The pinned OHIF stack takes initialImageOptions.index before its first image.
 * Keep that index unchanged: its overlay snapshots it before subscribing to scroll.
 * Each restore owns fresh viewport and presentation IDs, native data readiness and
 * the render of the saved display. Neither actor existence nor elapsed quiet time
 * is a completion boundary. The same owner is used when restoring the old screen. */
window.kinCreateStackRestore = function ({ services, dataSource }) {
  const grid = services.viewportGridService, cs = services.cornerstoneViewportService;
  const native = window.cornerstone, events = native.Enums.Events;
  const changed = () => Object.assign(new Error('화면이 변경되어 복원을 중단했습니다.'), { kinRestoreOwnershipLost: true });
  const mismatch = () => new Error('저장한 영상 표시를 확인하지 못했습니다.');
  const same = (a, b) => Array.isArray(b) ? Array.isArray(a) && a.length === b.length && b.every((n, i) => same(a[i], n))
    : typeof b === 'number' ? Number.isFinite(a) && Math.abs(a - b) < 1e-6 : a === b;
  const imageMatches = (id, cell) => {
    const m = native.metaData.get('instance', id);
    return m?.StudyInstanceUID === cell.study && m?.SeriesInstanceUID === cell.series && m?.SOPInstanceUID === cell.sop;
  };
  async function prepare(cells, sets, current, signal) {
    if (!current() || signal.aborted) throw changed();
    const cache = services.cornerstoneCacheService, source = dataSource?.();
    if (!cache?.createViewportData || !source) throw new Error('원본 영상 초기화 도구를 확인하지 못했습니다.');
    let timer, cancel;
    const stopped = new Promise((_, reject) => {
      cancel = () => reject(changed());
      signal.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => reject(new Error('원본 영상 로딩에 실패했습니다.')), 15000);
    });
    try {
      return await Promise.race([stopped, Promise.all(cells.map(async (cell, i) => {
        if (!cell) return null;
        const set = services.displaySetService.getActiveDisplaySets().find(d => d.displaySetInstanceUID === sets[i]);
        if (!set || set.isOverlayDisplaySet || set.isCompositeStack || !set.images?.every(m => m.SOPClassUID === '1.2.840.10008.5.1.4.1.1.2')) throw mismatch();
        // This is the public cache path used by OHIFCornerstoneViewport itself.
        // It fixes the ordering before the grid exists, including cached ordering.
        const data = await cache.createViewportData([set], { viewportType: 'stack' }, source);
        if (!current() || signal.aborted) throw changed();
        const ids = data?.viewportType === 'stack' && data.data?.length === 1 && data.data[0].imageIds;
        if (!Array.isArray(ids) || !ids.length) throw mismatch();
        const matches = ids.map((id, n) => imageMatches(id, cell) ? n : -1).filter(n => n >= 0);
        if (matches.length !== 1) throw new Error('저장한 원본 시리즈와 프레임을 찾을 수 없습니다.');
        return { cell, set: sets[i], imageIds: [...ids], index: matches[0] };
      }))]);
    } finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); }
  }
  function begin(plans, ids, current, signal) {
    let active = true, failure = null, timer;
    const cleanup = [], entries = plans.map((plan, i) => plan && { ...plan, id: ids[i], viewport: null, data: null, done: false, attempts: 0 });
    let resolve, reject;
    const completed = new Promise((yes, no) => { resolve = yes; reject = no; });
    // A failure can precede the caller's await while React is constructing the grid.
    completed.catch(() => {});
    const listen = (target, event, fn) => { target.addEventListener(event, fn); cleanup.push(() => target.removeEventListener(event, fn)); };
    const subscribe = (service, event, fn) => {
      if (!event || !service?.subscribe) throw new Error('영상 초기화 알림을 확인하지 못했습니다.');
      const subscription = service.subscribe(event, fn); cleanup.push(() => subscription.unsubscribe());
    };
    const dispose = () => { active = false; clearTimeout(timer); cleanup.splice(0).forEach(off => off()); };
    const fail = error => { if (!active) return; failure = error; dispose(); reject(error); };
    const ensure = () => { if (failure) throw failure; if (!active || !current() || signal.aborted) throw changed(); };
    const owns = entry => {
      ensure();
      const g = grid.getState().viewports.get(entry.id), v = cs.getCornerstoneViewport(entry.id);
      if (!g || g.displaySetInstanceUIDs?.length !== 1 || g.displaySetInstanceUIDs[0] !== entry.set ||
          v !== entry.viewport || v?.type !== 'stack' || cs.getViewportInfo(entry.id)?.getViewportData() !== entry.data) throw changed();
      const imageIds = v.getImageIds();
      if (imageIds.length !== entry.imageIds.length || imageIds.some((id, i) => id !== entry.imageIds[i]) ||
          v.getCurrentImageIdIndex() !== entry.index || v.getTargetImageIdIndex() !== entry.index ||
          !imageMatches(v.getCurrentImageId(), entry.cell)) throw mismatch();
      return v;
    };
    const matches = entry => {
      const v = owns(entry), camera = v.getCamera(), props = v.getProperties();
      return Object.entries(entry.cell.camera).every(([key, value]) => same(camera[key], value)) &&
        Object.entries(entry.cell.properties).every(([key, value]) => key === 'voiRange'
          ? same(props.voiRange?.lower, value.lower) && same(props.voiRange?.upper, value.upper) : same(props[key], value)) &&
        props.colormap?.name === 'Grayscale';
    };
    const verify = () => { ensure(); entries.filter(Boolean).forEach(entry => { if (!entry.done || !matches(entry)) throw mismatch(); }); };
    function apply(entry) {
      const v = owns(entry);
      if (++entry.attempts > 3) throw mismatch();
      entry.done = false;
      // Grayscale replaces the LUT without resetting its flags in the pinned GPU
      // implementation. Reset both flags so repeated SIGMOID/invert stays identical.
      v.setProperties({ invert: false, VOILUTFunction: 'LINEAR' });
      v.setProperties({ ...entry.cell.properties, colormap: { name: 'Grayscale', opacity: [] } });
      v.setCamera({ flipHorizontal: entry.cell.camera.flipHorizontal, flipVertical: entry.cell.camera.flipVertical });
      const camera = { ...entry.cell.camera }; delete camera.flipHorizontal; delete camera.flipVertical;
      v.setCamera(camera);
      v.render();
    }
    const guarded = action => (...args) => { if (!active) return; try { ensure(); action(...args); } catch (error) { fail(error); } };
    try {
      listen(signal, 'abort', () => fail(changed()));
      listen(window, 'pagehide', () => fail(changed()));
      listen(window, 'popstate', () => fail(changed()));
      listen(native.eventTarget, events.ELEMENT_ENABLED, guarded(event => {
        const entry = entries.find(e => e?.id === event.detail.viewportId);
        if (!entry) return;
        const v = cs.getCornerstoneViewport(entry.id);
        if (entry.viewport || !v || v.element !== event.detail.element) throw changed();
        entry.viewport = v;
      }));
      listen(native.eventTarget, events.ELEMENT_DISABLED, guarded(event => {
        if (entries.some(e => e?.viewport?.element === event.detail.element)) throw changed();
      }));
      subscribe(cs, cs.EVENTS.VIEWPORT_DATA_CHANGED, guarded(({ viewportId, viewportData }) => {
        const entry = entries.find(e => e?.id === viewportId);
        if (!entry) return;
        // No event from a previous data generation can certify this one.
        if (entry.data || !entry.viewport || cs.getViewportInfo(viewportId)?.getViewportData() !== viewportData) throw changed();
        entry.data = viewportData;
        const v = owns(entry);
        listen(v.element, events.IMAGE_RENDERED, guarded(event => {
          if (event.detail.viewportId !== entry.id || event.detail.element !== v.element) return;
          // Other listeners of this render can finish native camera/presentation
          // work. Read back after that dispatch before accepting the rendered state.
          queueMicrotask(guarded(() => {
            if (!matches(entry)) { apply(entry); return; }
            entry.done = true;
            if (entries.filter(Boolean).every(e => e.done)) { verify(); clearTimeout(timer); resolve(); }
          }));
        }));
        apply(entry);
      }));
      const gridChanged = guarded(({ removedViewportIds = [] }) => {
        if (ids.some(id => removedViewportIds.includes(id))) throw changed();
        for (const entry of entries) if (entry?.data) owns(entry);
      });
      subscribe(grid, grid.EVENTS.LAYOUT_CHANGED, gridChanged);
      subscribe(grid, grid.EVENTS.GRID_STATE_CHANGED, gridChanged);
      timer = setTimeout(() => fail(new Error('원본 영상 초기화 또는 최종 표시를 확인하지 못했습니다.')), 15000);
      ensure();
    } catch (error) { fail(error); }
    return {
      options: i => ({ id: ids[i], viewportId: ids[i], viewportType: 'stack', toolGroupId: 'default', allowUnmatchedView: true,
        // OHIF otherwise derives reusable presentation IDs from the series.
        presentationIds: { positionPresentationId: ids[i], lutPresentationId: ids[i] },
        ...(plans[i] ? { initialImageOptions: { index: plans[i].index, useOnce: true } } : {}) }),
      complete: async () => { ensure(); if (!entries.some(Boolean)) return; await completed; verify(); },
      verify, dispose,
    };
  }
  return { prepare, begin };
};
