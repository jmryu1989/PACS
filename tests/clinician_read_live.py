# coding: utf-8
"""TEST-S5-U1b-LIVE: the clinician read contract on the real Nest guard, Prisma, Keycloak, Orthanc and nginx.

REQ-S5-U1b-CLINICIAN-READ -> RISK-S5-U1b-DRAFT-LEAK / NONFINAL-BODY / WRITER-FIELD / COUNT-LEAK / TENANT-UID.
Hosted synthetic stack only, through scripts/run-tests.py (never the original DB, DICOM or accounts):

    python scripts/run-tests.py --module tests/clinician_read_live.py --mode live --unit s5-u1b-clinician-read --timeout 900

Per allow row: a positive read, a wrong-role negative and a wrong-tenant negative. Plus: member revocation on the
credentials the member already held (the BFF session is refused at once, a new token is PENDING, a Bearer issued
before the revocation is reported until and after its exp, never counted as revoked early), a final report turns
into status only after reset, the same user reading A -> B -> A gets each study's own answer, and two races placed
with pauses inside the compiled controller/services (S5-U1b-F01 reset -> re-approve between the viewer gates,
S5-U1b-F02 an Addendum between the list's StudyState and Report reads). Field sets come from
tests/clinician_policy_fixtures.json read_contract, shared with the pure serializer test, so the live answer and the
pure projection are held to one list.

Owned data only: run-created Keycloak users (kin-test-*), the run's password-grant client, one run-owned
short-lifespan password-grant client for the revocation case, the realm role `clinician` only when this run had to
create it, and C-STORE fixtures whose viewer rows are removed in dependency order before the fixture's own cleanup
(the product has no DELETE for them). The race driver runs `node` inside kin-api (as invariants_live's admin row
check does) against this run's fixtures with the clinician identity this run created; it writes nothing itself.
"""
from __future__ import annotations

import base64
import html
import http.cookiejar
import json
import re
import subprocess
import sys
import time
import unittest
import uuid
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import HTTPCookieProcessor, HTTPSHandler, Request, build_opener

from invariants_live import HttpResult, LiveStack, _json_or_text, psql, purge_user_audit

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = json.loads((ROOT / "tests" / "clinician_policy_fixtures.json").read_text(encoding="utf-8"))
C = FIXTURES["read_contract"]
DENIED = FIXTURES["denied_code"]
FORBIDDEN = set(C["forbidden_keys"])
OWNED_USERNAME = re.compile(r"kin-test-[0-9a-f]{12}-[a-z0-9_-]+")
# The revocation case waits for the kept Bearer's exp. The realm lifespan (1800 s) does not fit the unit budget, so
# that Bearer comes from a run-owned client whose only difference is this lifespan; the guard never reads azp for members.
SHORT_BEARER_SECONDS = 120
CLIENT_MAPPERS = (
    {"name": "kin-api-audience", "protocol": "openid-connect", "protocolMapper": "oidc-audience-mapper",
     "consentRequired": False, "config": {"included.custom.audience": "kin-api", "id.token.claim": "false",
                                          "access.token.claim": "true"}},
    {"name": "kin-institution-groups", "protocol": "openid-connect", "protocolMapper": "oidc-group-membership-mapper",
     "consentRequired": False, "config": {"full.path": "false", "id.token.claim": "false", "access.token.claim": "true",
                                          "userinfo.token.claim": "false", "claim.name": "groups"}},
)

# Runs inside kin-api on the compiled code. It builds the real ViewerController/ViewerService/PacsService on the
# real Prisma and Orthanc, and pauses at named points ("head", "read", "state"): it prints one event and waits for
# one line on stdin, while the Python side commits report changes through the public API. Nothing here writes.
DRIVER = r"""
'use strict';
const readline = require('node:readline');
const { PrismaService } = require('/app/dist/prisma.service');
const { OrthancService } = require('/app/dist/orthanc.service');
const { StudyAccessService } = require('/app/dist/study-access.service');
const { ViewerService } = require('/app/dist/viewer.service');
const { PacsService } = require('/app/dist/pacs.service');
const { ViewerController } = require('/app/dist/viewer.controller');

const args = JSON.parse(process.argv[1]);
const say = (event, detail = {}) => process.stdout.write('KIN-U1B ' + JSON.stringify({ event, ...detail }) + '\n');
const inbox = [], waiting = [];
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => { const next = waiting.shift(); if (next) next(line); else inbox.push(line); });
const pause = (event, detail) => new Promise(resolve => {
  say(event, detail);
  if (inbox.length) resolve(inbox.shift()); else waiting.push(resolve);
});
const failure = error => ({ status: typeof error?.getStatus === 'function' ? error.getStatus() : 500,
  body: typeof error?.getResponse === 'function' ? error.getResponse() : String(error?.message ?? error) });
const watchdog = setTimeout(() => { say('timeout'); process.exit(3); }, 150000);

const prisma = new PrismaService(), orthanc = new OrthancService();
const access = new StudyAccessService(prisma, orthanc, {});

async function viewer() {
  const pacs = new PacsService(prisma, orthanc, {}, access, {});
  const items = new ViewerService(prisma, orthanc, access);
  const heads = [];
  const gate = { clinicianViewerHead: async (uid, c) => {
    const version = await pacs.clinicianViewerHead(uid, c);
    heads.push(version);
    if (heads.length === 1) await pause('head', { version });
    return version;
  } };
  const service = { listFinal: async (uid, query, c, version) => {
    const page = await items.listFinal(uid, query, c, version);
    await pause('read', { finalVersion: page.finalVersion, ids: page.items.map(item => item.id) });
    return page;
  } };
  const controller = new ViewerController(service, gate);
  try { say('result', { status: 200, body: await controller.list(args.uid, {}, args.caller), heads }); }
  catch (error) { say('result', { ...failure(error), heads }); }
}

async function list() {
  let paused = false;
  const reports = prisma.report;
  const pausedReports = new Proxy(reports, { get(target, key) {
    if (key !== 'findMany') return Reflect.get(target, key);
    return async query => {
      const uids = query?.where?.uid?.in;
      if (!paused && Array.isArray(uids) && uids.includes(args.uid)) { paused = true; await pause('state'); }
      return target.findMany(query);
    };
  } });
  const db = new Proxy(prisma, { get(target, key) {
    if (key === 'report') return pausedReports;
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const pacs = new PacsService(db, orthanc, {}, access, {});
  await pacs.reloadInstitutions();
  let query = args.paged ? { limit: '100' } : {};
  for (let page = 0; page < 1000; page++) {
    let answer;
    try { answer = await pacs.clinicianStudies(args.caller, query); }
    catch (error) { say('result', { ...failure(error), paused }); return; }
    const row = answer.studies.find(study => study.uid === args.uid);
    if (row || !answer.pagination?.next) { say('result', { status: 200, row: row ?? null, paused }); return; }
    query = { limit: '100', after: answer.pagination.next };
  }
  say('result', { status: 500, body: 'page limit', paused });
}

let exit = 0;
(args.mode === 'viewer' ? viewer() : list())
  .catch(error => { exit = 2; say('error', { message: String(error?.stack ?? error) }); })
  .finally(async () => { clearTimeout(watchdog); input.close(); await prisma.$disconnect(); process.exit(exit); });
"""


