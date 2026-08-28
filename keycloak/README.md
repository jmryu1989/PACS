# Keycloak 렐름 (개발용)

`kin-realm.json`은 컨테이너가 뜰 때 자동으로 들어간다(`start-dev --import-realm`).

> ⚠️ **이 파일의 JSON에는 주석을 넣을 수 없다.** Keycloak은 모르는 필드를 만나면
> import 자체를 거부하고 서버가 뜨지 않는다 (`Unrecognized field ... not marked as ignorable`).
> 설명은 전부 이 README에 쓴다.

## 들어 있는 것

| 항목 | 값 |
|---|---|
| 렐름 | `kin` |
| 클라이언트 | `kin-web` (public, Authorization Code + PKCE S256) |
| 롤 | `radiologist`, `technician`, `admin` |
| 토큰 수명 | access 30분 / 세션 유휴 4시간 / 최대 12시간 |
| 보호 | 로그인 5회 실패 시 잠금(brute force) |

세션 유휴 4시간과 5회 실패 잠금은 HPACS가 2025년 6월에야 넣은 정책이다
(→ `HPACS-릴리즈노트-교훈.md` §9). 뒤늦게 붙이면 전 구간을 건드리게 되므로 처음부터 켠다.

## 개발용 계정

| 아이디 | 비밀번호 | 롤 |
|---|---|---|
| `jmryu` | `kin1234` | radiologist, technician, admin |
| `doctor` | `kin1234` | radiologist |
| `tech` | `kin1234` | technician |

Keycloak 관리 콘솔: http://localhost:8080 (`admin` / `admin`)

> **이 비밀번호는 저장소에 공개돼 있다.** 개발 편의용이며, 이 렐름 파일로 운영 사용자를
> 만들지 않는다. 운영에서는 관리 콘솔이나 Admin REST로 계정을 만들고 이 파일은 쓰지 않는다.

## 왜 audience 매퍼가 있나

`kin-api-audience` 프로토콜 매퍼가 access token의 `aud`에 `kin-api`를 넣는다.
API는 서명·발급자뿐 아니라 **이 토큰이 우리 API를 위해 발급된 것인지**(audience)까지 확인한다.
이게 없으면 같은 Keycloak의 다른 클라이언트용 토큰으로도 우리 API를 부를 수 있다.

## issuer 주소가 두 개인 이유

- 브라우저는 `http://localhost:8080`으로 Keycloak에 간다 → 토큰의 `iss`가 그 주소로 박힌다
- API 컨테이너는 같은 Keycloak을 `http://keycloak:8080`(도커 네트워크 이름)으로 본다

그래서 API는 **JWKS는 내부 주소로 가져오고, `iss` 검증은 외부 주소로** 한다.
compose의 `KC_ISSUER`(외부)와 `KC_JWKS_URL`(내부)이 그 둘이다.
Keycloak에 `KC_HOSTNAME=http://localhost:8080`을 고정해 두었기 때문에 `iss`가 흔들리지 않는다.

## 설정을 바꾼 뒤

Keycloak의 H2 데이터베이스는 컨테이너 안에만 있다(볼륨을 붙이지 않았다). 따라서
**컨테이너를 새로 만들면 이 파일이 다시 들어온다.**

```bash
docker compose up -d --force-recreate keycloak
```

`stop`/`start`나 `restart`로는 유지되고, `up --force-recreate`나 `down` 후 재기동에서 초기화된다.

### 왜 볼륨을 안 붙였나

`kc-db:/opt/keycloak/data/h2` 처럼 이름있는 볼륨을 붙이면 root 소유로 생성되는데
Keycloak은 UID 1000으로 돌기 때문에 H2 파일을 못 만들고 죽는다:

```
Caused by: java.nio.file.AccessDeniedException: /opt/keycloak/data/h2/keycloakdb.mv.db
ERROR: Failed to start server in (development) mode
```

(이미지에 그 디렉터리가 없어서 도커가 소유권을 복사해 줄 대상이 없다.)

**결과**: 관리 콘솔에서 만든 계정은 컨테이너를 다시 만들면 사라진다. 개발 중에는 오히려
편하다 — 이 파일이 늘 진실이 된다. 운영에서는 Keycloak도 PostgreSQL을 쓰게 하고
그 DB를 영속화한다(6단계).
