# 살아 있는 불변조건 테스트

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
