# KIN 0단계 실습 키트 — 내 손으로 미니 PACS 띄우기

목표는 하나: **브라우저에서 CT가 열리는 순간**을 오늘 경험하는 것.
이 키트는 클라우드 샌드박스에서 실제로 기동·업로드·판독화면까지 검증된 구성입니다.

## 준비물

- Docker Desktop 설치 ( https://www.docker.com/products/docker-desktop/ )
- Python 3.9+ 와 `pip install pydicom requests numpy`

## 실행 순서 (약 15분)

```bash
# 1. 전체 기동 — Orthanc + PostgreSQL + Keycloak + KIN API
#    (첫 실행은 이미지 다운로드와 API 빌드로 몇 분 걸림)
docker compose up -d --build

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
| http://localhost:8042/ohif/ | **OHIF 뷰어** |
| http://localhost:8042/worklist/hpacs-lite/index.html | **HPACS-lite** — 판독 워크스페이스 |
| http://localhost:8080 | Keycloak 관리 콘솔 (`admin` / `admin`) |
| http://localhost:3000/api/health | KIN API 살아있는지 확인 |

로그인:

- Orthanc — `admin` / `admin`
- HPACS-lite — **KIN 계정으로 로그인** 버튼 → Keycloak 화면에서 아래 계정 중 하나

| 아이디 | 비밀번호 | 할 수 있는 일 |
|---|---|---|
| `jmryu` | `kin1234` | 전부 (판독의 + 방사선사 + 관리자) |
| `doctor` | `kin1234` | 판독문 작성·승인. Verify·매칭은 막힘 |
| `tech` | `kin1234` | Verify·오더 매칭. 판독문은 읽기 전용 |

**데모 모드로 둘러보기**를 누르면 서버 없이 가짜 데이터로 열립니다(GitHub Pages 공유용).

우측 상단 표시:

- 초록 **● DB 연결됨** — 판독문·상태가 PostgreSQL에 저장됨. 브라우저를 바꿔도 유지
- 회색 **● 데모 모드** — 로그인하지 않은 둘러보기. 이 브라우저에만 남음
- 노랑 **● 로컬 저장** — API 미연결 (`docker compose logs api`로 확인)

## 첫날 미션 체크리스트

- [ ] OHIF에서 스터디를 열고 마우스 휠로 60장 스크롤하기
- [ ] 윈도잉(W/L) 도구로 밝기·대비를 바꿔 두개골/뇌를 번갈아 보기
- [ ] 측정 도구로 병변(우측 상부의 밝은 결절, 중간 슬라이스 부근) 크기 재기
- [ ] Orthanc 관리 UI에서 같은 스터디를 찾아 DICOM 태그 열람하기
- [ ] `config/orthanc.json`과 `docker-compose.yml`을 한 줄씩 읽고, 이해 안 되는 단어 목록 만들기 → 이것이 2단계 교재

## 이 키트의 구조

```
docker-compose.yml        # Orthanc + PostgreSQL + API 컨테이너 정의
config/orthanc.json       # Orthanc 설정: 계정, DICOMweb, DICOM AE, ServeFolders
scripts/make_sample_ct.py # 합성 두부 CT 팬텀 생성 (pydicom)
scripts/upload_samples.py # REST API(/instances)로 업로드
sample-data/              # 생성된 .dcm 파일이 여기 쌓임

worklist-v0/              # 프론트엔드 (Orthanc가 /worklist 로 서빙)
  worklist-v1~v3.html     #   워크리스트 재현 습작
  hpacs-lite/             #   본편: 로그인 + 판독 워크스페이스
    index.html            #     로그인 (가짜 인증 — 3단계 후반 Keycloak으로 교체)
    main.html             #     Radiology / Technician 두 모드

    auth.js               #     Keycloak OIDC (Authorization Code + PKCE)

api/                      # 백엔드 (NestJS + Prisma + PostgreSQL) — 3단계
  prisma/schema.prisma    #   StudyState, Report, Order, AuditLog
  src/auth.guard.ts       #   JWT 검증 (서명·iss·aud·exp)
  src/pacs.controller.ts  #   REST 엔드포인트
  src/pacs.service.ts     #   상태 전이·매칭 트랜잭션·역할 검사·감사로그

keycloak/                 # 인증 서버 설정
  kin-realm.json          #   렐름·클라이언트·롤·개발용 계정 (자동 import)
  README.md               #   주의사항 — JSON에 주석 금지 등
```

### 권한 모델

Radiology / Technician 두 탭은 화면 분리가 아니라 **권한 분리**다.

| | radiologist | technician |
|---|---|---|
| 판독문 저장·승인, RS 변경 | ✅ | ❌ |
| Verify/Unverify, 오더 매칭, 검사정보 수정, 삭제 | ❌ | ✅ |

`admin`은 둘 다. 화면에서도 버튼을 잠그지만 **진짜 방어선은 서버**다
(`pacs.service.ts`의 `need()`). 화면은 안내일 뿐이다.

### API 엔드포인트

| 메서드 | 경로 | 하는 일 |
|---|---|---|
| GET | `/api/bootstrap` | 프론트 시작 시 상태·판독문·오더를 한 번에 |
| PATCH | `/api/studies/:uid` | RS·SS·EM·TS·Ward 등 부분 수정 |
| PUT | `/api/studies/:uid/report` | 판독문 저장 |
| POST | `/api/match` · `/api/unmatch` | 검사↔오더 매칭 (트랜잭션) |
| GET | `/api/audit?uid=` | 감사 로그 |
| GET | `/api/me` | 내 토큰의 주인과 롤 |

`/api/health`를 뺀 모든 요청은 `Authorization: Bearer <token>`이 필요합니다.
서버는 서명·발급자(iss)·대상(aud)·만료를 모두 확인하고, **감사 로그의 actor를 토큰에서**
꺼냅니다 — 클라이언트가 자기 이름을 정하지 못합니다.

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
- **HPACS-lite가 "로컬 저장"으로 뜸**: API가 안 떠 있음. `docker compose ps`로 `kin-api`
  상태를 보고 `docker compose logs api`로 원인 확인. DB 준비 전에 API가 뜨면 재시작으로 해결.
- **API 코드를 고쳤는데 반영이 안 됨**: `src/`는 마운트돼 있어 자동 재시작됩니다.
  `prisma/schema.prisma`를 고쳤다면 `docker compose restart api` (스키마를 다시 push함).
- **API 로그에 `Could not parse schema engine response` / `failed to detect the libssl`**:
  Prisma 엔진은 네이티브 바이너리라 musl(alpine)에서 돌지 않습니다. `api/Dockerfile`의
  베이스가 `node:22-slim`인지, `openssl` 패키지를 설치하는지 확인하고 `--build`로 다시 빌드.
- **로그인 버튼이 "인증 서버 없음"**: Keycloak이 아직 뜨는 중(첫 기동 40초쯤). 잠시 뒤 새로고침.
  `docker compose logs keycloak | Select-String Imported` 로 렐름이 들어왔는지 확인할 수 있다.
- **로그인 후 `invalid_redirect_uri`**: 8042가 아닌 주소로 열었을 때. 렐름에 등록된 주소는
  `http://localhost:8042/*` 뿐이다. `keycloak/kin-realm.json`의 `redirectUris`를 고치고
  `docker compose down -v` 후 재기동하거나, 관리 콘솔에서 직접 추가.
- **렐름 파일을 고쳤는데 반영 안 됨**: `docker compose up -d --force-recreate keycloak`.
- **Keycloak이 `AccessDeniedException: keycloakdb.mv.db`로 죽음**: H2 경로에 이름있는 볼륨을
  붙였을 때 생긴다(root 소유로 만들어지는데 Keycloak은 UID 1000). `keycloak/README.md` 참고.
- **API가 401만 뱉음**: 토큰의 `iss`와 API의 `KC_ISSUER`가 달라진 경우. compose의
  `KC_HOSTNAME`과 `KC_ISSUER`가 둘 다 `http://localhost:8080`인지 확인.
- **처음부터 다시**: `docker compose down -v` (영상·DB·Keycloak 계정이 전부 삭제됨)

## 이것이 사업의 미니어처인 이유

지금 만든 구성 — 아카이브(Orthanc) + 표준 API(DICOMweb) + 뷰어(OHIF) — 는
Korea Imaging Network 데이터센터의 최소 원형입니다. 3단계에서는 이 Orthanc를
세 대로 늘려 "A병원 → 게이트웨이 → B병원" 라우팅을 만들게 됩니다.
