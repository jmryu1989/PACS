window.KinViewerSeriesStrip = (() => {
  const value = (item, tag) => item[tag]?.Value?.[0];
  const classic = new Set(['1.2.840.10008.5.1.4.1.1.1', '1.2.840.10008.5.1.4.1.1.1.1',
    '1.2.840.10008.5.1.4.1.1.1.1.1', '1.2.840.10008.5.1.4.1.1.2', '1.2.840.10008.5.1.4.1.1.4']);
  function frames(instance) {
    if (!value(instance, '00280010') || !value(instance, '00280011')) return null;
    const explicit = value(instance, '00280008');
    if (explicit !== undefined) { const count = Number(explicit); return Number.isSafeInteger(count) && count > 0 ? count : null; }
    return classic.has(value(instance, '00080016')) ? 1 : null;
  }
  function mount({ services }) {
    let host, list, uid, controller, sequence = 0, ended = false;
    const urls = new Set(), cards = new Map();
    const grid = services.viewportGridService, sets = services.displaySetService;
    function clear() { controller?.abort(); sequence++; urls.forEach(url => URL.revokeObjectURL(url)); urls.clear(); cards.clear(); list?.replaceChildren(); }
    async function request(path, options, signal) {
      const response = await fetch(path, { credentials: 'same-origin', signal, ...options,
        headers: { 'X-KIN-CSRF': '1', ...options?.headers } });
      if (window.KinSessionTransport?.refusal(response)) throw window.KinSessionTransport.responseError(response);
      if (!response.ok) throw new Error('시리즈 정보를 불러오지 못했습니다.');
      return response;
    }
    function message(text) { const label = document.createElement('span'); label.className = 'kin-series-status'; label.setAttribute('role', 'status'); label.textContent = text; list.replaceChildren(label); }
    function assign(series, expectedStudy) {
      const id = grid.getActiveViewportId(), current = window.KinViewerInfoBar.identity(services, id);
      if (ended || current.set?.StudyInstanceUID !== expectedStudy) return;
      // Reuse the same busy/unsaved boundaries as HP and saved-work restore.
      const states = [window.kinViewerHistoryWorkspaceState?.(), window.kinViewerJobWorkspaceState?.()];
      if (states.some(state => !state || state.dirty || state.busy) || window.kinViewerHistoryHasUnsaved?.() || window.kinMprMarks?.dirty?.()) {
        services.uiNotificationService?.show({ title: 'Series', message: '미저장 작업을 저장하거나 편집을 마친 뒤 시리즈를 여세요.', type: 'info' }); return;
      }
      const matches = sets.getActiveDisplaySets().filter(set => set.StudyInstanceUID === expectedStudy && set.SeriesInstanceUID === series);
      if (matches.length !== 1) {
        services.uiNotificationService?.show({ title: 'Series', message: '분할된 시리즈 또는 아직 준비되지 않은 영상입니다. Studies에서 영상을 선택하세요.', type: 'info' }); return;
      }
      grid.setDisplaySetsForViewport({ viewportId: id, displaySetInstanceUIDs: [matches[0].displaySetInstanceUID] });
    }
    async function load(study) {
      clear(); uid = study;
      if (!study) { message('현재 셀의 영상이 준비되면 시리즈를 표시합니다.'); return; }
      controller = new AbortController(); const signal = controller.signal, ticket = sequence;
      const live = () => !ended && !signal.aborted && ticket === sequence && uid === study;
      message('시리즈를 불러오는 중…');
      try {
        const response = await request('/dicom-web/studies/' + encodeURIComponent(study) + '/metadata', {}, signal);
        const instances = await response.json(); if (!live()) return;
        const groups = new Map();
        for (const instance of instances) {
          if (value(instance, '0020000D') !== study) continue;
          const series = value(instance, '0020000E'); if (!series) continue;
          if (!groups.has(series)) groups.set(series, []); groups.get(series).push(instance);
        }
        list.replaceChildren();
        for (const [series, images] of groups) {
          const first = images[0], counts = images.map(frames);
          const count = counts.every(count => count !== null) ? counts.reduce((a, b) => a + b, 0) : null;
          const number = String(value(first, '00200011') ?? '').trim() || 'Unknown';
          const title = String(value(first, '0008103E') ?? '').trim() || 'Unknown';
          const card = document.createElement('button'); card.type = 'button'; card.className = 'kin-series-card';
          const preview = document.createElement('span'); preview.className = 'kin-series-preview';
          const image = document.createElement('img'); image.alt = ''; image.hidden = true;
          const previewStatus = document.createElement('span'); previewStatus.className = 'kin-series-preview-status'; previewStatus.textContent = 'Loading';
          const label = document.createElement('span'); label.className = 'kin-series-count'; label.textContent = number + '/' + (count ?? 'Unknown');
          const description = document.createElement('span'); description.className = 'kin-series-title'; description.textContent = title;
          card.title = title + ' — SeriesNumber / 원본 DICOM 전체 프레임 수(다중 프레임 포함). 알 수 없는 수는 Unknown입니다.';
          card.setAttribute('aria-label', label.textContent + ' ' + title + '. ' + card.title);
          preview.append(image, previewStatus); card.append(preview, label, description); card.onclick = () => assign(series, study);
          cards.set(series, card); list.append(card);
        }
        if (!groups.size) message('시리즈가 없습니다.');
        refresh();
        // Use the existing preview API. A failed preview never removes its
        // series number/title or prevents keyboard assignment of loaded data.
        for (const [series, images] of groups) {
          if (!live()) return;
          const image = cards.get(series).querySelector('img');
          try {
            const lookup = await request('/api/dicom/lookup', { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ studyUid: study, sopUid: value(images[0], '00080018') }) }, signal);
            const result = await lookup.json();
            const preview = await request('/instances/' + encodeURIComponent(result.id) + '/preview', {}, signal);
            const blob = await preview.blob(); if (!live()) return;
            const url = URL.createObjectURL(blob); urls.add(url);
            image.onload = () => { if (live()) image.nextElementSibling.hidden = true; };
            image.onerror = () => { if (live()) { image.hidden = true; image.nextElementSibling.textContent = 'Preview unavailable'; image.parentElement.title += ' 썸네일 표시 실패.'; } };
            image.src = url; image.hidden = false;
          } catch (_) { if (!live()) return; cards.get(series).querySelector('.kin-series-preview-status').textContent = 'Preview unavailable'; cards.get(series).title += ' 썸네일 표시 실패.'; }
        }
      } catch (error) {
        if (!live()) return;
        message(error.message || '시리즈 정보를 불러오지 못했습니다.');
        const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry'; retry.onclick = () => load(study); list.append(retry);
      }
    }
    function refresh() {
      if (ended) return;
      if (!host) {
        const viewportGrid = document.querySelector('[data-cy="viewport-grid"]');
        const column = viewportGrid?.parentElement?.parentElement?.parentElement;
        if (!column) return;
        host = document.createElement('section'); host.className = 'kin-viewer-series-strip'; host.dataset.kinUxOwned = '';
        host.setAttribute('aria-label', 'Series');
        list = document.createElement('div'); list.className = 'kin-series-list';
        for (const [label, direction] of [['Previous Series', -1], ['Next Series', 1]]) {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'kin-series-scroll';
          button.textContent = direction === -1 ? '‹' : '›'; button.setAttribute('aria-label', label);
          button.onclick = () => list.scrollBy({ left: direction * list.clientWidth, behavior: 'smooth' });
          host.append(button); if (direction === -1) host.append(list);
        }
        column.prepend(host);
      }
      const current = window.KinViewerInfoBar.identity(services, grid.getActiveViewportId());
      // The strip follows the grid's assigned study while a slice is loading;
      // otherwise every wheel/cine frame would discard and fetch all previews.
      const next = current.set?.StudyInstanceUID || null;
      if (uid !== next) { load(next); return; }
      for (const [series, card] of cards) card.setAttribute('aria-pressed', String(series === current.set?.SeriesInstanceUID));
    }
    return { refresh, dispose() { ended = true; clear(); host?.remove(); } };
  }
  return { mount };
})();
