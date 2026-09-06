# 살아 있는 불변조건 테스트

D03A 자동 과거 검사 선택: `node --test tests/worklist_prior_test.cjs` (날짜·기관 포함 환자키·modality·동률 6개 순수 시험).
추가 실기: `python tests/e2e/test_prior_selection.py` (합성 CT의 실제 StudyDate·양 canvas/UID·수동 미래 비교와 개인 초안/이력 보존 2개).
기존 `test_worklist.py` 14개와 별도로 실행한다. 로컬 대상 제한·임시 인증·소유 fixture 정리를 그대로 사용한다.

D02A 세로 작업공간: `python tests/e2e/test_portrait_workspace.py` (별도 3개).
900×1400·768×1024 패널/스크롤/크기 조절, 가로 복귀, 실제 썸네일→OHIF,
상용구·개인 초안·승인 이력·촬영 잠금·Technician Verify를 검증한다.
한 장의 합성 CT phantom과 임시 계정/상용구만 사용하며 원본 해시와 소유 데이터 정리를 확인한다.

D02B 배치 저장: `node --test tests/workspace_layout_test.cjs` (순수6)와
`python tests/e2e/test_workspace_persistence.py` (별도 실제3).
계정 A/B×브라우저 프로필 X/Y·재로그인·가로/세로 크기·초기화·불량값/저장소 거부를 검증한다.
배치는 이 계정의 현재 origin/브라우저에만 저장되며 다른 기기와 자동 동기화되지 않는다.
세로 검증 범위는900×1400·768×1024, 가로1600×1000이다. 더 짧은 창의 모든 패널 접근은 미검증이다.
상용구 결합/영어 탭 등 UI 문구 변경 시 D02A/B 시험 기대값도 함께 검토한다.

D02C 썸네일 요청: `python tests/e2e/test_thumbnail_requests.py` (별도 실제3).
32시리즈 합성 CT에서24/8 페이지·최대4 worker·페이지 재조회·A→B→A 취소·개별503/metadata503 복구를 검증한다.
실제 CDP requestId 종결과 시험 nonce만 포함한 nginx 종료 행을 비교하며 로그/화면은 ignored artifacts에 둔다.
현재 페이지 blob만 보관하고 페이지 이동/검사 전환/이탈의 URL 해제와 전체 합성 원본hash·개인초안/확정/이력을 확인한다.
nginx200/499는 gateway 종결/연결 해제이며 upstream 계산 취소를 증명하지 않는다. OHIF loader는 별도 범위다.
현재 페이지의24개 제한은 metadata 응답 바이트나 개별 preview의 크기 상한을 보장하지 않는다.

C1 실행 계약: `python -B tests/ops_deploy_runner_test.py`.
실제 임시 Git·durable journal·별도 프로세스 lock 경합을 사용하지만 Docker 교체·smoke·승인·알림은
합성 호스트다. `ops_deploy_runner.py`는 고정 어댑터를 위한 상태기계 core이며 운영 어댑터/배포 CLI는
제공하지 않는다. 요청에 결속한 승인·복원·앱 호환 근거를 검증하는 신뢰 어댑터가 필요하다.
같은 backup lock 안에서 사전검사를 재관측하고 교체·전체 smoke·최대1회 앱 복귀까지 유지한다.
`DEPLOYED`만 배포 성공이고 `ROLLED_BACK`은 배포 실패다. 작업 종료 미확인/timeout·복귀/기록 실패는
`NEEDS_ATTENTION`과 lock 보존으로 끝난다. 보존 lock을 자동 삭제하지 않으며 실행 작업과 실제
컨테이너 상태를 사람이 대조한 후 복구한다. DB 자동 복원은 없다. 알림 실패는 durable pending이고,
accepted도 실제 수신을 증명하지 않는다. 기존 사전검사 CLI는 계속 읽기 전용이다.
운영 연결 전에는 개발자가 수정할 수 없는 실행기/정책/승인 저장소, 실제 서버 밖 복원·호환 근거,
기존 고정 메일 채널 연결과 실제 배포 smoke가 필요하다. 이 시험을 운영 배포 완료로 세지 않는다.

C5-2 SMTP/outbox 안전 시험: `python tests/ops_email_monitor_test.py` (실제 메일 발송 없음).
외부 호스트의 `scripts/ops_email_monitor.py`는 기존 HTTPS probe를 재사용하고 상태 전이 때만
smtp.daum.net:465에 인증서 검증을 켜서 발송한다. `--origin`, `--recipient`, `--credentials`,
`--state-dir`를 고정해 설치하며 최초 `--initialize`는 상태 파일을 배타 생성한다.
`--mode drill-alert|drill-recover`는 별도 훈련 상태를 사용한다. 기존 상태가 사라지거나
손상되면 자동 초기화하지 않는다. 발송 실패는 outbox를 보존하며 같은 Message-ID로 재시도한다.
UTC일별 실감시 발송 시도 상한24, 훈련 예산 별도24. SMTP 수락 직후 저장 실패 때 중복 가능하며
SMTP 수락만으로 받은편지함 도착이 검증되는 것은 아니다. credential·첨부·원본 로그는 메일에 넣지 않는다.

C1-2a 배포 전 검사 안전 시험: `python tests/ops_deploy_preflight_test.py`.
실제 임시 Git 저장소와 별도 프로세스 lock 경합을 포함하며 실행 서비스는 바꾸지 않는다.
`scripts/ops_deploy_preflight.py request.json --request-sha256 <sha256>`은 기존 backup lock
안에서 고정 요청·Git·로컬 이미지·현재 API를 조회한다. base+prod+monitor 세 파일이 필수다.
성공은 관측 결과이며 운영 승인·배포·자동 복귀를 실행하지 않는다. 같은 개발 계정에서
작성 가능한 요청/hash는 승인 권한 분리가 아니다. 향후 실행기는 같은 lock 안에서
전제를 재검사하고, 서버 밖 복원·외부 감시·별도 승인·실제 앱 호환성을 갖춰야 한다.

