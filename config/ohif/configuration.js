
window.config = {
  extensions: [kinCreateSessionBoundary(), kinStackPrecision, kinCreateSRProvenance(), kinCreateViewerHistory(), kinCreateViewerFindings(), kinCreateViewerLayout(), kinCreateViewerJobs(), kinCreateViewerTechNote(), kinCreateFrameCoverage(), '@ohif/extension-dicom-pdf', kinCreateDicomPdf(), kinCreateCTSync(), kinCreateCine(), kinCreateDisplayScope(), kinCreateCellMerge(), kinCreateImagesOnly(), kinCreateImageText(), kinCreateCTPresets(), kinCreateThreeDCursor(), kinCreateSeriesMetadataRecovery(), kinCreateContextLoss(), kinCreateMammographyHanging(), kinCreateStudyPrefetch()],
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
