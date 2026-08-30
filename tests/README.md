# 살아 있는 불변조건 테스트

```powershell
docker compose up -d
python tests/invariants_live.py
```

테스트는 현재 저장소의 Keycloak·Orthanc 개발 설정을 읽어 실제 토큰과 C-STORE를 사용한다.
비밀번호를 환경별로 바꿨다면 `KIN_TEST_PASSWORD`와 `KIN_TEST_ORTHANC_PASSWORD`로 덮어쓴다.
`kin-web`은 Authorization Code + PKCE 전용이므로 password grant를 켜지 않는다. 실행 감사는
운영 렐름 파일에 없는 로컬 전용 클라이언트를 만들고 `KIN_TEST_CLIENT_ID`로 지정한다.

각 픽스처는 임의의 Study UID로 매번 새로 전송되고, 종료할 때 그 UID의 Orthanc 스터디와
DB 행만 삭제된다. 정리 대상 UID가 숫자와 점 이외의 문자를 포함하면 DB 삭제를 거부한다.

`test_zzz_known_failure_concurrent_commit_must_not_return_500`은 동시 확정 16건에서 500이
한 건도 나오지 않는지 검사한다. 성공 1건을 제외한 충돌은 409여야 한다.
