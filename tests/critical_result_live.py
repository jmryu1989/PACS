# coding: utf-8
"""S7-U1c critical results on tele studies, on the real Nest guard and service, PostgreSQL, Keycloak and Orthanc.

REQ-S7-U1c-TELE / REQ-S7-U1c-SCHEMA-BRANCH (A: both record-time institutions, no migration)
  -> RISK-S7-U1c-TELE-WIDENING / RISK-S7-U1c-AFTER-CLOSE / RISK-S7-U1c-AUDIT-SIDES (+ RISK-S7-CVR-WRONG-RECIPIENT,
     RISK-S7-CVR-COUNT-LEAK, RISK-S7-CVR-PROXY-ACK)
  -> TEST-S7-U1c-LIVE TL01..TL05. The rule tables are the S7-U1c diagnosis's scenario rows (OP-4 a: the contract
     supplement): TS (sending while the channel is open), TR (boundaries), TC (the channel closing), TO (a reopened channel)
     and TA (the audit sides). Every rule also has a service case in tests/critical_result_service_test.cjs (PR CI); this
     module holds what only a stack shows: the guard and the tokens, the real TS transition of the receiving institution's
     approve, the channel opened and closed by the product's own PATCH /studies/:uid, and GET audit on both institutions.

A = hallym (the owner: doctor, doctor2, clinician, clinician2), B = kin-center (the tele receiver: kdoctor, kclinician).
The synthetic stack has two institutions only, so the third institution Z is kin-center on a study whose channel is not
open to it (the S7-U3a precedent, tests/e2e/test_reader_assignment.py). A channel is opened and closed either with psql
(CriticalResultHarness.move, the operational correction a completed TS leaves as the only way to close, F-05) or with the
owner's PATCH {ts:'wait', teleTo} / {ts:'cancelled'} (the product path, which S7-U3a closes in the same transaction).

Synthetic stack only, through scripts/run-tests.py (LiveStack refuses any other entry), once per candidate (D-S7-12 a):

    python scripts/run-tests.py --module tests/critical_result_live.py --class CriticalResultTeleLiveTests --mode live --unit s7-u1c-critical-result-live --timeout 900

Owned data only: run-created Keycloak users (kin-test-*), the realm role `clinician` only when this run had to create it,
one synthetic C-STORE study per case, and on those studies the critical result rows, receipts and audit rows, the report
versions the cases commit, and the closed S7-U3a reader assignment rows a product close writes (changedBy is this run's
account). Every case removes its critical result and reader assignment rows before the study cleanup, and a case that
moves a study's owner or channel with psql moves it back in a finally block.
"""
from __future__ import annotations

import json
import sys
import unittest
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parent))
from invariants_live import (  # noqa: E402
    CRITICAL_AUDIT_ACTION, CRITICAL_STUDY_UID, CriticalResultHarness, Fixture, LiveStack, critical_ledger, critical_row,
    drop_critical_results, ensure_clinician_role, psql, sql_text,
)

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

IDENTITIES = (("clinician", ["clinician"], "hallym"), ("clinician2", ["clinician"], "hallym"),
              ("kclinician", ["clinician"], "kin-center"))
NOT_FOUND, STUDY_NOT_FOUND = "CRITICAL_RESULT_NOT_FOUND", "STUDY_NOT_FOUND"
SOURCE_CHANGED, SOURCE_MOVED = "CRITICAL_RESULT_SOURCE_CHANGED", "CRITICAL_RESULT_SOURCE_MOVED"
AUDIT_KEYS = ["event", "from", "id", "institution", "recipient", "replacedBy", "requestId", "revision", "role", "senderInstitution",
              "source", "supersedes", "to"]


