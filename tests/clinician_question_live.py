# coding: utf-8
"""TEST-S5-U4a-LIVE: clinician question threads on the real Nest guard and service, PostgreSQL, Keycloak and Orthanc.

REQ-S5-U4p-ATTRIBUTION/TENANT/STUDY-ACCESS-READ/QUESTION-STATE/IDEMPOTENCY/LATE-UPDATE/REVOCATION/ROLE-MATRIX/
CONSULTATION-SEPARATE/AUDIT/AUDIT-READ -> RISK-S5-U4p-* -> TEST-S5-U4a-LIVE (contract S5-U4p section 2.3, 7.1, 11.1,
decision D33). The case names are the contract's Q01-Q14; Q15 is Astra S5-U4a-F01 (one thread read is one snapshot).
Hosted synthetic stack only, through scripts/run-tests.py:

    python scripts/run-tests.py --module tests/clinician_question_live.py --mode live --unit s5-u4a-clinician-question --timeout 1800

CASES below is the pinned order (one unittest class, the declaration order is the run order) with the expected seconds
of each case on the hosted synthetic stack; SETUP_SECONDS covers the class identities. The module refuses to load when
the class and CASES disagree.

Owned data only: run-created Keycloak users (kin-test-*), a pending member created and deleted here, the realm role
`clinician` only when this run had to create it, the LiveStack test client and gateway client, one synthetic C-STORE
study per case, the question rows, receipts and audit rows written on those studies, and SYNTHETIC StudyAccess policies
on this run's radiologists. Every case removes its question rows before the study cleanup (both foreign keys RESTRICT,
and LiveStack.cleanup_fixture deletes StudyState directly), refusing rows another member wrote. Q07 and Q13 move the
owning institution of their own synthetic study with psql (no product path moves ownership, contract F-21) and move it
back in a finally block; Q07 removes the clinician role from its own mixed member. Q15 holds the run clinician's
study-access advisory lock in its own psql session for the writes it makes through the product routes and commits that
session (it writes nothing) in a finally block.

Not proved here: withdrawing a clinician-only member's access per study (study-access target() still manages admin,
radiologist and technician members only, decision D33 OQ-8 b); a third institution beyond hallym and kin-center (Q13 uses
kin-center as the tele institution B and, after the psql move, as the owner C).
"""
from __future__ import annotations

import base64
import json
import re
import subprocess
import sys
import time
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import Request

from invariants_live import LiveStack, psql, purge_user_audit

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

CASES = (
    ("test_q01_question_attribution_comes_from_token", 30),
    ("test_q02_request_id_replay_and_reuse", 35),
    ("test_q03_state_machine_answer_followup_close", 40),
    ("test_q04_closed_question_refuses_late_writes", 30),
    ("test_q05_stale_revision_conflicts_without_merge", 30),
    ("test_q06_cross_tenant_uid_and_owner_negatives", 35),
    ("test_q07_revocation_hides_thread_and_refuses_replay", 60),
    ("test_q08_role_matrix", 75),
    ("test_q09_consultation_unchanged_for_clinician", 30),
    ("test_q10_audit_rows_attributed_and_text_free", 30),
    ("test_q11_answer_keeps_report_anchor_after_reset", 40),
    ("test_q12_study_delete_refused_while_questions_exist", 30),
    ("test_q13_audit_rows_owner_institution_only", 55),
    ("test_q14_metadata_study_access_allows_and_denies", 60),
    ("test_q15_thread_read_is_one_snapshot", 45),
)
SETUP_SECONDS = 90
EXPECTED_SECONDS = SETUP_SECONDS + sum(seconds for _name, seconds in CASES)

IDENTITIES = (
    ("clinician", ["clinician"], "hallym"),
    ("clinician2", ["clinician"], "hallym"),
    ("kclinician", ["clinician"], "kin-center"),
    ("clinrad", ["clinician", "radiologist"], "hallym"),
    ("clintech", ["clinician", "technician"], "hallym"),
    ("hadmin", ["admin"], "hallym"),
    ("kadmin", ["admin"], "kin-center"),
    ("qa", ["radiologist"], "hallym"),
    ("qx", ["radiologist"], "hallym"),
    ("qy", ["radiologist"], "hallym"),
    ("qz", ["radiologist"], "hallym"),
    ("qw", ["clinician", "radiologist"], "hallym"),
)
APPLIED_KEYS = ["action", "at", "entry", "from", "id", "requestId", "revision", "studyUid", "to"]
DETAIL_KEYS = ["entry", "from", "id", "institution", "kind", "requestId", "revision", "role", "to"]
SUMMARY_KEYS = ["author", "createdAt", "entryCount", "id", "lastEntryAt", "revision", "state", "studyUid", "updatedAt"]
THREAD_KEYS = sorted(SUMMARY_KEYS + ["closed", "current", "entries"])
ENTRY_KEYS = ["at", "author", "body", "id", "kind", "reportAnchor", "seq"]
REUSED = "REQUEST_ID_REUSED"
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
STUDY_UID = re.compile(r"^[0-9]+(?:\.[0-9]+)+$")
OWNED_USERNAME = re.compile(r"kin-test-[0-9a-f]{12}-[a-z0-9_-]+")
TIME_ONLY_CHANGES = {"StableStudy", "StableSeries", "StablePatient"}


def lit(value) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def code(result):
    return result.body.get("code") if isinstance(result.body, dict) else None


def rule(**changes):
    return {"patientId": None, "modalities": [], "dateFrom": None, "dateTo": None, "studyUids": [], **changes}


def restricted(*rules):
    return {"version": 1, "restricted": True, "startsAt": None, "endsAt": None, "rules": list(rules)}


# ── question helpers shared with clinician_policy_live test_05 (the matrix's :id question and its cleanup) ──

def member_owner(stack, user: str) -> list[str]:
    """expectedOwner of one identity: [institution, sub] as GET /me answers them, the value the service compares."""
    me = stack.request("GET", "/me", user)
    if me.status != 200:
        raise AssertionError(f"GET /me as {user}: {me.status} {me.text[:300]}")
    return [me.body["institution"], me.body["sub"]]


def ask_question(stack, user: str, uid: str, owner: list[str], body: str, rid: str | None = None):
    """POST studies/:uid/questions with exactly the three keys the service takes: (requestId, HTTP result)."""
    rid = rid or str(uuid.uuid4())
    return rid, stack.request("POST", f"/studies/{quote(uid)}/questions", user,
                              {"requestId": rid, "expectedOwner": owner, "body": body})


def read_question_row(qid: str) -> dict:
    """The StudyQuestion row of one id, read with psql; anything but exactly one row fails the calling case."""
    if not UUID.fullmatch(qid):
        raise AssertionError(f"not a question id: {qid!r}")
    rows = psql(f'SELECT to_jsonb(t)::text FROM "StudyQuestion" t WHERE id={lit(qid)}')
    if len(rows) != 1:
        raise AssertionError(f"StudyQuestion {qid}: {rows}")
    return json.loads(rows[0])


def drop_study_questions(uid: str, owned: set[str]) -> None:
    """Question rows of one run-owned study, children first; rows written by a subject outside owned stop the cleanup.

    Both foreign keys RESTRICT and LiveStack.cleanup_fixture deletes StudyState directly, so a module that writes
    questions on its study runs this before the study cleanup."""
    if not STUDY_UID.fullmatch(uid):
        raise RuntimeError(f"refusing question cleanup for an abnormal UID: {uid}")
    authors = set(psql(f'SELECT DISTINCT "authorSub" FROM "StudyQuestion" WHERE "studyUid"={lit(uid)}'))
    authors |= set(psql(f'SELECT DISTINCT e."authorSub" FROM "StudyQuestionEntry" e JOIN "StudyQuestion" q '
                        f'ON q.id=e."questionId" WHERE q."studyUid"={lit(uid)}'))
    foreign = authors - owned
    if foreign:
        raise RuntimeError(f"refusing to delete question rows this run did not write: {sorted(foreign)}")
    psql(f'BEGIN; DELETE FROM "StudyQuestionEntry" e USING "StudyQuestion" q WHERE q.id=e."questionId" '
         f'AND q."studyUid"={lit(uid)}; DELETE FROM "StudyQuestion" WHERE "studyUid"={lit(uid)}; COMMIT;')
    if psql(f'SELECT count(*) FROM "StudyQuestion" WHERE "studyUid"={lit(uid)}') != ["0"]:
        raise RuntimeError("question rows remained after cleanup")


