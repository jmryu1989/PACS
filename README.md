# KIN 0단계 실습 키트 — 내 손으로 미니 PACS 띄우기

목표는 하나: **브라우저에서 CT가 열리는 순간**을 오늘 경험하는 것.
이 키트는 클라우드 샌드박스에서 실제로 기동·업로드·판독화면까지 검증된 구성입니다.

## 준비물

- Docker Desktop 설치 ( https://www.docker.com/products/docker-desktop/ )
- Python 3.9+ 와 `pip install pydicom requests numpy`

## 실행 순서 (약 15분)

```bash
# 1. 실제 자격증명을 로컬 전용 .env에 넣는다 (.env는 Git에서 무시됨)
cp .env.example .env
# change-me 값을 모두 교체한다. 로컬 kin-api 시크릿은 렐름 JSON의 개발값과 맞춘다.

# 2. 전체 기동 — Orthanc + PostgreSQL + Keycloak + KIN API
#    (첫 실행은 이미지 다운로드와 API 빌드로 몇 분 걸림)
docker compose up -d --build

# 3. 실습용 합성 CT 60슬라이스 생성 (외부 다운로드 불필요)
cd scripts
python3 make_sample_ct.py

# 4. Orthanc에 업로드 (먼저 .env의 ORTHANC_PASS를 셸 환경변수로 내보낸다)
python3 upload_samples.py

# 5. (선택) 가짜 CT 장비가 되어 진짜 DICOM 프로토콜로 한 건 더 보내기
pip install pynetdicom
python3 send_cstore.py --name "HONG^GILDONG" --id P-1006
```

그리고 브라우저에서:

| 주소 | 화면 |
|---|---|
| http://localhost:8042 | Orthanc 관리 UI (Orthanc Explorer 2) |
| http://localhost:8042/ohif/ | **OHIF 뷰어** |
| http://localhost:8042/worklist/hpacs-lite/index.html | **HPACS-lite** — 판독 워크스페이스 |
| http://localhost:8080 | Keycloak 관리 콘솔 |
| http://localhost:3000/api/health | KIN API 살아있는지 확인 |

로그인 계정은 관리자에게 문의하세요.

기관이 다르면 **서로의 검사가 보이지 않는다.** 원격판독으로 의뢰한 검사 하나만 넘어간다.
`admin` 롤도 이 경계는 못 넘는다 (자세한 건 `keycloak/README.md`).

**데모 모드로 둘러보기**를 누르면 서버 없이 가짜 데이터로 열립니다(GitHub Pages 공유용).

우측 상단 표시:

- 초록 **● DB 연결됨** — 판독문·상태가 PostgreSQL에 저장됨. 브라우저를 바꿔도 유지
- 회색 **● 데모 모드** — 로그인하지 않은 둘러보기. 이 브라우저에만 남음
- 노랑 **● 로컬 저장** — API 미연결 (`docker compose logs api`로 확인)

## 운영 서버 최초 인증서와 기동

운영 proxy는 Let's Encrypt 인증서가 없으면 `nginx -t`에서 멈춘다. 자체 서명 인증서로
그 실패를 가리지 않는 것이 의도이므로, 최초 발급 때는 proxy를 내린 채 certbot이 80번을
직접 듣게 한다. 아래 명령은 저장소 루트에서 실행한다.

```bash
# 1. DNS가 서버 공인 IP를 가리키는지 먼저 확인한다.
dig pacs.koreaimagingnetwork.com

# 2. 최초 한 번만 standalone으로 발급한다. proxy가 80번을 잡고 있으면 안 된다.
docker compose -f docker-compose.yml -f docker-compose.prod.yml stop proxy
sudo certbot certonly --standalone -d pacs.koreaimagingnetwork.com

# 3. 인증서 파일을 확인한 뒤 운영 스택을 올린다.
sudo test -s /etc/letsencrypt/live/pacs.koreaimagingnetwork.com/fullchain.pem
sudo test -s /etc/letsencrypt/live/pacs.koreaimagingnetwork.com/privkey.pem
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

최초 발급 뒤에는 nginx가 `/.well-known/acme-challenge/`를 서빙하므로 갱신만 webroot로 한다.
갱신 성공 뒤에는 새 인증서를 읽도록 proxy를 reload한다.

```bash
sudo certbot renew --webroot -w "$(pwd)/certbot/www"
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec proxy nginx -s reload
```

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

### RS는 진행률이 아니라 책임의 소재다

| RS | 뜻 | 누가 다음을 하나 |
|---|---|---|
| W | 판독 대기 | 아무 판독의나 |
| T | 임시 저장 | 같은 기관 판독의 누구나 이어서 |
| **P** | **예비 판독 (Preliminary)** | **지정된 상급 판독의만** |
| A | 승인 완료 | Addendum만 가능 |

`P`는 상태 표시가 아니라 **접근 제어**다. Prelim 버튼으로 상급 판독의를 지정하면
그 사람과 작성자 외에는 판독문 내용을 볼 수 없다 — 워크리스트에 검사는 보이지만
Findings 칸에 "누가 최종 판독 중"이라고만 뜬다. 이력 조회·임시저장·점유도 함께 막힌다.

> 왜 가리나: 예비 판독은 상급자가 뒤집을 수 있는 소견이다. 확정되지 않은 내용이
> 기관 전체에 퍼지면 나중에 정정해도 이미 읽은 사람의 판단까지 정정되지는 않는다.
> (HPACS 매뉴얼 7.4.1.3-4.1 — "지정된 판독의만 판독 내용을 볼 수 있다")

**작성자도 자기 예비 판독을 스스로 승인할 수 없다.** 그러면 감독이라는 절차가 사라진다.
`Reset to Unread`로 되돌리면 지정도 함께 풀린다.

지정 대상은 서버가 Keycloak에 물어 만든 실제 명단에서 고른다(`GET /api/colleagues`).
접근 권한을 좌우하는 값을 자유 입력으로 받으면 오타 하나에 아무도 못 여는 판독문이 생긴다.

`H`/`O`는 아직 없다. 릴리즈 노트 원문상 둘 다 "초안이 저장된" 상태이고, 우리 `T`가 사실상
`O`(판독 중)에 해당한다. `H`는 보류로 추정하지만 정의가 어디에도 없어 지어내지 않았다.

### Reset은 지우기 전에 남긴다

`Reset to Unread`는 저장된 판독문을 지운다. 그런데 초안(`PUT .../report`)은 버전을 남기지
않으므로, 그냥 지우면 그 내용이 어디에도 안 남는다 — 사유만 남고 무엇을 버렸는지는 모른다.
그래서 지우기 **직전 내용을 `ReportVersion`에 `discarded`로 한 판 박고** 지운다.
같은 트랜잭션이라 "지워졌는데 기록은 없다"가 생길 수 없다. 화면에는 안 보이고 이력에만 남는다.

### 필터와 상용구는 브라우저가 아니라 계정에 붙는다

판독의는 자기 필터를 하루 종일 쓴다. PC를 바꿨다고 초기화되면 깨지는 건 작업이 아니라 신뢰다.
HPACS는 이 카테고리 버그를 5년간 반복했고(교훈 §6) 2024년에야 "계정별 저장"에 도달했다.

- **사용자 필터** — Save Filter로 이름을 붙여 저장. 컬럼 필터·Quick Search·날짜·모드에 더해
  **정렬(sortKey/sortDir)까지** 함께 저장한다. 필터가 같아도 정렬이 다르면 다른 화면이다.
- **기본 필터(⚑)** — 칩 우클릭 → "기본 필터로 지정". 다음 로그인부터 자동으로 걸린다.
  기본은 하나뿐이라, 새로 지정하면 이전 것이 풀린다.
- **판독 상용구** — 목록에서 우클릭 → 새로 만들기 / 수정 / 삭제. 매뉴얼이
  "Upload/Download **My** Template File"이라고 부르듯 기관 공용이 아니라 개인 것이다.
  새 계정은 기본 3종을 받고 시작한다(빈 목록은 버그처럼 보인다).
- 칩 우클릭이 바로 삭제하지 않고 메뉴를 띄운다. 되돌릴 수 없는 동작에 손이 미끄러질
  자리를 주지 않는다(교훈 §5).

> **모든 걸 계정에 두는 게 답은 아니다.** HPACS는 필름박스 Hanging Protocol만은
> "계정 + 컴퓨터"별로 기억하도록 따로 만들었다 — 집의 1대 모니터와 병원의 3대 모니터에
> 같은 레이아웃을 강요할 수 없기 때문. **사람에 딸린 것은 계정에, 기기에 딸린 것은 기기에.**

### 검사는 어떻게 들어오나 — C-STORE

실제 CT/MR 장비는 HTTP를 모른다. DICOM 상위 프로토콜로 TCP 연결(Association)을 맺고,
어떤 SOP Class를 어떤 전송구문으로 보낼지 협상한 뒤, **C-STORE**로 인스턴스를 하나씩 민다.
`scripts/send_cstore.py`가 그 장비 역할을 한다 (Orthanc의 DICOM 포트 4242, AET `KINLAB`).

```bash
python3 send_cstore.py                                    # 한림병원 CT 1건
python3 send_cstore.py --institution "KIN 판독센터"        # 다른 기관에서 도착
python3 send_cstore.py --verbose                          # 협상 로그를 전부 본다
```

DCMTK가 있다면 같은 일을 이렇게 한다: `storescu -aec KINLAB -aet HALLYM_CT localhost 4242 파일.dcm`

도착한 검사는 **SS=Unverified**로 등록된다. 방사선사가 Technician 탭에서 Verify해야
Radiology 탭에 올라온다 — 도착하자마자 판독 목록에 뜨면 기사가 환자·검사정보를 고칠 틈이 없고,
판독이 붙은 뒤에는 더 고칠 수 없다(RS≠W 규칙).

전송 성공과 저장 성공은 다른 사건이다. 스크립트는 C-STORE 응답 상태를 하나씩 확인하고,
하나라도 0x0000이 아니면 실패로 끝낸다. 보낸 수와 저장된 수가 어긋나는 것이
원격판독에서 가장 흔한 사고다(교훈 §10).

### 기관 모델 (멀티 기관 테넌시)

권한(무엇을 할 수 있나)과 기관(무엇을 볼 수 있나)은 **다른 축**이다.

- 검사의 소속 기관은 DICOM `InstitutionName`(0008,0080)에서 판정한다. 영상에 찍혀 오는 사실이므로,
  처음 목록에 올라올 때 `StudyState.institutionId`에 확정한다. 알아볼 수 없는 기관명은
  아무 데나 밀어넣지 않고 **미배정**으로 둔다 — 조용히 섞이는 것이 가장 나쁘다.
- 사용자의 기관은 Keycloak **그룹**에서 온다. 서명된 토큰의 `groups` 클레임이므로
  클라이언트가 고칠 수 없다.
- 브라우저는 더 이상 `/dicom-web/studies`를 직접 부르지 않는다. **API가 QIDO-RS를 대신 부른다.**
  화면 필터는 경계가 아니라 커튼이다 — 주소창에 그 URL을 치면 다 보이기 때문.
- 기관을 넘는 통로는 **`StudyState.teleInstitutionId` 하나뿐**이다. 원격판독을 의뢰하면
  거기에 수신 기관이 박히고, 취소하면 지워진다. `none`/`wait`/`sending`/`sent`는 의뢰 기관이,
  `inReading`/`completed`는 수신 기관이 민다.

> **주의**: Orthanc는 아직 하나다. 지금 가른 것은 DB 레코드의 소속과 목록이고,
> 영상 픽셀(WADO)·뷰어는 여전히 공용이다. 영상 자체의 기관 분리는 5단계(기관별 게이트웨이)의 몫.

### API 엔드포인트

| 메서드 | 경로 | 하는 일 |
|---|---|---|
| GET | `/api/bootstrap` | 프론트 시작 시 내 기관 상태·판독문·오더·기관 목록을 한 번에 |
| GET | `/api/studies` | **검사 목록** — 서버가 Orthanc QIDO-RS를 대신 부르고 기관으로 걸러 준다 |
| PATCH | `/api/studies/:uid` | RS·SS·EM·TS·Ward 등 부분 수정 |
| PUT | `/api/studies/:uid/report` | 판독문 임시저장 (버전 안 남김) |
| POST | `/api/studies/:uid/report/commit` | 판독문 확정 — `save`/`approve`/`addendum`/`reset` |
| GET | `/api/studies/:uid/report/versions` | 판독문 개정 이력 |
| POST | `/api/studies/:uid/hold` · `/release` | 판독문 점유 선언·하트비트 / 해제 |
| POST | `/api/match` · `/api/unmatch` | 검사↔오더 매칭 (트랜잭션) |
| GET | `/api/audit?uid=` | 감사 로그 |
| GET | `/api/me` | 내 토큰의 주인·롤·기관 |
| GET | `/api/colleagues` | 내 기관의 다른 판독의 (Preliminary 지정용, Keycloak에서 조회) |
| GET | `/api/prefs` | 내 필터·판독 상용구 (계정에 저장) |
| POST | `/api/filters` · DELETE `/api/filters/:id` | 필터 저장(이름이 같으면 덮어씀) / 삭제 |
| PATCH | `/api/filters/:id/default` | 기본 필터(⚑) 지정·해제 |
| POST | `/api/templates` · DELETE `/api/templates/:id` | 상용구 저장(id 있으면 수정) / 삭제 |

### 판독문은 덮어쓰지 않는다

`Report`는 현재 내용이고, `ReportVersion`은 **추가만 하는 역사**입니다.

- 임시저장(검사를 옮겨다닐 때 자동)은 버전을 남기지 않습니다 — 손실 방지가 목적
- Save / Approve / Addendum / Reset은 그때의 내용을 그대로 한 판으로 적립합니다
- **Approve된 판독문을 고쳐도 이전 승인본은 남습니다.** Addendum은 승인본 위에 덧붙는 새 판입니다
- **Reset to Unread에는 사유가 필수**입니다. 저장된 진술을 지우는 일이므로 사유가 기록에 남습니다

판독문은 의무기록입니다. "누가 언제 무엇이라고 말했는가"가 나중에 뒤집히면 안 됩니다.

### 두 사람이 같은 검사를 열면

- **점유는 열람이 아니라 쓰기로 시작합니다.** 판독문에 두 글자 이상 입력하면 그때 잡힙니다.
  검사를 열어보는 건 흔한 일이라 그걸 점유로 치면 경고가 남발되고, 남발된 경고는 무시됩니다
- 점유자는 워크리스트 **Viewing** 열에 표시됩니다 (내가 잡으면 초록 `✎ 나`, 남이 잡으면 주황)
- 점유는 **막지 않고 알려줍니다.** 응급 판독을 자물쇠로 세우는 건 위험합니다
- **실제로 덮어쓰기를 막는 건 저장 시점의 버전 비교**입니다. 그 사이 남이 저장했으면 409로
  거절하고, 내가 쓰던 내용은 클립보드에 넣은 뒤 서버 것을 보여줍니다
- 점유는 5분 뒤 자동으로 풀립니다. 브라우저가 죽어도 검사가 영원히 잠기지 않게

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
curl -u "$ORTHANC_USER:$ORTHANC_PASS" http://localhost:8042/studies
curl -u "$ORTHANC_USER:$ORTHANC_PASS" http://localhost:8042/dicom-web/studies   # QIDO-RS

# DICOM 프로토콜 맛보기 — DCMTK 설치 후 (brew install dcmtk / apt install dcmtk)
storescu -aec KINLAB localhost 4242 sample-data/ct_030.dcm    # C-STORE 전송
```

## 문제 해결

- **8042 포트가 이미 사용 중**: `docker-compose.yml`의 `"8042:8042"`를 `"8043:8042"`로
  바꾸고 주소도 `localhost:8043`으로.
- **/ohif/ 가 404**: `docker compose up -d` 후 플러그인 로드까지 몇 초 걸림.
  `curl -u "$ORTHANC_USER:$ORTHANC_PASS" http://localhost:8042/plugins` 에 `"ohif"`가 보여야 정상 —
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
- **운영 Keycloak 컨테이너를 재생성함**: H2가 초기화돼 공개 개발값이 다시 import되므로,
  관리자 비밀번호와 `kin-api` 클라이언트 시크릿을 즉시 다시 설정하고 `.env`도 맞춘다.
- **Keycloak이 `AccessDeniedException: keycloakdb.mv.db`로 죽음**: H2 경로에 이름있는 볼륨을
  붙였을 때 생긴다(root 소유로 만들어지는데 Keycloak은 UID 1000). `keycloak/README.md` 참고.
- **API가 401만 뱉음**: 토큰의 `iss`와 API의 `KC_ISSUER`가 달라진 경우. compose의
  `KC_HOSTNAME`과 `KC_ISSUER`가 둘 다 `http://localhost:8080`인지 확인.
- **처음부터 다시**: `docker compose down -v` (영상·DB·Keycloak 계정이 전부 삭제됨)

## 이것이 사업의 미니어처인 이유

지금 만든 구성 — 아카이브(Orthanc) + 표준 API(DICOMweb) + 뷰어(OHIF) — 는
Korea Imaging Network 데이터센터의 최소 원형입니다. 3단계에서는 이 Orthanc를
세 대로 늘려 "A병원 → 게이트웨이 → B병원" 라우팅을 만들게 됩니다.
