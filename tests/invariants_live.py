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
from datetime import date, datetime, timezone
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
    ("POST", "studies/:uid/release/force"): Route(Kind.REPORT, "release-force"),
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


def psql(sql: str) -> list[str]:
    """컨테이너 psql 한 문장. 시간 비교가 섞이므로 세션 시간대를 UTC로 고정한다 — Prisma가 UTC로 쓴다.

    점유 TTL처럼 '5분 뒤'를 기다리는 대신 heldAt을 과거로 옮기고, 회원 감사 행은 /audit이 검사 uid
    관문 뒤로 닫혀 API로 못 읽으므로 여기서 읽는다. 결과는 빈 줄을 뺀 줄 목록이다.
    """
    completed = subprocess.run(
        ["docker", "compose", "exec", "-T", "-e", "PGTZ=UTC", "db", "psql", "-U", "kin", "-d", "kin",
         "-v", "ON_ERROR_STOP=1", "-qAt", "-c", sql],
        cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30,
    )
    if completed.returncode:
        raise RuntimeError("psql 실패: " + completed.stdout + completed.stderr)
    return [line for line in completed.stdout.splitlines() if line.strip()]


UUID_RE = r"^[0-9a-f-]{36}$"


def user_audit(user_id: str) -> list[tuple[str, dict[str, Any]]]:
    """Keycloak 사용자 id를 target으로 남은 회원 감사 행 (id 순)."""
    if not re.fullmatch(UUID_RE, user_id):
        raise RuntimeError(f"감사 조회를 거부한 비정상 사용자 id: {user_id}")
    rows = psql(
        f"SELECT action || E'\\t' || coalesce(detail, '') FROM \"AuditLog\" WHERE target='{user_id}' ORDER BY id;"
    )
    out = []
    for row in rows:
        action, _, detail = row.partition("\t")
        out.append((action, json.loads(detail) if detail else {}))
    return out


def purge_user_audit(user_id: str) -> None:
    """시험이 만든 회원 감사 행 정리. cleanup_fixture는 검사 uid 행만 지운다."""
    if not re.fullmatch(UUID_RE, user_id):
        raise RuntimeError(f"감사 정리를 거부한 비정상 사용자 id: {user_id}")
    psql(f"DELETE FROM \"AuditLog\" WHERE target='{user_id}';")


