# coding: utf-8
"""TEST-S5-U1b-LIVE: the clinician read contract on the real Nest guard, Prisma, Keycloak, Orthanc and nginx.

REQ-S5-U1b-CLINICIAN-READ -> RISK-S5-U1b-DRAFT-LEAK / NONFINAL-BODY / WRITER-FIELD / COUNT-LEAK / TENANT-UID.
Hosted synthetic stack only, through scripts/run-tests.py (never the original DB, DICOM or accounts):

    python scripts/run-tests.py --module tests/clinician_read_live.py --mode live --unit s5-u1b-clinician-read --timeout 900

Per allow row: a positive read, a wrong-role negative and a wrong-tenant negative. Plus: a revoked member loses
every row, a final report turns into status only after reset, and the same user reading A -> B -> A gets each
study's own answer. Field sets come from tests/clinician_policy_fixtures.json read_contract, shared with the pure
serializer test, so the live answer and the pure projection are held to one list.

Owned data only: run-created Keycloak users (kin-test-*), the run's password-grant client, the realm role
`clinician` only when this run had to create it, and C-STORE fixtures whose viewer rows are removed in dependency
order before the fixture's own cleanup (the product has no DELETE for them).
"""
from __future__ import annotations

import json
import re
import sys
import time
import unittest
import uuid
from datetime import date, datetime, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import Request

from invariants_live import HttpResult, LiveStack, psql, purge_user_audit

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = json.loads((ROOT / "tests" / "clinician_policy_fixtures.json").read_text(encoding="utf-8"))
C = FIXTURES["read_contract"]
DENIED = FIXTURES["denied_code"]
FORBIDDEN = set(C["forbidden_keys"])
OWNED_USERNAME = re.compile(r"kin-test-[0-9a-f]{12}-[a-z0-9_-]+")


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

    def grant(self, username: str, password: str) -> str:
        data = urlencode({"client_id": self.stack.test_client_id, "grant_type": "password",
                          "username": username, "password": password}).encode("ascii")
        request = Request(self.stack.keycloak, data=data,
                          headers={"Content-Type": "application/x-www-form-urlencoded"}, method="POST")
        try:
            with self.stack._open(request) as response:
                return json.loads(response.read().decode("utf-8"))["access_token"]
        except HTTPError as error:
            self.fail(f"password grant failed for {username}: {error.code} {error.read()[:200]!r}")

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

    def test_04_a_revoked_member_loses_every_clinician_read(self) -> None:
        with self.stack.fixture() as fixture:
            uid = fixture.uid
            user_id, username, password = self.create_member("crevoke")
            path = f"/admin/users/{quote(user_id)}"
            approved = self.stack.request("PATCH", path, "jmryu",
                                          {"approvalState": "APPROVED", "institution": "hallym", "roles": ["clinician"]})
            self.assertEqual(approved.status, 200, approved.text)
            token = self.grant(username, password)
            reads = (("GET", "/clinician/studies", None), ("GET", f"/clinician/studies/{quote(uid)}/report", None),
                     ("GET", f"/studies/{quote(uid)}/viewer-items", None), ("POST", "/dicom/lookup", {"studyUid": uid, "sopUid": "1.2"}))
            for method, route, body in reads[:3]:
                self.assertEqual(self.stack.bearer_request(method, route, token, body).status, 200, route)

            revoked = self.stack.request("PATCH", path, "jmryu", {"approvalState": "PENDING"})
            self.assertEqual(revoked.status, 200, revoked.text)
            token = self.grant(username, password)
            for method, route, body in reads:
                with self.subTest(revoked=route):
                    result = self.stack.bearer_request(method, route, token, body)
                    self.assertEqual((result.status, code(result)), (403, "INSTITUTION_PENDING"), result.text)
            self.assertEqual(self.stack.bearer_request("POST", "/auth/logout", token).status, 204)

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


if __name__ == "__main__":
    print("Run through scripts/run-tests.py --mode live; direct execution is refused by the gate.", file=sys.stderr)
    raise SystemExit(125)
