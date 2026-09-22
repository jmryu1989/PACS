# 살아 있는 불변조건 테스트

REQ-D02-IDENTITY-POSITION → RISK-D02-WRONG-IDENTITY/OCCLUSION/PREFERENCE-LOSS/STALE → TEST-VIEWER-IDENTITY-POSITION: `viewer_identity_position_dom_test.py`는 현재/비교 정보 묶음의 네 모서리 배치·복사, 작은 viewport와 native overlay 겹침, 원본 식별/교체/소유자 경계 및 이전 설정 이행을 격리 DOM에서 검사한다. `reading_appearance_position_live.py`는 v7→v8 계정 왕복, viewer v2 위치의 엄격한 형식, 원자적 거절·구버전 작성자와 소유자 분리를 검사한다. `e2e/test_viewer_identity_position.py`는 실제 영상에서 위치 변경→복사→계정 저장/다른 브라우저 복원과 영상·편집 보존, 기존 로컬 설정·늦은 응답을 검사한다. 두 live 모듈은 각각 선언한 시험만 선택하며 fresh hosted CI가 기존 표시 설정 API 회귀와 함께 실행한다. 로컬 원본 연결 fixture는 실행하지 않는다. 필드별/modality별 배치·발표 모드·물리 모니터는 별도 잔여다.

## 실행 입구와 중단 조건 (2026-09-11)

REQ-DEV-EXECUTION-GATE → RISK-DEV-ACCIDENTAL-LIVE/CONCURRENT-FIXTURES/UNBOUNDED-RETRY → TEST-DEV-EXECUTION-GATE (`execution_guard_test.py`). `LiveStack`을 쓰는 아래 과거 직접 실행 예시는 이제 공용 실행기로 감싼다. 순수 모델 시험에서 실환경 TestCase가 import로 따라온 사고를 막기 위해 일반 `unittest`에서는 LiveStack 생성 자체가 거부된다.

```sh
python scripts/run-tests.py --module tests/volume_recipe_precision_test.py --mode pure --unit recipe-precision-fix
python scripts/run-tests.py --module tests/e2e/test_volume_rendering.py --class VolumeRenderingE2E --mode live --unit vr-display --timeout 1800
python scripts/run-tests.py --plan ../tmp/my-work/tests.json
```

`--module`은 해당 모듈의 `load_tests`를 존중하며 import된 TestCase가 섞인 수집을 거부한다. `--class`를 주면 그 파일에서 선언한 클래스의 직접 선언 시험만 선택한다. 상속 시험을 포함할 때는 JSON의 정확한 메서드로 선택한다. 실행 전 선택 전체를 검증하고 `EXACT_TESTS`로 출력한다. 기존 별도 main 블록의 선택을 추정하지 말고 대응하는 클래스/메서드를 대조한다. CI 측정 8개 suite는 기존 클래스의 직접 선언 시험 목록을 사용한다.

```json
{"unit":"vr-display-regression","mode":"live","tests":[{"file":"tests/e2e/test_volume_rendering.py","case":"VolumeRenderingE2E.test_vr_01_native_rotation_display_reset_and_preservation"}],"max_attempts":3,"timeout_seconds":600}
```

단위는 같은 결함 수정 동안 유지한다. 시도 수는 증거 디렉터리와 별도로 OS 계정의 영구 상태 디렉터리 `<unit>.json`에 누적되고 성공 후 반복·최대 3회 초과·한도 상향을 거부한다. Windows는 OS 계정의 Local AppData 아래 `KIN/PACS/test-gate`, Linux는 계정 홈 아래 `.local/state/kin-pacs/test-gate`이며 TMP/TEMP/TMPDIR/HOME 환경변수로 분리되지 않는다. 시간 초과는 자기 시험 프로세스 트리를 종료하고 실패로 남긴다. `record-run.py`로 이 실행기를 감싸면 기존 원문/exit/전후 해시 기록을 그대로 보존할 수 있다.

실환경 실행은 사용자 계정의 호스트 공용 OS 잠금을 소유하며, 실패/중단하면 `live-needs-inspection.json`을 남긴다. 다음 실행자는 이 파일과 해당 ledger를 읽고 자기 합성 fixture 정리·현행 보존 검사를 완료해 근거를 남긴 뒤, 살아 있는 잠금 소유자가 없는 상태에서 marker만 제거한다. 원본/기존 행은 정리 대상이 아니며 실패 기록과 시도 수는 지우지 않는다. 이 확인은 개발 실행자의 일이며 사용자에게 매번 승인·정리를 맡기지 않는다.

이 장치는 동일 계정의 악의적 코드에 대한 sandbox가 아니다. 직접 SQL/다른 시험 도구·Docker·원본 자격증명 접근과 Codex 앱 전체 호출/토큰 상한은 별도 경계다. 원본과 완전히 분리된 로컬 시험 환경을 구축했다고 해석하지 않는다. 모듈 import 자체도 임의 Python을 실행하므로 순수 모드는 LiveStack 입구 제한이며 OS 네트워크 차단이 아니다.

REQ-D-VOLUME-SYNC → RISK-D-VOLUME-SYNC-TARGET/GEOMETRY/LOSS → TEST-VOLUME-SYNC: `python tests/e2e/test_volume_sync.py`는 현재 정규 CT 3평면의 Windowing/Zoom 동기화, 선택 초기화 제외, 개별 카메라·반전 보존, SIGMOID 픽셀/실제 입력 범위, 부분 실패 복구·재시도, 배치 교체/오래된 이벤트, 모달·소유자·세션 종료와 저장 후 새 로그인 재열람을 검사하고, `test_hanging_protocol.py` hp_08의 Hanging Protocol 2x2(네 번째 칸 비어 있음) 3평면에서 최신 Windowing/Zoom 선택과 MPR Properties로 적용한 설정이 이후 갱신에도 초기화되지 않고 표시된 세 평면에만 동기화되며, 다른 규칙으로 바뀐 뒤 다시 연 배치에는 새로 연결되고 이후 저장값이 적용된 설정임을 native로 검사한다. 동기화 옵션은 현재 배치용이며 Job 필드가 아니다. `python tests/viewer_volume_sync_layout_dom_test.py`는 실제 동기화 패널을 합성 native 객체와 Chromium에서 실행해, 네 번째 칸이 빈 Hanging Protocol 2x2 3평면에서 사용자의 최신 선택과 설정 적용값이 다음 갱신에 초기화되지 않고, 복원 배치는 한 번만 연결되며 빈 칸이 채워지면 세션을 해제하고, 연결 실패가 native 변경을 남기지 않은 채 경로 복구 뒤 연결됨을 확인한다(GPU·픽셀·실제 HP 증거 아님). 전체 MPR/VR·전문 modality·대용량·물리 장치 수용은 별도 잔여다.

REQ-D-WORKSPACE-READING-LAYOUT → RISK-ROAM-MIX/LOST/SIZE/STALE → TEST-READING-PANEL-LAYOUT/TEST-ROAM-API: `tests/reading_panel_layout_test.cjs`, `workspace_layout_test.cjs`, `workspace_roaming_live.py`, `e2e/test_reading_panel_layout.py`는 통합 영상·판독/관련 패널의 키보드·포인터 크기 조절과 숨김·복원, 원래 CT 화소·카메라·동일 iframe·미저장 판독/작업 보존, 작은 창 clamp·계정 분리·로컬 실패·v1 불러오기/v2 계정 복원을 확인한다. API는 구형 v1 쓰기의 v2 설정 삭제와 다른 계정·오래된 revision을 거절한다. `viewer_migration_test.py`의 실제 dump/restore는 v2 표시 설정 전체 행을 대조한다. 물리 다중 모니터/OS 사용 확인은 별도 잔여다.

REQ-D01-FILTER-NAVIGATION → RISK-D01-FILTER-LOSS/WRONG/ACCESS → TEST-D01-FILTER-NAVIGATION: `python tests/e2e/test_saved_filter_navigation.py`는 Save Filter→관리, 저장 검색의 키보드 Edit·정확한 선택·초점 복귀, Saved/Modified/Deleted와 현재 조건 유지, Save & Apply의 검증/실패/중복 차단·성공·재로그인, 폴더/순서/검색 결과 내 이전·다음 이동과 미저장 취소를 검사한다. 실제 검사 목록·개인 판독 초안·확정 판독 이력을 보존하며 기존 관리/분류/건수/복합검색이 직접 회귀다. `KIN_EVIDENCE_DIR`는 해당 실행의 화면 기록 경로다.

REQ-D-WORKSPACE-SHORTCUTS → RISK-D-WORKSPACE-ACCESS/UNSAVED/SHORTCUT-CONFLICT → TEST-WORKSPACE-SHORTCUTS: `workspace_shortcuts_test.cjs`와 `e2e/test_workspace_shortcuts.py`는 통합 목록·영상·판독문 이동 키 편집, 예약/중복 거절, 이전 키 비활성화, 입력/모달 보호, 미저장 내용·영상 보존, 브라우저 저장/충돌/실패/복원·세션 종료를 검사한다. 별도 영상 창 편집 연계·계정 서버 복원은 잔여다.

REQ-D-WORKSPACE-DOCK-AUTOHIDE -> RISK-OCCLUSION/FOCUS/UNSAVED/PREFERENCE-LOSS -> TEST-DOCK-AUTOHIDE: `e2e/test_dock_autohide.py` verifies opt-in timed collapse, native input/pointer/request guards, preserved live panels and keyboard focus re-entry, account restore/legacy preservation and lifecycle. `reading_appearance_live.py` verifies v5/dockv2 strict boolean, atomic rejection and older-writer refusal. Scope is the existing custom tool panels; full OHIF toolbar and physical monitor validation remain pending.

REQ-D-WORKSPACE-NATIVE-FOCUS -> RISK-D-WORKSPACE-ACCESS/UNSAVED -> TEST-NATIVE-TOOLBAR: `e2e/test_native_toolbar.py` checks Ctrl+Alt+9 and explicit button entry to the pinned OHIF toolbar, native Tab/Enter activation and actual image manipulation, unchanged viewport on focus, report return, modal/modifier exclusion, missing target and standalone lifecycle. Full toolbar editing and other modality/device validation remain pending.

REQ-D-WORKSPACE-TOOLBAR-PREF -> RISK-D-WORKSPACE-TOOL/WORK-LOSS/OWNER -> TEST-TOOLBAR-PREF: `e2e/test_toolbar_preferences.py` checks native primary-group order/visibility editing, draft cancel/default/apply, preserved active tools/images/unsaved work, per-owner browser storage, corrupt values/storage refusal, popup restoration and current-window isolation, lifecycle reset and external-section conflict protection. Native button definitions and commands remain unchanged. Account server roaming, nested items and other mode/device inventories remain pending.

REQ-D-WORKSPACE-TOOLBAR-ROAM -> RISK-TOOLBAR-OWNER/LOST-UPDATE/STALE/WORK-LOSS -> TEST-TOOLBAR-ROAM: `reading_appearance_live.py` validates version6 toolbar lists atomically and rejects older writers against newer rows. `e2e/test_toolbar_account.py` checks explicit cross-browser/current-viewer/future-window restore, child ABA and other-window delayed-load rejection, request-time save snapshots, legacy preservation, malformed response and open-draft refusal, storage denial and session end. Hidden retained viewers keep their geometry off screen with input/accessibility exclusion; list-mode load and resume must preserve exact camera/VOI/pixel hashes and unsaved work. No schema, route or authority change; nested toolbar items and full workspace/device completion remain pending.

REQ-D01-COLUMN-FIT -> RISK-PREFERENCE-LOSS/TARGET/READABILITY -> TEST-D01-COLUMN-FIT: `e2e/test_column_fit.py` checks draft content-width fitting from current main/related pages, shared related widths, account restore, selected/report state, empty/long/literal content, small screens and late-load/storage-failure preservation. Existing width schema and permissions are unchanged; all-page automatic sizing and independent related-column layout remain outside this increment. It also verifies saved column typography when global reading preferences are absent, explicit global precedence after edits/reload/default reset, and width fitting without changing that precedence.

REQ-D-WORKSPACE-VIEWER-TITLE -> RISK-STALE-TITLE/WRONG-PATIENT/PREFERENCE-LOSS -> TEST-VIEWER-TITLE: `e2e/test_viewer_title.py` verifies actual active rendered current/prior identity in popup and embedded frame titles, optional account fields, preserved report/job/image state, held-loader animation frames, invalid SOP and session/mode teardown. The title-only QIDO request is removed and its absence asserted. OS taskbar behavior, all modalities and large-data performance remain unverified.

REQ-D-WORKSPACE-VIEWER-IDENTITY → RISK-WRONG-VIEWER-LABEL/PREFERENCE-LOSS/LATE-OWNER → TEST-VIEWER-IDENTITY: `test_viewer_identity.py`는 기준/비교 영상의 크기·글꼴·색·선택 표시 항목을 통합/별도 창과 다른 브라우저의 계정 복원에 연결하고, 실제 원본 식별·환자 ID 필수 표시·미저장 판독/제목·영상 보존을 검사한다. 메타데이터 불일치·세션 종료·늦은 계정 응답/창 알림·저장소 실패를 구분한다. 네이티브 로더를 지연시킨 뒤 애니메이션 프레임에서 표시가 없는지 확인하고, 성공한 영상의 실제 렌더링 후 복원·기존 글자와의 간격·검사 교체·계정 변경 거절을 검사한다. `reading_appearance_live.py`는 표시 설정 v4의 엄격한 값 검사·계정 분리·CAS와 이전 버전의 필드 삭제 거절·v3 업그레이드를 확인한다. 스키마 변경은 없으며 실제 모니터·전체 modality·대용량 성능과 전체 후보는 잔여다.

REQ-D-WORKSPACE-VOLUME-COPY → RISK-MIXED-SOURCE-ID/FUSION-FIRST-ACTOR/STALE-PLANE → TEST-VOLUME-PATIENT-COPY: `test_volume_patient_copy.py`는 실제 Layout→MPR 세 단면에서 단일 볼륨 원본 전체의 환자 ID 일치를 확인해 복사하고, 마지막 원본의 ID/SOP 불일치·미완료/부분 로딩·추가 actor·카메라 왕복·부모 대화상자·세션 종료를 거절하는지 검사한다. 영상 픽셀·VOI·원본 목록과 미저장 판독/제목은 그대로이며, 기본 MPR 선택이 재계산하는 카메라 부동소수점은 1e-9 이내로 대조한다. 기존 스택 메모/판독 복귀 대상은 확장하지 않는다. 전체 MPR 정확도·VR·다른 modality·대용량 성능·의사 후보 확인은 별도 잔여다.

REQ-D-WORKSPACE-EMBEDDED-COPY → RISK-WRONG-IMAGE-COPY/OWNER/STALE-FRAME → TEST-EMBEDDED-PATIENT-COPY: `test_embedded_patient_copy.py`는 통합 영상 창에서 실제 현재/과거 영상의 환자 ID를 우클릭 메뉴·버튼·Ctrl+Alt+C로 복사하고 판독 대상·미저장 판독/제목·영상 상태를 유지하는지 검사한다. 부모 판독 화면의 계정·같은 대상·현재 프레임·표시/대화상자 상태도 함께 확인하며 숨김/inert·입력 중·선택 왕복·SOP 불일치·종료/재진입을 검사한다. 별도 창과 영상 식별·클립보드·메뉴/드래그 로직을 공유하고 `test_viewer_patient_copy.py`, `test_image_context_copy.py`, `test_viewer_tech_note.py`, `test_window_return.py`, `test_reading_note.py`로 직접 회귀한다. API·스키마·저장 경로는 바꾸지 않으며 다른 SOP 종류·전체 modality·물리 OS 검증은 잔여다.

REQ-D-WORKSPACE-IMAGE-CONTEXT → RISK-WRONG-PATIENT-COPY/STALE-SELECTION/MEASUREMENT-MENU → TEST-IMAGE-CONTEXT-COPY: `test_image_context_copy.py`는 별도 영상 창의 빈 영상 영역 우클릭에서 실제 DICOM 환자 ID·검사일을 표시하고 복사하는지 검사한다. 메뉴를 연 뒤 빠른 선택/프레임 왕복은 거절하며 클립보드 실패/재시도·종료/재진입·미저장 판독과 영상 작업 보존을 확인한다. 기존 주석 삭제/라벨 메뉴와 우클릭 드래그 확대를 유지하며, mouseup 전에 발생하는 contextmenu의 드래그 거절은 합성 DOM 이벤트로 검사한다. `test_viewer_patient_copy.py`, `test_viewer_tech_note.py`, `test_window_return.py`가 직접 회귀다. 통합 창의 영상 문맥 메뉴·다른 SOP 종류·전체 modality·다른 OS의 물리 마우스 검증은 잔여다.

REQ-D01-NESTED-PAGES → RISK-FILTER-BROADEN/TARGET/PREFERENCE-LOSS/UNBOUNDED-DOM → TEST-D01-NESTED-PAGES: `node --test tests/compound_filter_test.cjs`는 평면/중첩 AND·OR, 잘못된 분기/빈 그룹·전체 조건20개/항목40개/중첩5단계와 고정 matcher를 검사한다. `python tests/e2e/test_nested_pages.py`는 그룹 작성→계정 저장/기본값/재로그인·취소/실패, 미저장 판독과 1,001건 브라우저 합성 응답에서25/50/100건 표 렌더링·전체 정렬/건수·페이지 경계 검사 이동을 확인한다. 서버 조회 분할·병원 규모 성능은 범위 밖이며 표시 건수는 불러온 목록 기준이다. 관련 회귀는 compound-search/saved-filter-manager/reading-flow와69→14다.

REQ-D01-APPEARANCE → RISK-PREFERENCE-LOSS/READABILITY/TARGET → TEST-D01-APPEARANCE: `python tests/e2e/test_worklist_appearance.py`는 모드별 열 내용 너비(64–600px)·목록 본문 글꼴/12–20px/색 선택의 명시적 적용, 독립 브라우저 계정 불러오기/재열기, 상태 색·판독 입력 보존, 범위 오류/취소/초기화·작은 창을 검사한다. `worklist_columns_test.cjs`와 `worklist_columns_live.py`는 선택적 appearance의 정상/불량 값과 서버 저장 불변을 확인한다. 기존 표시/순서 값은 호환되며 임의 CSS·셀 내용은 저장하지 않는다. 기존 열 설정/계정 저장 E2E가 직접 회귀다. `KIN_EVIDENCE_DIR`로 캡처 위치를 지정한다.

REQ-D01-COLUMNS → RISK-D01-HIDDEN-FILTER/OWNER/PREFERENCE-LOSS → TEST-D01-COLUMNS: `node --test tests/worklist_columns_test.cjs`와 `python tests/e2e/test_worklist_columns.py`는 열 표시/순서·ID/Name 필수 유지, 숨긴 열 조건/정렬과 판독 입력 보존, 판독/촬영별 설정, 같은 브라우저의 계정별 복원/재로그인, 다른 창 충돌·저장 실패·손상 값 복구·취소/키보드/작은 창을 검사한다. 열 설정은 기관+불변 subject별 브라우저 저장소에 표시 항목만 보관한다. 서버 동기화·다른 컴퓨터 복원은 포함하지 않으며 UI에 범위를 표시한다. API/DB/판독·원본 저장 경로는 변경하지 않는다.

## 공통 실행 증거 기록

REQ-D-CINE-RANGE/YOYO → RISK-D-CINE-WRONG-FRAME/STALE/LOSS/UNBOUNDED → TEST-CINE-RANGE/YOYO: `cine_playback_test.cjs`와 `cine_lifecycle_test.cjs`는 선택 구간의 양 끝·왕복·중단, 범위 검증·원본/평면 기하 교체와 기존 비동기 소유권을 검사한다. `e2e/test_cine.py`와 `e2e/test_volume_cine.py`의 각 클래스에 직접 정의된 시험은 기존 `measurements` 프로필에서 함께 실행하며, 실제 multiframe/재구성 평면·화소·세션/선택/숨김/지연 중단·판독/원본 보존을 확인한다. `execution_selection_test.py`는 새 범위/중단 시험의 실제 선택과 상속 시험 제외를 대조한다. 로컬 원본 fixture는 실행하지 않으며 등록 사실은 hosted 실행 성공을 뜻하지 않는다.

REQ-D-WORKSPACE-WINDOWS → RISK-D-WORKSPACE-IDENTITY/UNSAVED/STALE → TEST-VIEWER-WINDOW-MANAGER-DOM: `python tests/viewer_window_manager_dom_test.py` exercises the actual window-manager DOM handler and registry in isolated Chromium with synthetic window/session state and all network requests blocked. It checks pending navigation, changes during close confirmation, existing dirty/busy guards, normal close/focus, and neutral comparison identification. It does not start LiveStack or replace real OHIF/DICOM and physical-monitor verification. The existing measurements CI job runs this suite after installing the pinned browser dependencies and preserves its raw execution record separately.

단위별 기록 스크립트를 새로 만들지 않고 Python 3.9+ 표준 라이브러리 기록기를 재사용한다.
저장소 루트에서 `python scripts/record-run.py --run-dir <새-실행-폴더> --cwd . --file scripts/record-run.py --file tests/record_run_test.py -- python -B tests/record_run_test.py`로 실행한다.
`--file`은 작업 디렉터리 기준으로 반복 지정한다. 새 폴더의 `run.json`에는 명령 인자·cwd·UTC 시작/종료·실제 자식 exit·전후 파일 SHA256·조회 가능한 Git HEAD를, `stdout.log`/`stderr.log`에는 원문 바이트를 남긴다.
기존 실행 폴더는 거절하며 명령 실패 코드를 유지한다. 실행 불가는 자식 exit를 `null`로 기록하고 127, 기록 실패는 125로 종료한다. 원래 명령의 실패를 시험 통과로 해석하지 않는다.
명령 인자와 출력은 가리지 않고 그대로 보존하므로 비밀값·환자 자료를 입력/출력하지 않게 하고, 게시 전 별도로 확인한다. 환경변수 전체 수집·자동 게시·Git 쓰기는 하지 않는다. 이 기록기는 DB/DICOM 보존 검사나 실제 시험을 대신하지 않는다.

## 현재 실행 시점

REQ-D01-READING-PREFERENCES → RISK-PREFERENCE-OWNER/LOST-UPDATE/LATE-APPLY → TEST-D01-READING-PREFERENCES: `tests/reading_preferences_live.py`와 `tests/e2e/test_reading_preferences.py`는 메모 자동 열기의 명시적 계정 저장/불러오기, 기관+subject 분리·CAS·불량 입력, 다른 브라우저의 켜기/끄기, 충돌/실패/늦은 불러오기·세션 종료와 판독문/CT 표시 보존을 확인한다. 로컬 자동 열기는 유지하고 서버 값을 자동 적용하지 않는다. 새 ReadingPreferences 표는 boolean과 revision만 저장하며 기존 작업공간 배치와 분리한다. `viewer_migration_test.py`의 해당 추가/전체 dump 복원과 고정 제품 CI migration/합성 행도 함께 대조한다.

REQ-D-WORKSPACE-TEXT-SIZE → RISK-TEXT-OWNER/WORK-LOSS/INVALID → TEST-READING-APPEARANCE: `python tests/e2e/test_reading_appearance.py`는 목록·현재/과거 판독문의 독립 글자 크기, 이 브라우저 기관+계정별 보존·재접속·초기화, 불량 설정·저장소 거부·세션 종료와 실제 CT/미저장 작업 보존을 확인한다. 글꼴 종류·색 설정은 별도 잔여다.

REQ-D-WORKSPACE-TEXT-ROAM → RISK-TEXT-OWNER/LOST-UPDATE/LATE-APPLY → TEST-TEXT-ROAM-API/BROWSER/MIGRATION: `tests/reading_appearance_live.py`와 `tests/e2e/test_reading_appearance_account.py`는 명시적 계정 저장/다른 브라우저 불러오기, 엄격한 크기 형식·기관/계정 분리·revision 충돌·실패/늦은 응답·현재 세션 재확인과 편집/영상 보존을 확인한다. ReadingAppearance는 표시 숫자만 저장하며 기존 메모/배치와 분리한다. `viewer_migration_test.py`의 해당 추가 시험과 전체 dump 복원, 제품 CI의 migration 목록·실제 합성 행을 함께 갱신한다. 전체 열 260개를 위해 복원 도구의 열 목록만 512개로 제한하고 다른 목록 256개·출력 바이트 한도·완전 대조는 유지한다.

REQ-D01-WORKSPACE-ACTIVE-NOTE → RISK-D01-NOTE-IDENTITY/HISTORY/VIEW-LOSS → TEST-D01-WORKSPACE-ACTIVE-NOTE: `python tests/e2e/test_reading_note.py`는 통합 작업공간의 실제 선택 스택 검사(두 번째 비교 영상 포함) 메모 열기와 판독 대상·미저장 판독문·두 CT의 화소/카메라/밝기 보존을 확인한다. 대상은 imageId/displaySet/URL 범위를 대조하며 불명확한 영상칸은 거절한다. 자동 열기와 별도창 회귀는 `test_reading_note_auto.py`, `test_viewer_tech_note.py`다. 전체 modality는 별도 잔여다.

REQ-D01-NOTE-ASSET-RETRY → RISK-NOTE-RELOAD-LOSS/STALE-CONTEXT → TEST-READING-NOTE-04/TEST-VIEWER-NOTE-CONNECTION: 위 통합창 시험의 메모 파일 실패·반복 재시도·복구는 같은 영상 document, 두 CT 화소/카메라/밝기, 미저장 판독문/작업 제목과 활성 비교 검사 메모를 대조한다. `node --test tests/viewer_note_connection_test.cjs`는 중복 요청, 시간 초과, 모드 종료 뒤 늦은 완료와 재진입의 단일 연결을 확인한다.

Tech 메모의 목록 연결 시험은 같은 `test_tech_note.py`의 06~08이다. 본문 없는 유무/버전 응답, 다른 행의 메모를 열 때 판독 대상·입력 유지, 키보드 열기/복귀, 저장·비움·재로그인 표시와 오래된 목록 응답의 되돌림 거부를 확인한다. `invariants_live.py`는 생성 전 감사 이력 0건을 확인한 임시 계정의 잔존 감사만 전체 행 원문을 stdout에 남긴 뒤 정확히 일치하는 행을 정리한다. 실행 기록기를 통해 원문을 보존한다.

`python tests/e2e/test_tech_note.py`는 REQ-D01-TECH-NOTE → RISK-D01-NOTE-IDENTITY/HISTORY → TEST-D01-TECH-NOTE다. 촬영 기관 방사선사/관리자 작성·판독의 읽기 전용·타 기관 거부/원격 읽기, 충돌/수정 사유/이력 페이지·메모가 있는 검사 삭제 거부, 실제 저장·재열람·실패 입력 보존·세션 종료와 늦은 응답을 확인한다. 판독문과 분리된 소통 기록이며 ER 메모·응급의 역할은 구현하지 않는다. DB 추가/복원 시험은 `viewer_migration_test.ViewerMigration.test_tech_note_additive_and_restrict` 및 기존 `test_03_real_dump_restore_every_row_revision_replay_budget_and_fk`다.

`python tests/e2e/test_reading_context.py`는 REQ-D-WORKSPACE-CONTEXT → RISK-D-WORKSPACE-TARGET → TEST-D-WORKSPACE-CONTEXT다. 실제 CT와 미저장 판독문을 유지하며 정보 패널의 현재/관련 검사 식별, 키보드·닫기 복귀, 좁은 화면 줄바꿈과 검사 전환을 검사한다. ER/Tech 메모 저장·조회와 물리 OS 검증은 이 시험 범위가 아니다.

`python tests/e2e/test_reading_flow.py`는 REQ-D-WORKSPACE-FLOW → RISK-D-WORKSPACE-TARGET → TEST-D-WORKSPACE-FLOW다. 실제 목록 정렬과 이전/다음 검사 일치, 목록/영상/과거 판독/편집문 키보드 왕복, 입력·모달 중 이동 억제, 목록 끝/빈 목록, 미저장 판독·영상 보존과 복귀 후 화소를 검사한다. `KIN_EVIDENCE_DIR`로 이번 화면 기록 위치를 지정한다. 물리 키보드/OS·다중 모니터 전체 수용 검사는 아니다.

`python tests/e2e/test_filter_organization.py`는 TEST-D01-FILTER-ORGANIZE의 개인 저장 검색 경로 계층·설명 찾기·표시 순서·분류 이동과 재로그인 복원, 계정 분리·과거 클라이언트 저장의 메타데이터 유지·잘못된 값 거부를 확인한다. 빈 폴더와 폴더 일괄 관리·기관 공유 폴더는 잔여다. 관련 관리 화면 회귀는 `test_saved_filter_manager.py`이며 `KIN_EVIDENCE_DIR`로 이번 실행의 캡처 위치를 지정한다.

REQ-D01-COMPOUND-SEARCH → RISK-D01-FILTER-BROADEN/WRONG-CONTEXT/PREFERENCE-LOSS → TEST-D01-COMPOUND-SEARCH: `node tests/compound_filter_test.cjs`와 `python tests/e2e/test_compound_search.py`로 문자 정확/부분/부정/미입력, 날짜 범위와 AND/OR, 잘못된 조건 거부, 편집 조건 검색→개인 저장/기본값/재로그인·건수, 판독 대상/미저장 입력 유지, 실패 입력 보존을 확인한다. 복합 조건은 기존 개인 `cols` JSON의 예약 키 `$compound`에 버전 1로 보존한다. 기본 조건 전체 AND (복합 조건 1그룹의 AND 또는 OR)이며 최대 20개다. 부정 비교는 미입력을 포함하지 않는다. 없는/불량 날짜는 날짜 비교에서 제외하고 미입력 연산은 null/undefined/빈 문자열에만 일치한다. 알 수 없는 버전/항목/연산은 조건 없이 전체 목록을 보여주지 않는다. 서버 기관 범위/권한·원검사·판독 저장 경로는 변경하지 않는다. 임의 중첩 그룹·추가 페이지/대량 결과 성능·기관 공유 조건은 잔여다.

`python tests/e2e/test_saved_filter_manager.py`는 개인 저장 검색 관리의 생성·조건/정렬 편집·기본 지정/해제·새 로그인 복원·명시적 적용·삭제와 다른 계정의 목록/변경 거부를 확인한다. 실패 후 입력 보존, 요청 중 닫기/편집 차단, 계정 변경 시 쓰기 거부, Esc 취소/포커스 복귀, 900×600·600×900 접근을 검사한다. 기존 `test_saved_filter_counts.py`는 직접 회귀다. 폴더 분류는 `test_filter_organization.py`, 한 줄 복합 조건은 위 `test_compound_search.py`에서 별도 확인한다. 임의 중첩 조건·대용량 성능은 잔여다.

`python tests/e2e/test_reading_workspace.py`는 TEST-D-WORKSPACE의 실제 CT 비교 영상과 판독문 동시 배치, 판독 대상 유지, 별도 영상 창, 이전/다음 검사와 개인 초안, 미저장 영상 작업의 보존/명시적 폐기, 문서 연결 실패 후 재시도, 세션 종료 정리와 좁은 화면 배치를 검사한다. 판독 작업공간의 첫 통합이며 전체 도구 배치·물리 다중 모니터·의사 사용 확인은 완료 범위가 아니다.

