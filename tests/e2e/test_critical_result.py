# coding: utf-8
"""S7-U1a critical result delivery on the real Nest guard and service, PostgreSQL, Keycloak and Orthanc (API level).

REQ-S7-U1a-SOURCE-PIN / REQ-S7-U1a-IDEMPOTENCY / REQ-S7-U1a-AUTHZ / REQ-S7-U1a-RECIPIENT-MATRIX / REQ-S7-U2a-EXPLICIT-ACK /
REQ-S7-U1p-IDENTITY / REQ-S7-U1p-WRITE-OUTCOME / REQ-S7-U2a-RECIPIENT-LIST
  -> RISK-S7-U1p-FALSE-ACK / RISK-S7-CVR-STALE-SOURCE / RISK-S7-U2a-BODY-SUBSTITUTE / RISK-S7-CVR-ACK-CANCEL-RACE /
     RISK-S7-CVR-REVOKED-ACK / RISK-S7-CVR-COUNT-LEAK / RISK-S7-U1p-STALE-IDENTITY / RISK-S7-U1p-FALSE-UNDELIVERED /
     RISK-S7-U1p-CLASS-WIDENING
  -> TEST-S7-U1a-LIVE (state-transition half; the case names follow contract S7-U1p section 2.3 CR03-CR09, CR14,
     CR17-CR20, CR22 and the section 7.1 sequences S-CR, S-SU, S-RS, S-RR, S-RACE). The role matrix, the institution and
     tele boundary, the DB constraints of the append-only ledger and the study delete refusal are the invariant class in
     tests/invariants_live.py. No browser: the sender and recipient screens are S7-U1b and S7-U2a.

Synthetic stack only, through scripts/run-tests.py (LiveStack refuses any other entry):

    python scripts/run-tests.py --module tests/e2e/test_critical_result.py --mode live --unit s7-u1a-critical-result-e2e --timeout 2400

Owned data only: run-created Keycloak users (kin-test-*), the realm role `clinician` only when this run had to create it,
one synthetic C-STORE study per case (two or three for S-RR), the critical result rows, receipts and audit rows written on
those studies, and SYNTHETIC StudyAccess policies on this run's `doctor`. Every case removes its critical result rows before
the study cleanup (all foreign keys RESTRICT). Cases that remove a Keycloak role, move a member's group, disable a member or
move a study's owner restore it in a finally block. Not proved here: withdrawing a clinician-only member's access per study
(study-access target() does not manage clinicians, decision D-S7-13 a).
"""
from __future__ import annotations

import sys
import time
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from invariants_live import (  # noqa: E402
    CriticalResultHarness, Fixture, HttpResult, LiveStack, critical_ledger, critical_row, drop_critical_results,
    ensure_clinician_role, psql, sql_text,
)
from test_worklist import require_local_targets  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

IDENTITIES = (
    ("clinician", ["clinician"], "hallym"),
    ("clinician2", ["clinician"], "hallym"),
    ("clintech", ["clinician", "technician"], "hallym"),
    ("clinrad", ["clinician", "radiologist"], "hallym"),
    ("radx", ["radiologist"], "hallym"),
    ("radz", ["radiologist"], "hallym"),
    ("hadmin", ["admin"], "hallym"),
    ("kclinician", ["clinician"], "kin-center"),
)
ROLE_REQUIRED = "CRITICAL_RESULT_ROLE_REQUIRED"
NOT_FOUND = "CRITICAL_RESULT_NOT_FOUND"
MESSAGE = "SYNTHETIC critical finding message"


def restricted(*uids: str) -> dict:
    return {"version": 1, "restricted": True, "startsAt": None, "endsAt": None,
            "rules": [{"patientId": None, "modalities": [], "dateFrom": None, "dateTo": None, "studyUids": list(uids)}]}


UNRESTRICTED = {"version": 1, "restricted": False, "startsAt": None, "endsAt": None, "rules": []}


