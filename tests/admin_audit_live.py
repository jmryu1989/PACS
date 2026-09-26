# coding: utf-8
"""TEST-S5-U5b-LIVE: the admin audit read (GET /api/admin/audit) on the real Nest route, Keycloak, PostgreSQL and the
gateway announce.

REQ-S5-U5b-ADMIN-AUDIT / MOVE-PROJECTION / UNCLEAR-HIDDEN / NO-MIGRATION-START
  -> RISK-S5-U5b-CROSS-INSTITUTION / CURRENT-GROUP-ATTRIBUTION / CURRENT-OWNER-ATTRIBUTION / HIDDEN-COUNT /
     INVENTED-FIELDS / FAILURE-AS-EMPTY.

Hosted synthetic stack only, through scripts/run-tests.py:

    python scripts/run-tests.py --module tests/admin_audit_live.py --mode live --unit s5-u5b-admin-audit --timeout 900

One class; the cases run in declaration order and each builds on the history the previous ones wrote (CASES below,
name and expected seconds on a warm hosted stack):

  test_01  refusals before any history: clinician-only (guard CLINICIAN_ROUTE_DENIED), technician and radiologist
           403; bad queries 400; a forged continuation 409, never 200 with no rows; Z answers total 0.
  test_02  member m is created PENDING, approved into A, has its roles changed and a password reset and gets a Study
           Access policy in A, is moved A->B by Z's admin, suspended and un-approved in B. A receives the A-era rows and
           the move with `after` withheld; B the B-era rows and the move with `before` withheld; Z nothing; the PENDING
           create reaches nobody; no row carries an email. Two stored rows the API cannot write on demand (a failed
           partial move B->A and a snapshot naming several groups) are attributed the same way.
  test_03  m is deleted in Keycloak: A and B still receive exactly their record-time rows.
  test_04  a study announced by A's gateway, patched and deleted by A, then announced by B's gateway and patched by B:
           B (its current owner) receives none of A's rows for it; A keeps them; A's site Hanging Protocol reset is A's.
  test_05  rows without a record-time institution reach nobody (a draft, an unknown action, a Connect row, unparsable
           detail, an unassigned arrival, the member list, a non-string institution), each naming A; totals unchanged.
  test_06  totals and paging count visible rows only: limit=2 walks exactly the full read once, the continuation is
           opaque and bound to its reader (B's admin gets 409), and a Study Access-restricted admin gets 403
           ADMIN_AUDIT_RESTRICTED, never an empty list.

A query failure of the database cannot be caused safely on a shared stack; that failure-is-not-empty path is the pure
readAuditPage case in tests/admin_audit_attribution_test.cjs and the service's 503 ADMIN_AUDIT_UNAVAILABLE.

Owned data only: three run-created Keycloak groups kin-test-<run>-a/-b/-z (the synthetic institutions A, B and Z), the
run's identities (admins of A, B and Z, a second admin of A, a clinician-only, a technician and a radiologist of A),
member m created through the member console, two run-created gateway clients, the realm roles `clinician` and
`gateway` only when this run had to create them, one synthetic study UID 2.25.<random>, and AuditLog rows the run
inserts by exact id. Cleanup removes exactly these (AuditLog by id, run target or run actor; StudyState, Study Access
and site Hanging Protocol rows by the run's UID and institutions).
"""
from __future__ import annotations

import base64
import json
import re
import sys
import unittest
import uuid
from urllib.parse import quote, urlencode
from urllib.request import Request

from invariants_live import LiveStack, psql, purge_user_audit

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

CASES = (
    ("test_01_refusals_before_any_history", 30),
    ("test_02_member_history_is_attributed_at_write_time", 90),
    ("test_03_a_deleted_member_keeps_its_record_time_history", 20),
    ("test_04_a_study_recreated_under_another_owner_keeps_its_history", 60),
    ("test_05_rows_without_a_record_time_institution_reach_nobody", 20),
    ("test_06_totals_and_paging_count_visible_rows_only", 40),
)

WITHHELD = {"withheld": "other_institution"}
GROUP = re.compile(r"kin-test-[0-9a-f]{12}-[abz]")
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
STUDY = re.compile(r"2\.25\.\d{10,40}")
SAFE = re.compile(r"[A-Za-z0-9._@:+-]{1,160}")
SYNTHETIC_ACTOR = "kin-test-u5b-synthetic@local.test"
DENIED = "CLINICIAN_ROUTE_DENIED"