같은 시험은 저장 작업 복원으로 iframe의 비교 검사가 바뀔 때 부모 식별과 별도 창의 일치, 작업 패널 script 실패 후 검사 이동도 확인한다. `python tests/e2e/test_reading_workspace_guard.py`는 초기 자동 복원의 실제 서버 응답을 지연하고 방향키로 영상을 조작하여, 늦은 복원이 사용자의 변경을 덮어쓰지 않는지 검사한다.

`python tests/e2e/test_reading_workspace_dock.py`는 통합 영상 아래의 도구 영역을 펼치고 접으면서 실제 CT 화소와 패널 비겹침, 창 크기 변경, 미저장 제목의 검사 왕복 보호, 실제 비교 작업 저장과 수동 길이 측정/저장을 검사한다. 전체 도구 배치·물리 모니터 수용을 뜻하지 않는다.

REQ-D-WORKSPACE-DOCK-PREF → RISK-DOCK-OWNER/OCCLUSION/UNSAVED → TEST-STANDALONE-DOCK: `test_dock_preferences.py`와 `test_standalone_dock.py`는 도구 영역의 위/아래 위치·열린 패널을 기관+subject별 이 브라우저에서 기억하고 통합/별도 창에서 복원하는지 확인한다. 별도 창은 ‘도구 영역으로 모으기’를 명시적으로 선택하거나 기억한 설정이 있을 때 도구 영역을 연결한다. 열린 다른 창에는 변경을 강제로 적용하지 않는다. 실제 CT 화소/카메라/밝기·미저장 제목/판독 보존, 비겹침, 재열기·초기화·저장 실패·좁은 창·세션 종료와 메모 확장 재진입을 검사한다. 직접 회귀는 별도창 메모·환자 ID 복사·도구 초점 시험과 `viewer_note_connection_test.cjs`다. 계정 저장은 아래 ROAM 시험으로 연결하며 전체 modality·물리 다중 모니터는 잔여다.

REQ-D-WORKSPACE-DOCK-ROAM → RISK-DOCK-OWNER/LOST-UPDATE/LATE-APPLY/WORK-LOSS → TEST-DOCK-ROAM-API/BROWSER/RESTORE: `reading_appearance_live.py`와 `test_dock_account.py`는 기존 ReadingAppearance의 version3에 도구 위치·열린 패널만 추가해 명시적으로 계정 저장/불러오는 동작을 검사한다. 이전 version1/2 불러오기는 도구 설정을 유지하고, 이전 화면의 저장이 새 형식을 지우는 요청은 revision과 저장 버전을 함께 검사해 거절한다. 실제 CT/미저장 작업, 다른 브라우저 복원·열린 다른 창 유지, 늦은 GET과 도구 빠른 왕복·PUT 당시 설정, 잘못된 응답·저장소 거부·세션 종료를 확인한다. 스키마 변경 없이 갱신한 합성 JSON의 전체 dump/restore는 `ViewerMigration.test_03_real_dump_restore_every_row_revision_replay_budget_and_fk`로 대조한다. 기존 글자 계정·브라우저/별도 창 도구 시험은 직접 회귀이며 전체 개인화·물리 모니터 완료를 뜻하지 않는다.

`python tests/e2e/test_reading_window_reuse.py`는 별도 named 영상 창을 같은 검사에서 재로딩하지 않고 재사용하는지, 다른 검사로 바꿀 때 실제 미저장 작업 제목과 주입한 busy 상태를 자식 guard로 차단하는지 검사한다. 별도 최상위 창의 깨끗한 상태/미저장 상태에 합성 `beforeunload` 이벤트를 보내 비교 작업 입력의 이탈 guard도 확인한다. 닫힌 새 창에 이 브라우저가 저장한 좌표·크기를 적용하는 경로는 모의 window로 확인한다. 실제 미저장 표식·진행 중 저장/복원 race, 물리 다중 모니터 배치를 검증한 것은 아니다.

REQ-D-WORKSPACE-WINDOW-RETURN → RISK-WRONG-REPORT-FOCUS/WORK-LOSS/STALE-WINDOW → TEST-WINDOW-RETURN: `test_window_return.py`는 별도 영상 창의 Ctrl+Alt+4/판독문 복귀 버튼, 같은 창의 재연결·무재로딩, 실제 CT/미저장 판독·제목과 `opener=null` 보존을 검사한다. 임시 창 연결은 캡처한 계정·검사 범위·현재 판독 대상을 대조하며, 모달·대상 변경·응답 지연·빠른 영상 왕복·세션 종료를 거절한다. 부모 문서의 실제 초점을 확인한 응답만 복귀로 표시하고, 브라우저가 창 전환을 막으면 판독문 위치 준비와 목록 창 직접 선택을 안내한다. 물리 OS·다중 모니터 초점 수용 검사가 아니며 검사 선택/저장은 수행하지 않는다. 창 재사용·별도 메모/도구·통합 초점 시험이 직접 회귀다.

`python tests/e2e/test_saved_filter_counts.py`는 저장한 개인 검사 필터가 현재 검색을 바꾸지 않은 채 최신 목록 기준 건수를 표시하고, 새 검사가 들어온 뒤 Refresh에서 건수를 갱신하며, 명시적으로 눌렀을 때만 Quick Search와 컬럼 조건을 적용하는지 검사한다. 따옴표·HTML 문자가 있는 이름의 속성 안전 표시, 접근 가능한 건수 이름, 같은 건수 재렌더링의 키보드 포커스, 기본 필터 지정 요청/안내도 확인한다. 저장 검색의 폴더 트리·설명/순서·전체 고급 조건을 완료한 시험은 아니다.

`python tests/e2e/test_live_print.py`는 TEST-D09-LIVE-PRINT의 저장 없는 현재 CT 비교 출력을 검사한다. 읽기 전용 preview의 엄격한 입력·기관/P·같은 환자·no-store·무저장, native 두 검사 화소와 실제 PDF2페이지, 현재 표시/digest 응답 변경·늦은 닫기, 빈 셀·미저장 주석·출력 조절 복귀·세션 종료를 확인한다. 원본 변경의 새 기능 시험은 digest 응답 주입이며 실제 DICOM 교체는 기존 저장 출력 회귀에서 구분한다. 주석 미포함·현재 설정으로 원본 재조회이며 전체 화면 캡처/다른 modality/물리 출력의 완료 증거가 아니다.

`python tests/e2e/test_key_preview_controls.py`는 TEST-D09-KEY-PREVIEW의 출력 키 이미지 전체/선택 확대·이동·복귀, 독립 역좌표 RGB 비교, CT W/L·편집문·두 열 PDF, 선택/재선택·입력 오류·초기화·실패/지연과 조절 후 원본 digest 변경 응답의 인쇄 차단을 검사한다. 최근접 화소의 고정 출력 범위이며 주석/현재 화면 직접 캡처·전체 modality/서식/물리 크기 검증은 아니다.

`python tests/e2e/test_preview_controls.py`는 TEST-D09-PREVIEW-CONTROLS의 저장 비교 출력 전체/선택 셀 확대·이동·W/L·초기화, native 화소/주석 좌표·PDF, 잘못된 입력·실패/지연·현재 화면과 저장 이력 보존을 검사한다.

`python tests/e2e/test_viewer_job_report.py`는 TEST-D09-JOB-REPORT의 현재 검사 저장 판독문+비교 영상/주석 PDF, prior/타인 초안 제외, 출력 전 판독 변경 거절, 누락/조회 실패, 구성 중 변경/닫기와 읽기 전용 보존을 검사한다.

`python tests/e2e/test_compare_reports.py`는 TEST-D09-COMPARE-REPORTS의 명시적 현재/과거/두 검사 저장 판독문 선택을 검사한다. 저장 CT v3 비교·주석·각 검사 식별/버전의 PDF와 원본 화소, 과거 판독 변경 및 실제 P 접근 거절, 누락/잘못된 응답·늦은 선택 전환, 현재 CT 출력·단일 검사 재열기와 자료 보존을 확인한다. 미확정 편집문·전체 출력 서식·물리 매체는 별도 잔여다.

REQ-D09-OUTPUT-IDENTITY → RISK-D09-REPORT-MISATTRIBUTION → TEST-D09-OUTPUT-IDENTITY: `node --test tests/viewer_job_print_identity_test.cjs`의 순수 27건은 현재/비교 검사 명칭, 실제 달력 날짜와 선후 관계, 판독문 선택 항목, 환자·검사 식별행, 보고서별 named page와 margin-box CSS, 미확정 편집문 구분, 추가기재 라벨과 출력 원본 읽기의 전송 복구를 검사한다(이전 「14건」은 첫 묶음 기준이라 낡은 수였다). `python tests/viewer_job_print_pages_test.py`의 격리 Chromium 16건은 현재보다 이후·이전·같은 날짜와 미상 날짜, 긴 식별정보의 하단 여백, 단일 검사, named-page 미지원 거절, 미확정 편집문 출력·거절, 추가기재 표기와 잘못된 `action` 거절, preview 무쓰기, 그리고 **S3-U5의 인용 줄이 그 검사 자신의 페이지 바닥글과 같은 페이지에 찍히는 것**을 실제 PDF 페이지에서 확인하며, 같은 파일의 순수 2건이 PDF 추출 순서 규칙을 고정한다. 이 하네스의 세 api 스텁은 모두 전용 인용 읽기에 답한다 — 모르는 경로는 `.status` 없는 오류가 되어 「확인하지 못했습니다」로 분류되므로, 답하지 않으면 기존 fixture가 조용히 그 문구를 얻는다. **S3-U5 erratum(계약 7-3/8-7, Astra option A):** 편집문 지면이 공용 고지를 실으면서 그 문장이 「서버 저장본 출력에서 확인하세요」로 끝나므로, `test_pages_07`의 「'저장본' 부재」 두 단언은 **같은 성질을 더 강하게** 세는 형태로 바뀌었다 — 지면 전체에서 '저장본'은 정확히 1회이고 그 1회는 인용 절의 것이며(초안 PDF 페이지당 1회 이하, 있으면 고지의 것), 저장본 라벨이 들어오면 2회가 되어 여전히 실패한다. RS·판 스탬프 부재는 무조건으로 남는다. 공용 문면·U4·제품은 바뀌지 않았다. validate의 runtime과 measurements job은 각각 `record-run.py`로 원문과 소스 해시를 남기고 합성 artifact만 게시한다. 실제 프린터의 물리 여백·색·DPI 수용은 별도다.

REQ-S3-U1-ADDENDUM-OUTPUT → RISK-S3-ADDENDUM-MISLABEL → TEST-S3-U1-ADDENDUM-OUTPUT: `node --test tests/report_preview_label_test.cjs`의 순수 5건과 `viewer_job_print_identity_test.cjs`에 더한 3건은 머리 판 행의 `action`이 `addendum`이면 미리보기 머리글과 페이지마다 반복되는 식별 줄이 「추가기재」와 **그 판 자신의 번호**를 말하는지, 다른 action과 판 없음·미확정 편집문의 문자열이 바이트 그대로인지 확인한다. `ReportVersion`에는 부모 판 칸이 없고 `discarded` 행이 더 낮은 번호를 가질 수 있어 계보 번호는 출력하지 않는다. 두 출력 표면이 같은 행을 다르게 부르지 않는지는 `viewer_job_print_identity_test.cjs`의 교차 확인 1건이 검사하고, 두 시험의 action 행렬에는 `'Addendum'`·`'addendum '`·`['addendum']`·`true`·`{}` 같은 근접 값이 들어 있어 정확히 `'addendum'`일 때만 문면이 바뀐다. 두 순수 파일은 validate의 runtime job `job-print-identity` 단계에서 같은 컨테이너(`--network none`, 읽기 전용 마운트)로 함께 실행되며 `report-preview.js`도 그 record-run 입력에 들어간다 — 선언과 실제 CI 성공은 구분한다. 렌더된 출력의 추가기재 문면과 잘못된 `action` 거절은 `viewer_job_print_pages_test.py`의 `test_pages_14`·`test_pages_15`가 격리 Chromium에서 확인하며, **이 두 건의 첫 실행은 호스티드 CI다.** 실제 API를 거친 `action` 전달과 실스택 추가기재 확정 후 PDF 확인은 여전히 호스티드 잔여다.

REQ-S3-U3-STALE-ADDENDUM → RISK-S3-APPROVED-OVERWRITE/DRAFT-LOSS → TEST-S3-U3-STALE-ADDENDUM: `node --test tests/report_rebase_model_test.cjs`의 순수 6건은 main.html에서 그대로 떼어낸 기준 판 기록기·실패 분기·거절 본문 해석기를 검사한다 — 다시 그리지 않은 판 번호는 기준이 되지 못하고, `REPORT_DRAFT_STALE`은 `저장했습니다` 부분 문자열 분기보다 **먼저** 갈리며, 모양이 아닌 본문은 승인본으로 표시되지 않는다(호출부 4곳의 배선도 같은 파일에서 고정한다). `tests/report_stale_draft_test.cjs`의 8건은 빌드된 이미지(`kin-api:ci`, `/app/dist`)에서 `commitReport`의 추가기재 관문이 잠근 `Report` 행 그대로를 409에 싣고 아무 행도 쓰지 않는지, 역할·기관·예비 판독 거절이 먼저 답하고 승인본을 흘리지 않는지, 초안 없는 확정과 다른 action은 그대로인지, `putReport`가 아직 없는 판을 기준으로 거절하고 기준이 올라가는 PUT만 `report.draft.rebase`로 남기며 `Report`를 잠그지 않는지 확인한다. `python tests/report_rebase_dom_test.py`의 격리 Chromium 11건은 실제 `api()`·`loadReport()`·`stashReport()`·`commitReport()`와 실제 모달 표시로, 폴링·PATCH가 올린 판 번호가 확정 기준이 되지 못하고, 거절 뒤 textarea·초안 바이트가 그대로이며 `저장했습니다` 경로로 가지 않고, 화면에 보인 그 판 번호로만 재기준 PUT이 나가고, 검사를 옮기거나(A→B, A→B→A) 더 새 거절이 온 창은 아무것도 그리지 않으며, 초안이 살아남은 낙관적 락 복구는 "서버 판독문을 불러왔다"고 말하지 않는 것을 확인한다. 이 파일은 생성한 하네스를 먼저 컴파일해 보는 것이 전제다 — 추출이 `async`를 떨어뜨리면 스크립트가 통째로 컴파일되지 않아 모든 사례가 단언 이전에 죽는다(호스티드 run 35481281228에서 실제로 그랬다). 그래서 추출이 수식어를 유지하고, 시작 실패는 `pageerror`와 `typeof loadReport`로 그 자리에서 크게 보고한다. 계약 ㉑(실스택에서 두 사람이 겹쳐 승인·추가기재)은 `tests/e2e/test_worklist.py`의 `test_12_stale_draft_addendum_rebase_keeps_both_versions`가 맡는다 — 실제 409 직렬화 → `api()` → 안내 창 → 실제 재기준 PUT → 관문·낙관적 락 통과 → `/report/versions`를 한 번에 지나가며, 안내 창의 승인본 문자열이 그 409 본문의 `head.findings`와 **같은 바이트**인지, 거절 뒤 textarea와 초안 행이 그대로인지, 재기준 PUT이 화면에 보인 판 번호(v2)와 친 글자 그대로인지, 감사에 `report.draft.rebase`가 `{from:1,to:2}`로 한 번만 남는지, 마지막 이력이 approve·addendum·addendum이고 두 본문이 모두 살아 있는지 확인한다. 기존 `hanging-protocols` job의 `ci-hp-worklist`(240초 그대로)와 `candidate_ci`에서 함께 돌며, 이에 따라 선언 건수 핀이 14 → 15(누적 선택 90 → 91)로 옮겨졌다. **호스티드 Validate 35481281228(a07f207)에서 컴파일 API 8건·순수 6건·`test_worklist` 15건(㉑ 포함, 85.9초)이 실제로 통과했다. 격리 Chromium 11건은 아직 단언에 도달한 적이 없다** — 그 실행은 위 하네스 시작 결함으로 10건 전부 시작 단계에서 죽었고, 이 정정이 그 결함을 고쳤다. 브라우저 단언의 첫 실행은 여전히 다음 호스티드 CI다.

REQ-S3-U2a-CITATION-BACKEND → RISK-S3-CITATION-LEAK/FALSE-PRESENCE/CARRY-FORWARD-WRONG-HEAD/CHECK-AS-500/ATTESTATION-LOSS → TEST-S3-U2a-CITATION-BACKEND: 판독문 인용은 `ReportDraft`·`ReportVersion`의 추가 전용 JSONB 칸 둘뿐이고 `Report` 거울도 연결 표도 만들지 않는다. **호스트 순수 32건**: `python tests/report_citation_vectors_test.py` 10건이 공용 벡터 파일(`tests/report_citation_vectors.json` — occurrence 24·blank 8·sameText 7·state 7·equivalence 6·assembly 8 = 60벡터)을 계약 규칙의 독립 구현과 대조하고, `python tests/report_citation_migration_test.py` 22건이 추가 전용 DDL·**NULL 허용을 말로 적은 CHECK**·canonical `jsonb::text` UTF-8 바이트 한도·서비스가 409로 옮기는 제약 **이름** 일치·`versions()`의 명시 select와 `toClient` 무변경·전용 읽기가 행마다 따로 묻는다는 것·확정이 지울 초안 행을 먼저 잠근다는 것·재시도 다리까지 같은 매핑 안에 있다는 것·`n`과 `k`가 같은 등식을 쓴다는 것·**런타임 하네스가 자기 실패를 잃지 않는다는 것**·마이그레이션 부기를 고정한다. **컴파일 API 28건**(`node --test tests/report_citation_test.cjs`, 빌드된 이미지 필요)은 위조 차단·유지 목록 교집합과 키 부재=무변경·머리 판이 `ReportVersion(uid, Report.version)`이라는 것·이월 건의 작성자·시각 바이트 보존·`removeCitationIds`로만 빠지는 머리 건·reset과 빈 확정의 `[]`·강제 해제의 작성자별 보존과 NULL 생략·삽입 시점 예방 한도와 유지 목록 복구·머리40+초안30의 `REPORT_CITATION_LIMIT` 409·머리40+초안30 **읽기**가 행마다 64 한도 안에서 답한다는 것·**세는 일이 저장된 바이트를 고치지 않는다는 것**(전용 읽기까지 통과)·감사에 `findingId`·`sourceIndex`·문구가 없다는 것·전용 읽기의 소견 가독 재적용과 `source-unavailable` 축약을 확인한다. **호스티드 관문**: 위 28건, `viewer_migration_test.py`의 `test_report_citations_additive_nullable_bounded_and_named`(실제 PostgreSQL DDL·NULL·한도·제약 이름·dump/restore 카탈로그 동일성 — **애플리케이션 번역은 증명하지 않는다**)와 `test_report_citations_runtime_check_translation_and_draft_lock`(**실제 컴파일 `PacsService` + 실제 `PrismaClient`**로 세 경로의 진짜 CHECK 위반이 명명된 409가 되는지, 우리 것이 아닌 실제 CHECK는 그대로 남는지, 그리고 **다른 탭의 삽입이 서명된 판에 들어가는지** — 잠금 증명은 시간이나 거절이 아니라 **서명된 `cid` 집합**으로 가른다: 잠그고 읽으면 두 건, 잠그지 않고 읽으면 한 건이 서명에서 사라진다), 그리고 `finding_api_test.py` 13(계약 ⑭·⑮ 서버 절반·⑰·⑱·⑲·⑳·㉒). **실제로 관측된 것**(호스티드 run 35498319011, 후보 902c7e0): `DRIVER class=PrismaClientUnknownRequestError code=undefined names_constraint=true`와 PUT·COMMIT의 실제 CHECK → `REPORT_CITATION_LIMIT` 번역은 **실행되어 통과했다.** 강제 해제·음성 대조·잠금은 그 실행에서 **증명되지 않았고**(스크립트 출력이 `docker run failed (exit 1)`에 묻혔다) 이번 정정이 그 두 결함을 고쳤다. 화면(S3-U2b)은 이 묶음에 없다: 벡터의 `assembly` 절(R5 문면)과 존재 상태 표시·클라이언트 상태는 U2b가 소비하며 지금은 어떤 제품 코드도 읽지 않는다. 계약 ⑩·⑫·⑬의 화면 절반·⑯은 U2b, ㉑은 U3에서 닫혔다. ⑱의 감사 절은 D6대로 **이 단위가 쓰는 `report.*` 줄**에 건다 — `/audit`에 계보 관문이 없어 S2의 `finding.*` 줄이 `findingId`를 보이는 것은 **미해결 S2 잔여(O-1)**로 남긴다.

REQ-S3-U2b-CITATION-UI → RISK-S3-FALSE-PRESENCE/SILENT-ATTESTATION-LOSS/INVENTED-KEEP-LIST/LOST-TYPED-WORK/CROSS-STUDY-WRITE → TEST-S3-U2b-CITATION-UI: 화면 쪽 인용은 새 순수 모듈 `worklist-v0/hpacs-lite/report-citation.js` 하나와 `main.html`의 미리보기 대화·인용 줄·uid별 상태로 이뤄지고, 소견 패널(`reading-findings.js`)은 출처마다 `Insert into Report`를 붙여 조립된 블록을 건네기만 한다(판독문을 직접 쓰지 않는다). 순서는 **서버 먼저**다 — 확인은 세 칸 + 삽입될 문장이 이미 붙은 값과 `insert{7칸}`을 실은 PUT을 보내고, **200을 받은 뒤에만** 기존 상용구 기전(`el.value += …; input 이벤트`)으로 textarea가 바뀐다. **호스트에서 실제로 실행한 순수 29건**(`node --test tests/report_citation_client_test.cjs`)은 실제 모듈을 실행해 공용 벡터 60건 전부(occurrence 24·blank 8·sameText 7·state 7·equivalence 6·assembly 8)를 서버 검사기와 **같은 답**으로 통과시키고(계약 ⑬), 축약된 건이 본문 대조를 주장하지 않으며(⑥), R5 서식이 제목·본문·특성 순서·`특성: ` 접두사·줄 끝만 LF 정규화·길이 0 칸 생략·LF 하나로 잇기·공백만/4096바이트 초과 거절을 지키고 미리보기=요청=붙은 블록=증언이 같은 바이트임을(⑩), 확인 전 상태에서는 `citationIds` **키 자체가 없고**(`[]`가 아니다, ⑫·B2) 유지 목록이 `absent`·`ambiguous`·축약 건을 **조용히 빼지 않으며** 머리 건은 아직 머리에 있는 명시적 선택으로만 빠지는 것을 확인한다. 같은 파일이 제품 배선을 고정한다 — B1의 `settleStash`가 그 검사의 **모든** 나가 있는 저장을 기다린다는 것과 삽입 PUT과의 순서, 비-keepalive 저장이 **쓰기만** 비켜서고 화면 글자는 담아 둔다는 것, B3의 `reportNeedsWrite()`가 stash·타이머·beforeunload 세 곳에 걸린 것, 거절·늦은 응답·확인 전 200 뒤에 `invalidateCitations`가 초안 쪽만 모르는 상태로 되돌린다는 것(`forget()`은 머리 제거 선택을 지우므로 쓰지 않는다), §6의 낡은 초안 거절이 표시줄과 **같은 식 하나**를 쓴다는 것, 확정의 `citationIds`/`removeCitationIds` 분리, **받아들여진 삽입만이 그것을 건넨 목록 패널을 물러나게 한다는 것**(거절·늦은 응답·중복 경고에는 그 호출이 없고, 물러나는 길은 `reading-findings.js`의 닫기 경로라 `aria-expanded`가 함께 바뀌며, 콜백은 함수라 요청 본문 일곱 칸에는 닿지 못한다), 제어 바이트가 제품·시험 어디에도 없다는 것, 그리고 **DOM 하네스가 잘라 쓰는 제품 구간이 실제로 컴파일된다는 것**(U3에서 단언 이전에 전부 죽은 그 결함의 재발 방지). **호스티드 격리 Chromium 26건**(`python tests/report_citation_dom_test.py`, validate의 workspace-ui job)은 실제 `api()`·`loadReport()`·`stashReport()`·`commitReport()`·**실제 `select()`**(하네스는 그 이름의 `window` 도우미를 두지 않는다 — 최상위 함수 선언은 전역 객체의 쓰기 가능한 속성이라 같은 이름의 래퍼는 자기 자신을 부른다)·**실제 상태 병합**(`mergePolledState` — 서버 투영이 한 검사의 화면 상태를 대신하는 자리는 `fromApi`가 지나는 그 함수 하나뿐이라, 30초 폴링만이 아니라 **Refresh 단추**가 부르는 `load()`와 한 검사짜리 PATCH 응답도 같은 규칙을 지난다)·**실제 로그아웃 처리기**·실제 모달·실제 `beforeunload`와 **실제 20초 자동 저장 콜백**(하네스는 콜백이 아니라 스케줄러만 잡고 그 선언 지연 20000을 단언한다)으로 계약 ⑮(거절 뒤 textarea와 초안 행이 바이트 동일)과 ⑯(늦은 200이 검사 이동·A→B→A에서 화면에 쓰이지 않고 수렴 표시가 남는다), B1(나가 있는 **모든** 저장이 끝난 뒤에 삽입이 떠나고, 그 동안의 검사 이동은 쓰기만 미루고 타건은 담아 두어 돌아왔을 때 그대로 보인다), B2(확인 전 200은 키를 만들지 않고 전용 읽기 한 번이 그것을 바꾼다), B3(바쁜 동안 실제 키 입력·바깥 클릭이 닫지 못하고, stash 뒤 dirty가 clean이어도 명시 표시가 타이머와 beforeunload에서 다음 저장을 일으킨다), §6의 낡은 초안 거절, R5(정확한 바이트·명시적 대상·대상 변경 시 새 확인)와 머리 제거가 확정에서만 나간다는 것을 실행한다. 늦은 200 뒤에는 **유지 목록이 아예 나가지 않는다**는 것도 여기서 확인한다 — 새 `cid`가 빠진 목록은 방금 기록됐을 수 있는 증언만 지우고 문장은 남기기 때문이다. 삽입이 나가 있는 동안의 검사 이동이 담아 둔 타건은 **고르지 않은 검사의 서버 투영**도 덮지 못한다는 것(수렴 표시가 있는 동안만, 끝나면 평소대로 서버 투영을 받는다), 그리고 로그아웃이 그 동안 비켜선다는 것도 실제 처리기로 확인한다. `fromApi`가 그 규칙을 지난다는 것은 호스트 순수 시험이 **실제 그 줄을 실행해** 확인하고(옛 줄을 넣은 음성 대조가 타건을 잃는 것까지), 같은 시험이 이 화면 전체에서 서버 투영을 그대로 덮어쓰는 자리가 더 없다는 것을 고정한다 — 유일한 예외는 이 화면이 방금 누른 확정의 자기 응답이다. **이 25건의 첫 실행은 호스티드 run 35512072149이었고 통과하지 못했다** — 18건이 시작해 10건 ok·1건 FAIL·6건 ERROR, 그리고 3분 단계 상한에 걸려 나머지 7건은 시작조차 못 했다. 원인은 제품이 아니라 **이 하네스의 인용 읽기 응답 큐**였다: 큐에 넣는 값은 `{version, head, draft}` 본문인데 stub이 `{status, body}` 봉투로 읽어 `status`가 `undefined`가 되는 바람에 **모든 전용 읽기가 실패**했고, 확인된 상태를 전제로 한 사례들이 한꺼번에 무너졌다(단계 상한은 미충족 대기 6건 × 30초의 결과이지 별개의 원인이 아니다). 지금은 stub이 큐 값을 200 본문으로 읽고, 아무것도 안 넣으면 읽기 실패라는 기존 규칙은 그대로다. `open()`은 기본 대기 상한을 10초로 두어(정상 대기 중 가장 긴 것이 400ms 디바운스다) 실패한 묶음이 3분 예산을 다 쓰고 요약과 트레이스백까지 함께 잃는 일을 막는다 — 예산 자체는 그대로다. **그 정정 뒤 호스티드 run 35513967432에서 이 25건은 전부 통과했다**(4.315초, 후보 a7686c3). 같은 실행의 실스택 `FindingWorklistE2E`는 06에서 멈췄다 — `#b-cite-list`(Show Citations)는 보이고 눌릴 수 있는 상태였는데 `#reading-related-region` 안의 문단이 포인터를 가로채 20초 뒤 실패했다(6건 중 1건 error, plan exit 125). 원인은 인용 상태가 아니라 **배치**다: Image Findings는 `position: fixed; right:12px; bottom:12px; width:min(420px,100vw-24px); max-height:min(62vh,640px); z-index:80`인 고정 패널이라 목록·판독문·영상의 배치를 바꾸지 않는 대신 **판독문 칸 위를 덮는다**. 판독문 패널은 두 배치 모두에서 화면 오른쪽 끝 칸이고 인용 줄의 단추는 `.draftbar .spacer`가 오른쪽 끝으로 미므로, 그 패널이 열려 있는 동안 인용 줄의 단추는 언제나 그 아래에 있다. 이번 정정은 **서버가 받아들인 삽입에서만** 그 패널이 스스로 물러나게 한다(거절·중복 경고·늦은 응답은 그대로 둔다) — 방금 들어간 문장과 그것을 세는 인용 줄이 사람이 바로 다음에 읽어야 할 것이기 때문이다. 초점은 글이 들어간 칸으로 가고(숨겨질 단추로 가지 않는다), 물러나는 길은 패널 자신의 닫기 경로라 토글의 `aria-expanded`가 화면과 어긋나지 않는다. **26번째 사례와 이 제품 변경은 아직 브라우저에서 실행된 적이 없고, 실행되지 않은 시험은 어떤 결함의 kill도 아니다.** 패널이 열려 있는 동안 판독문의 다른 단추들이 어디까지 덮이는지는 S2-B가 정한 그 패널의 배치이며 이 단위에서 바꾸지 않았다 — `test_worklist_06`은 서명 전에 패널 자신의 Close로 목록을 닫는다. 다만 하네스가 제품 `select()`에 실제로 닿는지는 호스트 순수 스모크가 실행해 확인한다(같은 이름의 래퍼를 넣은 음성 대조가 `RangeError`로 죽는 것까지 함께). **정직하게 남기는 잔여**: ① 삽입이 날아가 있는 동안 탭이 닫히면 keepalive 저장은 응답을 기다릴 수 없어 본문 T0가 나갈 수 있다 — 확인된 상태면 유지 목록이 그 인용도 함께 지우고, 확인 전이면 인용이 남아 `absent`로 보인다(어느 쪽도 글을 잃지 않는다). **로그아웃은 이 등급이 아니다** — 그 경로의 초안 저장은 비-keepalive라 미뤄지고 `KinAuth.logout()`이 세션을 먼저 없애므로 이탈 시점의 keepalive는 이미 로그아웃된 세션으로 나간다. 그래서 로그아웃은 삽입이 나가 있는 동안 **비켜서고**(확정과 같은 규칙) 사람에게 다시 누르라고 말한다. ② 200을 잃고 재시도해 생긴 중복은 전용 읽기 뒤의 유지 목록에서만 사라지며 그때까지 `ambiguous`로 정직하게 보인다. ③ 머리 건의 제거 의사는 다시 불러오면 남지 않고 이월로 되돌아간다(한 세션 안에서 다시 읽어도 **아직 머리에 있는** 건의 선택은 유지한다). ④ 확인했으나 화면에서 보지 못한 문장이 기록에 남을 수 있다(현행 상용구 삽입보다 넓은 노출). ⑤ 삽입 시각의 `insertedBy`는 응답에 실려 오지 않으므로 화면이 추측하지 않고 "방금 이 화면에서 넣음"이라 쓰고, 다음 전용 읽기가 서버 바이트로 바꾼다. **실스택 관문**: `tests/e2e/test_finding_worklist.py`의 `test_worklist_06`이 실제 패널 행 → `Insert into Report` → 미리보기 바이트 → 서버 줄 블록 검사기 → 200과 전용 읽기(초안 1건·`sameTextCount` 1·`sourceRef`에 수치·계산기·식별자 없음) → 패널이 스스로 물러난 뒤(숨김·`aria-expanded=false`·초점은 글이 들어간 칸) **아무것도 가리지 않는 실제 클릭**으로 연 인용 목록의 `present` 표시 → 목록을 다시 열어 그 패널이 아직 r1을 들고 있음을 확인하고 → 소견을 API로 r2로 올린 뒤 **같은 출처 재삽입의 경고 한 번(요청 0건)** → 다시 눌러 확인한 요청의 409 `REPORT_CITATION_STALE`(화면 글자·소유 행·인용 전부 바이트 동일) → Save 뒤 머리 판이 그 증언을 작성자·시각 바이트 그대로 이어받는지까지를 한 번에 지나간다. 그 바이트 비교에서 `ReportDraft.updatedAt` **한 칸만** 제외한다 — 409가 계약 §4-5 ⑥대로 수렴 표시를 올리므로 그 뒤 20초 자동 저장이 **내용은 그대로 둔 채** 그 칸을 다시 쓸 수 있고, 본문·`baseVersion`·인용과 나머지 여섯 표는 전부 그대로 비교한다. 이 한 건이 화면 절반의 필수 관문이며, 늦은 응답·순서 경합은 실스택이 답을 붙잡아 둘 수 없으므로 위 DOM 하네스가 그 절반의 호스티드 증거다. 소견 패널 쪽 절반은 기존 `finding_command_test.cjs`(빌드된 이미지 없이 도는 순수 실행)에 **2건**을 더해 고정한다 — 출처마다 생긴 `Insert into Report`가 조립된 R5 블록과 `(소견, 판, 출처 번호, 인용 당시 연결 상태·머리 판)`을 워크리스트에 넘기고 **자기는 아무것도 쓰지 않으며**, 숨김·소실 출처, 숨긴 소견, 그 사이 사라진 행, `cite` 입구가 없는 옛 워크리스트는 각각 명시된 문자열로 거절하고 `revised`는 확인 후 넘어간다. 서버 절반은 U2a의 `finding_api_test.py` 13이, 화면까지 포함한 실스택 통합은 위 `test_worklist_06`이 맡는다. 두 시험 모두 이 후보에서는 아직 실행되지 않았다.

