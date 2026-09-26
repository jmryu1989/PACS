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

// Study/series/SOP/frame identity of a stack image id; frame is 1-based like the saved items.
function kinViewerImageReference(imageId) {
  const m = typeof imageId === 'string' && imageId.match(/\/studies\/([0-9.]+)\/series\/([0-9.]+)\/instances\/([0-9.]+)\/frames\/([1-9][0-9]*)(?:$|[?#])/);
  return m ? { study: m[1], seriesUid: m[2], sopUid: m[3], frame: Number(m[4]) } : null;
}
// Exact-frame navigation shared by the Saved Items "Go to Image" button and the Findings section.
// `env` exposes the live closure state of kinCreateViewerHistory through getters, so every decision
// after an await is re-taken against the current session and never against a copy. The result is
// { ok: true, highlighted, annotation } or { ok: false, reason }; it never throws, never changes the
// URL study set and never reslices a volume viewport (3D cursor stays off).
const KIN_NAVIGATION_REASONS = ['invalid', 'ended', 'scope', 'busy', 'series-missing', 'viewport-unsupported', 'frame-missing', 'superseded', 'tool-missing'];
async function kinViewerNavigateTo(env, target) {
  const refusal = reason => ({ ok: false, reason });
  const uid = s => typeof s === 'string' && s.length <= 64 && /^[0-9]+(?:\.[0-9]+)+$/.test(s);
  if (!target || typeof target !== 'object' || !uid(target.studyUid) || !uid(target.seriesUid) || !uid(target.sopUid) ||
      !Number.isSafeInteger(target.frame) || target.frame < 1) return refusal('invalid');
  if (env.ended()) return refusal('ended');
  const scope = env.scope();
  if (!scope || target.studyUid !== scope) return refusal('scope');
  if (env.busy()) return refusal('busy');
  const ticket = env.generation(), nav = env.beginNavigation();
  const live = () => !env.ended() && env.valid(ticket) && nav === env.navigation() && env.scope() === scope;
  const identity = { seriesUid: target.seriesUid, sopUid: target.sopUid, frame: target.frame };
  let sets;
  try {
    sets = env.services.displaySetService.getActiveDisplaySets().filter(d => d.StudyInstanceUID === scope && d.SeriesInstanceUID === target.seriesUid && (d.images || d.instances || []).some(i => i.SOPInstanceUID === target.sopUid));
  } catch (_) { return refusal('tool-missing'); }
  if (sets.length !== 1) return refusal('series-missing');
  const viewportId = env.services.viewportGridService.getActiveViewportId();
  const stack = v => v && v.type === 'stack' && typeof v.getImageIds === 'function' && typeof v.setImageIdIndex === 'function';
  const first = env.viewport();
  // A volume/MPR viewport has no stack image list to index: refuse instead of reslicing or retargeting.
  if (first && !stack(first)) return refusal('viewport-unsupported');
  if (!(first ? first.getImageIds() : []).some(id => env.matches(env.reference(id), identity))) {
    if (!live()) return refusal('superseded');
    env.services.viewportGridService.setDisplaySetsForViewport({ viewportId, displaySetInstanceUIDs: [sets[0].displaySetInstanceUID] });
  }
  for (let n = 0; n < 100; n++) {
    if (!live()) return refusal('superseded');
    const v = env.services.cornerstoneViewportService.getCornerstoneViewport(viewportId);
    if (v && !stack(v)) return refusal('viewport-unsupported');
    const index = (v ? v.getImageIds() : []).findIndex(id => env.matches(env.reference(id), identity));
    if (index >= 0) {
      try { await v.setImageIdIndex(index); } catch (_) { return live() ? refusal('frame-missing') : refusal('superseded'); }
      if (!live() || env.services.viewportGridService.getActiveViewportId() !== viewportId) return refusal('superseded');
      // The frame actually shown after the await is the only proof; a user scroll or a
      // display-set change during the load must not be reported as arrival.
      if (!env.matches(env.reference(v.getCurrentImageId?.()), identity)) return refusal('frame-missing');
      try { v.render(); } catch (_) {}
      env.hydrate();
      return { ok: true, ...env.highlight(target.itemId) };
    }
    await env.delay();
  }
  return live() ? refusal('frame-missing') : refusal('superseded');
}
// Go to Image for the other study of this viewer (S2-B2): exactly one viewport may show that study and
// only that viewport becomes active; the history scan then loads the study. No display set, layout,
// camera or URL changes, and a refused request changes nothing. The caller waits for the history and
// navigates only afterwards; `changed` tells it whether the active viewport really moved.
const KIN_ACTIVATION_REASONS = ['invalid', 'ended', 'viewport-missing', 'viewport-ambiguous', 'viewport-unsupported', 'tool-missing'];
function kinViewerActivateStudy(env, study) {
  const refusal = reason => ({ ok: false, reason });
  if (typeof study !== 'string' || study.length > 64 || !/^[0-9]+(?:\.[0-9]+)+$/.test(study)) return refusal('invalid');
  if (env.ended()) return refusal('ended');
  try {
    const grid = env.services.viewportGridService, sets = env.services.displaySetService;
    const shown = [...grid.getState().viewports].filter(([, view]) =>
      (view?.displaySetInstanceUIDs || []).some(id => sets.getDisplaySetByUID(id)?.StudyInstanceUID === study)).map(([id]) => id);
    if (shown.length > 1) return refusal('viewport-ambiguous');
    const v = shown.length ? env.services.cornerstoneViewportService.getCornerstoneViewport(shown[0]) : null;
    if (!v) return refusal('viewport-missing');
    if (v.type !== 'stack' || typeof v.getImageIds !== 'function') return refusal('viewport-unsupported');
    if (grid.getActiveViewportId() === shown[0]) return { ok: true, viewportId: shown[0], changed: false };
    // From here the grid may have moved even if the service throws.
    try { grid.setActiveViewportId(shown[0]); } catch (_) { return { ok: false, reason: 'tool-missing', changed: true }; }
    return { ok: true, viewportId: shown[0], changed: true };
  } catch (_) { return refusal('tool-missing'); }
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
    let scope = '', subject = '', me, generation = 0, readSequence = 0, shown = null, shownStatus = '', unmatched = false;
    let controller = new AbortController(), ended = false, checking = false, ownAnswer = false;
    let lastAuth = 0, tried = 0, loading = false, navigation = 0, suspended = true;
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
    // S5-U2b: /me가 업무 역할 clinician뿐이라고 답한 세션은 이 패널에서 저장된 항목을 보기만 한다. 만들기·저장·SR·이력
    // 컨트롤을 두지 않는 것은 화면일 뿐 권한이 아니다 — 쓰기는 서버(S5-U1a/U1b)가 거절한다. /me를 읽기 전에는 어느 쪽 컨트롤도 없다.
    // 판정은 문서 공통(kinViewerSession)이다: 어느 확장의 /me가 답했든, 모드를 다시 들어와도 쓰기 쪽으로 돌아가지 않는다.
    const readOnly = () => kinViewerSession.readOnly();
    // Astra S5-U2b-R-002 F01: authoring (native tools, mark edits, SR, this panel's own save paths) is open only while a successful
    // /me answered writer. No answer yet, an error or a 401/403 leaves image viewing only, the same as a clinician-only document.
    const writer = () => kinViewerSession.writer();
    const READ_ONLY = {
      note: '읽기 전용 · 확정 판독문에 저장된 측정·키 이미지만 표시합니다. 이 화면에서는 측정·키 이미지를 만들거나 저장하지 않으며 서버도 쓰기를 거절합니다.',
      withheld: '확정 판독문이 아니어서 저장된 측정·키 이미지를 표시하지 않습니다 · 읽기 전용',
      tool: '읽기 전용 화면입니다. 측정을 만들지 않습니다.',
      edit: '읽기 전용 화면입니다. 측정·표식을 편집하지 않습니다.',
      sr: '읽기 전용 화면에서는 SR을 만들거나 저장하지 않습니다.',
      denied: '이 검사의 저장 항목을 읽을 수 없습니다(HTTP 403). 서버가 거절했습니다.',
      unmatched: '현재 화면에서 원본 프레임을 확인할 수 없어 이 목록을 표시 영상과 맞추지 않았습니다. 마지막으로 확인한 검사 기준이며 확정 여부는 계속 다시 확인합니다.',
    };
    const UNCONFIRMED = {
      tool: '계정이 확인되기 전에는 영상 조작만 할 수 있습니다. 측정·표식을 만들지 않습니다.',
      edit: '계정이 확인되기 전에는 측정·표식을 편집하지 않습니다.',
      sr: '계정이 확인되기 전에는 SR을 만들거나 저장하지 않습니다.',
    };
    // After a 401/403 or a logout the panel has ended: that, not the account wording, is what the user needs to hear.
    const closedText = kind => ended ? '로그인이 종료되었습니다. 다시 로그인한 뒤 뷰어를 여세요.' : (readOnly() ? READ_ONLY : UNCONFIRMED)[kind];
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
        if (!writer()) {
          const message = closedText('sr');
          status.textContent = message;
          services.uiNotificationService.show({ title: 'SR', message, type: 'warning' });
          throw new Error(message);
        }
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
    // S5-U2b-R-001 F01 · R-002 F01. writer로 확인되지 않은 문서(답 없음·오류·401/403·clinician-only)에서는 뷰어 자체의 작성
    // 경로를 닫는다. 주 마우스 도구로 켤 수 있는 것은 영상 조작(W/L·이동·확대·넘기기·3D 회전·MPR 교차선·돋보기)뿐이고, 나머지
    // 도구는 이미 그려진 표식을 보여 주기만 하도록(Enabled) 둔다. 도구막대·단축키·명령·다른 확장의 전환은 모두 도구 그룹의
    // setToolActive/setToolPassive로 끝나므로 그 둘을 그룹마다 지키고, 모드 없이 도구에 바로 닿는 addNewAnnotation은 도구가
    // 스스로 거절한다. 그룹은 모드가 이 확장보다 나중에 만들고 /me 답은 그보다 늦을 수 있어, 만들어질 때 감싸 두고 매 관찰마다
    // 다시 맞춘다. 막는 동안 모드가 정한 모드는 적어 두었다가 writer 답이 오면 되돌린다(도구막대도 같다). 화면 정책일 뿐 서버
    // 권한을 대신하지 않는다.
    const VIEW_TOOLS = new Set(['WindowLevel', 'Pan', 'Zoom', 'StackScroll', 'TrackballRotate', 'Crosshairs', 'Magnify']);
    // The pinned longitudinal mode's measurement and annotation tools (its toolbar and initToolGroups). In a document that is not a
    // confirmed writer, a mark of one of these that this panel did not draw from a saved head is removed; SR display ('kin-sr:'),
    // reference lines and crosshairs keep their own state.
    const NATIVE_MARKS = new Set(['ArrowAnnotate', 'Length', 'Angle', 'Bidirectional', 'RectangleROI', 'EllipticalROI', 'CircleROI', 'Probe',
      'DragProbe', 'CobbAngle', 'CalibrationLine', 'PlanarFreehandROI', 'SplineROI', 'LivewireContour', 'UltrasoundDirectionalTool',
      'WindowLevelRegion', 'PlanarFreehandContourSegmentation', 'AdvancedMagnify']);
    const PRIMARY = ct.Enums?.MouseBindings?.Primary ?? 1;
    const nativeAuthoringClosed = () => !writer();
    const guardedGroups = new Map(), guardedTools = new Map(), policyRestores = [];
    function guardTool(name, tool) {
      if (!tool || VIEW_TOOLS.has(name) || typeof tool.addNewAnnotation !== 'function' || guardedTools.has(tool)) return;
      const add = tool.addNewAnnotation, own = Object.hasOwn(tool, 'addNewAnnotation');
      const guarded = function (...args) {
        if (nativeAuthoringClosed()) { status.textContent = closedText('tool'); return; }
        return add.apply(this, args);
      };
      tool.addNewAnnotation = guarded;
      guardedTools.set(tool, () => { if (tool.addNewAnnotation === guarded) { if (own) tool.addNewAnnotation = add; else delete tool.addNewAnnotation; } });
    }
    function guardGroup(group) {
      if (!group || ['setToolActive', 'setToolPassive', 'setToolEnabled'].some(name => typeof group[name] !== 'function')) return null;
      if (guardedGroups.has(group)) return guardedGroups.get(group);
      const active = group.setToolActive, passive = group.setToolPassive, addTool = group.addTool;
      // What the mode or the viewer asked for a tool this policy kept Enabled; the writer answer gives it back.
      const intended = new Map();
      let viewing = 'WindowLevel';
      // 네이티브 전환은 새 도구를 켜기 전에 이전 주 도구를 먼저 내려 두므로, 거절한 뒤에는 마지막 영상 조작 도구를 다시 켠다.
      const keepViewing = () => {
        if (!group.getActivePrimaryMouseButtonTool?.() && group.hasTool?.(viewing)) active.call(group, viewing, { bindings: [{ mouseButton: PRIMARY }] });
      };
      const onActive = function (name, options, ...rest) {
        if (!nativeAuthoringClosed() || VIEW_TOOLS.has(name)) {
          if (VIEW_TOOLS.has(name) && options?.bindings?.some(b => b?.mouseButton === PRIMARY && !b.modifierKey)) viewing = name;
          return active.call(group, name, options, ...rest);
        }
        intended.set(name, { mode: 'Active', bindings: [...(options?.bindings || [])] });
        status.textContent = closedText('tool'); keepViewing();
      };
      const onPassive = function (name, ...rest) {
        if (!nativeAuthoringClosed() || VIEW_TOOLS.has(name)) return passive.call(group, name, ...rest);
        intended.set(name, { mode: 'Passive', bindings: [] }); return group.setToolEnabled(name);
      };
      const onAddTool = typeof addTool === 'function' && function (name, ...rest) {
        const result = addTool.call(this, name, ...rest);
        guardTool(name, group.getToolInstance?.(name)); return result;
      };
      group.setToolActive = onActive; group.setToolPassive = onPassive;
      if (onAddTool) group.addTool = onAddTool;
      for (const name of Object.keys(group.toolOptions || {})) guardTool(name, group.getToolInstance?.(name));
      const record = { keepViewing, intended,
        reopen() {
          for (const [name, want] of intended) {
            if (group.toolOptions?.[name]?.mode !== 'Enabled') continue;
            // A refused primary activation is not replayed: the viewing tool keeps the primary button and the user picks the tool again.
            const bindings = want.bindings.filter(b => b?.mouseButton !== PRIMARY || b.modifierKey);
            if (want.mode === 'Active' && bindings.length) active.call(group, name, { bindings }); else passive.call(group, name);
          }
          intended.clear();
        },
        restore() {
          if (group.setToolActive === onActive) group.setToolActive = active;
          if (group.setToolPassive === onPassive) group.setToolPassive = passive;
          if (onAddTool && group.addTool === onAddTool) group.addTool = addTool;
        } };
      guardedGroups.set(group, record); return record;
    }
    function enforceTools() {
      const manager = ct.ToolGroupManager, groups = new Set(typeof manager?.getAllToolGroups === 'function' ? manager.getAllToolGroups() : []);
      const v = viewport(), own = v && manager?.getToolGroupForViewport?.(v.id, v.renderingEngineId);
      if (own) groups.add(own);
      for (const group of groups) {
        const record = guardGroup(group); if (!record) continue;
        let demoted = false;
        for (const [name, options] of Object.entries(group.toolOptions || {})) {
          // A tool added around group.addTool (an extension's addToolInstance) gets the instance guard here.
          guardTool(name, group.getToolInstance?.(name));
          if (!VIEW_TOOLS.has(name) && (options?.mode === 'Active' || options?.mode === 'Passive')) {
            record.intended.set(name, { mode: options.mode, bindings: [...(options.bindings || [])] });
            group.setToolEnabled(name); demoted = true;
          }
        }
        if (demoted) record.keepViewing();
      }
    }
    // 도구막대: 작성 도구를 켜는 버튼·묶음 항목을 없앤다(비활성 버튼으로 남기지 않는다). 버튼 정의와 평가·명령 연결은 뷰어의 것을
    // 그대로 쓰고, 모드가 버튼을 다시 넣을 때마다(모드 재진입 포함) 같은 규칙으로 다시 줄인다. 줄이기 전의 버튼·구역은 적어 두었다가
    // writer 답이 오면 그대로 되돌린다.
    const ACTIVATING = ['setToolActiveToolbar', 'setToolActive', 'toggleActiveDisabledToolbar'];
    const authoring = button => [button?.commands].flat().some(command => {
      const name = typeof command === 'string' ? command : command?.commandName;
      return ACTIVATING.includes(name) && !VIEW_TOOLS.has(command?.commandOptions?.toolName ?? button.id);
    });
    const TOOLBAR = ['getButtons', 'removeButton', 'addButtons', 'clearButtonSection', 'createButtonSection'];
    const trimmed = new Set(), originals = new Map(), sectionOriginals = new Map(), replacements = new WeakSet(); let trimming = false;
    function enforceToolbar() {
      const bar = services.toolbarService;
      if (trimming || TOOLBAR.some(name => typeof bar?.[name] !== 'function')) return;
      const replaced = [];
      for (const [id, button] of Object.entries(bar.getButtons() || {})) {
        if (replacements.has(button)) continue;
        const props = button?.props || {}, items = Array.isArray(props.items) ? props.items : null;
        if (!items) { if (authoring({ id, commands: props.commands })) { trimmed.add(id); originals.set(id, button); } continue; }
        const kept = items.filter(item => !authoring(item));
        if (!kept.length) { trimmed.add(id); originals.set(id, button); continue; }
        if (kept.length < items.length || props.primary && authoring(props.primary)) {
          const replacement = { ...button, props: { ...props, items: kept, primary: props.primary && !authoring(props.primary) ? props.primary : kept[0] } };
          originals.set(id, button); replacements.add(replacement); replaced.push(replacement);
        }
      }
      const buttons = bar.getButtons() || {}, gone = [...trimmed].filter(id => buttons[id]);
      const sections = Object.entries(bar.state?.buttonSections || {}).filter(([, ids]) => Array.isArray(ids) && ids.some(id => trimmed.has(id)));
      if (!gone.length && !replaced.length && !sections.length) return;
      trimming = true;
      try {
        for (const id of [...gone, ...replaced.map(button => button.id)]) bar.removeButton(id);
        if (replaced.length) bar.addButtons(replaced);
        for (const [key, ids] of sections) {
          const applied = ids.filter(id => !trimmed.has(id));
          sectionOriginals.set(key, { original: [...ids], applied });
          bar.clearButtonSection(key); bar.createButtonSection(key, [...applied]);
        }
        bar.refreshToolbarState?.({ viewportId: services.viewportGridService.getActiveViewportId?.() });
      } finally { trimming = false; }
    }
    function reopenToolbar() {
      const bar = services.toolbarService;
      if (trimming || TOOLBAR.some(name => typeof bar?.[name] !== 'function') || !originals.size && !sectionOriginals.size) return;
      trimming = true;
      try {
        // Only what still stands as this policy left it goes back; a section or button the mode has built again since is its own.
        const current = bar.state?.buttonSections || {}, same = (a, b) => Array.isArray(a) && a.length === b.length && a.every((id, i) => id === b[i]);
        const sections = [...sectionOriginals].filter(([key, record]) => same(current[key], record.applied));
        const listed = new Set(sections.flatMap(([, record]) => record.original));
        const buttons = bar.getButtons() || {}, back = [];
        for (const [id, original] of originals) {
          if (buttons[id] ? !replacements.has(buttons[id]) : !listed.has(id)) continue;
          if (buttons[id]) bar.removeButton(id);
          back.push(original);
        }
        if (back.length) bar.addButtons(back);
        for (const [key, record] of sections) { bar.clearButtonSection(key); bar.createButtonSection(key, [...record.original]); }
        bar.refreshToolbarState?.({ viewportId: services.viewportGridService.getActiveViewportId?.() });
      } finally { trimming = false; trimmed.clear(); originals.clear(); sectionOriginals.clear(); }
    }
    // 이 패널이 저장된 판에서 그리지 않은 작성 도구 표식(작성 경로를 모두 돌아 생긴 것 포함)은 writer가 아닌 문서에 남기지 않는다.
    function dropLocalMarks() {
      let dropped = false;
      for (const a of ct.annotation.state.getAllAnnotations()) {
        if (!NATIVE_MARKS.has(a?.metadata?.toolName) || annotations.has(a.annotationUID) || String(a.annotationUID).startsWith('kin-sr:')) continue;
        ct.annotation.state.removeAnnotation(a.annotationUID);
        if (measurementService.getMeasurement(a.annotationUID)) measurementService.remove(a.annotationUID);
        dropped = true;
      }
      if (dropped) render();
    }
    function closeAuthoring() { if (nativeAuthoringClosed()) { enforceTools(); enforceToolbar(); dropLocalMarks(); } }
    function reopenAuthoring() {
      if (nativeAuthoringClosed()) return;
      for (const record of guardedGroups.values()) record.reopen();
      reopenToolbar();
    }
    // 표식 편집 메뉴와 명령: 우클릭 메뉴(Delete measurement·Add Label), 이름 입력, 측정 수정, 화살표 글 입력. 새 화살표의 글
    // 입력에는 빈 답을 주어 네이티브 도구가 그 그리기를 취소하게 하고, 이미 있는 표식의 글 고치기는 답하지 않아 그대로 둔다.
    for (const name of ['showCornerstoneContextMenu', 'deleteMeasurement', 'setMeasurementLabel', 'updateMeasurement', 'arrowTextCallback']) {
      const original = commands?.getCommand(name, 'CORNERSTONE');
      if (typeof original?.commandFn !== 'function') continue;
      const guarded = { ...original, commandFn: options => {
        if (!nativeAuthoringClosed()) return original.commandFn(options);
        status.textContent = closedText('edit');
        if (name === 'arrowTextCallback' && !options?.data) options?.callback?.();
      } };
      commands.registerCommand('CORNERSTONE', name, guarded);
      policyRestores.push(() => { if (commands.getCommand(name, 'CORNERSTONE') === guarded) commands.registerCommand('CORNERSTONE', name, original); });
    }
    // 측정 목록 패널의 이름 바꾸기·잠금 풀기도 표식 편집이다. 사용자 편집(notYetUpdatedAtSource true)만 거절하고, 도구와의
    // 동기화(false)와 이 패널의 표시 갱신은 그대로 둔다. 목록의 Delete는 이 창의 그림만 지우며 저장 항목은 다음 관찰에서 다시 그린다.
    for (const [name, edits] of [['update', args => args[2] === true], ['toggleLockMeasurement', () => true]]) {
      const original = measurementService[name];
      if (typeof original !== 'function') continue;
      const guarded = function (...args) {
        if (nativeAuthoringClosed() && edits(args)) { status.textContent = closedText('edit'); return; }
        return original.apply(this, args);
      };
      measurementService[name] = guarded;
      policyRestores.push(() => { if (measurementService[name] === guarded) measurementService[name] = original; });
    }
    const groupService = services.toolGroupService, toolbarService = services.toolbarService;
    if (typeof groupService?.subscribe === 'function') {
      // TOOLGROUP_CREATED는 그룹을 만든 직후, 도구를 넣고 모드를 정하기 전에 동기로 온다: 여기서 감싸야 모드가 정하는 첫 모드부터 지킨다.
      if (groupService.EVENTS?.TOOLGROUP_CREATED) policyRestores.push(unsubscribe(groupService.subscribe(groupService.EVENTS.TOOLGROUP_CREATED,
        event => guardGroup(ct.ToolGroupManager?.getToolGroup?.(event?.toolGroupId)))));
      // 감싸지 않은 그룹이나 이 확장 밖의 전환이 작성 도구를 켜면 그 자리에서 되돌린다.
      if (groupService.EVENTS?.TOOL_ACTIVATED) policyRestores.push(unsubscribe(groupService.subscribe(groupService.EVENTS.TOOL_ACTIVATED,
        event => { if (nativeAuthoringClosed() && !VIEW_TOOLS.has(event?.toolName)) enforceTools(); })));
    }
    if (typeof toolbarService?.subscribe === 'function' && toolbarService.EVENTS?.TOOL_BAR_MODIFIED)
      policyRestores.push(unsubscribe(toolbarService.subscribe(toolbarService.EVENTS.TOOL_BAR_MODIFIED, () => { if (nativeAuthoringClosed()) enforceToolbar(); })));
    function unsubscribe(subscription) { return () => subscription?.unsubscribe?.(); }
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
    const reference = kinViewerImageReference;
    const matches = (r, item) => r?.study === scope && r.seriesUid === item.seriesUid && r.sopUid === item.sopUid && r.frame === item.frame;
    const current = () => reference(viewport()?.getCurrentImageId?.());
    const valid = ticket => !ended && ticket === generation && (!current() || current().study === scope);
    // S5-U2b-R-003 F01. 목록 읽기는 요청할 때 어느 목록인지 정해진다: writer의 작성자 목록(숨김 포함 전체) 또는 clinician의 확정 목록.
    // 답은 그 읽기(세대·순번)의 것이고 문서가 지금도 같은 목록을 읽을 때만 그린다 — clinician-only 경계(clinicianBoundary)가 어떤
    // 이유로 돌지 못했어도(settle은 감시자의 실패를 삼킨다) 전환 뒤에 도착한 작성자 목록은 그려지지 않는다.
    const readPolicy = () => readOnly() ? 'final' : 'author';
    const asked = (ticket, seq, policy) => valid(ticket) && seq === readSequence && readPolicy() === policy;
    const writable = entry => writer() && !suspended && !recovery.has(scope) && me?.kind === 'member' && me.roles?.includes('radiologist') &&
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
      entries.clear(); annotations.clear(); list.replaceChildren(); actions.replaceChildren(); loading = false; suspended = true; shown = null;
      unmatched = false; delete panel.dataset.studyUid; delete panel.dataset.readOnly; delete panel.dataset.frame;
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
      reset(readOnly() ? READ_ONLY.denied : '이 검사에 접근할 수 없습니다. 보관 작업은 접근 확인 후 재개할 수 있습니다.'); me = null;
      if (readOnly()) { panel.dataset.readOnly = 'denied'; panel.dataset.studyUid = scope; }
      button(actions, 'Recheck Access', () => load());
    }
    function end(modeExit = false) {
      if (ended) return;
      recovery.clear(); reset('로그인이 종료되었습니다. 다시 로그인한 뒤 뷰어를 여세요.'); ended = true; me = null; subject = ''; actions.replaceChildren();
      // Mode exit keeps this document and its login; the Findings section holds its drafts for the
      // next mode entry instead of destroying them as it must for a real logout or 401.
      window.dispatchEvent(Object.assign(new Event('kin-viewer-access-ended'), { kinModeExit: modeExit === true }));
      // A shared workstation must not retain unsaved labels after logout either.
      for (const a of ct.annotation.state.getAllAnnotations()) if (kinds[a.metadata.toolName]) {
        ct.annotation.state.removeAnnotation(a.annotationUID);
        if (services.measurementService.getMeasurement(a.annotationUID)) services.measurementService.remove(a.annotationUID);
      }
      render();
    }
    async function api(path, options = {}, ticket = generation) {
      // A request of a generation already given up (another study, the clinician-only boundary) is not sent at all: a save that
      // was waiting for its /me when that answer said clinician-only never reaches the server.
      if (!valid(ticket)) throw { stale: true };
      const parentSignal = controller.signal, request = new AbortController();
      const abort = () => request.abort(); parentSignal.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(abort, 30000);
      try {
      const res = await fetch('/api' + path, { ...options, cache: 'no-store', credentials: 'same-origin', signal: request.signal,
        headers: { 'X-KIN-CSRF': '1', ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
      if (!valid(ticket)) throw { stale: true };
      if (res.status === 401 || res.status === 403 && path === '/me') { kinViewerSession.refuse(); end(); throw { stale: true }; }
      if (res.status === 403) { deny(); throw { stale: true }; }
      const data = await res.json().catch(() => null);
      if (!valid(ticket)) throw { stale: true };
      // `said` (the server's wording) is read only by readOnlyLoad; writer paths keep their own messages (manualSr reads `message`).
      if (!res.ok || !data) throw { status: res.status, code: data?.code, said: data?.message };
      return data;
      } finally { clearTimeout(timeout); parentSignal.removeEventListener('abort', abort); }
    }
    async function authenticate(ticket) {
      const user = await api('/me', {}, ticket);
      // The session watcher below runs inside note(): ownAnswer tells it that this panel's own /me is the answer it reacts to.
      ownAnswer = true;
      try { kinViewerSession.note(user); } finally { ownAnswer = false; }
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
    // `answered`: only the clinician-only boundary passes it, from inside this panel's own /me answer — that answer is this read's /me.
    async function load(resume = false, recheck = null, answered = false) {
      if (!scope || ended || loading) return;
      const ticket = generation, seq = ++readSequence; loading = true; tried = Date.now();
      status.textContent = '저장 항목 확인 중…';
      try {
        if (!answered) await authenticate(ticket);
        if (readPolicy() === 'final') return await readOnlyLoad(ticket, seq);
        const heads = []; let cursor = null;
        do {
          const page = await api(path() + '?includeHidden=true&limit=100' + (recheck ? '&recheck=' + encodeURIComponent(recheck) : '') + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), {}, ticket);
          if (!asked(ticket, seq, 'author')) return;
          if (!Array.isArray(page.items) || heads.length + page.items.length > 512 || (cursor && page.nextCursor === cursor)) throw new Error('Invalid page');
          heads.push(...page.items); cursor = page.nextCursor;
        } while (cursor);
        if (!asked(ticket, seq, 'author')) return;
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
    // S5-U2b 읽기 전용 목록. 서버는 clinician-only에게 확정본일 때만 좁힌 쪽({uid, final, reportVersion, items, nextCursor})을
    // 주고, 숨긴 항목 요청은 400으로 거절한다. 이어받기 값은 받은 그대로 넘기고, 모든 쪽이 같은 검사·같은 확정 판이어야
    // 한다 — 판이 다른 쪽을 이어 붙이면 어느 확정 시점에도 없던 목록이 된다(S5-U1b-F04). 읽는 동안 이전 목록을 내려 두고,
    // 실패하면 받은 쪽도 버린다. 확정 전(items null)은 빈 목록(항목 없음)과 다르게 알린다.
    const dropRows = () => {
      for (const e of entries.values()) removeAnnotation(e);
      entries.clear(); list.replaceChildren(); shown = null; unmatched = false; delete panel.dataset.frame;
    };
    async function readOnlyLoad(ticket, seq) {
      if (!valid(ticket) || seq !== readSequence) return;
      const study = scope, heads = [];
      let cursor = null, version = null, withheld = false, pages = 0;
      dropRows(); panel.dataset.readOnly = 'loading'; toolbar();
      try {
        do {
          const page = await api(path() + '?limit=100' + (cursor === null ? '' : '&cursor=' + encodeURIComponent(cursor)), {}, ticket);
          if (!asked(ticket, seq, 'final')) return;
          if (++pages > 6 || !page || page.uid !== study || typeof page.final !== 'boolean') throw new Error('Invalid page');
          if (!page.final) {
            if (cursor !== null || page.items !== null || page.nextCursor !== null) throw new Error('Invalid page');
            withheld = true; break;
          }
          const next = page.nextCursor;
          if (!Number.isSafeInteger(page.reportVersion) || page.reportVersion < 1 || (version !== null && page.reportVersion !== version) ||
              !Array.isArray(page.items) || page.items.length > 100 || heads.length + page.items.length > 512 ||
              !page.items.every(h => h && typeof h === 'object' && typeof h.id === 'string' && h.id && Number.isSafeInteger(h.revision) &&
                h.item && typeof h.item === 'object' && Object.hasOwn(names, h.item.kind)) ||
              !(next === null || typeof next === 'string' && next.length > 0 && next.length <= 512 && next !== cursor)) throw new Error('Invalid page');
          version = page.reportVersion; heads.push(...page.items); cursor = next;
        } while (cursor !== null);
        if (!asked(ticket, seq, 'final')) return;
        readOnlyShow(study, withheld ? null : version, heads);
      } catch (error) {
        if (error?.stale || !asked(ticket, seq, 'final')) return;
        readOnlyFailed(error);
      }
    }
    // S5-U2b-R-003 F01. clinician-only가 되는 순간은 이 패널이 진행 중인 모든 읽기·쓰기의 경계다. /me를 기다리는 읽기든 이미
    // 작성자 목록을 요청한 읽기든(첫 쪽·다음 쪽·Refresh·Recheck Source), 저장·이력·SR 요청이든 reset()이 그 세대·순번을 버리고
    // 요청을 끊으며(아직 보내지 않은 요청은 api가 보내지 않는다), 작성자 행과 그 표식을 지금 내린다. 그 뒤 확정 목록 읽기를 정확히
    // 한 번 시작한다: 이 전환을 부른 답이 이 패널 자신의 /me면(ownAnswer) 방금 인증했으므로 곧바로 확정 목록을 읽고, 다른 확장의
    // /me면 이 패널의 /me부터 다시 묻는다(끊은 /me의 늦은 답은 버린다). 진행 중인 읽기(loading)를 이유로 건너뛰지 않는다 — 건너뛰면
    // writer로 이미 요청한 목록이 전환 뒤에 도착해 그려지고, 그 목록에는 확인 기준(shown)이 없어 final:false로도 내려가지 않았다.
    function clinicianBoundary(own) {
      reset('저장 항목 확인 중…'); toolbar();
      load(false, null, own);
    }
    // 끝까지 검증한 한 판(확정 판 번호, 확정 전이면 null)만 그리고, 그 판을 뒤따르는 주기·포커스 확인의 기준(shown)으로 남긴다.
    function readOnlyShow(study, version, heads) {
      suspended = false; shown = { study, version }; unmatched = false;
      for (const head of heads) {
        const e = { id: head.id, head, draft: itemOnly(head), editing: false, latest: null, message: '' };
        entries.set(e.id, e); row(e);
      }
      shownStatus = version === null ? READ_ONLY.withheld : heads.length ? '확정 판독문 r' + version + '의 저장 항목 ' + heads.length + '개 · 읽기 전용'
        : '확정 판독문 r' + version + '에 저장된 측정·키 이미지가 없습니다 · 읽기 전용';
      status.textContent = shownStatus;
      panel.dataset.studyUid = study; panel.dataset.readOnly = version === null ? 'withheld' : heads.length ? 'ready' : 'empty';
      toolbar(); hydrate(); frameMatch(current());
    }
    function readOnlyFailed(error) {
      dropRows();
      const said = Array.isArray(error?.said) ? error.said.filter(x => typeof x === 'string').join(' ') : typeof error?.said === 'string' ? error.said : '';
      status.textContent = '저장 항목을 불러오지 못했습니다. ' + (Number.isInteger(error?.status)
        ? (said ? said + ' ' : '') + '(HTTP ' + error.status + (typeof error.code === 'string' ? ' · ' + error.code : '') + ')'
        : error?.name === 'AbortError' || error instanceof TypeError ? '서버 응답을 받지 못했습니다.' : '응답 형식을 확인할 수 없습니다.') + ' Refresh로 다시 읽으세요.';
      panel.dataset.studyUid = scope; panel.dataset.readOnly = 'failed';
      toolbar();
    }
    // S5-U2b-R-001 F03. 주기·포커스 확인의 답도 지금 그려 둔 확정 판(shown)과 대조한다. 같은 검사·같은 읽기 세대의 답만 본다 —
    // 다른 검사로 옮겼다 돌아온 A→B→A의 늦은 답이나 그 사이 새로 시작한 읽기가 있으면 이 답은 아무것도 바꾸지 않는다. 확정이
    // 풀리면(final:false) 행과 표식을 바로 내리고 withheld로, 판이 바뀌면 내린 뒤 새 판 전체를 처음부터 다시 검증해 그린다.
    // 전송 실패·5xx는 확인하지 못한 것이라 다음 확인까지 검증한 판을 두고, 4xx·형식 오류는 서버가 지금 내주지 않는 목록이라 내린다.
    function confirmShown(ticket, seq, study, page, error) {
      if (error?.stale || !asked(ticket, seq, 'final') || loading || scope !== study || shown?.study !== study) return;
      if (error) { if (Number.isInteger(error.status) && error.status >= 400 && error.status < 500) readOnlyFailed(error); return; }
      if (!page || page.uid !== study || typeof page.final !== 'boolean' || (page.final
        ? !Number.isSafeInteger(page.reportVersion) || page.reportVersion < 1 || !Array.isArray(page.items)
        : page.items !== null || page.nextCursor !== null)) return readOnlyFailed(new Error('Invalid page'));
      const version = page.final ? page.reportVersion : null;
      if (version === shown.version) return;
      dropRows();
      if (version === null) return readOnlyShow(study, null, []);
      panel.dataset.readOnly = 'loading'; toolbar(); load();
    }
    // S5-U2b-R-002 F02. 이 확인은 활성 화면의 원본 프레임 식별과 떼어 둔다: 그려 둔 검사(scope)와 읽기 세대를 기준으로 주기(15초)·
    // 포커스마다 확인하고, 답은 위 confirmShown의 UID·세대 방어를 그대로 거친다. 프레임이 없는 화면(MPR·볼륨·로딩 실패)에
    // 머물러도 취소·교체된 판이 확인 없이 남지 않는다.
    function recheckShown() {
      if (!scope || !subject || suspended || loading || checking || Date.now() - lastAuth <= 15000) return;
      checking = true; const ticket = generation, seq = readSequence, study = scope;
      authenticate(ticket).then(() => api(path() + '?limit=1', {}, ticket))
        .then(page => confirmShown(ticket, seq, study, page, null), error => confirmShown(ticket, seq, study, null, error))
        .catch(() => {}).finally(() => { checking = false; });
    }
    // 목록은 식별된 원본 프레임으로만 화면 영상과 이어진다. 활성 화면에서 그 검사의 원본 프레임을 찾지 못하면 목록을 영상과 맞추지
    // 않았다고 알리고(data-frame="unmatched") 위 확인은 계속한다. 프레임이 돌아오면 그 자리에서 다시 확인한다.
    function frameMatch(r) {
      const lost = !!shown && !(r && r.study === shown.study);
      if (lost === unmatched) return;
      unmatched = lost;
      if (lost) { panel.dataset.frame = 'unmatched'; status.textContent = shownStatus + ' · ' + READ_ONLY.unmatched; return; }
      delete panel.dataset.frame; status.textContent = shownStatus; lastAuth = 0;
    }
    function toolbar() {
      const ticket = generation;
      actions.replaceChildren(); button(actions, 'Refresh', load);
      if (!writer()) { if (readOnly()) text(actions, 'p', READ_ONLY.note); return; }
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
          if (ended || !subject || suspended || recovery.has(scope) || !writer()) {
            status.textContent = ended ? '로그인이 종료되었습니다. 다시 로그인한 뒤 뷰어를 여세요.' : !writer() ? closedText('tool') : '현재 검사 접근과 보관 작업을 확인한 후 측정하세요.'; return;
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
      // The clinician projection carries no author (clinician-policy.ts clinicianViewerItem).
      if (e.head) text(el, 'div', readOnly() ? 'Read-only' : e.head.authorActor + (writable(e) ? ' · My Item' : ' · Read-only'));
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
      // Recheck and remeasure belong to the writer; a read-only row keeps the "재확인 필요" message hydrate() writes.
      if (sourceUnverified && !e.head.hidden && writer()) {
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
      // Revisions carry authors and hidden states; that route is a writer read, not a clinician one (S5-U1b allowlist).
      if (e.head && writer()) button(el, 'History', async () => {
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
    // Selection and highlight of the hydrated annotation behind a finding source; a hidden,
    // unverified or key-image source navigates just the same and reports why nothing is drawn.
    // S2-C: every answer for a linked item also reports this viewer's own entry at arrival (present, its saved revision, hidden,
    // and whether it is being edited or saved), so the finding discloses what is drawn instead of its list state.
    function highlight(itemId) {
      if (!itemId) return { highlighted: false, annotation: 'none' };
      const e = [...entries.values()].find(x => x.head?.id === itemId);
      if (!e) return { highlighted: false, annotation: 'missing', present: false };
      const live = { present: true, revision: e.head.revision, hidden: !!e.head.hidden, working: !!(e.editing || e.pending || e.busy) };
      if (e.head.hidden) return { highlighted: false, annotation: 'hidden', ...live };
      if (!tools[e.draft.kind]) return { highlighted: false, annotation: 'key', ...live };
      const a = e.annotationUID && ct.annotation.state.getAnnotation(e.annotationUID);
      if (!a) return { highlighted: false, annotation: manual(e.draft.kind) && e.head.referenceStatus !== 'verified' ? 'unverified' : 'none', ...live };
      for (const other of ct.annotation.state.getAllAnnotations())
        if (other.annotationUID !== a.annotationUID && kinds[other.metadata.toolName] && other.highlighted) other.highlighted = false;
      a.highlighted = true;
      try { ct.annotation.selection?.setAnnotationSelected?.(a.annotationUID, true, false); } catch (_) {}
      render();
      return { highlighted: true, annotation: 'shown', ...live };
    }
    const navigationEnv = { services, viewport, reference, matches, hydrate, highlight,
      ended: () => ended, scope: () => scope, busy: () => suspended || recovery.has(scope),
      generation: () => generation, valid, navigation: () => navigation, beginNavigation: () => ++navigation,
      delay: () => new Promise(resolve => setTimeout(resolve, 100)) };
    const navigateTo = target => kinViewerNavigateTo(navigationEnv, target);
    const activateStudy = study => kinViewerActivateStudy(navigationEnv, study);
    // The active viewport and the frame it shows: the Findings section's arrival proof after an activation.
    const shownImage = () => {
      try {
        const id = services.viewportGridService.getActiveViewportId();
        return { viewportId: typeof id === 'string' ? id : null, image: reference(services.cornerstoneViewportService.getCornerstoneViewport(id)?.getCurrentImageId?.()) };
      } catch (_) { return { viewportId: null, image: null }; }
    };
    async function navigate(e) {
      if (!valid(generation) || suspended || recovery.has(scope) || entries.get(e.id) !== e) return;
      const outcome = await navigateTo({ studyUid: scope, seriesUid: e.draft.seriesUid, sopUid: e.draft.sopUid, frame: e.draft.frame });
      if (outcome.ok || !valid(generation) || entries.get(e.id) !== e) return;
      const message = { 'series-missing': '현재 검사에서 원본 시리즈를 찾을 수 없습니다.', 'frame-missing': '원본 프레임을 열지 못했습니다.',
        'viewport-unsupported': '현재 화면은 원본 프레임 목록이 없는 MPR/볼륨 화면입니다. 일반 프레임 화면을 선택한 뒤 이동하세요.' }[outcome.reason];
      if (message) { e.message = message; row(e); }
    }
    // Read-only view of the saved heads for the Findings section: only saved rows are linkable and
    // the Orthanc verdict travels with them, separate from any database link state.
    const historyState = () => ({ scope, subject, ended, suspended: suspended || recovery.has(scope), writable: writable({}),
      generation, loading, ...shownImage(),
      heads: [...entries.values()].filter(e => e.head).map(e => ({ id: e.head.id, revision: e.head.revision, hidden: !!e.head.hidden,
        kind: e.draft.kind, label: e.draft.label ?? e.draft.title ?? '', seriesUid: e.head.item.seriesUid, sopUid: e.head.item.sopUid,
        frame: e.head.item.frame, authorSub: e.head.authorSub, referenceStatus: manual(e.draft.kind) ? e.head.referenceStatus ?? 'unverified' : null,
        values: Array.isArray(e.head.item.baseline?.values) ? [...e.head.item.baseline.values] : null, working: !!(e.editing || e.pending || e.busy) })) });
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
      closeAuthoring();
      if (ended) return;
      const r = current();
      if (r && r.study !== scope) {
        park(); reset('검사 확인 중…'); scope = r.study; me = null;
        load(); return;
      }
      // No /me has answered this panel yet (errors, time-outs): ask again on focus and every 15 s, so that a passing failure
      // does not leave a writer with image viewing only until the next study (authoring waits for a writer answer).
      if (!subject && scope && !loading && Date.now() - tried > 15000) { load(); return; }
      // S5-U2b-R-002 F02: the final list a clinician-only document shows is checked whether or not a source frame is identified.
      if (readOnly()) { frameMatch(r); recheckShown(); }
      // Switching display sets briefly removes the viewport. Mode exit, not
      // that loading gap, owns teardown of drafts and in-flight commands.
      if (!r) return;
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
      // The writer's access probe (a 403 parks the drafts in deny()); a clinician-only document is checked above.
      if (!readOnly() && Date.now() - lastAuth > 15000 && !checking) {
        checking = true; const ticket = generation;
        authenticate(ticket).then(() => api(path() + '?limit=1', {}, ticket)).catch(() => {}).finally(() => { checking = false; });
      }
      refreshMeasurementViews(); refreshSrButtons();
    }
    function captureAnnotations() {
      // Not a confirmed writer: a mark drawn with the viewer's own tools never becomes an unsaved item of this panel.
      if (suspended || recovery.has(scope) || !writer()) return;
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
    const onFocus = () => { lastAuth = 0; tried = 0; };
    // A document that is not a confirmed writer has no mark to save, so an unlocked native mark is not unsaved work there.
    const jobGuard = () => recovery.size > 0 || [...entries.values()].some(x => hasWork(x) || x.busy) || writer() &&
      ct.annotation.state.getAllAnnotations().some(a => kinds[a.metadata.toolName] && !ct.annotation.locking.isAnnotationLocked(a.annotationUID));
    // Finding drafts (including ones held for another study) count for the whole-viewer guards:
    // worklist Next Study, window reuse/close, cell merge/hanging protocol and page unload. They are
    // deliberately not part of the mark-only kinViewerHistoryHasUnsaved used by Job save/restore,
    // which never touches a finding. An unreadable state is uncertainty, not permission.
    const findingsWork = () => {
      try { const f = typeof window.kinViewerFindingsState === 'function' ? window.kinViewerFindingsState() : null; return { dirty: f?.dirty === true, busy: f?.busy === true }; }
      catch (_) { return { dirty: true, busy: true }; }
    };
    // Native marks exist before the next history scan; warn during that gap too.
    const beforeUnload = e => { if (jobGuard() || findingsWork().dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.kinViewerHistoryHasUnsaved = jobGuard;
    const workspaceState = () => {
      const findings = findingsWork();
      return { dirty: jobGuard() || findings.dirty, busy: [...entries.values()].some(x => x.busy || x.pending) || findings.busy };
    };
    window.kinViewerHistoryWorkspaceState = workspaceState;
    window.kinViewerHistoryNavigate = navigateTo;
    window.kinViewerHistoryActivate = activateStudy;
    window.kinViewerHistoryState = historyState;
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
    stop = () => { end(true); clearInterval(timer); channel?.close(); document.removeEventListener(stackEvent, onImage, true); subscriptions.forEach(s => s.unsubscribe()); window.removeEventListener('storage', onStorage); window.removeEventListener('focus', onFocus); window.removeEventListener('beforeunload', beforeUnload); for (const restores of configured.values()) restores.reverse().forEach(restore => restore()); configured.clear(); panel.remove(); };
    // 판정이 바뀌는 순간(이 패널의 /me가 아니어도): writer면 막는 동안 적어 둔 도구 모드·도구막대를 되돌리고, 그 밖이면 작성
    // 경로를 닫고 이 패널이 그리지 않은 표식을 지운다. read-only는 clinicianBoundary를 지난다. 다른 판정은 그려 둔 행의 컨트롤만
    // 다시 그린다.
    const unwatch = kinViewerSession.onChange(next => {
      const own = ownAnswer;
      if (next === 'writer') reopenAuthoring(); else closeAuthoring();
      if (ended || !scope) return;
      if (next === 'read-only') clinicianBoundary(own);
      else if (!suspended) { toolbar(); for (const e of entries.values()) row(e); }
    });
    const previousStop = stop;
    stop = () => {
      unwatch(); policyRestores.reverse().forEach(restore => restore());
      for (const record of guardedGroups.values()) record.restore();
      guardedGroups.clear();
      if (window.kinViewerHistoryHasUnsaved === jobGuard) delete window.kinViewerHistoryHasUnsaved;
      if (window.kinViewerHistoryWorkspaceState === workspaceState) delete window.kinViewerHistoryWorkspaceState;
      if (window.kinViewerHistoryNavigate === navigateTo) delete window.kinViewerHistoryNavigate;
      if (window.kinViewerHistoryActivate === activateStudy) delete window.kinViewerHistoryActivate;
      if (window.kinViewerHistoryState === historyState) delete window.kinViewerHistoryState;
      if (measurementService.getMeasurements === projectedMeasurements) measurementService.getMeasurements = originalMeasurements;
      reportRestores.reverse().forEach(restore => restore());
      previousStop();
      // After previousStop: the measurement wrappers configureMeasurements put over these restore to them first.
      for (const restore of guardedTools.values()) restore();
      guardedTools.clear();
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

function kinHangingProtocolDisplaySets(values) {
  const counts = new Map();
  for (const value of values) {
    const key = JSON.stringify([value.StudyInstanceUID, value.SeriesInstanceUID]);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return values.filter(value =>
    counts.get(JSON.stringify([value.StudyInstanceUID, value.SeriesInstanceUID])) === 1 &&
    value.SOPClassHandlerId === '@ohif/extension-default.sopClassHandlerModule.stack' &&
    !value.isCompositeStack && Array.isArray(value.images) && value.images.length > 0 &&
    value.images.every(image => image.StudyInstanceUID === value.StudyInstanceUID &&
      image.SeriesInstanceUID === value.SeriesInstanceUID));
}

/* S5-U2b. 서버 /me의 역할이 업무 역할 clinician뿐인가 — api/src/clinician-policy.ts clinicianOnly와 같은 규칙이다(Keycloak
   기본 역할은 보지 않고, 기존 세 역할이 하나라도 섞이면 아니다). 이 뷰어가 쓰기 컨트롤을 두지 않을 때만 쓰며 권한 판정이
   아니다: 쓰기와 작성자 쪽 읽기는 서버가 거절하고, 이 판정은 그 거절을 부를 버튼을 주지 않을 뿐이다. */
function kinViewerClinicianOnly(me) {
  const roles = me && me.kind === 'member' && Array.isArray(me.roles) ? me.roles : [];
  const app = roles.filter(role => ['radiologist', 'technician', 'admin', 'clinician'].includes(role));
  return app.length > 0 && app.every(role => role === 'clinician');
}

/* S5-U2b(Astra S5-U2b-R-001 F02). 이 뷰어 문서의 계정 판정 하나. 측정 패널·배치 패널·쓰기 화면 관문 중 어느 쪽이 받은 /me든
   여기에 적는다: unconfirmed(성공한 답 없음) · refused(401/403, 또는 뷰어 구성원이 아닌 답) · writer · read-only(clinician-only).
   read-only는 문서가 끝날 때까지 되돌리지 않는다 — 한 확장의 /me 실패, 뒤이은 다른 답, 모드 재진입이 쓰기 화면을 다시 열지
   못한다. 쓰기 화면(소견·저장 작업·Tech 메모)은 성공한 /me가 writer라고 답했을 때만 붙는다(decide). 오류·시간 초과·형식
   오류는 허가도 거절도 아니라서 결정을 미루고, 이 문서의 다음 성공한 /me(다른 확장의 것 포함)가 정한다. 권한 판정이 아니다:
   쓰기와 작성자 쪽 읽기는 서버가 거절하고, 이 판정은 그 거절을 부를 화면을 붙이지 않을 뿐이다.
   (Astra S5-U2b-R-002 F01) 기본값은 읽기 전용이다: 측정·표식 작성 경로는 writer일 때만 열리고, unconfirmed·refused에서도
   영상 조작만 된다. onChange는 판정이 바뀔 때마다 알린다 — 측정 패널이 작성 경로를 열고 닫고, 쓰기 화면은 writer가 아니게
   되는 순간 내려간다. */
const kinViewerSession = (() => {
  let state = 'unconfirmed', read = null;
  const waiting = new Set(), watchers = new Set(), changes = new Set();
  function settle(next) {
    if (state === 'read-only') return state;
    const previous = state; state = next;
    for (const resolve of [...waiting]) { waiting.delete(resolve); resolve(next); }
    if (next === 'read-only') for (const watch of [...watchers]) { try { watch(); } catch (_) {} }
    if (next !== previous) for (const watch of [...changes]) { try { watch(next); } catch (_) {} }
    return state;
  }
  const member = me => me?.kind === 'member' && typeof me.sub === 'string' && me.sub.length > 0;
  const note = me => settle(kinViewerClinicianOnly(me) ? 'read-only' : member(me) ? 'writer' : 'refused');
  return {
    state: () => state,
    readOnly: () => state === 'read-only',
    writer: () => state === 'writer',
    note,
    refuse: () => settle('refused'),
    onReadOnly(watch) { watchers.add(watch); return () => { watchers.delete(watch); }; },
    onChange(watch) { changes.add(watch); return () => { changes.delete(watch); }; },
    // 같은 때 붙는 확장끼리 /me 읽기 하나를 나눠 쓴다. 답은 그 읽기나 다른 확장의 성공한 /me 중 먼저 온 쪽이다.
    decide() {
      if (state === 'read-only') return Promise.resolve(state);
      const answer = new Promise(resolve => waiting.add(resolve));
      if (!read && typeof fetch === 'function') {
        read = fetch('/api/me', { credentials: 'same-origin', cache: 'no-store', headers: { 'X-KIN-CSRF': '1' } }).then(async response => {
          if (response.status === 401 || response.status === 403) settle('refused');
          else if (response.ok) note(await response.json());
        }).catch(() => {}).finally(() => { read = null; });
      }
      return answer;
    },
  };
})();

function kinCreateViewerLayout() {
  let services, stop;
  function mount() {
    stop?.();
    const model = kinViewerLayoutModel, grid = services.viewportGridService;
    const cs = services.cornerstoneViewportService, ds = services.displaySetService;
    const search = location.search, studies = model.scope(search);
    const panel = document.createElement('details'); panel.id = 'kin-viewer-layout'; panel.open = true;
    panel.style.cssText = 'position:fixed;left:8px;bottom:30px;z-index:41;width:360px;max-width:calc(100vw - 16px);max-height:calc(100vh - 48px);overflow:auto;box-sizing:border-box;background:#101e32;color:#e1ecfc;border:1px solid #657c9f;border-radius:8px;padding:8px;font:13px sans-serif';
    const summary = document.createElement('summary'); summary.textContent = 'Recent Layout'; panel.append(summary);
    const note = document.createElement('p'); note.textContent = '최근 1건만 저장합니다. 영상 위치·확대·주석은 포함하지 않습니다.'; panel.append(note);
    const status = document.createElement('p'); status.id = 'kin-viewer-layout-status'; status.setAttribute('role', 'status'); panel.append(status);
    const controls = document.createElement('div'); panel.append(controls); document.body.append(panel);
    let ended = false, busy = false, key = null, channel, hpOwner = null, hp = null, hpHost = null;
    const controller = new AbortController();
    const buttons = [];
    const live = () => !ended && location.search === search;
    const refresh = () => buttons.forEach(b => { b.disabled = ended || busy || !key || !studies; });
    function end() { ended = true; controller.abort(); hp?.end(); key = null; status.textContent = '세션이 변경되었습니다. 다시 로그인한 뒤 뷰어를 여세요.'; refresh(); }
    async function get(path, signal) {
      const request = new AbortController(), abort = () => request.abort();
      controller.signal.addEventListener('abort', abort, { once: true });
      signal?.addEventListener('abort', abort, { once: true });
      if (controller.signal.aborted || signal?.aborted) abort();
      const timer = setTimeout(abort, 10000);
      try {
        const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal: request.signal, headers: { 'X-KIN-CSRF': '1' } });
        if (!live()) throw new Error('화면이 변경되어 배치를 적용하지 않았습니다.');
        if (response.status === 401 || response.status === 403) { end(); throw new Error('검사 접근 권한을 확인할 수 없습니다.'); }
        if (!response.ok) throw new Error('서버 연결을 확인한 뒤 다시 시도하세요.');
        return await response.json();
      } finally { clearTimeout(timer); controller.signal.removeEventListener('abort', abort); signal?.removeEventListener('abort', abort); }
    }
    async function authenticate(signal) {
      const me = await get('/api/me', signal), next = model.owner(me);
      kinViewerSession.note(me);
      if (!live() || !next || (key && next !== key)) { end(); throw new Error('계정이 변경되어 배치를 적용하지 않았습니다.'); }
      key = next;
      hpOwner = { institution: me.institution, subject: me.sub };
    }
    // S5-U2b: 배치 저장·복원과 Hanging Protocol은 작성자 목록을 읽고 계정에 쓰므로, 문서가 clinician-only로 확인되면(이 패널의
    // /me든 다른 확장의 것이든, 이 모드 진입 전이든) 없애고 다른 확장이 적는 상태 줄만 남긴다.
    function readOnlyPanel() {
      for (const b of buttons.splice(0)) b.remove();
      hp?.end(); hp = null; hpHost?.remove(); hpHost = null;
      summary.textContent = 'Viewer Status'; note.textContent = '읽기 전용 화면입니다. 배치 저장·복원과 Hanging Protocol은 제공하지 않습니다. 화면 배치는 뷰어의 기본 레이아웃 도구로 바꿀 수 있습니다.';
    }
    async function mountProtocols() {
      const load = (name, global) => window[global] ? Promise.resolve() : new Promise((resolve, reject) => {
        const script = document.createElement('script'); script.src = '/worklist/hpacs-lite/' + name;
        const finish = error => { clearTimeout(timer); controller.signal.removeEventListener('abort', abort); script.onload = script.onerror = null; script.remove(); error ? reject(error) : resolve(); };
        const abort = () => finish(new Error('Hanging Protocol 연결이 중단되었습니다.'));
        const timer = setTimeout(abort, 10000);
        script.onload = () => finish(window[global] ? null : new Error('Hanging Protocol 모듈을 확인할 수 없습니다.'));
        script.onerror = () => finish(new Error('Hanging Protocol 화면을 불러오지 못했습니다.'));
        controller.signal.addEventListener('abort', abort, { once: true }); document.head.append(script);
      });
      await load('hanging-protocol-model.js', 'KinHangingProtocolModel');
      if (!live()) return;
      await load('viewer-hanging-protocol.js', 'KinViewerHangingProtocol');
      if (!live() || kinViewerSession.readOnly()) return;
      const host = hpHost = document.createElement('section'); panel.append(host);
      hp = window.KinViewerHangingProtocol.mount({ services, host, owner: hpOwner, live,
        access: async ({ signal }) => {
          await authenticate(signal);
          const data = await get('/api/studies', signal);
          // Current/Related follows the opening order, unlike Recent Layout's canonical scope.
          const uids = new URLSearchParams(search).get('StudyInstanceUIDs').split(',');
          const rows = uids.map(uid => data.studies?.find(row => row.uid === uid));
          if (rows.some(row => !row)) throw new Error('현재 검사 접근 권한을 확인할 수 없습니다.');
          await authenticate(signal);
          if (signal.aborted) throw new Error('Hanging Protocol 확인이 중단되었습니다.');
          return { studies: rows, displaySets: kinHangingProtocolDisplaySets(ds.getActiveDisplaySets()) };
        } });
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
      if (busy || !live() || !key || !studies || kinViewerSession.readOnly()) return;
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
    const unwatch = kinViewerSession.onReadOnly(readOnlyPanel);
    if (kinViewerSession.readOnly()) readOnlyPanel();
    const onStorage = e => { if (e.key === 'kin-session-ended') end(); };
    const onMessage = e => { if (e.data?.type === 'session-ended') end(); };
    window.addEventListener('storage', onStorage);
    try { channel = new BroadcastChannel('kin-session'); channel.addEventListener('message', onMessage); } catch (_) {}
    if (studies) authenticate().then(async () => {
      if (!live()) return;
      if (kinViewerSession.readOnly()) { readOnlyPanel(); return; }
      status.textContent = '현재 검사의 배치를 직접 저장하거나 복원하세요.'; await mountProtocols();
    }).catch(error => { if (live()) status.textContent = error?.message || '계정 정보를 확인할 수 없습니다. 뷰어를 다시 여세요.'; }).finally(refresh);
    else status.textContent = '현재 검사 1~2개의 일반 CT 배치만 지원합니다.';
    stop = () => { unwatch(); end(); window.removeEventListener('storage', onStorage); channel?.close(); panel.remove(); };
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

function kinCineNext(index, first, last, mode, direction, loop) {
  if (![index, first, last].every(Number.isSafeInteger) || first < 0 || first >= last || index < first || index > last ||
      !['forward', 'reverse', 'yoyo'].includes(mode)) throw Error('invalid cine range state');
  if (mode === 'yoyo') {
    let nextDirection = direction === -1 ? -1 : 1;
    if (index === last && nextDirection === 1) nextDirection = -1;
    else if (index === first && nextDirection === -1) {
      if (!loop) return { stop: true, direction: nextDirection };
      nextDirection = 1;
    }
    return { stop: false, direction: nextDirection, next: index + nextDirection };
  }
  const nextDirection = mode === 'reverse' ? -1 : 1, candidate = index + nextDirection;
  if (candidate >= first && candidate <= last) return { stop: false, direction: nextDirection, next: candidate };
  return loop ? { stop: false, direction: nextDirection, next: nextDirection === 1 ? first : last }
    : { stop: true, direction: nextDirection };
}

function kinCreateCine() {
  let services, dispose;
  function mount() {
    dispose?.();
    const core = window.cornerstone, cine = services.cineService, grid = services.viewportGridService;
    const nativePlay = cine.playClip, nativeStop = cine.stopClip;
    const records = new Map(), subscriptions = [], listeners = [];
    let ended = false, channel, selected, owner, sequence = 0, halting = false, wasEnabled = false, rangeShown;
    const panel = document.createElement('div'); panel.id = 'kin-cine'; panel.hidden = true;
    panel.style.cssText = 'position:fixed;bottom:60px;left:50%;transform:translateX(-50%);z-index:42;max-width:65vw;display:flex;flex-wrap:wrap;gap:6px;padding:7px;background:#101e32;color:#e1ecfc;border-radius:6px;font:13px sans-serif';
    // Native controls remain the playback/FPS entry point for the selected view.
    const direction = document.createElement('select'); direction.setAttribute('aria-label', 'Playback Direction');
    for (const [value, text] of [['forward', 'Forward'], ['reverse', 'Reverse'], ['yoyo', 'Yoyo']]) {
      const option = document.createElement('option'); option.value = value; option.textContent = text; direction.append(option);
    }
    const loop = document.createElement('input'); loop.type = 'checkbox'; loop.checked = true;
    const label = document.createElement('label'); label.append(loop, ' Loop');
    const rangeStart = document.createElement('input'); rangeStart.type = 'number'; rangeStart.min = '1'; rangeStart.setAttribute('aria-label', 'Range Start');
    const rangeEnd = document.createElement('input'); rangeEnd.type = 'number'; rangeEnd.min = '2'; rangeEnd.setAttribute('aria-label', 'Range End');
    const applyRange = document.createElement('button'); applyRange.textContent = 'Apply Range';
    const status = document.createElement('span'); status.setAttribute('role', 'status');
    const first = document.createElement('button'); first.textContent = 'First Frame';
    const last = document.createElement('button'); last.textContent = 'Last Frame';
    const help = document.createElement('span'); help.textContent = '범위는 1부터 시작합니다. Yoyo는 양 끝 프레임을 중복하지 않고 왕복합니다.';
    panel.append('Selected View ', direction, label, ' Range ', rangeStart, ' to ', rangeEnd, applyRange, first, last, status, help); document.body.append(panel);
    for (const control of [direction, rangeStart, rangeEnd, applyRange, first, last]) control.style.cssText = 'background:#263c57;color:white;border:1px solid #6884a6;border-radius:3px;padding:2px 5px';
    rangeStart.style.width = rangeEnd.style.width = '58px';
    const listen = (target, type, fn, capture = false) => { target.addEventListener(type, fn, capture); listeners.push(() => target.removeEventListener(type, fn, capture)); };
    const viewport = id => services.cornerstoneViewportService.getCornerstoneViewport(id);
    const volumeTarget = (v, verify = false) => { try { return window.kinGetVolumeCineTarget?.(v, verify) || null; } catch (e) { if (verify) throw e; return null; } };
    const eligible = v => v?.type === 'stack' || v?.type === 'orthographic' && !!volumeTarget(v)?.allowed;
    const signature = v => { if (v.type === 'orthographic') { const c=v.getCamera(),round=n=>Number(n.toFixed(6)); return JSON.stringify([volumeTarget(v)?.key,c.viewPlaneNormal.map(round),c.viewUp.map(round),round(c.parallelScale),c.flipHorizontal,c.flipVertical]); } return JSON.stringify([grid.getState().viewports.get(v.id)?.displaySetInstanceUIDs, v.getImageIds?.()]); };
    const contentSignature = v => v.type==='orthographic'?volumeTarget(v)?.contentKey:signature(v);
    const resetDirection = r => { r.playDirection = r.mode === 'reverse' ? -1 : 1; };
    const resetRange = r => { r.range = null; r.rangeRevision = (r.rangeRevision || 0) + 1; resetDirection(r); };
    const resetPlayback = r => { r.mode = 'forward'; r.loop = true; resetRange(r); };
    function positionControls(v) {
      const pane=[...document.querySelectorAll('[data-cy=viewport-grid] > div')].find(p=>p.contains(v?.element)),control=pane?.querySelector('[data-cy="cine-player-play-pause"]'),rect=control?.getBoundingClientRect();
      if(!rect?.width||!panel.offsetHeight)return;
      panel.style.bottom='auto';panel.style.top=Math.max(48,rect.top-panel.offsetHeight-8)+'px';panel.style.left=Math.min(innerWidth-panel.offsetWidth/2-8,Math.max(panel.offsetWidth/2+8,rect.x+rect.width/2))+'px';
    }
    function volumeFrames(v,target) {
      const {sliceRange,spacingInNormalDirection:step,camera}=core.utilities.getVolumeViewportScrollInfo(v,target.volume.volumeId).sliceRangeInfo;
      const {min,max,current}=sliceRange,last=Math.floor((max-min)/step+1e-6),index=Math.round((current-min)/step);
      if(![min,max,current,step].every(Number.isFinite)||step<=0||max<=min||!Number.isSafeInteger(last)||last<1||!Number.isSafeInteger(index))throw Error('MPR 재생 범위를 확인할 수 없습니다.');
      return {min,step,last,index,current,camera};
    }
    function moveVolume(v,target,frames,index) {
      const {camera,min,step,current}=frames,delta=min+index*step-current;
      const next={focalPoint:camera.focalPoint.map((n,i)=>n+camera.viewPlaneNormal[i]*delta),position:camera.position.map((n,i)=>n+camera.viewPlaneNormal[i]*delta)};
      try{v.setCamera(next);v.render();const actual=v.getCamera();if(Object.keys(next).some(key=>next[key].some((n,i)=>Math.abs(n-actual[key][i])>1e-5)))throw Error('MPR 재생 위치를 확인하지 못했습니다.');}
      catch(error){if(volumeTarget(v)?.key===target.key)try{v.setCamera({focalPoint:camera.focalPoint,position:camera.position});v.render();}catch(_){}throw error;}
    }
    function record(v) {
      let r = records.get(v.id);
      if (!r || r.element !== v.element) {
        const previous=r;
        r = { element: v.element, mode: 'forward', loop: true, range: null, rangeRevision: 0, playDirection: 1, ticket: 0, signature: signature(v), content:contentSignature(v) }; records.set(v.id, r);
        // stopClip broadcasts synchronously. Publish the replacement first so
        // its render callback cannot retire the same old viewport recursively.
        if(previous){clearInterval(previous.volumeTimer);nativeStop.call(cine,previous.element,{viewportId:v.id});if(cine.getState().cines?.[v.id]?.isPlaying)cine.setCine({id:v.id,isPlaying:false});}
        const owns=()=>records.get(v.id)===r;
        listen(v.element, core.Enums.Events.VIEWPORT_NEW_IMAGE_SET, () => { if(!owns())return;r.signature = signature(v);r.content=r.signature;resetPlayback(r);halt(v.id);render(); });
        if(v.type==='orthographic') {
          listen(v.element, core.Enums.Events.VOLUME_VIEWPORT_NEW_VOLUME, () => { if(!owns())return;r.signature=signature(v);const content=contentSignature(v);if(r.content!==content){r.content=content;resetPlayback(r);}else resetRange(r);halt(v.id);render(); });
          listen(v.element, core.Enums.Events.CAMERA_MODIFIED, () => { if(owns()&&r.signature!==signature(v)) { r.signature=signature(v); resetRange(r); halt(v.id); render(); } });
        }
        listen(v.element, 'CORNERSTONE_CINE_TOOL_STOPPED', () => {if(owns())halt(v.id);});
      }
      return r;
    }
    function halt(id) {
      const r = records.get(id); if (r) { r.ticket = ++sequence; r.loading = false; r.authorized = false; clearInterval(r.volumeTimer); r.volumeTimer=undefined; nativeStop.call(cine, r.element, { viewportId: id }); }
      if (cine.getState().cines?.[id]?.isPlaying) cine.setCine({ id, isPlaying: false });
    }
    function haltAll() { if (halting) return; halting = true; try { records.forEach((_, id) => halt(id)); } finally { halting = false; } }
    function frameCount(v) {
      if (v.type === 'stack') return v.getImageIds?.().length || 0;
      try { const target = volumeTarget(v); return target ? volumeFrames(v, target).last + 1 : 0; } catch (_) { return 0; }
    }
    function playbackRange(r, total) {
      if (!r.range) return { first: 0, last: total - 1 };
      return r.range.first >= 0 && r.range.first < r.range.last && r.range.last < total ? r.range : null;
    }
    function showRange(r, total, bounds) {
      if (rangeShown?.record === r && rangeShown.revision === r.rangeRevision && rangeShown.total === total) return;
      rangeStart.max = rangeEnd.max = String(total); rangeStart.value = total ? String(bounds.first + 1) : ''; rangeEnd.value = total ? String(bounds.last + 1) : '';
      rangeShown = { record: r, revision: r.rangeRevision, total };
    }
    function render() {
      if (ended) return;
      const id = grid.getActiveViewportId(), v = viewport(id), supported = eligible(v);
      first.textContent=v?.type==='orthographic'?'First Plane':'First Frame';last.textContent=v?.type==='orthographic'?'Last Plane':'Last Frame';
      panel.hidden = !cine.getState().isCineEnabled || (!supported&&v?.type!=='orthographic');
      panel.style.display = panel.hidden ? 'none' : 'flex';
      direction.disabled=loop.disabled=rangeStart.disabled=rangeEnd.disabled=applyRange.disabled=!supported;
      if (!supported) { first.disabled=last.disabled=true;rangeShown=undefined;status.textContent='완전히 로드된 단일 정규 CT의 MPR 평면을 선택하고 다른 작업을 마친 뒤 재생하세요.';positionControls(v);return; }
      const r = record(v);
      if (r.signature !== signature(v)) { r.signature = signature(v);const content=contentSignature(v);if(r.content!==content){r.content=content;resetPlayback(r);}else resetRange(r);halt(id); }
      const total=frameCount(v);let bounds=playbackRange(r,total);
      if(!bounds){resetRange(r);r.message='영상 범위가 변경되어 전체 범위로 초기화했습니다.';bounds=playbackRange(r,total);}
      showRange(r,total,bounds);
      direction.value = r.mode; loop.checked = r.loop;
      first.disabled = last.disabled = r.loading || total < 1; applyRange.disabled = r.loading || total < 2;
      status.textContent = r.message || (r.loading ? '프레임 준비 중' : total<1?'재생할 프레임을 확인할 수 없습니다.':`범위 ${bounds.first+1}~${bounds.last+1}` + (v.type==='orthographic'?' · 원본 CT에서 재구성한 평면을 재생합니다.':''));
      positionControls(v);
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
      const v = core.getEnabledElement(element)?.viewport, r = records.get(v?.id || options?.viewportId);
      // A late native unmount may still carry the retired element (or only its
      // viewport id). Neither it nor nativeStop's id fallback owns a new view.
      if (r && r.element !== element) return;
      if (r) { r.ticket = ++sequence; r.loading = false; clearInterval(r.volumeTimer); r.volumeTimer=undefined; }
      return nativeStop.call(this, element, options);
    };
    cine.playClip = async function (element, options = {}) {
      const v = core.getEnabledElement(element)?.viewport;
      if (ended || document.hidden || !v) { if(v)halt(v.id); return; }
      if (v.type !== 'stack' && v.type !== 'orthographic') return nativePlay.call(this, element, options);
      const r = record(v), id = v.id, ticket = r.ticket = ++sequence, before = signature(v);
      clearInterval(r.volumeTimer);r.volumeTimer=undefined;
      const current = () => !ended && !document.hidden && r.authorized && r.ticket === ticket && records.get(id)===r && viewport(id) === v && signature(v) === before && grid.getActiveViewportId() === id && cine.getState().isCineEnabled && (v.type==='stack'||!!volumeTarget(v)?.allowed);
      if (!r.authorized || grid.getActiveViewportId() !== id) { halt(id); return; }
      records.forEach((_, other) => { if (other !== id) halt(other); });
      r.loading = true; r.message = ''; render();
      try {
        if(v.type==='orthographic') {
          const target=volumeTarget(v,true);if(!target)throw Error('완전히 로드된 정규 CT MPR 평면을 선택하세요.');
          const fps=Math.abs(Number(options.framesPerSecond||24));if(!Number.isFinite(fps)||fps<1||fps>90)throw Error('MPR 재생 속도는 1~90 fps입니다.');
          await session();if(!current())return;
          let frames=volumeFrames(v,target);const bounds=playbackRange(r,frames.last+1);if(!bounds)throw Error('MPR 재생 범위가 바뀌었습니다. 다시 적용하세요.');
          if(frames.index<bounds.first||frames.index>bounds.last){moveVolume(v,target,frames,bounds.first);frames=volumeFrames(v,target);}
          nativeStop.call(cine,element,{viewportId:id});clearInterval(r.volumeTimer);r.loading=false;
          // Anchor a physical grid at the first plane. Native cine excludes the
          // final position and its oblique scroll snap accumulates spacing drift.
          const timer=setInterval(()=>{
            if(!current()){clearInterval(timer);if(records.get(id)===r&&r.ticket===ticket){halt(id);render();}return;}
            try{
              const frames=volumeFrames(v,target);if(frames.index<bounds.first||frames.index>bounds.last){moveVolume(v,target,frames,bounds.first);return;}
              const step=kinCineNext(frames.index,bounds.first,bounds.last,r.mode,r.playDirection,r.loop);
              if(step.stop){resetDirection(r);halt(id);render();return;}r.playDirection=step.direction;moveVolume(v,target,frames,step.next);
            }catch(error){clearInterval(timer);if(records.get(id)===r){r.message=error.message||'MPR 재생을 중단했습니다.';if(r.ticket===ticket)halt(id);render();}}
          },1000/fps);r.volumeTimer=timer;render();return;
        }
        const ids = v.getImageIds(), pixels = ids.map(imageId => core.metaData.get('imagePixelModule', imageId));
        if (!kinCineWithinBudget(ids, pixels)) throw Error('재생 준비 범위는 2~500 프레임·128 MiB 이내입니다');
        await session(); if (!current()) return;
        // Finish a bounded, four-worker preparation before the native timer starts, so stop/replace cannot be undone by a late frame load.
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
          while (current() && next < ids.length) { const imageId = ids[next++]; await core.imageLoader.loadAndCacheImage(imageId); }
        }));
        if (!current()) return;
        const bounds=playbackRange(r,ids.length);if(!bounds)throw Error('재생 범위가 바뀌었습니다. 다시 적용하세요.');const currentIndex=()=>v.getTargetImageIdIndex?.()??v.getCurrentImageIdIndex?.();
        if(currentIndex()<bounds.first||currentIndex()>bounds.last){await core.utilities.jumpToSlice(v.element,{imageIndex:bounds.first});if(!current())return;}
        r.loading = false;
        if(!r.range&&r.mode!=='yoyo'){
          nativePlay.call(this, element, { ...options, framesPerSecond: Math.abs(options.framesPerSecond || 10) * (r.mode==='reverse' ? -1 : 1), loop: r.loop });
        // This pinned native API retains loop from its first play; update its public cine state on every explicit start.
          window.cornerstoneTools.utilities.cine.getToolState(element).loop = r.loop;render();return;
        }
        const fps=Math.abs(Number(options.framesPerSecond||10));if(!Number.isFinite(fps)||fps<1||fps>90)throw Error('재생 속도는 1~90 fps입니다.');
        nativeStop.call(cine,element,{viewportId:id});
        const timer=setInterval(()=>{
          if(!current()){clearInterval(timer);if(records.get(id)===r&&r.ticket===ticket){halt(id);render();}return;}
          try{
            if(core.Enums.ViewportStatus&&v.viewportStatus!==core.Enums.ViewportStatus.RENDERED)return;
            const index=currentIndex();if(index<bounds.first||index>bounds.last){core.utilities.scroll(v,{delta:bounds.first-index,debounceLoading:true});return;}
            const step=kinCineNext(index,bounds.first,bounds.last,r.mode,r.playDirection,r.loop);
            if(step.stop){resetDirection(r);halt(id);render();return;}r.playDirection=step.direction;core.utilities.scroll(v,{delta:step.next-index,debounceLoading:true});
          }catch(error){clearInterval(timer);if(records.get(id)===r){r.message=error.message||'재생을 중단했습니다.';if(r.ticket===ticket)halt(id);render();}}
        },1000/fps);r.volumeTimer=timer;
        render();
      } catch (error) {
        if (current()) { r.message = v.type==='orthographic'?(error.message||'MPR 재생을 준비할 수 없습니다.'):'재생을 준비할 수 없습니다. 로그인·영상과 500 프레임/128 MiB 제한을 확인하세요.'; halt(id); render(); }
      } finally {
        if(v.type==='orthographic'&&records.get(id)===r&&r.ticket===ticket&&!current()){halt(id);render();}
      }
    };
    const change = () => {
      const v = viewport(grid.getActiveViewportId()); if (!eligible(v)) return;
      const r = record(v), modeChanged = r.mode !== direction.value; r.mode = direction.value; r.loop = loop.checked;
      if (modeChanged) resetDirection(r);
      halt(v.id); r.message = '설정을 바꿨습니다. 재생을 눌러 시작하세요.'; render();
    };
    listen(direction, 'change', change); listen(loop, 'change', change);
    listen(applyRange,'click',()=>{
      const v=viewport(grid.getActiveViewportId());if(!eligible(v))return;const r=record(v),total=frameCount(v);
      const parse=value=>/^\d+$/.test(value)?Number(value):NaN,firstValue=parse(rangeStart.value),lastValue=parse(rangeEnd.value);
      if(!Number.isSafeInteger(firstValue)||!Number.isSafeInteger(lastValue)||firstValue<1||firstValue>=lastValue||lastValue>total){
        r.message=`재생 범위는 1~${total} 안에서 시작이 끝보다 작아야 합니다.`;render();return;
      }
      r.range={first:firstValue-1,last:lastValue-1};r.rangeRevision++;resetDirection(r);halt(v.id);r.message='범위를 적용했습니다. 재생을 눌러 시작하세요.';render();
    });
    listen(document, 'click', e => {
      if (!e.target.closest?.('[data-cy="cine-player-play-pause"]')) return;
      const v = viewport(grid.getActiveViewportId());
      if (eligible(v)) record(v).authorized = !cine.getState().cines?.[v.id]?.isPlaying;
    }, true);
    async function jump(end) {
      const v = viewport(grid.getActiveViewportId()); if (!eligible(v)) return;
      halt(v.id); const r = record(v), ticket = r.ticket = ++sequence, before = signature(v);
      if(v.type==='orthographic') {
        try{const target=volumeTarget(v,true);if(!target)throw Error('대상 MPR 평면을 다시 확인하세요.');const frames=volumeFrames(v,target),bounds=playbackRange(r,frames.last+1);if(!bounds)throw Error('MPR 재생 범위가 바뀌었습니다. 다시 적용하세요.');moveVolume(v,target,frames,end?bounds.last:bounds.first);r.message='MPR 범위 끝 위치로 이동했습니다.';}catch(error){r.message=error.message;}render();return;
      }
      const ids=v.getImageIds(),bounds=playbackRange(r,ids.length);if(!bounds){r.message='재생 범위가 바뀌었습니다. 다시 적용하세요.';render();return;}const index=end?bounds.last:bounds.first,imageId=ids[index];
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
      if (closing) { rangeShown=undefined;haltAll(); } if (!halting) render();
    }));
    const end = () => { haltAll(); ended = true; panel.style.display = 'none'; };
    listen(document, 'visibilitychange', () => { if (document.hidden) haltAll(); });
    listen(window, 'pagehide', end);
    listen(window, 'kin-volume-cine-target-ended', () => { records.forEach((_,id)=>{if(viewport(id)?.type==='orthographic')halt(id);});render(); });
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

function kinCreateDisplayScope() {
  let ready, current, epoch = 0, ended = false, listening = false, channel;
  function endSession() {
    if (ended) return; ended = true; epoch++; current?.stop(); current = null;
    window.removeEventListener('storage', storage); window.removeEventListener('pagehide', endSession);
    channel?.close(); channel = null;
  }
  function storage(event) { if (event.key === 'kin-session-ended') endSession(); }
  function watchSession() {
    if (listening) return; listening = true;
    window.addEventListener('storage', storage); window.addEventListener('pagehide', endSession);
    try { channel = new window.BroadcastChannel('kin-session'); channel.onmessage = event => { if (event.data?.type === 'session-ended') endSession(); }; } catch (_) { }
  }
  function prepare() {
    if (window.KinViewerDisplayScope) return Promise.resolve(window.KinViewerDisplayScope);
    if (!ready) ready = new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = '/worklist/hpacs-lite/viewer-display-scope.js';
      const timer = setTimeout(() => finish(new Error('표시 범위 도구를 불러오지 못했습니다. 뷰어를 다시 여세요.')), 10000);
      function finish(error) { clearTimeout(timer); script.onload = script.onerror = null; if (error) { script.remove(); reject(error); } else resolve(window.KinViewerDisplayScope); }
      script.onload = () => finish(window.KinViewerDisplayScope ? null : new Error('표시 범위 모듈을 확인할 수 없습니다.'));
      script.onerror = () => finish(new Error('표시 범위 도구를 불러오지 못했습니다. 뷰어를 다시 여세요.'));
      document.head.append(script);
    }).catch(error => { ready = null; throw error; });
    return ready;
  }
  return { id: 'kin.display-scope', onModeEnter({ servicesManager }) {
    if (ended) return; watchSession();
    const ticket = ++epoch; current?.stop(); current = null;
    prepare().then(module => {
      if (ticket !== epoch) return;
      const connected = module.create(servicesManager.services);
      if (!connected.mount()) { connected.stop(); throw new Error('표시 범위 패널을 연결하지 못했습니다.'); }
      current = connected;
    }).catch(error => { if (ticket === epoch) { const status = document.querySelector('#kin-viewer-layout-status'); if (status) status.textContent = error.message; } });
  }, onModeExit() { epoch++; current?.stop(); current = null; } };
}

// Session-only cell merge/maximize. Loaded beside the existing layout controls and
// mounted into the same panel with its own id, so the Recent Layout and Hanging
// Protocol sections keep their markup and their own tests.
function kinCreateCellMerge() {
  let ready, current, epoch = 0, ended = false, listening = false, channel;
  function endSession() {
    if (ended) return; ended = true; epoch++; current?.stop(); current = null;
    window.removeEventListener('storage', storage); window.removeEventListener('pagehide', endSession);
    channel?.close(); channel = null;
  }
  function storage(event) { if (event.key === 'kin-session-ended') endSession(); }
  function watchSession() {
    if (listening) return; listening = true;
    window.addEventListener('storage', storage); window.addEventListener('pagehide', endSession);
    try { channel = new window.BroadcastChannel('kin-session'); channel.onmessage = event => { if (event.data?.type === 'session-ended') endSession(); }; } catch (_) { }
  }
  function prepare() {
    if (window.KinViewerCellMerge) return Promise.resolve(window.KinViewerCellMerge);
    if (!ready) ready = new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = '/worklist/hpacs-lite/viewer-cell-merge.js';
      const timer = setTimeout(() => finish(new Error('칸 병합 도구를 불러오지 못했습니다. 뷰어를 다시 여세요.')), 10000);
      function finish(error) { clearTimeout(timer); script.onload = script.onerror = null; if (error) { script.remove(); reject(error); } else resolve(window.KinViewerCellMerge); }
      script.onload = () => finish(window.KinViewerCellMerge ? null : new Error('칸 병합 모듈을 확인할 수 없습니다.'));
      script.onerror = () => finish(new Error('칸 병합 도구를 불러오지 못했습니다. 뷰어를 다시 여세요.'));
      document.head.append(script);
    }).catch(error => { ready = null; throw error; });
    return ready;
  }
  return { id: 'kin.cell-merge', onModeEnter({ servicesManager }) {
    if (ended) return; watchSession();
    const ticket = ++epoch; current?.stop(); current = null;
    prepare().then(module => {
      if (ticket !== epoch) return;
      const connected = module.create(servicesManager.services);
      if (!connected.mount()) { connected.stop(); throw new Error('칸 병합 패널을 연결하지 못했습니다.'); }
      current = connected;
    }).catch(error => { if (ticket === epoch) { const status = document.querySelector('#kin-viewer-layout-status'); if (status) status.textContent = error.message; } });
  }, onModeExit() { epoch++; current?.stop(); current = null; } };
}

function kinCreateImagesOnly() {
  let ready, current, epoch = 0, ended = false, listening = false, channel;
  function endSession() {
    if (ended) return; ended = true; epoch++; current?.stop(); current = null;
    window.removeEventListener('storage', storage); window.removeEventListener('pagehide', endSession);
    channel?.close(); channel = null;
  }
  function storage(event) { if (event.key === 'kin-session-ended') endSession(); }
  function watchSession() {
    if (listening) return; listening = true;
    window.addEventListener('storage', storage); window.addEventListener('pagehide', endSession);
    try { channel = new window.BroadcastChannel('kin-session'); channel.onmessage = event => { if (event.data?.type === 'session-ended') endSession(); }; } catch (_) { }
  }
  function prepare() {
    if (window.KinViewerImagesOnly) return Promise.resolve(window.KinViewerImagesOnly);
    if (!ready) ready = new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = '/worklist/hpacs-lite/viewer-images-only.js';
      const timer = setTimeout(() => finish(new Error('Images Only 도구를 불러오지 못했습니다. 뷰어를 다시 여세요.')), 10000);
      function finish(error) { clearTimeout(timer); script.onload = script.onerror = null; if (error) { script.remove(); reject(error); } else resolve(window.KinViewerImagesOnly); }
      script.onload = () => finish(window.KinViewerImagesOnly ? null : new Error('Images Only 모듈을 확인할 수 없습니다.'));
      script.onerror = () => finish(new Error('Images Only 도구를 불러오지 못했습니다. 뷰어를 다시 여세요.'));
      document.head.append(script);
    }).catch(error => { ready = null; throw error; });
    return ready;
  }
  return { id: 'kin.images-only', onModeEnter({ servicesManager }) {
    if (ended) return; watchSession();
    const ticket = ++epoch; current?.stop(); current = null;
    prepare().then(module => {
      if (ticket !== epoch) return;
      const connected = module.create(servicesManager.services);
      if (!connected.mount()) { connected.stop(); throw new Error('Images Only 패널을 연결하지 못했습니다.'); }
      current = connected;
    }).catch(error => { if (ticket === epoch) { const status = document.querySelector('#kin-viewer-layout-status'); if (status) status.textContent = error.message; } });
  }, onModeExit() { epoch++; current?.stop(); current = null; } };
}

function kinCreateImageText() {
  let ready, current, epoch = 0, ended = false, listening = false, channel;
  function endSession() {
    if (ended) return; ended = true; epoch++; current?.stop(); current = null;
    window.removeEventListener('storage', storage); window.removeEventListener('pagehide', endSession);
    channel?.close(); channel = null;
  }
  function storage(event) { if (event.key === 'kin-session-ended') endSession(); }
  function watchSession() {
    if (listening) return; listening = true;
    window.addEventListener('storage', storage); window.addEventListener('pagehide', endSession);
    try { channel = new window.BroadcastChannel('kin-session'); channel.onmessage = event => { if (event.data?.type === 'session-ended') endSession(); }; } catch (_) { }
  }
  function prepare() {
    if (window.KinViewerImageText) return Promise.resolve(window.KinViewerImageText);
    if (!ready) ready = new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = '/worklist/hpacs-lite/viewer-image-text.js';
      const timer = setTimeout(() => finish(new Error('Image Text 도구를 불러오지 못했습니다. 뷰어를 다시 여세요.')), 10000);
      function finish(error) { clearTimeout(timer); script.onload = script.onerror = null; if (error) { script.remove(); reject(error); } else resolve(window.KinViewerImageText); }
      script.onload = () => finish(window.KinViewerImageText ? null : new Error('Image Text 모듈을 확인할 수 없습니다.'));
      script.onerror = () => finish(new Error('Image Text 도구를 불러오지 못했습니다. 뷰어를 다시 여세요.'));
      document.head.append(script);
    }).catch(error => { ready = null; throw error; });
    return ready;
  }
  return { id: 'kin.image-text', onModeEnter({ servicesManager }) {
    if (ended) return; watchSession();
    const ticket = ++epoch; current?.stop(); current = null;
    prepare().then(module => {
      if (ticket !== epoch) return;
      const connected = module.create(servicesManager.services);
      if (!connected.mount()) { connected.stop(); throw new Error('Image Text 패널을 연결하지 못했습니다.'); }
      current = connected;
    }).catch(error => { if (ticket === epoch) { const status = document.querySelector('#kin-viewer-layout-status'); if (status) status.textContent = error.message; } });
  }, onModeExit() { epoch++; current?.stop(); current = null; } };
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
  // S5-U2b(R-001 F02, R-002 F01): a document that stops being a confirmed writer (clinician-only, or a /me refused with 401/403)
  // takes the Job panel down even if a writer answer mounted it first.
  kinViewerSession.onChange(next => { if (next !== 'writer') { epoch++; current?.stop(); current = null; } });
  return { id: 'kin.viewer-jobs', preRegistration({ servicesManager }) {
    const load = name => new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = '/worklist/hpacs-lite/' + name;
      script.onload = resolve;
      script.onerror = () => reject(new Error('비교 작업 화면을 불러오지 못했습니다.')); document.head.append(script);
    });
    ready = load('viewer-volume-job.js').catch(() => {}).then(() => load('viewer-jobs.js'))
      .then(() => window.kinViewerJobs(servicesManager.services, kinViewerLayoutModel));
    ready.catch(() => {});
  }, onModeEnter() {
    const ticket = ++epoch;
    // S5-U2b: saved jobs are written and read on writer routes; only a /me that answered writer mounts the Job panel.
    kinViewerSession.decide().then(session => session === 'writer' ? ready : null).then(extension => { if (extension && ticket === epoch) { current = extension; current.mount(); } }).catch(e => {
      if (ticket === epoch) { const p = document.querySelector('#kin-viewer-layout-status'); if (p) p.textContent = e.message; }
    });
  }, onModeExit() { epoch++; current?.stop(); current = null; } };
}

// Findings live inside the Measurements panel; the dock keeps its two panels unchanged.
function kinCreateViewerFindings() {
  let ready, current, epoch = 0;
  // S5-U2b(R-001 F02, R-002 F01): a document that stops being a confirmed writer (clinician-only, or a /me refused with 401/403)
  // takes the Findings section down even if a writer answer mounted it first.
  kinViewerSession.onChange(next => { if (next !== 'writer') { epoch++; current?.stop(); current = null; } });
  return { id: 'kin.viewer-findings', preRegistration({ servicesManager }) {
    const load = name => new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = '/worklist/hpacs-lite/' + name;
      script.onload = resolve;
      script.onerror = () => reject(new Error('소견 화면을 불러오지 못했습니다. 뷰어를 다시 여세요.')); document.head.append(script);
    });
    ready = load('finding-link-model.js').then(() => load('viewer-findings.js')).then(() => {
      if (typeof window.kinViewerFindings !== 'function' || !window.kinFindingLinkModel) throw new Error('소견 화면을 불러오지 못했습니다. 뷰어를 다시 여세요.');
      return window.kinViewerFindings(servicesManager.services, window.kinFindingLinkModel);
    });
    ready.catch(() => {});
  }, onModeEnter() {
    const ticket = ++epoch;
    // S5-U2b: findings are written and linked on writer routes; only a /me that answered writer mounts the Findings section.
    kinViewerSession.decide().then(session => session === 'writer' ? ready : null).then(extension => { if (extension && ticket === epoch) { current = extension; current.mount(); } }).catch(e => {
      if (ticket !== epoch) return;
      const host = document.querySelector('#kin-viewer-history');
      if (host) { const p = document.createElement('p'); p.id = 'kin-viewer-findings-unavailable'; p.textContent = e.message; host.append(p); }
    });
  }, onModeExit() { epoch++; current?.stop(); current = null; } };
}

function kinCreateViewerTechNote() {
  let ready, current, prepare, epoch=0, active=false, state='stopped';
  // S5-U2b(R-001 F02, R-002 F01): a document that stops being a confirmed writer drops the note bridge even if a writer answer
  // connected it first; the bridge state names why ('read-only' or 'refused').
  kinViewerSession.onChange(next=>{if(next==='writer')return;epoch++;if(active)state=next;current?.stop();current=null;});
  function connect() {
    if(!active||state==='loading'||state==='ready'||!kinViewerSession.writer())return;
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
      .then(()=>standalone&&!window.KinViewerWindows?load('viewer-windows.js').catch(()=>undefined):undefined)
      .then(()=>window.KinViewerIdentity?undefined:load('viewer-identity.js'))
      .then(()=>Promise.allSettled([
        window.KinVolumeOrientation?Promise.resolve():load('volume-orientation.js'),
        typeof window.kinCreateVolumeOrientation==='function'?Promise.resolve():load('viewer-volume-orientation.js'),
        window.KinVolumeDisplay?Promise.resolve():load('volume-display.js'),
        typeof window.kinCreateVolumeDisplay==='function'?Promise.resolve():load('viewer-volume-display.js'),
        typeof window.kinCreateVolumeSync==='function'?Promise.resolve():load('viewer-volume-sync.js'),
        typeof window.kinCreateVolumeProgressive==='function'?Promise.resolve():load('viewer-volume-progressive.js'),
        window.KinVolumeMarks?Promise.resolve():load('volume-marks.js'),
        typeof window.kinCreateVolumeMarks==='function'?Promise.resolve():load('viewer-volume-marks.js'),
        window.KinVolumeCurved?Promise.resolve():load('volume-curved.js'),
        typeof window.kinCreateVolumeCurved==='function'?Promise.resolve():load('viewer-volume-curved.js'),
        window.KinVolumePath?Promise.resolve():load('volume-path.js'),
        typeof window.kinCreateVolumePath==='function'?Promise.resolve():load('viewer-volume-path.js'),
        window.KinVolumePreferences?Promise.resolve():load('volume-preferences.js'),
        typeof window.kinCreateVolumePreferences==='function'?Promise.resolve():load('viewer-volume-preferences.js'),
        window.KinVolumeCrosshair?Promise.resolve():load('volume-crosshair.js'),
        typeof window.kinCreateVolumeCrosshair==='function'?Promise.resolve():load('viewer-volume-crosshair.js'),
        window.KinVolumeBatch?Promise.resolve():load('volume-batch.js'),
        window.KinVolumeBatchScout?Promise.resolve():load('volume-batch-scout.js'),
        typeof window.kinRenderVolumeScout==='function'?Promise.resolve():load('viewer-volume-scout.js'),
        typeof window.kinCreateVolumeBatch==='function'?Promise.resolve():load('viewer-volume-batch.js')]))
      .then(()=>typeof window.kinViewerTechNote==='function'?undefined:load('viewer-tech-note.js'))
      .then(()=>window.kinViewerTechNote(servicesManager.services)).catch(e=>{ready=null;throw e;}));
    window.kinViewerNoteConnectionState=()=>state;
    window.kinViewerNoteReconnect=()=>{if(active&&state==='failed')connect();};
  },onModeEnter(){if(!prepare)return;epoch++;active=true;state='unconfirmed';const ticket=epoch;
    // S5-U2b: Tech notes are a technician record the clinician allowlist neither reads nor writes. The bridge connects only
    // after a /me answered writer; until an answer it stays 'unconfirmed', and 'read-only'/'refused' never connect.
    kinViewerSession.decide().then(session=>{if(!active||ticket!==epoch)return;if(session==='writer'){state='stopped';connect();}else state=session;});
  },onModeExit(){epoch++;active=false;state='stopped';current?.stop();current=null;}};
}

function kinCreateFrameCoverage() {
  let ready, current, services, epoch=0;
  return {id:'kin.frame-coverage',preRegistration({servicesManager}) {
    services=servicesManager.services;
    ready=new Promise((resolve,reject)=>{
      const script=document.createElement('script');script.src='/worklist/hpacs-lite/viewer-frame-coverage.js';
      const timeout=setTimeout(()=>reject(Error('Frame Coverage loading timeout')),20000);
      script.onload=()=>{clearTimeout(timeout);resolve();};script.onerror=()=>{clearTimeout(timeout);reject(Error('Frame Coverage loading failed'));};document.head.append(script);
    });ready.catch(()=>{});
  },onModeEnter(){
    const ticket=++epoch;
    window.kinViewerFrameCoverageState=()=>({warn:true,phase:'unverified'});
    window.kinViewerFrameCoverageConfirm=ask=>(ask||window.confirm)('원본 프레임 표시 확인을 연결하지 못했습니다. 이 영상을 떠날까요?');
    ready.then(()=>{if(ticket===epoch)current=window.KinFrameCoverage.mount(services);}).catch(()=>{
      if(ticket===epoch){const status=document.querySelector('#kin-viewer-layout-status');if(status)status.textContent='Frame Coverage를 연결하지 못했습니다. 영상 작업을 저장한 뒤 뷰어를 다시 여세요.';}
    });
  },onModeExit(){epoch++;current?.stop();current=null;}};
}

/* REQ-D-3D-CURSOR 연결 경로. 이 확장은 3D Cursor 모듈 두 개를 불러 컨트롤러를 붙이고
   렌더러의 사건을 컨트롤러의 refresh()로 옮기는 일만 한다. 도구를 켜거나 끄지 않고,
   주석을 만들지 않으며, 저장소에 쓰지 않는다.
   평가 빌드에 커밋되는 플래그는 false다. 켜는 수단은 window.config의 리터럴 하나뿐이고
   URL 매개변수·localStorage·전역 토글 같은 런타임 우회 경로는 두지 않는다. OFF면
   preRegistration에서 스크립트를 주입하지 않으므로 모듈 전역도 패널도 생기지 않는다. */
function kinCreateThreeDCursor() {
  let services, ready = null, current = null, epoch = 0, ended = false, listening = false, channel = null;
  let rows = [], owner = null, mark = null, listeners = [], mounts = 0, renders = 0, invalidations = 0;
  /* 종료는 이 호스트가 소유한다. retiring은 아직 끝나지 않은 disable→stop이고, blocked는 그
     종료가 미완료(unsettled)이거나 예외로 끝나 이 뷰어 창에서 모드가 영구 불가가 된 상태다.
     컨트롤러 안의 poisoned는 인스턴스와 함께 사라지므로 창 단위 기억은 여기에만 있고, 그래서
     retire()는 컨트롤러를 버리기 전에 그 인스턴스의 오염을 읽어 여기로 올린다(:2308-2325). */
  let retiring = null, blocked = false;
  // 'true'가 아닌 모든 값(누락·문자열 'true'·1)은 OFF다.
  const on = () => window.config?.kinThreeDCursor?.enabled === true;
  const say = text => { const node = document.querySelector('#kin-viewer-layout-status'); if (node) node.textContent = text; };
  // mountProtocols() :1436-1448과 같은 형태. 이미 로드된 전역이 있으면 다시 주입하지 않는다.
  const load = (name, global) => window[global] ? Promise.resolve() : new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = '/worklist/hpacs-lite/' + name;
    const finish = error => { clearTimeout(timer); script.onload = script.onerror = null; error ? reject(error) : resolve(); };
    const timer = setTimeout(() => finish(new Error('3D Cursor 연결이 지연되어 중단했습니다.')), 20000);
    script.onload = () => finish(window[global] ? null : new Error('3D Cursor 모듈을 확인할 수 없습니다.'));
    script.onerror = () => finish(new Error('3D Cursor 모듈을 불러오지 못했습니다.'));
    document.head.append(script);
  });
  async function get(path) {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error('검사 접근 정보를 확인할 수 없습니다.');
    return await response.json();
  }
  const ownerOf = me => me?.kind === 'member' && me.institution && me.sub ? JSON.stringify([me.institution, me.sub]) : null;

  /* view(info) :1611-1614과 같은 이유의 렌더링엔진 대조: grid가 기록한 viewportId로 얻은
     뷰포트가 이 그리드를 그리는 엔진의 것이 아니면 그 pane은 버린다. 남은 판정(type,
     stack 내용, 앵커)은 컨트롤러가 한다. */
  function panes() {
    const grid = services.viewportGridService, cornerstoneViewports = services.cornerstoneViewportService;
    let engineId = null;
    try { engineId = cornerstoneViewports.getRenderingEngine?.()?.id || null; } catch (_) { engineId = null; }
    const list = [];
    for (const record of grid.getState().viewports.values()) {
      const viewport = cornerstoneViewports.getCornerstoneViewport(record.viewportId);
      const element = document.querySelector('[data-viewport-uid="' + record.viewportId + '"]');
      // 컨트롤러도 stack이 아닌 것을 거절하지만, 후보 목록에 넣지 않는 편이 조용한 탈락과
      // 거절 사유를 헷갈리게 하지 않는다.
      if (!viewport || !element || viewport.type !== 'stack') continue;
      let paneEngine = null;
      try { paneEngine = viewport.getRenderingEngine()?.id || null; } catch (_) { continue; }
      if (!paneEngine || (engineId && paneEngine !== engineId)) continue;
      list.push({ id: record.viewportId, element, viewport });
    }
    return list;
  }

  const numbers = value => Array.isArray(value) ? value.map(Number) : value;
  /* 환자 키는 인증된 /api/studies 행에서만 온다(:1617). DICOM PatientID는 제품의 식별
     경계가 아니므로 태그에서 유도하지 않으며, 행이 없으면 null을 돌려 pane을 거절시킨다. */
  function meta(imageId) {
    const core = window.cornerstone;
    const instance = core?.metaData?.get('instance', imageId);
    if (!instance) return null;
    const plane = core.metaData.get('imagePlaneModule', imageId) || {};
    const patient = rows.find(row => row.uid === instance.StudyInstanceUID)?.sourcePatientKey;
    if (!patient) return null;
    return {
      StudyInstanceUID: instance.StudyInstanceUID, SeriesInstanceUID: instance.SeriesInstanceUID,
      SOPInstanceUID: instance.SOPInstanceUID, FrameOfReferenceUID: instance.FrameOfReferenceUID,
      sourcePatientKey: patient, Modality: instance.Modality,
      ImageOrientationPatient: numbers(instance.ImageOrientationPatient ?? plane.imageOrientationPatient),
      ImagePositionPatient: numbers(instance.ImagePositionPatient ?? plane.imagePositionPatient),
      PixelSpacing: numbers(instance.PixelSpacing ?? plane.pixelSpacing),
      Rows: Number(instance.Rows ?? plane.rows), Columns: Number(instance.Columns ?? plane.columns), imageId };
  }

  /* 직렬화된 세 값 중 하나라도 바뀌면 컨트롤러가 진행 중인 run을 취소한다. owner는 :1605의
     ownerOf, tool은 :948과 같은 getActivePrimaryMouseButtonTool이다. 제품은 뷰어 창에
     읽을 수 있는 세션 식별자를 노출하지 않으므로 session은 이 창의 모드 진입 표식이며,
     세션 종료·모드 이탈에서 컨트롤러 자체가 내려가므로 그 경계와 같은 값이다. */
  function context() {
    if (!owner || !mark) return null;
    let tool = null;
    try {
      const active = services.viewportGridService.getActiveViewportId();
      const viewport = active && services.cornerstoneViewportService.getCornerstoneViewport(active);
      const group = viewport && window.cornerstoneTools.ToolGroupManager.getToolGroupForViewport(viewport.id, viewport.renderingEngineId);
      tool = group?.getActivePrimaryMouseButtonTool() || null;
    } catch (_) { tool = null; }
    return { owner, session: mark, tool };
  }

  /* 확정은 끝까지 컨트롤러 안의 rendered() 폴링이다. IMAGE_RENDERED는 그 대기를 줄이고,
     STACK_NEW_IMAGE·grid 변경·CAMERA_MODIFIED는 표식을 무효화한다. STACK_NEW_IMAGE는
     render 앞에 발화하므로 확정 신호로 쓰지 않는다(B8 §2). */
  function bind() {
    const core = window.cornerstone;
    const listen = (target, type, handler, capture) => {
      target.addEventListener(type, handler, capture);
      listeners.push(() => target.removeEventListener(type, handler, capture));
    };
    const rendered = () => { renders++; current?.refresh(); };
    const invalidate = () => { invalidations++; current?.refresh(); };
    // viewer-frame-coverage.js:141/146과 같은 document capture.
    listen(document, core.Enums.Events.IMAGE_RENDERED, rendered, true);
    listen(document, core.Enums.Events.STACK_NEW_IMAGE, invalidate, true);
    listen(document, core.Enums.Events.CAMERA_MODIFIED, invalidate, true);
    // kinCreateViewerHistory :1326-1329의 grid 구독 관례. 해제는 같은 배열이 가진다.
    for (const event of Object.values(services.viewportGridService.EVENTS)) {
      const subscription = services.viewportGridService.subscribe(event, invalidate);
      listeners.push(() => subscription.unsubscribe());
    }
  }
  function unbind() {
    const pending = listeners; listeners = [];
    for (const off of pending) { try { off(); } catch (_) {} }
  }

  function retire() {
    epoch++; unbind();
    const gone = current; current = null; mark = null;
    if (!gone) return;
    /* 이탈은 disable() 뒤 stop()이다. 둘 중 하나라도 'unsettled'를 돌려주거나 동기 예외·
       reject로 끝나면 취소할 수 없는 native 요청이 남은 것이므로 그 창에서 모드는 영구
       불가다. 호스트는 재마운트로 그것을 되돌리지 않으며, 뒤따르는 정리가 성공해도 이미
       세워진 차단을 지우지 않는다. 정리 자체는 오류 뒤에도 이어서 시도한다. */
    const step = call => Promise.resolve().then(call).then(
      result => { if (result === 'unsettled') blocked = true; }, () => { blocked = true; });
    /* 반환값만으로는 부족하다. 패널의 토글은 호스트를 거치지 않고 스스로 disable('off')을
       부를 수 있고, 그 종료가 미완료로 끝나면 기록은 그 인스턴스 안의 poisoned에만 남는다.
       뒤늦게 진행 중이던 요청이 정리되고 나면 호스트의 disable·stop은 이미 끝난 종료를 보고
       'idle'을 돌려주므로, 결과만 읽는 호스트는 그 미완료를 영원히 보지 못한 채 새 컨트롤러를
       올린다. 그래서 교체 전후로 컨트롤러 상태를 직접 읽어 창 단위 기억으로 올린다. 상태를
       읽지 못한 것은 안전을 확인하지 못한 것이므로 조용히 재마운트를 허용하지 않고 막는다. */
    const inspect = () => {
      let seen = null;
      try { seen = gone.state(); } catch (_) { blocked = true; return; }
      if (!seen || typeof seen !== 'object') { blocked = true; return; }
      if (seen.poisoned || seen.teardown === 'unsettled') blocked = true;
    };
    // 종료끼리 겹치지 않게 이어 붙이고, 끝나기 전에는 새 mount가 생기지 않게 보관한다.
    const run = (retiring || Promise.resolve())
      .then(inspect)
      .then(() => step(() => gone.disable('off')))
      .then(() => step(() => gone.stop()))
      .then(inspect);
    retiring = run;
    run.then(() => { if (retiring === run) retiring = null; });
  }
  function endSession() {
    if (ended) return; ended = true;
    retire();
    window.removeEventListener('storage', onStorage); window.removeEventListener('pagehide', endSession);
    channel?.close(); channel = null;
  }
  function onStorage(event) { if (event.key === 'kin-session-ended') endSession(); }
  function watchSession() {
    if (listening) return; listening = true;
    // kinCreateCTSync :1657-1660 + kinCreateImageText :2028-2040의 pagehide 포함 형태.
    window.addEventListener('storage', onStorage); window.addEventListener('pagehide', endSession);
    try { channel = new window.BroadcastChannel('kin-session'); channel.onmessage = event => { if (event.data?.type === 'session-ended') endSession(); }; } catch (_) {}
  }

  return {
    id: 'kin.three-d-cursor',
    preRegistration({ servicesManager }) {
      services = servicesManager.services;
      if (!on()) return;
      ready = load('three-d-cursor-model.js', 'KinThreeDCursorModel')
        .then(() => load('viewer-three-d-cursor.js', 'KinViewerThreeDCursor'));
      ready.catch(() => {});
      // 다른 확장과 같은 읽기 전용 관측 창구다. 여기서 기능을 켜거나 끌 수 없다.
      window.kinViewerThreeDCursorState = () => ({
        mounts, renders, invalidations, listeners: listeners.length, ended, blocked,
        retiring: !!retiring, mounted: !!current, cursor: current ? current.state() : null });
    },
    onModeEnter() {
      if (!ready || ended || blocked) return;
      // kinCreateFrameCoverage :2171-2175의 티켓 관례. 늦게 도착한 then은 버린다.
      const ticket = ++epoch;
      watchSession();
      // 이전 종료가 끝난 뒤에만 mount한다. 종료를 기다리는 동안 여러 번 진입해도 표가 가장
      // 나중인 요청 하나만 남아 재개하므로, 사용자는 모드를 다시 고르지 않아도 된다.
      ready.then(() => retiring).then(async () => {
        if (ticket !== epoch || ended || blocked) return;
        const me = await get('/api/me');
        const next = ownerOf(me);
        // 늦게 끝난 이전 진입이 최신 목록을 덮지 않도록 표를 확인한 뒤에만 옮긴다.
        const studies = (await get('/api/studies')).studies || [];
        if (ticket !== epoch || ended || blocked || !next) return;
        rows = studies; owner = next; mark = 'kin3d-mode-' + ticket;
        if (current) return;
        current = window.KinViewerThreeDCursor.mount(
          { panes, meta, context, host: document.querySelector('#kin-viewer-layout') });
        mounts++;
        bind();
      }).catch(() => { if (ticket === epoch) say('3D Cursor를 연결하지 못했습니다. 영상 작업을 저장한 뒤 뷰어를 다시 여세요.'); });
    },
    onModeExit() { retire(); },
  };
}