def outcome(result: dict) -> tuple:
    """(status, code) of a driver result; a 200 carries no code."""
    body = result.get("body")
    return result.get("status"), body.get("code") if isinstance(body, dict) else None


def jwt_claims(token: str) -> dict:
    """Read exp/iat of a token this run was issued; the signature is the API's business, not this test's."""
    body = token.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))


def literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def deep_keys(value, out=None) -> set[str]:
    out = set() if out is None else out
    if isinstance(value, list):
        for item in value:
            deep_keys(item, out)
    elif isinstance(value, dict):
        for key, item in value.items():
            out.add(key)
            deep_keys(item, out)
    return out


def code(result: HttpResult):
    return result.body.get("code") if isinstance(result.body, dict) else None


class ClinicianReadStack(LiveStack):
    def cleanup_fixture(self, uid: str) -> None:
        if uid in self.active and re.fullmatch(r"[0-9.]+", uid):
            # Viewer rows reference StudyState with RESTRICT; remove this run's own rows child-first.
            psql("BEGIN; "
                 f'DELETE FROM "ViewerRequest" WHERE "itemId" IN (SELECT id FROM "ViewerItem" WHERE "studyUid"={literal(uid)}); '
                 f'DELETE FROM "ViewerRevision" WHERE "itemId" IN (SELECT id FROM "ViewerItem" WHERE "studyUid"={literal(uid)}); '
                 f'DELETE FROM "ViewerItem" WHERE "studyUid"={literal(uid)}; '
                 f'DELETE FROM "ViewerStorageBudget" WHERE "studyUid"={literal(uid)}; COMMIT;')
        super().cleanup_fixture(uid)


