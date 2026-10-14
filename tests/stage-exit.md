# Stage 7 필수 시험 판정

`stage7-exit.json`의 명시적 필수 시험 항목을 **한 최종 main commit**의
원문 결과와 대조한다. U5는 접속기록·서버 종료/결속·화면 종료·글 보존으로 나누었다.
목록의 `left_out`에 제외 이유가 있다. 이 표는 의사 확인·규제/위험 처분·운영 검증·출시 승인이나
PR CI/독립 검토를 대신하지 않는다. 기존 CI와 시험 실행 예산도 바꾸지 않는다.

입력은 이미 있는 다음 산출물뿐이다. 새로운 실행 결과 형식은 없다.

- `record-run.py`: `run.json`, `stdout.log`, `stderr.log`. Python 사례는 verbosity=2의
  `module.Class.test_method`로, Node 파일 전체는 `node:tests/파일.cjs`로 적는다.
  Node는 해당 job의 소유 workflow에서 실행한 필터 없는 `node --test` TAP 출력이어야 한다.
- `candidate.yml`: `candidate-provenance.json`, `results.json`, 각 단계의 `.log`.
  `candidate-ci` 항목은 provenance의 **모든 실제 선택 사례**와 정리 결과를 검사한다.
  선택 수는 `candidate_ci.py`가 관리하며 이 목록에 복제하지 않는다.

`--runs`는 해당 실행에 선택한 폴더 안의 `run.json`만 찾는다. 과거 실행을 통째로 섞지 않는다.
같은 시험에 실패/다른 SHA 결과가 함께 있으면 통과한 결과로 덮지 않는다.
JSON에는 각 시험의 이유와 원문 경로를 남기며, 콘솔은 요구사항마다 첫 실패만 짧게 표시한다.
누락·건너뜀·중단·시간 초과·SHA 불일치는 PASS가 아니다. 모두 PASS이면 exit 0, 그 외 exit 1
(명령/목록 입력 오류는 argparse의 exit 2)이다.

U5 항목은 `tests/README.md`의 U5S-REQ와 U5S-RISK-AUDIT/SESSION/APPLY/DRAFT에 연결된
실제 동작 시험에서 골랐다. README의 과거 fix3/fix8 설명보다 뒤의 서버 재설계·통합과
DB 권한 이관 계약, 현재 시험 본문의 D621/D623 U5-core 동작을 적용한다. 회원의
Suspend/Approve/Change/Cancel/Activate는 DB 권한을 바꾸며 명부 게시의 성공을 기다려
권한을 결정하지 않는다. 초안은 프로세스 메모리 순번이 아니라 DB revision/epoch/CAS를 쓴다.
`auth_session_service_test.cjs`의 CORE 명령·감사 원자성·진입 거절은 컴파일된 서비스와
실제 PostgreSQL/가짜 IdP 수준이다. 실제 IdP 경계는 `SessionEndLive`가 맡는다.
그 클래스의 SE-10·11은 #138 hygiene에서 현재 이름과 본문에 맞춰 필수 목록에 재포함했으며, Stage 7은 두 사례를 포함한 목록으로 판정했다.
D621에 따라 provider reconciliation은 U5b 범위다. DB Suspend 뒤 살아 있는 provider SSO로도
제품 세션/토큰을 쓰지 못하고 Activate 뒤 옛 인증이 거절되는 동작은 SE-09가 맡는다.
명시적 Log out 뒤 같은 sid의 새 SSO 허용과 옛 토큰 거절은 SE-03b·03c가 맡는다.
정확한 ID·제외 사유·대체 근거의 한계는 `stage7-exit.json`의 `left_out`에 적었다.
전체 파일을 실행하는 CI와 이 목록의 필수 사례 부분집합은 다르다.
같은 Node 파일이나 보존 시험을 두 요구사항이 쓰더라도 같은 실행 결과를 재사용한다.

| 요구사항 | 직접 읽는 record-run 폴더(각 폴더의 `run.json`) | live / hosted 연결 |
|---|---|---|
| `U5-AUTH-AUDIT` | `tmp/runtime-ci/auth-session-service`, `tmp/runtime-ci/audit-integrity`; `tmp/workspace-ui-ci/admin-audit-dom` | `AuthAuditLive`: api |
| `U5-SESSION-END` | `tmp/runtime-ci/auth-session-service`, `tmp/runtime-ci/session-work-gate` | `LogoutOrderLive`, `SessionProxyLive`: api; `ReportDraftCasLive`: draft; `SessionEndLive`: end |
| `U5-SESSION-UI` | `tmp/workspace-ui-ci/`의 `auth-logout-dom`, `viewer-session-dom`, `admin-session-dom`, `auth-entry-dom`, `session-entry-dom` | `SessionDraftBoundaries`: boundaries; browser는 별도 PR 회귀/G3의 문서 결속 흐름 |
| `U5-DRAFT-SAFETY` | `tmp/runtime-ci/report-draft-cas`, `tmp/runtime-ci/report-draft-owner`; `tmp/workspace-ui-ci/`의 `report-session-page-dom`, `auth-logout-dom`, `report-text-boundaries-dom`, `viewer-session-dom` | `ReportDraftCasLive`: draft; `SessionDraftBoundaries`: boundaries; fixups는 별도 PR 회귀 |

2026-10-05 조사에 있던 "별도 viewer `-v` 패치" 메모는 현재 명령에 대한 아래 판단으로
대체한다. 기준 main의 `viewer-session-dom` 끝에는 `-v`가 없고 파일도 `unittest.main()`을
쓴다. 이 landing은 그 명령 끝에만 `-v`를 추가한다. 후속 별도 패치는 필요 없다.
위의 다른 DOM 파일은 `verbosity=2`이고, 목록의 Node 파일 일곱 개는 각각 필터 없는
단일 파일 실행으로 기록된다. 최종 workflow는 backup-safety와 production-image도
`record-run.py`로 감싼다. 두 기록은 `tmp/runtime-ci/`에서
`synthetic-runtime-record-runs` artifact에 포함되므로 아래 기본 CI 입력으로 읽는다.
도구는 job/계획 이름을 고정하지 않는다. `run.json`·unittest/TAP 및 G3 산출물 형식은 그대로 쓴다.