REQ-S3-U4-CITATION-OUTPUT → RISK-S3-U4-PAPER-IDENTIFIER-LEAK/FALSE-EMPTY/STALE-ANSWER-PRINTED/UNMAPPABLE-CLAIM → TEST-S3-U4-PREVIEW-CITATION: `#b-print` 미리보기 지면에만 인용 증적을 싣는다. 서버·스키마·엔드포인트 변경이 없고(`api/**` diff 0), 자료는 U2a가 만든 전용 읽기 `GET /studies/:uid/report/citations` 하나에서 온다 — 미리보기 관문은 기관 단위라 소견 가독을 다시 거는 그 표면을 거치지 않으면 계보 밖 출처가 지면에 샌다. 지면에 나가는 것은 칸·소견 판·출처 순번·인용 당시 연결 상태(한글 고정 다섯 값 + 미지 값은 원문을 옮기지 않는 중립 문구)·작성자·UTC 시각·존재 상태뿐이고, `insertedText`·`cid`·`findingId`·`sourceRef`·`headRevisionAtInsert`는 **어느 것도 싣지 않는다**(D5) — 그 대가로 줄이 문장과 1:1로 대응하지 않는다는 것을 지면 자신이 한 줄로 말한다. 「인용된 소견 없음」은 **유효한 200**(판 번호 일치 + `head`/`draft` 배열 + 모든 건이 객체이며 아는 칸)일 때만 나오고, 실패·403·모양 불일치·판 불일치는 전부 「확인하지 못했습니다」다. 편집문 출력은 인용 줄을 하나도 그리지 않고 고정 고지 한 줄만 인쇄하며 전용 읽기를 **발행하지 않는다**(D3) — 초안만 그리면 승인본에서 이어지는 건이 빠져 승인 문장 아래에 「없음」이 찍힌다. **호스트에서 실제로 실행한 순수 6건**(`node --test tests/report_preview_citation_test.cjs`): 칸 순서·저장 순서의 결정성, 서버 실제 투영 모양의 sentinel이 어느 상태에서도 지면에 나타나지 않는 것, 존재 상태가 공용 벡터(occurrence 24)에 대해 `presenceOf`와 같은 답이고 `absent`·축약 건이 목록에서 사라지지 않는 것, 네 종결 상태의 정확한 문면과 `citationAnswerOk`의 유효성 판정(판 불일치·비배열·null 건·모르는 칸), 연결 상태 다섯 값의 한글 매핑과 UTC·조건부 caveat·귀속 줄·한계 줄, 그리고 `savedLabel`이 새 순수 export 옆에 그대로 있는 것. **호스티드 격리 Chromium 17건**(`python tests/report_preview_citation_dom_test.py`, validate의 measurements job `report-preview-citation-dom` 단계)은 출하된 `KinReportPreview` 공장과 **main.html에서 추출한 실제 `api()`** 위에서 ok-n/ok-0/403/5xx/모양 깨진 200/판 불일치/편집문 고지와 읽기 미발행/모드 왕복/`다시 확인` 뒤 늦은 답이 더 새 지면을 덮지 못함/**닫은 뒤 늦은 답이 아무것도 그리지 않음**/**닫고 다른 환자를 연 뒤 늦은 답이 그 환자 지면에 칠해지지 않음**/**401은 지면을 비우고 세션 종료로 간다**/구조와 `break-inside`/인쇄 직전 재확인의 거절과 일치 시 **인쇄된 문서 문자열이 미리보기 문자열과 같음**/지면의 sentinel 부재/판 0의 무절·무읽기를 실행한다. 인쇄 경로는 기존 popup 시험들과 같은 방식으로 popup의 `print`를 stub하고 `document.write`를 가로채, 제품의 `print()` 호출이 **실제로 도달했는지**(`printCalls`)와 **쓰인 문자열 전체**를 단언한다 — 거절 경로에서는 그 둘이 각각 0과 빈 목록이어야 한다.

**브라우저 돌연변이 5건**(`python tests/report_preview_citation_mutants.py`, measurements job `report-preview-citation-mutants` 단계, 자체 5분 예산)은 이 단위의 공장 쪽 결함을 지킨다 — M2w(판 일치 제거)→판 불일치 사례, M5a(인쇄 직전 재확인 제거)→인쇄 거절 사례, M5b(인용 await를 마지막 관문 뒤로)→늦은 답 사례, M5b-close(`check(s)` 제거)→닫고 다른 환자를 연 사례, M6(편집문이 인용 상태를 그림)→편집문 고지 사례. 돌연변이는 **임시 사본에만** 적용하고 소스 트리는 건드리지 않으며(시험이 받는 `KIN_PREVIEW_JS` 덮어쓰기로 주입한다), 앵커가 정확히 1회 나타나야 하고, **수정하지 않은 사본이 같은 덮어쓰기를 통과해 exit 0**이어야 하며, kill은 자식 exit ≠ 0 **그리고** 지정한 사례가 `AssertionError`로 FAIL로 이름되고 **하네스 시작 실패 문구가 없을 때만** 센다 — 충돌은 kill이 아니다. 실행 후 소스 해시 무변경까지 요약 JSON에 남긴다.

**이 17건과 브라우저 돌연변이 5건은 아직 한 번도 실행된 적이 없다 — 첫 실행은 호스티드 후보 CI다.** 브라우저를 로컬에서 돌리지 않는 대신 생성한 하네스 세 블록을 `node --check`로, 두 시험 파일을 `py_compile`로, 돌연변이 앵커 5건과 그 대상 사례 이름을 `--anchors-only` 정적 검사로 먼저 통과시켰다(U3에서 하네스가 컴파일되지 않아 모든 사례가 단언 이전에 죽은 결함의 재발 방지). 실제 페이지 나눔과 **렌더된 키 이미지 절과의 순서**는 헤드리스 DOM이 관측할 수 없어 미검증으로 남기고 구조는 직렬화된 지면에서 확인한다. `AbortError`·15초 예산의 재throw는 **정적 검토만** 했다(타이머 사례는 비용에 비해 얻는 것이 없다). 실제 서버 답으로 `citationAnswerOk`를 지나가는 시험은 이 단위 밖이며 3단계 마감 항목으로 남긴다. `report_preview_label_test.cjs`의 export 목록 단언 한 줄은 새 순수 export를 포함하도록 **정확한 목록 그대로** 갱신했다. **R13은 이 단위로 닫히지 않는다** — job print의 판독문 지면(`saved`/`both`/`prior`/`editor`/`editor-prior`, `viewer-job-print.js` 무변경)과 머리 아닌 판의 인용 읽기는 U5·U5b로 남는 3단계 마감 관문이다. job print 지면은 **S3-U5**가 덮었고(아래), 머리 아닌 판은 U5b로 남는다.

REQ-S3-U5-JOB-PRINT-CITATION → RISK-S3-U5-EVIDENCE-LESS-PAGE/CROSS-STUDY-EVIDENCE/FALSE-EMPTY/STALE-EVIDENCE-PRINTED/PANEL-TEARDOWN → TEST-S3-U5-JOB-PRINT-CITATION: 두 번째 출력 경로인 job print 판독문 지면에 같은 인용 증적을 싣는다. 서버·스키마·엔드포인트 변경이 없고(`api/**` diff 0), 문면은 U4가 만든 순수 함수 `citationSection`/`citationAnswerOk`를 **그대로 재사용**한다 — 두 번째 구현은 같은 인용에 대해 두 지면이 다른 말을 하기 시작하는 방식이다. 뷰어 문서에는 그 파일이 없으므로 `report-preview.js`가 같은 객체를 `globalThis.KinReportPaper`로도 공개하고(`module.exports` 내용 무변경), `viewer-jobs.js`가 `viewer-editor-link.js` **바로 뒤** 순서로 `report-citation.js`·`report-preview.js`를 지연 로드한다. 읽기는 **인쇄되는 검사마다 그 검사 자신의 관문으로 한 번**(`GET /studies/:uid/report/citations`, `foreign: true`)이며, 귀속 줄의 확인자는 **그 uid 자신의 `/report-preview` 응답의 `actor`**다. 투영을 `state()`의 `data` 안에 넣었으므로 렌더(`:628`)·인쇄(`:645`) 직전 재확인이 **새 비교도 새 거절 문구도 없이** 인용을 덮고, 전용 읽기의 `draft`는 읽고 버린다(지면에 닿을 수 없는 변화로 인쇄를 거절하지 않는다). 필요한 라이브러리가 없으면 **fail-closed로 거절**한다(`인용 출력 구성 요소를 불러오지 못했습니다. 다시 확인을 누르세요.`) — 「확인하지 못했습니다」 문면 자체가 그 라이브러리 안에 있어 증적 없는 서명본을 인쇄하지 않는다. **호스트에서 실제로 실행한 순수 5건**(`node --test tests/viewer_job_print_citation_test.cjs`): 인쇄 항목→읽기 대상 매핑, 오류 모양→종결 상태 매핑과 `viewer-jobs.js`의 `r.status === 401 || r.status === 403 && !foreign` 문면 고정, 두 지면이 **같은 함수 객체**를 쓴다는 것, identity api의 16개 이름 유지, 그리고 두 지면의 줄이 **사람 표기 칸 말고는 바이트 동일**이라는 것. **호스티드 격리 Chromium 14건**(`tests/viewer_job_print_citation_dom_test.py`, measurements 잡 `job-print-citation-dom`)은 saved/prior/both/editor/editor-prior/none, 판 0, 403이 **패널을 끝내지 않는 것**, 5xx가 **다른 절과 영상을 살려두는 것**, 판 불일치·모양 깨진 200, 인쇄 직전 거절과 초안만 바뀐 경우의 인쇄 진행, 구조와 금지 목록을 실행한다. **브라우저 돌연변이 7건**(`tests/viewer_job_print_citation_mutants.py`, `job-print-citation-mutants` 단계)은 U4 하네스의 구멍을 막는다: kill은 자식 exit ≠ 0 ∧ 지정 사례가 **FAIL**(ERROR는 제외 — ERROR는 그 돌연변이가 겨냥한 단언이 아니라 예외를 가리킨다) ∧ AssertionError ∧ **그 돌연변이 자신의 `expect` 문구가 실패 본문에 있을 것** ∧ crash 없음이다. U4 규칙은 임의의 AssertionError를 kill로 셌다. crash 표지는 `playwright._impl._errors`·`ModuleNotFoundError` **둘뿐**이며 좁게 유지한다 — 평범한 실패 실행에도 나타나는 표지를 넣으면(예: 맨 `Traceback`) 진짜 kill이 전부 survivor가 된다. 뷰어의 `api()`는 `kinViewerJobs` 안의 클로저라 단독 로드가 불가능하므로 DOM 하네스는 그 함수를 **다시 타이핑한 사본**으로 돌리고, 제품 문면은 순수 5건이 고정한다. **이 DOM 14건·PDF 관문 1건·돌연변이 7건은 아직 한 번도 실행된 적이 없다 — 첫 실행은 호스티드 후보 CI다.** 실제 페이지 나눔은 헤드리스 DOM이 관측할 수 없어 PDF 관문이 맡고, 실제 프린터의 물리 여백·색·DPI와 실스택 동작은 여전히 별도 잔여다. `api()`의 30초 타이머가 만드는 「느린 읽기 한 건이 unknown으로 떨어진다」 행은 v2/v3의 30초 `bounded()` 예산에서는 **도달할 수 없고**(호출자 abort가 항상 먼저 이긴다) 어떤 U5 시험도 그것을 검증하지 않는다 — 미검증으로 남긴다.

REQ-S3-U5b-HISTORY-CITATION → RISK-S3-U5b-WRONG-BODY/FALSE-EMPTY/CROSS-VERSION/DRAFT-LEAK/REVOKED-LINEAGE/IDENTIFIER-LEAK/ALIASED-VERSION → TEST-S3-U5b-HISTORY-CITATION: 보존된 **과거 판**의 증언에 처음으로 독자를 만든다. `versions()`는 칸을 명시해 인용을 빼고 있고 머리 읽기는 `Report.version` 한 행만 답하므로, 그 사이의 모든 판(승인·추가기재·임시저장·예비판독·보류, 그리고 `reset`이 보존한 행과 관리자 강제 해제가 보존한 남의 초안 행)은 저장돼 있으면서 **어떤 표면도 읽지 않았다.** 새 표면은 `GET /studies/:uid/report/versions/:version/citations` 하나이고 답은 `{version, actor, entries}`뿐이다. 관문은 기존 규칙 그대로이되 **한 스냅샷 안**이다: 표준 십진·`Int` 범위 검사(`/^[1-9][0-9]{0,9}$/` ∧ ≤ 2147483647) → `prepare(c)` → `RepeatableRead` 트랜잭션 안에서 `gate(uid,c,tx)`(기관·접근정책 404) → `canReadPrelim`(403) → 그 판 행(없으면 404) → 소견 가독 재적용. 바깥 `gate()`를 두지 않는 이유는 관문과 판 읽기가 갈리면 그 사이에 예비 판독이 끼어든 판을 그 관문 없이 답할 수 있기 때문이다. **전선에는 메타데이터만 나간다** — 읽을 수 있는 건은 `field·findingRevision·sourceIndex·linkStateAtInsert·insertedAt·insertedBy·presence` 일곱 칸, 축약된 건은 네 칸이며 `insertedText`·`cid`·`findingId`·`sourceRef`는 **어느 것도** 나가지 않는다. 과거 판에는 지울 것도 바뀔 본문도 없으므로 존재 상태는 **서버가 그 행 자신의 본문에 대해** 세어 한 낱말로 보내고(`sameTextCount`는 축약된 쌍둥이까지 포함해 행 전체에서 센다), 화면은 본문을 갖지 않아 **틀린 본문으로 셀 방법이 없다**. 셀 수 없는 옛 건(문자열이 아닌 `insertedText`, 아는 칸이 아닌 `field`)은 `presence: null`이고 화면은 그 판 전체를 「확인하지 못했습니다」로 만든다 — 확인하지 못한 것을 「더는 없습니다」로 지어내지 않는다(그 판의 블록은 그래서 **영구히** 미확인이다). 화면은 이력 모달의 판마다 `Show Citations` 하나이며 **사람이 누른 판만** 읽는다. 지면의 포매터(`citationSection`)를 그대로 쓰고 축약 판별·존재 상태만 좁은 어댑터로 바꿔 끼우므로 `report-preview.js`·`report-citation.js`는 **바이트 무변경**이다. **컴파일 API 7건**(`node --test tests/report_citation_test.cjs`의 U5b 절, 기존 28건은 무약화로 함께 돈다 → 35건): 관문 순서가 `prepare → transaction(RepeatableRead) → studyState(tx) → require(tx) → 판 읽기 → readableFindings`이고 트랜잭션 **밖** 읽기가 하나도 없다는 것, 트랜잭션 결속 재검사만 거절시키면 **판 읽기 0회로 404**라는 것, `where.uid_version`과 네 칸 `select`, 없는 판의 404와 `citations`가 null인 행의 **참인 0건**, 응답 세 칸·건별 키 집합·초안 세 경로 모두 0회·무쓰기, 축약과 건수 보존과 그 행 id만 묻는 것, 표준 십진 12건이 **`calls` 빈 배열**로 400이고 `'2147483647'`은 관문을 다 돈 뒤 404라는 것, 강제 해제 행이 자기 증언만 답하고 남의 문장은 서버를 떠나지 않는 것, 그리고 존재 상태가 v2에서 `present`·v7에서 `absent`·축약 쌍둥이와 함께 `ambiguous`·셀 수 없으면 `null`이라는 것. **호스티드 격리 Chromium 10건**(`tests/report_version_citation_dom_test.py`, measurements 잡 `report-version-citation-dom`): 출하된 이력 블록을 **슬라이스 하나**로 올리고 실제 `#histmodal` 마크업과 실제 `#hist-close`를 쓴다(하네스는 이력 상태도 닫기 처리기도 선언하지 않는다). 사례는 누른 판만 읽고 귀속 줄이 **서버 actor**를 말하는 것, 0건, 거절이 「없음」이 아닌 것, 실패 세 종류와 **같은 판 재시도 실패가 이전 줄을 교체**하는 것과 401이 아무 상태도 그리지 않는 것, 판마다 자기 존재 상태를 말하는 것, **답이 깨지는 일곱 갈래**(판 불일치·판 비정수·`entries` 비배열·null 건·모르는 칸·actor 없음·존재 상태 없음)가 전부 미확인인 것, 축약 건의 줄 보존, 역순 도착, **닫으면 그린 블록이 사라지고 닫힌 동안 온 답이 아무것도 쓰지 않는 것**과 앞선 목록 읽기의 늦은 **성공과 실패** 둘 다, 그리고 식별자·문장 sentinel이 마크업에 없고 작성자 이름이 텍스트 노드로만 닿는 것이다. **브라우저 돌연변이 7건**(`tests/report_version_citation_mutants.py`, `report-version-citation-mutants` 단계, 5분 예산): 판 동일성 제거·화면이 존재 상태를 다시 계산·거절을 빈 목록으로 렌더·공유 host 하나·닫기가 버리지 않음·귀속을 세션에서 만듦·건별 모양 검사 제거. `expect`는 전부 **서로 다른 명시 단언 메시지**다 — 제품 문면은 「확인하지 못했습니다」가 「접근 권한 밖」의 접두사라 같은 사례의 무관한 실패에도 걸린다. 돌연변이는 임시 사본에만 적용하고 `KIN_HISTORY_CITATION_MAIN` 덮어쓰기로 주입하며 BASELINE도 같은 덮어쓰기를 지난다. **이 DOM 10건·돌연변이 7건·컴파일 7건은 아직 한 번도 실행된 적이 없다 — 첫 실행은 호스티드 후보 CI다.** 브라우저를 로컬에서 돌리지 않는 대신 생성한 하네스를 `node --check`로, 두 시험 파일을 `py_compile`로, 앵커 7건과 **하네스 슬라이스 마커 2건**을 `--anchors-only`로 먼저 통과시켰다. `ROUTES` 선언과 `call_report_route` 분기는 더했지만 **U5b의 어떤 관문도 그 시험을 실행하지 않는다**(호스티드는 `execution_selection_test.py`로 건수만 센다) — 미실행 선언으로 남기고 고정 후보 검토가 데코레이터·표·분기 URL을 정적으로 대조한다. 실제 PostgreSQL·기관 간 404·RS=P 403·접근정책 회수·`invariants_live` 69·`e2e/test_worklist` 15는 전부 미실행이며, `prepare(c)`가 제한 정책 호출자에게 tx 결속 재검사의 캐시를 채운다는 것도 스텁으로는 보이지 않아 실스택 잔여다. **R13은 이 단위로 닫히지 않는다** — 구현·검토·필수 CI·실제 main 수용까지 `partial`이고, 과거 판의 **인쇄**(S3-U5c)는 캐시된 원장에 요구 근거가 없어(IF-A27의 인쇄는 *이전 검사*의 보고서다) 이름 붙은 잔여로 **명시 미결**이다.

REQ-S3-U6-CURSOR-INSERTION → RISK-S3-U6-SPLIT-LINE/BROKEN-GUARD/LOST-TEXT/DIVERGENT-BODY/UNREAD-POSITION/LOST-CARET → TEST-S3-U6-CURSOR-PLACEMENT: 판독문 세 칸에 글이 들어갈 때 **사람이 둔 커서 자리**로 들어간다(원문 IF-A29의 「cursor 위치 삽입」). 대상은 인용 삽입과 상용구 삽입 두 경로뿐이고, 단축어 Tab 확장(인라인 삽입)은 그대로다. 서버·스키마·엔드포인트 변경이 없다(`api/**` diff 0) — 서버는 이미 「이 요청 본문의 그 칸에 **줄 블록으로 실재하는가**」만 보기 때문에(`pacs.service.ts:1726`) 줄 경계만 지키면 끝이라는 것이 이 단위의 근거다. 규칙은 순수 함수 하나(`report-citation.js`의 `placeBlock`)이며 셋을 동시에 지킨다: ① 기존 글자·선택 영역을 **한 자도 지우지 않는다**(구분자 LF만 더한다), ② 블록은 **완전한 줄들**을 차지한다(줄 한가운데 커서는 그 줄 **다음**으로 맞춘다), ③ 이미 인용된 줄 블록 **안으로는 들어가지 않는다**(그 뒤로 물러난다). 구분자 규칙은 「넣은 뒤에도 기존의 모든 줄이 그대로 남고 줄 수는 블록의 줄 수만큼만 는다」로 고정했다 — 초안 계약의 단순 규칙은 사람이 둔 빈 줄이나 인용 블록의 마지막 빈 줄의 종결자를 빼앗아 그 인용을 `absent`로 만들 수 있었다(§7-1 P1·P5가 그 자리를 고정한다). **커서 자리를 확인한 적이 없는 칸은 오늘과 바이트가 같다** — `appendBlock` 그대로이고, 그래서 기존 회귀 전부가 수정 없이 통과한다. 커서 자리는 브라우저(그 칸 자신)가 들고 있고 화면은 「이 칸을 짚은 적이 있는가」만 기억하며, 그 표시는 검사 이동과 **값이 실제로 달라진** 재대입에서만 지워진다. 미리보기는 **어느 칸 몇 번째 줄(줄바꿈 기준)부터** 들어가는지를 한 줄로 말하고, 열고 나서 그 자리가 달라졌으면 **아무것도 보내지 않고** 다시 확인시킨다(소견 패널이 판독문 칸을 덮고 있어 그 줄이 유일한 고지다). **호스트에서 실제로 실행한 순수 9건**(`node --test tests/report_cursor_insert_test.cjs`): 경계 행렬(빈 칸·맨 앞·줄 중간·줄 끝·줄 머리·LF로 끝나는 칸·빈 줄·범위 밖 정수)의 기대 문자열, 앵커 없는 답과 `appendBlock`의 바이트 동일성, 모든 자리에서의 줄 블록 실재, 무손실 복원, 공용 벡터 전부에서 `blockSpans` 개수 = `lineBlockOccurrences`와 보호 구간의 비파괴(**칸이 LF로 끝나고 인용 블록이 빈 줄로 끝나는 부류 포함** — 보호 구간을 지나 마지막 빈 줄 **뒤로** 물러난 자리는 앞 글자만으로는 그 앞과 구별되지 않아 한때 그 인용을 쪼갰다)와 **지면이 말한 줄 번호 = 블록이 실제로 놓인 줄**, 선택 영역 무삭제, 무정규화와 CR 입력의 무예외, 위치 무관한 건수 의미, 그리고 배선(빈 vm에서 도는 base block·`loadReport`의 고정 문자열·계획을 정하는 **세 자리**·상용구 경로·문면). **소스 문자열 배선 단언은 좌표일 뿐이고 동작 증명은 브라우저 쪽이다** — D11/M4(보낸 것 = 보이는 것), D7/M3(읽지 않은 자리는 보내지 않는다), D1/M1·M6(줄 단위 배치와 캐럿), D10/M5(기존 인용 보호). **호스티드 격리 Chromium 14건**(`tests/report_cursor_insert_dom_test.py`, measurements 잡 `report-cursor-insert-dom`)은 실제 `loadReport()`·`stashReport()`·인용 상태·미리보기·`insertTemplate`을 잘라 올려 D1~D14를 실행하고, **브라우저만 답할 수 있는 것**(blur 뒤 selection 유지, 같은 값 재대입의 캐럿 불변, 달라진 값의 앵커 폐기)을 D12가 가정이 아니라 실행으로 확인한다. **브라우저 돌연변이 6건**(`tests/report_cursor_insert_mutants.py`, `report-cursor-insert-mutants` 단계, 5분 예산)은 `KIN_CURSOR_MAIN`·`KIN_CURSOR_CITATION_JS` 덮어쓰기로 **임시 사본에만** 적용하며, kill은 자식 exit ≠ 0 ∧ 지정 사례가 **FAIL**(ERROR 제외) ∧ `AssertionError` ∧ **그 돌연변이 자신의 expect 문구가 그 사례의 실패 본문에 있을 것** ∧ crash 표지 없음의 완전 연언이고 돌연변이 파일 sha256과 실행 후 원본 무변경까지 요약 JSON에 남긴다. **이 DOM 14건과 돌연변이 6건은 아직 한 번도 실행된 적이 없다 — 첫 실행은 호스티드 후보 CI다.** 브라우저를 로컬에서 돌리지 않는 대신 하네스가 잘라 쓰는 제품 구간을 순수 시험이 **실제로 컴파일**해 보고(U3에서 모든 사례가 단언 이전에 죽은 그 결함의 재발 방지), **컴파일은 실행이 아니므로** 그 구간의 최상위 `$("#id")`가 찾는 요소가 하네스 마크업(잘라 넣은 `#stalemodal`·`#cite-preview` 포함)에 하나도 빠짐없이 있는지를 같은 순수 시험이 함께 확인하고(빠지면 페이지가 적재 중 throw해 14건 전부가 단언 이전에 죽는다), 두 시험 파일을 `py_compile`로, 돌연변이 앵커 6건·슬라이스 마커 3건·대상 사례 이름·expect 문구를 `--anchors-only` 정적 검사로 먼저 통과시켰다. `report_citation_client_test.cjs`의 배선 앵커 두 줄은 이 단위가 옮긴 좌표를 가리키도록 **정확한 새 문자열로 갱신**했고 단언은 늘었다(계획 도출 순서·같은 계획의 본문/화면 사용·캐럿). **미검증으로 남는 것**: 한글 조합(IME) 중의 커서 위치, 실스택(`tests/e2e/test_template_preview.py`의 상용구 삽입 기대값은 커서 자리가 확인되지 않은 칸의 경로여서 바이트가 같지만 **실행으로 확인되지 않았다**), 그리고 배포. 이 단위는 **IF-A29를 닫지 않는다** — 매크로 CRUD·제목 중복검사·Ctrl+1~9 메뉴·2연속문자 자동완성은 9단계 잔여이고, R13은 U4/U5/U5b로 공학 마감, U5c는 이름 붙은 비관문 잔여다.

