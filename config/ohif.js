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

/* KIN persistence owns only explicit user commands. Cornerstone objects are
 * session bindings, never wire payloads or durable identifiers. */
function kinCreateViewerHistory() {
  let services, stop;
  function mount() {
    stop?.();
    const cs = window.cornerstone, ct = window.cornerstoneTools;
    if (!cs || !ct?.annotation?.locking) return;
    const entries = new Map(), annotations = new Map();
    let scope = '', subject = '', me, generation = 0, readSequence = 0;
    let controller = new AbortController(), ended = false, checking = false;
    let lastAuth = 0, loading = false, navigation = 0;
    const panel = document.createElement('details');
    panel.id = 'kin-viewer-history'; panel.open = true;
    panel.style.cssText = 'position:fixed;right:8px;bottom:30px;z-index:40;width:300px;max-height:58vh;overflow:auto;background:#101e32;color:#e1ecfc;border:1px solid #657c9f;border-radius:8px;padding:10px;font:13px sans-serif';
    const summary = document.createElement('summary'); summary.textContent = '저장한 주석 · 키 이미지'; panel.append(summary);
    const status = document.createElement('p'); status.setAttribute('role', 'status'); panel.append(status);
    const actions = document.createElement('div'), list = document.createElement('div'); panel.append(actions, list);
    document.body.append(panel);
    const clone = value => JSON.parse(JSON.stringify(value));
    const itemOnly = head => { const item = clone(head.item); delete item.hidden; return item; };
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
    const writable = entry => me?.kind === 'member' && me.roles?.includes('radiologist') && (!entry.head || entry.head.authorSub === subject);
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
      for (const e of entries.values()) removeAnnotation(e);
      entries.clear(); annotations.clear(); list.replaceChildren(); loading = false;
      status.textContent = message; render();
    }
    function end() {
      if (ended) return;
      reset('로그인이 종료되었습니다. 다시 로그인한 뒤 뷰어를 여세요.'); ended = true; me = null; subject = ''; actions.replaceChildren();
      // A shared workstation must not retain unsaved labels after logout either.
      for (const a of ct.annotation.state.getAllAnnotations()) if (a.metadata.toolName === 'ArrowAnnotate') ct.annotation.state.removeAnnotation(a.annotationUID);
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
      if (res.status === 401 || res.status === 403) { end(); throw { stale: true }; }
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
    async function load() {
      if (!scope || ended || loading) return;
      const ticket = generation, seq = ++readSequence; loading = true;
      status.textContent = '저장 항목 확인 중…';
      try {
        await authenticate(ticket);
        const heads = []; let cursor = null;
        do {
          const page = await api(path() + '?includeHidden=true&limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), {}, ticket);
          if (seq !== readSequence) return;
          if (!Array.isArray(page.items) || heads.length + page.items.length > 512 || (cursor && page.nextCursor === cursor)) throw new Error('Invalid page');
          heads.push(...page.items); cursor = page.nextCursor;
        } while (cursor);
        if (!valid(ticket) || seq !== readSequence) return;
        for (const head of heads) {
          let e = entries.get(head.id);
          if (e && (e.editing || e.pending || e.busy)) {
            if (head.revision !== e.head?.revision) { e.latest = head; e.message = '서버에 다른 판이 있습니다. 작성 내용은 유지됩니다.'; row(e); }
            continue;
          }
          if (e) removeAnnotation(e);
          else { e = { id: head.id }; entries.set(e.id, e); }
          Object.assign(e, { head, draft: itemOnly(head), editing: false, latest: null, message: '' }); row(e);
        }
        status.textContent = heads.length + '개 저장 항목 · 저장은 판독 확정과 별개입니다.';
        panel.dataset.studyUid = scope;
        toolbar(); hydrate();
      } catch (e) { if (!e.stale && valid(ticket)) status.textContent = '목록을 확인하지 못했습니다. 새로고침으로 다시 확인하세요.'; }
      finally { if (ticket === generation) loading = false; }
    }
    function toolbar() {
      actions.replaceChildren(); button(actions, '새로고침', load);
      button(actions, '현재 프레임 키 저장', () => {
        const r = current(); if (!r || r.study !== scope) return;
        const e = { id: crypto.randomUUID(), editing: true, draft: { schemaVersion: 1, kind: 'key', seriesUid: r.seriesUid, sopUid: r.sopUid, frame: r.frame, title: '', description: '' } };
        entries.set(e.id, e); row(e);
      }, !writable({}));
    }
    function updateAnnotation(e) {
      const a = e.annotationUID && ct.annotation.state.getAnnotation(e.annotationUID);
      if (a) { a.data.text = e.draft.label; a.invalidated = true; render(); }
    }
    function row(e) {
      if (!e.element) { e.element = document.createElement('section'); e.element.style.cssText = 'border-top:1px solid #405777;margin-top:8px;padding-top:8px'; list.append(e.element); }
      const el = e.element; el.replaceChildren(); el.dataset.itemId = e.head?.id || ''; el.dataset.kind = e.draft.kind;
      text(el, 'strong', (e.draft.kind === 'arrow' ? '화살표' : '키 이미지') + ' · ' + (e.head ? '저장됨 r' + e.head.revision : '미저장') + (e.head?.hidden ? ' · 숨김' : ''));
      if (e.head) text(el, 'div', e.head.authorActor + (writable(e) ? ' · 내 항목' : ' · 읽기 전용'));
      if (e.editing) {
        input(el, e.draft.kind === 'arrow' ? '주석 문구' : '키 제목', e.draft.label ?? e.draft.title, value => {
          e.draft[e.draft.kind === 'arrow' ? 'label' : 'title'] = value; updateAnnotation(e);
        }, !!(e.busy || e.pending));
        if (e.draft.kind === 'key') input(el, '키 설명', e.draft.description || '', value => { e.draft.description = value; }, !!(e.busy || e.pending));
      } else {
        text(el, 'p', e.draft.label ?? e.draft.title);
        if (e.draft.description) text(el, 'p', e.draft.description);
      }
      text(el, 'div', '프레임 ' + e.draft.frame);
      if (e.message) text(el, 'p', e.message);
      button(el, '영상으로 이동', () => navigate(e));
      if (writable(e)) {
        if (e.pending) button(el, '같은 요청 재시도', () => save(e), !!e.busy);
        else if (e.editing) button(el, '저장', () => save(e, 'edit'), !!e.busy || !!e.latest);
        else if (!e.head?.hidden) button(el, '편집', () => { e.editing = true; lock(e, false); row(e); });
        if (e.head && !e.editing && !e.pending) button(el, e.head.hidden ? '복원' : '숨김', () => {
          const reason = window.prompt((e.head.hidden ? '복원' : '숨김') + ' 사유');
          if (reason?.trim()) save(e, e.head.hidden ? 'restore' : 'hide', reason);
        }, !!e.busy);
        if (e.latest && !e.pending) button(el, '최신판 기준으로 내 수정 유지', () => {
          e.head = e.latest; e.latest = null;
          if (e.head.hidden) { e.heldDraft = clone(e.draft); e.editing = false; e.draft = itemOnly(e.head); e.message = '서버에서 숨겨졌습니다. 미저장 수정은 보관되며 복원 후 다시 편집할 수 있습니다.'; }
          else e.message = '최신판을 확인했습니다. 저장을 눌러야 내 수정이 반영됩니다.';
          row(e);
        });
      }
      if (e.head) button(el, '이력', async () => {
        const ticket = generation; let cursor = null, count = 0;
        const history = document.createElement('div'); el.append(history);
        const more = async () => {
          const data = await api(path() + '/' + e.head.id + '/revisions?limit=50' + (cursor ? '&cursor=' + cursor : ''), {}, ticket);
          if (!valid(ticket) || !el.isConnected) return;
          for (const r of data.revisions) text(history, 'p', 'r' + r.revision + ' · ' + ({ create: '생성', edit: '수정', hide: '숨김', restore: '복원' }[r.action] || r.action) + ' · ' + r.actor + ' · ' + r.at + ' · ' + r.reason + ' · ' + (r.item.label ?? r.item.title));
          count += data.revisions.length; cursor = data.nextCursor;
          if (cursor && count < 4096) button(history, '다음 이력', more);
        };
        await more();
      });
    }
    async function save(e, action, reason) {
      if (!writable(e) || e.busy || ended) return;
      const ticket = generation; e.busy = true; lock(e, true);
      if (!e.pending) {
        const annotation = e.annotationUID && ct.annotation.state.getAnnotation(e.annotationUID);
        if (e.editing && annotation) {
          e.draft.points = clone(annotation.data.handles.points);
          e.draft.label = annotation.data.text;
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
        entries.delete(e.id); e.id = head.id; entries.set(e.id, e);
        Object.assign(e, { head, draft: itemOnly(head), pending: null, latest: null, editing: false, message: '저장 완료' });
        if (!head.hidden && e.heldDraft) {
          e.draft = e.heldDraft; e.heldDraft = null; e.editing = true;
          e.message = '복원 완료. 보관한 수정은 아직 미저장 상태입니다.';
          updateAnnotation(e);
        }
        if (head.hidden) removeAnnotation(e);
        else lock(e, !e.editing);
      } catch (error) {
        if (error.stale || !valid(ticket)) return;
        e.message = errorMessage(error);
        if (error.status >= 400 && error.status < 500) { e.pending = null; lock(e, !e.editing); }
        if (error.status === 409) await load();
      } finally { if (valid(ticket) && entries.has(e.id)) { e.busy = false; row(e); } }
    }
    async function navigate(e) {
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
      if (!r || r.study !== scope || !subject || ended) return;
      const plane = cs.metaData.get('imagePlaneModule', imageId);
      for (const e of entries.values()) {
        if (!e.head || e.head.hidden || e.draft.kind !== 'arrow' || e.annotationUID || !matches(r, e.draft) || plane?.frameOfReferenceUID !== e.draft.frameOfReferenceUid) continue;
        const uid = crypto.randomUUID(), camera = v.getCamera();
        const a = { annotationUID: uid, highlighted: false, invalidated: true, isLocked: true, isVisible: true,
          metadata: { toolName: 'ArrowAnnotate', FrameOfReferenceUID: e.draft.frameOfReferenceUid, referencedImageId: imageId, viewPlaneNormal: camera.viewPlaneNormal, viewUp: camera.viewUp },
          data: { text: e.draft.label, handles: { points: clone(e.draft.points), activeHandleIndex: null, textBox: { hasMoved: false, worldPosition: [0, 0, 0], worldBoundingBox: { topLeft: [0, 0, 0], topRight: [0, 0, 0], bottomLeft: [0, 0, 0], bottomRight: [0, 0, 0] } } }, cachedStats: {} } };
        ct.annotation.state.addAnnotation(a, v.element); e.annotationUID = uid; annotations.set(uid, e); lock(e, !e.editing); render();
      }
    }
    function scan() {
      if (ended) return;
      const r = current();
      // Switching display sets briefly removes the viewport. Mode exit, not
      // that loading gap, owns teardown of drafts and in-flight commands.
      if (!r) return;
      if (r.study !== scope) {
        reset('검사 확인 중…'); scope = r?.study || ''; me = null;
        if (scope) load(); return;
      }
      if (!subject || !scope) return;
      for (const e of entries.values()) {
        const a = e.annotationUID && ct.annotation.state.getAnnotation(e.annotationUID);
        if (e.annotationUID && !a) { annotations.delete(e.annotationUID); e.annotationUID = null; }
        if (a && e.head && !e.editing) {
          a.data.text = e.draft.label;
          a.data.handles.points = clone(e.draft.points);
          lock(e, true);
        }
      }
      hydrate();
      for (const a of ct.annotation.state.getAllAnnotations()) {
        if (a.metadata.toolName !== 'ArrowAnnotate' || !matches(reference(a.metadata.referencedImageId), { ...reference(a.metadata.referencedImageId) }) || !Array.isArray(a.data.handles?.points) || a.data.handles.points.length !== 2 || typeof a.data.text !== 'string') continue;
        let e = annotations.get(a.annotationUID);
        if (!e) {
          const ref = reference(a.metadata.referencedImageId);
          e = { id: crypto.randomUUID(), annotationUID: a.annotationUID, editing: true,
            draft: { schemaVersion: 1, kind: 'arrow', seriesUid: ref.seriesUid, sopUid: ref.sopUid, frame: ref.frame, frameOfReferenceUid: a.metadata.FrameOfReferenceUID, label: a.data.text, points: clone(a.data.handles.points) } };
          entries.set(e.id, e); annotations.set(a.annotationUID, e); row(e);
        } else if (e.editing && !e.busy && !e.pending) {
          e.draft.points = clone(a.data.handles.points);
          if (e.draft.label !== a.data.text) { e.draft.label = a.data.text; row(e); }
        }
      }
      if (Date.now() - lastAuth > 15000 && !checking) {
        checking = true; const ticket = generation;
        authenticate(ticket).then(() => api(path() + '?limit=1', {}, ticket)).catch(() => {}).finally(() => { checking = false; });
      }
    }
    const onStorage = e => { if (e.key === 'kin-session-ended') end(); };
    const onFocus = () => { lastAuth = 0; };
    const beforeUnload = e => { if ([...entries.values()].some(x => x.editing || x.pending)) { e.preventDefault(); e.returnValue = ''; } };
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
    stop = () => { end(); clearInterval(timer); channel?.close(); document.removeEventListener(stackEvent, onImage, true); subscriptions.forEach(s => s.unsubscribe()); window.removeEventListener('storage', onStorage); window.removeEventListener('focus', onFocus); window.removeEventListener('beforeunload', beforeUnload); panel.remove(); };
    scan();
  }
  return { id: 'kin.viewer-history', preRegistration({ servicesManager }) { services = servicesManager.services; }, onModeEnter: mount, onModeExit() { stop?.(); stop = null; } };
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
    const summary = document.createElement('summary'); summary.textContent = '최근 배치 · 이 브라우저'; panel.append(summary);
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
    for (const [label, action] of [['최근 배치 저장', 'save'], ['최근 배치 복원', 'restore'], ['최근 배치 삭제', 'remove']]) {
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

window.config = {
  extensions: [kinStackPrecision, kinCreateViewerHistory(), kinCreateViewerLayout(), kinCreateCTSync(), kinCreateCine(), kinCreateCTPresets()],
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
