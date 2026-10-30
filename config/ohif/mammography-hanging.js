
// The generic comparison protocol chooses by arrival order, not by breast/view/image kind.
// Use the existing DICOM classifier, while leaving pixels and viewport tools with OHIF.
function kinCreateMammographyHanging() {
  let protocolId = 'kin.mammography';
  let services, extensions, stop, institution;
  let preference = { layout: 'compare', kind: null };
  let preferenceProvider = null;
  let requestedLayout = null, accountDefault = false;
  const arrangement = { viewOrder: 'CC-MLO', sideOrder: 'R-L', priorPosition: 'right', currentColumns: 2, compareColumns: 4 };
  let applyPreference = () => {};
  const kinds = ['conventional', 'generated2d', 'dbt'];
  const labels = { conventional: 'Conventional', generated2d: 'Synthetic 2D', dbt: 'DBT' };
  const CT_IMAGE = '1.2.840.10008.5.1.4.1.1.2';
  // Orthanc builds bulk data URIs from its own base URL. Only the DICOMweb instance bulk path is
  // requested, and always on this origin, so a header cannot direct the viewer elsewhere.
  function sameOriginBulk(uri) {
    let url;
    try { url = new URL(uri, location.href); } catch (_) { return null; }
    const at = url.pathname.indexOf('/studies/');
    const path = at < 0 ? '' : '/dicom-web' + url.pathname.slice(at);
    return /^\/dicom-web\/studies\/[^/]+\/series\/[^/]+\/instances\/[^/]+\/bulk\/[0-9A-Fa-f/]+$/.test(path) ? path : null;
  }
  // A single-part answer is the element's bytes; a multipart one carries them in its first part.
  function firstPart(bytes, type) {
    if (!/^multipart\//i.test(type)) return bytes;
    const boundary = /boundary="?([^";]+)"?/i.exec(type)?.[1];
    if (!boundary) return null;
    const encode = s => Uint8Array.from(s, c => c.charCodeAt(0));
    const find = (needle, from) => {
      outer: for (let i = from; i <= bytes.length - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
        return i;
      }
      return -1;
    };
    const start = find(encode('--' + boundary), 0), body = start < 0 ? -1 : find(encode('\r\n\r\n'), start);
    const end = body < 0 ? -1 : find(encode('\r\n--' + boundary), body + 4);
    return end < 0 ? null : bytes.subarray(body + 4, end);
  }
  // U2 owns account storage. Restore through this hook after checking its owner; reset on logout.
  const preferences = {
    get: () => ({ ...preference }),
    // Register before mode entry. Called synchronously at each mount with the opened study UIDs;
    // return { layout: 'current' | 'compare', kind: null | 'conventional' | 'generated2d' | 'dbt' }.
    // null/invalid/throw uses the study-aware default. Storage and account ownership belong to U3.
    // 'compare' requires a usable prior; otherwise the effective layout is 'current'.
    // Pass null to unregister. Registration does not change an already mounted viewer.
    registerPreferenceProvider(provider) {
      if (provider !== null && typeof provider !== 'function') return false;
      preferenceProvider = provider;
      return true;
    },
    set(value, options = {}) {
      if (!value || !['compare', 'current'].includes(value.layout) ||
          !(value.kind === null || kinds.includes(value.kind))) return false;
      preference = { ...value };
      accountDefault = !!options.accountDefault;
      requestedLayout = value.layout;
      applyPreference();
      return true;
    },
  };
  function mount() {
    stop?.();
    const source = extensions.getActiveDataSource()[0], series = source.retrieve.series;
    const hp = services.hangingProtocolService, raw = new Map(), search = location.search;
    const opened = new URLSearchParams(search).get('StudyInstanceUIDs')?.split(',') || [];
    requestedLayout = null;
    preference = { layout: opened.length > 1 ? 'compare' : 'current', kind: null };
    try { preferences.set(preferenceProvider?.({ studyInstanceUIDs: opened.slice() }), { accountDefault: true }); } catch (_) { /* Use the study-aware default. */ }
    const retrieve = series.metadata, run = hp.run;
    let ended = false, last = null, cells = [], stageCells = [], panel = null, missing = null;
    const live = () => !ended && location.search === search;
    const handler = extensions.getModuleEntry('@ohif/extension-default.sopClassHandlerModule.stack');
    const nativeDisplaySets = handler.getDisplaySetsFromSeries;
    // OHIF makes one display set per instance for Modality MG, and the Siemens CT-format slices
    // carry MG. Only a complete, geometrically verified slice series becomes one stack, in position
    // order, built from OHIF's own set and the real instances; anything else stays native.
    const createDisplaySets = function (instances, ...args) {
      const sets = nativeDisplaySets.call(this, instances, ...args);
      const headers = instances.map(i => raw.get(i.SOPInstanceUID));
      if (!live() || !headers.length || headers.some(h => !h || h['00080016']?.Value?.[0] !== CT_IMAGE ||
          String(h['00080008']?.Value?.[2] ?? '').trim().toUpperCase() !== 'TOMO')) return sets;
      const model = window.KinMammographyModel, study = headers[0]['0020000D']?.Value?.[0];
      const plan = model.plan({ institution, studies: [{ uid: study, role: 'current', institution, instances: headers }] });
      const stacks = Object.values(plan.slots || {}).filter(s => s.status === 'ready' && s.object.stackMembers);
      if (stacks.length !== 1 || stacks[0].object.stackMembers.length !== instances.length) return sets;
      const members = stacks[0].object.stackMembers, sops = new Set(members.map(o => o.sop));
      const images = sets.flatMap(s => s.images || []), stack = sets[0];
      if (images.length !== sops.size || new Set(images.map(i => i.SOPInstanceUID)).size !== sops.size ||
          !images.every(i => sops.has(i.SOPInstanceUID)) || !Array.isArray(stack?.images)) return sets;
      // ImageSet.images is a non-writable property holding the array that is also `instances`;
      // fill that array in place rather than replacing it.
      const ordered = members.map(o => instances.find(i => i.SOPInstanceUID === o.sop));
      stack.images.splice(0, stack.images.length, ...ordered);
      if (stack.instances !== stack.images) stack.instances = stack.images;
      stack.instance = ordered[0];
      stack.setAttributes?.({ numImageFrames: ordered.length, isMultiFrame: false, instanceNumber: ordered[0].InstanceNumber });
      return stack.images.length === ordered.length ? [stack] : sets;
    };
    handler.getDisplaySetsFromSeries = createDisplaySets;
    // A stored VOI LUT read from implicit VR arrives as a bulk data element. Its bytes are fetched
    // with the metadata, before hanging, and handed to the classifier; an unread table is shown as such.
    const lutBytes = new Map();
    async function loadLutBulk(instances) {
      const tables = [];
      for (const item of instances) {
        const holders = [item, ...['52009229', '52009230'].flatMap(tag => (item[tag]?.Value || [])
          .map(group => group?.['00289132']?.Value?.[0]).filter(Boolean))];
        for (const holder of holders) for (const table of holder['00283010']?.Value || []) {
          const uri = table?.['00283006']?.BulkDataURI;
          if (typeof uri === 'string' && !Array.isArray(table['00283006'].Value) && !lutBytes.has(uri)) tables.push(uri);
        }
      }
      await Promise.allSettled([...new Set(tables)].map(async uri => {
        const url = sameOriginBulk(uri);
        if (!url) return;
        const response = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/octet-stream' } });
        if (!response.ok) return;
        const bytes = firstPart(new Uint8Array(await response.arrayBuffer()), response.headers.get('content-type') || '');
        if (bytes && live()) lutBytes.set(uri, bytes);
      }));
    }
    const orientations = new WeakMap(), presentations = new WeakMap();
    function orient(event) {
      if (!live()) return;
      const viewport = services.cornerstoneViewportService.getCornerstoneViewport(event.detail?.viewportId);
      const imageId = viewport?.getCurrentImageId?.();
      if (!imageId || viewport.type !== 'stack') return;
      const instance = window.cornerstone.metaData.get('instance', imageId);
      const item = raw.get(instance?.SOPInstanceUID);
      if (!item) return;
      const frame = item['00280008']?.Value?.[0] > 1 ? viewport.getCurrentImageIdIndex() + 1 : 1;
      const ctTomo = window.KinMammographyModel.classify(item).basis === 'ct-breast-tomosynthesis';
      const sourceKey = ctTomo ? instance.SeriesInstanceUID : instance.SOPInstanceUID;
      const previousPresentation = event.type === newStackEvent ? null : presentations.get(viewport);
      if (item['00080060']?.Value?.[0] === 'MG' || ctTomo) {
        if (previousPresentation?.sourceKey !== sourceKey) applyHeaderVOI(viewport, item, frame);
        presentations.set(viewport, { sourceKey });
      }
      // Grayscale belongs to the image even when the reader selected another layout.
      if (hp.getState()?.protocolId !== protocolId) return;
      // setStack clears flips even if the same object is hung again in this viewport.
      const previous = event.type === newStackEvent ? null : orientations.get(viewport);
      if (previous?.imageId === imageId) return;
      const orientation = window.KinMammographyModel.displaySpec(item, frame).orientation;
      const sameObject = previous?.sop === instance.SOPInstanceUID ||
        previous?.series === instance.SeriesInstanceUID && ctTomo;
      const camera = viewport.getCamera();
      // Preserve a reader's manual flip while scrolling; only changes in the stored frame's
      // orientation alter the normalization. A new object starts from its own display rule.
      const flipHorizontal = sameObject ? !!camera.flipHorizontal !== (previous.flipH !== orientation.flipH) : orientation.flipH;
      const flipVertical = sameObject ? !!camera.flipVertical !== (previous.flipV !== orientation.flipV) : orientation.flipV;
      orientations.set(viewport, { imageId, sop: instance.SOPInstanceUID, series: instance.SeriesInstanceUID, ...orientation });
      if (!!camera.flipHorizontal !== flipHorizontal || !!camera.flipVertical !== flipVertical) {
        viewport.setCamera({ flipHorizontal, flipVertical });
        viewport.render();
      }
      renderLabels();
    }
    function applyHeaderVOI(viewport, item, frame) {
      const spec = window.KinMammographyModel.displaySpec(item, frame, { bulk: uri => lutBytes.get(uri) || null }), voi = spec.voi;
      const element = viewport.element;
      element?.querySelector('.kin-mg-voi-notice')?.remove();
      if (voi.status !== 'verified') {
        if (element && spec.issues.includes('voi-lut-table-invalid')) {
          const notice = document.createElement('div'); notice.className = 'kin-mg-voi-notice';
          notice.setAttribute('role', 'status');
          notice.textContent = '저장된 VOI LUT를 읽을 수 없습니다. 영상 밝기와 대비를 확인해 주세요.';
          notice.style.cssText = 'position:absolute;top:40px;left:8px;z-index:5;color:#fff;background:#713f12;padding:4px 8px;pointer-events:none';
          element.append(notice);
        }
        return;
      }
      if (voi.lut) {
        // Use the stored table on the GPU actor, without rewriting decoded source pixels or the cache.
        // VTK midpoint=1/sharpness=1 keeps each integer entry constant until the next input value.
        const transfer = viewport.getDefaultActor()?.actor?.getProperty().getRGBTransferFunction(0);
        if (!transfer) return;
        transfer.removeAllPoints();
        const max = 2 ** voi.lut.bits - 1;
        voi.lut.data.forEach((value, i) => {
          const gray = spec.invert ? 1 - value / max : value / max;
          transfer.addRGBPoint(voi.lut.first + i, gray, gray, gray, 1, 1);
        });
      } else {
        const half = (voi.width - (voi.fn === 'LINEAR' ? 1 : 0)) / 2;
        const center = voi.center - (voi.fn === 'LINEAR' ? 0.5 : 0);
        // A fresh native LUT also removes a table left on a reused stack actor.
        viewport.setProperties({ VOILUTFunction: voi.fn, invert: spec.invert });
        viewport.setVOI({ lower: center - half, upper: center + half }, { forceRecreateLUTFunction: true });
      }
      viewport.render();
    }
    // Keep the raw responses that the real data source already loads. Starting all MG metadata
    // before hanging prevents a late series from turning a missing/unique slot into another image.
    const metadata = async function (...args) {
      const result = await retrieve.apply(this, args);
      if (!live() || !Array.isArray(result) || !result.some(p => ['MG', 'CT'].includes(p?.metadata?.Modality))) return result;
      const keep = instances => { if (live() && Array.isArray(instances)) for (const item of instances) raw.set(item['00080018']?.Value?.[0], item); };
      // OHIF attaches its store callback before start(), and that callback builds display sets at
      // once. Keep the raw headers (and any VOI LUT bulk data) inside the load itself, ahead of it.
      for (const p of result) {
        const load = p?.processFunction;
        if (typeof load === 'function' && !p.internalPromise && typeof p.setProcessFunction === 'function') {
          p.setProcessFunction(() => Promise.resolve(load()).then(async instances => {
            keep(instances);
            if (live() && Array.isArray(instances)) await loadLutBulk(instances);
            return instances;
          }));
        }
      }
      await Promise.allSettled(result.map(p => p.start().then(keep)));
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
        const viewport = services.cornerstoneViewportService.getCornerstoneViewport(v.viewportId);
        const orientation = orientations.get(viewport);
        const unverified = orientation?.imageId === viewport?.getCurrentImageId?.() && orientation?.status === 'unverified';
        const matched = views.length === cells.length && v.displaySetInstanceUIDs?.[0] === cell.selected;
        if (!matched && !unverified) { label?.remove(); return; }
        const text = (matched ? cell.label : '') + (unverified ? (matched ? ' · ' : '') + 'Orientation Unverified' : '');
        if (label?.textContent === text) return;
        if (!label) { label = document.createElement('div'); label.className = 'kin-mg-slot'; host.append(label); }
        label.style.cssText = 'position:absolute;bottom:24px;left:8px;z-index:5;pointer-events:none;color:#fff;background:#101e32;padding:3px 6px;font:12px sans-serif';
        label.textContent = text;
        label.title = unverified ? '영상 방향을 확인할 수 없어 저장된 방향으로 표시합니다.' : '';
      });
    }
    function protocol(data) {
      const model = window.KinMammographyModel;
      const displaySets = data.displaySets;
      const studies = opened.slice(0, 2).map((uid, i) => ({ uid, role: i ? 'prior' : 'current', institution,
        instances: [...raw.values()].filter(item => item['0020000D']?.Value?.[0] === uid) }));
      // The institution here is the viewing session's scope. The DICOMweb server has already
      // authorized these objects; this client classification does not grant access to a study.
      const plan = model.plan({ institution, studies });
      preference.layout = plan.prior?.status === 'ok' ? (requestedLayout || 'compare') : 'current';
      const hasKind = (role, kind) => plan.objects.some(o => o.role === role && o.standard && o.kind === kind);
      // Prefer a representation shared by both examinations; never substitute a different kind
      // in an empty counterpart. A personal explicit selection still wins.
      const selectedKind = (preference.kind && (!accountDefault || hasKind('current', preference.kind)) ? preference.kind : null) || kinds.find(k => hasKind('current', k) && hasKind('prior', k)) ||
        kinds.find(k => hasKind('current', k)) || 'conventional';
      const shape = { ...arrangement, ...preference };
      protocolId = 'kin.mammography' + (Object.keys(arrangement).some(key => shape[key] !== arrangement[key]) ? '.' + Object.keys(arrangement).map(key => shape[key]).join('.') : '');
      const selectors = {}, stages = [], layouts = ['compare', 'current'];
      stageCells = [];
      // OHIF retains a protocol object when its ID is unchanged. Native stages keep layout/type
      // switches real, instead of re-registering one ID and leaving its former images on screen.
      for (const layout of layouts) for (const kind of kinds) {
        const specs = [];
        const roles = layout === 'compare' ? (['left', 'top'].includes(shape.priorPosition) ? ['prior', 'current'] : ['current', 'prior']) : ['current'];
        const views = shape.viewOrder.split('-'), sides = shape.sideOrder.split('-');
        const vertical = ['top', 'bottom'].includes(shape.priorPosition);
        const columns = layout === 'current' ? shape.currentColumns :
          vertical ? Math.min(4, shape.compareColumns) : Math.max(2, shape.compareColumns);
        const breastViews = views.flatMap(view => sides.map(side => ({ side, view })));
        if (layout === 'current' || vertical) {
          for (const role of roles) for (const spec of breastViews) specs.push({ role, ...spec });
        } else {
          // Each study occupies its chosen side at every grid width, including 4 x 2.
          const perStudy = columns / roles.length;
          for (let offset = 0; offset < breastViews.length; offset += perStudy) {
            for (const role of roles) for (const spec of breastViews.slice(offset, offset + perStudy)) specs.push({ role, ...spec });
          }
        }
        const entries = specs.map(spec => {
          const key = [spec.role, spec.side, spec.view, kind].join('|'), slot = plan.slots[key];
          const object = slot?.status === 'ready' ? slot.object : null;
          const sops = object ? new Set((object.stackMembers || [object]).map(o => o.sop)) : null;
          const matches = object ? displaySets.filter(d => d.StudyInstanceUID === object.study &&
            d.images?.length === sops.size && new Set(d.images.map(i => i.SOPInstanceUID)).size === sops.size &&
            d.images.every(i => sops.has(i.SOPInstanceUID))) : [];
          const selected = matches.length === 1 ? matches[0] : null;
          selectors[key] = { seriesMatchingRules: [{ attribute: 'displaySetInstanceUID', required: true,
            constraint: { equals: { value: selected?.displaySetInstanceUID || '' } } }] };
          const state = selected ? '' : slot?.status === 'ambiguous' ? ' · Select Image' : slot?.status === 'missing' ? ' · Missing' : ' · Unverified';
          return { key, selected: selected?.displaySetInstanceUID, label: (spec.role === 'current' ? 'Current' : 'Prior') + ' · ' + spec.side + ' ' + spec.view + ' · ' + labels[kind] + state };
        });
        stageCells.push(entries);
        stages.push({ id: layout + '-' + kind, name: (layout === 'compare' ? 'Current vs Prior' : 'Current') + ' · ' + labels[kind],
          stageActivation: { enabled: { minViewportsMatched: 0 } },
          viewportStructure: { layoutType: 'grid', properties: { rows: specs.length / columns, columns } },
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
      if (!live() || !data.displaySets.some(d => d.StudyInstanceUID === opened[0] && (d.Modality === 'MG' ||
          d.images?.some(i => raw.has(i.SOPInstanceUID) && window.KinMammographyModel.classify(raw.get(i.SOPInstanceUID)).basis === 'ct-breast-tomosynthesis'))) ||
          (requested && !['@ohif/hpCompare', 'default'].includes(requested) && !requested.startsWith('kin.mammography'))) {
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
    const imageEvent = window.cornerstone.Enums.Events.STACK_NEW_IMAGE;
    const newStackEvent = window.cornerstone.Enums.Events.VIEWPORT_NEW_IMAGE_SET;
    document.addEventListener(imageEvent, orient, true);
    document.addEventListener(newStackEvent, orient, true);
    stop = () => {
      ended = true; raw.clear(); lutBytes.clear(); last = null; applyPreference = () => {};
      if (series.metadata === metadata) series.metadata = retrieve;
      if (handler.getDisplaySetsFromSeries === createDisplaySets) handler.getDisplaySetsFromSeries = nativeDisplaySets;
      if (hp.run === wrappedRun) hp.run = run;
      observer.disconnect(); subscription.unsubscribe(); panel?.remove();
      document.removeEventListener(imageEvent, orient, true);
      document.removeEventListener(newStackEvent, orient, true);
      document.querySelectorAll('.kin-mg-slot').forEach(el => el.remove());
      document.querySelectorAll('.kin-mg-voi-notice').forEach(el => el.remove());
    };
  }
  return { id: 'kin.mammography-hanging', async preRegistration({ servicesManager, extensionManager }) {
    services = servicesManager.services; extensions = extensionManager;
    await new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = '/worklist/hpacs-lite/mammography-model.js';
      script.onload = resolve; script.onerror = () => reject(Error('유방영상 분류를 불러오지 못했습니다.')); document.head.append(script);
    });
    const response = await fetch('/api/me', { credentials: 'same-origin' });
    const me = response.ok ? await response.json() : null;
    institution = kinViewerSession.sameAccount(me) === true ? me.institution : null;
    window.kinMammographyHanging = preferences;
  }, onModeEnter: mount, onModeExit() { stop?.(); stop = null; } };
}
