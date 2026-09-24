# KIN Gateway

병원 안의 DICOM 장비/PACS에서 C-STORE를 받고 KIN으로 HTTPS STOW-RS를 보내는 설치물이다.
현재 범위는 병원 → 자기 KIN 테넌트 수신뿐이며, KIN 영상을 원내로 가져오는 Import 방향은
Transfer 수신 API가 추가되는 후속 커밋 전에는 열지 않는다.

**Phase 1 지원 범위는 CT다.** 단일 DICOM 인스턴스가 24 MiB를 넘는 다중 프레임 유방
토모신테시스·XA/US 시네는 자동 재시도하지 않고 `failed`로 남긴다. 해당 경로의 업로드 상한과
전송 방식이 별도로 승인되기 전에는 이 Gateway로 보내지 않는다.

## 설치

1. `.env.example`을 `.env`로 복사하고 실제 값을 채운다. `.env`와 SQLite 큐는 커밋하지 않는다.
2. Keycloak에서 `gw-<institutionId>` confidential client를 만들고 client credentials를 켠다.
   서비스 계정은 해당 기관 그룹 하나와 realm 역할 `gateway` 하나만 가져야 한다.
3. `orthanc.json`의 `DicomModalities`를 실제 원내 송신 AE Title 화이트리스트로 바꾼다.
4. 이 디렉터리에서 `docker compose up -d --build`를 실행한다.

원내 장비는 Gateway 호스트의 `${GW_DICOM_PORT}`와 AE Title `KINGW`로 보낸다. Gateway의
로컬 REST 포트는 진단용으로 localhost에만 열리고, 클라우드로는 outbound HTTPS 443만 필요하다.
인터넷에서 병원 안으로 여는 인바운드 포트는 없다.

```bash
docker compose ps
docker compose logs -f gw-agent
docker compose exec gw-agent python /app/agent.py status
```

에이전트는 `StableStudy`를 `/changes`로 감지하고 SQLite에 큐를 먼저 남긴다. 검사마다 announce한
뒤 DICOM 인스턴스를 HTTP 본문 최대 24 MiB 묶음으로 직접 STOW한다. 응답의 실패 SOP만 남겨
지수 백오프로 재시도하며, 완료 조건은 로컬 SOP 집합과 성공 SOP 집합의 정확한 일치다. 같은
Study가 다시 stable이 되면 완료 큐를 재개해 늦게 온 인스턴스의 차분만 보낸다.
`status`의 `failed`는 같은 바이트로 재시도해도 성공할 수 없는 영구 실패 수다. 각 행의
`lastError`를 확인해 송신 대상과 지원 범위를 바로잡은 뒤 새 StableStudy 이벤트로 다시 연다.

announce가 성공한 검사마다 에이전트는 전송 영수증(`/api/gateway/receipt`)을 보낸다. 영수증에는
UID·단계·병원 보유 N건 중 보낸 M건·재시도 횟수·고정 오류 코드·큐 epoch·검사별 seq만 들어가고,
`lastError` 문구·시각·기관은 들어가지 않는다. `complete`는 "마지막 확인 때 들고 있던 SOP를 다 보냈다"는
뜻일 뿐 검사가 끝났다는 뜻이 아니다. 영수증 실패는 전송에 영향을 주지 않는다. SQLite 큐를 지우고 새로
만들면 새 epoch가 되고, KIN은 이미 이전 epoch로 보고된 검사의 새 epoch 영수증을 거절한다(승인된 교체
절차가 생기기 전까지). 전송은 계속되지만 그 검사들의 워크리스트 보고는 갱신되지 않으므로 큐를 지우지 않는다.

**Now Retry(S4-U4)는 `retry` 행에만 있는 요청이다.** 기사(admin 포함)가 워크리스트에서 누르면 KIN은 그 순간
저장된 `retry` 영수증의 (epoch, seq)에 묶인 요청을 남기고 감사로그에 요청자와 서버 시각을 적는다. 에이전트는
고정 30초 주기(설정·환경 변수 없음, 시작 30초 뒤 첫 조회)로 자기 epoch의 요청 UID 목록만 가져온다. 병원 쪽 포트는
여전히 열지 않는다. 적용 전에 그 행의 현재 영수증을 다시 보내 KIN이 `duplicate`라고 답할 때만 `next_at`을 0으로
당긴다. `attempt`·`lastError`·오류 코드·성공 SOP·개수·seq는 그대로라 다시 실패하면 백오프가 이어서 늘어난다.
조회는 주 루프 안에서 돌므로 전송이 진행 중이면 그 전송이 끝날 때까지 밀리고, 당겨진 행도 이미 전송을 기다리는
다른 행보다 앞서지 않는다.
화면의 `Retry Requested`는 "요청을 남겼다"는 뜻이지 재시도가 실행됐다는 뜻이 아니다. 전달은 한 번만이라고 보장하지
않으며, 요청 하나가 만드는 효과는 최대 한 번의 `next_at` 변경이다. 이 판단은 **한 에이전트 프로세스만 자기 epoch을
쓴다**는 전제에 기대므로 같은 `queue.db` 사본을 두 호스트에서 돌리지 않는다. `failed`(F-01, 같은 바이트로는 성공할
수 없음)에는 요청 컨트롤이 없고 KIN도 거절한다.

## 로컬 검증 전용

`python gateway/verify_c6.py`는 **로컬 개발 스택 전용**이다. Keycloak Admin API로 임시 역할·
클라이언트·사용자를 만들고 시험 DICOM과 DB 행을 삭제하므로 운영 렐름이나 실제 의료기관
Gateway를 대상으로 실행하지 않는다. 운영 smoke는 `tests/README.md`의 지정된 fixture 명령을
사용한다.

로그와 큐에는 UID·SOP UID·개수·바이트 수만 남기며 환자 이름과 PatientID는 남기지 않는다.
`KIN_TLS_VERIFY=false`는 자체 서명 인증서를 쓰는 로컬 검증 전용이다. 운영에서는 신뢰할 수 있는
CA 인증서를 사용하고 기본값 `true`를 유지한다.