REQ-S3-STRUCT-BODY → RISK-S3-STRUCT-SILENT-BODY-REWRITE/BROKEN-CITATION-BLOCK/FALSE-STRUCTURED-CLAIM/VALUE-TEXT-DRIFT/LOST-TYPED-WORK/CROSS-STUDY-WRITE/CHECK-AS-500/STALE-CONFIRMATION → TEST-S3-STRUCT-*: 판독문 본문에 **타입 있는 항목**을 넣는 기반이다(원문 Notion Part 1 Radiologist Workspace의 `structured report`). **이 단위는 R15를 닫지 않는다 — 제품 서식 목록이 비어 있다.** 어느 검사의 어떤 항목·라벨·단위·범위·문장을 구조화할지는 평가 판독의만 답할 수 있고(D2 미해결), 구현자가 지어내면 그것은 기능이 아니라 지어낸 임상 내용이다. 목록이 빈 동안 `Structured` 단추는 **그려지지 않고**(비활성이 아니다) 서버는 모든 적용을 400으로 거절한다. 합성 서식(`SYN-T1` / `SYN-CHOICE·SYN-NUMBER·SYN-BOOL·SYN-TEXT`, 문장 앞머리 `SYNTHETIC-ITEM`)은 **시험 안에서만** 존재하며 제품 코드나 HTTP로 닿을 길이 없다(주입 이음매는 클라이언트 `KinReportStructure.create(citationLib, catalog)`와 서버 인스턴스 칸 `structureCatalog` 하나뿐이다). 기록의 본체는 여전히 자유문 세 칸이고, 새 칸은 그 옆에 서는 증언이다 — **고른 값(`value`)과 본문에 들어간 그 한 줄(`renderedText`)을 함께** `ReportDraft`·`ReportVersion`의 추가 전용 `structured Json?`에 남긴다(`Report`에는 거울을 두지 않는다). 서버는 본문을 쓰지 않고 「그 문장이 이 요청의 본문에 줄 블록으로 실재하는가」만 확인하며(인용과 같은 구조적 방어), 문면은 서식이 정하므로 `renderedText ≠ renderItem(...)`은 거절이다. v1의 문장은 **정확히 한 줄**이라 `citationGuards`를 **그대로** 재사용한다. 확정에는 규칙이 하나다: 머리에서 왔든 초안에서 왔든 **그 문장이 확정될 본문에 있을 때만** 실린다 — 손으로 고친 문장의 옛 값이 서명된 판에 남으면 기계가 읽는 값이 의무기록과 다른 말을 하게 된다. 같은 항목은 한 번만 살고(되풀이 항목은 v1 밖), 값을 고치는 길은 `replace`이며 **머리 건도 가리킬 수 있다**(확정이 매번 초안 행을 지우므로 그러지 않으면 첫 저장 이후 수정이 불가능하다). 요청이 구조화를 건드리지 않으면 칸을 **생략**하고(그대로 두기), `structureIds: []`로 명시해 비우면 `Prisma.DbNull`로 **SQL NULL**을 쓴다 — 생략은 비우기가 아니다. 새 라우트는 `GET /studies/:uid/report/structure` 하나이며 관문은 `versions()`와 같다(기관 + 예비 판독). 인쇄·job print·이력·비교는 이 라우트를 부르지 않고 어떤 것도 「구조화」라고 부르지 않는다. 렌더는 `String.replace`의 문자열 치환을 쓰지 않는다 — 그 함수는 치환 문자열의 `$$`·`$&`·`` $` ``·`$'`를 패턴으로 해석해서 사람이 친 값과 본문에 들어가는 문장이 달라진다(공용 벡터에 그 네 가지가 있고, 독립 규칙이 「이 벡터들은 문자열 치환이 틀리는 바로 그 값」임을 함께 확인한다). 같은 항목이 살아 있는지 세는 규칙도 확정의 규칙과 같다 — **머리 건은 그 문장이 이 요청의 본문에 있을 때만** 살아 있다(한 번 고친 뒤 두 번째로 고치려는 사람에게 「이미 입력한 항목입니다」를 돌려주지 않기 위해서다). 창은 **열린 그 검사에 묶인다**(uid·선택 세대를 열 때 못 박고, 누를 때 계획을 다시 세우기 **전에** 대조하며, 선택이 바뀌면 진행 중이 아닌 창을 닫는다). 바꾸기는 **지워질 문장과 새 문장을 함께** 보여준다 — 이 단위에서 본문 글자를 지우는 경로는 그 하나뿐이고 창이 판독문 칸을 덮고 있다. **호스트에서 실제로 실행해 통과한 것**(이 단위가 직접 돌린 것만 적는다): `node --test tests/report_structure_client_test.cjs` 순수 22건, `python tests/report_structure_vectors_test.py` 9건(제3의 독립 규칙이 공용 벡터를 다시 검사하고, 달러 벡터가 문자열 치환이 틀리는 바로 그 값임을 확인하며, 양쪽 제품 목록이 비었음과 내용이 채워질 때의 선행 조건을 함께 건다), `python tests/report_structure_migration_test.py` 15건, `python tests/report_citation_migration_test.py` 22건(한도 매핑 래퍼 이름이 두 호출 지점에서 같은지), 그리고 이 단위가 `main.html`을 바꿔 다시 돌려야 했던 두 건 — `node --test tests/report_citation_client_test.cjs` 29건(`select()`가 빈 vm에서 실제로 돌고, 한가한 구조화 창은 닫히고 **요청이 나가 있는 창은 그대로 둔다**)과 `node --test tests/report_cursor_insert_test.cjs` 9건(인용 쪽 계획 지정은 여전히 정확히 한 자리, 구조화 블록은 자기 몫으로 정확히 두 자리). **`main.html`을 읽는 나머지 순수 소비자들은 이 단위가 다시 돌리지 않았다** — 제품 바이트가 같은 상태에서 독립 검토가 훑어 통과를 확인했고(`finding_command` 45, `finding_link_model` 116, `report_rebase_model` 6, `sr_tree` 6, `window_position_persistence` 3, `worklist_prior` 6), 그 근거를 소스 동일성으로 이어 쓴다. **호스티드에서 한 번 실행된 것**(첫 후보 CI): `node --test tests/report_structure_test.cjs` 39건(`kin-api:ci` 안의 컴파일된 `PacsService`를 가짜 DB로 구동한다 — 서버 규칙은 **직접 단언**이며 돌연변이 kill이 아니다)은 **36건 통과·3건 실패**했다. 세 실패는 전부 같은 하네스 결함이었다 — `AuditLog.detail`은 `String?`이고 서비스가 `dump()`(=`JSON.stringify`)로 쓰므로 저장된 값은 **JSON 문자열**인데, 시험이 그것을 객체로 다루거나 한 번 더 직렬화했다. 제품 감사 형식은 옳고 바뀌지 않았다. 기록된 것은 `JSON.parse(detail)`로, 기록되지 **않아야** 하는 것은 원문 문자열로 본다(선례 `report_citation_test.cjs:295`·`:522-527`). 같은 실행에서 `report_citation_client_test.cjs` 29건과 `report_cursor_insert_test.cjs` 9건은 호스티드에서 전부 통과해 R1/R2 수정이 확인됐다. **아직 한 번도 실행되지 않은 것**: 호스티드 격리 Chromium `tests/report_structure_dom_test.py` 17건(D1~D17, measurements 잡 `report-structure-dom`), 클라이언트 돌연변이 6건(`tests/report_structure_mutants.py`, `report-structure-mutants` 단계, 5분 예산 — kill은 자식 exit ≠ 0 ∧ 지정 사례 **FAIL**(ERROR 제외) ∧ `AssertionError` ∧ **그 돌연변이 자신의 expect 문구가 그 사례의 실패 본문에 있을 것** ∧ crash 표지 없음의 완전 연언이고 돌연변이 sha256과 실행 후 원본 무변경까지 요약 JSON에 남는다). **기존 DOM 하네스 세 개**(`report_cursor_insert_dom_test.py`·`report_citation_dom_test.py`·`report_rebase_dom_test.py`)는 이 단위의 블록이 같은 슬라이스 안에 들어왔으므로 **모듈과 모달 마크업을 함께 주입하도록 갱신했다** — 그러지 않으면 적재 중 throw가 나 모든 사례가 단언 이전에 죽는다(U3의 교훈). **렌더 단사성(P12)은 이 단위에서 부분이었다 — 그 자리는 아래 REQ-S3-STRUCT-CATALOG가 대체한다.** 당시 규칙은 열거 가능한 값(choice·boolean)만 전수 대조하고 자유 입력 항목은 문장 골격의 유일성만 요구해서, 자유 입력 값이 **다른 항목의 문장을 통째로 흉내 내는** 경우를 막지 못했다. 이 문단의 나머지 사실(빈 제품 목록·주입 이음매 하나·여기 적힌 실행 건수)은 그대로이고, 단사성 문장만 다음 단위가 고쳐 쓴다. 새 라우트는 실스택 불변조건 69건 안에서 **실제로 호출된다** — `invariants_live.py`의 `call_report_route`에 `structure` 분기를 두어, 기사에게는 손상이 없고 예비 판독의 제3자에게는 본문이 새지 않으며 타 기관 admin에게는 404라는 세 관문을 다른 REPORT 라우트와 같은 방식으로 지난다(첫 후보 CI에서 이 분기가 없어 세 subTest가 「호출 방법이 없습니다」로 실패했고, 건너뛰거나 목록에서 빼는 대신 호출을 더했다). **미검증으로 남는 것**: 실제 PostgreSQL의 CHECK 이름·canonical jsonb 바이트, 한글 조합(IME), 그리고 배포. 인쇄·이력의 무변경은 **소스 대조**로 보증하며 실행 바이트 비교가 아니다(D14는 빈 목록에서 요청이 없음을 볼 뿐 인쇄 바이트 증거가 아니다).

REQ-S3-STRUCT-CATALOG → RISK-S3-CATALOG-AMBIGUOUS-PRESENCE/CROSS-TEMPLATE-COLLISION/BOUNDARY-COMPOSITION/UNVALIDATED-INJECTION/WHOLE-PAGE-DOWN-ON-LOAD → TEST-S3-STRUCT-CATALOG: 위 단위가 부분으로 남긴 **P12(렌더 단사성)의 기술적 선행 조건**을 닫는다. **임상 내용은 하나도 더하지 않는다 — 제품 서식 목록은 여전히 비어 있고 `Structured` 단추는 그려지지 않으며 D2는 미해결 그대로다.** 이 단위가 여는 것은 내용이 아니라 **안전장치**다: 비어 있지 않은 목록이 언젠가 들어올 때 같은 칸의 서로 다른 (항목, 값)이 **같은 한 줄**을 만들어 존재 판정이 조용히 틀리는 일이 **불가능**해지도록 적재 시점에 막는다. 규칙은 다섯이고 **표본이 없다** — 값을 하나도 지어내지 않고 결정된다. 순서는 **R-D → R-S → R-C → 쌍(R-A 다음 R-B)**으로 고정이며 모든 거절은 어긴 규칙의 이름을 들고 나온다(`StructureCatalogError.rule`, 화면은 `CatalogError.rule`). **R-D**(모양): 슬롯이 정확히 한 번, 한 줄, **온전한 UTF-16**(짝 없는 서러게이트는 한도 질의에서 `jsonb` 오류가 돼 500이 된다), 앞뒤 고정 문자열이 **이미 NFC**, 바이트 여유, 형식별 칸. **R-S**(경계 안정성): `comparisonKey(앞머리+값+꼬리) === NFC(앞머리) + comparisonKey(값) + NFC(꼬리)`. **결합 등급(ccc) 표를 들추지 않고 실제 정규화기에게 직접 묻는다** — 앞머리가 `ᄀ`(U+1100)로 끝나고 값이 `ᅡ`(U+1161)로 시작하면 NFC가 둘을 `가`(U+AC00)로 합치는데 **둘 다 ccc 0**이라 「결합 문자 금지」류의 규칙으로는 잡히지 않는다(벵골어 U+09C7 + U+09BE → U+09CB도 같은 모양이라 벡터로 함께 건다). 거꾸로 값 **안에서만** 합쳐지는 글자나 공백 뒤에 오는 결합 부호는 **받는다** — ccc 규칙이 이유 없이 거절하던 바로 그 값들이고 수락 벡터로 남겼다. 글자는 고치지 않는다: 사람이 친 값도 이미 기록된 바이트도 다시 쓰지 않고 **거절만** 한다. **R-C**: 한 항목의 두 값이 같은 줄을 만들지 않을 것(정규화가 같으면 같은 줄이다 — 바이트가 다르다는 것은 증명이 아니다). **R-A**: 둘 다 열거 가능하면 값 공간이 유한하고 전부 적혀 있으므로 **전수로** 대조한다. **R-B**: 그 밖의 모든 쌍은 **앞머리만으로, 또는 꼬리만으로** 갈린다 — 한 문자열의 서로 다른 길이의 앞머리는 서로 포개지므로 두 앞머리가 서로의 앞머리가 아니면 두 문장은 같을 수 없다. 이 논증은 **값 공간을 한 번도 말하지 않아** 자유 입력에도 숫자에도 나중에 늘어날 형식에도 그대로 선다. 빈 문자열은 모든 문자열의 앞머리이자 꼬리이므로 앞머리가 빈 항목은 **꼬리로만** 갈린다. R-S와 R-B가 함께 서면 통과한 목록에서 **항목 간 충돌은 도달 불가능**하고, 남는 것은 한 항목이 같은 값을 두 번 사는 경우인데 그것은 P3가 막는다. 자유 입력이 **자기 항목의** 다른 값을 흉내 내는 경우의 답은 여전히 `presenceState`의 `ambiguous`다(거짓이 아니라 모른다고 말한다). 자유 입력 값은 목록에 없어 적재 시점이 볼 수 없으므로 **R-S는 입력 때 한 번 더** 본다 — 서버는 `structureApplyInput`의 **바이트 동일성 검사 뒤**에(먼저 「이 문장이 서식이 만드는 그 문장인가」, 그다음 「그 문장의 키가 조각의 키를 이어 붙인 것과 같은가」), 화면은 `validateValue`의 꼬리에서 한 줄 문면으로. `placePlan`·`replacePlan`은 손대지 않았으므로 돌연변이 앵커 M1·M6의 대상 줄은 그대로다. 적재 관문은 둘이고 **둘 다 우회할 수 없다**: (a) `report-structure.ts`의 **마지막 문장**이 `validateCatalog(STRUCTURE_CATALOG)`이라 모듈을 적재하기만 해도 검사가 돈다(어기면 API가 서지 않는다 — 모호한 목록으로 판독문을 받는 것보다 서지 않는 편이 낫다), (b) P7의 주입 이음매는 여전히 **하나**이되 검사를 지나는 getter/setter 쌍이 됐다. 검사는 **갈아끼우기 전에** 하므로 잘못된 배정은 던지면서 지나가고 **이미 서 있던 유효한 목록이 그대로 남는다** — 잘못된 배정이 멀쩡한 목록을 치우고 자리를 비우는 일은 없다. 새 환경변수·헤더·라우트·API 면은 없고 `report_structure_test.cjs:104`는 한 글자도 바뀌지 않았다. 화면 쪽은 **예외를 던지지 않는다** — `main.html`은 이 모듈을 워크리스트 나머지와 **한 `<script>` 안에서** 읽으므로 던지면 서식 하나 때문에 목록도 판독문도 자동 저장도 전부 죽는다. 대신 `create()`가 **빈 목록과 똑같이 무력한 형태**(`empty: true`, `catalog: []`)에 `invalid: '<규칙>: <사유>'`를 얹어 돌려주고 `console.error`를 **한 번** 낸다. 정상적인 빈 목록은 **아무 말도 하지 않는다** — 둘이 구별되지 않으면 깨진 목록이 「아직 구조화 항목이 없음」으로 조용히 출하된다. 잡는 것은 `CatalogError`뿐이고 프로그래밍 오류는 그대로 드러난다 — `create()`의 `try` **안에서** 난 오류도 마찬가지라서, 인용 라이브러리가 망가진 채로 들어오면 그 `TypeError`가 그대로 밖으로 나온다(순수 시험이 그 동작을 실제로 실행한다. 소스 문자열 고정이 아니다). **두 벌은 모양이 깨진 목록에서도 거울이다.** 서버가 `template?.templateId`·`item?.code`·`choice?.code`로 타입 있는 R-D를 주는 자리에서 화면도 같은 R-D를 준다 — `null` 원소든 배열의 구멍(`[a, , b]`)이든 원시값이든. 그러지 않으면 거기서 나는 것은 `CatalogError`가 아닌 `TypeError`고, `create()`가 그것을 다시 던지면 **서식 목록 하나 때문에 페이지 스크립트 전체가 죽는다** — B3/F4가 막으려던 바로 그 모양이 뒷문으로 돌아온다. 숫자 범위도 같은 질문을 쓴다: 전역 `isFinite`는 `null`과 `'12'`를 숫자로 바꿔 보고 통과시키지만 서버는 `Number.isFinite`라 둘 다 R-D이므로, 화면도 `Number.isFinite`다. 공용 벡터 파일이 세 벌을 묶는다: **목록 벡터 46건**(ACCEPT 10 — 출하된 `SYN-T1` 목록 자체와 빈 목록을 포함한다 — R-D 22·R-S 5·R-C 3·R-A 1·R-B 5)과 **입력 벡터 12건**(거절 5·수락 7), 그리고 `productCatalogSha256`(제품 목록 canonical JSON의 sha256, `4f53cda1…`). R-D 22건에는 **중복 templateId·중복 항목 code·중복 선택지 code·모르는 field·모르는 valueType·label 없음**(각각 그 검사 하나만 고치면 ACCEPT가 되므로 정확히 그 검사를 붙든다)과 **`null` 템플릿·`null` 항목·`null` 선택지**, 그리고 **min/max가 `null`·숫자 문자열·boolean**인 경우가 들어 있다. **배열의 구멍은 JSON이 표현할 수 없어** 공용 파일에 담지 못하므로 T1·T2가 각자 JS로 세 모양을 만들어 건다(구멍만 빼면 같은 목록이 ACCEPT라는 짝까지 함께). **모든 거절 벡터에는 같은 모양의 수락 짝이 있다** — 전부 거절하는 검사기는 여기서 떨어진다. 유니코드 사례는 escape가 아니라 **실제 코드포인트**를 싣는다(짝 없는 서러게이트만은 UTF-8 왕복이 불가능해 escape로 둔다). `productCatalogSha256`은 T1이 컴파일된 `STRUCTURE_CATALOG`에 대해, T2가 `PRODUCT_CATALOG`에 대해 **값으로** 단언한다 — 소스 정규식이 아니고 어느 쪽도 상대의 파일을 읽지 않으므로, 한쪽만 목록을 채우면 거기서 깨진다. **호스트에서 실제로 실행해 통과한 것**(이 단위가 직접 돌린 것만 적는다): `node --test tests/report_structure_client_test.cjs` **29건**, `python tests/report_structure_vectors_test.py` **14건**(제3의 독립 규칙이 목록 벡터 46건과 입력 벡터 12건을 다시 판정하고, 양쪽의 적재 관문과 `revision === 1` 덫과 두 제품 상수의 sha를 함께 건다 — 그 규칙도 `null` 원소를 R-D로 보고, `bool`이 `int`의 하위형인 파이썬에서 `isinstance(True, int)`가 참이라 min/max의 boolean을 따로 막는다), `python tests/report_structure_migration_test.py` 15건, `python tests/report_citation_migration_test.py` 22건. 여기에 **출하된 서버 TypeScript 자체**를 Node 24의 내장 타입 제거로 적재해 같은 표를 돌린 순수 탐침 86건(유일한 대체물은 `@nestjs/common`을 끌어오는 `finding-input.ts`이고 그 자리에는 **같은 파일에서 그대로 떼어낸 상수 문장**을 넣었다), 화면 쪽 탐침 111건, 규칙별 증인 탐침 36건, 그리고 모양 관문이 **무엇을 바꿨는지** 직접 보이는 판별 탐침 34건이 전부 통과했으며, 서버·화면·제3 규칙이 **46/46 목록을 똑같이** 판정한다. 판별 탐침은 첫 후보(`fc591b5`)의 화면 모듈을 `git show`로 읽기 전용으로 함께 적재해 같은 입력을 먹인다 — `null` 원소 3종과 구멍 3종은 거기서 `TypeError`였고 지금은 타입 있는 R-D이며, min/max 3종은 거기서 **ACCEPT**였고 지금은 R-D다. 되살린 중복·열거 벡터 6건은 양쪽 head에서 답이 같으므로, 대신 **그 결함 하나만 고치면 ACCEPT가 된다는 것**을 함께 보여 각자가 어느 검사를 붙들고 있는지 고정한다. **아직 한 번도 실행되지 않은 것**: `node --test tests/report_structure_test.cjs` **43건**(컴파일된 `PacsService`가 필요해 호스티드 후보 CI가 첫 실행이다 — 목록 벡터·입력 벡터·구멍 witness·이음매 setter·목록 sha가 새 건이다), 그리고 `report-structure.js`가 바뀌었으므로 **DOM 17건과 돌연변이 6건을 한 번 다시 돌려야 한다**. 하네스와 앵커는 바꾸지 않았고(`--anchors-only` 통과 — 슬라이스 표지 4건·앵커 6건이 각각 정확히 1회) `main.html`은 **바이트 무변경**이라 `main` 쪽 돌연변이 M2·M3c·M4c·M5c의 해시는 그대로다. 아래 해시는 전부 **커밋된 바이트(LF)** 기준이고, 그것이 호스티드(리눅스) 실행이 실제로 재는 값이다. Windows 체크아웃은 `core.autocrlf=true`로 CRLF를 넣으므로 **여기서 하네스를 돌리면 원본도 돌연변이도 다른 값이 찍힌다** — 원본은 작업본이 CRLF라서, 돌연변이는 하네스가 `write_text`로 쓸 때 `\n`이 다시 `\r\n`으로 펼쳐지기 때문이다(`read_text`가 읽을 때 LF로 접는 것은 맞지만, 그것만으로 양쪽이 같아지지는 않는다 — 앞선 기록의 그 괄호는 틀렸다). 예: `main.html`은 커밋 바이트 `a9b525cd…`, Windows 작업본 `b5d43a13…`. `report-structure.js`는 `5ac18627…`(base) → `a043b27a…`(첫 후보) → **`2397cd83…`**(모양 관문을 더한 이번 head)이고, 그래서 이번에 기대되는 정확한 돌연변이 해시는 **M1 `566dc80e…`, M6 `05b97b82…`**다(각각 base `04380e7b…`·`b7221bfd…`, 첫 후보 `5098300c…`·`fd797f71…`에서 다시 바뀌었다). kill 판정은 이전과 같은 **완전 연언**이며 `killed` 한 칸만으로는 절대 세지 않는다. **교차 revision은 이름 붙은 보류(HOLD)이고 해결됐다고 말하지 않는다** — 옛 revision으로 쓰인 건은 값을 보존한 채 읽기 전용으로 남고 머리와 초안은 **따로** 투영되므로 은퇴한 문장이 여전히 `present`로 세어질 수 있다. 이 단위는 그것을 결정하지 않는다. `revision === 1`인 동안은 겨룰 옛 판이 없어 질문이 공허하고 T3의 덫이 그것을 건다 — **그 덫은 불완전하다**: revision 1 안에서의 항목 코드 개명이나 항목 삭제는 보지 못하며 그것들도 같은 질문을 일으킨다. 덫은 **첫 revision 상승에서 깨지고**, 그때가 은퇴한 판을 검증용으로 보존할지 잔여를 명시하고 받을지 정해야 하는 순간이다. **R15는 이 단위로 닫히지 않는다** — 임상 내용(D2)과 목소리·기기·비용 결정은 여전히 사용자의 몫이고 3단계도 열려 있다.

REQ-S3-STRUCT-GENERIC-CATALOG → RISK-S3-INVENTED-CLINICAL-CONTENT/CROSS-REVISION-COLLISION/FALSE-STRUCTURED-CLAIM/MALFORMED-CATALOG-PAGE-DOWN/HARNESS-LOAD-DEATH/UNSEEN-NEW-READ → TEST-S3-STRUCT-GENERIC: 위 두 단위가 만든 기반에 **첫 실제 서식**을 실어 R15의 첫 사용 흐름을 연다. 서식은 검사에 매이지 않는 `GEN-1` revision 1 하나고 항목은 일곱이다 — 네 항목은 **절차적 사실**(`TECHNIQUE`·`CONTRAST`·`COMPARISON`·`COMPARISON-STUDY`), 세 항목은 판독의가 **자기 문장을 직접 치는 빈 칸**(`FINDING`·`CONCLUSION`·`RECOMMENDATION`)이다. 소견도 정상 문구도 질환 어휘도 기준값도 없다 — 서식이 주는 것은 앞머리와 항목의 신원뿐이고, 제품이 판단을 만들거나 미리 정해둔 진단 어휘를 고르게 하는 일은 없다(AGENTS §1-A.7이 막는 것이 바로 그것이다). 수정된 것은 두 모듈의 목록 상수 **둘뿐**이고 `main.html`·`pacs.service`·스키마·라우트는 **바이트 무변경**이다 — 단추를 만드는 가지(`if (!structureForm.empty)`)는 이미 있었고, 이제 **실제로 돌린다**. 두 리터럴은 **strict JSON**으로 쓰고 중첩 괄호를 짝맞추며 문자열 안을 건너뛰는 스캐너로 **값으로** 꺼내 대조한다(첫 `]`에서 멈추는 정규식은 `{value}`를 품은 문장과 중첩 `choices` 앞에서 반드시 틀린다). 고정 sha는 `c787f032…`이고 T1은 컴파일된 `STRUCTURE_CATALOG`에, T2는 브라우저 `PRODUCT_CATALOG`에, T3는 두 리터럴 모두에 건다. **한 칸 안의 앞머리는 서로의 앞머리가 아니고** 꼬리는 전부 비어 있으므로, R-S가 주는 `key(문장) = 앞머리 + key(값)`과 함께 **같은 칸의 서로 다른 항목은 어떤 값으로도 같은 줄을 만들 수 없다** — T3가 그 쌍 검사를 출하된 목록에 대해 자료로 단언한다. 이름 붙은 한계는 숨기지 않는다: 한 줄만(P10), 한 항목당 살아 있는 건 하나(P3, 그래서 `FINDING` 줄도 검사당 하나다), 512 UTF-8 바이트 대 `maxlength="512"`의 UTF-16 단위(한글 약 167자), 화면은 **값**을 재고 서버는 **문장**까지 재서 앞머리 바이트만큼의 좁은 구간은 400으로만 거절된다, NUL은 화면에서 막히고 **홀로 있는 서러게이트는 막히지 않아** 서버 400이 유일한 방버이다(화면에 `storable` 거울이 없다), 값은 지면과 이력에 **나가지 않는다**(문장은 본문이므로 나간다, P15), 구조화 목록·제거 화면은 없다. **모양 관문(D1)**은 이 단위에서 닫혔다 — 목록·`items`·`choices`가 배열이 아니면 양쪽이 **같은 이름·같은 자리·같은 문구**로 R-D를 주고, 화면의 복사는 검사 뒤로 옥기어 `create()`의 `try` 앞에서 페이지가 죽던 길이 사라졌다. **가로막은 세 하네스**(`report_citation_dom_test.py`·`report_rebase_dom_test.py`·`report_cursor_insert_dom_test.py`)는 같은 슬라이스를 올리므로 `#b-print`와 `/report/structure` 스텅을 받았다 — 없으면 적재 중 throw로 모든 사례가 단언 이전에 죽고(U3의 교훈), 스텅이 `calls`에 들어가면 그 파일의 정확한 `calls.length === n` 단언이 전부 옮겨가며 대기 중인 응답까지 가로채간다. **호스트에서 실제로 실행해 통과한 것**: `python tests/report_structure_vectors_test.py` **17건**, `python tests/report_structure_migration_test.py` **15건**, `node --test tests/report_structure_client_test.cjs` **31건**, `node --test tests/report_cursor_insert_test.cjs` **9건**, `node --test tests/report_citation_client_test.cjs` **29건**, `python tests/report_structure_mutants.py --anchors-only`(슬라이스 표지 4건·앵커 6건이 각각 정확히 1회). **아직 한 번도 실행되지 않은 것**: `tsc`/nest 빌드, 컴파일된 `report_structure_test.cjs` **48건**(이미지가 필요하다), DOM **20건**(D14는 뜻이 바뀜고 D14b·D18·D19가 새로 들어왔다), 돌연변이 **6건**(문구·앵커·완전 연언 무변경, `report-structure.js`가 바뀜어 M1·M6만 새 해시), 그리고 실스택 전체. **실스택 첫 사용 시험 두 건은 뒤이은 시험 전용 커밋에서 들어왔다** — `invariants_live.py`가 **69 → 71**이 되고 후보 선택의 고정값도 함께 올라간다(`tests/candidate_ci.py`의 `candidate-invariants` 71과 정확 선택 **93**건, `tests/candidate_ci_test.py`, `tests/execution_selection_test.py`의 `test_candidate_contract_remains_71_then_15`와 hanging-protocols 프로필의 `[71,15]`). worklist 15는 그대로다. **L-1**은 행정 항목 둘(`CONTRAST` boolean·`TECHNIQUE`)과 판독의가 직접 친 `CONCLUSION`을 두 칸에 걸쳐 적용해 초안 자동 저장 → 소유 경계(같은 기관의 다른 판독의는 내 초안 건을 보지 못한다) → 기관 경계 404 → 저장 → 재열람에서 값·문장·존재 상태를 확인하고, 마지막으로 **초안을 비워도 서명된 증언이 살아 있음**을 건다. **L-2**는 두 건 중 한 문장만 손으로 지우고 다시 저장해 떨어진 건이 감사에 **sid로만** 남고 남은 건과 사람이 친 자유문은 그대로임을 건다. 관찰 지점은 `GET /report/structure` 하나이며 `report/versions`의 응답 스키마는 넓히지 않았다. **두 건 모두 아직 실행되지 않았다 — 실스택은 호스티드 관문이다.** **교차 revision은 여전히 보류다** — 첫 채움은 빈 목록으로는 어떤 건도 기록될 수 없어 질문이 공허해서 지나가지만, 두 번째 변경은 은퇴한 판의 처분이 먼저다. 그래서 T3의 덫은 revision뿐 아니라 **항목 신원 집합과 열거 가능한 문장 집합**까지 고정한다(개명·삭제도 문장을 은퇴시킨다). **R15는 이 단위의 호스티드 관문이 통과해야 닫힌다 — 지금은 아니다. 3단계는 그것과 별개로 열려 있고, R14(음성)은 이 단위가 건드리지 않았다.**