TEMPORARY_PASSWORD_RE = r"^[A-Za-z0-9_-]{24}aA1!$"


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

    # ── v0.6.3 회원 승인 생애주기 헬퍼 ──

    def group_id(self, name: str) -> str:
        found = self.admin("GET", "/groups?search=" + quote(name))
        self.assertEqual(found.status, 200, found.text)
        exact = [group for group in found.body if group.get("name") == name]
        self.assertEqual(len(exact), 1, name)
        return exact[0]["id"]

    def kc_user_summary(self, user_id: str) -> tuple[list[str], list[str]]:
        """Keycloak이 실제로 들고 있는 (그룹, 앱 역할). 기본 역할(default-roles-kin 등)은 관리 대상이 아니라 뺀다."""
        groups = self.admin("GET", f"/users/{quote(user_id)}/groups")
        roles = self.admin("GET", f"/users/{quote(user_id)}/role-mappings/realm")
        self.assertEqual((groups.status, roles.status), (200, 200), groups.text + roles.text)
        app = {"radiologist", "technician", "admin"}
        return sorted(g["name"] for g in groups.body), sorted(r["name"] for r in roles.body if r["name"] in app)

    def admin_row(self, username: str) -> dict[str, Any]:
        page = 1
        while True:
            listed = self.stack.request("GET", f"/admin/users?page={page}", "jmryu")
            self.assertEqual(listed.status, 200, listed.text)
            for row in listed.body["users"]:
                if row["username"] == username:
                    return row
            if page * listed.body["pageSize"] >= listed.body["total"]:
                self.fail(f"회원 목록에 {username}이 없습니다")
            page += 1

    def password_grant_status(self, username: str, password: str) -> int:
        data = urlencode({
            "client_id": self.stack.test_client_id, "grant_type": "password",
            "username": username, "password": password,
        }).encode("ascii")
        request = Request(
            self.stack.keycloak, data=data,
            headers={"Content-Type": "application/x-www-form-urlencoded"}, method="POST",
        )
        try:
            with self.stack._open(request) as response:
                return response.status
        except HTTPError as error:
            return error.code

    def delete_member(self, user_id: str | None) -> None:
        if not user_id:
            return
        deleted = self.admin("DELETE", f"/users/{quote(user_id)}")
        self.assertIn(deleted.status, (204, 404), deleted.text)
        purge_user_audit(user_id)

    def test_member_approval_round_trip_grants_and_revokes_access(self) -> None:
        user_id = None
        opener = None
        try:
            user_id, username, password = self.create_member(with_group=False)
            path = f"/admin/users/{quote(user_id)}"
            opener, _sid = self.bff_login(username, password)
            pending = self.proxy(opener, "GET", "/api/me")
            self.assertEqual((pending.status, pending.body.get("code")), (403, "INSTITUTION_PENDING"), pending.text)

            approved = self.stack.request("PATCH", path, "jmryu", {
                "approvalState": "APPROVED", "institution": "hallym", "roles": ["radiologist"],
            })
            self.assertEqual(approved.status, 200, approved.text)
            self.assertEqual(
                (approved.body["approvalState"], approved.body["institution"], approved.body["roles"], approved.body["enabled"]),
                ("APPROVED", "hallym", ["radiologist"], True),
            )
            # 자격이 바뀌면 그 전에 만든 세션은 죽는다 — isolate()가 승인 앞에 선다
            self.assertEqual(self.proxy(opener, "GET", "/api/me").status, 401)
            opener, _sid = self.bff_login(username, password)
            me = self.proxy(opener, "GET", "/api/me")
            self.assertEqual(me.status, 200, me.text)
            self.assertEqual(me.body["institution"], "hallym")
            self.assertIn("radiologist", me.body["roles"])
            self.assertEqual(self.kc_user_summary(user_id), (["hallym"], ["radiologist"]))
            audit = user_audit(user_id)
            self.assertEqual([action for action, _ in audit], ["admin.user.approve"])
            self.assertEqual(
                (audit[0][1]["before"]["approvalState"], audit[0][1]["after"]["approvalState"]),
                ("PENDING", "APPROVED"),
            )

            cancelled = self.stack.request("PATCH", path, "jmryu", {"approvalState": "PENDING"})
            self.assertEqual(cancelled.status, 200, cancelled.text)
            self.assertEqual(
                (cancelled.body["approvalState"], cancelled.body["institution"], cancelled.body["roles"], cancelled.body["enabled"]),
                ("PENDING", None, [], True),
            )
            self.assertEqual(self.proxy(opener, "GET", "/api/me").status, 401)
            opener, _sid = self.bff_login(username, password)
            back = self.proxy(opener, "GET", "/api/me")
            self.assertEqual((back.status, back.body.get("code")), (403, "INSTITUTION_PENDING"), back.text)
            self.assertEqual(self.kc_user_summary(user_id), ([], []))
            self.assertEqual([action for action, _ in user_audit(user_id)], ["admin.user.approve", "admin.user.unapprove"])
        finally:
            if opener is not None:
                self.proxy(opener, "POST", "/api/auth/logout", headers={"X-KIN-CSRF": "1"})
            self.delete_member(user_id)

    def test_member_management_rejects_invalid_inputs_without_side_effects(self) -> None:
        user_id = None
        try:
            user_id, _username, _password = self.create_member(with_group=False)
            path = f"/admin/users/{quote(user_id)}"
            # roles 검사는 institution 뒤에 돌므로 유효한 기관을 같이 보내야 roles 규칙이 실제로 실행된다
            bad = (
                ({"approvalState": "APPROVED", "institution": "nowhere", "roles": ["radiologist"]}, "허용되지 않은 기관"),
                ({"approvalState": "APPROVED", "institution": "hallym", "roles": []}, "roles"),
                ({"approvalState": "APPROVED", "institution": "hallym", "roles": ["gateway"]}, "허용되지 않은 역할"),
                ({"approvalState": "BANNED"}, "approvalState"),
                ({"approvalState": "PENDING", "institution": "hallym"}, "섞을 수 없습니다"),
                ({"approvalState": "PENDING", "enabled": True}, "enabled=true"),
                ({"enabled": "yes"}, "boolean"),
                ({}, "변경할 회원 상태가 없습니다"),
                ({"verificationOverride": True}, "승인·자격 변경"),
            )
            for body, fragment in bad:
                with self.subTest(body=body):
                    result = self.stack.request("PATCH", path, "jmryu", body)
                    self.assertEqual(result.status, 400, result.text)
                    self.assertIn(fragment, result.body.get("message", ""), result.text)
            # 비관리자는 대상이 있든 없든 403 — 404를 주면 존재 여부가 새는 오라클이 된다
            ghost = str(uuid.uuid4())
            self.assertEqual(self.stack.request("PATCH", f"/admin/users/{ghost}", "doctor", {"enabled": False}).status, 403)
            self.assertEqual(self.stack.request("PATCH", path, "doctor", {"enabled": False}).status, 403)
            self.assertEqual(self.stack.request("POST", f"/admin/users/{ghost}/reset-password", "doctor", {"mode": "temp"}).status, 403)
            self.assertEqual(self.stack.request("POST", "/admin/users", "tech", {"username": "x"}).status, 403)
            self.assertEqual(self.stack.request("PATCH", f"/admin/users/{ghost}", "jmryu", {"enabled": False}).status, 404)
            self.assertEqual(self.stack.request("POST", f"/admin/users/{ghost}/reset-password", "jmryu", {"mode": "temp"}).status, 404)
            own = self.stack.user_ids["jmryu"]
            self.assertEqual(self.stack.request("PATCH", f"/admin/users/{quote(own)}", "jmryu", {"approvalState": "PENDING"}).status, 400)
            self.assertEqual(self.stack.request("GET", "/me", "jmryu").status, 200)
            self.assertEqual(self.stack.request("GET", "/admin/users?page=0", "jmryu").status, 400)
            self.assertEqual(self.stack.request("GET", "/admin/users?page=abc", "jmryu").status, 400)

            self.assertEqual(self.kc_user_summary(user_id), ([], []))
            current = self.admin("GET", f"/users/{quote(user_id)}")
            self.assertTrue(current.body.get("enabled"), current.text)
            self.assertEqual(user_audit(user_id), [], "거절된 요청이 감사 행을 남겼습니다")
        finally:
            self.delete_member(user_id)

    def test_member_invalid_states_cannot_be_activated_until_fixed(self) -> None:
        for axis in ("group-without-roles", "two-groups"):
            user_id = None
            opener = None
            with self.subTest(axis=axis):
                try:
                    user_id, username, password = self.create_member(with_group=True)
                    path = f"/admin/users/{quote(user_id)}"
                    if axis == "two-groups":
                        joined = self.admin("PUT", f"/users/{quote(user_id)}/groups/{quote(self.group_id('kin-center'))}")
                        self.assertEqual(joined.status, 204, joined.text)
                        role = self.admin("GET", "/roles/radiologist")
                        assigned = self.admin("POST", f"/users/{quote(user_id)}/role-mappings/realm", [role.body])
                        self.assertEqual(assigned.status, 204, assigned.text)
                    opener, _sid = self.bff_login(username, password)
                    me = self.proxy(opener, "GET", "/api/me")
                    self.assertEqual((me.status, me.body.get("code")), (403, "INSTITUTION_INVALID"), me.text)
                    row = self.admin_row(username)
                    # 그룹이 하나면 기관은 보이되 역할이 없어 INVALID, 둘이면 기관 자체가 정해지지 않는다
                    expected_institution = "hallym" if axis == "group-without-roles" else None
                    self.assertEqual((row["approvalState"], row["institution"]), ("INVALID", expected_institution), row)
                    blocked = self.stack.request("PATCH", path, "jmryu", {"enabled": True})
                    self.assertEqual(blocked.status, 400, blocked.text)
                    self.assertIn("INVALID", blocked.body["message"])

                    fixed = self.stack.request("PATCH", path, "jmryu", {
                        "approvalState": "APPROVED", "institution": "hallym", "roles": ["radiologist"],
                    })
                    self.assertEqual(fixed.status, 200, fixed.text)
                    self.assertEqual((fixed.body["approvalState"], fixed.body["institution"]), ("APPROVED", "hallym"))
                    self.assertEqual(self.kc_user_summary(user_id), (["hallym"], ["radiologist"]), "그룹이 하나로 수렴하지 않았습니다")
                    self.assertEqual(self.proxy(opener, "GET", "/api/me").status, 401)
                    opener, _sid = self.bff_login(username, password)
                    me = self.proxy(opener, "GET", "/api/me")
                    self.assertEqual((me.status, me.body.get("institution")), (200, "hallym"), me.text)
                    audit = user_audit(user_id)
                    # INVALID → APPROVED는 '승인'이 아니라 '교정'이다(action은 before가 PENDING일 때만 approve)
                    self.assertEqual([action for action, _ in audit], ["admin.user.update"])
                    self.assertEqual(audit[0][1]["before"]["approvalState"], "INVALID")
                finally:
                    if opener is not None:
                        self.proxy(opener, "POST", "/api/auth/logout", headers={"X-KIN-CSRF": "1"})
                    self.delete_member(user_id)

    def test_member_create_starts_pending_or_approved_with_override(self) -> None:
        created: list[str] = []
        usernames: list[str] = []
        try:
            def body_for(username: str, **extra: Any) -> dict[str, Any]:
                usernames.append(username)
                return {"username": username, "email": username + "@local.test", "firstName": "KIN", "lastName": "Create", **extra}

            plain = self.stack.request("POST", "/admin/users", "jmryu", body_for("kin-test-create-" + uuid.uuid4().hex[:10]))
            self.assertEqual(plain.status, 201, plain.text)
            created.append(plain.body["id"])
            self.assertEqual(
                (plain.body["approvalState"], plain.body["enabled"], plain.body["emailVerified"], plain.body["institution"], plain.body["roles"]),
                ("PENDING", True, False, None, []),
            )
            self.assertRegex(plain.body["temporaryPassword"], TEMPORARY_PASSWORD_RE)

            override = self.stack.request("POST", "/admin/users", "jmryu", body_for(
                "kin-test-create-" + uuid.uuid4().hex[:10],
                verificationOverride=True, institution="hallym", roles=["radiologist"],
            ))
            self.assertEqual(override.status, 201, override.text)
            created.append(override.body["id"])
            self.assertEqual(
                (override.body["approvalState"], override.body["institution"], override.body["roles"], override.body["emailVerified"], override.body["enabled"]),
                ("APPROVED", "hallym", ["radiologist"], False, True),
            )
            self.assertEqual(self.kc_user_summary(override.body["id"]), (["hallym"], ["radiologist"]))

            rejected = (
                (body_for("kin-test-create-" + uuid.uuid4().hex[:10], institution="hallym"), "verificationOverride"),
                ({"username": "kin-test-create-" + uuid.uuid4().hex[:10], "email": "a@local.test", "firstName": "KIN"}, "lastName"),
                (body_for("service-account-kin-test-" + uuid.uuid4().hex[:6]), "서비스 계정"),
            )
            for body, fragment in rejected:
                with self.subTest(body=body):
                    result = self.stack.request("POST", "/admin/users", "jmryu", body)
                    self.assertEqual(result.status, 400, result.text)
                    self.assertIn(fragment, result.body["message"])
            self.assertEqual(self.stack.request("POST", "/admin/users", "doctor", body_for("kin-test-create-" + uuid.uuid4().hex[:10])).status, 403)
            for username in usernames[2:]:
                found = self.admin("GET", f"/users?username={quote(username)}&exact=true")
                self.assertEqual([u for u in found.body if u.get("username") == username], [], f"거절된 생성이 사용자를 남겼습니다: {username}")

            secrets = {plain.body["temporaryPassword"], override.body["temporaryPassword"]}
            for user_id in created:
                audit = user_audit(user_id)
                self.assertEqual([action for action, _ in audit], ["admin.user.create"])
                text = json.dumps(audit, ensure_ascii=False)
                for secret in secrets:
                    self.assertNotIn(secret, text, "감사로그에 임시 비밀번호가 남았습니다")
        finally:
            for user_id in created:
                self.delete_member(user_id)
            for username in usernames:
                found = self.admin("GET", f"/users?username={quote(username)}&exact=true")
                for user in found.body or []:
                    if user.get("username") == username:
                        self.delete_member(user["id"])

    def test_member_create_override_validates_before_keycloak_write(self) -> None:
        usernames: list[str] = []
        try:
            for extra, fragment in (
                ({"institution": "no-such-institution", "roles": ["radiologist"]}, "허용되지 않은 기관"),
                ({"institution": "hallym", "roles": ["gateway"]}, "허용되지 않은 역할"),
                ({"institution": "hallym", "roles": []}, "roles"),
            ):
                username = "kin-test-orphan-" + uuid.uuid4().hex[:10]
                usernames.append(username)
                with self.subTest(body=extra):
                    result = self.stack.request("POST", "/admin/users", "jmryu", {
                        "username": username, "email": username + "@local.test",
                        "firstName": "KIN", "lastName": "Orphan", "verificationOverride": True, **extra,
                    })
                    self.assertEqual(result.status, 400, result.text)
                    self.assertIn(fragment, result.body.get("message", ""), result.text)
                    found = self.admin("GET", f"/users?username={quote(username)}&exact=true")
                    self.assertEqual(
                        [u for u in found.body if u.get("username") == username], [],
                        "잘못된 입력이 Keycloak에 고아 계정을 남겼습니다",
                    )
        finally:
            for username in usernames:
                found = self.admin("GET", f"/users?username={quote(username)}&exact=true")
                for user in found.body or []:
                    if user.get("username") == username:
                        self.delete_member(user["id"])

    def test_member_verification_override_is_the_single_audited_bypass(self) -> None:
        username = "kin-test-unverified-" + uuid.uuid4().hex[:12]
        created = self.admin("POST", "/users", {
            "username": username, "enabled": True, "emailVerified": False,
            "email": username + "@local.test", "firstName": "Unverified", "lastName": "KIN",
        })
        self.assertEqual(created.status, 201, created.text)
        user_id = str(created.body)
        try:
            path = f"/admin/users/{quote(user_id)}"
            approve = {"approvalState": "APPROVED", "institution": "hallym", "roles": ["radiologist"]}
            self.assertEqual(self.stack.request("PATCH", path, "jmryu", approve).status, 400)
            self.assertEqual(self.stack.request("PATCH", path, "jmryu", {**approve, "verificationOverride": "yes"}).status, 400)
            self.assertEqual(self.stack.request("PATCH", path, "jmryu", {"verificationOverride": True}).status, 400)
            self.assertEqual(self.stack.request("PATCH", path, "jmryu", {"enabled": True, "verificationOverride": True}).status, 400)
            self.assertEqual(user_audit(user_id), [])

            ok = self.stack.request("PATCH", path, "jmryu", {**approve, "verificationOverride": True})
            self.assertEqual(ok.status, 200, ok.text)
            self.assertEqual(
                (ok.body["approvalState"], ok.body["institution"], ok.body["emailVerified"], ok.body["enabled"]),
                ("APPROVED", "hallym", False, True),
            )
            # 우회는 검증을 위조하지 않는다 — Keycloak의 emailVerified는 그대로 false다
            self.assertFalse(self.admin("GET", f"/users/{quote(user_id)}").body.get("emailVerified"))
            audit = user_audit(user_id)
            self.assertEqual([action for action, _ in audit], ["admin.user.approve"])
            self.assertTrue(audit[0][1]["verificationOverride"])
            self.assertEqual((audit[0][1]["before"]["approvalState"], audit[0][1]["after"]["approvalState"]), ("PENDING", "APPROVED"))
        finally:
            self.delete_member(user_id)

    def test_member_credential_change_revokes_sessions_and_audits_update(self) -> None:
        target = self.stack.user_ids["doctor2"]
        path = f"/admin/users/{quote(target)}"
        purge_user_audit(target)
        openers = []
        try:
            opener, _sid = self.bff_login("doctor2", self.stack.passwords["doctor2"])
            openers.append(opener)
            self.assertEqual(self.proxy(opener, "GET", "/api/me").status, 200)
            changed = self.stack.request("PATCH", path, "jmryu", {"roles": ["radiologist", "technician"]})
            self.assertEqual(changed.status, 200, changed.text)
            self.assertEqual(
                (changed.body["roles"], changed.body["institution"], changed.body["approvalState"], changed.body["enabled"]),
                (["radiologist", "technician"], "hallym", "APPROVED", True),
            )
            self.assertEqual(self.proxy(opener, "GET", "/api/me").status, 401, "자격 변경이 기존 세션을 끊지 않았습니다")
            self.assertEqual(self.kc_user_summary(target), (["hallym"], ["radiologist", "technician"]))
            audit = user_audit(target)
            self.assertEqual([action for action, _ in audit], ["admin.user.update"])
            self.assertEqual((audit[0][1]["before"]["roles"], audit[0][1]["after"]["roles"]), (["radiologist"], ["radiologist", "technician"]))
            opener, _sid = self.bff_login("doctor2", self.stack.passwords["doctor2"])
            openers.append(opener)
            me = self.proxy(opener, "GET", "/api/me")
            self.assertEqual(me.status, 200, me.text)
            self.assertIn("technician", me.body["roles"])

            # 정지 중 자격 변경은 정지를 유지한다 — targetEnabled는 요청이 말하지 않으면 이전 값이다
            self.assertFalse(self.stack.request("PATCH", path, "jmryu", {"enabled": False}).body["enabled"])
            suspended = self.stack.request("PATCH", path, "jmryu", {"roles": ["radiologist"]})
            self.assertEqual(suspended.status, 200, suspended.text)
            self.assertEqual((suspended.body["enabled"], suspended.body["roles"]), (False, ["radiologist"]))
            self.assertTrue(self.stack.request("PATCH", path, "jmryu", {"enabled": True}).body["enabled"])
            self.assertEqual(
                [action for action, _ in user_audit(target)],
                ["admin.user.update", "admin.user.suspend", "admin.user.update", "admin.user.activate"],
            )
        finally:
            for opener in openers:
                self.proxy(opener, "POST", "/api/auth/logout", headers={"X-KIN-CSRF": "1"})
            restored = self.stack.request("PATCH", path, "jmryu", {"roles": ["radiologist"], "enabled": True})
            self.assertEqual(restored.status, 200, restored.text)
            self.admin("PUT", f"/users/{quote(target)}", {"enabled": True})
            # 캐시된 Bearer는 서명만 검사되므로 살아 있지만 realm_access.roles가 낡았다 — 다음 사용자가 새로 받게 한다
            self.stack.tokens.pop("doctor2", None)
            self.stack.actors.pop("doctor2", None)
            purge_user_audit(target)

    def test_member_reset_password_is_admin_only_and_secret_is_never_audited(self) -> None:
        doctor2 = self.stack.user_ids["doctor2"]
        self.assertEqual(self.stack.request("POST", f"/admin/users/{quote(doctor2)}/reset-password", "doctor", {"mode": "temp"}).status, 403)
        for body in ({}, {"mode": "sms"}):
            self.assertEqual(self.stack.request("POST", f"/admin/users/{quote(doctor2)}/reset-password", "jmryu", body).status, 400, body)
        clients = self.admin("GET", "/clients?clientId=kin-api")
        service = self.admin("GET", f"/clients/{clients.body[0]['id']}/service-account-user")
        self.assertEqual(self.stack.request("POST", f"/admin/users/{quote(service.body['id'])}/reset-password", "jmryu", {"mode": "temp"}).status, 403)

        user_id = None
        try:
            user_id, username, password = self.create_member(with_group=False)
            self.assertEqual(self.password_grant_status(username, password), 200)
            reset = self.stack.request("POST", f"/admin/users/{quote(user_id)}/reset-password", "jmryu", {"mode": "temp"})
            self.assertEqual(reset.status, 200, reset.text)
            self.assertRegex(reset.body["temporaryPassword"], TEMPORARY_PASSWORD_RE)
            self.assertEqual(reset.body["approvalState"], "PENDING")
            # Keycloak은 자격 불일치를 401, 임시 비밀번호의 UPDATE_PASSWORD 필수 동작을 400으로 거절한다 — 둘 다 '옛 비밀번호로는 못 들어온다'
            self.assertIn(self.password_grant_status(username, password), (400, 401), "옛 비밀번호가 아직 통합니다")
            audit = user_audit(user_id)
            self.assertEqual([action for action, _ in audit], ["admin.user.reset-password"])
            self.assertEqual(audit[0][1]["mode"], "temp")
            self.assertNotIn(reset.body["temporaryPassword"], json.dumps(audit, ensure_ascii=False))
        finally:
            self.delete_member(user_id)

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
            "holdReason",
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

    # ── v0.6.3 회귀 확충 헬퍼 ──

    def commit(self, fixture: Fixture, user: str, action: str, base_version: Any, **extra: Any) -> HttpResult:
        """확정 한 번. 본문 기본값은 fixture.secret이라 응답·감사에 새는지 그대로 검사할 수 있다.
        omit_base=True면 baseVersion 키를 아예 보내지 않는다(null과 '없음'은 서버에서 다른 답이다)."""
        body: dict[str, Any] = {
            "action": action,
            "findings": extra.pop("findings", fixture.secret),
            "conclusion": extra.pop("conclusion", ""),
            "recommendation": extra.pop("recommendation", ""),
        }
        if not extra.pop("omit_base", False):
            body["baseVersion"] = base_version
        body.update(extra)
        return self.stack.request("POST", f"/studies/{quote(fixture.uid)}/report/commit", user, body)

    def state(self, fixture: Fixture, user: str) -> dict[str, Any] | None:
        """bootstrap이 주는 toClient 행 전체. 기관 밖이면 None."""
        result = self.stack.request("GET", "/bootstrap", user)
        self.assert_status(result, 200)
        return result.body["states"].get(fixture.uid)

    def audit_rows(self, fixture: Fixture, user: str = "jmryu") -> list[dict[str, Any]]:
        result = self.stack.request("GET", f"/audit?uid={quote(fixture.uid)}&take=500", user)
        self.assert_status(result, 200)
        return result.body

    def audit_count(self, fixture: Fixture, action: str, user: str = "jmryu") -> int:
        return len([row for row in self.audit_rows(fixture, user) if row["action"] == action])

    def backdate_hold(self, uid: str, minutes: int) -> None:
        """TTL을 기다리지 않는다. heldAt을 과거로 옮기면 holdAlive가 결정적으로 뒤집힌다."""
        self.assertRegex(uid, r"^[0-9.]+$")
        psql(f"UPDATE \"StudyState\" SET \"heldAt\" = now() - interval '{minutes} minutes' WHERE uid='{uid}';")

    def hold_row(self, uid: str) -> str:
        """DB의 holder|heldAt 원문. toClient는 만료분을 감추므로 '아무것도 안 썼다'는 여기서만 증명된다."""
        self.assertRegex(uid, r"^[0-9.]+$")
        rows = psql(
            f"SELECT coalesce(holder, '') || '|' || coalesce(\"heldAt\"::text, '') "
            f"FROM \"StudyState\" WHERE uid='{uid}';"
        )
        self.assertEqual(len(rows), 1, rows)
        return rows[0]

    @staticmethod
    def today_set() -> set[str]:
        """confirm은 서버의 UTC 날짜다. 호출 전후로 모아 자정 경계에서도 흔들리지 않게 한다."""
        return {datetime.now(timezone.utc).date().isoformat(), date.today().isoformat()}

    def prefix(self, user: str) -> str:
        return self.stack.actor(user).split("@")[0]

    # ── 판독 상태기계 W/T/P/A/H ──

    def test_rs_transition_table_walks_every_state_and_rejects_illegal_cells(self) -> None:
        """한 fixture로 상태기계를 끝까지 걷는다. 거절 칸은 상태·이력이 그대로여야 하고 허용 칸은 표대로 움직인다.
        P 칸은 작성자·지정자만 부른다 — 제3자는 canReadPrelim 403이 먼저라 400을 볼 수 없다."""
        with self.stack.fixture() as fixture:
            def rejected(user: str, action: str, base: int, fragment: str, **extra: Any) -> None:
                before = self.snapshot(fixture, "doctor")
                result = self.commit(fixture, user, action, base, **extra)
                self.assertEqual(result.status, 400, result.text)
                self.assertIn(fragment, result.body.get("message", ""), result.text)
                self.assert_snapshot_unchanged(fixture, "doctor", before)

            def accepted(user: str, action: str, base: int, rs: str, **extra: Any) -> int:
                result = self.commit(fixture, user, action, base, **extra)
                self.assert_status(result, 201)
                self.assertEqual(result.body["rs"], rs, f"{action}@v{base}: {result.text}")
                return result.body["version"]

            senior = self.stack.actor("jmryu")
            with self.subTest(cell="W×addendum"):
                rejected("doctor", "addendum", 0, "승인(RS: A)된")
            with self.subTest(cell="W×reset(사유 없음)"):
                rejected("doctor", "reset", 0, "사유")
            v = accepted("doctor", "save", 0, "T")                                    # W→T
            with self.subTest(cell="T×addendum"):
                rejected("doctor", "addendum", v, "승인(RS: A)된")
            v = accepted("doctor", "preliminary", v, "P", reviewer=senior)           # T→P
            with self.subTest(cell="P×addendum(작성자)"):
                rejected("doctor", "addendum", v, "승인(RS: A)된")
            with self.subTest(cell="P×defer(지정자)"):
                rejected("jmryu", "defer", v, "보류할 수 없습니다", reason="x")
            v = accepted("doctor", "save", v, "P")                                    # P×save는 P 유지
            v = accepted("jmryu", "approve", v, "A")                                  # P→A 지정자만
            with self.subTest(cell="A×preliminary"):
                rejected("doctor", "preliminary", v, "되돌릴 수 없습니다", reviewer=senior)
            with self.subTest(cell="A×defer"):
                rejected("doctor", "defer", v, "보류할 수 없습니다", reason="x")
            v = accepted("doctor2", "addendum", v, "A", findings="addendum")          # A→A
            v = accepted("doctor", "reset", v, "W", reason="표 검증")                  # A→W (discarded+reset)
            v = accepted("doctor", "defer", v, "H", reason="prior 없음")              # W→H
            with self.subTest(cell="H×addendum"):
                rejected("doctor", "addendum", v, "승인(RS: A)된")
            v = accepted("doctor2", "defer", v, "H", reason="영상 불량")              # H→H 사유 갱신
            self.assertEqual(self.report_state(fixture, "doctor")["holdReason"], "영상 불량")
            v = accepted("doctor", "save", v, "T")                                    # H→T
            self.assertIsNone(self.report_state(fixture, "doctor")["holdReason"])
            v = accepted("doctor", "defer", v, "H", reason="재촬영 필요")             # T→H
            v = accepted("doctor2", "preliminary", v, "P", reviewer=self.stack.actor("doctor"))   # H→P
            v = accepted("doctor", "reset", v, "W", reason="표 검증")                  # P→W 지정자의 사유 있는 취소
            v = accepted("doctor", "defer", v, "H", reason="임상정보 부족")           # W→H
            v = accepted("doctor", "approve", v, "A")                                 # H→A
            self.assertEqual([row["version"] for row in self.versions(fixture, "doctor")], list(range(1, v + 1)))

    def test_approve_addendum_reset_move_repdoc_confirm_and_designation_together(self) -> None:
        with self.stack.fixture() as fixture:
            prelim = self.preliminary(fixture, author="doctor", reviewer="jmryu")
            state = self.report_state(fixture, "doctor")
            self.assertEqual(
                (state["preDoc"], state["preReviewer"], state["repDoc"], state["confirm"]),
                (self.stack.actor("doctor"), self.stack.actor("jmryu"), None, None),
            )
            days = self.today_set()
            approved = self.commit(fixture, "jmryu", "approve", prelim.body["version"])
            days |= self.today_set()
            self.assert_status(approved, 201)
            self.assertEqual(approved.body["rs"], "A")
            self.assertEqual(approved.body["repDoc"], self.prefix("jmryu"))
            self.assertIn(approved.body["confirm"], days)
            self.assertIsNone(approved.body["holder"])

            # addendum도 승인의 한 종류다 — 추가기재자가 승인자 자리에 기록된다(코드 계약).
            added = self.commit(fixture, "doctor2", "addendum", approved.body["version"], findings="addendum")
            days |= self.today_set()
            self.assert_status(added, 201)
            self.assertEqual(added.body["rs"], "A")
            self.assertEqual(added.body["version"], approved.body["version"] + 1)
            self.assertEqual(added.body["repDoc"], self.prefix("doctor2"))
            self.assertIn(added.body["confirm"], days)

            reset = self.commit(fixture, "doctor", "reset", added.body["version"], reason="정정 필요")
            self.assert_status(reset, 201)
            self.assertEqual(reset.body["rs"], "W")
            for key in ("repDoc", "confirm", "preDoc", "preReviewer", "holdReason", "holder"):
                self.assertIsNone(reset.body[key], key)
            self.assertEqual(reset.body["findings"], "")

    def test_commit_rejects_missing_or_stale_base_version_and_keeps_hold(self) -> None:
        with self.stack.fixture() as fixture:
            path = f"/studies/{quote(fixture.uid)}"
            self.assert_status(self.stack.request("POST", path + "/hold", "doctor"), 201)
            before = self.snapshot(fixture, "doctor")
            missing = self.commit(fixture, "doctor", "save", 0, omit_base=True)
            self.assert_status(missing, 400)
            self.assertIn("baseVersion", missing.body["message"])
            # null·문자열·낡은 값은 '없음'이 아니라 '틀림'이다 — 낙관적 락이 409로 잡는다.
            for label, base in (("null", None), ("string", "0"), ("stale", 7)):
                with self.subTest(base=label):
                    result = self.commit(fixture, "doctor", "save", base)
                    self.assert_status(result, 409)
                    self.assertIn("저장했습니다", result.body["message"])
            with self.subTest(case="addendum-on-W"):
                self.assert_status(self.commit(fixture, "doctor", "addendum", 0), 400)
            with self.subTest(case="reset-without-reason"):
                self.assert_status(self.commit(fixture, "doctor", "reset", 0), 400)
            self.assert_snapshot_unchanged(fixture, "doctor", before)
            self.assertEqual(self.versions(fixture, "doctor"), [])

            # 거절된 확정은 점유를 풀지 않는다 — holder:null은 성공한 트랜잭션 안에서만 쓰인다.
            blocked = self.stack.request("PUT", path + "/report", "doctor2", {"findings": "x"})
            self.assert_status(blocked, 409)
            self.assertEqual(blocked.body.get("code"), "REPORT_HELD")
            self.assertEqual(blocked.body.get("holder"), self.stack.actor("doctor"))
            conflict = self.stack.request("POST", path + "/hold", "doctor2")
            self.assertEqual(conflict.body, {"holder": self.stack.actor("doctor"), "mine": False, "conflict": True})
            self.assertEqual(self.audit_count(fixture, "report.hold"), 1)

            saved = self.commit(fixture, "doctor", "save", 0)
            self.assert_status(saved, 201)
            self.assertEqual((saved.body["version"], saved.body["holder"]), (1, None))

    def test_version_history_is_contiguous_and_append_only_through_lifecycle(self) -> None:
        with self.stack.fixture() as fixture:
            doctor, doctor2 = self.stack.actor("doctor"), self.stack.actor("doctor2")
            first_save = self.commit(fixture, "doctor", "save", 0, findings="first")
            self.assert_status(first_save, 201)
            self.assertEqual(first_save.body["version"], 1)
            self.assert_status(self.commit(fixture, "doctor", "approve", 1), 201)
            added = self.commit(fixture, "doctor2", "addendum", 2, findings="addendum text")
            self.assert_status(added, 201)
            self.assertEqual(added.body["version"], 3)
            first_three = self.versions(fixture, "doctor")
            self.assertEqual([row["version"] for row in first_three], [1, 2, 3])

            reset = self.commit(fixture, "doctor", "reset", 3, reason="lifecycle")
            self.assert_status(reset, 201)
            self.assertEqual((reset.body["version"], reset.body["rs"]), (5, "W"))   # discarded 4 + reset 5
            again = self.commit(fixture, "doctor", "save", 5, findings="again")
            self.assert_status(again, 201)
            self.assertEqual(again.body["version"], 6)

            rows = self.versions(fixture, "doctor")
            self.assertEqual([row["version"] for row in rows], list(range(1, 7)))
            self.assertEqual(
                [row["action"] for row in rows],
                ["save", "approve", "addendum", "discarded", "reset", "save"],
            )
            # discarded의 저자는 지운 사람이 아니라 마지막으로 그 내용을 저장한 사람이다.
            self.assertEqual([row["author"] for row in rows], [doctor, doctor, doctor2, doctor2, doctor, doctor])
            discarded, reset_row = rows[3], rows[4]
            self.assertEqual(discarded["findings"], "addendum text")
            self.assertTrue(str(discarded["reason"]).startswith("판독 취소로 폐기"), discarded)
            self.assertIn(doctor, str(discarded["reason"]))
            self.assertEqual((reset_row["reason"], reset_row["findings"]), ("lifecycle", ""))
            by_id = {row["id"]: row for row in rows}
            for row in first_three:
                self.assertEqual(by_id[row["id"]], row, "앞선 판이 뒤의 확정으로 바뀌었습니다")
            state = self.report_state(fixture, "doctor")
            self.assertEqual((state["version"], state["findings"], state["rs"]), (6, "again", "T"))

    def test_third_radiologist_cannot_touch_preliminary_with_any_action(self) -> None:
        with self.stack.fixture() as fixture:
            self.preliminary(fixture, author="doctor", reviewer="jmryu")
            before = self.snapshot(fixture, "doctor")
            for action in ("approve", "addendum", "reset", "defer", "preliminary", "save"):
                for user, status in (("doctor2", 403), ("tech", 403), ("kdoctor", 404)):
                    with self.subTest(action=action, user=user):
                        result = self.commit(
                            fixture, user, action, 1,
                            reason="x", reviewer=self.stack.actor("doctor"), findings="leak",
                        )
                        self.assertEqual(result.status, status, result.text)
                        self.assertFalse(result.contains(fixture.secret), "거절 응답에 예비 판독 본문이 노출됐습니다")
                        if user == "doctor2":
                            self.assertIn("예비 판독(RS: P) 중입니다", result.body["message"])
            self.assert_snapshot_unchanged(fixture, "doctor", before)
            self.assertEqual(len(self.versions(fixture, "doctor")), 1)
            report_actions = [row["action"] for row in self.audit_rows(fixture) if row["action"].startswith("report.")]
            self.assertEqual(report_actions, ["report.preliminary"])
            hidden = self.state(fixture, "doctor2")
            self.assertEqual((hidden["prelimHidden"], hidden["findings"]), (True, ""))
            shown = self.state(fixture, "doctor")
            self.assertEqual((shown["prelimHidden"], shown["findings"]), (False, fixture.secret))

    def test_preliminary_reviewer_must_be_a_same_institution_radiologist(self) -> None:
        with self.stack.fixture() as fixture:
            path = f"/studies/{quote(fixture.uid)}"
            self.assert_status(self.stack.request("PUT", path + "/report", "doctor", {"findings": "draft"}), 200)
            cases = [
                ({"reviewer": self.stack.actor("tech")}, "이 기관의 판독의가 아닙니다"),
                ({"reviewer": self.stack.actor("kdoctor")}, "이 기관의 판독의가 아닙니다"),
                ({"reviewer": "nobody@local.test"}, "이 기관의 판독의가 아닙니다"),
                ({"reviewer": self.stack.actor("doctor")}, "자기 자신"),
                ({"reviewer": ""}, "상급 판독의를 지정"),
                ({}, "상급 판독의를 지정"),
            ]
            for extra, fragment in cases:
                with self.subTest(reviewer=extra.get("reviewer", "<absent>")):
                    result = self.commit(fixture, "doctor", "preliminary", 0, **extra)
                    self.assert_status(result, 400)
                    self.assertIn(fragment, result.body["message"])
                    state = self.report_state(fixture, "doctor")
                    self.assertEqual((state["rs"], state["version"], state["preDoc"], state["preReviewer"]), ("W", 0, None, None))
                    self.assertEqual(self.versions(fixture, "doctor"), [])
                    self.assertEqual(self.state(fixture, "doctor")["draft"]["findings"], "draft")
            ok = self.commit(fixture, "doctor", "preliminary", 0, reviewer=self.stack.actor("doctor2"))
            self.assert_status(ok, 201)
            self.assertEqual((ok.body["rs"], ok.body["preDoc"], ok.body["preReviewer"], ok.body["draft"]),
                             ("P", self.stack.actor("doctor"), self.stack.actor("doctor2"), None))

        # 원격판독 수신 판독의는 검사 소유 기관이 아니라 **자기 기관** 명단으로 검증된다.
        with self.stack.fixture() as tele:
            opened = self.stack.request(
                "PATCH", f"/studies/{quote(tele.uid)}", "doctor", {"ts": "wait", "teleTo": "kin-center"},
            )
            self.assert_status(opened, 200)
            foreign = self.commit(tele, "kdoctor", "preliminary", 0, reviewer=self.stack.actor("doctor2"))
            self.assert_status(foreign, 400)
            self.assertIn("이 기관의 판독의가 아닙니다", foreign.body["message"])
            self.assert_status(self.commit(tele, "kdoctor", "preliminary", 0, reviewer=self.stack.actor("kdoctor")), 400)

    def test_accepted_draft_never_changes_report_in_any_rs(self) -> None:
        with self.stack.fixture() as fixture:   # A
            self.approve(fixture)
            path = f"/studies/{quote(fixture.uid)}"
            before = self.snapshot(fixture, "doctor")
            other = self.stack.request("PUT", path + "/report", "doctor2", {"findings": "draft-on-A", "baseVersion": 1})
            self.assert_status(other, 200)
            self.assertEqual(other.body["author"], self.stack.actor("doctor2"))
            self.assert_snapshot_unchanged(fixture, "doctor", before)
            seen = self.state(fixture, "doctor2")
            self.assertEqual((seen["findings"], seen["version"], seen["rs"]), (fixture.secret, 1, "A"))
            self.assertEqual(seen["draft"]["findings"], "draft-on-A")
            self.assertIsNone(self.state(fixture, "doctor")["draft"], "남의 초안이 실려 나갔습니다")
            self.assert_status(self.stack.request("PUT", path + "/report", "doctor", {"findings": "doctor-draft", "baseVersion": 1}), 200)
            self.assert_status(self.commit(fixture, "doctor2", "addendum", 1, findings="add"), 201)
            self.assertEqual(self.state(fixture, "doctor")["draft"]["findings"], "doctor-draft", "확정이 남의 초안을 지웠습니다")
            self.assertIsNone(self.state(fixture, "doctor2")["draft"])
        with self.stack.fixture() as deferred:   # H
            self.assert_status(self.commit(deferred, "doctor", "defer", 0, reason="r"), 201)
            self.assert_status(self.stack.request("PUT", f"/studies/{quote(deferred.uid)}/report", "doctor2", {"findings": "x"}), 200)
            state = self.report_state(deferred, "doctor")
            self.assertEqual((state["rs"], state["holdReason"], state["version"]), ("H", "r", 1))
        with self.stack.fixture() as prelim:   # P
            self.preliminary(prelim, author="doctor", reviewer="jmryu")
            path = f"/studies/{quote(prelim.uid)}/report"
            self.assert_status(self.stack.request("PUT", path, "doctor", {"findings": "p-draft"}), 200)
            self.assert_status(self.stack.request("PUT", path, "jmryu", {"findings": "r-draft"}), 200)
            self.assert_status(self.stack.request("PUT", path, "doctor2", {"findings": "leak"}), 403)
            state = self.report_state(prelim, "doctor")
            self.assertEqual((state["rs"], state["findings"], state["version"]), ("P", prelim.secret, 1))
        with self.stack.fixture() as waiting:   # W — Report 행이 아예 없다
            self.assert_status(self.stack.request("PUT", f"/studies/{quote(waiting.uid)}/report", "doctor", {"findings": "w"}), 200)
            state = self.report_state(waiting, "doctor")
            self.assertEqual((state["rs"], state["version"]), ("W", 0))
            self.assertEqual(self.versions(waiting, "doctor"), [])

    # ── 점유 ──

    def test_hold_expires_after_ttl_and_expired_holder_cannot_block(self) -> None:
        with self.stack.fixture() as fixture:
            path = f"/studies/{quote(fixture.uid)}"
            self.assert_status(self.stack.request("POST", path + "/hold", "doctor"), 201)
            self.backdate_hold(fixture.uid, 6)
            self.assertIsNone(self.state(fixture, "doctor2")["holder"], "만료된 점유가 화면에 자물쇠로 나갑니다")
            self.assert_status(self.stack.request("PUT", path + "/report", "doctor2", {"findings": "x"}), 200)
            taken = self.stack.request("POST", path + "/hold", "doctor2")
            self.assertEqual(taken.body, {"holder": self.stack.actor("doctor2"), "mine": True, "conflict": False})
            self.assertEqual(self.audit_count(fixture, "report.hold"), 2, "만료 뒤 재점유는 새 점유 세션이다")
            blocked = self.stack.request("PUT", path + "/report", "doctor", {"findings": "late"})
            self.assert_status(blocked, 409)
            self.assertEqual(blocked.body.get("holder"), self.stack.actor("doctor2"))
            stale = self.stack.request("POST", path + "/hold", "doctor")
            self.assertEqual(stale.body, {"holder": self.stack.actor("doctor2"), "mine": False, "conflict": True})

    def test_hold_release_clears_only_own_and_each_reacquisition_is_audited_once(self) -> None:
        with self.stack.fixture() as fixture:
            path = f"/studies/{quote(fixture.uid)}"
            for _ in range(2):   # 두 번째는 하트비트
                self.assert_status(self.stack.request("POST", path + "/hold", "doctor"), 201)
            self.assertEqual(self.audit_count(fixture, "report.hold"), 1)
            noop = self.stack.request("POST", path + "/release", "doctor2")
            self.assert_status(noop, 201)
            self.assertEqual(noop.body, {"ok": True})
            self.assertEqual(self.state(fixture, "doctor2")["holder"], self.stack.actor("doctor"), "남의 release가 점유를 풀었습니다")
            self.assert_status(self.stack.request("POST", path + "/release", "doctor"), 201)
            self.assertIsNone(self.state(fixture, "doctor")["holder"])
            self.assert_status(self.stack.request("POST", path + "/hold", "doctor"), 201)
            self.assertEqual(self.audit_count(fixture, "report.hold"), 2)
            saved = self.commit(fixture, "doctor", "save", 0)
            self.assert_status(saved, 201)
            self.assertIsNone(saved.body["holder"], "확정이 점유를 풀지 않았습니다")
            taken = self.stack.request("POST", path + "/hold", "doctor2")
            self.assertEqual(taken.body["mine"], True)
            self.assert_status(self.stack.request("POST", path + "/hold", "doctor2"), 201)
            self.assertEqual(self.audit_count(fixture, "report.hold"), 3)

    def test_hold_conflict_is_inert_no_steal_no_refresh_no_audit(self) -> None:
        with self.stack.fixture() as fixture:
            path = f"/studies/{quote(fixture.uid)}"
            self.assert_status(self.stack.request("POST", path + "/hold", "doctor"), 201)
            self.backdate_hold(fixture.uid, 2)   # 아직 살아 있지만, 갱신되면 값이 달라져 보인다
            before_row = self.hold_row(fixture.uid)
            self.assertTrue(before_row.startswith(self.stack.actor("doctor") + "|"), before_row)
            conflict = self.stack.request("POST", path + "/hold", "doctor2")
            self.assertEqual(conflict.body, {"holder": self.stack.actor("doctor"), "mine": False, "conflict": True})
            self.assertEqual(self.hold_row(fixture.uid), before_row, "남의 점유에 대한 hold가 DB를 건드렸습니다")
            holds = [row for row in self.audit_rows(fixture) if row["action"] == "report.hold"]
            self.assertEqual([row["actor"] for row in holds], [self.stack.actor("doctor")])
            self.assert_status(self.stack.request("PUT", path + "/report", "doctor2", {"findings": "y"}), 409)
            mine = self.stack.request("POST", path + "/hold", "doctor")
            self.assertEqual(mine.body["mine"], True)
            after_row = self.hold_row(fixture.uid)
            self.assertNotEqual(after_row, before_row, "주인의 하트비트가 heldAt을 갱신하지 않았습니다")
            self.assertTrue(after_row.startswith(self.stack.actor("doctor") + "|"))
            self.assertEqual(self.audit_count(fixture, "report.hold"), 1)

    def test_hold_is_visible_and_enforced_across_tele_boundary_both_ways(self) -> None:
        with self.stack.fixture() as fixture:
            path = f"/studies/{quote(fixture.uid)}"
            doctor, kdoctor = self.stack.actor("doctor"), self.stack.actor("kdoctor")
            self.assert_status(self.stack.request("POST", path + "/hold", "doctor"), 201)
            self.assert_status(self.stack.request("PATCH", path, "doctor", {"ts": "wait", "teleTo": "kin-center"}), 200)
            seen = self.state(fixture, "kdoctor")
            self.assertEqual((seen["holder"], seen["teleInstitutionId"]), (doctor, "kin-center"))
            listed = self.stack.request("GET", "/studies", "kdoctor")
            row = next(item for item in listed.body["studies"] if item["uid"] == fixture.uid)
            self.assertEqual((row["tele"], row["state"]["holder"]), (True, doctor))
            blocked = self.stack.request("PUT", path + "/report", "kdoctor", {"findings": "x"})
            self.assert_status(blocked, 409)
            self.assertEqual((blocked.body.get("code"), blocked.body.get("holder")), ("REPORT_HELD", doctor))
            self.assertEqual(self.stack.request("POST", path + "/hold", "kdoctor").body["conflict"], True)

            self.assert_status(self.stack.request("POST", path + "/release", "doctor"), 201)
            self.assertEqual(self.stack.request("POST", path + "/hold", "kdoctor").body["mine"], True)
            self.assertEqual(self.state(fixture, "doctor")["holder"], kdoctor)
            listed = self.stack.request("GET", "/studies", "doctor")
            row = next(item for item in listed.body["studies"] if item["uid"] == fixture.uid)
            self.assertEqual((row["tele"], row["state"]["holder"]), (False, kdoctor))
            blocked = self.stack.request("PUT", path + "/report", "doctor", {"findings": "x"})
            self.assert_status(blocked, 409)
            self.assertEqual(blocked.body.get("holder"), kdoctor)
            self.assertEqual(self.state(fixture, "ktech")["holder"], kdoctor)   # holder는 읽기 필드, 역할 관문 없음
            self.assert_status(self.stack.request("POST", path + "/hold", "ktech"), 403)

            forced = self.stack.request("POST", path + "/release/force", "jmryu")
            self.assert_status(forced, 200)
            self.assertEqual(forced.body["released"], kdoctor)
            self.assert_status(self.stack.request("PUT", path + "/report", "doctor", {"findings": "x"}), 200)

    def test_hold_requires_radiologist_and_prelim_access(self) -> None:
        with self.stack.fixture() as fixture:
            path = f"/studies/{quote(fixture.uid)}"
            self.assert_status(self.stack.request("POST", path + "/hold", "tech"), 403)
            self.preliminary(fixture, author="doctor", reviewer="jmryu")
            self.assert_status(self.stack.request("POST", path + "/hold", "doctor2"), 403)
            self.assertEqual(self.stack.request("POST", path + "/hold", "jmryu").body["mine"], True)

    # ── 교차: 원격판독 상태머신 · 감사 · PATCH 우회 · 잔여 역할/기관 관문 ──

    def test_tele_state_machine_gates_sides_rs_and_cancel_closes_channel(self) -> None:
        with self.stack.fixture() as f1:
            path = f"/studies/{quote(f1.uid)}"

            def patch(user: str, body: dict[str, Any]) -> HttpResult:
                return self.stack.request("PATCH", path, user, body)

            self.assert_status(patch("tech", {"ts": "wait", "teleTo": "kin-center"}), 403)
            for body, fragment in (
                ({"ts": "sent", "teleTo": "kin-center"}, "허용되지 않는 TS 전이"),
                ({"ts": "wait"}, "teleTo"),
                ({"ts": "wait", "teleTo": "hallym"}, "자기 기관"),
                ({"ts": "wait", "teleTo": "nowhere"}, "알 수 없는 기관"),
            ):
                with self.subTest(body=body):
                    result = patch("doctor", body)
                    self.assert_status(result, 400)
                    self.assertIn(fragment, result.body["message"])
            opened = patch("doctor", {"ts": "wait", "teleTo": "kin-center"})
            self.assert_status(opened, 200)
            self.assertEqual((opened.body["ts"], opened.body["teleInstitutionId"]), ("wait", "kin-center"))
            listed = self.stack.request("GET", "/studies", "kdoctor")
            self.assertTrue(next(item for item in listed.body["studies"] if item["uid"] == f1.uid)["tele"])
            self.assert_status(patch("kdoctor", {"ts": "sending"}), 403)      # 의뢰 구간은 소유 기관만
            self.assert_status(patch("kdoctor", {"ts": "inReading"}), 400)    # wait에서 건너뛰기 불가
            saved = self.commit(f1, "kdoctor", "save", 0, findings="kin")
            self.assert_status(saved, 201)
            resend = patch("doctor", {"ts": "sending"})
            self.assert_status(resend, 400)
            self.assertIn("(현재 RS: T)", resend.body["message"])
            closed = patch("doctor", {"ts": "cancelled"})
            self.assert_status(closed, 200)
            self.assertEqual((closed.body["ts"], closed.body["teleInstitutionId"]), ("cancelled", None))
            # 통로가 닫히면 수신 기관은 아무것도 못 본다
            self.assert_status(self.stack.request("POST", path + "/hold", "kdoctor"), 404)
            self.assert_status(self.stack.request("GET", path + "/report/versions", "kdoctor"), 404)
            self.assertIsNone(self.state(f1, "kdoctor"))
            self.assertEqual(self.stack.dicom_request(f"/dicom-web/studies/{quote(f1.uid)}/metadata", "kdoctor").status, 403)
            self.assert_status(patch("doctor", {"ts": "wait"}), 400)
            details = [json.loads(row["detail"]) for row in self.audit_rows(f1) if row["action"] == "state.patch"]
            self.assertIn({"ts": "wait", "teleInstitutionId": "kin-center", "by": "hallym"}, details)
            self.assertIn({"ts": "cancelled", "teleInstitutionId": None, "by": "hallym"}, details)

        with self.stack.fixture() as f2:
            path = f"/studies/{quote(f2.uid)}"
            for ts in ("wait", "sending", "sent"):
                body = {"ts": ts, **({"teleTo": "kin-center"} if ts == "wait" else {})}
                self.assert_status(self.stack.request("PATCH", path, "doctor", body), 200)
            self.assert_status(self.stack.request("PATCH", path, "doctor", {"ts": "inReading"}), 403)   # 수신 구간은 수신 기관만
            self.assert_status(self.stack.request("PATCH", path, "kdoctor", {"ts": "inReading"}), 200)
            approved = self.commit(f2, "kdoctor", "approve", 0, findings="x")
            self.assert_status(approved, 201)
            self.assertEqual((approved.body["rs"], approved.body["ts"], approved.body["repDoc"]), ("A", "completed", self.prefix("kdoctor")))
            added = self.commit(f2, "kdoctor", "addendum", 1, findings="add")
            self.assert_status(added, 201)
            self.assertEqual(added.body["ts"], "completed")
            self.assert_status(self.stack.request("PATCH", path, "doctor", {"ts": "cancelled"}), 400)
            seen = self.state(f2, "doctor2")
            self.assertEqual((seen["rs"], seen["ts"], seen["findings"], seen["prelimHidden"]), ("A", "completed", "add", False))

        with self.stack.fixture() as f3:   # 대조: 소유 기관 스스로 승인하면 completed가 아니다
            self.assert_status(self.stack.request("PATCH", f"/studies/{quote(f3.uid)}", "doctor", {"ts": "wait", "teleTo": "kin-center"}), 200)
            owner = self.commit(f3, "doctor", "approve", 0)
            self.assert_status(owner, 201)
            self.assertEqual((owner.body["rs"], owner.body["ts"]), ("A", "wait"))

    def test_audit_action_matrix_for_report_routes_is_complete_and_phi_free(self) -> None:
        with self.stack.fixture() as fixture:
            path = f"/studies/{quote(fixture.uid)}"
            count = lambda action: self.audit_count(fixture, action)   # noqa: E731

            drafted = self.stack.request("PUT", path + "/report", "doctor", {"findings": fixture.secret, "conclusion": "c"})
            self.assert_status(drafted, 200)
            self.assertEqual(count("report.draft"), 1)
            draft_row = next(row for row in self.audit_rows(fixture) if row["action"] == "report.draft")
            self.assertEqual(json.loads(draft_row["detail"]), {"len": [len(fixture.secret), 1, 0]})
            self.assert_status(self.stack.request("PUT", path + "/report", "doctor", {}), 200)
            self.assertEqual(count("report.draft.clear"), 1)
            self.assert_status(self.stack.request("DELETE", path + "/draft", "doctor"), 200)
            self.assertEqual(count("report.draft.discard"), 0, "지운 초안이 없는데 폐기 감사가 남았습니다")
            self.assert_status(self.stack.request("PUT", path + "/report", "doctor", {"findings": "x"}), 200)
            self.assert_status(self.stack.request("DELETE", path + "/draft", "doctor"), 200)
            self.assertEqual(count("report.draft.discard"), 1)
            forced = self.stack.request("DELETE", path + "/draft/force", "jmryu")
            self.assert_status(forced, 200)
            self.assertEqual(forced.body["count"], 0)
            self.assertEqual(count("report.draft.force-discard"), 1)
            self.assert_status(self.stack.request("POST", path + "/hold", "doctor"), 201)
            self.assert_status(self.stack.request("POST", path + "/release", "doctor"), 201)
            self.assertEqual(count("report.hold"), 1)

            v = self.commit(fixture, "doctor", "save", 0).body["version"]
            v = self.commit(fixture, "doctor", "preliminary", v, reviewer=self.stack.actor("jmryu")).body["version"]
            v = self.commit(fixture, "jmryu", "approve", v).body["version"]
            v = self.commit(fixture, "doctor", "addendum", v, findings=fixture.secret + " add").body["version"]
            v = self.commit(fixture, "doctor", "reset", v, reason="r").body["version"]
            v = self.commit(fixture, "doctor", "defer", v, reason="d").body["version"]
            self.assertEqual(v, 7)   # save1 prelim2 approve3 addendum4 discarded5 reset6 defer7
            actions = ("save", "preliminary", "approve", "addendum", "reset", "defer")
            rows = self.audit_rows(fixture)
            for action in actions:
                self.assertEqual(count(f"report.{action}"), 1, action)
            details = {row["action"]: json.loads(row["detail"]) for row in rows if row["action"] in {f"report.{a}" for a in actions}}
            self.assertEqual(details["report.preliminary"]["reviewer"], self.stack.actor("jmryu"))
            self.assertEqual(details["report.reset"]["reason"], "r")
            self.assertEqual(details["report.defer"]["reason"], "d")
            for action, detail in details.items():
                self.assertEqual(detail["by"], "hallym", action)
                self.assertEqual(len(detail["len"]), 3, action)
                self.assertTrue(all(isinstance(n, int) for n in detail["len"]), action)
            self.assertNotIn(fixture.secret, json.dumps(rows, ensure_ascii=False), "감사로그에 판독문 본문이 들어갔습니다")

            forced = self.stack.request("POST", path + "/release/force", "jmryu")
            self.assert_status(forced, 200)
            self.assertEqual(count("hold.force-release"), 1)
            force_detail = json.loads(next(row for row in self.audit_rows(fixture) if row["action"] == "hold.force-release")["detail"])
            self.assertEqual((force_detail["holder"], force_detail["alive"]), (None, None))
            self.assert_status(self.stack.request("PATCH", path, "tech", {"ss": "Unverified"}), 200)
            self.assertEqual(count("state.patch"), 2)   # fixture Verify + 이번

            rows = self.audit_rows(fixture)
            self.assertNotIn("unknown", {row["actor"] for row in rows})
            expected = {
                "state.patch", "report.draft", "report.draft.clear", "report.draft.discard",
                "report.draft.force-discard", "report.hold", "hold.force-release",
                *(f"report.{a}" for a in actions),
            }
            self.assertTrue(expected <= {row["action"] for row in rows}, expected - {row["action"] for row in rows})

    def test_patch_bypass_matrix_rejects_owned_fields_and_post_w_patient_edits(self) -> None:
        owned = [
            {"repDoc": "x"}, {"confirm": "2020-01-01"}, {"matched": "M"}, {"orig": {}},
            {"repDoc": None}, {"rs": "W", "ss": "Verified"}, {"holdReason": "h"},
        ]
        with self.stack.fixture() as fixture:
            path = f"/studies/{quote(fixture.uid)}"
            movers = (
                ("W", None),
                ("T", lambda: self.commit(fixture, "doctor", "save", 0)),
                ("H", lambda: self.commit(fixture, "doctor", "defer", 1, reason="h")),
                ("A", lambda: self.commit(fixture, "doctor", "approve", 2)),
            )
            for label, mover in movers:
                if mover:
                    self.assert_status(mover(), 201)
                before = self.snapshot(fixture, "doctor")
                for body in owned:
                    with self.subTest(state=label, body=body):
                        result = self.stack.request("PATCH", path, "jmryu", body)
                        self.assert_status(result, 400)
                        self.assertIn("전용 경로", result.body["message"])
                self.assert_snapshot_unchanged(fixture, "doctor", before)
                if label != "W":
                    with self.subTest(state=label, body="ov"):
                        result = self.stack.request("PATCH", path, "tech", {"ov": {"name": "X"}})
                        self.assert_status(result, 400)
                        self.assertIn("판독 전(RS: W)", result.body["message"])
                        # 같은 요청에 실린 다른 필드도 함께 거절된다 — 부분 적용은 없다
                        self.assert_status(self.stack.request("PATCH", path, "tech", {"ss": "Unverified", "ov": {"name": "X"}}), 400)
                        self.assertEqual(self.state(fixture, "doctor")["ss"], "Verified")
            # 목록 밖 키는 소리 없이 무시된다 — 상태·경계 필드는 PATCH가 만질 수 없다
            ignored = self.stack.request("PATCH", path, "jmryu", {
                "ss": "Verified", "preReviewer": self.stack.actor("doctor2"), "holder": self.stack.actor("doctor2"),
                "heldAt": "2020-01-01", "teleInstitutionId": "kin-center", "institutionId": "kin-center", "version": 99,
            })
            self.assert_status(ignored, 200)
            self.assertEqual(
                (ignored.body["preReviewer"], ignored.body["holder"], ignored.body["teleInstitutionId"],
                 ignored.body["institutionId"], ignored.body["version"]),
                (None, None, None, "hallym", 3),
            )
            self.assertIsNone(self.state(fixture, "kdoctor"))
            orders = self.stack.request("GET", "/bootstrap", "jmryu").body["orders"]
            oid = next(order["oid"] for order in orders if order["matched"] == "U")
            matched = self.stack.request("POST", "/match", "tech", {"uid": fixture.uid, "oid": oid, "patient": {}})
            self.assert_status(matched, 400)
            self.assertIn("(현재 RS: A)", matched.body["message"])
            orders = self.stack.request("GET", "/bootstrap", "jmryu").body["orders"]
            self.assertEqual(next(order for order in orders if order["oid"] == oid)["matched"], "U")

        with self.stack.fixture() as prelim:
            self.preliminary(prelim, author="doctor", reviewer="jmryu")
            path = f"/studies/{quote(prelim.uid)}"
            for user in ("jmryu", "doctor2"):
                result = self.stack.request("PATCH", path, user, {"repDoc": "x"})
                self.assert_status(result, 400)
                self.assertIn("전용 경로", result.body["message"])
                self.assertFalse(result.contains(prelim.secret))
            verify = self.stack.request("PATCH", path, "tech", {"ss": "Verified"})
            self.assert_status(verify, 403)
            self.assertIn("예비 판독(RS: P)", verify.body["message"])

        with self.stack.fixture() as matched_study:
            orders = self.stack.request("GET", "/bootstrap", "jmryu").body["orders"]
            oid = next(order["oid"] for order in orders if order["matched"] == "U")
            done = self.stack.request("POST", "/match", "tech", {"uid": matched_study.uid, "oid": oid, "patient": {}})
            self.assert_status(done, 201)
            self.assertEqual(done.body["matched"], "M")
            self.assert_status(self.commit(matched_study, "doctor", "save", 0), 201)
            undone = self.stack.request("POST", "/unmatch", "tech", {"uid": matched_study.uid})
            self.assert_status(undone, 400)
            self.assertIn("판독 전(RS: W)", undone.body["message"])
            order = next(o for o in self.stack.request("GET", "/bootstrap", "jmryu").body["orders"] if o["oid"] == oid)
            self.assertEqual((order["matched"], order["studyUid"]), ("M", matched_study.uid))

    def test_role_and_tenant_residue_routes_reject_wrong_caller(self) -> None:
        with self.stack.fixture() as fixture, self.stack.fixture() as other:
            path = f"/studies/{quote(fixture.uid)}"
            instance_id = self.stack.first_instance_id(fixture.uid)
            tags = self.stack._orthanc_request("GET", f"/instances/{quote(instance_id)}/tags?simplify")
            self.assertEqual(tags.status, 200, tags.text)
            sop = tags.body["SOPInstanceUID"]
            lookup = lambda user, study, sop_uid: self.stack.request(   # noqa: E731
                "POST", "/dicom/lookup", user, {"studyUid": study, "sopUid": sop_uid})
            found = lookup("doctor", fixture.uid, sop)
            self.assert_status(found, 200)
            self.assertEqual(found.body, {"id": instance_id})
            self.assert_status(lookup("kdoctor", fixture.uid, sop), 403)
            self.assert_status(lookup("doctor", other.uid, sop), 403)   # 다른 검사 UID로는 같은 인스턴스를 못 꺼낸다
            self.assert_status(lookup("doctor", fixture.uid, "abc"), 400)
            self.assert_status(self.stack.request("PATCH", path, "doctor", {"ts": "wait", "teleTo": "kin-center"}), 200)
            self.assert_status(lookup("kdoctor", fixture.uid, sop), 200)

            # 기사·관리자 전용 경로를 순수 판독의가 부르면 403 — need()가 불변조건 5의 유일한 장치다
            before = self.snapshot(fixture, "doctor")
            for method, suffix, body, role in (
                ("PATCH", path, {"ss": "Verified"}, "technician"),
                ("POST", "/match", {"uid": fixture.uid, "oid": "x", "patient": {}}, "technician"),
                ("POST", "/unmatch", {"uid": fixture.uid}, "technician"),
                ("DELETE", path, None, "technician"),
                ("DELETE", path + "/draft/force", None, "admin"),
                ("GET", "/unassigned", None, "admin"),
                ("POST", path + "/assign", {"institutionId": "hallym"}, "admin"),
            ):
                with self.subTest(route=(method, suffix)):
                    result = self.stack.request(method, suffix, "doctor", body)
                    self.assert_status(result, 403)
                    self.assertIn(f"{role} 권한", result.body["message"])
            self.assert_status(self.stack.request("POST", "/templates", "tech", {"title": "x"}), 403)
            self.assert_status(self.stack.request("DELETE", "/templates/1", "tech"), 403)
            self.assert_snapshot_unchanged(fixture, "doctor", before)

            # 남의 기관 오더는 우리 검사에 붙지 않고, 수신 기관은 받은 검사를 매칭하지 못한다
            korders = self.stack.request("GET", "/bootstrap", "kdoctor").body["orders"]
            koid = next((order["oid"] for order in korders if order["matched"] == "U"), None)
            self.assertIsNotNone(koid, "kin-center 시드 오더가 없습니다")
            foreign = self.stack.request("POST", "/match", "tech", {"uid": fixture.uid, "oid": koid, "patient": {}})
            self.assert_status(foreign, 400)
            self.assertIn("오더를 찾을 수 없습니다", foreign.body["message"])
            receiver = self.stack.request("POST", "/match", "ktech", {"uid": fixture.uid, "oid": koid, "patient": {}})
            self.assert_status(receiver, 403)
            self.assertIn("보유 기관", receiver.body["message"])
            korders = self.stack.request("GET", "/bootstrap", "kdoctor").body["orders"]
            self.assertEqual(next(order for order in korders if order["oid"] == koid)["matched"], "U")

    def test_defer_requires_reason_and_records_unoccupied_h(self) -> None:
        with self.stack.fixture() as fixture:
            path = f"/studies/{quote(fixture.uid)}"
            result = self.stack.request("POST", path + "/report/commit", "doctor", {"action": "defer", "reason": " "})
            self.assert_status(result, 400)
            self.assertEqual(result.body["message"], "보류에는 사유가 필요합니다")
            self.assert_status(self.stack.request("POST", path + "/hold", "doctor"), 201)
            result = self.stack.request("POST", path + "/report/commit", "doctor", {
                "action": "defer", "reason": "prior 없음", "baseVersion": 0, "findings": fixture.secret,
            })
            self.assert_status(result, 201)
            self.assertEqual(result.body["rs"], "H")
            self.assertEqual(result.body["holdReason"], "prior 없음")
            self.assertIsNone(result.body["holder"])
            self.assertEqual(result.body["findings"], fixture.secret)
            latest = self.versions(fixture, "doctor")[-1]
            self.assertEqual((latest["action"], latest["reason"]), ("defer", "prior 없음"))
            audit = self.stack.request("GET", f"/audit?uid={quote(fixture.uid)}", "jmryu")
            self.assert_status(audit, 200)
            self.assertEqual(len([r for r in audit.body if r["action"] == "report.defer"]), 1)

    def test_defer_all_exits_clear_hold_reason(self) -> None:
        for action, rs in (("save", "T"), ("approve", "A"), ("preliminary", "P"), ("reset", "W")):
            with self.subTest(action=action), self.stack.fixture() as fixture:
                path = f"/studies/{quote(fixture.uid)}/report/commit"
                deferred = self.stack.request("POST", path, "doctor", {
                    "action": "defer", "reason": "임상정보 부족", "baseVersion": 0,
                })
                self.assert_status(deferred, 201)
                result = self.stack.request("POST", path, "doctor2", {
                    "action": action, "baseVersion": deferred.body["version"], "reason": "내용 정정 필요",
                    "reviewer": self.stack.actor("doctor"), "findings": "continued",
                })
                self.assert_status(result, 201)
                self.assertEqual(result.body["rs"], rs)
                self.assertIn("holdReason", result.body)
                self.assertIsNone(result.body["holdReason"])

    def test_defer_cannot_leave_preliminary_or_approved(self) -> None:
        for state in ("P", "A"):
            with self.subTest(state=state), self.stack.fixture() as fixture:
                if state == "P":
                    self.preliminary(fixture)
                else:
                    self.approve(fixture)
                before = self.snapshot(fixture, "doctor")
                result = self.stack.request("POST", f"/studies/{quote(fixture.uid)}/report/commit", "doctor", {
                    "action": "defer", "reason": "영상 불량", "baseVersion": before[0]["version"],
                })
                self.assert_status(result, 400)
                self.assertIn("보류할 수 없습니다", result.body["message"])
                self.assert_snapshot_unchanged(fixture, "doctor", before)

    def test_defer_reason_cannot_be_patched(self) -> None:
        with self.stack.fixture() as fixture:
            before = self.snapshot(fixture, "doctor")
            for reason in ("우회", None):
                result = self.stack.request("PATCH", f"/studies/{quote(fixture.uid)}", "jmryu", {"holdReason": reason})
                self.assert_status(result, 400)
                self.assertIn("전용 경로", result.body["message"])
            self.assert_snapshot_unchanged(fixture, "doctor", before)

    def test_hold_blocks_other_actor_draft_and_all_commits_but_preserves_reads(self) -> None:
        with self.stack.fixture() as fixture:
            path = f"/studies/{quote(fixture.uid)}"
            self.assert_status(self.stack.request("POST", path + "/hold", "doctor"), 201)
            actor = self.stack.actor("doctor")
            before = self.snapshot(fixture, "doctor2")
            attempts = [("PUT", "/report", {"findings": fixture.secret})] + [
                ("POST", "/report/commit", {"action": action, "baseVersion": 0, "findings": fixture.secret})
                for action in ("save", "approve", "addendum", "reset", "preliminary", "defer")
            ]
            for method, suffix, body in attempts:
                with self.subTest(action=body.get("action", "draft")):
                    result = self.stack.request(method, path + suffix, "doctor2", body)
                    self.assert_status(result, 409)
                    self.assertEqual(result.body.get("code"), "REPORT_HELD")
                    self.assertEqual(result.body.get("holder"), actor)
                    self.assertEqual(result.body.get("message"), f"{actor} 님이 판독 중입니다")
            self.assert_snapshot_unchanged(fixture, "doctor2", before)

    def test_hold_allows_same_actor_draft_and_commit(self) -> None:
        with self.stack.fixture() as fixture:
            path = f"/studies/{quote(fixture.uid)}"
            self.assert_status(self.stack.request("POST", path + "/hold", "doctor"), 201)
            self.assert_status(self.stack.request(
                "PUT", path + "/report", "doctor", {"findings": fixture.secret},
            ), 200)
            self.approve(fixture)

    def test_hold_admin_force_release_is_audited_and_keeps_drafts(self) -> None:
        with self.stack.fixture() as fixture:
            path = f"/studies/{quote(fixture.uid)}"
            self.assert_status(self.stack.request("POST", path + "/hold", "doctor"), 201)
            self.assert_status(self.stack.request(
                "PUT", path + "/report", "doctor", {"findings": fixture.secret},
            ), 200)
            result = self.stack.request("POST", path + "/release/force", "jmryu")
            self.assert_status(result, 200)
            self.assertEqual(result.body, {"ok": True, "released": self.stack.actor("doctor")})
            audits = self.stack.request("GET", f"/audit?uid={quote(fixture.uid)}", "jmryu")
            self.assert_status(audits, 200)
            rows = [r for r in audits.body if r["action"] == "hold.force-release"]
            self.assertEqual(len(rows), 1)
            detail = json.loads(rows[0]["detail"])
            self.assertEqual(detail["holder"], self.stack.actor("doctor"))
            self.assertTrue(detail["alive"])
            self.assertIsNotNone(detail["heldAt"])
            state = self.stack.request("GET", "/bootstrap", "doctor")
            self.assert_status(state, 200)
            self.assertEqual(state.body["states"][fixture.uid]["draft"]["findings"], fixture.secret)
            self.assert_status(self.stack.request(
                "PUT", path + "/report", "doctor2", {"findings": "after release"},
            ), 200)
            empty = self.stack.request("POST", path + "/release/force", "jmryu")
            self.assert_status(empty, 200)
            self.assertIsNone(empty.body["released"])
            audits = self.stack.request("GET", f"/audit?uid={quote(fixture.uid)}", "jmryu")
            self.assertEqual(len([r for r in audits.body if r["action"] == "hold.force-release"]), 2)

    def test_hold_radiologist_cannot_force_release(self) -> None:
        with self.stack.fixture() as fixture:
            path = f"/studies/{quote(fixture.uid)}"
            self.assert_status(self.stack.request("POST", path + "/hold", "doctor"), 201)
            self.assert_status(self.stack.request("POST", path + "/release/force", "doctor2"), 403)
            result = self.stack.request("POST", path + "/hold", "doctor2")
            self.assert_status(result, 201)
            self.assertEqual(result.body, {"holder": self.stack.actor("doctor"), "mine": False, "conflict": True})

    def test_filming_non_emergency_blocks_all_report_writes_but_allows_reads(self) -> None:
        with self.stack.fixture() as fixture:
            path = f"/studies/{quote(fixture.uid)}"
            self.assert_status(self.stack.request(
                "PATCH", path, "tech", {"ss": "Unverified", "em": "N"},
            ), 200)
            before = self.snapshot(fixture, "doctor")
            message = "촬영 중(미확인) 검사입니다 — 기사 확인(Verify) 뒤 판독할 수 있습니다"
            for method, suffix, body in [
                ("PUT", "/report", {"findings": fixture.secret}),
                ("POST", "/report/commit", {"action": "save", "baseVersion": 0, "findings": fixture.secret}),
                ("POST", "/hold", None),
            ]:
                with self.subTest(route=suffix):
                    result = self.stack.request(method, path + suffix, "doctor", body)
                    self.assert_status(result, 409)
                    self.assertEqual(result.body.get("message"), message)
            # 판독문 조회는 별도 GET /report가 아니라 bootstrap과 versions로 제공된다.
            self.assert_snapshot_unchanged(fixture, "doctor", before)

    def test_filming_emergency_allows_report_writes_without_verify(self) -> None:
        with self.stack.fixture() as fixture:
            path = f"/studies/{quote(fixture.uid)}"
            self.assert_status(self.stack.request(
                "PATCH", path, "tech", {"ss": "Unverified", "em": "E"},
            ), 200)
            self.assert_status(self.stack.request("POST", path + "/hold", "doctor"), 201)
            self.assert_status(self.stack.request(
                "PUT", path + "/report", "doctor", {"findings": fixture.secret},
            ), 200)
            self.approve(fixture)

    def test_filming_verify_restores_non_emergency_report_writes(self) -> None:
        with self.stack.fixture() as fixture:
            path = f"/studies/{quote(fixture.uid)}"
            self.assert_status(self.stack.request(
                "PATCH", path, "tech", {"ss": "Unverified", "em": "N"},
            ), 200)
            self.assert_status(self.stack.request(
                "PATCH", path, "tech", {"ss": "Verified"},
            ), 200)
            self.assert_status(self.stack.request("POST", path + "/hold", "doctor"), 201)
            self.assert_status(self.stack.request(
                "PUT", path + "/report", "doctor", {"findings": fixture.secret},
            ), 200)
            self.approve(fixture)

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
        if operation == "release-force":
            return self.stack.request("POST", f"/studies/{uid}/release/force", user)
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

    def test_approved_report_only_exits_via_addendum_or_reset(self) -> None:
        with self.stack.fixture() as fixture:
            approved = self.approve(fixture)
            before = self.snapshot(fixture, "doctor")
            for user, action in (("doctor", "save"), ("doctor", "approve"), ("doctor2", "approve"), ("doctor2", "save")):
                with self.subTest(user=user, action=action):
                    result = self.commit(fixture, user, action, approved.body["version"], findings="replaced")
                    self.assert_status(result, 400)
                    self.assertIn("추가기재(Addendum) 또는 판독 취소(Reset)", result.body["message"])
                    self.assert_snapshot_unchanged(fixture, "doctor", before)
            self.assertEqual(self.report_state(fixture, "doctor")["repDoc"], self.prefix("doctor"))
            added = self.commit(fixture, "doctor2", "addendum", approved.body["version"], findings="add")
            self.assert_status(added, 201)
            reset = self.commit(fixture, "doctor", "reset", added.body["version"], reason="정정")
            self.assert_status(reset, 201)
            self.assertEqual(reset.body["rs"], "W")
            # 화면도 같은 말을 한다 — 잠금은 안내일 뿐이지만, 눌러보고 거절당하는 것보다 회색이 낫다
            page = (ROOT / "worklist-v0" / "hpacs-lite" / "main.html").read_text(encoding="utf-8")
            self.assertIn('for (const id of ["#b-save", "#b-transcribe", "#b-approve"])', page)
            self.assertIn("승인된 판독문은 추가기재(Addendum) 또는 판독 취소(Reset)로만 바꿀 수 있습니다", page)

    def test_uid_routes_404_without_study_state_row(self) -> None:
        doctor_id = self.stack.user_ids["doctor"]
        with self.stack.fixture() as fixture:
            path = f"/studies/{quote(fixture.uid)}"
            tagged = self.stack.request("PATCH", path, "tech", {"ov": {"id": "OVR", "name": fixture.secret}})
            self.assert_status(tagged, 200)   # 감사 detail에 환자 정보(ov)가 실린다
            # 살아 있는 행: 타기관은 404, 목록형 감사에도 안 보인다
            self.assert_status(self.stack.request("GET", f"/audit?uid={quote(fixture.uid)}", "kdoctor"), 404)
            collection = self.stack.request("GET", "/audit?take=500", "kdoctor")
            self.assert_status(collection, 200)
            self.assertFalse(any(row["target"] == fixture.uid for row in collection.body))
            self.assert_status(self.stack.request("PUT", path + "/report", "doctor", {"findings": fixture.secret}), 200)
            forced = self.stack.request("DELETE", path + "/draft/force", "jmryu")
            self.assert_status(forced, 200)
            self.assertEqual(forced.body["count"], 1)   # discarded 이력 1건이 남는다
            self.assert_status(self.stack.request("DELETE", path, "tech"), 200)
            # 행이 사라진 뒤에는 누구에게도 없는 검사다. GET /studies는 lazy 등록으로 행을 되살리므로 부르지 않는다.
            for user in ("kdoctor", "doctor", "jmryu"):
                with self.subTest(user=user):
                    audit = self.stack.request("GET", f"/audit?uid={quote(fixture.uid)}", user)
                    versions = self.stack.request("GET", path + "/report/versions", user)
                    self.assertEqual((audit.status, versions.status), (404, 404), audit.text + versions.text)
                    self.assertFalse(audit.contains(fixture.secret) or versions.contains(fixture.secret))
            # 회원 감사 행(target = Keycloak 사용자 id)은 검사 uid 관문을 지나지 못한다 — 관리자여도
            self.assert_status(self.stack.request("GET", f"/audit?uid={quote(doctor_id)}", "kdoctor"), 404)
            self.assert_status(self.stack.request("GET", f"/audit?uid={quote(doctor_id)}", "jmryu"), 404)

    def test_tele_receiver_cannot_edit_owner_exam_metadata(self) -> None:
        with self.stack.fixture() as fixture:
            path = f"/studies/{quote(fixture.uid)}"
            self.assert_status(self.stack.request("PATCH", path, "doctor", {"ts": "wait", "teleTo": "kin-center"}), 200)
            self.assert_status(self.stack.request("DELETE", path, "ktech"), 403)   # 이미 있던 형제 관문
            before = self.snapshot(fixture, "doctor")
            for body in (
                {"ss": "Unverified", "em": "N"}, {"em": "E"},
                {"ov": {"id": "K1", "name": "RENAMED"}}, {"ward": "K", "reqHosp": "KIN"},
            ):
                with self.subTest(body=body):
                    result = self.stack.request("PATCH", path, "ktech", body)
                    self.assert_status(result, 403)
                    self.assertIn("보유 기관", result.body["message"])
            state = self.state(fixture, "doctor")
            self.assertEqual((state["ss"], state["em"], state["ov"]), ("Verified", "N", None))
            self.assert_snapshot_unchanged(fixture, "doctor", before)
            self.assert_status(self.stack.request("PUT", path + "/report", "doctor", {"findings": "x"}), 200)   # 소유 기관은 잠기지 않았다
            # 수신 기관의 TS 자기 구간과 소유 기관 기사의 권한은 그대로다
            for ts in ("sending", "sent"):
                self.assert_status(self.stack.request("PATCH", path, "doctor", {"ts": ts}), 200)
            self.assert_status(self.stack.request("PATCH", path, "kdoctor", {"ts": "inReading"}), 200)
            self.assert_status(self.stack.request("PATCH", path, "tech", {"ss": "Unverified"}), 200)

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
