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
const KIN_VIEWER_PRODUCT = 'KIN Viewer';