```powershell
docker compose up -d
python tests/invariants_live.py
```

테스트는 현재 저장소의 Keycloak·Orthanc 개발 설정을 읽어 실제 토큰과 C-STORE를 사용한다.
로컬 `.env`는 필요한 값을 출력하지 않고 실행 환경에만 읽는다. Orthanc 비밀번호를
별도로 주려면 `KIN_TEST_ORTHANC_PASSWORD`를 쓴다.

fixture 수신은 기본 `KIN_TEST_INGEST=cstore`로 로컬 Orthanc 4242를 사용한다. 운영 4242를 닫은
대상에서 Gateway 수신 smoke만 실행할 때는 해당 기관 Gateway를 먼저 띄우고 다음처럼 지정한다.

```powershell
$env:KIN_TEST_INGEST="gateway"
$env:KIN_TEST_GATEWAY_HOST="127.0.0.1"
$env:KIN_TEST_GATEWAY_PORT="4243"
$env:KIN_TEST_GATEWAY_AET="KINGW"
$env:KIN_TEST_GATEWAY_INSTITUTION_NAME="KIN 판독센터"
python tests/invariants_live.py LiveInvariantTests.test_selected_ingest_reaches_worklist
```

전체 불변조건(v0.6.3 기준 69개)은 두 기관 fixture를 쓰므로 로컬 `cstore` 모드로 실행한다. Gateway smoke는
자격증명의 기관과 `KIN_TEST_GATEWAY_INSTITUTION_NAME`이 일치해야 한다. 실제 환자 영상이 아닌
격리된 시험 Gateway와 공개 fixture만 사용한다.

Keycloak 사용자 시험은 기존 개인·시드 계정의 비밀번호를 읽거나 바꾸지 않는다.
매 실행마다 `kin-test-*` 사용자와 `kin-invariants-*` password-grant 전용
클라이언트를 임시로 만들고 종료 정리에서 정확한 ID로 삭제한다. `kin-web`은
Authorization Code + PKCE 전용 설정을 유지한다.

각 픽스처는 임의의 Study UID로 매번 새로 전송되고, 종료할 때 그 UID의 Orthanc 스터디와
DB 행만 삭제된다. 정리 대상 UID가 숫자와 점 이외의 문자를 포함하면 DB 삭제를 거부한다.

회원 관리 배터리는 서비스 계정 제외·쓰기 차단, 자기 정지·관리자 해제 차단,
정지 즉시 BFF 세션 401, 삭제·범용 프록시·impersonation·클라이언트 경로 부재,
XSS 문자열의 원문 계약과 `textContent` 렌더링, 임시 비밀번호 1회 표시,
이메일 미검증 승인 거부, PENDING/INVALID 코드를 확인한다. 마지막에는 전용
시험 관리자 집합만 모두 비활성화한 뒤 컨테이너 loopback `kcadm` 복구를 리허설한다.

`test_zzz_known_failure_concurrent_commit_must_not_return_500`은 동시 확정 16건에서 500이
한 건도 나오지 않는지 검사한다. 성공 1건을 제외한 충돌은 409여야 한다.

v0.6.3 회귀 확충(+23)은 네 묶음이다. 판독 상태기계 W/T/P/A/H — 한 fixture로 전이표를 끝까지
걷고 거절 칸의 상태·이력 불변, repDoc·confirm·지정 필드의 동반 이동, baseVersion 없음(400)과
틀림(409), 판 번호 연속·append-only, 제3자의 P 접근, 상급 판독의 검증, 초안이 확정본을 안 건드림.
점유 — TTL 만료(psql로 `heldAt`을 과거로), 남의 release는 no-op, 재점유마다 감사 1건, 충돌 hold는
DB 무변경, 원격판독 양방향 holder 노출. 회원 승인 — 승인/취소 왕복과 세션 폐기, 입력 검증의 무부작용,
INVALID 두 축의 교정, 대면 생성, verificationOverride 감사, 자격 변경 세션 폐기, 임시 비밀번호 비기록
(회원 감사 행은 `/audit`이 아니라 psql로 읽는다). 교차 — 원격판독 TS 상태머신, 감사 action 표와
본문 비노출, PATCH 우회 표, 잔여 역할·기관 관문(dicom/lookup·남의 기관 오더).

## Run B2 — 실제 브라우저 E2E

```powershell
python -m pip install --only-binary=:all: -r tests/e2e/requirements.txt
python -m playwright install chromium
docker compose up -d
python tests/invariants_live.py
python tests/e2e/test_worklist.py
```

Python 3.9 이상, 기존 불변조건의 `pydicom`·`pynetdicom`·`requests` 및 로컬 공개 CT
샘플이 필요하다. Playwright/Chromium 버전은 requirements와 설치 명령으로 맞춘다.
Python 3.9 Windows에서는 greenlet 3.1.1 바이너리를 고정해 C++ 빌드 도구 없이 설치한다.
두 시험 명령은 순차 실행하고 **둘 다 종료코드 0**이어야 한다. skip/expectedFailure를
추가해서 통과시키지 않는다. 화면을 보려면 `KIN_E2E_HEADED=1`을 설정한다.

E2E는 14개 시험(화면 흐름 11 + 로컬 대상 거부 3)이다. 실제 정식 입구 `/` →
`/worklist/hpacs-lite/index.html` → Keycloak 로그인 폼 → BFF 세션으로 시작한다.
API를 mock하거나 토큰을 브라우저에 주입하지 않는다. 독립 browser context를 사용해
판독의 2명·기사·관리자의 점유와 역할을 구분한다. API는 공개 fixture 준비와 결과 검증에만 쓴다.

