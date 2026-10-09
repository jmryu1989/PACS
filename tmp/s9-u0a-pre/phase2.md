# S9-U0a-PRE phase 2 — 35개 선언 이동과 수용 시험·변이·재결속·CI 등록

설계: `C:\Users\norne\PACS\tmp\astra-control\evidence\s9-u0a-pre-prereview-20261009\design.md`(Astra 사전 검수, "최종 이동 35단위").
원본(ORIGINAL)은 f1d5406 blob(= main 2fc7358 제품). 브랜치 `fable/s9-u0a-pre-20261009`.

| 커밋 | SHA | 내용 |
|---|---|---|
| merge | `969581c9eed3dacd9e96e94e5db1b149efb5e7cb` | origin/main 04e50ab(RELIST round 2) 병합, 충돌 없음 |
| P | `121811d27b06c0b9868a7fd6b97f8eca995c87fc` | 제품 main.html 35단위 이동 + 시험(조기 입력 suite 해제·보강, 9개 legacy의 fixture projection) |
| C | `00bead586153fbae668c18f1d5387a6a2a13e4b0` | spec 재생성(base = P, 661문장) + fixture 참조 파일 + 변이 드라이버 + 증거. main.html blob P = C = `ec521a81b0921ec90647f8bf13ecb9aee1d07b12` |
| 후속 | 이 문서를 담은 커밋(C 다음) | PRE-P3 k=37 떠나기 사례 복원, fixture projection 끝 규칙 수정, report_version_citation 2개 재지정, A2·문서 |
| CI | 브랜치 마지막 커밋 | "S9-U0a-PRE CI registration": validate.yml + tests/README.md |

## 1. 제품 변경 (P)

`tmp/s9-u0a-pre/tools/apply_moves.cjs`가 f1d5406 blob에서 설계 표의 35단위를 TypeScript AST 위치로 옮겨 만든 바이트가 그대로 제품이다.
- 문장은 원문 그대로 옮기고, 그 문장만을 설명하는 바로 위 주석(M01 5505–5513, M06 9042–9049, M07 7390–7405, M12 3152–3153, M16 3181,
  M22 5775–5780)을 함께 옮겼다. 여러 문장을 묶는 절 제목(`// ── 데이터 ──`, `// ── 선택 ──`, `// ── Report ──`, `── User Filter List`,
  `// Related Exam: …`, baseVersion 절 jsdoc 5493–5504)은 제자리에 남겼다.
- 세 다중 선언: `selectedUid`, `consultationFilter`, `workspaceState`만 빼서 독립 `let`으로 옮겼고 나머지 initializer·순서는 그대로다.
- 목적지 6곳(1991 앞, 2159의 주석 묶음 앞, 2443 앞, 2752 앞, 2895 앞, 9898 앞)에 표 순서로 넣고 목적지마다 이유 주석 한 줄을 뒀다.
- 등록문·호출 지점·boot·함수 본문 변경 0, 문장 658→661, parse 진단 0.

## 2. 수용 시험 결과

| 실행 | exit | ran | pass | fail | skip | 비고 |
|---|---:|---:|---:|---:|---:|---|
| `runs/suite-p` (P) | 0 | 58 | 58 | 0 | 0 | 263.7 s, 등록 trace 출력 |
| `runs/suite-c` (C) | 0 | 58 | 58 | 0 | 0 | 320.7 s |
| `runs/a1-c` A1 `node --test tests/main_move_test.cjs` (C, spec.base = P) | 0 | 5 | 5 | 0 | 0 | 미이동·삭제/중복/교환 거절·18/30/45 복원 |
| `runs/fixture-check-c` | 0 | — | — | — | — | f1d5406 문장 목록 = 커밋된 fixture 파일 |
| `runs/mutant-M00..M37` 전체 시험 × 38 | 1 | 58 | — | — | — | M00(=원본) 및 37개 모두 kill, ERROR 0 |
| `runs/mutant-driver-1` `tests/main_early_input_mutants.py` | 0 | — | — | — | — | baseline 10건 통과 후 37/37 kill |
| `runs/suite-final` (후속 커밋 내용) | 0 | 59 | 59 | 0 | 0 | 943.4 s, k=37 사례 복원 포함 |
| `runs/suite-final` (후속 커밋 내용) | 0 | 59 | 59 | 0 | 0 | 943.4 s, k=37 사례 복원 포함 |

