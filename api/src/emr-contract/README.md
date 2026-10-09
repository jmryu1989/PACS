# EMR 단위 A — 분류와 계약

순수 계약만 제공하며 API·DB·인증·화면에 연결하지 않는다. D589·D591의 설계 자문 ①–④와 D593의 Addendum 초안 종료 명확화를 적용하며 충돌하는 이전 지휘 설계는 대체한다. 순수 시험은 후속 저장소·키·실제 삭제·법령 준수 인증의 완료 증거가 아니다.

| 파일 | 내용 / 소비자 |
|---|---|
| `composition.ts` | 서버 시작 시 단 한 번 저장소·법적 의무·초안 종료·재진료 reader 결속 / B, C, H |
| `classification.ts`, `routes.ts` | 기록 종류·저장 모델·제공 경로의 분류 / B–I |
| `lawful-defaults.ts`, `legal-basis.ts` | 기간·편입 참조·법적 보존·파기·서명 강화 / H, I, 전체 |
| `access-event.ts` | 대상 사실·행위·내구성·해시 체인·만료 checkpoint / B, C, D, E, F, H |
| `signature.ts` | 정확한 UTF-8 서명 바이트·ES256 JWS 봉투 / C, D, E |
| `report-lifecycle.ts` | 점유·승인·24시간 수정·추가기재·취소·새 단위·보존 전용 / C, H |

D590 소비자: B 접속 원장·신원 context·공통 선언, C 판독 작성·서명·공개·출력, D 임상 부가 업무, E 영상·객체 전송, F 감사 조사·사본, G 미서명 자료 이관, H 보존·분리·만료 파기(복제본·백업 포함), I 요구·법령·운영 증거.

## 소비 단위에 넘기는 계약 질문

- B — 초기 구성 위치는? 제안: B의 실제 서버 시작 모듈에서 `composeEmrAdapters`를 한 번 호출하고, 현재 A의 파일만 허용하는 호출 위치 시험을 B의 시작 경계로 확장하며 A에 DB 의존성을 넣지 않는다.
- C/H — archive 없는 만료·보전 기록의 접근은? 제안: 읽기에도 `reportRetentionAccess(facts, archive, resume, {record, at})`로 자체 만료를 확인하고 보전 기재의 `retentionOnlySince`를 판독·보존 사실과 같은 transaction에 저장한다.
- C/H — 보전 기재가 기한을 늘린 뒤 일반 Addendum 재개는? 제안: 보전 상태를 유지하여 `HeldCorrectionAuthorityRequired`로 거절하고 새 진료는 새 단위에 기록한다.
- H — 상호 편입의 동시 만료 호출은? 제안: `destroyBatchAtExpiry`에 전체 만료 묶음을 주고 `withRetentionBatchLock` 안에서 편입 기록 우선 순서와 SCC별 한 번의 원자적 집합 삭제를 이행한다.
- F/H/I — 응답기한과 의무 종료 증빙은? 제안: `responseDueAt`의 산정·연장 근거, 요청 `resolution`, hold `validity.until`, 귀속된 해제 `endingFact`를 구분하여 저장하고 기한 경과를 요청 완료로 기록하지 않는다.

## 분류와 기간의 단일 원천

`RECORD_CLASSIFICATION[kind].retention.statutoryMinimum`이 기간의 단일 원천이다. B의 서버 초기 구성은 `composeEmrAdapters({stored, legal, purpose, clinical})`를 프로세스당 한 번 실행한다. private binder로 생성한 동결 capability만 각 resolver가 인정하며 두 번째 구성은 `EmrAdaptersAlreadyComposed`로 거절한다. 요청별 reader 등록 함수는 공개하지 않는다. 등록 뒤 원 reader 메서드를 교체해도 capability는 바뀌지 않는다. 구성 함수를 요청 handler가 최초로 호출하지 않도록 B의 시작 순서와 TypeScript symbol 검사로 결속해야 한다. A 자체가 Prisma·HTTP·서버 시작을 구현하지는 않는다.

`resolveStoredRecord()`는 등록된 capability와 opaque ID로 저장 모델·행 사실·수명주기 사건을 확인한다. 호출자의 model/kind/기간 선언과 복제·역직렬화한 검증 결과는 거절한다. `retentionDisposition()`이 법정/목적/원기록/접속 처리 경로를 도출한다. 실제 적용 class와 `clauseId` 중 최장 기간을 사용한다. 사람이 서명하는 판독은 10년이며 임상 답변·협진은 처방전이 아니다.

| 법정 종류 | 기간 | clauseId (의료법 시행규칙 제15조①) |
|---|---|---|
| 환자 명부 | 5년 | `medical-rules:15.1.1` |
| 진료기록부 | 10년 | `medical-rules:15.1.2` |
| 처방전 | 2년 | `medical-rules:15.1.3` |
| 수술기록 | 10년 | `medical-rules:15.1.4` |
| 검사내용·검사소견 | 5년 | `medical-rules:15.1.5` |
| 방사선 사진·영상 및 그 소견서 | 5년 | `medical-rules:15.1.6` |
| 간호 / 조산 기록부 | 각각 5년 | `medical-rules:15.1.7` / `.8` |
| 진단서 등 부본 | 3년, 종류별 구분 | `medical-rules:15.1.9` |
| 접속기록 | 각 사건 2년 | `access-safety:8.1.2` (안전성 확보조치 기준) |

