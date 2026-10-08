# Stage 7 필수 시험 판정

`stage7-exit.json`의 명시적 필수 시험 항목을 **한 최종 main commit**의
원문 결과와 대조한다. U5는 접속기록·서버 종료/결속·화면 종료·글 보존으로 나누었다.
목록의 `left_out`에 제외 이유가 있다. 이 표는 의사 확인·규제/위험 처분·운영 검증·출시 승인이나
PR CI/독립 검토를 대신하지 않는다. 기존 CI와 시험 실행 예산도 바꾸지 않는다.

입력은 이미 있는 다음 산출물뿐이다. 새로운 실행 결과 형식은 없다.

- `record-run.py`: `run.json`, `stdout.log`, `stderr.log`. Python 사례는 verbosity=2의
  `module.Class.test_method`로, Node 파일 전체는 `node:tests/파일.cjs`로 적는다.
  Node는 기존 validate.yml의 필터 없는 `node --test` TAP 출력이어야 한다.
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
그 클래스의 SE-10·11은 U5 re-cut 뒤 이름과 본문이 달라 필수 목록에서 제외했다.
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
기본 입력은 동일 SHA의 validate `synthetic-runtime-record-runs`와
`synthetic-workspace-dom-results`, G3 `candidate-<sha>` artifact다.
`$validateRun`과 `$candidateRun`에는 해당 SHA의 실행 ID를 지정한다.

```powershell
$sha = (git rev-parse HEAD).Trim()
if ($sha -ne (git rev-parse main).Trim()) { throw '최종 main checkout 필요' }
if (git status --porcelain -- . ':(exclude)tmp') { throw '실행할 소스의 수정 상태 확인 필요' }
$shortSha = $sha.Substring(0, 12)
$out = "tmp/stage7-final-$shortSha"
```

| artifact | 업로드 원래 경로 | 수령 명령 |
|---|---|---|
| `synthetic-runtime-record-runs` | `tmp/runtime-ci/` | `gh run download $validateRun -n synthetic-runtime-record-runs -D "$out/validate/runtime"` |
| `synthetic-workspace-dom-results` | `tmp/workspace-ui-ci/` | `gh run download $validateRun -n synthetic-workspace-dom-results -D "$out/validate/workspace"` |
| `candidate-<sha>` | `target/tests/e2e/artifacts/candidate-ci/` | `gh run download $candidateRun -n "candidate-$sha" -D "$out/candidate"` |

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

앞서 받은 validate artifact의 `run.json`에서 Node service/scope, DOM, AuditStore DB,
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
python scripts/stage-exit.py --list tests/stage7-exit.json --sha $sha --runs "$out/validate" --runs "$out/live" --candidate "$out/candidate" --output "$out/verdict.json"
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