class CriticalResultE2E(CriticalResultHarness, unittest.TestCase):
    maxDiff = None

    @classmethod
    def setUpClass(cls) -> None:
        cls.stack = LiveStack()
        require_local_targets(cls.stack)
        cls.owners = {}
        cls.created_role = False
        cls.addClassCleanup(cls.stack.cleanup_test_identities)
        cls.addClassCleanup(cls.stack.cleanup_all)
        cls.addClassCleanup(cls.drop_all_critical_results)
        cls.stack.require_stack()
        cls.created_role = ensure_clinician_role(cls.stack)
        cls.addClassCleanup(cls.delete_role_if_created)
        for logical, roles, group in IDENTITIES:
            cls.stack.create_test_identity(logical, roles, group)

    @classmethod
    def delete_role_if_created(cls) -> None:
        if cls.created_role and cls.stack.kc_admin("DELETE", "/roles/clinician").status not in (204, 404):
            raise RuntimeError("temporary clinician role cleanup failed")
        cls.created_role = False

    @classmethod
    def drop_all_critical_results(cls) -> None:
        for uid in list(cls.stack.active):
            drop_critical_results(uid, set(cls.stack.user_ids.values()))

    # ── helpers ──

    def study(self) -> Fixture:
        fixture = self.stack.create_fixture()
        self.addCleanup(self.stack.cleanup_fixture, fixture.uid)
        self.addCleanup(drop_critical_results, fixture.uid, set(self.stack.user_ids.values()))
        return fixture

    def approved(self, fixture: Fixture) -> None:
        self.check(self.commit(fixture.uid, "doctor", "approve", 0, findings="SYNTHETIC approved " + fixture.secret,
                               conclusion="SYNTHETIC conclusion v1"), 201)

    def version_row(self, fixture: Fixture, version: int) -> dict:
        rows = self.check(self.stack.request("GET", f"/studies/{quote(fixture.uid)}/report/versions", "doctor"), 200).body
        [row] = [row for row in rows if row["version"] == version]
        return row

    def created(self, result: HttpResult) -> dict:
        body = self.check(result, 201).body
        self.assertEqual(sorted(body), ["applied", "owner", "replayed"])
        return body

    def item(self, user: str, record: str) -> dict:
        body = self.check(self.read(user, record), 200).body
        self.assertEqual(sorted(body), ["item", "owner"])
        return body["item"]

    def forbidden(self, result: HttpResult, *codes: str) -> None:
        self.assertEqual(result.status, 403, result.text[:400])
        self.assertIn(result.body.get("code") if isinstance(result.body, dict) else None, codes, result.text[:400])

    def role_mapping(self, logical: str, role_name: str, present: bool) -> None:
        role = self.stack.kc_admin("GET", "/roles/" + quote(role_name))
        self.assertEqual(role.status, 200, role.text)
        method = "POST" if present else "DELETE"
        changed = self.stack.kc_admin(method, f"/users/{quote(self.sub(logical))}/role-mappings/realm", [role.body])
        self.assertEqual(changed.status, 204, changed.text)

    def group_of(self, name: str) -> str:
        found = self.stack.kc_admin("GET", "/groups?search=" + quote(name))
        [group] = [row for row in found.body if row.get("name") == name]
        return group["id"]

    def move_member(self, logical: str, source: str, target: str) -> None:
        user = quote(self.sub(logical))
        self.assertEqual(self.stack.kc_admin("DELETE", f"/users/{user}/groups/{quote(self.group_of(source))}").status, 204)
        self.assertEqual(self.stack.kc_admin("PUT", f"/users/{user}/groups/{quote(self.group_of(target))}").status, 204)

    def enabled(self, logical: str, value: bool) -> None:
        self.assertEqual(self.stack.kc_admin("PUT", f"/users/{quote(self.sub(logical))}", {"enabled": value}).status, 204)

    def access(self, logical: str, policy: dict, revision: int) -> None:
        subject = self.sub(logical)
        written = self.stack.request("POST", f"/admin/users/{quote(subject)}/study-access", "jmryu", {
            "expectedOwner": self.owner("jmryu"), "policy": policy, "revision": revision,
            "reason": "SYNTHETIC S7-U1a access condition", "requestId": str(uuid.uuid4())})
        self.check(written, 201)

    def clear_access(self, logical: str) -> None:
        subject = self.sub(logical)
        for table in ("StudyAccessRevision", "StudyAccessPolicy"):
            for raw in psql(f'SELECT to_jsonb(t)::text FROM "{table}" t WHERE subject={sql_text(subject)}'):
                self.assertIn('"reason": "SYNTHETIC', raw)
                self.assertEqual(psql(f'DELETE FROM "{table}" t WHERE to_jsonb(t)={sql_text(raw)}::jsonb RETURNING 1'), ["1"])
        for raw in psql(f"SELECT to_jsonb(t)::text FROM \"AuditLog\" t WHERE target={sql_text(subject)} AND action='study.access'"):
            self.assertIn("SYNTHETIC", raw)
            self.assertEqual(psql(f'DELETE FROM "AuditLog" t WHERE to_jsonb(t)={sql_text(raw)}::jsonb RETURNING 1'), ["1"])

    def text_free(self, value: object, *texts: str) -> None:
        dumped = str(value)
        for text in texts:
            self.assertNotIn(text, dumped)

    # ── cases ──

    def test_cr_e2e_01_c2_create_read_explicit_ack_and_reads_never_acknowledge(self) -> None:
        """CR03/CR20: approve -> create -> received list -> read (the pinned body) -> ACK; GETs and time change nothing."""
        f = self.study()
        self.approved(f)
        rid, sent = self.send("doctor", f.uid, "clinician", 1)
        applied = self.created(sent)["applied"]
        self.assertEqual({key: applied[key] for key in ("id", "requestId", "action", "from", "to", "revision", "replacement")},
                         {"id": rid, "requestId": rid, "action": "create", "from": None, "to": "created", "revision": 1, "replacement": None})
        received = self.check(self.listed("clinician", "received", "pending"), 200)
        self.assertEqual((self.ids(received), received.body["pending"]), ([rid], 1))
        item = self.item("clinician", rid)
        pinned = self.version_row(f, 1)
        sender_name = self.check(self.stack.request("GET", "/me", "doctor"), 200).body["displayName"]
        self.assertEqual((item["view"], item["state"], item["message"], item["sender"]["name"]),
                         ("full", "created", MESSAGE, sender_name), "the sender name is the token's display name")
        self.assertEqual(item["body"], {key: pinned[key] for key in ("findings", "conclusion", "recommendation")})
        self.assertEqual({key: item["source"][key] for key in ("version", "action", "current", "reason")},
                         {"version": 1, "action": "approve", "current": True, "reason": None})
        self.assertEqual((item["study"]["uid"], item["study"]["id"]), (f.uid, f.patient_id))
        settled = critical_ledger(f.uid)
        for _ in range(4):
            self.check(self.listed("clinician", "received"), 200)
            self.check(self.read("clinician", rid), 200)
            self.check(self.read("doctor", rid), 200)
            self.check(self.for_study("doctor", f.uid), 200)
            self.check(self.listed("doctor", "sent"), 200)
            time.sleep(1)
        self.assertEqual(critical_ledger(f.uid), settled)
        self.assertEqual(self.item("clinician", rid)["state"], "created", "reading and elapsed time never acknowledge")
        sender = self.item("doctor", rid)
        self.assertEqual((sender["view"], sender["state"], sender["delivery"], sender["recipient"]["role"]), ("sender", "created", "readable", "clinician"))
        ack_rid, acked = self.ack("clinician", rid)
        self.assertEqual({key: self.created(acked)["applied"][key] for key in ("action", "from", "to", "revision")},
                         {"action": "ack", "from": "created", "to": "acknowledged", "revision": 2})
        after = self.item("clinician", rid)
        self.assertEqual((after["state"], after["revision"], after["acknowledgedAt"] is not None), ("acknowledged", 2, True))
        self.assertEqual(self.listed("clinician", "received").body["pending"], 0)
        self.assertEqual(self.ids(self.listed("clinician", "received", "acknowledged")), [rid])
        self.assertEqual(self.item("doctor", rid)["delivery"], None, "delivery is only for a pending record")
        self.assertEqual(critical_ledger(f.uid), {"records": 1, "events": 2, "receipts": 2, "audits": 2})

    def test_cr_e2e_02_head_moved_stub_and_supersede_s_su(self) -> None:
        """CR04: S-SU1..S-SU10 - after an addendum the clinician sees a stub (no message, no pinned or current body)."""
        f = self.study()
        self.approved(f)
        r0, sent = self.send("doctor", f.uid, "clinician", 1)
        self.created(sent)
        self.check(self.commit(f.uid, "doctor", "addendum", 1, findings="SYNTHETIC addendum body " + f.secret[-8:]), 201)
        stub = self.item("clinician", r0)                                                           # S-SU1
        self.assertEqual((stub["view"], stub["source"], stub["state"]), ("stub", {"current": False, "reason": "head_moved"}, "created"))
        self.text_free(stub, MESSAGE, f.secret, "SYNTHETIC addendum body", "SYNTHETIC approved")
        self.assertEqual(self.listed("clinician", "received").body["pending"], 1, "the stub stays pending until superseded or cancelled")
        self.check(self.ack("clinician", r0)[1], 409, "CRITICAL_RESULT_SOURCE_CHANGED")                 # S-SU2
        self.assertEqual((critical_row(r0)["state"], critical_row(r0)["revision"]), ("created", 1))
        duplicate = self.check(self.send("doctor", f.uid, "clinician", 2)[1], 409, "CRITICAL_RESULT_PENDING_EXISTS")   # S-SU3
        self.assertEqual(duplicate.body["id"], r0)
        self.check(self.supersede("doctor", r0, 1, 1)[1], 409, "CRITICAL_RESULT_SOURCE_MOVED")          # S-SU4
        b, replaced = self.supersede("doctor", r0, 1, 2)                                              # S-SU5
        applied = self.created(replaced)["applied"]
        self.assertEqual({key: applied[key] for key in ("id", "action", "from", "to", "revision", "replacement")},
                         {"id": r0, "action": "supersede", "from": "created", "to": "superseded", "revision": 2,
                          "replacement": {"id": b, "revision": 1, "sourceVersion": 2}})
        self.assertEqual(critical_ledger(f.uid), {"records": 2, "events": 3, "receipts": 2, "audits": 3})
        old, new = self.item("clinician", r0), self.item("clinician", b)                               # S-SU6
        self.assertEqual((old["view"], old["state"], old["replacedBy"]), ("stub", "superseded", b))
        self.assertEqual((new["view"], new["source"]["version"], new["body"]["findings"]),
                         ("full", 2, self.version_row(f, 2)["findings"]))
        self.created(self.ack("clinician", b)[1])                                                     # S-SU7
        again = self.created(self.supersede("doctor", r0, 1, 2, rid=b)[1])                            # S-SU8
        self.assertEqual((again["replayed"], again["applied"]), (True, applied))
        refused = self.check(self.supersede("doctor", r0, 2, 2)[1], 409, "CRITICAL_RESULT_SUPERSEDED")  # S-SU9
        self.assertEqual(refused.body["replacedBy"], b)
        self.check(self.ack("clinician", r0)[1], 409, "CRITICAL_RESULT_SUPERSEDED")                      # S-SU10
        self.assertEqual(critical_ledger(f.uid), {"records": 2, "events": 4, "receipts": 3, "audits": 4})

    def test_cr_e2e_03_reset_stub_and_cancel_s_rs(self) -> None:
        """CR05: S-RS1..S-RS6 - reset is never pinned; the clinician sees a stub; the sender cancels."""
        f = self.study()
        self.approved(f)
        r0, sent = self.send("doctor", f.uid, "clinician", 1)
        self.created(sent)
        self.check(self.commit(f.uid, "doctor", "reset", 1, reason="SYNTHETIC reset reason"), 201)
        head = max(row["version"] for row in self.check(self.stack.request("GET", f"/studies/{quote(f.uid)}/report/versions", "doctor"), 200).body)
        self.assertEqual(head, 3, "discarded v2 and reset v3")
        stub = self.item("clinician", r0)                                                           # S-RS1
        self.assertEqual((stub["view"], stub["source"]), ("stub", {"current": False, "reason": "reset"}))
        self.check(self.ack("clinician", r0)[1], 409, "CRITICAL_RESULT_SOURCE_CHANGED")                 # S-RS2
        self.check(self.supersede("doctor", r0, 1, 3)[1], 409, "CRITICAL_RESULT_SOURCE_INVALID")        # S-RS3
        self.check(self.supersede("doctor", r0, 1, 2)[1], 409, "CRITICAL_RESULT_SOURCE_MOVED")
        applied = self.created(self.cancel("doctor", r0, 1)[1])["applied"]                             # S-RS4
        self.assertEqual((applied["to"], applied["revision"]), ("cancelled", 2))
        self.assertEqual(critical_row(r0)["cancelReason"], "SYNTHETIC cancel reason")
        pending = self.check(self.listed("clinician", "received", "pending"), 200).body                # S-RS5
        self.assertEqual((pending["items"], pending["pending"]), ([], 0))
        self.check(self.ack("clinician", r0, 2)[1], 409, "CRITICAL_RESULT_CANCELLED")                   # S-RS6
        cancelled = self.item("clinician", r0)
        self.assertNotIn("cancelReason", cancelled, "a stub carries no cancel reason")
        self.assertEqual(critical_ledger(f.uid), {"records": 1, "events": 2, "receipts": 2, "audits": 2})

    def test_cr_e2e_04_radiologist_rows_s_rr(self) -> None:
        """CR07: S-RR1..S-RR8 - unsigned sources reach radiologists only; R3 shows the pinned row, never the head."""
        f = self.study()
        self.check(self.commit(f.uid, "doctor", "save", 0, findings="SYNTHETIC unsigned " + f.secret), 201)
        self.check(self.send("doctor", f.uid, "clinician", 1)[1], 409, "CRITICAL_RESULT_RECIPIENT_CANNOT_READ")   # S-RR1
        self.assertEqual(critical_ledger(f.uid), {"records": 0, "events": 0, "receipts": 0, "audits": 0})
        r0, sent = self.send("doctor", f.uid, "radx", 1)
        self.created(sent)
        v1 = self.version_row(f, 1)
        first = self.item("radx", r0)                                                               # S-RR2
        self.assertEqual((first["view"], first["source"]["current"], first["body"]["findings"]), ("full", True, v1["findings"]))
        self.check(self.commit(f.uid, "doctor", "approve", 1, findings="SYNTHETIC signed v2"), 201)
        moved = self.item("radx", r0)                                                               # S-RR3
        self.assertEqual((moved["view"], moved["source"]["current"], moved["source"]["reason"], moved["body"]["findings"]),
                         ("full", False, "head_moved", v1["findings"]))
        self.check(self.ack("radx", r0)[1], 409, "CRITICAL_RESULT_SOURCE_CHANGED")                      # S-RR4
        b, replaced = self.supersede("doctor", r0, 1, 2)                                              # S-RR5
        self.created(replaced)
        self.created(self.ack("radx", b)[1])
        g = self.study()                                                                              # S-RR6
        self.check(self.commit(g.uid, "doctor", "preliminary", 0, reviewer=self.stack.actor("doctor2"),
                               findings="SYNTHETIC preliminary " + g.secret), 201)
        self.check(self.send("doctor", g.uid, "radx", 1)[1], 409, "CRITICAL_RESULT_RECIPIENT_CANNOT_READ")
        self.created(self.send("doctor", g.uid, "doctor2", 1)[1])
        self.forbidden(self.send("radz", g.uid, "doctor2", 1)[1], "CRITICAL_RESULT_SOURCE_FORBIDDEN")   # S-RR7
        self.assertEqual(critical_ledger(g.uid)["records"], 1)
        h = self.study()                                                                              # S-RR8
        self.check(self.commit(h.uid, "doctor", "save", 0, findings="SYNTHETIC unsigned " + h.secret), 201)
        m, sent = self.send("doctor", h.uid, "clinrad", 1)
        self.created(sent)
        self.assertEqual(self.item("clinrad", m)["view"], "full")
        self.role_mapping("clinrad", "radiologist", present=False)
        self.stack.tokens.pop("clinrad", None)
        try:
            self.check(self.read("clinrad", m), 404, NOT_FOUND)
            listed = self.check(self.listed("clinrad", "received"), 200).body
            self.assertNotIn(m, [item["id"] for item in listed["items"]])
            self.assertEqual(listed["pending"], 0)
        finally:
            self.role_mapping("clinrad", "radiologist", present=True)
            self.stack.tokens.pop("clinrad", None)

    def test_cr_e2e_05_request_id_replay_sequence_s_cr(self) -> None:
        """CR08: S-CR1..S-CR11 - every applied requestId answers its stored result; nothing else moves the ledger."""
        f = self.study()
        self.approved(f)
        r0, sent = self.send("doctor", f.uid, "clinician", 1)
        create = self.created(sent)["applied"]
        a1, acked = self.ack("clinician", r0)
        ack = self.created(acked)["applied"]
        settled = {"records": 1, "events": 2, "receipts": 2, "audits": 2}
        self.assertEqual(critical_ledger(f.uid), settled)
        again = self.created(self.send("doctor", f.uid, "clinician", 1, rid=r0)[1])                      # S-CR1
        self.assertEqual((again["replayed"], again["applied"]), (True, create))
        again = self.created(self.ack("clinician", r0, rid=a1)[1])                                       # S-CR2
        self.assertEqual((again["replayed"], again["applied"]), (True, ack))
        self.check(self.send("doctor", f.uid, "clinician", 1, message=MESSAGE + " other", rid=r0)[1], 409, "REQUEST_ID_REUSED")  # S-CR3
        self.check(self.cancel("doctor", r0, 1, rid=r0)[1], 409, "REQUEST_ID_REUSED")                  # S-CR4
        self.check(self.cancel("doctor", r0, 2)[1], 409, "CRITICAL_RESULT_ACKNOWLEDGED")                 # S-CR5
        self.check(self.ack("clinician", r0, 2)[1], 409, "CRITICAL_RESULT_ACKNOWLEDGED")                 # S-CR6
        self.check(self.ack("clinician2", r0, rid=a1)[1], 404, NOT_FOUND)                               # S-CR7
        self.forbidden(self.ack("hadmin", r0)[1], ROLE_REQUIRED)                                        # S-CR8
        self.role_mapping("clinician", "clinician", present=False)                                     # S-CR9
        self.stack.tokens.pop("clinician", None)
        try:
            self.forbidden(self.ack("clinician", r0, rid=a1)[1], ROLE_REQUIRED, "INSTITUTION_INVALID")
            again = self.created(self.send("doctor", f.uid, "clinician", 1, rid=r0)[1])                  # S-CR11
            self.assertEqual((again["replayed"], again["applied"]), (True, create))
        finally:
            self.role_mapping("clinician", "clinician", present=True)
            self.stack.tokens.pop("clinician", None)
        self.move(f.uid, "kin-center")                                                                 # S-CR10
        try:
            self.check(self.send("doctor", f.uid, "clinician", 1, rid=r0)[1], 404, "STUDY_NOT_FOUND")
        finally:
            self.move(f.uid, "hallym")
        self.assertEqual(critical_ledger(f.uid), settled)

    def test_cr_e2e_06_ack_cancel_race_single_winner(self) -> None:
        """CR09: S-RACE ten times - exactly one 201; the other gets the winner's terminal code; two events, receipts, audits."""
        f = self.study()
        self.approved(f)
        for round_ in range(10):
            record, sent = self.send("doctor", f.uid, "clinician", 1)
            self.created(sent)
            with ThreadPoolExecutor(max_workers=2) as pool:
                ack_future = pool.submit(lambda: self.ack("clinician", record)[1])
                cancel_future = pool.submit(lambda: self.cancel("doctor", record)[1])
                ack_result, cancel_result = ack_future.result(), cancel_future.result()
            self.assertEqual(sorted([ack_result.status, cancel_result.status]), [201, 409], f"round {round_}")
            winner, loser = (ack_result, cancel_result) if ack_result.status == 201 else (cancel_result, ack_result)
            state = winner.body["applied"]["to"]
            self.assertEqual(loser.body["code"], "CRITICAL_RESULT_ACKNOWLEDGED" if state == "acknowledged" else "CRITICAL_RESULT_CANCELLED")
            self.assertEqual(critical_row(record)["state"], state)
            counts = psql(f'SELECT (SELECT count(*) FROM "CriticalResultEvent" WHERE "recordId"={sql_text(record)})::text || \',\' || '
                          f'(SELECT count(*) FROM "CriticalResultReceipt" WHERE "recordId"={sql_text(record)})::text')
            self.assertEqual(counts, ["2,2"], f"round {round_}")
        self.assertEqual(critical_ledger(f.uid), {"records": 10, "events": 20, "receipts": 20, "audits": 20})

    def test_cr_e2e_07_revocation_token_window_and_keycloak_recheck(self) -> None:
        """CR06/CR18: a revoked recipient's old token still reads (I-10) but cannot ACK; a new token cannot read; every new
        write re-checks Keycloak; an applied requestId still replays."""
        f = self.study()
        self.approved(f)
        r1, sent = self.send("doctor", f.uid, "clinician", 1)
        self.created(sent)
        self.assertEqual(self.item("clinician", r1)["view"], "full")    # the token is cached from here on
        self.role_mapping("clinician", "clinician", present=False)
        try:
            self.assertIn(r1, self.ids(self.check(self.listed("clinician", "received"), 200)), "old token: reads until expiry")
            self.assertEqual(self.item("clinician", r1)["view"], "full")
            settled = critical_ledger(f.uid)
            self.forbidden(self.ack("clinician", r1)[1], ROLE_REQUIRED)
            self.assertEqual(critical_ledger(f.uid), settled)
            [row] = [item for item in self.check(self.listed("doctor", "sent"), 200).body["items"] if item["id"] == r1]
            self.assertEqual(row["delivery"], "not_eligible", "the sender sees the Keycloak state at once")
            self.stack.tokens.pop("clinician", None)
            self.forbidden(self.read("clinician", r1), "INSTITUTION_INVALID", ROLE_REQUIRED)
        finally:
            self.role_mapping("clinician", "clinician", present=True)
            self.stack.tokens.pop("clinician", None)
        # (a) a mixed recipient keeps technician: the recipient routes answer 403 by role
        r2, sent = self.send("doctor", f.uid, "clintech", 1)
        self.created(sent)
        self.role_mapping("clintech", "clinician", present=False)
        self.stack.tokens.pop("clintech", None)
        try:
            self.forbidden(self.listed("clintech", "received"), ROLE_REQUIRED)
            self.forbidden(self.read("clintech", r2), ROLE_REQUIRED)
            self.forbidden(self.ack("clintech", r2)[1], ROLE_REQUIRED)
        finally:
            self.role_mapping("clintech", "clinician", present=True)
            self.stack.tokens.pop("clintech", None)
        # a group change: the record stays with its institution and is hidden from the moved member
        r3, sent = self.send("doctor", f.uid, "clinician2", 1)
        self.created(sent)
        self.move_member("clinician2", "hallym", "kin-center")
        self.stack.tokens.pop("clinician2", None)
        self.owners.pop("clinician2", None)
        try:
            self.check(self.read("clinician2", r3), 404, NOT_FOUND)
            self.assertNotIn(r3, self.ids(self.check(self.listed("clinician2", "received"), 200)))
        finally:
            self.move_member("clinician2", "kin-center", "hallym")
            self.stack.tokens.pop("clinician2", None)
            self.owners.pop("clinician2", None)
        # CR18: disabled with a valid token - every new write is 403 and writes nothing; an applied requestId replays
        settled = critical_ledger(f.uid)
        self.enabled("doctor", False)
        try:
            self.forbidden(self.send("doctor", f.uid, "radx", 1)[1], ROLE_REQUIRED)
            self.forbidden(self.cancel("doctor", r2)[1], ROLE_REQUIRED)
            self.forbidden(self.supersede("doctor", r2, 1, 1)[1], ROLE_REQUIRED)
            self.assertTrue(self.created(self.send("doctor", f.uid, "clinician", 1, rid=r1)[1])["replayed"])
        finally:
            self.enabled("doctor", True)
        self.enabled("clinician2", False)
        try:
            self.forbidden(self.ack("clinician2", r3)[1], ROLE_REQUIRED)
        finally:
            self.enabled("clinician2", True)
        self.assertEqual(critical_ledger(f.uid), settled)
        self.created(self.ack("clinician2", r3)[1])

    def test_cr_e2e_08_identity_original_tags_plus_live_overlay(self) -> None:
        """CR19: the record copies the original tags; the display overlays today's Modify values (name, id)."""
        f = self.study()
        self.approved(f)
        r0, sent = self.send("doctor", f.uid, "clinician", 1)
        self.created(sent)
        original = "INVARIANT " + f.secret[len("REPORT-"):][:10]
        self.assertEqual((self.item("clinician", r0)["study"]["name"], self.item("clinician", r0)["study"]["id"]), (original, f.patient_id))
        self.check(self.commit(f.uid, "doctor", "reset", 1, reason="SYNTHETIC reset before Modify"), 201)
        self.check(self.stack.request("PATCH", f"/studies/{quote(f.uid)}", "tech",
                                      {"ov": {"name": "SYNTHETIC OVERLAY NAME", "id": "SYN-OV-ID"}}), 200)
        stub = self.item("clinician", r0)
        self.assertEqual((stub["view"], stub["study"]["name"], stub["study"]["id"]), ("stub", "SYNTHETIC OVERLAY NAME", "SYN-OV-ID"))
        self.text_free(stub, MESSAGE, f.secret)
        sender = self.item("doctor", r0)
        self.assertEqual((sender["study"]["name"], sender["study"]["id"]), ("SYNTHETIC OVERLAY NAME", "SYN-OV-ID"))
        row = critical_row(r0)
        self.assertEqual((row["origName"], row["origPatientId"]), (original, f.patient_id), "the stored copy stays the original")

    def test_cr_e2e_09_applied_write_survives_sender_access_loss(self) -> None:
        """CR22: the sender loses StudyAccess after an applied create: the replay is 404, the record stays readable and
        acknowledgeable, and once access returns the replay answers the stored result."""
        f = self.study()
        self.approved(f)
        r0, sent = self.send("doctor", f.uid, "clinician", 1)
        create = self.created(sent)["applied"]
        self.addCleanup(self.clear_access, "doctor")
        self.access("doctor", restricted("2.25.1"), 0)
        self.check(self.send("doctor", f.uid, "clinician", 1, rid=r0)[1], 404, "STUDY_NOT_FOUND")
        received = self.check(self.listed("clinician", "received"), 200)
        self.assertEqual((self.ids(received), received.body["pending"]), ([r0], 1))
        self.assertEqual(self.item("clinician", r0)["view"], "full")
        self.assertEqual(critical_ledger(f.uid), {"records": 1, "events": 1, "receipts": 1, "audits": 1})
        self.created(self.ack("clinician", r0)[1])
        self.access("doctor", UNRESTRICTED, 1)
        again = self.created(self.send("doctor", f.uid, "clinician", 1, rid=r0)[1])
        self.assertEqual((again["replayed"], again["applied"]), (True, create))
        self.assertEqual(critical_ledger(f.uid), {"records": 1, "events": 2, "receipts": 2, "audits": 2})
        [row] = [item for item in self.check(self.listed("doctor", "sent"), 200).body["items"] if item["id"] == r0]
        self.assertEqual(row["state"], "acknowledged")

    def test_cr_e2e_10_lists_pages_cursor_and_pending(self) -> None:
        """CR14: 51 records page as 50 + 1 by (createdAt, id) DESC; pending is the server's count; a StudyAccess revision
        change refuses an earlier cursor."""
        f = self.study()
        self.approved(f)
        records = []
        for n in range(51):
            record, sent = self.send("doctor", f.uid, "clinician", 1, message=f"SYNTHETIC page message {n}")
            self.created(sent)
            records.append(record)
            if n < 50:
                self.created(self.cancel("doctor", record)[1])
        first = self.check(self.listed("clinician", "received"), 200).body
        self.assertEqual((len(first["items"]), first["pending"]), (50, 1))
        self.assertIsNotNone(first["nextCursor"])
        second = self.check(self.listed("clinician", "received", cursor=first["nextCursor"]), 200).body
        self.assertEqual((len(second["items"]), second["nextCursor"], second["pending"]), (1, None, 1))
        seen = [item["id"] for item in first["items"] + second["items"]]
        self.assertEqual(sorted(seen), sorted(records))
        self.assertEqual(seen[0], records[-1], "newest first")
        self.assertEqual(self.ids(self.listed("clinician", "received", "pending")), [records[-1]])
        self.assertEqual(len(self.check(self.listed("clinician", "received", "cancelled"), 200).body["items"]), 50)
        sent_page = self.check(self.listed("doctor", "sent"), 200).body
        self.assertEqual((len(sent_page["items"]), sent_page["pending"]), (50, 1))
        self.addCleanup(self.clear_access, "doctor")
        self.access("doctor", UNRESTRICTED, 0)
        self.check(self.listed("doctor", "sent", cursor=sent_page["nextCursor"]), 400, "CRITICAL_RESULT_INPUT_INVALID")
        for bad in ("not base64!", "e30", "x" * 300):
            self.check(self.listed("clinician", "received", cursor=bad), 400, "CRITICAL_RESULT_INPUT_INVALID")
        for query in ("view=inbox", "view=received&state=open", "view=received&extra=1", ""):
            self.check(self.stack.request("GET", "/critical-results?" + query, "clinician"), 400, "CRITICAL_RESULT_INPUT_INVALID")

    def test_cr_e2e_11_candidates_follow_the_create_rules(self) -> None:
        """CR17: every candidate the server offers is accepted by create; the sender, other institutions, readers outside
        the P pair and clinicians of an unsigned head are never offered."""
        f = self.study()
        self.approved(f)
        body = self.check(self.candidates("doctor", f.uid), 200).body
        self.assertEqual((body["sendable"], body["reason"], body["source"]["version"], body["source"]["final"]), (True, None, 1, True))
        offered = {row["sub"]: row["role"] for row in body["recipients"]}
        owned = {self.sub(name): name for name, _roles, group in IDENTITIES if group == "hallym"}
        owned.update({self.sub("doctor2"): "doctor2", self.sub("jmryu"): "jmryu"})
        for sub, name in owned.items():
            if name == "hadmin":
                self.assertNotIn(sub, offered, name)
            else:
                self.assertIn(sub, offered, name)
        for name in ("doctor", "tech", "kdoctor", "kclinician", "ktech"):
            self.assertNotIn(self.sub(name), offered, name)
        self.assertEqual(offered[self.sub("clinrad")], "radiologist")
        self.assertEqual(offered[self.sub("clintech")], "clinician")
        for sub, name in owned.items():
            if sub in offered:
                self.created(self.send("doctor", f.uid, name, 1)[1])
        g = self.study()
        self.check(self.commit(g.uid, "doctor", "preliminary", 0, reviewer=self.stack.actor("doctor2"), findings="SYNTHETIC p"), 201)
        pair = self.check(self.candidates("doctor", g.uid), 200).body
        self.assertIn(self.sub("doctor2"), {row["sub"] for row in pair["recipients"]})
        for name in ("clinician", "clintech", "clinrad", "radx", "radz", "jmryu"):
            self.assertNotIn(self.sub(name), {row["sub"] for row in pair["recipients"]}, name)
        outside = self.check(self.candidates("radz", g.uid), 200).body
        self.assertEqual((outside["sendable"], outside["reason"], outside["source"], outside["recipients"]),
                         (False, "SOURCE_FORBIDDEN", None, []))


if __name__ == "__main__":
    unittest.main(verbosity=2)