red→green: phase 1 적색 34건 중 33건은 같은 이름으로, PRE-P3 k=37 1건은 후속 커밋에서 같은 이름으로 복원해 녹색이다(§6).
phase 2에서 더한 분할 사례 12건(B1-05 Tab 6, B1-41/42/45 떠나기 5, B1-57/PRE-P3 k=36 1)과 등록 3건·대조 1건도 녹색이다.
설계 표 밖에서 실패한 사례 없음(still_red 0).

## 3. 등록·dispatch trace (원본 f1d5406 vs PRE)

`Registration.test_registrations_match_the_original_page_before_and_after_each_session_outcome`가 세션 답 대기, 답함→boot, 실패(503×4),
실패→Retry→boot 각각에서 원본과 PRE를 같은 단계로 실행해 (target, event)별 등록 목록(종류·capture·once·passive·listener 원문
hash)의 순서까지 비교한다. 결과 trace(`trace/`):

| 단계 | 원본 등록 | PRE 등록 | (target,event) 키 | 다른 키 | window pagehide |
|---|---:|---:|---:|---:|---:|
| 세션 답 대기 | 434 | 434 | 387 | 0 | 24 = 24 |
| 답함 → boot | 596 | 596 | 509 | 0 | 41 = 41 |
| 실패 | 435 | 435 | 388 | 0 | 24 = 24 |
| 실패 → Retry → boot | 597 | 597 | 510 | 0 | 41 = 41 |

window pagehide 24개의 순서는 설계 목록 그대로다(dictation, template preview, template editor, relatedParts, worklistBodyParts,
studyPriority, studyPageClient, SR, patient-copy, thumbnails, image-request, citation, viewer placement, favorites, study tags,
consultations, reader assignment, tech note, reading workspace, reading findings, clinical context, critical-result sender/recipient,
study questions) — 24개 모두 같은 listener. (studyPriority 문장의 익명 이름만 앞 선언이 바뀌어 다르게 붙는다.)
`test_after_retry_one_quick_match_change_has_one_effect`(Retry 뒤 한 change = 한 listener, 같은 화면)와
`test_a_report_field_input_reaches_its_listeners_in_the_original_order`(한 입력의 invocation 순서)도 원본과 같다.

## 4. 변이 37개

