"""TEST-S7-U5-LIVE (AL-01..AL-13, test-plan section 3): the access records of the real BFF, Keycloak, nginx and
PostgreSQL - login success and failure, logout, the login starts that end a session (account switch, the completion of
an unfinished logout, re-authentication, registration), idle expiry and a refused refresh - their fields, the proxy's
client address (also on the DICOM authorization path, A007), the record-time institution an institution's admin reads,
and no secret in any column; and of the same unit: every /api/ answer is `no-store` (A016) and the Keycloak account
console is not exposed (A018).

REQ-S7-U5-AUTH-AUDIT -> RISK-S7-U5-SECRET-IN-LOG / RISK-S7-U5-CROSS-INSTITUTION -> TEST-S7-U5-LIVE. The sweep is not here:
it is an hourly timer with no route (tests/auth_session_service_test.cjs AS-08, CFC-4).

Run only through the guarded runner, on the isolated synthetic stack (OP-4 A; COMPOSE_PROJECT_NAME and COMPOSE_FILE fixed
by the commander's procedure):
    python scripts/run-tests.py --module tests/auth_audit_live.py --mode live --unit s7-u5-auth-audit --timeout 900
One class, cases in declared order (CASES is compared with the class at start). The browser login is followed one
redirect at a time by this file's own opener, so state, code, kin_pending and kin_sid are held in memory only and become
the secret set the rows are searched for; nothing secret is printed - each case prints one line
`S7-U5-AUTH-LIVE {case, rows, hits:[kinds], ip_ok}`.

Owned data: Keycloak groups kin-test-<run>-a/-b/-z; admins of A, B and Z (LiveStack test identities, Bearer); members ma
(A, radiologist), mt (A, radiologist; AL-13), mb (B, technician), mm (A, moved to B), mp (no group: PENDING), mi2 (two
groups: INVALID) and mi1 (one group, no role: INVALID), created with passwords through the Keycloak admin API.
Cleanup: the members' and admins' access
rows by target and actor (past the AuditLog append-only guard, as the owned-row cleanup of tests/invariants_live.py does),
their sessions, ProviderChange and retained MemberRights by exact owned sub, the members and the groups.
"""
from __future__ import annotations

import html
import importlib.util
import http.cookiejar
import json
import os
import re
import subprocess
import sys
import time
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from html.parser import HTMLParser
from ipaddress import ip_address
from urllib.error import HTTPError
from urllib.parse import parse_qs, quote, unquote, urlencode, urljoin, urlparse
from urllib.request import HTTPCookieProcessor, HTTPRedirectHandler, HTTPSHandler, Request, build_opener

from invariants_live import ROOT, LiveStack, past_audit_guard, psql, purge_user_audit

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

CASES = (
    "test_01_login_success_row_and_no_secret",
    "test_02_the_address_is_the_proxys_not_a_forwarded_header",
    "test_03_logout_row_csrf_and_absence",
    "test_04_login_starts_record_their_declared_cause",
    "test_05_idle_row",
    "test_06_refused_refresh_row",
    "test_07_admins_read_record_time_institutions_only",
    "test_08_login_failures_of_this_servers_logins_only",
    "test_09_bearer_logout_writes_nothing",
    "test_10_a_session_ended_on_the_dicom_path_records_the_proxys_address",
    "test_11_api_answers_are_not_stored_and_the_account_console_is_closed",
    "test_11b_login_logout_server_time_and_timezone",
    "test_11c_ward_nat_relogin_and_operator_log_privacy",
    "test_12_cleanup_leaves_no_owned_row_or_session",
)
AUTH = ("auth.login", "auth.logout", "auth.session.expired")
GROUP = re.compile(r"kin-test-[0-9a-f]{12}-[abz]")
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
KEYS = {"auth.login:success": ["dataSubject", "institution", "ip", "outcome"],
        "auth.login:failure": ["cause", "dataSubject", "institution", "ip", "outcome"],
        "auth.logout": ["cause", "dataSubject", "institution", "ip"],
        # a session ended by a re-authentication also records what asked for it (the declared reason, or register)
        "auth.logout:reauthentication": ["cause", "dataSubject", "institution", "ip", "trigger"],
        "auth.session.expired": ["cause", "dataSubject", "institution", "ip"]}


def shape_of(action, detail):
    if action == "auth.login":
        return action + ":" + detail.get("outcome")
    return action + (":reauthentication" if action == "auth.logout" and detail.get("cause") == "reauthentication" else "")
ABSENT, EXPIRED, REFUSED = "인증 세션이 없습니다", "인증 세션이 만료되었습니다", "인증 세션을 갱신할 수 없습니다"