REQ-S3-R14-INPUT-COMPAT → RISK-S3-R14-LOST-DICTATED-TEXT/DUPLICATED-DICTATED-TEXT/WRONG-INSERT-POSITION/UNCLAIMED-OCCUPANCY/SILENT-OVERLONG-VALUE/FALSE-DICTATION-PROMISE → TEST-S3-R14-INPUT-COMPAT-DOM: 음성 인식기·IME가 **내보내는 모양의 글**이 판독문 세 칸과 `#struct-value-text`에 들어올 때 타이핑과 똑같이 저장·배치·점유·거절되는가. **이 단위는 제품 로직(JS)을 한 줄도 더하지 않는다** — 바뀐 제품 바이트는 두 곳뿐이다: ① `main.html:820`의 비활성 `Dictate` 단추에 `id="b-dictate"`와 `title="음성 인식기가 연결되지 않았습니다."`, ② `main.html:319-322`의 CSS 한 줄 `#structmodal.modal.on { display: flex; }`. ②는 이 단위의 **실제 동작 시험이 찾아낸 기존 결함**이다 — `openStructure()`는 `classList.add("on")`으로 창을 열지만(`:3774`) 표시 규칙은 `.modal.show`뿐이었고 `main.html`의 세 `<style>`에도 링크된 여덟 CSS에도 `.modal.on`이 없어서, **구조화 입력 창은 한 번도 화면에 나온 적이 없다**(`Structured`를 눌러도 아무것도 보이지 않았다). 기존 `report_structure_dom_test.py`는 창을 `evaluate`로 몰아 `innerText`만 읽었으므로 이 사실을 볼 수 없었고, 그 D1~D19 통과는 **렌더링에 대해 아무것도 말하지 않는다**(그 시험들의 측정 범위 안에서는 여전히 유효하다 — 지우지 않는다). 규칙은 이 창 하나에만 걸었고 다른 모달의 `show` 관례·JS 여닫기 규약·스크립트는 건드리지 않았다. 인식기·오디오·마이크·SDK·의존성은 여전히 없다(`api/**`·`report-structure.js`·`report-citation.js`·`report-preview.js`·`config/ohif.js` diff 0, `main.html`의 `<script>` 46개 전부 base와 바이트 동일). 조사 결과 **이미 맞는 것**이 대부분이라 호환 계층은 만들지 않았다: 단축키는 이미 열한 자리에서 `e.isComposing`을 본다, 쓰기 경로에 키 이벤트 의존이 없다, 자동 저장은 20초 **값 폴링**(`main.html:4932-4943`)이라 이벤트를 하나도 내지 않는 입력도 다음 tick에 저장된다, `renderStructure`는 타이핑 중인 `#struct-value-text.value`를 다시 쓰지 않는다, 거절은 값 기반이다. 신탁은 **CDP뿐**이다 — `Input.imeSetComposition`이 Blink의 `InputMethodController`를 실제로 돌리고 `Input.insertText`가 확정하므로 `compositionstart/update/end`와 `input(isComposing=true)`는 브라우저의 것이다. **스크립트로 만든 합성 조합 이벤트는 이 파일에 하나도 없다**(정적 검사가 그것을 건다) — 합성 이벤트는 조합에 대해 아무것도 증명하지 못한 채 조합 이름의 사례를 통과시킨다. 고정 Chromium에 그 전송이 없으면 `composition_source`는 `none`이고 조합 사례 아홉 건은 **건너뛰며 id가 요약에 UNEXECUTED로 찍힌다** — 조용히 초록이 되지 않는다. **DI-04는 관문이 아니라 관측이다**: 자동 저장 한 번이 조합 중인 글을 담아 `reportDirty()`가 거짓이 된 뒤 폴링의 비강제 `loadReport()`가 **바뀌지 않은 출하 핸들러** 위에서 무엇을 하는지 기록하고(쓰기 없음·초안 불변·앞뒤 글자 보존만 단언한다), 그 다음에 **DI-05**가 타이핑 동등성을 단언한다. DI-05가 실패하면 그것은 실제 비호환의 발견이며 DI-04의 기록이 증거다 — 추측성 가드로 덮지 않는다. 점유는 보고서 쓰기와 **다른 카운터**다: 출하된 입력 처리기가 두 글자에서 `POST …/hold`를 내므로 스텁이 `/hold`·`/release`를 `holdCalls`로 갈라 두지 않으면 이 파일의 모든 정확한 `calls.length`가 하나씩 밀린다(구조화 전용 읽기와 같은 부류). 마크업도 **슬라이스**다 — `rbtns`·`redit`·`rfoot2`·바 묶음·세 모달을 `main.html`에서 잘라 올리므로 DI-13은 제품 자신의 바이트를 단언한다. **호스티드 격리 Chromium 14건**(`tests/report_dictation_input_dom_test.py`, measurements 잡의 `report-dictation-input-dom` 단계): DI-00 슬라이스 표지·정지 시점 호출자(`stashReport()`/`loadReport()`)·라우팅·최상위 선택자 전수 확인, DI-01 커서 자리의 확정 조합, DI-02 **IME 없이 친 것·조합·직접 확정** 세 경로의 바이트/캐럿/초안 동일성(한글에는 보낼 키 정의가 없어 `keyboard.type`도 글자마다 `Input.insertText`로 내려간다 — 그래서 이 사례가 실제로 재는 것은 **조합 대 직접 삽입**이다), DI-03 조합 중과 확정 뒤의 자동 저장 본문 두 건, DI-04 관측, DI-05 동등성, DI-06 **강제 다른 값** 대입(제품 계약만 단언하고 조합의 뒤끝과 `#draftbar`는 기록한다), DI-07 남의 예비 판독 잠금(readOnly·안내문·무쓰기), DI-08 조합 중 두 글자에서의 점유 한 건과 확정 뒤 재청구 없음, DI-09 조합이 남긴 캐럿으로 들어가는 구조화 줄과 `보낸 것 = 보이는 것`, DI-10 조합 중 값·캐럿 불변, DI-11 `U+2028` 거절 문면, DI-12 **512 UTF-8 바이트** 경계(170자 510바이트 수락 / 171자 513바이트 거절 — 한도는 `maxlength`의 UTF-16 단위가 아니다), DI-13 `Dictate`의 id·비활성·문구·툴팁 정확 일치와 세 파일 전수 grep(`SpeechRecognition`·`MediaRecorder`·`getUserMedia`·`mediaDevices` 없음). 구조화 네 건(DI-09~12)은 **제품이 스스로 만드는 `Structured` 단추를 실제로 눌러** 들어가고(`main.html:3900-3908`), 창이 `on` 클래스를 갖는 것이 아니라 **계산된 `display`가 `flex`이고 `.box`가 실제 넓이를 차지하는 것**을 확인한 뒤에야 `select_option`·`fill`·`click` 같은 **가시·조작 가능 컨트롤**로만 움직인다 — `evaluate`로 렌더링을 우회하지 않는다. 표시 규칙은 **제품의 것**이며 하네스는 CSS 슬라이스로 그것을 그대로 들어 올린다(하네스가 규칙을 주입하면 제품이 보여줄 수 없는 창을 통과시키게 된다 — 정적 검사가 그 주입을 금지한다). **관문은 fail-closed다**: 시험이 전부 통과하더라도 `composition_source`가 `cdp`가 아니거나 조합 사례가 하나라도 건너뛰어졌으면 `R14-GATE FAIL` 한 줄을 찍고 **exit 1**이다 — CDP가 없다는 사실이 초록이 되는 길은 없다. **호스트에서 실제로 실행해 통과한 것**: `python tests/report_dictation_input_dom_test.py --static-only`(표지 유일성·최상위 선택자 전수·호출자 두 자리·툴팁·사례 14건·합성 조합 이벤트 부재·**출하 CSS 규칙이 슬라이스 안에 정확히 한 번**·하네스 무주입·**fail-closed 관문 판정표 5건**), 생성한 하네스 `<script>` 세 덩어리의 `node --check`, base `d366e7e` 대비 **세 슬라이스와 `<script>` 46개 전부 바이트 동일** 증명, 그리고 (워크플로가 바뀐 앞선 head에서) `python tests/measurement_ci_test.py` 66건. **아직 한 번도 실행되지 않은 것: DOM 14건 전부 — 첫 실행은 호스티드 후보 CI다.** 브라우저·CDP는 로컬에서 돌리지 않았으므로 `Input.imeSetComposition`의 가용성과 실제 조합 동작은 **미검증**이다. 돌연변이는 **더하지 않았다**(새 제품 로직이 없다). 다만 `main.html`의 blob이 바뀌었으므로 `report_cursor_insert_mutants.py`와 `report_structure_mutants.py`의 **main 쪽 돌연변이 해시를 다시 고정하고 한 번 다시 돌려야 한다** — 앵커와 `expect` 문구는 그대로다(고친 줄이 앵커가 아니다). `candidate_ci.py`·`execution_selection_test.py`는 건드리지 않았고 `invariants_live` 71·worklist 15도 그대로다. **이 단위는 R14를 닫지 않는다** — 동작하는 textarea는 검증된 받아쓰기가 아니다. 엔진 선택·환자 음성의 망 외부 전송 근거·기기/라이선스 비용·판독 워크스테이션 설치·임상 전사 정확도 판정은 전부 열려 있으며 **인식기를 고르거나 켜는 일에만** 적용되는 조건이지 일반 개발 관문이 아니다. IF-A25와 3단계도 그대로 열려 있다.

프론트엔드·UI/UX와 필수 API를 통합한 뒤 의사에게 평가 후보를 전달한다. 전달 전 중간 버전은 사용자가 사용하지 않는다. 전달 뒤에는 의사 피드백과 단일 병원 도입용 백엔드 준비를 병행하되, 평가 버전·데이터를 안정적으로 유지하고 백엔드는 별도 브랜치·환경에서 작업한다. 의사 재확인과 운영 검증 후 배포하며 병원 간 Connect 확장은 보류한다.

| 시점 또는 변경 | 실행할 검증 |
|---|---|
| 전달 전 개발 중의 업무 구현·수정 | 변경 기능과 직접 영향을 받는 회귀, 필요한 빌드·구문 검사 |
| 인증·권한·판독 상태 전이·원본/저장 보존·DB/migration 변경 | 해당 실패·보존 경계를 즉시 검사. 공유 경로 변경, 영향 범위 불명확 또는 교차 기능 실패 시 69→14를 포함해 확대 |
| 다른 변경이라도 공유 경로·영향 범위 불명확·교차 기능 실패가 있는 경우 | 영향을 확인할 수 있도록 69→14를 포함한 넓은 회귀 실행 |
| 의사 최초 전달·평가 후보 교체·실제 배포 후보 확정 | 같은 최종 SHA에서 69→14 순차 실행, 누적 기능 통합·필요한 정확도 시험, 독립 최종 검토 차단 0, 실제 CI |
| 문서만 변경 | 문서 대조·링크·diff. 일상 상태/증거 요약에는 별도 독립 검토를 두지 않고, 안전·권한·제품 경계·최종 후보 계약 문서만 독립 문서 검토(제품 AGENTS 기준). 제품 재기동·제품 시험·새 제품 태그 불필요 |

아래 카탈로그의 “최종”, “필수 69→14”, “mandatory”는 위 후보 확정 시점과 검증 확대 조건에 적용한다. 매 중간 커밋이나 턴 종료마다 모든 시험·전량 독립 검토·제품 태그를 반복하라는 뜻이 아니다. 중간 커밋은 즉시 push해 이력을 보존하고, 제품 릴리스와 구분한다. 변경 범위와 실제 수행·실패·미검증을 남기고 완료한 검증을 근거 없이 반복하지 않는다.

시험 구현·단언·불변조건을 삭제하거나 약화하지 않는다. 이 문서는 실행 시점을 조정하며 CI 구조·트리거를 변경하지 않는다. 자동으로 실행되는 기존 CI 결과는 그대로 확인한다. 의사 확인과 운영 검증은 자동시험 통과와 별도 조건이다.

## 기능별 시험 카탈로그

D-MEASURE2 비교 중 미저장 작업 회복: `node --test tests/viewer_recovery_test.cjs` (18개),
`python tests/e2e/test_viewer_recovery.py` (6개).
REQ-D04-MANUAL-CONTINUE → RISK-D04-LOSS → TEST-D04-HELD-RECOVERY: 실제 주석 생성 이벤트에서 이력 scan 전에도 Job/이탈 가드가 모두 미저장 상태를 감지하는지 검사한다. 기존 삭제·저장·보관 수정 회귀의 경고 해제 조건도 유지한다.
빠른 시험은 실제 `config/ohif.js` 확장을 VM에서 mount하고 DOM/HTTP 경계만 대체한다.
A1(원문 §2-5)의 검사 왕복·늦은 응답·동일 UUID, A2(6)의 busy 경합,
C1(7)의 서버판 채택/취소, C2(9)의 종료 후 두 SR command 안내,
C5(4)의 검사403 격리·재인가·다른 검사 보관본과 실제401 정리를 실행한다.
삭제한 새 표식의 재생성 방지·늦은 영수증과 다른 편집의 공존·주체 변경 폐기,
두 SR command의 계산 전 기하 변경 거절과 패널의 관찰 사이 상태 갱신도 검사한다.
빠른 시험은 validate CI의 컨테이너 없는 명시 step으로 등록했다.
브라우저 시험은 실제 비교 CT·측정 좌표 재열림·숨김 충돌과 커밋 후 주입한403 응답 복구를 확인한다.
실제 서버의 replay 검증 중 권한 변경은 별도 `viewer_readback_fault.cjs`에서 검사한다.
B1(13)의 실스택 실행은 validate의 별도 `measurements` job과 `tests/measurement_ci.py`에 등록한다.
GitHub 호스팅의 빈 Docker runner에서만 임시 비밀·합성 CT·DB/Keycloak/Orthanc/API/BFF/고정 뷰어를 만들며,
측정 job의 API는 실제 `development` target/소스 mount로 컴파일한다. 기존 `runtime` job의 production image 검증과 구분한다.
기존 readback/panel/held/manual-SR와 viewer-api, 재확인/세션회복/calibration 시험을 순서대로 실제 실행한다.
두 fault.cjs는 해당 E2E가 소유 fixture와 실제 컴파일 서비스를 통해 실행한다. 등록과 실제 CI 성공은 구분한다.
수동 `Focused integration` workflow는 같은 빈 GitHub-hosted runner와 실행 가드를 재사용한다. 열두 선택지는 `output-integration`, `identity-fields`, `vr-resize-probe`, `hanging-protocols`, `dicom-pdf`, `image-thumbnails`, `display-scope`, `study-arrivals`, `images-only`, `image-text`, `three-d-cursor-accuracy`, `three-d-cursor-wiring`다. 기본 `output-integration` 선택은 비교 판독문 6개, Job 판독문 4개, 편집기 비교 출력 4개를 이 순서로 실행한다. `identity-fields` 선택은 표시 설정 API 17개, 위치 API 2개, 필드 API 2개, 실제 위치 2개, 실제 필드 2개를 이 순서로 실행하며 프로필별 정화 로그를 분리한다. runner의 `--profile` 허용 목록은 이 열두 선택지에 자동 `measurements`, `volume-rendering`을 더한 열네 프로필을 검사한다. `three-d-cursor-accuracy`와 `three-d-cursor-wiring`은 dispatch 전용이라 validate CI 이름 목록에는 없다. `three-d-cursor-wiring`은 `config/ohif.js`를 통한 로드·활성화·해제·재진입(플래그 ON은 설정 응답 가로채기, 플래그 OFF는 평가 빌드 그대로)을 3건으로 실행하며, 모듈을 주입하지 않는다. 이는 실제 실행 경로의 등록 설명이며 실행 성공 근거가 아니다. 로컬 원본 fixture에서 실행하지 않는다.
세션 내 보관본은 브라우저 저장소에 쓰지 않으며 명시적 재개 전에 현재 검사 접근을 조회한다.
뷰어 모드 종료·로그아웃·로그인 주체 변경 시 폐기하며 페이지 이탈/Job 복구 경고에 포함한다.
후속 A3/A4 빠른 시험은 같은 revision의 검증 실패와 분리된 편집문, 분리된 이전 저장 handler 거절,
편집 진입만으로 관문 해제 불가·실제 현재 좌표 계산 후 회복을 추가한다.

D-MEASURE2 원본 재확인·재측정: `python tests/e2e/test_measurement_recheck.py` (2개).
A3(11)은 소유 합성 CT 한 장만 같은 SOP의 다른 pixel bytes로 교체해 실제409/list unverified를 확인한다.
기존 수정·revision 보존, 저장 반복 차단, 새 뷰어에서 실제 새 pixel 읽기·새 측정 저장을 검사하고 합성 원본 bytes를 복원한다.
A4(12)는 기존 baseline 불일치에서 편집→계산 전 차단→native 재계산 후 캔버스/패널/CSV 및 두 SR command 회복을 확인한다.
SR 경로가 먼저 측정을 저장하는 기존 manualSr 경계도 유지한다.

D-MEASURE2 원본 실패 관측: production image에서 `node --test /tests/viewer_source_test.cjs` (2개).
B2(10)의 실제 컴파일된 viewerJson/reportPreviewStudy에 합성 localhost HTTP401/404/503·크기·UTF8/JSON·취소/5초 마감을 주입한다.
고정 분류만의 경고, 민감값 부재·반복 제한과 verifyMeasurements의 실제3초/병렬4 상한·digest 음성/양성·최종권한 검사를 실행한다.
validate CI의 production image에 별도 step으로 등록했다. DB·Orthanc 서비스가 없는 시험이며 컨테이너 없는 시험으로 세지 않는다.
B3(14)의 실제 Prisma list 음성/양성·항목/이력/영수증/예산/감사 불변은 `test_measurement_readback.py`가 호출하는
`viewer_readback_fault.cjs`에서도 검사한다.
C4a/b(원문2/3)는 같은 뒤쪽 SOP가 반복 목록에서 굶는 결함 주입 후 비작성자의 `recheck=<item UUID>` 읽기 회복,
잘못된/복수 query와 타 기관 거절, 최초 쓰기·replay의3초 원본 마감과 영수증/이력/감사 불변을 추가한다.
목록 정렬·페이지 cursor·병렬4 상한은 유지한다. 재확인은 쓰기가 아니며 현재 접근권을 다시 검사한다.
A5는 `test_measurement_calibration.py`의 실제 일반 CT 열기/재열기/프레임 왕복 이벤트 관찰과,
별도로 명시 호출한 고정 번들 calibration handler의 캐시 교체 후 미저장 측정 회복을 구분한다.
자연 이벤트가 관찰됐다고 자연 작업 소실까지 재현했다고 쓰지 않는다. 빠른 시험도 캐시 교체 후 재장착과
기존 값의 신선도 불인정, C3의 두 SR command 원인 항목/사유와 선택 유지, 항목 단위 재확인 요청을 단언한다.

판독문·키 이미지 출력: `python tests/e2e/test_report_preview.py` (7개).
같은 조회 시점의 저장본/승인 정보·환자 오버레이·키 revision과 기관/P/역할·타 작성자 초안 제외를 확인한다.
실제 미리보기/인쇄 창에서 미확정 편집문을 구분하고 다중 프레임 PNG를 원본 바이트와 대조한다.
이미지 실패·원본 digest 변경·키 숨김·대형 PNG·지연 취소/검사 전환·세션 종료·팝업 차단과
판독/초안/키 이력·원본 불변을 검사한다. 실제 Chromium PDF를 산출하며 물리 프린터 시험은 아니다.
관련 회귀는 업무 화면14와 신규 진입점/권한 검사다. 전체 출력 템플릿·film/true-size·전체 UIUX 완료를 뜻하지 않는다.

직접 작성 측정 SR: `python tests/e2e/test_manual_sr.py` (7개).
실제 길이·각도·타원 ROI의 Part10 다운로드와 서버의 원본 독립 계산을 pydicom/NumPy로 대조한다.
다운로드만으로 Orthanc에 쓰지 않으며 별도 저장은 동일 bytes/SOP를 사용한다. 새 로그인 재열람,
기관/작성자/P/revision/숨김·범용 STOW 거절, 감사 실패 후 측정/접근 변경과 백그라운드 영수증 복구,
네트워크 저장 중 검사 잠금 해제, 임시 파일 24시간 만료/한도 회복·UUID tombstone,
원본 조회 전체 10초 제한/실제 취소, 열린 시리즈의 문서 선택·늦은 load/이탈을 검사한다.
전송 지연은 시험 프로세스 또는 브라우저에만 주입한다. 수신 SR 재계산/편집은 허용하지 않는다.
DB 복원은 `python tests/viewer_migration_test.py ViewerMigration.test_03_real_dump_restore_every_row_revision_replay_budget_and_fk`로
24개 migration·37개 표·49개 합성 행(소견 `Finding`/`FindingRevision` 3행 포함)의 원문/바이트·pending intent·만료 tombstone까지 대조한다.
관련 회귀는 measurement-panel/sr-provenance/viewer-api, DB 공유 경로 변경은69→14까지 확인한다.

소견 기록/정확한 영상 이동(S2-A): `python tests/finding_api_test.py` (13개, 8~10은 S2-B2 서버, 11·12는 S2-L, 13은 S3-U2a 인용 백엔드)와 `python tests/e2e/test_finding_navigation.py` (8개, 7은 S2-B2 화면, 8은 S2-C).
저장한 표식 1~8개를 같은 검사 안에서 소견에 연결하고 서버가 식별·판·수치·digest를 복사한다. 클라이언트가 보낸
수치/종류/digest 거절, 같은 요청 ID 재시도의 동일 결과, 다른 본문 409, 동시 편집 하나만 200, 부모 잠금 대기 중 바뀐 표식판의
409, 잠금 지연 503 후 재시도, 검사당 256개·누적 4096판·16MiB와 소견당 1000판 한도, 기관/P 지정/작성자/서비스 토큰 경계,
표식 수정→Revised(수치는 저장 당시 값)·숨김→Hidden·미존재→Missing, 본문 수정 시 기존 사본 바이트 유지, 명시적 Refresh Link의 새 판,
승인 후 소견 편집이 판독 행을 바꾸지 않음을 검사한다. 브라우저 시험은 새 로그인 뒤 목록·Go to Image가 실제 저장 SOP/프레임을
`getCurrentImageId`로 증명하고 표식 강조, 응답 유실 재시도, 두 창 충돌, 같은 문서의 mode 재진입(A→B→A) 뒤 늦은 목록 폐기,
다른 검사 소견의 `scope` 거절과 URL 불변, 세션 종료 후 `ended`를 확인한다. 순수 시험 `node --test tests/finding_link_model_test.cjs`는 출하되는
`config/ohif.js`의 `kinViewerNavigateTo`와 `finding-link-model.js`의 저장소를 그대로 실행한다. MPR/볼륨 화면은 `viewport-unsupported`로
거절하며 다른 검사·워크리스트 연결(S2-B)과 판독문 연결(3단계)은 이 시험 범위 밖이다.
소견 작성 보호(S2-B 첫 수정): 작성·대기 중 소견은 검사 전환·403·mode exit에서 계정·검사별 사본으로 보관되고, 인증된 해당 검사 목록 뒤에만
복원되며 로그아웃·401·계정 변경에서 폐기된다. 순수 시험은 같은 요청 본문 재시도, 늦은 응답의 사본 불변, 한 행 수렴, 뷰어 전체
dirty/busy·이탈 경고와 표식 전용 `kinViewerHistoryHasUnsaved` 유지, 판독 작업공간·창 재사용·Hanging Protocol·칸 병합 판정을
출하 코드로 확인한다. 브라우저 시험 5·6은 Next Study·창 재사용/닫기·이탈 경고의 차단과 깨끗한 화면의 통과, 비교 검사 영상 칸
활성화 동안 작성·대기 소견의 유지(보관하지 않음), 403·mode exit 뒤 복원과 로그아웃 폐기를 확인한다. 저장 작업(Job)의 다른 검사 복원 차단은 원문 위치 확인만 하며 브라우저로 실행하지 않았다.
영상 소견 목록·이동(S2-B1): `node --test tests/finding_command_test.cjs` (45개, 8개는 S2-B2, 2개는 S2-V, 8개는 S2-C·S2-L, 2개는 S3-U2b의 `Insert into Report` 인계와 거절; `finding_link_model_test.cjs`가 같은 프로세스에서 함께 실행)와
`python tests/e2e/test_finding_worklist.py` (6개, 4는 S2-B2, 5는 S2-L, 6은 S3-U2b 실스택 인용; 기존 `measurements` 프로필의 19번째 suite, suite 수·per-suite 상한·540초 deadline 모두 그대로). 워크리스트·통합 작업공간의 Image Findings는 선택한
판독 대상 검사의 기존 소견 목록 읽기만 하며, Go to Image는 이미 그 검사를 표시하는 통합 작업공간 영상 또는 연결된 영상 창 하나에만 보낸다.
순수 시험은 대상 선택(여러 창·미연결·소유자·로딩), 호출 전 거절, 호출 시점의 함수 조회, 대기 후 계정·선택·문서·범위 확인, 15초 제한,
최신 명령만의 알림과 A-B-A·403/404/503·세션 종료 목록 폐기를 출하 코드와 별도 vm 영상 문서로 확인한다. Retry Go to Image는 처음 누른
원본(목록 세대·소견 id/개정·원본 위치·원본 항목과 영상 식별)이 다시 읽은 목록에 그대로 있을 때만 그 원본으로 보내고, 순서 변경·교체·개정·삭제면
호출 없이 list-changed로 거절한다(다른 원본으로 바꿔 보내지 않음). 브라우저 시험은 실제 영상의
`getCurrentImageId`로 도착을 증명하고, 거절·대체된 명령은 성공 문구 없음·URL 검사 범위·DB 행 바이트 동일만 확인한다(영상 화면은 이미 이동했을 수 있음).
MPR/볼륨 화면 거절은 영상 쪽 순수 시험 범위이며 비교 검사 원본(S2-B2)과 판독문 연결은 포함하지 않는다.
소견 수치 이름·단위(S2-V): 뷰어 Findings와 워크리스트 Image Findings는 서버가 복사한 수치를 다시 계산하지 않고 이름·단위와 함께 보인다(길이 `12.3 mm`, 각도 `12.3°`,
타원 `면적 … mm² · 평균 … HU · 최소 … HU · 최대 … HU · 화소 수 …`). 순서는 고정 계산기(`config/ohif.js` sample)를, 문구는 `viewer-job-print.js`를 따르며
인쇄의 반올림은 달라 같은 값의 소수 자릿수가 다를 수 있다(인쇄 코드는 바꾸지 않음). `valueText(kind, calculator, values, provenance)`는 출처가 필수다.
서버 사본(소견 원본·비교 검사 viewer-items)은 계산기가 정확히 `kin-native-manual-v1`일 때만, 뷰어 Measurements의 저장 표식은 계산기가 없거나 같을 때만 단위를 붙인다.
그 밖의 출처·계산기, 종류별 개수(1/1/5) 불일치, 유한수가 아니거나 1e21 이상인 값, 음이 아닌 안전 정수가 아닌 화소 수는 원본 전체를
`수치(단위 미확인): a / b`로 보인다. 반올림은 `Math.round(n*10)/10` 후 한 자리이며 `-0`은 `0.0`, 화소 수는 그대로 쓴다. 계산기는 표시에만 쓰며
요청 본문·초안·보관 사본·이동 대상에 들어가지 않는다. Revised 연결은 연결 당시 값을, 이력 줄은 표식 개수만, 접근할 수 없는 비교 검사는 수치 없이 보인다.
순수 시험은 `finding_link_model_test.cjs` 70개 중 7개(형식 행렬, comparisonHead, 요청 바이트, 출하 Findings 화면 3개, 저장 표식 값 출처)와 위 2개다.
기존 `measurements` 프로필 안의 `test_finding_worklist.py` 1·4와 `test_finding_navigation.py` 1은 API로 넣은 길이·축 정렬 타원의 목록·뷰어 표시,
그린 길이의 선택지와 저장 사본의 `mm`, 비교 검사 회수 뒤 비교 길이 수치의 부재를 확인한다(suite 수·시간 한도 변경 없음). 3D 위치 연결(D1)과 특성(D2)은 이 범위 밖이다.
비교 검사 원본 서버(S2-B2 B2-S): `finding_api_test.py` 8~10(기존 `measurements` 프로필 17번째 suite 안)과 `finding_input_test.cjs`의
`comparisonStudies`. 검사 X의 소견은 같은 비어 있지 않은 PatientID·같은 기관이며 둘 다 현재 읽을 수 있는 비교 검사 P 하나의 표식을
평생 하나만 연결한다(다른 P는 409 `FINDING_COMPARISON_STUDY`, 새 소견으로 기록). 모든 개정의 계보에 읽을 수 없는 검사가 있으면 목록·이력·
재요청에서 없는 소견과 같고 수정·숨김·복원도 404이며, 거르기는 LIMIT 전에 해 페이지가 차고 cursor에 보이지 않는 id가 없다. 시험은 X만 허용된
독자의 누락 없는 1개 페이지·이웃 uuid cursor, P의 RS=P 비지정·기관 이탈·원격 전용, 권한 회수 중 재요청·편집·숨김·복원 404와 X/P 행 바이트
불변, 재허용 후 바이트 동일 이력과 동결 사본 유지, 다른 환자 400·다른 기관 403·읽을 수 없는 검사 표식=임의 id(앞뒤 순서 포함), 환자
메타데이터 규칙, 두 행 정렬 잠금(낮은 행 대기 중 높은 행 NOWAIT 성공, 대칭 쓰기·ViewerJob 동시 완료), 높은 행 잠금 503 후 재시도, P 잠금 대기 중
바뀐 표식판 409, 잠금 대기 중 P가 RS=P 비지정으로 바뀐 새 연결·재요청·숨김의 404와 무기록, 쓰기가 잡은 접근 조건 공유 잠금 뒤에서
기다린 제한(쓰기가 먼저 확정되고 그 뒤 재요청·편집 404)과 먼저 확정된 제한을 공유 잠금 대기 뒤에 읽은 숨김·새 연결의 404(pg_locks·
pg_stat_activity로 대기 확인 후 해제), 읽을 수 없는 행 포함 X 전체 한도(본문은 code/message뿐)와 256개·1000판·거의 16MiB 목록/이력 응답을 확인한다. 기존
시험 2의 다른 환자 검사 표식은 B2 계약에 따라 404 대신 400이다.
비교 검사 원본 화면(S2-B2 B2-U): 서버·경로·권한 변경 없이 기존 API만 쓴다. 비교 화면(URL의 검사 X,P)의 Findings는 첫 검사 X에 고정되어
P 영상 칸을 활성화해도 X의 소견·작성·대기 요청 본문을 보관하거나 버리지 않으며, 실제 기준 검사·계정·세션 변화만 기존 보관·격리를 쓴다.
P 표식은 `GET /studies/P/viewer-items`의 저장·비숨김 판에서만 고르고 `{itemId, revision}`만 보낸다(소견 하나에 비교 검사 하나,
다른 비교 검사를 이미 가진 소견은 고를 수 없음). P 목록 403/404는 목록·표식을 지우고 X 목록을 한 번 다시 읽어 그 검사를 연결한 소견을
화면에서 빼며, 작성 중이던 소견은 작성자 제목·본문과 X 연결만 새 초안으로 남긴다. 400·403·404·409(`FINDING_COMPARISON_STUDY`)·한도
문구는 초안을 유지하고, 한도 문구는 보이지 않는 소견도 한도에 들어간다고 알린다. P 원본 Go to Image는 그 뷰어에서 P를 표시하는 영상 칸이
정확히 하나일 때만 그 칸을 활성화(`kinViewerHistoryActivate`, 0개 `viewport-missing`·여러 개 `viewport-ambiguous`)하고 기존 15초 안에서
그 칸의 기록이 P를 불러온 뒤 한 번만 이동하며, 성공은 viewer의 ok와 같은 세대·같은 칸·정확한 series/SOP/frame 재확인이 모두 맞을 때뿐이다.
시간 초과·거절은 이동하지 않고 칸을 되돌리지 않으며 칸 선택이 바뀌었을 수 있다고 알린다. 워크리스트는 X와 P를 함께 표시하는 화면에만
보내고(없으면 `comparison-viewer`, 자동 열기 없음) Retry는 고정한 P 원본만 다시 보낸다. 순수 시험은 `config/ohif.js`의 활성화 함수 조각,
`crossNavigate`의 지연·거절·시간 초과·A-B-A·계정·재확인, 고정 저장소의 P 활성화 유지·늦은/대체 P 목록 폐기·회수·오류 문구, 두 영상 칸 vm 뷰어의
실제 기록·Findings 연결과 워크리스트 대상 선택·명령·vm 문서 어댑터를 실행한다. 브라우저 시험(탐색 7, 워크리스트 4)은 같은 환자 합성 CT 두 개의
hpCompare에서 X 고정·초안/대기 본문 유지·P 연결 저장, X 활성 상태의 P SOP/frame 도착(영상 id·기록 재확인·픽셀 막대 폭), P 기록 다시 읽기
503 뒤 busy와 고정 원본 Retry, P 기관 이탈(합성 경계 변경 후 복원) 뒤 P 행·문구 부재를 확인하고 JSON·화면을 `measurement-ci` 산출물에 남긴다.
소견 특성·저장 작업 위치(S2-C·S2-L): 새 migration·경로·의존성 없이 소견 원본에 저장 작업(`ViewerJob`) 참조 `{jobId, revision, markId?}`를
schemaVersion 2 요청에서만 받는다. 서버는 작업 판·검사 조합(1~2개, 첫 검사가 작업 검사)·제목·작성자·Snapshot 판(1~15)·3D 표식(식별·라벨·점·
원본 volume series/SOP/digest/SOP 수)·FrameOfReferenceUID를 복사하고 작업 원문은 바꾸지 않는다. 다른 검사 기준 작업은 접근 확인·잠금·Orthanc
읽기 없이 없는 id와 같은 404이고, 검사 조합 전체의 접근 확인 뒤에만 판·표식을 보고(숨김·판 불일치 409, 표식 없음 400 `FINDING_JOB_MARK`,
판 밖 400 `FINDING_JOB_VERSION`), FoR는 작업당 한 번·20초 안에 읽는다(불일치 409, 쓰기 시점 누락은 재시도 409). 특성은 사용자가 직접 입력하는
자유 문자열(1000 code point, 브라우저 `maxLength`는 UTF-16 단위)이며 판독문에 들어가지 않고, 요청 본문 한도는 60640바이트다.
판 협상: 새 화면은 `X-KIN-Finding-Schema: 2`를 보내고 서버는 모든 소견 응답에 같은 헤더를 붙인다. 헤더 없는 옛 화면은 v2 행이 있는 페이지에서
409 `FINDING_CLIENT_OUTDATED`, 헤더 없는 성공 응답(옛 API)을 받은 새 화면은 저장하지 않고 읽기만 한다. v1 요청의 v2 head 수정·숨김은 409
`FINDING_SCHEMA_VERSION`, v2 수정은 v1 소견을 v2로 올리고 숨김·복원은 head 판과 내용을 유지한다. 기존 v1 재요청·이력 바이트는 그대로다.
모양이 틀린 작업 계보 행(배열 길이·문자열·중복·첫 검사·투영 불일치)은 읽을 수 없는 검사로 취급한다(합성 행 시험, 운영 행 수정 없음).
화면: 뷰어 Findings의 `Link 3D Point`·`Link Saved View`, `Go to 3D Point`·`Open Saved View`는 저장 작업 버튼과 같은 복원·이동 함수를 쓴다.
복원 전 작업을 다시 읽고(GET 409는 거절) 적용 뒤 읽기 확인과 동결된 점·FoR 비교가 맞을 때만 복원으로 알린다. 결과는 거절·되돌림·화면
미확인·복원(점 이동 실패 포함)·새 화면 계속이며, 한 복원은 180초 기한(적용 60초, 요청 120초 중단, 준비 대기 20초)을 갖고 호출 쪽 270초 뒤에도
적용이 끝날 때까지 다른 이동을 막는다. 검사 조합이 다른 작업은 새 화면(URL `kinFinding*`와 한 번 쓰는 sessionStorage 표시)에서 입력 없이 한 번만
복원하고 새로고침은 거절한다. Go to Image 도착 문구는 현재 뷰어 소견의 판·숨김·작성 중 여부를 알린다(2D만, 3D 커서 없음). 워크리스트는 특성·작업 줄을
보이고 작업 복원은 그 검사 조합을 정확히 표시하는 창에만 보낸다. 목록 읽기는 헤더를 붙인 같은 출처 GET이며 401은 기존 `app.api`로 넘긴다.
위치 결과의 기계 판독 값(`locationResult`, 뷰어 문구의 `data-kin-location-result`, 워크리스트 `data-result`)은 요청한 3D 표식에 도달했을 때만
`ok`다. 화면은 복원했지만 표식 이동이 실패하면 복원 결과(state `restored`, point `failed`, 뷰어의 사유)와 문구는 그대로 두고 `point-failed`로
표시하며 전체 화면을 되돌렸다고 하지 않고 Retry도 두지 않는다. 확인된 되돌림은 `rolled-back`이다. `test_location_02`는 화면을 바꾼 v6 적용의
3D 표식 단계에서 기존 `kinMprMarks.restore`를 한 번만 실패시키고(시험 안에서만 감싸고 finally에서 원래대로 되돌림, 제품 시험용 경로 없음)
`rolled-back` 문구, 새 viewport에 다시 세운 이전 화면(볼륨·활성 평면·투영·카메라 1e-6, 저장 화면과 6 mm 차이)과 표식, 점 이동 없음,
작업·소견·판독 행 불변을 확인한다. 이 호스트 시험은 로컬에서 실행하지 않았다.
순수 시험은 `finding_input_test.cjs` 11개 중 6개, `finding_link_model_test.cjs` 70개 중 12개, `finding_command_test.cjs` 45개 중 8개,
`viewer_volume_job_capture_test.cjs` 51개 중 8개(위치 복원 7, `goTo` 1)와 `measurement_ci_test.py`의 음성 선택 1개다. 브라우저·DB 시험은
`finding_api_test.py` 11·12, `test_finding_navigation.py` 8, `test_finding_worklist.py` 5(기존 `measurements` 19개 suite·540초 한도 그대로)와
새 `python tests/e2e/test_finding_locations.py` (3개, `VolumeMarksE2E` 상속, `test_location_`만)이다. 새 모듈은 기존 `volume-path` 프로필의
세 번째 suite `ci-finding-location`(360초)이며 (420+35)+(300+35)+(360+35)=1185초에 예비 150초를 더해 1335≤1500초다.