| M | 이동 단위 | 실패 사례 수 | 고른 사례 | 그 사례의 실패 문구 |
|---|---|---:|---|---|
| M01 | selectionSeq | 11 | `EarlyInputSplit.test_B1_03_45_hold_report_editor_js` | `ReferenceError: selectionSeq is not defined` |
| M02 | studies | 4 | `EarlyInputSplit.test_B1_05_45_hold_worklist_columns_view_js` | `ReferenceError: studies is not defined` |
| M03 | quickDays, sortKey, sortDir, selectedUid, selectedOid | 4 | `EarlyInputSplit.test_B1_05_45_hold_worklist_columns_view_js` | `ReferenceError: selectedUid is not defined` |
| M04 | cur | 11 | `EarlyInputSplit.test_B1_05_45_hold_current_study_js` | `ReferenceError: cur is not defined` |
| M05 | RFIELDS | 11 | `EarlyInputSplit.test_B1_05_45_hold_current_study_js` | `ReferenceError: RFIELDS is not defined` |
| M06 | reportWriteBlock | 28 | `EarlyInputSplit.test_B1_05_45_hold_current_study_js` | `ReferenceError: reportWriteBlock is not defined` |
| M07 | editReport | 6 | `EarlyInputSplit.test_B1_05_TAB_45_hold_report_draft_save_js` | `ReferenceError: editReport is not defined` |
| M08 | relatedModalities | 7 | `EarlyInputSplit.test_B1_15_45_leave_while_holding_worklist_view_js` | `ReferenceError: relatedModalities is not defined` |
| M09 | relatedPage, relatedPageQuery | 7 | `EarlyInputSplit.test_B1_15_45_leave_while_holding_worklist_view_js` | `ReferenceError: relatedPageQuery is not defined` |
| M10 | renderRelated | 7 | `EarlyInputSplit.test_B1_15_45_leave_while_holding_worklist_view_js` | `ReferenceError: renderRelated is not defined` |
| M11 | savedFilterDays | 3 | `EarlyInputSplit.test_B1_15_45_leave_while_holding_worklist_view_js` | `ReferenceError: savedFilterDays is not defined` |
| M12 | filteredFor | 3 | `EarlyInputSplit.test_B1_15_45_leave_while_holding_worklist_view_js` | `ReferenceError: filteredFor is not defined` |
| M13 | consultationFilter, consultationFilterSequence | 3 | `EarlyInputSplit.test_B1_15_45_leave_while_holding_worklist_view_js` | `ReferenceError: consultationFilter is not defined` |
| M14 | searchCriteria | 3 | `EarlyInputSplit.test_B1_15_45_leave_while_holding_worklist_view_js` | `ReferenceError: searchCriteria is not defined` |
| M15 | filtered | 4 | `EarlyInputSplit.test_B1_15_45_leave_while_holding_worklist_view_js` | `ReferenceError: filtered is not defined` |
| M16 | orderedStudies | 3 | `EarlyInputSplit.test_B1_15_45_leave_while_holding_worklist_view_js` | `ReferenceError: orderedStudies is not defined` |
| M17 | resultPage, resultQuery, resultPageSize | 3 | `EarlyInputSplit.test_B1_15_45_leave_while_holding_worklist_view_js` | `ReferenceError: resultQuery is not defined` |
| M18 | render | 3 | `EarlyInputSplit.test_B1_15_45_leave_while_holding_worklist_view_js` | `ReferenceError: render is not defined` |
| M19 | relatedStudy | 4 | `EarlyInputSplit.test_B1_15_45_leave_while_holding_worklist_view_js` | `ReferenceError: relatedStudy is not defined` |
| M20 | viewed | 5 | `EarlyInputSplit.test_B1_15_45_leave_while_holding_worklist_view_js` | `ReferenceError: viewed is not defined` |
| M21 | renderStudyIdentity | 4 | `EarlyInputSplit.test_B1_15_45_leave_while_holding_worklist_view_js` | `ReferenceError: renderStudyIdentity is not defined` |
| M22 | renderDraftHint | 7 | `EarlyInputSplit.test_B1_15_45_leave_while_holding_worklist_view_js` | `ReferenceError: renderDraftHint is not defined` |
| M23 | heldByOther | 9 | `EarlyInputSplit.test_B1_15_45_leave_while_holding_worklist_view_js` | `ReferenceError: heldByOther is not defined` |
| M24 | updateReportButtons | 9 | `EarlyInputSplit.test_B1_15_45_leave_while_holding_worklist_view_js` | `ReferenceError: updateReportButtons is not defined` |
| M25 | validUserFilters | 5 | `EarlyInputSplit.test_B1_58_45_hold_saved_filters_js` | `'chips': 'SYN Local Search (0)'` |
| M26 | userFilters | 3 | `UnsplitControl.test_B1_58_unsplit` | `'chips': 'SYN Local Search (0)'` |
| M27 | TryStatement after userFilters #1 | 2 | `EarlyInputSplit.test_B1_58_45_hold_saved_filters_js` | `'chips': 'SYN Local Search (0)'` |
| M28 | activeFilterName | 13 | `EarlyInputSplit.test_B1_15_45_leave_while_holding_worklist_view_js` | `ReferenceError: activeFilterName is not defined` |
| M29 | renderActiveFilter | 15 | `EarlyInputSplit.test_B1_58_45_hold_saved_filters_js` | `ReferenceError: renderActiveFilter is not defined` |
| M30 | renderChips | 15 | `EarlyInputSplit.test_B1_58_45_hold_saved_filters_js` | `ReferenceError: renderChips is not defined` |
| M31 | layoutMode | 3 | `EarlyInputSplit.test_B1_57_45_leave_while_holding_clinical_context_panel_js` | `ReferenceError: layoutMode is not defined` |
| M32 | workspaceState, workspaceOwner, workspaceStorage, workspaceGeneration | 3 | `EarlyInputSplit.test_B1_57_45_leave_while_holding_clinical_context_panel_js` | `ReferenceError: workspaceState is not defined` |
| M33 | portraitLayout | 2 | `EarlyInputSplit.test_B1_57_45_leave_while_holding_clinical_context_panel_js` | `ReferenceError: portraitLayout is not defined` |
| M34 | workspaceAxis | 2 | `EarlyInputSplit.test_B1_57_45_leave_while_holding_clinical_context_panel_js` | `ReferenceError: workspaceAxis is not defined` |
| M35 | applyLayout | 2 | `EarlyInputSplit.test_B1_57_45_leave_while_holding_clinical_context_panel_js` | `ReferenceError: applyLayout is not defined` |
| M36 | Retry에 Quick Match closure 추가 등록 | 3 | `Registration.test_after_retry_one_quick_match_change_has_one_effect` | `the listeners one Quick Match change reaches after Retry` |
| M37 | dictation 편집 알림을 citation input 뒤로 | 10 | `Registration.test_a_report_field_input_reaches_its_listeners_in_the_original_order` | `the (target, event, listener) invocation order of one focus/keypress` |