| TEST ID | 검사 내용 |
|---|---|
| E2E-B2-01 | BFF 로그인, HttpOnly/Secure/Strict 쿠키, 토큰 저장소 부재, UI 로그아웃 후 401 |
| E2E-B2-02 | 검사 선택과 UID별 초안/확정본 격리 |
| E2E-B2-03~05 | 촬영중 잠금, 기사 Verify, 응급 우회와 다른 검사 잠금 유지 |
| E2E-B2-06 | prior 소견, 더블클릭 hpCompare, 두 UID의 frame 200과 두 캔버스 실제 픽셀 표시 |
| E2E-B2-07~08 | 두 계정 점유, 비관리자 메뉴 부재, 관리자 강제 해제 감사와 기존 초안 보존 |
| E2E-B2-09~10 | 보류/Reset 사유 모달·취소 무변경·서버 사유와 승인 이력 보존 |
| E2E-B2-11 | UI 승인 후 Save/Transcribe/Approve 비활성, 재로드 지속 |
| E2E-B2-12a~c | 원격 URL·자격증명 URL·Docker Host/Context·Gateway·운영 Compose 거부 |

E2E는 로컬 `cstore` 전용이다. 운영 서버에서 실행하지 않는다. 로컬 URL과 Docker 소켓을
자원 생성 전에 검사한다. 시험마다 소유한 UID의 Orthanc·DB·감사 행 삭제 결과를 확인하고,
마지막에 임시 계정의 BFF 세션·Keycloak 계정·전용 시험 클라이언트도 정리한다.
정리 실패는 시험 실패다. 강제 프로세스 종료 때는 finally가 실행되지 않을 수 있으므로
실행을 중단했다면 해당 실행의 임시 `kin-test-*`/UID 잔존을 확인한다.

실패 스크린샷은 인증된 워크리스트만 `tests/e2e/artifacts/`에 저장하고 Git에서 제외한다.
비밀번호·쿠키·토큰·storageState·네트워크 trace는 파일에 저장하지 않는다.
실제 다중 모니터 권한과 모니터별 배치, 임상 화질 적합성은 이 시험의 검증 범위가 아니다.

## Run C — 백업과 격리 복원

```powershell
python tests/ops_backup_test.py
python scripts/ops_backup.py backup --output "$env:USERPROFILE/backups/kin-pacs"
python scripts/ops_backup.py rehearse <출력된-백업-디렉터리>
```

서버에서는 저장소 폴더에서 `python3 scripts/ops_backup.py backup --output "$HOME/backups/kin-pacs"`를 쓴다.
원격 Docker context는 거부한다. 백업 시 **API·Keycloak·Orthanc가 잠시 중단**되므로 E2E나 다른
운영 작업과 동시에 실행하지 않는다. 약 1.1GB 로컬 영상의 첫 측정은 정지~재시작 명령 121초였다.
`.kin-ops.lock`으로 이 스크립트끼리의 중복을 막는다. 강제 종료 뒤 남은 lock을 자동 삭제하지 않는다.

두 DB의 custom dump, Orthanc SQLite 인덱스·첨부 전체 archive, Git SHA, Compose·.env,
파일별 SHA-256과 모든 DB 테이블 행수를 저장한다. 실패해도 원래 켜져 있던 서비스만 재기동한다.
API·OIDC·워크리스트 준비까지 확인한다(`--ready-timeout` 기본 120초, 최대 900초).
부분 백업/재기동/준비 실패는 backup 명령 종료코드 1이다. 완성된 snapshot의 유효성과 서비스
준비 상태는 별도로 기록하므로, 재기동에 실패해도 checksum이 맞는 snapshot은 복원 리허설에 쓸 수 있다.
Linux에서 새 백업 디렉터리 700·파일 600을 적용한다. 기존 출력 부모 디렉터리는 권한을 바꾸지 않고
현재 사용자 소유·그룹/기타 접근 없음 조건을 확인한다. 공용 부모라면 새 전용 하위 디렉터리를 출력 위치로 쓴다.
실행 중인 5개 컨테이너의 이미지 ID·RepoDigests도 기록한다. 백업에는 시크릿이 있으므로 Git 밖에 보관한다.

복원은 포트 게시/외부 네트워크가 없는 임시 PostgreSQL과 새 Orthanc volume에서만 실행한다.
두 DB의 실제 restore·테이블별 행수, SQLite integrity_check·모든 첨부 파일 존재/크기를 확인한다.
백업 당시의 로컬 Docker image ID가 필요하다. 임시 자원은 실행별 이름과 소유 label 확인 후 정리하며,
실패 결과도 백업 폴더의 `rehearsal-*.json`에 남긴다. 기존 DB/volume에 덮어쓰는 기능은 없다.

`ops_backup_test.py`는 실패 뒤 서비스 재개·시크릿 출력 방지·변조 백업 거절·소유권 없는 자원 삭제
거절·작업 잠금·daemon 장애·archive 경로·부모 권한 보존·준비 실패와 snapshot 분리 등
17개 안전 시험이다(TEST-OPS-01~02). 실제 복원 리허설과 함께 통과해야 한다.
쓰기 서비스 재개 후 nginx 설정 검사·reload로 정적 upstream의 Docker IP를 다시 해석한다.
reload 실패는 준비 실패로 기록하고 종료코드 1을 반환한다. 실행 중이던 proxy에만 적용한다.
Linux의 root Docker helper가 호스트 파일 소유권을 바꾸지 않도록 Orthanc 압축은 stdout으로
흘리고 호스트 실행 계정이 파일을 쓴다. 바이너리 스트림·timeout 뒤 소유 helper 정리도 검사한다.
이 단계의 서버 내부 백업은 오프사이트 재해복구가 아니다. Gateway queue·인증서·Docker 이미지
오프사이트 보관과 보존/암호화 정책은 별도다. 스크립트 자체가 cron을 설치하거나 오래된 백업을 삭제하지 않는다.