`tests/measurement_ci.py` PROFILES와 `s7-u5-session-contracts` matrix의 여덟 항목은 다음과 같다.
마지막 이름은 `u5-session-fixups`가 아니라 **`u5-fixups`**다. 아래 artifact에는
`results.json`과 사례 `.log`가 있으며 **`run.json`은 없다**. 따라서 이 도구의 `--runs`에
넣어도 그 로그는 PASS 증거가 되지 않는다. 각 필수 live 클래스는 아래 기록기 명령으로
같은 최종 SHA에서 실행한 `$out/live/<unit>/run.json`이 필요하다. 기존 동일 SHA의 적격
기록이 있으면 재사용한다. 전체 profile을 기록기로 감싸도 내부 사례 로그가 stdout으로
나오지 않으므로 그 외곽 `run.json`만으로 대체할 수 없다.

| profile / artifact 이름 | 업로드 원래 경로 | 사례 로그 / 관련 요구사항 |
|---|---|---|
| `u5-session-api` / `synthetic-u5-session-api` | `tests/e2e/artifacts/u5-session-api-ci/` | `auth_audit_live.log`, `session_proxy_live.log`, `logout_order_live.log`: AUTH-AUDIT, SESSION-END |
| `u5-session-draft` / `synthetic-u5-session-draft` | `tests/e2e/artifacts/u5-session-draft-ci/` | `report_draft_cas_live.log`: SESSION-END, DRAFT-SAFETY |
| `u5-session-regression` / `synthetic-u5-session-regression` | `tests/e2e/artifacts/u5-session-regression-ci/` | `server_contract_regression_live.log`: 권한·상태 보존 PR 회귀, 명시 목록 밖; G3와 독립 |
| `u5-session-boundaries` / `synthetic-u5-session-boundaries` | `tests/e2e/artifacts/u5-session-boundaries-ci/` | `test_session_draft_boundaries.log`: SESSION-UI, DRAFT-SAFETY |
| `u5-session-mutants` / `synthetic-u5-session-mutants` | `tests/e2e/artifacts/u5-session-mutants-ci/` | `test_session_draft_mutants.log`: SESSION-UI 진입 결함 대조, 별도 PR CI |
| `u5-session-browser` / `synthetic-u5-session-browser` | `tests/e2e/artifacts/u5-session-browser-ci/` | `test_session_worklist_regression.log`, `test_document_session.log`: SESSION-UI / DRAFT-SAFETY 회귀; 문서 결속 사례는 G3도 선택 |
| `u5-session-end` / `synthetic-u5-session-end` | `tests/e2e/artifacts/u5-session-end-ci/` | `session_end_live.log`: SESSION-END; 독립 빈 hosted runner |
| `u5-fixups` / `synthetic-u5-fixups` | `tests/e2e/artifacts/u5-fixups-ci/` | `test_u5_fixups.log`: SESSION-UI / DRAFT-SAFETY 관련 다섯 화면 회귀, 별도 PR CI |

접속기록 필드와 비밀 제외는 U5 시험, 체크포인트의 달력 2년 `retain_until`은 PV-06,
변조·유실·복원은 기존 `REQ-S7-AUDIT-STORE`가 맡는다. `AuthAuditLive` AL-13은 실제 로그인·로그아웃의
`AuditLog.at`을 사건 전후 `/api/health.at`(최대 5초 구간, 양끝 ±1초)과 대조하고 관리자 콘솔 API의
명시적 시간대·DB와 같은 시각·사건 순서를 검증하며, AS-01은 실제 DB 사건 구간(전후 CURRENT_TIMESTAMP ±1초)
안의 저장 시각 + UTC 순간을 단언한다. 둘은 `REQ-S7-U5-AUTH-AUDIT` 필수 시험에 결속한다.
실제 2년 운영 보관의 이행 여부는 이 표의 PASS로 닫지 않는다.

최종 main을 깨끗하게 checkout한 **원본과 분리된 합성 환경**에서 다음 PowerShell 명령을 쓴다.
이 문서의 실행 예시는 환경 기동이나 원본 연결을 허가하지 않는다. `record-run.py`는 HEAD와
파일 해시를 기록하지만 dirty tree 자체를 증명하지 않으므로 실행 전에 수정 상태를 확인한다.
기본 입력은 동일 SHA의 모든 소유 workflow에 있는 `synthetic-runtime-record-runs`와
`synthetic-workspace-dom-results`, G3 `candidate-<sha>` artifact다.
`tests/ci_artifacts.py`는 `tests/ci_workflows.py`의 job → workflow 매핑으로 업로드 출처를
찾고, workflow별로 후보 SHA의 최신 실행 ID와 attempt를 조회한다. 실패·진행 중 실행을
이전 성공으로 대체하지 않으며, SHA/소유 workflow 불일치·누락·만료 artifact는 거절한다.
G3(candidate.yml)는 **CI-TOOLING-1b**의 공식 라운드 기록으로만 받는다. 전체 수집 호출은
아래 G3 절의 `--record $roundRecord`를 **명시 입력**으로 받으며, 기록이 없으면 조회 전에 STOP한다.
기본 경로·최근 실행·제목·artifact 이름·PR head로 기록이나 G3 실행을 찾지 않는다.
수집기는 비후보 수집을 먼저 끝낸 뒤 같은 query/fetch로 `ci_candidate_evidence.collect`를 호출해
기록된 run ID만 검증하고, **둘 다** 성공한 뒤에만 `stage-evidence.json`을 completed로 쓴다.
`--non-candidate`는 G3를 뺀 별도 수집이다. 그 manifest의 scope는 non-candidate이고
G3는 NOT_COLLECTED이며 전체 stage 통과가 아니다. candidate.yml의 run-name은 후보 SHA와
dispatch nonce를 담지만 수집기는 이를 귀속 근거로 쓰지 않는다(응답 유실 복구에만 쓴다).