외부 SR 출처/원문 표식: `python tests/e2e/test_sr_provenance.py` (5개).
실제 C-STORE TID1500 SR의 NUM·단위와 출처를 native SR 캔버스/패널에서 대조한다.
직접 그린 측정과 분리하고 SR hydration을 거절해 로컬 계산·저장 이력에 섞이지 않게 한다.
같은 tracking UID를 쓰는 다른 문서·같은 시리즈의 최신 문서, 표시 전환·확대·직접 측정 저장,
원문 0/소수/지수 값, 세션 종료·접근 실패 시 표식 제거와 기존 원본/판독 보존을 확인한다.
숫자는 DICOMweb/dcmjs가 전달한 값이며 DS 원본 바이트의 문자 표기 보존을 뜻하지 않는다.
관련 회귀는 sr-reader/manual-measurements/measurement-panel이다. 전체 SR 편집/반출 완료 시험은 아니다.

보관 수정 취소/회복: `python tests/e2e/test_held_measurements.py` (6개).
실제 수동 길이의 숨김 충돌 뒤 내용 미리보기·확인/취소·로컬 버리기를 검사한다.
버리기는 서버 item/revision/request/budget 전체 필드를 바꾸지 않으며 다른 미저장 항목을 보호한다.
실제 멈춘 HTTP 요청/응답 유실에서 이전 DOM handler도 버리기를 거절하고 동일 UUID 재시도를 유지한다.
다른 프레임의 원본 재확인 실패/회복·이동·저장, 반복 숨김/복원 충돌의 최초 보관 내용 유지,
버리기 후 이미 조회한 최신판 채택과 숨김 수용 직후 실제 SVG 표식 제거를 확인한다.
관련 회귀는 measurement-readback/history/measurement-panel이며 전체 후보 검증과 구분한다.

추적 측정 패널/수치 내보내기: `python tests/e2e/test_measurement_panel.py` (4개).
실제 OHIF 추적 행과 CSV 다운로드에서 기준 불일치·낡은 기하·지원 밖 보정은
재확인 필요로 표시하고 수치를 제외하며, 재계산 후 현재 수치를 회복한다.
이미 잡아 둔 CSV 함수/SR 선택도 호출 시점에 재검사한다. 실제 서버 SR 준비/다운로드의
길이·각도·ROI 면적을 독립 계산값과 대조하며 다운로드만으로 실제 Orthanc SR을 추가하지 않는다.
미검증 SR 생성/저장 거절, 세션 종료 후 과거 함수 거절과 모드 종료 시 관문 복원을 검사한다.
외부 SR 원문 표시와 실제 반출/저장 지원 전체를 이 시험으로 완료 처리하지 않는다.

측정 저장 응답/목록 복구: `python tests/e2e/test_measurement_readback.py` (4개).
실제 BFF/OHIF에서 저장 응답 유실 후 같은 UUID 재시도, SVG 수치 유지와
미검증 응답의 저장 완료/재확인 안내·표식 보류·새로고침 복구를 검사한다.
숨김 충돌 뒤 실제 드래그한 좌표·새 baseline 복원, 보관한 미저장 수정의 이탈 경고도 확인한다.
별도 Node 프로세스의 실제 제품 서비스/Prisma/합성 Orthanc를 사용해 SOP 조회 재사용,
개별 실패, 최대4개 병렬/전체3초 제한, 대기 요청과 실제 HTTP 응답 본문 취소,
replay digest 불일치/원본 장애, 조회 중 P/기관 권한 변경 거절과 중복 쓰기0을 확인한다.
전송 결함은 시험 프로세스에만 주입하며 기존 원본·DB 행은 바꾸지 않는다.
추적 측정 패널/CSV/SR 내보내기의 수치 관문은 위 `test_measurement_panel.py`에서 별도로 검사한다.

저장한 비교 영상 출력: `python tests/e2e/test_viewer_job_print.py`.
Job v2에 각 canvas의 화소 크기를 보존하고 현재 작업공간을 움직이지 않는 별도 native viewport에서
새로 읽은 원본으로 저장 W/L·camera를 재현한다. 실제 전체 화소/PDF 영상 일치, 다른 화면 크기와
배율·signed/rescale/비정방 화소·VOI, 빈 셀·미저장 입력·v1 호환/상한·원본 교체·권한/숨김/세션·실패 복구를 검사한다.
출력 파일404/잘못된 export 이후 기존 저장·복원 유지와 크기 상한 안내/입력 보존·정상 재시도도 검사한다.
v2 출력은 주석 미포함·실제 크기 아님이며 과거 주석 revision 동결을 대신하지 않는다.
시험 소유 합성 원본만 바이트 대조 후 교체/복원하고 기존 Job 정리 경로를 사용한다.

저장 주석 포함 출력: `python tests/e2e/test_viewer_job_annotations.py` (10개).
명시적 새 v3 저장은 선택 CT SOP의 서버 저장 화살표/길이/각도/ROI 이력을 고정한다.
이후 편집·숨김·추가/UUID 재시도, 범위·권한 잠금 경쟁·64개/256KiB 한도,
fresh 원본 교체 거절과 문제 주석 안내/영상만 저장/원본 복구를 검사한다.
고정 native 수치 재확인과 위조 baseline 거절, 변환/반전·DPR2/1.25 주석 위치,
현재 측정 집합 보존, 빈 셀/긴 주석과 실제 PDF의 화소·페이지 식별을 대조한다.
응답 형식 결함의 전체 거절·캐시 여유 부족 시 기존 영상 보존/재시도,
ROI 누적2M 후보 화소 한도·native 계산 예외 뒤 정적 누산기 복원도 확인한다.
원본 digest가 바뀐 기존 측정은 숨김/편집도 거절하므로 원본 복구 또는 해당 영상 제외가 필요하다.
출력은 실제 크기가 아니며 과거 주석을 현재 편집 표식으로 복원하는 UI는 잔여다.

비교 작업 저장/재열람: `python tests/e2e/test_viewer_jobs.py` (6개 업무/경계 시험).
일반 CT 현재/과거 검사·원 SOP·1/2/4셀·W/L·camera·활성 셀을 서버에 저장하고
새 브라우저에서 실제 canvas hash·좌표·프레임 표시·다음 스크롤을 대조한다.
미저장 표식 차단, 저장한 최신 화살표/키 이미지와의 연결, 입력/판독/원본 보존,
UUID 재시도·작성자 CAS·숨김 이력·기관/P/prior 거절·잠금 경쟁·감사 실패 rollback을 확인한다.
원본 digest 불일치는 저장 snapshot의 결함 주입이며 실제 원본을 바꾼 시험으로 세지 않는다.
고정 시점 표식의 출력은 위 v3 시험에서 별도로 다룬다. 과거 편집 표식 복원,
GSPS/KO, 비CT/volume·물리 다중모니터의 전체 Job은 잔여다.
`viewer_jobs` migration은 기존 표에 데이터를 쓰지 않고 두 표만 추가한다. 원본/비교 검사의
상태 삭제는 `removeState`의 같은 parent lock 관문에서 거절하며 숨김으로 해제되지 않는다.
숨김은 기본 목록 제외이고 보안 경계가 아니다. 현재 두 검사 모두에 접근 가능한 사용자는
전체/숨김 목록을 볼 수 있고 작성자만 설명 수정·사유 숨김/해제를 할 수 있다.
표식과 Job의 본문/이력 보호는 서로 별도다. 본문은 서비스에서 수정 경로를 제공하지 않는다.
관련 회귀는 viewer-layout/history/display, 저장 DB 확인은
`python tests/viewer_migration_test.py ViewerMigration.test_03_real_dump_restore_every_row_revision_replay_budget_and_fk`다.
합성 복원 원장은 위 D05B 복원 시험과 같은 24개 migration·37개 표·49개 합성 행을 대조한다.

E01-GATE 전송 근거/요청 관문: `python tests/connect_gate_test.py` (별도 API12).
실제 C-STORE·임시 두 기관 계정으로 admin 근거/계약 기록과 철회, 기사 요청/철회,
기관 격리·유효기간·원 PatientID·OPEN 접근권 없음·감사 실패 전체 rollback을 확인한다.
실제 DB lock의 양쪽 순서·중복 OPEN·소유권/RS 재검사·만료 재요청·100행/cursor·FK/CHECK를 검증한다.
소유 합성 행만 전체 필드와 행위자를 대조해 자식부터 정리한다. 외부 전송/수신함/Import/UI는 이 시험 범위 밖이다.
복원 모델14는 `tests/ops_product_transfer_test.py`, production 이미지 계약5는 `tests/production_image_test.py`다.
실제 네 migration/18개 사용자표/19개 합성 행의 DB·DICOM 결합 복원은 해당 Linux CI에서 확인한다.

D02H 시리즈 번호 정렬: `python tests/e2e/test_thumbnail_sort.py` (별도 UI3).
원래순서/번호오름·내림, 0/음수/동률/누락·불량번호·캐시25항목 페이지·오래된 handler를 대조한다.
실제 두시리즈 CT 현재/관련검사의 정렬 후 OHIF Study/Series/SOP와 판독·초안·점유·원본 보존을 검증한다.
정렬은 작업공간 썸네일에만 적용하며 영상 내부 slice순서·서버 저장을 바꾸지 않는다.

D09E 복사한 상용구 편집문 보존: `python tests/e2e/test_template_snapshot.py` (별도 UI2).
실제 지연된 초안 버리기 응답 후 원판독이 비어도 편집문3칸을 저장하며, 목록에서 출처가 사라지면 저장을 거절한다.
원판독/이력·개인 owner·POST1회·새 로그인과 기존 D09C4/D09A4·최종69→14를 유지한다.

D09D 개인 상용구 부위 필터: `python tests/e2e/test_template_filters.py` (별도 UI4).
부위 정규화/미지정·검색/정확 Modality 조합·조건 유지/전체 보기·편집/삭제·계정 분리와 탐색 쓰기0을 검증한다.
실제 CT와 합성 API Modality 변형을 구분하며 D09A/B/C·D02A·최종69→14를 유지한다.

외부 백업 OFF/전송: `python -B tests/ops_offsite_backup_test.py`.
기본 OFF에서는 SDK·자격증명·원본·네트워크에 접근하지 않는다. enabled 경로는 Linux private
seal 산출물 검증·암호문/receipt 전송·전체 GET hash/size 대조·실패 시 원본 보존을 시험한다.
실제 카카오 계정은 사용하지 않는다. CI의 기존 hash-pinned SDK 환경에서 Linux 전체 및 SDK stub을
필수 실행하며 Windows는 OFF/파싱/요청 경계만 검사한다. OFF는 정상 skipped이고 실제 외부 복원은 미검증이다.

D09C 현재 판독문에서 개인 상용구 만들기: `python tests/e2e/test_report_template.py` (별도 실제4).
현재/prior 구분·세 칸과 출처·새 개인 항목/재로그인, 취소·503 입력 보존·짧은 창,
A→B→A 폐기·저장 중 중복 클릭·늦은 응답·POST 성공 뒤 목록 갱신 실패를 검증한다.
미선택/빈 내용/기사/촬영/타인 점유/P 관문과 승인 A·초안·이력·DICOM 원본을 보존한다.
기존 D09A4·D09B4·D02A3 및 같은 최종 SHA의69→14를 유지한다.

D09B 개인 상용구 검색·미리보기: `python tests/e2e/test_template_preview.py` (별도 실제4).
제목/단축어/Modality/부위의 리터럴 복수어 검색·해제·기존 modality 조건,
세 칸의 읽기 전용 미리보기·키보드/짧은 창·XSS 문자열·현재/prior 삽입 대상,
A→B→A 선택 변경의 미리보기 폐기·공유 삽입 관문·빈 내용 안내를 검증한다.
실제 명시적 삽입의 점유/개인 초안과 합성 원본hash를 대조하고 D09A4·D02A3도 유지한다.

D09A 개인 상용구 보존: `python tests/e2e/test_template_preservation.py` (별도 실제4).
기존 부위/권고문/순서의 제목 편집 왕복, 취소/503/명시적 비움, 새 로그인·개인 소유,
Recommendation 커서 Tab·세 칸 삽입·실제 판독 점유·현재 개인 초안/관련 확정본 분리,
촬영/타인 점유/P·기사 읽기 전용과 원본 DICOM hash를 검증한다.
합성 텍스트와 소유 fixture만 사용하며 기존 69→14 및 D02A의 승인본/초안 경계를 유지한다.

D03A 자동 과거 검사 선택: `node --test tests/worklist_prior_test.cjs` (날짜·기관 포함 환자키·modality·동률 6개 순수 시험).
추가 실기: `python tests/e2e/test_prior_selection.py` (합성 CT의 실제 StudyDate·양 canvas/UID·수동 미래 비교와 개인 초안/이력 보존 2개).
기존 `test_worklist.py` 15개와 별도로 실행한다. 로컬 대상 제한·임시 인증·소유 fixture 정리를 그대로 사용한다.

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
위 실행 시점 기준으로 69→14를 수행할 때 두 시험 명령은 순차 실행하고 **둘 다 종료코드 0**이어야 한다. skip/expectedFailure를
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

D05B1 extends this profile to fourteen tables and fourteen synthetic rows, including
hidden viewer items, both immutable revisions, request-to-revision references and
lifetime storage counters. Both versioned migration digests and all new foreign-key
restrictions are included in the existing exact catalog/row restore comparison.

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
# 뷰어 반전 정밀도

`node --test tests/viewer_precision_test.cjs`는 고정 upstream 함수 fingerprint,
버전/상속 불일치와 비동기 등록 충돌 거부, base/volume 보존, reset 네 조합,
큰 좌표의 좌우/상하 반전 복귀를 확인한다. CI에서도 격리 Node 컨테이너로 실행한다.

`python tests/e2e/test_viewer_precision.py`는 로컬 스택에서 합성 CT 2검사/4 SOP의
좌우·상하·회전 후 반전과 pan/zoom, 주석 편집·초기화 12조건을 확인한다.
제품 app-config를 그대로 사용하며 bundle 응답을 치환하지 않는다. 판독문·개인 초안·
이력과 원본 hash 보존, 생성한 fixture/임시 인증만 정리한다. 결과는 workspace의
`tmp/d05c5/`에 기록한다. 정식 입구와 로컬 테스트 자격증명을 사용하는 기존 E2E 준비가 필요하다.
Orthanc는 UserConfiguration을 시작할 때 읽으므로 설정 수정 후 재시작·게시 포트/HTTPS 확인이 필요하다.

적용 범위는 GPU StackViewport 반전/helper이며 CPU와 volume은 기존 경로다.
`window.kinViewerPrecision.state`의 ready는 adapter 설치 상태일 뿐 영구 저장 허용 신호가 아니다.
확대 시작점과 pan에 따른 잔여 오차는 남으며, 이후 저장 API는 원본 DICOM geometry에
맞지 않는 좌표를 서버에서 거절해야 한다. 이 시험은 다른 영상군·전체 확대 조합·임상 정확도를 보증하지 않는다.

## D05B1 표시 항목 저장 API

`POST/GET /studies/:uid/viewer-items`와 `POST/GET /studies/:uid/viewer-items/:id/revisions`는
주석/키 이미지 표시 이력을 판독문과 별도로 저장한다. 아직 OHIF 저장/재열람 UI는 연결되지 않았다.
POST는 `requestId` UUID와 완전한 `item`을 받으며 revision 추가는 `expectedRevision`,
`action`(edit/hide/restore), 숨김/복원 시 `reason`을 받는다. 응답은 item ID, StudyUID,
작성자 sub/actor, revision, 생성/변경 시각과 hidden을 포함한 item snapshot이다.
첫 생성/재시도/수정 성공은 모두200이며 재시도는 원래 성공 revision을 반환한다.

읽기에는 현재 source/tele 기관과 RS=P의 preDoc/preReviewer 제한을 적용한다.
쓰기는 member+radiologist와 원 작성자 sub가 필요하며 admin 단독 쓰기는 거절한다.
항목 kind/Study/Series/SOP/frame/FoR은 변경할 수 없다. 삭제한 계정·철회된 작성자의
항목을 다른 사람에게 넘기거나 대신 숨기는 기능은 없어 해당 이력은 읽기전용으로 남는다.

검사당 lifetime512항목/4096revision/16MiB와 snapshot8KiB를 적용한다.
bytes는 PostgreSQL jsonb::text의 UTF-8이며 전체 디스크 사용량 상한은 아니다.
숨김은 용량을 반환하지 않는다. revision/bytes가 가득 차면 숨김/복원도409
`VIEWER_STORAGE_LIMIT`이다. 항목 개수만 가득 찼을 때는 추가 identity를 만들지 않는
편집/숨김/복원이 revision/bytes 잔여 안에서 가능하다. raw 본문32KiB, 깊이16,
중복 key·NUL·lone surrogate·비유한 수치·알 수 없는 필드는 거절한다.
목록 기본50/최대100, UUID 오름차순 exclusive cursor; 이력은 revision 오름차순이다.
여러 페이지는 하나의 장기 snapshot이 아니므로 동시 생성 UUID가 cursor 앞에 생기면
새 첫 페이지에서 확인해야 한다. 삭제·숨김된 cursor 자체를 다시 찾을 필요는 없다.

`python -B tests/viewer_api_test.py`는 임시 계정과 실제 Orthanc 합성 영상으로9개 묶음을
검사한다. lifecycle/원래 성공 replay, 네 route 기관·역할·P·gateway, raw/canonical/
no-store, 지원 SOP/frame/평면, 동시 revision/요청, 세 quota 마지막 자리, 감사 실패
원자적 rollback, 실제 부모 lock wait 뒤 철회/P 재검사, 삭제 경쟁, pagination과 실제 DB lock timeout503의 무변경을 확인한다.
quota 경계는 이 실행이 만든 검사에만 counter를 미리 채우며, 별도 lifecycle 시험이
실제 저장 이력 합계와 counter를 대조한다. 원본 바이트와 판독/초안/판독 이력을 보존한다.
감사 실패용 trigger는 해당 합성 StudyUID에만 적용하고 finally에서 제거한다.

`tests/viewer_input_test.cjs`는 빌드된 `/app/dist`를 실행한다. Docker 이미지에서
`node --test /tests/viewer_input_test.cjs`로8개 묶음(JSON/DTO/canonical/페이지/metadata/
geometry/Orthanc 응답·크기/실제5초 timeout)을 실행한다. 외부 네트워크는 필요 없다.
`python -B tests/viewer_migration_test.py`는 별도 PostgreSQL에서 기존 행 보존, DDL 실패
전체 rollback,14표14행/4시퀀스의 실제 pg_dump/restore와 RESTRICT를 검사한다.
`KIN_TEST_OLD_API_IMAGE=sha256:...`를 지정하면 고정 이전 API의 읽기·쓰기와 실제
removeState 삭제 시도의 FK 거절도 검사한다. 입력이 없으면 이 마지막 시험만 skip한다.

새 DB는 versioned migrate deploy, 기존 migration 관리 DB는 추가 migration만 적용한다.
baseline.mjs는 최초 스키마 전용으로 유지했다. Migrate 이력이 없는 구 DB는 먼저
직전 릴리스의 백업/drift/baseline 절차를 끝낸 뒤 업그레이드한다. 새 스키마에서 baseline
기록을 다시 쓰거나 db push/reset을 사용하지 않는다. 이전 앱 복귀 시 새 표를 보존한다.


## D05D viewer save and reopen

python -B tests/e2e/test_viewer_history.py runs six local browser suites against
the actual pinned OHIF configuration and temporary BFF identities. It covers
arrow create/edit/hide/restore/history and a new login, US multiframe keys and
read-only authors, lost-response idempotent retry/409/quota/503, real 401 and
preliminary-state access revocation, A-to-B-to-A delayed lists and logout, and
large-origin oblique CT coordinates across pan/zoom/flip and reopening. Only
the transition test appends the existing service observer; product config and
network endpoints remain real. The 503 and lost-response cases use explicit
browser network fault injection. Original bytes and report state are checked;
owned ViewerStack children are cleaned before the parent fixture. No credentials
or patient data are saved in browser storage. The UI offers explicit saving;
reopening never automatically writes a revision.

The viewer server now uses one canonical JSON string for byte accounting and
both parameterized JSONB snapshot writes. Valid GPU coordinates containing tiny
exponent values previously failed the immutable revision byte equality check
when Prisma serialized an object differently. The live API reference suite
checks these exact numeric values, original-success replay and stored byte equality.
No schema, quota, permission or geometry tolerance is relaxed.

### Related-study date context (D03B)

`python tests/e2e/test_related_context.py` runs three local BFF/C-STORE UI tests for reporting-target identity, past/same-date/later/unknown labels, real manual comparison, uncertain-date response fixtures, and delayed related-report responses. It reuses the local fixture guard and checks original bytes/report rows.

### Return from related viewing (D03C)

`python tests/e2e/test_return_to_current.py` runs three local BFF/C-STORE UI tests: return to the report-target thumbnail/Clinical Info and real viewer; stale related replies and thumbnail cancellation; keyboard/small-window access with input, hold and report history preserved. It keeps normal autosave separate from the return action.

### Related-list modality filtering (D03D)

`python tests/e2e/test_related_filter.py` runs three local BFF/C-STORE UI tests for exact compound modality tokens, patient-key scope, missing values and empty results; hidden related viewing with unchanged images/report/draft/hold; keyboard/small-window access, delayed reports and target-change reset. Non-CT modality values are owned list-response variants, not proof of non-CT image support. Filtering itself causes no image fetch or report write.

### Series thumbnail opening (D02E)

`python tests/e2e/test_thumbnail_series.py` runs three local tests for real two-series CT thumbnail-to-viewport Study/Series/SOP identity and retained display sets; related/current report, private draft and hold preservation; cached paging, stale thumbnail handlers and missing/malformed Series UID refusal. The pagination response fixture tests identity plumbing without claiming 25 real loaded series. Existing whole-study/compare entry points remain separate.

### Source series labels (D02F)

`python tests/e2e/test_thumbnail_labels.py` runs three local tests for visible ordinal/source-number/description labels tied to real two-series CT metadata and viewport identity; missing, zero, duplicate and literal long text at 900×1400 with per-item lookup/preview failure identity; cached page labels, UID pairing and stale handlers. Labels describe the same representative SOP as the preview. Source-number sorting and metadata consistency validation are outside this contract. Response-only variants are distinguished from real C-STORE image checks; report, private draft, hold and original bytes are preserved. D02E and D02C remain separate regression suites.

### Thumbnail common failures (D02G)

`python tests/e2e/test_thumbnail_failures.py` runs three local tests for stopping new item scheduling after lookup/preview transport failure or HTTP401; bounded first-wave requests and unstarted-item labels; real BFF session revocation followed by the unchanged logout redirect; and continued per-item403/503 handling with explicit refresh recovery. Response-only25 identities and a logout observer are distinct from actual server401. Already in-flight items finish, so this is not immediate cancellation or global logout deduplication. D02F3 and D02C3 remain separate regression suites for real series/report identity and request lifecycle.

### Accessible series identity and opening (D02I)

`python tests/e2e/test_thumbnail_access.py` runs three local tests for native full-identity disclosure with keyboard/click and literal long text; Enter/Space/click opening of real current/related two-series CT with viewport identity and draft/hold preservation; cached paging, stale handlers, lookup/preview/decode/network failure disabling, recovery and invalid UID refusal. Response-only variants do not establish real 25-series image support. D02H3/D02G3/D02C3 remain relevant regressions.

### Series placement and recent layout restoration

`python tests/e2e/test_viewer_layout.py` runs four local tests for native 1/2/4-cell CT drag placement, replacement and duplication; explicit account/browser recent-layout save and reopening with actual canvas/Study/Series/SOP checks; current/related reporting preservation; account/device separation, delayed access checks and logout; corrupt storage, missing/ambiguous references and unsupported viewport refusal. `node --test tests/viewer_layout_test.cjs` runs six model/storage tests. Values retain only one recent grid with study/series references and active cell per institution/subject, never transient display-set IDs, report text or images. Camera, frame, annotations, server roaming and specialized layouts remain outside this feature. Existing viewer-history6 and prior-selection2 are the related regressions.
# Account workspace roaming

REQ-D01-COLUMNS-ROAM → RISK-OWNER/LOST-UPDATE/DISPLAY-ONLY → TEST-D01-COLUMNS-API: `python tests/worklist_columns_live.py` checks institution + immutable subject isolation, clinical roles and denied gateway/anonymous identities, strict display-key payloads, concurrent create/update/reset, retained reset revisions and the server/browser column allowlist match. The additive `WorklistColumns` table is separate from panel layout. Only synthetic owners are cleaned with full-row equality guards. `python tests/e2e/test_worklist_columns_roaming.py` (TEST-D01-COLUMNS-BROWSER) checks explicit save/load/apply across independent BFF browsers, account isolation, local restoration, report input preservation, conflicts, network failure, delayed responses, edit/close cancellation and post-response identity recheck. Server reads only populate the editor; login does not replace the current list. `python tests/ops_product_transfer_test.py` includes settings and reset tombstones in the restore contract; Windows skips remain explicitly separate from Linux execution.

`python tests/workspace_roaming_live.py` checks actual account/institution ownership, strict display-only payloads, concurrent revision conflicts, reset tombstones and denied identities. `python tests/e2e/test_workspace_roaming.py` exercises explicit save/load/reset across real BFF accounts and independent browser contexts, local layout priority, size clamping, delayed responses and reporting preservation. These are separate from the mandatory 69 then 14 gates. Fixtures remove only their own new workspace rows with full-row equality checks. Apply the additive workspace migration with `prisma migrate deploy`; never reset the database.

### CT position synchronization

`node --test tests/ct_sync_test.cjs` checks eight physical-plane matching boundaries. `python tests/e2e/test_ct_sync.py` exercises the pinned Image Slice Sync menu with synthetic classic CT, different spacing/order, actual keyboard navigation, explicit OFF/reopening, incompatible patient/FoR/orientation and out-of-range refusal, held image responses and replaced stacks, and actual logout. Native position navigation is guarded by visible sourcePatientKey and DICOM geometry; it does not perform registration across different FoRs or persist display/report changes. Existing viewer-layout4 and viewer-history6 remain separate regressions. Model-only invalid geometry and browser response delays are distinguished from actual DICOM fixture cases.