class _NoRedirect(HTTPRedirectHandler):
    """Every redirect comes back to the caller, which reads Location and Set-Cookie itself."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class LinkTargets(HTMLParser):
    def __init__(self):
        super().__init__()
        self.targets = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            target = dict(attrs).get("href")
            if target is not None:
                self.targets.append(target)


def secret_hits(texts, secrets):
    """Kinds of secret found in texts; the values never leave this function."""
    found = set()
    for text in texts:
        if not isinstance(text, str) or not text:
            continue
        for kind, value in secrets:
            if value and len(value) >= 6 and (value in text or quote(value, safe="") in text):
                found.add(kind)
    return sorted(found)


def secret_entries(kind, value):
    entries = [(kind, value)]
    if isinstance(value, str) and value.count(".") == 2:
        entries += [(f"{kind}-piece{n}", piece) for n, piece in enumerate(value.split("."))]
    return entries


class Browser:
    """One browser profile of the BFF: a cookie jar and an opener that follows no redirect by itself."""

    def __init__(self, stack: LiveStack, real_ip: str | None = None, forwarded: str | None = None):
        self.stack = stack
        self.jar = http.cookiejar.CookieJar()
        self.opener = build_opener(HTTPCookieProcessor(self.jar), HTTPSHandler(context=stack.context), _NoRedirect())
        self.headers = {}
        # S7-U5: the id of the login session this profile's document saw (GET me); sent as X-KIN-Session on /api calls.
        self.session = None
        self.calls = []
        self.proof = None
        if real_ip:
            self.headers["X-Real-IP"] = real_ip
        if forwarded:
            self.headers["X-Forwarded-For"] = forwarded

    def call(self, method, url, data=None, headers=None):
        target = url if url.startswith("http") else self.stack.proxy + url
        bound = {"X-KIN-Session": self.session} if self.session and url.startswith("/api/") else {}
        request = Request(target, data=data, method=method, headers={**self.headers, **bound, **(headers or {})})
        try:
            with self.opener.open(request, timeout=30) as response:
                self.calls.append((urlparse(target).path, response.status))
                return response.status, dict(response.headers), response.read().decode("utf-8", "replace")
        except HTTPError as error:
            self.calls.append((urlparse(target).path, error.code))
            return error.code, dict(error.headers or {}), error.read().decode("utf-8", "replace")

    def cookie(self, name):
        return next((c.value for c in self.jar if c.name == name), None)

    def pending(self):
        """The newest pending login flow of this profile (one cookie per flow: kin_pending_<derived from its state>)."""
        return next((c.value for c in reversed(list(self.jar)) if c.name.startswith("kin_pending_")), None)

    def sid(self):
        return self.cookie("kin_sid")


class AuthSessionServiceLive(unittest.TestCase):
    """Full compiled regression on B's disposable fixture; no original-stack endpoint is used.

    Selected explicitly through run-tests.py --class AuthSessionServiceLive. The hosted HTTP profile continues to
    select AuthAuditLive; this adapter adds no alternate gate or test selector.
    """
    _spec = importlib.util.spec_from_file_location('emrb_auth_fixture', ROOT / 'tests/emr/b/live.py')
    _fixture = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(_fixture)
    label_namespace = 'kin.emrb.live'
    setUpClass = classmethod(_fixture.EmrBAuthLive.setUpClass.__func__)
    setup_disposable_resources = classmethod(_fixture.EmrBAuthLive.setup_disposable_resources.__func__)
    cleanup_resources = classmethod(_fixture.EmrBAuthLive.cleanup_resources.__func__)
    start_db = classmethod(_fixture.EmrBAuthLive.start_db.__func__)
    provision = classmethod(_fixture.EmrBAuthLive.provision.__func__)
    migrate = classmethod(_fixture.EmrBAuthLive.migrate.__func__)
    volume = classmethod(_fixture.EmrBAuthLive.volume.__func__)
    url = classmethod(_fixture.EmrBAuthLive.url.__func__)
    psql = _fixture.EmrBAuthLive.psql
    ok = _fixture.EmrBAuthLive.ok
    auth_case = _fixture.EmrBAuthLive.auth_case

    # Disjoint, exhaustive title families keep each gated method below the live
    # deadline. Counts prove that selection actually executed the intended cases.
    def test_compiled_01_session_contracts(self):
        self.auth_case('group-01', full=True,
                       pattern=r'^(?:U5S[-_]|L(?:09|1[0-6]) |AS-|U5E-|R10-|U[1-59] |ASTRA[-_ ])', expected=77)

    def test_compiled_02_core_lifecycle(self):
        self.auth_case('group-02', full=True, pattern=r'^CORE-', expected=19)

    def test_compiled_03_command_commit(self):
        self.auth_case('group-03', full=True, pattern=r'^CORE_(?:COMMAND_CAS_MATRIX|POSTCOMMIT_MATRIX)', expected=48)

    def test_compiled_04_end_races(self):
        self.auth_case('group-04', full=True, pattern=r'^CORE_COMMAND_END_RACE', expected=30)

    def test_compiled_05_core_revisions(self):
        self.auth_case('group-05', full=True, pattern=r'^CORE_R(?:9_|10_|11_)', expected=51)

    def test_compiled_06_core_remaining(self):
        self.auth_case('group-06', full=True,
                       pattern=r'^CORE_(?!COMMAND_CAS_MATRIX|POSTCOMMIT_MATRIX|COMMAND_END_RACE|R(?:9_|10_|11_))', expected=77)


class ReportDraftServiceLive(unittest.TestCase):
    """The compiled draft CAS contract on the same networkless, disposable PostgreSQL fixture."""
    label_namespace = 'kin.emrb.live'
    setUpClass = classmethod(AuthSessionServiceLive.setUpClass.__func__)
    setup_disposable_resources = classmethod(AuthSessionServiceLive.setup_disposable_resources.__func__)
    cleanup_resources = classmethod(AuthSessionServiceLive.cleanup_resources.__func__)
    start_db = classmethod(AuthSessionServiceLive.start_db.__func__)
    provision = classmethod(AuthSessionServiceLive.provision.__func__)
    migrate = classmethod(AuthSessionServiceLive.migrate.__func__)
    volume = classmethod(AuthSessionServiceLive.volume.__func__)
    url = classmethod(AuthSessionServiceLive.url.__func__)
    psql = AuthSessionServiceLive.psql
    ok = AuthSessionServiceLive.ok

    def test_compiled_report_draft_cas(self):
        db = self.start_db('draft-cas')
        self.provision(db)
        self.ok('CREATE DATABASE kin_report_draft_test OWNER kin', db=db)
        env = {**self.env, 'KIN_REPORT_DRAFT_DATABASE_URL': self.url('kin', 'kin_report_draft_test')}
        result = self.__class__._run([
            'docker', 'run', '--rm', '--label', self.label, '--network', 'container:' + db,
            '-e', 'KIN_REPORT_DRAFT_DATABASE_URL', '-v', str(ROOT / 'tests') + ':/tests:ro',
            '--entrypoint', 'node', self.image, '--test', '--test-reporter=tap', '/tests/report_draft_cas_service_test.cjs'],
            env=env, check=False, timeout=3000)
        output = (result.stdout + result.stderr).decode('utf-8', 'replace')
        for value in self.secrets.values():
            output = output.replace(value, '[redacted]')
        print(output, flush=True)
        self.assertEqual(result.returncode, 0)
        self.assertRegex(output, r'(?m)^# pass 42$')
        self.assertRegex(output, r'(?m)^# fail 0$')
        self.assertRegex(output, r'(?m)^# skipped 0$')

    _run = staticmethod(AuthSessionServiceLive._fixture.run)


class AuthFailureCapacityLive(unittest.TestCase):
    """Separately gated 60,000-refusal measurement; every fact uses the real producer, DB and seal."""
    label_namespace = 'kin.emrb.live'
    setUpClass = classmethod(AuthSessionServiceLive.setUpClass.__func__)
    setup_disposable_resources = classmethod(AuthSessionServiceLive.setup_disposable_resources.__func__)
    cleanup_resources = classmethod(AuthSessionServiceLive.cleanup_resources.__func__)
    start_db = classmethod(AuthSessionServiceLive.start_db.__func__)
    provision = classmethod(AuthSessionServiceLive.provision.__func__)
    migrate = classmethod(AuthSessionServiceLive.migrate.__func__)
    volume = classmethod(AuthSessionServiceLive.volume.__func__)
    url = classmethod(AuthSessionServiceLive.url.__func__)

    def test_deactivated_member_capacity(self):
        env = {**self.env, 'DATABASE_URL': self.url(), 'KIN_EMR_STATE_DIR': '/var/lib/kin-emr'}
        done = AuthSessionServiceLive._fixture.run([
            'docker', 'run', '--rm', '--label', self.label, '--network', 'container:' + self.db,
            '-e', 'DATABASE_URL', '-e', 'KIN_EMR_STATE_DIR', '-v', self.state + ':/var/lib/kin-emr',
            '-v', str(ROOT / 'tests') + ':/tests:ro', '--entrypoint', 'node', self.image,
            '/tests/emr/b/contract_test.cjs', '--emr-b-live', 'auth-failure-capacity'],
            env=env, check=False, timeout=3300)
        output = (done.stdout + done.stderr).decode('utf-8', 'replace')
        for value in self.secrets.values():
            output = output.replace(value, '[redacted]')
        print(output, flush=True)
        self.assertEqual(done.returncode, 0)
        results = [json.loads(line.removeprefix('EMR_B_RESULT ')) for line in output.splitlines() if line.startswith('EMR_B_RESULT ')]
        self.assertEqual(len(results), 1)
        self.assertNotIn('error', results[0])
        self.assertEqual(results[0]['recorded'], 60000)
        self.assertEqual(results[0]['unrecorded'], 0)


class AuthAuditLive(unittest.TestCase):
    secrets: list = []
    provider_sessions: list = []

    @classmethod
    def setUpClass(cls) -> None:
        declared = [name for name in sorted(vars(cls)) if name.startswith("test_")]
        if list(CASES) != declared:
            raise RuntimeError(f"CASES {CASES} differ from the declared cases {declared}")
        from owned_auth_http_stack import start_if_requested
        start_if_requested(cls)
        cls.stack = LiveStack()
        cls.addClassCleanup(cls.stack.cleanup_test_identities)
        cls.run_id = uuid.uuid4().hex[:12]
        cls.groups: dict[str, tuple[str, str]] = {}
        cls.members: dict[str, dict] = {}
        cls.addClassCleanup(cls.delete_groups)
        cls.addClassCleanup(cls.delete_members)
        cls.addClassCleanup(cls.purge_owned_rows)
        cls.stack.require_stack()
        for key in "ABZ":
            cls.create_group(key)
        for logical, group in (("u5-admin-a", "A"), ("u5-admin-b", "B"), ("u5-admin-z", "Z")):
            cls.stack.create_test_identity(logical, ["admin"], cls.groups[group][0])
        for name, groups, roles in (("ma", "A", ["radiologist"]), ("mb", "B", ["technician"]), ("mm", "A", ["radiologist"]),
                                    ("mp", "", ["radiologist"]), ("mi2", "AB", ["radiologist"]), ("mi1", "A", [])):
            cls.create_member(name, groups, roles)
        cls.expected_ip = cls.observed_ip()

    # ── owned fixtures ──
    @classmethod
    def create_group(cls, key: str) -> None:
        name = f"kin-test-{cls.run_id}-{key.lower()}"
        if not GROUP.fullmatch(name):
            raise RuntimeError("invalid synthetic institution name")
        created = cls.stack.kc_admin("POST", "/groups", {"name": name})
        if created.status != 201:
            raise RuntimeError(f"synthetic institution group creation failed: {created.status}")
        found = cls.stack.kc_admin("GET", "/groups?search=" + quote(name))
        exact = [g for g in (found.body if isinstance(found.body, list) else []) if g.get("name") == name]
        if len(exact) != 1:
            raise RuntimeError(f"synthetic institution group lookup failed: {name}")
        cls.groups[key] = (name, exact[0]["id"])

    @classmethod
    def create_member(cls, name: str, groups: str, roles: list[str]) -> None:
        username = f"kin-test-{cls.run_id}-u5-{name}"
        password = uuid.uuid4().hex + "Aa1!"
        created = cls.stack.kc_admin("POST", "/users", {
            "username": username, "enabled": True, "emailVerified": True, "email": username + "@local.test",
            "firstName": "SYN", "lastName": "U5 " + name})
        if created.status != 201 or not UUID.fullmatch(str(created.body)):
            raise RuntimeError(f"synthetic member creation failed: {created.status}")
        user_id = str(created.body)
        cls.members[name] = {"id": user_id, "username": username, "password": password, "email": username + "@local.test"}
        reset = cls.stack.kc_admin("PUT", f"/users/{user_id}/reset-password", {"type": "password", "value": password, "temporary": False})
        if reset.status != 204:
            raise RuntimeError(f"synthetic member password failed: {reset.status}")
        if len(groups) == 1 and roles:
            cls.stack.set_member_rights(user_id, institution=cls.groups[groups][0], roles=roles,
                                        enabled=True, verificationOverride=True)
        # Unregistered identities wait without rights; cancellation would additionally suspend them.
        cls.secrets += [("password", password)]

    @classmethod
    def owned_ids(cls) -> list[str]:
        ids = [m["id"] for m in cls.members.values()] + list(cls.stack.user_ids.values())
        if not all(UUID.fullmatch(i) for i in ids):
            raise RuntimeError("refusing cleanup: an owned id has an unexpected shape")
        return ids

    @classmethod
    def purge_owned_rows(cls) -> None:
        """Access rows whose target or actor is an owned account (the failure rows of AL-08 have target '' and actor
        'unknown': they are removed by the run's own failure-row ids, kept in cls.failure_ids), then the sessions and
        provider changes before retained rights, for all owned members and admins."""
        for user_id in cls.owned_ids():
            purge_user_audit(user_id)
            psql(f'DELETE FROM "AuthSession" WHERE sub=\'{user_id}\';')
            # The product retains cancelled rights and has no member removal API. Bypass its retention trigger
            # only in this owned-fixture transaction; ProviderChange ownership is sub, not its call target.
            psql(f'BEGIN; DELETE FROM "ProviderChange" WHERE sub=\'{user_id}\'; '
                 'SET LOCAL session_replication_role = replica; '
                 f'DELETE FROM "MemberRights" WHERE sub=\'{user_id}\'; '
                 'SET LOCAL session_replication_role = origin; COMMIT;')
        # The end marks of this run's own provider sessions (ids read from this run's own session rows).
        owned = [value for value in cls.provider_sessions if re.fullmatch(r"[0-9A-Za-z-]{8,64}", value)]
        if owned:
            psql('DELETE FROM "IdpSessionEnd" WHERE "idpSid" IN (' + ",".join(f"'{value}'" for value in owned) + ");")
        ids = [int(i) for i in getattr(cls, "failure_ids", [])]
        if ids:
            psql(past_audit_guard('DELETE FROM "AuditLog" WHERE id IN (' + ",".join(map(str, ids)) + ");"))

    @classmethod
    def delete_members(cls) -> None:
        for member in cls.members.values():
            cls.stack.kc_admin("DELETE", f"/users/{member['id']}")

    @classmethod
    def delete_groups(cls) -> None:
        for _name, group_id in cls.groups.values():
            cls.stack.kc_admin("DELETE", f"/groups/{group_id}")

    # ── what the proxy saw: the expected client address ──
    # Each call names its Compose command in full (S7-TEST-DB-EXEC TG-02): the project is the one this run inherited,
    # selected by cwd = ROOT alone, never by a fixed container name or a forwarded argument list.
    @classmethod
    def proxy_log(cls) -> str:
        done = subprocess.run(["docker", "compose", "logs", "--no-log-prefix", "proxy"], cwd=ROOT, capture_output=True,
                              text=True, encoding="utf-8", errors="replace", timeout=60)
        if done.returncode:
            raise RuntimeError("harness: the proxy log could not be read")
        return done.stdout + done.stderr

    @classmethod
    def proxy_addresses(cls) -> list:
        done = subprocess.run(["docker", "compose", "exec", "-T", "proxy", "hostname", "-i"], cwd=ROOT, capture_output=True,
                              text=True, encoding="utf-8", errors="replace", timeout=60)
        if done.returncode:
            raise RuntimeError("harness: the proxy container address could not be read")
        return done.stdout.split()

    @classmethod
    def observed_ip(cls) -> str:
        """A unique path on the existing unknown-route response; queries are deliberately absent from product logs."""
        mark = "/api/audit-address-" + uuid.uuid4().hex
        status, _headers, _body = Browser(cls.stack).call("GET", mark)
        if status != 404:
            raise RuntimeError(f"harness: the address check answered {status}")
        lines = [json.loads(line) for line in cls.proxy_log().splitlines() if line.startswith("{")]
        rows = [line for line in lines if line.get("path") == mark]
        if len(rows) != 1:
            raise RuntimeError(f"harness: expected one access record, got {len(rows)}")
        address = rows[0]["remote"]
        ip_address(address)
        return address

    # ── the BFF login, one redirect at a time ──
    def login(self, name: str, browser: Browser | None = None, server_window: list | None = None) -> Browser:
        time.sleep(1.05)  # Authenticate after any just-committed rights boundary.
        member = self.members[name]
        browser = browser or Browser(self.stack)
        status, headers, _ = browser.call("GET", "/api/auth/login")
        self.assertEqual(status, 302)
        location = headers.get("Location", "")
        state = parse_qs(urlparse(location).query)["state"][0]
        self.secret("state", state)
        self.secret("pending", browser.pending())
        status, _, page = browser.call("GET", location)
        self.assertEqual(status, 200, "the Keycloak login form")
        form = re.search(r'<form[^>]+action="([^"]+)"', page, re.I)
        self.assertIsNotNone(form, "the Keycloak login form has an action")
        data = urlencode({"username": member["username"], "password": member["password"], "credentialId": ""}).encode("utf-8")
        status, headers, _ = browser.call("POST", html.unescape(form.group(1)), data=data,
                                          headers={"Content-Type": "application/x-www-form-urlencoded"})
        self.assertEqual(status, 302, "Keycloak sends the browser back to the callback")
        callback = headers.get("Location", "")
        self.secret("code", parse_qs(urlparse(callback).query).get("code", [""])[0])
        if server_window is not None:
            server_window.append(self.server_time(browser))
        status, headers, _ = browser.call("GET", callback)
        self.assertEqual((status, urlparse(headers.get("Location", "")).path), (302, "/worklist/hpacs-lite/main.html"))
        if server_window is not None:
            server_window.append(self.server_time(browser))
        self.assertIsNotNone(browser.sid())
        self.secret("sid", browser.sid())
        # S7-U5: the single-use entry proof rides in the fragment; the document then learns its session id from its
        # bootstrap (the one cookie request without a binding; a member awaiting approval gets the id with the 403).
        browser.proof = urlparse(headers.get("Location", "")).fragment.partition("kin-entry=")[2] or None
        self.assertTrue(browser.proof, "the callback hands the login's entry proof in the fragment")
        self.secret("proof", unquote(browser.proof))
        browser.session = None
        _, _, me = browser.call("GET", "/api/me")
        browser.session = json.loads(me).get("sessionId")
        self.assertTrue(browser.session and browser.session != browser.sid(), "GET me answers the session id")
        row = psql(f'SELECT "accessToken" || E\'\\t\' || "refreshToken" || E\'\\t\' || coalesce("idpSid", \'\') FROM "AuthSession" WHERE sub=\'{member["id"]}\' ORDER BY "createdAt" DESC LIMIT 1;')
        access, refresh, provider = row[0].split("\t")
        for kind, value in (("access", access), ("refresh", refresh)):
            self.secret(kind, value)
        # S7-U5 session end: every login is stored with the provider session it was born from; its end mark is this
        # run's to clean up.
        self.assertTrue(provider, "the session remembers its provider session")
        type(self).provider_sessions.append(provider)
        browser.provider = provider
        return browser

    def logout(self, browser: Browser, csrf: bool = True) -> int:
        status, _, _ = browser.call("POST", "/api/auth/logout", data=b"", headers={"X-KIN-CSRF": "1"} if csrf else {})
        return status

    # ── reading rows and checking them ──
    def secret(self, kind, value):
        type(self).secrets += secret_entries(kind, value)

    def rows_of(self, name: str) -> list[dict]:
        user_id = self.members[name]["id"]
        actions = ",".join(f"'{a}'" for a in AUTH)
        out = psql(f'SELECT json_build_object(\'id\', id, \'at\', at AT TIME ZONE \'UTC\', \'actor\', actor, \'action\', action, \'target\', target, \'detail\', detail)::text '
                   f'FROM "AuditLog" WHERE target=\'{user_id}\' AND action IN ({actions}) ORDER BY id;')
        return [json.loads(line) for line in out]

    def check_rows(self, case: str, rows: list[dict], ip_ok: bool = True) -> None:
        for row in rows:
            detail = json.loads(row["detail"])
            self.assertEqual(sorted(detail), KEYS[shape_of(row["action"], detail)], f"{case}: the detail keys")
            self.assertIsNone(detail["dataSubject"])
        hits = secret_hits([v for row in rows for v in (row["actor"], row["action"], row["target"], row["detail"])], self.secrets)
        print("S7-U5-AUTH-LIVE " + json.dumps({"case": case, "rows": len(rows), "hits": hits, "ip_ok": ip_ok}))
        self.assertEqual([], hits, f"{case}: a secret in a row column (kinds only)")

    def ends(self, name: str) -> list[tuple]:
        return [(r["action"], json.loads(r["detail"]).get("cause") or json.loads(r["detail"]).get("outcome"),
                 json.loads(r["detail"]).get("institution"), json.loads(r["detail"]).get("ip")) for r in self.rows_of(name)]

    def admin_rows(self, key: str, limit: int = 100) -> list[dict]:
        """The console's GET /api/admin/audit readback, retaining fields and page order."""
        seen, after = [], None
        for _ in range(50):
            query = f"limit={limit}" + (f"&after={quote(after)}" if after else "")
            answer = self.stack.request("GET", "/admin/audit?" + query, f"u5-admin-{key.lower()}")
            self.assertEqual(answer.status, 200, answer.text)
            seen.extend(answer.body["rows"])
            after = answer.body.get("next")
            if not after:
                return seen
        raise RuntimeError("harness: the admin audit read did not end")

    def admin_view(self, key: str, limit: int = 100) -> set:
        """(action, target, cause/outcome, institution) of the access rows admin `key` reads, every page."""
        seen = set()
        for row in self.admin_rows(key, limit):
            if row["action"] in AUTH:
                self.assertEqual(sorted(row["detail"]), KEYS[shape_of(row["action"], row["detail"])])
                seen.add((row["action"], row["target"], row["detail"].get("cause") or row["detail"].get("outcome"),
                          row["detail"].get("institution")))
        return seen

    def explicit_time(self, value, label: str) -> datetime:
        self.assertIsInstance(value, str, label + ": a time is present")
        self.assertRegex(value, r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$",
                         label + ": ISO-8601 with an explicit timezone")
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        self.assertIsNotNone(parsed.utcoffset(), label + ": timezone-aware")
        return parsed

    def server_time(self, browser: Browser) -> datetime:
        status, _, body = browser.call("GET", "/api/health")
        self.assertEqual(status, 200, "the server time probe succeeded")
        return self.explicit_time(json.loads(body).get("at"), "health.at")

    # ── cases ──
    def test_01_login_success_row_and_no_secret(self):
        browser = self.login("ma")
        rows = self.rows_of("ma")
        self.assertEqual([(r["action"], r["actor"], r["target"]) for r in rows],
                         [("auth.login", self.members["ma"]["email"], self.members["ma"]["id"])])
        self.assertEqual(json.loads(rows[0]["detail"]), {"institution": self.groups["A"][0], "ip": self.expected_ip,
                                                          "dataSubject": None, "outcome": "success"})
        # The judge itself: a row carrying a secret is caught, a clean one is not.
        self.assertTrue(secret_hits([json.dumps({"x": browser.sid()})], self.secrets))
        self.assertFalse(secret_hits([json.dumps({"x": "clean"})], self.secrets))
        self.check_rows("AL-01", rows)
        # S7-U5 (U5S-REQ-09): the login is entered once with its proof - the answer is the session id the bootstrap
        # gives, one auth.entry row is recorded with the login's institution, and the same proof does not enter again.
        entry = lambda: browser.call("POST", "/api/auth/entry", data=json.dumps({"proof": unquote(browser.proof)}).encode("utf-8"),
                                     headers={"X-KIN-CSRF": "1", "Content-Type": "application/json"})
        status, _, body = entry()
        self.assertEqual((status, json.loads(body)), (200, {"sessionId": browser.session}))
        entered = psql(f'SELECT detail FROM "AuditLog" WHERE target=\'{self.members["ma"]["id"]}\' AND action=\'auth.entry\' ORDER BY id;')
        self.assertEqual([json.loads(line) for line in entered],
                         [{"institution": self.groups["A"][0], "ip": self.expected_ip, "dataSubject": None}])
        self.assertFalse(secret_hits(entered, self.secrets))
        status, _, body = entry()
        self.assertEqual((status, json.loads(body).get("code")), (403, "AUTH_ENTRY_REFUSED"))
        self.assertEqual(len(psql(f'SELECT id FROM "AuditLog" WHERE target=\'{self.members["ma"]["id"]}\' AND action=\'auth.entry\';')), 1)
        self.assertEqual(204, self.logout(browser))

    def test_02_the_address_is_the_proxys_not_a_forwarded_header(self):
        forged = Browser(self.stack, real_ip="203.0.113.7", forwarded="203.0.113.8")
        browser = self.login("ma", forged)
        self.assertEqual(204, self.logout(browser))
        proxy_address = self.proxy_addresses()
        rows = self.rows_of("ma")[-2:]
        ips = [json.loads(r["detail"])["ip"] for r in rows]
        ip_ok = ips == [self.expected_ip, self.expected_ip] and not set(ips) & {"203.0.113.7", "203.0.113.8", *proxy_address}
        self.check_rows("AL-02", rows, ip_ok)
        self.assertTrue(ip_ok, "the proxy's client address, not a forged header or the proxy container")

    def test_03_logout_row_csrf_and_absence(self):
        browser = self.login("ma")
        before = len(self.rows_of("ma"))
        self.assertEqual(403, self.logout(browser, csrf=False))
        self.assertEqual(before, len(self.rows_of("ma")), "a refused logout writes nothing")
        self.assertEqual(psql(f'SELECT count(*) FROM "AuthSession" WHERE sub=\'{self.members["ma"]["id"]}\';'), ["1"])
        sid = browser.sid()
        self.assertEqual(204, self.logout(browser))
        self.assertEqual(self.ends("ma")[-1], ("auth.logout", "logout", self.groups["A"][0], self.expected_ip))
        self.assertEqual(psql(f'SELECT count(*) FROM "AuthSession" WHERE sub=\'{self.members["ma"]["id"]}\';'), ["0"])
        # The same logout again (S7-U5): without the session id it is refused as a request (428, nothing ended or
        # recorded); with it, the session that is already gone is confirmed again - and still one row.
        replay = Browser(self.stack)
        status, _, body = replay.call("POST", "/api/auth/logout", data=b"", headers={"X-KIN-CSRF": "1", "Cookie": "kin_sid=" + sid})
        self.assertEqual((status, json.loads(body).get("code")), (428, "AUTH_SESSION_REQUIRED"))
        status, _, _ = replay.call("POST", "/api/auth/logout", data=b"", headers={"X-KIN-CSRF": "1", "Cookie": "kin_sid=" + sid,
                                                                               "X-KIN-Session": browser.session})
        self.assertEqual(status, 204)
        status, _, body = replay.call("GET", "/api/me", headers={"Cookie": "kin_sid=" + sid})
        self.assertEqual((status, json.loads(body).get("code"), json.loads(body).get("message")), (401, "AUTH_SESSION_ENDED", ABSENT))
        self.assertEqual(before + 1, len(self.rows_of("ma")))
        self.check_rows("AL-03", self.rows_of("ma"))

    def test_04_login_starts_record_their_declared_cause(self):
        """A019: the row of a session a login start ended says what the start declared - the completion of the person's
        own Log out is `logout`, only Switch account is `account_switch`, an unknown leave state and a registration are
        `reauthentication` (with what asked for it); one row per session, none for a session already gone."""
        count = f'SELECT count(*) FROM "AuthSession" WHERE sub=\'{self.members["ma"]["id"]}\';'
        for kind, reason, cause, trigger, prompt in (
                ("login", "switch_account", "account_switch", None, "login"),
                ("register", None, "reauthentication", "register", "create"),
                ("login", "logout_unfinished", "logout", None, "login"),
                ("login", "storage_untrusted", "reauthentication", "storage_untrusted", "login"),
                ("login", "record_unreadable", "reauthentication", "record_unreadable", "login")):
            label = f"{kind}/{reason}"
            browser = self.login("ma")
            path = "/api/auth/login" if kind == "login" else "/api/auth/register"
            body = json.dumps({"intent": "reauthenticate", "reason": reason} if kind == "login" else {}).encode("utf-8")
            start = lambda: browser.call("POST", path, data=body, headers={"X-KIN-CSRF": "1", "Content-Type": "application/json"})
            # A link (GET) ends nothing and carries no intent, whatever its address says: with a live session it goes
            # back to the entrance.
            status, headers, _ = browser.call("GET", path + "?prompt=login&intent=reauthenticate&reason=switch_account")
            self.assertEqual((status, urlparse(headers.get("Location", "")).query), (302, "auth_error=session_active"), label)
            self.assertEqual(psql(count), ["1"], label)
            before = len(self.rows_of("ma"))
            # The start is the bound POST: CSRF and the session id of the document that asks. The session is ended with
            # its row, the provider session is ended and that end confirmed, and only then the address is given - it
            # asks for credentials (prompt=login) or opens the registration.
            status, _, answer = start()
            self.assertEqual(200, status, label)
            location = json.loads(answer).get("location", "")
            self.assertIn("/protocol/openid-connect/auth?", location, label)
            self.assertEqual(parse_qs(urlparse(location).query).get("prompt"), [prompt], label)
            self.assertEqual(self.ends("ma")[-1], ("auth.logout", cause, self.groups["A"][0], self.expected_ip), label)
            self.assertEqual(json.loads(self.rows_of("ma")[-1]["detail"]).get("trigger"), trigger, label)
            self.assertEqual(before + 1, len(self.rows_of("ma")), label + ": one row")
            self.assertEqual(psql(count), ["0"], label)
            mark = psql(f'SELECT cause || E\'\\t\' || ("confirmedAt" IS NOT NULL)::text FROM "IdpSessionEnd" WHERE "idpSid"=\'{browser.provider}\';')
            self.assertEqual(mark, [cause + "\ttrue"], label + ": the provider session is marked and its end confirmed")
            if kind == "login":
                # The provider has no session of this browser any more: the address shows the form with a name field.
                status, _, page = browser.call("GET", location)
                self.assertEqual(200, status, label)
                self.assertRegex(page, r'<input[^>]+name="username"', label + ": an editable user name")
            # The same start again: the session is gone - nothing to end, no row; the SSO is probed first.
            browser.session = None
            status, _, answer = start()
            self.assertEqual(200, status, label)
            if kind == "login":
                self.assertEqual(parse_qs(urlparse(json.loads(answer)["location"]).query).get("prompt"), ["none"], label)
            self.assertEqual(before + 1, len(self.rows_of("ma")), label + ": no second row")
        # A start that declares no reason, or one the server does not know, starts nothing and ends nothing.
        browser = self.login("ma")
        for bad in ({}, {"prompt": "login"}, {"intent": "reauthenticate", "reason": "register"}):
            status, _, answer = browser.call("POST", "/api/auth/login", data=json.dumps(bad).encode("utf-8"),
                                             headers={"X-KIN-CSRF": "1", "Content-Type": "application/json"})
            self.assertEqual((status, json.loads(answer).get("code")), (400, "AUTH_LOGIN_INTENT_INVALID"), bad)
        self.assertEqual(psql(count), ["1"])
        self.assertEqual(204, self.logout(browser))
        self.check_rows("AL-04", self.rows_of("ma"))

    def test_05_idle_row(self):
        sub = self.members["mb"]["id"]
        for age, expected in (("11 hours 59 minutes", 200), ("12 hours 1 minute", 401)):
            browser = self.login("mb")
            before, sid = len(self.rows_of("mb")), browser.sid()
            psql(f'UPDATE "AuthSession" SET "lastSeenAt" = now() - interval \'{age}\' WHERE sub=\'{sub}\';')
            status, _, body = browser.call("GET", "/api/me", headers={"X-KIN-CSRF": "1"})
            self.assertEqual(expected, status, age)
            if expected == 200:
                self.assertEqual(before, len(self.rows_of("mb")), "not idle yet: no row")
                self.assertEqual(204, self.logout(browser))
                continue
            self.assertEqual(json.loads(body).get("message"), EXPIRED)
            self.assertEqual(self.ends("mb")[-1], ("auth.session.expired", "idle", self.groups["B"][0], self.expected_ip))
            again = Browser(self.stack)
            status, _, body = again.call("GET", "/api/me", headers={"Cookie": "kin_sid=" + sid})
            self.assertEqual((status, json.loads(body).get("message")), (401, ABSENT), "the same cookie again")
            self.assertEqual(before + 1, len(self.rows_of("mb")), "one idle row")
        self.check_rows("AL-05", self.rows_of("mb"))

    def test_06_refused_refresh_row(self):
        sub = self.members["mb"]["id"]
        # Preserving: an expired access token whose session Keycloak still holds refreshes without a row.
        browser = self.login("mb")
        before = len(self.rows_of("mb"))
        psql(f'UPDATE "AuthSession" SET "atExpiresAt" = now() - interval \'1 minute\' WHERE sub=\'{sub}\';')
        self.assertEqual(200, browser.call("GET", "/api/me")[0])
        self.assertEqual(before, len(self.rows_of("mb")))
        self.assertEqual(204, self.logout(browser))
        # Keycloak ends the member's sessions; the next refresh is refused and ends the BFF session with one row.
        browser = self.login("mb")
        logged_out = self.stack.kc_admin("POST", f"/users/{sub}/logout")
        self.assertEqual(204, logged_out.status)
        psql(f'UPDATE "AuthSession" SET "atExpiresAt" = now() - interval \'1 minute\' WHERE sub=\'{sub}\';')
        status, _, body = browser.call("GET", "/api/me")
        self.assertEqual((status, json.loads(body).get("message")), (401, REFUSED))
        self.assertEqual(self.ends("mb")[-1], ("auth.session.expired", "refresh_failed", self.groups["B"][0], self.expected_ip))
        self.check_rows("AL-06", self.rows_of("mb"))

    def test_07_admins_read_record_time_institutions_only(self):
        a, b = self.groups["A"][0], self.groups["B"][0]
        for name in ("mp", "mi2", "mi1"):
            waiting = self.login(name)
            status, _, body = waiting.call("GET", "/api/me")
            self.assertEqual((status, json.loads(body).get("code")), (403, "INSTITUTION_PENDING"))
            self.assertEqual(204, self.logout(waiting), name)
        self.assertEqual(204, self.logout(self.login("mm")))
        # Z's admin moves mm from A to B (an isolation: its sessions end without an access row), then mm logs in in B.
        mm = self.members["mm"]["id"]
        moved = self.stack.request("PATCH", f"/admin/users/{mm}", "u5-admin-z", {"institution": b, "verificationOverride": True})
        self.assertIn(moved.status, (200, 204), moved.text)
        self.login("mm")
        expected_rows = lambda name, inst: {(r["action"], r["target"], json.loads(r["detail"]).get("cause") or json.loads(r["detail"]).get("outcome"), inst)
                                            for r in self.rows_of(name) if json.loads(r["detail"]).get("institution") == inst}
        expected = {
            "A": expected_rows("ma", a) | expected_rows("mm", a),
            "B": expected_rows("mb", b) | expected_rows("mm", b),
            "Z": set(),
        }
        self.assertEqual(3, len(expected_rows("mm", a)) + len(expected_rows("mm", b)), "mm: A-era login and logout, one B-era login")
        for key in "ABZ":
            seen = {row for row in self.admin_view(key) if row[1] in self.owned_ids()}
            self.assertEqual(expected[key], seen, key)
            self.assertEqual(seen, {row for row in self.admin_view(key, limit=2) if row[1] in self.owned_ids()}, key + " paged")
        for name in ("mp", "mi2", "mi1"):
            self.assertTrue(all(json.loads(r["detail"])["institution"] is None for r in self.rows_of(name)), name)
        self.check_rows("AL-07", [r for name in ("mp", "mi2", "mi1", "mm") for r in self.rows_of(name)])

    def failure_rows(self) -> list[dict]:
        out = psql('SELECT json_build_object(\'id\', id, \'actor\', actor, \'action\', action, \'target\', target, \'detail\', detail)::text '
                   'FROM "AuditLog" WHERE action=\'auth.login\' AND target=\'\' AND id > ' + str(self.failure_floor) + ' ORDER BY id;')
        return [json.loads(line) for line in out]

    def test_08_login_failures_of_this_servers_logins_only(self):
        type(self).failure_floor = int(psql('SELECT coalesce(max(id), 0) FROM "AuditLog";')[0])
        type(self).failure_ids = []
        for error in ("access_denied", "temporarily_unavailable"):
            browser = Browser(self.stack)
            status, headers, _ = browser.call("GET", "/api/auth/login")
            state = parse_qs(urlparse(headers["Location"]).query)["state"][0]
            self.secret("state", state)
            status, headers, _ = browser.call("GET", f"/api/auth/callback?error={error}&state={quote(state)}")
            self.assertEqual((status, urlparse(headers["Location"]).query), (302, "auth_error=" + error))
        rows = self.failure_rows()
        type(self).failure_ids = [r["id"] for r in rows]
        self.assertEqual([(r["actor"], json.loads(r["detail"])) for r in rows],
                         [("unknown", {"institution": None, "ip": self.expected_ip, "dataSubject": None, "outcome": "failure",
                                       "cause": "provider_error"})] * 2)
        # No row without a pending login of this server, nor for a wrong password on the Keycloak form.
        self.assertEqual(302, Browser(self.stack).call("GET", "/api/auth/callback?error=access_denied&state=x")[0])
        member = dict(self.members["ma"])
        browser = Browser(self.stack)
        status, headers, _ = browser.call("GET", "/api/auth/login")
        status, _, page = browser.call("GET", headers["Location"])
        form = re.search(r'<form[^>]+action="([^"]+)"', page, re.I)
        data = urlencode({"username": member["username"], "password": "wrong-" + uuid.uuid4().hex, "credentialId": ""}).encode()
        status, _, _ = browser.call("POST", html.unescape(form.group(1)), data=data, headers={"Content-Type": "application/x-www-form-urlencoded"})
        self.assertEqual(200, status, "Keycloak shows its form again; no callback")
        self.assertEqual(len(rows), len(self.failure_rows()), "no further failure row")
        for key in "ABZ":
            self.assertFalse({row for row in self.admin_view(key) if row[1] == ""}, key + " sees no failure row")
        self.check_rows("AL-08", rows)
        # B2R3-01/06/08: all router aliases share a zone. Each callback spelling has its own valid pending flow.
        aliases = ["/api/auth/callback", "/api/auth/callback/", "/API/AUTH/CALLBACK"]
        cookies = {}
        for alias in aliases:
            browser = Browser(self.stack)
            status, headers, _ = browser.call("GET", "/api/auth/login")
            self.assertEqual(status, 302)
            self.secret("state", parse_qs(urlparse(headers["Location"]).query)["state"][0])
            flow = next(c for c in browser.jar if c.name.startswith("kin_pending_"))
            self.secret("pending", flow.value)
            cookies[alias] = flow.name + "=" + flow.value
        hsts = headers.get("Strict-Transport-Security")
        floor = int(psql('SELECT coalesce(max(id), 0) FROM "AuditLog";')[0])
        paths = aliases + ["/api/auth/login", "/api/auth/login/", "/API/AUTH/LOGIN"]
        code, state = uuid.uuid4().hex, uuid.uuid4().hex
        self.secret("query-code", code); self.secret("query-state", state)
        def repeated(n):
            path = paths[n % len(paths)]
            query = urlencode({"code": code, "state": state})
            browser = Browser(self.stack)
            answer = browser.call("GET", path + "?" + query,
                headers={"Cookie": cookies.get(path, ""), "Referer": self.stack.proxy + "/api/auth/callback?" + query})
            if path not in aliases and answer[0] == 302:
                self.secret("state", parse_qs(urlparse(answer[1]["Location"]).query)["state"][0])
                self.secret("pending", browser.pending())
            return path, answer
        with ThreadPoolExecutor(max_workers=40) as pool:
            answers = list(pool.map(repeated, range(480)))
        burst = [int(i) for i in psql('SELECT id FROM "AuditLog" WHERE action=\'auth.login\' AND target=\'\' AND id > '
                                      + str(floor) + ' ORDER BY id;')]
        type(self).failure_ids = list(self.failure_ids) + burst
        for path in paths:
            selected = [answer[0] for found, answer in answers if found == path]
            self.assertIn(429, selected, "each accepted alias shares the rate zone: " + path)
        admitted = sum(status == 302 for path, (status, _, _) in answers if path in aliases)
        self.assertEqual(len(burst), admitted, "every admitted callback refusal has exactly one durable fact")
        retry_targets = set()
        origin = urlparse(self.stack.proxy)
        for _, (status, headers, body) in answers:
            self.assertIn(status, (302, 429))
            if status == 429:
                self.assertRegex(body, r"[가-힣]")
                links = LinkTargets(); links.feed(body)
                targets = [urlparse(urljoin(self.stack.proxy, target)) for target in links.targets]
                fresh = [target for target in targets if target.path == "/worklist/hpacs-lite/index.html"]
                self.assertTrue(fresh, "the refusal offers the fresh sign-in screen")
                for target in fresh:
                    self.assertEqual((target.scheme, target.netloc), (origin.scheme, origin.netloc))
                    self.assertEqual((target.query, target.fragment), ("", ""), "retry never reuses code or state")
                    retry_targets.add(target.geturl())
                self.assertEqual(secret_hits([body], self.secrets), [], "the recovery page carries no generated secret")
                self.assertIn("no-store", {part.strip().lower() for part in headers.get("Cache-Control", "").split(",")})
                self.assertEqual(headers.get("X-Content-Type-Options"), "nosniff")
                self.assertEqual(headers.get("Referrer-Policy"), "no-referrer")
                self.assertEqual(headers.get("Strict-Transport-Security"), hsts)
                self.assertIn("frame-ancestors", headers.get("Content-Security-Policy", ""))
        for target in retry_targets:
            self.assertEqual(Browser(self.stack).call("GET", target)[0], 200, "the offered retry screen is reachable")
        self.assertEqual(secret_hits([self.proxy_log()], self.secrets), [], "raw operator output contains no generated secret kind")
        print("B2_RATE_ALIASES " + json.dumps({"requests": len(answers), "callback_facts": len(burst),
            "admitted_callbacks": admitted, "limited": sum(a[0] == 429 for _, a in answers), "secret_kind_hits": 0}))
        time.sleep(125)  # isolate the next case after the full 240-request burst at two requests/second

    def test_09_bearer_logout_writes_nothing(self):
        actor = self.stack.actor("u5-admin-a")
        before = psql(f'SELECT count(*) FROM "AuditLog" WHERE actor=\'{actor}\' AND action IN (\'auth.login\',\'auth.logout\',\'auth.session.expired\');')
        for path in ("/me", "/admin/users?page=1"):
            self.assertEqual(200, self.stack.request("GET", path, "u5-admin-a").status, path)
        self.assertEqual(204, self.stack.request("POST", "/auth/logout", "u5-admin-a").status)
        after = psql(f'SELECT count(*) FROM "AuditLog" WHERE actor=\'{actor}\' AND action IN (\'auth.login\',\'auth.logout\',\'auth.session.expired\');')
        self.assertEqual(before, after)
        self.assertEqual(["0"], after)
        print("S7-U5-AUTH-LIVE " + json.dumps({"case": "AL-09", "rows": 0, "hits": [], "ip_ok": True}))

    def test_10_a_session_ended_on_the_dicom_path_records_the_proxys_address(self):
        """A007: a session that ends on a DICOM request (the proxy's authorization subrequest) is recorded with the
        address the proxy observed - not with none, and not with a header the client sent."""
        sub = self.members["mb"]["id"]
        browser = self.login("mb", Browser(self.stack, real_ip="203.0.113.9", forwarded="203.0.113.10"))
        before = len(self.rows_of("mb"))
        psql(f'UPDATE "AuthSession" SET "lastSeenAt" = now() - interval \'12 hours 1 minute\' WHERE sub=\'{sub}\';')
        status, headers, _ = browser.call("GET", "/dicom-web/studies?limit=1", headers={"X-KIN-Session": browser.session})
        self.assertEqual((status, headers.get("X-KIN-Auth-Code")), (401, "AUTH_SESSION_ENDED"))
        rows = self.rows_of("mb")
        self.assertEqual(before + 1, len(rows))
        self.assertEqual(self.ends("mb")[-1], ("auth.session.expired", "idle", self.groups["B"][0], self.expected_ip),
                         "the proxy-observed address on the DICOM authorization path")
        ip_ok = json.loads(rows[-1]["detail"])["ip"] not in (None, "203.0.113.9", "203.0.113.10", *self.proxy_addresses())
        self.check_rows("AL-10", rows[-1:], ip_ok)
        self.assertTrue(ip_ok)

    def test_11_api_answers_are_not_stored_and_the_account_console_is_closed(self):
        """A016: every /api/ answer is `no-store` - success, refusal, unknown route alike. A018: the Keycloak account
        console is not reachable through the proxy; the login surfaces stay reachable."""
        browser = self.login("ma")
        anonymous = Browser(self.stack)
        answers = [("health", anonymous.call("GET", "/api/health")), ("me without a session", anonymous.call("GET", "/api/me")),
                   ("an unknown route", anonymous.call("GET", "/api/no-such-route-" + uuid.uuid4().hex)),
                   ("me", browser.call("GET", "/api/me")),
                   ("a refused write", browser.call("POST", "/api/auth/logout", data=b""))]
        self.assertEqual([(label, status) for label, (status, _, _) in answers],
                         [("health", 200), ("me without a session", 401), ("an unknown route", 404), ("me", 200), ("a refused write", 403)])
        for label, (_, headers, _) in answers:
            self.assertEqual(headers.get("Cache-Control"), "no-store", label)
        # Every spelling that can reach Keycloak's account console (SEA-F05): a matrix parameter (Keycloak's path matching
        # ignores it), a sub-path, another case, and the forms nginx normalises before it matches a location
        # (%-encoding, a doubled slash, a dot segment).
        for path in ("/auth/realms/kin/account", "/auth/realms/kin/account/", "/auth/realms/kin/account/account-security/signing-in",
                     "/auth/realms/kin/account;x=1", "/auth/realms/kin/account;jsessionid=1/", "/auth/realms/kin/ACCOUNT/",
                     "/auth/realms/KIN/Account", "/auth/realms/kin/%61ccount/", "/auth/realms/kin//account/",
                     "/auth/realms/kin/./account/", "/auth/realms/kin/x/../account/"):
            self.assertEqual(404, browser.call("GET", path)[0], path)
        # The opposite side: discovery and the login form are still served (every login of this suite passes them).
        self.assertEqual(200, anonymous.call("GET", "/auth/realms/kin/.well-known/openid-configuration")[0])
        self.assertEqual(204, self.logout(browser))
        print("S7-U5-AUTH-LIVE " + json.dumps({"case": "AL-11", "rows": 0, "hits": [], "ip_ok": True}))

    def test_11b_login_logout_server_time_and_timezone(self):
        """AL-13: D195 server time + timezone, from real events through DB and console readback.

        Bracket only the BFF callback/logout with health.at (never the client clock). Each bracket must be <= 5 s;
        a 1 s margin allows bounded API/DB clock skew and millisecond rounding, not a slow or stale event.
        A fresh owned member makes the two records unambiguous even though the console does not expose row ids.
        This runs before AL-12 so its rows also pass the owned-fixture cleanup assertions.
        """
        type(self).create_member("mt", "A", ["radiologist"])
        login_window = []
        browser = self.login("mt", server_window=login_window)
        logout_window = [self.server_time(browser)]
        self.assertEqual(204, self.logout(browser))
        logout_window.append(self.server_time(browser))
        rows = self.rows_of("mt")
        self.assertEqual([r["action"] for r in rows], ["auth.login", "auth.logout"], "one row per real event")
        self.assertEqual([json.loads(r["detail"]).get("outcome") or json.loads(r["detail"]).get("cause") for r in rows],
                         ["success", "logout"])
        stored_times = []
        for row, (before, after) in zip(rows, (login_window, logout_window)):
            with self.subTest(action=row["action"]):
                self.assertGreaterEqual(after, before, "server clock does not go backwards during the event")
                self.assertLessEqual(after - before, timedelta(seconds=5), "a tight server-observed event window")
                # Prisma stores UTC in a timestamp column; the SQL read gives that value its UTC timezone,
                # without changing the stored value. The independent product readback must supply its own offset.
                stored = self.explicit_time(row.get("at"), "AuditLog.at")
                self.assertGreaterEqual(stored, before - timedelta(seconds=1), "stored at is not stale")
                self.assertLessEqual(stored, after + timedelta(seconds=1), "stored at is not in the future")
                stored_times.append(stored)
        self.assertLess(stored_times[0], stored_times[1], "login precedes logout by stored at")
        # The console also lists the member's approval row (its target is the same account); only the
        # two access rows of this case are compared, in the console's own order.
        member_rows = [r for r in self.admin_rows("A", limit=2) if r["target"] == self.members["mt"]["id"]]
        self.assertIn("admin.user.approve", [r["action"] for r in member_rows], "console retains the member approval row")
        visible = [r for r in member_rows if r["action"] in AUTH]
        self.assertEqual([r["action"] for r in visible], ["auth.logout", "auth.login"], "console returns newest first")
        read_times = []
        for read, stored in zip(visible, reversed(rows)):
            self.assertEqual((read["actor"], read["target"], read["detail"]),
                             (stored["actor"], stored["target"], json.loads(stored["detail"])), "the same event")
            read_times.append(self.explicit_time(read.get("at"), "admin audit at"))
        self.assertEqual(read_times, list(reversed(stored_times)), "console times are the stored event times")
        self.assertGreater(read_times[0], read_times[1], "console time order agrees with event order")
        self.check_rows("AL-13", rows)

    def test_11c_ward_nat_relogin_and_operator_log_privacy(self):
        """B2R3-05/08/09: 20 real synthetic doctors, two tabs each; DB and protected seal stay on the request path."""
        names = ["ward%02d" % n for n in range(20)]
        for name in names:
            self.create_member(name, "A", ["radiologist"])
        # Establish a real provider/product session for each doctor before the owned restart.
        for name in names:
            self.login(name)
        restart = "owned provider sessions invalidated"
        if os.environ.get("KIN_TEST_OWNED_AUTH_HTTP") == "1":
            done = subprocess.run(["docker", "compose", "restart", "keycloak"], cwd=ROOT, capture_output=True, timeout=120)
            self.assertEqual(done.returncode, 0, "owned Keycloak restart")
            deadline = time.monotonic() + 180
            while True:
                try:
                    if Browser(self.stack).call("GET", "/auth/realms/kin/.well-known/openid-configuration")[0] == 200:
                        break
                except Exception:
                    pass
                if time.monotonic() >= deadline:
                    self.fail("owned provider did not become ready after restart")
                time.sleep(1)
            restart = "owned Keycloak restarted; owned sessions invalidated"
        # Modern providers may persist sessions across restart. Explicitly end only these owned SSO sessions so every
        # tested tab must complete the provider flow; no existing-product-session shortcut can count as a callback.
        for name in names:
            self.assertEqual(self.stack.kc_admin("POST", "/users/" + self.members[name]["id"] + "/logout").status, 204)
        def successful_logins():
            return {name: sum(row["action"] == "auth.login" and json.loads(row["detail"]).get("outcome") == "success"
                              for row in self.rows_of(name)) for name in names}
        def protected_logins():
            subjects = {self.members[name]["id"]: name for name in names}
            counts = {name: 0 for name in names}
            for payload in psql("SELECT payload FROM emr_access.access_entry WHERE stream='viewing'"):
                event = json.loads(payload).get("event", {})
                subject = (event.get("userId", {}).get("value") or {}).get("subject")
                if event.get("action") == "auth.login" and event.get("result") == "succeeded" and subject in subjects:
                    counts[subjects[subject]] += 1
            return counts
        results = []
        for sensitive in (False, True):
            time.sleep(125)  # reset the shared IP budget between independently counted normal workloads
            before, protected_before = successful_logins(), protected_logins()
            def relogin(item):
                name, tab = item
                member, browser = self.members[name], Browser(self.stack)
                if sensitive:
                    status, _, body = browser.call("POST", "/api/auth/login",
                        data=json.dumps({"intent": "reauthenticate", "reason": "storage_untrusted"}).encode(),
                        headers={"Content-Type": "application/json", "X-KIN-CSRF": "1"})
                    self.assertEqual(status, 200)
                    location = json.loads(body)["location"]
                else:
                    status, headers, _ = browser.call("GET", "/api/auth/login")
                    self.assertEqual(status, 302)
                    location = headers["Location"]
                completed = False
                for _ in range(10):
                    parsed = urlparse(location)
                    query = parse_qs(parsed.query)
                    for kind in ("code", "state"):
                        for value in query.get(kind, []):
                            self.secret(kind, value)
                    self.secret("pending", browser.pending())
                    status, headers, body = browser.call("GET", location)
                    self.assertNotEqual(status, 429, "normal ward request was limited")
                    if status == 200:
                        form = re.search(r'<form[^>]+action="([^"]+)"', body, re.I)
                        self.assertIsNotNone(form, "owned provider credential form")
                        status, headers, _ = browser.call("POST", html.unescape(form.group(1)),
                            data=urlencode({"username": member["username"], "password": member["password"], "credentialId": ""}).encode(),
                            headers={"Content-Type": "application/x-www-form-urlencoded"})
                    self.assertEqual(status, 302)
                    location = headers.get("Location", "")
                    if urlparse(location).path == "/worklist/hpacs-lite/main.html":
                        completed = True
                        break
                self.assertTrue(completed, "bounded automatic restart reaches the worklist")
                self.assertIsNotNone(browser.sid())
                self.secret("sid", browser.sid())
                proof = unquote(urlparse(location).fragment.partition("kin-entry=")[2])
                self.assertTrue(proof, "the worklist receives its one-use entry proof")
                self.secret("proof", proof)
                status, _, me = browser.call("GET", "/api/me")
                self.assertEqual(status, 200)
                browser.session = json.loads(me).get("sessionId")
                self.assertTrue(browser.session)
                self.assertEqual(browser.call("POST", "/api/auth/entry", data=json.dumps({"proof": proof}).encode(),
                    headers={"Content-Type": "application/json", "X-KIN-CSRF": "1"})[0], 200)
                return browser.calls
            with ThreadPoolExecutor(max_workers=40) as pool:
                calls = [call for tab_calls in pool.map(relogin, [(name, tab) for name in names for tab in range(2)]) for call in tab_calls]
            auth = [(path, status) for path, status in calls if path.lower().rstrip("/") in ("/api/auth/login", "/api/auth/callback")]
            bff = [(path, status) for path, status in calls if path.lower().startswith("/api/")]
            starts = sum(path == "/api/auth/login" for path, _ in auth)
            callbacks = sum(path == "/api/auth/callback" for path, _ in auth)
            entries = sum(path == "/api/auth/entry" and status == 200 for path, status in bff)
            after, protected_after = successful_logins(), protected_logins()
            by_doctor = {name: after[name] - before[name] for name in names}
            protected_by_doctor = {name: protected_after[name] - protected_before[name] for name in names}
            self.assertEqual(starts, 40); self.assertGreaterEqual(callbacks, 40)
            self.assertEqual(by_doctor, {name: 2 for name in names}, "two successful sign-in projections per doctor")
            self.assertEqual(protected_by_doctor, by_doctor, "each sign-in projection has its protected original")
            self.assertEqual(entries, 40, "all forty tabs complete automatic worklist entry")
            self.assertEqual(sum(status == 429 for _, status in bff), 0)
            if sensitive:
                self.assertGreater(callbacks, 40, "silent SSO probe callbacks and automatic restarts were actually counted")
            result = {"doctors": 20, "tabs_per_doctor": 2, "concurrency": 40, "starts": starts, "callbacks": callbacks,
                "automatic_extra_callbacks": callbacks - 40, "login_callback_requests": len(auth),
                "bff_requests": len(bff), "all_http_requests": len(calls), "worklist_entries": entries, "limited": 0,
                "recorded_signins": sum(by_doctor.values()), "protected_signin_facts": sum(protected_by_doctor.values()),
                "signins_per_doctor": 2, "unrecorded_signins": 0, "database": True, "seal": True,
                "scenario": "silent SSO restart" if sensitive else "relogin", "provider_reset": restart}
            results.append(result)
            print("B2_NAT_CAPACITY " + json.dumps(result))
        # Compare freshly generated tokens too, in memory only. Fixture evidence redaction cannot satisfy this check.
        for name in names:
            rows = psql('SELECT "accessToken" || E\'\\t\' || "refreshToken" FROM "AuthSession" WHERE sub=\''
                        + self.members[name]["id"] + '\';')
            for row in rows:
                access, refresh = row.split("\t", 1)
                self.secret("access", access); self.secret("refresh", refresh)
        # Inspect original bytes before evidence redaction, including an oversized request with a generated query and
        # Referer. Its HTTP error metadata must survive without either value.
        secret = uuid.uuid4().hex
        self.secret("operator-query", secret)
        browser = Browser(self.stack)
        browser.call("POST", "/api/auth/login?secret=" + secret, data=b"x" * (2 * 1024 * 1024 + 1),
                     headers={"Referer": self.stack.proxy + "/?token=" + secret})
        done = subprocess.run(["docker", "compose", "logs", "--no-color", "--no-log-prefix"], cwd=ROOT,
                              capture_output=True, timeout=60)
        self.assertEqual(done.returncode, 0)
        operators = (done.stdout + done.stderr).decode("utf-8", "replace")
        ledger = psql('SELECT payload FROM emr_access.access_entry')
        hits = secret_hits([operators, *ledger], self.secrets)
        self.assertEqual(hits, [], "generated secret kinds in raw ledger/operator output")
        metadata = [json.loads(line) for line in self.proxy_log().splitlines() if line.startswith('{')]
        self.assertTrue(any(row.get("status") == 413 for row in metadata), "HTTP failure metadata remains observable")
        self.assertTrue(all({"at", "remote", "method", "path", "status", "seconds", "upstream_status", "limit"} <= row.keys() for row in metadata))
        auth_metadata = [row for row in metadata if row["path"].lower().rstrip("/") in ("/api/auth/login", "/api/auth/callback")]
        self.assertEqual({row["remote"] for row in auth_metadata}, {self.expected_ip}, "the ward flows really share one proxy-observed address")
        print("B2_OPERATOR_PRIVACY " + json.dumps({"secret_kind_hits": hits, "raw_logs": True, "posthoc_redaction": False,
                                                   "nat_scenarios": len(results), "nat_addresses": 1, "access_metadata": True}))

    def test_12_cleanup_leaves_no_owned_row_or_session(self):
        type(self).purge_owned_rows()
        ids = self.owned_ids()
        listed = ",".join(f"'{i}'" for i in ids)
        actions = ",".join(f"'{a}'" for a in AUTH + ("auth.entry",))
        self.assertEqual(["0"], psql(f'SELECT count(*) FROM "AuditLog" WHERE target IN ({listed}) AND action IN ({actions});'))
        self.assertEqual(["0"], psql(f'SELECT count(*) FROM "AuthSession" WHERE sub IN ({listed});'))
        self.assertEqual(["0"], psql(f'SELECT count(*) FROM "ProviderChange" WHERE sub IN ({listed});'))
        self.assertEqual(["0"], psql(f'SELECT count(*) FROM "MemberRights" WHERE sub IN ({listed});'))
        if getattr(type(self), "failure_ids", None):
            self.assertEqual(["0"], psql('SELECT count(*) FROM "AuditLog" WHERE id IN (' + ",".join(map(str, self.failure_ids)) + ");"))
        print("S7-U5-AUTH-LIVE " + json.dumps({"case": "AL-12", "rows": 0, "hits": [], "ip_ok": True}))


if __name__ == "__main__":
    unittest.main(verbosity=2)