전체 시험 × 38 실행은 C 내용(58건)으로 했다. 후속 커밋은 k=37 사례 1건을 더할 뿐 변이 표·kill 규칙을 바꾸지 않는다.

M00(모든 단위를 되돌린 = f1d5406 페이지)은 분할 46건과 창/세션 사건 시험에서 실패한다(원래 위험의 재현). 모든 kill은 assertion
실패이며 ERROR(import·fixture·timeout) 0이다. M25/M26/M27은 catch·sloppy 대입에 숨는 변이라 오류가 아니라 저장 검색 칩
(`SYN Local Search (0)`) 누락이라는 사용자 결과로 죽는다(M26은 분할 hold 사례에서는 전역 대입이 칩을 살려 살아남고, 무분할 대조와
150 ms 사례가 죽인다).

## 5. A2 (지시 42개 + 9개) 와 추가 13개

before = merge `969581c` 별도 worktree(TypeScript 같은 junction), after = C `00bead5`의 시험 + 후속 커밋의 투영 규칙.

| 묶음 | 전 (사례 / 결과) | 후 | 사례·결과 동일 | 비고 |
|---|---|---|---|---|
| 지시 42개(9개 포함) | 800 / pass 800 / fail 0 / kill 19 | 800 / pass 800 / fail 0 / kill 19 | True | LiveStack 2개(`invariants_live.py`, `worklist_columns_live.py`) 미실행; 12개 fixture 소비 파일은 `a2/after-fixture` |
| 추가 14개(main.html 소비 격리 + A1) | 322 / pass 321 / fail 1 / kill 0 | 322 / pass 321 / fail 1 / kill 0 | True | `auth_session_service_test.cjs`는 전후 모두 fail 1(`/app/node_modules` 필요 — 컨테이너 전용) |