### Selected-stack cine

`python tests/e2e/test_cine.py` runs six focused cases against the pinned native Cine menu and renderer: real synthetic US12/7 frame pixels and forward/reverse order, loop/end/first/last/pause/resume, native 10/5 FPS, selection and replacement, held frame/session responses, failed frame retry, close/logout/SPA exit and reload. The hidden-page case explicitly simulates the visibility event; it does not claim physical OS tab occlusion. `node --test tests/cine_budget_test.cjs` checks four preparation boundaries and runs in CI.

The selected stack requires an explicit native play click after replacement, selection, direction/loop change or exit. Preparation uses four workers, 2–500 frames and an estimated 128 MiB RGBA pixel limit; that estimate is not a total-browser memory guarantee. An in-flight native load may finish after stop, but cannot start the discarded playback. Report/draft/hold/history and original DICOM remain unchanged. Volume, enhanced/XA/color/compressed cine, linked frame numbers, yoyo, recording and clinical timing accuracy are outside this verification. Related regressions are viewer-layout4, viewer-history6 and CT-sync6, separate from mandatory69→14.

### Selected CT display controls

`python tests/e2e/test_display_controls.py` runs four local cases for native CT preset keys 1–5 and matching menu values, selected-cell scope, US refusal, zoom/pan/WL gestures, rotation/flips/invert, fit versus reset, retained current frame and annotation world coordinates, numeric text input and report/draft/hold/original preservation. Reset normalizes the native colormap to Grayscale; camera, VOI and full grayscale canvas pixels return to their initial values. Reopening starts with the native default display. `node --test tests/ct_presets_test.cjs` runs four command and lifecycle boundary tests in CI, including empty/unsupported selections and malformed values.

The pinned mode already supplies its own preset hotkeys; the unused top-level hotkeys configuration is removed. Only the five named CT preset commands gain a classic-CT selection guard. Other native window/level commands retain their existing behavior. Physical true size, measurements, all-selection changes, specialized modalities and clinical display accuracy remain outside this verification. Related regressions are viewer-layout4, viewer-history6 and cine6, separate from mandatory69→14.

### Report key image output layout

`python tests/e2e/test_report_window.py` adds seven focused scenarios for explicit
CT print W/L: lossless PAM signed pixels and independently calculated output,
UI and PDF image/setting equality, invalid/mixed selections and failure recovery,
late-image suppression, LUT/source-change guards, unsigned fractional rescale,
width 1/1.5/2/20000 boundaries, malformed PAM rejection and 32 distinct 512px keys.
The manual path is limited to single-frame classic CT MONOCHROME2 with positive
finite rescale slope and finite intercept, 16-bit samples and no complex LUT.
Automatic preview remains the default. Manual output calculates DICOM LINEAR
from decoded samples; Orthanc rendered clamps narrow widths and tiny slopes.
Run the nine report-preview regressions below after changing the shared output
module. These are focused local tests; physical printing and viewer annotation
snapshots are not covered.

`python tests/e2e/test_report_preview.py` runs nine focused actual-stack scenarios.
The original seven cover report snapshot permissions, editor/source separation,
key frames and print, stale/failure/session paths and output identity support.
TEST-D09-KEY-LAYOUT adds single/two-column selection, three keys with an odd final
item, order/geometry, actual Chromium PDF text and repeated patient identity,
reopening defaults, and cancellation of a pending print when layout changes.
Report/draft/key histories and original DICOM remain unchanged. Render the PDF
pages for visual inspection; text extraction alone does not establish layout.
This is a focused local suite, not an added CI job. It does not verify physical
printing, true size, editable modality templates or annotation/WL snapshots.

### External SR source reader

`python tests/e2e/test_sr_reader.py` runs four focused tests using actual C-STORE Basic Text and Comprehensive SR alongside CT. It checks original nested text/code/numeric/unit/date/time/coordinate/image references, literal strings, current/related study identity, cancelled and delayed replies, actual BFF tenant denial/logout, explicit HTTP/malformed/oversized/identity/bulk-value failures and retry, keyboard/small-window access and report/draft/hold/original preservation. Response variants for failures and list/body limits are distinct from actual stored SR documents. `node --test tests/sr_tree_test.cjs` runs six pure identity, literal-value and structure-budget cases in CI.

The reader uses existing study-scoped DICOMweb GET authorization and does not resolve external references, generate measurements or save reports. It lists up to100 SR series and200 instances per selected series; each response is bounded to2MiB, the tree to depth32/node2000/text200000. Exceeding a limit, mismatched identity, or binary/external values rejects the whole document. Basic/Enhanced/Comprehensive/Comprehensive3D SR class identifiers are allowed, with actual fixtures limited to Basic/Comprehensive and model checks for the other two. DICOM JSON numeric representations are displayed as delivered, not asserted to preserve the original DICOM numeric byte spelling. IOD/TID semantic validation, clinical interpretation, reference-image navigation, SR generation, PDF and SEG are outside this feature. Related regressions are related-context3, return-to-current3 and viewer-history6, separate from mandatory69→14.

### Viewed patient ID copy

`python tests/e2e/test_patient_id_copy.py` runs three cases for the explicit Clinical Info button and worklist Ctrl+Alt+C. Actual C-STORE PatientID, authenticated API data, displayed source institution/context and the secure-origin browser clipboard are compared, including leading zeros, Unicode and literal special characters. Related-study and other-patient selection, actual tenant denial, clipboard rejection/unavailability and retry, input/modal/IME/repeat exclusion, keyboard access, report/draft/hold/original preservation and logout/relogin are covered. Browser clipboard permissions are granted only in the isolated test context.

One test performs a real clipboard write and holds only its Promise completion locally to exercise A→B→A stale-result suppression and duplicate-call prevention. This does not claim OS clipboard cancellation. The product copies the exact displayed API PatientID at the user's action, never reads or clears the clipboard, and does not automatically copy on selection or logout. Empty/unsupported target variants are local test state changes, not edits to stored DICOM. The shortcut applies to the worklist, not the separate OHIF window. Related regressions are related-context3, return-to-current3 and SR-reader4, separate from mandatory69→14.
D 수동 측정: `python tests/e2e/test_manual_measurements.py`.
비등방 합성 CT의 길이·각도·ROI 면적/mean/min/max/count를 독립 원본 계산과 대조하고,
저장·새 로그인 좌표/재계산·잘못된 평면/기사 저장 거절·계산 비교값 불일치 안내를 검사한다.
간격 누락/비-HU 표시는 브라우저 메타데이터 결함 주입으로 별도 확인한다.
3개 시나리오에는 계산 생략 후 낡은 캐시/좌표 불일치의 실제 SVG 경고와 저장 거절,
재계산 뒤 정상 baseline 저장이 포함된다. 실행 번들의 Length는 영상 조회 실패 분기를 직접
재현하고, 누락 영상에서 예외를 내는 Angle은 낡은 캐시/false 플래그를 명시적으로 주입한다.
두 경우 trailing 호출을 잠시 보류했다가 복구하며 실제 마우스 이동 속도의 확률에 의존하지 않는다.
거짓 저장 baseline의 캔버스 라벨과 원본 digest 불일치의 API unverified/표식 미복원도 단언한다.
digest 결함은 이번 실행의 저장 참조에만 주입하고 완전한 snapshot 대조 후 복구한다.
사선 ROI는 현재 제한이며 이 시험을 전체 modality·변환 정확도나 의사 확인으로 세지 않는다.


### Bounded study transfers and related pages

REQ-D01-PAGE-TRANSFER → RISK-TENANT-LEAK/STALE-REPORT/PARTIAL-LIST/UNBOUNDED-DOM → TEST-D01-PAGE-TRANSFER.
`node --test tests/study_pages_client_test.cjs` covers checkpoint retry, final identity failure, malformed order, stale epochs, cancellation, superseded requests and request timeout. `tests/study_page_test.cjs` runs against the built API module inside the container and checks signed owner/size/expiry/membership cursors and legacy query-less behavior. `python tests/study_pages_live.py` checks actual tenant sets, draft/report visibility and cursor refusal in three cases.
`python tests/e2e/test_study_page_transfer.py` checks atomic replacement after a failed page, explicit resume/cancel, 50-row related pages, owner logout, automatic poll recovery/two-failure offline detection and a completion-to-application commit race. The 201-row response is a browser fixture variant backed by two selectable studies; it is not a server scale benchmark. Existing related/search regressions and sequential69→14 cover shared paths.
The API slices only the already-authorized list and rechecks page access before response. Each request allows60seconds; signed cursors expire after5minutes or process restart. A cancelled batch waits for explicit user action; a transient failure allows the next automatic poll to fetch fresh pages. Explicit resume may retain earlier row states until the next refresh. Membership changes reject the batch; continuous arrivals may repeatedly restart it. Orthanc enumeration, initial bootstrap and the complete browser array remain whole-list operations. Hospital-scale performance and point-in-time state snapshots are unverified.


### Initial query scope

REQ-D01-QUERY-SCOPE → RISK-TENANT-LEAK/STALE-REPORT/DUPLICATE-LOAD → TEST-D01-QUERY-SCOPE.
`tests/study_query_scope_test.cjs` runs against the compiled API and asserts that lean bootstrap does not query states/reports/drafts, page enumeration projects only identity/scope, detail/note queries use page UIDs, and concurrent tenant or Preliminary visibility changes reject the response. `python tests/study_query_scope_live.py` runs lean/full bootstrap comparisons and the three existing page tenant/draft/cursor API cases. `python tests/e2e/test_study_query_scope.py` checks saved draft restoration on a fresh page and failed initial page retry without partial state.
Only initial boot uses `bootstrap?states=omit`. Query-less bootstrap, reconnect and modification-failure recovery still load full states. Legacy and paged list responses both reject concurrent institution/RS/Preliminary-author/reviewer changes before sending. Orthanc full enumeration, full UID/scope enumeration and the completed browser array remain unbounded; this reduces duplicate payload and page DB detail reads, not hospital-scale query performance.


### Original detail page queries

REQ-D01-SOURCE-PAGES → RISK-TENANT-LEAK/SOURCE-MISMATCH/UNBOUNDED-DETAIL → TEST-D01-SOURCE-PAGES.
`tests/study_source_test.cjs` checks the compiled original-source adapter: UID-only inventory request, duplicate/malformed identity refusal, comma-separated QIDO UID-list matching, exact returned UID set/order, empty-request IO avoidance, and 100-ID cold-registration batches followed by a page-only warm query. Run with the updated `tests/study_query_scope_test.cjs` for six model cases including permission races. `python tests/study_source_live.py` adds actual cold/unassigned registration to the four previous API comparisons. `python tests/study_source_batch.py` sends100 isolated single-instance studies with64-character UIDs from copied public CT pixels, exercises the actual compiled adapter with all100 UIDs, checks exact order/patient identity and removes only owned resources. Existing query-start/transfer browser tests and69→14 cover display and shared paths.
Paged requests use Orthanc1.12.5 ExtendedFind UID inventory, then original institution lookup only for missing/unassigned DB rows, then full QIDO metadata only for the authorized page. Missing/duplicate/extra detail UIDs reject the batch. Query-less list/unassigned management retain their original full QIDO path. Full UID/scope enumeration, cold/unassigned registration cost and the full completed browser array remain. This is neither a source cache nor a transactional source/DB snapshot, and small fixture/probe byte counts are not hospital-scale benchmarks. Unsupported inventory responses fail without a full-detail fallback.

Image opening: `tests/viewer_opening_test.cjs` and `tests/e2e/test_viewer_opening.py` cover REQ-D-WORKSPACE-OPENING → RISK-D-WORKSPACE-IDENTITY/UNSAVED/ACCESS → TEST-VIEWER-OPENING. Owner-scoped local target/prior choices affect subsequent opens; actual viewer/draft state and the existing guarded transitions remain intact.

Viewer windows: `tests/viewer_windows_test.cjs` and `tests/e2e/test_viewer_windows.py` cover REQ-D-WORKSPACE-WINDOWS → RISK-D-WORKSPACE-IDENTITY/UNSAVED/ACCESS/WINDOW-LOST → TEST-VIEWER-WINDOWS. A limit of 1 retains guarded named-window reuse; 2–4 retain separate scopes and refuse excess opens. Real CT tests cover dirty-close refusal, focus, closed-slot reuse, reduced limits, reload rediscovery, popup denial, unverified owner, session end and corrupted registry. Only connection identifiers and occupancy persist in sessionStorage. Physical monitor placement and OS focus acceptance remain unverified.

Automatic selection: `tests/e2e/test_viewer_autoload.py` covers REQ-D-WORKSPACE-AUTOLOAD → RISK-D-WORKSPACE-IDENTITY/UNSAVED/STALE/WINDOW-LOST → TEST-VIEWER-AUTOLOAD. Optional selection opening and clean-window reuse preserve existing guards; previous/next window navigation only focuses. Cases include account/reload separation, dirty work, exact/reduced capacity, another patient, context-menu exclusion, blocked popups and delayed double-click. The window model deduplicates a requested scope while the old Document remains active and distinguishes a replacement document from a changed URL; elapsed time never releases occupancy.


MPR batch preview: `node --test tests/volume_batch_test.cjs`, `python tests/e2e/test_volume_batch.py`, and `python tests/e2e/test_volume_batch_context.py` cover REQ-D-VOLUME-BATCH / RISK-D-VOLUME-BATCH-GEOMETRY/SOURCE/LOSS / TEST-VOLUME-BATCH. Run the live suites serially. Fully loaded classic CT sources (2-256 slices, three MPR views) generate temporary parallel PNG previews with patient-space offsets, interval and count. Tests check actual pixels and oblique positions, MIP/MinIP/Average/flips, unchanged source cameras/report, cancelled or late rendering, owner/session loss, deadlines, object-URL cleanup and Chromium DPR 1.25/1.5. The raster budget is 64 MiB before encoding and 32 MiB of PNGs, with at most 128 planes and a 512-pixel maximum dimension. Native window errors are captured even when the OHIF ErrorBoundary prevents the default event. This suite covers temporary previews; saved recipe replay is covered below. Derived DICOM, filming and physical mixed-DPI displays remain separate work. Scout coverage is described below.

MPR batch saved reconstruction: `python tests/e2e/test_volume_batch_save.py` and compiled-API `tests/viewer_volume_job_test.cjs` cover REQ-D-VOLUME-BATCH-SAVE / RISK-D-VOLUME-BATCH-SAVE-SOURCE/REPLAY/LOSS / TEST-VOLUME-BATCH-SAVE. Snapshot v5 stores the generation-time recipe and complete original CT reference independently of later source-camera motion or unapplied input edits. Reopening reconstructs the saved raster in a fresh login with a different viewport and DPR; decoded full-image hashes, physical camera values, report/original preservation, source/role rejection and partial/cancelled restoration are checked. Keep `test_volume_jobs.py` for v4 compatibility. Snapshot v5 uses a fixed half-step ray phase in its disposable mapper; native per-mapper random jitter would otherwise change Average pixels on replay. The shader template is pinned: a viewer/vtk upgrade requires rerunning the Average replay test; bitwise equality across GPUs/drivers is not claimed. DPR outside the tested 1/1.25/1.5 ratios fails closed on a raster mismatch. The 1e-12 camera comparison is specific to this synthetic fixture; the restoration oracle remains 1e-6. Job restoration uses a fresh native position-cache identity to avoid applying an old oblique reference during axial initialization. Derived DICOM and filming are separate work. Scout coverage is described below.

MPR batch location reference: `node --test tests/volume_batch_scout_test.cjs` and `python tests/e2e/test_volume_batch_scout.py` cover REQ-D-VOLUME-BATCH-SCOUT / RISK-D-VOLUME-BATCH-SCOUT-GEOMETRY/REFERENCE/LOSS / TEST-VOLUME-BATCH-SCOUT. A disposable thin MPR reference shows physical center-plane guides and the selected frame during navigation/playback. Five live cases check known pixels, independent patient-space guide coordinates, double-oblique reversed reconstruction, fresh-login saved replay at DPR1.5, failure/cancellation retention and missing optional assets. Run serially with batch save, preview, context and SR suites. Reference rendering shares the source GL context without changing original viewports. It uses the same pinned half-step shader as batch output; viewer/vtk upgrades require both replay suites. The reference and output slabs are labeled separately. Missing assets keep basic batch available, but a runtime reference failure conservatively retains the previous complete batch. Raster mismatch fails closed; this adds a separate 256/DPR size gate and does not guarantee every DPR or physical mixed-DPI configuration. No derived DICOM or filming is implemented by this reference.

Cine replacement ownership: `node --test tests/cine_lifecycle_test.cjs` runs the complete extension with deterministic service events and permission promises. Five cases cover late success/failure, retired enabled/disabled element stop requests, and current-source invalidation. `test_volume_cine.py` also remounts real native layouts, reuses the original viewport ID with a new element, then checks continuing playback after the retired request settles. Use MPR7, stack6 and SR7 serial regressions for this boundary. Forced DOM replacement is not the native layout contract; failed development probes are retained separately. Element listeners still live until mode exit. REQ-D-VOLUME-CINE / RISK-D-VOLUME-CINE-REFERENCE/RUNAWAY/LOSS / TEST-VOLUME-CINE.

Saved MPR batch print/PDF: `python tests/e2e/test_volume_batch_print.py` covers REQ-D-VOLUME-BATCH-PRINT / RISK-D-VOLUME-BATCH-PRINT-SOURCE/IDENTITY/LOSS / TEST-VOLUME-BATCH-PRINT. Eleven cases compare full decoded rasters with the saved recipe, including oblique Average, signed negative pixels, individual flips and DPR1.25/1.5; verify every generated plane and patient footer in a multipage PDF with an optional server report; and exercise read-only replay, changed Job/source rejection, missing assets, capacity refusal, cancellation and retry. A private CT volume reads every original again, checks the ordered source digest and frees only its own renderer, images and metadata. The source viewports and unsaved report remain unchanged. Run existing saved-image, output-control, report, current-image and annotation print suites serially after this suite.

This development path accepts 2-256 classic CT instances and at most 16,777,216 source voxels (64 instances at 512 by 512), plus a 64 MiB source response budget. It requires enough free cache for twice the Float32 source size without evicting existing images. Larger studies are explicitly refused before raw pixel reads; the test injects dimensions to exercise this branch and does not establish real large-study performance. Keep the bound until the large-data workflow is validated; this is not support for typical 256-slice 512-square CT output or an evaluation release. The 512-pixel plane, 128-plane, raster/PNG budgets and pinned half-step shader remain in force. Ceiling-size integrated-GPU timing, other GPU/driver equivalence and physical mixed-DPI behavior are unverified. Browser print/PDF is distinct from the derived DICOM, device filming and actual printer acceptance work still outstanding.

MPR selected display reset: `node --test tests/volume_display_test.cjs` and `python tests/e2e/test_volume_display.py` cover REQ-D-VOLUME-DISPLAY / RISK-D-VOLUME-DISPLAY-GEOMETRY/LOSS/STALE / TEST-VOLUME-DISPLAY. Twelve live cases check native default windowing and visible W/L labels, linear/sigmoid pixels and inversion, oblique zoom/pan reset with unchanged slice depth, fresh and same-page Job restoration, partial native failure and visible rollback failure, active-plane changes with newer edits, owner/modal/session protection, actual cine/batch busy gating, and missing optional assets. The zoom baseline is shared with Reset Planes and recaptured for new native viewports after Job restore. The pinned native enum supports LINEAR and SIGMOID; unsupported defaults disable Windowing reset. Native sigmoid readback rounds an inferred range, so reset verifies its transfer nodes directly. Rollback uses the pinned native setter's input VOI range, preserves exact curve nodes (including inverted sigmoid), and only reverts state still owned by the reset; retired or unavailable viewports are not mutated. Run orientation, volume Jobs, batch save/context, cine and batch print regressions serially. This does not complete all MPR display, synchronization or rendering settings.

MPR Basic Orthogonal (IF-A02 first unit): `node --test tests/volume_orientation_test.cjs`, `python tests/viewer_volume_orientation_dom_test.py` and `VolumeCrosshairE2E.test_crosshair_09..11` cover REQ-D-MPR-BASIC-ORTHOGONAL / RISK-D-MPR-BASIC-AXIS/PIVOT/PARTIAL, RISK-D-MPR-RESET-SEMANTICS / TEST-VOLUME-ORIENTATION-ORTHOGONAL, TEST-VOLUME-ORIENTATION-BASIC-DOM and TEST-VOLUME-CROSSHAIR. Each plane returns to the pinned native patient-axis camera (`cornerstone.CONSTANTS.MPR_CAMERA_VALUES`) of the orientation name it was opened as (grid `viewportOptions.orientation`, else native `options.orientation`, as the MPR Job uses), never to a nearest axis, grid order or acquired volume axis; missing, duplicate or unknown names and a missing native table are refused before any camera write. The current three-plane intersection is kept and each plane's focal/position offsets from it keep their right/up/normal coordinates, so pan, depth, camera distance and zoom stay, and VOI/projection are not written. Native Crosshairs recompute their center after application and after rollback. Flipped planes are refused rather than guessed. Reset Planes is unchanged and still returns to the bind baseline, which after an oblique Job restore is that oblique screen. The live cases use a synthetic acquisition tilted 30°/20° to compare native initial planes with the native table, pivot, canvas pivot point, pan/zoom/VOI/MIP, crosshair center and index-derived pixels; a saved oblique Job reopened in a new browser; Reset after reopen; a Job saved after Basic; injected native camera failure, flip refusal and Tech Note busy gating. Curved/Freehand MPR, flipped-plane support and physician confirmation are outside this unit.

## TEST-MPR-PREFERENCES — MPR display and input profiles

REQ-D-MPR-PREFERENCES → RISK-D-MPR-PREF-DISPLAY/INPUT/OWNER/LOSS → TEST-MPR-PREFERENCES.
`tests/e2e/test_volume_preferences.py` exercises native display overlays, patient-plane ruler accuracy after oblique rotation and zoom, mouse button rollback and modifier/touch preservation, local and account profiles, modal deferral, Job restoration, and progressive ray sampling with exact refined pixels. Fault cases cover storage, binding/sync/attach failure, pending settings, inexact/persistent refinement, and render errors. `tests/volume_preferences_test.cjs` validates profile shape and ruler/cube geometry. `tests/reading_appearance_live.py` includes v7 input validation, old-version upgrade, old-writer rejection and owner checks. Run fixture suites sequentially; preserve original DICOM and report state.

These are display/input preferences. The scale is patient-plane distance, not physical monitor size. Progressive rendering returns to the original ray sample distance; a failed restore remains visibly flagged and retried. Its busy capability reports unresolved rendering and does not disable the preferences controls. Manual 3D annotations remain a separate workflow.

## TEST-MPR-MARKS — Manual 3D points and source-bound Jobs

REQ-D-MPR-MARKS → RISK-D-MPR-MARK-SOURCE/PLANE/LOSS/OWNER → TEST-MPR-MARKS.
`tests/e2e/test_volume_marks.py` covers manual patient-coordinate points, exact point-glyph placement, wrapped off-plane labels, plane navigation, editing/removal, visibility/sync settings, immutable Job snapshots and new-browser restoration. It also checks forged source/bounds and roles, descending originals, dirty drafts across source/layout changes, owner retirement, response loss and partial navigation/restore failures. The pure models are `tests/volume_marks_test.cjs` and `tests/viewer_volume_marks_test.cjs` (the latter uses the compiled API inside the container).

Job v6 binds marks to every ordered original CT SOP; it does not invent a reconstructed SOP. An optional batch recipe remains independently validated. The pinned grid's retained-element readiness repair requires the actual connected native renderer plus complete source, volume and canvas checks; a mismatched renderer cannot be promoted. Existing Job, batch, orientation, sync and preferences suites provide direct regression coverage. Fixtures must run sequentially. Saved MPR output is covered by TEST-MPR-PRINT below; clinical acceptance remains separate.

Progressive refinement and manual points (IF-A06): the MPR host creates progressive refinement before the annotation panel, so on a slab thicker than 0.2 mm with Progressive Rendering on, an armed pick's own press used to start a coarse preview and the pick then refused itself as unresolved rendering. An armed pick now owns its press through `kinMprMarks.claims`; a preview or unresolved refinement already on screen still refuses the pick, and an unarmed press still previews and refines. `tests/viewer_volume_marks_progressive_dom_test.py` runs the real orientation host, progressive refinement and annotation panel in Chromium against a synthetic thick-slab target; it is no GPU or pixel proof. `test_marks_20` repeats the press on the native renderer with Average 20 mm, generates a batch beside an injected persistent refinement failure and again after recovery with identical decoded rasters, saves Job v6 and restores the points, recipe and raster in a fresh login. The hosted `volume-marks` group runs `test_volume_marks.py` (20) then `test_volume_mpr_print.py` (9) serially on a fresh synthetic runner after the DOM and exact-selection steps. Registration is not execution evidence, and current unsaved output (`test_volume_current_print.py`) stays outside this group.

## TEST-MPR-CURVED — Manual curved/freehand MPR and Job v10

REQ-D-MPR-OBLIQUE-CURVED → RISK-D-MPR-GEOMETRY/INTERPOLATION/SOURCE-MUTATION/PREVIEW-FINAL → TEST-MPR-CURVED-MODEL/DOM.
`tests/volume_curved_test.cjs` checks the pure `kin-cpr-1` model against multilinear-field oracles: anisotropic/oblique/descending bases, trilinear midpoints, half-voxel edge clamp and NaN outside, arc-length columns, row 0 on +plane normal, Catmull-Rom/freehand rules, limits and refusals. `tests/viewer_volume_curved_dom_test.py` runs the real panel in Chromium with held timers for superseded finals, target/owner loss, off-plane edits, scalar absence, the capture gate and restore rollback. `tests/viewer_volume_job_capture_test.cjs` covers v10 selection/refusals; `tests/viewer_volume_job_test.cjs` covers the compiled server schema, frame of reference, finest spacing, voxel bounds and plan parity. `tests/e2e/test_volume_curved.py` (volume-mpr profile, `ci-mpr-curved`) proves native pointer editing, cached scalars as HU (slope 2/intercept −1024 and signed +1024), every sample against a numpy oracle, Job v10 save, new-browser restore, failed-restore rollback and unchanged originals.

A curve is drawn by a person on one fixed MPR plane (LPS mm, 1 µm storage). Output spacing is the finest voxel spacing; Half Height is the only parameter. Preview and final are labelled and only a final for the current curve is shown as Final or saved. The result is a derived display on an arc-length axis: no straight-line distance, measurement, mark projection, print or DICOM export. Batch or 3D marks beside a curve, and non-1×3/3×1 layouts holding one, are refused. Fixtures run sequentially; clinical acceptance remains separate.

## TEST-MPR-PATH — Manual 3D path, path planes, unfolded display and Job v11

REQ-D-MPR-PATH → RISK-D-MPR-PATH-AUTO/GEOMETRY/UNFOLD-DISTANCE/PREVIEW-FINAL/RESTORE-ROLLBACK → TEST-MPR-PATH-MODEL/DOM/NATIVE; the double-oblique native suite (REQ-D-VOLUME-ORIENTATION → TEST-VOLUME-ORIENTATION) is registered beside it.
`tests/volume_path_test.cjs` checks the pure `kin-path-1` model against oracles it does not share with the model: a straight diagonal path (closed-form centres, exact arc length/columns, constant frame), a planar arc in an oblique plane with an explicitly in-plane initial normal (binormal equals the plane normal at every column), a non-coplanar helix against the analytic rotation-minimizing twist of minus the torsion, a field linear in patient coordinates on an oblique descending basis for unfold angles 0/90/37°, two scalar volumes sharing every geometric fact, re-projected/regenerated initial normals, the Go to Path Point camera triple, every refusal (reversal, coincident centres, stale or non-unit normal, angle, column, limits) and server parity constants. The default initial normal is tested on its own and is not claimed to lie in any drawing plane. `tests/viewer_volume_path_dom_test.py` runs the real panel in Chromium on a controlled target: points on three planes, on/off-plane styling and editing, invalid proposals keeping the last valid path, delete/Clear/Reset to saved, held timers for superseded finals, Go to Path Point waiting for a render event from every viewport with injected camera/render failures and rollback, the capture gate and restore rollback. `tests/viewer_volume_job_capture_test.cjs` covers v11 selection and refusals; `tests/viewer_volume_job_test.cjs` covers the compiled server schema, frame recomputation/refusals, frame of reference, finest spacing, voxel bounds and plan parity. `tests/e2e/test_volume_path.py` (volume-path profile, `ci-path-native`) proves native point picking on three planes, every unfolded sample against a numpy oracle, Job v11 save and new-browser restore, forged Jobs, native path planes with camera and pixel oracles after a fresh render event, edit/delete/reset, failed-restore rollback, conflicts and print refusal; `tests/e2e/test_volume_orientation.py` runs unchanged as `ci-mpr-orientation`.

A path is placed by a person, point by point, on the current slice of any of the three native planes (LPS mm, 1 µm storage); nothing reads image content to create, move or correct it. Output spacing is the finest voxel spacing; Half Height, Unfold Angle and the column position are the parameters. The perpendicular/parallel planes are a navigation action rendered by the native viewports; the Job saves the resulting cell cameras. Preview and final are labelled and only a final for the current path is shown as Final or saved. The unfolded result is a derived display on an arc-length axis: no straight-line distance, measurement, marks, print or DICOM export. A curve, batch or 3D marks beside a path, and non-1×3/3×1 layouts holding one, are refused. Automatic centre lines, Endo navigation, thick unfolded slabs and batches along a path are outside this unit; clinical acceptance remains separate.

## TEST-MPR-PRINT — Saved planes, manual points and printed identity

REQ-D-MPR-PRINT → RISK-D-MPR-PRINT-SOURCE/GEOMETRY/IDENTITY/LOSS → TEST-MPR-PRINT.
`tests/e2e/test_volume_mpr_print.py` and `test_volume_mpr_print_failures.py` verify saved v4/v6 three-plane output and annotated batches, native pixel and point-coordinate agreement, hidden points, oblique Average at different DPR, source/Job changes, cancellation, missing assets/model, memory, forged points, canvas mismatch and PDF page identity. The oblique pixel reference uses a fixed ray sampling phase to match deterministic saved reconstruction; every pixel remains an exact assertion. Native MPR's 0.05 mm half-thickness needs `resetSlabThickness`, because the pinned setter clamps it to 0.1; both batch generation and output verify the actual applied thickness.

Use full `test_volume_batch_print.py` and `test_viewer_job_print.py` as direct regressions, then targeted Job/mark reopen coverage. Run all fixture suites sequentially. On-plane marks use a cross; off-plane projections use a dashed ring and tilde number, with explicit signed distance and patient coordinates in the output legend. These printed numbers refer to the saved mark order. Current unsaved MPR output is covered separately by tests/e2e/test_volume_current_print.py and does not require Save New Job; existing source-volume output capacity and clinical/device acceptance remain separate.


