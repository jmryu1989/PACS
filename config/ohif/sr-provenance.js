
/* KIN persistence owns only explicit user commands. Cornerstone objects are
 * session bindings, never wire payloads or durable identifiers. */
// Received SRs retain their source values and read-only SR renderer. A native
// hydration would turn them into local tools and silently recalculate them.
function kinCreateSRProvenance() {
  let services, extensions, stop;
  const sequence = value => Array.isArray(value) ? value : value ? [value] : [];
  const first = value => sequence(value)[0];
  const caption = instance => instance?.Manufacturer === 'KIN' && instance?.SoftwareVersions === 'kin-manual-sr-v1'
    ? '수동 측정 SR 원문 · 읽기 전용' : '외부 SR 원문 · 읽기 전용';
  const sourceGroups = instance => {
    const groups = new Map(); groups.tracking = []; let budget = 2000, incomplete = false;
    function walk(items, group, depth = 0) {
      if (depth > 32) { incomplete = true; return; }
      for (const item of sequence(items)) {
        if (--budget < 0) { incomplete = true; return; }
        if (first(item.ConceptNameCodeSequence)?.CodeValue === '112039' && typeof item.TextValue === 'string') groups.tracking.push(item);
        let branch = group;
        if (first(item.ConceptNameCodeSequence)?.CodeValue === '125007') {
          const uid = sequence(item.ContentSequence).find(x => first(x.ConceptNameCodeSequence)?.CodeValue === '112040')?.UID;
          branch = uid && (groups.get(uid) || { uid, values: [] });
          if (branch) groups.set(uid, branch);
        }
        if (branch && item.ValueType === 'NUM') {
          for (const measured of sequence(item.MeasuredValueSequence)) {
            const unit = first(measured.MeasurementUnitsCodeSequence);
            if (measured.NumericValue !== undefined && measured.NumericValue !== null)
              branch.values.push({ label: first(item.ConceptNameCodeSequence)?.CodeMeaning || 'NUM',
                value: String(measured.NumericValue) + (unit?.CodeValue ? ' ' + unit.CodeValue : ''),
                scheme: unit?.CodingSchemeDesignator || '' });
          }
        }
        walk(item.ContentSequence, branch, depth + 1);
      }
    }
    walk(instance?.ContentSequence, null);
    groups.incomplete = incomplete; return groups;
  };
  function mount() {
    stop?.();
    const displaySets = services.displaySetService, customization = services.customizationService;
    const restores = [], guarded = new WeakSet(), parsed = new WeakMap(); let ended = false, signature = '';
    const values = instance => {
      if (!instance) return new Map();
      if (!parsed.has(instance)) parsed.set(instance, sourceGroups(instance));
      return parsed.get(instance);
    };
    const panel = document.createElement('details'); panel.id = 'kin-sr-provenance'; panel.open = true; panel.hidden = true;
    panel.style.cssText = 'margin:8px 0;max-height:32vh;overflow:auto;border-top:1px solid #657c9f;padding:8px 0;overflow-wrap:anywhere';
    document.body.append(panel);
    const text = (parent, tag, value) => { const el = document.createElement(tag); el.textContent = value; parent.append(el); return el; };
    const protect = ds => {
      if (ds?.Modality !== 'SR' || guarded.has(ds)) return ds;
      guarded.add(ds);
      const flag = Object.getOwnPropertyDescriptor(ds, 'isRehydratable');
      // The native loader rewrites this flag after every load. Install the
      // policy before loading, so its async completion cannot reopen hydration.
      Object.defineProperty(ds, 'isRehydratable', { configurable: true, get: () => false, set: () => {} });
      const load = ds.load, addInstances = ds.addInstances; let loading, arrivals = [];
      const measurementDescriptor = Object.getOwnPropertyDescriptor(ds, 'measurements');
      let sourceMeasurements = ds.measurements;
      const measurementRead = () => ended ? [] : sourceMeasurements;
      // A native load can finish after this mode exits. Its subsequent source
      // subscription must see no measurements from the retired document.
      Object.defineProperty(ds, 'measurements', { configurable: true, enumerable: true,
        get: measurementRead, set: value => { if (!ended) sourceMeasurements = value; } });
      const guardedLoad = function (...args) {
        if (ds.isLoaded) return Promise.resolve();
        for (const item of values(ds.instance).tracking || []) {
          const descriptor = Object.getOwnPropertyDescriptor(item, 'TextValue');
          if (!descriptor?.configurable || descriptor.set) continue;
          const originalText = item.TextValue;
          // Legacy native hydration normalizes TrackingIdentifier before the
          // rejection hook. Keep source text immutable even on that early path.
          Object.defineProperty(item, 'TextValue', { configurable: true, enumerable: true, get: () => originalText, set: () => {} });
          restores.push(() => Object.defineProperty(item, 'TextValue', descriptor));
        }
        // Both tracking context and SR viewport request this load. Coalesce
        // them so the same source does not add duplicate overlay annotations.
        if (!loading) loading = Promise.resolve(load.apply(this, args)).finally(() => {
          loading = null;
          if (arrivals.length && !ended) { const pending = arrivals; arrivals = []; replaceInstances(...pending); }
        });
        return loading;
      };
      ds.load = guardedLoad;
      const replaceInstances = function (instances, service, selectedSop) {
        if (ended) return ds;
        // Let an older asynchronous loader finish against its own document.
        // Publishing a new instance before it finishes mixes old coordinates
        // with the new source labels in the native add-measurement hook.
        if (loading) { arrivals = [arrivals.length ? [...arrivals[0], ...instances] : instances, service, selectedSop]; return ds; }
        const previous = ds.instance?.SOPInstanceUID, wasLoaded = ds.isLoaded;
        const result = addInstances.call(ds, instances, service);
        if (selectedSop) ds.instance = ds.instances.find(instance => instance.SOPInstanceUID === selectedSop) || ds.instance;
        if (ds.instance?.SOPInstanceUID === previous) { ds.isLoaded = wasLoaded; return result; }
        for (const a of window.cornerstoneTools.annotation.state.getAllAnnotations())
          if (String(a.annotationUID).startsWith('kin-sr:' + previous + ':')) window.cornerstoneTools.annotation.state.removeAnnotation(a.annotationUID);
        ds.SOPInstanceUID = ds.instance.SOPInstanceUID; ds.measurements = []; ds.referencedImages = [];
        signature = ''; panel.hidden = true; panel.replaceChildren();
        const affected = [...services.viewportGridService.getState().viewports].filter(([, view]) => view.displaySetInstanceUIDs?.includes(ds.displaySetInstanceUID)).map(([id]) => id);
        // The pinned React viewport keys its effects by display-set object
        // identity, which native addInstances keeps unchanged. Unmount only
        // those SR cells before reopening the new document; CT cells remain.
        for (const viewportId of affected) services.viewportGridService.setDisplaySetsForViewport({ viewportId, displaySetInstanceUIDs: [] });
        const unmounted = new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        Promise.all([guardedLoad(), unmounted]).then(() => {
          if (ended) return;
          const grid = services.viewportGridService.getState();
          for (const viewportId of affected) {
            const view = grid.viewports.get(viewportId);
            if (!view || view.displaySetInstanceUIDs?.length) continue;
            services.viewportGridService.setDisplaySetsForViewport({ viewportId, displaySetInstanceUIDs: [ds.displaySetInstanceUID] });
          }
          signature = '';
          for (const entry of window.cornerstone.getEnabledElements()) entry.viewport.render();
        }).catch(() => { if (!ended) { panel.hidden = false; panel.replaceChildren(); text(panel, 'summary', 'SR 문서를 다시 열어 주세요'); } });
        return result;
      };
      if (typeof addInstances === 'function') ds.addInstances = replaceInstances;
      const previousSelect = ds.kinSelectDocument;
      ds.kinSelectDocument = sop => replaceInstances([], displaySets, sop);
      restores.push(() => {
        if (ds.load === guardedLoad) ds.load = load;
        if (ds.addInstances === replaceInstances) ds.addInstances = addInstances;
        if (previousSelect) ds.kinSelectDocument = previousSelect; else delete ds.kinSelectDocument;
        const release = () => {
          if (Object.getOwnPropertyDescriptor(ds, 'measurements')?.get !== measurementRead) return;
          Object.defineProperty(ds, 'measurements', { ...measurementDescriptor, value: [], writable: true });
          if (flag) Object.defineProperty(ds, 'isRehydratable', flag);
          else delete ds.isRehydratable;
        };
        if (loading) void loading.finally(release).catch(() => {}); else release();
      });
      return ds;
    };
    for (const name of ['dicom-sr', 'dicom-sr-3d']) {
      const handler = extensions.getModuleEntry('@ohif/extension-cornerstone-dicom-sr.sopClassHandlerModule.' + name);
      if (!handler) continue;
      const original = handler.getDisplaySetsFromSeries;
      const wrapped = function (...args) { return original.apply(this, args).map(protect); };
      handler.getDisplaySetsFromSeries = wrapped;
      restores.push(() => { if (handler.getDisplaySetsFromSeries === wrapped) handler.getDisplaySetsFromSeries = original; });
    }
    displaySets.getActiveDisplaySets().forEach(protect);
    const corners = services.viewportActionCornersService, originalCorners = corners.addComponents;
    const sourceCorners = function (components) {
      const grid = services.viewportGridService.getState();
      return originalCorners.call(this, components.map(item => {
        const ids = grid.viewports.get(item.viewportId)?.displaySetInstanceUIDs || [];
        return item.id === 'viewportStatusComponent' && ids.some(uid => displaySets.getDisplaySetByUID(uid)?.Modality === 'SR')
          ? { ...item, component: '외부 SR · 원문' } : item;
      }));
    };
    corners.addComponents = sourceCorners;
    restores.push(() => { if (corners.addComponents === sourceCorners) corners.addComponents = originalCorners; });
    const previousAdd = customization.get('onBeforeSRAddMeasurement');
    const addHook = { id: 'onBeforeSRAddMeasurement', value: ({ measurement, StudyInstanceUID, SeriesInstanceUID }) => {
      if (ended) throw new Error('로그인이 종료되어 SR 표식을 표시하지 않았습니다.');
      const ds = displaySets.getActiveDisplaySets().find(d => d.Modality === 'SR' && d.measurements?.includes(measurement));
      if (!ds || !guarded.has(ds)) throw new Error('현재 SR 문서에 속하지 않는 표식입니다.');
      const sourceUID = measurement.kinSourceTrackingUID || measurement.TrackingUniqueIdentifier;
      const groups = values(ds?.instance), group = groups.get(sourceUID);
      // Only labels are projected. Original ContentSequence and native graphic
      // coordinates are untouched; zero and the delivered numeric value survive
      // without the native two-decimal rounding. DICOM DS byte spelling is not
      // available after DICOMweb/dcmjs decoding.
      // Keep the derived measurement identity: the loader records imageId and
      // loaded on this same object for the SR viewport's reference navigation.
      measurement.labels = [{ label: '출처', value: caption(ds.instance) },
        ...(group?.values || [{ label: '원문', value: groups.incomplete ? '표시 상한 초과: SR 원문을 확인하세요' : '수치는 SR 원문에서 확인하세요' }])];
      // Tracking UIDs may be reused in later source documents. Scope only the
      // derived overlay ID by SOP so another SR cannot overwrite this overlay.
      measurement.kinSourceTrackingUID = sourceUID;
      measurement.TrackingUniqueIdentifier = 'kin-sr:' + ds?.instance?.SOPInstanceUID + ':' + sourceUID;
      return measurement;
    } };
    customization.setModeCustomization('onBeforeSRAddMeasurement', addHook);
    const previousHydrate = customization.get('onBeforeSRHydration');
    const hydrateHook = { id: 'onBeforeSRHydration', value: () => {
      throw new Error('외부 SR 원문은 읽기 전용입니다. 새 측정은 원영상에서 직접 작성하세요.');
    } };
    customization.setModeCustomization('onBeforeSRHydration', hydrateHook);
    for (const [name, prior, hook] of [['onBeforeSRAddMeasurement', previousAdd, addHook], ['onBeforeSRHydration', previousHydrate, hydrateHook]]) {
      restores.push(() => {
        if (customization.get(name)?.value === hook.value) customization.setModeCustomization(name, { id: name, value: prior?.value });
      });
    }
    const refresh = () => {
      if (ended) return;
      const history = document.getElementById('kin-viewer-history');
      if (history && panel.parentElement !== history) history.append(panel);
      const grid = services.viewportGridService.getState();
      const active = grid.viewports.get(grid.activeViewportId);
      const ds = active?.displaySetInstanceUIDs?.map(uid => displaySets.getDisplaySetByUID(uid)).find(d => d?.Modality === 'SR');
      if (!ds || !ds.isLoaded) { panel.hidden = true; signature = ''; return; }
      protect(ds); const instance = ds.instance;
      const key = [ds.displaySetInstanceUID, instance?.SOPInstanceUID, ds.isLoaded].join('|');
      panel.hidden = false; if (signature === key) return; signature = key; panel.replaceChildren();
      text(panel, 'summary', caption(instance));
      if (ds.instances?.length > 1) {
        const select = document.createElement('select'); select.setAttribute('aria-label', 'SR 문서 선택');
        select.style.cssText = 'width:100%;background:#101e32;color:#e1ecfc';
        for (const document of ds.instances) {
          const option = window.document.createElement('option'); option.value = document.SOPInstanceUID;
          option.textContent = '#' + document.InstanceNumber + ' · ' + (document.ContentDate || '') + ' ' + (document.ContentTime || '') + ' · ' + document.SOPInstanceUID;
          option.selected = document.SOPInstanceUID === instance.SOPInstanceUID; select.append(option);
        }
        select.addEventListener('change', () => { if (!ended) ds.kinSelectDocument(select.value); }); panel.append(select);
      }
      text(panel, 'p', '이 문서의 값과 표식을 그대로 열람합니다. 직접 작성한 측정과 저장 이력을 구분합니다.');
      for (const [label, value] of [['문서 SOP', instance?.SOPInstanceUID], ['작성 장치', instance?.Manufacturer],
        ['문서 일시', [instance?.ContentDate, instance?.ContentTime, instance?.SoftwareVersions === 'kin-manual-sr-v1' ? '(UTC)' : ''].filter(Boolean).join(' ')], ['원문 검증 상태', instance?.VerificationFlag]])
        text(panel, 'p', label + ': ' + (value || '기록 없음'));
      const groups = values(instance);
      if (groups.incomplete) text(panel, 'p', '표시 상한을 초과했습니다. 수치는 업무 화면의 SR 원문에서 확인하세요.');
      for (const group of groups.values()) {
        const section = text(panel, 'section', '');
        for (const value of group.values) text(section, 'p', value.label + ': ' + value.value + (value.scheme ? ' [' + value.scheme + ']' : ''));
      }
      // Changing SRs can reuse the same CT frame. The native viewport updates
      // its selected tracking IDs without repainting that unchanged image.
      services.cornerstoneViewportService.getCornerstoneViewport(grid.activeViewportId)?.render();
    };
    const timer = setInterval(refresh, 250);
    const end = () => {
      if (ended) return;
      ended = true; panel.hidden = true; panel.replaceChildren();
      for (const a of window.cornerstoneTools.annotation.state.getAllAnnotations())
        if (String(a.annotationUID).startsWith('kin-sr:')) window.cornerstoneTools.annotation.state.removeAnnotation(a.annotationUID);
      for (const entry of window.cornerstone.getEnabledElements()) { try { entry.viewport.render(); } catch (_) {} }
    };

    let channel; try { channel = kinViewerOnEnd(() => end()); } catch (_) {}

    window.addEventListener('kin-viewer-access-ended', end);
    stop = () => { end(); clearInterval(timer); panel.remove(); channel?.close();  window.removeEventListener('kin-viewer-access-ended', end); restores.reverse().forEach(restore => restore()); };
    refresh();
  }
  return { id: 'kin.sr-provenance', preRegistration({ servicesManager, extensionManager }) { services = servicesManager.services; extensions = extensionManager; },
    onModeEnter: mount, onModeExit() { stop?.(); stop = null; } };
}
