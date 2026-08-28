# KIN 0단계 실습 키트 — 내 손으로 미니 PACS 띄우기

목표는 하나: **브라우저에서 CT가 열리는 순간**을 오늘 경험하는 것.
이 키트는 클라우드 샌드박스에서 실제로 기동·업로드·판독화면까지 검증된 구성입니다.

## 준비물

- Docker Desktop 설치 ( https://www.docker.com/products/docker-desktop/ )
- Python 3.9+ 와 `pip install pydicom requests numpy`

## 실행 순서 (약 15분)

```bash
# 1. PACS 기동 (첫 실행은 이미지 다운로드로 몇 분 걸림)
docker compose up -d

# 2. 실습용 합성 CT 60슬라이스 생성 (외부 다운로드 불필요)
cd scripts
python3 make_sample_ct.py

# 3. Orthanc에 업로드
python3 upload_samples.py
```

그리고 브라우저에서:

| 주소 | 화면 |
|---|---|
| http://localhost:8042 | Orthanc 관리 UI (Orthanc Explorer 2) |
| http://localhost:8042/ohif/ | **OHIF 뷰어** — 여기가 오늘의 목적지 |

로그인: `admin` / `admin`

## 첫날 미션 체크리스트

- [ ] OHIF에서 스터디를 열고 마우스 휠로 60장 스크롤하기
- [ ] 윈도잉(W/L) 도구로 밝기·대비를 바꿔 두개골/뇌를 번갈아 보기
- [ ] 측정 도구로 병변(우측 상부의 밝은 결절, 중간 슬라이스 부근) 크기 재기
- [ ] Orthanc 관리 UI에서 같은 스터디를 찾아 DICOM 태그 열람하기
- [ ] `config/orthanc.json`과 `docker-compose.yml`을 한 줄씩 읽고, 이해 안 되는 단어 목록 만들기 → 이것이 2단계 교재

## 이 키트의 구조

```
docker-compose.yml        # Orthanc 컨테이너 정의 (OHIF 플러그인 활성화 포함)
config/orthanc.json       # Orthanc 설정: 계정, DICOMweb, DICOM AE
scripts/make_sample_ct.py # 합성 두부 CT 팬텀 생성 (pydicom)
scripts/upload_samples.py # REST API(/instances)로 업로드
sample-data/              # 생성된 .dcm 파일이 여기 쌓임
```

핵심 개념 미리보기: OHIF는 Orthanc의 **DICOMweb** API(`/dicom-web/...`)로 영상을
가져옵니다. 지금 브라우저 개발자도구(Network 탭)를 열고 스터디를 열어보면
`QIDO-RS`(검색)와 `WADO-RS`(픽셀 조회) 요청이 실제로 날아가는 게 보입니다 —
2단계에서 배울 내용의 예고편입니다.

## 다음 실험 (둘째 날 이후)

```bash
# REST API 맛보기 — PACS와 코드로 대화하기
curl -u admin:admin http://localhost:8042/studies
curl -u admin:admin http://localhost:8042/dicom-web/studies   # QIDO-RS

# DICOM 프로토콜 맛보기 — DCMTK 설치 후 (brew install dcmtk / apt install dcmtk)
storescu -aec KINLAB localhost 4242 sample-data/ct_030.dcm    # C-STORE 전송
```

## 문제 해결

- **8042 포트가 이미 사용 중**: `docker-compose.yml`의 `"8042:8042"`를 `"8043:8042"`로
  바꾸고 주소도 `localhost:8043`으로.
- **/ohif/ 가 404**: `docker compose up -d` 후 플러그인 로드까지 몇 초 걸림.
  `curl -u admin:admin http://localhost:8042/plugins` 에 `"ohif"`가 보여야 정상 —
  compose 파일의 `OHIF_PLUGIN_ENABLED: "true"`가 지워지지 않았는지 확인.
- **업로드 스크립트 실패**: Orthanc가 아직 기동 중일 수 있음. 몇 초 뒤 재시도.
- **처음부터 다시**: `docker compose down -v` (저장된 영상까지 전부 삭제됨)

## 이것이 사업의 미니어처인 이유

지금 만든 구성 — 아카이브(Orthanc) + 표준 API(DICOMweb) + 뷰어(OHIF) — 는
Korea Imaging Network 데이터센터의 최소 원형입니다. 3단계에서는 이 Orthanc를
세 대로 늘려 "A병원 → 게이트웨이 → B병원" 라우팅을 만들게 됩니다.
