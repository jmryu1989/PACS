"""살아 있는 PACS 스택에 대고 돌리는 불변조건 테스트.

커버리지가 목적이 아니다. 컨트롤러에 진입점이 하나 늘어날 때마다 아래 ROUTES 표에
REPORT/TENANT/USER/NEITHER 중 하나로 선언하게 만드는 것이 이 파일의 첫 번째 역할이다.
REPORT라고 선언하는 순간 실제 Keycloak 토큰·Orthanc 검사·PostgreSQL 역사를 쓰는
배터리를 피할 수 없다. Prisma나 Orthanc를 대신하는 가짜 객체는 두지 않는다.
"""

from __future__ import annotations

import base64
import html
import http.cookiejar
import json
import os
import re
import ssl
import subprocess
import sys
import threading
import time
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Iterator
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import (
    HTTPCookieProcessor, HTTPRedirectHandler, HTTPSHandler, Request, build_opener, urlopen,
)


# 실패 메시지가 핵심 증거인데 Windows CP949가 한글을 깨뜨리면 어떤 불변조건이 무너졌는지
# 로그만 보고 알 수 없다. 테스트 결과 자체도 자동화가 읽을 수 있는 UTF-8로 고정한다.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


ROOT = Path(__file__).resolve().parents[1]
CONTROLLER_GLOB = "*.controller.ts"


def load_local_env() -> None:
    """Git에서 제외된 로컬 시험 비밀을 출력하지 않고 환경에만 채운다."""
    path = ROOT / ".env"
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if not key or key in os.environ:
            continue
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        os.environ[key] = value


load_local_env()


class Kind(str, Enum):
    REPORT = "REPORT"
    TENANT = "TENANT"
    USER = "USER"
    NEITHER = "NEITHER"


@dataclass(frozen=True)
class Route:
    kind: Kind
    operation: str | None = None
    scope: str = "study"


# 이 표가 진입점의 단일 진실원천이다. 컨트롤러에 라우트를 추가하고 여기에 선언하지
# 않으면 test_every_controller_route_is_declared가 살아 있는 스택을 건드리기도 전에 실패한다.
ROUTES: dict[tuple[str, str], Route] = {
    ("GET", "health"): Route(Kind.NEITHER),
    ("GET", "auth/login"): Route(Kind.NEITHER),
    ("GET", "auth/register"): Route(Kind.NEITHER),
    ("GET", "auth/callback"): Route(Kind.NEITHER),
    ("POST", "auth/logout"): Route(Kind.NEITHER),
    ("GET", "me"): Route(Kind.NEITHER),
    ("GET", "authz/dicom"): Route(Kind.TENANT),
    ("POST", "gateway/announce"): Route(Kind.TENANT),
    ("POST", "dicom/lookup"): Route(Kind.TENANT),
    ("GET", "colleagues"): Route(Kind.TENANT),
    ("GET", "prefs"): Route(Kind.USER),
    ("POST", "filters"): Route(Kind.USER),
    ("PATCH", "filters/:id/default"): Route(Kind.USER),
    ("DELETE", "filters/:id"): Route(Kind.USER),
    ("POST", "templates"): Route(Kind.USER),
    ("DELETE", "templates/:id"): Route(Kind.USER),
    ("GET", "bootstrap"): Route(Kind.REPORT, "bootstrap", "collection"),
    ("GET", "studies"): Route(Kind.REPORT, "studies", "collection"),
    ("GET", "unassigned"): Route(Kind.TENANT),
    ("POST", "studies/:uid/assign"): Route(Kind.TENANT),
    ("PATCH", "studies/:uid"): Route(Kind.REPORT, "patch"),
    ("PUT", "studies/:uid/report"): Route(Kind.REPORT, "draft-put"),
    ("DELETE", "studies/:uid/draft"): Route(Kind.REPORT, "draft-delete"),
    ("DELETE", "studies/:uid/draft/force"): Route(Kind.REPORT, "draft-force"),
    ("POST", "studies/:uid/report/commit"): Route(Kind.REPORT, "commit"),
    ("GET", "studies/:uid/report/versions"): Route(Kind.REPORT, "versions"),
    ("POST", "studies/:uid/hold"): Route(Kind.REPORT, "hold"),
    ("POST", "studies/:uid/release"): Route(Kind.REPORT, "release"),
    ("DELETE", "studies/:uid"): Route(Kind.REPORT, "study-delete"),
    ("POST", "match"): Route(Kind.TENANT),
    ("POST", "unmatch"): Route(Kind.TENANT),
    ("GET", "audit"): Route(Kind.TENANT),
    ("GET", "admin/users"): Route(Kind.NEITHER),
    ("POST", "admin/users"): Route(Kind.NEITHER),
    ("PATCH", "admin/users/:id"): Route(Kind.NEITHER),
    ("POST", "admin/users/:id/reset-password"): Route(Kind.NEITHER),
}


REPORT_ROUTES = [(key, route) for key, route in ROUTES.items() if route.kind is Kind.REPORT]


def controller_routes() -> set[tuple[str, str]]:
    """Nest 데코레이터를 열거한다. 런타임 메타데이터가 외부에 없어서 소스를 읽는다."""
    found: set[tuple[str, str]] = set()
    controller_dir = ROOT / "api" / "src"
    # 지금 쓰는 다섯 종류만 보면 @All 같은 새 진입점이 선언표 밖으로 조용히 빠진다.
    # Nest의 경로형 HTTP 데코레이터를 실제 메서드로 정규화한다.
    http_decorators = {
        "All": "ALL",
        "Get": "GET",
        "Post": "POST",
        "Put": "PUT",
        "Delete": "DELETE",
        "Patch": "PATCH",
        "Options": "OPTIONS",
        "Head": "HEAD",
        "Search": "SEARCH",
        "Sse": "GET",
    }
    names = "|".join(map(re.escape, http_decorators))
    decorator = re.compile(rf"@({names})\(\s*(?:(['\"])(.*?)\2)?\s*\)")
    route_call = re.compile(rf"@({names}|RequestMapping)\s*\(")
    prefix_re = re.compile(r"@Controller\(\s*(?:(['\"])(.*?)\1)?\s*\)")
    # 하위 폴더를 빼면 새 모듈 전체가 호구조사에서 빠지므로 컨트롤러를 재귀 탐색한다.
    for path in sorted(controller_dir.rglob(CONTROLLER_GLOB)):
        source = path.read_text(encoding="utf-8")
        prefix_match = prefix_re.search(source)
        prefix = (prefix_match.group(2) if prefix_match else "") or ""
        prefix = prefix.strip("/")
        matches = list(decorator.finditer(source))
        parsed_offsets = {match.start() for match in matches}
        unparsed = [
            match.group(1)
            for match in route_call.finditer(source)
            if match.start() not in parsed_offsets
        ]
        if unparsed:
            raise AssertionError(
                f"{path.relative_to(ROOT)}의 HTTP 데코레이터를 해석하지 못했습니다: {unparsed}. "
                "문자열 리터럴 경로로 바꾸거나 호구조사 파서를 확장하세요."
            )
        for match in matches:
            child = (match.group(3) or "").strip("/")
            route_path = "/".join(part for part in (prefix, child) if part)
            found.add((http_decorators[match.group(1)], route_path))
    return found


@dataclass
class HttpResult:
    status: int
    body: Any
    text: str

    def contains(self, value: str) -> bool:
        return value in self.text


@dataclass
class Fixture:
    uid: str
    patient_id: str
    institution: str
    owner_user: str
    secret: str


def _json_or_text(raw: bytes) -> tuple[Any, str]:
    text = raw.decode("utf-8", errors="replace")
    try:
        return json.loads(text), text
    except json.JSONDecodeError:
        return text, text


