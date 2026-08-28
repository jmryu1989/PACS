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

window.config = {
  extensions: [],
  modes: [],
  customizationService: {},
  showStudyList: true,

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
