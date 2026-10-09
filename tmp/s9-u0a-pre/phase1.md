# S9-U0a-PRE phase 1 — 분할 시험 기반과 조기 입력 적색 시험 (제품 무변경)

기준 `f1d540626aac03f46de23a9620d69f4c9da66037`(RELIST, 제품 = main `2fc7358`), branch `fable/s9-u0a-pre-20261009`.
제품 경로 변경 0(`git diff 2fc7358 HEAD -- worklist-v0 config api` 빈 결과). 실행·이어 쓰기 방법은 `notes.md`.

## 1. 산출물

| 경로 | 내용 |
|---|---|
| `tests/main_split_harness.cjs` | 임시 0/18/30/45 분할 생성(`main_move_contract.chunks`, 생성물마다 `verify` 바이트·문장·markup 동등), 문장→파일·줄 manifest, `deriveSpec`(바뀐 페이지를 같은 45 run으로). 제품 tree 안 쓰기 거부(`tmp*` 밖). |
| `tests/main_split_harness.py` | `ScratchPages`(OS temp), `Delivery`(경계별 0/150 ms, 한 script hold→`release`), `TRACE_SCRIPT`(등록·해제·on* 속성, dispatch 결과, 실행 script, uncaught error; listener 무변경·무catch), `attribute`, `by_target_event`, `derive_spec`. |
| `tests/main_early_input_dom_test.py` | 43 사례: 등록 2·창/세션 사건 1·무분할 대조 6(green) + 분할 적색 34. 원본 = `2fc7358` git blob(main.html과 다른 script 모두). |
| `tmp/s9-u0a-pre/tools/` | `matrix.py`(경계 전수 조사), `summarize_matrix.py`, `attribute_extra.py`·`attribute_pagehide.py`(오류→등록 문장), `simulate_fix.cjs`·`run_variants.py`(scratch 모의 수정/변이), `probe_initial.py`. 시험이 아닌 조사 도구다. |
| `tmp/s9-u0a-pre/trace/` | 원본 등록 trace(세션 답 대기)와 현재 페이지의 답함/실패/실패→Retry 전체 trace(JSON, 문장 귀속·target/event 수). |
| `tmp/s9-u0a-pre/runs/` | 모든 실행의 record-run 원문(run.json·stdout·stderr). `matrix-1/2.json`은 조사 원자료. |

## 2. 실행 결과(원문은 runs/)

| 실행 | 명령 | exit | ran | pass | fail | xfail | skip |
|---|---|---:|---:|---:|---:|---:|---:|
| `runs/suite-2` (최종 tree) | `python tests/main_early_input_dom_test.py` | 0 | 43 | 9 | 0 | 34 | 0 |
| `runs/suite-unmarked-2` | `KIN_PRE_EXPECT_RED=0 python tests/main_early_input_dom_test.py EarlyInputSplit` | 1 | 34 | 0 | 34 | 0 | 0 |
| `runs/suite-1`, `runs/suite-unmarked-1` | 같은 명령, 원본 참조 script를 blob으로 바꾸기 전 tree | 0 / 1 | 43 / 34 | 9 / 0 | 0 / 34 | 34 / 0 | 0 |
| `runs/matrix-2` | `tools/matrix.py`: 18/30/45 전 경계 hold × 입력 8군 + 0 ms×10·150 ms×3 | 0 | (조사) | | | | |
| `runs/matrix-1` | 같은 조사의 첫 판(입력 5군, 0 ms×5·150 ms×2) | 0 | (조사) | | | | |
| `runs/attribute-extra-1`, `runs/attribute-pagehide-1` | 추가 위험의 등록 문장 귀속 | 0 | (조사) | | | | |

unmarked 실행의 34 실패는 모두 `HazardFailure`(uncaught error 목록)이고 suite-1/2에서 문구가 같다.

- 0 ms 재현은 시간 경쟁이라 시험 판정에 쓰지 않고 matrix 비율로만 기록한다(§4). 150 ms 사례는 입력이 끝났을 때 선언 part가 아직 안 돌았는지
  확인하고, 아니면 skip("timing")한다 — 경쟁에 진 실행을 통과로 세지 않기 위해서다(이번 실행 skip 0).
