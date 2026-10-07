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
(A, radiologist), mb (B, technician), mm (A, moved to B), mp (no group: PENDING), mi2 (two groups: INVALID) and mi1 (one
group, no role: INVALID), created with passwords through the Keycloak admin API. Cleanup: the members' and admins' access
rows by target and actor (past the AuditLog append-only guard, as the owned-row cleanup of tests/invariants_live.py does),
their sessions by sub, the members and the groups.
"""
from __future__ import annotations

import html
import http.cookiejar
import json
import re
import subprocess
import sys
import unittest
import uuid
from ipaddress import ip_address
from urllib.error import HTTPError
from urllib.parse import parse_qs, quote, unquote, urlencode, urlparse
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
                return response.status, dict(response.headers), response.read().decode("utf-8", "replace")
        except HTTPError as error:
            return error.code, dict(error.headers or {}), error.read().decode("utf-8", "replace")

    def cookie(self, name):
        return next((c.value for c in self.jar if c.name == name), None)

    def pending(self):
        """The newest pending login flow of this profile (one cookie per flow: kin_pending_<derived from its state>)."""
        return next((c.value for c in reversed(list(self.jar)) if c.name.startswith("kin_pending_")), None)

    def sid(self):
        return self.cookie("kin_sid")


class AuthAuditLive(unittest.TestCase):
    secrets: list = []
    provider_sessions: list = []

    @classmethod
    def setUpClass(cls) -> None:
        declared = [name for name in sorted(vars(cls)) if name.startswith("test_")]
        if list(CASES) != declared:
            raise RuntimeError(f"CASES {CASES} differ from the declared cases {declared}")
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
        else:
            cls.stack.set_member_rights(user_id, approvalState="PENDING")
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
        'unknown': they are removed by the run's own failure-row ids, kept in cls.failure_ids), then the sessions."""
        for user_id in cls.owned_ids():
            purge_user_audit(user_id)
            psql(f'DELETE FROM "AuthSession" WHERE sub=\'{user_id}\';')
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
        return done.stdout

    @classmethod
    def proxy_addresses(cls) -> list:
        done = subprocess.run(["docker", "compose", "exec", "-T", "proxy", "hostname", "-i"], cwd=ROOT, capture_output=True,
                              text=True, encoding="utf-8", errors="replace", timeout=60)
        if done.returncode:
            raise RuntimeError("harness: the proxy container address could not be read")
        return done.stdout.split()

    @classmethod
    def observed_ip(cls) -> str:
        """One marked request through the proxy; the first field of the one nginx log line that carries the mark."""
        mark = "u5probe=" + uuid.uuid4().hex
        status, _headers, _body = Browser(cls.stack).call("GET", "/api/health?" + mark)
        if status != 200:
            raise RuntimeError(f"harness: the probe request answered {status}")
        lines = [line for line in cls.proxy_log().splitlines() if mark in line]
        if len(lines) != 1:
            raise RuntimeError(f"harness: the probe mark is in {len(lines)} proxy log lines (need exactly one)")
        address = lines[0].split(" ", 1)[0]
        ip_address(address)
        return address

    # ── the BFF login, one redirect at a time ──
    def login(self, name: str, browser: Browser | None = None, *, refused: bool = False) -> Browser:
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
        status, headers, _ = browser.call("GET", callback)
        if refused:
            self.assertEqual((status, urlparse(headers.get("Location", "")).path), (302, "/worklist/hpacs-lite/index.html"))
            self.assertIsNone(browser.sid(), "pending member receives no product session")
            self.assertEqual(browser.call("GET", "/api/me")[0], 401)
            return browser
        self.assertEqual((status, urlparse(headers.get("Location", "")).path), (302, "/worklist/hpacs-lite/main.html"))
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
        out = psql(f'SELECT json_build_object(\'id\', id, \'actor\', actor, \'action\', action, \'target\', target, \'detail\', detail)::text '
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

    def admin_view(self, key: str, limit: int = 100) -> set:
        """(action, target, cause/outcome, institution) of the access rows admin `key` reads, every page."""
        seen, after = set(), None
        for _ in range(50):
            query = f"limit={limit}" + (f"&after={quote(after)}" if after else "")
            answer = self.stack.request("GET", "/admin/audit?" + query, f"u5-admin-{key.lower()}")
            self.assertEqual(answer.status, 200, answer.text)
            for row in answer.body["rows"]:
                if row["action"] in AUTH:
                    self.assertEqual(sorted(row["detail"]), KEYS[shape_of(row["action"], row["detail"])])
                    seen.add((row["action"], row["target"], row["detail"].get("cause") or row["detail"].get("outcome"),
                              row["detail"].get("institution")))
            after = answer.body.get("next")
            if not after:
                return seen
        raise RuntimeError("harness: the admin audit read did not end")

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
            self.assertEqual(204, self.logout(self.login(name, refused=True)), name)
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

    def test_12_cleanup_leaves_no_owned_row_or_session(self):
        type(self).purge_owned_rows()
        ids = self.owned_ids()
        listed = ",".join(f"'{i}'" for i in ids)
        actions = ",".join(f"'{a}'" for a in AUTH + ("auth.entry",))
        self.assertEqual(["0"], psql(f'SELECT count(*) FROM "AuditLog" WHERE target IN ({listed}) AND action IN ({actions});'))
        self.assertEqual(["0"], psql(f'SELECT count(*) FROM "AuthSession" WHERE sub IN ({listed});'))
        if getattr(type(self), "failure_ids", None):
            self.assertEqual(["0"], psql('SELECT count(*) FROM "AuditLog" WHERE id IN (' + ",".join(map(str, self.failure_ids)) + ");"))
        print("S7-U5-AUTH-LIVE " + json.dumps({"case": "AL-12", "rows": 0, "hits": [], "ip_ok": True}))


if __name__ == "__main__":
    unittest.main(verbosity=2)