| 제품 내용 | 적용 계약 |
|---|---|
| 판독 현재판·불변판·수정·Addendum | 검사/영상 소견 + 진료기록부 후보, 최장 10년 |
| 임상 Q&A·협진·Critical Result 본문·Finding·임상 비교 설명·Order | 진료기록부 10년 |
| 영상·측정·Key Image·수동 SR·외부 SR/SEG·취득 메타데이터 | 검사/영상 5년. 서명 대상 판독 본문은 위 판독 분류 적용 |
| Tech Note | 검사소견기록 후보 5년, 독립 단위 |
| 영상/워크리스트 요청·환자 연결 | 환자 명부 5년 |
| 임상 인계 완료 ACK | 수신자·고정판을 검증한 `CriticalResultEvent`를 CVR의 part로 보존, 진료기록부 10년 |
| 별도 접속·단순 전송 영수증 | 각 사건 2년. ACK API의 재전송 영수증도 실제 임상 ACK 원본과 별개 |
| 고정 원기록의 출력·다운로드·썸네일·서명 증거 | `source-record`, 원기록을 따라 파기, 독립 기산 금지 |
| 개인 초안·dictation | 해당 결과판 서명·명시적 discard 또는 그 intent를 불가능하게 만든 저장 사건에서 목적 종료 |
| 배치·분류 자유 문구·양식·개인 설정·기타 운영 자료 | 아래 닫힌 목적 종료 사건, 임상 5/10년을 부여하지 않음 |

혼합 모델 목록은 가능한 내용의 영향 조사 목록이다. 저장소 어댑터는 같은 테이블의 모든 종류를 합치지 않고 저장 행의 discriminator와 실제 임상 채택·기재 사건을 확인한다. 예를 들어 단순 ViewerJob 배치는 목적 자료, 임상 설명을 기재한 판은 10년이다. StudyState 메타데이터 정정은 동일 메타데이터 단위의 `correction` part로 검사/영상 5년을 적용하고 이전 판과 `orig`를 보존한다. 환자 매칭은 명부, 배정은 목적 자료 경로다. Order의 `product-authored`는 새 제품 서명을 요구하고 `received-ris`는 검증된 수신 사건·원시스템·원서명 증거에 결속한 `received-order`로 10년을 적용한다. 수신 사건에 제품 서명을 만들어 붙이지 않는다. `source-record`인 썸네일·출력 등은 독립 시계가 없다. 접속기록은 `accessRetention(parsed event)`, 단순 전달은 `deliveryRetention(resolved)`로만 만들고 판독과 섞지 않는다. 임상 ACK는 새 독립 단위로 만들지 않고 같은 CVR에 추가한다.

이 어댑터는 HTTP 입력이 아니다. 서버가 저장된 모델을 찾아 행을 읽고 서명 검증·원내용 해시·행위·시각·원판·구성요소와 업무 사건을 대조한다. `verified`/`clinicalEntry` 같은 검증 사실을 클라이언트 body에서 복사하면 계약 위반이다. 저장 후 재적재는 `reloadRetentionRecord()`/`reloadPurposeRecord()`를 사용한다. 서버에 한 번 결속된 reader로 실제 저장된 part와 hold를 재검증한다. `reloadLegalHolds(recordId)`는 `listHolds()`의 명시적 `complete:true`와 hold ID 전수 목록을 요구하고, 각 holdId의 근거·범위·등록 당시 판본·유효 조건·해제 사건을 읽는다. 활성·종료·해제된 hold를 모두 복원하며 현재 시각으로 재등록하거나 시계를 옮기지 않는다. 빈 배열을 직접 넣거나 인증된 집합을 다른 기록에 붙이면 `HoldSetIncomplete`다. 새 기록 생성도 저장 hold 목록 조회를 생략하지 않는다. 실제 DB 조회·암호 검증은 B/C/H가 이행한다.

## 부분별 기산·편입 참조·민법 기간 계산

새 part는 실제 적법한 기록 사건에만 결속한다. `recordVersionAdded()`는 검증된 저장 사건의 record/version·원내용 SHA-256·기재/추가기재/정정·실제 시각과 바로 이전 판을 대조한다. 서명 대상은 검증된 해당 서명판, 영상은 취득 사건, 비서명 내용은 분류에 맞는 생성/ACK 사건이 필요하다. 열람·동일 내용 재서명·이관·장부정리를 거절한다. 각 part의 기산과 단위 최댓값은 완전한 기록 보존을 위한 제품 계약이며 법령이 모든 기산을 서명 시각이라고 직접 정했다는 주장이 아니다.

자체 기간 경과와 파기 가능 상태를 구분한다. `recordVersionAdded()`에는 사건 시점의 완전한 graph가 필수다. CVR 편입·적법 연장·유효 hold로 존속하는 단위는 적법한 새 part를 받을 수 있지만, 보존 근거 없이 만료한 단위는 부활시키지 않고 새 진료는 새 단위에 기록한다. hold 중에도 분류표가 허용하는 Addendum·ACK·취득·비서명 정정 모두 가능하며, 독립 처리 근거·권한·모든 hold의 조건·원본 보존을 확인한다. 서명은 해당 종류가 요구할 때만 필요하다. 수명주기 전이 후에도 보존 전용으로 남거나 hold만으로 만료 후 존속하는 때에는 분리 관리도 요구한다. 만료 전 archived 판독의 적법한 임상 Addendum은 분리 관리 주장을 요구하지 않고 공개·접근 복귀를 수명주기로 결정한다. C는 기존 단위의 서명판을 저장하기 전에 `transitionRetainedReport()`로 수명주기와 part 계약을 함께 검사한다. hold만으로 존속하는 보전 정정은 임상 접근이나 공개를 재개하지 않는다.

자체 기한(적법 연장 포함)을 넘겨 hold 또는 다른 기록의 참조로만 존속하는 판독은 archive 유무와 무관하게 보존 전용이다. C/H의 읽기는 `reportRetentionAccess`에 `{record, at}`를 함께 전달한다. 적법한 `preservationEntry`/`preservationCorrection`는 기존 공개판·본문판을 유지하고 공개 효과를 만들지 않는다. `transitionRetainedReport`가 남긴 `retentionOnlySince`는 보전 기재의 새 자체 기한이나 resume 사건으로 지워지지 않으며 `ordinaryClinicalAccess=false`, `separateStorage=true`를 유지한다. 이 사실은 재적재 때도 보존한다. 일반 임상 Addendum은 `HeldCorrectionAuthorityRequired`로 거절한다. 자체 기간 안의 일반 Addendum은 기존과 같이 공개할 수 있다.

