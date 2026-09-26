# coding: utf-8
"""TEST-S5-U4c-LIVE: external-image and image-transfer requests on the real Nest guard and service, PostgreSQL,
Keycloak and Orthanc.

REQ-S5-U4p-ATTRIBUTION/TENANT/STUDY-ACCESS-READ/REQUEST-STATE/IDEMPOTENCY/LATE-UPDATE/REVOCATION/ROLE-MATRIX/
CONNECT-SEPARATE/AUDIT/AUDIT-READ -> RISK-S5-U4p-REQUEST-AS-TRANSFER/REPLAY-HISTORY/REPLAY-AFTER-REVOKE/BODY-ATTRIBUTION/
PHI-IN-AUDIT/AUDIT-READ-LEAK/ACCESS-READ-CONFLATION/COUNT-LEAK -> TEST-S5-U4c-LIVE (contract S5-U4p section 2.3, 4.1,
7.1, 11.1, decision D33: OQ-1, OQ-5, OQ-7, OQ-10, OQ-13, OQ-14 and OQ-15 a). The case names are the contract's R01-R11.
Hosted synthetic stack only, through scripts/run-tests.py:

    python scripts/run-tests.py --module tests/clinician_request_live.py --mode live --unit s5-u4c-image-request --timeout 1800

CASES below is the pinned order (one unittest class, the declaration order is the run order) with the expected seconds
of each case on the hosted synthetic stack; SETUP_SECONDS covers the class identities. The module refuses to load when
the class and CASES disagree.

Owned data only: run-created Keycloak users (kin-test-*), a pending member created and deleted here, the realm role
`clinician` only when this run had to create it, the LiveStack test client and gateway client, one synthetic C-STORE
study per case (two in R10), the request rows, receipts and audit rows written on those studies, and SYNTHETIC
StudyAccess policies on this run's technicians and mixed members. Every case removes its request rows before the study
cleanup (every foreign key RESTRICT, and LiveStack.cleanup_fixture deletes StudyState directly), refusing rows another
member wrote. R05 and R10 move the owning institution of their own synthetic study with psql (no product path moves
ownership, contract F-21) and move it back in a finally block; R05 removes the technician role from one of its own mixed
members and the clinician role from another. Nothing here writes Transfer, TransferBasis or ProcessingAgreement: R01 and
R11 read them (row count and a digest of every row) and Orthanc's statistics, change log and jobs before and after.

Not proved here: withdrawing a clinician-only member's access per study (study-access target() still manages admin,
radiologist and technician members only, decision D33 OQ-8 b); a third institution beyond hallym and kin-center (R10
uses kin-center as the tele institution B, after the psql move as the owner C, and on a second study without tele as
the counterparty institution D). The screen and its Closed sentence are S5-U4c 2/2.
"""
from __future__ import annotations

import base64
import json
import re
import sys
import unittest
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import Request

from clinician_question_live import TIME_ONLY_CHANGES, code, lit, member_owner, restricted, rule
from invariants_live import LiveStack, psql, purge_user_audit

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[1]
SERVICE = ROOT / "api" / "src" / "image-request.service.ts"

CASES = (
    ("test_r01_registration_creates_no_transfer_rows", 40),
    ("test_r02_state_machine_and_handlers", 55),
    ("test_r03_active_duplicate_and_replay", 45),
    ("test_r04_counterparty_validation_and_no_counterparty_visibility", 40),
    ("test_r05_cross_tenant_and_revocation", 75),
    ("test_r06_dto_has_no_transfer_vocabulary", 30),
    ("test_r07_role_matrix", 90),
    ("test_r08_connect_routes_still_deny_clinician", 25),
    ("test_r09_audit_rows", 30),
    ("test_r10_audit_rows_owner_institution_only", 65),
    ("test_r11_metadata_study_access_allows_and_denies", 60),
)
SETUP_SECONDS = 105
EXPECTED_SECONDS = SETUP_SECONDS + sum(seconds for _name, seconds in CASES)

IDENTITIES = (
    ("clinician", ["clinician"], "hallym"),
    ("clinician2", ["clinician"], "hallym"),
    ("kclinician", ["clinician"], "kin-center"),
    ("clinrad", ["clinician", "radiologist"], "hallym"),
    ("clintech", ["clinician", "technician"], "hallym"),
    ("hadmin", ["admin"], "hallym"),
    ("kadmin", ["admin"], "kin-center"),
    ("rta", ["technician"], "hallym"),                 # R05: StudyAccess restricts it away from the study
    ("rct", ["clinician", "technician"], "hallym"),    # R05: loses technician (S-R12)
    ("rcr", ["clinician", "radiologist"], "hallym"),   # R05: the requester loses clinician
    ("rt1", ["technician"], "hallym"),                 # R11: modality matches
    ("rt2", ["technician"], "hallym"),                 # R11: modality does not match
    ("rw", ["clinician", "radiologist"], "hallym"),    # R11: patientId matches
    ("rw2", ["clinician", "radiologist"], "hallym"),   # R11: dateTo before the study date
)
APPLIED_KEYS = ["action", "at", "from", "id", "kind", "requestId", "revision", "studyUid", "to"]
DETAIL_KEYS = ["action", "counterpartyInstitutionId", "from", "id", "institution", "kind", "requestId", "revision", "role", "to"]
ITEM_KEYS = ["counterparty", "createdAt", "handler", "id", "kind", "note", "reason", "requester", "revision", "state",
             "studyUid", "updatedAt"]
REUSED = "REQUEST_ID_REUSED"
MISSING = "IMAGE_REQUEST_NOT_FOUND"
ROLE = "IMAGE_REQUEST_ROLE_REQUIRED"
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
STUDY_UID = re.compile(r"^[0-9]+(?:\.[0-9]+)+$")
OWNED_USERNAME = re.compile(r"kin-test-[0-9a-f]{12}-[a-z0-9_-]+")
# R06: no response key may say that images moved (contract section 3.3); compared case-insensitively
TRANSFER_WORDS = ("transfer", "sent", "delivered", "imported", "completed")
CONNECT_TABLES = ("Transfer", "TransferBasis", "ProcessingAgreement")
CONNECT_ROUTES = (("GET", "admin/agreements"), ("POST", "admin/agreements"), ("PATCH", "admin/agreements/:id"),
                  ("GET", "studies/:uid/basis"), ("POST", "studies/:uid/basis"), ("POST", "studies/:uid/basis/:id/revoke"),
                  ("POST", "studies/:uid/transfers"), ("GET", "transfers"), ("POST", "transfers/:id/revoke"))


# ── request helpers shared with clinician_policy_live test_05 (the matrix's :id request and its cleanup) ──

def make_image_request(stack, user: str, uid: str, owner: list[str], kind: str = "image-transfer",
                       counterparty: str = "SYNTHETIC receiving hospital", counterparty_id: str | None = None,
                       reason: str = "SYNTHETIC image request", rid: str | None = None):
    """POST studies/:uid/image-requests with exactly the six keys the service takes: (requestId, HTTP result)."""
    rid = rid or str(uuid.uuid4())
    return rid, stack.request("POST", f"/studies/{quote(uid)}/image-requests", user, {
        "requestId": rid, "expectedOwner": owner, "kind": kind, "counterparty": counterparty,
        "counterpartyInstitutionId": counterparty_id, "reason": reason})


def read_request_row(rid: str) -> dict:
    """The StudyImageRequest row of one id, read with psql; anything but exactly one row fails the calling case."""
    if not UUID.fullmatch(rid):
        raise AssertionError(f"not a request id: {rid!r}")
    rows = psql(f'SELECT to_jsonb(t)::text FROM "StudyImageRequest" t WHERE id={lit(rid)}')
    if len(rows) != 1:
        raise AssertionError(f"StudyImageRequest {rid}: {rows}")
    return json.loads(rows[0])


