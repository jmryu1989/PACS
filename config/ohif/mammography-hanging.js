
// The generic comparison protocol chooses by arrival order, not by breast/view/image kind.
// Use the existing DICOM classifier, while leaving pixels and viewport tools with OHIF.
function kinCreateMammographyHanging() {
  const protocolId = 'kin.mammography';
  let services, extensions, stop, institution;
  let preference = { layout: 'compare', kind: null };
  let applyPreference = () => {};
  const kinds = ['conventional', 'generated2d', 'dbt'];
  const labels = { conventional: 'Conventional', generated2d: 'Synthetic 2D', dbt: 'DBT' };
  // U2 owns account storage. Restore through this hook after checking its owner; reset on logout.
  const preferences = {
    get: () => ({ ...preference }),
    set(value) {
      if (!value || !['compare', 'current'].includes(value.layout) ||
          !(value.kind === null || kinds.includes(value.kind))) return false;
      preference = { layout: value.layout, kind: value.kind };
      applyPreference();
      return true;
    },
  };
  function mount() {
    stop?.();
    const source = extensions.getActiveDataSource()[0], series = source.retrieve.series;
    const hp = services.hangingProtocolService, raw = new Map(), search = location.search;
    const opened = new URLSearchParams(search).get('StudyInstanceUIDs')?.split(',') || [];
    const retrieve = series.metadata, run = hp.run;
    let ended = false, last = null, cells = [], stageCells = [], panel = null, missing = null;
    const live = () => !ended && location.search === search;
    // Keep the raw responses that the real data source already loads. Starting all MG metadata
    // before hanging prevents a late series from turning a missing/unique slot into another image.
    const metadata = async function (...args) {
      const result = await retrieve.apply(this, args);
      if (!live() || !Array.isArray(result) || !result.some(p => p?.metadata?.Modality === 'MG')) return result;
      await Promise.allSettled(result.map(p => p.start().then(instances => {
        if (live()) for (const item of instances) raw.set(item['00080018']?.Value?.[0], item);
      })));
      return result;
    };
    series.metadata = metadata;
    function renderLabels() {
      if (!live() || hp.getState()?.protocolId !== protocolId) {
        document.querySelectorAll('.kin-mg-slot').forEach(el => el.remove()); return;
      }
      cells = stageCells[hp.getState().stageIndex] || [];
      const message = cells.filter(cell => !cell.selected).map(cell => cell.label).join(' / ');
      if (missing && missing.textContent !== message) missing.textContent = message;
      const views = [...services.viewportGridService.getState().viewports.values()].sort((a,b) => a.y-b.y || a.x-b.x);
      // Empty native panes have no Cornerstone element yet. Their pane wrappers still occupy
      // the grid's positions, so a missing counterpart can be labelled where it belongs.
      const panes = [...document.querySelectorAll('[class~="group/pane"]')].sort((a,b) => {
        const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
        return ar.top-br.top || ar.left-br.left;
      });
      views.forEach((v, i) => {
        const cell = cells[i], host = document.querySelector('[data-viewport-uid="' + v.viewportId + '"]') ||
          (!v.displaySetInstanceUIDs?.length && panes.length === views.length ? panes[i] : null);
        if (!cell || !host) return;
        let label = host.querySelector('.kin-mg-slot');
        if (views.length !== cells.length || v.displaySetInstanceUIDs?.[0] !== cell.selected) { label?.remove(); return; }
        if (label?.textContent === cell.label) return;
        if (!label) { label = document.createElement('div'); label.className = 'kin-mg-slot'; host.append(label); }
        label.style.cssText = 'position:absolute;bottom:24px;left:8px;z-index:5;pointer-events:none;color:#fff;background:#101e32;padding:3px 6px;font:12px sans-serif';
        label.textContent = cell.label;
      });
    }
    function protocol(data) {
      const model = window.KinMammographyModel;
      const displaySets = data.displaySets.filter(d => d.Modality === 'MG');
      const studies = opened.slice(0, 2).map((uid, i) => ({ uid, role: i ? 'prior' : 'current', institution,
        instances: [...raw.values()].filter(item => item['0020000D']?.Value?.[0] === uid) }));
      // The institution here is the viewing session's scope. The DICOMweb server has already
      // authorized these objects; this client classification does not grant access to a study.
      const plan = model.plan({ institution, studies });
      const hasKind = (role, kind) => plan.objects.some(o => o.role === role && o.standard && o.kind === kind);
      // Prefer a representation shared by both examinations; never substitute a different kind
      // in an empty counterpart. A personal explicit selection still wins.
      const selectedKind = preference.kind || kinds.find(k => hasKind('current', k) && hasKind('prior', k)) ||
        kinds.find(k => hasKind('current', k)) || 'conventional';
      const selectors = {}, stages = [], layouts = ['compare', 'current'];
      stageCells = [];
      // OHIF retains a protocol object when its ID is unchanged. Native stages keep layout/type
      // switches real, instead of re-registering one ID and leaving its former images on screen.
      for (const layout of layouts) for (const kind of kinds) {
        const specs = [];
        for (const view of ['CC', 'MLO']) for (const role of layout === 'compare' ? ['current', 'prior'] : ['current'])
          for (const side of ['R', 'L']) specs.push({ role, side, view });
        const entries = specs.map(spec => {
          const key = [spec.role, spec.side, spec.view, kind].join('|'), slot = plan.slots[key];
          const object = slot?.status === 'ready' ? slot.object : null;
          const matches = object ? displaySets.filter(d => d.images?.length === 1 &&
            d.StudyInstanceUID === object.study && d.images[0].SOPInstanceUID === object.sop) : [];
          const selected = matches.length === 1 ? matches[0] : null;
          selectors[key] = { seriesMatchingRules: [{ attribute: 'displaySetInstanceUID', required: true,
            constraint: { equals: { value: selected?.displaySetInstanceUID || '' } } }] };
          const state = selected ? '' : slot?.status === 'ambiguous' ? ' · Select Image' : slot?.status === 'missing' ? ' · Missing' : ' · Unverified';
          return { key, selected: selected?.displaySetInstanceUID, label: (spec.role === 'current' ? 'Current' : 'Prior') + ' · ' + spec.side + ' ' + spec.view + ' · ' + labels[kind] + state };
        });
        stageCells.push(entries);
        stages.push({ id: layout + '-' + kind, name: (layout === 'compare' ? 'Current vs Prior' : 'Current') + ' · ' + labels[kind],
          stageActivation: { enabled: { minViewportsMatched: 0 } },
          viewportStructure: { layoutType: 'grid', properties: { rows: 2, columns: layout === 'compare' ? 4 : 2 } },
          viewports: entries.map(cell => ({ viewportOptions: { toolGroupId: 'default', viewportType: 'stack', allowUnmatchedView: true },
            displaySets: [{ id: cell.key }] })) });
      }
      const stageIndex = layouts.indexOf(preference.layout) * kinds.length + kinds.indexOf(selectedKind);
      cells = stageCells[stageIndex];
      return { stageIndex, value: { id: protocolId, name: 'Mammography', locked: true, numberOfPriorsReferenced: 1,
        protocolMatchingRules: [], displaySetSelectors: selectors, stages } };
    }
    function showControls() {
      if (panel) return;
      panel = document.createElement('section'); panel.id = 'kin-mammography-hanging';
      panel.style.cssText = 'background:#101e32;color:white;padding:4px;font:12px sans-serif';
      const title = document.createElement('strong'); title.textContent = 'Mammography'; panel.append(title);
      for (const [key, name, options] of [
        ['layout', 'MG Layout', [['compare', 'Current vs Prior'], ['current', 'Current']]],
        ['kind', 'MG Image Type', [['', 'Automatic'], ...kinds.map(k => [k, labels[k]])]],
      ]) {
        const select = document.createElement('select'); select.setAttribute('aria-label', name);
        select.style.cssText = 'color:#fff;background:#101e32;border:1px solid #657c9f;padding:3px';
        for (const [value, text] of options) { const option = document.createElement('option'); option.value = value; option.textContent = text; select.append(option); }
        select.value = preference[key] || '';
        select.addEventListener('change', () => {
          preferences.set({ ...preference, [key]: select.value || null });
          window.dispatchEvent(new CustomEvent('kin-mammography-hanging-changed', { detail: preferences.get() }));
        });
        panel.append(select);
      }
      missing = document.createElement('div'); missing.setAttribute('role', 'status');
      missing.title = '같은 좌우·촬영 방향·영상 종류가 확인된 영상만 자동 배치합니다. 빈 칸은 다른 영상으로 대체하지 않습니다.';
      panel.append(missing);
      document.querySelector('#kin-viewer-layout')?.append(panel);
    }
    const wrappedRun = function (data, requested, options) {
      if (!live() || !data.displaySets.some(d => d.Modality === 'MG' && d.StudyInstanceUID === opened[0]) ||
          (requested && !['@ohif/hpCompare', 'default', protocolId].includes(requested))) {
        last = null; return run.call(this, data, requested, options);
      }
      last = { data, options };
      const next = protocol(data);
      hp.addProtocol(protocolId, next.value);
      showControls();
      missing.textContent = cells.filter(cell => !cell.selected).map(cell => cell.label).join(' / ');
      return run.call(this, data, protocolId, { ...options, stageIndex: next.stageIndex });
    };
    hp.run = wrappedRun;
    applyPreference = () => {
      if (!live()) return;
      if (last) wrappedRun.call(hp, last.data, protocolId, last.options);
      panel?.querySelectorAll('select').forEach((el, i) => { el.value = preference[i ? 'kind' : 'layout'] || ''; });
    };
    // React can replace an empty viewport without a grid-state notification.
    const observer = new MutationObserver(renderLabels);
    observer.observe(document.body, { childList: true, subtree: true });
    const subscription = services.viewportGridService.subscribe(services.viewportGridService.EVENTS.GRID_STATE_CHANGED, renderLabels);
    stop = () => {
      ended = true; raw.clear(); last = null; applyPreference = () => {};
      if (series.metadata === metadata) series.metadata = retrieve;
      if (hp.run === wrappedRun) hp.run = run;
      observer.disconnect(); subscription.unsubscribe(); panel?.remove();
      document.querySelectorAll('.kin-mg-slot').forEach(el => el.remove());
    };
  }
  return { id: 'kin.mammography-hanging', async preRegistration({ servicesManager, extensionManager }) {
    services = servicesManager.services; extensions = extensionManager;
    await new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = '/worklist/hpacs-lite/mammography-model.js';
      script.onload = resolve; script.onerror = () => reject(Error('유방영상 분류를 불러오지 못했습니다.')); document.head.append(script);
    });
    const response = await fetch('/api/me', { credentials: 'same-origin', headers: { 'X-KIN-CSRF': '1' } });
    const me = response.ok ? await response.json() : null;
    institution = kinViewerSession.sameAccount(me) === true ? me.institution : null;
    window.kinMammographyHanging = preferences;
  }, onModeEnter: mount, onModeExit() { stop?.(); stop = null; } };
}