class ClinicianQuestionLive(unittest.TestCase):
    maxDiff = None

    @classmethod
    def setUpClass(cls) -> None:
        cls.stack = LiveStack()
        cls.owned_users: list[str] = []
        cls.owners: dict[str, list[str]] = {}
        cls.created_role = False
        cls.addClassCleanup(cls.stack.cleanup_test_identities)
        cls.addClassCleanup(cls.stack.cleanup_all)
        cls.addClassCleanup(cls.drop_all_questions)
        cls.stack.require_stack()
        role = cls.stack.kc_admin("GET", "/roles/clinician")
        if role.status == 404:
            created = cls.stack.kc_admin("POST", "/roles", {"name": "clinician", "description": "temporary S5-U4a clinician role"})
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
    def drop_questions(cls, uid: str) -> None:
        drop_study_questions(uid, cls.owned_subjects())

    @classmethod
    def drop_all_questions(cls) -> None:
        # Safety net before LiveStack.cleanup_all: a failed per-case cleanup must not leave the study delete refused.
        for uid in list(cls.stack.active):
            cls.drop_questions(uid)

    # ── helpers ──

    def study(self):
        fixture = self.stack.create_fixture()
        self.addCleanup(self.stack.cleanup_fixture, fixture.uid)
        self.addCleanup(self.drop_questions, fixture.uid)
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

    def ask(self, user, uid, body="SYNTHETIC question", rid=None, expect=201, expected_code=None):
        rid, result = ask_question(self.stack, user, uid, self.owner(user), body, rid)
        return rid, self.check(result, expect, expected_code)

    def entry(self, user, qid, revision, body="SYNTHETIC answer", rid=None, expect=201, expected_code=None):
        rid = rid or str(uuid.uuid4())
        result = self.stack.request("POST", f"/questions/{quote(qid)}/entries", user,
                                    {"requestId": rid, "expectedOwner": self.owner(user), "revision": revision, "body": body})
        return rid, self.check(result, expect, expected_code)

    def shut(self, user, qid, revision, note="", rid=None, expect=201, expected_code=None):
        rid = rid or str(uuid.uuid4())
        result = self.stack.request("POST", f"/questions/{quote(qid)}/close", user,
                                    {"requestId": rid, "expectedOwner": self.owner(user), "revision": revision, "note": note})
        return rid, self.check(result, expect, expected_code)

    def read(self, user, qid):
        result = self.check(self.stack.request("GET", f"/questions/{quote(qid)}", user), 200)
        self.assertEqual(sorted(result.body), ["item", "owner"])
        self.assertEqual(sorted(result.body["item"]), THREAD_KEYS)
        return result.body["item"]

    def listed(self, user, view, expect=200, expected_code=None, cursor=None):
        path = "/questions?view=" + view + ("&cursor=" + cursor if cursor else "")
        return self.check(self.stack.request("GET", path, user), expect, expected_code)

    def ids(self, result) -> set[str]:
        return {item["id"] for item in result.body["items"]}

    def question_row(self, qid) -> dict:
        return read_question_row(qid)

    def entries(self, qid) -> list[dict]:
        self.assertRegex(qid, UUID)
        return [json.loads(raw) for raw in psql(
            f'SELECT to_jsonb(t)::text FROM "StudyQuestionEntry" t WHERE "questionId"={lit(qid)} ORDER BY seq')]

    def question_audits(self, uid) -> list[dict]:
        self.assertRegex(uid, STUDY_UID)
        return [json.loads(raw) for raw in psql(
            f"SELECT to_jsonb(t)::text FROM \"AuditLog\" t WHERE target={lit(uid)} AND action='study.question' ORDER BY id")]

    def ledger(self, uid, qid) -> tuple:
        """(question revision, receipt rows, study.question audit rows of this question)."""
        audits = [row for row in self.question_audits(uid) if json.loads(row["detail"])["id"] == qid]
        return self.question_row(qid)["revision"], len(self.entries(qid)), len(audits)

    def move(self, uid, institution, tele=None) -> None:
        """F-21: no product route moves a study's owner; only this run's synthetic study is moved."""
        self.assertRegex(uid, STUDY_UID)
        self.assertIn(institution, ("hallym", "kin-center"))
        value = "NULL" if tele is None else lit(tele)
        psql(f'UPDATE "StudyState" SET "institutionId"={lit(institution)}, "teleInstitutionId"={value} WHERE uid={lit(uid)}')

    def restrict(self, logical, policy) -> None:
        subject = self.stack.user_ids[logical]
        self.addCleanup(self.clear_access, subject)
        written = self.stack.request("POST", f"/admin/users/{quote(subject)}/study-access", "jmryu", {
            "expectedOwner": self.owner("jmryu"), "policy": policy, "revision": 0,
            "reason": "SYNTHETIC S5-U4a access condition", "requestId": str(uuid.uuid4())})
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

    def cursor(self, at, qid, revision) -> str:
        raw = json.dumps({"at": at, "id": qid, "r": revision}, separators=(",", ":")).encode("utf-8")
        return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")

    def commit(self, uid, user, action, base, **extra):
        body = {"action": action, "baseVersion": base, "findings": extra.pop("findings", ""),
                "conclusion": extra.pop("conclusion", ""), "recommendation": extra.pop("recommendation", ""), **extra}
        return self.stack.request("POST", f"/studies/{quote(uid)}/report/commit", user, body)

    def head_version(self, uid):
        self.assertRegex(uid, STUDY_UID)
        value = psql(f"SELECT coalesce(max(version)::text, 'none') FROM \"ReportVersion\" WHERE uid={lit(uid)} AND action <> 'discarded'")
        return None if value == ["none"] else int(value[0])

    def audit(self, user, uid, take, scoped=True):
        path = f"/audit?uid={quote(uid)}&take={take}" if scoped else f"/audit?take={take}"
        return self.stack.request("GET", path, user)

    def pending_token(self) -> str:
        """An unapproved member (clinician role, no institution group): the guard answers INSTITUTION_PENDING."""
        username = f"kin-test-{uuid.uuid4().hex[:12]}-qpending"
        self.assertRegex(username, OWNED_USERNAME)
        password = uuid.uuid4().hex + "Aa1!"
        created = self.stack.kc_admin("POST", "/users", {
            "username": username, "enabled": True, "emailVerified": True,
            "email": username + "@local.test", "firstName": "KIN", "lastName": "qpending"})
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

    def whole(self, item) -> None:
        """One thread answer is one moment (S5-U4a-F01): revision = entryCount = entries 1..n, closed exactly when Closed."""
        self.assertEqual(item["revision"], item["entryCount"])
        self.assertEqual([e["seq"] for e in item["entries"]], list(range(1, item["entryCount"] + 1)))
        self.assertEqual(item["closed"] is not None, item["state"] == "Closed")
        self.assertEqual(any(e["kind"] == "close" for e in item["entries"]), item["state"] == "Closed")

    def hold_access_lock(self, user):
        """An open psql transaction holding `user`'s study-access advisory lock exclusively: every question transaction of
        that member takes it shared (StudyAccessService.snapshot) and waits here. Same shape as finding_api_test.hold."""
        key = "study-access:" + json.dumps(self.owner(user), separators=(",", ":"), ensure_ascii=False)
        holder = subprocess.Popen(["docker", "exec", "-i", "kin-db", "psql", "-XqAt", "-U", "kin", "-d", "kin", "-v", "ON_ERROR_STOP=1"],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8")
        holder.stdin.write("BEGIN; SET LOCAL statement_timeout='8s'; SET LOCAL idle_in_transaction_session_timeout='30s'; "
                           f"SELECT pg_advisory_xact_lock(hashtextextended({lit(key)}, 0)); SELECT 'LOCKED';\n")
        holder.stdin.flush()
        while holder.stdout.readline().strip() != "LOCKED":
            if holder.poll() is not None:
                raise RuntimeError("study-access lock holder failed: " + holder.stderr.read())
        return holder, key

    def holder_rows(self, holder, sql) -> list[str]:
        """Read-only `sql` in the holder's own session: no process start-up while requests wait on its lock."""
        holder.stdin.write(sql + "; SELECT 'DONE';\n")
        holder.stdin.flush()
        rows = []
        while (line := holder.stdout.readline().strip()) != "DONE":
            if not line and holder.poll() is not None:
                self.fail("the lock holder session ended: " + holder.stderr.read())
            if line:
                rows.append(line)
        return rows

    def wait_on_lock(self, holder, key, count, timeout=10) -> None:
        """Bounded wait until `count` sessions wait for the shared lock of `key` (a bigint key shows its high half in
        classid and its low half in objid, objsubid 1)."""
        sql = ("SELECT count(*) FROM pg_locks l CROSS JOIN (SELECT hashtextextended(" + lit(key) + ", 0) AS h) k "
               "WHERE l.locktype='advisory' AND l.objsubid=1 AND l.mode='ShareLock' AND NOT l.granted "
               "AND l.classid::text::bigint=((k.h>>32)&4294967295) AND l.objid::text::bigint=(k.h&4294967295)")
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.holder_rows(holder, sql) == [str(count)]:
                return
            time.sleep(0.02)
        self.fail(f"{count} request(s) were not observed waiting on the study-access lock")

    def release_lock(self, holder) -> None:
        """Commit the holder (it wrote nothing); a second call and an ended session are no-ops."""
        if holder.poll() is not None:
            return
        holder.stdin.write("COMMIT;\n")
        holder.stdin.flush()
        try:
            holder.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            holder.kill()
            holder.communicate()
            raise
        self.assertEqual(holder.returncode, 0, "the study-access lock holder failed")

    # ── cases (contract S5-U4p section 2.3 names) ──

    def test_q01_question_attribution_comes_from_token(self) -> None:
        f = self.study()
        path = f"/studies/{quote(f.uid)}/questions"
        base = {"requestId": str(uuid.uuid4()), "expectedOwner": self.owner("clinician"), "body": "SYNTHETIC attribution question"}
        for key, value in (("institution", "kin-center"), ("institutionId", "kin-center"),
                           ("authorSub", self.stack.user_ids["clinician2"]), ("role", "radiologist")):
            with self.subTest(key=key):
                self.check(self.stack.request("POST", path, "clinician", {**base, key: value}), 400, "QUESTION_INPUT_INVALID")
        self.check(self.stack.request("POST", path, "clinician", {k: v for k, v in base.items() if k != "body"}), 400, "QUESTION_INPUT_INVALID")
        self.assertEqual(psql(f'SELECT count(*) FROM "StudyQuestion" WHERE "studyUid"={lit(f.uid)}'), ["0"])
        created = self.check(self.stack.request("POST", path, "clinician", base), 201)
        sub, actor = self.stack.user_ids["clinician"], self.stack.actor("clinician")
        self.assertEqual(sorted(created.body), ["applied", "owner", "replayed"])
        self.assertEqual((created.body["owner"], created.body["replayed"]), (["hallym", sub], False))
        applied = created.body["applied"]
        self.assertEqual(sorted(applied), APPLIED_KEYS)
        self.assertEqual((applied["id"], applied["requestId"], applied["entry"]), (base["requestId"], base["requestId"],
                         {"id": base["requestId"], "seq": 1, "kind": "question"}))
        row, [receipt] = self.question_row(applied["id"]), self.entries(applied["id"])
        self.assertEqual((row["institutionId"], row["authorSub"], row["authorActor"], row["studyUid"], row["state"]),
                         ("hallym", sub, actor, f.uid, "Open"))
        self.assertEqual((receipt["authorSub"], receipt["authorActor"], receipt["authorRole"], receipt["result"]),
                         (sub, actor, "clinician", applied))
        [audit] = self.question_audits(f.uid)
        self.assertEqual(audit["actor"], actor)
        detail = json.loads(audit["detail"])
        self.assertEqual((detail["institution"], detail["role"], detail["requestId"]), ("hallym", "clinician", base["requestId"]))
        me = self.stack.request("GET", "/me", "clinician")
        thread = self.read("clinician", applied["id"])
        self.assertEqual(thread["author"], {"actor": actor, "name": me.body["displayName"]})
        self.assertEqual(row["authorName"], me.body["displayName"])
        text = json.dumps(thread)
        for absent in ("authorSub", "institutionId", "fingerprint", "appliedRevision", sub):
            self.assertNotIn(absent, text)

    def test_q02_request_id_replay_and_reuse(self) -> None:
        f = self.study()
        r0, created = self.ask("clinician", f.uid)
        qid = created.body["applied"]["id"]
        a, answered = self.entry("doctor", qid, 1)
        b, closed = self.shut("clinician", qid, 2)
        self.assertEqual(self.ledger(f.uid, qid), (3, 3, 3))
        replays = {"S-Q1": (self.ask("clinician", f.uid, rid=r0)[1], created, ("create", 1, "question", None, "Open", 1)),
                   "S-Q2": (self.entry("doctor", qid, 1, rid=a)[1], answered, ("answer", 2, "answer", "Open", "Answered", 2)),
                   "S-Q3": (self.shut("clinician", qid, 2, rid=b)[1], closed, ("close", 3, "close", "Answered", "Closed", 3))}
        for case, (again, first, shape) in replays.items():
            with self.subTest(case=case):
                self.assertEqual((again.status, again.body["replayed"]), (201, True))
                self.assertEqual(again.body["applied"], first.body["applied"])
                applied = again.body["applied"]
                self.assertEqual((applied["action"], applied["entry"]["seq"], applied["entry"]["kind"], applied["from"],
                                  applied["to"], applied["revision"]), shape)
        self.assertEqual(self.ledger(f.uid, qid), (3, 3, 3))
        _, other = self.ask("clinician", f.uid, body="SYNTHETIC second question")
        q2 = other.body["applied"]["id"]
        refusals = (
            ("S-Q4", lambda: self.ask("clinician", f.uid, body="SYNTHETIC changed question", rid=r0, expect=409, expected_code=REUSED)),
            ("S-Q5", lambda: self.entry("doctor", qid, 1, body="SYNTHETIC changed answer", rid=a, expect=409, expected_code=REUSED)),
            ("S-Q6", lambda: self.shut("doctor", qid, 1, note="SYNTHETIC close note", rid=a, expect=409, expected_code=REUSED)),
            ("S-Q7", lambda: self.entry("doctor", q2, 1, rid=a, expect=409, expected_code=REUSED)),
            ("S-Q8", lambda: self.shut("doctor2", qid, 2, rid=b, expect=409, expected_code=REUSED)),
        )
        for case, call in refusals:
            with self.subTest(case=case):
                call()
        self.assertEqual(self.ledger(f.uid, qid), (3, 3, 3))
        self.assertEqual(self.ledger(f.uid, q2), (1, 1, 1))

    def test_q03_state_machine_answer_followup_close(self) -> None:
        f = self.study()
        _, created = self.ask("clinician", f.uid)
        qid = created.body["applied"]["id"]
        steps = (("doctor", "entry", "answer", "Open", "Answered"),        # Q-T2
                 ("clinician", "entry", "followup", "Answered", "Open"),   # Q-T5
                 ("clinician", "entry", "followup", "Open", "Open"),       # Q-T4
                 ("doctor2", "entry", "answer", "Open", "Answered"),       # Q-T2
                 ("doctor", "entry", "answer", "Answered", "Answered"),    # Q-T3
                 ("clinician", "close", "close", "Answered", "Closed"))    # Q-T6
        for revision, (user, route, kind, before, to) in enumerate(steps, start=1):
            with self.subTest(user=user, kind=kind, revision=revision):
                _, result = self.entry(user, qid, revision) if route == "entry" else self.shut(user, qid, revision)
                applied = result.body["applied"]
                self.assertEqual((applied["entry"]["kind"], applied["from"], applied["to"], applied["revision"]),
                                 (kind, before, to, revision + 1))
        thread = self.read("doctor", qid)
        self.assertEqual([(e["seq"], e["kind"], e["author"]["role"]) for e in thread["entries"]],
                         [(1, "question", "clinician"), (2, "answer", "radiologist"), (3, "followup", "clinician"),
                          (4, "followup", "clinician"), (5, "answer", "radiologist"), (6, "answer", "radiologist"), (7, "close", "clinician")])
        for item in thread["entries"]:
            self.assertEqual(sorted(item), ENTRY_KEYS)
        self.assertEqual((thread["state"], thread["revision"], thread["entryCount"]), ("Closed", 7, 7))
        self.assertEqual((thread["closed"]["by"]["actor"], thread["closed"]["by"]["role"]), (self.stack.actor("clinician"), "clinician"))
        # Q-T7: a radiologist or an admin closes someone else's question only with a note
        _, other = self.ask("clinician", f.uid, body="SYNTHETIC second question")
        q2 = other.body["applied"]["id"]
        self.shut("doctor", q2, 1, note="", expect=400, expected_code="QUESTION_INPUT_INVALID")
        # actors outside the table: another clinician does not see the thread, admin alone and technician hold no reply role
        self.entry("clinician2", q2, 1, expect=404, expected_code="QUESTION_NOT_FOUND")
        self.shut("clinician2", q2, 1, note="SYNTHETIC", expect=404, expected_code="QUESTION_NOT_FOUND")
        self.entry("hadmin", q2, 1, expect=403, expected_code="QUESTION_ROLE_REQUIRED")
        self.entry("tech", q2, 1, expect=403, expected_code="QUESTION_ROLE_REQUIRED")
        _, closing = self.shut("doctor", q2, 1, note="SYNTHETIC closed by the reader")
        self.assertEqual((closing.body["applied"]["from"], closing.body["applied"]["to"]), ("Open", "Closed"))
        # Every (state, action) pair of Open and Answered is in the table; Closed answers QUESTION_CLOSED to every new write.
        # QUESTION_STATE (a state outside the machine) cannot be reached through the API; TEST-S5-U4a-ACCESS pins it.
        for user, route in (("doctor", "entry"), ("clinician", "entry"), ("clinician", "close"), ("doctor", "close")):
            with self.subTest(closed=user + " " + route):
                if route == "entry":
                    self.entry(user, qid, 7, expect=409, expected_code="QUESTION_CLOSED")
                else:
                    self.shut(user, qid, 7, note="SYNTHETIC late", expect=409, expected_code="QUESTION_CLOSED")
        self.assertEqual(self.ledger(f.uid, qid), (7, 7, 7))
        self.assertEqual(self.ledger(f.uid, q2), (2, 2, 2))

    def test_q04_closed_question_refuses_late_writes(self) -> None:
        f = self.study()
        r0, created = self.ask("clinician", f.uid)
        qid = created.body["applied"]["id"]
        a, answered = self.entry("doctor", qid, 1)
        b, closed = self.shut("clinician", qid, 2)
        stored = (self.question_row(qid), self.entries(qid))
        # S-Q9: a new requestId at the current revision
        self.entry("doctor", qid, 3, expect=409, expected_code="QUESTION_CLOSED")
        self.entry("clinician", qid, 3, expect=409, expected_code="QUESTION_CLOSED")
        self.shut("clinician", qid, 3, expect=409, expected_code="QUESTION_CLOSED")
        self.shut("doctor", qid, 3, note="SYNTHETIC late close", expect=409, expected_code="QUESTION_CLOSED")
        # S-Q10: a new requestId at an earlier revision
        self.entry("doctor", qid, 2, expect=409, expected_code="QUESTION_CHANGED")
        self.shut("clinician", qid, 2, expect=409, expected_code="QUESTION_CHANGED")
        # the applied requestIds of every kind keep answering their receipts after Closed
        for again, first in ((self.ask("clinician", f.uid, rid=r0)[1], created), (self.entry("doctor", qid, 1, rid=a)[1], answered),
                             (self.shut("clinician", qid, 2, rid=b)[1], closed)):
            self.assertEqual((again.status, again.body["replayed"], again.body["applied"]), (201, True, first.body["applied"]))
        self.assertEqual((self.question_row(qid), self.entries(qid)), stored)
        self.assertEqual(self.ledger(f.uid, qid), (3, 3, 3))

    def test_q05_stale_revision_conflicts_without_merge(self) -> None:
        f = self.study()
        _, created = self.ask("clinician", f.uid)
        qid = created.body["applied"]["id"]
        bodies = {user: {"requestId": str(uuid.uuid4()), "expectedOwner": self.owner(user), "revision": 1,
                         "body": "SYNTHETIC concurrent answer " + user} for user in ("doctor", "doctor2")}
        for user in bodies:
            self.stack.token(user)   # both requests leave together; no token exchange inside the race
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = dict(zip(bodies, pool.map(
                lambda user: self.stack.request("POST", f"/questions/{quote(qid)}/entries", user, bodies[user]), bodies)))
        self.assertEqual(sorted(r.status for r in results.values()), [201, 409], {u: r.text[:200] for u, r in results.items()})
        winner = next(user for user, r in results.items() if r.status == 201)
        loser = next(user for user, r in results.items() if r.status == 409)
        self.assertEqual(code(results[loser]), "QUESTION_CHANGED")
        self.assertEqual(self.ledger(f.uid, qid), (2, 2, 2))
        thread = self.read("doctor", qid)
        self.assertEqual([e["body"] for e in thread["entries"]], ["SYNTHETIC question", "SYNTHETIC concurrent answer " + winner])
        # no merge: the loser's text reaches the thread only as a new request against the revision it now reads
        _, again = self.entry(loser, qid, 2, body="SYNTHETIC concurrent answer " + loser)
        self.assertEqual(again.body["applied"]["revision"], 3)

    def test_q06_cross_tenant_uid_and_owner_negatives(self) -> None:
        f = self.study()
        _, created = self.ask("clinician", f.uid)
        qid = created.body["applied"]["id"]
        self.entry("doctor", qid, 1)
        opened = self.check(self.stack.request("PATCH", f"/studies/{quote(f.uid)}", "doctor", {"ts": "wait", "teleTo": "kin-center"}), 200)
        self.assertEqual(opened.body["teleInstitutionId"], "kin-center")
        before = self.ledger(f.uid, qid)
        other_uid, other_id = "2.25." + str(uuid.uuid4().int), str(uuid.uuid4())

        def ask_body(user):
            return {"requestId": str(uuid.uuid4()), "expectedOwner": self.owner(user), "body": "SYNTHETIC foreign question"}

        def reply_body(user):
            return {"requestId": str(uuid.uuid4()), "expectedOwner": self.owner(user), "revision": 2, "body": "SYNTHETIC foreign answer"}

        def close_body(user):
            return {"requestId": str(uuid.uuid4()), "expectedOwner": self.owner(user), "revision": 2, "note": "SYNTHETIC foreign close"}

        cases = (
            ("uid changed: study threads", "GET", f"/studies/{other_uid}/questions", "doctor", None, "STUDY_NOT_FOUND"),
            ("uid changed: create", "POST", f"/studies/{other_uid}/questions", "clinician", ask_body("clinician"), "STUDY_NOT_FOUND"),
            ("id changed: read", "GET", f"/questions/{other_id}", "doctor", None, "QUESTION_NOT_FOUND"),
            ("id changed: reply", "POST", f"/questions/{other_id}/entries", "doctor", reply_body("doctor"), "QUESTION_NOT_FOUND"),
            ("tele radiologist: read", "GET", f"/questions/{qid}", "kdoctor", None, "QUESTION_NOT_FOUND"),
            ("tele radiologist: study threads", "GET", f"/studies/{quote(f.uid)}/questions", "kdoctor", None, "STUDY_NOT_FOUND"),
            ("tele radiologist: answer", "POST", f"/questions/{qid}/entries", "kdoctor", reply_body("kdoctor"), "QUESTION_NOT_FOUND"),
            ("tele radiologist: close", "POST", f"/questions/{qid}/close", "kdoctor", close_body("kdoctor"), "QUESTION_NOT_FOUND"),
            ("other institution clinician: create", "POST", f"/studies/{quote(f.uid)}/questions", "kclinician", ask_body("kclinician"), "STUDY_NOT_FOUND"),
            ("other institution admin: read", "GET", f"/questions/{qid}", "kadmin", None, "QUESTION_NOT_FOUND"),
            ("other institution admin: close", "POST", f"/questions/{qid}/close", "kadmin", close_body("kadmin"), "QUESTION_NOT_FOUND"),
        )
        for label, method, path, user, body, expected in cases:
            with self.subTest(case=label):
                self.check(self.stack.request(method, path, user, body), 404, expected)
        for user, view in (("kdoctor", "inbox"), ("kadmin", "inbox"), ("kclinician", "mine")):
            with self.subTest(listed=user):
                self.assertNotIn(qid, self.ids(self.listed(user, view)))
        # owner negatives: another member's or another institution's expectedOwner is 409 before any lookup
        for wrong in (self.owner("clinician2"), ["kin-center", self.stack.user_ids["clinician"]]):
            refused = self.stack.request("POST", f"/studies/{quote(f.uid)}/questions", "clinician",
                                         {"requestId": str(uuid.uuid4()), "expectedOwner": wrong, "body": "SYNTHETIC owner"})
            self.check(refused, 409, "OWNER_CHANGED")
        self.assertEqual(self.ledger(f.uid, qid), before)
        self.assertEqual(psql(f'SELECT count(*) FROM "StudyQuestion" WHERE "studyUid"={lit(f.uid)}'), ["1"])

    def test_q07_revocation_hides_thread_and_refuses_replay(self) -> None:
        f = self.study()
        _, created = self.ask("clinician", f.uid)
        qid = created.body["applied"]["id"]
        a1, _ = self.entry("qa", qid, 1)
        a2, _ = self.entry("doctor", qid, 2)
        self.assertEqual(self.ledger(f.uid, qid), (3, 3, 3))
        page = self.cursor(self.read("qa", qid)["createdAt"], qid, 0)
        self.listed("qa", "inbox", cursor=page)
        # (a) StudyAccess restricts the answering radiologist away from the study (S-Q13)
        self.restrict("qa", restricted(rule(studyUids=["2.25." + str(uuid.uuid4().int)])))
        self.check(self.stack.request("GET", f"/questions/{qid}", "qa"), 404, "QUESTION_NOT_FOUND")
        self.assertNotIn(qid, self.ids(self.listed("qa", "inbox")))
        self.listed("qa", "inbox", 400, "QUESTION_INPUT_INVALID", cursor=page)
        self.check(self.stack.request("GET", f"/studies/{quote(f.uid)}/questions", "qa"), 404, "STUDY_NOT_FOUND")
        self.entry("qa", qid, 3, expect=404, expected_code="QUESTION_NOT_FOUND")
        self.entry("qa", qid, 1, rid=a1, expect=404, expected_code="QUESTION_NOT_FOUND")
        self.read("doctor", qid)
        # (b) the author loses the clinician role; the member keeps technician, so the service answers (S-Q11)
        r2, second = self.ask("clintech", f.uid, body="SYNTHETIC revocation question")
        q2 = second.body["applied"]["id"]
        self.remove_role("clintech", "clinician")
        self.ask("clintech", f.uid, body="SYNTHETIC revocation question", rid=r2, expect=403, expected_code="QUESTION_ROLE_REQUIRED")
        self.check(self.stack.request("GET", f"/questions/{q2}", "clintech"), 403, "QUESTION_ROLE_REQUIRED")
        self.listed("clintech", "mine", 403, "QUESTION_ROLE_REQUIRED")
        self.assertEqual(self.read("doctor", q2)["author"]["actor"], self.stack.actor("clintech"))
        # (c) the owning institution changes (psql, F-21): hidden on both sides and never moved; replay refused (S-Q12)
        self.move(f.uid, "kin-center")
        try:
            for user in ("doctor", "clinician", "kdoctor", "kadmin"):
                with self.subTest(moved=user):
                    self.check(self.stack.request("GET", f"/questions/{qid}", user), 404, "QUESTION_NOT_FOUND")
            self.entry("doctor", qid, 2, rid=a2, expect=404, expected_code="QUESTION_NOT_FOUND")
            self.check(self.stack.request("GET", f"/studies/{quote(f.uid)}/questions", "doctor"), 404, "STUDY_NOT_FOUND")
            moved = self.check(self.stack.request("GET", f"/studies/{quote(f.uid)}/questions", "kdoctor"), 200)
            self.assertEqual(moved.body["items"], [], "the new owner never inherits the old owner's threads")
            self.assertNotIn(qid, self.ids(self.listed("kdoctor", "inbox")))
            self.assertNotIn(qid, self.ids(self.listed("doctor", "inbox")))
        finally:
            self.move(f.uid, "hallym")
        self.assertEqual(self.read("doctor", qid)["revision"], 3)
        self.assertEqual(self.ledger(f.uid, qid), (3, 3, 3))
        self.assertEqual(self.ledger(f.uid, q2), (1, 1, 1))

    def test_q08_role_matrix(self) -> None:
        f = self.study()
        uid = quote(f.uid)
        self.check(self.stack.request("PATCH", f"/studies/{uid}", "doctor", {"ts": "wait", "teleTo": "kin-center"}), 200)
        tokens = {"gateway": self.stack.service_token("gateway"), "pending": self.pending_token()}
        _, own = self.ask("clinician", f.uid)
        _, mixed = self.ask("clinrad", f.uid, body="SYNTHETIC mixed question")
        mine_q, other_q = own.body["applied"]["id"], mixed.body["applied"]["id"]
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

        def body(identity, **fields):
            return {"requestId": str(uuid.uuid4()), "expectedOwner": owner_of(identity), **fields}

        guard = [("gateway", 403, None, "게이트웨이에 허용되지 않는 경로입니다"), ("pending", 403, "INSTITUTION_PENDING", None)]
        # RM-Q1 create
        for identity, status, expected, message in [("clinician", 201, None, None), ("clinrad", 201, None, None),
                                                    ("doctor", 403, "QUESTION_ROLE_REQUIRED", None), ("tech", 403, "QUESTION_ROLE_REQUIRED", None),
                                                    ("hadmin", 403, "QUESTION_ROLE_REQUIRED", None), ("kclinician", 404, "STUDY_NOT_FOUND", None)] + guard:
            call("RM-Q1", identity, "POST", f"/studies/{uid}/questions", body(identity, body="SYNTHETIC matrix question"), status, expected, message)
        # RM-Q2 view=mine and RM-Q3 view=inbox
        for identity, status, expected, message in [("clinician", 200, None, None), ("clinrad", 200, None, None),
                                                    ("doctor", 403, "QUESTION_ROLE_REQUIRED", None), ("tech", 403, "QUESTION_ROLE_REQUIRED", None),
                                                    ("hadmin", 403, "QUESTION_ROLE_REQUIRED", None), ("kclinician", 200, None, None)] + guard:
            result = call("RM-Q2", identity, "GET", "/questions?view=mine", None, status, expected, message)
            if status == 200:
                seen = self.ids(result)
                self.assertEqual(seen & {mine_q, other_q}, {"clinician": {mine_q}, "clinrad": {other_q}, "kclinician": set()}[identity])
        for identity, status, expected, message in [("clinician", 403, "QUESTION_ROLE_REQUIRED", None), ("clinrad", 200, None, None),
                                                    ("doctor", 200, None, None), ("tech", 403, "QUESTION_ROLE_REQUIRED", None),
                                                    ("hadmin", 200, None, None), ("kdoctor", 200, None, None)] + guard:
            result = call("RM-Q3", identity, "GET", "/questions?view=inbox", None, status, expected, message)
            if status == 200:
                self.assertEqual(self.ids(result) & {mine_q, other_q}, set() if identity == "kdoctor" else {mine_q, other_q})
        # RM-Q4 read one thread and RM-Q5 the study's threads
        for identity, status, expected, message in [("clinician", 404, "QUESTION_NOT_FOUND", None), ("clinrad", 200, None, None),
                                                    ("doctor", 200, None, None), ("tech", 403, "QUESTION_ROLE_REQUIRED", None),
                                                    ("hadmin", 200, None, None), ("kdoctor", 404, "QUESTION_NOT_FOUND", None),
                                                    ("kadmin", 404, "QUESTION_NOT_FOUND", None)] + guard:
            call("RM-Q4", identity, "GET", f"/questions/{other_q}", None, status, expected, message)
        call("RM-Q4 own", "clinician", "GET", f"/questions/{mine_q}", None, 200)
        for identity, status, expected, message in [("clinician", 200, None, None), ("clinrad", 200, None, None),
                                                    ("doctor", 200, None, None), ("tech", 403, "QUESTION_ROLE_REQUIRED", None),
                                                    ("hadmin", 200, None, None), ("kclinician", 404, "STUDY_NOT_FOUND", None),
                                                    ("kdoctor", 404, "STUDY_NOT_FOUND", None)] + guard:
            result = call("RM-Q5", identity, "GET", f"/studies/{uid}/questions", None, status, expected, message)
            if status == 200:
                authors = {item["author"]["actor"] for item in result.body["items"]}
                if identity == "clinician":
                    self.assertEqual(authors, {self.stack.actor("clinician")}, "a clinician-only member sees only its own threads")
                else:
                    self.assertIn(self.stack.actor("clinrad"), authors)
        # RM-Q6 answer by a non-author; RM-Q7 follow-up by the author (the server decides the kind)
        for identity, status, expected, message in [("clinician", 404, "QUESTION_NOT_FOUND", None), ("tech", 403, "QUESTION_ROLE_REQUIRED", None),
                                                    ("hadmin", 403, "QUESTION_ROLE_REQUIRED", None), ("kdoctor", 404, "QUESTION_NOT_FOUND", None)] + guard:
            call("RM-Q6", identity, "POST", f"/questions/{other_q}/entries", body(identity, revision=1, body="SYNTHETIC matrix answer"),
                 status, expected, message)
        answer = call("RM-Q6", "doctor", "POST", f"/questions/{other_q}/entries", body("doctor", revision=1, body="SYNTHETIC reader answer"), 201)
        crossed = call("RM-Q6 mixed", "clinrad", "POST", f"/questions/{mine_q}/entries", body("clinrad", revision=1, body="SYNTHETIC mixed answer"), 201)
        self.assertEqual((answer.body["applied"]["entry"]["kind"], crossed.body["applied"]["entry"]["kind"]), ("answer", "answer"))
        followup = call("RM-Q7", "clinician", "POST", f"/questions/{mine_q}/entries", body("clinician", revision=2, body="SYNTHETIC follow-up"), 201)
        mixed_followup = call("RM-Q7 mixed", "clinrad", "POST", f"/questions/{other_q}/entries", body("clinrad", revision=2, body="SYNTHETIC own follow-up"), 201)
        self.assertEqual((followup.body["applied"]["entry"]["kind"], mixed_followup.body["applied"]["entry"]["kind"]), ("followup", "followup"))
        self.assertEqual(self.entries(other_q)[-1]["authorRole"], "clinician", "a mixed author writes a follow-up, never an answer")
        # RM-Q8 close
        for identity, status, expected, message in [("tech", 403, "QUESTION_ROLE_REQUIRED", None), ("kdoctor", 404, "QUESTION_NOT_FOUND", None),
                                                    ("hadmin", 400, "QUESTION_INPUT_INVALID", None)] + guard:
            note = "" if identity == "hadmin" else "SYNTHETIC matrix close"
            call("RM-Q8", identity, "POST", f"/questions/{other_q}/close", body(identity, revision=3, note=note), status, expected, message)
        admin_close = call("RM-Q8", "hadmin", "POST", f"/questions/{other_q}/close", body("hadmin", revision=3, note="SYNTHETIC admin close"), 201)
        author_close = call("RM-Q8", "clinician", "POST", f"/questions/{mine_q}/close", body("clinician", revision=3, note=""), 201)
        _, third = self.ask("clinician", f.uid, body="SYNTHETIC third question")
        reader_close = call("RM-Q8", "doctor", "POST", f"/questions/{third.body['applied']['id']}/close",
                            body("doctor", revision=1, note="SYNTHETIC reader close"), 201)
        self.assertEqual([self.question_row(q)["closedByRole"] for q in (other_q, mine_q, third.body["applied"]["id"])],
                         ["admin", "clinician", "radiologist"])
        for closed in (admin_close, author_close, reader_close):
            self.assertEqual(closed.body["applied"]["to"], "Closed")
        print("CLINICIAN_QUESTION_LIVE_MATRIX " + json.dumps(observed, ensure_ascii=True, sort_keys=True))

    def test_q09_consultation_unchanged_for_clinician(self) -> None:
        f = self.study()
        actor = self.stack.actor("clinician").replace("'", "''")
        before = psql(f"SELECT count(*) FROM \"AuditLog\" WHERE actor='{actor}'")
        probes = (("GET", "/consultation-candidates", None), ("GET", "/consultations?direction=received", None),
                  ("GET", f"/consultations/{uuid.uuid4()}", None), ("POST", f"/studies/{quote(f.uid)}/consultations", {}),
                  ("POST", f"/consultations/{uuid.uuid4()}", {}))
        for method, path, body in probes:
            with self.subTest(route=method + " " + path.split("?")[0]):
                self.check(self.stack.request(method, path, "clinician", body), 403, "CLINICIAN_ROUTE_DENIED")
        # a mixed clinician+radiologist keeps the reader's consultation path unchanged
        candidates = self.check(self.stack.request("GET", "/consultation-candidates", "clinrad"), 200)
        self.assertEqual(sorted(candidates.body), ["owner", "readers"])
        received = self.check(self.stack.request("GET", "/consultations?direction=received", "clinrad"), 200)
        self.assertIsInstance(received.body["items"], list)
        self.check(self.stack.request("GET", "/consultations?direction=nowhere", "clinrad"), 400)
        self.check(self.stack.request("GET", "/consultation-candidates", "tech"), 403)
        self.assertEqual(psql(f'SELECT count(*) FROM "StudyConsultation" WHERE "studyUid"={lit(f.uid)}'), ["0"])
        self.assertEqual(psql(f"SELECT count(*) FROM \"AuditLog\" WHERE actor='{actor}'"), before)

    def test_q10_audit_rows_attributed_and_text_free(self) -> None:
        f = self.study()
        texts = ("SYNTHETIC-Q10-question-text", "SYNTHETIC-Q10-answer-text", "SYNTHETIC-Q10-followup-text", "SYNTHETIC-Q10-close-note")
        r0, created = self.ask("clinician", f.uid, body=texts[0])
        qid = created.body["applied"]["id"]
        a, _ = self.entry("doctor", qid, 1, body=texts[1])
        c, _ = self.entry("clinician", qid, 2, body=texts[2])
        b, _ = self.shut("doctor", qid, 3, note=texts[3])
        # a replay, a reuse and a refusal write no audit row
        self.entry("doctor", qid, 1, body=texts[1], rid=a)
        self.entry("doctor", qid, 1, body="SYNTHETIC-Q10-other", rid=a, expect=409, expected_code=REUSED)
        self.entry("tech", qid, 4, expect=403, expected_code="QUESTION_ROLE_REQUIRED")
        rows = self.question_audits(f.uid)
        expected = ((self.stack.actor("clinician"), "question", None, "Open", 1, r0, "clinician"),
                    (self.stack.actor("doctor"), "answer", "Open", "Answered", 2, a, "radiologist"),
                    (self.stack.actor("clinician"), "followup", "Answered", "Open", 3, c, "clinician"),
                    (self.stack.actor("doctor"), "close", "Open", "Closed", 4, b, "radiologist"))
        self.assertEqual(len(rows), len(expected))
        for row, (actor, kind, before, to, revision, rid, role) in zip(rows, expected):
            with self.subTest(kind=kind, revision=revision):
                detail = json.loads(row["detail"])
                self.assertEqual(sorted(detail), DETAIL_KEYS)
                self.assertEqual((row["actor"], row["action"], row["target"]), (actor, "study.question", f.uid))
                self.assertEqual((detail["id"], detail["institution"], detail["entry"], detail["kind"], detail["from"], detail["to"],
                                  detail["revision"], detail["requestId"], detail["role"]),
                                 (qid, "hallym", rid, kind, before, to, revision, rid, role))
                for text in texts + (f.patient_id,):
                    self.assertNotIn(text, row["detail"])
        # the owning institution reads the same four rows through GET audit
        listed = self.check(self.audit("jmryu", f.uid, 500), 200)
        self.assertEqual(sorted(row["id"] for row in listed.body if row["action"] == "study.question"), sorted(row["id"] for row in rows))

    def test_q11_answer_keeps_report_anchor_after_reset(self) -> None:
        f = self.study()
        _, created = self.ask("clinician", f.uid)
        qid = created.body["applied"]["id"]
        approved = self.check(self.commit(f.uid, "doctor", "approve", 0, findings="SYNTHETIC-Q11-approved-findings",
                                          conclusion="SYNTHETIC-Q11-conclusion"), 201)
        self.assertEqual(approved.body["rs"], "A")
        at_answer = self.head_version(f.uid)
        self.assertIsNotNone(at_answer)
        self.entry("doctor2", qid, 1)
        added = self.check(self.commit(f.uid, "doctor2", "addendum", approved.body["version"], findings="SYNTHETIC-Q11-addendum"), 201)
        reset = self.check(self.commit(f.uid, "doctor", "reset", added.body["version"], reason="SYNTHETIC Q11 reset"), 201)
        self.assertEqual(reset.body["rs"], "W")
        thread = self.read("clinician", qid)
        self.assertEqual(thread["entries"][0]["reportAnchor"], {"rs": "W", "version": None})
        self.assertEqual(thread["entries"][1]["reportAnchor"], {"rs": "A", "version": at_answer})
        self.assertEqual(thread["current"], {"rs": "W", "version": self.head_version(f.uid)})
        self.assertNotEqual(thread["current"], thread["entries"][1]["reportAnchor"])
        self.assertEqual((thread["state"], thread["revision"]), ("Answered", 2), "the server never reopens or closes a thread")
        text = json.dumps(thread, ensure_ascii=False)
        for body in ("SYNTHETIC-Q11-approved-findings", "SYNTHETIC-Q11-conclusion", "SYNTHETIC-Q11-addendum"):
            self.assertNotIn(body, text)

    def test_q12_study_delete_refused_while_questions_exist(self) -> None:
        f = self.study()
        _, created = self.ask("clinician", f.uid)
        qid = created.body["applied"]["id"]
        state = psql(f'SELECT to_jsonb(t)::text FROM "StudyState" t WHERE uid={lit(f.uid)}')
        stored = (self.question_row(qid), self.entries(qid))
        self.assertEqual(psql(f"SELECT count(*) FROM \"ReportVersion\" WHERE uid={lit(f.uid)}"), ["0"], "no reading history")
        self.check(self.stack.request("DELETE", f"/studies/{quote(f.uid)}", "tech"), 409, "STUDY_HAS_QUESTIONS")
        self.assertEqual(psql(f'SELECT to_jsonb(t)::text FROM "StudyState" t WHERE uid={lit(f.uid)}'), state)
        self.assertEqual((self.question_row(qid), self.entries(qid)), stored)
        self.assertEqual(psql(f"SELECT count(*) FROM \"AuditLog\" WHERE target={lit(f.uid)} AND action='state.delete'"), ["0"])

    def test_q13_audit_rows_owner_institution_only(self) -> None:
        f = self.study()
        uid = f.uid
        self.check(self.stack.request("PATCH", f"/studies/{quote(uid)}", "doctor", {"ts": "wait", "teleTo": "kin-center"}), 200)

        def rows(user, scoped=True, take=500):
            return self.check(self.audit(user, uid, take, scoped), 200).body

        def of_study(listed):
            return [row for row in listed if row["target"] == uid]

        def questions(listed):
            return [row for row in of_study(listed) if row["action"] == "study.question"]

        tele_before = {user: [row["id"] for row in rows(user)] for user in ("kdoctor", "kadmin")}
        self.assertTrue(all(tele_before.values()), "the tele institution sees the study's earlier rows")
        r0, created = self.ask("clinician", uid)
        qid = created.body["applied"]["id"]
        a, _ = self.entry("doctor", qid, 1)
        c, _ = self.entry("clinician", qid, 2)
        b, _ = self.shut("clinician", qid, 3)
        secret = {qid, r0, a, c, b}
        # (a) B radiologist and B admin: no owner-only row on either path, no id in the answer, other rows as before
        for user in ("kdoctor", "kadmin"):
            for scoped in (True, False):
                with self.subTest(a=user, scoped=scoped):
                    listed = rows(user, scoped)
                    self.assertEqual(questions(listed), [])
                    self.assertEqual([row["id"] for row in of_study(listed)], tele_before[user])
                    text = json.dumps(listed)
                    for value in secret:
                        self.assertNotIn(value, text)
        # (b) the filter runs before LIMIT: the newest rows of this study are question rows, yet take=1 is not empty
        newest = rows("doctor", True, 1)
        self.assertEqual(newest[0]["action"], "study.question")
        for user in ("kdoctor", "kadmin"):
            for scoped in (True, False):
                with self.subTest(b=user, scoped=scoped):
                    one, full = rows(user, scoped, 1), rows(user, scoped, 500)
                    self.assertEqual(len(one), 1, "a short page would reveal a filtered row")
                    self.assertEqual(one[0], full[0])
        # (c) the owning institution's radiologist and admin read all four rows
        for user in ("doctor", "hadmin"):
            for scoped in (True, False):
                with self.subTest(c=user, scoped=scoped):
                    owned = questions(rows(user, scoped))
                    self.assertEqual(len(owned), 4)
                    for row in owned:
                        self.assertEqual(sorted(json.loads(row["detail"])), DETAIL_KEYS)
        # (d) the owner becomes C (psql, F-21; kin-center as a plain owner, no tele): rows of the A era stay A's
        self.move(uid, "kin-center")
        try:
            for scoped in (True, False):
                self.assertEqual(questions(rows("kadmin", scoped)), [])
            self.check(self.audit("hadmin", uid, 500), 404)
            self.assertEqual(of_study(rows("hadmin", False)), [])
            # (e) a row created while C owns the study
            _, c_era = self.ask("kclinician", uid, body="SYNTHETIC C-era question")
            c_question = c_era.body["applied"]["id"]
            self.assertEqual([json.loads(row["detail"])["id"] for row in questions(rows("kadmin"))], [c_question])
        finally:
            self.move(uid, "hallym")
        for scoped in (True, False):
            with self.subTest(e=scoped):
                back = questions(rows("hadmin", scoped))
                self.assertEqual(len(back), 4)
                self.assertNotIn(c_question, {json.loads(row["detail"])["id"] for row in back})
        self.check(self.audit("kadmin", uid, 500), 404)
        # (f) the clinician-only gate still refuses GET audit on both paths
        for scoped in (True, False):
            self.check(self.audit("clinician", uid, 500, scoped), 403, "CLINICIAN_ROUTE_DENIED")
        self.assertEqual(self.ledger(uid, qid), (4, 4, 4))
        self.assertEqual(self.ledger(uid, c_question), (1, 1, 1))

    def test_q14_metadata_study_access_allows_and_denies(self) -> None:
        f = self.study()
        instance = self.stack.first_instance_id(f.uid)
        tags = self.check(self.stack._orthanc_request("GET", f"/instances/{quote(instance)}/tags?simplify"), 200).body
        modality, patient, date = tags["Modality"], tags["PatientID"], tags["StudyDate"]
        self.assertEqual(patient, f.patient_id)
        self.assertRegex(date, r"^[0-9]{8}$")
        day = f"{date[:4]}-{date[4:6]}-{date[6:]}"
        self.restrict("qx", restricted(rule(modalities=[modality])))
        self.restrict("qy", restricted(rule(patientId="SYNTHETIC-OTHER-PATIENT")))
        self.restrict("qz", restricted(rule(dateFrom=day, dateTo=day)))
        self.restrict("qw", restricted(rule(patientId=patient)))
        marks = self.orthanc_marks()
        _, created = self.ask("qw", f.uid)
        qid = created.body["applied"]["id"]
        self.entry("qx", qid, 1)
        self.entry("qz", qid, 2)
        self.assertEqual(self.ledger(f.uid, qid), (3, 3, 3))
        for user in ("qx", "qz", "qw"):
            self.assertEqual(self.read(user, qid)["revision"], 3)
        self.assertNotIn(qid, self.ids(self.listed("qy", "inbox")))
        self.assertIn(qid, self.ids(self.listed("qx", "inbox")))
        self.check(self.stack.request("GET", f"/questions/{qid}", "qy"), 404, "QUESTION_NOT_FOUND")
        self.check(self.stack.request("GET", f"/studies/{quote(f.uid)}/questions", "qy"), 404, "STUDY_NOT_FOUND")
        self.entry("qy", qid, 3, expect=404, expected_code="QUESTION_NOT_FOUND")
        self.shut("qy", qid, 3, note="SYNTHETIC denied close", expect=404, expected_code="QUESTION_NOT_FOUND")
        self.assertEqual(self.ledger(f.uid, qid), (3, 3, 3))
        self.assert_orthanc_unchanged(marks)

    def test_q15_thread_read_is_one_snapshot(self) -> None:
        """Astra S5-U4a-F01. The thread read (#2) and the study's thread list (#3) of the clinician wait on the clinician's
        study-access lock, the first query of their transaction. RepeatableRead fixed the snapshot before that wait, so
        an answer, a close and a report reset committed through the product routes meanwhile reach neither answer: both
        are the moment before, whole. A read taking a snapshot per statement answers the moment after instead."""
        f = self.study()
        _, created = self.ask("clinician", f.uid)
        qid = created.body["applied"]["id"]
        approved = self.check(self.commit(f.uid, "doctor", "approve", 0, findings="SYNTHETIC-Q15-findings"), 201)
        self.assertEqual(approved.body["rs"], "A")
        thread_path, study_path = f"/questions/{quote(qid)}", f"/studies/{quote(f.uid)}/questions"
        before = self.read("clinician", qid)
        listed = self.check(self.stack.request("GET", study_path, "clinician"), 200).body["items"]
        self.whole(before)
        self.assertEqual((before["state"], before["revision"], before["current"]), ("Open", 1, {"rs": "A", "version": self.head_version(f.uid)}))
        self.assertEqual([item["id"] for item in listed], [qid])
        for user in ("clinician", "doctor", "doctor2"):
            self.stack.token(user)   # no token exchange or GET /me while the reads wait
            self.owner(user)
        holder, key = self.hold_access_lock("clinician")
        try:
            with ThreadPoolExecutor(max_workers=2) as pool:
                reads = [pool.submit(self.stack.request, "GET", path, "clinician") for path in (thread_path, study_path)]
                self.wait_on_lock(holder, key, 2)
                started = time.monotonic()
                _, answered = self.entry("doctor2", qid, 1, body="SYNTHETIC Q15 answer while the reads wait")
                _, closed = self.shut("doctor", qid, 2, note="SYNTHETIC Q15 close while the reads wait")
                reset = self.check(self.commit(f.uid, "doctor", "reset", approved.body["version"], reason="SYNTHETIC Q15 reset"), 201)
                # the waiting transactions give up after the service's 3 s lock_timeout (503 QUESTION_BUSY)
                print(f"CLINICIAN_QUESTION_Q15_WRITES_SECONDS {time.monotonic() - started:.3f}", flush=True)
                self.release_lock(holder)
                thread, threads = [future.result(timeout=30) for future in reads]
        finally:
            self.release_lock(holder)
        self.assertEqual([answered.body["applied"]["revision"], closed.body["applied"]["revision"], reset.body["rs"]], [2, 3, "W"])
        self.check(thread, 200)
        self.check(threads, 200)
        self.assertEqual(thread.body["item"], before, "the waiting read answers the snapshot fixed before the commits")
        self.assertEqual(threads.body["items"], listed, "the waiting study list answers the same snapshot")
        self.whole(thread.body["item"])
        after = self.read("clinician", qid)
        self.whole(after)
        self.assertEqual((after["state"], after["revision"], [e["kind"] for e in after["entries"]]), ("Closed", 3, ["question", "answer", "close"]))
        self.assertEqual((after["closed"]["by"]["actor"], after["closed"]["by"]["role"]), (self.stack.actor("doctor"), "radiologist"))
        self.assertEqual(after["current"], {"rs": "W", "version": self.head_version(f.uid)})
        self.assertNotEqual(after["current"]["version"], before["current"]["version"])
        [summary] = self.check(self.stack.request("GET", study_path, "clinician"), 200).body["items"]
        self.assertEqual((summary["state"], summary["revision"], summary["entryCount"]), ("Closed", 3, 3))
        self.assertEqual(self.ledger(f.uid, qid), (3, 3, 3))


# The pinned order is the class's own: a renamed, added or missing case stops the module before any live call.
if [name for name in sorted(vars(ClinicianQuestionLive)) if name.startswith("test_")] != [name for name, _ in CASES]:
    raise RuntimeError("clinician_question_live CASES does not match the test methods")


if __name__ == "__main__":
    print("Run through scripts/run-tests.py --mode live; direct execution is refused by the gate.", file=sys.stderr)
    raise SystemExit(125)