비후보는 **push 실행만** head_sha 증거로 수집한다. pull_request는 GitHub 병합 ref를 시험하므로
run id/event를 남기고 STOP하며 이 결과를 main SHA의 stage-exit 증거로 쓰지 않는다.
시작 시 GET repos/{owner}/{repo}로 저장소 id를 한 번 확인하고 Link의 원래 경로 또는
같은 저장소의 /repositories/{id}/ 경로만 따라 끝까지 읽는다. page 외 query 변경,
다른 host/저장소/path 및 Link 순환은 STOP한다.
[workflow runs 계약](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-workflow)의
head_sha 검색 상한 1,000건에 닿으면 STOP한다. total_count는 반복 횟수가 아니라 일관성 검사다.
[2026-09-25 count 변경](https://github.blog/changelog/2026-09-25-changes-to-query-results-in-the-github-actions-api-and-ui/)의
상한/비정확 count, 누락·중복·변동도 거절한다. [Link pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api)을
따르며 artifact 목록에는 run 검색의 1,000 상한을 적용하지 않는다.
[artifact REST](https://docs.github.com/en/rest/actions/artifacts)에는 attempt 식별자가 없다.
현재 producer도 이를 결속하지 않으므로 **attempt 1만 수집**한다. 같은 SHA의 관련 실행 중
재실행(attempt 2 이상)이 하나라도 있으면 오래된 생성 시각이어도 STOP한다. 정상 재실행과
부분 job 재실행도 이 제한에 포함된다. 시각·동명 artifact의 순서로 attempt를 추정하지 않는다.
재실행을 수집하려면 후속 CI-TOOLING-1b **CD-02-R** producer provenance 계약이 필요하다.
모든 stage artifact에 run id와 run_attempt를 넣고 attempt N에서 생성된 것이 증명된 artifact만
N의 증거로 수집한다. 부분 재실행은 이전 attempt artifact를 N으로 재표시하지 않고 STOP하는
정책을 기본으로 하며, 전체 재실행·부분 재실행·attempt 미증명 시험을 1b에서 수행한다.

**재실행 STOP 운영 절차:** attempt >= 2이면 원래 수집 폴더와 STOP 원문을 보존한다.
`$repository`는 owner/repo, `$stoppedRun`은 STOP의 양의 run id, `$artifactId`는 같은 저장소의
REST artifact 목록/metadata에서 확인한 양의 id다. 저장소 루트에서 다음 명령을 실행한다.

```powershell
python -B scripts/collect-rerun-diagnostic.py --repository $repository --run-id $stoppedRun --artifact-id $artifactId --out $out
if ($LASTEXITCODE -ne 0) { throw '재실행 진단 증거 수집 실패: 원문 로그 확인' }
```

CLI는 `gh run view`에 `--repo`를 명시하고 run 응답의 ID·attempt·필수 필드와 artifact
metadata의 ID·소유 run을 검사한 뒤 해당 ID의 ZIP endpoint를 GET한다. 상대 `--out`은
스크립트가 속한 저장소 루트(선택 `--repo-root`)에 결합해 절대 경로로 확정하므로, 셸을
다른 디렉터리에서 시작해 Set-Location해도 같다. 공백·한글 경로와 절대 out도 지원한다.
advertised `sha256:<64 hex>`와 실제 archive SHA-256이 모두 필수이며 없음·빈 값·잘못된 형식은
`RERUN_DIGEST_REQUIRED`, 불일치는 `RERUN_DIGEST_MISMATCH`로 STOP한다. digest 없는 과거
artifact는 이 진단 CLI에서 받을 수 없으며 null digest 영수증이나 fallback은 없다.
이 제한은 비후보 collector 또는 1b의 digest 정책을 바꾸지 않는다.

`manual-<run>-<artifact>.zip`과 `.json`은 exclusive 생성한다. 기존 파일을 덮거나 지우지 않고,
download가 nonzero이면 완전한 ZIP이어도 실패한다. 받은 partial/archive와 호출별 raw stdout·stderr·
argv/exit는 새 `rerun-*` 폴더 및 archive에 남긴다. JSON 쓰기 실패 시 이번 호출의 불완전 JSON만
지운다. 성공 JSON에는 repository/run id/관측 attempt/artifact id/절대 archive 경로/두 digest/run 상태,
`use=diagnostic-only`, `producer_attempt_verified=false`를 남긴다. stdout/stderr는 UTF-8이고
JSON과 오류 code/ID는 ASCII 안전 출력이다. 정상은 0, 검증·외부 명령·파일 오류는 1, 사용 오류는 2다.

운영자는 관측 run id/attempt/SHA/event/workflow를 최신 공식 실행 기록과 대조한다. 관측 attempt는
producer attempt 증명이 아니다. 이 자료는 진단·누락 확인에만 쓰며 자동 수집 completed나
stage-exit PASS 증거로 쓰지 않는다. **이전 성공 run 대체 금지**다.
이미 dispatch한 대체 run도 event=workflow_dispatch로 STOP하며 동일 수동 절차를 적용한다.
대체 dispatch나 전체/부분 재실행의 성공만으로 STOP을 해소하지 않는다. CLI는 재실행·dispatch·삭제하지 않는다.

`ci_rerun_diagnostic_test.py`는 PS5.1/pwsh 문서 호출, 상대 out·다른 cwd·digest·실패·기존 파일
보존을 검사한다. `record_run_test.py`는 이 시험과 collector·detector 행동 시험을 수집하며 기존
validate.yml / measurements의 `Execution evidence raw and LF hash preservation` 단계에서 실행된다.
`node tests/ci_workflow_consumers.cjs --audit .`는 gap/미등록 파일로 CI를 실패시키지 않는 진단이다.
진단기의 실행/파싱 오류와 행동 시험 실패는 성공으로 숨기지 않는다.

새 run끼리는 생성 시각, 같은 초면 ID로 최신을 고르고 최신 실패·대기·진행·누락·만료는 거절한다.
검사한 artifact ID로 archive를 받고 제공된 digest와 대조하며, 실제 archive SHA256을 남긴다.
각 다운로드 직후 run attempt/updated_at과 metadata를 재조회하고 마지막에 전체 run 집합을
다시 대조한 뒤에만 completed를 쓴다. STOP에는 run id/attempt/artifact id(미확정은 unknown)가 남는다.
`--dry-run`은 archive를 받지 않으며 status=planned다. verified_at은 조회 시점일 뿐 미래의
재실행/삭제나 REST 다중 요청의 원자성을 보장하지 않는다. 병합 전에는 재확인한다.
동명 artifact가 validate와 Worklist UX 양쪽에 있으면 **둘 다** 별도 경로에 받는다.
workflow 파일명 변경이나 job 이동은 고정 validate 실행 ID로 우회하지 않는다.

```powershell
$sha = (git rev-parse HEAD).Trim()
if ($sha -ne (git rev-parse main).Trim()) { throw '최종 main checkout 필요' }
if (git status --porcelain -- . ':(exclude)tmp') { throw '실행할 소스의 수정 상태 확인 필요' }
$shortSha = $sha.Substring(0, 12)
$out = "tmp/stage7-final-$shortSha"
```

| artifact | 업로드 원래 경로 | 수령 명령 |
|---|---|---|
| `synthetic-runtime-record-runs` | `tmp/runtime-ci/` | 아래 수집기의 모든 소유 workflow 실행 → `hosted/runs/<workflow>/<run>/<artifact>` |
| `synthetic-workspace-dom-results` | `tmp/workspace-ui-ci/` | 아래 수집기의 모든 소유 workflow 실행 → `hosted/runs/<workflow>/<run>/<artifact>` |
| `candidate-<sha>` | `target/tests/e2e/artifacts/candidate-ci/` | 같은 수집기의 `--record` 공식 run ID → `hosted/g3/run-<id>-attempt-<n>-artifact-<id>` = `$candidateDir` |

먼저 **모든 workflow의 모든 업로드 이름과 소유 workflow/job**을 나열한다.
matrix·실행 ID·SHA 표현식이 있는 이름은 원래 템플릿으로 표시하므로 목록에서 빠지지 않는다.
수집기는 같은 전체 목록을 `artifact-inventory.json`에, 선택한 실행과 실제 다운로드 출처를
`artifact-downloads.json`에 보존한다. Stage 7/8에 필요한 이름만 다운로드하며 각 이름의
소유 workflow를 하나도 생략하지 않는다. 아래 목록/수집 명령은 live 시험을 실행하지 않는다.

```powershell
python -B tests/ci_artifacts.py --list
if ($LASTEXITCODE -ne 0) { throw '전체 artifact 출처 목록 확인 실패' }
# $roundRecord는 아래 G3 절에서 이 후보 SHA로 --init·dispatch한 공식 라운드 기록이다(검색으로 찾지 않음).
python -B tests/ci_artifacts.py --sha $sha --stage 7 --record $roundRecord --out "$out/hosted"
if ($LASTEXITCODE -ne 0) { throw '동일 SHA의 비후보·G3 수집 STOP; 원문 보존 후 확인' }
$hosted = Get-Content -Raw "$out/hosted/stage-evidence.json" | ConvertFrom-Json
if ($hosted.status -ne 'completed' -or $hosted.sha -ne $sha -or $hosted.g3.status -ne 'verified') { throw '비후보·G3 수집 상태 불일치' }
$candidateDir = $hosted.g3.candidate_directory
```

위 artifact를 받은 뒤 아래 기록기 loop는 필요한 live 클래스만 보충한다.
기존 동일 SHA의 적격 기록은 재사용한다.

```powershell
$live = @(
  @('tests/e2e/test_critical_result.py', 'CriticalResultE2E'),
  @('tests/e2e/test_critical_result.py', 'CriticalResultScreensE2E'),
  @('tests/critical_result_live.py', 'CriticalResultTeleLiveTests'),
  @('tests/e2e/test_reader_assignment.py', 'ReaderAssignmentE2E'),
  @('tests/clinical_context_live.py', 'ClinicalContextLive'),
  @('tests/auth_audit_live.py', 'AuthAuditLive'),
  @('tests/live/logout_order_live.py', 'LogoutOrderLive'),
  @('tests/live/report_draft_cas_live.py', 'ReportDraftCasLive'),
  @('tests/live/session_proxy_live.py', 'SessionProxyLive'),
  @('tests/live/session_end_live.py', 'SessionEndLive'),
  @('tests/e2e/test_session_draft_boundaries.py', 'SessionDraftBoundaries')
)
foreach ($item in $live) {
  $unit = 's7-exit-' + $shortSha + '-' + $item[1].ToLowerInvariant()
  $runDir = "$out/live/$unit"
  if (Test-Path "$runDir/run.json") {
    $record = Get-Content -Raw "$runDir/run.json" | ConvertFrom-Json
    if ($record.git_head_before -eq $sha -and $record.git_head_after -eq $sha -and
        $record.status -eq 'completed' -and $record.exit_code -eq 0 -and $record.recorder_exit_code -eq 0) {
      continue
    }
  }
  if (Test-Path $runDir) { throw "기존 미완료 기록 점검 필요: $runDir; 아래 재시도 절차 확인" }
  python scripts/record-run.py --run-dir $runDir --cwd . --file $item[0] -- python scripts/run-tests.py --module $item[0] --class $item[1] --mode live --unit $unit --timeout 1800
  if ($LASTEXITCODE -ne 0) { throw "시험 실패: $unit; 기존 실행 원장/정리 절차에 따라 확인" }
}
```

같은 SHA의 성공 기록은 재실행하지 않고 재사용한다. 미완료/실패 기록은 원장과 정리 상태를
먼저 점검한다. 기존 절차가 재시도를 허용하면 실패 기록을 `$out/failed/`에 보존한 뒤
원래 `$runDir`가 없는 상태에서 같은 `$unit`으로 반복문을 재개한다. 성공한 다른 클래스는 건너뛴다.
이전 실패는 최종 판정 입력과 구분해 보존하며, `$out/failed/`를 `--runs`에 넣지 않는다.
단위 이름·SHA·출력 폴더를 바꿔 같은 실패의 예산이나 점검 marker를 우회하지 않는다.
새 최종 SHA의 검증은 새 단위로 식별하되 이전 실행의 정리 의무는 그대로다.
위에서 지정한 U5 클래스는 G3 선택에 포함되지 않는다(별도 `test_document_session.py`는 포함).
`SessionDraftBoundaries` 전체
클래스의 뷰어 사례에는 `KIN_U5_DICOM_SOURCE` 공개 CT 입력도 필요하다(`tests/README.md`).
실행기는 `--class`에 그 클래스가 직접 선언한 사례를 고정하므로 상속한 worklist 시험은 추가하지 않는다.

앞서 수집기가 소유 workflow 실행마다 받은 artifact(`hosted/runs/<workflow>/<run>/<artifact>`)의 `run.json`에서 Node service/scope, DOM, AuditStore DB,
integrity, backup-safety, production-image를 읽는다.
여덟 U5 artifact는 위 표의 보조 원문으로 보존하되 SHA 없는 `results.json`만으로 위 live
기록을 대체하지 않는다. G3 artifact 이름은 `candidate-<최종 40자리 SHA>`이며,
`--candidate`에는 `candidate-provenance.json`이 바로 들어 있는 폴더를 지정한다.

기본 판정에는 별도 runtime 실행이 필요 없다. 같은 SHA의 별도 runtime 실행 기록이 실제로
`$out/runtime`에 있을 때만 아래 명령에 `--runs "$out/runtime"`을 추가한다.
존재하지 않는 폴더나 `run.json`이 없는 폴더를 `--runs`로 넘기면
`scripts/stage-exit.py:178`에서 입력 오류(`run.json 없음`)로 기록되며 PASS가 될 수 없다.
CI 기록의 누락·실패도 성공으로 간주하지 않는다.

```powershell
python scripts/stage-exit.py --list tests/stage7-exit.json --sha $sha --runs "$out/hosted/runs" --runs "$out/live" --candidate $candidateDir --output "$out/verdict.json"
$LASTEXITCODE
```

도구 자체의 대표 시험은 Python만 실행한다. TAP은 합성 원문을 공급하고 실제 Python 시험
자식 강제종료 **한 번**을 포함한다. ID 검사는 `run-tests.py`의 수집기만 호출하며
live/e2e/DOM의 setup이나 본문은 실행하지 않는다. 수집 import에는 PyYAML을 포함한
e2e requirements와 CI와 같은 pydicom/numpy/pynetdicom Python 패키지가 필요하다(브라우저 설치 불필요).
없는 module/class/method/Node 파일이나 필터 실행을 전체 파일로 쓴 경우 시험이 실패한다.
`tmp/lean-exit-land/id-resolution.json`은 수집 증거이며 제품 시험의 PASS 기록이 아니다.

```powershell
python scripts/record-run.py --run-dir tmp/lean-exit-check --cwd . --file scripts/stage-exit.py --file tests/stage7-exit.json --file tests/stage_exit_test.py -- python -B tests/stage_exit_test.py
```

Stage 8은 의사가 채택한 영상 기능의 실제 영상·정확도·실패 복구 시험만,
Stage 9는 승인된 세션/저장 충돌 보호·운영 복구와 정리한 시험의 실제 ID를 추가한다.
새 판정기·포장 규격·문서 형식 관문은 추가하지 않는다.

## Stage 8 필수 시험 판정

`stage8-exit.json`은 VR 접근/세션 보호 착륙, CTX 복구·Tech Note 저장 시도,
EMR-A **순수 계약**과 직접 회귀를 묶는다. `left_out`은 원 Stage 8 단위별 요구 ID와
보류/다른 단계의 이유를 남긴다. 기존 VR의 회귀 통과를 미착륙 VOI·Sculpt 확장이나
VR Job 전체 저장의 완료로 바꾸지 않는다. 의사 채택·규제/위험 처분·운영·출시 승인과
EMR의 실제 소비 구현은 이 자동 판정 밖이며 해당 출시 조건은 남는다.

Stage 7과 동일한 기록기·판정기·실패 규칙을 사용한다. 최종 main의 깨끗한 소스와
그 SHA에 실제 결속된 격리 합성 환경에서만 다음 일곱 클래스를 **순차** 실행한다.
아래 건수는 목록 작성 기준 `2fc7358`에서 `run-tests.py`의 수집만 수행한 결과다.
최종 소스가 달라지면 수집 ID를 다시 대조하며 상속된 worklist 사례를 임의로 더하지 않는다.

| 순서 | module | class | 전체 실행 건수 | 목록의 필수 건수 |
|---|---|---|---:|---:|
| 1 | `tests/e2e/test_volume_rendering.py` | `VolumeRenderingE2E` | 23 | 23 |
| 2 | `tests/e2e/test_context_loss.py` | `ContextLossE2E` | 4 | 4 |
| 3 | `tests/e2e/test_tech_note.py` | `TechNoteE2E` | 9 | 9 |
| 4 | `tests/e2e/test_viewer_tech_note.py` | `ViewerTechNoteE2E` | 5 | 5 |
| 5 | `tests/e2e/test_volume_study_workflow.py` | `VolumeStudyWorkflowE2E` | 7 | 7 |
| 6 | `tests/live/session_proxy_live.py` | `SessionProxyLive` | 1 | 1 |
| 7 | `tests/e2e/test_session_draft_boundaries.py` | `SessionDraftBoundaries` | 7 | 2 |

전체 56건과 필수 51건을 구별한다. G3의 invariants/worklist 및 누적 흐름은
`candidate-ci`로 별도 판정하므로 이 loop에 중복하지 않는다. 마지막 클래스에는
Stage 7과 같은 `KIN_U5_DICOM_SOURCE` 공개 CT 입력이 필요하다. 실제 GPU/브라우저·
fixture 경로와 소스 결속을 실행 기록에 남긴다. CPU/GPU 부하를 주는 다른 코스와
동시에 실행하지 않는다. hosted 지연으로 실패하면 원문과 원인을 보존하며 기다림을
통과로 세거나 단위 이름을 바꿔 예산을 회피하지 않는다.

Stage 7 예시의 최종 SHA·clean tree 확인을 그대로 수행하고 `$out`만
`tmp/stage8-final-$shortSha`로 정한다. 환경 기동/재결속과 격리 확인은 해당 환경의
실행 담당자가 먼저 완료해야 한다. 아래 loop는 환경 권한을 새로 부여하지 않는다.

```powershell
$live = @(
  @('tests/e2e/test_volume_rendering.py', 'VolumeRenderingE2E'),
  @('tests/e2e/test_context_loss.py', 'ContextLossE2E'),
  @('tests/e2e/test_tech_note.py', 'TechNoteE2E'),
  @('tests/e2e/test_viewer_tech_note.py', 'ViewerTechNoteE2E'),
  @('tests/e2e/test_volume_study_workflow.py', 'VolumeStudyWorkflowE2E'),
  @('tests/live/session_proxy_live.py', 'SessionProxyLive'),
  @('tests/e2e/test_session_draft_boundaries.py', 'SessionDraftBoundaries')
)
foreach ($item in $live) {
  $unit = 's8-exit-' + $shortSha + '-' + $item[1].ToLowerInvariant()
  $runDir = "$out/live/$unit"
  if (Test-Path "$runDir/run.json") {
    $record = Get-Content -Raw "$runDir/run.json" | ConvertFrom-Json
    if ($record.git_head_before -eq $sha -and $record.git_head_after -eq $sha -and
        $record.status -eq 'completed' -and $record.exit_code -eq 0 -and $record.recorder_exit_code -eq 0) {
      continue
    }
  }
  if (Test-Path $runDir) { throw "기존 미완료 기록 점검 필요: $runDir" }
  python scripts/record-run.py --run-dir $runDir --cwd . --file $item[0] --file config/ohif.js --tree worklist-v0/hpacs-lite --tree api/src --tree api/prisma --tree tests -- python scripts/run-tests.py --module $item[0] --class $item[1] --mode live --unit $unit --timeout 1800
  if ($LASTEXITCODE -ne 0) { throw "시험 실패: $unit; 원장과 정리 상태 확인 필요" }
}
```

기록 존재 여부는 재실행 방지용일 뿐 PASS 판정이 아니다. 사례별 누락/skip,
입력 전후 해시·실행 코드·환경 결속은 최종 원문에서 확인한다. 실패 재시도는 위
Stage 7 절차와 기존 영구 원장을 따르고 실패 기록을 별도 보존한다.

| 동일 최종 SHA의 hosted 입력 | artifact / 내부 기록 | 용도 |
|---|---|---|
| `runtime` 및 동명 artifact의 모든 소유 workflow | `synthetic-runtime-record-runs`: `viewer-context-event`, `tech-note-attempt`, `findings-migration`, `production-image` | 서버 사건·실제 PG 저장 시도·dump/restore·기동 |
| `measurements` 및 동명 artifact의 모든 소유 workflow | `synthetic-workspace-dom-results`: `viewer-context-loss-dom`, `viewer-tech-note-dom`, `emr-contract` | CTX/VR 결합 포함 DOM·두 Note 소비자·EMR-A 순수 계약 |
| `volume-rendering`의 소유 workflow | `synthetic-volume-rendering-results`: `tmp/vr-ci/pure-vr`, `tmp/vr-ci/binding-dom` (artifact 내부 경로 유지) | VR 순수 모델 3파일·접근/세션 DOM |
| 각각 `volume-rendering`, `context-loss`의 소유 workflow | `synthetic-volume-rendering-results`, `synthetic-context-loss`의 profile 결과/로그/영상 | hosted native 보조 근거; 아래 local 기록 대체 불가 |
| candidate.yml | `candidate-<최종 40자리 SHA>` | `candidate-provenance.json`과 전 선택/cleanup 결과 |

전체 소유 workflow의 성공·headSha·attempt와 artifact 출처를 별도 보존한다.
분할 후 `volume-rendering`은 `volume-rendering.yml`에서 찾으며 validate 실행에서 받지 않는다.
Worklist UX의 동명 workspace/runtime artifact도 각 소유 실행에서 따로 받는다.
build 및 나머지 회귀 jobs를 생략하지 않는다. 위 artifact의 profile `results.json`/
개별 `.log`는 `run.json`이 없으므로 `--runs`의 적격 live 근거가 아니다.
`synthetic-context-loss`는 보조 폴더에 받아 판정기의 `--runs`로 넘기지 않는다.
이 제한 때문에 native VR·CTX는 위 local 기록기 코스로 보충한다.

VR `pure-vr`는 기존 CI에서 **세 파일을 함께** 필터 없이 실행한다. 판정기는 TAP의
묶음 전체 성공을 확인한 경우에만 각 `node:tests/<file>.cjs`를 인정한다. 한 사례라도
실패·skip·취소·미완료면 그 묶음의 어느 파일도 PASS가 아니다. EMR-A·CTX 서버의
단일 파일 처리와 Stage 7의 판정 의미는 같다. `tech-note-attempt` 원문에는
`S8-NOTE-SVR storage: postgresql`이 있어야 하며 stand-in 결과로 DB 원자성을 주장하지 않는다.

```powershell
python -B tests/ci_artifacts.py --list
if ($LASTEXITCODE -ne 0) { throw '전체 artifact 출처 목록 확인 실패' }
# $roundRecord는 아래 G3 절에서 이 후보 SHA로 --init·dispatch한 공식 라운드 기록이다(검색으로 찾지 않음).
python -B tests/ci_artifacts.py --sha $sha --stage 8 --record $roundRecord --out "$out/hosted"
if ($LASTEXITCODE -ne 0) { throw '동일 SHA의 비후보·G3 수집 STOP; 원문 보존 후 확인' }
$hosted = Get-Content -Raw "$out/hosted/stage-evidence.json" | ConvertFrom-Json
if ($hosted.status -ne 'completed' -or $hosted.sha -ne $sha -or $hosted.g3.status -ne 'verified') { throw '비후보·G3 수집 상태 불일치' }
$candidateDir = $hosted.g3.candidate_directory
python scripts/record-run.py --run-dir "$out/verdict-run" --cwd . --file scripts/stage-exit.py --file tests/stage8-exit.json -- python scripts/stage-exit.py --list tests/stage8-exit.json --sha $sha --runs "$out/hosted/runs" --runs "$out/live" --candidate $candidateDir --output "$out/verdict.json"
if ($LASTEXITCODE -ne 0) { throw 'Stage 8 필수 시험 미충족: verdict.json 확인' }
```

다운로드·판정은 새 폴더에서 수행하고 각 명령의 exit를 확인한다. G3 workflow 실행의
headSha만 믿지 않고 `candidate-provenance.json.candidate_sha`를 최종 SHA와 대조한다.
13개 요구 그룹의 자동 PASS와 독립 Astra의 Stage 8 종료 판정은 별개다. 이후 관문은
같은 SHA의 원문을 대상으로 요구→실제 단언→기록을 대조한다.

W2C-05 입력 계약: recorder 명령을 실행하는 각 workflow step이 그 명령의 입력을 선언한다.
`--file tests/**` 및 tests를 포함하는 `--tree`는 소비자 등록 없이 workflow catalogue 전체를 전후 해시한다.
`node tests/ci_workflow_consumers.cjs --audit .`는 step별 누락 입력/미해석 shell 명령을 보고하는 진단 도구다.
수동 소비자 명단이나 새 미등록 시험에 대한 required check는 없다. 지원 loader와 정적 분석 경계는 tests/README.md를 따른다.
누락 입력은 recorder non-zero이며, 감사 결과가 없는 것을 stage-exit PASS로 간주하지 않는다.

## G3 공식 라운드 기록과 수집 (CI-TOOLING-1b)

REQ-G3-PUSH → RISK-G3-STALE/OMITTED/WRONG-ATTEMPT →
`ci_candidate_evidence_test.py`. 공식 모집단은 라운드의 `g3-round.json`에
기록한 run ID뿐이다. 스키마는 `g3_round.schema.json`, writer는
`scripts/g3_dispatch.py`, reader는 `ci_candidate_evidence.py`다. 비공개
라운드 기록에서 이 sidecar의 경로와 SHA256을 결속한다. schema 1은 요청을
누적하고 replacement에도 옛 행을 삭제하지 않는다. 새 요청/재실행/기록 수정은
기존 수집 판정을 무효화하며 병합 직전에 같은 기록으로 다시 확인한다.

**legacy 기준 T0(D1117):** T0는 G3 producer를 처음 담은 main commit(이 단위 PR의 병합
commit)이며, 병합 전 시험에서는 이 브랜치의 첫 producer commit이다. `--init`만 `cutoff`에
T0 SHA와 그 commit의 committer 시각을 쓴다. `--init`은 T0의 candidate.yml에 `--produce`
단계가 있고 첫 부모에는 없음을 GitHub에서 확인하며, 더 늦은 commit이나 미래 시각은 거절한다.
생성 시각과 최신 attempt 시작 시각이 모두 T0 이전인 candidate.yml 실행은 **legacy**다.
legacy는 증거로 인정하지도, STOP 사유로 쓰지도 않으며 `g3-evidence.json`의
`legacy_excluded`에 run id·created_at과 함께 남긴다. 기록된 run이 T0 이전에 생성됐거나
`--adopt-run`이 T0 이전 실행을 가리키면 STOP한다. T0 이전 실행을 T0 이후 재실행하면
legacy가 아니며 provenance를 증명해야 한다. 같은 후보 supersession 검사는 T0 이후 실행에만
적용한다. 제목·이름 shortcut이나 이력 삭제는 쓰지 않는다.

다음 명령은 지휘자가 지정한 후보 SHA와 **새 producer가 들어 있는 branch/tag ref**로
한 번 실행한다. dispatch ref tip과 후보 SHA는 달라도 된다. 이 예시는 실행 허가가
아니며 이미 결속된 실행은 재요청하지 않는다. `$roundRecord`는 비공개 라운드의
sidecar 경로, `$roundId`는 해당 라운드 식별자, `$dispatchRef`는 검토된 도구 ref,
`$cutoffSha`는 위 T0다. 기록은 `--init`으로만 만들며 dispatch가 대신 만들지 않는다.

```powershell
python scripts/g3_dispatch.py --init --record $roundRecord --repository $repository --sha $sha --round-id $roundId --cutoff-sha $cutoffSha
if ($LASTEXITCODE -ne 0) { throw 'G3 라운드 초기화 실패: T0와 기록 확인' }
python scripts/g3_dispatch.py --record $roundRecord --repository $repository --sha $sha --round-id $roundId --ref $dispatchRef
if ($LASTEXITCODE -ne 0) { throw 'G3 dispatch 미확정: 기록을 보존하고 STOP 절차 확인' }
```

Stage 7/8의 G3 입력은 위 수집기 블록이 같은 `$roundRecord`로 받는다. G3만 확인할 때는
`python tests/ci_candidate_evidence.py --record $roundRecord --out <새 폴더>`로 같은 검증을
따로 실행할 수 있으며 결과는 `<새 폴더>/g3-evidence.json`이다.
collector의 `verified`는 실행/attempt/artifact 출처 확인이다. Stage 7/8 판정은
그 뒤 `$candidateDir`의 runner provenance·실제 선택·결과·cleanup을 기존
`scripts/stage-exit.py`로 확인한다. 여러 active 기록은 **모두** 최신 attempt가
success이며 적격 업로드가 있어야 한다. 마지막 기록의 폴더를 판정 입력으로 쓴다.
비후보 CI 경로는 1a의 별도 수집 계약을 그대로 따른다. producer attempt 결속(CD-02-R)은
candidate.yml에만 있다. 비후보 workflow의 재실행(attempt 2 이상)은 위 1a 계약대로 STOP이다.

dispatch는 원자적으로 pending 요청과 nonce를 먼저 쓰고, 정확한 POST body와
응답을 기록한다. 200 응답의 run ID(`run_url`도 같은 저장소·ID여야 함)를 직접 조회하며,
event·workflow·저장소·생성 시각 창·dispatch ref가 다르면 즉시 STOP한다. GitHub는 run-name을
렌더링하기 전에 ID를 돌려주므로(실제 run 38504773317), 같은 ID를 최대 12회 다시 읽어 제목에 후보 SHA와
nonce가 나타날 때만 결속하고, 끝내 나타나지 않으면 pending으로 STOP한다. ID 없는 응답/응답 유실의 복구는
동일 nonce를 넣은 run-name과 요청 시각(−5초~+10분)을 최대 12회 대조한다.
모호하거나 못 찾으면 pending을 유지한다. 제목 검색은 이 **요청 응답 복구**에만
쓰며 collector는 제목으로 후보 귀속을 정하지 않는다. `--resume`은 재POST하지 않는다.

각 official ID는 run과 최신 attempt endpoint의 workflow·repository·event·상태를
대조한다. 유일한 `candidate-<sha>` artifact의 ID로 zip을 받고, API가 제공한 digest와
실제 SHA256을 대조한다(API digest가 없으면 실제 archive hash만 기록한다).
payload의 run_id·run_attempt·candidate_sha·workflow_path·started_at·tools_sha·nonce를
검사하고, run/attempt/목록/artifact metadata와 원장 hash를 끝에서 다시 대조한다.
producer는 `g3-provenance.json`을 기존 업로드에 넣고 재실행 때 `overwrite: true`로
같은 run의 옛 업로드를 교체한다. 누락·중복·만료·교체·digest/출처 모순은 STOP이다.

supersession 조회는 보존된 candidate.yml 전체 run 목록을 끝까지 대조한다. 실제
`/repositories/<id>/` Link를 허용하되 host·repository·query 변경, cycle, count 모순,
workflow count ≥1,000은 STOP한다. 목록에서 새 official ID를 선택하지 않는다.
T0 이후 미등록 run의 payload가 같은 후보면 ID/attempt를 표시하고 STOP하며, 제목·head_sha·
artifact 이름으로 귀속을 추정하지 않는다. 다른 후보의 현재 attempt provenance가
검증되면 영향을 주지 않는다. T0 이후의 provenance 없는 실행(producer 없는 ref에서 시작한
실행, 무업로드 실행)은 귀속 불명으로 STOP한다. legacy 행은 내용을 읽지 않고 마지막 전체 목록
대조에만 포함되므로, 수집 중 legacy 행이 바뀌어도 STOP한다.
retention/수동 삭제 이전의 전 GitHub 이력을 증명하지 않으며, `verified_at` 이후
재실행까지 막는 원자적 snapshot이나 영구 인증서도 아니다.

G3는 하나의 candidate job이다. 최신 attempt에서 이 job 전체와 provenance upload가
다시 끝나야 한다. 일부 step/job의 옛 artifact를 새 attempt로 표시하지 않으며, 부분
재실행으로 현재 attempt 업로드가 없으면 STOP한다. 별도 시작 marker는 추가하지 않았다.
기존 upload의 `always()` 단계에 provenance를 더하는 비용만 들이고, runner 배정 전
실패·취소·업로드 장애는 push-side pending/run 기록으로 거절한다.

PR은 기본 거절한다. 자동 PR G3를 공식 수용할 라운드는 먼저 아래처럼 초기화한다.
PR 일반 CI는 merge commit을 시험하므로 head SHA 근거로 바꾸지 않는다. 이 G3의
별도 candidate checkout만 수용하며 PR head와 merge-tools SHA를 admission에서
대조하고 payload의 candidate/tools SHA를 수집 때 재검증한다.

```powershell
python scripts/g3_dispatch.py --init --record $roundRecord --repository $repository --sha $sha --round-id $roundId --cutoff-sha $cutoffSha --pr-policy candidate-checkout-with-merge-tools
if ($LASTEXITCODE -ne 0) { throw 'G3 라운드 초기화 실패' }
python scripts/g3_dispatch.py --record $roundRecord --adopt-run $prRun --evidence-dir "$out/pr-admission"
if ($LASTEXITCODE -ne 0) { throw 'G3 PR 출처 admission STOP' }
```

STOP 시 `gh run view <id> --json databaseId,attempt,status,conclusion,headSha,event,workflowName`
및 `gh api repos/<owner>/<repo>/actions/runs/<id>/attempts/<n>`으로 실제 ID·attempt·실패/대기·
workflow 경로를 확인한다. 원문과 incomplete manifest를 보존한다. 완료 실패를 고친 뒤
같은 run을 재실행하면 기존 ID를 유지하고 최신 attempt를 수집한다. 새 dispatch로
교체하려면 완료된 옛 ID/attempt를 명시한다. active run을 조용히 제외하지 않는다.
pending 요청만 다음 응답 복구 명령을 사용한다.

```powershell
python scripts/g3_dispatch.py --record $roundRecord --resume
if ($LASTEXITCODE -ne 0) { throw '응답 복구 미확정: 재POST 금지, 원문 확인' }
```

이미 ID가 결속된 완료 실패를 새 실행으로 교체하도록 승인한 경우에는 다음 명령을 쓴다.
원래 실패 행과 정확한 attempt를 보존한다. 교체 완료 후 `$out`을 새 증거 디렉터리로
정해 수집 절차만 다시 실행한다(기존 출력 덮어쓰기와 추가 dispatch는 하지 않는다).

```powershell
python scripts/g3_dispatch.py --record $roundRecord --repository $repository --sha $sha --round-id $roundId --ref $dispatchRef --supersede "${oldRun}:${oldAttempt}"
if ($LASTEXITCODE -ne 0) { throw '교체 실행 미확정' }
```

옛 run의 attempt가 바뀌거나 교체 run 시작보다 늦게 끝났으면 교체 계약이 무효다.
미등록 실행은 제목으로 등록하지 않는다. payload가 검증 가능한 기존 실행만
`--adopt-run`으로 누적한다. T0 이후 무업로드/만료라 귀속이 불명확한 경우 이 도구는
복구를 추정하지 않으며, 지휘자의 별도 검증 가능한 admission 근거/계약 정리가 필요하다.
cap STOP도 임의 기간 축소로 우회하지 않는다. `.lock`/`.new`가 남았다면 소유 프로세스와
마지막 기록을 확인하고 원문을 보존한 뒤 소유한 중단 파일만 정리한다.

1a 연결: `ci_artifacts.download()`의 기본(전체) 경로는 명시한 `record`가 없거나 `--dry-run`이면
조회 전에 STOP한다. 기록의 후보 SHA·저장소를 확인한 뒤 비후보 수집(`--non-candidate`와 같은
코드 경로) → `ci_candidate_evidence.collect(record, <out>/g3, query, fetch)` 순서로 실행하고,
G3가 읽은 기록 hash가 처음 결속한 hash와 같으며 두 결과가 모두 성공한 뒤에만
`stage-evidence.json`을 completed로 쓴다. 어느 쪽이 STOP해도 각 manifest와 incomplete 결합
manifest를 남긴다. `non_candidate=True` 경로의 동작은 바꾸지 않았다.