## Run C — Prisma baseline과 시작

기존 데이터베이스는 검증된 백업을 먼저 만들고, 초기 schema와 실제 DB가 일치할 때만
`docker compose exec -T api node prisma/baseline.mjs`를 **한 번** 실행한다. 이후
`docker compose up -d --build api`로 새 시작 명령을 적용한다. 새 빈 DB는 baseline 없이
`migrate deploy`가 `0_init`을 실제 생성한다. baseline은 자동 부팅 명령에 넣지 않는다.
API 의존성은 `package-lock.json`과 Dockerfile의 `npm ci`로 고정한다.

`baseline.mjs`는 초기 schema·migration SHA-256·Prisma 5.22.0·DB drift·기존 migration
이력을 확인하고, 이미 같은 baseline이면 재등록하지 않는다. 빈 DB/변형된 SQL/다른 이력은
거부한다. 기존 테이블 행수도 전후 대조한다. `prisma migrate reset`·`db push`·`accept-data-loss`를
실패 해결 절차로 사용하지 않는다. 새 변경에는 새 migration 파일과 별도 검토가 필요하다.

```powershell
python tests/migration_rehearsal.py <완료된-백업-디렉터리>
```

이 시험은 현재 API 이미지와 체크아웃의 Prisma 파일을 네트워크 격리된 임시 PostgreSQL에
연결한다(TEST-OPS-03). 빈 DB baseline 무변경 거부, 빈 DB deploy/schema 일치,
기존 DB baseline 반복/deploy/전체 테이블 행수 보존, drift 거부와 이력 미생성을 확인한다.
살아 있는 DB 행수·migration metadata 불변과 임시 컨테이너 정리도 확인한다.
새 초기 baseline을 채택하는 시점의 리허설이므로 baseline 적용 전 백업을 입력으로 쓴다.
# C1 production image validation

The isolated test uses a disposable PostgreSQL on a network namespace with no
external networking or published ports. It checks real migrations, compiled
startup, preserved rows/history on restart, authentication refusal, failed DB
startup and Node signal handling. Its temporary resources carry unique ownership
labels; it never connects to the shared PACS database.

```powershell
$env:KIN_REVISION = git rev-parse HEAD
docker compose -f docker-compose.yml -f docker-compose.runtime-test.yml build api
$env:KIN_EXPECTED_REVISION = $env:KIN_REVISION
python tests/production_image_test.py
docker compose -f docker-compose.yml -f docker-compose.runtime-test.yml up -d --no-deps --no-build api
docker exec kin-proxy nginx -t
docker exec kin-proxy nginx -s reload
python -c "import sys; sys.path.insert(0, 'scripts'); import ops_backup; ops_backup.wait_ready('https://localhost:9443')"
python tests/invariants_live.py
python tests/e2e/test_worklist.py
```

Run on the local test stack only. Confirm HTTPS `/api/health` and published ports
after replacement. To return to local source watching, use
`docker compose up -d --no-deps --build api`, then validate/reload nginx and check
health again. Operating the API in production does not require Nest CLI, a source
mount or a TypeScript compiler. Prisma CLI remains installed for `migrate deploy`.

GitHub `Validate production image` runs the 17 backup safety tests and isolated
production image tests for main, PRs and tags, recording the exact SHA/image ID.
It does not deploy, publish a registry image or replace the 69+14 live/browser
release gates and independent review. No production credentials are used in CI.

## C5 host monitoring and external notification checks

`python tests/ops_monitor_test.py` checks stale/failed backups, bounded maintenance,
restart counters, external response validation and private issue notification
boundaries. Linux flock/permission cases must run on Linux (CI or a disposable
container); a Windows skipped result is not the full gate.

The reviewed `scripts/ops_monitor.py collect` runs once per minute on the Docker
host with explicit `--repo`, `--backups`, `--state-dir` (dedicated mode700) and
`--public-dir` (dedicated mode755). The public directory contains only status.json:
schema, checked_at, ok and maintenance_until. Mount it read-only into proxy with
`docker-compose.monitor.yml` and `KIN_MONITOR_PUBLIC_DIR`; never mount backups or
private state into nginx. Pin the installed collector SHA256 outside Git and check
it before each cron invocation. It only reads services/backups and never restarts,
restores or deletes them. Missing/expired status is an external failure.

`scripts/ops_monitor.py probe --origin https://example.test --output report.json`
validates TLS, status age (180 seconds), API authentication configuration, OIDC
issuer and worklist content; it retries a failed observation once after 15 seconds.
Maintenance requires a matching unfinished backup/operations lock and is bounded
to 600 seconds. PostgreSQL/proxy failures and stale/failed backups are not suppressed.
Three automatic restarts within five minutes, active restarting, or a stopped/
unhealthy service fail the host check; a newly replaced container resets its counter.

The workflow example is installed in a **private** operational repository with an
exact reviewed public code SHA, without personal SMTP/SSH credentials. Alert/recover
exercises use a separate marker from real incidents. Issues created by the Actions
bot are assigned to the repository owner; existing incidents are not repeatedly
commented on. Maintenance alone cannot close an incident. The owner must have email
delivery enabled for participating/assigned issue notifications. A GitHub API
notification or accepted issue is not proof of email inbox delivery. Schedule jobs
can be delayed/dropped by GitHub, so this is not a five-minute availability SLA.

## Offline export inventory (C12B-01)

