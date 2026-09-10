/**
 * OHIF 사용자 설정 — Orthanc OHIF 플러그인이 뷰어에 주입
 * (orthanc.json의 "OHIF" > "UserConfiguration"에서 참조)
 *
 * 주의: UserConfiguration은 플러그인 기본 설정에 "병합"이 아니라 "통째로 교체"됨.
 * 따라서 플러그인의 기본 app-config-user.js 전체를 복사한 뒤 필요한 것만 추가한다.
 * 원본: https://orthanc.uclouvain.be/hg/orthanc-ohif/file/default/Sources/app-config-user.js
 * (SPDX-License-Identifier: MIT — Sebastien Jodogne, ICTEAM UCLouvain / OHIF)
 *
 * [KIN 추가] 표시가 붙은 부분만 기본값과 다름.
 */

const KIN_VIEWER_DEFAULT_TITLE = '판독 뷰어 — KOREA IMAGING NETWORK';

/** Product branding only; loaded-image identity owns clinical window titles. */
function KinViewerBrand({ React }) {
  React.useEffect(() => {
    let sessionChannel;

    const resetTitle = () => {
      document.title = KIN_VIEWER_DEFAULT_TITLE;
    };

    // 공용 판독 PC에서 로그아웃한 워크리스트가 다른 뷰어 탭의 환자명도 함께 지운다.
    const onSessionMessage = event => {
      if (event.data?.type === 'session-ended') resetTitle();
    };
    const onStorage = event => {
      if (event.key === 'kin-session-ended') resetTitle();
    };
    try {
      sessionChannel = new BroadcastChannel('kin-session');
      sessionChannel.addEventListener('message', onSessionMessage);
    } catch (e) { /* 구형 브라우저는 storage 이벤트만 쓴다. */ }
    window.addEventListener('storage', onStorage);

    // 내장 정보 창의 링크와 버전 정보는 유지하되, 화면에 노출되는 제품명만 중립화한다.
    const replaceBrandText = root => {
      const replacements = new Map([
        ['About', '오픈소스 정보'],
        ['About OHIF Viewer', '오픈소스 정보'],
        ['OHIF Viewer', 'KIN 판독 뷰어'],
        ['https://github.com/OHIF/Viewers/', '업스트림 소스 저장소'],
        ['https://github.com/OHIF/Viewers/blob/master/DATACITATION.md', '업스트림 데이터 인용 지침'],
      ]);
      root.querySelectorAll?.('*').forEach(element => {
        if (element.childElementCount) return;
        const text = element.textContent?.trim();
        if (!text) return;
        if (replacements.has(text)) {
          element.textContent = replacements.get(text);
        } else if (/OHIF|Open Health Imaging Foundation/i.test(text)) {
          element.textContent = text
            .replace(/Open Health Imaging Foundation/gi, '업스트림 오픈소스 프로젝트')
            .replace(/OHIF/gi, '업스트림');
        }
      });
    };
    replaceBrandText(document.body);
    const observer = new MutationObserver(records => records.forEach(record =>
      record.addedNodes.forEach(node => node.nodeType === Node.ELEMENT_NODE && replaceBrandText(node))
    ));
    observer.observe(document.body, { childList: true, subtree: true });

    document.title = KIN_VIEWER_DEFAULT_TITLE;

    return () => {
      document.title = KIN_VIEWER_DEFAULT_TITLE;
      observer.disconnect();
      window.removeEventListener('storage', onStorage);
      if (sessionChannel) {
        sessionChannel.removeEventListener('message', onSessionMessage);
        sessionChannel.close();
      }
    };
  }, []);

  const style = `
    :root {
      --kin-panel: #0E1728;
      --kin-accent: #4F8EF7;
      --kin-accent-soft: rgba(79, 142, 247, .20);
      --kin-accent-faint: rgba(79, 142, 247, .10);
      --kin-link: #9CC3FF;
    }
    #root > div > .bg-secondary-dark.z-20:has(#kin-viewer-brand) {
      background-color: var(--kin-panel) !important;
      border-bottom: 1px solid rgba(130, 160, 210, .22) !important;
    }
    #root > div > .bg-secondary-dark.z-20:has(#kin-viewer-brand) button.bg-primary-light {
      color: #071528 !important;
      background-color: var(--kin-accent) !important;
    }
    #root > div > .bg-secondary-dark.z-20:has(#kin-viewer-brand) .absolute.right-0 .text-primary-active {
      color: var(--kin-link) !important;
    }
    #root div:has(> .bg-bkg-med [data-cy="seriesList-btn"]) [data-cy="seriesList-btn"],
    #root div:has(> .bg-bkg-med [data-cy="seriesList-btn"]) .text-primary-active,
    #root div:has(> .bg-bkg-med [data-cy="seriesList-btn"]) .text-primary,
    #root div:has(> .bg-bkg-med [data-cy="seriesList-btn"]) .text-actions-primary {
      color: var(--kin-accent) !important;
    }
    #root div:has(> .bg-bkg-med [data-cy="seriesList-btn"]) [role="group"] {
      background-color: var(--kin-accent-faint) !important;
    }
    #root div:has(> .bg-bkg-med [data-cy="seriesList-btn"]) button[role="radio"][aria-checked="true"] {
      color: var(--kin-link) !important;
      background-color: var(--kin-accent-soft) !important;
    }
    #root div:has(> .bg-bkg-med [data-cy="seriesList-btn"]) [data-cy="study-browser-thumbnail"] .bg-highlight {
      background-color: var(--kin-accent) !important;
    }
    #root div:has(> .bg-bkg-med [data-cy="seriesList-btn"]) [data-cy="study-browser-thumbnail"]:hover {
      background-color: var(--kin-accent-soft) !important;
    }
    #root div:has(> .bg-bkg-med [data-cy="seriesList-btn"]) [data-cy="study-browser-thumbnail"]:focus-visible {
      outline: 2px solid var(--kin-accent) !important;
      outline-offset: -2px;
    }
  `;

  return React.createElement(
    'div',
    {
      id: 'kin-viewer-brand',
      style: { display: 'flex', alignItems: 'center', gap: '9px', height: '28px' },
    },
    React.createElement('style', null, style),
    React.createElement('img', {
      src: '/kin-brand/kin-emblem-j1.svg',
      alt: '',
      width: 24,
      height: 24,
      style: { display: 'block', flex: '0 0 auto' },
    }),
    React.createElement(
      'span',
      {
        style: {
          color: '#AFC3E2',
          fontSize: '9.5px',
          fontWeight: 600,
          lineHeight: 1.3,
          letterSpacing: '.14em',
          whiteSpace: 'nowrap',
        },
      },
      'KOREA IMAGING',
      React.createElement('br'),
      'NETWORK'
    )
  );
}

document.title = KIN_VIEWER_DEFAULT_TITLE;

/*
 * Stack flip/reset geometry adapted from Cornerstone3D Viewport.
 * MIT License — Copyright (c) 2019 Open Health Imaging Foundation.
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 * Source: https://github.com/cornerstonejs/cornerstone3D/blob/main/LICENSE
 * Pinned source: app.bundle.6656ed549d35896854f2.js, SHA256
 * 4fc18be2b7ae02369093d0505ae3241c9d78cb7396aebef4a0e01b8534f5ff58.
 */
const kinStackPrecision = (() => {
  const names = ['flip', '_getFocalPointForResetCamera'];
  const hashes = [
    '94ab10a51ca3095a7eef8ace693f7477e7961de741f1e9d8208b867520d8e8e4',
    '6734d58b792202f939f6fb3e9a7c19e67c191f83bcab66094ee82e4cd273f210',
  ];
  let pending;
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const sub = (a, b) => new Float64Array([a[0] - b[0], a[1] - b[1], a[2] - b[2]]);
  const add = (a, b, k) => new Float64Array([a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k]);
  const negate = a => new Float64Array([-a[0], -a[1], -a[2]]);
  const cross = (a, b) => new Float64Array([
    a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
  ]);

  // Float32 temporaries round large patient-space origins before editing begins.
  // Both this helper and flip must keep double precision; changing flip alone worsens drift.
  function resetFocal(centered, previous, { resetPan = true, resetToCenter = true }) {
    if (resetToCenter && resetPan) return centered;
    if (!resetToCenter && resetPan) {
      const distance = dot(sub(centered, previous.focalPoint), previous.viewPlaneNormal);
      return Array.from(add(centered, previous.viewPlaneNormal, -distance));
    }
    const invalid = Array.isArray(previous.focalPoint)
      ? previous.focalPoint.some(Number.isNaN) : Number.isNaN(previous.focalPoint);
    return invalid ? centered : previous.focalPoint;
  }

  function flip({ flipHorizontal, flipVertical }) {
    const imageData = this.getDefaultImageData();
    if (!imageData) return;
    const camera = this.getCamera();
    const { viewPlaneNormal, viewUp, focalPoint, position } = camera;
    const right = cross(viewPlaneNormal, viewUp);
    let up = new Float64Array(viewUp);
    const normal = negate(viewPlaneNormal);
    const delta = sub(position, focalPoint);
    const distance = Math.sqrt(dot(delta, delta));
    const center = imageData.indexToWorld(imageData.getDimensions().map(d => Math.floor(d / 2)), new Float64Array(3));
    const reset = this._getFocalPointForResetCamera(center, camera, { resetPan: true, resetToCenter: false });
    const pan = sub(focalPoint, reset);
    const panLength = Math.sqrt(dot(pan, pan));
    const mirror = axis => {
      const projected = add(new Float64Array(3), axis, 2 * dot(pan, axis));
      const result = sub(projected, pan);
      const length = dot(result, result);
      const inverse = length > 0 ? 1 / Math.sqrt(length) : length;
      return new Float64Array([result[0] * inverse, result[1] * inverse, result[2] * inverse]);
    };
    if (flipHorizontal) {
      const focal = add(reset, mirror(up), panLength);
      this.setCamera({ viewPlaneNormal: normal, position: add(focal, normal, distance), focalPoint: focal });
      this.flipHorizontal = !this.flipHorizontal;
    }
    if (flipVertical) {
      up = negate(viewUp);
      const focal = add(reset, mirror(right), panLength);
      this.setCamera({ focalPoint: focal, viewPlaneNormal: normal, viewUp: up, position: add(focal, normal, distance) });
      this.flipVertical = !this.flipVertical;
    }
    this.render();
  }

  function status(state) {
    // This reports installation only. Future persistence still validates original DICOM geometry on the server.
    window.kinViewerPrecision = Object.freeze({ version: 1, state, scope: 'gpu-stack-flip' });
    if (state === 'unsupported') console.warn('KIN stack precision adapter: unsupported viewer source; original methods retained.');
    return state;
  }

  async function install() {
    const core = window.cornerstone;
    const base = core?.Viewport?.prototype;
    const target = core?.StackViewport?.prototype;
    if (!base || !target || !globalThis.crypto?.subtle || Object.getPrototypeOf(target) !== base) return status('unsupported');
    const originals = names.map(name => base[name]);
    const eligible = () => Object.isExtensible(target) && names.every((name, i) =>
      typeof originals[i] === 'function' && base[name] === originals[i] &&
      !Object.hasOwn(target, name) && target[name] === originals[i]);
    if (!eligible()) return status('unsupported');
    const actual = await Promise.all(originals.map(async fn => {
      const bytes = new TextEncoder().encode(Function.prototype.toString.call(fn).replace(/\r\n/g, '\n').trim());
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    }));
    // Recheck after the asynchronous hash; another extension may have installed its own methods.
    if (!eligible() || actual.some((hash, i) => hash !== hashes[i])) return status('unsupported');
    const replacements = [flip, resetFocal];
    const descriptors = Object.fromEntries(names.map((name, i) => [name, {
      configurable: true, writable: true,
      value: function (...args) {
        return (this.useCPURendering ? originals[i] : replacements[i]).apply(this, args);
      },
    }]));
    Object.defineProperties(target, descriptors);
    return status('ready');
  }
  return { id: 'kin.stack-precision', preRegistration() {
    // Extension registration can be repeated across modes; never stack wrappers.
    pending ||= install().catch(() => status('unsupported'));
    return pending;
  } };
})();

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
    if (incomplete) groups.clear();
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
    const onStorage = event => { if (event.key === 'kin-session-ended') end(); };
    let channel; try { channel = new BroadcastChannel('kin-session'); channel.onmessage = e => { if (e.data?.type === 'session-ended') end(); }; } catch (_) {}
    window.addEventListener('storage', onStorage);
    window.addEventListener('kin-viewer-access-ended', end);
    stop = () => { end(); clearInterval(timer); panel.remove(); channel?.close(); window.removeEventListener('storage', onStorage); window.removeEventListener('kin-viewer-access-ended', end); restores.reverse().forEach(restore => restore()); };
    refresh();
  }
  return { id: 'kin.sr-provenance', preRegistration({ servicesManager, extensionManager }) { services = servicesManager.services; extensions = extensionManager; },
    onModeEnter: mount, onModeExit() { stop?.(); stop = null; } };
}