파일별 표: `a2-counts.md`, `a2-extra-counts.md`; 원문 `a2/<phase>/runs/<stem>/`; 병합 근거 `a2/after-merged/results.json`.
첫 after 실행(`a2/after`)에서 `report_version_citation_dom_test.py`·`_mutants.py`가 깨졌다: 그 시험은 history block을
`reportWriteBlock`의 jsdoc 문자열로 잘랐는데 M06이 그 선언을 앞으로 옮겼다(설계 9개 목록 밖). 같은 fixture projection으로
옮겼고(`HISTORY_BLOCK = historyEpoch..reportWriteBlock`의 f1d5406 문장 11개 = 원래 절단 11개, 단언·사례·변이 불변) 재실행 중 변이 MH5가
살아남아 투영의 끝 규칙을 고쳤다(끝 선언이 옮겨 간 경우에도 run 마지막 문장 바로 뒤의 미대응 문장은 run에 속함). 고친 뒤 12개 fixture
소비 파일 전부를 다시 돌린 것이 `a2/after-fixture`(모두 exit 0, MH5 포함 kill 동일).

## 6. 실행 중 결정·편차

- console.error 포착: studyPriority의 catch가 render 실패를 console.error로만 알리므로(B1-41) 떠나기·입력 사례가 page error와 함께
  page 코드의 console.error를 오류로 센다(브라우저 자체 알림은 표시로 구분).
- listener 동일성: 외부 part 파일의 CRLF와 inline LF 차이를 hash에서만 정규화(제품 바이트 비교는 정규화하지 않음).
- 판정 규칙: 화면은 원본 pre/post 중 한 시점과 early·final·dialog 전부 같아야 한다(혼합 등록 상태 허용, 부분 결과 불허).
- fixture projection: f1d5406 문장 목록을 `tests/main_split_harness_fixture.json`으로 고정(runtime의 read-only node 컨테이너와
  dictation-capture job에 git 이력이 없음). CI의 `fixture-check`가 blob과 대조한다.
- 두 S3 변이 드라이버의 fixture 확인은 `--anchors-only` 종료 뒤로(그 단계가 CI에서 TypeScript 설치 전에 돈다). 사례·변이·kill 규칙 불변.
- phase 1의 PRE-P3 k=37 사례 이름을 phase 2 초안에서 k=38 사례로 바꿨던 것을 후속 커밋에서 되살렸다(두 경계 모두 유지).
- merge 커밋 메시지는 기본 문구(Co-Authored-By 줄 없음)로 push됐다.
- 설계의 9개 밖: `report_version_citation_dom_test.py`·`report_version_citation_mutants.py`도 M06 때문에 같은 projection으로 재지정(§5).
- 파일 이름: 설계의 `tests/main_pre_order_dom_test.py` = `tests/main_early_input_dom_test.py`, `tests/main_pre_contract.cjs` =
  `tests/main_split_harness.cjs`(+ `tests/main_split_harness.py`, 변이 드라이버 `tests/main_early_input_mutants.py`).
- 설계의 9개 밖: `report_version_citation_dom_test.py`·`report_version_citation_mutants.py`도 M06 때문에 같은 projection으로 재지정(§5).
- 파일 이름: 설계의 `tests/main_pre_order_dom_test.py` = `tests/main_early_input_dom_test.py`, `tests/main_pre_contract.cjs` =
  `tests/main_split_harness.cjs`(+ `tests/main_split_harness.py`, 변이 드라이버 `tests/main_early_input_mutants.py`).
- CI: PRE DOM·변이·A1·fixture 참조는 measurements job에 넣었고(브라우저 job은 measurement_ci 프로필 1개 규칙), job 시간이 약 56분이라
  timeout을 90→120분으로 올렸다. runtime·dictation-capture job에는 TypeScript 설치 단계를 더했다.

## 7. 미완·한계

- hosted PR CI/G3, Astra 교차 검수 미실행. 설계 acceptance 중 실제 받아쓰기 A→B→A·늦은 dictation, native BFCache, C6 semantic
  diagnostics는 실행하지 않았다.
- 실환경(LiveStack) 2개 미실행. 0 ms는 경쟁(비율만), 150 ms 사례는 틈을 놓치면 skip으로 드러낸다(이번 0).
- module-map/part-spec/B1 비공개 기록의 재결속은 지휘자 업무(설계 §저장소 일관성).