Run `python tests/ops_export_inventory_test.py` for 20 synthetic refusal/round-trip
checks, including real complete/incremental Git bundles. This test does not invoke
Docker or contact a server. POSIX ownership/mode checks require the Linux run.

`python scripts/ops_export_inventory.py PRIVATE_DIRECTORY --inventory-sha256 HASH`
checks an already assembled, quiescent staging directory. It never creates a
snapshot, executes a host script, extracts image files, loads Docker images,
restores databases or uploads data. `inventory_verified` proves only the checked
component consistency. Encryption, offsite receipt, actual restore and deployment
authority remain explicitly false. Freeze the staging files before verification;
the returned hash is not a lock or authorization token for later work.

`inventory.json` has exactly `schema: 1`, a 40-hex `git_sha`, `storage_mode: "local"`,
`running_images` (the five `kin-*` service names to exact `sha256:` identities),
and `files` (relative path to `{ "bytes": positive_integer, "sha256": hex64 }`).
Files must be exactly the following, with private owner-only permissions and no
symlinks, hardlinks, Windows reparse points, extra files or extra directories:

- `snapshot/manifest.json` and the six `ops_backup.FILES` components.
- `source.bundle`, complete in an empty Git repository, containing the named commit
  and the three Compose files plus backup/monitor scripts as regular Git blobs.
- `images/<64hex>.tar` per distinct running image ID. Only uncompressed Docker save
  archives with a single `manifest.json` image entry are supported. Config/layer
  hashes and OCI descriptor chains bind either classic config IDs or containerd
  index/manifest IDs. Gzip layers are streamed; other compression fails closed.
- `host/collector.sh`, `host/crontab.txt`, `host/settings.json`,
  `host/tls-fullchain.pem`, `host/tls-privkey.pem`. Their bytes are inventoried;
  certificate validity and host configuration semantics are not yet validated.

Metadata is limited to 1MiB, each component to 128GiB, image archive members to
8192, layers to 256 and each expanded layer to 8GiB. File/layer hashing is streamed.
The input hash binds bytes, not the author's identity. An intact complete snapshot
with failed source-service resumption remains eligible for this inspection:
`source_services_ready` is false and it must not authorize deployment.

## Local encrypted export preparation (C12F)

`KIN_TEST_AGE=/protected/age python3 -B tests/ops_export_crypto_test.py` runs 25
checks on Linux, including actual age 1.3.2 encryption/decryption, authenticated
tail failure, concurrent input changes, disk errors and publication conflicts.
The sibling `age-keygen` is required only for synthetic tests. Both binary hashes
are pinned; CI checks the official Linux amd64 archive digest before extracting
only these binaries. This is digest verification, not independent Sigsum verification.
Windows runs four platform/schema checks and skips the 21 Linux preparation tests.
In a disposable read-only Docker test container, mount `/tmp` with `exec` because
the fixture copies the binaries into its own protected Linux temporary directory.

The production wrapper is Linux amd64 only. Use an owner-only, quiescent inventory
directory and a separate existing output parent with mode 700. Install the pinned
age binary at a nonsymlink path owned by root or the caller and not group/world
writable. Choose a new output name; the wrapper never replaces an existing result.

```bash
python3 scripts/ops_export_crypto.py seal --source /private/inventory \
  --destination /private/output/sealed --age /protected/age \
  --recipient "$AGE_RECIPIENT" --inventory-sha256 "$INVENTORY_SHA256"
python3 scripts/ops_export_crypto.py unseal --source /private/output/sealed \
  --destination /private/received/opened --age /protected/age \
  --identity /private/keys/identity.txt --receipt-sha256 "$RECEIPT_SHA256"
```

Provide an X25519 recipient for seal and a separate owner-only identity file for
unseal. The identity is never archived or copied into a named output file. Save
the returned receipt digest through a separately trusted channel: receipt hashes
bind bytes and do not authenticate the sender. Unseal requires that digest and
the same verifier source hash. It verifies ciphertext, complete authenticated
plaintext and every inventoried component before publishing `opened/staging`.
Neither command uploads data, restores a database, loads an image, or authorizes
deployment. Successful preparation still reports offsite/restore/deployment false.

On a caught failure, only partial files inside this invocation's exclusively
created `.NAME.pending` directory are removed, with a fixed failure marker left
for inspection. Existing pending directories are refused. Abrupt termination or
power loss can leave private partial files: inspect that pending directory before
retrying; there is no automatic reclamation. If parent fsync fails after atomic
publication, the command reports failure but preserves the complete published
directory for inspection. Do not interpret a retry conflict as a new success.
Input files must remain quiescent; stream hashes catch changed bytes but do not
isolate a hostile process running as the same user/root. The total tar and cipher
limit is 512GiB and each age invocation times out after 15 minutes; these are
refusal limits, not demonstrated large-backup capacity or recovery performance.
GNU tar base-256 sizes remove USTAR's 8GiB member encoding limit while preserving
the fixed regular-file allowlist. The boundary test encodes/decodes headers at
8GiB and 128GiB; it does not allocate or encrypt payloads of those sizes.

## Offline storage reconciliation (C4S)

`python3 -B tests/ops_storage_reconcile_test.py` runs 26 synthetic checks on Linux.
Windows runs the 15 pure/parser checks and skips 11 private SQLite checks. The
tool never contacts a cloud provider, downloads objects, deletes orphans, modifies
the source index, restores data, or changes storage configuration.

```bash
python3 scripts/ops_storage_reconcile.py --index /private/snapshot/index \
  --index-sha256 "$INDEX_SHA256" --listing /private/listing.json \
  --listing-sha256 "$LISTING_SHA256" --bucket kin-synthetic-only \
  --prefix kin-c4-fixture/ --destination /private/reports/new-check
```

