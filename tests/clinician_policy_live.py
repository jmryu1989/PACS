# coding: utf-8
"""TEST-S5-U1a-CLINICIAN-LIVE: clinician-only default denial on the real Nest guard, Keycloak and member console.

REQ-S5-U1a-ROLE-DEFAULT-DENY -> RISK-S5-CLINICIAN-WRITER-LEAK/UNCLASSIFIED-ROUTE/ROLE-LIST-DRIFT.
REQ-S5-U1c-ROUTE-COMPLETENESS -> RISK-S5-U1c-NEW-ROUTE-LEAK/MIXED-DOWNGRADE -> TEST-S5-U1c-LIVE-MATRIX: test_01 sweeps
every controller route that is neither public nor allowed and requires them to be exactly the route_matrix denied rows,
test_04 fixes the mixed/legacy role composition on a real study, test_05 runs the live_matrix of the fixtures (a positive,
a wrong-role and a wrong-tenant case for every allow row, one call each).
Hosted synthetic stack only, through scripts/run-tests.py:

    python scripts/run-tests.py --module tests/clinician_policy_live.py --mode live --unit s5-u1c-clinician-policy --timeout 900

Owned data only: run-created Keycloak users (kin-test-*), the run's password-grant client, the realm role `clinician`
only when this run had to create it, the LiveStack gateway service client, and one synthetic C-STORE study shared by
test_04 and test_05 (report left at RS W; nothing here writes a report, item or setting) removed by the class cleanup.
Every clinician-gate denial is discriminated by the guard's own code CLINICIAN_ROUTE_DENIED and by the absence of audit
rows for the clinician actor, so a 403 from a service-layer need() is never counted as one.
"""
from __future__ import annotations

import json
import re
import sys
import unittest
import uuid
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import Request

from invariants_live import LiveStack, controller_routes, psql, purge_user_audit

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = json.loads((ROOT / "tests" / "clinician_policy_fixtures.json").read_text(encoding="utf-8"))
ALLOWED = set(FIXTURES["session_routes"]) | set(FIXTURES["business_routes"])
PUBLIC = set(FIXTURES["public_routes"])
DENIED_ROUTES = {route for routes in FIXTURES["route_matrix"]["denied"].values() for route in routes}
COUNTS = FIXTURES["route_matrix"]["counts"]
LIVE_MATRIX = FIXTURES["live_matrix"]
APP_ROLES = set(FIXTURES["app_roles"])
READ = FIXTURES["read_contract"]
DENIED = FIXTURES["denied_code"]
PROBE = FIXTURES["live_probe_values"]
OWNED_USERNAME = re.compile(r"kin-test-[0-9a-f]{12}-[a-z0-9_-]+")


def probe_path(route: str) -> str:
    path = route
    for token, value in PROBE.items():
        path = path.replace(token, value)
    return "/" + path


def code(result):
    return result.body.get("code") if isinstance(result.body, dict) else None


def message(result) -> str:
    text = result.body.get("message") if isinstance(result.body, dict) else None
    return text if isinstance(text, str) else ""