function kinDicomPdfViewportGuard(extensionManager, options) {
  options = options || {};
  const entryId = '@ohif/extension-dicom-pdf.viewportModule.dicom-pdf';
  const handlerId = '@ohif/extension-dicom-pdf.sopClassHandlerModule.dicom-pdf';
  const pdfSop = '1.2.840.10008.5.1.4.1.1.104.1';
  const objectIds = new WeakMap(); let nextObjectId = 0, patch = null, active = false, epoch = 0;
  let cache = new WeakMap(), sessionChannel = null, listening = false; const pending = new Set(), records = new Set(), activationWaiters = new Set();
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 10000;
  const validUid = item => typeof item === 'string' && item.length <= 64 && /^\d+(?:\.\d+)+$/.test(item);
  function sourceOf(props) {
    const values = props?.displaySets;
    if (!Array.isArray(values) || values.length !== 1) return null;
    const value = values[0], instance = value?.instance;
    if (!value || typeof value.displaySetInstanceUID !== 'string' || !value.displaySetInstanceUID ||
        value.SOPClassHandlerId !== handlerId || value.SOPClassUID !== pdfSop || !instance || instance.SOPClassUID !== pdfSop ||
        ![value.StudyInstanceUID, value.SeriesInstanceUID, value.SOPInstanceUID].every(validUid) ||
        instance.StudyInstanceUID !== value.StudyInstanceUID || instance.SeriesInstanceUID !== value.SeriesInstanceUID ||
        instance.SOPInstanceUID !== value.SOPInstanceUID || instance.MIMETypeOfEncapsulatedDocument !== 'application/pdf' ||
        instance.EncapsulatedDocument?.InlineBinary || instance.EncapsulatedDocument?.DirectRetrieveURL) return null;
    const pdfUrl = value.pdfUrl; let urlIdentity;
    if ((typeof pdfUrl === 'object' && pdfUrl !== null) || typeof pdfUrl === 'function') {
      if (!objectIds.has(pdfUrl)) objectIds.set(pdfUrl, ++nextObjectId);
      urlIdentity = ['object', objectIds.get(pdfUrl)];
    } else if (typeof pdfUrl === 'string' && pdfUrl) urlIdentity = ['value', pdfUrl];
    else return null;
    const key = JSON.stringify(['kin-pdf-source-v2', value.displaySetInstanceUID, value.StudyInstanceUID,
      value.SeriesInstanceUID, value.SOPInstanceUID, urlIdentity]);
    return { value, instance, pdfUrl, key };
  }
  function matches(source) {
    const current = sourceOf({ displaySets: [source.value] });
    return !!current && current.key === source.key && current.pdfUrl === source.pdfUrl;
  }
  async function json(result) { try { return await result.json(); } catch (_) { throw new Error('원본 PDF 확인 응답이 올바르지 않습니다.'); } }
  function requireReply(reply, message) {
    if (reply?.ok) return reply;
    const error = new Error(message);
    error.retryable = !reply || reply.status === 429 || reply.status >= 500;
    throw error;
  }
  function ownerOf(value) {
    return value && value.kind === 'member' && typeof value.institution === 'string' && value.institution &&
      typeof value.sub === 'string' && value.sub ? { institution: value.institution, sub: value.sub } : null;
  }
  function sameOwner(a, b) { return !!a && !!b && a.institution === b.institution && a.sub === b.sub; }
  function assertLive(source, ticket, controller) {
    if (!active || ticket !== epoch || controller.signal.aborted || !matches(source)) throw new Error('선택한 원본 문서가 변경되었습니다.');
  }
  function waitForActivation(ticket, controller) {
    if (active && ticket === epoch) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = { ticket, resolve, reject }; activationWaiters.add(waiter);
      controller.signal.addEventListener('abort', () => { activationWaiters.delete(waiter); reject(new Error('원본 PDF 준비가 중단되었습니다.')); }, { once: true });
    });
  }
  async function resolveAttempt(source, ticket, controller) {
      const raw = await source.pdfUrl; assertLive(source, ticket, controller);
      if (typeof raw !== 'string') throw new Error('원본 PDF 경로를 확인할 수 없습니다.');
      const root = globalThis.location, parsed = new URL(raw, root.href);
      const rendered = '/dicom-web/studies/' + source.value.StudyInstanceUID + '/series/' + source.value.SeriesInstanceUID + '/instances/' + source.value.SOPInstanceUID + '/rendered';
      if (parsed.origin !== root.origin || parsed.pathname !== rendered || parsed.search || parsed.hash || parsed.username || parsed.password) throw new Error('원본 PDF 경로를 확인할 수 없습니다.');
      const init = (method = 'GET', body) => ({ method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: { 'X-KIN-CSRF': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const firstReply = requireReply(await fetch('/api/me', init()), '로그인 세션을 확인할 수 없습니다.'); assertLive(source, ticket, controller);
      const first = ownerOf(await json(firstReply)); assertLive(source, ticket, controller);
      if (!first) throw new Error('로그인 세션을 확인할 수 없습니다.');
      const lookupReply = requireReply(await fetch('/api/dicom/lookup', init('POST', { studyUid: source.value.StudyInstanceUID, sopUid: source.value.SOPInstanceUID })), '원본 PDF 식별을 확인할 수 없습니다.'); assertLive(source, ticket, controller);
      const lookup = await json(lookupReply); assertLive(source, ticket, controller);
      if (!lookup || Object.keys(lookup).length !== 1 || typeof lookup.id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{8}){4}$/.test(lookup.id)) throw new Error('원본 PDF 식별을 확인할 수 없습니다.');
      const lastReply = requireReply(await fetch('/api/me', init()), '로그인 세션을 확인할 수 없습니다.'); assertLive(source, ticket, controller);
      const last = ownerOf(await json(lastReply)); assertLive(source, ticket, controller);
      if (!sameOwner(first, last)) throw new Error('계정이 변경되어 원본 PDF를 표시하지 않았습니다.');
      return root.origin + '/instances/' + lookup.id + '/pdf';
  }
  async function resolve(source, ticket, controller) {
    await waitForActivation(ticket, controller); assertLive(source, ticket, controller);
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { const error = new Error('원본 PDF 확인 시간이 지났습니다. 다시 시도하세요.'); error.retryable = true; reject(error); controller.abort(); }, timeoutMs); });
    try { return await Promise.race([resolveAttempt(source, ticket, controller), deadline]); }
    catch (error) { if (error?.name === 'TypeError') error.retryable = true; throw error; }
    finally { clearTimeout(timer); pending.delete(controller); }
  }
  function start(record) {
    const controller = new AbortController(); record.controller = controller; record.failed = false; pending.add(controller);
    resolve(record.source, record.ticket, controller).then(value => { if (!record.settled) { record.settled = true; records.delete(record); record.resolve(value); options.onSuccess?.(record.source.value, record.original); } }, error => {
      if (!record.settled && error?.retryable && active && record.ticket === epoch && matches(record.source)) { record.failed = true; options.onFailure?.(error, record.source.value, record.original); }
      else if (!record.settled) { record.settled = true; records.delete(record); record.reject(error); }
    });
  }
  function resolvedSource(source) {
    let record = cache.get(source.value);
    if (record?.key === source.key && record.original === source.pdfUrl) return record;
    if (record && !record.settled) { record.controller?.abort(); record.settled = true; records.delete(record); record.reject(new Error('선택한 원본 문서가 변경되었습니다.')); }
    let fulfill, reject; const promise = new Promise((resolve, fail) => { fulfill = resolve; reject = fail; }); promise.catch(() => {});
    record = { key: source.key, original: source.pdfUrl, source, ticket: epoch, promise, resolve: fulfill, reject, failed: false, settled: false, controller: null };
    cache.set(source.value, record); records.add(record); start(record); return record;
  }
  function install() {
    if (patch && patch.entry.component === patch.wrapper) return true;
    const entry = extensionManager?.getModuleEntry?.(entryId);
    if (!entry || typeof entry.component !== 'function') return false;
    const original = entry.component;
    const wrapper = function(props) {
      const source = sourceOf(props); if (!source) return null;
      const record = resolvedSource(source), key = JSON.stringify([source.key, 'lifecycle', epoch]);
      const element = original.call(this, { ...props, displaySets: [{ ...source.value, pdfUrl: record.promise }], key });
      return element && element.key === key ? element : null;
    };
    entry.component = wrapper;
    if (entry.component !== wrapper) return false;
    patch = { entry, original, wrapper }; return true;
  }
  function ownsWrapper() { return !!patch && patch.entry.component === patch.wrapper; }
  function sessionEnded() { deactivate(); options.onSessionEnd?.(); }
  const storageEnded = event => { if (event.key === 'kin-session-ended') sessionEnded(); };
  function listen() { if (listening) return; listening = true; globalThis.addEventListener?.('storage', storageEnded); try { sessionChannel = new BroadcastChannel('kin-session'); sessionChannel.onmessage = event => { if (event.data?.type === 'session-ended') sessionEnded(); }; } catch (_) {} }
  function unlisten() { if (!listening) return; listening = false; globalThis.removeEventListener?.('storage', storageEnded); sessionChannel?.close(); sessionChannel = null; }
  function activate() { active = true; listen(); for (const waiter of [...activationWaiters]) { if (waiter.ticket === epoch) waiter.resolve(); else waiter.reject(new Error('원본 PDF 준비가 중단되었습니다.')); activationWaiters.delete(waiter); } }
  function retry(value, pdfUrl) { for (const record of records) if (record.failed && !record.settled && record.ticket === epoch && matches(record.source) && (!value || record.source.value === value && record.original === pdfUrl)) start(record); }
  function deactivate() {
    active = false; epoch++; unlisten(); cache = new WeakMap(); for (const item of pending) item.abort(); pending.clear();
    for (const waiter of activationWaiters) waiter.reject(new Error('원본 PDF 준비가 중단되었습니다.')); activationWaiters.clear();
    for (const record of records) if (!record.settled) { record.settled = true; record.reject(new Error('원본 PDF 준비가 중단되었습니다.')); } records.clear();
  }
  function dispose() { deactivate(); if (patch && patch.entry.component === patch.wrapper) patch.entry.component = patch.original; patch = null; }
  return { install, ownsWrapper, activate, deactivate, retry, dispose };
}