- `runs/sim-final-proposal`은 시험 파일 수정 뒤 재실행하려고 TaskStop으로 중단한 실행이다(run.json에 exit 없음). 판정에 쓰지 않는다.
  `runs/sim-proposal`, `sim-proposal-plus(-2)`, `sim-m1/m2/m5-*`는 같은 모의의 앞선 시험 판(각 run.json에 당시 파일 hash); 판정은 `sim-f2-*`.
- suite-1의 trace 출력(커밋 전 산출물)은 suite-2 직전에 지우고 suite-2가 다시 만들었다. suite-1의 실행 원문은 runs/suite-1에 그대로 있다.

## 3. 등록 trace 요약 (영향 target, 등록 수)

원본(세션 답 대기) / 현재 페이지: 답함 → boot 완료 / 실패(503×4) / 실패 → Retry → boot. 원본과 현재의 세션 답 전 등록은 (target,event)별 순서까지 같다.

| target event | 원본 대기 | 답함 | 실패 | 실패→Retry |
|---|---:|---:|---:|---:|
| #conclusion focus | 2 | 2 | 2 | 2 |
| #conclusion input | 4 | 4 | 4 | 4 |
| #conclusion keydown | 1 | 1 | 1 | 1 |
| #conclusion mouseup | 1 | 1 | 1 | 1 |
| #findings focus | 2 | 2 | 2 | 2 |
| #findings input | 4 | 4 | 4 | 4 |
| #findings keydown | 1 | 1 | 1 | 1 |
| #findings mouseup | 1 | 1 | 1 | 1 |
| #page-current click | 1 | 1 | 1 | 1 |
| #page-next click | 1 | 1 | 1 | 1 |
| #page-prev click | 1 | 1 | 1 | 1 |
| #page-size change | 1 | 1 | 1 | 1 |
| #quick input | 1 | 1 | 1 | 1 |
| #quick keydown | 1 | 1 | 1 | 1 |
| #quick-match change | 1 | 1 | 1 | 1 |
| #recommendation focus | 2 | 2 | 2 | 2 |
| #recommendation input | 4 | 4 | 4 | 4 |
| #recommendation keydown | 1 | 1 | 1 | 1 |
| #recommendation mouseup | 1 | 1 | 1 | 1 |
| #t-body change | 1 | 1 | 1 | 1 |
| #t-mod change | 1 | 1 | 1 | 1 |
| #tpl-filter-clear click | 1 | 1 | 1 | 1 |
| #tpl-preview click | 1 | 1 | 1 | 1 |
| #tpl-preview keydown | 1 | 1 | 1 | 1 |
| #tpl-preview-close click | 1 | 1 | 1 | 1 |
| #tpl-preview-insert click | 1 | 1 | 1 | 1 |
| #tpl-search input | 1 | 1 | 1 | 1 |
| #tpl-search-clear click | 1 | 1 | 1 | 1 |
| #tplrows click | 1 | 1 | 1 | 1 |
| #tplrows contextmenu | 1 | 1 | 1 | 1 |
| #tplrows dblclick | 1 | 1 | 1 | 1 |
| window pagehide | 24 | 41 | 24 | 41 |
| (전체 등록) | 434 | 596 | 435 | 597 |