class LiveStack:
    def __init__(self) -> None:
        self.proxy = os.environ.get("KIN_TEST_PROXY", "https://localhost:9443").rstrip("/")
        self.api = os.environ.get("KIN_TEST_API", self.proxy + "/api").rstrip("/")
        self.keycloak = os.environ.get(
            "KIN_TEST_TOKEN_URL",
            "http://127.0.0.1:8080/auth/realms/kin/protocol/openid-connect/token",
        )
        self.orthanc = os.environ.get("KIN_TEST_ORTHANC", "http://127.0.0.1:8042").rstrip("/")
        self.context = ssl._create_unverified_context()
        self.tokens: dict[str, str] = {}
        self.actors: dict[str, str] = {}
        self.active: dict[str, Fixture] = {}
        self.passwords: dict[str, str] = {}
        self.usernames: dict[str, str] = {}
        self.user_ids: dict[str, str] = {}
        self.test_client_id = "kin-invariants-" + uuid.uuid4().hex[:12]
        self.test_client_uuid: str | None = None
        self.service_clients: dict[str, dict[str, str]] = {}
        self.service_tokens: dict[str, str] = {}
        self.created_gateway_role = False
        self.admin_token: str | None = None
        self._load_local_configuration()

    def _load_local_configuration(self) -> None:
        self.orthanc_user = os.environ.get("KIN_TEST_ORTHANC_USER", "admin")
        self.orthanc_password = os.environ.get(
            "KIN_TEST_ORTHANC_PASSWORD", os.environ.get("ORTHANC_PASS", ""),
        )
        if not self.orthanc_password:
            raise RuntimeError("KIN_TEST_ORTHANC_PASSWORD 또는 ORTHANC_PASS가 필요합니다")

    def _open(self, request: Request):
        if request.full_url.startswith("https://"):
            return urlopen(request, timeout=30, context=self.context)
        return urlopen(request, timeout=30)

    def _admin_login(self) -> None:
        password = os.environ.get("KC_ADMIN_PASSWORD", "")
        if not password:
            raise RuntimeError("KC_ADMIN_PASSWORD가 필요합니다")
        data = urlencode({
            "client_id": "admin-cli", "grant_type": "password",
            "username": "admin", "password": password,
        }).encode("ascii")
        request = Request(
            "http://127.0.0.1:8080/auth/realms/master/protocol/openid-connect/token",
            data=data, headers={"Content-Type": "application/x-www-form-urlencoded"}, method="POST",
        )
        with self._open(request) as response:
            self.admin_token = json.loads(response.read().decode("utf-8"))["access_token"]

    def kc_admin(self, method: str, path: str, body: Any = None) -> HttpResult:
        if not self.admin_token:
            self._admin_login()
        data = None if body is None else json.dumps(body).encode("utf-8")
        headers = {"Authorization": "Bearer " + str(self.admin_token)}
        if data is not None:
            headers["Content-Type"] = "application/json"
        request = Request(
            "http://127.0.0.1:8080/auth/admin/realms/kin" + path,
            data=data, headers=headers, method=method,
        )
        try:
            with self._open(request) as response:
                payload, text = _json_or_text(response.read())
                if method == "POST" and path == "/clients":
                    payload = response.headers.get("Location", "").rstrip("/").split("/")[-1]
                if method == "POST" and path == "/users":
                    payload = response.headers.get("Location", "").rstrip("/").split("/")[-1]
                return HttpResult(response.status, payload, text)
        except HTTPError as error:
            payload, text = _json_or_text(error.read())
            return HttpResult(error.code, payload, text)

    def _create_test_client(self) -> None:
        created = self.kc_admin("POST", "/clients", {
            "clientId": self.test_client_id,
            "name": "KIN local invariant runner",
            "enabled": True,
            "publicClient": True,
            "standardFlowEnabled": False,
            "directAccessGrantsEnabled": True,
            "serviceAccountsEnabled": False,
            "protocol": "openid-connect",
        })
        if created.status != 201 or not created.body:
            raise RuntimeError(f"로컬 시험 클라이언트 생성 실패: {created.status} {created.text}")
        self.test_client_uuid = str(created.body)
        mappers = (
            {
                "name": "kin-api-audience", "protocol": "openid-connect",
                "protocolMapper": "oidc-audience-mapper", "consentRequired": False,
                "config": {
                    "included.custom.audience": "kin-api", "id.token.claim": "false",
                    "access.token.claim": "true",
                },
            },
            {
                "name": "kin-institution-groups", "protocol": "openid-connect",
                "protocolMapper": "oidc-group-membership-mapper", "consentRequired": False,
                "config": {
                    "full.path": "false", "id.token.claim": "false",
                    "access.token.claim": "true", "userinfo.token.claim": "false",
                    "claim.name": "groups",
                },
            },
        )
        for mapper in mappers:
            added = self.kc_admin(
                "POST", f"/clients/{quote(self.test_client_uuid)}/protocol-mappers/models", mapper,
            )
            if added.status != 201:
                raise RuntimeError(f"로컬 시험 클라이언트 매퍼 생성 실패: {added.status} {added.text}")

    def service_identity(self, logical: str) -> dict[str, str]:
        if logical in self.service_clients:
            return self.service_clients[logical]
        definitions = {
            "gateway": ("gw-kin-center", ["gateway"], ["kin-center"]),
            "gateway-no-role": ("gw-kin-center-norole", [], ["kin-center"]),
            "gateway-mixed": ("gw-kin-center-mixed", ["gateway", "radiologist"], ["kin-center"]),
            "gateway-wrong-azp": ("service-kin-center", ["gateway"], ["kin-center"]),
        }
        if logical not in definitions:
            raise RuntimeError(f"정의되지 않은 시험 서비스 신원: {logical}")

        role = self.kc_admin("GET", "/roles/gateway")
        if role.status == 404:
            created_role = self.kc_admin("POST", "/roles", {
                "name": "gateway", "description": "temporary invariant gateway role",
            })
            if created_role.status != 201:
                raise RuntimeError(f"시험 gateway 역할 생성 실패: {created_role.status}")
            self.created_gateway_role = True
        elif role.status != 200:
            raise RuntimeError(f"시험 gateway 역할 조회 실패: {role.status}")

        prefix, roles, groups = definitions[logical]
        client_id = f"{prefix}-invariant-{uuid.uuid4().hex[:10]}"
        secret = uuid.uuid4().hex + uuid.uuid4().hex
        created = self.kc_admin("POST", "/clients", {
            "clientId": client_id,
            "name": f"KIN invariant {logical}",
            "enabled": True,
            "publicClient": False,
            "secret": secret,
            "standardFlowEnabled": False,
            "directAccessGrantsEnabled": False,
            "serviceAccountsEnabled": True,
            "protocol": "openid-connect",
        })
        if created.status != 201 or not created.body:
            raise RuntimeError(f"시험 서비스 클라이언트 생성 실패: {created.status}")
        client_uuid = str(created.body)
        identity = {"id": client_uuid, "client_id": client_id, "secret": secret}
        self.service_clients[logical] = identity

        mappers = (
            {
                "name": "kin-api-audience", "protocol": "openid-connect",
                "protocolMapper": "oidc-audience-mapper", "consentRequired": False,
                "config": {
                    "included.custom.audience": "kin-api", "id.token.claim": "false",
                    "access.token.claim": "true",
                },
            },
            {
                "name": "kin-institution-groups", "protocol": "openid-connect",
                "protocolMapper": "oidc-group-membership-mapper", "consentRequired": False,
                "config": {
                    "full.path": "false", "id.token.claim": "false",
                    "access.token.claim": "true", "userinfo.token.claim": "false",
                    "claim.name": "groups",
                },
            },
        )
        for mapper in mappers:
            added = self.kc_admin(
                "POST", f"/clients/{quote(client_uuid)}/protocol-mappers/models", mapper,
            )
            if added.status != 201:
                raise RuntimeError(f"시험 서비스 매퍼 생성 실패: {added.status}")

        service = self.kc_admin("GET", f"/clients/{quote(client_uuid)}/service-account-user")
        if service.status != 200 or not service.body.get("id"):
            raise RuntimeError(f"시험 서비스 계정 조회 실패: {service.status}")
        service_id = quote(str(service.body["id"]))
        for group_name in groups:
            found = self.kc_admin("GET", "/groups?search=" + quote(group_name))
            if found.status != 200 or not isinstance(found.body, list):
                raise RuntimeError(f"시험 서비스 그룹 조회 실패: {group_name}/{found.status}")
            exact = [item for item in found.body if item.get("name") == group_name]
            if len(exact) != 1:
                raise RuntimeError(f"시험 서비스 그룹 조회 실패: {group_name}")
            joined = self.kc_admin(
                "PUT", f"/users/{service_id}/groups/{quote(str(exact[0]['id']))}",
            )
            if joined.status != 204:
                raise RuntimeError(f"시험 서비스 그룹 설정 실패: {joined.status}")
        for role_name in roles:
            found = self.kc_admin("GET", "/roles/" + quote(role_name))
            if found.status != 200:
                raise RuntimeError(f"시험 서비스 역할 조회 실패: {role_name}/{found.status}")
            assigned = self.kc_admin(
                "POST", f"/users/{service_id}/role-mappings/realm", [found.body],
            )
            if assigned.status != 204:
                raise RuntimeError(f"시험 서비스 역할 설정 실패: {assigned.status}")
        return identity

    def service_token(self, logical: str) -> str:
        if logical in self.service_tokens:
            return self.service_tokens[logical]
        identity = self.service_identity(logical)
        data = urlencode({
            "client_id": identity["client_id"], "client_secret": identity["secret"],
            "grant_type": "client_credentials",
        }).encode("ascii")
        request = Request(
            self.keycloak, data=data,
            headers={"Content-Type": "application/x-www-form-urlencoded"}, method="POST",
        )
        with self._open(request) as response:
            token = str(json.loads(response.read().decode("utf-8"))["access_token"])
        self.service_tokens[logical] = token
        return token

    def create_test_identity(self, logical: str, roles: list[str], group: str) -> str:
        if logical in self.user_ids:
            return self.user_ids[logical]
        username = f"kin-test-{uuid.uuid4().hex[:12]}-{logical}"
        password = uuid.uuid4().hex + "Aa1!"
        created = self.kc_admin("POST", "/users", {
            "username": username, "enabled": True, "emailVerified": True,
            "email": username + "@local.test", "firstName": "KIN", "lastName": logical,
        })
        if created.status != 201 or not created.body:
            raise RuntimeError(f"로컬 시험 사용자 생성 실패({logical}): {created.status} {created.text}")
        user_id = str(created.body)
        self.user_ids[logical] = user_id
        self.usernames[logical] = username
        self.passwords[logical] = password

        reset = self.kc_admin("PUT", f"/users/{quote(user_id)}/reset-password", {
            "type": "password", "value": password, "temporary": False,
        })
        if reset.status != 204:
            raise RuntimeError(f"로컬 시험 사용자 비밀번호 설정 실패({logical}): {reset.status}")
        for role_name in roles:
            role = self.kc_admin("GET", "/roles/" + quote(role_name))
            if role.status != 200:
                raise RuntimeError(f"로컬 시험 역할 조회 실패({role_name}): {role.status}")
            assigned = self.kc_admin(
                "POST", f"/users/{quote(user_id)}/role-mappings/realm", [role.body],
            )
            if assigned.status != 204:
                raise RuntimeError(f"로컬 시험 역할 설정 실패({logical}/{role_name}): {assigned.status}")
        groups = self.kc_admin("GET", "/groups?search=" + quote(group))
        if groups.status != 200 or not isinstance(groups.body, list):
            raise RuntimeError(f"로컬 시험 그룹 조회 실패({group}): {groups.status}")
        exact = [row for row in groups.body if row.get("name") == group]
        if len(exact) != 1:
            raise RuntimeError(f"로컬 시험 그룹 조회 실패({group})")
        joined = self.kc_admin("PUT", f"/users/{quote(user_id)}/groups/{quote(exact[0]['id'])}")
        if joined.status != 204:
            raise RuntimeError(f"로컬 시험 그룹 설정 실패({logical}/{group}): {joined.status}")
        return user_id

    def provision_test_identities(self) -> None:
        if self.test_client_uuid:
            return
        try:
            self._admin_login()
            self._create_test_client()
            definitions = {
                "jmryu": (["radiologist", "technician", "admin"], "hallym"),
                "doctor": (["radiologist"], "hallym"),
                "doctor2": (["radiologist"], "hallym"),
                "tech": (["technician"], "hallym"),
                "kdoctor": (["radiologist"], "kin-center"),
                "ktech": (["technician"], "kin-center"),
            }
            for logical, (roles, group) in definitions.items():
                self.create_test_identity(logical, roles, group)
        except Exception:
            self.cleanup_test_identities()
            raise

    def username(self, logical: str) -> str:
        return self.usernames.get(logical, logical)

    def cleanup_test_identities(self) -> None:
        if self.user_ids or self.test_client_uuid or self.service_clients or self.created_gateway_role:
            self._admin_login()
        failures = []
        for logical, user_id in list(self.user_ids.items())[::-1]:
            deleted = self.kc_admin("DELETE", f"/users/{quote(user_id)}")
            if deleted.status not in (204, 404):
                failures.append(f"사용자 {logical}: {deleted.status}")
        self.user_ids.clear()
        self.usernames.clear()
        self.passwords.clear()
        if self.test_client_uuid:
            deleted = self.kc_admin("DELETE", f"/clients/{quote(self.test_client_uuid)}")
            if deleted.status not in (204, 404):
                failures.append(f"클라이언트: {deleted.status}")
        self.test_client_uuid = None
        for logical, identity in list(self.service_clients.items())[::-1]:
            deleted = self.kc_admin("DELETE", f"/clients/{quote(identity['id'])}")
            if deleted.status not in (204, 404):
                failures.append(f"서비스 클라이언트 {logical}: {deleted.status}")
        self.service_clients.clear()
        self.service_tokens.clear()
        if self.created_gateway_role:
            deleted = self.kc_admin("DELETE", "/roles/gateway")
            if deleted.status not in (204, 404):
                failures.append(f"gateway 역할: {deleted.status}")
        self.created_gateway_role = False
        self.tokens.clear()
        if failures:
            raise RuntimeError("로컬 시험 계정 정리 실패: " + "; ".join(failures))

    def request(self, method: str, path: str, user: str | None = None, body: Any = None) -> HttpResult:
        data = None if body is None else json.dumps(body).encode("utf-8")
        headers = {"Accept": "application/json"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        if user:
            headers["Authorization"] = "Bearer " + self.token(user)
        request = Request(self.api + path, data=data, headers=headers, method=method)
        try:
            with self._open(request) as response:
                payload, text = _json_or_text(response.read())
                return HttpResult(response.status, payload, text)
        except HTTPError as error:
            payload, text = _json_or_text(error.read())
            return HttpResult(error.code, payload, text)

    def bearer_request(
        self, method: str, path: str, token: str, body: Any = None,
        *, base: str | None = None, headers: dict[str, str] | None = None,
    ) -> HttpResult:
        request_headers = {"Accept": "application/json", "Authorization": "Bearer " + token}
        request_headers.update(headers or {})
        if isinstance(body, bytes):
            data = body
        elif body is None:
            data = None
        else:
            data = json.dumps(body).encode("utf-8")
            request_headers["Content-Type"] = "application/json"
        request = Request((base or self.api) + path, data=data, headers=request_headers, method=method)
        try:
            with self._open(request) as response:
                payload, text = _json_or_text(response.read())
                return HttpResult(response.status, payload, text)
        except HTTPError as error:
            payload, text = _json_or_text(error.read())
            return HttpResult(error.code, payload, text)

    def token(self, user: str) -> str:
        if user in self.tokens:
            return self.tokens[user]
        password = self.passwords.get(user)
        if not password:
            raise RuntimeError(f"Keycloak 개발 계정 비밀번호를 찾을 수 없습니다: {user}")
        data = urlencode({
            "client_id": self.test_client_id, "grant_type": "password",
            "username": self.username(user), "password": password,
        }).encode("ascii")
        request = Request(
            self.keycloak, data=data,
            headers={"Content-Type": "application/x-www-form-urlencoded"}, method="POST",
        )
        with self._open(request) as response:
            token = json.loads(response.read().decode("utf-8"))["access_token"]
        self.tokens[user] = token
        me = self.request("GET", "/me", user)
        if me.status != 200:
            raise RuntimeError(f"실제 토큰으로 /me 호출 실패: {user} -> {me.status} {me.text}")
        self.actors[user] = me.body["actor"]
        return token

    def actor(self, user: str) -> str:
        self.token(user)
        return self.actors[user]

    def require_stack(self) -> None:
        health = self.request("GET", "/health")
        if health.status != 200 or not health.body.get("ok"):
            raise RuntimeError(f"살아 있는 API가 필요합니다: {health.status} {health.text}")
        self.provision_test_identities()
        for user in ("jmryu", "doctor", "doctor2", "tech", "kdoctor", "ktech"):
            self.token(user)

    def _orthanc_request(self, method: str, path: str, body: bytes | None = None) -> HttpResult:
        auth = base64.b64encode(f"{self.orthanc_user}:{self.orthanc_password}".encode()).decode()
        headers = {"Authorization": "Basic " + auth}
        if body is not None:
            headers["Content-Type"] = "text/plain"
        request = Request(self.orthanc + path, data=body, headers=headers, method=method)
        try:
            with urlopen(request, timeout=30) as response:
                payload, text = _json_or_text(response.read())
                return HttpResult(response.status, payload, text)
        except HTTPError as error:
            payload, text = _json_or_text(error.read())
            return HttpResult(error.code, payload, text)

    def orthanc_bytes(self, path: str) -> bytes:
        auth = base64.b64encode(f"{self.orthanc_user}:{self.orthanc_password}".encode()).decode()
        request = Request(self.orthanc + path, headers={"Authorization": "Basic " + auth})
        with urlopen(request, timeout=30) as response:
            return response.read()

    def dicom_request(self, path: str, user: str | None = None) -> HttpResult:
        """정식 프록시의 DICOM 경로. 사용자 지정 시 쿠키가 아닌 Bearer로 검증한다."""
        headers = {"Accept": "*/*"}
        if user:
            headers["Authorization"] = "Bearer " + self.token(user)
        request = Request(self.proxy + path, headers=headers, method="GET")
        # 로컬 정식 입구는 자체 서명 인증서다. 토큰 검증과 기관 관문은 서버에서 그대로 돈다.
        context = ssl._create_unverified_context()
        try:
            with urlopen(request, timeout=30, context=context) as response:
                payload, text = _json_or_text(response.read())
                return HttpResult(response.status, payload, text)
        except HTTPError as error:
            payload, text = _json_or_text(error.read())
            return HttpResult(error.code, payload, text)

    def first_instance_id(self, uid: str) -> str:
        """테스트 픽스처의 첫 Orthanc 인스턴스 ID를 안전하게 찾는다."""
        lookup = self._orthanc_request("POST", "/tools/lookup", uid.encode("ascii"))
        if lookup.status != 200:
            raise RuntimeError(f"Orthanc study lookup 실패: {lookup.status} {lookup.text}")
        studies = [item.get("ID") for item in lookup.body if item.get("Type") == "Study"]
        if len(studies) != 1:
            raise RuntimeError(f"Study UID에 대응하는 Orthanc study가 1개가 아닙니다: {len(studies)}")
        study = self._orthanc_request("GET", f"/studies/{quote(studies[0])}")
        if study.status != 200 or not study.body.get("Series"):
            raise RuntimeError(f"Orthanc study에 series가 없습니다: {study.status} {study.text}")
        series = self._orthanc_request("GET", f"/series/{quote(study.body['Series'][0])}")
        if series.status != 200 or not series.body.get("Instances"):
            raise RuntimeError(f"Orthanc series에 instance가 없습니다: {series.status} {series.text}")
        return series.body["Instances"][0]

    def fixture_command(self, institution: str, name: str, patient_id: str) -> list[str]:
        command = [
            sys.executable, str(ROOT / "scripts" / "send_cstore.py"),
            "--institution", institution, "--name", name,
            "--id", patient_id, "--desc", "Invariant route fixture", "--slices", "1",
        ]
        mode = os.environ.get("KIN_TEST_INGEST", "cstore").strip().lower()
        if mode not in {"cstore", "gateway"}:
            raise RuntimeError("KIN_TEST_INGEST는 cstore 또는 gateway여야 합니다")
        if mode == "gateway":
            host = os.environ.get("KIN_TEST_GATEWAY_HOST", "").strip()
            if not host:
                raise RuntimeError("gateway fixture에는 KIN_TEST_GATEWAY_HOST가 필요합니다")
            try:
                port = int(os.environ.get("KIN_TEST_GATEWAY_PORT", "4243"))
            except ValueError:
                raise RuntimeError("KIN_TEST_GATEWAY_PORT는 정수여야 합니다") from None
            called_aet = os.environ.get("KIN_TEST_GATEWAY_AET", "KINGW").strip() or "KINGW"
            command += ["--host", host, "--port", str(port), "--called-aet", called_aet]
        return command

    def create_fixture(
        self, institution: str = "한림병원", *, patient_id: str | None = None,
    ) -> Fixture:
        run = uuid.uuid4().hex
        owner = "jmryu" if institution == "한림병원" else "kdoctor"
        patient_id = "INV-" + run[:16] if patient_id is None else patient_id
        command = self.fixture_command(institution, f"INVARIANT^{run[:10]}", patient_id)
        completed = subprocess.run(
            command, cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
            errors="replace", timeout=120,
        )
        if completed.returncode:
            raise RuntimeError("C-STORE 픽스처 생성 실패\n" + completed.stdout + completed.stderr)
        match = re.search(r"StudyUID\s+([0-9.]+)", completed.stdout)
        if not match:
            raise RuntimeError("C-STORE 출력에서 StudyUID를 찾지 못했습니다\n" + completed.stdout)
        uid = match.group(1)
        fixture = Fixture(uid, patient_id, institution, owner, "REPORT-" + run)
        self.active[uid] = fixture
        try:
            mode = os.environ.get("KIN_TEST_INGEST", "cstore").strip().lower()
            wait_seconds = 90 if mode == "gateway" else 20
            deadline = time.monotonic() + wait_seconds
            while time.monotonic() < deadline:
                listed = self.request("GET", "/studies", owner)
                if listed.status == 200 and any(s.get("uid") == uid for s in listed.body.get("studies", [])):
                    break
                time.sleep(0.25)
            else:
                raise RuntimeError(f"C-STORE한 검사가 API 목록에 나타나지 않았습니다: {uid}")

            verifier = "jmryu" if institution == "한림병원" else "ktech"
            verified = self.request("PATCH", f"/studies/{quote(uid)}", verifier, {"ss": "Verified"})
            if verified.status != 200:
                raise RuntimeError(f"픽스처 Verify 실패: {verified.status} {verified.text}")
            return fixture
        except Exception:
            self.cleanup_fixture(uid)
            raise

    def cleanup_fixture(self, uid: str) -> None:
        fixture = self.active.get(uid)
        failures: list[str] = []
        try:
            lookup = self._orthanc_request("POST", "/tools/lookup", uid.encode("ascii"))
            if lookup.status == 200:
                for item in lookup.body:
                    if item.get("Type") != "Study":
                        continue
                    orthanc_id = item.get("ID", "")
                    detail = self._orthanc_request("GET", f"/studies/{quote(orthanc_id)}")
                    actual_uid = (detail.body.get("MainDicomTags") or {}).get("StudyInstanceUID")
                    if actual_uid != uid:
                        failures.append(f"Orthanc ID 검증 불일치: {orthanc_id} -> {actual_uid}")
                        continue
                    deleted = self._orthanc_request("DELETE", f"/studies/{quote(orthanc_id)}")
                    if deleted.status not in (200, 204):
                        failures.append(f"Orthanc 삭제 실패: {deleted.status} {deleted.text}")
            elif lookup.status != 404:
                failures.append(f"Orthanc lookup 실패: {lookup.status} {lookup.text}")
        except Exception as error:  # DB 정리는 Orthanc 실패와 무관하게 반드시 시도한다.
            failures.append(f"Orthanc 정리 예외: {error}")

        if not re.fullmatch(r"[0-9.]+", uid):
            failures.append(f"DB 정리를 거부한 비정상 UID: {uid}")
        else:
            sql = (
                "BEGIN; "
                f"UPDATE \"Order\" SET matched='U', \"studyUid\"=NULL WHERE \"studyUid\"='{uid}'; "
                f"DELETE FROM \"ReportDraft\" WHERE uid='{uid}'; "
                f"DELETE FROM \"Report\" WHERE uid='{uid}'; "
                f"DELETE FROM \"StudyState\" WHERE uid='{uid}'; "
                f"DELETE FROM \"ReportVersion\" WHERE uid='{uid}'; "
                f"DELETE FROM \"AuditLog\" WHERE target='{uid}'; COMMIT;"
            )
            cleaned = subprocess.run(
                ["docker", "compose", "exec", "-T", "db", "psql", "-U", "kin", "-d", "kin",
                 "-v", "ON_ERROR_STOP=1", "-c", sql],
                cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30,
            )
            if cleaned.returncode:
                failures.append("DB 정리 실패: " + cleaned.stdout + cleaned.stderr)

        self.active.pop(uid, None)
        if failures and fixture is not None:
            raise RuntimeError("; ".join(failures))

    def cleanup_all(self) -> None:
        failures = []
        for uid in list(self.active):
            try:
                self.cleanup_fixture(uid)
            except Exception as error:
                failures.append(str(error))
        if failures:
            raise RuntimeError("픽스처 일괄 정리 실패: " + "; ".join(failures))

    @contextmanager
    def fixture(
        self, institution: str = "한림병원", *, patient_id: str | None = None,
    ) -> Iterator[Fixture]:
        fixture = self.create_fixture(institution, patient_id=patient_id)
        try:
            yield fixture
        finally:
            self.cleanup_fixture(fixture.uid)


class EntryPointManifestTests(unittest.TestCase):
    def test_every_controller_route_is_declared(self) -> None:
        actual = controller_routes()
        declared = set(ROUTES)
        missing = sorted(actual - declared)
        stale = sorted(declared - actual)
        self.assertFalse(
            missing or stale,
            "라우트 선언표가 컨트롤러와 다릅니다. "
            f"표에 없는 라우트={missing}, 컨트롤러에 없는 선언={stale}",
        )


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class BffInvariantTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.stack = LiveStack()
        cls.addClassCleanup(cls.stack.cleanup_test_identities)
        cls.stack.require_stack()
        cls.context = cls.stack.context
        cls.admin_token = str(cls.stack.admin_token)
        groups = cls.admin("GET", "/groups?search=hallym")
        exact = [group for group in groups.body if group.get("name") == "hallym"]
        if len(exact) != 1:
            raise RuntimeError(f"hallym 그룹을 하나로 확정할 수 없습니다: {len(exact)}")
        cls.hallym_group_id = exact[0]["id"]

    @classmethod
    def admin(cls, method: str, path: str, body: Any = None) -> HttpResult:
        data = None if body is None else json.dumps(body).encode("utf-8")
        headers = {"Authorization": "Bearer " + cls.admin_token}
        if data is not None:
            headers["Content-Type"] = "application/json"
        request = Request(
            "http://127.0.0.1:8080/auth/admin/realms/kin" + path,
            data=data, headers=headers, method=method,
        )
        try:
            with urlopen(request, timeout=30) as response:
                raw = response.read()
                payload, text = _json_or_text(raw)
                if method == "POST" and path == "/users":
                    payload = response.headers.get("Location", "").rstrip("/").split("/")[-1]
                return HttpResult(response.status, payload, text)
        except HTTPError as error:
            payload, text = _json_or_text(error.read())
            return HttpResult(error.code, payload, text)

    def proxy(self, opener, method: str, path: str, body: Any = None,
              headers: dict[str, str] | None = None) -> HttpResult:
        data = None if body is None else json.dumps(body).encode("utf-8")
        sent = {"Accept": "application/json", **(headers or {})}
        if data is not None:
            sent["Content-Type"] = "application/json"
        request = Request(self.stack.proxy + path, data=data, headers=sent, method=method)
        try:
            with opener.open(request, timeout=30) as response:
                payload, text = _json_or_text(response.read())
                return HttpResult(response.status, payload, text)
        except HTTPError as error:
            payload, text = _json_or_text(error.read())
            return HttpResult(error.code, payload, text)

    def service_admin(self, method: str, path: str, body: Any = None) -> HttpResult:
        """kin-api 서비스 계정의 Keycloak Admin 권한 상한을 실제로 검사한다."""
        secret = os.environ.get("KC_CLIENT_SECRET", "")
        if not secret:
            raise RuntimeError("KC_CLIENT_SECRET이 필요합니다")
        token_request = Request(
            self.stack.keycloak,
            data=urlencode({
                "client_id": "kin-api", "client_secret": secret,
                "grant_type": "client_credentials",
            }).encode("ascii"),
            headers={"Content-Type": "application/x-www-form-urlencoded"}, method="POST",
        )
        with self.stack._open(token_request) as response:
            token = json.loads(response.read().decode("utf-8"))["access_token"]
        data = None if body is None else json.dumps(body).encode("utf-8")
        headers = {"Authorization": "Bearer " + token}
        if data is not None:
            headers["Content-Type"] = "application/json"
        request = Request(
            "http://127.0.0.1:8080/auth/admin/realms/kin" + path,
            data=data, headers=headers, method=method,
        )
        try:
            with self.stack._open(request) as response:
                payload, text = _json_or_text(response.read())
                return HttpResult(response.status, payload, text)
        except HTTPError as error:
            payload, text = _json_or_text(error.read())
            return HttpResult(error.code, payload, text)

    def kcadm(self, config: str, *arguments: str, login: bool = False) -> subprocess.CompletedProcess[str]:
        base = ["docker", "exec", "kin-keycloak"]
        if login:
            command = (
                "/opt/keycloak/bin/kcadm.sh config credentials "
                f"--config {config} --server http://localhost:8080/auth --realm master "
                '--user "$KC_BOOTSTRAP_ADMIN_USERNAME" --password "$KC_BOOTSTRAP_ADMIN_PASSWORD"'
            )
            return subprocess.run(
                base + ["sh", "-lc", command], capture_output=True, text=True,
                encoding="utf-8", errors="replace", timeout=30,
            )
        return subprocess.run(
            base + ["/opt/keycloak/bin/kcadm.sh", *arguments, "--config", config],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30,
        )

    def bff_login(self, username: str, password: str):
        jar = http.cookiejar.CookieJar()
        opener = build_opener(HTTPCookieProcessor(jar), HTTPSHandler(context=self.context))
        login = self.proxy(opener, "GET", "/api/auth/login")
        self.assertEqual(login.status, 200, login.text)
        match = re.search(r'<form[^>]+action="([^"]+)"', login.text, re.I)
        self.assertIsNotNone(match, "Keycloak 로그인 form이 없습니다")
        data = urlencode({
            "username": self.stack.username(username), "password": password, "credentialId": "",
        }).encode("utf-8")
        submitted = Request(
            html.unescape(match.group(1)), data=data,
            headers={"Content-Type": "application/x-www-form-urlencoded"}, method="POST",
        )
        with opener.open(submitted, timeout=30) as response:
            response.read()
        sid = next((cookie.value for cookie in jar if cookie.name == "kin_sid"), None)
        self.assertIsNotNone(sid, "BFF 로그인 뒤 kin_sid가 없습니다")
        return opener, sid

    def create_member(self, with_group: bool) -> tuple[str, str, str]:
        username = "bff-invariant-" + uuid.uuid4().hex
        password = uuid.uuid4().hex + "Aa1!"
        created = self.admin("POST", "/users", {
            "username": username, "enabled": True, "emailVerified": True,
            "email": username + "@local.test", "firstName": "BFF", "lastName": "Invariant",
        })
        self.assertEqual(created.status, 201, created.text)
        user_id = created.body
        reset = self.admin("PUT", f"/users/{user_id}/reset-password", {
            "type": "password", "value": password, "temporary": False,
        })
        self.assertEqual(reset.status, 204, reset.text)
        if with_group:
            joined = self.admin("PUT", f"/users/{user_id}/groups/{self.hallym_group_id}")
            self.assertEqual(joined.status, 204, joined.text)
        return user_id, username, password

    def test_cookie_session_security_and_legacy_cookie_rejection(self) -> None:
        raw = build_opener(HTTPSHandler(context=self.context))
        forged = self.proxy(raw, "GET", "/api/me", headers={"Cookie": "kin_sid=forged"})
        self.assertEqual(forged.status, 401, forged.text)

        legacy = self.proxy(raw, "GET", "/api/me", headers={
            "Cookie": "kin_at=" + self.stack.token("doctor"),
        })
        self.assertEqual(legacy.status, 401, legacy.text)

        opener, sid = self.bff_login("doctor", self.stack.passwords["doctor"])
        csrf = self.proxy(opener, "POST", "/api/studies/1.2.3/hold", {})
        self.assertEqual(csrf.status, 403, csrf.text)
        logged_out = self.proxy(
            opener, "POST", "/api/auth/logout", headers={"X-KIN-CSRF": "1"},
        )
        self.assertEqual(logged_out.status, 204, logged_out.text)
        reused = self.proxy(raw, "GET", "/api/me", headers={"Cookie": "kin_sid=" + sid})
        self.assertEqual(reused.status, 401, reused.text)

        realm = json.loads((ROOT / "keycloak" / "kin-realm.json").read_text(encoding="utf-8"))
        clients = {client["clientId"]: client for client in realm["clients"]}
        self.assertFalse(clients["kin-web"]["enabled"])
        self.assertEqual(
            clients["kin-bff"].get("attributes", {}).get("pkce.code.challenge.method"), "S256",
        )

        live_clients = {}
        for client_id in ("kin-web", "kin-bff"):
            found = self.admin("GET", "/clients?clientId=" + client_id)
            self.assertEqual(found.status, 200, found.text)
            exact = [client for client in found.body if client.get("clientId") == client_id]
            self.assertEqual(len(exact), 1, f"{client_id} 라이브 클라이언트 수")
            live_clients[client_id] = exact[0]
        self.assertFalse(live_clients["kin-web"]["enabled"])
        self.assertEqual(
            live_clients["kin-bff"].get("attributes", {}).get("pkce.code.challenge.method"),
            "S256",
        )

    def test_only_four_routes_are_public(self) -> None:
        opener = build_opener(HTTPSHandler(context=self.context), NoRedirect())
        public = {
            ("GET", "health"): 200,
            ("GET", "auth/login"): 302,
            ("GET", "auth/register"): 302,
            ("GET", "auth/callback"): 302,
        }
        for (method, route), _meta in ROUTES.items():
            path = route.replace(":uid", "1.2.3").replace(":id", "1")
            body = {} if method in {"POST", "PUT", "PATCH"} else None
            result = self.proxy(opener, method, "/api/" + path, body)
            with self.subTest(method=method, path=path):
                self.assertEqual(result.status, public.get((method, route), 401), result.text)

    def test_pending_and_invalid_have_codes_but_can_logout(self) -> None:
        for with_group, code in (
            (False, "INSTITUTION_PENDING"),
            (True, "INSTITUTION_INVALID"),
        ):
            user_id = username = password = None
            opener = None
            try:
                user_id, username, password = self.create_member(with_group)
                opener, _sid = self.bff_login(username, password)
                me = self.proxy(opener, "GET", "/api/me")
                self.assertEqual(me.status, 403, me.text)
                self.assertEqual(me.body.get("code"), code, me.text)
                logout = self.proxy(
                    opener, "POST", "/api/auth/logout", headers={"X-KIN-CSRF": "1"},
                )
                self.assertEqual(logout.status, 204, logout.text)
            finally:
                if opener is not None:
                    self.proxy(opener, "POST", "/api/auth/logout", headers={"X-KIN-CSRF": "1"})
                if user_id is not None:
                    deleted = self.admin("DELETE", f"/users/{user_id}")
                    self.assertIn(deleted.status, (204, 404), deleted.text)

    def test_member_service_account_is_hidden_and_unwritable(self) -> None:
        page = 1
        seen = []
        while True:
            listed = self.stack.request("GET", f"/admin/users?page={page}", "jmryu")
            self.assertEqual(listed.status, 200, listed.text)
            seen.extend(listed.body.get("users", []))
            if page * listed.body["pageSize"] >= listed.body["total"]:
                break
            page += 1
        self.assertFalse(
            any(str(user.get("username", "")).startswith("service-account-") for user in seen),
            "회원 목록에 Keycloak 서비스 계정이 노출됐습니다",
        )

        clients = self.admin("GET", "/clients?clientId=kin-api")
        self.assertEqual(clients.status, 200, clients.text)
        exact = [client for client in clients.body if client.get("clientId") == "kin-api"]
        self.assertEqual(len(exact), 1, "kin-api 클라이언트를 하나로 확정할 수 없습니다")
        service = self.admin("GET", f"/clients/{exact[0]['id']}/service-account-user")
        self.assertEqual(service.status, 200, service.text)
        blocked = self.stack.request(
            "PATCH", f"/admin/users/{quote(service.body['id'])}", "jmryu", {"enabled": False},
        )
        self.assertEqual(blocked.status, 403, blocked.text)

        technician = self.stack.request("GET", "/admin/users?page=1", "tech")
        self.assertEqual(technician.status, 403, technician.text)

    def test_member_self_suspension_and_admin_removal_are_blocked(self) -> None:
        own_id = self.stack.user_ids["jmryu"]
        suspended = self.stack.request(
            "PATCH", f"/admin/users/{quote(own_id)}", "jmryu", {"enabled": False},
        )
        self.assertEqual(suspended.status, 400, suspended.text)
        demoted = self.stack.request(
            "PATCH", f"/admin/users/{quote(own_id)}", "jmryu",
            {"approvalState": "APPROVED", "institution": "hallym", "roles": ["radiologist"]},
        )
        self.assertEqual(demoted.status, 400, demoted.text)

    def test_member_suspension_revokes_session_without_erasing_membership(self) -> None:
        target_id = self.stack.user_ids["doctor"]
        opener, _sid = self.bff_login("doctor", self.stack.passwords["doctor"])
        try:
            changed = self.stack.request(
                "PATCH", f"/admin/users/{quote(target_id)}", "jmryu", {"enabled": False},
            )
            self.assertEqual(changed.status, 200, changed.text)
            self.assertFalse(changed.body.get("enabled"), changed.text)
            expired = self.proxy(opener, "GET", "/api/me")
            self.assertEqual(expired.status, 401, expired.text)

            groups = self.admin("GET", f"/users/{quote(target_id)}/groups")
            roles = self.admin("GET", f"/users/{quote(target_id)}/role-mappings/realm")
            self.assertEqual(groups.status, 200, groups.text)
            self.assertEqual(roles.status, 200, roles.text)
            self.assertEqual([group["name"] for group in groups.body], ["hallym"])
            self.assertIn("radiologist", [role["name"] for role in roles.body])
        finally:
            restored = self.admin("PUT", f"/users/{quote(target_id)}", {"enabled": True})
            self.assertIn(restored.status, (204, 404), restored.text)
            self.stack.tokens.pop("doctor", None)
            self.stack.actors.pop("doctor", None)

    def test_member_delete_proxy_client_and_impersonation_paths_are_absent(self) -> None:
        target_id = self.stack.user_ids["doctor2"]
        absent = (
            self.stack.request("DELETE", f"/admin/users/{quote(target_id)}", "jmryu"),
            self.stack.request("GET", "/admin/clients", "jmryu"),
            self.stack.request("POST", f"/admin/users/{quote(target_id)}/impersonation", "jmryu", {}),
            self.stack.request("GET", "/admin/keycloak/users", "jmryu"),
        )
        for result in absent:
            self.assertEqual(result.status, 404, result.text)

        self.assertEqual(
            self.service_admin("POST", f"/users/{quote(target_id)}/impersonation").status, 403,
            "kin-api 서비스 계정에 impersonation 권한이 있습니다",
        )
        self.assertEqual(
            self.service_admin("GET", "/clients").status, 403,
            "kin-api 서비스 계정에 클라이언트 열거 권한이 있습니다",
        )

        controller = (ROOT / "api" / "src" / "admin.controller.ts").read_text(encoding="utf-8")
        keycloak = (ROOT / "api" / "src" / "keycloak.service.ts").read_text(encoding="utf-8")
        self.assertNotRegex(controller, r"@(Delete|Put|All|RequestMapping)\s*\(")
        self.assertRegex(keycloak, r"private async adm\(")

    def test_member_xss_value_stays_text_and_temporary_password_is_one_time(self) -> None:
        payload = '<img src=x onerror="document.body.dataset.pwned=1">'
        script = """
const { AdminService } = require('/app/dist/admin.service.js');
const payload = process.argv[1];
const value = new AdminService({}, {}).row({
  id: 'x', username: 'x', email: 'x@local.test', emailVerified: true,
  firstName: payload, lastName: '', enabled: true, serviceAccountClientId: null,
  groups: ['hallym'], roles: ['radiologist'],
});
process.stdout.write(JSON.stringify(value));
"""
        mapped = subprocess.run(
            ["docker", "exec", "kin-api", "node", "-e", script, payload],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30,
        )
        self.assertEqual(mapped.returncode, 0, mapped.stderr)
        self.assertEqual(json.loads(mapped.stdout)["name"], payload)

        source = (ROOT / "worklist-v0" / "hpacs-lite" / "admin.html").read_text(encoding="utf-8")
        self.assertNotIn("innerHTML", source)
        self.assertNotIn("localStorage", source)
        self.assertNotIn("sessionStorage", source)
        self.assertIn("cell.textContent = value", source)
        self.assertIn("box.textContent = value", source)
        self.assertIn('value.textContent = password;', source)
        self.assertIn('$("#temporary-password").textContent = "";', source)

    def test_member_names_have_one_separator_between_family_and_given_name(self) -> None:
        me = self.stack.request("GET", "/me", "doctor")
        self.assertEqual(me.status, 200, me.text)
        self.assertEqual(me.body.get("displayName"), "doctor KIN")

        listed = self.stack.request("GET", "/admin/users?page=1", "jmryu")
        self.assertEqual(listed.status, 200, listed.text)
        doctor = next(
            user for user in listed.body["users"]
            if user["username"] == self.stack.username("doctor")
        )
        self.assertEqual(doctor["name"], "doctor KIN")

        colleagues = self.stack.request("GET", "/colleagues", "doctor")
        self.assertEqual(colleagues.status, 200, colleagues.text)
        self.assertIn("doctor2 KIN", [user["name"] for user in colleagues.body])

    def test_registration_success_page_has_safe_return_path(self) -> None:
        source = (
            ROOT / "keycloak" / "themes" / "kin-login" / "login" / "info.ftl"
        ).read_text(encoding="utf-8")
        self.assertIn('id="kin-continue"', source)
        self.assertIn('href="/api/auth/login"', source)
        self.assertIn('${msg("continueToKin")}', source)

    def test_member_unverified_email_cannot_be_approved(self) -> None:
        username = "kin-test-unverified-" + uuid.uuid4().hex[:12]
        created = self.admin("POST", "/users", {
            "username": username, "enabled": True, "emailVerified": False,
            "email": username + "@local.test", "firstName": "Unverified", "lastName": "KIN",
        })
        self.assertEqual(created.status, 201, created.text)
        try:
            blocked = self.stack.request(
                "PATCH", f"/admin/users/{quote(str(created.body))}", "jmryu",
                {"approvalState": "APPROVED", "institution": "hallym", "roles": ["radiologist"]},
            )
            self.assertEqual(blocked.status, 400, blocked.text)
            self.assertEqual(
                blocked.body.get("message"),
                "이메일 검증이 끝나지 않은 사용자는 승인할 수 없습니다",
            )
        finally:
            deleted = self.admin("DELETE", f"/users/{quote(str(created.body))}")
            self.assertIn(deleted.status, (204, 404), deleted.text)

    def test_zzz_break_glass_recovers_dedicated_admin_set(self) -> None:
        recovered_id = self.stack.user_ids["jmryu"]
        other_id = self.stack.create_test_identity("breakglass", ["admin"], "hallym")
        ids = (recovered_id, other_id)
        for user_id in ids:
            self.assertRegex(user_id, r"^[0-9a-f-]{36}$")
        config = "/tmp/kin-breakglass-" + uuid.uuid4().hex + ".config"
        logged_in = self.kcadm(config, login=True)
        self.assertEqual(logged_in.returncode, 0, "kcadm loopback 인증 실패")
        try:
            for user_id in ids:
                disabled = self.kcadm(config, "update", f"users/{user_id}", "-r", "kin", "-s", "enabled=false")
                self.assertEqual(disabled.returncode, 0, "전용 시험 관리자 비활성화 실패")
            for user_id in ids:
                current = self.admin("GET", f"/users/{user_id}")
                self.assertEqual(current.status, 200, current.text)
                self.assertFalse(current.body.get("enabled"), current.text)

            recovered = self.kcadm(
                config, "update", f"users/{recovered_id}", "-r", "kin", "-s", "enabled=true",
            )
            self.assertEqual(recovered.returncode, 0, "kcadm break-glass 복구 실패")
            self.stack.tokens.pop("jmryu", None)
            self.stack.actors.pop("jmryu", None)
            self.assertEqual(self.stack.request("GET", "/me", "jmryu").status, 200)
        finally:
            for user_id in ids:
                self.kcadm(config, "update", f"users/{user_id}", "-r", "kin", "-s", "enabled=true")
                self.admin("PUT", f"/users/{user_id}", {"enabled": True})
            subprocess.run(
                ["docker", "exec", "kin-keycloak", "rm", "-f", config],
                capture_output=True, timeout=30,
            )


class LiveInvariantTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.stack = LiveStack()
        cls.addClassCleanup(cls.stack.cleanup_test_identities)
        cls.addClassCleanup(cls.stack.cleanup_all)
        cls.stack.require_stack()

    def assert_status(self, result: HttpResult, *allowed: int) -> None:
        self.assertIn(result.status, allowed, result.text)

    def versions(self, fixture: Fixture, user: str) -> list[dict[str, Any]]:
        result = self.stack.request(
            "GET", f"/studies/{quote(fixture.uid)}/report/versions", user,
        )
        self.assertEqual(result.status, 200, "기존 ReportVersion이 조회 불가능해졌습니다: " + result.text)
        return sorted(result.body, key=lambda row: row["version"])

    def report_state(self, fixture: Fixture, user: str) -> dict[str, Any]:
        result = self.stack.request("GET", "/bootstrap", user)
        self.assertEqual(result.status, 200, result.text)
        state = result.body.get("states", {}).get(fixture.uid)
        self.assertIsNotNone(state, "StudyState 삭제로 판독문과 이력의 조회 관문이 사라졌습니다")
        keys = (
            "rs", "version", "findings", "conclusion", "recommendation",
            "preDoc", "preReviewer", "repDoc", "confirm",
        )
        return {key: state.get(key) for key in keys}

    def snapshot(self, fixture: Fixture, user: str) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        return self.report_state(fixture, user), self.versions(fixture, user)

    def assert_snapshot_unchanged(
        self, fixture: Fixture, user: str,
        before: tuple[dict[str, Any], list[dict[str, Any]]],
    ) -> None:
        after = self.snapshot(fixture, user)
        self.assertEqual(after[0], before[0], "판독문 현재 내용 또는 RS가 바뀌었습니다")
        self.assertEqual(after[1], before[1], "ReportVersion은 append-only인데 기존 역사가 바뀌었습니다")

    def approve(self, fixture: Fixture, user: str = "doctor") -> HttpResult:
        result = self.stack.request(
            "POST", f"/studies/{quote(fixture.uid)}/report/commit", user,
            {
                "action": "approve", "baseVersion": 0,
                "findings": fixture.secret, "conclusion": "approved", "recommendation": "none",
            },
        )
        self.assert_status(result, 201)
        self.assertEqual(result.body.get("rs"), "A")
        return result

    def preliminary(
        self, fixture: Fixture, author: str = "doctor", reviewer: str = "jmryu",
    ) -> HttpResult:
        result = self.stack.request(
            "POST", f"/studies/{quote(fixture.uid)}/report/commit", author,
            {
                "action": "preliminary", "baseVersion": 0,
                "reviewer": self.stack.actor(reviewer),
                "findings": fixture.secret, "conclusion": "preliminary", "recommendation": "none",
            },
        )
        self.assert_status(result, 201)
        self.assertEqual(result.body.get("rs"), "P")
        return result

    @staticmethod
    def multipart_dicom(content: bytes) -> tuple[bytes, str]:
        boundary = "kin-invariant-" + uuid.uuid4().hex
        body = (
            f"--{boundary}\r\nContent-Type: application/dicom\r\n\r\n".encode("ascii") +
            content + f"\r\n--{boundary}--\r\n".encode("ascii")
        )
        return body, f'multipart/related; type="application/dicom"; boundary={boundary}'

    def test_connect_source_patient_key_is_tenant_scoped_and_empty_safe(self) -> None:
        patient_id = "INV-SHARED-" + uuid.uuid4().hex[:10]
        with ExitStack() as fixtures:
            hallym_a = fixtures.enter_context(self.stack.fixture(patient_id=patient_id))
            hallym_b = fixtures.enter_context(self.stack.fixture(patient_id=patient_id))
            kin = fixtures.enter_context(self.stack.fixture("KIN 판독센터", patient_id=patient_id))
            empty = fixtures.enter_context(self.stack.fixture("KIN 판독센터", patient_id=""))

            for fixture in (hallym_a, hallym_b):
                shared = self.stack.request(
                    "PATCH", f"/studies/{quote(fixture.uid)}", fixture.owner_user,
                    {"ts": "wait", "teleTo": "kin-center"},
                )
                self.assertEqual(shared.status, 200, shared.text)

            listed = self.stack.request("GET", "/studies", "kdoctor")
            self.assertEqual(listed.status, 200, listed.text)
            rows = {item["uid"]: item for item in listed.body.get("studies", [])}
            for fixture in (hallym_a, hallym_b, kin, empty):
                self.assertIn(fixture.uid, rows)
            self.assertEqual(rows[hallym_a.uid].get("sourcePatientKey"), f"hallym|{patient_id}")
            self.assertEqual(rows[hallym_b.uid].get("sourcePatientKey"), f"hallym|{patient_id}")
            self.assertEqual(rows[kin.uid].get("sourcePatientKey"), f"kin-center|{patient_id}")
            self.assertIsNone(rows[empty.uid].get("sourcePatientKey"))
            same_source = [
                row for row in rows.values()
                if row.get("sourcePatientKey") == f"hallym|{patient_id}"
            ]
            self.assertEqual(len(same_source), 2, "단일 기관의 기존 prior 묶음이 달라졌습니다")

    def test_gateway_adjacent_identities_are_rejected(self) -> None:
        for logical in ("gateway-no-role", "gateway-mixed", "gateway-wrong-azp"):
            with self.subTest(identity=logical):
                result = self.stack.bearer_request(
                    "GET", "/studies", self.stack.service_token(logical),
                )
                self.assertEqual(result.status, 403, result.text)
                self.assertEqual(result.body.get("code"), "GATEWAY_IDENTITY_INVALID", result.text)

    def test_gateway_allowed_surface_stays_minimal(self) -> None:
        token = self.stack.service_token("gateway")
        uid = "2.25." + str(uuid.uuid4().int)
        studies = self.stack.bearer_request("GET", "/studies", token)
        self.assertEqual(studies.status, 403, studies.text)
        wado = self.stack.bearer_request(
            "GET", f"/dicom-web/studies/{uid}/metadata", token, base=self.stack.proxy,
        )
        self.assertEqual(wado.status, 403, wado.text)
        human = self.stack.request(
            "POST", "/gateway/announce", "kdoctor", {"studyUid": uid},
        )
        self.assertEqual(human.status, 403, human.text)
        health = self.stack.bearer_request("GET", "/health", token)
        self.assertEqual(health.status, 200, health.text)

    def test_gateway_announce_is_idempotent_and_preserves_dicom_origin(self) -> None:
        token = self.stack.service_token("gateway")
        uid = "2.25." + str(uuid.uuid4().int)
        self.stack.active[uid] = Fixture(uid, "", "KIN 판독센터", "kdoctor", "")
        first = self.stack.bearer_request(
            "POST", "/gateway/announce", token,
            {"studyUid": uid, "institutionNameTag": "한림병원"},
        )
        second = self.stack.bearer_request(
            "POST", "/gateway/announce", token,
            {"studyUid": uid, "institutionNameTag": "한림병원"},
        )
        self.assertEqual(first.status, 200, first.text)
        self.assertEqual(second.status, 200, second.text)
        self.assertEqual(first.body.get("origin"), "gateway")
        audits = self.stack.request("GET", "/audit?uid=" + quote(uid), "kdoctor")
        announced = [row for row in audits.body if row.get("action") == "study.announce"]
        self.assertEqual(len(announced), 1, audits.text)
        self.assertIn("tagMismatch", json.dumps(announced[0], ensure_ascii=False))

        with self.stack.fixture("KIN 판독센터") as existing:
            preserved = self.stack.bearer_request(
                "POST", "/gateway/announce", token, {"studyUid": existing.uid},
            )
            self.assertEqual(preserved.status, 200, preserved.text)
            self.assertEqual(preserved.body.get("origin"), "dicom")

        with self.stack.fixture() as foreign:
            conflict = self.stack.bearer_request(
                "POST", "/gateway/announce", token, {"studyUid": foreign.uid},
            )
            self.assertEqual(conflict.status, 409, conflict.text)
            self.assertEqual(conflict.body.get("code"), "STUDY_OWNERSHIP_CONFLICT", conflict.text)

    def test_gateway_stow_requires_announce_and_matching_uid(self) -> None:
        token = self.stack.service_token("gateway")
        with self.stack.fixture() as source:
            instance_id = self.stack.first_instance_id(source.uid)
            content = self.stack.orthanc_bytes(f"/instances/{quote(instance_id)}/file")
            body, content_type = self.multipart_dicom(content)
            unannounced_uid = "2.25." + str(uuid.uuid4().int)
            unannounced = self.stack.bearer_request(
                "POST", f"/dicom-web/studies/{unannounced_uid}", token, body,
                base=self.stack.proxy,
                headers={"Content-Type": content_type, "Accept": "application/dicom+json"},
            )
            self.assertEqual(unannounced.status, 403, unannounced.text)
            uidless = self.stack.bearer_request(
                "POST", "/dicom-web/studies", token, body, base=self.stack.proxy,
                headers={"Content-Type": content_type, "Accept": "application/dicom+json"},
            )
            self.assertEqual(uidless.status, 403, uidless.text)

            announced_uid = "2.25." + str(uuid.uuid4().int)
            self.stack.active[announced_uid] = Fixture(
                announced_uid, "", "KIN 판독센터", "kdoctor", "",
            )
            announced = self.stack.bearer_request(
                "POST", "/gateway/announce", token, {"studyUid": announced_uid},
            )
            self.assertEqual(announced.status, 200, announced.text)
            mismatch = self.stack.bearer_request(
                "POST", f"/dicom-web/studies/{announced_uid}", token, body,
                base=self.stack.proxy,
                headers={"Content-Type": content_type, "Accept": "application/dicom+json"},
            )
            self.assertEqual(mismatch.status, 409, mismatch.text)
            self.assertIn("00081198", mismatch.text)

    def test_gateway_agent_queue_and_batch_contract(self) -> None:
        completed = subprocess.run(
            [sys.executable, str(ROOT / "gateway" / "agent" / "test_agent.py")],
            cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60,
        )
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        self.assertIn("Ran 5 tests", completed.stderr + completed.stdout)

    def test_production_gateway_contract_is_declared(self) -> None:
        completed = subprocess.run(
            [
                "docker", "compose", "-f", "docker-compose.yml", "-f",
                "docker-compose.prod.yml", "config", "--format", "json",
            ],
            cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        rendered = json.loads(completed.stdout)
        ports = rendered["services"]["orthanc"].get("ports", [])
        self.assertFalse(
            any(str(port.get("target")) == "4242" or str(port.get("published")) == "4242"
                for port in ports),
            "production compose가 클라우드 Orthanc 4242를 다시 게시합니다",
        )

        realm = json.loads((ROOT / "keycloak" / "kin-realm.json").read_text(encoding="utf-8"))
        self.assertIn("gateway", {role["name"] for role in realm["roles"]["realm"]})
        clients = [item for item in realm["clients"] if item.get("clientId") == "gw-kin-center"]
        self.assertEqual(len(clients), 1)
        self.assertNotIn("secret", clients[0], "Gateway 시크릿을 렐름 JSON에 커밋했습니다")
        self.assertFalse(clients[0].get("enabled"), "시크릿 없는 Gateway 템플릿은 활성화하면 안 됩니다")

        page = (ROOT / "worklist-v0" / "hpacs-lite" / "main.html").read_text(encoding="utf-8")
        self.assertRegex(page, r"\.userfilter\s*\{[^}]*flex-wrap:\s*wrap")
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        gateway_readme = (ROOT / "gateway" / "README.md").read_text(encoding="utf-8")
        self.assertIn("gw-<institutionId>", readme)
        self.assertIn("Phase 1 지원 범위는 CT", gateway_readme)
        self.assertIn("로컬 개발 스택 전용", gateway_readme)

        with patch.dict(os.environ, {
            "KIN_TEST_INGEST": "gateway", "KIN_TEST_GATEWAY_HOST": "gateway.test",
            "KIN_TEST_GATEWAY_PORT": "14243", "KIN_TEST_GATEWAY_AET": "KINGW",
        }):
            command = self.stack.fixture_command("KIN 판독센터", "INVARIANT^MODE", "INV-MODE")
        self.assertEqual(command[command.index("--host") + 1], "gateway.test")
        self.assertEqual(command[command.index("--port") + 1], "14243")
        self.assertEqual(command[command.index("--called-aet") + 1], "KINGW")

    def test_selected_ingest_reaches_worklist(self) -> None:
        mode = os.environ.get("KIN_TEST_INGEST", "cstore").strip().lower()
        institution = (
            os.environ.get("KIN_TEST_GATEWAY_INSTITUTION_NAME", "").strip()
            if mode == "gateway" else "한림병원"
        )
        if mode == "gateway" and not institution:
            self.fail("gateway smoke에는 KIN_TEST_GATEWAY_INSTITUTION_NAME이 필요합니다")
        with self.stack.fixture(institution) as fixture:
            listed = self.stack.request("GET", "/studies", fixture.owner_user)
            self.assertEqual(listed.status, 200, listed.text)
            row = next(
                (item for item in listed.body.get("studies", []) if item.get("uid") == fixture.uid),
                None,
            )
            self.assertIsNotNone(row, "선택한 fixture 수신 경로가 워크리스트까지 이어지지 않았습니다")

    def call_report_route(
        self, route: Route, fixture: Fixture, user: str, base_version: int,
    ) -> HttpResult:
        uid = quote(fixture.uid)
        operation = route.operation
        if operation == "bootstrap":
            return self.stack.request("GET", "/bootstrap", user)
        if operation == "studies":
            return self.stack.request("GET", "/studies", user)
        if operation == "patch":
            return self.stack.request("PATCH", f"/studies/{uid}", user, {"ss": "Verified"})
        if operation == "draft-put":
            return self.stack.request(
                "PUT", f"/studies/{uid}/report", user,
                {"findings": "ATTEMPT", "conclusion": "", "recommendation": "", "baseVersion": base_version},
            )
        if operation == "draft-delete":
            return self.stack.request("DELETE", f"/studies/{uid}/draft", user)
        if operation == "draft-force":
            return self.stack.request("DELETE", f"/studies/{uid}/draft/force", user)
        if operation == "commit":
            return self.stack.request(
                "POST", f"/studies/{uid}/report/commit", user,
                {
                    "action": "save", "baseVersion": base_version,
                    "findings": "ATTEMPT", "conclusion": "", "recommendation": "",
                },
            )
        if operation == "versions":
            return self.stack.request("GET", f"/studies/{uid}/report/versions", user)
        if operation == "hold":
            return self.stack.request("POST", f"/studies/{uid}/hold", user)
        if operation == "release":
            return self.stack.request("POST", f"/studies/{uid}/release", user)
        if operation == "study-delete":
            return self.stack.request("DELETE", f"/studies/{uid}", user)
        raise AssertionError(f"REPORT 라우트에 호출 방법이 없습니다: {route}")

    def test_report_routes_cannot_damage_approved_report_as_technician(self) -> None:
        with self.stack.fixture() as fixture:
            self.approve(fixture)
            before = self.snapshot(fixture, "doctor")
            for key, route in REPORT_ROUTES:
                with self.subTest(route=key):
                    result = self.call_report_route(route, fixture, "tech", before[0]["version"])
                    self.assertLess(result.status, 500, result.text)
                    self.assert_snapshot_unchanged(fixture, "doctor", before)

    def test_report_routes_hide_and_protect_preliminary_from_third_radiologist(self) -> None:
        with self.stack.fixture() as fixture:
            self.preliminary(fixture, author="doctor", reviewer="jmryu")
            before = self.snapshot(fixture, "doctor")
            for key, route in REPORT_ROUTES:
                with self.subTest(route=key):
                    result = self.call_report_route(route, fixture, "doctor2", before[0]["version"])
                    self.assertFalse(result.contains(fixture.secret), "제3자 응답에 예비 판독 본문이 노출됐습니다")
                    self.assertLess(result.status, 500, result.text)
                    self.assert_snapshot_unchanged(fixture, "doctor", before)

    def test_report_routes_hide_other_tenant_even_from_admin(self) -> None:
        with self.stack.fixture("KIN 판독센터") as fixture:
            self.approve(fixture, user="kdoctor")
            before = self.snapshot(fixture, "kdoctor")
            for key, route in REPORT_ROUTES:
                with self.subTest(route=key):
                    result = self.call_report_route(route, fixture, "jmryu", before[0]["version"])
                    if route.scope == "collection":
                        self.assert_status(result, 200)
                        self.assertFalse(result.contains(fixture.uid), "admin 응답에 다른 기관 검사가 노출됐습니다")
                    else:
                        self.assertEqual(result.status, 404, result.text)
                    self.assert_snapshot_unchanged(fixture, "kdoctor", before)

    def test_dicom_routes_enforce_tenant_boundary_and_preserve_tele_access(self) -> None:
        with self.stack.fixture() as fixture:
            uid = quote(fixture.uid)
            instance_id = quote(self.stack.first_instance_id(fixture.uid))
            protected = (
                f"/dicom-web/studies/{uid}/metadata",
                f"/instances/{instance_id}/preview",
                f"/dicom-web/studies?StudyInstanceUID={uid}",
            )

            # 로그인만으로는 부족하다. 타 기관은 UID나 Orthanc ID를 알아도 열지 못한다.
            for path in protected:
                with self.subTest(boundary="other-tenant", path=path):
                    result = self.stack.dicom_request(path, "kdoctor")
                    self.assertEqual(result.status, 403, result.text)

            # 전체 열거는 기관을 가를 UID가 없다. 소유기관 토큰이어도 워크리스트 API를 써야 한다.
            for user in ("kdoctor", fixture.owner_user):
                with self.subTest(boundary="uidless-list", user=user):
                    result = self.stack.dicom_request("/dicom-web/studies", user)
                    self.assertEqual(result.status, 403, result.text)

            for path in protected:
                with self.subTest(boundary="owner", path=path):
                    result = self.stack.dicom_request(path, fixture.owner_user)
                    self.assertEqual(result.status, 200, result.text)

            # visible()의 두 번째 가지: 정식 원격판독 수신기관은 같은 영상에 접근할 수 있다.
            requested = self.stack.request(
                "PATCH", f"/studies/{uid}", fixture.owner_user,
                {"ts": "wait", "teleTo": "kin-center"},
            )
            self.assertEqual(requested.status, 200, requested.text)
            for path in protected:
                with self.subTest(boundary="tele-receiver", path=path):
                    result = self.stack.dicom_request(path, "kdoctor")
                    self.assertEqual(result.status, 200, result.text)

            # A-1 회귀: 기관 판단 전에 인증부터 요구한다.
            unauthenticated = self.stack.dicom_request(protected[0])
            self.assertEqual(unauthenticated.status, 401, unauthenticated.text)

    def test_preliminary_save_then_author_approve_stays_locked(self) -> None:
        with self.stack.fixture() as fixture:
            prelim = self.preliminary(fixture, author="doctor", reviewer="doctor2")
            saved = self.stack.request(
                "POST", f"/studies/{quote(fixture.uid)}/report/commit", "doctor",
                {
                    "action": "save", "baseVersion": prelim.body["version"],
                    "findings": fixture.secret, "conclusion": "saved while P", "recommendation": "none",
                },
            )
            self.assert_status(saved, 201)
            self.assertEqual(saved.body.get("rs"), "P")
            approved = self.stack.request(
                "POST", f"/studies/{quote(fixture.uid)}/report/commit", "doctor",
                {
                    "action": "approve", "baseVersion": saved.body["version"],
                    "findings": fixture.secret, "conclusion": "self approve", "recommendation": "none",
                },
            )
            self.assertEqual(approved.status, 403, approved.text)
            self.assertEqual(self.report_state(fixture, "doctor")["rs"], "P")

    def test_preliminary_patch_rs_then_author_approve_stays_locked(self) -> None:
        with self.stack.fixture() as fixture:
            prelim = self.preliminary(fixture, author="doctor", reviewer="doctor2")
            patched = self.stack.request(
                "PATCH", f"/studies/{quote(fixture.uid)}", "doctor", {"rs": "T"},
            )
            self.assertEqual(patched.status, 400, patched.text)
            approved = self.stack.request(
                "POST", f"/studies/{quote(fixture.uid)}/report/commit", "doctor",
                {
                    "action": "approve", "baseVersion": prelim.body["version"],
                    "findings": fixture.secret, "conclusion": "self approve", "recommendation": "none",
                },
            )
            self.assertEqual(approved.status, 403, approved.text)
            self.assertEqual(self.report_state(fixture, "doctor")["rs"], "P")

    def test_approved_report_cannot_be_taken_over_as_preliminary(self) -> None:
        with self.stack.fixture() as fixture:
            approved = self.approve(fixture)
            before = self.snapshot(fixture, "doctor")
            result = self.stack.request(
                "POST", f"/studies/{quote(fixture.uid)}/report/commit", "doctor",
                {
                    "action": "preliminary", "baseVersion": approved.body["version"],
                    "reviewer": self.stack.actor("doctor2"),
                    "findings": "replacement", "conclusion": "", "recommendation": "",
                },
            )
            self.assertEqual(result.status, 400, result.text)
            self.assert_snapshot_unchanged(fixture, "doctor", before)

    def test_approved_report_cannot_be_deleted(self) -> None:
        with self.stack.fixture() as fixture:
            self.approve(fixture)
            before = self.snapshot(fixture, "doctor")
            deleted = self.stack.request("DELETE", f"/studies/{quote(fixture.uid)}", "tech")
            self.assertEqual(deleted.status, 400, deleted.text)
            self.assert_snapshot_unchanged(fixture, "doctor", before)

    def test_reset_approved_report_still_cannot_be_deleted(self) -> None:
        with self.stack.fixture() as fixture:
            approved = self.approve(fixture)
            original_versions = self.versions(fixture, "doctor")
            reset = self.stack.request(
                "POST", f"/studies/{quote(fixture.uid)}/report/commit", "doctor",
                {
                    "action": "reset", "baseVersion": approved.body["version"],
                    "reason": "invariant regression", "findings": "", "conclusion": "", "recommendation": "",
                },
            )
            self.assert_status(reset, 201)
            self.assertEqual(reset.body.get("rs"), "W")
            deleted = self.stack.request("DELETE", f"/studies/{quote(fixture.uid)}", "tech")
            self.assertEqual(deleted.status, 400, deleted.text)
            after = self.versions(fixture, "doctor")
            old_by_id = {row["id"]: row for row in original_versions}
            after_by_id = {row["id"]: row for row in after}
            self.assertTrue(old_by_id.keys() <= after_by_id.keys(), "Reset 이전 판이 사라졌습니다")
            self.assertIsNotNone(self.report_state(fixture, "doctor"))

    def test_zzz_known_failure_concurrent_commit_must_not_return_500(self) -> None:
        """다음 배치의 빨간 테스트. @expectedFailure로 숨기지 않는다."""
        with self.stack.fixture() as fixture:
            callers = 16
            barrier = threading.Barrier(callers)

            def commit(index: int) -> HttpResult:
                barrier.wait(timeout=10)
                user = "doctor" if index % 2 == 0 else "doctor2"
                return self.stack.request(
                    "POST", f"/studies/{quote(fixture.uid)}/report/commit", user,
                    {
                        "action": "save", "baseVersion": 0,
                        "findings": f"concurrent-{index}", "conclusion": "", "recommendation": "",
                    },
                )

            with ThreadPoolExecutor(max_workers=callers) as pool:
                results = list(pool.map(commit, range(callers)))
            statuses = [result.status for result in results]
            server_errors = [result.text for result in results if result.status >= 500]
            self.assertIn(201, statuses, f"동시 호출 중 확정된 요청이 하나도 없습니다: {statuses}")
            self.assertFalse(
                server_errors,
                "동시 commitReport가 같은 version을 계산해 500을 냈습니다. "
                f"statuses={statuses}, errors={server_errors}",
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