function kinCreateDicomPdf() {
  let services, ready, current, viewportGuard, nativeErrors = new WeakMap(), epoch = 0;
  function retire() { epoch++; nativeErrors = new WeakMap(); current?.stop(); current = null; }
  function prepare() {
    if (window.KinDicomPdf) return Promise.resolve(window.KinDicomPdf);
    if (!ready) ready = new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = '/worklist/hpacs-lite/viewer-dicom-pdf.js';
      const finish = error => { clearTimeout(timer); script.onload = script.onerror = null; script.remove(); error ? reject(error) : resolve(window.KinDicomPdf); };
      const timer = setTimeout(() => finish(new Error('원본 PDF 도구 연결 시간이 지났습니다. 뷰어를 다시 여세요.')), 10000);
      script.onload = () => finish(window.KinDicomPdf?.create ? null : new Error('원본 PDF 도구를 확인할 수 없습니다.'));
      script.onerror = () => finish(new Error('원본 PDF 도구를 불러오지 못했습니다. 뷰어를 다시 여세요.'));
      document.head.append(script);
    }).catch(error => { ready = null; throw error; });
    return ready;
  }
  return { id: 'kin.source-pdf', preRegistration({ servicesManager, extensionManager }) {
    services = servicesManager.services;
    if (extensionManager) { viewportGuard = kinDicomPdfViewportGuard(extensionManager, { onSessionEnd: retire,
      onFailure: (error, value, pdfUrl) => { nativeErrors.set(value, { pdfUrl, error }); current?.nativeFailure?.(error, value, pdfUrl); },
      onSuccess: (value, pdfUrl) => { if (nativeErrors.has(value)) nativeErrors.delete(value); current?.nativeReady?.(value, pdfUrl); }
    }); if (!viewportGuard.install()) throw new Error('원본 PDF 화면을 안전하게 연결하지 못했습니다. 뷰어를 다시 여세요.'); }
  },
    onModeEnter() {
      if (viewportGuard && !viewportGuard.ownsWrapper() && !viewportGuard.install()) { const status = document.querySelector('#kin-viewer-layout-status'); if (status) status.textContent = '원본 PDF 화면을 안전하게 연결하지 못했습니다. 뷰어를 다시 여세요.'; return; }
      viewportGuard?.activate();
      const ticket = ++epoch; current?.stop(); current = null;
      prepare().then(module => { if (ticket === epoch) { current = module.create(services, {
        nativeFailureFor: (value, pdfUrl) => { const saved = nativeErrors.get(value); return saved?.pdfUrl === pdfUrl ? saved.error : null; },
        onRetry: (value, pdfUrl) => viewportGuard?.retry(value, pdfUrl)
      }); current.mount(); } }).catch(error => {
        if (ticket === epoch) { const status = document.querySelector('#kin-viewer-layout-status'); if (status) status.textContent = error.message; }
      });
    },
    onModeExit() { viewportGuard?.deactivate(); retire(); },
  };
}