Actual file processing is Linux only. Both inputs and their parent directories
must be owner-only (directories 700), with no symlinks/hardlinks. Freeze a complete
SQLite snapshot without WAL/SHM/journal sidecars; the tool hashes a private copy
before opening only that copy read-only/immutable. Do not point it at a live DB.
The two expected SHA256 values must be fixed independently of these files.
Use a new destination name under an existing 700 parent; reports never overwrite.

The listing document has exactly `schema: 1`, `bucket`, `prefix`, `profile`, and
`pages`. The supported profile is `{ "orthanc": "1.12.5", "storage_plugin":
"2.5.0", "structure": "flat", "client_encryption": false }`. Each page is
`{ "request_token": null_or_string, "response": ListObjectsV2_JSON }`.
Response fields are `Name`, `Prefix`, `MaxKeys`, `KeyCount`, `IsTruncated`, optional
`Contents`, and continuation tokens. `Contents` entries require `Key` and `Size`;
standard ETag/checksum/owner/time/storage metadata is accepted but not trusted as
content verification. No delimiter, StartAfter, CommonPrefixes, or EncodingType
is supported. Every requested token must follow the prior returned token, match
the response token, and lead to exactly one final non-truncated page. Duplicate
keys, repeated/missing tokens and error envelopes are refused.

This validates an offline transcript, not its authenticity or the provider's
actual completeness. A future collector must preserve and verify that provenance.
Index and listing hashes do not prove that the two snapshots share a point in
time. General current-key listings do not verify object version histories.

The first observed profile supports index fileTypes 1, 1024, and 1025 with the
observed uncompressed representation. UUID and index fileType establish the
association; suffixes are a separate support check, never a way to infer an
orphan's type. Other types/compression, unexpected suffixes and ambiguous UUIDs
are reported conservatively. The private `report.json` includes details; stdout
contains only counts/types and scope limitations. Missing/orphan candidates,
size mismatches and unsupported data can overlap in the counts.

Exit 0 means only complete transcript parsing and no observed UUID/size/support
differences; exit 2 publishes a report with differences; exit 1 refuses invalid
input or failed publication. Content, provider, snapshot consistency, restore,
and migration authority always remain false. Bounds: index 512MiB, listing 64MiB,
10000 pages, 100000 objects/index rows, plus a SQLite instruction/time budget.
These bounds do not establish large-system performance or restoration readiness.

## Bounded storage listing collector (C4U)

`tests/ops_storage_collect_test.py` exercises the actual pinned SDK against a
synthetic TLS server on loopback: 24 checks on Linux, 9 pure checks on Windows
(15 Linux checks skipped). The fixture uses an ephemeral certificate and fake
credentials. It never connects to a provider account. Install the seven locked
wheels only in a dedicated Linux Python 3.10+ venv whose directory is mode 700:

```bash
umask 077
python3 -m venv /private/storage-sdk
/private/storage-sdk/bin/python -m pip install --only-binary=:all: --require-hashes \
  -r scripts/requirements-storage-sdk.txt
/private/storage-sdk/bin/python -B tests/ops_storage_collect_test.py
/private/storage-sdk/bin/python scripts/ops_storage_collect.py collect \
  --config /private/collector.json --config-sha256 "$CONFIG_SHA256" \
  --destination /private/listings/new-listing
```

The operational command contacts the explicitly configured HTTPS endpoint. Only
run it after the endpoint, bucket, prefix, owner, region and read-only credentials
are established. No provider connection has been validated by these tests.
Config and credential files require private 700 parents and owner-only regular
files without symlinks/hardlinks. Config has exactly `schema: 1`, `endpoint`,
`region`, `bucket`, `prefix`, `expected_owner` (12 digits), `credentials_file`
(absolute path), and `storage_profile` (the C4S profile above). Optional private
`ca_file` and `ca_sha256` must be supplied together; TLS verification remains on.
Pin the config SHA independently. Credential JSON has `access_key_id`,
`secret_access_key`, and optionally `session_token`; default AWS profiles and
environment credentials are not used. The API runtime gets no SDK dependency.

Every SDK transmission must be GET ListObjectsV2 for the exact endpoint, bucket,
prefix, expected owner, and current opaque token. Hidden HeadBucket/GetObject,
redirected hosts and extra query parameters are refused before transmission.
Explicit URL encoding is decoded exactly once for keys/prefixes, never tokens.
As in botocore, `+` becomes a space and `%2B` becomes a literal plus; percent
escapes and UTF-8 are validated strictly. The real SDK/TLS fixture covers both.
Each page and the final transcript pass the same C4S contract. No object bytes,
versions, writes, deletions, requester-pays calls or migration are performed.

A separate worker has 120 seconds wall time, 60 seconds CPU, 512MiB address space,
and core dumps disabled. SDK connect/read timeouts are 3/5 seconds, at most two
attempts per call and 20000 total sends; listing limits remain 10000 pages,
100000 objects, 64MiB. The parent kills and reaps the worker on interruption or
timeout before cleaning its own partial files. SDK error details are suppressed.
Other failures retain a private failure marker; pre-existing pending/output
directories are never overwritten. SIGKILL/power loss may retain private partial
files requiring inspection. Code, venv and inputs assume a trusted OS account;
permissions do not isolate a hostile same-user/root process.

Only complete, revalidated `listing.json` and `receipt.json` are atomically
published. Receipt records scope, config/SDK lock/listing hashes, SDK versions,
times and request/page/object counts; it does not copy credentials. stdout has
only counts/hash and limits on what is verified. Exit 0 means completed collection
and publication, exit 1 means refusal/failure. The receipt is not a signature or
proof of content, provider completeness, snapshot consistency, restore readiness
or migration approval; all five authority fields remain false.

## Synthetic image restoration across CI jobs (C12I)

