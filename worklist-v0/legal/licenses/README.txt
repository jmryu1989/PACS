Open Source Notice Inputs

scripts/build-open-source-notices.py는 네트워크 없이 저장소의 선언과 이 폴더의 원문을 읽습니다.
실행 환경은 Python과 Node이며, Compose 해석에는 API 잠금 파일에 이미 포함된 js-yaml 패키지를
사용합니다. API의 npm ci --ignore-scripts가 선행되어야 합니다. 별도 파서는 설치하지 않습니다.
components.json과 ../open-source-notices.html은 생성물이므로 직접 수정하지 않습니다.

catalog.json은 name@version별 원문 파일, 공개 출처, 공급자와 확인하지 못한 항목을 기록합니다.
texts/에는 해당 버전의 배포 패키지 또는 upstream 소스에서 확보한 LICENSE, NOTICE,
COPYING, 저작권 표시 및 라이선스가 포함된 README/소스 원문을 보관합니다.
sha256은 CRLF를 LF로 정규화한 텍스트의 해시입니다. Git의 플랫폼별 줄바꿈을 구분하지 않습니다.
파일명을 통해 같은 원문을 공유할 수 있지만 버전 간 원문 확보 사실을 자동 승계하지 않습니다.
새 버전은 해당 배포물의 저작권 표시와 해당하는 모든 NOTICE를 확인하고 catalog에 추가합니다.
공급자 또는 원문을 확인하지 못한 값은 추정하지 않습니다.

orthanc-build-matrix-24.12.0.json은 공개 upstream 24.12.0 빌드 목록과 Dockerfile의
기본 이미지 복사 목록을 대조한 자료입니다. -full 전용 플러그인은 포함하지 않습니다.
Osimis Viewer는 build-matrix의 dev 대신 Dockerfile이 실제 다운로드하는 1.4.3을 사용합니다.
빌드에 포함된 플러그인 목록이며, 개별 설치본에서 활성화된 플러그인 목록은 아닙니다.

python -B scripts/build-open-source-notices.py
python -B scripts/build-open-source-notices.py --check
python -B scripts/build-open-source-notices.py --check --require-complete

--check는 선언·원문과 생성물의 일치만 확인합니다.
--require-complete는 원문 미확보나 수정 확인이 남으면 실패합니다.
원문 미확보가 남은 상태를 배포 고지 완료로 보고하지 않습니다.
소스 제공 설정은 --source-offer link(기본) 또는 written입니다.
written은 미확정 서면 제공 문안이며 유효한 제공 약정의 확정을 대신하지 않습니다.

API에는 잠금 파일의 개발 의존성도 포함합니다. Gateway requirements는 Python 3.12의
전체 resolver 결과를 고정하며 gateway-resolution.json에 pip 보고서를 보존합니다.
catalog의 requirement_resolutions는 requirements 해시·전체 패키지·보고서 해시를 연결합니다.
이 기록과 requirements가 달라지면 간접 의존성 미확보 행을 추가합니다.
컨테이너 OS 패키지와 Orthanc 바이너리 내 제3자 라이브러리는 이미지별 미확보 행으로 집계합니다.
OHIF 내장 빌드의 라이선스 메타데이터가 저장소에 없으면 원문 미확보로 남깁니다.

원문별 source와 revision은 수집한 URL과 upstream 태그/리비전입니다. Mercurial
json-file 응답은 lines[].line을 그대로 이어 원문을 복원하며 응답 해시도 기록합니다.
별도 파일 없이 SPDX 필드만 있는 npm 배포물은 그 선언과 SPDX 원문을 함께 제공하고
고지에 대체 원문이라는 사실을 표시합니다. 모델 가중치는 고정 모델 카드의 MIT
선언을 따르며, 엔진의 라이선스만으로 가중치의 라이선스를 추정하지 않습니다.
OS 이미지의 유지관리자 고지·도구 라이선스는 OS 전체의 단일 라이선스가 아닙니다.
patch/digest가 없는 이미지 태그의 실제 설치 버전은 이 수집 리비전과 구분합니다.