def shape(row):
    """(action, target, sides withheld from this reader) — what a reader may see of one row, without its time."""
    withheld = ()
    if row["rule"] == "member_snapshots":
        withheld = tuple(side for side in ("before", "after") if row["detail"].get(side) == WITHHELD)
    return (row["action"], row["target"], withheld)


def keys_of(value, found=None):
    found = set() if found is None else found
    if isinstance(value, dict):
        for key, item in value.items():
            found.add(key)
            keys_of(item, found)
    elif isinstance(value, list):
        for item in value:
            keys_of(item, found)
    return found


class AdminAuditLive(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.stack = LiveStack()
        cls.addClassCleanup(cls.stack.cleanup_test_identities)
        cls.run_id = uuid.uuid4().hex[:12]
        cls.groups: dict[str, tuple[str, str]] = {}
        cls.created_roles: list[str] = []
        cls.gateway_clients: list[str] = []
        cls.inserted: list[int] = []
        cls.members: list[str] = []
        cls.synthetic_members: list[str] = []
        cls.study = "2.25." + str(uuid.uuid4().int)
        cls.expected: dict[str, list[tuple]] = {"A": [], "B": []}
        cls.addClassCleanup(cls.delete_groups)
        cls.addClassCleanup(cls.delete_created_roles)
        cls.addClassCleanup(cls.delete_gateway_clients)
        cls.addClassCleanup(cls.delete_members)
        cls.addClassCleanup(cls.purge_owned_rows)
        cls.stack.require_stack()
        for key in "ABZ":
            cls.create_group(key)
        cls.ensure_role("clinician")
        a, b, z = (cls.groups[key][0] for key in "ABZ")
        for logical, roles, group in (("u5b-admin-a", ["admin"], a), ("u5b-admin-a2", ["admin"], a), ("u5b-admin-b", ["admin"], b),
                                      ("u5b-admin-z", ["admin"], z), ("u5b-clinician-a", ["clinician"], a),
                                      ("u5b-tech-a", ["technician"], a), ("u5b-radiologist-a", ["radiologist"], a)):
            cls.stack.create_test_identity(logical, roles, group)
        cls.gateway = {key: cls.gateway_token(key) for key in "AB"}

    # ── owned fixtures ──
    @classmethod
    def create_group(cls, key: str) -> None:
        name = f"kin-test-{cls.run_id}-{key.lower()}"
        if not GROUP.fullmatch(name):
            raise RuntimeError("invalid synthetic institution name")
        created = cls.stack.kc_admin("POST", "/groups", {"name": name})
        if created.status != 201:
            raise RuntimeError(f"synthetic institution group creation failed: {created.status} {created.text}")
        found = cls.stack.kc_admin("GET", "/groups?search=" + quote(name))
        exact = [group for group in (found.body if isinstance(found.body, list) else []) if group.get("name") == name]
        if len(exact) != 1:
            raise RuntimeError(f"synthetic institution group lookup failed: {name}")
        cls.groups[key] = (name, exact[0]["id"])

    @classmethod
    def ensure_role(cls, name: str) -> dict:
        role = cls.stack.kc_admin("GET", "/roles/" + quote(name))
        if role.status == 404:
            created = cls.stack.kc_admin("POST", "/roles", {"name": name, "description": f"temporary S5-U5b {name} role"})
            if created.status != 201:
                raise RuntimeError(f"{name} role creation failed: {created.status}")
            cls.created_roles.append(name)
            role = cls.stack.kc_admin("GET", "/roles/" + quote(name))
        if role.status != 200:
            raise RuntimeError(f"{name} role lookup failed: {role.status}")
        return role.body

    @classmethod
    def gateway_token(cls, key: str) -> str:
        """A run-owned gateway credential of institution `key` (azp gw-*, the gateway role only, one group)."""
        role = cls.ensure_role("gateway")
        client_id = f"gw-kin-test-{cls.run_id}-u5b-{key.lower()}"
        secret = uuid.uuid4().hex + uuid.uuid4().hex
        created = cls.stack.kc_admin("POST", "/clients", {
            "clientId": client_id, "name": f"KIN S5-U5b gateway {key}", "enabled": True, "publicClient": False,
            "secret": secret, "standardFlowEnabled": False, "directAccessGrantsEnabled": False,
            "serviceAccountsEnabled": True, "protocol": "openid-connect",
        })
        if created.status != 201 or not created.body:
            raise RuntimeError(f"gateway client creation failed: {created.status}")
        client_uuid = str(created.body)
        cls.gateway_clients.append(client_uuid)
        for mapper in (
            {"name": "kin-api-audience", "protocol": "openid-connect", "protocolMapper": "oidc-audience-mapper",
             "consentRequired": False, "config": {"included.custom.audience": "kin-api", "id.token.claim": "false",
                                                  "access.token.claim": "true"}},
            {"name": "kin-institution-groups", "protocol": "openid-connect", "protocolMapper": "oidc-group-membership-mapper",
             "consentRequired": False, "config": {"full.path": "false", "id.token.claim": "false", "access.token.claim": "true",
                                                  "userinfo.token.claim": "false", "claim.name": "groups"}},
        ):
            added = cls.stack.kc_admin("POST", f"/clients/{quote(client_uuid)}/protocol-mappers/models", mapper)
            if added.status != 201:
                raise RuntimeError(f"gateway mapper creation failed: {added.status}")
        service = cls.stack.kc_admin("GET", f"/clients/{quote(client_uuid)}/service-account-user")
        if service.status != 200 or not service.body.get("id"):
            raise RuntimeError(f"gateway service account lookup failed: {service.status}")
        service_id = quote(str(service.body["id"]))
        joined = cls.stack.kc_admin("PUT", f"/users/{service_id}/groups/{quote(cls.groups[key][1])}")
        assigned = cls.stack.kc_admin("POST", f"/users/{service_id}/role-mappings/realm", [role])
        if (joined.status, assigned.status) != (204, 204):
            raise RuntimeError(f"gateway service account setup failed: {joined.status}/{assigned.status}")
        data = urlencode({"client_id": client_id, "client_secret": secret, "grant_type": "client_credentials"}).encode("ascii")
        request = Request(cls.stack.keycloak, data=data, headers={"Content-Type": "application/x-www-form-urlencoded"}, method="POST")
        with cls.stack._open(request) as response:
            return str(json.loads(response.read().decode("utf-8"))["access_token"])

    @classmethod
    def insert_audit(cls, action: str, target: str, detail, actor: str = SYNTHETIC_ACTOR) -> int:
        """A stored AuditLog row of a shape the API cannot be made to write on demand; kept for cleanup by its id."""
        for value in (action, target, actor):
            if not SAFE.fullmatch(value):
                raise RuntimeError(f"refusing to write a synthetic audit value {value!r}")
        text = detail if isinstance(detail, str) else json.dumps(detail, ensure_ascii=True, separators=(",", ":"))
        out = psql("INSERT INTO \"AuditLog\" (actor, action, target, detail) VALUES "
                   f"('{actor}', '{action}', '{target}', '{text.replace(chr(39), chr(39) * 2)}') RETURNING id;")
        ids = [line for line in out if line.isdigit()]
        if len(ids) != 1:
            raise RuntimeError(f"synthetic audit insert returned {out!r}")
        cls.inserted.append(int(ids[0]))
        return int(ids[0])

    @classmethod
    def purge_owned_rows(cls) -> None:
        if cls.inserted:
            psql('DELETE FROM "AuditLog" WHERE id IN (' + ",".join(str(int(i)) for i in cls.inserted) + ");")
            if psql('SELECT count(*) FROM "AuditLog" WHERE id IN (' + ",".join(str(int(i)) for i in cls.inserted) + ");") != ["0"]:
                raise RuntimeError("synthetic audit rows remain")
            cls.inserted.clear()
        names = [name for name, _ in cls.groups.values()]
        if not all(GROUP.fullmatch(name) for name in names) or not STUDY.fullmatch(cls.study):
            raise RuntimeError("refusing cleanup: an owned identifier has an unexpected shape")
        targets = [cls.study, *names]
        psql('DELETE FROM "AuditLog" WHERE target IN (' + ",".join(f"'{t}'" for t in targets) + ");")
        if names:
            listed = ",".join(f"'{name}'" for name in names)
            psql(f'DELETE FROM "StudyState" WHERE uid=\'{cls.study}\' AND "institutionId" IN ({listed});')
            psql(f'DELETE FROM "HangingProtocolPreference" WHERE institution IN ({listed}) AND subject=\'\';')
            psql(f'DELETE FROM "StudyAccessRevision" WHERE institution IN ({listed});')
            psql(f'DELETE FROM "StudyAccessPolicy" WHERE institution IN ({listed});')
            if psql(f'SELECT count(*) FROM "StudyState" WHERE uid=\'{cls.study}\';') != ["0"]:
                raise RuntimeError("the synthetic study state remains (another owner?)")
        for member in cls.synthetic_members:
            purge_user_audit(member)
        cls.synthetic_members.clear()

    @classmethod
    def delete_members(cls) -> None:
        failures = []
        for member in reversed(cls.members):
            deleted = cls.stack.kc_admin("DELETE", f"/users/{quote(member)}")
            if deleted.status not in (204, 404):
                failures.append(f"{member}: {deleted.status}")
            purge_user_audit(member)
        cls.members.clear()
        if failures:
            raise RuntimeError("owned member cleanup failed: " + "; ".join(failures))

    @classmethod
    def delete_gateway_clients(cls) -> None:
        failures = [client for client in cls.gateway_clients
                    if cls.stack.kc_admin("DELETE", f"/clients/{quote(client)}").status not in (204, 404)]
        cls.gateway_clients.clear()
        if failures:
            raise RuntimeError("gateway client cleanup failed: " + ", ".join(failures))

    @classmethod
    def delete_created_roles(cls) -> None:
        failures = [name for name in cls.created_roles
                    if cls.stack.kc_admin("DELETE", "/roles/" + quote(name)).status not in (204, 404)]
        cls.created_roles.clear()
        if failures:
            raise RuntimeError("temporary role cleanup failed: " + ", ".join(failures))

    @classmethod
    def delete_groups(cls) -> None:
        failures = [name for name, group_id in cls.groups.values()
                    if cls.stack.kc_admin("DELETE", f"/groups/{quote(group_id)}").status not in (204, 404)]
        cls.groups.clear()
        if failures:
            raise RuntimeError("synthetic institution cleanup failed: " + ", ".join(failures))

    # ── helpers ──
    def inst(self, key: str) -> str:
        return self.groups[key][0]

    def audit(self, user: str, query: str = "limit=100"):
        return self.stack.request("GET", "/admin/audit?" + query, user)

    def read(self, key: str) -> dict:
        """One admin's whole visible history (a fresh institution fits in one page of 100)."""
        result = self.audit("u5b-admin-" + key.lower())
        self.assertEqual(result.status, 200, result.text)
        body = result.body
        self.assertEqual((body["institutionId"], body["next"], body["total"]), (self.inst(key), None, len(body["rows"])))
        for row in body["rows"]:
            self.assertNotIn("email", keys_of(row), row)
        return body

    def assert_history(self, key: str) -> dict:
        body = self.read(key)
        self.assertEqual(sorted(self.expected[key]), sorted(shape(row) for row in body["rows"]), f"{key}'s record-time rows")
        return body

    def member_patch(self, admin: str, member: str, body: dict, action: str) -> None:
        result = self.stack.request("PATCH", f"/admin/users/{quote(member)}", admin, body)
        self.assertEqual(result.status, 200, f"{action}: {result.status}")

    # ── cases ──
    def test_01_refusals_before_any_history(self) -> None:
        clinician = self.audit("u5b-clinician-a")
        self.assertEqual((clinician.status, clinician.body.get("code") if isinstance(clinician.body, dict) else None),
                         (403, DENIED), clinician.text)
        for user in ("u5b-tech-a", "u5b-radiologist-a"):
            with self.subTest(user=user):
                refused = self.audit(user)
                self.assertEqual(refused.status, 403, refused.text)
                self.assertNotEqual(refused.body.get("code"), DENIED, "the service's admin check decides, not the clinician gate")
        for query in ("limit=0", "limit=101", "limit=1.5", "take=5", "limit=5&limit=6", "limit=5&institution=x"):
            with self.subTest(query=query):
                bad = self.audit("u5b-admin-a", query)
                self.assertEqual((bad.status, bad.body.get("code")), (400, "ADMIN_AUDIT_QUERY_INVALID"), bad.text)
        forged = self.audit("u5b-admin-a", "limit=5&after=" + quote(base64.urlsafe_b64encode(b'{"after":1}').decode().rstrip("=")))
        self.assertEqual((forged.status, forged.body.get("code")), (409, "ADMIN_AUDIT_CURSOR_EXPIRED"), forged.text)
        for key in "ABZ":
            with self.subTest(institution=key):
                self.assertEqual(self.read(key)["total"], 0, "a fresh institution has no history yet")

    def test_02_member_history_is_attributed_at_write_time(self) -> None:
        username = f"kin-test-{uuid.uuid4().hex[:12]}-u5b-m"
        created = self.stack.request("POST", "/admin/users", "u5b-admin-a", {
            "username": username, "email": username + "@local.test", "firstName": "KIN", "lastName": "u5b-m"})
        self.assertEqual(created.status, 201, f"member create: {created.status}")   # the body carries a temporary password
        member = created.body["id"]
        self.assertTrue(UUID.fullmatch(member))
        self.members.append(member)
        type(self).member = member
        self.assertEqual(created.body["approvalState"], "PENDING")
        a, b = self.inst("A"), self.inst("B")
        self.member_patch("u5b-admin-a", member, {"approvalState": "APPROVED", "institution": a, "roles": ["technician"],
                                                  "verificationOverride": True}, "approve into A")
        self.member_patch("u5b-admin-a", member, {"roles": ["radiologist", "technician"], "verificationOverride": True}, "roles in A")
        reset = self.stack.request("POST", f"/admin/users/{quote(member)}/reset-password", "u5b-admin-a", {"mode": "temp"})
        self.assertEqual(reset.status, 200, f"password reset: {reset.status}")
        policy = self.stack.request("POST", f"/admin/users/{quote(member)}/study-access", "u5b-admin-a", {
            "expectedOwner": [a, self.stack.user_ids["u5b-admin-a"]], "revision": 0, "requestId": str(uuid.uuid4()),
            "reason": "SYN S5-U5b policy while in A",
            "policy": {"version": 1, "restricted": False, "startsAt": None, "endsAt": None, "rules": []}})
        self.assertIn(policy.status, (200, 201), policy.text)
        self.member_patch("u5b-admin-z", member, {"institution": b, "verificationOverride": True}, "move A->B by Z")
        self.member_patch("u5b-admin-b", member, {"enabled": False}, "suspend in B")
        self.member_patch("u5b-admin-b", member, {"approvalState": "PENDING"}, "un-approve in B")

        # Stored shapes the API cannot be made to write on demand, as admin.service.ts row() writes them.
        def snapshot(member_id, institution, state, roles=("technician",)):
            return {"id": member_id, "username": "syn-" + member_id[:8], "email": member_id[:8] + "@local.test",
                    "emailVerified": True, "name": "SYN U5b", "institution": institution, "roles": list(roles),
                    "enabled": True, "approvalState": state}
        partial, ambiguous = str(uuid.uuid4()), str(uuid.uuid4())
        self.synthetic_members += [partial, ambiguous]
        self.insert_audit("admin.user.patch.failed", partial, {"before": snapshot(partial, b, "APPROVED"),
                          "after": snapshot(partial, a, "INVALID", roles=()), "verificationOverride": True, "failed": True})
        self.insert_audit("admin.user.update", ambiguous, {"before": snapshot(ambiguous, None, "INVALID"),
                          "after": snapshot(ambiguous, a, "APPROVED"), "verificationOverride": True})

        self.expected["A"] += [("admin.user.approve", member, ()), ("admin.user.update", member, ()),
                               ("admin.user.reset-password", member, ()), ("study.access", member, ()),
                               ("admin.user.update", member, ("after",)), ("admin.user.patch.failed", partial, ("before",))]
        self.expected["B"] += [("admin.user.update", member, ("before",)), ("admin.user.suspend", member, ()),
                               ("admin.user.unapprove", member, ()), ("admin.user.patch.failed", partial, ("after",))]
        seen_a, seen_b = self.assert_history("A"), self.assert_history("B")
        self.assertEqual(self.read("Z")["total"], 0, "Z (the mover's institution) receives nothing")
        move_a = next(r for r in seen_a["rows"] if shape(r) == ("admin.user.update", member, ("after",)))
        move_b = next(r for r in seen_b["rows"] if shape(r) == ("admin.user.update", member, ("before",)))
        self.assertEqual((move_a["detail"]["before"]["institution"], move_b["detail"]["after"]["institution"]), (a, b))
        self.assertNotIn(b, json.dumps(move_a), "A never learns where the member went")
        self.assertNotIn(a, json.dumps(move_b), "B never learns where the member came from")
        self.assertEqual(move_a["actor"], move_b["actor"])
        self.assertEqual(move_a["actor"], self.stack.actor("u5b-admin-z"))
        for body in (seen_a, seen_b):
            text = json.dumps(body)
            self.assertNotIn(username + "@local.test", text, "the member's email is never projected")
            self.assertNotIn("admin.user.create", text, "the PENDING create names no institution")
            self.assertNotIn(ambiguous, text, "a snapshot naming several groups reaches nobody")

    def test_03_a_deleted_member_keeps_its_record_time_history(self) -> None:
        deleted = self.stack.kc_admin("DELETE", f"/users/{quote(self.member)}")
        self.assertEqual(deleted.status, 204, deleted.text)
        self.assertEqual(self.stack.kc_admin("GET", f"/users/{quote(self.member)}").status, 404)
        self.assert_history("A")
        self.assert_history("B")
        self.assertEqual(self.read("Z")["total"], 0)

    def test_04_a_study_recreated_under_another_owner_keeps_its_history(self) -> None:
        a, b, uid = self.inst("A"), self.inst("B"), self.study
        announced = self.stack.bearer_request("POST", "/gateway/announce", self.gateway["A"], {"studyUid": uid})
        self.assertEqual((announced.status, announced.body.get("institutionId")), (200, a), announced.text)
        patched = self.stack.request("PATCH", f"/studies/{uid}", "u5b-admin-a", {"ward": "SYN-U5B-A"})
        self.assertEqual(patched.status, 200, patched.text)
        site = self.stack.request("PUT", "/hanging-protocols/site", "u5b-admin-a",
                                  {"expectedOwner": {"institution": a, "subject": ""}, "revision": 0, "value": None})
        self.assertEqual(site.status, 200, site.text)
        removed = self.stack.request("DELETE", f"/studies/{uid}", "u5b-admin-a")
        self.assertEqual(removed.status, 200, removed.text)
        again = self.stack.bearer_request("POST", "/gateway/announce", self.gateway["B"], {"studyUid": uid})
        self.assertEqual((again.status, again.body.get("institutionId")), (200, b), again.text)
        patched_b = self.stack.request("PATCH", f"/studies/{uid}", "u5b-admin-b", {"ward": "SYN-U5B-B"})
        self.assertEqual(patched_b.status, 200, patched_b.text)
        # The study's current owner is B; that does not decide who reads A's rows about it.
        self.assertEqual(psql(f'SELECT "institutionId" FROM "StudyState" WHERE uid=\'{uid}\';'), [b])
        self.expected["A"] += [("study.announce", uid, ()), ("state.patch", uid, ()), ("hanging-protocol.site.reset", a, ()),
                               ("state.delete", uid, ())]
        self.expected["B"] += [("study.announce", uid, ()), ("state.patch", uid, ())]
        seen_a, seen_b = self.assert_history("A"), self.assert_history("B")
        self.assertEqual(self.read("Z")["total"], 0)
        by_a = {row["action"]: row for row in seen_a["rows"] if row["target"] == uid}
        by_b = {row["action"]: row for row in seen_b["rows"] if row["target"] == uid}
        self.assertEqual((by_a["state.patch"]["detail"]["by"], by_a["state.patch"]["detail"]["ward"]), (a, "SYN-U5B-A"))
        self.assertEqual((by_b["state.patch"]["detail"]["by"], by_b["state.patch"]["detail"]["ward"]), (b, "SYN-U5B-B"))
        self.assertEqual(sorted(by_b), ["state.patch", "study.announce"], "B receives none of A's rows for the study")
        self.assertNotIn("SYN-U5B-A", json.dumps(seen_b))

    def test_05_rows_without_a_record_time_institution_reach_nobody(self) -> None:
        a, b, uid = self.inst("A"), self.inst("B"), self.study
        before = {key: self.read(key)["total"] for key in "ABZ"}
        orphan = "2.25." + str(uuid.uuid4().int)
        rows = [
            ("report.draft", uid, {"len": [1, 0, 0], "by": a}),
            ("future.action", uid, {"by": a}),
            ("agreement.record", "syn-agreement-" + self.run_id, {"agreementId": "syn-agreement-" + self.run_id, "from": a, "to": b}),
            ("admin.user.update", self.member, '{"before":{"id":"' + self.member + '","institution":"' + a + '"'),
            ("study.arrived", uid, {"institutionId": None, "note": a}),
            ("admin.user.list", "admin-users", {"page": 1, "count": 1, "institution": a}),
            ("study.access", self.member, {"institution": 7, "note": a}),
            ("study.arrived", orphan, {"institutionId": None}),
        ]
        for action, target, detail in rows:
            self.insert_audit(action, target, detail)
        after = {key: self.read(key) for key in "ABZ"}
        self.assertEqual(before, {key: body["total"] for key, body in after.items()}, "totals do not change")
        self.assert_history("A")
        self.assert_history("B")
        shown = {(row["action"], row["target"]) for body in after.values() for row in body["rows"]}
        for action, target, _ in rows:
            if action in ("admin.user.update", "study.access"):
                continue   # the same (action, target) exists as a real A/B row; the totals above prove none was added
            self.assertNotIn((action, target), shown, action)

    def test_06_totals_and_paging_count_visible_rows_only(self) -> None:
        full = self.assert_history("A")
        self.assertEqual(full["total"], len(self.expected["A"]))
        pages, query, cursors = [], "limit=2", []
        for _ in range(full["total"] + 2):
            page = self.audit("u5b-admin-a", query)
            self.assertEqual(page.status, 200, page.text)
            self.assertLessEqual(len(page.body["rows"]), 2)
            self.assertEqual(page.body["total"], full["total"], "every page counts the same visible rows")
            pages.append(page.body["rows"])
            if page.body["next"] is None:
                break
            cursors.append(page.body["next"])
            query = "limit=2&after=" + quote(page.body["next"], safe="")
        self.assertIsNone(page.body["next"], "the walk ends")
        walked = [row for rows in pages for row in rows]
        key = lambda row: (row["at"], row["action"], row["target"], json.dumps(row["detail"], sort_keys=True))  # noqa: E731
        self.assertEqual([key(row) for row in full["rows"]], [key(row) for row in walked], "the pages are the full read, once")
        self.assertEqual(len(pages), -(-full["total"] // 2))
        self.assertTrue(cursors, "more than one page")
        raw = base64.urlsafe_b64decode(cursors[0] + "=" * (-len(cursors[0]) % 4))
        self.assertNotIn(b'"after"', raw)
        with self.assertRaises((UnicodeDecodeError, ValueError)):
            json.loads(raw.decode("utf-8"))
        stolen = self.audit("u5b-admin-b", "limit=2&after=" + quote(cursors[0], safe=""))
        self.assertEqual((stolen.status, stolen.body.get("code")), (409, "ADMIN_AUDIT_CURSOR_EXPIRED"), stolen.text)
        # A Study Access-restricted admin is refused, never answered with an empty list.
        second = self.stack.user_ids["u5b-admin-a2"]
        restricted = self.stack.request("POST", f"/admin/users/{quote(second)}/study-access", "u5b-admin-a", {
            "expectedOwner": [self.inst("A"), self.stack.user_ids["u5b-admin-a"]], "revision": 0, "requestId": str(uuid.uuid4()),
            "reason": "SYN S5-U5b restricted admin",
            "policy": {"version": 1, "restricted": True, "startsAt": None, "endsAt": None, "rules": []}})
        self.assertIn(restricted.status, (200, 201), restricted.text)
        refused = self.audit("u5b-admin-a2")
        self.assertEqual((refused.status, refused.body.get("code")), (403, "ADMIN_AUDIT_RESTRICTED"), refused.text)
        self.expected["A"].append(("study.access", second, ()))
        self.assertEqual(self.assert_history("A")["total"], full["total"] + 1, "the policy write is A's row")
        print("S5-U5B-AUDIT-LIVE " + json.dumps({"A": len(self.expected["A"]), "B": len(self.expected["B"]),
              "pages": len(pages), "inserted": len(self.inserted)}, sort_keys=True))


_declared = sorted(name for name in AdminAuditLive.__dict__ if name.startswith("test_"))
if [name for name, _ in CASES] != _declared:
    raise RuntimeError(f"CASES and the declared cases differ: {_declared}")


if __name__ == "__main__":
    print("Run through scripts/run-tests.py --mode live; direct execution is refused by the gate.", file=sys.stderr)
    raise SystemExit(125)