class ClinicianPolicyLive(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.stack = LiveStack()
        cls.addClassCleanup(cls.stack.cleanup_test_identities)
        cls.addClassCleanup(cls.stack.cleanup_all)
        cls.stack.require_stack()
        cls.created_role = False
        cls.owned_users: list[str] = []
        cls.shared_study = None
        role = cls.stack.kc_admin("GET", "/roles/clinician")
        if role.status == 404:
            created = cls.stack.kc_admin("POST", "/roles", {"name": "clinician", "description": "temporary S5-U1a clinician role"})
            if created.status != 201:
                raise RuntimeError(f"clinician role creation failed: {created.status} {created.text}")
            cls.created_role = True
        elif role.status != 200:
            raise RuntimeError(f"clinician role lookup failed: {role.status} {role.text}")
        cls.addClassCleanup(cls.delete_role_if_created)
        cls.addClassCleanup(cls.delete_owned_users)
        cls.stack.create_test_identity("clinician", ["clinician"], "hallym")
        cls.stack.create_test_identity("clinician-radiologist", ["clinician", "radiologist"], "hallym")
        cls.stack.create_test_identity("clinician-technician", ["clinician", "technician"], "hallym")
        cls.stack.create_test_identity("clinician-admin", ["clinician", "admin"], "kin-center")
        cls.stack.create_test_identity("kclinician", ["clinician"], "kin-center")

    @classmethod
    def delete_role_if_created(cls) -> None:
        if not cls.created_role:
            return
        deleted = cls.stack.kc_admin("DELETE", "/roles/clinician")
        if deleted.status not in (204, 404):
            raise RuntimeError(f"temporary clinician role cleanup failed: {deleted.status}")
        cls.created_role = False

    @classmethod
    def delete_owned_users(cls) -> None:
        failures = []
        for user_id in reversed(cls.owned_users):
            deleted = cls.stack.kc_admin("DELETE", f"/users/{quote(user_id)}")
            if deleted.status not in (204, 404):
                failures.append(f"{user_id}: {deleted.status}")
            else:
                purge_user_audit(user_id)
        cls.owned_users.clear()
        if failures:
            raise RuntimeError("owned member cleanup failed: " + "; ".join(failures))

    # ── owned member helpers (no group => PENDING, two groups => INVALID) ──

    def create_member(self, logical: str, roles: list[str], groups: list[str]) -> tuple[str, str, str]:
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
        reset = self.stack.kc_admin("PUT", f"/users/{quote(user_id)}/reset-password", {
            "type": "password", "value": password, "temporary": False,
        })
        self.assertEqual(reset.status, 204, reset.text)
        for role_name in roles:
            role = self.stack.kc_admin("GET", "/roles/" + quote(role_name))
            self.assertEqual(role.status, 200, role.text)
            assigned = self.stack.kc_admin("POST", f"/users/{quote(user_id)}/role-mappings/realm", [role.body])
            self.assertEqual(assigned.status, 204, assigned.text)
        for group in groups:
            found = self.stack.kc_admin("GET", "/groups?search=" + quote(group))
            self.assertEqual(found.status, 200, found.text)
            exact = [row for row in found.body if row.get("name") == group]
            self.assertEqual(len(exact), 1, group)
            joined = self.stack.kc_admin("PUT", f"/users/{quote(user_id)}/groups/{quote(exact[0]['id'])}")
            self.assertEqual(joined.status, 204, joined.text)
        return user_id, username, password

    def grant(self, username: str, password: str) -> str:
        data = urlencode({
            "client_id": self.stack.test_client_id, "grant_type": "password",
            "username": username, "password": password,
        }).encode("ascii")
        request = Request(self.stack.keycloak, data=data,
                          headers={"Content-Type": "application/x-www-form-urlencoded"}, method="POST")
        try:
            with self.stack._open(request) as response:
                return json.loads(response.read().decode("utf-8"))["access_token"]
        except HTTPError as error:
            self.fail(f"password grant failed for {username}: {error.code} {error.read()[:200]!r}")

    def bearer(self, method: str, path: str, token: str, body=None):
        return self.stack.bearer_request(method, path, token, body)

    def study(self):
        """One run-owned hallym study for test_04 and test_05; its report stays at RS W. stack.cleanup_all removes it."""
        cls = type(self)
        if cls.shared_study is None:
            cls.shared_study = cls.stack.create_fixture()
        return cls.shared_study

    def admin_row(self, username: str) -> dict:
        page = 1
        while True:
            listed = self.stack.request("GET", f"/admin/users?page={page}", "jmryu")
            self.assertEqual(listed.status, 200, listed.text)
            for row in listed.body["users"]:
                if row["username"] == username:
                    return row
            if page * listed.body["pageSize"] >= listed.body["total"]:
                self.fail(f"{username} missing from the member console")
            page += 1

    # ── tests ──

    def test_01_clinician_only_session_routes_and_default_denial(self) -> None:
        me = self.stack.request("GET", "/me", "clinician")
        self.assertEqual(me.status, 200, me.text)
        self.assertEqual((me.body["kind"], me.body["institution"]), ("member", "hallym"))
        self.assertIn("clinician", me.body["roles"])
        self.assertTrue({"radiologist", "technician", "admin"}.isdisjoint(me.body["roles"]))

        routes = controller_routes()
        keys = {m + " " + p for m, p in routes}
        self.assertTrue(ALLOWED <= keys, sorted(ALLOWED - keys))
        # the controllers decide what is probed, so a route without a matrix row is probed too; the matrix is compared after
        swept = []
        for method, path in sorted(routes):
            key = method + " " + path
            if key in PUBLIC or key in ALLOWED:
                continue
            body = {} if method in {"POST", "PUT", "PATCH"} else None
            result = self.stack.request(method, probe_path(path), "clinician", body)
            with self.subTest(route=key):
                self.assertEqual(result.status, 403, result.text)
                self.assertEqual(code(result), DENIED, result.text)
            swept.append(key)
        self.assertEqual(sorted(swept), sorted(DENIED_ROUTES), "RISK-S5-U1c-NEW-ROUTE-LEAK: the probed routes are not "
                         "exactly the route_matrix denied rows")
        self.assertEqual((len(routes), len(swept)), (COUNTS["routes"], COUNTS["denied"]))
        self.assertGreaterEqual(len(routes), len(FIXTURES["baseline_inventory"]["routes"]))

        health = self.stack.request("GET", "/health", "clinician")
        self.assertEqual((health.status, health.body.get("ok")), (200, True), health.text)
        logout = self.stack.request("POST", "/auth/logout", "clinician")
        self.assertEqual(logout.status, 204, logout.text)
        # Guard-level denial never reaches a service: the clinician actor has written no audit row.
        actor = self.stack.actor("clinician").replace("'", "''")
        self.assertEqual(psql(f"SELECT count(*) FROM \"AuditLog\" WHERE actor='{actor}'"), ["0"])
        print("CLINICIAN_LIVE_SWEEP " + json.dumps({"routes": len(routes), "denied": len(swept),
              "allowed": sorted(ALLOWED), "public": sorted(PUBLIC),
              "newly_classified": sorted(FIXTURES["route_matrix"]["post_baseline"])}, ensure_ascii=True, sort_keys=True))

    def test_02_pending_and_invalid_clinician_keep_membership_codes_and_logout(self) -> None:
        for logical, groups, code in (("cpending", [], "INSTITUTION_PENDING"),
                                      ("cinvalid", ["hallym", "kin-center"], "INSTITUTION_INVALID")):
            with self.subTest(logical=logical):
                _user_id, username, password = self.create_member(logical, ["clinician"], groups)
                token = self.grant(username, password)
                me = self.bearer("GET", "/me", token)
                self.assertEqual((me.status, me.body.get("code")), (403, code), me.text)
                prefs = self.bearer("GET", "/prefs", token)
                self.assertEqual((prefs.status, prefs.body.get("code")), (403, code), prefs.text)
                logout = self.bearer("POST", "/auth/logout", token)
                self.assertEqual(logout.status, 204, logout.text)

    def test_03_member_console_approves_updates_and_revokes_a_clinician(self) -> None:
        user_id, username, password = self.create_member("crevoke", [], [])
        path = f"/admin/users/{quote(user_id)}"
        pending = self.bearer("GET", "/me", self.grant(username, password))
        self.assertEqual((pending.status, pending.body.get("code")), (403, "INSTITUTION_PENDING"), pending.text)

        rejected = self.stack.request("PATCH", path, "jmryu", {
            "approvalState": "APPROVED", "institution": "hallym", "roles": ["clinicians"],
        })
        self.assertEqual(rejected.status, 400, rejected.text)
        self.assertIn("허용되지 않은 역할", rejected.body.get("message", ""))

        approved = self.stack.request("PATCH", path, "jmryu", {
            "approvalState": "APPROVED", "institution": "hallym", "roles": ["clinician"],
        })
        self.assertEqual(approved.status, 200, approved.text)
        self.assertEqual((approved.body["approvalState"], approved.body["institution"], approved.body["roles"], approved.body["enabled"]),
                         ("APPROVED", "hallym", ["clinician"], True))
        row = self.admin_row(username)
        self.assertEqual((row["approvalState"], row["roles"]), ("APPROVED", ["clinician"]))

        token = self.grant(username, password)
        me = self.bearer("GET", "/me", token)
        self.assertEqual(me.status, 200, me.text)
        self.assertIn("clinician", me.body["roles"])
        for route in ("/prefs", "/bootstrap", "/studies"):
            result = self.bearer("GET", route, token)
            self.assertEqual((result.status, result.body.get("code")), (403, DENIED), route + " " + result.text)

        mixed = self.stack.request("PATCH", path, "jmryu", {"roles": ["clinician", "radiologist"]})
        self.assertEqual(mixed.status, 200, mixed.text)
        self.assertEqual(mixed.body["roles"], ["clinician", "radiologist"])
        token = self.grant(username, password)
        prefs = self.bearer("GET", "/prefs", token)
        self.assertEqual(prefs.status, 200, prefs.text)

        revoked = self.stack.request("PATCH", path, "jmryu", {"approvalState": "PENDING"})
        self.assertEqual(revoked.status, 200, revoked.text)
        self.assertEqual((revoked.body["approvalState"], revoked.body["institution"], revoked.body["roles"]), ("PENDING", None, []))
        token = self.grant(username, password)
        back = self.bearer("GET", "/me", token)
        self.assertEqual((back.status, back.body.get("code")), (403, "INSTITUTION_PENDING"), back.text)
        self.assertEqual(self.bearer("GET", "/prefs", token).status, 403)

    def test_04_mixed_and_legacy_roles_keep_their_existing_paths(self) -> None:
        for user in ("clinician-radiologist", "clinician-technician"):
            with self.subTest(user=user):
                me = self.stack.request("GET", "/me", user)
                self.assertEqual(me.status, 200, me.text)
                self.assertIn("clinician", me.body["roles"])
                prefs = self.stack.request("GET", "/prefs", user)
                self.assertEqual(prefs.status, 200, prefs.text)
                unassigned = self.stack.request("GET", "/unassigned", user)
                self.assertEqual(unassigned.status, 403, unassigned.text)
                self.assertNotEqual(unassigned.body.get("code"), DENIED, "existing need(admin) decides, not the clinician gate")
        admin = self.stack.request("GET", "/unassigned", "clinician-admin")
        self.assertEqual(admin.status, 200, admin.text)
        for user, status in (("doctor", 403), ("tech", 403), ("jmryu", 200)):
            with self.subTest(user=user):
                self.assertEqual(self.stack.request("GET", "/prefs", user).status, 200)
                result = self.stack.request("GET", "/unassigned", user)
                self.assertEqual(result.status, status, result.text)
                if status == 403:
                    self.assertNotEqual(result.body.get("code"), DENIED)

        # S5-U1c RISK-S5-U1c-MIXED-DOWNGRADE on a real study, one call per case: a mixed member keeps the legacy answer
        # where the clinician gate or projection would narrow, and a clinician-only member inherits none of it
        study = self.study()
        uid = quote(study.uid)
        composition: dict[str, dict] = {}
        for user, editor in (("clinician-radiologist", True), ("clinician-technician", False)):
            with self.subTest(mixed=user):
                listed = self.stack.request("GET", "/studies", user)
                items = self.stack.request("GET", f"/studies/{uid}/viewer-items", user)
                preview = self.stack.request("GET", f"/studies/{uid}/report-preview", user)
                composition[user] = {"studies": listed.status, "viewer-items": [items.status, items.body],
                                     "report-preview": preview.status}
                self.assertEqual(listed.status, 200, listed.text[:300])
                self.assertIn(study.uid, {row["uid"] for row in listed.body["studies"]}, "the legacy worklist is not reduced")
                self.assertEqual((items.status, items.body), (200, {"items": [], "nextCursor": None}),
                                 "the legacy item answer, not the clinician projection")
                self.assertEqual(preview.status, 200, preview.text[:300])
                self.assertEqual(preview.body["canPreviewEditor"], editor, "the legacy role decides, not clinician")
        only: dict[str, list] = {}
        for path in ("/studies", f"/studies/{uid}/report-preview"):
            result = self.stack.request("GET", path, "clinician")
            only[path] = [result.status, code(result)]
            with self.subTest(clinician_only=path):
                self.assertEqual((result.status, code(result)), (403, DENIED), result.text[:300])
        narrowed = self.stack.request("GET", f"/studies/{uid}/viewer-items", "clinician")
        only["viewer-items"] = [narrowed.status, narrowed.body]
        composition["clinician"] = only
        self.assertEqual((narrowed.status, narrowed.body),
                         (200, {"uid": study.uid, "final": False, "items": None, "nextCursor": None}))
        # admin is no institution exception: the kin-center clinician+admin meets the preview's own institution rule
        foreign = self.stack.request("GET", f"/studies/{uid}/report-preview", "clinician-admin")
        composition["clinician-admin"] = {"report-preview": [foreign.status, code(foreign)]}
        self.assertEqual(foreign.status, 403, foreign.text[:300])
        self.assertNotEqual(code(foreign), DENIED, "the institution rule decides, not the clinician gate")
        self.assertIn("판독문 미리보기에 접근할 수 없습니다", message(foreign), foreign.text[:300])
        print("CLINICIAN_LIVE_COMPOSITION " + json.dumps(composition, ensure_ascii=True, sort_keys=True))

    def assert_positive(self, route: str, result, uid: str, instance: str) -> None:
        """What the clinician-only member of the study's institution is answered on each allow row (RS W, no items)."""
        body = result.body
        if route == "GET me":
            self.assertEqual((body["kind"], body["institution"]), ("member", "hallym"))
            self.assertEqual({role for role in body["roles"] if role in APP_ROLES}, {"clinician"})
        elif route == "POST auth/logout":
            self.assertEqual(result.text, "")
        elif route == "GET authz/dicom":
            self.assertTrue(isinstance(body, list) and body, "no DICOM metadata behind the passed auth_request")
        elif route == "POST dicom/lookup":
            self.assertEqual(body, {"id": instance})
        elif route == "GET studies/:uid/viewer-items":
            self.assertEqual(body, {"uid": uid, "final": False, "items": None, "nextCursor": None})
        elif route == "GET clinician/studies":
            self.assertEqual(sorted(body), sorted(READ["list_response_keys"]))
            self.assertIn(uid, {row["uid"] for row in body["studies"]})
        elif route == "GET clinician/studies/:uid/report":
            self.assertEqual(body, {"uid": uid, "report": {"final": False, "rs": "W"}, "keys": None})
        else:
            self.fail("no positive check for " + route)

    def test_05_every_allow_row_has_a_positive_a_wrong_role_and_a_wrong_tenant_case(self) -> None:
        study = self.study()
        uid = study.uid
        instance = self.stack.first_instance_id(uid)
        tags = self.stack._orthanc_request("GET", f"/instances/{quote(instance)}/tags?simplify")
        self.assertEqual(tags.status, 200, tags.text)
        lookup = {"studyUid": uid, "sopUid": tags.body["SOPInstanceUID"]}
        _user_id, username, password = self.create_member("cinvalid", ["clinician"], ["hallym", "kin-center"])
        tokens = {"cinvalid": self.grant(username, password), "gateway": self.stack.service_token("gateway")}

        def call(route: str, identity: str):
            token = tokens[identity] if identity in tokens else self.stack.token(identity)
            if route == "GET authz/dicom":
                # its only caller: nginx auth_request in front of the DICOMweb read
                return self.stack.bearer_request("GET", f"/dicom-web/studies/{quote(uid)}/metadata", token,
                                                 base=self.stack.proxy, headers={"Accept": "*/*"})
            method, template = route.split(" ", 1)
            return self.bearer(method, "/" + template.replace(":uid", quote(uid)), token,
                               lookup if route == "POST dicom/lookup" else None)

        observed: dict[str, list] = {}
        # logout last: a Bearer logout ends no session (AuthService.logout(null)); the order keeps that question out of the reading
        for route in sorted(LIVE_MATRIX["rows"], key=lambda key: (key == "POST auth/logout", key)):
            row = LIVE_MATRIX["rows"][route]
            for name in ("positive", "wrong_role", "wrong_tenant"):
                case = row[name]
                result = call(route, case["as"])
                observed[route + " " + name] = [case["as"], result.status, code(result)]
                with self.subTest(route=route, case=name, identity=case["as"]):
                    self.assertEqual(result.status, case["status"], result.text[:300])
                    self.assertEqual(code(result), case["code"], result.text[:300])
                    if "message" in case:
                        self.assertIn(case["message"], message(result), result.text[:300])
                    if name == "positive":
                        self.assert_positive(route, result, uid, instance)
                    elif case["expect"] == "absent":
                        self.assertNotIn(uid, {r["uid"] for r in result.body["studies"]}, "another institution lists the study")
        self.assertEqual(len(observed), 3 * len(ALLOWED))
        actor = self.stack.actor("clinician").replace("'", "''")
        self.assertEqual(psql(f"SELECT count(*) FROM \"AuditLog\" WHERE actor='{actor}'"), ["0"], "the allow rows are reads")
        print("CLINICIAN_LIVE_MATRIX " + json.dumps({"rows": len(LIVE_MATRIX["rows"]), "cases": len(observed),
              "observed": observed}, ensure_ascii=True, sort_keys=True))


if __name__ == "__main__":
    print("Run through scripts/run-tests.py --mode live; direct execution is refused by the gate.", file=sys.stderr)
    raise SystemExit(125)