/* S3-U5 CI1. OHIF 3.9.1 로더는 시리즈 메타데이터 GET 하나가 거절되면 다시 묻지 않고 검사 캐시에 거절된 약속을
   남긴다(retrieveMetadataLoaderAsync.js:65-83, retrieveStudyMetadata.js:30-32). 그래서 서버의 500 한 번에 현재 검사
   칸이 빈 채로 끝났다. 설정에서 닿는 재시도 지점이 없으므로 이번 모드 수명주기의 WADO 클라이언트 인스턴스 하나에만
   공개 메서드 retrieveSeriesMetadata를 자기 속성으로 씌우고, 나갈 때 그 속성이 아직 이 확장의 것일 때만 지운다.
   prototype·전역 fetch/XHR은 건드리지 않는다.
   - 다시 묻는 것은 HTTP 500~599로 거절된 GET뿐이다. 0(중단·연결 오류)·4xx(401/403/404/429 포함)·동기 예외는 원래
     결과를 그대로 돌려준다. (수명주기, 검사, 시리즈)마다 한 번, 고정 1000ms 뒤, 같은 this·options로 보낸다.
   - 로더가 쥐는 약속은 여기서 돌려준 하나뿐이다. 다시 받은 응답으로 그 약속을 한 번 채우므로 storeInstances·표시 세트·
     HP 적용도 한 번만 일어난다. 끝난 실패는 마지막 오류로 거절하고 영상이 준비된 척하지 않는다.
   - URL의 검사 목록과 수명주기에 묶는다. 나가거나 URL이 바뀌면 기다리던 재요청은 보내지 않고 원래 오류로 끝내며
     알림도 남기지 않는다.
   - 실패는 URL 순서의 검사 번호와 HTTP 상태로만 알린다. UID·환자 정보는 쓰지 않는다.
   - 모양이 예상과 다르면 씌우지 않고 기본 동작을 둔 채 그 사실만 표시한다. */