`RetentionGraph`의 편입은 실제 본문을 이루는 바이트와 수정 전 원본으로 한정한다. CVR→차분판→기초 원본처럼 여러 단계로 저장되더라도 필요한 모든 판/바이트를 서명 시 **완전한 직접 구성요소 목록**으로 고정한다. `newRetentionRecord()`와 `recordVersionAdded()`가 생성/서명 사건 시점에 고정 해시·중첩 의존성·기존 보존 근거를 검사한다. 보존 근거 없이 만료한 구성요소와 파기된 구성요소는 `ComponentExpired`/`ComponentDestroyed`로 거절한다. hold만으로 남은 만료 구성요소를 새 임상 기록에 편입하려면 그 새 기록의 검증된 `processing`에 독립 근거·권한·원본 보존, 해당 `componentRecordIds`, 모든 활성 `permittedHoldIds`가 있어야 한다. 없으면 `ComponentProcessingBasisRequired`다. 이 근거로 적법하게 편입한 뒤에도 새 직접 편입 기록의 자체 기한만 적용하고 상속 기한을 재전파하지 않는다. 파기 시의 동일한 누락·해시 검사는 유지한다. 단순 비교·과거 검사·후속 판독 인용은 navigation이며 필요한 인용문 자체는 새 문서의 서명 바이트에 넣는다. 임의의 한 홉 제한도, 상속 기한의 재전파도 없다.

생성 검사에는 새 part를 추가하기 전의 snapshot을 전달한다. transaction 안에서 아직 확정하지 않은 새 참조판도 snapshot에 포함하면 `ComponentAdmissionSnapshotRefused`다. 새 참조판의 긴 기한을 먼저 반영하여 자기 구성요소의 만료를 가리는 순환 논증을 허용하지 않는다.

대상 단위의 기한은 자체 part/적법 연장의 최댓값과 대상을 직접 구성요소로 포함하는 각 법정기록의 **자체** 기한 중 최댓값이다. 다른 기록에서 물려받은 기한은 다시 계산에 넣지 않는다. 30년 비교 인용이 첫 판독의 자체 기한을 늘리지 않는다. 유효 hold는 필요한 직접 구성요소에도 별도로 검사한다.

B/H의 저장소 어댑터는 같은 잠금 안에서 역참조 전수 조회·모든 구성요소 및 법적 의무의 현재 상태를 확인하여 `complete/revision/checkedAt`을 공급한다. `destroyAtExpiry()`는 null/undefined/불완전 graph를 거절하고 `withRetentionLock()`이 다시 읽은 최신 snapshot의 내용 전체를 요청 snapshot과 대조한다. 잠금은 시작 원장·삭제·완료까지 유지한다. 잠금 안에서 저장 hold 전수 집합도 다시 읽어 누락·오래된 해제 상태를 거절한다. 기존 단위의 part/연장/hold는 `withRetentionChange()` 안에서 순수 결정을 실행하고 반환 값을 같은 잠금에서 저장한다. 새 편입도 구성요소와 역참조 변경 전체를 같은 잠금에 참여시킨다. `destroyedAt`은 B가 실제 완료/복구 상태에서 확인하는 파기 사실이며, 파기된 기록에는 hold·part를 추가할 수 없다. 조회 실패나 오래된 cache를 빈 목록으로 바꾸면 안 된다. 빈 참조는 완전한 조사 결과 0건일 때만 유효하다. 접속 단위에는 원환자 기록의 참조 의존성을 넣지 않으며 자기 hold/시계만 검사한다. 공통 만료 시점에는 **편입 기록 → 구성요소** 순으로 한 파기 작업을 수행한다. 같이 만료한 직접 편입 기록이 남으면 구성요소 파기는 `IncorporatorStillPresent`로 거절하므로 H가 선행 기록을 파기한 뒤 같은 시점에 재시도한다. 다른 부분만 참조한 후속 기록에서 편입 기록이 물려받은 더 긴 기한은 이 순서 검사로 재전파하지 않는다. 이 경우 구성요소는 자신의 직접 보존기한에 파기하고 관계없는 부분의 보존은 계속한다. 완료 tombstone의 참조는 보존을 연장하지 않는다. 파기 시에는 해당 대상을 보존하는 편입 기록의 완전한 목록·해시를 검사하되 대상 자신의 이미 소실된 outgoing 구성요소는 대상 파기의 근거가 아니다. 무관한 manifest 결함이나 자신의 구성요소 손실 때문에 기록 자체의 hold·적법한 Addendum을 거절하지 않는다. A의 순수 시험은 실제 DB의 잠금·역참조 전수성을 증명하지 않는다.

기간은 **Asia/Seoul 기관 역일**로 민법 제157조·제159조·제160조에 따라 계산한다. 초일은 불산입하되 오전 0시에 시작하면 산입한다. 연 단위는 역으로 계산하고 해당일이 없으면 그 월 말일의 종료까지 보존한다. `civilPeriodEnd()`/`retentionDeadline()`은 **말일이 완전히 끝난 직후 00:00 KST 경계**를 UTC로 반환한다. 파기는 이 경계 이상에서만 가능하다. 경계 직전 1ms도 보존 중이다. 별도 유예기간은 없다.

상호 편입으로 단일 파기가 교착되는 경우 H는 `destroyBatchAtExpiry({append, withRetentionBatchLock}, {units, requestedAt, graph}, destroySet)`을 사용한다. 과거 판 편입은 계속 허용한다. 계약은 전체 집합의 최신 graph·전수 hold·완전한 판 목록·각 기한을 먼저 확인하고, 묶음 밖의 미파기 편입 기록이 있으면 시작 원장/삭제 전에 거절한다. 강연결요소(SCC)는 한 집합으로 유지하고 축약 그래프에서 **편입 기록 → 구성요소** 순서로 처리한다. 각 SCC의 모든 시작 원장이 내구성을 얻은 뒤 `destroySet`을 정확히 한 번 호출하며 모든 구성원의 완료를 함께 확인한다. H는 그 집합의 모든 판·복제본·복구 가능한 백업을 원자적으로 파기해야 하며 구성원별 독립 삭제로 구현하면 안 된다. 실패 시 해당 SCC의 실패 원장을 남기고 다음 SCC로 진행하지 않는다. 시작/완료 원장 저장 실패의 복구와 재시도는 실제 저장소의 tombstone·원장 대조로 수행한다. A는 콜백 계약을 검사하며 실제 저장소 원자성을 구현하거나 증명하지 않는다.