REQ-D-VOLUME-AVERAGE-AFFINE → RISK-D-VOLUME-AVERAGE-OFFSET → TEST-VOLUME-AVERAGE-AFFINE. `test_volume_average_affine.py` requires a constant signed or unsigned CT to keep exactly the same gray level in thin MPR and Average; its known sampling phase removes noise from the oracle. `tests/volume_average_shader_test.cjs` exercises the pinned vtk RegExp substitution semantics and idempotent composition with other shader properties. The Average helper counts actual accepted scalar samples, preserving constants and rescale offsets. Full `test_volume_projection.py`, signed batch output and oblique Average output remain required regressions. Live Average may use a different sampling phase from deterministic saved reconstruction, so their individual pixels need not coincide without phase control.

REQ-D-VR-DISPLAY → RISK-D-VR-SOURCE/TRANSFER/GEOMETRY/LOSS → TEST-VR-DISPLAY. `node --test tests/volume_rendering_test.cjs` covers the pure VR model. The fixture module `tests/e2e/test_volume_rendering.py` covers manual CT volume rendering in a separate viewport: patient directions, rotation/zoom, native presets, opacity/shading/reset, known-box geometry and signed/rescaled HU equivalence. Failure, pending input, source/owner changes and close/retry preserve MPR pixels, marks and report input. The workflow returns to current MPR output and saved Job replay. Run fixture suites sequentially through `scripts/run-tests.py` only after confirming separation from original storage, endpoints and credentials; direct regressions are orientation, batch, current MPR print and saved annotated output. The viewer shares the existing GL context but owns its actor, camera and lifecycle.

REQ-D-VR-CROP/TRANSFER → RISK-D-VR-GEOMETRY/TRANSFER/SOURCE/LOSS → TEST-VR-CROP/TRANSFER extends the same model suite with voxel-edge crop geometry and transfer-knot validation. E2E cases 11–12 cover manual I/J/K crop pixels, invalid bounds, custom HU/color/opacity, repeated global opacity, reset and reopen with MPR/source preservation. The dedicated `volume-rendering` GitHub-hosted CI job selects declared VR cases only through `scripts/run-tests.py`, using the existing disposable runner with explicit local endpoints, generated credentials, empty Docker storage and bounded timeouts. It runs both pure VR model files first, publishes sanitized logs and only the expected PNG from private staging, and preserves existing measurement/runtime jobs. Run evidence determines pass/fail; syntax checks do not establish renderer accuracy. Do not invoke this live profile on the original local environment. Sculpt, VOI overlays, VR batch, MR and large-volume support remain incomplete.

REQ-D-VR-PERSONAL-PRESET → RISK-D-VR-TRANSFER/OWNER/LOSS → TEST-VR-PERSONAL-PRESET: `tests/volume_rendering_presets_test.cjs` covers strict owner-bound browser library data, display-only payloads, normalized names, limits, exact-raw conflicts and storage failures. E2E13–17 cover applied display save/reopen/replace/delete, pending edits, other-window conflict, write failure, Custom reuse on another study, owner isolation, corrupt reads, partial native load failure and closing a queued Web Lock write. Presets are limited to the current institution/subject in this browser; no crop/camera/source is stored. Writes require Web Locks in the supported HTTPS/localhost entry point; unavailable writes are disabled while VR editing and read operations remain available. Server account roaming and cross-device restoration remain incomplete.

Execution evidence retains the original `sha256` and adds `lf_sha256`: byte-level CRLF-to-LF normalization, preserving lone CR and all other bytes even in binary files. It is not a Git blob ID or a clean-filter result. Missing/unreadable files have null hashes. `python tests/record_run_test.py` checks mixed endings across a 1 MiB read boundary, raw preservation, missing/unreadable inputs and existing recorder behavior; CI runs it. Historical records without the additive field remain valid raw records.

`TEST-VIEWER-NOTE-CONNECTION` now runs in CI with the history model tests. Its six cases include failure of every optional MPR asset and isolate required note/identity/dock dependencies from already available optional MPR modules and retain failure, timeout, repeated retry, mode exit and late-load assertions. `TEST-READING-NOTE-04` remains the actual browser asset-failure/retry and image/report preservation evidence for REQ-D01-NOTE-ASSET-RETRY.

`python tests/volume_recipe_precision_test.py` checks the actual saved-batch recipe assertion at large patient coordinates, near zero, and with deliberately wrong geometry/controls. Camera round trips use `rtol=1e-13, atol=1e-14`; identifiers, controls and rasters remain exact, and the separate native camera oracle remains `1e-6`. Run `test_volume_batch_save.py` case 01 for fresh-login/DPR replay when this tolerance changes.

### Worklist DICOM body-part search

`node --test tests/worklist_body_parts_test.cjs tests/compound_filter_test.cjs` checks real token semantics, unknown/error exclusion, bounded series reads, cancellation/resume and stale account/scope rejection. `python tests/worklist_body_parts_dom_test.py` uses isolated Chromium and synthetic QIDO responses with the actual worklist filter, saved-search editor and metadata loader. It verifies partial counts, explicit reads and editor/selection preservation; it does not use a PACS stack.

The fresh GitHub-hosted `measurements` profile additionally selects only `WorklistBodyPartsE2E.test_worklist_body_parts_01_actual_metadata_saved_default_and_clear` from `e2e/test_worklist_body_parts.py` through the guarded runner. Three owned synthetic CT studies exercise real DICOMweb metadata, saved/default search restoration, Clear, and unchanged report target/text/history. Never run this LiveStack fixture against the original local environment while isolation remains incomplete. Both pure DOM and real-stack evidence distinguish unverified metadata from verified missing BodyPartExamined.


## TEST-HP-LIBRARY — Personal rules, explicit Apply, and account storage

REQ-D-HP-LIBRARY → RISK-D-HP-WRONG-STUDY/STALE/OWNER/LOSS → TEST-HP-MODEL/DOM/API/NATIVE.
`hanging_protocol_model_test.cjs` and `hanging_protocol_validator_test.cjs` share strict JSON vectors. `viewer_hanging_protocol_dom_test.py` covers form edits, ordered first-match selection, explicit Vacancy and duplicates, owner CAS, empty-library save, corruption, stale requests/imports, and bounded native rollback. `viewer_hanging_protocol_mount_dom_test.py` exercises the authenticated config loader and stack-source filtering.

A plane cell is admitted only from a series the volume loader can reconstruct — the predicates `viewer-volume-job.js` and `viewer-volume-orientation.js` already enforce (CT Image Storage, MONOCHROME2 single-sample frames, one Frame of Reference, constant matrix/pixel spacing/orientation, collinear and evenly spaced positions, 2 to 256 frames) — and the model test refuses a topogram, uneven spacing, colour CT, mixed Frame of Reference and over-long series before any layout change. A plane is only *applied* once its viewport really holds the requested series as a fully loaded volume standing on the requested patient axis; a missing volume, a foreign volume or an oblique camera keeps the previous screen, and the rollback restores the camera the user was actually working in or refuses before mutating. `viewer_vr_binding_dom_test.py` additionally holds the three-plane tools bound when a Hanging Protocol leaves a fourth cell empty.

REQ-D-HP-JOB (IF-A01 "저장 후 재현") → RISK-D-HP-JOB-LAYOUT/ORIENTATION/SOURCE/OUTPUT → TEST-VOLUME-JOB: an MPR Job saved from a Hanging Protocol plane screen is snapshot **version 7**. It admits 1×1, 1×2 and 2×2 beside the existing 1×3/3×1, stores a vacancy as a `null` cell so a cell index stays a viewport index, and records an explicit `orientation` (`axial|sagittal|coronal`) per plane cell. Everything else is unchanged: one fully loaded, grayscale, opaque, eligible CT volume shared by every cell, real Study/Series/SOP references only, no reconstructed SOP or frame, and the whole-volume source digest the server computes. Versions 4-6 keep their exact three-plane shape — no `orientation` key, no vacancy, no other grid — and their batch/marks semantics; on a version 7 layout an existing batch recipe or 3D mark state is *refused by name* rather than dropped, so those stay three-plane features. A version 7 Job is explicitly refused before any export in both `viewer-jobs.js` and `viewer-job-print.js` and is labelled `MPR Plane Layout · 출력 미지원`, because `viewer-volume-job-print.js` reconstructs a fixed vacancy-free cell list; plane-layout output is separate geometry work. `tests/viewer_volume_job_capture_test.cjs` drives the real `viewer-volume-job.js` capture over a mocked grid (grid set, vacancies, active index on a vacancy, orientation source and refusal, version selection, v4/v5/v6 regression) and `tests/viewer_volume_job_test.cjs` does the same against the compiled server parser plus `verifyVolumeReference` with null cells. `HangingProtocolE2E.test_hp_05` proves the flow end to end: apply the 2×2 three-plane rule, manipulate a plane's camera and window, Save New Job, verify the stored v7 snapshot and reject an incomplete original, then reopen on the same account and device and restore over an HP-rebuilt screen, comparing native SOPs, planes, camera and VOI rather than labels. Merged geometry, larger/nested/freeform grids and version 7 output remain out of scope.

REQ-D-MIXED-JOB (IF-A01 "저장 후 재현", mixed cells) → RISK-D-MIXED-JOB-SHAPE/SOURCE/FRAME/OUTPUT → TEST-VOLUME-JOB: a Hanging Protocol rule may already place an ordinary stack alias cell beside `mpr` plane cells on the same 1×1/1×2/2×2 whitelist (`hanging-protocol-model.js`). That screen is snapshot **version 8**. It is admitted on the Hanging Protocol grids only — 1×3/3×1 and 2×1 belong to no rule that places both kinds — and it must actually be mixed: an all-plane grid stays version 7 and an all-stack grid stays version 2, so version 8 never shadows an existing shape and a 1×1 can never be one. Every non-null cell names its own `kind` (`plane|stack`); the server chooses that cell's key list, its reference rules and its verification from the discriminator, never from the snapshot version alone. A `plane` cell is a version 7 plane cell (one shared fully loaded grayscale opaque eligible CT volume, explicit orientation, no `sop`/`frame`, no reconstructed SOP); a `stack` cell is a version 2 frame cell (real Study/Series/SOP, `frame` 1) and may name either opened study. Both originals are verified for the one snapshot: the ordered whole-volume manifest/geometry/digest **and** every stack cell's own instance and digest, and both are re-checked on reopen. The single per-screen pixel budget (8192 per side, 16777216 per cell, 33554432 total) and the 28000-byte canonical cap are shared by both kinds, unchanged. The frame-cell shape has exactly one definition — `viewer-jobs.js` lends its own capture/resolve/restore to `viewer-volume-job.js`, which refuses a mixed screen by name if that helper is missing rather than dropping the cell. Restoring still requires a rollback snapshot of the current screen first; a screen no saved shape can read now says so in restore wording instead of repeating the Save guidance. Batch recipes, 3D marks, `Save Job with Annotations` and all output are refused by name on a version 8 shape, client and server, before any mutation or export; the row is labelled `MPR Mixed Layout · 출력 미지원`. `tests/viewer_volume_job_capture_test.cjs` drives the real module (kind discriminator, mixture rule, grid set, shared pixel budget, missing-helper refusal, marks/batch refusal, and that versions 2/4/5/6/7 gain no `kind` key) with the frame cell injected as a stub, because its content needs a DOM; `tests/viewer_volume_job_test.cjs` drives the compiled parser (accept matrix, unnamed/foreign kind, not-actually-mixed, foreign grid, cross-shaped keys, and `verifyVolumeReference` over a cell that has no slab). `HangingProtocolE2E.test_hp_07` proves the flow end to end on two real series: apply the mixed rule, manipulate the plane camera/window and the frame cell's chosen original frame/window, make the frame cell active, Save New Job, verify the stored v8 snapshot, reject both an incomplete volume and a frame cell pointed at a foreign instance, then reopen on the same account and device, restore over an ordinary single-cell screen, check the planes' whole ordered volume and axes, the frame cell's exact instance and window and the active index, and save again from the restored screen so the second stored snapshot is compared to the first. Merged geometry, larger/nested/freeform grids, version 7/8 output and mixed marks/batch remain out of scope, and IF-A01 is advanced rather than closed.

The manual `hanging-protocols` profile runs unchanged invariants69 → worklist14 → `HangingProtocolApiLive` → seven declared `HangingProtocolE2E` tests on a fresh synthetic hosted stack. The additive `HangingProtocolPreference` migration, production-image migration list and synthetic product-restore fixture travel together. Native tests verify Study/Series/SOP, rendered pixels, account reopening, stale frame/camera/layout responses and preserved report/original rows. Registration is not execution evidence.

Current/Related follows the viewer URL order. Only unambiguous native stack display sets with consistent study/series image identities are eligible; composite stacks, split series and specialized objects are refused. Apply First Match follows enabled rule order. Save Draft and account Save do not apply layouts; account Load is explicit. Definitions contain no patient snapshots or monitor coordinates. Retrieve AE means DICOM (0008,0054); unknown or mixed metadata does not match a specified condition. Other-user copying, physical monitor placement, and modality-specific display transformations remain separate requirements.

Yoyo direction persists through the native FPS stop/play effect and pause/resume. The deterministic stack/MPR lifecycle tests reproduce the descending-direction regression and check explicit range/mode/geometry resets. The late preload native test checks the pinned getter-only loader export, evicts one exact non-current SOP/frame cache entry, and holds its observed WADO request to exercise source retirement.


REQ-D-SOURCE-PDF → RISK-WRONG-SOURCE/OWNER/STALE-POPUP → TEST-SOURCE-PDF: `viewer_dicom_pdf_dom_test.py` checks strict native PDF identity, exact same-origin input identity, owner and PatientID access revalidation, popup ownership, timeout, source replacement and loader lifecycle. The pinned DICOMweb plugin does not serve Encapsulated PDF through /rendered. Both native viewport and explicit Open resolve the verified Study/SOP via the existing authorized lookup and read the canonical /instances/{id}/pdf endpoint; no API, proxy or database contract changes. Native preparation waits for mode activation, bounds resolution to 10 seconds, and permits explicit retry while retiring previous mode/session work. The manual `dicom-pdf` profile selects four declared native cases in `e2e/test_dicom_pdf.py`: original three-page PDF bytes and text, active source changes, real popup authorization and cancellation, and malformed MIME/bytes and popup failure. The pinned hook-free PDF viewport wrapper receives a source-specific React key during extension preRegistration, before ViewerLayout snapshots the component; the wrapper survives normal mode exit/reentry. The source GET preflight accepts only HTTP 200 application/pdf and cancels its body before final owner revalidation. This checks response availability/MIME, not complete PDF syntax. The PDF profile uses full Chromium (channel=chromium), whose new headless mode supports native PDF rendering; the default headless-shell downloads PDFs instead. The pinned raw PDF endpoint may return 200 application/pdf for malformed encapsulated bytes, so this preflight does not certify a readable document. The updated native retrieval cases remain unexecuted after the three-run PDF budget was exhausted. Native browser PDF page navigation, search and printing remain browser-owned controls; their full interaction is not claimed by these tests. Original report, draft, hold and DICOM preservation are asserted on the fresh synthetic hosted stack. Registration does not establish a passing native run.

Cine natural completion resets Yoyo direction so another Play starts a fresh cycle. Pausing or changing FPS retains the current direction; `cine_lifecycle_test.cjs` distinguishes both behaviors for stack and MPR timers, and native Cine case07 repeats a completed cycle.


REQ-D-IMAGE-THUMBNAILS → RISK-WRONG-FRAME/STALE/REQUEST-AMPLIFICATION/LOSS → TEST-IMAGE-THUMBNAILS: `worklist_image_thumbnails_dom_test.py` exercises the optional Series→Images integration, ordered 12-frame pages, exact zero-based SOP frame passed to Image Preview, four active workers across cancelled generations, streamed 16MiB metadata/4MiB PNG limits, timeout/retry, detached controls and URL/owner lifecycle. The fresh hosted manual `image-thumbnails` profile selects exactly four methods in `e2e/test_image_thumbnails.py` for actual multi-instance/multiframe pixels, ordering/pages, exact preview frame, report/draft/hold/original preservation, late-source/failure recovery and keyboard/narrow-window behavior. Registration is not native execution evidence. Only the current page is rendered; no background page cache, cross-window drag, or initial-frame OHIF navigation is claimed.

`worklist_narrow_layout_dom_test.py` reproduces the real worklist markup/CSS at 390x700 without services. Wrapped menus/filters remain scrollable within bounded heights, the study row keeps a clickable grid area, and full-width image context cards retain reachable keyboard controls and editor text. Hosted image profile case04 exercises actual login/search/selection before image browsing at the same size.

REQ-D-DISPLAY-SCOPE → RISK-WRONG-CELL/SOURCE/PARTIAL/LOSS → TEST-DISPLAY-SCOPE: the session-only Active/Set/All/Invert Selection panel applies explicit one-shot classic CT display operations through public viewport APIs. WW must be at least 1, matching the pinned native window tool; WW=1 retains its equal-bound threshold range. Group Reset requires an explicit, publicly restorable colormap and VOI snapshot; undefined native defaults are refused. The existing native Reset remains available. A failed W/L operation may restore pixels and VOI while materializing an undefined default colormap as Grayscale; it is reported as partial recovery, never an exact restoration. Source/layout replacement resets selection, all targets are checked before mutation, and partial failures restore only still-identical sources. Pure model and DOM tests cover selection, rollback, detached controls and session/loader boundaries. The manual `display-scope` profile declares four fresh synthetic native cases for CT pixels/WW-WC/rotation/flip/reset, exact target complement, injected intermediate failure and report/draft/hold preservation. Registration is not native execution evidence; no whole IF-V02/V09 completion or multi-modality/gesture/physical true-size claim.

REQ-D07-CELL-MERGE → RISK-D07-WRONG-CELL/WRONG-SOURCE/PARTIAL-LAYOUT/STATE-LOSS → TEST-CELL-MERGE-MODEL/DOM/NATIVE: 한 칸 확대와 인접 칸 병합을 세션 한정 표시 상태로만 제공한다. 기반 격자는 1×2·2×1·2×2의 균일 일반 CT 격자이며, 병합은 고정 native `setLayout({layoutOptions})`의 분수 사각형만 사용한다(maximize 1개, 2×2의 열/행 병합 3개). 확대되는 칸은 영상이 실제로 표시된 stack이어야 하고, MPR·3D·SR·PDF·미로딩 칸이 하나라도 있으면 요청 전에 전체를 거절한다. 영상 칸 더블클릭이 확대, 다시 더블클릭이 복귀이며 native cornerstoneTools가 소비했거나 드래그로 무시한 더블클릭은 `stopImmediatePropagation` 때문에 document까지 오지 않아 이중 처리되지 않는다. 버튼은 같은 동작의 접근 가능한 대체 수단이다. 복귀는 기록한 격자·원본과 카메라·W/L·현재 영상을 대조해 검증하며, 화면에 남아 있던 칸은 사용자의 최신 상태를 유지한다. 검증하지 못하면 복구했다고 말하지 않고 버튼과 제스처를 막는다. 병합 화면의 Recent Layout(`kin-viewer-layout-v1`)·Job v2~v3·MPR job v4~v6 거절 문구는 그대로 유지된다(병합 배치의 Job 저장은 아래 REQ-D-MERGED-JOB이 version 9로 따로 다룬다). 상시 `cell-merge` 프로필이 선언된 네 개의 합성 native 시험(더블클릭 확대·복귀, 열 병합 기하, 측정/판독문/저장 거절 보존, 빈 칸·실패 배치 복구)을 실행한다. 병합 상태의 저장·재열람은 REQ-D-MERGED-JOB이 다루며, HP 규칙의 병합 기하, 3×3 이상, 자유 사각형 선택은 IF-A01의 남은 요구사항이고 이 단위로 완료되지 않는다.

REQ-D-MERGED-JOB (IF-A01 "셀 병합 … 저장 후 같은 계정·기기 재현") → RISK-D-MERGED-JOB-SHAPE/SOURCE/FALSE-RESTORE/HISTORY → TEST-VOLUME-JOB: 병합한 칸 배치를 스냅샷 **version 9**로 저장하고 같은 계정·기기에서 복원한다. 저장 대상 기하는 `viewer-cell-merge.js`가 실제로 dispatch하는 것뿐이다 — 기반 격자 1×2·2×1·2×2·1×3·3×1의 maximize 하나와 2×2의 열/행 병합 네 개. 기하는 셀이 아니라 `rects`가 들고 있는데, 행·열 병합이 남긴 빈 칸도 사각형을 차지하기 때문이다. 셀 목록은 기반 격자가 아니라 그 사각형들을 덮으며, 병합이 흡수한 칸은 화면에 없으므로 무엇으로도 저장하지 않는다. 서버는 어떤 원본을 읽기도 전에 이 화이트리스트로 기하를 판정하므로 겹침·틈·격자 밖·중첩·자유 사각형·2×2가 아닌 기반의 행/열 모양·3×3 이상·셀 수 불일치가 DB에 닿지 않는다. 모든 비 null 셀은 v8처럼 자신의 `kind`(`plane|stack`)를 이름 붙이고, 서버는 스냅샷 버전이 아니라 그 판별자로 셀의 키 목록·참조 규칙·검증을 고른다. `plane` 셀이 하나라도 있으면 `volume`은 그 하나의 CT 볼륨 참조이고 없으면 `null`이며, 이 두 사실은 양방향으로 대조된다. 원본 검증은 줄이지 않는다: 볼륨을 든 v9는 순서 있는 전체 manifest/기하/digest를, 모든 stack 셀은 자기 instance와 digest를 통과해야 하고 재열람 때 다시 검사한다. 화면당 픽셀 예산과 28000바이트 정규화 상한, 계정·기관 경계와 `expectedRevision` CAS, 복원 전 현재 화면 rollback 스냅샷은 그대로다. 단면 묶음·MPR 3D 표식·`Save Job with Annotations`·모든 출력은 v9에서 이름을 들어 거절하며 목록 행은 `Merged Cell Layout · 출력 미지원`으로 표시한다. **병합 전 격자는 저장하지 않는다.** 병합이 없앤 칸의 카메라·창·프레임은 화면에 남아 있지 않아 저장하려면 만들어내야 하기 때문이다. 그래서 복원한 병합 화면에서 Restore Grid는 기록이 없어 계속 비활성이고, 확대를 시도하면 누를 수 없는 버튼을 가리키는 대신 "병합 전 격자는 저장되지 않아 되돌릴 수 없다"고 답한다. 병합을 수행한 세션 안에서는 Restore Grid가 전과 똑같이 동작하며 저장이 그 기록을 소비하지 않는다. 그 기록이 있는 동안 Restore Job은 배치 변경·검사 이동보다 먼저 거절된다: 복원이 배치를 바꾼 뒤 실패하면 새 viewport로 롤백되어 기록과 가려진 칸의 프레임·카메라를 되찾을 수 없으므로, 사용자는 Restore Grid 뒤에 복원한다. 병합 요청이 진행 중이거나 칸 병합 상태를 읽을 수 없을 때도 같은 자리에서 거절하고, 칸 병합 모듈이 없거나 기록이 없는 화면(저장된 v9 복원 화면 포함)에서는 복원이 그대로 진행된다. `tests/viewer_cell_merge_dom_test.py`의 두 Jobs 사례가 실제 세 모듈을 한 화면에 올려 거절·기록 보존·가려진 칸 복귀·기록 없는 화면의 v2/v9 복원·진행 중 병합과 입력 순서·외부 배치 변경을 검사한다. `tests/viewer_volume_job_capture_test.cjs`가 실제 모듈로 기하 판정·기반 격자별 maximize·네 개의 2×2 모양·빈 칸 보존·kind·볼륨 유무·공유 픽셀 예산·표식/묶음 거절·보조 도구 부재 거절과 기존 uniform v4/v7/v8 불변을 검사하고, `tests/viewer_volume_job_test.cjs`가 컴파일된 파서로 수용 행렬과 위의 모든 거절, v1~v8에 `rects`가 들어가지 않음을 검사한다. `HangingProtocolE2E.test_hp_08`이 실제 합성 CT에서 흐름 전체를 증명한다: HP 2×2 평면 배치 적용 → 축상면 카메라/창 조작 → Cell Merge 패널로 그 칸 확대 → 저장 → v9 스냅샷과 `volume.sourceDigest` 대조 → 불완전 볼륨과 지원하지 않는 사각형 세 가지 400 거절 및 Job 행 불변 → 같은 계정·기기의 새 화면에서 복원 → 복원된 사각형·기반 격자·전체 순서 볼륨·평면 축·활성 칸 확인 → 제품 자신의 capture로 되읽어 저장본과 필드별 대조 → Restore Grid 비활성과 정직한 거절 문구 확인. 네이티브 왕복은 예산 안에서 maximize 모양만 덮으며, 행·열 병합 모양은 두 순수 시험과 서버 화이트리스트가 덮는다. v9 출력, HP 규칙이 만드는 병합 기하, 3×3 이상과 자유 사각형은 범위 밖이고 IF-A01은 전진할 뿐 종료되지 않는다.

REQ-D-STUDY-ARRIVAL → RISK-STALE-COUNT/FALSE-ARRIVAL/REPORT-LOSS → TEST-STUDY-ARRIVALS: strict instance/series count deltas notify only existing studies and retain all original polling owner/commit/generation gates. The actual polling function DOM test covers row counts, combined notices, unchanged/decreased counts, stale responses, report draft/version/hold preservation. Since S3-U2b centralised that preservation, the harness slices the shipped `preservedLocal`/`mergePolledState` instead of stubbing them, so the draft/version assertions are produced by the product rule itself; a harness that slices `startPolling` without them makes the poll throw inside its own `catch`, which shows up only as a row that was never redrawn — `report_citation_client_test.cjs` pins that dependency. A separate manual study-arrivals profile declares four fresh synthetic native cases. Counts are DICOM instances, not multiframe frames; metadata reload and appending to existing native stacks remain separate incomplete requirements.


Latest Images (IF-V11): the Viewer Windows action allocates a fresh managed viewer document for the verified Study/prior/initialSeries scope. It preserves the old viewport and unsaved work, refuses same-scope/reuseClean replacement, honors the configured window limit, and reclaims blocked popup reservations. The existing viewer_windows model and viewer_window_manager DOM suites cover owner, stale row, full limit and popup retry boundaries. StudyArrivalsE2E case01 checks a new fifth SOP in the fresh native stack while the original four imageIds, display, unsaved Job, report/draft/hold and source hashes remain unchanged. This is explicit re-query in a separate document; in-place metadata append is not implemented.

Latest Images retains the source window's reading-return link. A refused fresh open reports within the Viewer Windows dialog and a pre-existing named-window collision releases its unused reservation without adopting or changing that document. Regular non-fresh opens retain the existing first matching window behavior; use Focus on the fresh window to revisit newly arrived images.


REQ-D-IMAGES-ONLY -> RISK-WRONG-SOURCE/IDENTITY-HIDDEN/UNSAVED-LOSS/STUCK-FULLSCREEN -> TEST-IMAGES-ONLY-MODEL/DOM/NATIVE. Images Only requests browser fullscreen for the selected loaded stack element, preserving its native canvas, annotations and patient identity. Exit and Escape return to the existing grid; native double-click one-up remains a separate layout operation. Entry verifies one display set, all image identities and owner/workspace readiness, with a 2000-image limit. Valid frame changes remain fullscreen; source/layout/session changes retire only the owned request. Pending browser requests are bounded with guidance and cannot overlap on the same element until settled. Pure model, isolated module DOM and actual config-loader DOM tests cover cancellation, denial/retry and late callbacks. The manual images-only profile declares exactly four synthetic CT native cases for geometry, identity, display/frame changes, preserved work, session exit and one-up restoration. Registration is not native execution evidence; MPR, other modalities, physical monitor placement and whole IF-V11 completion are not claimed.

Images Only native resize assertions use the pinned viewport zoom/pan presentation, which OHIF snapshots and restores around renderer resize. Raw parallelScale depends on the resized initial camera; every other camera field and source remains checked, and the original stable state is checked again after exit. Exit placement is remeasured against the current fullscreen and identity bounds, with one automatic exit attempt for unsafe geometry and explicit retry on rejection.

If all Exit positions would obscure identity and the browser also rejects programmatic exit, the unsafe button is hidden; browser Escape remains the fallback and Retry returns when safe geometry recovers. The layout-panel status retains the Escape guidance, but that panel is outside the fullscreen target. The brief post-exit click shield exempts Retry and any newer fullscreen owner.


REQ-D-IMAGE-TEXT -> RISK-WRONG-SOURCE/IDENTITY-HIDDEN/UNSAVED-LOSS -> TEST-IMAGE-TEXT-MODEL/DOM/NATIVE. The manual Display Image only requirement means hiding information text inside image cells; the existing selected-viewport browser fullscreen feature is separate. Image Text explicitly hides/shows native corner information, orientation letters and KIN patient/source labels in verified stack panes while leaving window identity, pixels, camera, annotation geometry, Job and report input unchanged. Owned pane attributes and a scoped stylesheet preserve pre-existing overlay classes/styles and cover newly rendered identity labels. Source/grid/owner/session changes restore text; same-stack frame changes retain the choice. Text hiding is unavailable during fullscreen; fullscreen entry and pending completion refuse the hidden-text state. The isolated loader, model and DOM suites cover these boundaries. The separate image-text synthetic profile tests this text-visibility workflow only; it does not retry the exhausted fullscreen h-key integration unit. Registration is not native evidence, and other modalities/specialized views remain unverified until exercised. The control requires verified KIN identity labels in every pane, unique source SOP entries, and at most 2,000 source entries/image IDs per pane; unsupported source shapes remain unavailable. Annotation labels and geometry are preserved rather than included in the hidden demographic/corner text.


REQ-D03-HP-NAV → RISK-D03-IDENTITY/STALE/LOSS → TEST-HP-NAV-MODEL/DOM/NATIVE: Previous Protocol / Next Protocol traverse fully matching enabled personal rules in library order without wrapping. Navigation starts from the last successful application; with an unset cursor, Next starts at the first match and Previous at the last. Editing, loading or importing the library and manual layout/source changes invalidate that cursor. Existing access verification, unsaved work protection, stale interaction checks and rollback remain in the Apply path. The account schema and automatic-apply policy are unchanged. Specialized Mammo loops and monitor protocols remain separate. Native verification uses the existing hanging-protocols unit and its remaining retry budget.

HP navigation confirmation and recovery: the native React layout request cannot be cancelled once dispatched. A timeout or changed context must not claim that the old layout was preserved. A confirmed rollback may restore the previous applied-rule label; otherwise clear that label and report that layout application/restoration could not be confirmed. Recovery must not overwrite subsequent user interaction or a different grid. When fresh verified study metadata makes the cursor rule stop matching, clear the stale cursor and allow navigation through the newly matching rules.

Native HP apply/recovery waits must release the editor after their time budget. A timed-out native Promise is not cancellation: further layout application must stay blocked while that earlier request could still land. An unconfirmed request requires reopening the viewer, with editing/saving controls and the displayed uncertainty guidance available; it must not silently re-enable navigation over a pending layout.
