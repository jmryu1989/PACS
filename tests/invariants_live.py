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
from contextlib import contextmanager
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Iterator
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
        self.api = os.environ.get("KIN_TEST_API", "http://127.0.0.1:3000/api").rstrip("/")
        self.keycloak = os.environ.get(
            "KIN_TEST_TOKEN_URL",
            "http://127.0.0.1:8080/auth/realms/kin/protocol/openid-connect/token",
        )
        # 운영 UI 클라이언트는 password grant를 받지 않는다. 실행 감사에서는 운영 렐름에
        # 포함되지 않는 별도 로컬 클라이언트를 KIN_TEST_CLIENT_ID로 명시한다.
        self.client_id = os.environ.get("KIN_TEST_CLIENT_ID", "kin-web")
        self.orthanc = os.environ.get("KIN_TEST_ORTHANC", "http://127.0.0.1:8042").rstrip("/")
        self.proxy = os.environ.get("KIN_TEST_PROXY", "https://localhost:9443").rstrip("/")
        self.tokens: dict[str, str] = {}
        self.actors: dict[str, str] = {}
        self.active: dict[str, Fixture] = {}
        self._load_seed_configuration()

    def _load_seed_configuration(self) -> None:
        realm = json.loads((ROOT / "keycloak" / "kin-realm.json").read_text(encoding="utf-8"))
        self.passwords: dict[str, str] = {}
        common = os.environ.get("KIN_TEST_PASSWORD")
        for user in realm.get("users", []):
            username = user.get("username")
            credentials = user.get("credentials") or []
            if username and (common or credentials):
                self.passwords[username] = common or credentials[0].get("value", "")

        self.orthanc_user = os.environ.get("KIN_TEST_ORTHANC_USER", "admin")
        self.orthanc_password = os.environ.get(
            "KIN_TEST_ORTHANC_PASSWORD", os.environ.get("ORTHANC_PASS", ""),
        )
        if not self.orthanc_password:
            raise RuntimeError("KIN_TEST_ORTHANC_PASSWORD 또는 ORTHANC_PASS가 필요합니다")

    def request(self, method: str, path: str, user: str | None = None, body: Any = None) -> HttpResult:
        data = None if body is None else json.dumps(body).encode("utf-8")
        headers = {"Accept": "application/json"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        if user:
            headers["Authorization"] = "Bearer " + self.token(user)
        request = Request(self.api + path, data=data, headers=headers, method=method)
        try:
            with urlopen(request, timeout=30) as response:
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
            "client_id": self.client_id, "grant_type": "password",
            "username": user, "password": password,
        }).encode("ascii")
        request = Request(
            self.keycloak, data=data,
            headers={"Content-Type": "application/x-www-form-urlencoded"}, method="POST",
        )
        with urlopen(request, timeout=30) as response:
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

    def create_fixture(self, institution: str = "한림병원") -> Fixture:
        run = uuid.uuid4().hex
        owner = "jmryu" if institution == "한림병원" else "kdoctor"
        patient_id = "INV-" + run[:16]
        command = [
            sys.executable, str(ROOT / "scripts" / "send_cstore.py"),
            "--institution", institution, "--name", f"INVARIANT^{run[:10]}",
            "--id", patient_id, "--desc", "Invariant route fixture", "--slices", "1",
        ]
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
            deadline = time.monotonic() + 20
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
    def fixture(self, institution: str = "한림병원") -> Iterator[Fixture]:
        fixture = self.create_fixture(institution)
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
        cls.stack.require_stack()
        cls.context = ssl._create_unverified_context()
        password = os.environ.get("KC_ADMIN_PASSWORD", "")
        if not password:
            raise RuntimeError("KC_ADMIN_PASSWORD가 필요합니다")
        data = urlencode({
            "client_id": "admin-cli", "grant_type": "password",
            "username": "admin", "password": password,
        }).encode("ascii")
        with urlopen(Request(
            "http://127.0.0.1:8080/auth/realms/master/protocol/openid-connect/token",
            data=data, headers={"Content-Type": "application/x-www-form-urlencoded"}, method="POST",
        ), timeout=30) as response:
            cls.admin_token = json.loads(response.read().decode("utf-8"))["access_token"]
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

    def bff_login(self, username: str, password: str):
        jar = http.cookiejar.CookieJar()
        opener = build_opener(HTTPCookieProcessor(jar), HTTPSHandler(context=self.context))
        login = self.proxy(opener, "GET", "/api/auth/login")
        self.assertEqual(login.status, 200, login.text)
        match = re.search(r'<form[^>]+action="([^"]+)"', login.text, re.I)
        self.assertIsNotNone(match, "Keycloak 로그인 form이 없습니다")
        data = urlencode({
            "username": username, "password": password, "credentialId": "",
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


class LiveInvariantTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.stack = LiveStack()
        cls.stack.require_stack()
        cls.addClassCleanup(cls.stack.cleanup_all)

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
