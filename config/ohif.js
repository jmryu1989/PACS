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

/** DICOM JSON의 첫 값을 탭에 넣을 수 있는 평문으로 정규화한다. */
function kinDicomValue(study, tag) {
  const value = study?.[tag]?.Value?.[0];
  if (value && typeof value === 'object') {
    return String(value.Alphabetic ?? value.Ideographic ?? value.Phonetic ?? '');
  }
  return value == null ? '' : String(value);
}

/**
 * 장비마다 BodyPartExamined를 비우거나 영어 StudyDescription만 보내므로 둘을 함께 본다.
 * 탭에는 판독 맥락만 남기고 조영제·추적검사 같은 프로토콜 세부사항은 넣지 않는다.
 */
function kinStudyBodyPart(study, modality) {
  const raw = `${kinDicomValue(study, '00180015')} ${kinDicomValue(study, '00081030')}`.trim();
  const names = [
    [/\bbrain\b/i, '뇌'], [/\bhead\b/i, '머리'], [/\bchest\b|\bthorax\b/i, '흉부'],
    [/\babdomen\b|\babdominal\b/i, '복부'], [/\bpelvis\b|\bpelvic\b/i, '골반'],
    [/\bspine\b/i, '척추'], [/\bknee\b/i, '무릎'], [/\bshoulder\b/i, '어깨'],
    [/\bneck\b/i, '경부'], [/\bbreast\b/i, '유방'], [/\bheart\b|\bcardiac\b/i, '심장'],
  ];
  const localized = names.find(([pattern]) => pattern.test(raw));
  if (localized) return localized[1];

  const modalityPattern = modality ? new RegExp(`\\b${modality.replace(/[^A-Z0-9]/gi, '')}\\b`, 'ig') : null;
  return raw
    .replace(modalityPattern ?? /$^/, '')
    .replace(/\(synthetic\)|\bf\/?u\b|\bfollow[ -]?up\b|\bscreening\b|\bwith(?:out)? contrast\b/ig, '')
    .replace(/\s+/g, ' ')
    .trim() || '검사';
}

/**
 * whiteLabeling 컴포넌트의 mount/unmount를 검사 화면의 수명주기로 쓴다.
 * 별도 확장이나 뷰어 포크 없이도 로딩 완료 뒤 제목을 올리고, 화면 이탈 시 즉시 지운다.
 */
function KinViewerBrand({ React }) {
  React.useEffect(() => {
    const abort = new AbortController();
    let sessionEnded = false;
    let sessionChannel;

    const resetTitle = () => {
      sessionEnded = true;
      document.title = KIN_VIEWER_DEFAULT_TITLE;
      abort.abort();
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
        ['Patient', '환자'],
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
    const studyUid = new URLSearchParams(location.search).get('StudyInstanceUIDs')?.split(',')[0]?.trim();
    if (studyUid) {
      const query = new URLSearchParams({
        StudyInstanceUID: studyUid,
        includefield: '00081030,00180015,00080061,00100010',
      });
      fetch(`${location.origin}/dicom-web/studies?${query}`, { signal: abort.signal })
        .then(response => response.ok ? response.json() : Promise.reject(new Error(`QIDO ${response.status}`)))
        .then(studies => {
          if (sessionEnded || !studies?.[0]) return;
          const study = studies[0];
          const patientName = kinDicomValue(study, '00100010').replace(/\^/g, ' ').replace(/\s+/g, ' ').trim();
          const modality = kinDicomValue(study, '00080061').split('\\')[0].trim();
          const bodyPart = kinStudyBodyPart(study, modality);
          if (patientName && modality) document.title = `${patientName} · ${modality} ${bodyPart} — 판독 뷰어`;
        })
        .catch(error => error.name !== 'AbortError' && console.warn('KIN viewer title:', error));
    }

    return () => {
      document.title = KIN_VIEWER_DEFAULT_TITLE;
      abort.abort();
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

window.config = {
  extensions: [kinStackPrecision],
  modes: [],
  customizationService: {},
  showStudyList: true,

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
  hotkeys: [
    { commandName: 'incrementActiveViewport', label: 'Next Viewport', keys: ['right'] },
    { commandName: 'decrementActiveViewport', label: 'Previous Viewport', keys: ['left'] },
    { commandName: 'rotateViewportCW', label: 'Rotate Right', keys: ['r'] },
    { commandName: 'rotateViewportCCW', label: 'Rotate Left', keys: ['l'] },
    { commandName: 'invertViewport', label: 'Invert', keys: ['i'] },
    { commandName: 'flipViewportHorizontal', label: 'Flip Horizontally', keys: ['h'] },
    { commandName: 'flipViewportVertical', label: 'Flip Vertically', keys: ['v'] },
    { commandName: 'scaleUpViewport', label: 'Zoom In', keys: ['+'] },
    { commandName: 'scaleDownViewport', label: 'Zoom Out', keys: ['-'] },
    { commandName: 'fitViewportToWindow', label: 'Zoom to Fit', keys: ['='] },
    { commandName: 'resetViewport', label: 'Reset', keys: ['space'] },
    { commandName: 'nextImage', label: 'Next Image', keys: ['down'] },
    { commandName: 'previousImage', label: 'Previous Image', keys: ['up'] },
    { commandName: 'setToolActive', commandOptions: { toolName: 'Zoom' }, label: 'Zoom', keys: ['z'] },
    { commandName: 'windowLevelPreset1', label: 'W/L Preset 1', keys: ['1'] },
    { commandName: 'windowLevelPreset2', label: 'W/L Preset 2', keys: ['2'] },
    { commandName: 'windowLevelPreset3', label: 'W/L Preset 3', keys: ['3'] },
    { commandName: 'windowLevelPreset4', label: 'W/L Preset 4', keys: ['4'] },
    { commandName: 'windowLevelPreset5', label: 'W/L Preset 5', keys: ['5'] },
    { commandName: 'windowLevelPreset6', label: 'W/L Preset 6', keys: ['6'] },
    { commandName: 'windowLevelPreset7', label: 'W/L Preset 7', keys: ['7'] },
    { commandName: 'windowLevelPreset8', label: 'W/L Preset 8', keys: ['8'] },
    { commandName: 'windowLevelPreset9', label: 'W/L Preset 9', keys: ['9'] },
  ],
};