- 위험 target(세 칸, 상용구 패널, Quick Match, #quick·#page-*)은 세션 답 뒤 등록이 하나도 늘지 않고 Retry도 더하지 않는다.
- `window pagehide`는 세션 답 전 24개(문장 귀속은 trace JSON). report-dictation 1, report-templates-ui 2(2411·2540행)가 앞쪽에 있어,
  상용구 등록을 window 것까지 boot 초기화로 옮기면 이 key의 순서가 바뀐다(§6 변이 m1이 실패로 잡음).
- 등록 총수: 원본 대기 434, 답함 596, 실패 435(+Retry 버튼), 실패→Retry 597(+Retry 버튼 1).

## 4. 위험별 재현 경계 (k = 실행된 module 수, part k를 보류)

| 위험 | 18 | 30 | 45 | 0 ms(matrix 1+2, 15회) | 150 ms |
|---|---|---|---|---|---|
| B1-03 세 칸 focus | k=5–17 | k=5–19 | k=5–19 | 18: 6/15, 30: 4/15, 45: 8/15(1회는 PRE-X1 오류 동반) | 18·30·45 각 5/5 |
| B1-05 Modality/Bodypart/검색/clear (cur 전) | k=6–11 | k=6–11 | k=6–11 | 18: 2/15, 30: 2/15, 45: 3/15 | 18·30·45 각 5/5 |
| B1-05 View (cur 뒤, RFIELDS 전) | k=12–17 | k=12–18 | k=12–18 | (시험 사례 150 ms만) | 사례 1(45) |
| B1-58 Quick Match | 없음* | 없음* | k=38 | 45: 0/15 | 5/5(45) |

\* 18/30에서는 worklist-controls.js와 saved-filters.js가 같은 남은 inline script 안이라 경계가 없다(재현 불가가 아니라 해당 없음).

정확한 실패 원문(unmarked 실행, 사례마다 같은 문구 반복):
- B1-03: `ReferenceError: selectionSeq is not defined` ×3 (#findings/#conclusion/#recommendation focus; mouseup·input listener는 이 경계에서 성공).
- B1-05: `ReferenceError: cur is not defined` ×5 (#t-mod change, #t-body change, #tpl-search input, #tpl-search-clear click, #tpl-filter-clear click);
  View 경로 `ReferenceError: RFIELDS is not defined` ×2 (#tplrows click 두 번, 미리보기 안 열림).
- B1-58: `ReferenceError: renderChips is not defined` ×1 (#quick-match change; `activeFilterName = null`은 sloppy 전역 속성 생성으로 오류 없이
  지나간 뒤 `render()`→`renderChips()`에서 실패 — 조건(fval)만 바뀌고 그리기가 끊긴 부분 변경).
- 무분할: 같은 입력이 pre(본문 script 전)·post(세션 답 대기) 모두 오류 0이며 원본 참조와 화면 동일(UnsplitControl 6 통과).

## 5. 함께 드러난 위험 (보고만, 수정 안 함)

b1-possible.md "needs runtime check" 중 실제 위험으로 확인:
- **B1-15** relatedParts(worklist-data.js) — 페이지를 떠날 때(pagehide, related-parts.js:61의 window listener) `changed`→`renderRelated` 미정의.
  k=9–13, 18/30/45 모두. 오류 `ReferenceError: renderRelated is not defined`.
- **B1-57** readingWorkspace(feature-mounts.js) — pagehide(reading-workspace.js:662) `layout`→`applyLayout` 미정의. k=33–36, 45만.

b1-possible.md 58개에 없는 새 위험:
- **PRE-X1** report-hold.js의 세 칸 input listener(`ExpressionStatement after releaseHold #1`) → `reportWriteBlock`(report-toolbar.js) 미정의.
  k=26–29, 30/45. 세 칸 input 이벤트라 B1-03 수용 기준 범위다.
- **PRE-X2** 상용구 View(B1-05와 같은 문장) → `updateTemplatePreview`→`templateInsertionBlock`→`reportEditorBlock`→`reportWriteBlock` 미정의.
  k=19–29, 30/45(RFIELDS 경계 뒤의 같은 경로, 다른 binding).
- **PRE-X3** worklist-controls.js의 #quick input(#7)·#page-size change(#13)·#page-prev/next/current click(#10–12) → `render`→`renderChips` 미정의. k=38, 45.
- **PRE-P3** feature-mounts.js `consultations`의 pagehide(consultations.js:155) → `clearFilter`→`render`→`renderChips` 미정의. k=33–38, 45.

나머지 "needs runtime check"(B1-16..42, B1-45)는 경계마다 처음부터 켜진 모든 control 입력, 1.5 s 대기(타이머·observer), 창 크기 변경,
다른 문서 앞/뒤·focus, storage+BroadcastChannel 세션 종료, 페이지 떠나기로도 재현되지 않았다(matrix-2: idle 93/93, environment 93/93 무오류).
그 콜백은 boot 뒤 자료 적재가 부르므로 boot가 마지막 part 뒤에만 도는 이 하니스에서는 틈에 닿지 않는다 — **안전 증명은 아니다.**
관찰: k=44(page-boot.js 보류)에서 세션 종료 알림은 session-end.js 처리로 페이지를 랜딩으로 옮긴다(오류 0). k<44에서는 boot의 KinAuth.init이
종료 기록을 읽을 때까지 아무 일도 없다 — 독립 target의 시간 이동이지만 결과(진입 거절)는 같다.

## 6. 시험 판별력 확인 (scratch 모의, 제품 아님)

`tools/simulate_fix.cjs`가 main.html 복사본(OS temp)에 early-input.md의 최소안을 흉내 내고, `KIN_PRE_PAGE`·`KIN_PRE_EXPECT_RED=0`로 전체를
돌렸다(`runs/sim-f2-*`). 시험이 옳은 설계를 통과시키고 틀린 설계를 잡는지 보는 용도이며 phase 2 설계가 아니다.

| 모의 | 내용 | 결과 |
|---|---|---|
| f2-proposal | `let selectionSeq` 를 `const work` 뒤로 + 상용구(report-templates/-ui)의 window 외 등록과 Quick Match 등록을 once 가드 boot 초기화(첫 await 전) | 43 중 33 통과. B1-03/05/58·PRE-X2·등록·대조·창/세션 전부 통과; 실패 10 = PRE-X1 4, PRE-X3 1, 떠나기 5(B1-15 3, B1-57, PRE-P3) |
| f2-proposal-plus | 위 + worklist-controls 등록 전부 + report-hold의 window 외 등록 초기화 | 38 통과; 실패 5 = 떠나기 위험(B1-15 3, B1-57, PRE-P3)만 |
| f2-m1-window-moved | 상용구 window pagehide 등록까지 boot 초기화로 이동 | 등록 시험 실패: `('window','pagehide')` 순서 차이 |
| f2-m2-noguard | once 가드 없음(재등록 변이) | Retry 시험 실패: 예 `('#conclusion','keydown')` 1 → 2 |
| f2-m5-late-init | 초기화를 첫 await(세션 답) 뒤에서 호출(인증 의존 변이) | 등록 2, 무분할 대조 B1-05/B1-58(post) 실패 |

원본 위험 변이 = 지금 페이지 자체(34 xfail, 문서화된 오류만). 모의 판정 규칙 보완 하나: 같은 칸에 B1-03(제자리 유지)과 PRE-X1(초기화로 늦춤)이
섞이면 경계에 따라 일부 listener만 있는 혼합 상태가 되므로, 화면 비교를 "원본 pre 또는 post 중 한 시점과 전부 같음"으로 정했다(첫 규칙은
위험 자신의 dispatch로 시점을 골라 PRE-X1 모의를 잘못 거절했다 — `runs/sim-proposal-plus` 원문).

설계 힌트(결정 아님): window 등록은 제자리에 두고, boot 초기화는 once 가드와 함께 첫 await 전에 둔다. pagehide 세 건(B1-15/B1-57/PRE-P3)은
module mount가 등록한 pagehide listener가 뒤 part의 함수를 부르는 구조라 등록 이동만으로는 풀리지 않는다.

## 7. D73 자가 점검

- 단언: uncaught error, 위험 listener dispatch 결과(원본 trace의 listener 원문 hash로 식별), 화면에 보이는 값(칸 값·초점·상용구 표·미리보기
  글·Quick Match·칩·목록·toast·dialog), 공개 모듈 계약 `KinWorkContext.selection()`. 구현 문자열·DOM 형태·내부 함수명 단언 없음.
- id는 locator로만 쓴다. 문장 이름은 manifest/trace에서 등록 위치를 사람에게 알리는 데만 쓰고 단언하지 않는다. 바이트 동등은 이동 계약의
  요구 자체(§1-B.14)이며 기존 `verify`를 재사용했다. 자체 파서 없음(TypeScript AST).
- 제품 코드 변경 0. 적색 표시는 문서화된 오류일 때만 expected failure이고 다른 실패는 error다. 단언 약화 없음.

## 8. 미완·한계

- tests/README.md, validate.yml/candidate_ci.py 등록은 owned path 밖이라 하지 않았다.
- dictation 대상(dictationField)은 받아쓰기 흐름 없이 직접 보이지 않는다. focus/mouseup/input listener 완료, 편집 순번(editRevision), 화면,
  boot 뒤 검사 선택 결과로 대신 비교한다(선택이 selection epoch을 올려 이른 focus의 대상 효과는 선택 뒤 남지 않는다).
- 0 ms 재현은 시간 경쟁(비율만). 같은 PC에서 다른 단위의 DOM/실환경 시험이 동시에 돌고 있었다(CPU 경쟁).
- Chromium은 Playwright 1.60 기본(headless shell). Node TypeScript는 `NODE_PATH`=s7-u5-integ/api/node_modules(이 worktree에 api 의존성 없음).
- hosted CI/G3·Astra 검수 미실행. phase 2 설계 미수신.
