
// W9 multi-study view (worklist-v0/hpacs-lite/viewer-multi-study.js): load, mount and stop its strip and renderer observer
// with the viewer mode, the way Frame Coverage is mounted. Only a viewer the worklist opened for a multi-study opening (the
// `kin-w9` fragment, also set later on a reused window) loads it; every other viewer loads nothing more.
function kinCreateMultiStudyStrip() {
  let ready = null, current = null, services, epoch = 0, active = false;
  const wanted = () => /(?:^#|&)kin-w9=/.test(location.hash);
  const load = () => window.KinViewerMultiStudy ? Promise.resolve() : ready || (ready = new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = '/worklist/hpacs-lite/viewer-multi-study.js';
    const timeout = setTimeout(() => { ready = null; reject(Error('Multi-Study View loading timeout')); }, 20000);
    script.onload = () => { clearTimeout(timeout); resolve(); start(); };
    script.onerror = () => { clearTimeout(timeout); ready = null; reject(Error('Multi-Study View loading failed')); };
    document.head.append(script);
  }));
  function start() {
    if (!active || current || !wanted()) return;
    const ticket = epoch;
    load().then(() => { if (active && ticket === epoch && !current) current = window.KinViewerMultiStudy.mount(services); }).catch(() => {});
  }
  return { id: 'kin.multi-study-strip', preRegistration({ servicesManager }) {
    services = servicesManager.services;
    window.addEventListener('hashchange', start); window.addEventListener('kin-window-link-changed', start);
  }, onModeEnter() { epoch++; active = true; start(); },
  onModeExit() { epoch++; active = false; current?.stop(); current = null; } };
}

window.config = {
  extensions: [kinCreateSessionBoundary(), kinStackPrecision, kinCreateFrameMetadata(), kinCreateSRProvenance(), kinCreateViewerHistory(), kinCreateViewerFindings(), kinCreateViewerLayout(), kinCreateViewerJobs(), kinCreateViewerTechNote(), kinCreateFrameCoverage(), '@ohif/extension-dicom-pdf', kinCreateDicomPdf(), kinCreateCTSync(), kinCreateCine(), kinCreateDisplayScope(), kinCreateCellMerge(), kinCreateImagesOnly(), kinCreateImageText(), kinCreateCTPresets(), kinCreateThreeDCursor(), kinCreateSeriesMetadataRecovery(), kinCreateContextLoss(), kinCreateMammographyHanging(), kinCreateMGReferenceLines(), kinCreateStudyPrefetch(), kinCreateViewerUX(), kinCreateViewerPrior(), kinCreateMultiStudyStrip()],
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