function kinCreateViewerHistory() {
  let services, commands, extensions, stop;
  const tools = { arrow: 'ArrowAnnotate', length: 'Length', angle: 'Angle', ellipse: 'EllipticalROI' };
  const kinds = Object.fromEntries(Object.entries(tools).map(([kind, tool]) => [tool, kind]));
  const names = { arrow: 'Arrow', key: 'Key Image', length: 'Length', angle: 'Angle', ellipse: 'Ellipse ROI' };
  function mount() {
    stop?.();
    const cs = window.cornerstone, ct = window.cornerstoneTools;
    if (!cs || !ct?.annotation?.locking) return;
    const entries = new Map(), annotations = new Map(), recovery = new Map();
    let scope = '', subject = '', me, generation = 0, readSequence = 0;
    let controller = new AbortController(), ended = false, checking = false;
    let lastAuth = 0, loading = false, navigation = 0, suspended = true;
    const panel = document.createElement('details');
    panel.id = 'kin-viewer-history'; panel.open = true;
    panel.style.cssText = 'position:fixed;right:8px;bottom:30px;z-index:40;width:300px;max-height:58vh;overflow:auto;background:#101e32;color:#e1ecfc;border:1px solid #657c9f;border-radius:8px;padding:10px;font:13px sans-serif';
    const summary = document.createElement('summary'); summary.textContent = 'Measurements & Key Images'; panel.append(summary);
    const status = document.createElement('p'); status.setAttribute('role', 'status'); panel.append(status);
    const actions = document.createElement('div'), list = document.createElement('div'); panel.append(actions, list);
    document.body.append(panel);
    const clone = value => JSON.parse(JSON.stringify(value));
    const itemOnly = head => { const item = clone(head.item); delete item.hidden; delete item.sourceDigest; return item; };
    const manual = kind => ['length', 'angle', 'ellipse'].includes(kind);
    function measurementReason(imageId, kind, points) {
      const image = cs.metaData.get('instance', imageId);
      const finite = n => (typeof n === 'number' || typeof n === 'string' && n.trim() !== '') && Number.isFinite(Number(n));
      const spacing = image?.PixelSpacing, orientation = image?.ImageOrientationPatient, origin = image?.ImagePositionPatient;
      if (image?.SOPClassUID !== '1.2.840.10008.5.1.4.1.1.2' || image.Modality !== 'CT' || Number(image.NumberOfFrames || 1) !== 1)
        return '일반 CT 원본 프레임에서 지원합니다';
      if (!Array.isArray(spacing) || spacing.length !== 2 || spacing.some(n => !finite(n) || Number(n) <= 0) ||
          !Array.isArray(orientation) || orientation.length !== 6 || orientation.some(n => !finite(n)) ||
          !Array.isArray(origin) || origin.length !== 3 || origin.some(n => !finite(n)) || !image.FrameOfReferenceUID ||
          image.PixelSpacingCalibrationType || cs.cache.getImage(imageId)?.calibration?.type) return '원본 좌표·간격·보정을 확인할 수 없습니다';
      const dot = (a, b) => a.reduce((s, n, i) => s + n * b[i], 0);
      const u = orientation.slice(0, 3).map(Number), v = orientation.slice(3).map(Number);
      const normal = [u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]];
      if (Math.max(Math.abs(dot(u,u)-1), Math.abs(dot(v,v)-1), Math.abs(dot(u,v))) > 1e-4) return '원본 방향이 올바르지 않습니다';
      if (kind === 'ellipse') {
        if (!finite(image.RescaleSlope) || Number(image.RescaleSlope) === 0 || !finite(image.RescaleIntercept) || image.RescaleType !== 'HU' || image.ModalityLUTSequence)
          return 'HU 보정을 확인할 수 없습니다';
        const axis = a => a.filter(n => Math.abs(n) > 1e-6).length === 1;
        if (!axis(normal) || points?.length === 4 && (!axis(points[0].map((n,i)=>n-points[1][i])) || !axis(points[3].map((n,i)=>n-points[2][i]))))
          return '사선·회전 ROI는 아직 지원하지 않습니다';
      }
      if (points?.some(p => {
        if (!Array.isArray(p) || p.length !== 3 || p.some(n => !Number.isFinite(n))) return true;
        const d = p.map((n,i)=>n-Number(origin[i])), x=dot(d,u)/Number(spacing[1]), y=dot(d,v)/Number(spacing[0]);
        return Math.abs(dot(d,normal)) > .001 || x < -.501 || y < -.501 || x > Number(image.Columns)-.499 || y > Number(image.Rows)-.499;
      })) return '측정이 원본 영상 범위를 벗어났습니다';
      return '';
    }
    const calculatedGeometry = new WeakMap(), trackedMeasurements = new WeakSet();
    const geometry = data => JSON.stringify(data.handles.points);
    const freshStats = (data, target) => {
      const stats = data.cachedStats?.[target];
      return stats && calculatedGeometry.get(stats) === geometry(data);
    };
    function trackMeasurement(a) {
      if (!manual(kinds[a.metadata.toolName]) || trackedMeasurements.has(a.data.cachedStats)) return;
      // The pinned calculator clears invalidated even when its image lookup
      // fails. Only a newly assigned native result witnesses these coordinates;
      // the existing trailing throttle and native voxel calculation stay intact.
      a.data.cachedStats = new Proxy(a.data.cachedStats || {}, {
        set(stats, target, value) {
          stats[target] = value;
          if (value && typeof value === 'object') calculatedGeometry.set(value, geometry(a.data));
          return true;
        },
      });
      // Calibration replaces cachedStats while keeping data. Reattach to that
      // new cache; existing values gain no witness until native recalculation.
      trackedMeasurements.add(a.data.cachedStats);
    }
    function sample(a) {
      if (!a || a.invalidated) return null;
      const kind = kinds[a.metadata.toolName], target = 'imageId:' + a.metadata.referencedImageId, s = a.data.cachedStats?.[target];
      if (!freshStats(a.data, target) || measurementReason(a.metadata.referencedImageId, kind, a.data.handles.points)) return null;
      const values = kind === 'length' ? [s.length] : kind === 'angle' ? [s.angle] :
        [s.area, s.mean, s.statsArray?.find(x => x?.name === 'min')?.value, s.max, s.statsArray?.find(x => x?.name === 'count')?.value];
      if (values.some(n => !Number.isFinite(n)) || kind === 'ellipse' && s.modalityUnit !== 'HU') return null;
      return { calculator: 'kin-native-manual-v1', values };
    }
    const measurementService = services.measurementService;
    const originalMeasurements = measurementService.getMeasurements;
    const numericMeasurement = m => manual(kinds[m?.toolName]);
    const unverifiedReport = () => ({ columns: ['Verification'], values: ['재확인 필요'] });
    function checkedMeasurement(m) {
      if (!m || ended || suspended || recovery.has(scope)) return null;
      const a = ct.annotation.state.getAnnotation(m.uid);
      if (!a || a.data.kinUnverified || !sample(a)) return null;
      const mapping = measurementService.getSourceMappings(m.source?.name, m.source?.version)
        ?.find(x => x.annotationType === a.metadata.toolName);
      if (!mapping) return null;
      // Native CSV functions capture numbers at mapping time. Map the current
      // verified target on every read, including a previously captured export.
      const target = 'imageId:' + a.metadata.referencedImageId;
      try {
        return mapping.toMeasurementSchema({ annotation: { ...a, data: {
          ...a.data, cachedStats: { [target]: a.data.cachedStats[target] },
        } } });
      } catch (_) { return null; } // Display sets may disappear before their metadata.
    }
    function projectMeasurement(m) {
      if (!numericMeasurement(m)) return m;
      const checked = checkedMeasurement(m);
      return { ...m, ...(checked || { data: null,
        displayText: { primary: ['재확인 필요'], secondary: [] } }),
        getReport: () => {
          const current = measurementService.getMeasurement(m.uid);
          return checkedMeasurement(current)?.getReport?.() || unverifiedReport();
        },
      };
    }
    const measurementViews = new Map(), measurementViewReads = new Set();
    const viewSignature = view => JSON.stringify([view.displayText, view.points]);
    const projectedMeasurements = function (...args) {
      return originalMeasurements.apply(this, args).map(m => {
        const view = projectMeasurement(m);
        // Native panel/CSV reads can happen between observation ticks. Track
        // the view actually returned, or a short unverified interval can leave
        // the panel stale when the next tick matches its older good signature.
        if (numericMeasurement(m) && measurementViews.get(m.uid) !== viewSignature(view)) measurementViewReads.add(m.uid);
        return view;
      });
    };
    measurementService.getMeasurements = projectedMeasurements;
    function refreshMeasurementViews() {
      const present = new Set();
      for (const m of originalMeasurements.call(measurementService)) {
        if (!numericMeasurement(m)) continue;
        present.add(m.uid);
        const view = projectMeasurement(m), signature = viewSignature(view);
        if (measurementViews.get(m.uid) === signature && !measurementViewReads.has(m.uid)) continue;
        measurementViewReads.delete(m.uid);
        measurementViews.set(m.uid, signature);
        // Publish a view refresh without removing the annotation or changing
        // geometry at the source (the native handler ignores false updates).
        measurementService.update(m.uid, m, false);
      }
      for (const uid of measurementViews.keys()) if (!present.has(uid)) { measurementViews.delete(uid); measurementViewReads.delete(uid); }
    }
    const reportContext = 'CORNERSTONE_STRUCTURED_REPORT', reportRestores = [], srRequests = new Map();
    function srItemMessage(m, reason) {
      const e = annotations.get(m?.uid), a = m?.uid && ct.annotation.state.getAnnotation(m.uid);
      const label = String(e?.draft?.label || m?.label || names[kinds[a?.metadata?.toolName]] || m?.toolName || '측정').slice(0, 80);
      const frame = e?.draft?.frame || m?.frameNumber;
      return '재확인 필요: ' + label + (frame ? ' · 프레임 ' + frame : '') + ' [' + String(m?.uid || '항목 없음').slice(0, 12) + '] — ' + reason + ' SR에 포함할 항목을 명시적으로 다시 선택하세요.';
    }
    function srVerificationMessage(m) {
      const e = annotations.get(m?.uid), a = m?.uid && ct.annotation.state.getAnnotation(m.uid);
      const reason = e?.head && e.head.referenceStatus !== 'verified' ? '원본 다시 확인을 누르세요.' :
        !a ? '현재 영상의 측정 표식을 찾을 수 없습니다.' :
        !a.data?.handles?.points ? '측정 위치가 완성되지 않았습니다. 측정을 마치세요.' :
        measurementReason(a.metadata.referencedImageId, kinds[a.metadata.toolName], a.data.handles.points) ||
        (a.data.kinUnverified ? '저장 당시 측정과 다릅니다. 편집 후 다시 측정하세요.' :
          !sample(a) ? '현재 위치의 계산이 완료되지 않았습니다. 측정을 마치고 다시 시도하세요.' : '현재 영상의 측정 변환을 확인할 수 없습니다.');
      return srItemMessage(m, reason);
    }
    let srBusy = false;
    async function manualSr(name, options) {
      if (srBusy) throw new Error('SR을 처리 중입니다. 결과를 기다려 주세요.');
      const selected = options.measurementData || [], ticket = generation; let requestKey;
      if (ended || !selected.length || selected.length > 16) throw new Error('직접 작성한 측정을1~16개 선택하세요.');
      srBusy = true; refreshSrButtons();
      try {
        await authenticate(ticket);
        const chosen = selected.map(m => annotations.get(m.uid));
        const invalid = chosen.findIndex(e => !e || !manual(e.draft.kind) || !writable(e) || e.heldDraft || e.head?.hidden);
        if (invalid !== -1)
          throw new Error(srItemMessage(selected[invalid], '현재 검사에서 직접 작성한 측정만 SR로 저장할 수 있습니다. 숨김이나 보관 중인 수정도 먼저 정리하세요.'));
        for (const [i, e] of chosen.entries()) {
          if (!checkedMeasurement(measurementService.getMeasurement(e.annotationUID))) throw new Error(srVerificationMessage(selected[i]));
          if (e.editing || e.pending || !e.head) await save(e, e.head ? 'edit' : 'create');
          if (!valid(ticket) || !e.head || e.editing || e.pending || e.busy || e.head.referenceStatus !== 'verified')
            throw new Error(srItemMessage(selected[i], '측정 저장을 완료하지 못했습니다. 측정 패널의 안내를 확인하세요.'));
        }
        const items = chosen.map(e => ({ id: e.head.id, revision: e.head.revision })).sort((a,b) => a.id.localeCompare(b.id));
        const key = scope + '|' + subject + '|' + JSON.stringify(items);
        requestKey = key;
        if (!srRequests.has(key)) srRequests.set(key, crypto.randomUUID());
        const stillCurrent = () => valid(ticket) && chosen.every((e, i) => !e.editing && !e.pending && !e.heldDraft &&
          items.some(item => item.id === e.head?.id && item.revision === e.head?.revision) && checkedMeasurement(measurementService.getMeasurement(e.annotationUID)));
        const endpoint = '/studies/' + scope + '/manual-sr';
        status.textContent = '원본 측정으로 SR을 확인하고 있습니다…';
        const prepared = await api(endpoint, { method: 'POST', body: JSON.stringify({ requestId: srRequests.get(key), items }) }, ticket);
        if (!stillCurrent()) throw new Error('SR 준비 중 측정이 변경되었습니다. 현재 측정을 다시 확인하세요.');
        if (name === 'downloadReport') {
          const bytes = Uint8Array.from(atob(prepared.dicom), c => c.charCodeAt(0));
          const url = URL.createObjectURL(new Blob([bytes], { type: 'application/dicom' }));
          const a = document.createElement('a'); a.href = url; a.download = 'KIN-manual-' + prepared.id + '.dcm';
          document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
          status.textContent = 'SR 파일을 다운로드했습니다. 검사에 저장하려면24시간 안에 SR 저장을 누르세요.';
          return prepared.dataset;
        }
        const stored = await api(endpoint + '/' + prepared.id + '/store', { method: 'POST', body: '{}' }, ticket);
        if (!stillCurrent()) throw new Error('SR 저장 응답을 받았습니다. 최신 측정과 저장 문서를 다시 확인하세요.');
        const source = extensions.getActiveDataSource?.()[0];
        source?.deleteStudyMetadataPromise?.(scope);
        // Public display-set API dispatches the pinned SR SOP handler; no
        // webpack module IDs or global DICOM serializer hooks are required.
        services.displaySetService.makeDisplaySets([stored.dataset], true);
        services.displaySetService.getActiveDisplaySets().find(ds => ds.SeriesInstanceUID === stored.dataset.SeriesInstanceUID)?.kinSelectDocument?.(stored.dataset.SOPInstanceUID);
        status.textContent = 'SR 저장 완료 · 검사 목록에서 원문을 다시 열 수 있습니다.';
        return stored.dataset;
      } catch (error) {
        if (error.status === 410 && requestKey) srRequests.delete(requestKey);
        if (valid(ticket)) {
          const message = error.message || (error.status === 410 ? 'SR 준비 파일의24시간 보관 기한이 지났습니다. 다시 누르면 새 파일을 준비합니다.' : error.status === 409 ? '측정이 변경되었거나 원본 재확인이 필요합니다.' : 'SR 처리를 완료하지 못했습니다. 같은 동작으로 다시 시도하세요.');
          status.textContent = message; services.uiNotificationService.show({ title: 'SR', message, type: 'warning' });
        }
        throw error;
      } finally { srBusy = false; refreshSrButtons(); }
    }
    for (const name of ['downloadReport', 'storeMeasurements']) {
      const original = commands?.getCommand(name, reportContext);
      if (!original) continue;
      const guarded = { ...original, commandFn: options => {
        const blocked = options.measurementData?.find(m => {
          const a = ct.annotation.state.getAnnotation(m.uid), current = measurementService.getMeasurement(m.uid);
          if (!numericMeasurement(m) && !numericMeasurement(current) && !manual(kinds[a?.metadata.toolName])) return false;
          // The pinned SR adapters use imageId:referencedImageId. An abandoned
          // volume target must not prevent export of the verified source frame.
          return !checkedMeasurement(current);
        });
        if (blocked || ended || suspended || recovery.has(scope)) {
          const message = ended ? '로그인이 종료되었습니다. 다시 로그인한 뒤 뷰어를 여세요.' :
            suspended || recovery.has(scope) ? '현재 검사 접근을 확인하고 보관 작업을 재개한 후 SR을 생성하세요.' :
            srVerificationMessage(blocked);
          status.textContent = message;
          services.uiNotificationService.show({ title: '측정 확인', message, type: 'warning' });
          throw new Error(message);
        }
        return manualSr(name, options);
      } };
      commands.registerCommand(reportContext, name, guarded);
      reportRestores.push(() => { if (commands.getCommand(name, reportContext) === guarded) commands.registerCommand(reportContext, name, original); });
    }
    const text = (parent, tag, value) => { const el = document.createElement(tag); el.textContent = value; parent.append(el); return el; };
    const button = (parent, label, run, disabled = false) => {
      const b = text(parent, 'button', label); b.type = 'button'; b.disabled = disabled;
      b.style.cssText = 'margin:3px;padding:4px 7px;border:1px solid #657c9f;border-radius:4px';
      b.addEventListener('click', () => Promise.resolve().then(run).catch(() => { status.textContent = '작업을 완료하지 못했습니다. 현재 내용을 확인하세요.'; })); return b;
    };
    const input = (parent, label, value, change, disabled = false) => {
      const wrap = text(parent, 'label', label), el = document.createElement('input');
      el.value = value; el.disabled = disabled; el.setAttribute('aria-label', label);
      el.style.cssText = 'display:block;width:100%;background:#0c1423;color:#fff;border:1px solid #657c9f;padding:4px';
      el.addEventListener('input', () => change(el.value)); wrap.append(el); return el;
    };
    const viewport = () => services.cornerstoneViewportService.getCornerstoneViewport(services.viewportGridService.getActiveViewportId());
    const reference = imageId => {
      const m = typeof imageId === 'string' && imageId.match(/\/studies\/([0-9.]+)\/series\/([0-9.]+)\/instances\/([0-9.]+)\/frames\/([1-9][0-9]*)(?:$|[?#])/);
      return m ? { study: m[1], seriesUid: m[2], sopUid: m[3], frame: Number(m[4]) } : null;
    };
    const matches = (r, item) => r?.study === scope && r.seriesUid === item.seriesUid && r.sopUid === item.sopUid && r.frame === item.frame;
    const current = () => reference(viewport()?.getCurrentImageId?.());
    const valid = ticket => !ended && ticket === generation && (!current() || current().study === scope);
    const writable = entry => !suspended && !recovery.has(scope) && me?.kind === 'member' && me.roles?.includes('radiologist') &&
      (!entry.head || entry.head.authorSub === subject);
    const render = () => { try { viewport()?.render(); } catch (_) {} };
    const lock = (entry, locked) => { if (entry.annotationUID) ct.annotation.locking.setAnnotationLocked(entry.annotationUID, locked); };
    function removeAnnotation(entry) {
      if (!entry.annotationUID) return;
      annotations.delete(entry.annotationUID);
      ct.annotation.state.removeAnnotation(entry.annotationUID);
      // Measurements can be created by later handle edits; remove the paired
      // transient OHIF row too, without treating its removal as a server delete.
      if (services.measurementService.getMeasurement(entry.annotationUID)) services.measurementService.remove(entry.annotationUID);
      entry.annotationUID = null;
    }
    function reset(message) {
      generation++; readSequence++; navigation++; controller.abort(); controller = new AbortController();
      srRequests.clear();
      for (const e of entries.values()) removeAnnotation(e);
      entries.clear(); annotations.clear(); list.replaceChildren(); actions.replaceChildren(); loading = false; suspended = true;
      delete panel.dataset.studyUid;
      status.textContent = message; render();
    }
    const hasWork = e => e.editing || e.pending || e.heldDraft;
    function park() {
      if (!scope || !subject) return;
      captureAnnotations();
      const saved = [];
      for (const e of entries.values()) {
        if (!hasWork(e)) continue;
        const a = e.annotationUID && ct.annotation.state.getAnnotation(e.annotationUID);
        if (e.editing && !e.pending && a) {
          e.draft.points = clone(a.data.handles.points);
          e.draft.label = a.data.text ?? a.data.label ?? '';
        }
        // Copy only session data. Detached handlers and late responses must not
        // mutate a parked draft or attach its annotation to another study.
        saved.push(clone({ id: e.id, head: e.head, draft: e.draft, editing: e.editing,
          pending: e.pending, heldDraft: e.heldDraft, latest: e.latest, message: e.message }));
      }
      if (saved.length) recovery.set(scope, { subject, entries: saved });
    }
    function deny() {
      park();
      // An unfinished drawing may not yet have a history entry. Quarantine
      // removes those transient marks too, without touching another study.
      for (const a of ct.annotation.state.getAllAnnotations()) {
        const study = reference(a.metadata.referencedImageId)?.study;
        if (!kinds[a.metadata.toolName] || study && study !== scope) continue;
        ct.annotation.state.removeAnnotation(a.annotationUID);
        if (measurementService.getMeasurement(a.annotationUID)) measurementService.remove(a.annotationUID);
      }
      reset('이 검사에 접근할 수 없습니다. 보관 작업은 접근 확인 후 재개할 수 있습니다.'); me = null;
      button(actions, 'Recheck Access', () => load());
    }
    function end() {
      if (ended) return;
      recovery.clear(); reset('로그인이 종료되었습니다. 다시 로그인한 뒤 뷰어를 여세요.'); ended = true; me = null; subject = ''; actions.replaceChildren();
      window.dispatchEvent(new Event('kin-viewer-access-ended'));
      // A shared workstation must not retain unsaved labels after logout either.
      for (const a of ct.annotation.state.getAllAnnotations()) if (kinds[a.metadata.toolName]) {
        ct.annotation.state.removeAnnotation(a.annotationUID);
        if (services.measurementService.getMeasurement(a.annotationUID)) services.measurementService.remove(a.annotationUID);
      }
      render();
    }
    async function api(path, options = {}, ticket = generation) {
      const parentSignal = controller.signal, request = new AbortController();
      const abort = () => request.abort(); parentSignal.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(abort, 30000);
      try {
      const res = await fetch('/api' + path, { ...options, cache: 'no-store', credentials: 'same-origin', signal: request.signal,
        headers: { 'X-KIN-CSRF': '1', ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
      if (!valid(ticket)) throw { stale: true };
      if (res.status === 401 || res.status === 403 && path === '/me') { end(); throw { stale: true }; }
      if (res.status === 403) { deny(); throw { stale: true }; }
      const data = await res.json().catch(() => null);
      if (!valid(ticket)) throw { stale: true };
      if (!res.ok || !data) throw { status: res.status, code: data?.code };
      return data;
      } finally { clearTimeout(timeout); parentSignal.removeEventListener('abort', abort); }
    }
    async function authenticate(ticket) {
      const user = await api('/me', {}, ticket);
      if (!user.sub || (subject && subject !== user.sub)) { end(); throw { stale: true }; }
      me = user; subject = user.sub; lastAuth = Date.now(); return user;
    }
    const path = () => '/studies/' + scope + '/viewer-items';
    function errorMessage(error) {
      if (error.code === 'VIEWER_STORAGE_LIMIT') return '저장 공간 한도입니다. 숨김으로 공간이 회수되지는 않습니다. 작성 내용은 미저장 상태로 남아 있습니다.';
      if (error.status === 409) return '다른 판 또는 저장 조건과 충돌했습니다. 최신판을 확인한 뒤 다시 저장하세요.';
      if (error.status === 400 || error.status === 413) return '지원 영상·원본 평면·입력 길이를 확인하세요. 작성 내용은 저장되지 않았습니다.';
      return '저장 결과를 확인하지 못했습니다. 같은 요청 재시도로 결과를 확인하세요.';
    }
    async function load(resume = false, recheck = null) {
      if (!scope || ended || loading) return;
      const ticket = generation, seq = ++readSequence; loading = true;
      status.textContent = '저장 항목 확인 중…';
      try {
        await authenticate(ticket);
        const heads = []; let cursor = null;
        do {
          const page = await api(path() + '?includeHidden=true&limit=100' + (recheck ? '&recheck=' + encodeURIComponent(recheck) : '') + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), {}, ticket);
          if (seq !== readSequence) return;
          if (!Array.isArray(page.items) || heads.length + page.items.length > 512 || (cursor && page.nextCursor === cursor)) throw new Error('Invalid page');
          heads.push(...page.items); cursor = page.nextCursor;
        } while (cursor);
        if (!valid(ticket) || seq !== readSequence) return;
        suspended = false;
        const parked = recovery.get(scope);
        if (resume === true && parked && parked.subject === subject) {
          for (const e of entries.values()) removeAnnotation(e);
          entries.clear(); list.replaceChildren();
          for (const e of clone(parked.entries)) { e.rehydrate = !e.head; entries.set(e.id, e); row(e); }
          recovery.delete(scope);
        }
        for (const head of heads) {
          let e = entries.get(head.id);
          if (e && (e.editing || e.pending || e.busy)) {
            if (head.revision !== e.head?.revision) { e.latest = head; e.message = '서버에 다른 판이 있습니다. 작성 내용은 유지됩니다.'; row(e); }
            else {
              // A read's source verdict can change without a new revision.
              // Retain the draft, never treat a parked verdict as fresh proof.
              e.head = head;
              if (manual(e.draft.kind) && head.referenceStatus !== 'verified') {
                const a = e.annotationUID && ct.annotation.state.getAnnotation(e.annotationUID);
                if (e.editing && !e.pending && a) e.draft.points = clone(a.data.handles.points);
                removeAnnotation(e); e.message = '재확인 필요: 원본을 확인하지 못했습니다. 작성 내용은 유지됩니다.';
              } else if (manual(e.draft.kind) && e.message.startsWith('재확인 필요: 원본')) e.message = '원본 확인 완료. 작성 내용은 아직 미저장 상태입니다.';
            }
            continue;
          }
          if (e) removeAnnotation(e);
          else { e = { id: head.id }; entries.set(e.id, e); }
          Object.assign(e, { head, draft: itemOnly(head), editing: false, latest: null, message: '' }); restoreHeldDraft(e); row(e);
        }
        for (const e of entries.values()) row(e);
        status.textContent = recheck ? (heads.some(h => h.id === recheck) ? '선택한 항목의 원본 확인을 마쳤습니다. 항목의 확인 상태를 보세요. 저장 이력은 바뀌지 않습니다.' : '선택한 저장 항목을 찾지 못했습니다. 목록을 새로고침하세요.') : heads.length + '개 저장 항목 · 저장은 판독 확정과 별개입니다.';
        panel.dataset.studyUid = scope;
        toolbar(); hydrate();
      } catch (e) { if (!e.stale && valid(ticket)) status.textContent = '목록을 확인하지 못했습니다. 새로고침으로 다시 확인하세요.'; }
      finally { if (ticket === generation) loading = false; }
    }
    function toolbar() {
      const ticket = generation;
      actions.replaceChildren(); button(actions, 'Refresh', load);
      if (recovery.has(scope)) {
        text(actions, 'p', '이 검사의 미저장 작업이 보관 중입니다. 이 뷰어를 닫거나 로그아웃하면 폐기됩니다.');
        button(actions, 'Resume Held Work', () => { if (valid(ticket)) return load(true); });
        button(actions, 'Discard Held Work', () => {
          if (!valid(ticket) || suspended || !recovery.has(scope)) return;
          if (!window.confirm('이 검사의 보관한 미저장 작업과 결과 미확인 요청을 버리시겠습니까? 서버 저장 이력은 유지됩니다.')) return;
          recovery.delete(scope); toolbar(); hydrate();
        });
        return;
      }
      for (const [label, command] of [['Download SR', 'downloadReport'], ['Store SR', 'storeMeasurements']]) {
        const control = button(actions, label, () => commands.runCommand(command, { measurementData: srSelection() }, reportContext), true);
        control.dataset.kinSr = command;
      }
      refreshSrButtons();
      for (const kind of ['length', 'angle', 'ellipse']) button(actions, names[kind], () => {
        const v = viewport(), group = v && ct.ToolGroupManager.getToolGroupForViewport(v.id, v.renderingEngineId);
        if (!group || v.type !== 'stack') { status.textContent = '원본 CT 프레임을 선택하세요.'; return; }
        if (!group.getToolInstance(tools[kind])) group.addTool(tools[kind]);
        configureMeasurements(group);
        const previous = group.getActivePrimaryMouseButtonTool();
        if (previous) group.setToolPassive(previous);
        group.setToolActive(tools[kind], { bindings: [{ mouseButton: ct.Enums.MouseBindings.Primary }] });
      }, !writable({}));
      button(actions, 'Add Key Image', () => {
        const r = current(); if (!r || r.study !== scope) return;
        const e = { id: crypto.randomUUID(), editing: true, draft: { schemaVersion: 1, kind: 'key', seriesUid: r.seriesUid, sopUid: r.sopUid, frame: r.frame, title: '', description: '' } };
        entries.set(e.id, e); row(e);
      }, !writable({}));
    }
    function srSelection() {
      return measurementService.getMeasurements().filter(m => annotations.has(m.uid) && manual(annotations.get(m.uid).draft.kind));
    }
    function refreshSrButtons() {
      const selected = srSelection();
      const ready = !ended && !srBusy && selected.length > 0 && selected.length <= 16 && selected.every(m => {
        const e = annotations.get(m.uid);
        return writable(e) && !e.heldDraft && !e.head?.hidden && !e.busy && checkedMeasurement(measurementService.getMeasurement(m.uid));
      });
      for (const b of actions.querySelectorAll('[data-kin-sr]')) {
        b.disabled = !ready; b.title = ready ? '' : srBusy ? 'SR 처리 결과를 기다려 주세요.' : '원본 프레임에서 직접 작성한 측정의 확인이 끝나면 사용할 수 있습니다.';
      }
    }
      const configured = new Map();
    function configureMeasurements(group) {
      if (!group || configured.has(group)) return;
      const roi = group.getToolInstance('EllipticalROI');
      if (!roi?.configuration?.statsCalculator) return;
      const previous = roi.configuration;
      const calculator = previous.statsCalculator;
      // Preserve native voxel selection and statistics; expose the named min
      // which this pinned release omits from its returned array.
      const adapter = {
        statsInit: options => calculator.statsInit?.(options),
        statsCallback: value => calculator.statsCallback(value),
        getStatistics: (...args) => {
          const result = calculator.getStatistics(...args);
          return { ...result, array: [...result.array.filter(s => s.name !== 'min'), result.min] };
        },
      };
      roi.configuration = { ...previous, statsCalculator: adapter, getTextLines(data, target) {
        if (data.kinUnverified) return ['재확인 필요: 측정값을 확인할 수 없습니다'];
        const s = data.cachedStats[target]; if (!s) return [];
        const min = s.statsArray?.find(x => x?.name === 'min')?.value;
        const number = x => Math.sign(x) * Math.round(Math.abs(x));
        const lines = [];
        if (Number.isFinite(s.area)) lines.push('Area: ' + number(s.area) + ' ' + s.areaUnit);
        if (s.modalityUnit === 'HU') {
          for (const [name, value] of [['Mean', s.mean], ['Min', min], ['Max', s.max]])
            if (Number.isFinite(value)) lines.push(name + ': ' + (name === 'Mean' ? number(value) : value) + ' HU');
        }
        return lines;
      } };
      const restores = [() => { roi.configuration = previous; }];
      for (const kind of ['length', 'angle', 'ellipse']) {
        if (!group.getToolInstance(tools[kind])) group.addTool(tools[kind]);
        const tool = group.getToolInstance(tools[kind]), config = tool.configuration, add = tool.addNewAnnotation;
        const lines = config.getTextLines;
        tool.addNewAnnotation = function (event) {
          if (ended || !subject || suspended || recovery.has(scope)) {
            status.textContent = ended ? '로그인이 종료되었습니다. 다시 로그인한 뒤 뷰어를 여세요.' : '현재 검사 접근과 보관 작업을 확인한 후 측정하세요.'; return;
          }
          const v = cs.getEnabledElement(event.detail.element).viewport;
          const id = v.type === 'stack' && v.getCurrentImageId();
          let reason = id ? measurementReason(id, kind) : '일반 CT 원본 프레임을 선택하세요';
          if (!reason && kind === 'ellipse' && v.getCamera().viewUp.filter(n => Math.abs(n) > 1e-6).length !== 1)
            reason = '사선·회전 ROI는 아직 지원하지 않습니다';
          if (reason) { status.textContent = reason; return; }
          const annotation = add.call(this, event);
          if (annotation) trackMeasurement(annotation);
          return annotation;
        };
        tool.configuration = { ...config, getTextLines(data, target) {
          const id = target.startsWith('imageId:') && target.slice(8);
          const reason = data.kinUnverified ? '재확인 필요: 저장 당시 측정과 다릅니다' :
            id ? measurementReason(id, kind, data.handles.points) : '지원하지 않는 측정 평면입니다';
          if (reason) return [reason];
          if (!freshStats(data, target)) return ['재확인 필요: 현재 좌표로 계산되지 않았습니다'];
          if (kind === 'ellipse') return lines(data, target);
          const value = data.cachedStats[target]?.[kind === 'length' ? 'length' : 'angle'];
          if (!Number.isFinite(value) || value <= 0) return ['측정을 완료하세요'];
          return [(Math.round(value * 10) / 10).toFixed(1) + (kind === 'length' ? ' mm' : '°')];
        } };
        restores.push(() => { tool.configuration = config; tool.addNewAnnotation = add; });
      }
      configured.set(group, restores);
    }
    function updateAnnotation(e) {
      const a = e.annotationUID && ct.annotation.state.getAnnotation(e.annotationUID);
      if (a) { a.data.text = e.draft.label; a.data.label = e.draft.label; if (!manual(e.draft.kind)) a.invalidated = true; render(); }
    }
    function restoreHeldDraft(e) {
      if (!e.head?.hidden && e.heldDraft) {
        if (manual(e.draft.kind) && e.head.referenceStatus !== 'verified') {
          e.message = '재확인 필요: 원본을 확인하지 못했습니다. 보관한 수정은 유지됩니다.';
          return;
        }
        // The hidden head may have replaced the live handles with its older
        // points. Rehydrate the held geometry instead of copying those back.
        removeAnnotation(e);
        e.draft = e.heldDraft; e.heldDraft = null; e.editing = true;
        e.message = '복원 완료. 보관한 수정은 아직 미저장 상태입니다.' +
          (matches(current(), e.draft) ? ' 위치를 확인한 후 저장하세요.' : ' 영상으로 이동해 위치를 확인한 후 저장하세요.');
      }
    }
    const heldActionReady = e => valid(generation) && entries.get(e.id) === e && writable(e) && e.heldDraft && !e.busy && !e.pending;
    function discardHeld(e) {
      if (!heldActionReady(e)) return;
      if (!window.confirm('보관한 미저장 수정을 버리고 서버판 r' + (e.latest || e.head).revision +
          '을 채택하시겠습니까?' + (e.latest ? ' 아직 반영하지 않은 최신 서버판입니다.' : '') + ' 서버 저장 이력은 유지됩니다.')) return;
      if (!heldActionReady(e)) return;
      // A detached button can outlive a restore request. Never discard the
      // local recovery copy while that request's result is still uncertain.
      removeAnnotation(e);
      e.head = e.latest || e.head; e.latest = null;
      e.heldDraft = null; e.editing = false; e.draft = itemOnly(e.head);
      e.message = '보관한 미저장 수정을 버렸습니다. 저장 이력은 유지됩니다.';
      if (manual(e.draft.kind) && e.head.referenceStatus !== 'verified')
        e.message += ' 재확인 필요: 원본 영상의 동일성을 확인할 수 없습니다.';
      row(e); hydrate(); render();
    }
    function row(e) {
      if (!e.element) { e.element = document.createElement('section'); e.element.style.cssText = 'border-top:1px solid #405777;margin-top:8px;padding-top:8px'; list.append(e.element); }
      const el = e.element; el.replaceChildren(); el.dataset.itemId = e.head?.id || ''; el.dataset.kind = e.draft.kind;
      text(el, 'strong', names[e.draft.kind] + ' · ' + (e.head ? 'Saved r' + e.head.revision : 'Unsaved') + (e.head?.hidden ? ' · Hidden' : ''));
      if (e.head) text(el, 'div', e.head.authorActor + (writable(e) ? ' · My Item' : ' · Read-only'));
      if (e.editing) {
        input(el, e.draft.kind !== 'key' ? 'Annotation Text' : 'Key Title', e.draft.label ?? e.draft.title, value => {
          e.draft[e.draft.kind !== 'key' ? 'label' : 'title'] = value; updateAnnotation(e);
        }, !!(e.busy || e.pending));
        if (e.draft.kind === 'key') input(el, 'Key Description', e.draft.description || '', value => { e.draft.description = value; }, !!(e.busy || e.pending));
      } else {
        text(el, 'p', e.draft.label ?? e.draft.title);
        if (e.draft.description) text(el, 'p', e.draft.description);
      }
      text(el, 'div', '프레임 ' + e.draft.frame);
      if (e.message) text(el, 'p', e.message);
      if (e.heldDraft) {
        text(el, 'p', '미저장 수정은 보관 중입니다. ' + (e.head.hidden ?
          '숨김을 복원하고 원본을 확인한 후 다시 편집할 수 있습니다.' : '원본을 다시 확인하면 보관한 수정으로 돌아갑니다.'));
        const held = text(el, 'details', ''); text(held, 'summary', 'Held Changes');
        text(held, 'p', e.heldDraft.label ?? e.heldDraft.title);
        if (e.heldDraft.description) text(held, 'p', e.heldDraft.description);
        text(held, 'p', '프레임 ' + e.heldDraft.frame + ' · 아직 저장되지 않은 내용입니다.');
      }
      button(el, 'Go to Image', () => navigate(e));
      const sourceUnverified = manual(e.draft.kind) && e.head && e.head.referenceStatus !== 'verified';
      if (sourceUnverified && !e.head.hidden) {
        text(el, 'p', '저장 이력과 현재 원본 확인은 별개입니다. 이 항목만 다시 확인할 수 있습니다. 원본이 바뀐 경우 새 뷰어에서 다시 측정하세요. 이 창의 수정과 기존 저장 이력은 유지됩니다.');
        if (!e.heldDraft) button(el, 'Recheck Source', () => {
          if (valid(generation) && entries.get(e.id) === e && !e.busy && !e.pending) return load(false, e.head.id);
        }, !!(e.busy || e.pending));
        const link = text(el, 'a', 'Remeasure in New Viewer');
        link.href = '/ohif/viewer?StudyInstanceUIDs=' + encodeURIComponent(scope);
        link.target = '_blank'; link.rel = 'noopener noreferrer';
      }
      if (writable(e)) {
        if (e.pending) button(el, 'Retry Request', () => save(e), !!e.busy);
        else if (e.editing) button(el, 'Save', () => save(e, 'edit'), !!e.busy || !!e.latest || !!sourceUnverified);
        else if (!e.head?.hidden) button(el, 'Edit', () => { e.editing = true; lock(e, false); row(e); }, manual(e.draft.kind) && e.head?.referenceStatus !== 'verified');
        if (e.head && !e.editing && !e.pending) button(el, e.head.hidden ? 'Restore' : 'Hide', () => {
          const reason = window.prompt((e.head.hidden ? '복원' : '숨김') + ' 사유');
          if (reason?.trim()) save(e, e.head.hidden ? 'restore' : 'hide', reason);
        }, !!e.busy);
        if (e.latest && !e.pending) button(el, 'Use Latest & Keep Changes', () => {
          e.head = e.latest; e.latest = null;
          if (e.head.hidden) {
            if (e.editing) e.heldDraft ??= clone(e.draft);
            removeAnnotation(e); render();
            e.editing = false; e.draft = itemOnly(e.head); e.message = '서버에서 숨겨졌습니다.';
          }
          else if (e.heldDraft) { e.draft = itemOnly(e.head); restoreHeldDraft(e); }
          else if (e.editing) e.message = '최신판을 확인했습니다. 저장을 눌러야 내 수정이 반영됩니다.';
          else { e.draft = itemOnly(e.head); e.message = '최신 서버판을 반영했습니다.'; }
          row(e); hydrate(); render();
        }, !!e.busy);
        if (e.heldDraft) {
          if (!e.head.hidden) button(el, 'Recheck Source', () => {
            if (heldActionReady(e)) return load(false, e.head.id);
          }, !!(e.busy || e.pending));
          button(el, 'Discard Held Changes', () => discardHeld(e), !!(e.busy || e.pending));
        }
      }
      if (e.head) button(el, 'History', async () => {
        const ticket = generation; let cursor = null, count = 0;
        const history = document.createElement('div'); el.append(history);
        const more = async () => {
          const data = await api(path() + '/' + e.head.id + '/revisions?limit=50' + (cursor ? '&cursor=' + cursor : ''), {}, ticket);
          if (!valid(ticket) || !el.isConnected) return;
          for (const r of data.revisions) text(history, 'p', 'r' + r.revision + ' · ' + ({ create: '생성', edit: '수정', hide: '숨김', restore: '복원' }[r.action] || r.action) + ' · ' + r.actor + ' · ' + r.at + ' · ' + r.reason + ' · ' + (r.item.label ?? r.item.title));
          count += data.revisions.length; cursor = data.nextCursor;
          if (cursor && count < 4096) button(history, 'Load More History', more);
        };
        await more();
      });
    }
    async function save(e, action, reason) {
      if (!valid(generation) || entries.get(e.id) !== e || !writable(e) || e.busy || ended) return;
      // A verdict can change without a revision. A retained draft must never
      // bind itself to different source bytes by repeatedly retrying an edit.
      if (!e.pending && e.editing && manual(e.draft.kind) && e.head && e.head.referenceStatus !== 'verified') {
        e.message = '재확인 필요: 원본을 다시 확인하거나 새 뷰어에서 재측정하세요. 작성 내용은 유지됩니다.'; row(e); return;
      }
      if (manual(e.draft.kind) && e.editing && !e.pending) {
        const baseline = sample(e.annotationUID && ct.annotation.state.getAnnotation(e.annotationUID));
        if (!baseline) { e.message = '측정을 마치고 계산 완료 후 저장하세요.'; row(e); return; }
        e.draft.baseline = baseline;
      }
      const ticket = generation; e.busy = true; lock(e, true);
      if (!e.pending) {
        const annotation = e.annotationUID && ct.annotation.state.getAnnotation(e.annotationUID);
        if (e.editing && annotation) {
          e.draft.points = clone(annotation.data.handles.points);
          e.draft.label = annotation.data.text ?? annotation.data.label ?? '';
        }
        const command = { requestId: crypto.randomUUID(), item: clone(e.draft) };
        if (e.head) Object.assign(command, { expectedRevision: e.head.revision, action, ...(reason ? { reason } : {}) });
        e.pending = { url: path() + (e.head ? '/' + e.head.id + '/revisions' : ''), body: JSON.stringify(command) };
      }
      row(e);
      try {
        await authenticate(ticket);
        const head = await api(e.pending.url, { method: 'POST', body: e.pending.body }, ticket);
        if (!valid(ticket) || !entries.has(e.id)) return;
        const duplicate = entries.get(head.id);
        if (duplicate && duplicate !== e && hasWork(duplicate)) {
          // A lost create receipt can be listed before its retry resolves.
          // Keep edits started on that listed row instead of overwriting them.
          removeAnnotation(e); e.element?.remove(); entries.delete(e.id);
          duplicate.message = '같은 요청의 저장 결과를 확인했습니다. 이 항목의 작성 내용은 유지됩니다.';
          row(duplicate); return;
        }
        if (duplicate && duplicate !== e) { removeAnnotation(duplicate); duplicate.element?.remove(); }
        entries.delete(e.id); e.id = head.id; entries.set(e.id, e);
        Object.assign(e, { head, draft: itemOnly(head), pending: null, latest: null, editing: false, message: '저장 완료' });
        restoreHeldDraft(e);
        if (manual(e.draft.kind) && head.referenceStatus !== 'verified') {
          e.message = '저장 완료 · 재확인 필요: 원본 영상의 동일성을 확인할 수 없습니다. 새로고침으로 다시 확인하세요.';
          removeAnnotation(e);
        } else if (head.hidden) removeAnnotation(e);
        else lock(e, !e.editing);
      } catch (error) {
        if (error.stale || !valid(ticket)) return;
        e.message = errorMessage(error);
        if (error.status >= 400 && error.status < 500) { e.pending = null; lock(e, !e.editing); }
        if (error.status === 409) await load();
      } finally { if (valid(ticket) && entries.has(e.id)) { e.busy = false; row(e); } }
    }
    async function navigate(e) {
      if (!valid(generation) || suspended || recovery.has(scope) || entries.get(e.id) !== e) return;
      const ticket = generation, nav = ++navigation;
      const sets = services.displaySetService.getActiveDisplaySets().filter(d => d.StudyInstanceUID === scope && d.SeriesInstanceUID === e.draft.seriesUid && (d.images || d.instances || []).some(i => i.SOPInstanceUID === e.draft.sopUid));
      if (sets.length !== 1) { e.message = '현재 검사에서 원본 시리즈를 찾을 수 없습니다.'; row(e); return; }
      const viewportId = services.viewportGridService.getActiveViewportId();
      if (!(viewport()?.getImageIds?.() || []).some(id => matches(reference(id), e.draft))) {
        services.viewportGridService.setDisplaySetsForViewport({ viewportId, displaySetInstanceUIDs: [sets[0].displaySetInstanceUID] });
      }
      for (let n = 0; n < 100; n++) {
        if (!valid(ticket) || nav !== navigation) return;
        const v = services.cornerstoneViewportService.getCornerstoneViewport(viewportId);
        const index = (v?.getImageIds?.() || []).findIndex(id => matches(reference(id), e.draft));
        if (index >= 0) { await v.setImageIdIndex(index); if (valid(ticket) && nav === navigation) { v.render(); hydrate(); } return; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (valid(ticket)) { e.message = '원본 프레임을 열지 못했습니다.'; row(e); }
    }
    function hydrate() {
      const v = viewport(), imageId = v?.getCurrentImageId?.(), r = reference(imageId);
      if (!r || r.study !== scope || !subject || ended || suspended || recovery.has(scope)) return;
      configureMeasurements(ct.ToolGroupManager.getToolGroupForViewport(v.id, v.renderingEngineId));
      const plane = cs.metaData.get('imagePlaneModule', imageId);
      for (const e of entries.values()) {
        if (!e.head && !e.rehydrate || e.head?.hidden || !tools[e.draft.kind] || e.annotationUID || !matches(r, e.draft) || plane?.frameOfReferenceUID !== e.draft.frameOfReferenceUid) continue;
        if (manual(e.draft.kind) && e.head && e.head.referenceStatus !== 'verified') {
          if (!e.message) { e.message = '재확인 필요: 원본 영상의 동일성을 확인할 수 없습니다.'; row(e); }
          continue;
        }
        const uid = crypto.randomUUID(), camera = v.getCamera();
        const a = { annotationUID: uid, highlighted: false, invalidated: true, isLocked: true, isVisible: true,
          metadata: { toolName: tools[e.draft.kind], FrameOfReferenceUID: e.draft.frameOfReferenceUid, referencedImageId: imageId, viewPlaneNormal: e.draft.viewPlaneNormal || camera.viewPlaneNormal, viewUp: e.draft.viewUp || camera.viewUp },
          data: { text: e.draft.label, label: e.draft.label, kinUnverified: manual(e.draft.kind) && !e.editing, handles: { points: clone(e.draft.points), activeHandleIndex: null, textBox: { hasMoved: false, worldPosition: [0, 0, 0], worldBoundingBox: { topLeft: [0, 0, 0], topRight: [0, 0, 0], bottomLeft: [0, 0, 0], bottomRight: [0, 0, 0] } } }, cachedStats: {} } };
        trackMeasurement(a);
        e.rehydrate = false;
        ct.annotation.state.addAnnotation(a, v.element); e.annotationUID = uid; annotations.set(uid, e); lock(e, !!(e.pending || e.busy || !e.editing)); render();
      }
    }
    function scan() {
      if (ended) return;
      const r = current();
      // Switching display sets briefly removes the viewport. Mode exit, not
      // that loading gap, owns teardown of drafts and in-flight commands.
      if (!r) return;
      if (r.study !== scope) {
        park(); reset('검사 확인 중…'); scope = r?.study || ''; me = null;
        if (scope) load(); return;
      }
      if (!subject || !scope || suspended || recovery.has(scope)) return;
      const v = viewport();
      configureMeasurements(v && ct.ToolGroupManager.getToolGroupForViewport(v.id, v.renderingEngineId));
      for (const a of ct.annotation.state.getAllAnnotations()) {
        if (!manual(kinds[a.metadata.toolName])) continue;
        trackMeasurement(a);
        if (a.metadata.referencedImageId === v.getCurrentImageId() &&
            !freshStats(a.data, 'imageId:' + a.metadata.referencedImageId)) {
          a.invalidated = true; render();
        }
      }
      for (const e of entries.values()) {
        const a = e.annotationUID && ct.annotation.state.getAnnotation(e.annotationUID);
        if (e.annotationUID && !a) {
          annotations.delete(e.annotationUID); e.annotationUID = null;
          if (!e.head && !e.pending) { entries.delete(e.id); e.element?.remove(); continue; }
        }
        if (a && e.head && !e.editing) {
          a.data.text = e.draft.label;
          a.data.handles.points = clone(e.draft.points);
          lock(e, true);
        }
        if (a && e.head && manual(e.draft.kind)) {
          const actual = sample(a), baseline = e.head.item.baseline;
          const remeasured = e.editing && geometry(a.data) !== JSON.stringify(e.head.item.points);
          const mismatch = e.head.referenceStatus !== 'verified' || !actual || !remeasured &&
            (actual.calculator !== baseline?.calculator || actual.values.length !== baseline?.values?.length ||
            actual.values.some((value, index) => value !== baseline.values[index]));
          if (a.data.kinUnverified !== mismatch) { a.data.kinUnverified = mismatch; render(); }
          if (mismatch && actual && !e.message.startsWith('재확인 필요')) {
            e.message = e.head.referenceStatus !== 'verified' ? '재확인 필요: 원본을 확인하지 못했습니다. 작성 내용은 유지됩니다.' :
              '재확인 필요: 재계산 값이 저장 당시와 다릅니다. 편집 후 다시 측정하세요.'; row(e);
          }
          else if (!mismatch && e.message.startsWith('재확인 필요')) { e.message = e.editing ? '재측정 확인 완료. 작성 내용은 아직 미저장 상태입니다.' : ''; row(e); }
        }
      }
      hydrate();
      captureAnnotations();
      if (Date.now() - lastAuth > 15000 && !checking) {
        checking = true; const ticket = generation;
        authenticate(ticket).then(() => api(path() + '?limit=1', {}, ticket)).catch(() => {}).finally(() => { checking = false; });
      }
      refreshMeasurementViews(); refreshSrButtons();
    }
    function captureAnnotations() {
      if (suspended || recovery.has(scope)) return;
      for (const a of ct.annotation.state.getAllAnnotations()) {
        const kind = kinds[a.metadata.toolName];
        const count = kind === 'angle' ? 3 : kind === 'ellipse' ? 4 : 2;
        if (!kind || !matches(reference(a.metadata.referencedImageId), { ...reference(a.metadata.referencedImageId) }) || !Array.isArray(a.data.handles?.points) || a.data.handles.points.length !== count || kind === 'arrow' && typeof a.data.text !== 'string') continue;
        let e = annotations.get(a.annotationUID);
        if (!e) {
          const ref = reference(a.metadata.referencedImageId);
          e = { id: crypto.randomUUID(), annotationUID: a.annotationUID, editing: true,
            draft: { schemaVersion: 1, kind, seriesUid: ref.seriesUid, sopUid: ref.sopUid, frame: ref.frame, frameOfReferenceUid: a.metadata.FrameOfReferenceUID, label: a.data.text ?? a.data.label ?? '', points: clone(a.data.handles.points),
              ...(kind === 'arrow' ? {} : { viewPlaneNormal: clone(a.metadata.viewPlaneNormal), viewUp: clone(a.metadata.viewUp) }) } };
          entries.set(e.id, e); annotations.set(a.annotationUID, e); row(e);
        } else if (e.editing && !e.busy && !e.pending) {
          e.draft.points = clone(a.data.handles.points);
          const label = a.data.text ?? a.data.label ?? '';
          if (e.draft.label !== label) { e.draft.label = label; row(e); }
        }
      }
    }
    const onStorage = e => { if (e.key === 'kin-session-ended') end(); };
    const onFocus = () => { lastAuth = 0; };
    const beforeUnload = e => { if (recovery.size || [...entries.values()].some(hasWork)) { e.preventDefault(); e.returnValue = ''; } };
    const jobGuard = () => recovery.size > 0 || [...entries.values()].some(x => hasWork(x) || x.busy) ||
      ct.annotation.state.getAllAnnotations().some(a => kinds[a.metadata.toolName] && !ct.annotation.locking.isAnnotationLocked(a.annotationUID));
    window.kinViewerHistoryHasUnsaved = jobGuard;
    const workspaceState = () => ({ dirty: jobGuard(), busy: [...entries.values()].some(x => x.busy || x.pending) });
    window.kinViewerHistoryWorkspaceState = workspaceState;
    let channel;
    try { channel = new BroadcastChannel('kin-session'); channel.onmessage = e => { if (e.data?.type === 'session-ended') end(); }; } catch (_) {}
    window.addEventListener('storage', onStorage); window.addEventListener('focus', onFocus); window.addEventListener('beforeunload', beforeUnload);
    // The pinned viewer changes active viewports through several services. A
    // bounded observation timer also covers stack frame changes without patching them.
    const timer = setInterval(() => { try { scan(); } catch (_) { status.textContent = '현재 영상 연결을 확인할 수 없습니다.'; } }, 250);
    // Identity changes must invalidate immediately, even for A→B→A within one
    // observation tick. Stack events and active-viewport events own that boundary.
    const onImage = () => { try { scan(); } catch (_) {} };
    const stackEvent = cs.Enums.Events.STACK_NEW_IMAGE;
    document.addEventListener(stackEvent, onImage, true);
    const subscriptions = Object.values(services.viewportGridService.EVENTS).map(event => services.viewportGridService.subscribe(event, onImage));
    stop = () => { end(); clearInterval(timer); channel?.close(); document.removeEventListener(stackEvent, onImage, true); subscriptions.forEach(s => s.unsubscribe()); window.removeEventListener('storage', onStorage); window.removeEventListener('focus', onFocus); window.removeEventListener('beforeunload', beforeUnload); for (const restores of configured.values()) restores.reverse().forEach(restore => restore()); configured.clear(); panel.remove(); };
    const previousStop = stop;
    stop = () => {
      if (window.kinViewerHistoryHasUnsaved === jobGuard) delete window.kinViewerHistoryHasUnsaved;
      if (window.kinViewerHistoryWorkspaceState === workspaceState) delete window.kinViewerHistoryWorkspaceState;
      if (measurementService.getMeasurements === projectedMeasurements) measurementService.getMeasurements = originalMeasurements;
      reportRestores.reverse().forEach(restore => restore());
      previousStop();
    };
    scan();
  }
  return { id: 'kin.viewer-history', preRegistration({ servicesManager, commandsManager, extensionManager }) { services = servicesManager.services; commands = commandsManager; extensions = extensionManager; }, onModeEnter: mount, onModeExit() { stop?.(); stop = null; } };
}

// Only a bounded recent grid is retained; transient display-set IDs never leave this session.
const kinViewerLayoutModel = (() => {
  const PREFIX = 'kin-viewer-layout-v1:';
  const uid = s => typeof s === 'string' && s.length <= 64 && /^[0-9]+(?:\.[0-9]+)*$/.test(s);
  const exact = (x, keys) => x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).sort().join('|') === [...keys].sort().join('|');
  function scope(search) {
    const query = new URLSearchParams(search), raw = query.getAll('StudyInstanceUIDs');
    if (raw.length !== 1) return null;
    const values = raw[0].split(',');
    return values.length >= 1 && values.length <= 2 && values.every(uid) && new Set(values).size === values.length ? values.sort() : null;
  }
  function owner(me) {
    return me?.kind === 'member' && [me.sub, me.institution].every(x => typeof x === 'string' && x.length > 0 && x.length <= 256)
      ? PREFIX + JSON.stringify([me.institution, me.sub]) : null;
  }
  function normalize(value) {
    if (!exact(value, ['version', 'studies', 'rows', 'cols', 'active', 'cells']) || value.version !== 1) return null;
    const { studies, rows, cols, active, cells } = value;
    if (!Array.isArray(studies) || ![1, 2].includes(studies.length) || !studies.every(uid) || new Set(studies).size !== studies.length) return null;
    if (![1, 2].includes(rows) || ![1, 2].includes(cols) || !Number.isInteger(active) || active < 0 || active >= rows * cols) return null;
    if (!Array.isArray(cells) || cells.length !== rows * cols || cells.every(x => x === null)) return null;
    if (!cells.every(x => x === null || (exact(x, ['study', 'series']) && studies.includes(x.study) && uid(x.series)))) return null;
    return { version: 1, studies: [...studies].sort(), rows, cols, active, cells: cells.map(x => x && ({ study: x.study, series: x.series })) };
  }
  function read(storage, key) {
    if (!key) throw new Error('계정 정보를 확인할 수 없습니다.');
    const raw = storage.getItem(key);
    if (raw === null) return null;
    const value = typeof raw === 'string' && raw.length <= 8192 ? normalize(JSON.parse(raw)) : null;
    if (!value) throw new Error('저장한 배치가 손상되었거나 지원하지 않는 형식입니다.');
    return value;
  }
  function write(storage, key, value) {
    const clean = normalize(value);
    if (!key || !clean) throw new Error('이 배치는 저장할 수 없습니다.');
    storage.setItem(key, JSON.stringify(clean));
  }
  return { PREFIX, uid, scope, owner, normalize, read, write };
})();

function kinCreateViewerLayout() {
  let services, stop;
  function mount() {
    stop?.();
    const model = kinViewerLayoutModel, grid = services.viewportGridService;
    const cs = services.cornerstoneViewportService, ds = services.displaySetService;
    const search = location.search, studies = model.scope(search);
    const panel = document.createElement('details'); panel.id = 'kin-viewer-layout'; panel.open = true;
    panel.style.cssText = 'position:fixed;left:8px;bottom:30px;z-index:41;width:260px;max-width:calc(100vw - 16px);background:#101e32;color:#e1ecfc;border:1px solid #657c9f;border-radius:8px;padding:8px;font:13px sans-serif';
    const summary = document.createElement('summary'); summary.textContent = 'Recent Layout'; panel.append(summary);
    const note = document.createElement('p'); note.textContent = '최근 1건만 저장합니다. 영상 위치·확대·주석은 포함하지 않습니다.'; panel.append(note);
    const status = document.createElement('p'); status.id = 'kin-viewer-layout-status'; status.setAttribute('role', 'status'); panel.append(status);
    const controls = document.createElement('div'); panel.append(controls); document.body.append(panel);
    let ended = false, busy = false, key = null, channel;
    const controller = new AbortController();
    const buttons = [];
    const live = () => !ended && location.search === search;
    const refresh = () => buttons.forEach(b => { b.disabled = ended || busy || !key || !studies; });
    function end() { ended = true; controller.abort(); key = null; status.textContent = '세션이 변경되었습니다. 다시 로그인한 뒤 뷰어를 여세요.'; refresh(); }
    async function get(path) {
      const request = new AbortController(), abort = () => request.abort();
      controller.signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, 10000);
      try {
        const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal: request.signal, headers: { 'X-KIN-CSRF': '1' } });
        if (!live()) throw new Error('화면이 변경되어 배치를 적용하지 않았습니다.');
        if (response.status === 401 || response.status === 403) { end(); throw new Error('검사 접근 권한을 확인할 수 없습니다.'); }
        if (!response.ok) throw new Error('서버 연결을 확인한 뒤 다시 시도하세요.');
        return await response.json();
      } finally { clearTimeout(timer); controller.signal.removeEventListener('abort', abort); }
    }
    async function authenticate() {
      const next = model.owner(await get('/api/me'));
      if (!live() || !next || (key && next !== key)) { end(); throw new Error('계정이 변경되어 배치를 적용하지 않았습니다.'); }
      key = next;
    }
    const ordered = state => [...state.viewports.values()].sort((a, b) => a.y - b.y || a.x - b.x);
    const signature = () => {
      const state = grid.getState();
      return JSON.stringify([state.layout, state.activeViewportId, ordered(state).map(v => [v.viewportId, v.x, v.y, v.width, v.height, v.displaySetInstanceUIDs])]);
    };
    function resolve(cell) {
      if (!cell) return null;
      const matches = ds.getActiveDisplaySets().filter(d => d.StudyInstanceUID === cell.study && d.SeriesInstanceUID === cell.series);
      // Split series and non-stack objects cannot be silently replaced with a default display set.
      if (matches.length !== 1 || matches[0].Modality !== 'CT' || !(matches[0].images?.length) ||
          !matches[0].images.every(i => i.SOPClassUID === '1.2.840.10008.5.1.4.1.1.2')) throw new Error('시리즈를 찾을 수 없거나 지원하지 않는 영상입니다. 현재 배치를 유지합니다.');
      return matches[0].displaySetInstanceUID;
    }
    function capture() {
      const state = grid.getState(), views = ordered(state), { numRows: rows, numCols: cols, layoutType } = state.layout;
      if (layoutType !== 'grid' || views.length !== rows * cols) throw new Error('1·2·4화면의 일반 CT 배치만 저장할 수 있습니다.');
      const cells = views.map((v, i) => {
        if (Math.abs(v.x - (i % cols) / cols) > 1e-6 || Math.abs(v.y - Math.floor(i / cols) / rows) > 1e-6 ||
            Math.abs(v.width - 1 / cols) > 1e-6 || Math.abs(v.height - 1 / rows) > 1e-6) throw new Error('병합 또는 특수 배치는 저장할 수 없습니다.');
        const ids = v.displaySetInstanceUIDs || [];
        if (!ids.length) return null;
        if (ids.length !== 1 || cs.getCornerstoneViewport(v.viewportId)?.type !== 'stack') throw new Error('일반 CT 스택만 저장할 수 있습니다.');
        const d = ds.getDisplaySetByUID(ids[0]), cell = { study: d?.StudyInstanceUID, series: d?.SeriesInstanceUID };
        if (!studies.includes(cell.study) || resolve(cell) !== ids[0] || !cs.getCornerstoneViewport(v.viewportId)?.getCurrentImageId?.()) throw new Error('영상 로딩이 끝난 뒤 다시 저장하세요.');
        return cell;
      });
      const value = model.normalize({ version: 1, studies, rows, cols, active: views.findIndex(v => v.viewportId === state.activeViewportId), cells });
      if (!value) throw new Error('1·2·4화면의 일반 CT 배치만 저장할 수 있습니다.');
      return value;
    }
    async function run(action) {
      if (busy || !live() || !key || !studies) return;
      busy = true; refresh(); status.textContent = '계정과 검사 접근 확인 중…'; const before = signature();
      try {
        await authenticate();
        const data = await get('/api/studies');
        const rows = studies.map(uid => data.studies?.find(s => s.uid === uid));
        if (rows.some(s => !s) || (rows.length > 1 && (!rows[0].sourcePatientKey || rows.some(s => s.sourcePatientKey !== rows[0].sourcePatientKey)))) throw new Error('현재 검사의 접근 권한과 같은 환자 여부를 확인할 수 없습니다.');
        // A delayed permission response must not overwrite a newer manual layout or selection.
        if (!live() || before !== signature()) throw new Error('화면 배치가 변경되어 작업을 적용하지 않았습니다. 다시 시도하세요.');
        if (action === 'save') { model.write(localStorage, key, capture()); status.textContent = '최근 배치를 이 브라우저에 저장했습니다.'; }
        else if (action === 'remove') { localStorage.removeItem(key); status.textContent = '이 계정의 최근 배치를 삭제했습니다. 현재 화면은 유지됩니다.'; }
        else {
          if (ordered(grid.getState()).some(v => v.displaySetInstanceUIDs?.length && cs.getCornerstoneViewport(v.viewportId)?.type !== 'stack')) throw new Error('일반 CT 화면에서 배치를 복원하세요. 현재 화면은 유지됩니다.');
          const value = model.read(localStorage, key);
          if (!value) throw new Error('이 계정에서 저장한 최근 배치가 없습니다.');
          if (JSON.stringify(value.studies) !== JSON.stringify(studies)) throw new Error('다른 검사의 배치입니다. 저장한 검사를 먼저 여세요.');
          const sets = value.cells.map(resolve), ids = value.cells.map(() => 'kin-layout-' + crypto.randomUUID());
          await grid.setLayout({ numRows: value.rows, numCols: value.cols, activeViewportId: ids[value.active], isHangingProtocolLayout: false,
            findOrCreateViewport: index => ({ displaySetInstanceUIDs: sets[index] ? [sets[index]] : [], displaySetOptions: [{}],
              viewportOptions: { viewportId: ids[index], viewportType: 'stack', toolGroupId: 'default', allowUnmatchedView: true } }) });
          if (live()) status.textContent = '저장한 시리즈 배치를 적용했습니다. 영상 로딩 상태를 확인하세요.';
        }
      } catch (error) {
        if (live()) status.textContent = error?.name === 'QuotaExceededError' || error?.name === 'SecurityError' ? '브라우저 저장소를 사용할 수 없습니다. 현재 화면은 유지됩니다.' : error instanceof SyntaxError ? '저장한 배치가 손상되었습니다. 현재 화면은 유지됩니다.' : error?.message || '배치 작업에 실패했습니다.';
      } finally { busy = false; refresh(); }
    }
    for (const [label, action] of [['Save Recent Layout', 'save'], ['Restore Recent Layout', 'restore'], ['Delete Recent Layout', 'remove']]) {
      const b = document.createElement('button'); b.textContent = label; b.type = 'button'; b.disabled = true;
      b.style.cssText = 'margin:3px;padding:4px 7px;border:1px solid #657c9f;border-radius:4px';
      b.onclick = () => run(action); controls.append(b); buttons.push(b);
    }
    const onStorage = e => { if (e.key === 'kin-session-ended') end(); };
    const onMessage = e => { if (e.data?.type === 'session-ended') end(); };
    window.addEventListener('storage', onStorage);
    try { channel = new BroadcastChannel('kin-session'); channel.addEventListener('message', onMessage); } catch (_) {}
    if (studies) authenticate().then(() => { if (live()) status.textContent = '현재 검사의 배치를 직접 저장하거나 복원하세요.'; }).catch(() => { if (live()) status.textContent = '계정 정보를 확인할 수 없습니다. 뷰어를 다시 여세요.'; }).finally(refresh);
    else status.textContent = '현재 검사 1~2개의 일반 CT 배치만 지원합니다.';
    stop = () => { end(); window.removeEventListener('storage', onStorage); channel?.close(); panel.remove(); };
  }
  return { id: 'kin.viewer-layout', preRegistration({ servicesManager }) { services = servicesManager.services; }, onModeEnter: mount, onModeExit() { stop?.(); stop = null; } };
}

// Position matching is display navigation, not image registration or a measurement result.
const kinCTSyncModel = (() => {
  const eps = 1e-3, dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
  const sub = (a, b) => a.map((x, i) => x - b[i]);
  const vector = v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
  function normal(p) {
    if (!p || !vector(p.imagePositionPatient) || !vector(p.rowCosines) || !vector(p.columnCosines) ||
        p.isDefaultValueSetForRowCosine || p.isDefaultValueSetForColumnCosine) return null;
    const r = p.rowCosines, c = p.columnCosines;
    if (Math.abs(dot(r, r) - 1) > 1e-6 || Math.abs(dot(c, c) - 1) > 1e-6 || Math.abs(dot(r, c)) > 1e-6) return null;
    return [r[1]*c[2]-r[2]*c[1], r[2]*c[0]-r[0]*c[2], r[0]*c[1]-r[1]*c[0]];
  }
  function match(source, target) {
    const deny = reason => ({ reason, index: -1 });
    if (!source?.patient || source.patient !== target?.patient) return deny('같은 환자를 확인할 수 없습니다');
    if (!source.classic || !target.classic) return deny('일반 CT 스택만 위치 동기할 수 있습니다');
    const a = source.planes?.[source.index], planes = target.planes;
    if (!a?.frameOfReferenceUID || !Array.isArray(planes) || planes.length < 2 || planes.length > 2000 ||
        planes.some(p => !p?.frameOfReferenceUID || p.frameOfReferenceUID !== a.frameOfReferenceUID)) return deny('좌표계가 다르거나 없습니다');
    const n = normal(a), t = normal(planes[0]);
    if (!n || !t || Math.abs(dot(n, t)) < 1 - 1e-6) return deny('영상 방향 또는 위치가 맞지 않습니다');
    const origin = planes[0].imagePositionPatient, values = [];
    for (const p of planes) {
      const pn = normal(p);
      if (!pn || Math.abs(dot(pn, t)) < 1 - 1e-6) return deny('영상 방향 또는 위치가 맞지 않습니다');
      const d = sub(p.imagePositionPatient, origin), z = dot(d, t);
      if (Math.sqrt(dot(d, d) - Math.min(dot(d, d), z*z)) > eps) return deny('기울어진 스택은 위치 동기하지 않습니다');
      values.push(z);
    }
    const sorted = [...values].sort((a, b) => a - b), gaps = sorted.slice(1).map((x, i) => x - sorted[i]);
    if (gaps.some(x => x < eps)) return deny('같은 위치의 영상이 중복되어 있습니다');
    const z = dot(sub(a.imagePositionPatient, origin), t);
    if (z < sorted[0] - eps || z > sorted.at(-1) + eps) return deny('대상 영상의 위치 범위를 벗어났습니다');
    // Preserve native nearest-position and stable first-index tie behavior, but refuse large gaps.
    let index = 0;
    for (let i = 1; i < values.length; i++) if (Math.abs(values[i]-z) < Math.abs(values[index]-z) - 1e-9) index = i;
    if (Math.abs(values[index]-z) > Math.min(...gaps) / 2 + eps) return deny('대상 영상 위치 사이에 큰 공백이 있습니다');
    return { index, reason: '' };
  }
  return { match };
})();

function kinCreateCTSync() {
  let services, stop;
  function mount() {
    stop?.();
    const core = window.cornerstone, groups = services.syncGroupService;
    const creators = ['imageSlice', 'stackimage'].map(type => [type, groups.getSyncCreatorForType(type)]);
    if (!core?.imageLoader || creators.some(([, fn]) => typeof fn !== 'function')) return;
    const notice = document.createElement('div'); notice.id = 'kin-ct-sync-status'; notice.setAttribute('role', 'status');
    notice.style.cssText = 'position:fixed;top:110px;left:50%;transform:translateX(-50%);z-index:42;max-width:70vw;padding:6px 10px;background:#101e32;color:#e1ecfc;border-radius:6px;font:13px sans-serif;pointer-events:none';
    notice.hidden = true; document.body.append(notice);
    const controller = new AbortController(), search = location.search, created = new Set();
    let ended = false, channel, owner, checking, rows = [];
    const say = text => { notice.textContent = text; notice.hidden = !text; };
    const live = () => !ended && location.search === search;
    const end = () => { ended = true; controller.abort(); created.forEach(s => s.setEnabled(false)); say('세션이 변경되어 위치 동기를 중지했습니다'); };
    async function get(path) {
      const request = new AbortController(), abort = () => request.abort();
      controller.signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, 10000);
      try {
        const r = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal: request.signal });
        if (!r.ok) throw Error('검사 접근 정보를 확인할 수 없습니다');
        return await r.json();
      } finally { clearTimeout(timer); controller.signal.removeEventListener('abort', abort); }
    }
    const session = () => checking ||= get('/api/me').finally(() => { checking = null; });
    const ownerOf = me => me?.kind === 'member' && me.institution && me.sub ? JSON.stringify([me.institution, me.sub]) : null;
    const ready = (async () => {
      owner = ownerOf(await get('/api/me'));
      rows = (await get('/api/studies')).studies || [];
      if (!owner || ownerOf(await get('/api/me')) !== owner) throw Error('계정이 변경되었습니다');
    })().then(() => true, () => { end(); return false; });
    function view(info) {
      const v = services.cornerstoneViewportService.getCornerstoneViewport(info.viewportId);
      const g = services.viewportGridService.getState().viewports.get(info.viewportId);
      if (!v || !g || v.getRenderingEngine().id !== info.renderingEngineId) return null;
      const ids = v.getImageIds?.() || [], sets = g.displaySetInstanceUIDs || [];
      const d = sets.length === 1 && services.displaySetService.getDisplaySetByUID(sets[0]);
      const patient = rows.find(r => r.uid === d?.StudyInstanceUID)?.sourcePatientKey;
      const classic = v.type === 'stack' && d?.Modality === 'CT' && d?.SOPClassUID === '1.2.840.10008.5.1.4.1.1.2' &&
        d.images?.length === ids.length && d.images.every(i => i.SOPClassUID === '1.2.840.10008.5.1.4.1.1.2') &&
        ids.length > 1 && ids.length <= 2000 && ids.every(id => id.includes('/studies/'+d.StudyInstanceUID+'/series/'+d.SeriesInstanceUID+'/'));
      return { v, ids, patient, classic, index: v.getCurrentImageIdIndex?.(),
        planes: classic ? ids.map(id => core.metaData.get('imagePlaneModule', id)) : [],
        signature: JSON.stringify([sets, ids, v.getCurrentImageId?.()]) };
    }
    const current = (info, before) => before && view(info)?.signature === before.signature;
    for (const [type, original] of creators) {
      groups.addSynchronizerType(type, (id, options) => {
        const sync = original(id, options), fire = sync.fireEvent;
        created.add(sync); let serial = 0;
        const destroy = sync.destroy;
        sync.destroy = function (...args) { ++serial; created.delete(sync); say('위치 동기 꺼짐'); return destroy.apply(this, args); };
        sync.fireEvent = async function (sourceInfo, event) {
          if (!live() || sync.isDisabled()) return;
          const ticket = ++serial, source = view(sourceInfo), targets = sync.getTargetViewports().filter(t => t.viewportId !== sourceInfo.viewportId);
          const snapshots = targets.map(view);
          if (!(await ready) || !live() || ticket !== serial || !current(sourceInfo, source)) return;
          try {
            const me = await session();
            if (ownerOf(me) !== owner) { end(); return; }
            if (!live() || sync.isDisabled() || ticket !== serial || !current(sourceInfo, source)) return;
            const matches = snapshots.map(t => kinCTSyncModel.match(source, t));
            await Promise.all(matches.map((m, i) => m.index < 0 ? null : core.imageLoader.loadAndCacheImage(snapshots[i].ids[m.index])));
            // Native movement now uses cached pixels. A late load cannot choose a replaced stack or an OFF group.
            if (!live() || sync.isDisabled() || ticket !== serial || !current(sourceInfo, source) || targets.some((t, i) => !current(t, snapshots[i]) || !sync.hasTargetViewport(t.renderingEngineId, t.viewportId))) return;
            matches.forEach((m, i) => {
              sync.setOptions(targets[i].viewportId, { ...sync.getOptions(targets[i].viewportId), disabled: m.index < 0, useInitialPosition: true });
              if (m.index >= 0) core.utilities.spatialRegistrationMetadataProvider.add([targets[i].viewportId, sourceInfo.viewportId], [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
            });
            const denied = matches.find(m => m.index < 0);
            say(denied ? '위치 동기 제한: '+denied.reason : '같은 좌표계의 CT 위치 동기');
            return fire.call(sync, sourceInfo, event);
          } catch (_) { if (live()) say('위치 동기를 적용하지 못했습니다. 영상과 연결 상태를 확인하세요'); }
        };
        return sync;
      });
    }
    const onStorage = e => { if (e.key === 'kin-session-ended') end(); };
    const onMessage = e => { if (e.data?.type === 'session-ended') end(); };
    window.addEventListener('storage', onStorage);
    try { channel = new BroadcastChannel('kin-session'); channel.addEventListener('message', onMessage); } catch (_) {}
    stop = () => { end(); creators.forEach(([type, fn]) => groups.addSynchronizerType(type, fn)); window.removeEventListener('storage', onStorage); channel?.close(); notice.remove(); };
  }
  return { id: 'kin.ct-sync', preRegistration({ servicesManager }) { services = servicesManager.services; }, onModeEnter: mount, onModeExit() { stop?.(); stop = null; } };
}

function kinCineWithinBudget(ids, pixels) {
  return ids.length >= 2 && ids.length <= 500 && pixels.length === ids.length &&
    pixels.every(p => Number.isInteger(p?.rows) && p.rows > 0 && Number.isInteger(p?.columns) && p.columns > 0) &&
    pixels.reduce((n, p) => n + p.rows * p.columns * 4, 0) <= 128 * 1024 * 1024;
}

function kinCreateCine() {
  let services, dispose;
  function mount() {
    dispose?.();
    const core = window.cornerstone, cine = services.cineService, grid = services.viewportGridService;
    const nativePlay = cine.playClip, nativeStop = cine.stopClip;
    const records = new Map(), subscriptions = [], listeners = [];
    let ended = false, channel, selected, owner, sequence = 0, halting = false, wasEnabled = false;
    const panel = document.createElement('div'); panel.id = 'kin-cine'; panel.hidden = true;
    panel.style.cssText = 'position:fixed;bottom:60px;left:50%;transform:translateX(-50%);z-index:42;max-width:65vw;display:flex;flex-wrap:wrap;gap:6px;padding:7px;background:#101e32;color:#e1ecfc;border-radius:6px;font:13px sans-serif';
    // The native controls remain the playback/FPS entry point; these apply to the selected stack only.
    const direction = document.createElement('select'); direction.setAttribute('aria-label', '재생 방향');
    for (const [value, text] of [['forward', '정방향'], ['reverse', '역방향']]) {
      const option = document.createElement('option'); option.value = value; option.textContent = text; direction.append(option);
    }
    const loop = document.createElement('input'); loop.type = 'checkbox'; loop.checked = true;
    const label = document.createElement('label'); label.append(loop, ' 반복');
    const status = document.createElement('span'); status.setAttribute('role', 'status');
    const first = document.createElement('button'); first.textContent = '첫 프레임';
    const last = document.createElement('button'); last.textContent = '끝 프레임';
    panel.append('선택 화면 ', direction, label, first, last, status); document.body.append(panel);
    for (const control of [direction, first, last]) control.style.cssText = 'background:#263c57;color:white;border:1px solid #6884a6;border-radius:3px;padding:2px 5px';
    const listen = (target, type, fn, capture = false) => { target.addEventListener(type, fn, capture); listeners.push(() => target.removeEventListener(type, fn, capture)); };
    const viewport = id => services.cornerstoneViewportService.getCornerstoneViewport(id);
    const signature = v => JSON.stringify([grid.getState().viewports.get(v.id)?.displaySetInstanceUIDs, v.getImageIds?.()]);
    function record(v) {
      let r = records.get(v.id);
      if (!r || r.element !== v.element) {
        r = { element: v.element, reverse: false, loop: true, ticket: 0, signature: signature(v) }; records.set(v.id, r);
        listen(v.element, core.Enums.Events.VIEWPORT_NEW_IMAGE_SET, () => { r.signature = signature(v); halt(v.id); r.reverse = false; r.loop = true; render(); });
        listen(v.element, 'CORNERSTONE_CINE_TOOL_STOPPED', () => halt(v.id));
      }
      return r;
    }
    function halt(id) {
      const r = records.get(id); if (r) { r.ticket = ++sequence; r.loading = false; r.authorized = false; nativeStop.call(cine, r.element, { viewportId: id }); }
      if (cine.getState().cines?.[id]?.isPlaying) cine.setCine({ id, isPlaying: false });
    }
    function haltAll() { if (halting) return; halting = true; try { records.forEach((_, id) => halt(id)); } finally { halting = false; } }
    function render() {
      if (ended) return;
      const id = grid.getActiveViewportId(), v = viewport(id), stack = v?.type === 'stack';
      panel.hidden = !cine.getState().isCineEnabled || !stack;
      panel.style.display = panel.hidden ? 'none' : 'flex';
      if (!stack) return;
      const r = record(v);
      if (r.signature !== signature(v)) { r.signature = signature(v); halt(id); r.reverse = false; r.loop = true; }
      direction.value = r.reverse ? 'reverse' : 'forward'; loop.checked = r.loop;
      first.disabled = last.disabled = r.loading || !v.getImageIds?.().length;
      status.textContent = r.message || (r.loading ? '프레임 준비 중' : '');
    }
    async function session() {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch('/api/me', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw Error('로그인 상태를 확인할 수 없습니다');
        const me = await response.json();
        const key = me?.kind === 'member' && me.institution && me.sub ? JSON.stringify([me.institution, me.sub]) : null;
        if (!key || (owner && key !== owner)) throw Error('계정이 변경되었습니다');
        owner = key;
      } finally { clearTimeout(timer); }
    }
    cine.stopClip = function (element, options) {
      const v = core.getEnabledElement(element)?.viewport, r = v && records.get(v.id);
      if (r) { r.ticket = ++sequence; r.loading = false; }
      return nativeStop.call(this, element, options);
    };
    cine.playClip = async function (element, options = {}) {
      const v = core.getEnabledElement(element)?.viewport;
      if (ended || document.hidden || !v) return;
      if (v.type !== 'stack') return nativePlay.call(this, element, options);
      const r = record(v), id = v.id, ticket = r.ticket = ++sequence, before = signature(v);
      const current = () => !ended && !document.hidden && r.authorized && r.ticket === ticket && viewport(id) === v && signature(v) === before && grid.getActiveViewportId() === id && cine.getState().isCineEnabled;
      if (!r.authorized || grid.getActiveViewportId() !== id) { halt(id); return; }
      records.forEach((_, other) => { if (other !== id) halt(other); });
      r.loading = true; r.message = ''; render();
      try {
        const ids = v.getImageIds(), pixels = ids.map(imageId => core.metaData.get('imagePixelModule', imageId));
        if (!kinCineWithinBudget(ids, pixels)) throw Error('재생 준비 범위는 2~500 프레임·128 MiB 이내입니다');
        await session(); if (!current()) return;
        // Finish a bounded, four-worker preparation before the native timer starts, so stop/replace cannot be undone by a late frame load.
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
          while (current() && next < ids.length) { const imageId = ids[next++]; await core.imageLoader.loadAndCacheImage(imageId); }
        }));
        if (!current()) return;
        r.loading = false;
        nativePlay.call(this, element, { ...options, framesPerSecond: Math.abs(options.framesPerSecond || 10) * (r.reverse ? -1 : 1), loop: r.loop });
        // This pinned native API retains loop from its first play; update its public cine state on every explicit start.
        window.cornerstoneTools.utilities.cine.getToolState(element).loop = r.loop;
        render();
      } catch (_) {
        if (current()) { r.message = '재생을 준비할 수 없습니다. 로그인·영상과 500 프레임/128 MiB 제한을 확인하세요.'; halt(id); render(); }
      }
    };
    const change = () => {
      const v = viewport(grid.getActiveViewportId()); if (v?.type !== 'stack') return;
      const r = record(v); r.reverse = direction.value === 'reverse'; r.loop = loop.checked; halt(v.id); r.message = '설정을 바꿨습니다. 재생을 눌러 시작하세요.'; render();
    };
    listen(direction, 'change', change); listen(loop, 'change', change);
    listen(document, 'click', e => {
      if (!e.target.closest?.('[data-cy="cine-player-play-pause"]')) return;
      const v = viewport(grid.getActiveViewportId());
      if (v?.type === 'stack') record(v).authorized = !cine.getState().cines?.[v.id]?.isPlaying;
    }, true);
    async function jump(end) {
      const v = viewport(grid.getActiveViewportId()); if (v?.type !== 'stack') return;
      halt(v.id); const r = record(v), ticket = r.ticket = ++sequence, before = signature(v);
      const index = end ? v.getImageIds().length - 1 : 0, imageId = v.getImageIds()[index];
      r.loading = true; r.message = ''; render();
      try {
        await core.imageLoader.loadAndCacheImage(imageId);
        if (ended || r.ticket !== ticket || viewport(v.id) !== v || signature(v) !== before) return;
        await core.utilities.jumpToSlice(v.element, { imageIndex: index });
      } catch (_) { if (!ended && r.ticket === ticket) r.message = '프레임을 불러올 수 없습니다'; }
      finally { if (!ended && r.ticket === ticket) { r.loading = false; render(); } }
    }
    listen(first, 'click', () => jump(false)); listen(last, 'click', () => jump(true));
    for (const event of [grid.EVENTS.ACTIVE_VIEWPORT_ID_CHANGED, grid.EVENTS.GRID_STATE_CHANGED]) subscriptions.push(grid.subscribe(event, () => {
      const id = grid.getActiveViewportId(); if (selected !== id) { haltAll(); selected = id; }
      records.forEach((r, key) => { const v = viewport(key); if (!v || r.signature !== signature(v)) halt(key); }); render();
    }));
    subscriptions.push(cine.subscribe(cine.EVENTS.CINE_STATE_CHANGED, () => {
      const enabled = cine.getState().isCineEnabled, closing = wasEnabled && !enabled; wasEnabled = enabled;
      if (closing) haltAll(); if (!halting) render();
    }));
    const end = () => { haltAll(); ended = true; panel.style.display = 'none'; };
    listen(document, 'visibilitychange', () => { if (document.hidden) haltAll(); });
    listen(window, 'pagehide', end);
    listen(window, 'storage', e => { if (e.key === 'kin-session-ended') end(); });
    try { channel = new BroadcastChannel('kin-session'); listen(channel, 'message', e => { if (e.data?.type === 'session-ended') end(); }); } catch (_) {}
    const timer = setInterval(render, 250); selected = grid.getActiveViewportId(); render();
    dispose = () => { end(); clearInterval(timer); listeners.forEach(off => off()); subscriptions.forEach(s => s.unsubscribe()); channel?.close(); cine.playClip = nativePlay; cine.stopClip = nativeStop; panel.remove(); };
  }
  return { id: 'kin.cine', preRegistration({ servicesManager }) { services = servicesManager.services; }, onModeEnter: mount, onModeExit() { dispose?.(); dispose = null; } };
}

