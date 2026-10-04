# Stage 7 필수 시험 판정

`stage7-exit.json`의 13개 요구사항과 66개 시험 항목을 **한 최종 main commit**의
원문 결과와 대조한다. U5는 아직 실제 시험 ID가 없으므로 반드시 FAIL이다.
U5 병합 시 최종 계약의 실제 시험 ID를 그 행에 넣고 `pending`을 제거한다.
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

최종 main을 깨끗하게 checkout한 **원본과 분리된 합성 환경**에서 다음 PowerShell 명령을 쓴다.
이 문서의 실행 예시는 환경 기동이나 원본 연결을 허가하지 않는다. `record-run.py`는 HEAD와
파일 해시를 기록하지만 dirty tree 자체를 증명하지 않으므로 실행 전에 수정 상태를 확인한다.

```powershell
$sha = (git rev-parse HEAD).Trim()
if ($sha -ne (git rev-parse main).Trim()) { throw '최종 main checkout 필요' }
if (git status --porcelain -- . ':(exclude)tmp') { throw '실행할 소스의 수정 상태 확인 필요' }
$shortSha = $sha.Substring(0, 12)
$out = "tmp/stage7-final-$shortSha"
# U5 병합 후에는 아래 실행 목록에도 그 실제 시험을 추가한다.
$live = @(
  @('tests/e2e/test_critical_result.py', 'CriticalResultE2E'),
  @('tests/e2e/test_critical_result.py', 'CriticalResultScreensE2E'),
  @('tests/critical_result_live.py', 'CriticalResultTeleLiveTests'),
  @('tests/e2e/test_reader_assignment.py', 'ReaderAssignmentE2E'),
  @('tests/clinical_context_live.py', 'ClinicalContextLive')
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

동일 SHA의 validate 및 G3 실행 artifact를 받아 각각 `$out/validate`, `$out/candidate`에 푼다.
validate에서는 `synthetic-runtime-record-runs`와 `synthetic-workspace-dom-results`가 필요하다.
Node service/scope, DOM, AuditStore DB, integrity와 함께, 두 기존 실행을 `record-run`으로 감싼
`backup-safety/run.json`·`production-image/run.json`도 runtime artifact에서 읽는다.
별도 hosted 업무 프로필의 `results.json`만으로는 SHA가 없으므로 위 live 기록을 대체할 수 없다.
G3 폴더는 `candidate-provenance.json`이 바로 들어 있는 폴더를 지정한다.

```powershell
python scripts/stage-exit.py --list tests/stage7-exit.json --sha $sha --runs "$out/validate" --runs "$out/live" --candidate "$out/candidate" --output "$out/verdict.json"
$LASTEXITCODE
```

도구 자체의 대표 시험(서비스/네트워크 불필요, 실제 시험 자식 강제종료 **한 번** 포함):

```powershell
$env:PATH = 'C:\Users\norne\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;C:\Users\norne\.cache\codex-runtimes\codex-primary-runtime\dependencies\python;' + $env:PATH
python scripts/record-run.py --run-dir tmp/lean-exit-check --cwd . --file scripts/stage-exit.py --file tests/stage7-exit.json --file tests/stage_exit_test.py -- python -B tests/stage_exit_test.py
```

Stage 8은 의사가 채택한 영상 기능의 실제 영상·정확도·실패 복구 시험만,
Stage 9는 승인된 세션/저장 충돌 보호·운영 복구와 정리한 시험의 실제 ID를 추가한다.
새 판정기·포장 규격·문서 형식 관문은 추가하지 않는다.