def drop_study_image_requests(uid: str, owned: set[str]) -> None:
    """Request rows of one run-owned study, receipts first; rows a subject outside owned wrote stop the cleanup.

    Every foreign key RESTRICTs and LiveStack.cleanup_fixture deletes StudyState directly, so a module that writes
    requests on its study runs this before the study cleanup."""
    if not STUDY_UID.fullmatch(uid):
        raise RuntimeError(f"refusing request cleanup for an abnormal UID: {uid}")
    subjects = set(psql(f'SELECT DISTINCT "requesterSub" FROM "StudyImageRequest" WHERE "studyUid"={lit(uid)}'))
    subjects |= set(psql(f'SELECT DISTINCT c."subjectSub" FROM "StudyImageRequestReceipt" c JOIN "StudyImageRequest" r '
                         f'ON r.id=c."imageRequestId" WHERE r."studyUid"={lit(uid)}'))
    foreign = subjects - owned
    if foreign:
        raise RuntimeError(f"refusing to delete request rows this run did not write: {sorted(foreign)}")
    psql(f'BEGIN; DELETE FROM "StudyImageRequestReceipt" c USING "StudyImageRequest" r WHERE r.id=c."imageRequestId" '
         f'AND r."studyUid"={lit(uid)}; DELETE FROM "StudyImageRequest" WHERE "studyUid"={lit(uid)}; COMMIT;')
    if psql(f'SELECT count(*) FROM "StudyImageRequest" WHERE "studyUid"={lit(uid)}') != ["0"]:
        raise RuntimeError("request rows remained after cleanup")