function kinApplyCTPreset(services, commands, presetIndex) {
  const id = services.viewportGridService.getActiveViewportId();
  const grid = services.viewportGridService.getState().viewports.get(id);
  const viewport = services.cornerstoneViewportService.getCornerstoneViewport(id);
  const ids = grid?.displaySetInstanceUIDs || [];
  const displaySet = ids.length === 1 && services.displaySetService.getDisplaySetByUID(ids[0]);
  const preset = Number.isInteger(presetIndex) && presetIndex >= 0 && presetIndex < 5 &&
    services.customizationService.get('cornerstone.windowLevelPresets')?.presets?.CT?.[presetIndex];
  const validNumber = value => (typeof value === 'number' || typeof value === 'string' && value.trim() !== '') && Number.isFinite(Number(value));
  if (viewport?.type !== 'stack' || displaySet?.Modality !== 'CT' || displaySet?.SOPClassUID !== '1.2.840.10008.5.1.4.1.1.2' ||
      !preset || !validNumber(preset.window) || Number(preset.window) <= 0 || !validNumber(preset.level)) {
    services.uiNotificationService.show({ title: 'CT 표시 프리셋', message: '일반 CT 영상을 선택하고 프리셋 설정을 확인하세요.', type: 'info' });
    return false;
  }
  commands.runCommand('setViewportWindowLevel', { viewportId: id, window: Number(preset.window), level: Number(preset.level) }, 'CORNERSTONE');
  return true;
}