function kinCreateSeriesMetadataRecovery() {
  const retryDelay = 1000, own = (target, key) => Object.prototype.hasOwnProperty.call(target, key);
  let services = null, extensions = null, ticket = null, phase = 'stopped';
  const retryable = error => !!error && typeof error === 'object' && !!error.request &&
    Number.isInteger(error.status) && error.status >= 500 && error.status <= 599;
  function studiesOf(search) {
    const list = [];
    for (const value of new URLSearchParams(search).getAll('StudyInstanceUIDs'))
      for (const uid of value.split(',')) if (uid && !list.includes(uid)) list.push(uid);
    return list;
  }
  // 다른 확장이 함께 쓰는 #kin-viewer-layout-status 문구를 덮지 않도록 같은 상태 패널 안의 자기 줄만 쓴다.
  function say(text) {
    let node = document.querySelector('#kin-series-metadata-status');
    if (!text) { node?.remove(); return; }
    if (!node) {
      const panel = document.querySelector('#kin-viewer-layout'); if (!panel) return;
      node = document.createElement('p'); node.id = 'kin-series-metadata-status'; node.setAttribute('role', 'alert');
      node.style.cssText = 'margin:6px 0;color:#ffb4a8'; panel.append(node);
    }
    node.textContent = text;
  }
  function describe(failure) {
    const code = Number.isInteger(failure.status) && failure.status > 0 ? 'HTTP ' + failure.status : '요청 오류';
    if (failure.status === 401 || failure.status === 403) return failure.position + '번째 검사의 영상 정보에 접근할 수 없습니다(' + code + '). 이 검사 영상은 표시하지 않았습니다.';
    return failure.position + '번째 검사의 영상 정보를 ' + (failure.retried ? '한 번 다시 요청했지만 ' : '') +
      '불러오지 못했습니다(' + code + '). 이 검사 영상은 표시하지 않았습니다. 뷰어를 다시 여세요.';
  }
  function render(current) {
    const failures = [...current.failures.values()].sort((a, b) => a.position - b.position);
    say([...new Set(failures.map(describe))].join(' '));
  }
  function release() {
    const current = ticket; ticket = null; phase = 'stopped'; say('');
    if (!current) return;
    for (const wait of current.waits) { clearTimeout(wait.timer); wait.cancel(); }
    current.waits.clear(); current.failures.clear();
    if (own(current.client, 'retrieveSeriesMetadata') && current.client.retrieveSeriesMetadata === current.wrapper) delete current.client.retrieveSeriesMetadata;
  }
  function install() {
    const search = location.search, studies = studiesOf(search);
    const refuse = () => { phase = 'refused'; say('영상 정보 재요청 기능을 연결하지 못했습니다. 기본 동작으로 계속 표시하며, 영상 칸이 비어 있으면 뷰어를 다시 여세요.'); };
    let client = null, config = null;
    try {
      const source = extensions?.getActiveDataSource?.()?.[0];
      client = typeof source?.retrieve?.getWadoDicomWebClient === 'function' ? source.retrieve.getWadoDicomWebClient() : null;
      config = typeof source?.getConfig === 'function' ? source.getConfig() : null;
    } catch (_) { client = null; }
    // 지연 로드가 꺼져 있으면 로더가 이 메서드를 부르지 않으므로 복구가 성립하지 않는다.
    if (!client || typeof client !== 'object' || typeof client.retrieveSeriesMetadata !== 'function' ||
        own(client, 'retrieveSeriesMetadata') || config?.enableStudyLazyLoad !== true || !studies.length) return refuse();
    const original = client.retrieveSeriesMetadata;
    const current = { client, wrapper: null, used: new Set(), waits: new Set(), failures: new Map(), retries: 0 };
    const live = () => ticket === current && location.search === search;
    const succeed = key => { if (live() && current.failures.delete(key)) render(current); };
    const fail = (key, position, error, retried) => {
      if (!live()) return;
      const fresh = !current.failures.has(key);
      current.failures.set(key, { position, status: error?.status, retried: retried || !!current.failures.get(key)?.retried });
      render(current);
      if (!fresh) return;
      try { services?.uiNotificationService?.show?.({ title: 'Image Loading', message: describe(current.failures.get(key)), type: 'error' }); } catch (_) {}
    };
    current.wrapper = function retrieveSeriesMetadata(options) {
      // 동기 예외와 약속이 아닌 반환은 원래 메서드의 것 그대로 나간다.
      const first = original.call(this, options);
      const study = options?.studyInstanceUID, series = options?.seriesInstanceUID, position = studies.indexOf(study) + 1;
      if (!live() || !position || typeof series !== 'string' || !series || typeof first?.then !== 'function') return first;
      const self = this, key = JSON.stringify([study, series]);
      return new Promise((resolve, reject) => {
        first.then(value => { resolve(value); succeed(key); }, error => {
          // 예산은 첫 거절 때 잡는다. 같은 키의 반복·동시 요청은 예산을 새로 만들지 못한다.
          if (!live() || !retryable(error) || current.used.has(key)) { reject(error); fail(key, position, error, false); return; }
          current.used.add(key);
          const wait = { cancel: () => reject(error) };
          wait.timer = setTimeout(() => {
            current.waits.delete(wait);
            if (!live()) { reject(error); return; }
            current.retries++;
            let again;
            try { again = original.call(self, options); } catch (thrown) { reject(thrown); fail(key, position, thrown, true); return; }
            Promise.resolve(again).then(value => { resolve(value); succeed(key); }, final => { reject(final); fail(key, position, final, true); });
          }, retryDelay);
          current.waits.add(wait);
        });
      });
    };
    try { Object.defineProperty(client, 'retrieveSeriesMetadata', { configurable: true, writable: true, enumerable: false, value: current.wrapper }); } catch (_) {}
    if (!own(client, 'retrieveSeriesMetadata') || client.retrieveSeriesMetadata !== current.wrapper) return refuse();
    ticket = current; phase = 'installed';
  }
  const state = () => ({ phase, pending: ticket ? ticket.waits.size : 0, retries: ticket ? ticket.retries : 0, errors: ticket ? ticket.failures.size : 0 });
  return {
    id: 'kin.series-metadata-recovery',
    preRegistration({ servicesManager, extensionManager }) {
      services = servicesManager?.services || null; extensions = extensionManager || null;
      window.kinSeriesMetadataRecoveryState = state;
    },
    onModeEnter() { release(); install(); },
    onModeExit() { release(); },
  };
}

window.config = {
  extensions: [kinStackPrecision, kinCreateSRProvenance(), kinCreateViewerHistory(), kinCreateViewerFindings(), kinCreateViewerLayout(), kinCreateViewerJobs(), kinCreateViewerTechNote(), kinCreateFrameCoverage(), '@ohif/extension-dicom-pdf', kinCreateDicomPdf(), kinCreateCTSync(), kinCreateCine(), kinCreateDisplayScope(), kinCreateCellMerge(), kinCreateImagesOnly(), kinCreateImageText(), kinCreateCTPresets(), kinCreateThreeDCursor(), kinCreateSeriesMetadataRecovery()],
  // REQ-D-3D-CURSOR. 평가 빌드에 커밋되는 리터럴은 false다. 활성화는 체크리스트 12조건과
  // B10(허용된 분리 환경의 실제 CT 확인) 뒤의 별도 결정이며, === true 하나만 ON이다.
  kinThreeDCursor: { enabled: false },
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
