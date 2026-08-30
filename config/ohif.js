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

window.config = {
  extensions: [],
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