function kinCreateCTPresets() {
  let restore;
  return {
    id: 'kin.ct-presets',
    onModeEnter({ servicesManager, commandsManager }) {
      restore?.();
      const native = commandsManager.getCommand('setWindowLevel', 'CORNERSTONE');
      if (!native?.commandFn) return;
      // Mode hotkeys supply these five named CT presets; the viewport menu uses a separate native command.
      const names = ['Soft tissue', 'Lung', 'Liver', 'Bone', 'Brain'];
      const guarded = { ...native, commandFn(props) {
        const index = names.indexOf(props.description);
        return index < 0 ? native.commandFn(props) : kinApplyCTPreset(servicesManager.services, commandsManager, index);
      } };
      commandsManager.registerCommand('CORNERSTONE', 'setWindowLevel', guarded);
      restore = () => {
        if (commandsManager.getCommand('setWindowLevel', 'CORNERSTONE') === guarded) commandsManager.registerCommand('CORNERSTONE', 'setWindowLevel', native);
      };
    },
    onModeExit() { restore?.(); restore = null; },
  };
}

function kinCreateViewerJobs() {
  let ready, current, epoch = 0;
  return { id: 'kin.viewer-jobs', preRegistration({ servicesManager }) {
    const load = name => new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = '/worklist/hpacs-lite/' + name;
      script.onload = resolve;
      script.onerror = () => reject(new Error('비교 작업 화면을 불러오지 못했습니다.')); document.head.append(script);
    });
    ready = load('viewer-jobs.js')
      .then(() => window.kinViewerJobs(servicesManager.services, kinViewerLayoutModel));
    ready.catch(() => {});
  }, onModeEnter() {
    const ticket = ++epoch;
    ready.then(extension => { if (ticket === epoch) { current = extension; current.mount(); } }).catch(e => {
      if (ticket === epoch) { const p = document.querySelector('#kin-viewer-layout-status'); if (p) p.textContent = e.message; }
    });
  }, onModeExit() { epoch++; current?.stop(); current = null; } };
}

