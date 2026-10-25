window.KinViewerInfoBar = (() => {
  const text = value => typeof value === 'object' && value !== null
    ? String(value.Alphabetic || value.Ideographic || value.Phonetic || '') : String(value ?? '');
  function identity(services, viewportId) {
    const cell = services.viewportGridService.getState().viewports.get(viewportId);
    const viewport = services.cornerstoneViewportService.getCornerstoneViewport(viewportId);
    const ids = cell?.displaySetInstanceUIDs || [];
    const set = ids.length === 1 && services.displaySetService.getDisplaySetByUID(ids[0]);
    let image = viewport?.getCurrentImageId?.();
    if (!image && ['orthographic', 'volume3d'].includes(viewport?.type)) {
      const volumeId = viewport.getVolumeId?.(), actors = viewport.getActors?.() || [];
      const volume = volumeId && window.cornerstone.cache.getVolume(volumeId);
      if (actors.length === 1 && (actors[0].referencedId || actors[0].uid) === volumeId && volume?.loadStatus?.loaded) {
        image = volume.imageIds?.[0];
      }
    }
    const instance = image && window.cornerstone.metaData.get('instance', image);
    // A replacement display set can precede the new canvas. Never label the
    // old pixels with that display set's patient or examination.
    const rendered = viewport?.viewportStatus === window.cornerstone.Enums.ViewportStatus.RENDERED;
    const matched = rendered && instance && set && instance.StudyInstanceUID === set.StudyInstanceUID &&
      instance.SeriesInstanceUID === set.SeriesInstanceUID;
    return { viewportId, viewport, cell, set, instance: matched ? instance : null };
  }
  function mount({ services, studyActions }) {
    const bars = new Map(), labels = new Map();
    // Attach a bar to every pane that lacks one. The bar takes its height from
    // the pane's canvas container, so a pane must get it before the stock code
    // enables the element and sizes the canvas; `added` tells the caller which
    // panes were measured without it and need a re-fit now.
    function adopt() {
      const state = services.viewportGridService.getState();
      const ids = [...state.viewports.keys()];
      const panes = [...document.querySelectorAll('[data-cy="viewport-grid"] [data-cy="viewport-pane"]')];
      // Native EmptyViewport has no Cornerstone element. The stock grid emits
      // panes in its service order; verify enabled cells before using that order.
      const ordered = panes.length === ids.length && ids.every((id, index) => {
        const element = services.cornerstoneViewportService.getCornerstoneViewport(id)?.element;
        return !element || panes[index].contains(element);
      });
      for (const [id, bar] of bars) if (!state.viewports.has(id) || !bar.isConnected) {
        bar.parentElement?.classList.remove('kin-ux-pane'); bar.remove(); bars.delete(id); labels.delete(id);
      }
      const cells = []; let added = false;
      for (const [index, id] of ids.entries()) {
        const current = identity(services, id);
        const pane = current.viewport?.element?.closest('[data-cy="viewport-pane"]') || (ordered && panes[index]);
        if (!pane) continue;
        if (!bars.has(id)) {
          const bar = document.createElement('section'); bar.className = 'kin-viewer-info-bar';
          bar.dataset.kinUxOwned = ''; bar.setAttribute('aria-label', 'Viewport Information');
          const label = document.createElement('span'); label.className = 'kin-viewer-info-identity';
          const mode = document.createElement('span'); mode.className = 'kin-viewer-info-mode';
          const study = document.createElement('button'); study.type = 'button'; study.textContent = 'Study ▾';
          study.disabled = true; study.title = '이전 검사 연결은 다음 단계에서 제공됩니다.';
          study.onclick = () => studyActions?.open(id, study);
          bar.append(label, mode, study); pane.classList.add('kin-ux-pane'); pane.prepend(bar); bars.set(id, bar); added = true;
        }
        cells.push({ id, current, bar: bars.get(id) });
      }
      return { layout: state.layout, cells, added };
    }
    function refresh() {
      const { layout, cells } = adopt();
      for (const { id, current, bar } of cells) {
        const m = current.instance;
        bar.children[2].disabled = !m || !studyActions?.available();
        bar.children[2].title = studyActions?.available() ? '이 셀의 이전 검사 목록을 엽니다.' : '이전 검사 연결은 다음 단계에서 제공됩니다.';
        let label = m ? [text(m.PatientName) || 'Unknown', text(m.PatientSex) || 'Unknown',
          text(m.PatientAge) || 'Unknown', text(m.PatientID) || 'Unknown',
          [text(m.StudyDate), text(m.StudyTime)].filter(Boolean).join(' ') || 'Unknown',
          text(m.StudyDescription), text(m.InstitutionName)].filter(Boolean).join(' | ') : 'Loading / No image';
        const previous = labels.get(id);
        const viewportStatus = window.cornerstone.Enums.ViewportStatus;
        const pending = [viewportStatus.LOADING, viewportStatus.PRE_RENDER, viewportStatus.RESIZE].includes(current.viewport?.viewportStatus);
        // While another frame of this same stack loads, the last rendered
        // pixels still have this identity. Replacing it with a shorter Loading
        // label resizes the image area on every cine frame.
        if (m) labels.set(id, { viewport: current.viewport, set: current.set, label });
        else if (pending && current.viewport?.type === 'stack' && previous?.viewport === current.viewport && previous.set === current.set) label = previous.label;
        else labels.delete(id);
        const type = current.viewport?.type;
        const mode = ({ stack: '2D', orthographic: 'MPR', volume3d: '3D' })[type] || type || 'No image';
        const status = mode + ' | ' + (layout.layoutType === 'grid' ? layout.numRows + '×' + layout.numCols : layout.layoutType);
        // The bar clamps the label to two lines; the full identity stays readable on hover.
        if (bar.children[0].textContent !== label) { bar.children[0].textContent = label; bar.children[0].title = m ? label : ''; }
        if (bar.children[1].textContent !== status) bar.children[1].textContent = status;
        bar.children[1].title = '영상 모드는 이 셀, 배치는 전체 뷰어에 적용됩니다.';
      }
    }
    return {
      refresh,
      adopt: () => adopt().added,
      invalidate() { labels.clear(); for (const bar of bars.values()) bar.children[0].textContent = 'Loading / No image'; },
      dispose() { for (const bar of bars.values()) { bar.parentElement?.classList.remove('kin-ux-pane'); bar.remove(); } bars.clear(); labels.clear(); },
    };
  }
  return { mount, identity };
})();