| 시작 (KST) / 기간 | 보존 말일 종료 → 최초 파기 가능 경계 (KST) | 반환 UTC |
|---|---|---|
| 2026-10-05 00:00 / 5년 | 2031-10-04 종료 → 10-05 00:00 | 2031-10-04T15:00:00.000Z |
| 2026-10-05 00:01 또는 23:59 / 5년 | 2031-10-05 종료 → 10-06 00:00 | 2031-10-05T15:00:00.000Z |
| 2024-02-29 00:00 또는 23:59 / 5년 | 2029-02-28 종료 → 03-01 00:00 | 2029-02-28T15:00:00.000Z |
| 2026-10-05 09:00 판독 + 2036-09-01 09:00 Addendum / 각 10년 | 전체 단위 2046-09-01 종료 → 09-02 00:00 | 2046-09-01T15:00:00.000Z |

## 연장·보존 명령·목적 종료와 파기

D589의 시행규칙 제15조① 단서에 따른 **계속 진료 1회 연장**은 유지한다. 사유·행위자·시각을 기록하고 결정 시 존재하는 부분들의 기본 만료 전에 결정하며 같은 법정 기간 이내로 한정한다. 짧은 연장도 1회를 소비한다. 새 부분이 추가되어도 연장 횟수는 초기화되지 않는다. 접속기록은 이 연장을 사용할 수 없다. 기관 기간 설정은 같은 값·단축·증액 모두 금지한다.

hold는 **파기만 정지**하며 기산/기한/일반 접근권을 바꾸지 않는다. `LegalDutyReader`가 실제 요청·명령을 검증하여 고정 유형(법원/수사/감독 명령·법정 의무·미처리 열람 요청), 적용 법률·조항·판본, 검증한 requestId, 권한 주체, 대상 기록 범위, 효력 시작/종료와 유효 조건을 공급한다. `placeLegalHold()`는 이 조회 결과에 기록·행위자·시각을 결속한다. 병원 방침/가짜 문서번호/자유문구만으로 성립하지 않는다. 기관이 실제 법정 의무를 이행하려고 등록하는 경우는 허용한다. `verified`는 법적 의무 어댑터가 실제 문서·권한·대상·조건을 대조한 결과이며 관리자 입력값이 아니다.

파기되지 않고 존속하는 기록에는 자체 기한이 지난 뒤에도 검증된 hold를 등록한다. CVR가 보존 중인 기록·다른 hold가 보존 중인 기록·만료 후 파기 실행 전 기록을 모두 포함한다. hold는 집합이며 하나의 해제로 나머지를 해제하지 않는다. 법정 의무는 `HOLD_DUTY_CLAUSES`의 고정 clauseId·법률·조항·권한 주체를 대조한다. clauseId는 판본과 무관한 절 키이며 `HOLD_CLAUSE_VERSIONS`가 공포번호·공포일·시행일을 대응한다. 등록 시점의 KST 시행판을 hold에 고정하고, 재적재·해제도 그 등록 시점 판본으로 검사한다. 새 시행판을 추가해도 과거 표 항목을 제거하지 않는다. 표 밖의 명령 근거는 I가 검토한 절 버전 표를 결속된 `loadClauseVersions()`로 공급하며 자유문구·알 수 없는 판본은 거절한다. 현재 열거된 `privacy:36.2`는 `loadCorrectionRequest()`가 읽은 실제 정정·삭제 요청(범위·접수·응답기한·해결 사건)에 결속한다. 해당 개인정보처리자만 권한 주체이며 응답기한 이내의 유한한 until이 필수다. 등록자 자기 선언이나 존재하지 않는 요청·무기한 의무는 거절한다. 응답기한의 법적 산정·적법 연장은 어댑터가 근거와 함께 검증한다. A는 미검증 시행령 조문을 새 기간 상수로 만들지 않는다. 다른 의무의 지원에는 검토된 표 항목이 필요하며 기관이 표나 기간을 편집하지 않는다.

미처리 열람 요청은 `privacy:35.3`과 해당 요청의 유한한 `until`을 요구한다. 결속된 reader가 원 요청의 응답기한(검증된 적법 연장 포함)·대상과 이행/철회/적법 거절 사건을 읽는다. 요청이 해결되거나 효력이 끝나면 `retentionState().releaseNotRecorded`에 미해제 holdId를 보고한다. 효력 종료된 hold는 Addendum·취득·편입의 처리 조건을 추가하지 않는다. 파기는 해제 기록이 남을 때까지 `HoldReleaseRequired`로 거절한다. 원래 보존기한을 넘긴 기록의 임상 재개 금지는 별개로 유지한다. 해제는 그 해결 사건 ID와 해당 종료 사유를 대조한다. 종료일 없는 유효 법원 명령을 이 요청 규칙으로 자동 해제하지 않는다.

`effect-ended`는 **효력 종료 확인** 해제 사유다. 기존 `holdId`, 확인한 권한자·시각·증빙 ID에 `endingFact`를 결속한다. `validity-expired`는 저장된 `validity.until`과 같은 시각이고 해제 시각 이전이어야 하며, `request-resolved`는 검증된 요청 해결 사건의 ID·시각과 같아야 한다. 실제 요청의 이행·철회·적법 거절 사유도 기존대로 허용한다. 만료한 hold의 효력 확인은 미처리 요청을 완료로 바꾸지 않는다. 응답기한 자체는 실제 의무 종료 증빙이 아니며, I가 확인한 hold 유효 종료나 실제 요청 해결 사실을 읽어야 한다. 종료 사실 없는 미처리 요청의 해제·파기는 거절하고, 종료 사실이 있어도 해제를 자동 기록하지 않는다. 제35조·제36조 요청에 동일하게 적용한다.