class ClinicianReadLive(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.stack = ClinicianReadStack()
        cls.addClassCleanup(cls.stack.cleanup_test_identities)
        cls.addClassCleanup(cls.stack.cleanup_all)
        cls.stack.require_stack()
        cls.created_role = False
        cls.owned_users: list[str] = []
        role = cls.stack.kc_admin("GET", "/roles/clinician")
        if role.status == 404:
            created = cls.stack.kc_admin("POST", "/roles", {"name": "clinician", "description": "temporary S5-U1b clinician role"})
            if created.status != 201:
                raise RuntimeError(f"clinician role creation failed: {created.status} {created.text}")
            cls.created_role = True
        elif role.status != 200:
            raise RuntimeError(f"clinician role lookup failed: {role.status} {role.text}")
        cls.addClassCleanup(cls.delete_role_if_created)
        cls.addClassCleanup(cls.delete_owned_users)
        cls.stack.create_test_identity("clinician", ["clinician"], "hallym")
        cls.stack.create_test_identity("kclinician", ["clinician"], "kin-center")
        for user in ("clinician", "kclinician"):
            cls.stack.token(user)
        # A preliminary needs this run's reviewer in the product's colleague cache (viewer_api_test does the same).
        started, reviewer = time.monotonic(), cls.stack.actor("jmryu")
        while True:
            peers = cls.stack.request("GET", "/colleagues", "doctor")
            if peers.status != 200:
                raise RuntimeError(f"colleague readiness failed: HTTP {peers.status}")
            if reviewer in {peer["id"] for peer in peers.body}:
                break
            if time.monotonic() - started >= 70:
                raise RuntimeError("this run's reviewer did not become visible before the readiness deadline")
            time.sleep(1)

    @classmethod
    def delete_role_if_created(cls) -> None:
        if not cls.created_role:
            return
        # a fresh admin token: the unit now waits for a Bearer's exp, longer than a master-realm admin token may live
        cls.stack._admin_login()
        deleted = cls.stack.kc_admin("DELETE", "/roles/clinician")
        if deleted.status not in (204, 404):
            raise RuntimeError(f"temporary clinician role cleanup failed: {deleted.status}")
        cls.created_role = False

    @classmethod
    def delete_owned_users(cls) -> None:
        failures = []
        if cls.owned_users:
            cls.stack._admin_login()
        for user_id in reversed(cls.owned_users):
            deleted = cls.stack.kc_admin("DELETE", f"/users/{quote(user_id)}")
            if deleted.status not in (204, 404):
                failures.append(f"{user_id}: {deleted.status}")
            else:
                purge_user_audit(user_id)
        cls.owned_users.clear()
        if failures:
            raise RuntimeError("owned member cleanup failed: " + "; ".join(failures))

    # ── helpers ──

    def call(self, method: str, path: str, user: str, body=None, status: int = 200) -> HttpResult:
        result = self.stack.request(method, path, user, body)
        self.assertEqual(result.status, status, f"{method} {path} as {user}: {result.text[:400]}")
        return result

    def assert_route_denied(self, method: str, path: str, user: str, body=None) -> None:
        result = self.stack.request(method, path, user, body)
        self.assertEqual((result.status, code(result)), (403, DENIED), f"{method} {path}: {result.text[:300]}")

    def assert_role_denied(self, path: str, user: str) -> None:
        result = self.stack.request("GET", path, user)
        self.assertEqual(result.status, 403, result.text)
        self.assertNotEqual(code(result), DENIED, "need('clinician') decides, not the clinician-only gate")
        self.assertIn("clinician 권한", result.body.get("message", ""), result.text)

    def assert_clean(self, value, label: str) -> None:
        self.assertEqual(sorted(deep_keys(value) & FORBIDDEN), [], label + ": a writer/engineering field reached the clinician")

    def commit(self, uid: str, action: str, base: int, user: str = "doctor", **extra) -> int:
        body = {"action": action, "baseVersion": base, "findings": extra.pop("findings", ""),
                "conclusion": extra.pop("conclusion", ""), "recommendation": extra.pop("recommendation", ""), **extra}
        result = self.stack.request("POST", f"/studies/{quote(uid)}/report/commit", user, body)
        self.assertEqual(result.status, 201, f"{action}: {result.text[:300]}")
        return result.body["version"]

    def add_key(self, uid: str, title: str) -> dict:
        instance = self.stack.first_instance_id(uid)
        tags = self.stack._orthanc_request("GET", f"/instances/{quote(instance)}/tags?simplify")
        self.assertEqual(tags.status, 200, tags.text)
        item = {"schemaVersion": 1, "kind": "key", "seriesUid": tags.body["SeriesInstanceUID"],
                "sopUid": tags.body["SOPInstanceUID"], "frame": 1, "title": title, "description": ""}
        return self.call("POST", f"/studies/{quote(uid)}/viewer-items", "doctor",
                         {"requestId": str(uuid.uuid4()), "item": item}).body

    def report(self, uid: str, user: str = "clinician", status: int = 200) -> HttpResult:
        return self.call("GET", f"/clinician/studies/{quote(uid)}/report", user, status=status)

    def items(self, uid: str, user: str = "clinician", query: str = "", status: int = 200) -> HttpResult:
        return self.call("GET", f"/studies/{quote(uid)}/viewer-items{query}", user, status=status)

    def assert_open(self, answer: dict, uid: str, rs: str | None, *secrets: str) -> None:
        self.assertEqual(sorted(answer), sorted(C["report_read_keys"]))
        self.assertEqual(answer["uid"], uid)
        self.assertEqual(answer["report"], {"final": False, "rs": rs})
        self.assertIsNone(answer["keys"], "keys are withheld (null), not an empty list")
        for secret in secrets:
            self.assertNotIn(secret, json.dumps(answer, ensure_ascii=False))
        self.assert_clean(answer, "open report " + uid)

    def clinician_rows(self, user: str) -> list[dict]:
        rows, after, total = [], None, None
        for _ in range(1000):
            query = "?limit=100" + ("&after=" + quote(after, safe="") if after else "")
            page = self.call("GET", "/clinician/studies" + query, user).body
            self.assertEqual(sorted(page), sorted(C["list_paged_response_keys"]))
            pagination = page["pagination"]
            self.assertEqual(sorted(pagination), sorted(C["pagination_keys"]))
            total = pagination["total"] if total is None else total
            self.assertEqual(pagination["total"], total)
            self.assertEqual(pagination["offset"], len(rows))
            for row in page["studies"]:
                self.assertEqual(sorted(row), sorted(C["list_row_keys"]), row.get("uid"))
            self.assert_clean(page, "clinician list page")
            rows += page["studies"]
            after = pagination["next"]
            if after is None:
                break
        self.assertEqual(len(rows), total, "total counts exactly the rows the caller can page through")
        return rows

    def worklist_uids(self, user: str) -> set[str]:
        return {row["uid"] for row in self.call("GET", "/studies", user).body["studies"]}

    def create_member(self, logical: str) -> tuple[str, str, str]:
        username = f"kin-test-{uuid.uuid4().hex[:12]}-{logical}"
        self.assertRegex(username, OWNED_USERNAME)
        password = uuid.uuid4().hex + "Aa1!"
        created = self.stack.kc_admin("POST", "/users", {
            "username": username, "enabled": True, "emailVerified": True,
            "email": username + "@local.test", "firstName": "KIN", "lastName": logical,
        })
        self.assertEqual(created.status, 201, created.text)
        user_id = str(created.body)
        self.owned_users.append(user_id)
        reset = self.stack.kc_admin("PUT", f"/users/{quote(user_id)}/reset-password",
                                    {"type": "password", "value": password, "temporary": False})
        self.assertEqual(reset.status, 204, reset.text)
        return user_id, username, password

    def grant(self, username: str, password: str, client_id: str | None = None) -> str:
        data = urlencode({"client_id": client_id or self.stack.test_client_id, "grant_type": "password",
                          "username": username, "password": password}).encode("ascii")
        request = Request(self.stack.keycloak, data=data,
                          headers={"Content-Type": "application/x-www-form-urlencoded"}, method="POST")
        try:
            with self.stack._open(request) as response:
                return json.loads(response.read().decode("utf-8"))["access_token"]
        except HTTPError as error:
            self.fail(f"password grant failed for {username}: {error.code} {error.read()[:200]!r}")

    def short_lived_client(self) -> str:
        """A run-owned password-grant client identical to the run's own except for SHORT_BEARER_SECONDS."""
        self.stack._admin_login()
        client_id = "kin-u1b-revoke-" + uuid.uuid4().hex[:12]
        created = self.stack.kc_admin("POST", "/clients", {
            "clientId": client_id, "name": "KIN S5-U1b revocation probe", "enabled": True, "publicClient": True,
            "standardFlowEnabled": False, "directAccessGrantsEnabled": True, "serviceAccountsEnabled": False,
            "protocol": "openid-connect", "attributes": {"access.token.lifespan": str(SHORT_BEARER_SECONDS)},
        })
        self.assertEqual(created.status, 201, created.text)
        client_uuid = str(created.body)
        self.addCleanup(self.delete_client, client_uuid)
        for mapper in CLIENT_MAPPERS:
            added = self.stack.kc_admin("POST", f"/clients/{quote(client_uuid)}/protocol-mappers/models", mapper)
            self.assertEqual(added.status, 201, added.text)
        return client_id

    def delete_client(self, client_uuid: str) -> None:
        self.stack._admin_login()
        deleted = self.stack.kc_admin("DELETE", f"/clients/{quote(client_uuid)}")
        if deleted.status not in (204, 404):
            raise RuntimeError(f"revocation probe client cleanup failed: {deleted.status}")

    def bff_session(self, username: str, password: str) -> str:
        """The browser's own login (BffInvariantTests.bff_login): /api/auth/login -> Keycloak form -> callback."""
        jar = http.cookiejar.CookieJar()
        opener = build_opener(HTTPCookieProcessor(jar), HTTPSHandler(context=self.stack.context))
        with opener.open(Request(self.stack.proxy + "/api/auth/login", headers={"Accept": "application/json"},
                                 method="GET"), timeout=30) as response:
            page = response.read().decode("utf-8", errors="replace")
        form = re.search(r'<form[^>]+action="([^"]+)"', page, re.I)
        self.assertIsNotNone(form, "no Keycloak login form")
        data = urlencode({"username": username, "password": password, "credentialId": ""}).encode("utf-8")
        with opener.open(Request(html.unescape(form.group(1)), data=data, method="POST",
                                 headers={"Content-Type": "application/x-www-form-urlencoded"}), timeout=30) as response:
            response.read()
        sid = next((cookie.value for cookie in jar if cookie.name == "kin_sid"), None)
        self.assertIsNotNone(sid, "no kin_sid after the BFF login")
        return sid

    def session_call(self, sid: str, method: str, path: str, body: Any = None) -> HttpResult:
        """One call on the kept session id. No cookie jar: an expiring Set-Cookie must not swap the credential."""
        headers = {"Accept": "application/json" if path.startswith("/api/") else "*/*", "Cookie": "kin_sid=" + sid}
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers.update({"Content-Type": "application/json", "X-KIN-CSRF": "1"})
        opener = build_opener(HTTPSHandler(context=self.stack.context))
        try:
            with opener.open(Request(self.stack.proxy + path, data=data, headers=headers, method=method), timeout=30) as response:
                payload, text = _json_or_text(response.read())
                return HttpResult(response.status, payload, text)
        except HTTPError as error:
            payload, text = _json_or_text(error.read())
            return HttpResult(error.code, payload, text)

    def through(self, kind: str, secret: str, row: tuple) -> HttpResult:
        _name, method, path, body = row
        if kind == "session":
            return self.session_call(secret, method, path, body)
        return self.stack.bearer_request(method, path, secret, body, base=self.stack.proxy,
                                         headers=None if path.startswith("/api/") else {"Accept": "*/*"})

    def drive(self, mode: str, uid: str, steps: dict[str, Callable[[dict], None]], **extra) -> list[dict]:
        """Run DRIVER in kin-api. At each pause run steps[event] (if any), then release the pause."""
        caller = {"sub": self.stack.user_ids["clinician"], "actor": self.stack.actor("clinician"),
                  "roles": ["clinician"], "institution": "hallym", "kind": "member"}
        payload = json.dumps({"mode": mode, "uid": uid, "caller": caller, **extra})
        process = subprocess.Popen(["docker", "exec", "-i", "kin-api", "node", "-e", DRIVER, payload],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                   text=True, encoding="utf-8", errors="replace")
        events: list[dict] = []
        noise: list[str] = []
        try:
            while True:
                line = process.stdout.readline()
                if not line:
                    break
                if not line.startswith("KIN-U1B "):
                    noise.append(line)
                    continue
                event = json.loads(line[len("KIN-U1B "):])
                events.append(event)
                if event["event"] in ("result", "error", "timeout"):
                    break
                step = steps.get(event["event"])
                if step is not None:
                    step(event)
                process.stdin.write("GO\n")
                process.stdin.flush()
            rest, _ = process.communicate(timeout=60)
            noise.append(rest or "")
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()
        tail = "".join(noise)[-2000:]
        self.assertTrue(events and events[-1]["event"] == "result", f"driver ended without a result: {events} {tail}")
        self.assertEqual(process.returncode, 0, tail)
        return events

    # ── tests ──

    def test_01_list_row_is_narrow_counts_only_visible_studies_and_keeps_role_gates(self) -> None:
        with self.stack.fixture() as fixture:
            uid = fixture.uid
            draft = "U1B-DRAFT-" + uuid.uuid4().hex
            self.call("PUT", f"/studies/{quote(uid)}/report", "doctor2",
                      {"findings": draft, "conclusion": "", "recommendation": "", "baseVersion": 0})
            self.commit(uid, "approve", 0, findings=fixture.secret, conclusion="approved")

            rows = self.clinician_rows("clinician")
            listed = {row["uid"]: row for row in rows}
            self.assertIn(uid, listed)
            row = listed[uid]
            self.assertEqual(row["report"], {"final": True, "rs": "A", "action": "approve", "version": 1,
                                             "repDoc": self.stack.actor("doctor").split("@")[0], "confirm": row["report"]["confirm"]})
            self.assertIn(row["report"]["confirm"], {datetime.now(timezone.utc).date().isoformat(), date.today().isoformat()})
            self.assertEqual((row["tele"], row["institutionName"] != ""), (False, True))
            text = json.dumps(rows, ensure_ascii=False)
            for secret in (fixture.secret, draft):
                self.assertNotIn(secret, text, "the list carries status only, never a body or a draft")
            # COUNT-LEAK / TENANT-UID: the clinician sees exactly the studies the same institution's worklist sees.
            self.assertEqual(set(listed), self.worklist_uids("doctor"))
            unpaged = self.call("GET", "/clinician/studies", "clinician").body
            self.assertEqual(sorted(unpaged), sorted(C["list_response_keys"]))
            self.assertEqual({r["uid"] for r in unpaged["studies"]}, set(listed))
            self.assert_clean(unpaged, "unpaged clinician list")
            other = self.clinician_rows("kclinician")
            self.assertNotIn(uid, {r["uid"] for r in other}, "another institution's clinician must not list it")
            self.assertEqual({r["uid"] for r in other}, self.worklist_uids("kdoctor"))

            # wrong role: the narrow list is a clinician read; radiologist and technician keep their own worklist
            for user in ("doctor", "tech"):
                with self.subTest(wrong_role=user):
                    self.assert_role_denied("/clinician/studies", user)
            self.call("GET", "/clinician/studies?limit=0", "clinician", status=400)
            # the broad surfaces stay closed to clinician-only
            for method, path in (("GET", "/studies"), ("GET", "/bootstrap"), ("GET", "/prefs"),
                                 ("GET", f"/studies/{quote(uid)}/report-preview"), ("GET", f"/audit?uid={quote(uid)}"),
                                 ("GET", f"/studies/{quote(uid)}/report/versions")):
                with self.subTest(denied=path):
                    self.assert_route_denied(method, path, "clinician")
            actor = self.stack.actor("clinician").replace("'", "''")
            self.assertEqual(psql(f"SELECT count(*) FROM \"AuditLog\" WHERE actor='{actor}'"), ["0"], "reads write no audit")

    def test_02_report_read_follows_the_head_row_final_then_reset_back_to_status(self) -> None:
        with self.stack.fixture() as fixture:
            uid, secret = fixture.uid, fixture.secret
            draft = "U1B-DRAFT-" + uuid.uuid4().hex
            self.assert_open(self.report(uid).body, uid, "W")
            self.call("PUT", f"/studies/{quote(uid)}/report", "doctor2",
                      {"findings": draft, "conclusion": "", "recommendation": "", "baseVersion": 0})
            key = self.add_key(uid, "S5-U1b key " + uuid.uuid4().hex[:8])
            self.assert_open(self.report(uid).body, uid, "W", draft)
            self.assertEqual(self.items(uid).body, {"uid": uid, "final": False, "items": None, "nextCursor": None})

            v = self.commit(uid, "save", 0, findings=secret + " saved")
            self.assert_open(self.report(uid).body, uid, "T", secret, draft)
            v = self.commit(uid, "approve", v, findings=secret, conclusion="approved", recommendation="none")
            answer = self.report(uid).body
            self.assertEqual(sorted(answer), sorted(C["report_read_keys"]))
            self.assertEqual(sorted(answer["report"]), sorted(C["report_final_keys"] + C["report_body_keys"]))
            self.assertEqual((answer["uid"], answer["report"]["final"], answer["report"]["action"], answer["report"]["version"]),
                             (uid, True, "approve", v))
            self.assertEqual((answer["report"]["findings"], answer["report"]["conclusion"], answer["report"]["recommendation"]),
                             (secret, "approved", "none"))
            self.assertEqual([k["id"] for k in answer["keys"]], [key["id"]])
            self.assertEqual(sorted(answer["keys"][0]), sorted(C["key_image_keys"]))
            self.assertEqual(sorted(answer["keys"][0]["item"]), sorted(C["snapshot_keys"]["key"]))
            self.assertNotIn(draft, json.dumps(answer, ensure_ascii=False), "another radiologist's draft never rides along")
            self.assert_clean(answer, "final report")
            page = self.items(uid).body
            self.assertEqual((page["uid"], page["final"], [i["id"] for i in page["items"]]), (uid, True, [key["id"]]))
            self.assert_clean(page, "final viewer items")

            v = self.commit(uid, "addendum", v, findings=secret + " addendum", conclusion="approved", recommendation="none")
            answer = self.report(uid).body
            self.assertEqual((answer["report"]["action"], answer["report"]["version"], answer["report"]["findings"]),
                             ("addendum", v, secret + " addendum"))

            # NONFINAL-BODY: reset turns the approved body into status only, for the report and the viewer items.
            v = self.commit(uid, "reset", v, reason="S5-U1b reset")
            self.assert_open(self.report(uid).body, uid, "W", secret, draft)
            self.assertEqual(self.items(uid).body, {"uid": uid, "final": False, "items": None, "nextCursor": None})
            v = self.commit(uid, "preliminary", v, findings=secret + " prelim", reviewer=self.stack.actor("jmryu"))
            self.assert_open(self.report(uid).body, uid, "P", secret, draft)
            self.assertEqual(self.items(uid).body["final"], False)

            for user in ("doctor", "tech"):
                with self.subTest(wrong_role=user):
                    self.assert_role_denied(f"/clinician/studies/{quote(uid)}/report", user)
            self.report(uid, "kclinician", status=404)
            self.call("GET", "/clinician/studies/not-a-uid/report", "clinician", status=400)

    def test_03_viewer_pair_items_statistics_and_the_tele_boundary(self) -> None:
        with self.stack.fixture() as fixture:
            uid = fixture.uid
            key = self.add_key(uid, "S5-U1b tele key")
            metadata = f"/dicom-web/studies/{quote(uid)}/metadata"

            # tele (a referral needs RS W): the receiving institution's clinician sees the study and its status while
            # the referral is open, and loses all of it when the owner cancels
            self.call("PATCH", f"/studies/{quote(uid)}", "doctor", {"ts": "wait", "teleTo": "kin-center"})
            received = next(r for r in self.clinician_rows("kclinician") if r["uid"] == uid)
            self.assertEqual((received["tele"], received["report"]), (True, {"final": False, "rs": "W"}))
            self.assert_open(self.report(uid, "kclinician").body, uid, "W")
            self.assertEqual(self.items(uid, "kclinician").body["final"], False)
            self.assertEqual(self.stack.dicom_request(metadata, "kclinician").status, 200)
            self.call("PATCH", f"/studies/{quote(uid)}", "doctor", {"ts": "cancelled"})
            self.report(uid, "kclinician", status=404)
            self.items(uid, "kclinician", status=404)
            self.assertNotIn(uid, {r["uid"] for r in self.clinician_rows("kclinician")})
            self.assertEqual(self.stack.dicom_request(metadata, "kclinician").status, 403)

            self.commit(uid, "approve", 0, findings=fixture.secret, conclusion="approved")
            instance = self.stack.first_instance_id(uid)
            sop = self.stack._orthanc_request("GET", f"/instances/{quote(instance)}/tags?simplify").body["SOPInstanceUID"]
            lookup = {"studyUid": uid, "sopUid": sop}

            # viewer read pair: lookup + nginx auth_request
            self.assertEqual(self.call("POST", "/dicom/lookup", "clinician", lookup).body, {"id": instance})
            self.call("POST", "/dicom/lookup", "kclinician", lookup, status=403)
            gateway = self.stack.bearer_request("POST", "/dicom/lookup", self.stack.service_token("gateway"), lookup)
            self.assertEqual(gateway.status, 403, gateway.text)
            protected = (f"/dicom-web/studies/{quote(uid)}/metadata", f"/instances/{quote(instance)}/preview")
            for path in protected:
                with self.subTest(dicom=path):
                    self.assertEqual(self.stack.dicom_request(path, "clinician").status, 200)
                    self.assertEqual(self.stack.dicom_request(path, "kclinician").status, 403)
            # COUNT-LEAK: the server-wide Orthanc count closes for clinician-only and stays open for the reader
            self.assertEqual(self.stack.dicom_request("/statistics", "clinician").status, 403)
            self.assertEqual(self.stack.dicom_request("/statistics", "doctor").status, 200)

            # saved viewer items: narrow for clinician-only, unchanged for the radiologist
            page = self.items(uid).body
            self.assertEqual(sorted(page), sorted(C["viewer_page_keys"]))
            self.assertEqual((page["final"], [i["id"] for i in page["items"]]), (True, [key["id"]]))
            self.assertEqual(sorted(page["items"][0]), sorted(C["viewer_item_keys"]))
            self.assert_clean(page, "clinician viewer items")
            legacy = self.items(uid, "doctor").body
            self.assertIn("authorSub", legacy["items"][0], "the radiologist path keeps its full answer")
            self.items(uid, query="?includeHidden=true", status=400)
            self.items(uid, query="?includeHidden=false&limit=1")
            self.items(uid, "kclinician", status=404)
            gateway = self.stack.bearer_request("GET", f"/studies/{quote(uid)}/viewer-items", self.stack.service_token("gateway"))
            self.assertEqual(gateway.status, 403, gateway.text)
            self.assert_route_denied("GET", f"/studies/{quote(uid)}/viewer-items/{key['id']}/revisions", "clinician")
            self.assert_route_denied("POST", f"/studies/{quote(uid)}/viewer-items", "clinician", {})

            # a hidden key leaves both the item page and the report's key list
            snapshot = {k: v for k, v in key["item"].items() if k != "hidden"}
            self.call("POST", f"/studies/{quote(uid)}/viewer-items/{key['id']}/revisions", "doctor",
                      {"requestId": str(uuid.uuid4()), "expectedRevision": key["revision"], "action": "hide",
                       "reason": "S5-U1b hide", "item": snapshot})
            self.assertEqual(self.items(uid).body["items"], [])
            self.assertEqual(self.report(uid).body["keys"], [])

    def test_04_revocation_ends_the_kept_session_and_new_tokens_and_reports_the_kept_bearer_until_exp(self) -> None:
        """S5-U1b-F03: the member's OWN credentials from before the revocation, on all five allow rows.

        Counted as revoked: the kept BFF session (refused at once) and any token issued after (PENDING). A Bearer issued
        before the revocation carries signed claims the guard trusts until exp; its answers before and after exp are
        reported in the S5-U1B-REVOCATION marker and are never counted as an immediate revocation.
        """
        with self.stack.fixture() as fixture:
            uid = fixture.uid
            key = self.add_key(uid, "S5-U1b revocation key")
            self.commit(uid, "approve", 0, findings=fixture.secret, conclusion="approved")
            instance = self.stack.first_instance_id(uid)
            sop = self.stack._orthanc_request("GET", f"/instances/{quote(instance)}/tags?simplify").body["SOPInstanceUID"]
            rows = (("list", "GET", "/api/clinician/studies", None),
                    ("report", "GET", f"/api/clinician/studies/{quote(uid)}/report", None),
                    ("viewer-items", "GET", f"/api/studies/{quote(uid)}/viewer-items", None),
                    ("dicom-lookup", "POST", "/api/dicom/lookup", {"studyUid": uid, "sopUid": sop}),
                    # GET authz/dicom through its only caller, nginx auth_request on the DICOMweb read
                    ("authz-dicom", "GET", f"/dicom-web/studies/{quote(uid)}/metadata", None))

            client_id = self.short_lived_client()
            user_id, username, password = self.create_member("crevoke")
            path = f"/admin/users/{quote(user_id)}"
            approved = self.stack.request("PATCH", path, "jmryu",
                                          {"approvalState": "APPROVED", "institution": "hallym", "roles": ["clinician"]})
            self.assertEqual(approved.status, 200, approved.text)
            sid = self.bff_session(username, password)
            self.addCleanup(self.session_call, sid, "POST", "/api/auth/logout", {})
            bearer = self.grant(username, password, client_id)
            claims = jwt_claims(bearer)
            self.assertLessEqual(claims["exp"] - claims["iat"], SHORT_BEARER_SECONDS,
                                 "the probe client's lifespan was not applied; the post-exp answer cannot be observed")

            def observe(kind: str, secret: str) -> dict[str, HttpResult]:
                return {row[0]: self.through(kind, secret, row) for row in rows}

            def summary(results: dict[str, HttpResult]) -> dict[str, list]:
                return {name: [result.status, code(result)] for name, result in results.items()}

            # every row really answers both credentials before the revocation (a real SOP, a real study)
            before: dict[str, dict] = {}
            for kind, secret in (("session", sid), ("bearer", bearer)):
                answers = observe(kind, secret)
                for name, result in answers.items():
                    with self.subTest(before=kind, row=name):
                        self.assertEqual(result.status, 200, result.text[:300])
                self.assertIn(uid, {row["uid"] for row in answers["list"].body["studies"]})
                self.assertEqual((answers["report"].body["uid"], answers["report"].body["report"]["final"]), (uid, True))
                self.assertEqual([i["id"] for i in answers["viewer-items"].body["items"]], [key["id"]])
                self.assertEqual(answers["dicom-lookup"].body, {"id": instance})
                before[kind] = summary(answers)

            realm = self.stack.kc_admin("GET", "")
            marker: dict[str, Any] = {
                "unit": "S5-U1b", "case": "member-revocation", "rows": [row[0] for row in rows],
                "realm_access_token_lifespan_seconds": realm.body.get("accessTokenLifespan") if isinstance(realm.body, dict) else None,
                "bff_session": {"before": before["session"]},
                "kept_bearer": {"lifespan_seconds": claims["exp"] - claims["iat"], "before_revocation": before["bearer"]},
                "limit": ("A Bearer issued before the revocation keeps its signed groups/roles until exp. The revocation "
                          "deletes the member's BFF sessions and makes tokens issued after it PENDING; it does not recall "
                          "an issued Bearer. Only the first two are counted as revocation."),
            }
            try:
                revoked = self.stack.request("PATCH", path, "jmryu", {"approvalState": "PENDING"})
                self.assertEqual(revoked.status, 200, revoked.text)
                session_after = observe("session", sid)
                kept = observe("bearer", bearer)
                kept_seconds_left = claims["exp"] - time.time()
                fresh_token = self.grant(username, password, client_id)
                fresh = observe("bearer", fresh_token)
                marker["bff_session"]["after_revocation"] = summary(session_after)
                marker["new_token_after_revocation"] = summary(fresh)
                kept_class = sorted({"allowed" if r.status == 200 else "denied" if r.status in (401, 403) else f"HTTP {r.status}"
                                     for r in kept.values()})
                marker["kept_bearer"].update({"after_revocation_before_exp": summary(kept),
                                              "seconds_left_at_check": round(kept_seconds_left, 1),
                                              "answer_before_exp": kept_class})
                self.assertEqual(self.stack.bearer_request("POST", "/auth/logout", fresh_token).status, 204)
                # the kept Bearer only stops at its exp (+3 s: jose has no clock tolerance, the runner and kin-api share a clock)
                wait = claims["exp"] + 3 - time.time()
                self.assertLessEqual(wait, SHORT_BEARER_SECONDS + 3)
                if wait > 0:
                    time.sleep(wait)
                expired = observe("bearer", bearer)
                marker["kept_bearer"]["after_exp"] = summary(expired)
                marker["counted_as_revoked"] = ["bff_session", "new_token"] + (["kept_bearer"] if kept_class == ["denied"] else [])
            finally:
                print("S5-U1B-REVOCATION " + json.dumps(marker, ensure_ascii=True, sort_keys=True), flush=True)

            for name, result in session_after.items():
                with self.subTest(kept_session=name):
                    self.assertEqual(result.status, 401, "the kept BFF session must be gone at once: " + result.text[:300])
            for name, result in fresh.items():
                with self.subTest(new_token=name):
                    # nginx answers the auth_request refusal itself (status only); the API rows carry the code
                    expected = (403, "INSTITUTION_PENDING") if name != "authz-dicom" else (403, None)
                    self.assertEqual((result.status, code(result) if name != "authz-dicom" else None), expected, result.text[:300])
            self.assertGreater(kept_seconds_left, 5, "the kept-Bearer batch ran into its exp; its before-exp answer is not observed")
            self.assertEqual(len(kept_class), 1, f"the five rows disagree on the same kept Bearer: {summary(kept)}")
            self.assertIn(kept_class[0], ("allowed", "denied"), summary(kept))
            for name, result in expired.items():
                with self.subTest(kept_bearer_after_exp=name):
                    self.assertEqual(result.status, 401, result.text[:300])

    def test_05_same_user_a_b_a_gets_each_studys_own_answer(self) -> None:
        with self.stack.fixture() as first, self.stack.fixture() as second:
            a, b = first.uid, second.uid
            self.add_key(a, "S5-U1b A key")
            self.add_key(b, "S5-U1b B key")
            self.commit(a, "approve", 0, findings=first.secret)
            self.commit(b, "save", 0, findings=second.secret)
            reads = [self.report(uid).body for uid in (a, b, a)]
            self.assertEqual([r["uid"] for r in reads], [a, b, a])
            self.assertEqual(reads[0], reads[2], "the same study read again answers the same")
            self.assertEqual(reads[0]["report"]["findings"], first.secret)
            self.assertNotIn(second.secret, json.dumps(reads[0], ensure_ascii=False))
            self.assert_open(reads[1], b, "T", first.secret, second.secret)
            pages = [self.items(uid).body for uid in (a, b, a)]
            self.assertEqual([(p["uid"], p["final"]) for p in pages], [(a, True), (b, False), (a, True)])
            self.assertEqual(pages[0], pages[2])
            listed = {r["uid"]: r["report"] for r in self.clinician_rows("clinician")}
            self.assertEqual((listed[a]["final"], listed[b]), (True, {"final": False, "rs": "T"}))

    def hide(self, uid: str, item: dict, reason: str) -> None:
        self.call("POST", f"/studies/{quote(uid)}/viewer-items/{item['id']}/revisions", "doctor",
                  {"requestId": str(uuid.uuid4()), "expectedRevision": item["revision"], "action": "hide", "reason": reason,
                   "item": {k: v for k, v in item["item"].items() if k != "hidden"}})

    def test_06_viewer_items_stay_on_one_signed_version_across_a_reset_and_reapproval(self) -> None:
        """S5-U1b-F01 on the compiled ViewerController/ViewerService/PacsService, the reset placed between the gates."""
        with self.stack.fixture() as fixture:
            uid = fixture.uid
            key = self.add_key(uid, "S5-U1b signed key")
            v = self.commit(uid, "approve", 0, findings=fixture.secret, conclusion="approved")

            # control: nothing moves at the pauses -> exactly the page the HTTP route answers
            control = self.drive("viewer", uid, {})[-1]
            self.assertEqual((control["status"], control["heads"]), (200, [v, v]), control)
            self.assertEqual((control["body"]["final"], [i["id"] for i in control["body"]["items"]]), (True, [key["id"]]))
            self.assertEqual(control["body"], self.items(uid).body)

            # the reported race: gate sees v; reset; an item written and read while open; hidden; re-approved
            box: dict[str, Any] = {}

            def reopen(event: dict) -> None:
                self.assertEqual(event["version"], v)
                box["reset"] = self.commit(uid, "reset", v, reason="S5-U1b-F01 reset between the gates")
                box["open_item"] = self.add_key(uid, "S5-U1b open-only " + uuid.uuid4().hex[:8])

            def reapprove(event: dict) -> None:
                # the pinned read ran while the report was open: that statement saw no signed head, so no items
                self.assertEqual((event["finalVersion"], event["ids"]), (None, []))
                self.hide(uid, box["open_item"], "S5-U1b-F01 hidden before re-approval")
                box["signed"] = self.commit(uid, "approve", box["reset"], findings=fixture.secret, conclusion="re-approved")

            events = self.drive("viewer", uid, {"head": reopen, "read": reapprove})
            result = events[-1]
            # both gates saw a signed head (a boolean recheck passed here) but not the same one
            self.assertEqual(result["heads"], [v, box["signed"]])
            self.assertTrue(all(isinstance(h, int) and h > 0 for h in result["heads"]), result["heads"])
            self.assertEqual(outcome(result), (409, C["viewer_changed_code"]), result)
            self.assertNotIn(box["open_item"]["id"], json.dumps(events), "an item of the open interval reached the answer")

            # the last gate: the read sees the signed head, then reset -> re-approve lands before the answer
            v, late = box["signed"], {}

            def change_after_read(event: dict) -> None:
                self.assertEqual((event["finalVersion"], event["ids"]), (v, [key["id"]]))
                late["reset"] = self.commit(uid, "reset", v, reason="S5-U1b-F01 reset after the read")
                late["signed"] = self.commit(uid, "approve", late["reset"], findings=fixture.secret, conclusion="approved again")

            result = self.drive("viewer", uid, {"read": change_after_read})[-1]
            self.assertEqual(result["heads"], [v, late["signed"]])
            self.assertEqual(outcome(result), (409, C["viewer_changed_code"]), result)

            # settled: the signed page, still without the item that only lived while the report was open
            page = self.items(uid).body
            self.assertEqual((page["final"], [i["id"] for i in page["items"]]), (True, [key["id"]]))
            # a plain reset between the gates is refused the same way, and afterwards the answer is withheld
            reset = {}
            result = self.drive("viewer", uid, {"head": lambda event: reset.setdefault(
                "v", self.commit(uid, "reset", event["version"], reason="S5-U1b-F01 plain reset"))})[-1]
            self.assertEqual((result["heads"], *outcome(result)),
                             ([late["signed"], None], 409, C["viewer_changed_code"]), result)
            self.assertEqual(self.items(uid).body, {"uid": uid, "final": False, "items": None, "nextCursor": None})

    def test_07_list_status_is_one_snapshot_when_an_addendum_lands_mid_list(self) -> None:
        """S5-U1b-F02 on the compiled PacsService: an Addendum between listStudies' StudyState and Report reads."""
        with self.stack.fixture() as fixture:
            uid = fixture.uid
            box: dict[str, Any] = {"v": self.commit(uid, "approve", 0, findings=fixture.secret, conclusion="approved")}
            # each run changes the signer, so the worklist row would carry the new version with the old signer
            for paged, signer in ((False, "doctor2"), (True, "doctor")):
                with self.subTest(paged=paged):
                    def addendum(event: dict, user: str = signer) -> None:
                        box["v"] = self.commit(uid, "addendum", box["v"], user=user,
                                               findings=fixture.secret + " addendum " + user, conclusion="approved")

                    result = self.drive("list", uid, {"state": addendum}, paged=paged)[-1]
                    self.assertTrue(result["paused"], "the pause never reached the page that carries the study")
                    self.assertEqual(outcome(result), (409, "STUDY_LIST_CHANGED"), result)
                    # the snapshot recheck refused it, not the page stamp or listStudies' own scope check (same code)
                    self.assertIn("판독 상태", result["body"]["message"], result)
                    # settled: the HTTP list row is the new head with its own signer
                    row = next(r for r in self.clinician_rows("clinician") if r["uid"] == uid)
                    self.assertEqual(row["report"], {"final": True, "rs": "A", "action": "addendum", "version": box["v"],
                                                     "repDoc": self.stack.actor(signer).split("@")[0],
                                                     "confirm": row["report"]["confirm"]})
            # control: nothing moves at the pause -> the driver's row is the row of the same (unpaged) HTTP read
            control = self.drive("list", uid, {})[-1]
            self.assertEqual((control["status"], control["paused"]), (200, True), control)
            unpaged = self.call("GET", "/clinician/studies", "clinician").body["studies"]
            self.assertEqual(control["row"], next(r for r in unpaged if r["uid"] == uid))


if __name__ == "__main__":
    print("Run through scripts/run-tests.py --mode live; direct execution is refused by the gate.", file=sys.stderr)
    raise SystemExit(125)