class ClinicianRequestLive(unittest.TestCase):
    maxDiff = None

    @classmethod
    def setUpClass(cls) -> None:
        cls.stack = LiveStack()
        cls.owned_users: list[str] = []
        cls.owners: dict[str, list[str]] = {}
        cls.created_role = False
        cls.addClassCleanup(cls.stack.cleanup_test_identities)
        cls.addClassCleanup(cls.stack.cleanup_all)
        cls.addClassCleanup(cls.drop_all_requests)
        cls.stack.require_stack()
        role = cls.stack.kc_admin("GET", "/roles/clinician")
        if role.status == 404:
            created = cls.stack.kc_admin("POST", "/roles", {"name": "clinician", "description": "temporary S5-U4c clinician role"})
            if created.status != 201:
                raise RuntimeError(f"clinician role creation failed: {created.status} {created.text}")
            cls.created_role = True
        elif role.status != 200:
            raise RuntimeError(f"clinician role lookup failed: {role.status} {role.text}")
        cls.addClassCleanup(cls.delete_role_if_created)
        cls.addClassCleanup(cls.delete_owned_users)
        for logical, roles, group in IDENTITIES:
            cls.stack.create_test_identity(logical, roles, group)

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

    @classmethod
    def owned_subjects(cls) -> set[str]:
        return set(cls.stack.user_ids.values()) | set(cls.owned_users)

    @classmethod
    def drop_requests(cls, uid: str) -> None:
        drop_study_image_requests(uid, cls.owned_subjects())

    @classmethod
    def drop_all_requests(cls) -> None:
        # Safety net before LiveStack.cleanup_all: a failed per-case cleanup must not leave the study delete refused.
        for uid in list(cls.stack.active):
            cls.drop_requests(uid)

    # ── helpers ──

    def study(self):
        fixture = self.stack.create_fixture()
        self.addCleanup(self.stack.cleanup_fixture, fixture.uid)
        self.addCleanup(self.drop_requests, fixture.uid)
        return fixture

    def owner(self, user: str) -> list[str]:
        if user not in self.owners:
            self.owners[user] = member_owner(self.stack, user)
        return self.owners[user]

    def check(self, result, status: int, expected_code: str | None = None):
        self.assertEqual(result.status, status, result.text[:500])
        if expected_code is not None:
            self.assertEqual(code(result), expected_code, result.text[:500])
        return result

    def make(self, user, uid, kind="image-transfer", counterparty="SYNTHETIC receiving hospital", counterparty_id=None,
             reason="SYNTHETIC image request", rid=None, expect=201, expected_code=None):
        rid, result = make_image_request(self.stack, user, uid, self.owner(user), kind, counterparty, counterparty_id, reason, rid)
        return rid, self.check(result, expect, expected_code)

    def change(self, user, rid, revision, action, note="", request_id=None, expect=201, expected_code=None):
        request_id = request_id or str(uuid.uuid4())
        result = self.stack.request("POST", f"/image-requests/{quote(rid)}", user, {
            "requestId": request_id, "expectedOwner": self.owner(user), "revision": revision, "action": action, "note": note})
        return request_id, self.check(result, expect, expected_code)

    def read(self, user, rid):
        result = self.check(self.stack.request("GET", f"/image-requests/{quote(rid)}", user), 200)
        self.assertEqual(sorted(result.body), ["item", "owner"])
        self.assertEqual(sorted(result.body["item"]), ITEM_KEYS)
        return result.body["item"]

    def listed(self, user, view, state="all", expect=200, expected_code=None, cursor=None):
        path = "/image-requests?view=" + view + "&state=" + state + ("&cursor=" + cursor if cursor else "")
        return self.check(self.stack.request("GET", path, user), expect, expected_code)

    def ids(self, result) -> set[str]:
        return {item["id"] for item in result.body["items"]}

    def shape(self, result) -> tuple:
        applied = result.body["applied"]
        return applied["action"], applied["from"], applied["to"], applied["revision"]

    def request_row(self, rid) -> dict:
        return read_request_row(rid)

    def receipts(self, rid) -> list[dict]:
        self.assertRegex(rid, UUID)
        return [json.loads(raw) for raw in psql(
            f'SELECT to_jsonb(t)::text FROM "StudyImageRequestReceipt" t WHERE "imageRequestId"={lit(rid)} ORDER BY "appliedRevision"')]

    def request_audits(self, uid) -> list[dict]:
        self.assertRegex(uid, STUDY_UID)
        return [json.loads(raw) for raw in psql(
            f"SELECT to_jsonb(t)::text FROM \"AuditLog\" t WHERE target={lit(uid)} AND action='study.image-request' ORDER BY id")]

    def ledger(self, uid, rid) -> tuple:
        """(request revision, receipt rows, study.image-request audit rows of this request)."""
        audits = [row for row in self.request_audits(uid) if json.loads(row["detail"])["id"] == rid]
        return self.request_row(rid)["revision"], len(self.receipts(rid)), len(audits)

    def count_requests(self, uid) -> list[str]:
        self.assertRegex(uid, STUDY_UID)
        return psql(f'SELECT count(*) FROM "StudyImageRequest" WHERE "studyUid"={lit(uid)}')

    def move(self, uid, institution, tele=None) -> None:
        """F-21: no product route moves a study's owner; only this run's synthetic study is moved."""
        self.assertRegex(uid, STUDY_UID)
        self.assertIn(institution, ("hallym", "kin-center"))
        value = "NULL" if tele is None else lit(tele)
        psql(f'UPDATE "StudyState" SET "institutionId"={lit(institution)}, "teleInstitutionId"={value} WHERE uid={lit(uid)}')

    def tele(self, uid) -> None:
        opened = self.check(self.stack.request("PATCH", f"/studies/{quote(uid)}", "doctor", {"ts": "wait", "teleTo": "kin-center"}), 200)
        self.assertEqual(opened.body["teleInstitutionId"], "kin-center")

    def restrict(self, logical, policy) -> None:
        subject = self.stack.user_ids[logical]
        self.addCleanup(self.clear_access, subject)
        written = self.stack.request("POST", f"/admin/users/{quote(subject)}/study-access", "jmryu", {
            "expectedOwner": self.owner("jmryu"), "policy": policy, "revision": 0,
            "reason": "SYNTHETIC S5-U4c access condition", "requestId": str(uuid.uuid4())})
        self.check(written, 201)

    def clear_access(self, subject) -> None:
        self.assertIn(subject, self.stack.user_ids.values())
        for table in ("StudyAccessRevision", "StudyAccessPolicy"):
            for raw in psql(f'SELECT to_jsonb(t)::text FROM "{table}" t WHERE subject={lit(subject)}'):
                self.assertTrue(json.loads(raw)["reason"].startswith("SYNTHETIC"))
                self.assertEqual(psql(f'DELETE FROM "{table}" t WHERE to_jsonb(t)={lit(raw)}::jsonb RETURNING 1'), ["1"])
        for raw in psql(f"SELECT to_jsonb(t)::text FROM \"AuditLog\" t WHERE target={lit(subject)} AND action='study.access'"):
            self.assertTrue(json.loads(json.loads(raw)["detail"])["reason"].startswith("SYNTHETIC"))
            self.assertEqual(psql(f'DELETE FROM "AuditLog" t WHERE to_jsonb(t)={lit(raw)}::jsonb RETURNING 1'), ["1"])

    def remove_role(self, logical, role_name) -> None:
        role = self.stack.kc_admin("GET", "/roles/" + quote(role_name))
        self.assertEqual(role.status, 200, role.text)
        removed = self.stack.kc_admin("DELETE", f"/users/{quote(self.stack.user_ids[logical])}/role-mappings/realm", [role.body])
        self.assertEqual(removed.status, 204, removed.text)
        self.stack.tokens.pop(logical, None)   # the next call takes a token without the role

    def cursor(self, at, rid, revision) -> str:
        raw = json.dumps({"at": at, "id": rid, "r": revision}, separators=(",", ":")).encode("utf-8")
        return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")

    def audit(self, user, uid, take, scoped=True):
        path = f"/audit?uid={quote(uid)}&take={take}" if scoped else f"/audit?take={take}"
        return self.stack.request("GET", path, user)

    def pending_token(self) -> str:
        """An unapproved member (clinician role, no institution group): the guard answers INSTITUTION_PENDING."""
        username = f"kin-test-{uuid.uuid4().hex[:12]}-rpending"
        self.assertRegex(username, OWNED_USERNAME)
        password = uuid.uuid4().hex + "Aa1!"
        created = self.stack.kc_admin("POST", "/users", {
            "username": username, "enabled": True, "emailVerified": True,
            "email": username + "@local.test", "firstName": "KIN", "lastName": "rpending"})
        self.assertEqual(created.status, 201, created.text)
        user_id = str(created.body)
        self.owned_users.append(user_id)
        reset = self.stack.kc_admin("PUT", f"/users/{quote(user_id)}/reset-password",
                                    {"type": "password", "value": password, "temporary": False})
        self.assertEqual(reset.status, 204, reset.text)
        role = self.stack.kc_admin("GET", "/roles/clinician")
        self.assertEqual(role.status, 200, role.text)
        assigned = self.stack.kc_admin("POST", f"/users/{quote(user_id)}/role-mappings/realm", [role.body])
        self.assertEqual(assigned.status, 204, assigned.text)
        data = urlencode({"client_id": self.stack.test_client_id, "grant_type": "password",
                          "username": username, "password": password}).encode("ascii")
        request = Request(self.stack.keycloak, data=data, headers={"Content-Type": "application/x-www-form-urlencoded"}, method="POST")
        try:
            with self.stack._open(request) as response:
                return json.loads(response.read().decode("utf-8"))["access_token"]
        except HTTPError as error:
            self.fail(f"password grant failed for {username}: {error.code}")

    def orthanc_marks(self) -> dict:
        stats = self.stack._orthanc_request("GET", "/statistics")
        changes = self.stack._orthanc_request("GET", "/changes?last")
        jobs = self.stack._orthanc_request("GET", "/jobs")
        for result in (stats, changes, jobs):
            self.assertEqual(result.status, 200, result.text[:300])
        return {"studies": stats.body["CountStudies"], "instances": stats.body["CountInstances"],
                "last": changes.body["Last"], "jobs": sorted(jobs.body)}

    def assert_orthanc_unchanged(self, before) -> None:
        """No store, move, modify, delete or job: counts, jobs and the change log move only by Orthanc's own timers."""
        after = self.orthanc_marks()
        self.assertEqual((after["studies"], after["instances"], after["jobs"]), (before["studies"], before["instances"], before["jobs"]))
        if after["last"] != before["last"]:
            listed = self.stack._orthanc_request("GET", f"/changes?since={before['last']}&limit=1000")
            self.assertEqual(listed.status, 200, listed.text[:300])
            kinds = {change["ChangeType"] for change in listed.body["Changes"]}
            self.assertTrue(kinds <= TIME_ONLY_CHANGES, sorted(kinds))

    def connect_marks(self) -> dict:
        """Row count and a digest of every row of the three Connect tables: a request reads and writes none of them."""
        return {table: psql(f"SELECT count(*)::text || ':' || coalesce(md5(string_agg(to_jsonb(t)::text, ',' "
                            f"ORDER BY to_jsonb(t)::text)), '') FROM \"{table}\" t") for table in CONNECT_TABLES}

    # ── cases (contract S5-U4p section 2.3 names) ──

    def test_r01_registration_creates_no_transfer_rows(self) -> None:
        f = self.study()
        connect, marks = self.connect_marks(), self.orthanc_marks()
        r0, created = self.make("clinician", f.uid, counterparty_id="kin-center")
        rid = created.body["applied"]["id"]
        a, accepted = self.change("tech", rid, 1, "accept")
        b, closed = self.change("tech", rid, 2, "close", note="SYNTHETIC R01 processing record")
        for again, first in ((self.make("clinician", f.uid, counterparty_id="kin-center", rid=r0)[1], created),
                             (self.change("tech", rid, 1, "accept", request_id=a)[1], accepted),
                             (self.change("tech", rid, 2, "close", note="SYNTHETIC R01 processing record", request_id=b)[1], closed)):
            self.assertEqual((again.body["replayed"], again.body["applied"]), (True, first.body["applied"]))
        _, declined = self.make("clinician", f.uid, kind="external-image")
        self.change("hadmin", declined.body["applied"]["id"], 1, "decline", note="SYNTHETIC R01 decline reason")
        _, cancelled = self.make("clinician", f.uid, kind="external-image")
        self.change("clinician", cancelled.body["applied"]["id"], 1, "cancel", note="SYNTHETIC R01 cancel reason")
        self.assertEqual(self.read("tech", rid)["state"], "Closed")
        # (a) the three Connect tables and (b) Orthanc: a request, every transition and every replay leave them as they were
        self.assertEqual(self.connect_marks(), connect, "a request never reads or writes Transfer, TransferBasis or ProcessingAgreement")
        self.assertEqual(psql(f'SELECT count(*) FROM "Transfer" WHERE "studyUid"={lit(f.uid)}'), ["0"])
        self.assert_orthanc_unchanged(marks)
        # (c) the source: two injected services, no Orthanc or Connect service, no Connect delegate or table
        source = SERVICE.read_text(encoding="utf-8")
        constructor = re.search(r"constructor\(([^)]*)\)", source)
        self.assertIsNotNone(constructor)
        self.assertEqual(re.findall(r":\s*([A-Za-z]+)", constructor.group(1)), ["PrismaService", "StudyAccessService"])
        for banned in ("OrthancService", "ConnectService", "orthanc.service", "connect.service",
                       '"Transfer"', '"TransferBasis"', '"ProcessingAgreement"'):
            self.assertNotIn(banned, source, banned)
        self.assertEqual(re.findall(r"\.\s*(?:transfer|transferBasis|processingAgreement)\b", source), [])
        self.assertEqual(sorted(re.findall(r"^import .* from '([^']+)';$", source, re.M)),
                         sorted(["@nestjs/common", "node:crypto", "./prisma.service", "./study-access.service",
                                 "./clinician-policy", "./pacs.service"]))

    def test_r02_state_machine_and_handlers(self) -> None:
        f = self.study()
        tech, admin = self.stack.actor("tech"), self.stack.actor("hadmin")
        # R-T2 then R-T3: Requested -> Accepted -> Closed by a technician
        _, made = self.make("clinician", f.uid)
        r1 = made.body["applied"]["id"]
        self.assertEqual(self.shape(made), ("create", None, "Requested", 1))
        self.assertIsNone(self.read("tech", r1)["handler"])
        _, accepted = self.change("tech", r1, 1, "accept")
        self.assertEqual(self.shape(accepted), ("accept", "Requested", "Accepted", 2))
        self.change("tech", r1, 2, "accept", expect=409, expected_code="IMAGE_REQUEST_STATE")
        _, closed = self.change("tech", r1, 2, "close", note="SYNTHETIC R02 processing record")
        self.assertEqual(self.shape(closed), ("close", "Accepted", "Closed", 3))
        item = self.read("doctor", r1)
        self.assertEqual((item["state"], item["revision"], item["handler"]["actor"], item["note"]),
                         ("Closed", 3, tech, "SYNTHETIC R02 processing record"))
        # a terminal state refuses every change at the current revision
        for user, action, note in (("tech", "accept", ""), ("tech", "close", "SYNTHETIC R02 late"),
                                   ("hadmin", "decline", "SYNTHETIC R02 late"), ("clinician", "cancel", "SYNTHETIC R02 late")):
            with self.subTest(terminal=action):
                self.change(user, r1, 3, action, note=note, expect=409, expected_code="IMAGE_REQUEST_STATE")
        # R-T4 from Requested by an admin; R-T5 from Accepted by the requester, which keeps the technician as handler
        _, second = self.make("clinician", f.uid, kind="external-image")
        r2 = second.body["applied"]["id"]
        _, declined = self.change("hadmin", r2, 1, "decline", note="SYNTHETIC R02 decline reason")
        self.assertEqual(self.shape(declined), ("decline", "Requested", "Declined", 2))
        self.assertEqual(self.read("tech", r2)["handler"]["actor"], admin)
        _, third = self.make("clinician", f.uid)
        r3 = third.body["applied"]["id"]
        self.change("tech", r3, 1, "accept")
        _, cancelled = self.change("clinician", r3, 2, "cancel", note="SYNTHETIC R02 cancel reason")
        self.assertEqual(self.shape(cancelled), ("cancel", "Accepted", "Cancelled", 3))
        item = self.read("clinician", r3)
        self.assertEqual((item["state"], item["handler"]["actor"], item["note"]), ("Cancelled", tech, "SYNTHETIC R02 cancel reason"))
        # R-T3 straight from Requested, R-T4 from Accepted, R-T5 from Requested by an admin
        _, fourth = self.make("clinrad", f.uid)
        r4 = fourth.body["applied"]["id"]
        _, direct = self.change("hadmin", r4, 1, "close", note="SYNTHETIC R02 closed without accept")
        self.assertEqual(self.shape(direct), ("close", "Requested", "Closed", 2))
        _, fifth = self.make("clinrad", f.uid, kind="external-image")
        r5 = fifth.body["applied"]["id"]
        self.change("clintech", r5, 1, "accept")
        _, late = self.change("tech", r5, 2, "decline", note="SYNTHETIC R02 declined after accept")
        self.assertEqual(self.shape(late), ("decline", "Accepted", "Declined", 3))
        _, sixth = self.make("clinician2", f.uid)
        r6 = sixth.body["applied"]["id"]
        _, admin_cancel = self.change("hadmin", r6, 1, "cancel", note="SYNTHETIC R02 admin cancel")
        self.assertEqual(self.shape(admin_cancel), ("cancel", "Requested", "Cancelled", 2))
        self.assertEqual(self.read("tech", r6)["handler"]["actor"], admin)
        # the note rule: accept takes '', every other action 1..2000 characters that are not blank
        _, seventh = self.make("clinician2", f.uid, kind="external-image")
        r7 = seventh.body["applied"]["id"]
        for user, action, note in (("tech", "accept", "SYNTHETIC not empty"), ("tech", "close", ""), ("tech", "decline", "   "),
                                   ("clinician2", "cancel", ""), ("tech", "close", "S" * 2001)):
            with self.subTest(note=action + ":" + str(len(note))):
                self.change(user, r7, 1, action, note=note, expect=400, expected_code="IMAGE_REQUEST_INPUT_INVALID")
        self.assertEqual(self.ledger(f.uid, r7), (1, 1, 1))
        for rid, revision in ((r1, 3), (r2, 2), (r3, 3), (r4, 2), (r5, 3), (r6, 2)):
            with self.subTest(ledger=rid):
                self.assertEqual(self.ledger(f.uid, rid), (revision, revision, revision))
        self.assertEqual(psql(f'SELECT count(*) FROM "Transfer" WHERE "studyUid"={lit(f.uid)}'), ["0"], "Closed is not a transfer")

    def test_r03_active_duplicate_and_replay(self) -> None:
        f = self.study()
        reason, record = "SYNTHETIC R03 reason", "SYNTHETIC R03 processing record"
        r0, created = self.make("clinician", f.uid, reason=reason)
        rid = created.body["applied"]["id"]
        a, accepted = self.change("tech", rid, 1, "accept")
        b, closed = self.change("tech", rid, 2, "close", note=record)
        self.assertEqual(self.ledger(f.uid, rid), (3, 3, 3))
        replays = {"S-R1": (self.make("clinician", f.uid, reason=reason, rid=r0)[1], created, ("create", None, "Requested", 1)),
                   "S-R2": (self.change("tech", rid, 1, "accept", request_id=a)[1], accepted, ("accept", "Requested", "Accepted", 2)),
                   "S-R3": (self.change("tech", rid, 2, "close", note=record, request_id=b)[1], closed, ("close", "Accepted", "Closed", 3))}
        for case, (again, first, shape) in replays.items():
            with self.subTest(case=case):
                self.assertEqual((again.status, again.body["replayed"]), (201, True))
                self.assertEqual(again.body["applied"], first.body["applied"])
                self.assertEqual(sorted(again.body["applied"]), APPLIED_KEYS)
                self.assertEqual(self.shape(again), shape)
        self.assertEqual(self.ledger(f.uid, rid), (3, 3, 3))
        refusals = (
            ("S-R4", lambda: self.make("clinician", f.uid, reason="SYNTHETIC R03 other reason", rid=r0, expect=409, expected_code=REUSED)),
            ("S-R5", lambda: self.change("tech", rid, 1, "decline", note="SYNTHETIC R03 decline", request_id=a, expect=409,
                                         expected_code=REUSED)),
            ("S-R6", lambda: self.change("tech", rid, 2, "close", note="SYNTHETIC R03 other record", request_id=b, expect=409,
                                         expected_code=REUSED)),
            # A with a note never reaches the receipt: accept takes '' only, so it is the input stage's 400
            ("A with a note", lambda: self.change("tech", rid, 1, "accept", note="SYNTHETIC R03 note", request_id=a, expect=400,
                                                  expected_code="IMAGE_REQUEST_INPUT_INVALID")),
            # another requester with R0's own body: the fingerprint names the subject
            ("R0 by another clinician", lambda: self.make("clinician2", f.uid, reason=reason, rid=r0, expect=409, expected_code=REUSED)),
        )
        for case, call in refusals:
            with self.subTest(case=case):
                call()
        self.assertEqual(self.ledger(f.uid, rid), (3, 3, 3))
        # S-R7: a new active request of the same study and kind; S-R8: R0 still answers its receipt; S-R9: a third create
        _, fresh = self.make("clinician", f.uid, reason="SYNTHETIC R03 second request")
        self.assertEqual((fresh.body["replayed"], self.shape(fresh)), (False, ("create", None, "Requested", 1)))
        second = fresh.body["applied"]["id"]
        self.assertNotEqual(second, rid)
        again = self.make("clinician", f.uid, reason=reason, rid=r0)[1]
        self.assertEqual((again.status, again.body["replayed"], again.body["applied"]), (201, True, created.body["applied"]))
        self.make("clinician", f.uid, reason="SYNTHETIC R03 third request", expect=409, expected_code="IMAGE_REQUEST_ACTIVE_EXISTS")
        # A sent to the new request: the receipt belongs to the first one
        self.change("tech", second, 1, "accept", request_id=a, expect=409, expected_code=REUSED)
        # S-R10 / S-R11: new requestIds on the Closed request
        self.change("tech", rid, 3, "decline", note="SYNTHETIC R03 late decline", expect=409, expected_code="IMAGE_REQUEST_STATE")
        self.change("tech", rid, 2, "decline", note="SYNTHETIC R03 late decline", expect=409, expected_code="IMAGE_REQUEST_CHANGED")
        self.assertEqual(self.ledger(f.uid, rid), (3, 3, 3))
        self.assertEqual(self.ledger(f.uid, second), (1, 1, 1))
        self.assertEqual(self.count_requests(f.uid), ["2"])

    def test_r04_counterparty_validation_and_no_counterparty_visibility(self) -> None:
        f = self.study()
        path = f"/studies/{quote(f.uid)}/image-requests"
        owner = self.owner("clinician")

        def body(**changes):
            return {"requestId": str(uuid.uuid4()), "expectedOwner": owner, "kind": "image-transfer",
                    "counterparty": "SYNTHETIC R04 hospital", "counterpartyInstitutionId": "kin-center",
                    "reason": "SYNTHETIC R04 reason", **changes}

        invalid = "IMAGE_REQUEST_INPUT_INVALID"
        for label, changes, expected in (
                ("unknown institution", {"counterpartyInstitutionId": "SYNTHETIC-no-such-institution"}, "IMAGE_REQUEST_COUNTERPARTY_INVALID"),
                ("own institution", {"counterpartyInstitutionId": "hallym"}, "IMAGE_REQUEST_COUNTERPARTY_INVALID"),
                ("empty institution id", {"counterpartyInstitutionId": ""}, invalid),
                ("empty counterparty", {"counterparty": ""}, invalid),
                ("blank counterparty", {"counterparty": "   "}, invalid),
                ("counterparty over 256", {"counterparty": "S" * 257}, invalid),
                ("reason over 2000", {"reason": "S" * 2001}, invalid),
                ("kind", {"kind": "transfer"}, invalid),
                ("body attribution: institution", {"institution": "kin-center"}, invalid),
                ("body attribution: institutionId", {"institutionId": "kin-center"}, invalid),
                ("body attribution: requesterSub", {"requesterSub": self.stack.user_ids["clinician2"]}, invalid),
                ("body attribution: role", {"role": "technician"}, invalid)):
            with self.subTest(case=label):
                self.check(self.stack.request("POST", path, "clinician", body(**changes)), 400, expected)
        missing = body()
        del missing["counterpartyInstitutionId"]
        self.check(self.stack.request("POST", path, "clinician", missing), 400, invalid)
        self.assertEqual(self.count_requests(f.uid), ["0"])
        rid, created = self.make("clinician", f.uid, counterparty="SYNTHETIC R04 hospital", counterparty_id="kin-center")
        self.assertEqual(created.body["applied"]["id"], rid)
        # attribution comes from the token: the row's institution, requester sub and actor, and the displayed name
        row, me = self.request_row(rid), self.stack.request("GET", "/me", "clinician")
        self.assertEqual((row["institutionId"], row["requesterSub"], row["requesterActor"], row["requesterName"]),
                         ("hallym", self.stack.user_ids["clinician"], self.stack.actor("clinician"), me.body["displayName"]))
        item = self.read("tech", rid)
        self.assertEqual(item["counterparty"], {"text": "SYNTHETIC R04 hospital", "institutionId": "kin-center"})
        self.assertEqual(item["requester"], {"actor": self.stack.actor("clinician"), "name": me.body["displayName"]})
        # the counterparty institution gains no visibility, whatever its members' roles
        for user in ("kdoctor", "ktech", "kadmin", "kclinician"):
            with self.subTest(counterparty=user):
                self.check(self.stack.request("GET", f"/image-requests/{rid}", user), 404, MISSING)
                self.check(self.stack.request("GET", path, user), 404, "STUDY_NOT_FOUND")
        for user, view in (("kdoctor", "queue"), ("ktech", "queue"), ("kadmin", "queue"), ("kclinician", "mine")):
            with self.subTest(listed=user):
                self.assertNotIn(rid, self.ids(self.listed(user, view)))
        self.change("ktech", rid, 1, "accept", expect=404, expected_code=MISSING)
        self.change("kadmin", rid, 1, "cancel", note="SYNTHETIC R04 foreign cancel", expect=404, expected_code=MISSING)
        self.change("kclinician", rid, 1, "cancel", note="SYNTHETIC R04 foreign cancel", expect=404, expected_code=MISSING)
        self.assertEqual(self.ledger(f.uid, rid), (1, 1, 1))

    def test_r05_cross_tenant_and_revocation(self) -> None:
        f = self.study()
        uid = quote(f.uid)
        _, created = self.make("clinician", f.uid)
        rid = created.body["applied"]["id"]
        a1, _ = self.change("rta", rid, 1, "accept")
        self.tele(f.uid)
        before = self.ledger(f.uid, rid)
        other_uid, other_id = "2.25." + str(uuid.uuid4().int), str(uuid.uuid4())

        def create_body(user):
            return {"requestId": str(uuid.uuid4()), "expectedOwner": self.owner(user), "kind": "external-image",
                    "counterparty": "SYNTHETIC R05 hospital", "counterpartyInstitutionId": None, "reason": "SYNTHETIC R05 reason"}

        def change_body(user, action, note):
            return {"requestId": str(uuid.uuid4()), "expectedOwner": self.owner(user), "revision": 2, "action": action, "note": note}

        cases = (
            ("uid changed: study requests", "GET", f"/studies/{other_uid}/image-requests", "doctor", None, "STUDY_NOT_FOUND"),
            ("uid changed: create", "POST", f"/studies/{other_uid}/image-requests", "clinician", create_body("clinician"), "STUDY_NOT_FOUND"),
            ("id changed: read", "GET", f"/image-requests/{other_id}", "doctor", None, MISSING),
            ("id changed: close", "POST", f"/image-requests/{other_id}", "tech", change_body("tech", "close", "SYNTHETIC R05"), MISSING),
            ("tele radiologist: read", "GET", f"/image-requests/{rid}", "kdoctor", None, MISSING),
            ("tele radiologist: study requests", "GET", f"/studies/{uid}/image-requests", "kdoctor", None, "STUDY_NOT_FOUND"),
            ("tele technician: close", "POST", f"/image-requests/{rid}", "ktech", change_body("ktech", "close", "SYNTHETIC R05"), MISSING),
            ("other institution clinician: create", "POST", f"/studies/{uid}/image-requests", "kclinician", create_body("kclinician"),
             "STUDY_NOT_FOUND"),
            ("other institution admin: read", "GET", f"/image-requests/{rid}", "kadmin", None, MISSING),
            ("other institution admin: cancel", "POST", f"/image-requests/{rid}", "kadmin", change_body("kadmin", "cancel", "SYNTHETIC R05"),
             MISSING),
        )
        for label, method, path, user, body, expected in cases:
            with self.subTest(case=label):
                self.check(self.stack.request(method, path, user, body), 404, expected)
        for user, view in (("kdoctor", "queue"), ("ktech", "queue"), ("kadmin", "queue"), ("kclinician", "mine")):
            with self.subTest(listed=user):
                self.assertNotIn(rid, self.ids(self.listed(user, view)))
        # owner negatives: another member's or another institution's expectedOwner is 409 before any lookup
        for wrong in (self.owner("clinician2"), ["kin-center", self.stack.user_ids["clinician"]]):
            refused = self.stack.request("POST", f"/studies/{uid}/image-requests", "clinician", {**create_body("clinician"), "expectedOwner": wrong})
            self.check(refused, 409, "OWNER_CHANGED")
        self.assertEqual(self.ledger(f.uid, rid), before)
        self.assertEqual(self.count_requests(f.uid), ["1"])
        # (a) StudyAccess restricts the accepting technician away from the study: 404, out of the queue, cursor 400, replay 404
        page = self.cursor(self.read("rta", rid)["createdAt"], rid, 0)
        self.listed("rta", "queue", cursor=page)
        self.restrict("rta", restricted(rule(studyUids=["2.25." + str(uuid.uuid4().int)])))
        self.check(self.stack.request("GET", f"/image-requests/{rid}", "rta"), 404, MISSING)
        self.assertNotIn(rid, self.ids(self.listed("rta", "queue")))
        self.listed("rta", "queue", expect=400, expected_code="IMAGE_REQUEST_INPUT_INVALID", cursor=page)
        self.check(self.stack.request("GET", f"/studies/{uid}/image-requests", "rta"), 404, "STUDY_NOT_FOUND")
        self.change("rta", rid, 2, "close", note="SYNTHETIC R05 restricted close", expect=404, expected_code=MISSING)
        self.change("rta", rid, 1, "accept", request_id=a1, expect=404, expected_code=MISSING)
        self.assertEqual(self.read("tech", rid)["handler"]["actor"], self.stack.actor("rta"))
        # (b) S-R12: a mixed member who accepted loses technician; it keeps clinician, so the service answers the replay
        _, second = self.make("clinician2", f.uid)
        r2 = second.body["applied"]["id"]
        a2, _ = self.change("rct", r2, 1, "accept")
        self.remove_role("rct", "technician")
        self.change("rct", r2, 1, "accept", request_id=a2, expect=403, expected_code=ROLE)
        self.listed("rct", "queue", expect=403, expected_code=ROLE)
        self.check(self.stack.request("GET", f"/image-requests/{r2}", "rct"), 404, MISSING)
        # the requester loses clinician (keeps radiologist): its replay, its own list and its cancel are refused
        q0, third = self.make("rcr", f.uid)
        r3 = third.body["applied"]["id"]
        self.remove_role("rcr", "clinician")
        self.make("rcr", f.uid, rid=q0, expect=403, expected_code=ROLE)
        self.listed("rcr", "mine", expect=403, expected_code=ROLE)
        self.change("rcr", r3, 1, "cancel", note="SYNTHETIC R05 cancel without the role", expect=403, expected_code=ROLE)
        self.assertEqual(self.read("tech", r3)["requester"]["actor"], self.stack.actor("rcr"))
        # (c) S-R13: the owning institution changes (psql, F-21): hidden on both sides and never moved; replay refused
        b, _ = self.change("tech", rid, 2, "close", note="SYNTHETIC R05 processing record")
        self.move(f.uid, "kin-center")
        try:
            for user in ("doctor", "tech", "clinician", "kdoctor", "kadmin"):
                with self.subTest(moved=user):
                    self.check(self.stack.request("GET", f"/image-requests/{rid}", user), 404, MISSING)
            self.change("tech", rid, 2, "close", note="SYNTHETIC R05 processing record", request_id=b, expect=404, expected_code=MISSING)
            self.check(self.stack.request("GET", f"/studies/{uid}/image-requests", "doctor"), 404, "STUDY_NOT_FOUND")
            moved = self.check(self.stack.request("GET", f"/studies/{uid}/image-requests", "kdoctor"), 200)
            self.assertEqual(moved.body["items"], [], "the new owner never inherits the old owner's requests")
            self.assertNotIn(rid, self.ids(self.listed("kdoctor", "queue")))
            self.assertNotIn(rid, self.ids(self.listed("tech", "queue")))
        finally:
            self.move(f.uid, "hallym")
        self.assertEqual(self.read("tech", rid)["state"], "Closed")
        self.assertEqual(self.ledger(f.uid, rid), (3, 3, 3))
        self.assertEqual(self.ledger(f.uid, r2), (2, 2, 2))
        self.assertEqual(self.ledger(f.uid, r3), (1, 1, 1))

    def test_r06_dto_has_no_transfer_vocabulary(self) -> None:
        f = self.study()
        answers = []
        _, made = self.make("clinician", f.uid, counterparty_id="kin-center")
        rid = made.body["applied"]["id"]
        _, accepted = self.change("tech", rid, 1, "accept")
        b, closed = self.change("tech", rid, 2, "close", note="SYNTHETIC R06 processing record")
        _, replayed = self.change("tech", rid, 2, "close", note="SYNTHETIC R06 processing record", request_id=b)
        _, active = self.make("clinician", f.uid, kind="external-image")
        answers += [made.body, accepted.body, closed.body, replayed.body, active.body]
        for user, path in (("clinician", f"/image-requests/{rid}"), ("tech", f"/image-requests/{rid}"),
                           ("clinician", "/image-requests?view=mine&state=all"), ("tech", "/image-requests?view=queue&state=all"),
                           ("doctor", "/image-requests?view=queue"), ("clinician", f"/studies/{quote(f.uid)}/image-requests"),
                           ("hadmin", f"/studies/{quote(f.uid)}/image-requests")):
            answers.append(self.check(self.stack.request("GET", path, user), 200).body)
        keys: set[str] = set()

        def walk(value) -> None:
            if isinstance(value, dict):
                for key, inner in value.items():
                    keys.add(key)
                    walk(inner)
            elif isinstance(value, list):
                for inner in value:
                    walk(inner)

        for answer in answers:
            walk(answer)
        self.assertEqual(sorted(key for key in keys if any(word in key.lower() for word in TRANSFER_WORDS)), [])
        for body in (made.body, accepted.body, closed.body, replayed.body):
            self.assertEqual(sorted(body), ["applied", "owner", "replayed"])
            self.assertEqual(sorted(body["applied"]), APPLIED_KEYS)
        item = self.read("tech", rid)
        self.assertEqual((sorted(item["requester"]), sorted(item["counterparty"]), sorted(item["handler"])),
                         (["actor", "name"], ["institutionId", "text"], ["actor", "name"]))
        text = json.dumps(item)
        for absent in ("requesterSub", "subjectSub", "fingerprint", "appliedRevision", "handlerActor", "changedBy",
                       self.stack.user_ids["clinician"], self.stack.user_ids["tech"]):
            self.assertNotIn(absent, text)

    def test_r07_role_matrix(self) -> None:
        f = self.study()
        uid = quote(f.uid)
        self.tele(f.uid)
        tokens = {"gateway": self.stack.service_token("gateway"), "pending": self.pending_token()}
        observed: dict[str, list] = {}

        def owner_of(identity):
            return self.owner(identity) if identity not in tokens else ["none", "none"]

        def call(label, identity, method, path, body, status, expected=None, message=None):
            if identity in tokens:
                result = self.stack.bearer_request(method, path, tokens[identity], body)
            else:
                result = self.stack.request(method, path, identity, body)
            observed[label + " " + identity] = [result.status, code(result)]
            with self.subTest(row=label, identity=identity):
                self.assertEqual(result.status, status, result.text[:300])
                if expected is not None:
                    self.assertEqual(code(result), expected, result.text[:300])
                if message is not None:
                    self.assertIn(message, result.text)
            return result

        def create(identity, kind):
            return {"requestId": str(uuid.uuid4()), "expectedOwner": owner_of(identity), "kind": kind,
                    "counterparty": "SYNTHETIC R07 hospital", "counterpartyInstitutionId": None, "reason": "SYNTHETIC R07 reason"}

        def change(identity, revision, action, note):
            return {"requestId": str(uuid.uuid4()), "expectedOwner": owner_of(identity), "revision": revision, "action": action,
                    "note": note}

        guard = [("gateway", 403, None, "게이트웨이에 허용되지 않는 경로입니다"), ("pending", 403, "INSTITUTION_PENDING", None)]
        # RM-R1 create
        own = call("RM-R1", "clinician", "POST", f"/studies/{uid}/image-requests", create("clinician", "image-transfer"), 201)
        mixed = call("RM-R1", "clinrad", "POST", f"/studies/{uid}/image-requests", create("clinrad", "image-transfer"), 201)
        for identity, status, expected, message in [("doctor", 403, ROLE, None), ("tech", 403, ROLE, None), ("hadmin", 403, ROLE, None),
                                                    ("kclinician", 404, "STUDY_NOT_FOUND", None)] + guard:
            call("RM-R1", identity, "POST", f"/studies/{uid}/image-requests", create(identity, "external-image"), status, expected, message)
        mine_r, other_r = own.body["applied"]["id"], mixed.body["applied"]["id"]
        # RM-R2 view=mine and RM-R3 view=queue
        for identity, status, expected, message in [("clinician", 200, None, None), ("clinrad", 200, None, None),
                                                    ("doctor", 403, ROLE, None), ("tech", 403, ROLE, None),
                                                    ("hadmin", 403, ROLE, None), ("kclinician", 200, None, None)] + guard:
            result = call("RM-R2", identity, "GET", "/image-requests?view=mine&state=all", None, status, expected, message)
            if status == 200:
                self.assertEqual(self.ids(result) & {mine_r, other_r},
                                 {"clinician": {mine_r}, "clinrad": {other_r}, "kclinician": set()}[identity])
        for identity, status, expected, message in [("clinician", 403, ROLE, None), ("clinrad", 200, None, None),
                                                    ("doctor", 200, None, None), ("tech", 200, None, None),
                                                    ("hadmin", 200, None, None), ("kdoctor", 200, None, None)] + guard:
            result = call("RM-R3", identity, "GET", "/image-requests?view=queue", None, status, expected, message)
            if status == 200:
                self.assertEqual(self.ids(result) & {mine_r, other_r}, set() if identity == "kdoctor" else {mine_r, other_r})
        # RM-R4 read one request and RM-R5 the study's requests
        for identity, status, expected, message in [("clinician", 404, MISSING, None), ("clinrad", 200, None, None),
                                                    ("doctor", 200, None, None), ("tech", 200, None, None),
                                                    ("hadmin", 200, None, None), ("kdoctor", 404, MISSING, None),
                                                    ("kadmin", 404, MISSING, None)] + guard:
            call("RM-R4", identity, "GET", f"/image-requests/{other_r}", None, status, expected, message)
        call("RM-R4 own", "clinician", "GET", f"/image-requests/{mine_r}", None, 200)
        for identity, status, expected, message in [("clinician", 200, None, None), ("clinrad", 200, None, None),
                                                    ("doctor", 200, None, None), ("tech", 200, None, None),
                                                    ("hadmin", 200, None, None), ("kclinician", 404, "STUDY_NOT_FOUND", None),
                                                    ("kdoctor", 404, "STUDY_NOT_FOUND", None)] + guard:
            result = call("RM-R5", identity, "GET", f"/studies/{uid}/image-requests", None, status, expected, message)
            if status == 200:
                requesters = {item["requester"]["actor"] for item in result.body["items"]}
                if identity == "clinician":
                    self.assertEqual(requesters, {self.stack.actor("clinician")}, "a clinician-only member sees only its own")
                else:
                    self.assertIn(self.stack.actor("clinrad"), requesters)
        # RM-R6 accept/close/decline: technician and admin only; the radiologist reads only (OQ-5 a)
        for identity, status, expected, message in [("clinician", 403, ROLE, None), ("clinrad", 403, ROLE, None),
                                                    ("doctor", 403, ROLE, None), ("ktech", 404, MISSING, None),
                                                    ("kadmin", 404, MISSING, None)] + guard:
            for action, note in (("accept", ""), ("close", "SYNTHETIC R07 record"), ("decline", "SYNTHETIC R07 reason")):
                call("RM-R6 " + action, identity, "POST", f"/image-requests/{other_r}", change(identity, 1, action, note),
                     status, expected, message)
        call("RM-R6 accept", "tech", "POST", f"/image-requests/{other_r}", change("tech", 1, "accept", ""), 201)
        call("RM-R6 close", "hadmin", "POST", f"/image-requests/{other_r}", change("hadmin", 2, "close", "SYNTHETIC R07 admin record"), 201)
        _, third = self.make("clinician2", f.uid)
        third_r = third.body["applied"]["id"]
        call("RM-R6 decline", "tech", "POST", f"/image-requests/{third_r}", change("tech", 1, "decline", "SYNTHETIC R07 decline"), 201)
        # RM-R7 cancel: the requesting clinician or admin; a visible non-requester without admin is the actor rule
        for identity, status, expected, message in [("doctor", 403, ROLE, None), ("tech", 403, ROLE, None),
                                                    ("clinician2", 404, MISSING, None),
                                                    ("clintech", 403, "IMAGE_REQUEST_ACTION_FORBIDDEN", None),
                                                    ("kclinician", 404, MISSING, None)] + guard:
            call("RM-R7", identity, "POST", f"/image-requests/{mine_r}", change(identity, 1, "cancel", "SYNTHETIC R07 cancel"),
                 status, expected, message)
        call("RM-R7", "clinician", "POST", f"/image-requests/{mine_r}", change("clinician", 1, "cancel", "SYNTHETIC R07 own cancel"), 201)
        _, fourth = self.make("clinrad", f.uid)
        call("RM-R7 mixed", "clinrad", "POST", f"/image-requests/{fourth.body['applied']['id']}",
             change("clinrad", 1, "cancel", "SYNTHETIC R07 mixed cancel"), 201)
        _, fifth = self.make("clinician2", f.uid, kind="external-image")
        call("RM-R7", "hadmin", "POST", f"/image-requests/{fifth.body['applied']['id']}",
             change("hadmin", 1, "cancel", "SYNTHETIC R07 admin cancel"), 201)
        roles = [json.loads(row["detail"])["role"] for row in self.request_audits(f.uid) if json.loads(row["detail"])["action"] != "create"]
        self.assertEqual(roles, ["technician", "admin", "technician", "clinician", "clinician", "admin"])
        print("CLINICIAN_REQUEST_LIVE_MATRIX " + json.dumps(observed, ensure_ascii=True, sort_keys=True))

    def test_r08_connect_routes_still_deny_clinician(self) -> None:
        f = self.study()
        actor = self.stack.actor("clinician")
        before = psql(f'SELECT count(*) FROM "AuditLog" WHERE actor={lit(actor)}')
        connect = self.connect_marks()
        fixtures = json.loads((ROOT / "tests" / "clinician_policy_fixtures.json").read_text(encoding="utf-8"))
        self.assertEqual(sorted(fixtures["route_matrix"]["denied"]["connect"]), sorted(m + " " + p for m, p in CONNECT_ROUTES))
        for method, template in CONNECT_ROUTES:
            path = "/" + template.replace(":uid", quote(f.uid)).replace(":id", str(uuid.uuid4()))
            with self.subTest(route=method + " " + template):
                self.check(self.stack.request(method, path, "clinician", {} if method in ("POST", "PATCH") else None), 403,
                           "CLINICIAN_ROUTE_DENIED")
        # a mixed member keeps the legacy path: the clinician gate never answers it
        legacy = self.stack.request("GET", "/transfers", "clintech")
        self.assertNotEqual(code(legacy), "CLINICIAN_ROUTE_DENIED", legacy.text[:300])
        self.assertEqual(psql(f'SELECT count(*) FROM "AuditLog" WHERE actor={lit(actor)}'), before)
        self.assertEqual(self.connect_marks(), connect)

    def test_r09_audit_rows(self) -> None:
        f = self.study()
        texts = ("SYNTHETIC-R09-reason-text", "SYNTHETIC-R09-counterparty-text", "SYNTHETIC-R09-close-note",
                 "SYNTHETIC-R09-second-reason", "SYNTHETIC-R09-cancel-note")
        r0, created = self.make("clinician", f.uid, counterparty=texts[1], counterparty_id="kin-center", reason=texts[0])
        rid = created.body["applied"]["id"]
        a, _ = self.change("tech", rid, 1, "accept")
        b, _ = self.change("hadmin", rid, 2, "close", note=texts[2])
        q0, second = self.make("clinician2", f.uid, kind="external-image", reason=texts[3])
        r2 = second.body["applied"]["id"]
        c, _ = self.change("clinician2", r2, 1, "cancel", note=texts[4])
        # a replay, a reuse and a refusal write no audit row
        self.change("tech", rid, 1, "accept", request_id=a)
        self.change("tech", rid, 1, "decline", note="SYNTHETIC-R09-other", request_id=a, expect=409, expected_code=REUSED)
        self.change("doctor", rid, 3, "close", note="SYNTHETIC-R09-refused", expect=403, expected_code=ROLE)
        rows = self.request_audits(f.uid)
        clinician, clinician2 = self.stack.actor("clinician"), self.stack.actor("clinician2")
        expected = ((clinician, rid, "image-transfer", "create", None, "Requested", 1, r0, "kin-center", "clinician"),
                    (self.stack.actor("tech"), rid, "image-transfer", "accept", "Requested", "Accepted", 2, a, "kin-center", "technician"),
                    (self.stack.actor("hadmin"), rid, "image-transfer", "close", "Accepted", "Closed", 3, b, "kin-center", "admin"),
                    (clinician2, r2, "external-image", "create", None, "Requested", 1, q0, None, "clinician"),
                    (clinician2, r2, "external-image", "cancel", "Requested", "Cancelled", 2, c, None, "clinician"))
        self.assertEqual(len(rows), len(expected))
        for row, (actor, request, kind, action, before, to, revision, request_id, counterparty, role) in zip(rows, expected):
            with self.subTest(action=action, revision=revision):
                detail = json.loads(row["detail"])
                self.assertEqual(sorted(detail), DETAIL_KEYS)
                self.assertEqual((row["actor"], row["action"], row["target"]), (actor, "study.image-request", f.uid))
                self.assertEqual((detail["id"], detail["institution"], detail["kind"], detail["action"], detail["from"], detail["to"],
                                  detail["revision"], detail["requestId"], detail["counterpartyInstitutionId"], detail["role"]),
                                 (request, "hallym", kind, action, before, to, revision, request_id, counterparty, role))
                for text in texts + (f.patient_id,):
                    self.assertNotIn(text, row["detail"])
        # the owning institution reads the same five rows through GET audit
        listed = self.check(self.audit("jmryu", f.uid, 500), 200)
        self.assertEqual(sorted(row["id"] for row in listed.body if row["action"] == "study.image-request"),
                         sorted(row["id"] for row in rows))

    def test_r10_audit_rows_owner_institution_only(self) -> None:
        f = self.study()
        uid = f.uid
        self.tele(uid)

        def rows(user, scoped=True, take=500, study=None):
            return self.check(self.audit(user, study or uid, take, scoped), 200).body

        def of_study(listed, study=None):
            return [row for row in listed if row["target"] == (study or uid)]

        def requests(listed, study=None):
            return [row for row in of_study(listed, study) if row["action"] == "study.image-request"]

        tele_before = {user: [row["id"] for row in rows(user)] for user in ("kdoctor", "kadmin")}
        self.assertTrue(all(tele_before.values()), "the tele institution sees the study's earlier rows")
        r0, created = self.make("clinician", uid, counterparty_id="kin-center")
        rid = created.body["applied"]["id"]
        a, _ = self.change("tech", rid, 1, "accept")
        b, _ = self.change("tech", rid, 2, "close", note="SYNTHETIC R10 processing record")
        secret = {rid, r0, a, b}
        # (a) B radiologist and B admin: no owner-only row on either path, no id in the answer, other rows as before
        for user in ("kdoctor", "kadmin"):
            for scoped in (True, False):
                with self.subTest(a=user, scoped=scoped):
                    listed = rows(user, scoped)
                    self.assertEqual(requests(listed), [])
                    self.assertEqual([row["id"] for row in of_study(listed)], tele_before[user])
                    text = json.dumps(listed)
                    for value in secret:
                        self.assertNotIn(value, text)
                    if scoped:
                        self.assertNotIn("counterpartyInstitutionId", text)
        # (b) the filter runs before LIMIT: the newest rows of this study are request rows, yet take=1 is not empty
        self.assertEqual(rows("doctor", True, 1)[0]["action"], "study.image-request")
        for user in ("kdoctor", "kadmin"):
            for scoped in (True, False):
                with self.subTest(b=user, scoped=scoped):
                    one, full = rows(user, scoped, 1), rows(user, scoped, 500)
                    self.assertEqual(len(one), 1, "a short page would reveal a filtered row")
                    self.assertEqual(one[0], full[0])
        # (c) the owning institution's radiologist and admin read all three rows
        for user in ("doctor", "hadmin"):
            for scoped in (True, False):
                with self.subTest(c=user, scoped=scoped):
                    owned = requests(rows(user, scoped))
                    self.assertEqual(len(owned), 3)
                    for row in owned:
                        self.assertEqual(sorted(json.loads(row["detail"])), DETAIL_KEYS)
        # (d) the owner becomes C (psql, F-21; kin-center as a plain owner, no tele): rows of the A era stay A's
        c_request = None
        self.move(uid, "kin-center")
        try:
            for scoped in (True, False):
                self.assertEqual(requests(rows("kadmin", scoped)), [])
            self.check(self.audit("hadmin", uid, 500), 404)
            self.assertEqual(of_study(rows("hadmin", False)), [])
            # (e) a row created while C owns the study
            _, c_era = self.make("kclinician", uid, reason="SYNTHETIC R10 C-era request")
            c_request = c_era.body["applied"]["id"]
            self.assertEqual([json.loads(row["detail"])["id"] for row in requests(rows("kadmin"))], [c_request])
        finally:
            self.move(uid, "hallym")
        for scoped in (True, False):
            with self.subTest(e=scoped):
                back = requests(rows("hadmin", scoped))
                self.assertEqual(len(back), 3)
                self.assertNotIn(c_request, {json.loads(row["detail"])["id"] for row in back})
        self.check(self.audit("kadmin", uid, 500), 404)
        # (f) the clinician-only gate still refuses GET audit on both paths
        for scoped in (True, False):
            self.check(self.audit("clinician", uid, 500, scoped), 403, "CLINICIAN_ROUTE_DENIED")
        # D: the counterparty institution of a study without tele reads no row of it on either path
        g = self.study()
        _, towards = self.make("clinician", g.uid, counterparty_id="kin-center")
        d_request = towards.body["applied"]["id"]
        self.change("tech", d_request, 1, "accept")
        self.assertEqual(len(requests(rows("hadmin", True, 500, g.uid), g.uid)), 2)
        for user in ("kdoctor", "ktech", "kadmin"):
            with self.subTest(d=user):
                self.check(self.audit(user, g.uid, 500), 404)
                self.assertEqual(of_study(rows(user, False), g.uid), [])
        self.assertEqual(self.ledger(uid, rid), (3, 3, 3))
        self.assertEqual(self.ledger(uid, c_request), (1, 1, 1))
        self.assertEqual(self.ledger(g.uid, d_request), (2, 2, 2))

    def test_r11_metadata_study_access_allows_and_denies(self) -> None:
        f = self.study()
        uid = quote(f.uid)
        instance = self.stack.first_instance_id(f.uid)
        tags = self.check(self.stack._orthanc_request("GET", f"/instances/{quote(instance)}/tags?simplify"), 200).body
        modality, patient, date = tags["Modality"], tags["PatientID"], tags["StudyDate"]
        self.assertEqual(patient, f.patient_id)
        self.assertRegex(date, r"^[0-9]{8}$")
        before_day = (datetime.strptime(date, "%Y%m%d") - timedelta(days=1)).strftime("%Y-%m-%d")
        self.restrict("rt1", restricted(rule(modalities=[modality])))
        self.restrict("rt2", restricted(rule(modalities=["SYNTHETIC_OTHER"])))
        self.restrict("rw", restricted(rule(patientId=patient)))
        self.restrict("rw2", restricted(rule(dateTo=before_day)))
        marks, connect = self.orthanc_marks(), self.connect_marks()
        _, created = self.make("rw", f.uid)
        rid = created.body["applied"]["id"]
        self.change("rt1", rid, 1, "accept")
        self.change("rt1", rid, 2, "close", note="SYNTHETIC R11 processing record")
        self.assertEqual(self.ledger(f.uid, rid), (3, 3, 3))
        for user in ("rt1", "rw"):
            self.assertEqual(self.read(user, rid)["revision"], 3)
        self.assertIn(rid, self.ids(self.listed("rt1", "queue")))
        # T2: the modality does not match: out of the queue, the request and the study's requests 404, no receipt or audit
        self.assertNotIn(rid, self.ids(self.listed("rt2", "queue")))
        self.check(self.stack.request("GET", f"/image-requests/{rid}", "rt2"), 404, MISSING)
        self.check(self.stack.request("GET", f"/studies/{uid}/image-requests", "rt2"), 404, "STUDY_NOT_FOUND")
        self.change("rt2", rid, 3, "decline", note="SYNTHETIC R11 denied decline", expect=404, expected_code=MISSING)
        # W2: the study date is after dateTo: the create is 404 and writes no row, receipt or audit row
        self.make("rw2", f.uid, kind="external-image", expect=404, expected_code="STUDY_NOT_FOUND")
        self.assertEqual(self.count_requests(f.uid), ["1"])
        self.assertEqual(self.ledger(f.uid, rid), (3, 3, 3))
        self.assertEqual(len(self.request_audits(f.uid)), 3)
        self.assert_orthanc_unchanged(marks)
        self.assertEqual(self.connect_marks(), connect)


# The pinned order is the class's own: a renamed, added or missing case stops the module before any live call.
if [name for name in sorted(vars(ClinicianRequestLive)) if name.startswith("test_")] != [name for name, _ in CASES]:
    raise RuntimeError("clinician_request_live CASES does not match the test methods")


if __name__ == "__main__":
    print("Run through scripts/run-tests.py --mode live; direct execution is refused by the gate.", file=sys.stderr)
    raise SystemExit(125)