등록 당시 절 판본은 20897(2025-10-02 시행), 기존 21445·21910을 내장 이력으로 보존한다. 20897의 공포·시행 메타데이터는 [국가법령정보센터 과거 시행판](https://www.law.go.kr/LSW/lsLinkCommonInfo.do?chrClsCd=010202&lsJoLnkSeq=1029335723)으로 확인했다. 첫 내장판보다 앞선 등록일은 결속된 `loadClauseVersions`의 검증된 과거 표를 우선 사용한다. 내장 범위의 시행판은 외부 표로 덮어쓰지 않는다. 외부 표도 공포번호·공포일·시행일과 조항을 검사하며 자유문구 판본, 미공급 이력, 등록일 재작성으로 대체하지 않는다. 이전에 수용한 표 항목은 삭제하지 않고, 실제 저장 이력에 추가 과거판이 있으면 I/B가 그 검증된 표를 재적재 전에 공급한다.

H/B는 파기/추가 잠금 안에서 명령·요청의 현재 유효 조건도 재확인한다. 조건이 소멸하면 **같은 holdId**에 종료 근거·권한자·시각을 담은 해제 사건을 즉시 저장하고 `liftLegalHold()` 또는 `liftPurposeLegalHold()`로 반영한다. 해제 증빙 ID는 원명령 ID와 달라도 된다. 유효 종료가 지났는데 해제가 없으면 `HoldReleaseRequired`로 근거 재확인/해제 처리를 요구하며 이를 계속 유효한 hold로 보고하지 않는다. 처리한 열람 요청이나 소멸한 근거를 무기한 보전 사유로 사용하면 안 된다. 남은 의무가 없으면 본래 만료와 마지막 해제 중 늦은 시점부터 즉시 파기한다. 해제는 새 시계를 만들지 않는다.

`purpose` 종류는 분류표의 `purposeEnds`에 다음 사건을 모두 고정한다. 모든 사건은 B가 실제 해당 기록/부모 판독/소유자와 결속한다. 기관이 시점·보유연수를 고르는 설정은 없다.

| 목적 자료 | 종료 사건 |
|---|---|
| 개인 초안·dictation 및 이전/비운 초안판 | 해당 결과판 서명·소유자의 명시적 discard 또는 `intent-superseded`: approve 초안의 타 판독자 승인, 부모 판독 취소, amend 초안의 수정창 종료 |
| study-organization·comparison-layout·reading-template | 소유자 삭제 |
| preferences | 설정 교체 또는 소유자 삭제 |
| assignment·identity-access | 배정/권한 관계 종료; 남겨야 할 변경 증거는 별도 접속기록 단위 |
| authentication-session | 세션 종료, 비밀은 의무기록 보존 대상 아님 |
| institution | 기관 설정 사용 종료 |
| transfer-governance | 동의·처리/전송 계약의 모든 의무 종료를 기존 업무 계약으로 확인한 사건 |
| system-operation | 해당 운영 작업 완료 |

`PurposeRecord`는 서버가 저장한 소유자·생성 시각·draftBinding(부모 기록·작업 intent·approve/addendum/amend)을 가진다. `resolvePurposeEnd()`가 저장 종료 사건을 읽고 `destroyAtPurposeEnd()`가 그 초안·intent·결과판·서명 action·실제 서명 시각과 초안 생성 **이후** 여부를 대조한다. 과거 부모 승인에 현재 시각을 붙이거나 Finalized timer로 새 Addendum 초안을 끝낼 수 없다. 해당 초안 소유자의 명시적 discard도 실제 저장된 사건이어야 한다. 모든 파기 거절은 구체적인 오류 code와 삭제 호출 0회·시작 원장 0건으로 시험한다.

`intent-superseded`는 원인이 된 저장 사건을 포함하고 별도 `loadIntentEndingFact()` 결과와 대조한다. 다른 독자의 승인판·작성자·초안, 사유 있는 취소판, 최초 승인으로 고정된 amendUntil 도달을 구별한다. D593: Addendum 초안의 목적은 해당 Addendum 서명·명시적 discard·부모 판독 취소에서 끝난다. 타 판독자의 본문 승인과 24시간 amend 창은 Addendum 초안을 끝내지 않는다. 취소는 해당 부모의 초안에, 수정창 종료는 amend intent에만 적용한다. 단순 Finalized·Release·이전 부모 승인은 새 Addendum 초안의 종료 사건이 아니다. 실제 종료 즉시 제21조① 파기 경로를 사용한다.

`destroyAtPurposeEnd()`는 최신 목적 자료/hold를 `withPurposeLock()` 아래 다시 확인하고 지체 없이 파기·시작/완료/실패 원장을 남긴다. 목적 자료의 hold 등록도 `withPurposeChange()` 안에서 최신 자료를 확인하고 저장한다. 목적은 종료됐어도 아직 파기되지 않은 자료에는 실제 hold를 등록할 수 있으며, `destroyedAt`이 있는 자료의 hold 등록/재파기는 거절한다. 승인 전 Save/Release는 개인 자료를 보존한다. 승인/새 Addendum/수정의 서명은 해당 결과판 초안의 `end-private-draft-purpose` 효과를 내지만 단순 최종화는 초안 종료 효과를 내지 않는다. 다른 intent의 후속 입력은 별도 목적 자료로 보존한다.

`destroyAtExpiry()`는 모든 단위 판의 정확한 집합을 요구하고, 내구성 있는 시작 기록 → 원본·이전 판·서명 payload·사본·복제본·복구 가능한 백업의 복원 불가능한 영구 삭제 → 성공 영수증 → 완료 기록 순서를 강제한다(제21조①②, 시행령 제16조①1). 실패/중단 및 완료 기록 실패는 H가 실제 삭제 상태와 대조·복구한다. 파기 지연은 파기를 더 막지 않으며, 표준 개인정보 보호지침 제10조①의 5일 경계를 넘어선 요청/완료에는 `overdue`를 남긴다. 작업은 만료/해제/목적 종료 즉시 실행하고 5일을 대기 설정으로 쓰지 않는다.

파기 기록은 **무엇을 지웠는지** 법정 class·clauseId·무작위 `disposalUnitId`·부분 수·만료일·1회 연장 사용 여부·실행일·지연 여부로 식별한다. 이 ID는 환자/검사/record/version ID나 해시가 아닌 전용 불투명 단위 식별자다. 원자료와의 매핑·검색 인덱스는 파기와 함께 제거하며 환자 데이터·본문·자유문구·접속 연결 ID를 원장에 남기지 않는다. 개인정보 보호책임자는 완료 batch를 `confirmDestruction()`으로 확인한다(제10조③④); 확인자의 직무 신원은 파기 대상 환자 정보와 구별한다.

## 보존 전용·취소 후 새 판독

Finalized는 24시간 수정창 종료일 뿐 목적 종료가 아니다. `archiveFinalizedReport()`는 저장된 finalization과 현재 공개판·해시·행위자·사유·시각에 명시적 진료 목적 종료를 결속한다. 보존 전용은 제21조③에 따라 다른 업무 자료와 분리 저장·관리하고 일반 조회에서 제외한다. H는 별도 보존 열람의 목적·역할·기관을 검사하고 접속을 기록한다.

`resumeClinicalUse()`는 권한 있는 radiologist의 명시적 요청과 서버 `ClinicalStudyReader`가 읽은 새 검사·원판독의 동일 환자/발급기관을 대조한다. 단순 evidenceId나 hold는 복귀 근거가 아니다. 일반 임상 목적의 적법한 후속 Addendum/수정은 원 Archive의 판/해시 검증 후 정상 보존을 반환한다. 보전 정정(`preservationCorrection`)과 보전 목적의 적법한 기재(`preservationEntry`)는 독립 처리 근거·권한·서명·원본 보존·분리를 확인하고 이력에 각각 `preservation-correction`/`preservation-entry`로 남긴다. 두 경로 모두 일반 임상 접근·공개를 재개하지 않는다. 단순 열람은 아무 상태도 바꾸지 않는다. 재사용 사건은 기산/만료를 변경하지 않는다.

첫 입력→In Progress, Save→개인 저장, Release→Unread 및 점유 세대 증가. Approve는 즉시 공개하며 `firstApprovedAt`·`originalSignerId`·24시간 `amendUntil`을 고정한다. 수정은 원서명자만 기한 직전까지 가능하고 모든 수정/추가기재는 새 서명판이다. 다른 작성자의 Addendum도 보존한다. Finalized 처리 지연이 기한을 늘리지 않는다. Preliminary의 지정 상급자·자기 승인 금지, Defer 사유를 유지한다.

사유 있는 Cancelled는 **그 판독 단위**를 닫는다. 기존 본문·공개판·Addendum·취소판·최초 승인 시계는 그대로 보존한다. `newReportAfterCancellation()`은 동일 studyId의 새 recordId와 취소 단위 참조를 만들며 새 단위만 Start/Approve와 자기 24시간 창을 갖는다. 취소 단위의 수정창 재개·재승인·Unread 복귀는 금지한다. B는 새 ID의 전체 이력 유일성, 동일 검사와 취소 사유 참조, 중복 후속 단위 생성을 원자적으로 검사한다.

## 접속 사건과 별도 저장소

성공한 환자 기록 사건은 환자 연결 snapshot·검사·기록·판이 모두 `known`이어야 한다. `surface`는 서버의 실제 라우트/외부 제공 경계에서 기록하며 target.kind가 그 경계 분류에 속하는지 대조한다. 판독 조회를 preferences로 바꾸어 면제할 수 없다. `not-applicable: non-record-target`은 **preferences, reading-template, institution, identity-access, authentication-session, system-operation**에만 허용한다. 자유문구 사유는 사실을 대체하지 못한다. 인증/인가 실패 전에 확인 불가능한 값은 `unresolved`; 실제 빈 결과는 명시적 빈 targets다.

`GET bootstrap`처럼 기록/비기록을 함께 제공하는 경계에서는 `parseAccessEvent(input, servedRows)`에 서버가 실제 제공한 검증 행 목록을 전달해야 한다. 목록 길이·행의 분류·기록/판을 대조하므로 target 라벨만 preferences로 바꾸어 면제할 수 없다. 실제 설정 행과 비기록 전용 경로의 면제는 유지한다. 저장된 혼합 사건의 재검증도 해당 서버 행 manifest가 필요하다. 접속 보존 생성에는 모듈 내부의 고정 AuditLog 어댑터를 쓰며 호출별 reader를 만들지 않는다.

멤버 성공 사건은 신뢰 프록시 IP가 필수다. `executor: service` + `cause: service-job`인 프로세스 내부 작업만 `not-applicable: in-process-service` IP를 허용한다. 서비스도 자기 불변 신원·역할·기관을 기록한다. 감사 연결 ID는 독립 난수 `audit:<UUID>`이며 인증 수단이 아니다.

`STATUTORY_ACT`는 모든 action을 제23조④ **기재·추가기재·수정·열람 또는 none**에 대응한다. write/approve-sign/draft-save는 기재, additional-entry/addendum은 추가기재, modify/amend/cancel/clear/discard는 수정이다. 제공/전송/표시/출력 단계는 열람, finalize/archive/resume/연장/법적 보존/해제/파기 및 실패는 none으로 별도 기록한다. none은 사건 생략을 뜻하지 않는다. 제공 준비·전송·화면 표시·명시적 ACK는 서로 다른 관찰이다. print-done은 앞 print-opened 참조가 필요하며 실제 종이 출력의 증명은 아니다.

B의 접속 저장소는 업무 기록과 **별도 저장소**이며 제23조④의 별도 보관과 제21조③의 분리 관리를 계약으로 강제한다. 런타임은 전용 INSERT만 가능하고 owner/superuser/UPDATE/DELETE 권한을 갖지 않는다. 각 저장 사건은 서버가 같은 append 안에서 단조 sequence·previousHash·SHA-256을 결속한다(`AccessChainEntry`). 외부 seal에 저장한 신뢰 tail까지 검증하여 중간/끝 누락을 확인한다. 별도 읽기 요청·사용자 확인창을 추가하지 않는다.

**append-only는 보존 중 사건의 불변성**이다. 2년 만료와 모순되지 않는다: 별도 retention-job 역할만 만료한 prefix를 삭제하며, 그 삭제를 같은 원자적 작업 안에서 `sealAccessExpiry()`의 체인 사건으로 기록한다. 삭제 끝 sequence·hash와 건수의 비개인 checkpoint가 남아 이후 체인 검증을 이어간다. 삭제 역할은 미만료/보존 명령 대상이나 임의 행을 삭제할 수 없다. checkpoint도 자기 사건부터 2년으로 관리하고 최소 비개인 seal만 갱신한다. 접속 사건은 원기록 기간/마지막 열람으로 자동 연장하지 않는다.

`provideAfterDurableEvent()`는 내구성 있는 제공 사건 전에는 본문을 보내지 않는다. 성공 쓰기/서명/공개/접속 append는 함께 commit하고 실패 사건은 업무 rollback과 별개 저널에 남긴다. B의 합성 실환경 시험은 런타임 UPDATE/DELETE/trigger 해제 거절, 저장소 분리, 위변조·누락 탐지, retention 역할의 미만료 삭제 거절, 삭제/checkpoint 중단 원자성·복구를 검증해야 한다. A의 해시 체인 순수 시험은 DB 권한의 실제 이행을 증명하지 않는다.

## EMR-B1: 접속사건 v2·SQL 저장 분류·단말 경계

`formatVersion: 1`의 필드·규칙·체인 바이트는 그대로다. `parseAccessEvent()`는 getter를 실행하지 않고 판본을 읽어 v1과 v2를 나누며 v2는 닫힌 두 분기다.

- **`online-auth`**: `auth.login`·`auth.entry`·`auth.logout`·`auth.session.expired`(법정행위 전부 none, `AUTH_STATUTORY_ACT`). `targets`는 항상 빈 배열이며 임상 대상을 합성하지 않는다. 실행자(`userId`)와 영향 신원(`affectedIdentity`)을 분리한다: 회원 자신의 로그인·종료는 같은 신원, 관리자의 isolation은 다른 회원, 세션 수거는 서비스 신원과 그 회원이다(`service:auth-session-sweep`, `INTERNAL_SURFACES`, IP는 `not-applicable: in-process-service`). 검증 후 거절한 로그인은 known 신원을 남기고 검증 전 거절은 unresolved다. 역할은 확인된 빈 배열도 known이며 DB 권한 판(`rightsVersion`)을 함께 둔다. 기관 미승인 회원의 인증 성공은 `actingInstitution: not-applicable / not-approved`로 임상 접근 성공과 구별한다. 성공은 신뢰 프록시 IP·관리기관·비인증 난수 세션 참조(`authref:<UUID>`)가 필요하고 실패에는 세션이 없다. `auth`의 `endCause`·`failureCause`·`trigger`는 닫힌 값이며 trigger는 재인증 종료에만 있다. 원사건 ID는 서버가 만든 UUID다.
- **`verified-offline`**: 단말에서 실제로 일어난 임상 행위. IP는 항상 `unresolved: offline`(재접속 IP는 `relatedEventId`의 별도 수신사건), 기기·kid·사전권한·시간 근거/불확실도·기기 순서·대상 manifest·실제 signedAt을 요구하며 이 사실은 서버 시작 시 한 번 구성하는 `composeOfflineReceiptVerifier()`의 결과와 같아야 한다. 본문의 `offline`/`verified` 플래그는 근거가 아니다. C의 실제 키·서명 검증이 없는 현재는 아무것도 구성하지 않으므로 이 분기는 `OfflineVerificationUnsupported`로 거절된다(B2가 main.ts에서 구성 위치를 정한다).

B의 SQL 전용 저장(schema `emr_access`, 전용 tablespace)은 Prisma 모델이 아니므로 `SQL_STORAGE_CLASSIFICATION`에 따로 분류하고 실제 catalog와 양방향 대조한다. 법적 보존 의무·요청(`legal-duty`)과 검토된 조문 판본 이력(`legal-reference`)은 원기록을 따르는 증빙이다(`source-record`). 저장된 접속사건은 `emr_access.access_entry` 모델로 A의 고정 접속 매핑과 같은 사실을 돌려준다.

D596 단말 경계(`TERMINAL_RECORD_BOUNDARY`, 저장은 C의 단말 대기열): 미전송 서명 원본(`offline-signed-original`)은 서명자 소유, 실제 signedAt부터의 판독/진료기록 기간이며 private-draft의 목적 종료로 지워지지 않고 수신·재인증 시각으로 기산하지 않는다(`TerminalOriginalTimeRefused`). 복구·재검토 작업본(`recovery-working-copy`)은 같은 회원 소유·원본 사건 참조·목적 ID를 가진 목적 자료이며 검증된 원본 수신(`original-received`) 또는 소유자 폐기에서 끝난다. 상태는 `pending-transmission`·`received-unverified`·`verified`·`verification-refused`다.

**A low 이관 상태(B1):** L5-02의 B 부분은 `emr_access.clause_version`(설치 자격만 기록, 수정·삭제 거절)과 결속 reader의 전체 hold 목록(활성·종료·해제, `complete:true`, 조회 실패는 빈 집합이 아님)이다. F/H/I 부분은 남는다. L5-05(main 단일 구성·AST 허용 위치 이동)는 B2, L5-01·03·04·06은 C/F/H/I 그대로다.

## 서명·키·검증 범위

의료인의 임상 기재는 제22조①·제23조①에 따라 각 작성판을 서명한다. Tech Note·초안 등 인간 작성 작업 자료는 실제 임상 기재 시 서명을 요구한다. 서명 강화 설정은 `required`/`clinical-entry-only` 종류만 허용하며, 장치 영상·썸네일·접속기록·시스템 작업 등에 사람이 하지 않는 서명을 요구할 수 없다. source-evidence는 원서명/출처를 보존하고 신규 임상 의견은 별도 임상 종류로 저장한다. 외부 AI 자료는 원문을 재계산·재해석하지 않는다.

서명 v1은 `canonicalPayload()`의 고정 필드 순서 JSON UTF-8 바이트이며 본문 공백·CR/LF·Unicode를 정규화하지 않는다. 이전 판·첨부의 record/version ID와 해시, 환자·검사·기관·작성자·서명자·서버 시각을 결속한다. JWS는 ES256, 등록 kid, emr-signature+jws, 64바이트 R||S이며 봉투 검사는 암호 검증을 대체하지 않는다. C는 내용 무결성·신원 등록·당시 키 소유/활성을 각각 검증한다.

키 기본값은 의사별 보호 볼륨·볼륨/DB 밖 별도 wrapping secret·암호화 보관, 브라우저 키 반출 금지다. 복구는 신원·권한 확인과 서로 다른 두 운영자, 새 kid 발급을 요구한다. 폐기 키는 되살리지 않고 기존 서명 검증 증거는 원기록 수명에 따른다. 실패하면 새 서명을 막고 유효한 기존 내용은 보존한다.

REQ-EMR-01/17/19 → RISK-EMR-01/17/19 → TEST-EMR-01/17/19-A: 분류·최장 기간·부분·참조·역일·목적·보존 명령·파기. REQ-EMR-06/07 → RISK-EMR-06/07 → TEST-EMR-06/07-A: 사실·체인·내구성. REQ-EMR-02/12/13 → RISK-EMR-02/12/13 → TEST-EMR-02/12/13-A: 역할·점유·수정창·취소 후 새 단위·보존 전용 해제. REQ-EMR-04/05 → RISK-EMR-04/05 → TEST-EMR-04/05-A: 서명 바이트·봉투. 최종 CI/G3·독립 판정·실제 운영 검증은 후속 B–I 통합과 후보 관문에서 확인한다.

시험은 설치된 Prisma generator와 TypeScript AST로 모델/실제 Nest 라우트를 대조하며 `os.tmpdir()`의 inventory를 finally에서 제거한다. P06(성공 unresolved 대상), P07(Archive 해시 무시), P08(print-done 선행 사건 생략), P09(성공 unresolved IP), P10(접속기록 연장)의 독립 행동 사례와 반대쪽 허용 사례를 둔다. 시험은 구현 문자열/한국어 근거 문구를 고정하지 않으며 바이트 동일성은 서명 상호운용 계약에만 사용한다.

## 확인한 법령 판본과 열린 법적 쟁점

법령은 지정된 `legalize-kr` 사본의 파일·front matter와 조문/부칙을 대조했다. 날짜는 법령 판본 식별 정보뿐이다. 특히 **2026-12-10은 제21776호 개정 의료법 시행일**이며 제품 일정이나 기관 기한이 아니다.

| 원문 경로 | 법령MST / 공포번호 | 공포일자 / 시행일자 | 확인 범위 |
|---|---|---|---|
| `legalize-kr/kr/의료법/법률.md`의 현행 이력 | 285327 / 21524 | 2026-04-07 / 2026-04-07 | 제22조·제23조; 현행 ④는 추가기재·수정 |
| 같은 파일의 개정 본문 | 286719 / 21776 | 2026-06-09 / 2026-12-10 | 제22조·제23조와 부칙; ④에 기재·열람 추가 |
| `legalize-kr/kr/의료법/시행규칙.md` | 286963 / 01177 | 2026-06-12 / 2026-06-12 | 제14조·제15조·제16조 |
| `legalize-kr/kr/개인정보보호법/법률.md`의 현행 이력 | 283839 / 21445 | 2026-03-10 / 2026-09-11 | 제21조; 사본 최신 본문의 미래 시행판과 구별 |
| `legalize-kr/kr/개인정보보호법/법률.md` 최신 공포본 | 289415 / 21910 | 2026-09-08 / 2027-03-09 | 제3·15·21·58조; **시행 예정** |
| `legalize-kr/kr/개인정보보호법/시행령.md` | 289537 / 36671 | 2026-09-10 / 2026-09-11 | 제16조①1 |
| `admrule-kr/국무총리/개인정보보호위원회/고시/개인정보의 안전성 확보조치 기준/본문.md` ([원문 소재](https://www.law.go.kr/LSW/admRulInfoP.do?admRulSeq=2100000281400)) | 행정규칙 식별자 2100000281400 / 2026-9 | 2026-07-01 / 2026-07-01 | 제8조①2 본문과 시행일자 확인; 부칙은 사본에 없어 **원문 미확인** |
| `admrule-kr/보건복지부/_본부/고시/전자의무기록의 관리·보존에 필요한 시설과 장비에 관한 기준/본문.md` | 행정규칙 식별자 2100000232676 / 2023-245 | 2023-12-14 / 2023-12-14 | 제2조·제3조·제4조·제5조·제6조 확인; 별표·부칙은 **원문 미확인** |

지휘자가 확인할 쟁점은 다음과 같다. 이 항목은 기관 입력이나 결정 대기가 아니며 기본 보호 설정을 비우지 않는다.

- **D589/D591 반례 검토:** 개인정보 보호법 제21조① 단서는 실제 다른 법령의 보존 의무 범위에 한정된다. 개별 처리 근거·환자 요청은 모든 임상 기록의 일괄 연장 근거가 아니다. 종류별 기간·계속 진료 1회 연장을 유지하고 실제 편입 바이트/수정 전 원본은 완전한 직접 목록과 각 법정기록의 자체 기한으로 보존한다. 단순 비교 인용·상속 기한의 재전파·무조건 한 홉 절단을 모두 금한다.
- **개정안:** 보건복지부공고 제2026-696호는 공포·시행 법령으로 확인되지 않은 개정안이며 적용하지 않는다. 공포본과 시행일 확인 후 기간/접속기록 계약을 재대조해야 한다.
- **판본 검증의 한계:** 고시의 부칙 및 시설·장비 기준 제7조의 기관 외 보관 별표는 원문 미확인이다. 본문에서 확인한 제8조①2의 2년 하한, 시설·장비 기준 제3~6조의 서명 검증·이력·백업·보안 보호를 적용하되 미확인 별표나 미래 개정까지 준수 검증을 끝냈다고 표시하지 않는다. 관련 법령 변경은 제품 계약 갱신 대상으로 관리한다.
