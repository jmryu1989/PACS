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
    let host, slot, list, uid, stripPatient, controller, sequence = 0, ended = false;
    const urls = new Set(), cards = new Map(), loads = new Map();
    let dragging = null;
    const events = new AbortController();
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
    const patient = () => window.KinViewerPatientTabs.snapshot();
    const samePatient = snapshot => {
      const now = patient();
      return !!now && !!snapshot && now.key === snapshot.key && now.sequence === snapshot.sequence;
    };
    function panes() {
      const ids = [...grid.getState().viewports.keys()];
      const nodes = [...document.querySelectorAll('[data-cy="viewport-grid"] [data-cy="viewport-pane"]')];
      return new Map(ids.map((id, index) => [id,
        services.cornerstoneViewportService.getCornerstoneViewport(id)?.element?.closest('[data-cy="viewport-pane"]') ||
        (nodes.length === ids.length ? nodes[index] : null)]));
    }
    function clearLoad(id) { loads.get(id)?.notice?.remove(); loads.delete(id); }
    function liveLoad(load) {
      return !ended && loads.get(load.id) === load && samePatient(load.patient) &&
        grid.getState().viewports.get(load.id)?.displaySetInstanceUIDs?.[0] === load.set;
    }
    function showLoad(load, error) {
      if (!liveLoad(load)) return;
      load.error = error || null;
      const pane = panes().get(load.id); if (!pane) return;
      const notice = load.notice ||= document.createElement('section');
      notice.className = 'kin-series-load'; notice.dataset.kinUxOwned = ''; notice.setAttribute('role', 'status');
      notice.replaceChildren();
      const label = document.createElement('span');
      label.textContent = error ? '영상을 불러오지 못했습니다. 연결을 확인한 뒤 Retry로 다시 시도하세요.' : '영상을 불러오는 중…';
      notice.append(label);
      if (error) {
        const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry';
        retry.onclick = () => retryLoad(load); notice.append(retry);
      }
      pane.append(notice);
    }
    async function retryLoad(load) {
      if (!liveLoad(load) || !canReplace()) return;
      const viewport = services.cornerstoneViewportService.getCornerstoneViewport(load.id);
      const ids = viewport?.getImageIds?.();
      if (!ids?.length) { assign(load.series, load.study, load.id, load.patient); return; }
      const retry = { ...load, notice: null, watched: null };
      clearLoad(load.id); loads.set(load.id, retry); showLoad(retry);
      try {
        await viewport.setStack(ids, viewport.getCurrentImageIdIndex());
        if (liveLoad(retry)) viewport.render();
      } catch (error) { showLoad(retry, error); }
    }
    function canReplace() {
      if (document.body.classList.contains('kin-patient-switching') || document.body.classList.contains('kin-viewer-empty')) return false;
      // Reuse the same busy/unsaved boundaries as HP and saved-work restore.
      const states = [window.kinViewerHistoryWorkspaceState?.(), window.kinViewerJobWorkspaceState?.()];
      if (states.some(state => state?.dirty || state?.busy) || window.kinViewerHistoryHasUnsaved?.() || window.kinMprMarks?.dirty?.()) {
        services.uiNotificationService?.show({ title: 'Series', message: '미저장 작업을 저장하거나 편집을 마친 뒤 시리즈를 여세요.', type: 'info' }); return false;
      }
      return true;
    }
    function assign(series, expectedStudy, id = grid.getActiveViewportId(), snapshot = patient()) {
      if (ended || !samePatient(snapshot) || !grid.getState().viewports.has(id) || !canReplace()) return;
      const viewport = services.cornerstoneViewportService.getCornerstoneViewport(id);
      if (viewport && viewport.type !== 'stack') {
        services.uiNotificationService?.show({ title: 'Series', message: '2D 영상 칸에 시리즈를 놓으세요.', type: 'info' }); return;
      }
      const matches = sets.getActiveDisplaySets().filter(set => set.StudyInstanceUID === expectedStudy && set.SeriesInstanceUID === series);
      if (matches.length !== 1) {
        services.uiNotificationService?.show({ title: 'Series', message: '분할된 시리즈 또는 아직 준비되지 않은 영상입니다. Studies에서 영상을 선택하세요.', type: 'info' }); return;
      }
      const set = matches[0].displaySetInstanceUID;
      clearLoad(id);
      const load = { id, set, series, study: expectedStudy, patient: snapshot };
      loads.set(id, load);
      try {
        grid.setDisplaySetsForViewport({ viewportId: id, displaySetInstanceUIDs: [set],
          viewportOptions: { viewportType: 'stack', toolGroupId: 'default', allowUnmatchedView: true } });
        showLoad(load);
      } catch (error) { showLoad(load, error); }
    }
    function refreshLoads() {
      for (const [id, load] of loads) {
        if (!liveLoad(load)) { clearLoad(id); continue; }
        const current = window.KinViewerInfoBar.identity(services, id);
        if (current.instance?.SeriesInstanceUID === load.series && current.instance?.StudyInstanceUID === load.study) {
          clearLoad(id); continue;
        }
        const imageId = current.viewport?.getCurrentImageId?.();
        const instance = imageId && window.cornerstone.metaData.get('instance', imageId);
        if (imageId && load.watched !== imageId && instance?.SeriesInstanceUID === load.series && instance?.StudyInstanceUID === load.study) {
          load.watched = imageId;
          // Share the native loader's promise: grid assignment itself completes
          // before a frame loads and cannot report a decode/network failure.
          window.cornerstone.imageLoader.loadAndCacheImage(imageId).catch(error => showLoad(load, error));
        }
      }
    }
    function finishDrag() {
      dragging = null;
      document.querySelectorAll('.kin-series-drop-target,.kin-series-drop-over').forEach(node => {
        node.classList.remove('kin-series-drop-target', 'kin-series-drop-over'); delete node.dataset.kinSeriesDrop;
      });
    }
    function dragTarget(event) {
      if (!dragging || !samePatient(dragging.patient)) return null;
      return [...panes()].find(([id, pane]) => {
        const viewport = services.cornerstoneViewportService.getCornerstoneViewport(id);
        // OHIF's empty-cell hit surface is a sibling of the non-interactive
        // pane. Both surfaces belong to the same grid cell.
        const cell = pane?.closest('[data-cy="viewport-grid"] > div');
        return cell?.contains(event.target) && (!viewport || viewport.type === 'stack');
      });
    }
    document.addEventListener('dragover', event => {
      if (!dragging) return;
      const target = dragTarget(event);
      for (const [, pane] of panes()) pane?.classList.toggle('kin-series-drop-over', pane === target?.[1]);
      if (!target) return;
      event.preventDefault(); event.stopImmediatePropagation(); event.dataTransfer.dropEffect = 'copy';
    }, { capture: true, signal: events.signal });
    document.addEventListener('drop', event => {
      const target = dragTarget(event); if (!target) return;
      event.preventDefault(); event.stopImmediatePropagation();
      const source = dragging; finishDrag(); assign(source.series, source.study, target[0], source.patient);
    }, { capture: true, signal: events.signal });
    document.addEventListener('dragend', finishDrag, { signal: events.signal });
    async function load(study) {
      clear(); uid = study; stripPatient = patient();
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
          preview.append(image, previewStatus); card.append(preview, label, description);
          card.onclick = () => assign(series, study, grid.getActiveViewportId(), stripPatient);
          card.draggable = true;
          card.ondragstart = event => {
            const snapshot = stripPatient; if (!samePatient(snapshot) || !canReplace()) { event.preventDefault(); return; }
            dragging = { series, study, patient: snapshot };
            event.dataTransfer.setData('application/x-kin-series', JSON.stringify({ series, study }));
            event.dataTransfer.effectAllowed = 'copy';
            for (const [id, pane] of panes()) {
              const viewport = services.cornerstoneViewportService.getCornerstoneViewport(id);
              if (!pane || viewport && viewport.type !== 'stack') continue;
              pane.classList.add('kin-series-drop-target'); pane.dataset.kinSeriesDrop = 'Drop Series';
            }
          };
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
    // The strip and, above it, the row the toolbar will fill. The toolbar mounts
    // only after the tech-note connection answers; reserving its row here, as
    // soon as the grid exists, keeps the image area where it will stay, so a
    // camera a saved Job or a patient tab applies before that answer is not
    // re-fitted when the toolbar arrives.
    function place() {
      if (ended || host) return;
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
      slot = document.createElement('section'); slot.className = 'kin-ux-toolbar-slot'; slot.dataset.kinUxOwned = '';
      column.prepend(slot, host);
    }
    function refresh() {
      if (ended) return;
      refreshLoads();
      if (dragging && !samePatient(dragging.patient)) finishDrag();
      place(); if (!host) return;
      if (document.body.classList.contains('kin-patient-switching')) return;
      const current = window.KinViewerInfoBar.identity(services, grid.getActiveViewportId());
      // The strip follows the grid's assigned study while a slice is loading;
      // otherwise every wheel/cine frame would discard and fetch all previews.
      // Selecting a vacant comparison cell must leave a source to choose from.
      // Keep the strip only for the same patient/tab generation.
      if (current.set?.StudyInstanceUID === uid) stripPatient = patient();
      const next = current.set?.StudyInstanceUID || (samePatient(stripPatient) ? uid : null);
      if (uid !== next) { load(next); return; }
      for (const [series, card] of cards) card.setAttribute('aria-pressed', String(series === current.set?.SeriesInstanceUID));
    }
    return { refresh, place, dispose() {
      ended = true; events.abort(); finishDrag(); [...loads.keys()].forEach(clearLoad);
      clear(); host?.remove(); slot?.remove();
    } };
  }
  return { mount };
})();
