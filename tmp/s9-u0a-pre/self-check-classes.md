# S9-U0a-PRE phase 2 — 반복 지적 유형 자가점검 (finding-classes.md v1)

대상: P(제품+시험)·C(spec 재결속+시험 보완)·CI 등록 커밋. 근거 경로는 이 디렉터리 기준이다.

| 항목 | 해당 | 확인 방법·증거 |
|---|---|---|
| A1 검사-후-사용 | 해당 없음 | 제품 변경은 선언 이동뿐이며 입력 검증 순서를 바꾸지 않는다(함수 본문 변경 0, `git diff f1d5406 P -- main.html`의 +/-가 같은 줄 원문 — `apply_moves.cjs`가 원문 줄을 그대로 옮김). |
| A2 늦게 도착하는 결과 | 확인 | 등록·호출 지점 불변(등록 trace 원본=PRE, (target,event) 키 509/510개 차이 0, `trace/`). 늦은 응답 관문(work.commit) 코드는 손대지 않았다. dictation A→B→A·늦은 받아쓰기는 이 시험에서 실행하지 않았다(§미완). |
| A3 선행 쓰기 | 해당 없음 | 저장/쓰기 경로 변경 없음. |
| A4 실패 시 상태 | 확인 | 인증 실패→Retry 경로에서 등록 1회·한 change 한 효과를 원본과 같은 흐름으로 비교(`Registration` 4건, M36 kill). |
| A5 감시 중단 | 해당 없음 | 긴 동기 처리 추가 없음. |
| B1 합집합 판정 | 확인 | 각 사례가 자기 오류 0·위험 listener 실패 0·원본 pre/post 중 **한 시점과 전부** 동일(early+final+dialog를 같은 시점으로)일 때만 통과. 변이는 사례별 개별 판정(`mutants.json`, 드라이버는 사례별 FAIL+문구). |
| B2 조용히 건너뜀 | 확인 | 150 ms 사례가 틈을 놓치면 skip("timing")으로 드러내고 통과로 세지 않음(이번 실행 skip 0). 드라이버는 fixture 미해석·변이 미작성·baseline 실패를 실패로 끝낸다. fixture 해석 실패는 예외. |
| B3 추론으로 적격 인정 | 확인 | kill은 FAIL 토큰만이 아니라 그 사례 블록의 HazardFailure/AssertionError 문구에 변이 자신의 binding(`<이름> is not defined`)이나 사용자 결과(칩)를 요구(`tests/main_early_input_mutants.py`, `kill-table.md`). ERROR·import 오류는 kill 아님(37개 모두 errors 0). |
| B4 범위 축약 | 확인 | 37개 변이 전부를 전체 시험 58건으로 각각 실행(`runs/mutant-M00..M37`). 경계는 18/30/45 각각 실제 존재하는 경계로 사례화(위험별 표, phase2.md). |
| B5 전체 vs 부분 | 확인 | A2는 지시 42개(+수동 9개 포함)와 별도 추가 13개(main.html 소비 격리 시험)를 따로 전후 비교. LiveStack 2개는 미실행으로 표시. |
| B6 기록 결속 | 확인 | 모든 실행 record-run(run.json의 argv·입력 hash·exit). P/C SHA와 main.html blob 동일성은 phase2.md에 기록. |
| B7 출력 형식 | 확인 | unittest stream(`Ran N`, `FAIL:`/`ERROR:` 블록), node TAP(`# pass/fail`), 드라이버 JSON을 각 형식대로 판독(`run_mutants.py`, `a2/*`). |
| B8 주장 > 증거 | 확인 | "37/37 kill", "trace 동일"은 원문 실행에 한정. hosted CI/G3·Astra 검수·BFCache·실스택은 미실행으로 명시. |
| B9 공허한 시험 | 확인 | 원본 페이지(M00)에서 분할 46건+창/세션 사건 실패, 각 변이에서 자기 사례 실패를 직접 확인. |
| C1 숨은 고정 전수 조사 | 확인 | main.html 소비 시험 76개 중 A2 42개 외 34개를 확인: e2e/live 21개는 실스택(미실행), 격리 13개는 전후 실행(`a2/before-extra`, `a2/after-extra`). 9개 legacy의 다른 marker 절단·함수 추출은 원본=PRE 동일(`tools/check_other_slices.py`). S7-PINS 바이트 동등 시험은 고정 commit을 읽으며 현재 main.html의 script를 핀하지 않음(A2 전후 동일로 확인). |
| C2 고정은 행동으로 | 확인 | BASE_BLOCK/REPORT_BLOCK 문자열 절단을 TypeScript AST fixture projection으로 바꿈(단언·사례·변이 그대로, A2 건수 동일). 새 시험은 등록/dispatch/화면 결과만 단언. |
| C3 시험을 위해 제품 변경 금지 | 확인 | 제품 변경은 설계 35단위 선언 이동과 이유 주석 6줄뿐. 시험용 marker·더미 선언·anchor 주석 없음. |
| D1 경로 함정 | 해당 적음 | 생성물은 OS temp/scratch에만 씀(`outsideProduct`가 저장소 안 쓰기 거부). junction(api/node_modules)은 끝에 제거. |
| D2 설정 누락 기본값 | 확인 | spec이 페이지를 설명하지 않으면 재유도(deriveSpec), fixture 파일·git 객체가 없으면 실패(조용한 fallback 없음). |
| D3 요청 필드 권위 | 해당 없음 | — |
| E1 범위 | 확인 | 변경 경로: main.html, tests/(지시된 9개 + 내 시험/하니스/드라이버/fixture/spec), .github/workflows/validate.yml, tests/README.md, tmp/s9-u0a-pre/**. |
| E2 worktree | 해당 없음 | 검수 worktree는 지휘자/Astra 몫. A2-before용 임시 worktree는 끝에 제거. |
| E3 addressed | 해당 없음 | 첫 phase 2 제출. |
| E4 근거 결속 | 확인 | 설계 원문 경로·원본 SHA f1d5406·P/C SHA를 문서와 시험 상수에 결속. |
| E5 자가점검 기록 | 확인 | 이 표. |
| F1 범용 엔진 금지 | 확인 | 변이/투영은 설계 표(35단위)를 명시 표로 둔 도구. 범용 판정 엔진 없음. |
| F2 범위 먼저 | 확인 | 설계 밖 이동 0. 표 밖 실패 없음(still_red 0). |