function kinCreateViewerTechNote() {
  let ready, current, prepare, epoch=0, active=false, state='stopped';
  function connect() {
    if(!active||state==='loading'||state==='ready')return;
    const ticket=epoch;state='loading';
    prepare().then(extension=>{
      if(!active||ticket!==epoch)return;
      current=extension;
      if(current.mount()!==true)throw new Error('Tech 메모 연결 대상을 확인하지 못했습니다.');
      state='ready';
    }).catch(e=>{
      if(!active||ticket!==epoch)return;
      state='failed';
      if(window.top===window){const p=document.querySelector('#kin-viewer-layout-status');if(p)p.textContent='Tech 메모 화면을 연결하지 못했습니다. 영상 작업을 저장한 뒤 뷰어를 다시 여세요.';}
    });
  }
  return {id:'kin.viewer-tech-note',preRegistration({servicesManager}) {
    const load=name=>new Promise((resolve,reject)=>{
      const script=document.createElement('script');script.src='/worklist/hpacs-lite/'+name;
      const fail=()=>{clearTimeout(timer);script.onload=script.onerror=null;script.remove();reject(new Error('Tech 메모 화면을 불러오지 못했습니다. 메모 연결을 다시 시도하세요.'));};
      const timer=setTimeout(fail,20000);
      script.onload=()=>{clearTimeout(timer);resolve();};script.onerror=fail;document.head.append(script);
    });
    const standalone=window.top===window;
    if(standalone){const css=document.createElement('link');css.rel='stylesheet';css.href='/worklist/hpacs-lite/tech-note.css';document.head.append(css);}
    prepare=()=>ready||(ready=(standalone&&typeof window.KinTechNote!=='function'?load('tech-note.js'):Promise.resolve())
      .then(()=>standalone&&typeof window.KinViewerWorkspaceDock!=='function'?load('viewer-workspace-dock.js'):undefined)
      .then(()=>standalone&&!window.KinWorkspaceShortcuts?load('workspace-shortcuts.js'):undefined)
      .then(()=>window.KinViewerIdentity?undefined:load('viewer-identity.js'))
      .then(()=>typeof window.kinViewerTechNote==='function'?undefined:load('viewer-tech-note.js'))
      .then(()=>window.kinViewerTechNote(servicesManager.services)).catch(e=>{ready=null;throw e;}));
    window.kinViewerNoteConnectionState=()=>state;
    window.kinViewerNoteReconnect=()=>{if(active&&state==='failed')connect();};
  },onModeEnter(){if(!prepare)return;epoch++;active=true;state='stopped';connect();
  },onModeExit(){epoch++;active=false;state='stopped';current?.stop();current=null;}};
}

