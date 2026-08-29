# 살아 있는 불변조건 테스트

```powershell
docker compose up -d
python tests/invariants_live.py
```

테스트는 현재 저장소의 Keycloak·Orthanc 개발 설정을 읽어 실제 토큰과 C-STORE를 사용한다.
비밀번호를 환경별로 바꿨다면 `KIN_TEST_PASSWORD`와 `KIN_TEST_ORTHANC_PASSWORD`로 덮어쓴다.

각 픽스처는 임의의 Study UID로 매번 새로 전송되고, 종료할 때 그 UID의 Orthanc 스터디와
DB 행만 삭제된다. 정리 대상 UID가 숫자와 점 이외의 문자를 포함하면 DB 삭제를 거부한다.

현재는 `test_zzz_known_failure_concurrent_commit_must_not_return_500` 한 건이 의도적으로
빨갛다. 같은 검사의 동시 `commitReport`가 같은 version을 계산하는 잠재 결함을 다음 배치에서
고치기 위해 `expectedFailure`로 숨기지 않았다.