`python -B tests/ops_image_transfer_test.py` runs 12 refusal/validation checks on
Linux; Windows runs six pure checks and skips six Linux file-handling checks.
Docker calls in these tests are mocked. The separate `restore-image.yml` workflow
performs the real transfer between two hosted Ubuntu jobs: a fixed static probe
in a scratch image is saved, uploaded with its receipt, downloaded by exact
artifact ID, validated, loaded and executed in the receiving job. The image must
be absent before load and the two observed Linux boot IDs must differ.

Only `image.tar` and `receipt.json` are uploaded, with one-day retention. No real
PACS data, configuration, keys or private documentation are included. A separate
job output pins the receipt hash; run/SHA/attempt, archive size/hash and complete
config/layer hashes are checked before load. The archive is limited to 16MiB.
The container runs nonroot, read-only, without networking/capabilities, with
memory/CPU/PID/time bounds. Cleanup checks ownership. The real fixture refuses
ordinary local invocation; CI environment flags prevent accidental use but are
not an authorization boundary against a process with the same OS privileges.

This verifies restoration of one synthetic executable image only. It does not
verify the PACS service images, encrypted offsite backup, full restoration or
deployment authorization. Those three authority fields remain false.

## Synthetic database restoration across CI jobs (C12J)

`python -B tests/ops_database_transfer_test.py` checks refusal, private streaming,
full row comparison and cleanup (12 Linux checks; six pure on Windows with six
Linux skips). Docker calls are mocked in these tests. `restore-database.yml`
performs the actual two-job restoration using a pinned PostgreSQL 16 Alpine
base with a unique fixture label. The producer creates two synthetic databases
with three fixed rows each and exports custom-format dumps plus the image.
The consumer requires a different boot ID and an absent image before validating
and loading the image, restoring both dumps and comparing every ordered row.

The four-file, one-day artifact is bound to the run/SHA/attempt and separately
supplied receipt hash. Private streaming copies cap images at 512MiB, each dump
at 16MiB and receipts at 8KiB. Hashes, image config/layers and fixed configuration
are checked before load. Both databases run as UID70 with no network or host
ports, a read-only root, dropped capabilities and bounded tmpfs/memory/CPU/PIDs.
TCP readiness excludes PostgreSQL's temporary initialization server. Only owned
containers and images are removed. Source hashes are compared after restoration.

The public artifact contains synthetic data only, with no encryption keys or
production inputs. This checks PostgreSQL image/dump restoration; it does not
restore the real API schema, Keycloak realm, Orthanc or complete PACS services.
Full restoration, encrypted offsite backup and deployment authority remain false.
The CI environment guard is an accidental-use check, not a same-user security
boundary. CLI timeout leaves a short interval before finally removes resources;
runner/process termination can prevent that cleanup.

## Synthetic Orthanc restoration across CI jobs (C12K)

`python -B tests/ops_orthanc_transfer_test.py` runs 14 checks on Linux and nine
on Windows (five Linux file-handling checks are explicitly skipped). Docker
calls are mocked in these refusal tests. `restore-orthanc.yml` performs the real
two-job transfer of a pinned Orthanc 1.12.5 image and a frozen synthetic store.
The producer creates one synthetic DICOM instance and attachments 1024/1025,
gracefully stops and reaps Orthanc, then checks SQLite integrity and every stored
attachment's size/MD5/SHA256. Only the index and three attachment files enter the
store archive. Paths, member types, duplicates, extra files and sizes are checked
before the consumer extracts individual files into its own tmpfs.

The receiving hosted VM must have a different boot ID and lack the exact image.
Run/SHA/attempt, a separately supplied receipt hash, image config/layers and all
file hashes are verified before load. A fresh Orthanc process must return the
original instance and all three attachment byte sequences exactly. Downloaded
source artifact hashes remain unchanged. The public artifact contains only
`image.tar`, `store.tar`, and `receipt.json`, with one-day retention and download
by exact artifact ID. No production data, configuration or keys are read.

The image archive cap is 2GiB: classic Docker saves the pinned layers expanded
(about 1.75GB), while containerd saves compressed blobs (about 684MB). Store and
receipt caps are 32MiB and 8KiB. The shared image checker separately limits each
expanded layer to 8GiB; the job timeout is ten minutes. These bounds are for the
fixed synthetic profile, not a large production restore. Before load, the
consumer reports matching layers referenced by existing Docker images; it does
not prove absence of unreferenced build-cache blobs. The base-image label is a
producer declaration, not an independent signature.

Containers use UID65534, no network or published ports, a read-only root,
cap-drop ALL, no-new-privileges, PID128, 256MiB memory, one CPU and tmpfs limits
of 128MiB for `/work` and 8MiB for `/tmp`. Plugins and the DICOM server are
disabled; REST requests stay within the container. Only owned resources are
removed, and cleanup errors cannot become success. SIGKILL or host termination
can prevent cleanup. The CI environment guard prevents accidental local use;
it does not isolate a hostile process with the same OS privileges.

Only synthetic Orthanc restoration can become true. Full PACS restoration,
encrypted offsite backup and deployment authorization remain false. API and
Keycloak authentication, reporting/viewer recovery, real destinations and key
custody require their own evidence.

## Synthetic combined restoration across CI jobs (C12L)

`python -B tests/ops_combined_transfer_test.py` covers snapshot binding, mixed
components, both-image absence, partial failure cleanup, full restored rows,
source mutation, disk preflight, strict worker JSON and bounded output. Linux
runs 18 tests; Windows runs 11 and explicitly skips seven Linux FD/pipe tests.
Docker calls in these tests are mocked. The pipe cases run real child processes.
`restore-combined.yml` performs the actual two-job transfer and restoration.

