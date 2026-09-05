# 살아 있는 불변조건 테스트

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

전체 불변조건(v0.6.3 기준 65개)은 두 기관 fixture를 쓰므로 로컬 `cstore` 모드로 실행한다. Gateway smoke는
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
