# api/src/pacs — PACS 업무 API의 concern 지도

`PacsService`(`api/src/pacs.service.ts`)는 컨트롤러와 다른 서비스가 주입받는 **유일한 Nest provider**이자 공개 facade다.
업무 구현은 이 디렉터리의 concern 객체 15개와 값 함수 모듈 1개에 있다. facade는 constructor에서 concern을 `new`로 한 번씩
만들어 `private readonly` 필드에 둔다. 공개 메서드 64개는 같은 이름의 concern 메서드에 인수를 순서 그대로 넘긴다.
concern은 Nest provider가 아니며 decorator가 없다. 그래서 DI 그래프(토큰, constructor 순서, scope, 전역 guard/interceptor,
middleware)는 분할 전과 같다(S9-U0b, `tests/pacs_split_test.cjs` U0B-DI).

```
Controller ─▶ PacsService (facade, @Injectable, 5 DI 의존성: Prisma·Orthanc·Keycloak·StudyAccess·Finding)
                 │ constructor에서 생성·소유
                 ▼
 values ◀── access ◀── institutions · preferences · filters · audit · metrics
                         ◀── worklist · dicom-gateway · study-state · tech-note · hold ◀── clinician
            access ◀── report-evidence ◀── report-draft ◀── report-commit
```
화살표는 소비자 → 공급자 방향이다. 실행 시간 import 순환은 없다. concern끼리의 클래스 참조는 `import type`뿐이고,
실제 객체는 facade가 생성자 인수로 넘긴다.

## 어디서 무엇을 강제하나

| 파일 | 맡은 일 | 강제하는 규칙(AGENTS §1)·상태 |
|---|---|---|
| `values.ts` | `toClient`, 초안 경계(작성자·세대·revision) 요청 해석과 답 봉투, QIDO 개수, hold 유효시간(5분), 트랜잭션 오류 변환 | 상태·IO 없음. 비울 수 있는 필드는 `null`(§4), QIDO 모름은 `null`(0이 아님) |
| `access.ts` | `Caller`, `need`·`needExact`·`inst`, `visible`, `gate`, `scopeWrite`, `myDraft` | §1.4·§1.5: 역할은 `need()`, 기관은 `visible()`(admin도 예외 없음). 쓰기 관문은 트랜잭션 안에서 StudyAccess 재검사 |
| `institutions.ts` | 기관 캐시, 기동 시드(`onModuleInit`), DICOM 기관명 해석, 미배정 검사 배정, 판독의 명부 | **기관 캐시는 이 객체 하나**. 모르는 기관명은 미배정으로 남김 |
| `preferences.ts` | 작업공간 배치·Hanging Protocol·단축키·글자·열·메모 자동 열기, 판독 상용구 | 설정마다 형식 검사 + revision CAS 쓰기. W3 validator의 현재 자리(`workspaceValue`) |
| `filters.ts` | 개인 검색 모음, 기관 공유 검색 | 두 모음을 함께 잠그는 쓰기는 개인 → 기관 순서 |
| `audit.ts` | 감사 행 쓰기(`audit`), 검사별 감사 읽기(`audits`) | 기록 당시 기관·소유 기관 전용 action(`OWNER_ONLY_AUDIT_ACTIONS`·`INSTITUTION_AUDIT_ACTIONS`)을 SQL 안에서 거름 |
| `metrics.ts` | 관리자 운영 지표 | 관측 불가는 0이 아님. 시계·대기 상한은 이 객체 하나 |
| `worklist.ts` | 워크리스트 목록·초기 묶음, 처음 본 검사 등록(도착 감사), 관측 부재, 오더 대사 | 응답 전 접근·판독 상태 재확인(바뀌면 409 `STUDY_LIST_CHANGED`) |
| `dicom-gateway.ts` | DICOMweb 관문, SOP lookup, Gateway 수신 예고·전송 영수증·Now Retry | Gateway 면은 admin 예외 없음(`needExact`), 영수증·재시도 멱등 |
| `study-state.ts` | 상태 PATCH, 매칭/해제, 검사 행 삭제, 원격판독 전이표 | §1.6: `rs`·`repDoc`·`confirm`은 PATCH로 바꾸지 않음. 원격판독 취소 시 수신 기관 판독의 배정 종료 |
| `tech-note.ts` | Tech 메모 판 | 권한 → 검사 잠금 → 시도 ID → 판 번호. 같은 시도는 같은 판, 감사 1회 |
| `hold.ts` | 판독 점유·해제·강제 해제 | 남의 살아 있는 점유는 막지 않고 알림. 강제 해제는 admin 전용이고 감사를 남김 |
| `clinician.ts` | 임상의 목록·판독 읽기·뷰어 머리판·타임라인 | 워크리스트 목록을 그대로 부르고 좁힘. 판독 상태는 한 SQL 문장 스냅숏 |
| `report-evidence.ts` | 인용·구조화 검증·한도, 판독 이력과 인용·구조화 읽기 | 인용은 소견 가독을 다시 검사. DB CHECK는 409로 옮김. 구조화 서식 목록은 이 객체 하나 |
| `report-draft.ts` | 내 초안 저장·비우기·버리기·관리자 강제 해제, 초안 읽기, 받아쓰기 관문 | §1.2: 초안 키는 `(uid, author)`. 초안을 바꾸는 길은 모두 `draftTransaction`(세션 → 검사 → 초안 잠금, 감사는 같은 트랜잭션) |
| `report-commit.ts` | 판독문 확정 `commitReport` | §1.1·§1.3: 판은 추가만 함. A에서는 Addendum·사유 있는 Reset만 허용. P는 지정 상급자만 승인 |

## 바꿀 때

- 공개 API를 더하거나 바꾸면 facade 전달, 소유 concern, `tests/pacs_split_spec.json`의 facade 계약을 함께 다룬다.
  분할 동등성 시험은 원본의 125 멤버·57 선언을 이 지도로 결속한다.
- concern 사이 호출은 생성자로 받은 객체를 통해서만 한다. service locator, facade 역참조, 동적 mixin, prototype 조작,
  concern에 decorator 붙이기는 하지 않는다. 감사 검사기(`tests/admin_audit_attribution_test.cjs`)는 이 형태만 증명한다.
- 남은 U0f 부채(그대로 옮김): `metrics.ts`의 `this.orthanc['get']('/statistics')`, 시험용 protected seam
  (`metrics.ts`의 시계·대기 상한, `report-evidence.ts`의 구조화 서식 목록).