window.config = {
  extensions: [kinStackPrecision, kinCreateSRProvenance(), kinCreateViewerHistory(), kinCreateViewerLayout(), kinCreateViewerJobs(), kinCreateViewerTechNote(), kinCreateCTSync(), kinCreateCine(), kinCreateCTPresets()],
  modes: [],
  customizationService: {},
  showStudyList: true,
  autoPlayCine: false,

  // [KIN 추가] 업스트림 소스를 건드리지 않고 헤더·검사 탭 수명주기를 교체한다.
  whiteLabeling: {
    createLogoComponentFn: React => React.createElement(KinViewerBrand, { React }),
  },

  // [KIN 추가] "investigational use only" 배너를 표시하지 않음
  investigationalUseDialog: { option: 'never' },

  // some windows systems have issues with more than 3 web workers
  maxNumberOfWebWorkers: 3,
  // below flag is for performance reasons, but it might not work for all servers
  omitQuotationForMultipartRequest: true,
  showWarningMessageForCrossOrigin: true,
  showCPUFallbackMessage: true,
  showLoadingIndicator: true,
  strictZSpacingForVolumeViewport: true,
  maxNumRequests: {
    interaction: 100,
    thumbnail: 75,
    prefetch: 25,
  },
  httpErrorHandler: error => {
    if (error.status) {
      console.warn(error.status);
    } else {
      console.warn(error);
    }
  },
};