One producer freezes a synthetic Orthanc instance and attachments 1/1024/1025,
then writes their instance ID and SHA256 into three `fixture_attachment` rows
in each of two synthetic databases named `kin` and `keycloak`. These are fixture
tables, not product or Keycloak schemas. The artifact contains exactly two image
archives, two dumps, one store archive and one receipt. Receipt SHA and expected
sorted-row SHA are passed separately as job outputs. Both are producer-supplied
integrity bindings, not independent endorsements of a hostile producer.

The consumer checks scope, different boot ID, all file/config/layer hashes and
expected snapshot relation, then verifies that **both** exact image IDs are
absent before loading either. An existing image prevents all loading and cleanup.
After restore, every sorted DB row must match the frozen snapshot relation, and
Orthanc REST must return the original instance and all three exact attachment
byte sequences. Dump internal row content is checked after restore, before the
success decision. The original download hashes must remain unchanged.

Postgres and Orthanc retain their isolated UID70/UID65534, network-none,
portless, read-only-root, bounded tmpfs profiles. They never connect to each
other; the parent compares their synthetic results. Before build/load, the
helper checks both `RUNNER_TEMP` and Python's private temporary filesystem and
requires 9GiB free on each. Image limits are
512MiB/2GiB, dumps 16MiB each, store 32MiB, receipt 16KiB, jobs ten minutes.
Producer image/dump/store pipes enforce the limit before each chunk is written,
drain stderr with a 4KiB capture cap and kill/reap the CLI at the deadline. The
C12K store producer also uses this receiver; its worker rejects duplicate JSON
keys and nonfinite constants.

Cleanup attempts all known containers and derived images even if one attempt
fails. A build with no returned ID may resolve only its exact unique tag and
validated ownership settings. Bases/build cache remain; host termination or a
daemon build completing after the cleanup observation can leave resources.
Cached-layer observation inconsistencies still fail closed. The base labels
remain producer declarations; unreferenced cache absence is not proved.

Only `synthetic_combined_restored` can become true. Full PACS restoration,
encrypted offsite backup and deployment authorization remain false. Real app
schemas, API/Keycloak authentication, reporting/viewer recovery, TLS, cron,
encryption keys and external destinations need separate evidence.

### C12M product schema restore

`python -B tests/ops_product_transfer_test.py` covers the separate v2 receipt,
migration binding, every product row/column, sequence state, real-restore failure
classification and inherited private-copy/image-absence boundaries. Linux runs
14 tests; Windows runs 11 and explicitly skips three Linux cases. Docker calls
in these unit tests are mocked. `restore-product.yml` runs the actual engine
producer/consumer in different hosted VMs; it preserves the existing C12L format.

The producer applies the exact Git migration SQL to a new isolated `kin` DB.
Two institutions, one StudyState, one Report, two ReportVersions and two private
ReportDrafts contain fixed SYNTHETIC values, using the actual DICOM StudyInstanceUID
read before Orthanc stops. All columns and all ten tables (including five empty
tables and empty AuthSession) are compared. Four SERIAL sequences include both
last_value and is_called. The receipt binds migration order/digests, a bounded
OID-free catalog of tables/columns/constraints/indexes/sequence settings, rows
and sequences. Consumer checkout migration bytes and independently transported
product/receipt hashes must agree. These hashes are producer declarations,
not authentication against a hostile producer.

The consumer restores real custom pg_dumps and compares the complete product
metadata, then probes duplicate report version, Report-to-StudyState FK and draft
composite PK in a rolled-back transaction with explicit IDs. It rechecks data
and sequences afterwards. A separate job-local DB creates a valid dump with a
different study/history; actual pg_restore must succeed before the same product
checker rejects its rows. A restore/query failure cannot pass this negative test.
The negative dump never joins the public artifact. Keycloak remains a synthetic
three-attachment fixture, not a real realm/schema restore.

The six filenames and image/dump/store caps match C12L; the new receipt cap is
128KiB, SQL observations are capped at 256KiB/30 seconds, dump/restore at 120
seconds, and each job at 15 minutes. Both temp filesystems need 9GiB. The same
two-image absence, non-root/network-none, owned cleanup and source hash checks
apply. Only `synthetic_product_schema_restored` becomes true. SQL preservation
does not prove service append-only enforcement, institution access, report state
transitions, real Keycloak/API/viewer recovery, encryption/offsite or deployment.
# Protected host deployment tests

`python -B tests/ops_deploy_host_test.py` runs four portable refusal checks. In a
disposable Linux root environment it also exercises private files, one-use
synthetic attestations, durable journals/outboxes, UID denial and real local TLS.
The fixed `/opt/kin-deploy` installation check is opt-in with
`KIN_TEST_ISOLATED_INSTALL=1`; use a disposable container with private tmpfs mounts
at `/opt/kin-deploy` and `/etc/kin-deploy`. Never enable it on an operational host.

`sudo env KIN_TEST_API_IMAGE=kin-api:ci python3 -B tests/ops_deploy_host_container_test.py`
is for an isolated Linux CI Docker daemon after building `kin-api:ci` and
`kin-proxy:ci` and pulling `postgres:16-alpine`. It refuses any existing `kin-api`
or `kin-proxy`, replaces a disposable product API twice, and verifies Prisma
history and a synthetic database row survive. It checks actual nginx reload and
health/auth refusal; full authenticated HTTPS/frame checks use the separate TLS
fixture. It sends no mail and proves no operational offsite restore. Cleanup
checks ownership labels and removes only the fixture's containers/network/tag.

`scripts/deploy-policy.example.json` is disabled and contains unusable placeholders.
The isolated `ops_deploy_entry.py` requires a separately provisioned root-owned
policy/library/repository and request-bound operator evidence. Running scripts
from a developer checkout does not grant deployment authority.
