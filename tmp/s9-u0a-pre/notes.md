# S9-U0a-PRE — 작업 노트 (phase 2에서 이어 쓰기)

worktree `C:\Users\norne\PACS\tmp\opus-worktrees\s9-u0a-pre`, branch `fable/s9-u0a-pre-20261009`, base `f1d540626aac03f46de23a9620d69f4c9da66037`.
제품(worklist-v0/config/api)은 phase 1에서 바꾸지 않았다(`git diff 2fc7358 HEAD -- worklist-v0 config api` 빈 결과).

## 실행 환경

```powershell
$env:Path = "C:\Users\norne\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;" + $env:Path
$env:NODE_PATH = 'C:\Users\norne\PACS\tmp\opus-worktrees\s7-u5-integ\api\node_modules'   # api/node_modules 없음 → TypeScript
$py = 'C:\Users\norne\PACS\tmp\hp-dom-venv\Scripts\python.exe'                          # Playwright 1.60
& $py scripts\record-run.py --run-dir tmp\s9-u0a-pre\runs\<새 이름> --cwd . --file ... -- $py tests/main_early_input_dom_test.py
```

- 시험은 `tests/`를 cwd로 import한다(`python tests/main_early_input_dom_test.py [Class[.method]]`). `-m unittest tests.x`는 import 실패.
- PowerShell 5.1: native stderr를 `2>`로 받지 말 것. record-run.py가 stdout/stderr를 따로 남긴다.
- 환경 변수: `KIN_PRE_EXPECT_RED=0`(적색 표시 해제), `KIN_PRE_PAGE`(시험 대상 페이지를 scratch 복사본으로; 변이 실행용),
  `KIN_PRE_SPEC`(분할 spec 지정; 기본은 대상 페이지에 맞춰 자동 재유도), `KIN_PRE_TRACE_DIR`(등록 trace JSON 출력).

## 구조 요약

- `tests/main_split_harness.cjs`: `split(count, outDir, {page, spec})`(0=무분할, 18/30/45) → manifest(문장별 module·served 파일·줄 범위).
  `main_move_contract.chunks/verify`를 그대로 써서 생성물마다 바이트·문장·markup 동등을 확인. `deriveSpec(page)`: 기준 이후 바뀐 페이지를
  같은 45 run으로 나눈다(문장 원문 일치 + 기준 순서 최장 증가열은 원래 module, 나머지는 지금 놓인 run으로).
- `tests/main_split_harness.py`: `ScratchPages`(OS temp, 닫을 때 삭제), `Delivery`(Playwright route: 경계마다 0/150 ms, 한 script hold →
  `release()`; `pump()/wait()`로만 응답), `TRACE_SCRIPT`(등록·해제·on* 속성, dispatch 결과, 실행된 script, uncaught error; listener는 그대로
  호출하고 catch하지 않는다), `attribute()`(등록 → 문장), `by_target_event()`.
- `tests/main_early_input_dom_test.py`: 원본 = `git cat-file --filters 2fc7358:worklist-v0/hpacs-lite/main.html`(scratch). 대상 = 제품 파일.
  - `Registration`(green 2): 세션 답 전 등록의 (target,event)별 순서 동일; 위험 target 등록이 답(성공/실패/실패→Retry)과 무관, Retry 추가 0.
  - `WindowAndSessionEvents`(green 1): 45분할 9개 hold 경계에서 timer 1 s·resize·다른 문서 앞/뒤·storage+channel 세션 종료 → 오류 0.
  - `UnsplitControl`(green 6): 무분할 pre/post에서 같은 입력 → 오류 0, 원본 참조와 화면 동일; 무분할 떠나기 오류 0.
  - `EarlyInputSplit`(red 34): 위험별 hold/150 ms 경계 사례. `red(hazard, 문서화된 오류)` — 모든 uncaught error가 문서화된 binding일 때만
    expected failure, 그 밖의 실패는 tearDown에서 error. `OPEN_HAZARDS`에서 id를 지우면 그 사례는 일반 시험이 된다.
- 판정 규칙(`assert_like_original`): 오류 0 → 위험 listener 실패 0 → 닿은 위험 listener는 원본 post 순서와 같음 → 화면(입력 직후·boot 후)과
  dialog가 원본 pre 또는 post 중 **한 시점과 전부** 같음. 같은 target의 다른 listener가 경계 때문에 일부만 있어도(혼합 상태) 사람이 보는
  것이 원본 한 시점과 같으면 통과한다(PRE-X1 모의에서 필요성 확인).

## phase 2에서 할 일 (지휘자 설계 수신 후)

1. 제품 변경 후 `OPEN_HAZARDS`에서 고친 id만 지운다. 단언을 약화하지 않는다.
2. 기본 실행으로 분할 spec이 자동 재유도된다(`Pages.derived["moved"]`에 옮겨진 문장 목록). 결과가 이상하면 `KIN_PRE_SPEC`.
3. 원본 참조 run은 main.html 밖 script도 기준 blob(`Pages.baseline_file`)으로 받는다. 그래서 제품 변경이 다른 파일을 바꿔도 원본은
   원본 그대로다. 단 CSS·이미지·index.html은 Site가 현재 파일로 낸다(원본 비교 대상 화면 영역과 무관).
4. 원본 위험 변이(제품 변경 되돌림) = 지금 페이지(34 xfail로 확인됨). 재등록 변이(once 가드 제거)·늦은 등록 변이(첫 await 뒤)·window
   등록 이동 변이는 `tools/simulate_fix.cjs` + `tools/run_variants.py`로 scratch에서 재실행(제품 무변경).
5. tests/README.md·CI(validate.yml/candidate_ci.py) 등록은 owned path 밖 — 지휘자 결정 대기.

## phase 2 (요약은 `phase2.md`)

- 설계 이름 대응: `main_pre_order_dom_test.py` → `tests/main_early_input_dom_test.py`; `main_pre_contract.cjs` → `tests/main_split_harness.cjs`(split·deriveSpec·fixtureBlocks·preMutant) + `tests/main_split_harness.py`; 변이 실행 → `tests/main_early_input_mutants.py`; f1d5406 문장 목록 → `tests/main_split_harness_fixture.json`.
- 제품 바이트는 `node tmp/s9-u0a-pre/tools/apply_moves.cjs worklist-v0/hpacs-lite/main.html`(f1d5406 blob 입력)의 출력과 같다.
- 변이: `apply_moves.cjs --except Mxx | --m36 | --m37`(전체 시험 × 38), `preMutant`(드라이버, 같은 문장 결과 `tools/check_mutant_equivalence.cjs`).