def critical_audits(uid: str) -> list[dict[str, Any]]:
    """The study.critical-result audit rows of one run-owned study, oldest first, with their detail parsed."""
    if not CRITICAL_STUDY_UID.fullmatch(uid):
        raise RuntimeError(f"refusing an audit read for an abnormal UID: {uid}")
    rows = [json.loads(raw) for raw in psql(f'SELECT to_jsonb(t)::text FROM "AuditLog" t WHERE target={sql_text(uid)} '
                                            f'AND action={sql_text(CRITICAL_AUDIT_ACTION)} ORDER BY id')]
    return [{**row, "detail": json.loads(row["detail"])} for row in rows]


def study_state(uid: str) -> dict[str, Any]:
    if not CRITICAL_STUDY_UID.fullmatch(uid):
        raise RuntimeError(f"refusing a study read for an abnormal UID: {uid}")
    [raw] = psql(f'SELECT to_jsonb(t)::text FROM (SELECT "institutionId", "teleInstitutionId", ts, rs FROM "StudyState" '
                 f'WHERE uid={sql_text(uid)}) t')
    return json.loads(raw)


class CriticalResultTeleLiveTests(CriticalResultHarness, unittest.TestCase):
    maxDiff = None

    @classmethod
    def setUpClass(cls) -> None:
        cls.stack = LiveStack()
        cls.owners = {}
        cls.created_role = False
        cls.addClassCleanup(cls.stack.cleanup_test_identities)
        cls.addClassCleanup(cls.stack.cleanup_all)
        cls.addClassCleanup(cls.drop_all_owned_rows)
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
    def drop_all_owned_rows(cls) -> None:
        # Safety net before LiveStack.cleanup_all: a failed per-case cleanup must not leave the study delete refused.
        for uid in list(cls.stack.active):
            drop_critical_results(uid, set(cls.stack.user_ids.values()))
            cls.drop_reader_assignments(uid)

    @classmethod
    def drop_reader_assignments(cls, uid: str) -> None:
        """The closed S7-U3a rows a product channel close wrote on this run's study; a row another actor changed stops it."""
        if not CRITICAL_STUDY_UID.fullmatch(uid):
            raise RuntimeError(f"refusing reader assignment cleanup for an abnormal UID: {uid}")
        actors = {cls.stack.actor(user) for user in ("doctor", "doctor2", "kdoctor", "tech", "ktech", "jmryu")}
        for raw in psql(f'SELECT to_jsonb(t)::text FROM "ReaderAssignment" t WHERE "studyUid"={sql_text(uid)}'):
            if json.loads(raw).get("changedBy") not in actors:
                raise RuntimeError("refusing to delete a reader assignment row this run did not write")
            if psql(f'DELETE FROM "ReaderAssignment" t WHERE to_jsonb(t)={sql_text(raw)}::jsonb RETURNING 1') != ["1"]:
                raise RuntimeError("reader assignment cleanup failed")

    # ── helpers ──

    def study(self) -> Fixture:
        fixture = self.stack.create_fixture()
        self.addCleanup(self.stack.cleanup_fixture, fixture.uid)
        self.addCleanup(drop_critical_results, fixture.uid, set(self.stack.user_ids.values()))
        self.addCleanup(self.drop_reader_assignments, fixture.uid)
        return fixture

    def channel(self, uid: str, body: dict[str, Any], status: int = 200) -> Any:
        """The owner's PATCH /studies/:uid, the product path that opens ({ts:'wait', teleTo}) and closes ({ts:'cancelled'})."""
        return self.check(self.stack.request("PATCH", f"/studies/{quote(uid)}", "doctor", body), status).body

    def sent(self, user: str) -> dict[str, Any]:
        return self.check(self.listed(user, "sent"), 200).body

    def item(self, user: str, record: str) -> dict[str, Any]:
        return self.check(self.read(user, record), 200).body["item"]

    def pinned(self, uid: str, version: int) -> dict[str, Any]:
        rows = self.check(self.stack.request("GET", f"/studies/{quote(uid)}/report/versions", "doctor"), 200).body
        [row] = [row for row in rows if row["version"] == version]
        return {key: row[key] for key in ("findings", "conclusion", "recommendation")}

    def audit_actions(self, uid: str, user: str) -> list[str]:
        return [row["action"] for row in self.check(self.stack.request("GET", f"/audit?uid={quote(uid)}", user), 200).body]

    def kin_center_subs(self) -> set[str]:
        return {self.sub("kdoctor"), self.sub("kclinician")}

    # ── cases ──

    def test_tl01_send_while_open_both_institutions_audit_sides_and_the_close(self) -> None:
        """TS-01..TS-03, TA-02, TC-01, TA-04: B approves (TS completed), sends to A's clinicians, A acknowledges one; both
        institution columns and audit sides; GET audit is owner-only; after a psql close B loses everything, A keeps it."""
        f = self.study()
        self.move(f.uid, "hallym", tele="kin-center")
        try:
            self.check(self.commit(f.uid, "kdoctor", "approve", 0, findings="SYNTHETIC tele approved " + f.secret), 201)
            self.assertEqual(study_state(f.uid)["ts"], "completed", "the receiving institution's approve completes TS (F-05)")
            candidates = self.check(self.candidates("kdoctor", f.uid), 200).body
            self.assertEqual((candidates["sendable"], candidates["source"]["version"]), (True, 1))
            subs = {row["sub"] for row in candidates["recipients"]}
            self.assertIn(self.sub("clinician"), subs)
            self.assertFalse(subs & self.kin_center_subs(), "A's members only")
            r1, sent1 = self.send("kdoctor", f.uid, "clinician", 1)
            self.check(sent1, 201)
            r2, sent2 = self.send("kdoctor", f.uid, "clinician2", 1)
            self.check(sent2, 201)
            for rid in (r1, r2):
                row = critical_row(rid)
                self.assertEqual((row["institutionId"], row["senderInstitutionId"], row["senderSub"]), ("hallym", "kin-center", self.sub("kdoctor")))
            received = self.check(self.listed("clinician", "received"), 200).body
            self.assertEqual((self.ids_of(received), received["pending"]), ([r1], 1))
            item = self.item("clinician", r1)
            self.assertEqual((item["view"], item["body"]), ("full", self.pinned(f.uid, 1)))
            self.check(self.ack("clinician", r1)[1], 201)
            open_list = self.sent("kdoctor")
            self.assertEqual(open_list, self.sent("kdoctor"), "reading the sent list twice changes nothing")
            states = {row["id"]: row["state"] for row in open_list["items"]}
            self.assertEqual(({key: states[key] for key in (r1, r2)}, open_list["pending"]), ({r1: "acknowledged", r2: "created"}, 1))
            ledger = critical_ledger(f.uid)
            self.assertEqual(ledger, {"records": 2, "events": 3, "receipts": 3, "audits": 3})
            # GET audit: the owner sees the rows; B sees the study's other rows without them (OP-2 a)
            self.assertEqual(self.audit_actions(f.uid, "doctor").count(CRITICAL_AUDIT_ACTION), 3)
            tele_actions = self.audit_actions(f.uid, "kdoctor")
            self.assertEqual(tele_actions.count(CRITICAL_AUDIT_ACTION), 0)
            self.assertTrue(any(action != CRITICAL_AUDIT_ACTION for action in tele_actions), "B still sees its other rows")
            # TC-01: an operational correction closes the completed channel
            self.move(f.uid, "hallym")
            for rid in (r1, r2):
                self.check(self.read("kdoctor", rid), 404, NOT_FOUND)
            closed = self.sent("kdoctor")
            self.assertEqual(([row["id"] for row in closed["items"] if row["id"] in (r1, r2)], closed["pending"]), ([], 0))
            for result in (self.for_study("kdoctor", f.uid), self.candidates("kdoctor", f.uid), self.send("kdoctor", f.uid, "doctor2", 1)[1],
                           self.send("kdoctor", f.uid, "clinician2", 1, rid=r2)[1]):
                self.check(result, 404, STUDY_NOT_FOUND)
            self.check(self.cancel("kdoctor", r2)[1], 404, NOT_FOUND)
            self.check(self.supersede("kdoctor", r2, 1, 1)[1], 404, NOT_FOUND)
            self.check(self.stack.request("GET", f"/audit?uid={quote(f.uid)}", "kdoctor"), 404)
            self.assertEqual(critical_ledger(f.uid), ledger, "the close and every refusal write nothing")
            # A keeps both records: R1 acknowledged, R2 pending and acknowledged now
            self.assertEqual(self.item("clinician", r1)["state"], "acknowledged")
            self.assertEqual(self.check(self.listed("clinician2", "received"), 200).body["pending"], 1)
            self.check(self.ack("clinician2", r2)[1], 201)
            self.assertEqual({rid: (critical_row(rid)["institutionId"], critical_row(rid)["senderInstitutionId"]) for rid in (r1, r2)},
                             {r1: ("hallym", "kin-center"), r2: ("hallym", "kin-center")})
            self.assertEqual(critical_ledger(f.uid), {"records": 2, "events": 4, "receipts": 4, "audits": 4})
        finally:
            self.move(f.uid, "hallym")

    def test_tl02_product_close_leaves_records_alone_and_ends_b(self) -> None:
        """TS-04, TC-02: opened and closed by the owner's PATCH; B's unsigned source reaches an A radiologist only; the close
        writes no critical result row, the record stays pending for A, and B loses it."""
        f = self.study()
        self.assertEqual(self.channel(f.uid, {"ts": "wait", "teleTo": "kin-center"})["teleInstitutionId"], "kin-center")
        self.check(self.commit(f.uid, "kdoctor", "save", 0, findings="SYNTHETIC tele saved " + f.secret), 201)
        self.check(self.send("kdoctor", f.uid, "clinician", 1)[1], 409, "CRITICAL_RESULT_RECIPIENT_CANNOT_READ")
        rx, sent = self.send("kdoctor", f.uid, "doctor2", 1)
        self.check(sent, 201)
        before, audits = critical_ledger(f.uid), critical_audits(f.uid)
        self.assertIsNone(self.channel(f.uid, {"ts": "cancelled"})["teleInstitutionId"])
        self.assertEqual((critical_ledger(f.uid), critical_audits(f.uid), critical_row(rx)["state"]), (before, audits, "created"),
                         "the close writes no critical result row and changes no record")
        self.check(self.read("kdoctor", rx), 404, NOT_FOUND)
        self.assertNotIn(rx, [row["id"] for row in self.sent("kdoctor")["items"]])
        self.check(self.for_study("kdoctor", f.uid), 404, STUDY_NOT_FOUND)
        self.check(self.cancel("kdoctor", rx)[1], 404, NOT_FOUND)
        item = self.item("doctor2", rx)
        self.assertEqual((item["view"], item["body"]), ("full", self.pinned(f.uid, 1)))
        self.check(self.ack("doctor2", rx)[1], 201)

    def test_tl03_source_moves_supersede_and_cancel_keep_both_institutions(self) -> None:
        """TS-12, TS-13, TV-01, TA-01: A's addendum moves the head; A's clinician gets a stub and cannot acknowledge; B's
        supersede pins A's addendum and keeps both institutions; B cancels another; every audit row names both sides."""
        f = self.study()
        self.move(f.uid, "hallym", tele="kin-center")
        try:
            self.check(self.commit(f.uid, "kdoctor", "approve", 0, findings="SYNTHETIC tele approved " + f.secret), 201)
            r1, sent1 = self.send("kdoctor", f.uid, "clinician", 1)
            self.check(sent1, 201)
            r2, sent2 = self.send("kdoctor", f.uid, "clinician2", 1)
            self.check(sent2, 201)
            self.check(self.commit(f.uid, "doctor", "addendum", 1, findings="SYNTHETIC owner addendum " + f.secret), 201)
            stub = self.item("clinician", r1)
            self.assertEqual((stub["view"], stub["source"], "message" in stub, "body" in stub),
                             ("stub", {"current": False, "reason": "head_moved"}, False, False))
            self.check(self.ack("clinician", r1)[1], 409, SOURCE_CHANGED)
            replacement, superseded = self.supersede("kdoctor", r1, 1, 2)
            self.check(superseded, 201)
            row = critical_row(replacement)
            self.assertEqual((row["institutionId"], row["senderInstitutionId"], row["sourceVersion"], row["sourceAuthor"], row["supersedesId"]),
                             ("hallym", "kin-center", 2, self.stack.actor("doctor"), r1))
            self.check(self.ack("clinician", replacement)[1], 201)
            self.check(self.cancel("kdoctor", r2)[1], 201)
            audits = critical_audits(f.uid)
            self.assertEqual([(row["detail"]["event"], row["detail"]["id"]) for row in audits],
                             [("created", r1), ("created", r2), ("superseded", r1), ("created", replacement), ("acknowledged", replacement),
                              ("cancelled", r2)])
            for audit in audits:
                self.assertEqual(sorted(audit["detail"]), AUDIT_KEYS)
                self.assertEqual((audit["detail"]["institution"], audit["detail"]["senderInstitution"]), ("hallym", "kin-center"))
            self.assertEqual({row["actor"] for row in audits}, {self.stack.actor("kdoctor"), self.stack.request("GET", "/me", "clinician").body["actor"]})
        finally:
            self.move(f.uid, "hallym")

    def test_tl04_reopened_channel_reads_by_class_and_late_requests_in_order(self) -> None:
        """TO-01..TO-03 (OP-3 a): the channel reopens only after a reset; B sees its records again; A's radiologist reads the
        pinned v1 in full, A's clinician a stub, both ACKs refused; B's late requests replay, PENDING_EXISTS, SOURCE_MOVED."""
        f = self.study()
        self.channel(f.uid, {"ts": "wait", "teleTo": "kin-center"})                                              # F-RO 1
        self.check(self.commit(f.uid, "kdoctor", "save", 0, findings="SYNTHETIC tele v1 " + f.secret), 201)     # v1, RS T
        rx, sent = self.send("kdoctor", f.uid, "doctor2", 1)                                                     # F-RO 2: R_X
        self.check(sent, 201)
        replay_body = self.check(sent, 201).body["applied"]
        self.check(self.commit(f.uid, "doctor", "approve", 1, findings="SYNTHETIC owner v2 " + f.secret), 201)  # v2, RS A
        self.assertEqual(study_state(f.uid)["ts"], "wait", "the owner's approve keeps TS")
        rc, sent_c = self.send("kdoctor", f.uid, "clinician", 2)                                                 # F-RO 3: R_C
        self.check(sent_c, 201)
        self.channel(f.uid, {"ts": "cancelled"})                                                                 # F-RO 4
        self.check(self.read("kdoctor", rx), 404, NOT_FOUND)
        self.channel(f.uid, {"ts": "wait", "teleTo": "kin-center"}, 400)                                        # TO-01: RS is not W
        self.check(self.commit(f.uid, "doctor", "reset", 2, reason="SYNTHETIC reset before reopening"), 201)    # discarded v3, reset v4
        self.channel(f.uid, {"ts": "wait", "teleTo": "kin-center"})                                              # F-RO 7: reopened
        l0 = {"records": 2, "events": 2, "receipts": 2, "audits": 2}
        self.assertEqual(critical_ledger(f.uid), l0)
        # TO-02: the counterexample pair in one reset state
        x = self.item("doctor2", rx)
        self.assertEqual((x["view"], x["source"]["version"], x["source"]["current"], x["source"]["reason"], x["body"]),
                         ("full", 1, False, "reset", self.pinned(f.uid, 1)))
        c = self.item("clinician", rc)
        self.assertEqual((c["view"], c["source"], "message" in c, "body" in c), ("stub", {"current": False, "reason": "reset"}, False, False))
        self.check(self.ack("doctor2", rx)[1], 409, SOURCE_CHANGED)
        self.check(self.ack("clinician", rc)[1], 409, SOURCE_CHANGED)
        listed = self.sent("kdoctor")
        by = {row["id"]: row for row in listed["items"]}
        self.assertEqual((by[rx]["delivery"], by[rc]["delivery"], listed["pending"]), ("readable", "stub", 2))
        self.assertEqual(critical_ledger(f.uid), l0)
        # TO-03: late requests prepared before the close, in this order
        replayed = self.check(self.send("kdoctor", f.uid, "doctor2", 1, rid=rx)[1], 201).body
        self.assertEqual((replayed["replayed"], replayed["applied"]), (True, replay_body))
        duplicate = self.check(self.send("kdoctor", f.uid, "doctor2", 1)[1], 409, "CRITICAL_RESULT_PENDING_EXISTS")
        self.assertEqual(duplicate.body.get("id"), rx)
        q3 = str(uuid.uuid4())
        self.assertEqual(psql(f'SELECT count(*) FROM "CriticalResultReceipt" WHERE "requestId"={sql_text(q3)}'), ["0"])
        self.assertEqual(psql(f'SELECT count(*) FROM "CriticalResult" WHERE "studyUid"={sql_text(f.uid)} AND "senderSub"='
                              f'{sql_text(self.sub("kdoctor"))} AND "recipientSub"={sql_text(self.sub("doctor"))} AND state=\'created\''), ["0"])
        self.check(self.send("kdoctor", f.uid, "doctor", 1, rid=q3)[1], 409, SOURCE_MOVED)
        self.check(self.supersede("kdoctor", rx, 1, 1)[1], 409, SOURCE_MOVED)
        self.assertEqual(critical_ledger(f.uid), l0)
        self.check(self.cancel("kdoctor", rx)[1], 201)
        self.assertEqual(critical_ledger(f.uid), {"records": 2, "events": 3, "receipts": 3, "audits": 3})
        self.channel(f.uid, {"ts": "cancelled"})

    def test_tl05_no_channel_is_the_unknown_study_answer(self) -> None:
        """TR-04, TR-05, TR-01 (the test_cr_inv_02 404s S7-U1c moved here): on a hallym study with no channel kin-center gets
        STUDY_NOT_FOUND on every UID route and GET audit; hallym cannot send to kin-center members."""
        g = self.study()
        self.approved_by_doctor(g)
        before = critical_ledger(g.uid)
        for result in (self.candidates("kdoctor", g.uid), self.send("kdoctor", g.uid, "doctor2", 1)[1], self.for_study("kdoctor", g.uid)):
            self.check(result, 404, STUDY_NOT_FOUND)
        self.check(self.stack.request("GET", f"/audit?uid={quote(g.uid)}", "kdoctor"), 404)
        for user in ("kdoctor", "kclinician"):
            self.check(self.send("doctor", g.uid, user, 1)[1], 400, "CRITICAL_RESULT_RECIPIENT_INVALID")
        self.assertFalse({row["sub"] for row in self.check(self.candidates("doctor", g.uid), 200).body["recipients"]} & self.kin_center_subs())
        self.assertEqual(critical_ledger(g.uid), before)

    def approved_by_doctor(self, fixture: Fixture) -> None:
        self.check(self.commit(fixture.uid, "doctor", "approve", 0, findings="SYNTHETIC approved findings " + fixture.secret), 201)

    @staticmethod
    def ids_of(body: dict[str, Any]) -> list[str]:
        return [item["id"] for item in body["items"]]


if __name__ == "__main__":
    unittest.main()
