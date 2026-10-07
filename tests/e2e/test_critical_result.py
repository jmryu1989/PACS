# coding: utf-8
"""S7-U1a critical result delivery on the real Nest guard and service, PostgreSQL, Keycloak and Orthanc (API level), and
S7-U2b the two critical result screens on the same kind of stack (browser, second class).

REQ-S7-U1a-SOURCE-PIN / REQ-S7-U1a-IDEMPOTENCY / REQ-S7-U1a-AUTHZ / REQ-S7-U1a-RECIPIENT-MATRIX / REQ-S7-U2a-EXPLICIT-ACK /
REQ-S7-U1p-IDENTITY / REQ-S7-U1p-WRITE-OUTCOME / REQ-S7-U2a-RECIPIENT-LIST
  -> RISK-S7-U1p-FALSE-ACK / RISK-S7-CVR-STALE-SOURCE / RISK-S7-U2a-BODY-SUBSTITUTE / RISK-S7-CVR-ACK-CANCEL-RACE /
     RISK-S7-CVR-REVOKED-ACK / RISK-S7-CVR-COUNT-LEAK / RISK-S7-U1p-STALE-IDENTITY / RISK-S7-U1p-FALSE-UNDELIVERED /
     RISK-S7-U1p-CLASS-WIDENING
  -> TEST-S7-U1a-LIVE (state-transition half; the case names follow contract S7-U1p section 2.3 CR03-CR09, CR14,
     CR17-CR20, CR22 and the section 7.1 sequences S-CR, S-SU, S-RS, S-RR, S-RACE). The role matrix, the institution and
     tele boundary, the DB constraints of the append-only ledger and the study delete refusal are the invariant class in
     tests/invariants_live.py. CriticalResultE2E has no browser.

REQ-S7-U2b-E2E / REQ-S7-U2a-EXPLICIT-ACK / REQ-S7-U2a-RECIPIENT-LIST / REQ-S7-U1b-SENDER-UI / REQ-S7-U1b-FAILURE /
REQ-S7-U1p-WRITE-OUTCOME
  -> RISK-S7-U2b-SELF-PROOF / RISK-S7-U1p-FALSE-ACK / RISK-S7-U1p-FALSE-UNDELIVERED / RISK-S7-CVR-WRONG-RECIPIENT /
     RISK-S7-CVR-ACK-CANCEL-RACE / RISK-S7-CVR-REVOKED-ACK / RISK-S7-U2a-BODY-SUBSTITUTE
  -> TEST-S7-U2b-E2E: CriticalResultScreensE2E drives the S7-U1b sender screen (main.html) and the S7-U2a recipient screen
     (clinician.html) of two identities in their own browser contexts. Every critical result write is a click on a screen; the
     API only sets up (report commits, Keycloak group moves) and reads back (psql, the session's own GETs), and a pure judge
     compares every checkpoint's screen with the server (design: the S7-U2b diagnosis, Astra S7-U2b-DIAG-E-R-001).

Synthetic stack only, through scripts/run-tests.py (LiveStack refuses any other entry), one class per run:

    python scripts/run-tests.py --module tests/e2e/test_critical_result.py --class CriticalResultE2E --mode live --unit s7-u1a-critical-result-e2e --timeout 2400
    python scripts/run-tests.py --module tests/e2e/test_critical_result.py --class CriticalResultScreensE2E --mode live --unit ci-s7-u2b-critical-result-screens --timeout 900

The second runs on a hosted runner only, through the dispatch-only Focused integration profile critical-result-screens
(tests/measurement_ci.py). The module's load_tests loads each class's own declared cases only, never the inherited
WorklistE2E cases.

Owned data only: run-created Keycloak users (kin-test-*), the realm role `clinician` only when this run had to create it,
one synthetic C-STORE study per case (two or three for S-RR), the critical result rows, receipts and audit rows written on
those studies, and SYNTHETIC StudyAccess policies on this run's `doctor`. Every case removes its critical result rows before
the study cleanup (all foreign keys RESTRICT). Cases that remove a Keycloak role, move a member's group, disable a member or
move a study's owner restore it in a finally block. Not proved here: withdrawing a clinician-only member's access per study
(study-access target() does not manage clinicians, decision D-S7-13 a) - CriticalResultScreensE2E records it as not_run data.
CriticalResultScreensE2E owns four more clinician-only identities (clinician, clinician2, clinician3, kclinician), one or two
synthetic studies per case, their critical result rows, and the evidence it writes below
tests/e2e/artifacts/critical-result-screens-ci/evidence/; it moves clinician3's group in CRS-02 and moves it back in a finally
block.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, urlencode, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from invariants_live import (  # noqa: E402
    ROOT, CriticalResultHarness, Fixture, HttpResult, LiveStack, critical_ledger, critical_row, drop_critical_results,
    ensure_clinician_role, past_audit_guard, psql, sql_text,
)
import measurement_ci  # noqa: E402
# The module, never its classes: a TestCase name imported here would join a class-less run (scripts/run-tests.py refuses
# that plan as "Discovery included an imported TestCase").
import test_worklist as base  # noqa: E402
from playwright.sync_api import Error as PlaywrightError, TimeoutError as PlaywrightTimeout, expect  # noqa: E402
from document_session import document_request

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


class KeycloakGroups:
    """Keycloak institution group moves of a run identity, shared by both classes (setup API, never a critical result write)."""
    stack: LiveStack

    def group_of(self, name: str) -> str:
        found = self.stack.kc_admin("GET", "/groups?search=" + quote(name))
        [group] = [row for row in found.body if row.get("name") == name]
        return group["id"]

    def move_member(self, logical: str, source: str, target: str) -> None:
        sub = self.sub(logical)
        current = self.stack.member_rights[sub]
        self.stack.set_member_rights(sub, institution=target, roles=current["roles"], enabled=True, verificationOverride=True)
        self.stack.token(logical)  # A new authentication, never reuse the pre-Change token.



class CriticalResultE2E(KeycloakGroups, CriticalResultHarness, unittest.TestCase):
    maxDiff = None

    @classmethod
    def setUpClass(cls) -> None:
        cls.stack = LiveStack()
        base.require_local_targets(cls.stack)
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
        sub = self.sub(logical)
        current = self.stack.member_rights[sub]
        saved = self.__dict__.setdefault("_role_institutions", {})
        if current["institution"]:
            saved[sub] = current["institution"]
        roles = sorted((set(current["roles"]) | {role_name}) if present else (set(current["roles"]) - {role_name}))
        if roles:
            self.stack.set_member_rights(sub, institution=saved[sub], roles=roles, enabled=True, verificationOverride=True)
        else:
            self.stack.set_member_rights(sub, approvalState="PENDING")

    def enabled(self, logical: str, value: bool) -> None:
        old = self.stack.token(logical) if not value else None
        self.stack.set_member_rights(self.sub(logical), enabled=value)
        if old:
            self.stack.tokens[logical] = old  # Deliberately exercise the member's retained pre-Suspend credential.

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
            self.assertEqual(psql(past_audit_guard(f'DELETE FROM "AuditLog" t WHERE to_jsonb(t)={sql_text(raw)}::jsonb RETURNING 1')),
                             ["1"])

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
            self.stack.token("clinician", refused=True)          # a new token of a member left without a KIN role
            self.check(self.stack.request("GET", "/me", "clinician"), 401, "AUTH_SESSION_ENDED")
            self.check(self.ack("clinician", r0, rid=a1)[1], 401, "AUTH_SESSION_ENDED")
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
        old = self.stack.token("clinician")
        self.role_mapping("clinician", "clinician", present=False)
        self.stack.tokens["clinician"] = old
        try:
            self.check(self.listed("clinician", "received"), 401, "AUTH_SESSION_ENDED")
            self.check(self.read("clinician", r1), 401, "AUTH_SESSION_ENDED")
            settled = critical_ledger(f.uid)
            self.check(self.ack("clinician", r1)[1], 401, "AUTH_SESSION_ENDED")
            self.assertEqual(critical_ledger(f.uid), settled)
            [row] = [item for item in self.check(self.listed("doctor", "sent"), 200).body["items"] if item["id"] == r1]
            self.assertEqual(row["id"], r1, "the sender keeps the original record; roster delivery is not the access authority")
            self.stack.tokens.pop("clinician", None)
            self.stack.token("clinician", refused=True)
            self.check(self.stack.request("GET", "/me", "clinician"), 401, "AUTH_SESSION_ENDED")
            self.check(self.read("clinician", r1), 401, "AUTH_SESSION_ENDED")
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
            self.check(self.send("doctor", f.uid, "radx", 1)[1], 401, "AUTH_SESSION_ENDED")
            self.check(self.cancel("doctor", r2)[1], 401, "AUTH_SESSION_ENDED")
            self.check(self.supersede("doctor", r2, 1, 1)[1], 401, "AUTH_SESSION_ENDED")
            self.check(self.send("doctor", f.uid, "clinician", 1, rid=r1)[1], 401, "AUTH_SESSION_ENDED")
        finally:
            self.enabled("doctor", True)
        self.owner("clinician2")     # CR18's valid token is taken while enabled: Keycloak grants a disabled account none
        self.enabled("clinician2", False)
        try:
            self.check(self.ack("clinician2", r3)[1], 401, "AUTH_SESSION_ENDED")
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


# ═══ S7-U2b: the sender (main.html) and recipient (clinician.html) screens against the real server ═══
# Case ids (CRS-01..06), step ids (S-01, L-01b, ...), variant ids (RF-*, MU-*, JV-*), keys K1-K5, rules U1-U4, tables
# D/LA/SL/SD and the control windows W-S/W-P are those of the S7-U2b diagnosis (scenario-table.md, test-plan.md 2-7).

SCREENS_EVIDENCE = measurement_ci.PROFILES["critical-result-screens"]["out"] / "evidence"
SCREEN_IDENTITIES = (("clinician", "hallym"), ("clinician2", "hallym"), ("clinician3", "hallym"), ("kclinician", "kin-center"))
CLINICIAN_ONLY = frozenset(name for name, _ in SCREEN_IDENTITIES)
API_WRITE_REFUSED = "harness: CriticalResultScreensE2E writes critical results only by clicks on a screen (scenario I-03)"
# Contract S7-U1p section 6.1 routes #1-#8 by method and path: handlers choose requests by this shape only, never by which
# product trigger (period, Refresh, a write's follow-up read) sent them (test-plan 6.4 rule 6).
ROUTE_FORMS = (
    ("#1", "GET", re.compile(r"/api/studies/([0-9.]+)/critical-result-recipients")),
    ("#2", "POST", re.compile(r"/api/studies/([0-9.]+)/critical-results")),
    ("#5", "GET", re.compile(r"/api/studies/([0-9.]+)/critical-results")),
    ("#3", "GET", re.compile(r"/api/critical-results()")),
    ("#4", "GET", re.compile(r"/api/critical-results/([0-9A-Fa-f-]{36})")),
    ("#6", "POST", re.compile(r"/api/critical-results/([0-9A-Fa-f-]{36})/ack")),
    ("#7", "POST", re.compile(r"/api/critical-results/([0-9A-Fa-f-]{36})/cancel")),
    ("#8", "POST", re.compile(r"/api/critical-results/([0-9A-Fa-f-]{36})/supersede")),
)
WRITE_ROUTES = frozenset(("#2", "#6", "#7", "#8"))
WRITE_ACTION = {"#2": "create", "#6": "ack", "#7": "cancel", "#8": "supersede"}
# Contract section 16 names. They are what is judged, so they never tell which record an observation is (test-plan 6.1.1).
ROW_WORDS = ("Pending ACK", "Source Changed", "Acknowledged", "Cancelled", "Superseded")
LINE_WORDS = ("Acknowledgement status unknown", "Acknowledged", "Cancelled", "Superseded")
SEND_WORDS = ("Delivered", "Not delivered", "Delivery status unknown", "Cancelled", "Not cancelled", "Cancellation status unknown")
SENT_WORDS = ("Pending ACK", "Acknowledged", "Cancelled", "Superseded")
MARK_WORDS = ("Source Changed", "Recipient Not Eligible", "Status Unknown")
STATE_NAME = {"created": "Pending ACK", "acknowledged": "Acknowledged", "cancelled": "Cancelled", "superseded": "Superseded"}
# Contract sentences (sections 16.1, 16.2). A refusal's reason, which the contract leaves open, is only checked as Korean text
# next to the server's code.
DELIVERED_TEXT = "전달 기록이 저장되었습니다. 수신자가 확인(Acknowledge)하면 Acknowledged로 바뀝니다."
UNKNOWN_TEXT = "요청이 서버에 적용되었는지 확인하지 못했습니다. 전달되었을 수 있습니다."
ACK_UNKNOWN_TEXT = "확인이 저장되었는지 확인하지 못했습니다."
STUB_TEXT = "판독이 바뀌어 발신자의 대체 또는 취소를 기다립니다. 확인할 수 없습니다."
SOURCE_MARK_TEXT = "판독이 바뀌어 수신자가 확인할 수 없습니다. 새 판으로 대체하거나 취소하세요."
NOT_ELIGIBLE_TEXT = ("수신자가 지금 이 전달을 볼 수 없습니다(수신자의 역할·기관·검사 접근이 바뀌었거나, 판독의 역할을 잃어 서명 전 판을 "
                     "더는 읽을 수 없음). 확인할 수 없으니 취소하고 다른 사람에게 보내세요.")
# Contract section 8.1: a first request's answers that are a definite refusal. Every other answer (none, 409
# STUDY_ACCESS_CHANGED, a 503 without code, CRITICAL_RESULT_BUSY, other statuses or codes) leaves the outcome unknown.
REFUSED = {
    400: {"CRITICAL_RESULT_INPUT_INVALID", "CRITICAL_RESULT_RECIPIENT_INVALID"},
    403: {"CRITICAL_RESULT_ROLE_REQUIRED", "CRITICAL_RESULT_SOURCE_FORBIDDEN", "INSTITUTION_PENDING", "INSTITUTION_INVALID",
          "GATEWAY_IDENTITY_INVALID", "CLINICIAN_ROUTE_DENIED"},
    404: {"STUDY_NOT_FOUND", "CRITICAL_RESULT_NOT_FOUND"},
    409: {"OWNER_CHANGED", "REQUEST_ID_REUSED", "CRITICAL_RESULT_ACKNOWLEDGED", "CRITICAL_RESULT_CANCELLED",
          "CRITICAL_RESULT_SUPERSEDED", "CRITICAL_RESULT_PENDING_EXISTS", "CRITICAL_RESULT_CHANGED",
          "CRITICAL_RESULT_SOURCE_MOVED", "CRITICAL_RESULT_SOURCE_INVALID", "CRITICAL_RESULT_SOURCE_CHANGED",
          "CRITICAL_RESULT_RECIPIENT_CANNOT_READ"},
    503: {"CRITICAL_RESULT_UNAVAILABLE"},
}
# test-plan 6.2: the judge's nine problem names and the failure class (section 5) an unplanned one gets.
PROBLEM_KIND = {"ack-not-on-server": "screen", "delivered-not-on-server": "screen", "row-not-for-session": "screen",
                "badge-not-server": "screen", "acknowledge-offered-off-c2": "screen", "stub-shows-content": "screen",
                "state-word-mismatch": "screen", "write-not-from-page": "server", "actor-mismatch": "server"}
FAILURE_KINDS = ("harness", "screen", "server", "infra")
HANGUL = re.compile("[가-힣]")
JWT_SHAPE = re.compile(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+")
BADGE = re.compile(r"Pending ACK \d+")
AUTHENTICATED_PAGES = ("/worklist/hpacs-lite/main.html", "/worklist/hpacs-lite/clinician.html")


def route_of(method: str, path: str) -> tuple[str, str | None] | None:
    """The contract route (#1-#8) of one request and the study UID or record id its path names."""
    for number, verb, form in ROUTE_FORMS:
        found = form.fullmatch(path)
        if found and verb == method:
            return number, (found.group(1).lower() or None)
    return None


def cvr_url(url: str) -> bool:
    """Any critical result route, any method: the one URL predicate every handler of this class is registered with."""
    path = urlsplit(url).path
    return any(form.fullmatch(path) for _, _, form in ROUTE_FORMS)


def view_of(entry: dict) -> str | None:
    return ((entry.get("query") or {}).get("view") or [None])[0]


def words(text: str, vocabulary: tuple[str, ...]) -> list[str]:
    """Every word of `vocabulary` shown in `text` as a whole word, so the button `Acknowledge` never reads as `Acknowledged`."""
    found: list[str] = []
    for word in vocabulary:
        found += [word] * len(re.findall(r"(?<![A-Za-z])" + re.escape(word) + r"(?![A-Za-z])", text))
    return sorted(found)


def names(actor: str, text: str) -> bool:
    """`text` names this account (its email) as a whole token: `doctor@x` is not inside `kin-test-1a2b-doctor@x`."""
    return re.search(r"(?<![\w@.+-])" + re.escape(actor) + r"(?![\w@.+-])", text) is not None


def ack_times(text: str) -> list[str]:
    return re.findall(r"(?<![A-Za-z])Acknowledged (\d{4}-\d{2}-\d{2} \d{2}:\d{2})", text)


def minute(value: Any) -> str:
    """A server ISO time the way a row shows it (principle 5): its date and hours:minutes in the browser's time zone, which
    is the runner's own."""
    return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone().strftime("%Y-%m-%d %H:%M")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def answered(entry: dict) -> bool:
    return entry.get("state") == "answered" and isinstance(entry.get("status"), int)


def body_of(entry: dict) -> dict:
    try:
        value = json.loads(entry.get("body") or "null")
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def request_id(entry: dict) -> str:
    return str(body_of(entry).get("requestId") or "").lower()


def key_of(item: Any) -> str:
    return str(item.get("id") or "").lower() if isinstance(item, dict) else ""


def items_of(entry: dict | None) -> list[dict]:
    """The records a read answer carried: #3/#5 items, #4 item."""
    data = (entry or {}).get("json")
    if not isinstance(data, dict):
        return []
    if entry["route"] == "#4":
        return [data["item"]] if isinstance(data.get("item"), dict) else []
    return [item for item in data.get("items") or [] if isinstance(item, dict)]


def classify(entry: dict) -> str:
    """Contract 8.1 for one write's own answer: 'none' (no answer), 'created' (201), 'refused' (definite), 'unsure'."""
    if not answered(entry):
        return "none"
    if entry["status"] == 201:
        return "created"
    data = entry.get("json")
    code = data.get("code") if isinstance(data, dict) else None
    return "refused" if code in REFUSED.get(entry["status"], ()) else "unsure"


def applied_write(entry: dict, owner: list, request: str, target: str | None = None) -> bool:
    """The page received this very request's own 201 envelope (contract 3.4, 8.1 rule 4 (a)) - owner, requestId, action and
    record all match. Another request's envelope proves nothing about this one."""
    data = entry.get("json") if classify(entry) == "created" else None
    applied = data.get("applied") if isinstance(data, dict) else None
    if not isinstance(applied, dict) or data.get("owner") != owner or str(applied.get("requestId") or "").lower() != request:
        return False
    if applied.get("action") != WRITE_ACTION[entry["route"]]:
        return False
    record = key_of(applied)
    if entry["route"] == "#2":
        return record == request
    if entry["route"] == "#8":
        return record == target and key_of(applied.get("replacement")) == request
    return record == target


def confirmed_ack(net: list[dict], record: str, owner: list) -> str | None:
    """w(r), test-plan 6.1: the server time of this page's confirmed ACK of `record` - its own matching 201, or a #4 of the
    record reading acknowledged that the page received after its ACK POST - or None. A fabricated 201 is a received answer too."""
    posts = [entry for entry in net if entry["route"] == "#6" and entry["target"] == record]
    if not posts:
        return None
    at = None
    for entry in posts:
        if applied_write(entry, owner, request_id(entry), record):
            at = entry["json"]["applied"].get("at")
    first = min(entry["n"] for entry in posts)
    for entry in net:
        if entry["route"] == "#4" and entry["target"] == record and entry["n"] > first and answered(entry) and entry["status"] == 200:
            for item in items_of(entry):
                if item.get("state") == "acknowledged" and at is None:
                    at = item.get("acknowledgedAt")
    return at


def ack_exchange(net: list[dict], record: str, owner: list) -> tuple:
    """x(r) and table LA (test-plan 6.3): what this page's own ACK exchange for `record` lets its result line show."""
    posts = sorted((entry for entry in net if entry["route"] == "#6" and entry["target"] == record), key=lambda entry: entry["n"])
    if not posts or confirmed_ack(net, record, owner):
        return ("LA0",)
    last = request_id(posts[-1])
    first = next(entry for entry in posts if request_id(entry) == last)
    reads = sorted((entry for entry in net if entry["route"] == "#4" and entry["target"] == record and entry["n"] > first["n"]
                    and answered(entry) and entry["status"] == 200), key=lambda entry: entry["done"])
    state = next((item.get("state") for item in items_of(reads[-1])), None) if reads else None
    if classify(first) == "refused":
        code = first["json"].get("code")
        return ("LA2", code, "Cancelled" if code == "CRITICAL_RESULT_CANCELLED" and state == "cancelled" else None)
    if state in ("cancelled", "superseded"):
        return ("LA3", STATE_NAME[state])
    return ("LA1",)


def send_outcome(net: list[dict], request: str, route: str, owner: list, target: str | None = None) -> str | None:
    """Table SD (test-plan 6.3): the word a sender dialog or line owes one of this page's writes, from its own exchange and the
    reads it received (a held read is not received)."""
    posts = sorted((entry for entry in net if entry["route"] == route and request_id(entry) == request), key=lambda entry: entry["n"])
    if not posts:
        return None
    cancel = route == "#7"
    done, refused, unknown = (("Cancelled", "Not cancelled", "Cancellation status unknown") if cancel
                              else ("Delivered", "Not delivered", "Delivery status unknown"))
    if any(applied_write(entry, owner, request, target) for entry in posts):
        return done
    for entry in posts:
        data = entry.get("json")
        if (not cancel and answered(entry) and entry["status"] == 409 and isinstance(data, dict)
                and data.get("code") == "CRITICAL_RESULT_PENDING_EXISTS" and str(data.get("id") or "").lower() == request):
            return done
    first = posts[0]["n"]
    for entry in net:
        if not (answered(entry) and entry["status"] == 200 and entry["n"] > first):
            continue
        if not (entry["route"] in ("#4", "#5") or (entry["route"] == "#3" and view_of(entry) == "sent")):
            continue
        for item in items_of(entry):
            if cancel and key_of(item) == target and item.get("state") == "cancelled":
                return done
            if not cancel and key_of(item) == request:
                return done
    return refused if classify(posts[0]) == "refused" else unknown


class Unmatched(Exception):
    """test-plan 6.1.1 rule U3: an observation that is not exactly one record is not judged; the checkpoint fails."""

    def __init__(self, kind: str, detail: str) -> None:
        super().__init__(f"{kind}: {detail}")
        self.kind, self.detail = kind, detail


def correspond(cp: dict) -> dict:
    """test-plan 6.1.1: each observation to exactly one record by the keys the contract puts on the screen - K1 the synthetic
    message, K2/K3 the study identity's patient ID, K4 the study and pinned Source version, K5 the page's own writes -
    with candidates from server facts only. Never a state word, a button, a time, row order or a product data-* attribute."""
    screen, net, studies, records = cp["screen"], cp["net"], cp["studies"], cp["server"]["records"]
    messages = {record: row["message"] for record, row in records.items() if row.get("message")}

    def identity(text: str, what: str) -> str:
        found = [uid for uid, patient in studies.items() if patient in text]
        if len(found) != 1:
            raise Unmatched("screen", f"{what}: {len(found)} study identities in view")
        return found[0]

    def one(what: str, candidates) -> Any:
        candidates = sorted(set(candidates))
        if len(candidates) > 1:
            raise Unmatched("harness", f"{what}: records {candidates} share its key (U1)")
        if not candidates:
            raise Unmatched("screen", f"{what}: no record explains it (U1)")
        return candidates[0]

    received = [entry for entry in net if answered(entry) and entry["status"] == 200]
    mapping: dict = {"rows": [], "lines": [], "sent_rows": [], "dialog": None, "sent_lines": []}
    if cp["role"] == "recipient":
        lists = [entry for entry in received if entry["route"] == "#3" and view_of(entry) == "received"]
        last = max(lists, key=lambda entry: entry["done"]) if lists else None
        # A row the last list answer carried in full must show its message (K1), so it is no K2 candidate.
        full = {key_of(item) for item in items_of(last) if item.get("view") == "full"}
        seen: set[str] = set()
        for entry in received:
            if entry["route"] in ("#4", "#5") or (entry["route"] == "#3" and view_of(entry) == "received"):
                seen |= {key_of(item) for item in items_of(entry)}
        for entry in net:
            data = entry.get("json")
            if entry["route"] == "#6" and answered(entry) and entry["status"] == 201 and isinstance(data, dict):
                seen.add(key_of(data.get("applied")))
        for index, row in enumerate(screen["rows"]):
            hits = [record for record, message in messages.items() if message in row["text"]]
            if hits:
                mapping["rows"].append(one(f"row {index} (K1)", hits))
                continue
            uid = identity(row["text"], f"row {index} (K2)")
            mapping["rows"].append(one(f"row {index} (K2 {studies[uid]})",
                                       [record for record in seen - full if records.get(record, {}).get("studyUid") == uid]))
        acked = {entry["target"] for entry in net if entry["route"] == "#6"}
        for index, line in enumerate(screen["lines"]):
            uid = identity(line["text"], f"line {index} (K3)")
            mapping["lines"].append(one(f"line {index} (K3 {studies[uid]})",
                                        [record for record in acked if records.get(record, {}).get("studyUid") == uid]))
    else:
        lists = [entry for entry in received if entry["route"] == "#3" and view_of(entry) == "sent"]
        last = max(lists, key=lambda entry: entry["done"]) if lists else None
        for index, row in enumerate(screen["sent_rows"]):
            uid = identity(row["study"], f"sent row {index} (K4)")
            version = re.search(r"(?<![0-9A-Za-z])v(\d+)(?![0-9])", row["source"])
            if not version:
                raise Unmatched("screen", f"sent row {index}: no Source version in view (K4)")
            mapping["sent_rows"].append(one(
                f"sent row {index} (K4 {studies[uid]} v{version.group(1)})",
                [key_of(item) for item in items_of(last) if item.get("studyUid") == uid
                 and (item.get("source") or {}).get("version") == int(version.group(1))]))
        writes = [entry for entry in net if entry["route"] in ("#2", "#7", "#8")]
        dialog = screen.get("dialog")
        if dialog and dialog["words"]:
            creates = [entry for entry in writes if entry["route"] == "#2"]
            if not creates:
                raise Unmatched("screen", "the dialog shows an outcome but this page sent no create (K5)")
            mapping["dialog"] = request_id(max(creates, key=lambda entry: entry["n"]))
        for index, line in enumerate(screen["sent_lines"]):
            actions = sorted(set(re.findall(r"(?<![A-Za-z])(Cancel Delivery|Supersede|Send)(?![A-Za-z])", line["text"])))
            if len(actions) != 1:
                raise Unmatched("screen", f"sent line {index}: actions {actions} in view (K5)")
            route = {"Send": "#2", "Supersede": "#8", "Cancel Delivery": "#7"}[actions[0]]
            uid = identity(line["text"], f"sent line {index} (K5)")
            mapping["sent_lines"].append(one(f"sent line {index} (K5 {actions[0]} {studies[uid]})", [
                (route, request_id(entry), None if route == "#2" else entry["target"]) for entry in writes if entry["route"] == route
                and (entry["target"] if route == "#2" else records.get(entry["target"], {}).get("studyUid")) == uid]))
    for kind in ("rows", "lines", "sent_rows", "sent_lines"):
        if len(set(mapping[kind])) != len(mapping[kind]):
            raise Unmatched("screen", f"two {kind} of one page stand for one record (U2)")
    # U5 (S7-U2b-R-001 F001): U1/U2 look from an observation to a record only, so a record the screen left out failed
    # neither. A checkpoint that names the records its list must show (`shows`: H-03, H-04, the All lists of test-plan
    # 6.3.1) gets each of them as exactly one observation and no other record. The named records are this case's own
    # records of the page's identity and the step shows the All list, whose answer carries every one of them (contract 4,
    # state=all): one missing from the page's last list answer is the server's, one missing from the screen is the screen's.
    listed = {key_of(item) for item in items_of(last)}
    for kind, named in sorted((cp.get("shows") or {}).items()):
        named = {str(record).lower() for record in named}
        if named - listed:
            raise Unmatched("server", f"{kind}: the page's last list answer lacks {sorted(named - listed)} (U5)")
        shown = set(mapping[kind])
        if shown != named:
            raise Unmatched("screen", f"{kind}: records {sorted(named - shown)} not shown, {sorted(shown - named)} shown "
                                      "but not named by this checkpoint (U5)")
    return mapping


def problems(cp: dict) -> list[str]:
    """test-plan 6.2: the problems of one checkpoint, after correspond() tied every observation to one record. Pure: the
    input is the screen, the answers the page received, the handler records and the server facts, nothing of the product's
    code. `settled` checkpoints get every rule; `in-flight` ones (a held read, a paused old screen) only the rules that hold
    while the page may not yet know a server change."""
    mapping = correspond(cp)
    found: set[str] = set()
    screen, net, owner, records = cp["screen"], cp["net"], cp["owner"], cp["server"]["records"]
    settled = cp["kind"] == "settled"
    reads = cp.get("reads") or {}
    listing = reads.get("list") or {}
    list_data = listing.get("json") if isinstance(listing.get("json"), dict) else {}
    listed = {key_of(item): item for item in list_data.get("items") or [] if isinstance(item, dict)}

    def session_item(record: str) -> dict | None:
        read = (reads.get("items") or {}).get(record)
        data = read.get("json") if read and read.get("status") == 200 else None
        item = data.get("item") if isinstance(data, dict) else None
        return item if isinstance(item, dict) else listed.get(record)

    def acknowledged(record: str) -> bool:
        return records.get(record, {}).get("state") == "acknowledged"

    if cp["role"] == "recipient":
        rows = list(zip(screen["rows"], mapping["rows"]))
        lines = dict(zip(mapping["lines"], screen["lines"]))
        for row, record in rows:
            if "Acknowledged" in row["words"] and not acknowledged(record):
                found.add("ack-not-on-server")
        for record, line in lines.items():
            if "Acknowledged" in line["words"] and not acknowledged(record):
                found.add("ack-not-on-server")
        if settled:
            if screen["badge"] != f"Pending ACK {list_data.get('pending')}":
                found.add("badge-not-server")
            for row, record in rows:
                item = session_item(record)
                if item is None:
                    found.add("row-not-for-session")      # split 1: no s(r) to judge the rest of this row by
                    continue
                w = confirmed_ack(net, record, owner)
                state, source = item.get("state"), item.get("source") or {}
                current_full = item.get("view") == "full" and source.get("current") is True
                if state == "acknowledged":
                    want, at = "Acknowledged", item.get("acknowledgedAt")                      # D4
                elif state == "created" and w:
                    want, at = "Acknowledged", w                                               # D7
                elif state == "created":
                    want, at = ("Pending ACK" if current_full else "Source Changed"), None     # D1, D2/D3
                else:
                    want, at = STATE_NAME.get(state), None                                     # D5, D6, D8
                if "Acknowledged" in row["words"] and not acknowledged(record):
                    pass                                                                       # split 2
                elif (row["words"] != [want] or (at is not None and minute(at) not in row["times"])
                      or (state == "superseded" and item.get("replacedBy") and not row["replacement"])):
                    found.add("state-word-mismatch")
                if row["ack"] and not (state == "created" and current_full and not w and ack_exchange(net, record, owner)[0] != "LA1"):
                    found.add("acknowledge-offered-off-c2")
                if item.get("view") == "stub" and any(text and text in row["text"] for text in list(cp["contents"]) + ["Source:"]):
                    found.add("stub-shows-content")
        for record in sorted({entry["target"] for entry in net if entry["route"] == "#6"}):
            want = ack_exchange(net, record, owner)
            line = lines.pop(record, None)
            if want[0] == "LA0":
                ok = line is None
            elif line is None:
                ok = False
            elif want[0] == "LA1":
                ok = line["words"] == ["Acknowledgement status unknown"] and line["check"]
            elif want[0] == "LA2":
                ok = (line["words"] == ([want[2]] if want[2] else []) and not line["check"] and bool(want[1])
                      and want[1] in line["text"] and HANGUL.search(line["text"]) is not None)
            else:
                ok = line["words"] == [want[1]] and not line["check"]
            # LA1-LA3: while the line stands no `Acknowledged` of r shows anywhere (a false one is ack-not-on-server's, split 2).
            if want[0] != "LA0" and acknowledged(record) and any("Acknowledged" in row["words"] for row, other in rows if other == record):
                ok = False
            if not ok:
                found.add("state-word-mismatch")
        if lines:
            found.add("state-word-mismatch")
    else:
        dialog = screen.get("dialog")
        if dialog and mapping["dialog"]:
            request = mapping["dialog"]
            want = send_outcome(net, request, "#2", owner)
            if "Delivered" in dialog["words"] and request not in records:
                found.add("delivered-not-on-server")
            elif dialog["words"] != [want] or dialog["check"] != str(want).endswith("status unknown"):
                found.add("state-word-mismatch")
        for line, (route, request, target) in zip(screen["sent_lines"], mapping["sent_lines"]):
            want = send_outcome(net, request, route, owner, target)
            if "Delivered" in line["words"] and request not in records:
                found.add("delivered-not-on-server")
            elif line["words"] != [want] or line["check"] != str(want).endswith("status unknown"):
                found.add("state-word-mismatch")
        if settled:
            for row, record in zip(screen["sent_rows"], mapping["sent_rows"]):
                item = listed.get(record)
                if item is None:
                    found.add("state-word-mismatch")
                    continue
                state, marks, actions = item.get("state"), [], []
                if state == "created":
                    if (item.get("source") or {}).get("current") is False:
                        marks.append("Source Changed")
                    if item.get("delivery") == "not_eligible":
                        marks.append("Recipient Not Eligible")
                    if item.get("delivery") == "unknown":
                        marks.append("Status Unknown")
                    actions = ["Cancel Delivery", "Supersede"]
                if row["words"] != [STATE_NAME.get(state)] or row["marks"] != sorted(marks) or sorted(row["actions"]) != actions:
                    found.add("state-word-mismatch")
    # RISK-S7-U2b-SELF-PROOF: the receipts are exactly the applied writes a page sent to the server, from the identity it
    # was signed in as (a POST a handler answered itself never reached the server).
    receipts = {str(row.get("requestId") or "").lower() for row in cp["server"]["receipts"]}
    reached: dict[str, dict] = {}
    unsure: set[str] = set()
    for write in cp["writes"]:
        if write["reached"] is True and write["status"] == 201:
            reached.setdefault(write["requestId"], write)
        elif write["reached"] is None:
            unsure.add(write["requestId"])
    if receipts - set(reached) - unsure or set(reached) - receipts:
        found.add("write-not-from-page")
    for event in cp["server"]["events"]:
        post = reached.get(str(event.get("requestId") or "").lower())
        if post is not None and event.get("actorSub") != post["sub"]:
            found.add("actor-mismatch")
    return sorted(found)


def judge_vectors() -> list[dict]:
    """test-plan 6.3.2: JV-01..JV-18 as pure inputs (no browser, no stack). Normal vectors answer [], the head-only twins
    (`m`) and the MU vectors exactly the listed problems, and JV-16 (the fix3 layout) stops before judging. JV-19 (H-03)
    and JV-20 (H-04) add rule U5 (S7-U2b-R-001 F001): the three records shown in any order answer [], each one left out
    stops before judging as the screen's."""
    a, b = "2.25.99001", "2.25.99002"
    studies = {a: "INV-VECTOR00000A01", b: "INV-VECTOR00000B02"}
    p_owner, s_owner, w_owner = ["hallym", "sub-p"], ["hallym", "sub-s"], ["hallym", "sub-w"]
    r0, r1, r2, q1, q2 = (f"00000000-0000-4000-8000-00000000000{n}" for n in range(5))
    t0, t1 = "2026-09-29T03:00:05.000Z", "2026-09-29T03:04:40.000Z"
    m0, m1, m2 = "SYNTHETIC U2b vector #0.", "SYNTHETIC U2b vector #1.", "SYNTHETIC U2b vector #2."
    v1 = {"findings": "SYNTHETIC U2b vector findings v1.", "conclusion": "SYNTHETIC U2b vector conclusion v1.", "recommendation": ""}
    v2 = {"findings": "SYNTHETIC U2b vector findings v2.", "conclusion": "SYNTHETIC U2b vector conclusion v2.", "recommendation": ""}
    contents = [m0, m1, m2, *v1.values(), *v2.values()]

    def item(record, uid, state="created", view="full", current=True, message=m1, acknowledged_at=None, replaced_by=None,
             reason=None, version=1, body=None):
        row = {"id": record, "studyUid": uid, "state": state, "revision": 1 if state == "created" else 2, "createdAt": t0,
               "replacedBy": replaced_by, "view": view, "sender": {"name": "KIN doctor"},
               "study": {"uid": uid, "name": "INVARIANT vector", "id": studies[uid], "birth": "", "date": "20260929"},
               "acknowledgedAt": acknowledged_at, "cancelledAt": None, "supersededAt": None}
        if view == "full":
            row.update(message=message, source={"version": version, "action": "approve", "author": "doctor", "at": t0,
                                                "current": current, "reason": None if current else "head_moved"},
                       body=body or v1, cancelReason=reason)
        else:
            row["source"] = {"current": False, "reason": "head_moved"}
        return row

    def shown(head, uid, message=None, extra=(), ack=0, replacement=False):
        text = "\n".join([head] + ([message] if message else []) + [f"From KIN doctor · Sent {minute(t0)}",
                         f"Patient: INVARIANT vector · ID {studies[uid]} · Birth — · Study Date 20260929", *extra])
        return {"text": text, "words": words(text, ROW_WORDS), "times": ack_times(text), "ack": ack, "ack_all": ack,
                "replacement": replacement}

    def line(head, uid, text, check):
        full = f"{head} · INVARIANT vector · {studies[uid]} · Sent {minute(t0)}\n{text}"
        return {"text": full, "words": words(full, LINE_WORDS), "check": check}

    def entry(n, route, target=None, view=None, body=None, status=200, data=None, state="answered"):
        return {"n": n, "done": n + 1 if state == "answered" else None, "route": route, "target": target,
                "query": {"view": [view]} if view else {}, "body": json.dumps(body) if body is not None else None,
                "state": state, "status": status if state == "answered" else None, "json": data, "page": "V"}

    def listing(n, owner, items, pending, view="received"):
        return entry(n, "#3", view=view, data={"owner": owner, "view": view, "items": items, "nextCursor": None, "pending": pending})

    def envelope(owner, record, uid, request, action="ack", at=t1, replayed=False, replacement=None):
        return {"owner": owner, "replayed": replayed, "applied": {
            "id": record, "studyUid": uid, "requestId": request, "action": action, "from": None if action == "create" else "created",
            "to": {"create": "created", "ack": "acknowledged", "cancel": "cancelled", "supersede": "superseded"}[action],
            "revision": 1 if action == "create" else 2, "replacement": replacement, "at": at}}

    def write(request, sub, reached=True, status=201):
        return {"requestId": request, "sub": sub, "reached": reached, "status": status if reached else None}

    def cp(kind="settled", role="recipient", owner=p_owner, rows=(), lines=(), badge="Pending ACK 1", records=None, net=(),
           list_items=(), pending=1, session=None, writes=(), receipts=(), events=(), dialog=None, sent_lines=(), sent_rows=(),
           shows=None):
        return {"id": "vector", "kind": kind, "role": role, "owner": owner, "studies": studies, "contents": contents,
                "shows": dict(shows or {}),
                "screen": {"rows": list(rows), "lines": list(lines), "badge": badge, "dialog": dialog,
                           "sent_lines": list(sent_lines), "sent_rows": list(sent_rows)},
                "net": list(net), "writes": list(writes),
                "server": {"records": records or {}, "receipts": [{"requestId": r} for r in receipts], "events": list(events)},
                "reads": {"list": {"status": 200, "json": {"owner": owner, "view": "received", "items": list(list_items),
                                                           "nextCursor": None, "pending": pending}},
                          "items": {record: ({"status": 200, "json": {"owner": owner, "item": value}} if value else
                                             {"status": 404, "json": {"code": "CRITICAL_RESULT_NOT_FOUND"}})
                                    for record, value in (session or {}).items()}}}

    def record(uid, state="created", message=m1):
        return {"studyUid": uid, "state": state, "message": message}

    vectors: list[tuple[str, dict, list[str]]] = []
    # sender's create r1 for every recipient vector: its receipt and event are part of the case's ledger
    s_create = [write(r1, "sub-s")]
    s_events = [{"requestId": r1, "actorSub": "sub-s", "recordId": r1, "event": "created"}]
    full_body = ["Source: v1 · Approve · doctor · " + minute(t0), v1["findings"], v1["conclusion"]]
    created = item(r1, a)
    base_cp = dict(records={r1: record(a)}, net=[listing(1, p_owner, [created], 1)], list_items=[created], session={r1: created},
                   writes=s_create, receipts=[r1], events=s_events)
    vectors.append(("JV-01", cp(rows=[shown("Pending ACK", a, m1, full_body, ack=1)], **base_cp), []))
    vectors.append(("JV-01m", cp(rows=[shown("Source Changed", a, m1, full_body, ack=1)], **base_cp), ["state-word-mismatch"]))
    stub = item(r1, a, view="stub")
    stub_cp = dict(base_cp, net=[listing(1, p_owner, [stub], 1)], list_items=[stub], session={r1: stub})
    vectors.append(("JV-02", cp(rows=[shown("Source Changed", a, None, [STUB_TEXT])], **stub_cp), []))
    vectors.append(("JV-02m", cp(rows=[shown("Pending ACK", a, None, [STUB_TEXT])], **stub_cp), ["state-word-mismatch"]))
    acked = item(r1, a, state="acknowledged", acknowledged_at=t1)
    acked_cp = dict(base_cp, records={r1: record(a, "acknowledged")}, net=[listing(1, p_owner, [acked], 0)], list_items=[acked],
                    pending=0, session={r1: acked}, writes=s_create + [write(q1, "sub-p")], receipts=[r1, q1],
                    events=s_events + [{"requestId": q1, "actorSub": "sub-p", "recordId": r1, "event": "acknowledged"}])
    vectors.append(("JV-03", cp(rows=[shown(f"Acknowledged {minute(t1)}", a, m1, full_body)], badge="Pending ACK 0", **acked_cp), []))
    vectors.append(("JV-03m", cp(rows=[shown("Pending ACK", a, m1, full_body)], badge="Pending ACK 0", **acked_cp),
                    ["state-word-mismatch"]))
    reason = "SYNTHETIC U2b vector reason."
    cancelled = item(r1, a, state="cancelled", reason=reason)
    cancelled_cp = dict(base_cp, records={r1: record(a, "cancelled")}, net=[listing(1, p_owner, [cancelled], 0)],
                        list_items=[cancelled], pending=0, session={r1: cancelled})
    vectors.append(("JV-04", cp(rows=[shown("Cancelled", a, m1, full_body + [f"취소 사유: {reason}"])], badge="Pending ACK 0",
                                **cancelled_cp), []))
    vectors.append(("JV-04m", cp(rows=[shown("Superseded", a, m1, full_body + [f"취소 사유: {reason}"])], badge="Pending ACK 0",
                                 **cancelled_cp), ["state-word-mismatch"]))
    superseded = item(r1, a, state="superseded", view="stub", replaced_by=r2)
    superseded_cp = dict(base_cp, records={r1: record(a, "superseded")}, net=[listing(1, p_owner, [superseded], 0)],
                         list_items=[superseded], pending=0, session={r1: superseded})
    vectors.append(("JV-05", cp(rows=[shown("Superseded", a, None, replacement=True)], badge="Pending ACK 0", **superseded_cp), []))
    vectors.append(("JV-05m", cp(rows=[shown("Cancelled", a, None, replacement=True)], badge="Pending ACK 0", **superseded_cp),
                    ["state-word-mismatch"]))
    vectors.append(("JV-06", cp(rows=[shown(f"Acknowledged {minute(t1)}", a, m1, full_body)], **base_cp), ["ack-not-on-server"]))
    # JV-07 (MU-A): a matching 201 the handler made itself; the server record stays created.
    fabricated = entry(2, "#6", r1, body={"requestId": q1, "expectedOwner": p_owner, "revision": 1}, status=201,
                       data=envelope(p_owner, r1, a, q1))
    vectors.append(("JV-07", cp(rows=[shown(f"Acknowledged {minute(t1)}", a, m1, full_body)],
                                **dict(base_cp, net=[listing(1, p_owner, [created], 1), fabricated],
                                       writes=s_create + [write(q1, "sub-p", reached=False)])), ["ack-not-on-server"]))
    # JV-08 (L-05b, in-flight): the ACK answer cut (the server applied it), another envelope's 201, the confirming #4 held.
    ack_body = {"requestId": q1, "expectedOwner": p_owner, "revision": 1}
    lost_net = [listing(1, p_owner, [created], 1), entry(10, "#6", r1, body=ack_body, state="failed"),
                entry(12, "#6", r1, body=ack_body, status=201, data=envelope(p_owner, r1, a, q2, replayed=True)),
                entry(13, "#4", r1, state="out")]
    lost_cp = dict(records={r1: record(a, "acknowledged")}, net=lost_net, writes=s_create + [write(q1, "sub-p"),
                   write(q1, "sub-p", reached=False)], receipts=[r1, q1],
                   events=s_events + [{"requestId": q1, "actorSub": "sub-p", "recordId": r1, "event": "acknowledged"}])
    unknown_line = line("Acknowledgement status unknown", a, ACK_UNKNOWN_TEXT + " Check Again으로 확인하세요.", True)
    vectors.append(("JV-08", cp(kind="in-flight", rows=[shown("Pending ACK", a, m1, full_body)], lines=[unknown_line], **lost_cp), []))
    vectors.append(("JV-08m", cp(kind="in-flight", rows=[shown(f"Acknowledged {minute(t1)}", a, m1, full_body)], **lost_cp),
                    ["state-word-mismatch"]))
    # JV-09 (C-02): the late ACK's first answer is the definite 409 CANCELLED, then #4 reads cancelled.
    refusal = {"code": "CRITICAL_RESULT_CANCELLED", "message": "이미 취소된 전달입니다."}
    late_net = [listing(1, p_owner, [created], 1), entry(20, "#6", r1, body=ack_body, status=409, data=refusal),
                entry(22, "#4", r1, data={"owner": p_owner, "item": cancelled}), listing(23, p_owner, [cancelled], 0)]
    late_cp = dict(records={r1: record(a, "cancelled")}, net=late_net, list_items=[cancelled], pending=0, session={r1: cancelled},
                   writes=s_create + [write(q2, "sub-s"), write(q1, "sub-p", status=409)], receipts=[r1, q2], events=s_events)
    refused_text = "서버가 이 수신 확인을 거절했습니다. 이미 취소된 전달입니다.\n이미 취소된 전달입니다. (HTTP 409 · CRITICAL_RESULT_CANCELLED)"
    cancelled_row = shown("Cancelled", a, m1, full_body + [f"취소 사유: {reason}"])
    vectors.append(("JV-09", cp(rows=[cancelled_row], lines=[line("Cancelled", a, refused_text, False)], badge="Pending ACK 0",
                                **late_cp), []))
    vectors.append(("JV-09m", cp(rows=[cancelled_row], lines=[line("Superseded", a, refused_text, False)], badge="Pending ACK 0",
                                 **late_cp), ["state-word-mismatch"]))
    # JV-10 (MU-E): a stub the list answer turned into a full row with the record's own message and the head version's body.
    vectors.append(("JV-10", cp(rows=[shown("Source Changed", a, m1, ["Source: v1 · Approve · doctor", v2["findings"]])], **stub_cp),
                    ["stub-shows-content"]))
    # JV-11 (MU-C): another clinician's page shows a record its own session cannot read.
    vectors.append(("JV-11", cp(owner=w_owner, rows=[shown("Pending ACK", a, m1, full_body, ack=1)], badge="Pending ACK 0",
                                records={r1: record(a)}, net=[listing(1, w_owner, [created], 0)], pending=0, session={r1: None},
                                writes=s_create, receipts=[r1], events=s_events), ["row-not-for-session"]))
    # JV-12 (MU-B): the dialog shows Delivered for a create the handler answered itself; no record exists.
    made = entry(30, "#2", a, body={"requestId": q2}, status=201, data=envelope(s_owner, q2, a, q2, action="create"))
    vectors.append(("JV-12", cp(role="sender", owner=s_owner, records={}, net=[made, listing(31, s_owner, [], 0, view="sent")],
                                writes=[write(q2, "sub-s", reached=False)],
                                dialog={"text": "Delivered\n" + DELIVERED_TEXT, "words": ["Delivered"], "check": False}),
                    ["delivered-not-on-server"]))
    # JV-13 (MU-H): the observation loses one POST that reached the server; its receipt is then nobody's.
    vectors.append(("JV-13", cp(rows=[shown("Pending ACK", a, m1, full_body, ack=1)], **dict(base_cp, writes=[])),
                    ["write-not-from-page"]))
    # JV-14 (V-04): the old session still reads the record (L-10) and its ACK got the definite 403.
    role_refusal = {"code": "CRITICAL_RESULT_ROLE_REQUIRED", "message": "이 계정에는 지금 수신 확인할 역할이 없습니다."}
    old_net = [listing(1, p_owner, [created], 1), entry(40, "#6", r1, body=ack_body, status=403, data=role_refusal),
               listing(42, p_owner, [created], 1)]
    role_text = ("서버가 이 수신 확인을 거절했습니다. 이 계정에는 지금 수신 확인할 역할이 없습니다. 다시 누르면 새 요청으로 보냅니다.\n"
                 "이 계정에는 지금 수신 확인할 역할이 없습니다. (HTTP 403 · CRITICAL_RESULT_ROLE_REQUIRED)")
    vectors.append(("JV-14", cp(rows=[shown("Pending ACK", a, m1, full_body, ack=1)], lines=[line("", a, role_text, False)],
                                **dict(base_cp, net=old_net, writes=s_create + [write(q1, "sub-p", status=403)])), []))
    # JV-15 (L-01b, in-flight): the create's answer cut after the server applied it, the confirming reads held.
    cut = entry(50, "#2", b, body={"requestId": q2}, state="failed")
    held_net = [cut, entry(52, "#3", view="sent", state="out")]
    held = dict(role="sender", kind="in-flight", owner=s_owner, records={q2: record(b, message=m2)}, net=held_net,
                writes=[write(q2, "sub-s")], receipts=[q2], events=[{"requestId": q2, "actorSub": "sub-s", "recordId": q2}])
    unknown_dialog = {"text": "Delivery status unknown\n" + UNKNOWN_TEXT, "words": ["Delivery status unknown"], "check": True}
    vectors.append(("JV-15", cp(dialog=unknown_dialog, **held), []))
    vectors.append(("JV-15m", cp(dialog={"text": "Delivered", "words": ["Delivered"], "check": True}, **held),
                    ["state-word-mismatch"]))
    # JV-16..18 (H-04): r0 acknowledged, r1 superseded by r2, r2 created on the head version.
    r0_full = item(r0, a, state="acknowledged", message=m0, acknowledged_at=t1)
    the_ledger = dict(writes=[write(r0, "sub-s"), write(r1, "sub-s"), write(r2, "sub-s"), write(q1, "sub-p")],
                      receipts=[r0, r1, r2, q1],
                      events=[{"requestId": r0, "actorSub": "sub-s"}, {"requestId": r1, "actorSub": "sub-s"},
                              {"requestId": r2, "actorSub": "sub-s"}, {"requestId": q1, "actorSub": "sub-p"}])
    ack0 = entry(2, "#6", r0, body={"requestId": q1, "expectedOwner": p_owner, "revision": 1}, status=201,
                 data=envelope(p_owner, r0, a, q1))
    # fix3 layout: every record on one study, so r0 and r1 are both message-less rows of one patient in the same minute.
    old_items = [item(r0, a, state="acknowledged", view="stub", acknowledged_at=t1), item(r1, a, state="superseded", view="stub",
                 replaced_by=r2), item(r2, a, message=m2, version=2, body=v2)]
    vectors.append(("JV-16", cp(rows=[shown(f"Acknowledged {minute(t1)}", a), shown("Superseded", a, replacement=True),
                                      shown("Pending ACK", a, m2, ack=1)],
                                records={r0: record(a, "acknowledged", m0), r1: record(a, "superseded", m1), r2: record(a, message=m2)},
                                net=[ack0, listing(3, p_owner, old_items, 1)], list_items=old_items,
                                session=dict(zip((r0, r1, r2), old_items)), **the_ledger), ["unmatched:harness"]))
    # fix4 layout: r0 on study a (head unchanged, still full), r1 and r2 on study b.
    new_items = [r0_full, item(r1, b, state="superseded", view="stub", replaced_by=r2), item(r2, b, message=m2, version=2, body=v2)]
    fix4 = dict(records={r0: record(a, "acknowledged", m0), r1: record(b, "superseded", m1), r2: record(b, message=m2)},
                net=[ack0, listing(3, p_owner, new_items, 1)], list_items=new_items, session=dict(zip((r0, r1, r2), new_items)),
                **the_ledger)
    r0_row = shown(f"Acknowledged {minute(t1)}", a, m0, full_body)
    r2_row = shown("Pending ACK", b, m2, ["Source: v2 · Approve · doctor", v2["findings"]], ack=1)
    vectors.append(("JV-17", cp(rows=[r0_row, shown("Superseded", b, replacement=True), r2_row], **fix4), []))
    vectors.append(("JV-17m", cp(rows=[r0_row, shown("Cancelled", b, replacement=True), r2_row], **fix4), ["state-word-mismatch"]))
    vectors.append(("JV-18", cp(rows=[r0_row, shown(f"Acknowledged {minute(t1)}", b, replacement=True), r2_row], **fix4),
                    ["ack-not-on-server"]))
    # JV-19 (H-03, F001): S's All list of the fix4 layout - r0 acknowledged (a, v1), r1 superseded (b, v1), r2 created (b, v2).
    # Each row is tied by K4 and judged by table SL; U5 then asks for exactly the three records.
    def sent_item(record, uid, state, version):
        return {"id": record, "studyUid": uid, "state": state, "revision": 1 if state == "created" else 2, "createdAt": t0,
                "view": "sender", "recipient": {"name": "clinician KIN", "role": "clinician"}, "study": {"id": studies[uid]},
                "source": {"version": version, "action": "approve" if version == 1 else "addendum", "current": True},
                "delivery": "readable"}

    def sent(uid, version, state):
        actions = ["Supersede", "Cancel Delivery"] if state == "created" else []
        cell = "\n".join([STATE_NAME[state], *actions])
        return {"study": f"INVARIANT vector ({studies[uid]})\n20260929", "recipient": "clinician KIN · Clinician",
                "source": f"v{version} · {'Approve' if version == 1 else 'Addendum'} · doctor · {minute(t0)}", "state": cell,
                "words": words(cell, SENT_WORDS), "marks": words(cell, MARK_WORDS), "actions": actions}

    all_sent = [sent_item(r0, a, "acknowledged", 1), sent_item(r1, b, "superseded", 1), sent_item(r2, b, "created", 2)]
    h03 = dict(role="sender", owner=s_owner, badge=None, records=fix4["records"], net=[listing(5, s_owner, all_sent, 1, view="sent")],
               list_items=all_sent, shows={"sent_rows": [r0, r1, r2]}, **the_ledger)
    h03_rows = [sent(a, 1, "acknowledged"), sent(b, 1, "superseded"), sent(b, 2, "created")]
    vectors.append(("JV-19", cp(sent_rows=h03_rows, **h03), []))
    for index in range(3):
        vectors.append((f"JV-19-{index}", cp(sent_rows=h03_rows[:index] + h03_rows[index + 1:], **h03), ["unmatched:screen"]))
    vectors.append(("JV-19o", cp(sent_rows=[h03_rows[2], h03_rows[0], h03_rows[1]], **h03), []))
    # the list answer itself without r0 (and so no r0 row): U5 names the server, not the screen
    vectors.append(("JV-19s", cp(sent_rows=h03_rows[1:], **dict(h03, net=[listing(5, s_owner, all_sent[1:], 1, view="sent")],
                                                                list_items=all_sent[1:])), ["unmatched:server"]))
    # JV-20 (H-04, F001): JV-17's P All list with U5 naming r0, r1 and r2.
    h04_rows = [r0_row, shown("Superseded", b, replacement=True), r2_row]
    h04 = dict(fix4, shows={"rows": [r0, r1, r2]})
    vectors.append(("JV-20", cp(rows=h04_rows, **h04), []))
    for index in range(3):
        vectors.append((f"JV-20-{index}", cp(rows=h04_rows[:index] + h04_rows[index + 1:], **h04), ["unmatched:screen"]))
    vectors.append(("JV-20o", cp(rows=[h04_rows[1], h04_rows[2], h04_rows[0]], **h04), []))
    out = []
    for name, value, want in vectors:
        try:
            got = problems(value)
        except Unmatched as error:
            got = [f"unmatched:{error.kind}"]
        out.append({"id": name, "want": want, "got": got})
    return out


@dataclass
class Session:
    """One identity's own browser context (E-03): its cookie session, recorder and the filters its screens show."""
    logical: str
    label: str
    context: Any
    page: Any
    wire: "Wire"
    owner: list | None = None
    recv_filter: str = "pending"
    sent_filter: str = "pending"
    paused: bool = False


class Wire:
    """One browser context's critical result traffic (and its /api/me answers), in the order the browser reported it
    (test-plan section 2 recorder): which page sent what, the answer the page received, or its failure. Request and Response
    objects stay outside the logged entries and bodies are read after the action, never inside an event handler."""

    def __init__(self, test: "CriticalResultScreensE2E", context_label: str) -> None:
        self.test, self.ctx = test, context_label
        self.entries: list[dict] = []
        self.me: list[dict] = []
        self.paths: list[dict] = []
        self.errors: list[str] = []
        self.objects: dict[int, list] = {}
        self.by_request: dict[Any, dict] = {}
        self.pages: dict[Any, str] = {}
        self.sub: str | None = None

    def attach(self, context: Any) -> None:
        context.on("request", self.on_request)
        context.on("response", self.on_response)
        context.on("requestfinished", self.on_finished)
        context.on("requestfailed", self.on_failed)

    def name(self, page: Any, label: str) -> None:
        self.pages[page] = label

    def label(self, page: Any) -> str:
        return self.pages.get(page, "?")

    def page_of(self, request: Any) -> str:
        try:
            return self.pages.get(request.frame.page, "?")
        except Exception:
            return "?"

    def on_request(self, request: Any) -> None:
        try:
            split = urlsplit(request.url)
            if not split.path.startswith("/api/"):
                return
            n, page = self.test.tick(), self.page_of(request)
            self.paths.append({"n": n, "page": page, "method": request.method, "path": split.path})
            if split.path == "/api/me" and request.method == "GET":
                # The document that asked: a clinician-only login asks from main.html, which then replaces itself with
                # clinician.html (auth.js land()), so that answer's body may be gone when it is read (hosted run
                # 36540533271, CRS-04 E-03 P).
                try:
                    doc = urlsplit(request.frame.url).path
                except Exception:
                    doc = None
                entry = {"n": n, "page": page, "doc": doc, "state": "out", "status": None, "json": None, "done": None}
                self.me.append(entry)
            else:
                found = route_of(request.method, split.path)
                if found is None:
                    return
                headers = request.headers
                entry = {"n": n, "ctx": self.ctx, "page": page, "sub": self.sub, "method": request.method, "path": split.path,
                         "query": parse_qs(split.query), "route": found[0], "target": found[1], "body": request.post_data,
                         "csrf": headers.get("x-kin-csrf"), "authorization": "authorization" in headers,
                         "t": self.test.clock(), "wall": now_iso(), "state": "out", "status": None, "json": None, "done": None,
                         "failure": None}
                self.entries.append(entry)
            self.by_request[request] = entry
            self.objects[n] = [request, None]
        except Exception as error:
            self.errors.append(f"request: {type(error).__name__}: {error}")

    def on_response(self, response: Any) -> None:
        try:
            entry = self.by_request.get(response.request)
            if entry is None:
                return
            entry["status"] = response.status
            self.objects[entry["n"]][1] = response
            if entry.get("route") in WRITE_ROUTES and response.status == 201:
                self.test.mark_change()
        except Exception as error:
            self.errors.append(f"response: {type(error).__name__}: {error}")

    def on_finished(self, request: Any) -> None:
        entry = self.by_request.get(request)
        if entry is not None:
            entry["state"], entry["done"] = "answered", self.test.tick()

    def on_failed(self, request: Any) -> None:
        entry = self.by_request.get(request)
        if entry is not None:
            entry["state"], entry["done"] = "failed", self.test.tick()
            try:
                entry["failure"] = request.failure
            except Exception:
                entry["failure"] = "unknown"

    def harvest(self) -> None:
        """Read the bodies of the answers that arrived, once, soon after they arrived."""
        for entry in self.entries + self.me:
            if entry["state"] != "answered" or entry.get("read"):
                continue
            entry["read"] = True
            response = self.objects.get(entry["n"], [None, None])[1]
            try:
                entry["json"] = response.json() if response is not None else None
            except Exception:
                entry["json"] = None

    def outstanding(self, label: str) -> list[dict]:
        return [entry for entry in self.entries if entry["page"] == label and entry["state"] == "out"]


class Control:
    """One handler set of test-plan section 6.4 on a context (all its pages) or on one dedicated page (MU-A, MU-B), with the
    sub-handlers of that step: hp (hold the create), hr3/hr4/hr5 (hold confirm reads), h1 (forward then cut), h2/h4 and the
    MU-B create (a made-up 201), the list changes of MU-C..MU-F and the RF-1 delay. Every request a sub-handler takes is logged
    with the case's tick, so "before or after the POST" is the handler record's order."""

    def __init__(self, test: "CriticalResultScreensE2E", sess: Session, name: str, page: Any = None) -> None:
        self.test, self.sess, self.name = test, sess, name
        self.target = page if page is not None else sess.context
        self.page_scoped = page is not None
        self.pump_page = page if page is not None else sess.page
        self.subs: list[tuple] = []
        self.held: list[dict] = []
        self.grabbed: dict | None = None
        self.q: str | None = None
        self.forwarded = False
        self.registered = False
        self.handler: Any = None
        test.controls.append(self)

    def add(self, label: str, predicate, action: str, **options: Any) -> None:
        self.subs.append((label, predicate, action, options))
        self.test.log("handler", control=self.name, sub=label, act="add")

    def remove(self, label: str) -> None:
        self.subs = [sub for sub in self.subs if sub[0] != label]
        self.test.log("handler", control=self.name, sub=label, act="remove")

    def start(self) -> None:
        def window_route(route):
            self.take(route)
        self.handler = window_route
        self.target.route(cvr_url, window_route)
        self.registered = True
        self.test.log("handler", control=self.name, act="register", at=self.test.tick())

    def take(self, route: Any) -> None:
        request = route.request
        entry = self.sess.wire.by_request.get(request)
        split = urlsplit(request.url)
        found = route_of(request.method, split.path) or (None, None)
        info = {"route": found[0], "target": found[1], "view": (parse_qs(split.query).get("view") or [None])[0],
                "method": request.method, "entry": entry["n"] if entry else None}
        for label, predicate, action, options in list(self.subs):
            try:
                if not predicate(info):
                    continue
                if getattr(self, "act_" + action)(label, route, request, info, options):
                    return
            except Exception as error:
                self.test.handler_errors.append(f"{self.name}/{label}: {type(error).__name__}: {error}")
                self.test.log("handler", control=self.name, sub=label, act="error", error=f"{type(error).__name__}: {error}")
                try:
                    route.fallback()
                except Exception:
                    pass
                return
        route.fallback()

    def record(self, label: str, act: str, info: dict, **fields: Any) -> dict:
        row = {"control": self.name, "sub": label, "act": act, "route": info.get("route"), "target": info.get("target"),
               "view": info.get("view"), "entry": info.get("entry"), "n": self.test.tick(), **fields}
        self.test.handled.append(row)
        self.test.log("handler", **row)
        return row

    def act_hold(self, label, route, request, info, options) -> bool:
        row = self.record(label, "hold", info)
        self.held.append({"n": row["n"], "sub": label, "route": route, "entry": info["entry"]})
        return True

    def act_grab(self, label, route, request, info, options) -> bool:
        if self.grabbed is not None:
            return False
        self.q = request_id({"body": request.post_data})
        row = self.record(label, "grab", info, request=self.q)
        self.grabbed = {"n": row["n"], "route": route, "entry": info["entry"]}
        return True

    def act_hold_q(self, label, route, request, info, options) -> bool:
        if self.q is None or info["target"] != self.q:
            self.record(label, "pass", info)
            return False
        return self.act_hold(label, route, request, info, options)

    def act_forward_cut(self, label, route, request, info, options) -> bool:
        if options.get("done"):
            return False
        options["done"] = True
        response = route.fetch()
        try:
            data = response.json()
        except Exception:
            data = None
        self.test.mark_change()
        route.abort()
        self.record(label, "fetch-abort", info, status=response.status, json=data)
        return True

    def act_fulfill(self, label, route, request, info, options) -> bool:
        answer = options["answer"](request)
        route.fulfill(status=201, content_type="application/json", body=json.dumps(answer))
        self.record(label, "fulfill", info, json=answer)
        return True

    def act_modify(self, label, route, request, info, options) -> bool:
        response = route.fetch()
        data = response.json()
        options["change"](data)
        route.fulfill(status=response.status, content_type="application/json", body=json.dumps(data))
        self.record(label, "modify", info, status=response.status, json=data)
        return True

    def release(self, before: int | None = None) -> list[dict]:
        """Hand the held requests to the server in the order they were caught and wait for what the page receives (a real
        server answer, or the request's own failure)."""
        released = []
        for hold in list(self.held):
            if before is not None and hold["n"] > before:
                continue
            entry = self.entry(hold["entry"])
            failed = entry is not None and entry["state"] == "failed"
            try:
                hold["route"].continue_()
                act = "release"
            except Exception as error:
                act = f"release-error: {type(error).__name__}"
            self.record(hold["sub"], act, {"entry": hold["entry"]}, failed_before_release=failed)
            self.held.remove(hold)
            released.append(hold)
        self.test.until(lambda: all(self.entry(hold["entry"]) is None or self.entry(hold["entry"])["state"] != "out"
                                    for hold in released), f"{self.name}: the released requests' answers", self.pump_page)
        self.test.harvest()
        return released

    def entry(self, n: int | None) -> dict | None:
        return next((entry for entry in self.sess.wire.entries if entry["n"] == n), None) if n is not None else None

    def forward_and_cut(self) -> None:
        """E5: the held create goes to the server now, its answer is recorded here, and the page's own request is cut."""
        grabbed = self.grabbed
        response = grabbed["route"].fetch()
        try:
            data = response.json()
        except Exception:
            data = None
        self.test.mark_change()
        grabbed["route"].abort()
        self.forwarded = True
        self.record("hp", "fetch-abort", {"entry": grabbed["entry"], "route": "#2"}, status=response.status, json=data)

    def caught(self, label: str, after: int = 0) -> list[dict]:
        return [row for row in self.test.handled if row["control"] == self.name and row["sub"] == label
                and row["act"] == "hold" and row["n"] > after]

    def drain(self, what: str, label: str | None = None) -> None:
        """E2: every critical result request of the page(s) sent before the handlers took over, and not taken by them, gets
        its answer or failure first (a server answer: it cannot carry a write that has not been sent yet)."""
        registered = self.test.tick()
        mine = {hold["entry"] for hold in self.held} | ({self.grabbed["entry"]} if self.grabbed else set())
        self.test.until(lambda: not [entry for entry in self.sess.wire.entries if entry["n"] < registered and entry["state"] == "out"
                                     and entry["n"] not in mine and (label is None or entry["page"] == label)],
                        what, self.pump_page)
        self.test.log("window", control=self.name, act="drained", at=self.test.tick())

    def close(self) -> None:
        if not self.registered:
            return
        if self.page_scoped:
            self.target.unroute_all()
        else:
            self.target.unroute(cvr_url, self.handler)
        self.registered = False
        self.test.log("handler", control=self.name, act="unregister", at=self.test.tick())

    def cleanup(self) -> tuple[list[str], list[str]]:
        """test-plan 6.4 rule 5 for this control: unroute, cut a create still held (it never reaches the server), release the
        remaining holds in order. Returns what was left to do and what failed."""
        left, errors = [], []
        if self.registered:
            left.append(f"{self.name}: handler still registered")
            try:
                self.close()
            except Exception as error:
                errors.append(f"{self.name} unroute: {type(error).__name__}: {error}")
                self.registered = False
        if self.grabbed is not None and not self.forwarded and not self.grabbed.get("cut"):
            left.append(f"{self.name}: create still held")
            try:
                self.grabbed["route"].abort()
            except Exception as error:
                errors.append(f"{self.name} abort: {type(error).__name__}: {error}")
            self.grabbed["cut"] = True
            self.record("hp", "abort-held-post", {"entry": self.grabbed["entry"], "route": "#2"})
        if self.held:
            left.append(f"{self.name}: {len(self.held)} held requests")
            for hold in list(self.held):
                try:
                    hold["route"].continue_()
                    act = "release (cleanup)"
                except Exception as error:
                    act = f"release-error (cleanup): {type(error).__name__}"
                self.record(hold["sub"], act, {"entry": hold["entry"]})
                self.held.remove(hold)
        return left, errors


def is_(**fixed: Any):
    """A sub-handler predicate over the request's contract shape (route, target, view, method)."""
    return lambda info: all(info.get(key) == value for key, value in fixed.items())


class CriticalResultScreensE2E(KeycloakGroups, CriticalResultHarness, base.WorklistE2E):
    """REQ-S7-U2b-E2E / REQ-S7-U2a-EXPLICIT-ACK / REQ-S7-U2a-RECIPIENT-LIST / REQ-S7-U1b-SENDER-UI / REQ-S7-U1b-FAILURE /
    REQ-S7-U1p-WRITE-OUTCOME -> RISK-S7-U2b-SELF-PROOF / RISK-S7-U1p-FALSE-ACK / RISK-S7-U1p-FALSE-UNDELIVERED /
    RISK-S7-CVR-WRONG-RECIPIENT / RISK-S7-CVR-ACK-CANCEL-RACE / RISK-S7-CVR-REVOKED-ACK / RISK-S7-U2a-BODY-SUBSTITUTE ->
    TEST-S7-U2b-E2E. Synthetic stack only, `scripts/run-tests.py --class CriticalResultScreensE2E` only (hosted dispatch,
    profile critical-result-screens). S = doctor (radiologist) on main.html, P/W/V = clinician/clinician2/clinician3 and
    K = kclinician (clinician only) on clinician.html, T = tech. No mail, SMS or push delivery is claimed.

    Inherited from WorklistE2E: the stack, Chromium, the per-case fixture cleanup (preceded here by the critical result rows,
    which RESTRICT it), the context closing and select(). Its own 15 cases never load (load_tests, --class)."""
    maxDiff = None

    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        cls.owners = {}
        cls.created_role = False
        cls.addClassCleanup(cls.drop_all_critical_results)
        cls.created_role = ensure_clinician_role(cls.stack)
        cls.addClassCleanup(cls.delete_role_if_created)
        for logical, group in SCREEN_IDENTITIES:
            cls.stack.create_test_identity(logical, ["clinician"], group)

    @classmethod
    def delete_role_if_created(cls) -> None:
        if cls.created_role and cls.stack.kc_admin("DELETE", "/roles/clinician").status not in (204, 404):
            raise RuntimeError("temporary clinician role cleanup failed")
        cls.created_role = False

    @classmethod
    def drop_all_critical_results(cls) -> None:
        for uid in list(cls.stack.active):
            drop_critical_results(uid, set(cls.stack.user_ids.values()))

    def setUp(self) -> None:
        super().setUp()
        self.case = "CRS-" + self._testMethodName.split("_")[1][3:]
        self.run = uuid.uuid4().hex[:8]
        self.n = self.change_n = self.messages = 0
        self.t0 = time.monotonic()
        self.steps: list[dict] = []
        self.handled: list[dict] = []
        self.handler_errors: list[str] = []
        self.sessions: list[Session] = []
        self.controls: list[Control] = []
        self.case_studies: list[Fixture] = []
        self.cookie_values: set[str] = set()
        self.not_run_record: dict | None = None
        self.version_cache: dict[str, list] = {}

    # ── I-03: the API write helpers of CriticalResultHarness are refused in this class ──

    def send(self, *args: Any, **kwargs: Any) -> Any:
        raise AssertionError(API_WRITE_REFUSED)

    def ack(self, *args: Any, **kwargs: Any) -> Any:
        raise AssertionError(API_WRITE_REFUSED)

    def cancel(self, *args: Any, **kwargs: Any) -> Any:
        raise AssertionError(API_WRITE_REFUSED)

    def supersede(self, *args: Any, **kwargs: Any) -> Any:
        raise AssertionError(API_WRITE_REFUSED)

    # ── E-09 order: contexts closed (base), then every case study's critical result rows, then the fixtures ──

    def cleanup_fixtures(self) -> None:
        failures = []
        for uid in list(self.stack.active):
            try:
                drop_critical_results(uid, set(self.stack.user_ids.values()))
            except Exception as error:
                failures.append(f"{uid}: {error}")
        super().cleanup_fixtures()
        if failures:
            raise RuntimeError("critical result cleanup failed: " + "; ".join(failures))

    # ── the case's clock, step log and failure class ──

    def tick(self) -> int:
        self.n += 1
        return self.n

    def clock(self) -> float:
        return round(time.monotonic() - self.t0, 3)

    def mark_change(self) -> None:
        """A server change a later settled checkpoint must have read past (test-plan 6.2)."""
        self.change_n = self.tick()

    def log(self, kind: str, **fields: Any) -> None:
        self.steps.append({"t": self.clock(), "n": self.n, "case": self.case, "kind": kind, **fields})

    @contextmanager
    def step(self, name: str):
        """One scenario row. A failure is classified (test-plan section 5) and the class leads its message."""
        self.log("step", step=name, act="start")
        try:
            yield
        except Exception as error:
            text = str(error)
            kind = next((kind for kind in FAILURE_KINDS if text.startswith(kind + ":")), None)
            if kind is None:
                kind = "harness" if isinstance(error, (PlaywrightTimeout, PlaywrightError)) else (
                    "screen" if isinstance(error, AssertionError) and "Locator" in text else "harness")
            self.log("step", step=name, act="failed", failure=kind, error=text[:4000])
            if text.startswith(kind + ":"):
                raise
            raise AssertionError(f"{kind}: {name}: {text}") from error
        self.log("step", step=name, act="end")

    def server_eq(self, actual: Any, expected: Any, what: str) -> None:
        if actual != expected:
            raise AssertionError(f"server: {what}: {actual!r} != {expected!r}")

    def screen_ok(self, condition: bool, what: str) -> None:
        if not condition:
            raise AssertionError(f"screen: {what}")

    def harness_ok(self, condition: bool, what: str) -> None:
        if not condition:
            raise AssertionError(f"harness: {what}")

    def until(self, predicate, what: str, page: Any, timeout: float = 20.0) -> None:
        """Wait for a server answer or an arrival the case's own action caused; never for time to pass."""
        deadline = time.monotonic() + timeout
        while not predicate():
            if time.monotonic() > deadline:
                raise AssertionError(f"harness: waited {timeout:.0f}s for {what}")
            page.wait_for_timeout(40)

    def harvest(self) -> None:
        for sess in self.sessions:
            sess.wire.harvest()

    # ── studies, messages and sessions ──

    def approved_study(self, tag: str) -> Fixture:
        """E-04: a new synthetic study, approved v1 by S through the setup API; its ledger starts empty."""
        fixture = self.stack.create_fixture()
        self.case_studies.append(fixture)
        self.check(self.commit(fixture.uid, "doctor", "approve", 0, findings=f"SYNTHETIC U2b {self.run} {tag} findings v1.",
                               conclusion=f"SYNTHETIC U2b {self.run} {tag} conclusion v1."), 201)
        self.mark_change()
        self.server_eq(critical_ledger(fixture.uid), {"records": 0, "events": 0, "receipts": 0, "audits": 0}, f"{tag} ledger")
        self.log("study", tag=tag, uid=fixture.uid, patient=fixture.patient_id)
        return fixture

    def addendum(self, fixture: Fixture, tag: str) -> None:
        self.check(self.commit(fixture.uid, "doctor", "addendum", 1, findings=f"SYNTHETIC U2b {self.run} {tag} findings v2.",
                               conclusion=f"SYNTHETIC U2b {self.run} {tag} conclusion v2."), 201)
        self.mark_change()
        self.version_cache.pop(fixture.uid, None)

    def distinct_studies(self) -> None:
        """E-04: the case's studies differ in patient ID and name and none is part of another - the K2/K3/K4 premise."""
        names = {f.uid: "INVARIANT " + f.secret[len("REPORT-"):][:10] for f in self.case_studies}
        for one in self.case_studies:
            for other in self.case_studies:
                if one is other:
                    continue
                self.harness_ok(one.patient_id not in other.patient_id and one.patient_id not in names[other.uid]
                                and names[one.uid] not in names[other.uid] and names[one.uid] not in other.patient_id,
                                f"study identities {one.patient_id} and {other.patient_id} overlap")

    def message(self) -> str:
        # A trailing full stop, so no message is a part of another (#1. is not in #10.).
        self.messages += 1
        return f"SYNTHETIC U2b {self.run} #{self.messages}."

    def versions_of(self, fixture: Fixture) -> list[dict]:
        if fixture.uid not in self.version_cache:
            self.version_cache[fixture.uid] = self.versions(fixture)
        return self.version_cache[fixture.uid]

    def sign_in(self, logical: str, label: str, *, clock: bool = False) -> Session:
        """E-03: a new browser context per identity, the real BFF login form, the page the product lands on. The page clock is
        installed before the first page exists when the case controls time with it."""
        with self.step(f"E-03 {label}"):
            context = self.browser.new_context(ignore_https_errors=True, viewport={"width": 1600, "height": 1050})
            self.contexts.append(context)
            wire = Wire(self, label)
            wire.attach(context)
            if clock:
                context.clock.install()
            page = context.new_page()
            wire.name(page, label)
            page.set_default_timeout(20000)
            sess = Session(logical=logical, label=label, context=context, page=page, wire=wire)
            self.sessions.append(sess)
            since = self.n
            page.goto(self.stack.proxy + "/")
            self.submit_login(page, logical)
            self.landed(sess, since)
        return sess

    def submit_login(self, page: Any, logical: str) -> None:
        try:
            page.locator("#username").fill(self.stack.username(logical))
            page.locator("#password").fill(self.stack.passwords[logical])
            page.locator("#kc-login").click()
        except Exception:
            # Playwright's call log can include fill() values; never print credentials.
            raise AssertionError("harness: the real BFF login form could not be submitted") from None

    def landed(self, sess: Session, since: int) -> None:
        page = sess.page
        if sess.logical in CLINICIAN_ONLY:
            page.wait_for_url("**/worklist/hpacs-lite/clinician.html", timeout=30000)
            expect(page.get_by_role("heading", name="Clinician Home", exact=True)).to_be_visible()
        else:
            page.wait_for_url("**/worklist/hpacs-lite/main.html", timeout=30000)
            expect(page.locator("#dbstat")).to_contain_text("DB Connected")
            expect(page.locator("#roles")).to_contain_text("technician" if sess.logical == "tech" else "radiologist")
        label, landing = sess.wire.label(page), urlsplit(page.url).path

        def answers() -> list[dict]:
            return [entry for entry in sess.wire.me if entry["n"] > since and entry["page"] == label and answered(entry)
                    and entry["status"] == 200]
        # The landing page's own /api/me, not the first one answered: a redirecting main.html's answer arrives first and
        # its body may no longer be readable, which read as "another identity" (hosted run 36540533271, CRS-04 E-03 P).
        try:
            self.until(lambda: any(entry["doc"] == landing for entry in answers()),
                       f"{sess.label}: the landing page's own /api/me", page)
        finally:
            sess.wire.harvest()
            self.log("me", context=sess.label, landing=landing, answers=[
                {"n": entry["n"], "doc": entry["doc"], "readable": isinstance(entry["json"], dict),
                 "sub": entry["json"].get("sub") if isinstance(entry["json"], dict) else None} for entry in answers()])
        readable = [entry for entry in answers() if isinstance(entry["json"], dict)]
        own = [entry for entry in readable if entry["doc"] == landing]
        self.harness_ok(bool(own), f"{sess.label}: the landing page's /api/me answer could not be read")
        # Every readable answer since the login, the redirecting page's included, names this identity.
        self.harness_ok(all(entry["json"].get("sub") == self.stack.user_ids[sess.logical] for entry in readable),
                        f"{sess.label}: /api/me is another identity")
        me = own[0]["json"]
        sess.owner = [me.get("institution"), me.get("sub")]
        sess.wire.sub = me.get("sub")
        for cookie in sess.context.cookies():
            self.cookie_values.add(str(cookie.get("value") or ""))
        self.log("session", context=sess.label, logical=sess.logical, sub=me.get("sub"), institution=me.get("institution"))

    def open_page(self, sess: Session, label: str) -> Any:
        """Another page of the same context through the public entry (main.html; a clinician-only session lands on its home)."""
        page = sess.context.new_page()
        sess.wire.name(page, label)
        page.set_default_timeout(20000)
        page.goto(self.stack.proxy + "/worklist/hpacs-lite/main.html")
        if sess.logical in CLINICIAN_ONLY:
            page.wait_for_url("**/worklist/hpacs-lite/clinician.html", timeout=30000)
            expect(page.get_by_role("heading", name="Clinician Home", exact=True)).to_be_visible()
        else:
            expect(page.locator("#dbstat")).to_contain_text("DB Connected")
        return page

    def session_read(self, sess: Session, path: str) -> dict:
        """A verification GET with this page's own session binding and context cookies (no Authorization). It
        never passes a route handler, so it is the server's real answer to that session even while a variant is active."""
        response = document_request(sess.page, "GET", self.stack.api + path, headers={"X-KIN-CSRF": "1"})
        try:
            data = response.json()
        except Exception:
            data = None
        return {"status": response.status, "json": data}

    # ── waits on the recorder ──

    def answer(self, sess: Session, route: str, since: int, what: str, *, page: Any = None, target: str | None = None,
               view: str | None = None, timeout: float = 20.0) -> dict:
        """The first request of `route` sent after tick `since` from the page, once the page received its answer or failure."""
        label = sess.wire.label(page or sess.page)

        def find() -> dict | None:
            return next((entry for entry in sess.wire.entries if entry["n"] > since and entry["route"] == route
                         and entry["page"] == label and (target is None or entry["target"] == target)
                         and (view is None or view_of(entry) == view) and entry["state"] != "out"), None)
        self.until(lambda: find() is not None, f"{label}: {what}", page or sess.page, timeout)
        self.harvest()
        return find()

    def quiet(self, sess: Session, page: Any = None) -> None:
        label = sess.wire.label(page or sess.page)
        self.until(lambda: not sess.wire.outstanding(label), f"{label}: critical result requests to finish", page or sess.page)

    def posts(self, sess: Session, route: str | None = None, target: str | None = None, after: int = 0) -> list[dict]:
        return [entry for entry in sess.wire.entries if entry["route"] in WRITE_ROUTES and entry["n"] > after
                and (route is None or entry["route"] == route) and (target is None or entry["target"] == target)]

    # ── screens: roles and accessible names only (test-plan principle 4) ──

    def inbox(self, page: Any) -> Any:
        return page.get_by_role("region", name="Critical Results", exact=True)

    def rows(self, page: Any) -> Any:
        return self.inbox(page).get_by_role("list", name="Received Critical Results", exact=True).get_by_role("listitem")

    def lines(self, page: Any) -> Any:
        return self.inbox(page).get_by_role("list", name="Unconfirmed Acknowledgements", exact=True).get_by_role("listitem")

    def sent_lines(self, page: Any) -> Any:
        return page.get_by_role("list", name="Unconfirmed Critical Result Requests", exact=True).get_by_role("listitem")

    def sent_region(self, page: Any) -> Any:
        return page.get_by_role("region", name="Sent Critical Results", exact=True)

    def sent_pane(self, page: Any) -> Any:
        return page.get_by_role("region", name="Sent Critical Results List", exact=True)

    def stable(self, read, page: Any) -> Any:
        """Read the screen until two consecutive reads agree, so one snapshot never mixes two paints."""
        last = read()
        for _ in range(8):
            page.wait_for_timeout(30)
            now = read()
            if now == last:
                return now
            last = now
        raise AssertionError("harness: the screen kept changing while it was read")

    def recipient_screen(self, page: Any) -> dict:
        region = self.inbox(page)

        def read() -> dict:
            rows = []
            for item in self.rows(page).all():
                text = item.inner_text()
                acks = item.get_by_role("button", name="Acknowledge", exact=True).all()
                rows.append({"text": text, "words": words(text, ROW_WORDS), "times": ack_times(text),
                             "ack": sum(1 for button in acks if button.is_enabled()), "ack_all": len(acks),
                             "replacement": item.get_by_role("button", name="Open Replacement", exact=True).count() > 0})
            lines = []
            for item in self.lines(page).all():
                text = item.inner_text()
                lines.append({"text": text, "words": words(text, LINE_WORDS),
                              "check": item.get_by_role("button", name="Check Again", exact=True).count() > 0})
            statuses = [text.strip() for text in region.get_by_role("status").all_inner_texts()]
            return {"rows": rows, "lines": lines, "badge": next((text for text in statuses if BADGE.fullmatch(text)), None)}
        return self.stable(read, page)

    def sender_screen(self, page: Any) -> dict:
        def read() -> dict:
            dialog = page.get_by_role("dialog", name="Send Critical Result")
            view = None
            if dialog.count():
                text = dialog.get_by_role("status").inner_text()
                view = {"text": text, "words": words(text, SEND_WORDS),
                        "check": dialog.get_by_role("button", name="Check Again", exact=True).count() > 0}
            lines = []
            for item in self.sent_lines(page).all():
                text = item.inner_text()
                lines.append({"text": text, "words": words(text, SEND_WORDS),
                              "check": item.get_by_role("button", name="Check Again", exact=True).count() > 0})
            rows = []
            pane = self.sent_pane(page)
            if pane.count():
                table = pane.get_by_role("table")
                headers = [text.strip() for text in table.get_by_role("columnheader").all_inner_texts()]
                for row in table.get_by_role("row").all():
                    cells = row.get_by_role("cell").all_inner_texts()
                    if len(cells) != len(headers):
                        continue            # the header row and an open Supersede / Cancel Delivery form
                    cell = dict(zip(headers, cells))
                    rows.append({"study": cell["Study"], "recipient": cell["Recipient"], "source": cell["Source"],
                                 "state": cell["State"], "words": words(cell["State"], SENT_WORDS),
                                 "marks": words(cell["State"], MARK_WORDS),
                                 "actions": [name for name in ("Supersede", "Cancel Delivery")
                                             if row.get_by_role("button", name=name, exact=True).count()]})
            return {"dialog": view, "sent_lines": lines, "sent_rows": rows}
        return self.stable(read, page)

    # ── the judge at a checkpoint ──

    def facts(self) -> dict:
        """psql: the case studies' records, receipts and events, one statement."""
        values = ",".join(sql_text(fixture.uid) for fixture in self.case_studies) or "''"
        # json_agg separates its elements with a line break, so the one value spans lines of psql's output.
        raw = "\n".join(psql(
            "SELECT json_build_object("
            f"'records', (SELECT coalesce(json_agg(json_build_object('id', r.id, 'studyUid', r.\"studyUid\", 'state', r.state, "
            "'revision', r.revision, 'sourceVersion', r.\"sourceVersion\", 'message', r.message, 'cancelReason', r.\"cancelReason\", "
            "'recipientSub', r.\"recipientSub\", 'senderSub', r.\"senderSub\", 'supersedesId', r.\"supersedesId\", "
            f"'acknowledgedAt', r.\"acknowledgedAt\")), '[]'::json) FROM \"CriticalResult\" r WHERE r.\"studyUid\" IN ({values})), "
            "'receipts', (SELECT coalesce(json_agg(json_build_object('requestId', c.\"requestId\", 'recordId', c.\"recordId\", "
            "'subjectSub', c.\"subjectSub\", 'action', c.action)), '[]'::json) FROM \"CriticalResultReceipt\" c "
            f"JOIN \"CriticalResult\" r ON r.id = c.\"recordId\" WHERE r.\"studyUid\" IN ({values})), "
            "'events', (SELECT coalesce(json_agg(json_build_object('recordId', e.\"recordId\", 'event', e.event, "
            "'actorSub', e.\"actorSub\", 'actorRole', e.\"actorRole\", 'requestId', e.\"requestId\")), '[]'::json) "
            f"FROM \"CriticalResultEvent\" e JOIN \"CriticalResult\" r ON r.id = e.\"recordId\" WHERE r.\"studyUid\" IN ({values})))::text"))
        data = json.loads(raw)
        return {"records": {str(row["id"]).lower(): row for row in data["records"]}, "receipts": data["receipts"],
                "events": data["events"]}

    def contents(self, server: dict) -> list[str]:
        """What a stub row must not show: every run message, every cancel reason, every report text of the case studies."""
        texts = [row.get("message") for row in server["records"].values()] + [row.get("cancelReason") for row in server["records"].values()]
        for fixture in self.case_studies:
            for version in self.versions_of(fixture):
                texts += [version.get(key) for key in ("findings", "conclusion", "recommendation")]
        return sorted({text for text in texts if isinstance(text, str) and text.strip()})

    def writes(self) -> list[dict]:
        """Every POST a page of the case sent, whether it reached the server and the server's status: a handler's
        fetch-then-cut reached it, a made-up answer or a cut held create did not, otherwise the page's own answer decides."""
        verdicts: dict[int, tuple] = {}
        for row in self.handled:
            if row.get("entry") is None:
                continue
            if row["act"] == "fetch-abort":
                verdicts[row["entry"]] = (True, row.get("status"))
            elif row["act"] in ("fulfill", "grab", "abort-held-post"):
                verdicts[row["entry"]] = (False, None)
        out = []
        for sess in self.sessions:
            for entry in sess.wire.entries:
                if entry["route"] not in WRITE_ROUTES:
                    continue
                if entry["n"] in verdicts:
                    reached, status = verdicts[entry["n"]]
                elif answered(entry):
                    reached, status = True, entry["status"]
                else:
                    reached, status = None, None
                out.append({"requestId": request_id(entry), "ctx": entry["ctx"], "page": entry["page"], "route": entry["route"],
                            "target": entry["target"], "sub": entry["sub"], "reached": reached, "status": status, "n": entry["n"]})
        return out

    def settled(self, sess: Session, page: Any, role: str) -> None:
        """test-plan 6.2 `settled`: nothing of this page in flight (holds included), and its newest list answer was sent after
        the last server change."""
        label = sess.wire.label(page)
        view = "received" if role == "recipient" else "sent"

        def ready() -> bool:
            newest = max((entry["n"] for entry in sess.wire.entries if entry["page"] == label and entry["route"] == "#3"
                          and view_of(entry) == view and answered(entry)), default=0)
            return not sess.wire.outstanding(label) and newest > self.change_n
        # The page's own read after the step's write or Refresh (an arrival the case caused), never a period.
        self.until(ready, f"{label}: a {view} list read after the last server change and nothing in flight (settled)", page)

    def judge(self, name: str, sess: Session, kind: str, *, role: str, page: Any = None, expected: tuple = (),
              shows: dict | None = None) -> dict:
        """One checkpoint: screen, the page's received answers, handler records and server facts into problems(); the result
        must be exactly `expected` ([] on the main path, the named problem of a violating variant). `shows` names the records
        a settled All list must show, each exactly once (rule U5)."""
        page = page or sess.page
        # An in-flight screen may not know a server change yet, so no list of it is asked to show named records.
        self.harness_ok(not shows or kind == "settled", f"{name}: records named for a {kind} checkpoint")
        if kind == "settled":
            self.settled(sess, page, role)
        screen = self.recipient_screen(page) if role == "recipient" else self.sender_screen(page)
        self.harvest()
        label = sess.wire.label(page)
        cp = {"id": name, "case": self.case, "kind": kind, "role": role, "page": label, "owner": sess.owner, "screen": screen,
              "net": [dict(entry) for entry in sess.wire.entries if entry["page"] == label], "writes": self.writes(),
              "server": self.facts(), "studies": {fixture.uid: fixture.patient_id for fixture in self.case_studies}}
        if shows:
            cp["shows"] = {what: sorted(records) for what, records in shows.items()}
        cp["contents"] = self.contents(cp["server"])
        record = {k: v for k, v in cp.items() if k != "net"}
        record["net"] = [entry["n"] for entry in cp["net"]]
        try:
            mapping = correspond(cp)
        except Unmatched as error:
            self.log("checkpoint", checkpoint=record, unmatched=error.kind, detail=error.detail)
            raise AssertionError(f"{error.kind}: {name}: {error.detail}") from None
        items = {record_id: self.session_read(sess, f"/critical-results/{record_id}")
                 for record_id in sorted(set(mapping["rows"]) | set(mapping["lines"]))}
        view, state = ("received", sess.recv_filter) if role == "recipient" else ("sent", sess.sent_filter)
        cp["reads"] = {"list": self.session_read(sess, f"/critical-results?view={view}&state={state}"), "items": items}
        found = problems(cp)
        record.update(reads=cp["reads"], mapping=mapping, problems=found, expected=sorted(expected))
        self.log("checkpoint", checkpoint=record)
        if found != sorted(expected):
            kinds = "/".join(sorted({PROBLEM_KIND[problem] for problem in set(found) ^ set(expected)}))
            raise AssertionError(f"{kinds}: {name}: problems {found}, expected {sorted(expected)}")
        return cp

    def pure(self, name: str, cp: dict, expected: list[str]) -> None:
        """A variant of a recorded checkpoint, judged without a browser (JV-*, MU-H)."""
        try:
            found = problems(cp)
        except Unmatched as error:
            found = [f"unmatched:{error.kind}"]
        self.log("pure", variant=name, problems=found, expected=expected)
        self.harness_ok(found == expected, f"{name}: the judge answered {found}, expected {expected}")

    # ── sender screen actions ──

    def mark_cvr(self, page: Any) -> Any:
        mark = page.get_by_role("button", name="Mark CVR", exact=True)
        if not mark.is_visible():
            page.get_by_label("More Report Actions", exact=True).filter(visible=True).first.click()
            expect(mark).to_be_visible()
        return mark

    def choose(self, sess: Session, fixture: Fixture, page: Any = None) -> None:
        """S picks the study in its worklist (the existing WorklistE2E.select) and the #1 read for it is answered."""
        page = page or sess.page
        since = self.n
        self.select(page, fixture)
        read = self.answer(sess, "#1", since, f"#1 for {fixture.patient_id}", page=page, target=fixture.uid)
        self.server_eq((read["status"], (read["json"] or {}).get("sendable")), (200, True), "#1 answer")

    def open_dialog(self, sess: Session, fixture: Fixture, page: Any = None) -> tuple[Any, dict]:
        page = page or sess.page
        mark = self.mark_cvr(page)
        expect(mark).to_be_enabled()
        since = self.n
        mark.click()
        dialog = page.get_by_role("dialog", name="Send Critical Result")
        expect(dialog).to_be_visible()
        read = self.answer(sess, "#1", since, "the dialog's #1", page=page, target=fixture.uid)
        self.server_eq(read["status"], 200, "the dialog's #1")
        expect(dialog.get_by_role("button", name="Send", exact=True)).to_be_enabled()
        return dialog, read["json"] or {}

    def fill_and_send(self, dialog: Any, logical: str, message: str) -> None:
        field = dialog.get_by_label("Recipient", exact=True)
        actor = self.stack.actor(logical)
        options = [text for text in field.get_by_role("option", include_hidden=True).all_inner_texts() if names(actor, text)]
        self.screen_ok(len(options) == 1, f"one Recipient option names {logical}'s account, got {len(options)}")
        field.select_option(label=options[0])
        dialog.get_by_label("Message", exact=True).fill(message)
        dialog.get_by_role("button", name="Send", exact=True).click()

    def close_dialog(self, page: Any) -> None:
        dialog = page.get_by_role("dialog", name="Send Critical Result")
        dialog.get_by_role("button", name="Close", exact=True).click()
        expect(dialog).to_be_hidden()

    def deliver(self, sess: Session, fixture: Fixture, logical: str, message: str, *, page: Any = None) -> str:
        """A plain delivery on the screen (Mark CVR -> Recipient -> Message -> Send -> Delivered); the record's id."""
        page = page or sess.page
        dialog, _ = self.open_dialog(sess, fixture, page)
        since = self.n
        self.fill_and_send(dialog, logical, message)
        post = self.answer(sess, "#2", since, "the create", page=page, target=fixture.uid)
        self.server_eq(post["status"], 201, "create")
        expect(dialog.get_by_role("status")).to_contain_text("Delivered")
        self.answer(sess, "#3", post["n"], "the sent list after Delivered", page=page, view="sent")
        self.close_dialog(page)
        return request_id(post)

    def show_sent(self, sess: Session, page: Any = None) -> Any:
        page = page or sess.page
        pane = self.sent_pane(page)
        if not pane.count():
            self.sent_region(page).get_by_role("button", name="Show Sent", exact=True).click()
        expect(pane).to_be_visible()
        return pane

    def sent_filter(self, sess: Session, label: str, value: str) -> None:
        since = self.n
        self.sent_pane(sess.page).get_by_label("State", exact=True).select_option(label=label)
        self.answer(sess, "#3", since, f"the sent list, {label}", view="sent")
        sess.sent_filter = value

    def sent_refresh(self, sess: Session, page: Any = None) -> dict:
        page = page or sess.page
        since = self.n
        self.sent_region(page).get_by_role("button", name="Refresh", exact=True).click()
        return self.answer(sess, "#3", since, "the sent list after Refresh", page=page, view="sent")

    def sent_row(self, page: Any, fixture: Fixture, version: int) -> Any:
        """The sent-list row of a study and pinned Source version (K4) as a locator for its actions. The version token is
        looked for in one cell's own text: a row's text joins its cells with nothing between them (`Cancel Deliveryv1`,
        `08:07v1`), so a pattern over the whole row cannot see where the Source cell starts (hosted run 36540533271, S-04
        and V-03 found no row while the row was on screen)."""
        version_cell = page.get_by_role("cell").filter(has_text=re.compile(rf"(?<![0-9A-Za-z])v{version}(?![0-9])"))
        found = (self.sent_pane(page).get_by_role("table").get_by_role("row").filter(has_text=fixture.patient_id)
                 .filter(has=version_cell))
        expect(found).to_have_count(1)
        return found

    # ── recipient screen actions ──

    def first_list(self, sess: Session, page: Any = None, since: int = 0) -> dict:
        return self.answer(sess, "#3", since, "the first received list", page=page, view="received")

    def recv_refresh(self, sess: Session, page: Any = None) -> dict:
        page = page or sess.page
        since = self.n
        self.inbox(page).get_by_role("button", name="Refresh", exact=True).click()
        return self.answer(sess, "#3", since, "the received list after Refresh", page=page, view="received")

    def show_all(self, sess: Session, on: bool) -> None:
        button = self.inbox(sess.page).get_by_role("button", name="Show All", exact=True)
        since = self.n
        button.click()
        expect(button).to_have_attribute("aria-pressed", "true" if on else "false")
        self.answer(sess, "#3", since, "the received list after Show All", view="received")
        sess.recv_filter = "all" if on else "pending"

    def pause(self, sess: Session) -> None:
        now = sess.page.evaluate("() => Date.now()")
        sess.context.clock.pause_at(now + 1000)
        sess.paused = True
        self.log("clock", context=sess.label, act="pause_at", fake_ms=now + 1000)

    def resume(self, sess: Session) -> None:
        sess.context.clock.resume()
        sess.paused = False
        self.log("clock", context=sess.label, act="resume")

    # ── control windows and variants (test-plan 6.4) ──

    def sender_window(self, sess: Session, fixture: Fixture, *, clock: bool) -> Control:
        """W-S entry E0-E2: (E0, CRS-01) pause the S clock, (E1) register hp/hr3/hr4/hr5, (E2) drain the requests sent
        before registration. E3 is the caller's click; E4/E5 are sender_post()."""
        if clock:
            self.pause(sess)
        control = Control(self, sess, "W-S")
        control.add("hp", is_(route="#2", target=fixture.uid), "grab")
        control.add("hr3", is_(route="#3", view="sent"), "hold")
        control.add("hr4", is_(route="#4"), "hold_q")
        control.add("hr5", is_(route="#5", target=fixture.uid), "hold")
        control.start()
        control.drain("W-S drain (E2)")
        return control

    def sender_post(self, sess: Session, control: Control) -> dict:
        """E4: with the create held, release in order what the handlers caught before it and wait for the page's answers
        (the create has not reached the server, so they cannot carry it). E5: forward the create, cut the page's answer."""
        self.until(lambda: control.grabbed is not None, "hp holds the create (E4)", sess.page)
        control.release(before=control.grabbed["n"])
        self.harness_ok(not [hold for hold in control.held if hold["n"] < control.grabbed["n"]], "a hold caught before the POST remains")
        control.forward_and_cut()
        post = control.entry(control.grabbed["entry"])
        self.until(lambda: post is not None and post["state"] == "failed", "the page's create to end without an answer (E5)", sess.page)
        return post

    def recipient_window(self, sess: Session, record: str, page: Any = None) -> Control:
        """W-P: h1 forwards the one ACK and cuts its answer, hr4 holds the record's #4; registered before the click, then drain."""
        control = Control(self, sess, "W-P")
        control.add("h1", is_(route="#6", target=record), "forward_cut")
        control.add("hr4", is_(route="#4", target=record), "hold")
        control.start()
        control.drain("W-P drain", sess.wire.label(page or sess.page))
        return control

    def list_variant(self, sess: Session, name: str, change, step: str, expected: tuple) -> None:
        """MU-C/D/E/F: this context's received-list answers changed by `change`; judged; then the handler removed and the
        list re-read (Refresh is the contract's re-read, a projection boundary) and judged again."""
        control = Control(self, sess, name)
        control.add(name, is_(route="#3", view="received"), "modify", change=change)
        control.start()
        try:
            self.recv_refresh(sess)
            self.judge(step, sess, "settled", role="recipient", expected=expected)
            # The route handler touches page requests only (test-plan section 2): the session's own read is the server's list.
            state = self.session_read(sess, f"/critical-results?view=received&state={sess.recv_filter}")
            changed = [row["json"] for row in self.handled if row["control"] == name and row["act"] == "modify"][-1]
            self.harness_ok(state["json"] != changed, f"{name}: the session read answered the changed list")
        finally:
            control.close()
        self.recv_refresh(sess)
        self.judge(step + " cleanup", sess, "settled", role="recipient")

    def ledger_is(self, fixture: Fixture, records: int, events: int, receipts: int, audits: int, what: str) -> None:
        ledger = critical_ledger(fixture.uid)
        self.log("ledger", step=what, study=fixture.patient_id, value=ledger)
        self.server_eq(ledger, {"records": records, "events": events, "receipts": receipts, "audits": audits},
                       f"{what} ledger of {fixture.patient_id}")

    @contextmanager
    def controlled(self):
        """test-plan 6.4 rule 5: on every path every control, held create, hold and paused clock is undone; on a path that
        has not failed yet, anything left is itself the case's (harness) failure."""
        failed = False
        try:
            yield
        except BaseException:
            failed = True
            raise
        finally:
            left, errors = self.release_all()
            self.log("cleanup", left=left, errors=errors, handler_errors=self.handler_errors,
                     wire_errors=[error for sess in self.sessions for error in sess.wire.errors])
            if not failed and (left or errors or self.handler_errors):
                raise AssertionError(f"harness: left after the case: {left + errors + self.handler_errors}")

    def release_all(self) -> tuple[list[str], list[str]]:
        left: list[str] = []
        errors: list[str] = []
        for control in reversed(self.controls):
            more, failed = control.cleanup()
            left += more
            errors += failed
        for sess in self.sessions:
            if sess.paused:
                left.append(f"{sess.label}: clock still paused")
                try:
                    self.resume(sess)
                except Exception as error:
                    errors.append(f"{sess.label} resume: {type(error).__name__}")
        for sess in self.sessions:
            try:
                open_pages = [page for page in sess.context.pages if not page.is_closed()]
                if open_pages:
                    self.until(lambda: not [entry for entry in sess.wire.entries if entry["state"] == "out"
                                            and sess.wire.label(sess.page) == entry["page"]],
                               f"{sess.label}: released requests", open_pages[0], timeout=10)
            except Exception as error:
                errors.append(f"{sess.label}: {error}")
        return left, errors

    # ── evidence (E-08) ──

    def failed(self) -> bool:
        result = self._outcome.result
        failures = result.failures + result.errors + [
            (test, error) for test, error in getattr(self._outcome, "errors", []) if error]
        return any(test is self for test, _ in failures)

    def secrets(self) -> list[str]:
        values = set(self.cookie_values) | {str(value) for value in self.stack.passwords.values()}
        values |= {str(value) for value in self.stack.tokens.values()}
        for sess in self.sessions:
            try:
                values |= {str(cookie.get("value") or "") for cookie in sess.context.cookies()}
            except Exception:
                pass
        return sorted(value for value in values if len(value) >= 8)

    def har(self) -> dict:
        """HAR 1.2 of the critical result routes only, built from the recorder: no cookie, no Authorization, no login POST;
        headers are content-type and x-kin-csrf only."""
        entries = []
        for sess in self.sessions:
            for entry in sess.wire.entries:
                self.harness_ok(route_of(entry["method"], entry["path"]) is not None, "a request outside the routes reached the HAR")
                query = urlencode(entry["query"], doseq=True)
                request = {"method": entry["method"], "url": self.stack.proxy + entry["path"] + ("?" + query if query else ""),
                           "httpVersion": "HTTP/1.1", "cookies": [], "queryString": [], "headersSize": -1,
                           "bodySize": len(entry["body"] or ""),
                           "headers": ([{"name": "content-type", "value": "application/json"}] if entry["body"] else [])
                           + ([{"name": "x-kin-csrf", "value": entry["csrf"]}] if entry["csrf"] else [])}
                if entry["body"]:
                    request["postData"] = {"mimeType": "application/json", "text": entry["body"]}
                text = json.dumps(entry["json"], ensure_ascii=False) if entry["json"] is not None else ""
                entries.append({"startedDateTime": entry["wall"], "time": -1, "request": request, "response": {
                    "status": entry["status"] or 0, "statusText": "", "httpVersion": "HTTP/1.1", "cookies": [],
                    "headers": [{"name": "content-type", "value": "application/json"}] if text else [], "redirectURL": "",
                    "content": {"size": len(text), "mimeType": "application/json", "text": text}, "headersSize": -1, "bodySize": -1},
                    "cache": {}, "timings": {"send": 0, "wait": 0, "receive": 0},
                    "_kin": {"context": entry["ctx"], "page": entry["page"], "n": entry["n"], "done": entry["done"],
                             "state": entry["state"], "failure": entry["failure"], "authorization": entry["authorization"]}})
        return {"log": {"version": "1.2", "creator": {"name": "S7-U2b recorder", "version": "1"}, "entries": entries}}

    def shot(self, page: Any, name: str) -> None:
        folder = SCREENS_EVIDENCE / self.case
        folder.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(folder / f"{name}.png"))
        self.log("screenshot", name=name)

    def tearDown(self) -> None:
        failure = None
        try:
            self.write_evidence()
        except Exception as error:
            failure = error
        super().tearDown()
        if failure is not None:
            raise failure

    def write_evidence(self) -> None:
        folder = SCREENS_EVIDENCE / self.case
        folder.mkdir(parents=True, exist_ok=True)
        if self.failed():
            for sess in self.sessions:
                for index, page in enumerate(list(sess.context.pages)):
                    if any(path in page.url for path in AUTHENTICATED_PAGES):
                        try:
                            page.screenshot(path=str(folder / f"failure-{sess.label}-{index}.png"))
                        except Exception as error:
                            self.log("screenshot", failure=f"{type(error).__name__}")
        self.harvest()
        secrets = self.secrets()
        texts = {folder / "network.har": json.dumps(self.har(), ensure_ascii=False, indent=1),
                 folder / "steps.jsonl": "".join(json.dumps(step, ensure_ascii=False, default=str) + "\n" for step in self.steps)}
        if self.not_run_record is not None:
            texts[SCREENS_EVIDENCE / "not-run.json"] = json.dumps(self.not_run_record, ensure_ascii=False, indent=1)
        refused = []
        for path, text in texts.items():
            leak = next((f"secret value of {len(value)} characters" for value in secrets if value in text), None)
            if leak is None and JWT_SHAPE.search(text):
                leak = "a JWT-shaped value"
            if leak:
                refused.append(f"{path.name}: {leak}")
                continue
            path.write_text(measurement_ci.sanitize(text, secrets), encoding="utf-8")
        self.write_manifest()
        if refused:
            raise AssertionError("harness: the evidence leak check refused " + "; ".join(refused))

    def write_manifest(self) -> None:
        try:
            head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, timeout=30).stdout.strip()
        except Exception:
            head = None
        files = []
        for path in sorted(SCREENS_EVIDENCE.rglob("*")):
            if not path.is_file() or path == SCREENS_EVIDENCE / "manifest.json":
                continue
            data = path.read_bytes()
            relative = path.relative_to(SCREENS_EVIDENCE).as_posix()
            files.append({"path": relative, "case": relative.split("/")[0] if "/" in relative else None,
                          "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)})
        (SCREENS_EVIDENCE / "manifest.json").write_text(json.dumps({
            "head": head or None, "github_run_id": os.environ.get("GITHUB_RUN_ID"),
            "github_run_attempt": os.environ.get("GITHUB_RUN_ATTEMPT"), "files": files}, indent=1), encoding="utf-8")

    def not_run(self) -> None:
        """E-07 (D-S7-13 a): the per-study StudyAccess withdrawal of a clinician is recorded as data, never as a skip
        (scripts/run-tests.py refuses a plan with a skipped case)."""
        try:
            head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, timeout=30).stdout.strip()
        except Exception:
            head = None
        self.not_run_record = {
            "id": "NR-S7-U2b-CLINICIAN-STUDYACCESS", "requirement": ["TEST-S7-U2b-E2E", "RISK-S7-CVR-REVOKED-ACK"],
            "decision": "D-S7-13 (a)",
            "reason": ("임상의에게는 검사 단위 StudyAccess를 걸 수 없다(api/src/study-access.service.ts target()은 admin·radiologist·"
                       "technician만 관리한다) — 계약 §9 표 'StudyAccess 제한(clinician-only)', §17 L-5"),
            "substitute": "CRS-02 institution group move", "backlog": "Stage 9", "product_sha": head or None, "recorded_at": now_iso()}
        print("NOT_RUN " + json.dumps(self.not_run_record, ensure_ascii=False), flush=True)
        self.log("not-run", record=self.not_run_record)

    # ── end-of-case facts (I-01, I-02, K1 premise) ──

    def written_through_pages(self) -> None:
        """I-01: every critical result write of the case is a page POST of a cookie session: X-KIN-CSRF 1, no Authorization."""
        for sess in self.sessions:
            for entry in self.posts(sess):
                self.harness_ok(entry["csrf"] == "1" and not entry["authorization"],
                                f"{sess.label}: a write without the cookie-session headers (#{entry['n']})")

    def distinct_messages(self) -> None:
        messages = [row["message"] for row in self.facts()["records"].values()]
        self.harness_ok(len(messages) == len(set(messages)), "two run records share a message (K1)")

    # ═══ the six cases (test-plan section 3) ═══

    def test_crs01_two_sessions_send_list_refuse_acknowledge_replay_supersede_cancel(self) -> None:
        """CRS-01: S sends from main.html, P reads and acknowledges on clinician.html, W is offered nothing; a lost create is
        proved by the same-bytes Check Again inside W-S; a head move turns P's row into a stub; supersede, cancel, late ACK."""
        with self.controlled():
            with self.step("I-03"):
                for write in (self.send, self.ack, self.cancel, self.supersede):
                    with self.assertRaises(AssertionError):
                        write("doctor", "2.25.1", "clinician", 1)
                vectors = judge_vectors()
                self.log("pure", variant="JV-01..JV-20 (synthetic)", rows=vectors)
                self.harness_ok(all(row["got"] == row["want"] for row in vectors),
                                f"judge vectors: {[row for row in vectors if row['got'] != row['want']]}")
            with self.step("E-04"):
                u1, u1s = self.approved_study("U1"), self.approved_study("U1s")
                self.distinct_studies()
            s = self.sign_in("doctor", "S", clock=True)
            with self.step("S-01"):
                # Before any study is chosen the button sits in the closed More menu: off, whether seen or not.
                expect(s.page.get_by_role("button", name="Mark CVR", exact=True, include_hidden=True)).to_be_disabled()
                self.choose(s, u1)
                expect(self.mark_cvr(s.page)).to_be_enabled()
            with self.step("S-02"):
                dialog, offered = self.open_dialog(s, u1)
                source = offered.get("source") or {}
                self.server_eq((source.get("version"), source.get("action")), (1, "approve"), "S-02 #1 source")
                expect(dialog).to_contain_text("Source: v1 · Approve")
                candidates = self.session_read(s, f"/studies/{u1.uid}/critical-result-recipients")["json"]["recipients"]
                options = dialog.get_by_label("Recipient", exact=True).get_by_role("option", include_hidden=True).all_inner_texts()
                for row in candidates:
                    self.screen_ok(sum(names(row["actor"], option) for option in options) == 1, f"S-02: one option for {row['actor']}")
                self.screen_ok(sum(any(names(row["actor"], option) for row in candidates) for option in options) == len(candidates),
                               "S-02: the options are the #1 recipients")
                for logical in ("clinician", "clinician2", "clinician3"):
                    self.screen_ok(any(names(self.stack.actor(logical), option) for option in options), f"S-02: {logical} offered")
                for logical in ("kclinician", "tech", "doctor"):
                    self.screen_ok(not any(names(self.stack.actor(logical), option) for option in options),
                                   f"S-02: {logical} not offered")
                expect(dialog.get_by_label("Message", exact=True)).to_have_value("")
            with self.step("S-03"):
                m1 = self.message()
                since = self.n
                self.fill_and_send(dialog, "clinician", m1)
                post = self.answer(s, "#2", since, "S-03 create", target=u1.uid)
                r0 = request_id(post)
                body = body_of(post)
                self.harness_ok(sorted(body) == ["expectedOwner", "message", "recipientSub", "requestId", "sourceVersion"],
                                f"S-03 body keys {sorted(body)}")
                self.harness_ok(re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", r0) is not None,
                                "S-03 requestId is a UUID v4")
                self.harness_ok((body["expectedOwner"], body["recipientSub"], body["sourceVersion"], body["message"])
                                == (s.owner, self.sub("clinician"), 1, m1), "S-03 body values")
                self.harness_ok(post["csrf"] == "1" and not post["authorization"], "S-03 cookie session")
                applied = (post["json"] or {}).get("applied") or {}
                self.server_eq((post["status"], (post["json"] or {}).get("replayed"), applied.get("action"), applied.get("from"),
                                applied.get("to"), applied.get("revision")), (201, False, "create", None, "created", 1), "S-03 answer")
                status = dialog.get_by_role("status")
                expect(status).to_contain_text("Delivered")
                expect(status).to_contain_text(DELIVERED_TEXT)
                self.harness_ok(len(self.posts(s, "#2", u1.uid)) == 1, "S-03 one create")
                self.ledger_is(u1, 1, 1, 1, 1, "S-03")
                row = critical_row(r0)
                self.server_eq((row["state"], row["senderSub"], row["recipientSub"], row["sourceVersion"]),
                               ("created", self.sub("doctor"), self.sub("clinician"), 1), "S-03 record")
                events = self.facts()["events"]
                self.server_eq([(e["event"], e["actorSub"], e["actorRole"], str(e["requestId"]).lower()) for e in events],
                               [("created", self.sub("doctor"), "radiologist", r0)], "S-03 events")
                receipts = self.facts()["receipts"]
                self.server_eq([(str(r["requestId"]).lower(), r["subjectSub"]) for r in receipts], [(r0, self.sub("doctor"))],
                               "S-03 receipt")
                self.answer(s, "#3", post["n"], "S-03 sent list after Delivered", view="sent")
                self.judge("S-03", s, "settled", role="sender")
            with self.step("S-04"):
                self.close_dialog(s.page)
                self.show_sent(s)
                row = self.sent_row(s.page, u1, 1)
                expect(row).to_contain_text("Pending ACK")
                expect(row).to_contain_text(critical_row(r0)["recipientName"])
                expect(row).to_contain_text("Clinician")
                pending = self.session_read(s, "/critical-results?view=sent&state=pending")["json"]["pending"]
                statuses = [text.strip() for text in self.sent_region(s.page).get_by_role("status").all_inner_texts()]
                self.screen_ok(f"Pending ACK {pending}" in statuses, f"S-04 summary {statuses}, server pending {pending}")
                self.judge("S-04", s, "settled", role="sender")
            p = self.sign_in("clinician", "P", clock=True)
            with self.step("R-01"):
                self.first_list(p)
                row = self.rows(p.page).filter(has_text=m1)
                expect(row).to_have_count(1)
                item = self.session_read(p, f"/critical-results/{r0}")["json"]["item"]
                text = row.inner_text()
                version = next(v for v in self.versions_of(u1) if v["version"] == 1)
                for part in (m1, f"From {item['sender']['name']}", f"Sent {minute(item['createdAt'])}", u1.patient_id,
                             "Source: v1 · Approve", version["findings"], version["conclusion"]):
                    self.screen_ok(part in text, f"R-01 row shows {part!r}")
                expect(row.get_by_role("button", name="Acknowledge", exact=True)).to_be_enabled()
                before = self.judge("R-01", p, "settled", role="recipient")
            with self.step("RF-1"):
                delay = Control(self, p, "RF-1")
                delay.add("RF-1", is_(route="#3", view="received"), "hold")
                delay.start()
                since = self.n
                self.inbox(p.page).get_by_role("button", name="Refresh", exact=True).click()
                self.until(lambda: delay.caught("RF-1", since), "RF-1 list read held", p.page)
                p.page.wait_for_timeout(1500)          # the variant itself: the list answer 1.5 s late (test-plan 6.4 RF-1)
                delay.close()
                delay.release()
                after = self.judge("R-01 RF-1", p, "settled", role="recipient")
                self.screen_ok([row["text"] for row in after["screen"]["rows"]] == [row["text"] for row in before["screen"]["rows"]]
                               and after["screen"]["badge"] == before["screen"]["badge"], "RF-1: the same screen")
            with self.step("R-02 / T-01"):
                ledger = critical_ledger(u1.uid)
                self.show_all(p, True)
                self.show_all(p, False)
                self.recv_refresh(p)
                self.quiet(p)
                since = self.n
                p.context.clock.fast_forward(61000)
                self.log("clock", context="P", act="fast_forward", ms=61000)
                periodic = self.answer(p, "#3", since, "T-01 periodic list", view="received")
                self.harness_ok((periodic["query"].get("state") or [None])[0] == "pending", "T-01 reads the pending list")
                self.harness_ok(not self.posts(p), "R-02: reading, Show All, Refresh and a minute send no write")
                self.server_eq((critical_row(r0)["state"], critical_row(r0)["revision"]), ("created", 1), "R-02 R0")
                self.server_eq(critical_ledger(u1.uid), ledger, "R-02 ledger")
                self.screen_ok(not any("Acknowledged" in row["words"] for row in self.recipient_screen(p.page)["rows"]),
                               "R-02: no Acknowledged")
            with self.step("R-03"):
                panel = self.inbox(s.page)
                toggle = panel.get_by_role("button", name="Show Received", exact=True)
                if toggle.count():
                    toggle.click()
                self.recv_refresh(s)
                expect(self.rows(s.page).filter(has_text=m1)).to_have_count(0)
                listed = self.session_read(s, "/critical-results?view=received&state=pending")["json"]
                self.server_eq(r0 in [key_of(item) for item in listed["items"]], False, "R-03 S's received list")
                self.judge("R-03", s, "settled", role="recipient")
            w = self.sign_in("clinician2", "W")
            with self.step("W-01"):
                self.first_list(w)
                expect(self.rows(w.page).filter(has_text=m1)).to_have_count(0)
                missing = self.session_read(w, f"/critical-results/{r0}")
                self.server_eq((missing["status"], (missing["json"] or {}).get("code")), (404, NOT_FOUND), "W-01 W reads R0")
                self.ledger_is(u1, 1, 1, 1, 1, "W-01")
                self.judge("W-01", w, "settled", role="recipient")
            with self.step("MU-C"):
                r0_item = self.session_read(p, f"/critical-results/{r0}")["json"]["item"]
                self.list_variant(w, "MU-C", lambda data: data["items"].insert(0, copy.deepcopy(r0_item)), "W-01 MU-C",
                                  ("row-not-for-session",))
                expect(self.rows(w.page).filter(has_text=m1)).to_have_count(0)
            with self.step("A-01"):
                since = self.n
                self.rows(p.page).filter(has_text=m1).get_by_role("button", name="Acknowledge", exact=True).dblclick()
                ack = self.answer(p, "#6", since, "A-01 ACK", target=r0)
                self.harness_ok(len(self.posts(p, "#6", r0)) == 1, "A-01: two quick clicks send one ACK")
                body = body_of(ack)
                self.harness_ok(sorted(body) == ["expectedOwner", "requestId", "revision"]
                                and (body["expectedOwner"], body["revision"]) == (p.owner, 1)
                                and ack["csrf"] == "1" and not ack["authorization"], "A-01 ACK request")
                applied = (ack["json"] or {}).get("applied") or {}
                self.server_eq((ack["status"], (ack["json"] or {}).get("replayed"), applied.get("action"), applied.get("from"),
                                applied.get("to"), applied.get("revision")), (201, False, "ack", "created", "acknowledged", 2), "A-01 answer")
                self.answer(p, "#3", ack["n"], "A-01 list after the ACK", view="received")
                expect(self.rows(p.page).filter(has_text=u1.patient_id)).to_contain_text(f"Acknowledged {minute(applied['at'])}")
                self.server_eq((critical_row(r0)["state"], critical_row(r0)["revision"]), ("acknowledged", 2), "A-01 R0")
                self.ledger_is(u1, 1, 2, 2, 2, "A-01")
                acked = [e for e in self.facts()["events"] if e["event"] == "acknowledged"]
                self.server_eq([(e["actorSub"], e["actorRole"], str(e["requestId"]).lower()) for e in acked],
                               [(self.sub("clinician"), "clinician", body["requestId"].lower())], "A-01 event")
                self.judge("A-01", p, "settled", role="recipient")
            with self.step("A-02"):
                self.sent_filter(s, "Acknowledged", "acknowledged")
                self.sent_refresh(s)
                expect(self.sent_row(s.page, u1, 1)).to_contain_text("Acknowledged")
                self.judge("A-02", s, "settled", role="sender")
            with self.step("L-01 (W-S E0-E5)"):
                self.choose(s, u1s)
                window = self.sender_window(s, u1s, clock=True)
                dialog, _ = self.open_dialog(s, u1s)
                m1b = self.message()
                self.log("window", control="W-S", act="write click (E3)", at=self.tick())
                self.fill_and_send(dialog, "clinician", m1b)
                first = self.sender_post(s, window)
                q = window.q
                status = dialog.get_by_role("status")
                expect(status).to_contain_text("Delivery status unknown")
                expect(status).to_contain_text(UNKNOWN_TEXT)
                expect(dialog.get_by_role("button", name="Check Again", exact=True)).to_be_visible()
                expect(s.page.get_by_text("Not delivered")).to_have_count(0)
                expect(dialog.get_by_label("Recipient", exact=True)).to_be_disabled()
                expect(dialog.get_by_label("Message", exact=True)).not_to_be_editable()
                expect(dialog.get_by_role("button", name="Send", exact=True)).to_be_disabled()
                self.server_eq(critical_row(q)["state"], "created", "L-01 R1 exists")
                self.ledger_is(u1s, 1, 1, 1, 1, "L-01")
                self.ledger_is(u1, 1, 2, 2, 2, "L-01")
                self.judge("L-01", s, "in-flight", role="sender")
            with self.step("L-01b"):
                after_post = [row for row in window.caught("hr3") if row["n"] > window.grabbed["n"]]
                if after_post:
                    branch = 1
                else:
                    busy = [entry["n"] for entry in s.wire.entries if entry["page"] == "S" and entry["state"] == "out"]
                    self.harness_ok(not busy, f"L-01b start state: critical result requests in flight {busy}")
                    branch = 2
                    since = self.n
                    s.context.clock.fast_forward(61000)
                    self.log("clock", context="S", act="fast_forward", ms=61000)
                    self.until(lambda: [row for row in window.caught("hr3") if row["n"] > since], "L-01b periodic read held", s.page)
                self.log("window", control="W-S", act="L-01b", branch=branch)
                expect(status).to_contain_text("Delivery status unknown")
                expect(s.page.get_by_text("Not delivered")).to_have_count(0)
                self.screen_ok("Delivered" not in words(status.inner_text(), SEND_WORDS), "L-01b: no Delivered")
                self.server_eq(critical_row(q)["state"], "created", "L-01b R1")
                reached = [entry["n"] for entry in s.wire.entries if entry["n"] > first["n"] and answered(entry)
                           and (entry["route"] == "#5" or (entry["route"] == "#4" and entry["target"] == q)
                                or (entry["route"] == "#3" and view_of(entry) == "sent"))]
                self.harness_ok(not reached, f"L-01b: confirm reads reached the server {reached}")
                cp_l01b = self.judge("L-01b", s, "in-flight", role="sender")
            with self.step("L-02"):
                window.remove("hp")
                since = self.n
                dialog.get_by_role("button", name="Check Again", exact=True).click()
                retry = self.answer(s, "#2", since, "L-02 same-bytes Check Again", target=u1s.uid)
                self.server_eq((retry["status"], (retry["json"] or {}).get("replayed")), (201, True), "L-02 replay")
                fetched = [row for row in self.handled if row["control"] == "W-S" and row["act"] == "fetch-abort"][-1]
                self.server_eq((retry["json"] or {}).get("applied"), (fetched.get("json") or {}).get("applied"), "L-02 stored result")
                self.harness_ok(retry["body"] == first["body"], "L-02 body bytes are the first request's")
                expect(status).to_contain_text("Delivered")
                expect(status).to_contain_text(DELIVERED_TEXT)
                self.harness_ok(len([e for e in self.posts(s, "#2", u1s.uid) if request_id(e) == q]) == 2, "L-02 #2(q) twice")
                self.ledger_is(u1s, 1, 1, 1, 1, "L-02")
                self.ledger_is(u1, 1, 2, 2, 2, "L-02")
                self.judge("L-02", s, "in-flight", role="sender")
                window.close()
                released = window.release()
                self.resume(s)
                self.harness_ok(not [row for row in self.handled if row["control"] == "W-S" and row.get("failed_before_release")],
                                "L-02: a hold ended on the page before its release")
                self.judge("L-02 released", s, "settled", role="sender")
                self.harness_ok(len(self.posts(s, after=first["n"] - 1)) == 2, "L-02: no write besides the create and its replay")
                self.log("window", control="W-S", act="closed", released=len(released))
                self.shot(s.page, "S-dialog-L-02")
                self.close_dialog(s.page)
            with self.step("H-01"):
                self.addendum(u1s, "U1s")
                self.recv_refresh(p)
                stub = self.rows(p.page).filter(has_text=u1s.patient_id)
                expect(stub).to_have_count(1)
                expect(stub).to_contain_text("Source Changed")
                expect(stub).to_contain_text(STUB_TEXT)
                text = stub.inner_text()
                for part in [m1b, "Source:"] + [v["findings"] for v in self.versions_of(u1s)]:
                    self.screen_ok(part not in text, f"H-01 stub shows {part!r}")
                expect(stub.get_by_role("button", name="Acknowledge", exact=True)).to_have_count(0)
                report_reads = [row["path"] for row in p.wire.paths if "/report" in row["path"]
                                and (u1s.uid in row["path"] or u1.uid in row["path"])]
                self.harness_ok(not report_reads, f"H-01: the home read a report {report_reads}")
                self.judge("H-01", p, "settled", role="recipient")
            with self.step("MU-E"):
                sender_view = self.session_read(s, f"/critical-results/{q}")["json"]["item"]
                v2 = next(v for v in self.versions_of(u1s) if v["version"] == 2)

                def full_stub(data):
                    for index, row in enumerate(data["items"]):
                        if key_of(row) == q:
                            data["items"][index] = dict(row, view="full", message=m1b, cancelReason=None,
                                                        source=dict(sender_view["source"], current=False, reason="head_moved"),
                                                        body={key: str(v2.get(key) or "") for key in ("findings", "conclusion", "recommendation")})
                self.list_variant(p, "MU-E", full_stub, "H-01 MU-E", ("stub-shows-content",))
                expect(self.rows(p.page).filter(has_text=u1s.patient_id)).to_contain_text(STUB_TEXT)
            with self.step("H-02"):
                self.sent_filter(s, "Pending ACK", "pending")
                self.sent_refresh(s)
                row = self.sent_row(s.page, u1s, 1)
                expect(row).to_contain_text("Source Changed")
                expect(row).to_contain_text(SOURCE_MARK_TEXT)
                expect(row.get_by_role("button", name="Supersede", exact=True)).to_be_visible()
                expect(row.get_by_role("button", name="Cancel Delivery", exact=True)).to_be_visible()
                self.judge("H-02", s, "settled", role="sender")
            with self.step("H-03"):
                since = self.n
                self.sent_row(s.page, u1s, 1).get_by_role("button", name="Supersede", exact=True).click()
                self.answer(s, "#1", since, "H-03 the Supersede form's #1", target=u1s.uid)
                pane = self.sent_pane(s.page)
                expect(pane).to_contain_text("Source: v2 · Addendum")
                m2 = self.message()
                pane.get_by_label("Message", exact=True).fill(m2)
                since = self.n
                pane.get_by_role("button", name="Supersede", exact=True, disabled=False).click()
                post = self.answer(s, "#8", since, "H-03 supersede", target=q)
                b = request_id(post)
                body = body_of(post)
                self.harness_ok(sorted(body) == ["expectedOwner", "message", "requestId", "revision", "sourceVersion"]
                                and (body["revision"], body["sourceVersion"], body["message"]) == (1, 2, m2), "H-03 request")
                applied = (post["json"] or {}).get("applied") or {}
                self.server_eq((post["status"], applied.get("action"), applied.get("to"), applied.get("replacement")),
                               (201, "supersede", "superseded", {"id": b, "revision": 1, "sourceVersion": 2}), "H-03 answer")
                self.answer(s, "#3", post["n"], "H-03 sent list after the supersede", view="sent")
                self.sent_filter(s, "All", "all")
                self.sent_refresh(s)
                self.server_eq((critical_row(q)["state"], critical_row(q)["revision"]), ("superseded", 2), "H-03 R1")
                self.server_eq((critical_row(b)["state"], critical_row(b)["supersedesId"]), ("created", q), "H-03 B")
                self.ledger_is(u1s, 2, 3, 2, 3, "H-03")
                self.ledger_is(u1, 1, 2, 2, 2, "H-03")
                cp_h03 = self.judge("H-03", s, "settled", role="sender", shows={"sent_rows": (r0, q, b)})
            with self.step("H-04"):
                self.show_all(p, True)
                self.recv_refresh(p)
                cp_h04 = self.judge("H-04", p, "settled", role="recipient", shows={"rows": (r0, q, b)})
                self.shot(p.page, "P-list-H-04")
                since = self.n
                (self.rows(p.page).filter(has_text=u1s.patient_id).filter(has_not_text=m2)
                 .get_by_role("button", name="Open Replacement", exact=True).click())
                opened = self.answer(p, "#4", since, "H-04 Open Replacement", target=b)
                self.log("trace", step="H-04", act="Open Replacement on the K2 U1s row", request=opened["n"], record=b)
                self.server_eq((opened["status"], ((opened["json"] or {}).get("item") or {}).get("view")), (200, "full"), "H-04 #4 B")
                self.harness_ok(len([e for e in p.wire.entries if e["route"] == "#4" and e["target"] == b and e["n"] > since]) == 1,
                                "H-04: one #4 of B")
                replacement = self.rows(p.page).filter(has_text=m2)
                expect(replacement).to_contain_text("Source: v2 · Addendum")
                expect(replacement).to_contain_text(next(v for v in self.versions_of(u1s) if v["version"] == 2)["findings"])
                expect(replacement.get_by_role("button", name="Acknowledge", exact=True)).to_be_enabled()
            with self.step("C-01"):
                self.quiet(p)
                self.pause(p)
                reason = f"SYNTHETIC U2b {self.run} cancel reason."
                self.sent_row(s.page, u1s, 2).get_by_role("button", name="Cancel Delivery", exact=True).click()
                pane = self.sent_pane(s.page)
                pane.get_by_label("Reason", exact=True).fill(reason)
                since = self.n
                pane.get_by_role("button", name="Cancel Delivery", exact=True, disabled=False).click()
                post = self.answer(s, "#7", since, "C-01 cancel", target=b)
                self.log("trace", step="C-01", act="cancel of B", request=post["n"], record=b, status=post["status"])
                body = body_of(post)
                self.harness_ok(sorted(body) == ["expectedOwner", "reason", "requestId", "revision"]
                                and (body["revision"], body["reason"]) == (1, reason), "C-01 request")
                self.server_eq((post["status"], ((post["json"] or {}).get("applied") or {}).get("to")), (201, "cancelled"), "C-01 answer")
                self.answer(s, "#3", post["n"], "C-01 sent list after the cancel", view="sent")
                row = critical_row(b)
                self.server_eq((row["state"], row["revision"], row["cancelReason"]), ("cancelled", 2, reason), "C-01 B")
                self.ledger_is(u1s, 2, 4, 3, 4, "C-01")
                self.ledger_is(u1, 1, 2, 2, 2, "C-01")
                expect(self.sent_row(s.page, u1s, 2)).to_contain_text("Cancelled")
                self.judge("C-01 S", s, "settled", role="sender")
                self.shot(s.page, "S-sent-list-C-01")
                self.judge("C-01 P", p, "in-flight", role="recipient")
            with self.step("C-02"):
                since = self.n
                self.rows(p.page).filter(has_text=m2).get_by_role("button", name="Acknowledge", exact=True).click()
                late = self.answer(p, "#6", since, "C-02 late ACK", target=b)
                self.log("trace", step="C-02", act="late ACK of B", request=late["n"], record=b, status=late["status"])
                self.resume(p)
                self.server_eq((late["status"], (late["json"] or {}).get("code")), (409, "CRITICAL_RESULT_CANCELLED"), "C-02 answer")
                self.answer(p, "#3", late["n"], "C-02 list after the refusal", view="received")
                self.answer(p, "#4", late["n"], "C-02 record read after the refusal", target=b)
                line = self.lines(p.page).filter(has_text=u1s.patient_id)
                expect(line).to_contain_text("CRITICAL_RESULT_CANCELLED")
                expect(line).to_contain_text("Cancelled")
                expect(self.rows(p.page).filter(has_text=m2)).to_contain_text("Cancelled")
                expect(self.rows(p.page).filter(has_text=m2)).to_contain_text(reason)
                self.server_eq(critical_row(b)["state"], "cancelled", "C-02 B")
                self.server_eq([e for e in self.facts()["events"] if str(e["recordId"]).lower() == b and e["event"] == "acknowledged"],
                               [], "C-02: no ack event on B")
                self.ledger_is(u1s, 2, 4, 3, 4, "C-02")
                self.ledger_is(u1, 1, 2, 2, 2, "C-02")
                self.judge("C-02", p, "settled", role="recipient")
            with self.step("C-03"):
                self.show_all(p, False)
                expect(self.rows(p.page)).to_have_count(0)
                cp_c03 = self.judge("C-03", p, "settled", role="recipient")
                self.shot(p.page, "P-list-C-03")
            with self.step("I-01 / I-02"):
                self.written_through_pages()
                self.distinct_messages()
                sender = self.sub("doctor")
                for event in self.facts()["events"]:
                    want = self.sub("clinician") if event["event"] == "acknowledged" else sender
                    self.server_eq(event["actorSub"], want, f"I-02 {event['event']} actor")
                audits = psql("SELECT actor || ' ' || (detail::jsonb ->> 'event') FROM \"AuditLog\" WHERE action = "
                              f"'study.critical-result' AND target IN ({sql_text(u1.uid)}, {sql_text(u1s.uid)}) ORDER BY id")
                for line in audits:
                    actor, event = line.rsplit(" ", 1)
                    want = self.stack.actor("clinician") if event == "acknowledged" else self.stack.actor("doctor")
                    self.server_eq(actor, want, f"I-02 audit {event}")
            with self.step("MU-H / JV-15m / JV-16 / JV-17m / JV-18"):
                ack0 = request_id([e for e in p.wire.entries if e["route"] == "#6" and e["target"] == r0][0])
                mu_h = copy.deepcopy(cp_c03)
                mu_h["writes"] = [write for write in mu_h["writes"] if write["requestId"] != ack0]
                mu_h["net"] = [entry for entry in mu_h["net"] if request_id(entry) != ack0]
                self.pure("MU-H", mu_h, ["write-not-from-page"])
                jv15 = copy.deepcopy(cp_l01b)
                jv15["screen"]["dialog"]["words"] = ["Delivered"]
                self.pure("JV-15m", jv15, ["state-word-mismatch"])
                acked_at = minute(critical_row(r0)["acknowledgedAt"] + "Z")
                stub_index = next(i for i, record in enumerate(correspond(cp_h04)["rows"]) if record == q)
                jv17 = copy.deepcopy(cp_h04)
                jv17["screen"]["rows"][stub_index].update(words=["Cancelled"], times=[])
                self.pure("JV-17m", jv17, ["state-word-mismatch"])
                jv18 = copy.deepcopy(cp_h04)
                jv18["screen"]["rows"][stub_index].update(words=["Acknowledged"], times=[acked_at])
                self.pure("JV-18", jv18, ["ack-not-on-server"])
                jv16 = copy.deepcopy(cp_h04)
                # the fix3 layout: R1 and B on R0's study, R0 a stub in the list answer, R1's row showing R0's patient
                for record in (q, b):
                    jv16["server"]["records"][record]["studyUid"] = u1.uid
                for entry in jv16["net"]:
                    for item in items_of(entry):
                        if key_of(item) == r0:
                            item["view"] = "stub"
                            item.pop("message", None)
                jv16["screen"]["rows"][stub_index]["text"] = jv16["screen"]["rows"][stub_index]["text"].replace(
                    u1s.patient_id, u1.patient_id)
                jv16["screen"]["rows"].append(dict(jv16["screen"]["rows"][stub_index], words=["Acknowledged"], times=[acked_at]))
                self.pure("JV-16", jv16, ["unmatched:harness"])
            with self.step("U5 H-03 / H-04 (F001)"):
                # The run's own H-03 and H-04 observations: each named row left out in turn is the screen's failure before
                # any judging, and the same rows in the opposite order are judged [] again.
                for name, recorded, what in (("H-03", cp_h03, "sent_rows"), ("H-04", cp_h04, "rows")):
                    for index, record in enumerate(correspond(recorded)[what]):
                        dropped = copy.deepcopy(recorded)
                        del dropped["screen"][what][index]
                        self.pure(f"{name} without {record}", dropped, ["unmatched:screen"])
                    turned = copy.deepcopy(recorded)
                    turned["screen"][what].reverse()
                    self.pure(f"{name} reversed", turned, [])

    def test_crs02_revoked_recipient_old_session_cannot_acknowledge_new_session_sees_nothing(self) -> None:
        """CRS-02: V moves to another institution: S sees Recipient Not Eligible, V's old session ends, and a fresh login
        sees nothing (R5) and cannot ACK; the move is undone and a third session sees the record again."""
        with self.controlled():
            with self.step("E-04"):
                u2 = self.approved_study("U2")
                self.distinct_studies()
            s = self.sign_in("doctor", "S")
            with self.step("V-01"):
                self.choose(s, u2)
                m = self.message()
                r2 = self.deliver(s, u2, "clinician3", m)
                o = self.sign_in("clinician3", "O")
                self.first_list(o)
                row = self.rows(o.page).filter(has_text=m)
                expect(row).to_have_count(1)
                expect(row.get_by_role("button", name="Acknowledge", exact=True)).to_be_enabled()
                self.judge("V-01", o, "settled", role="recipient")
            moved = False
            try:
                with self.step("V-02"):
                    self.move_member("clinician3", "hallym", "kin-center")
                    moved = True
                    self.mark_change()
                with self.step("V-03"):
                    self.show_sent(s)
                    self.sent_refresh(s)
                    row = self.sent_row(s.page, u2, 1)
                    expect(row).to_contain_text("Recipient Not Eligible")
                    expect(row).to_contain_text(NOT_ELIGIBLE_TEXT)
                    self.judge("V-03", s, "settled", role="sender")
                with self.step("V-04"):
                    # D621/D623 ends the old rights version. Observe its next navigation without submitting a login.
                    o.page.goto(self.stack.proxy + "/worklist/hpacs-lite/clinician.html")
                    o.page.wait_for_url(lambda url: urlsplit(url).path == "/auth/realms/kin/protocol/openid-connect/auth")
                    expect(o.page.locator('input[name="password"]')).to_be_visible()
                    expect(self.inbox(o.page)).to_have_count(0)
                    expect(o.page.get_by_role("list", name="Received Critical Results", exact=True)).to_have_count(0)
                    expect(o.page.get_by_role("button", name="Acknowledge", exact=True)).to_have_count(0)
                    self.harness_ok(not self.posts(o, "#6"), "V-04: the ended session sent no ACK")
                    self.server_eq((critical_row(r2)["state"], critical_row(r2)["revision"]), ("created", 1), "V-04 R2")
                    self.ledger_is(u2, 1, 1, 1, 1, "V-04")
                    self.log("session-ended", step="V-04", context=o.label, received=False, acknowledge=False)
                with self.step("RF-5"):
                    self.sent_refresh(s)
                    expect(self.sent_row(s.page, u2, 1)).to_contain_text("Recipient Not Eligible")
                    self.judge("V-03 RF-5", s, "settled", role="sender")
                with self.step("V-05"):
                    n = self.sign_in("clinician3", "N")
                    self.first_list(n)
                    expect(self.rows(n.page)).to_have_count(0)
                    expect(n.page.get_by_role("button", name="Acknowledge", exact=True)).to_have_count(0)
                    missing = self.session_read(n, f"/critical-results/{r2}")
                    self.server_eq((missing["status"], (missing["json"] or {}).get("code")), (404, NOT_FOUND), "V-05 N reads R2")
                    self.judge("V-05", n, "settled", role="recipient")
                with self.step("MU-D"):
                    # Reuse V-01's recorded answer, never read through the ended session. This response variant offers
                    # a stale row; its page's real ACK must still meet R5, using N's current session and owner envelope.
                    old = next(copy.deepcopy(item) for item in items_of(self.first_list(o)) if key_of(item) == r2)
                    control = Control(self, n, "MU-D")
                    control.add("MU-D", is_(route="#3", view="received"), "modify",
                                change=lambda data: data["items"].insert(0, copy.deepcopy(old)))
                    control.start()
                    try:
                        self.recv_refresh(n)
                        self.judge("V-05 MU-D", n, "settled", role="recipient", expected=("row-not-for-session",))
                    finally:
                        control.close()
                    since = self.n
                    self.rows(n.page).filter(has_text=m).get_by_role("button", name="Acknowledge", exact=True).click()
                    refused = self.answer(n, "#6", since, "V-05 N ACK", target=r2)
                    self.server_eq((refused["status"], (refused["json"] or {}).get("code")), (404, NOT_FOUND), "V-05 N ACK answer")
                    self.answer(n, "#3", refused["n"], "V-05 list after the refusal", view="received")
                    expect(self.rows(n.page)).to_have_count(0)
                    line = self.lines(n.page).filter(has_text=u2.patient_id)
                    expect(line).to_contain_text(NOT_FOUND)
                    self.screen_ok(HANGUL.search(line.inner_text()) is not None, "V-05: a Korean reason")
                    self.server_eq((critical_row(r2)["state"], critical_row(r2)["revision"]), ("created", 1), "V-05 R2")
                    self.ledger_is(u2, 1, 1, 1, 1, "V-05")
                    self.judge("V-05 MU-D cleanup", n, "settled", role="recipient")
            finally:
                if moved:
                    self.move_member("clinician3", "kin-center", "hallym")
                    self.mark_change()
                    self.log("setup", act="group restored", logical="clinician3")
            with self.step("V-06"):
                again = self.sign_in("clinician3", "N2")
                self.first_list(again)
                row = self.rows(again.page).filter(has_text=m)
                expect(row).to_have_count(1)
                expect(row.get_by_role("button", name="Acknowledge", exact=True)).to_be_enabled()
                self.server_eq((critical_row(r2)["state"], critical_row(r2)["revision"]), ("created", 1), "V-06 R2")
                self.ledger_is(u2, 1, 1, 1, 1, "V-06")
                self.judge("V-06", again, "settled", role="recipient")
            with self.step("V-07"):
                self.not_run()
                self.written_through_pages()

    def test_crs03_wrong_role_and_other_institution_are_offered_nothing(self) -> None:
        """CRS-03: a technician's main.html asks no critical result route and the server refuses it by role; another
        institution's clinician sees no row and reads 404."""
        with self.controlled():
            with self.step("E-04"):
                u3 = self.approved_study("U3")
                self.distinct_studies()
            s = self.sign_in("doctor", "S")
            with self.step("S"):
                self.choose(s, u3)
                m = self.message()
                r3 = self.deliver(s, u3, "clinician", m)
            with self.step("W-02"):
                t = self.sign_in("tech", "T")
                self.select(t.page, u3)
                expect(self.inbox(t.page)).to_have_count(0)
                expect(self.sent_region(t.page)).to_have_count(0)
                mark = t.page.get_by_role("button", name="Mark CVR", exact=True)
                if mark.is_visible():
                    expect(mark).to_be_disabled()
                self.harness_ok(not t.wire.entries, f"W-02: T's pages asked critical result routes {[e['n'] for e in t.wire.entries]}")
                denied = self.session_read(t, "/critical-results?view=received&state=pending")
                self.server_eq((denied["status"], (denied["json"] or {}).get("code")), (403, ROLE_REQUIRED), "W-02 T's list")
            k = self.sign_in("kclinician", "K")
            with self.step("W-03"):
                self.first_list(k)
                expect(self.rows(k.page).filter(has_text=m)).to_have_count(0)
                missing = self.session_read(k, f"/critical-results/{r3}")
                self.server_eq(missing["status"], 404, "W-03 K reads R3")
                self.judge("W-03", k, "settled", role="recipient")
                self.show_all(k, True)
                self.recv_refresh(k)
                self.judge("W-03 Show All", k, "settled", role="recipient")
                self.show_all(k, False)
            with self.step("W-03 MU"):
                item = self.check(self.read("clinician", r3), 200).body["item"]
                self.list_variant(k, "W-03 MU", lambda data: data["items"].insert(0, copy.deepcopy(item)), "W-03 MU",
                                  ("row-not-for-session",))
                self.written_through_pages()

    def test_crs04_lost_answers_stay_unknown_until_a_read_or_check_again_proves_them(self) -> None:
        """CRS-04: RF-2 a lost create answer ended by the released read, L-03/L-04 a lost ACK answer ended by the same-bytes
        Check Again, L-05 another request's 201 is no evidence but the released #4 is, L-06 a made-up 201 on a dedicated
        page is caught and the page is discarded."""
        with self.controlled():
            with self.step("E-04"):
                u4, u4s = self.approved_study("U4"), self.approved_study("U4s")
                self.distinct_studies()
            s = self.sign_in("doctor", "S")
            with self.step("RF-2"):
                self.show_sent(s)
                self.choose(s, u4)
                window = self.sender_window(s, u4, clock=False)
                dialog, _ = self.open_dialog(s, u4)
                m4 = self.message()
                self.log("window", control="W-S", act="write click (E3)", at=self.tick())
                self.fill_and_send(dialog, "clinician", m4)
                first = self.sender_post(s, window)
                r4 = window.q
                expect(dialog.get_by_role("status")).to_contain_text("Delivery status unknown")
                expect(dialog.get_by_role("button", name="Check Again", exact=True)).to_be_visible()
                self.judge("RF-2 window", s, "in-flight", role="sender")
                self.close_dialog(s.page)
                line = self.sent_lines(s.page).filter(has_text=u4.patient_id)
                expect(line).to_contain_text("Delivery status unknown")
                expect(line.get_by_role("button", name="Check Again", exact=True)).to_be_visible()
                self.judge("RF-2 line", s, "in-flight", role="sender")
                since = self.n
                self.sent_region(s.page).get_by_role("button", name="Refresh", exact=True).click()
                self.until(lambda: window.caught("hr3", since), "RF-2 the Refresh read held", s.page)
                expect(line).to_contain_text("Delivery status unknown")
                self.judge("RF-2 Refresh held", s, "in-flight", role="sender")
                window.close()
                window.release()
                expect(line).to_contain_text("Delivered")
                self.harness_ok([request_id(e) for e in self.posts(s, "#2", u4.uid)] == [r4], "RF-2: the first create only")
                self.ledger_is(u4, 1, 1, 1, 1, "RF-2")
                self.judge("RF-2", s, "settled", role="sender")
            p = self.sign_in("clinician", "P", clock=True)
            with self.step("L-03"):
                self.first_list(p)
                expect(self.rows(p.page).filter(has_text=m4).get_by_role("button", name="Acknowledge", exact=True)).to_be_enabled()
                window = self.recipient_window(p, r4)
                self.log("window", control="W-P", act="write click", at=self.tick())
                self.rows(p.page).filter(has_text=m4).get_by_role("button", name="Acknowledge", exact=True).click()
                self.until(lambda: [row for row in self.handled if row["control"] == "W-P" and row["act"] == "fetch-abort"],
                           "L-03 h1 forwarded the ACK", p.page)
                first_ack = self.posts(p, "#6", r4)[0]
                self.until(lambda: first_ack["state"] == "failed", "L-03 the page's ACK without an answer", p.page)
                line = self.lines(p.page).filter(has_text=u4.patient_id)
                expect(line).to_contain_text("Acknowledgement status unknown")
                expect(line).to_contain_text(ACK_UNKNOWN_TEXT)
                expect(line.get_by_role("button", name="Check Again", exact=True)).to_be_visible()
                expect(self.rows(p.page).filter(has_text=m4).get_by_role("button", name="Acknowledge", exact=True)).to_have_count(0)
                self.server_eq(critical_row(r4)["state"], "acknowledged", "L-03 R4")
                self.judge("L-03", p, "in-flight", role="recipient")
            with self.step("L-04"):
                window.remove("h1")
                since = self.n
                line.get_by_role("button", name="Check Again", exact=True).click()
                retry = self.answer(p, "#6", since, "L-04 Check Again", target=r4)
                self.server_eq((retry["status"], (retry["json"] or {}).get("replayed")), (201, True), "L-04 replay")
                self.harness_ok(retry["body"] == first_ack["body"], "L-04 body bytes")
                at = ((retry["json"] or {}).get("applied") or {}).get("at")
                expect(self.rows(p.page).filter(has_text=u4.patient_id)).to_contain_text(f"Acknowledged {minute(at)}")
                self.ledger_is(u4, 1, 2, 2, 2, "L-04")
                self.judge("L-04", p, "in-flight", role="recipient")
                window.close()
                window.release()
                self.judge("L-04 released", p, "settled", role="recipient")
            with self.step("L-05a"):
                self.choose(s, u4s)
                m4p = self.message()
                r4p = self.deliver(s, u4s, "clinician", m4p)
                self.recv_refresh(p)
                expect(self.rows(p.page).filter(has_text=m4p).get_by_role("button", name="Acknowledge", exact=True)).to_be_enabled()
                window = self.recipient_window(p, r4p)
                self.log("window", control="W-P", act="write click", at=self.tick())
                self.rows(p.page).filter(has_text=m4p).get_by_role("button", name="Acknowledge", exact=True).click()
                self.until(lambda: len([row for row in self.handled if row["control"] == "W-P" and row["act"] == "fetch-abort"
                                        and row["target"] == r4p]) == 1, "L-05a h1 forwarded the ACK", p.page)
                first_ack = self.posts(p, "#6", r4p)[0]
                self.until(lambda: first_ack["state"] == "failed", "L-05a the page's ACK without an answer", p.page)
                line = self.lines(p.page).filter(has_text=u4s.patient_id)
                expect(line).to_contain_text("Acknowledgement status unknown")
                expect(self.rows(p.page).filter(has_text=m4p).get_by_role("button", name="Acknowledge", exact=True)).to_have_count(0)
                self.server_eq((critical_row(r4p)["state"], critical_row(r4p)["revision"]), ("acknowledged", 2), "L-05a R4'")
                self.ledger_is(u4s, 1, 2, 2, 2, "L-05a (B)")
                self.ledger_is(u4, 1, 2, 2, 2, "L-05a")
                self.judge("L-05a", p, "in-flight", role="recipient")
                window.remove("h1")
            with self.step("L-05b"):
                window.add("h2", is_(route="#6", target=r4p), "fulfill", answer=lambda request: {
                    "owner": p.owner, "replayed": True, "applied": {
                        "id": r4p, "studyUid": u4s.uid, "action": "ack", "from": "created", "to": "acknowledged", "revision": 2,
                        "replacement": None, "at": now_iso(), "requestId": str(uuid.uuid4())}})
                since = self.n
                line.get_by_role("button", name="Check Again", exact=True).click()
                made = self.answer(p, "#6", since, "L-05b the made-up 201", target=r4p)
                self.until(lambda: window.caught("hr4", made["n"]), "L-05b the confirming #4 held", p.page)
                expect(line).to_contain_text("Acknowledgement status unknown")
                expect(line.get_by_role("button", name="Check Again", exact=True)).to_be_visible()
                self.harness_ok(len(self.posts(p, "#6", r4p)) == 2, "L-05b #6(R4') twice")
                self.harness_ok(not [e for e in p.wire.entries if e["route"] == "#4" and e["target"] == r4p and answered(e)],
                                "L-05b: no #4 of R4' reached the server")
                self.ledger_is(u4s, 1, 2, 2, 2, "L-05b (B)")
                cp_l05b = self.judge("L-05b", p, "in-flight", role="recipient")
            with self.step("L-05c"):
                window.close()
                window.release()
                acked = critical_row(r4p)["acknowledgedAt"] + "Z"
                expect(self.rows(p.page).filter(has_text=u4s.patient_id)).to_contain_text(f"Acknowledged {minute(acked)}")
                expect(self.lines(p.page).filter(has_text=u4s.patient_id)).to_have_count(0)
                self.harness_ok(len(self.posts(p, "#6", r4p)) == 2, "L-05c: no more ACK")
                self.ledger_is(u4s, 1, 2, 2, 2, "L-05c (B)")
                self.judge("L-05c", p, "settled", role="recipient")
            with self.step("L-06a (MU-A)"):
                m4pp = self.message()
                r4pp = self.deliver(s, u4s, "clinician", m4pp)
                self.ledger_is(u4s, 2, 3, 3, 3, "L-06a (C)")
                m = self.open_page(p, "M")
                self.first_list(p, m)
                expect(self.rows(m).filter(has_text=m4pp).get_by_role("button", name="Acknowledge", exact=True)).to_be_enabled()
                fake = Control(self, p, "MU-A", page=m)
                fake.add("h4", is_(route="#6", target=r4pp), "fulfill", answer=lambda request: {
                    "owner": p.owner, "replayed": False, "applied": {
                        "id": r4pp, "studyUid": u4s.uid, "requestId": request_id({"body": request.post_data}), "action": "ack",
                        "from": "created", "to": "acknowledged", "revision": 2, "replacement": None, "at": now_iso()}})
                fake.start()
                since = self.n
                self.rows(m).filter(has_text=m4pp).get_by_role("button", name="Acknowledge", exact=True).click()
                made = self.answer(p, "#6", since, "MU-A the made-up 201", page=m, target=r4pp)
                self.answer(p, "#3", made["n"], "MU-A the list after it", page=m, view="received")
                expect(self.rows(m).filter(has_text=m4pp)).to_contain_text("Acknowledged")
                self.server_eq((critical_row(r4pp)["state"], critical_row(r4pp)["revision"]), ("created", 1), "L-06a R4''")
                self.ledger_is(u4s, 2, 3, 3, 3, "L-06a (C)")
                self.judge("L-06a", p, "settled", role="recipient", page=m, expected=("ack-not-on-server",))
            with self.step("L-06b"):
                fake.close()
                self.harvest()
                m.close()
                page = self.open_page(p, "N")
                self.first_list(p, page)
                row = self.rows(page).filter(has_text=m4pp)
                expect(row).to_contain_text("Pending ACK")
                expect(row.get_by_role("button", name="Acknowledge", exact=True)).to_be_enabled()
                self.harness_ok(not self.posts(p, after=made["n"]), "L-06b: no write after the made-up one")
                self.server_eq((critical_row(r4pp)["state"], critical_row(r4pp)["revision"]), ("created", 1), "L-06b R4''")
                self.ledger_is(u4s, 2, 3, 3, 3, "L-06b (C)")
                self.judge("L-06b", p, "settled", role="recipient", page=page)
            with self.step("JV-08m"):
                jv08 = copy.deepcopy(cp_l05b)
                shown_as = [row for row, record in zip(jv08["screen"]["rows"], correspond(jv08)["rows"]) if record == r4p]
                wrong = {"words": ["Acknowledged"], "times": [minute(acked)], "ack": 0, "ack_all": 0, "replacement": False}
                if shown_as:
                    shown_as[0].update(wrong)
                else:
                    # a period's list may already have dropped R4''s row while its #4 was held: the copy draws one (K1)
                    jv08["screen"]["rows"].append(dict(wrong, text=f"Acknowledged {minute(acked)}\n{m4p}"))
                jv08["screen"]["lines"] = []
                self.pure("JV-08m", jv08, ["state-word-mismatch"])
                self.written_through_pages()
                self.distinct_messages()

    def test_crs05_moved_head_before_send_is_refused_and_the_dialog_rereads_the_version(self) -> None:
        """CRS-05: an addendum while the dialog shows v1 makes the Send a definite 409 SOURCE_MOVED (Not delivered, nothing
        stored); the dialog rereads v2 and the next Send stores v2. MU-B: a made-up 201 on a dedicated page is caught."""
        with self.controlled():
            with self.step("E-04"):
                # RF-4 needs its own study: after H-06 the same study already holds P's pending v2 record, so opening the
                # dialog after an addendum can only reach the same end state (one v2 record, none on v1) somewhere else, and a
                # second recipient on U5 v2 would give two sent rows one K4 key.
                u5, u5r = self.approved_study("U5"), self.approved_study("U5r")
                self.distinct_studies()
            s = self.sign_in("doctor", "S")
            with self.step("H-05"):
                self.choose(s, u5)
                dialog, offered = self.open_dialog(s, u5)
                expect(dialog).to_contain_text("Source: v1 · Approve")
                self.addendum(u5, "U5")
                m5 = self.message()
                since = self.n
                self.fill_and_send(dialog, "clinician", m5)
                first = self.answer(s, "#2", since, "H-05 create", target=u5.uid)
                self.harness_ok(body_of(first)["sourceVersion"] == 1, "H-05 the create pinned v1")
                self.server_eq((first["status"], (first["json"] or {}).get("code")), (409, "CRITICAL_RESULT_SOURCE_MOVED"), "H-05")
                reread = self.answer(s, "#1", first["n"], "H-05 the dialog reads #1 again", target=u5.uid)
                self.server_eq(((reread["json"] or {}).get("source") or {}).get("version"), 2, "H-05 #1 again")
                status = dialog.get_by_role("status")
                expect(status).to_contain_text("Not delivered")
                expect(status).to_contain_text("CRITICAL_RESULT_SOURCE_MOVED")
                self.screen_ok(HANGUL.search(status.inner_text()) is not None, "H-05: a Korean reason")
                expect(dialog).to_contain_text("Source: v2 · Addendum")
                expect(dialog.get_by_label("Message", exact=True)).to_have_value(m5)
                self.ledger_is(u5, 0, 0, 0, 0, "H-05")
                # The modal dialog covers the sent list, so its newest list read predates the addendum: the dialog's table SD
                # holds at every checkpoint kind, and this one is in-flight by the 6.2 definition.
                self.judge("H-05", s, "in-flight", role="sender")
            with self.step("H-06"):
                since = self.n
                dialog.get_by_role("button", name="Send", exact=True).click()
                second = self.answer(s, "#2", since, "H-06 create", target=u5.uid)
                body = body_of(second)
                self.harness_ok(body["requestId"].lower() != request_id(first) and (body["sourceVersion"], body["message"]) == (2, m5),
                                "H-06 a new request on v2")
                self.server_eq(second["status"], 201, "H-06 answer")
                expect(dialog.get_by_role("status")).to_contain_text("Delivered")
                self.answer(s, "#3", second["n"], "H-06 sent list after Delivered", view="sent")
                records = self.facts()["records"]
                self.server_eq(sorted((r["sourceVersion"], r["recipientSub"]) for r in records.values()),
                               [(2, self.sub("clinician"))], "H-06 one record on v2")
                self.judge("H-06", s, "settled", role="sender")
            with self.step("RF-4"):
                self.close_dialog(s.page)
                self.addendum(u5r, "U5r")
                self.choose(s, u5r)
                dialog, offered = self.open_dialog(s, u5r)
                self.server_eq((offered.get("source") or {}).get("version"), 2, "RF-4 the dialog opens on v2")
                expect(dialog).to_contain_text("Source: v2 · Addendum")
                since = self.n
                self.fill_and_send(dialog, "clinician", self.message())
                post = self.answer(s, "#2", since, "RF-4 create", target=u5r.uid)
                self.server_eq((post["status"], body_of(post)["sourceVersion"]), (201, 2), "RF-4 create")
                expect(dialog.get_by_role("status")).to_contain_text("Delivered")
                self.answer(s, "#3", post["n"], "RF-4 sent list", view="sent")
                records = self.facts()["records"]
                self.server_eq(sorted((r["studyUid"], r["sourceVersion"]) for r in records.values()),
                               sorted([(u5.uid, 2), (u5r.uid, 2)]), "RF-4: the same end state, no v1 record")
                self.judge("RF-4", s, "settled", role="sender")
                self.close_dialog(s.page)
            with self.step("MU-B"):
                m = self.open_page(s, "M'")
                self.choose(s, u5, page=m)
                dialog, _ = self.open_dialog(s, u5, page=m)
                fake = Control(self, s, "MU-B", page=m)
                fake.add("hb", is_(route="#2", target=u5.uid), "fulfill", answer=lambda request: {
                    "owner": s.owner, "replayed": False, "applied": {
                        "id": request_id({"body": request.post_data}), "studyUid": u5.uid,
                        "requestId": request_id({"body": request.post_data}), "action": "create", "from": None, "to": "created",
                        "revision": 1, "replacement": None, "at": now_iso()}})
                fake.start()
                since = self.n
                self.fill_and_send(dialog, "clinician3", self.message())
                made = self.answer(s, "#2", since, "MU-B the made-up 201", page=m, target=u5.uid)
                expect(dialog.get_by_role("status")).to_contain_text("Delivered")
                self.answer(s, "#3", made["n"], "MU-B the sent list after it", page=m, view="sent")
                self.judge("MU-B", s, "settled", role="sender", page=m, expected=("delivered-not-on-server",))
                fake.close()
                self.harvest()
                m.close()
                page = self.open_page(s, "N'")
                self.show_sent(s, page)
                listed = self.answer(s, "#3", made["n"], "N' first sent list", page=page, view="sent")
                self.server_eq(request_id(made) in [key_of(item) for item in items_of(listed)], False, "MU-B: N' lists the made-up id")
                self.server_eq(request_id(made) in self.facts()["records"], False, "MU-B: no record")
                self.harness_ok(not self.posts(s, after=made["n"]), "MU-B: no write after the made-up one")
                self.judge("MU-B N'", s, "settled", role="sender", page=page)
                self.written_through_pages()

    def test_crs06_account_switch_in_one_browser_keeps_nothing_of_the_first_recipient(self) -> None:
        """CRS-06: P logs out and W logs in on the same context: nothing of P's record remains, P's session row is gone."""
        with self.controlled():
            with self.step("E-04"):
                u6 = self.approved_study("U6")
                self.distinct_studies()
            s = self.sign_in("doctor", "S")
            with self.step("S"):
                self.choose(s, u6)
                m6 = self.message()
                r6 = self.deliver(s, u6, "clinician", m6)
            p_sub = self.sub("clinician")
            before = set(psql(f'SELECT sid FROM "AuthSession" WHERE sub = {sql_text(p_sub)}'))
            c = self.sign_in("clinician", "C")
            with self.step("I-05"):
                self.first_list(c)
                expect(self.rows(c.page).filter(has_text=m6)).to_have_count(1)
                p_item = self.session_read(c, f"/critical-results/{r6}")["json"]["item"]
                mine = set(psql(f'SELECT sid FROM "AuthSession" WHERE sub = {sql_text(p_sub)}')) - before
                self.harness_ok(len(mine) >= 1, "I-05: P's session row in C")
                logins: list[str] = []
                c.page.on("request", lambda r: logins.append(r.url) if urlsplit(r.url).path == "/api/auth/login" else None)
                c.page.get_by_role("button", name="Log out", exact=True).click()
                # S7-U5: the end stays until the next explicit login, so the landing shows it and starts no login by itself.
                c.page.wait_for_url("**/worklist/hpacs-lite/index.html", timeout=30000)
                expect(c.page.locator("#signin")).to_be_enabled()
                self.screen_ok(c.page.evaluate("KinAuth.endState()") == {"state": "confirmed", "reason": None},
                               "I-05: the landing shows P's confirmed end")
                self.screen_ok(not logins, "I-05: the landing started a login by itself")
                left = [sid for sid in mine if psql(f'SELECT count(*) FROM "AuthSession" WHERE sid = {sql_text(sid)}') != ["0"]]
                self.server_eq(len(left), 0, "I-05 P's session rows after Log out")
                switched = self.n
                c.logical = "clinician2"
                # W logs in on the same context through the landing's own login control.
                c.page.locator("#signin").click()
                self.submit_login(c.page, "clinician2")
                self.landed(c, switched)
                self.first_list(c, since=switched)
                expect(self.rows(c.page).filter(has_text=m6)).to_have_count(0)
                expect(c.page.get_by_text(m6)).to_have_count(0)
                for entry in c.wire.entries:
                    if entry["n"] > switched:
                        self.harness_ok(p_sub not in (entry["body"] or "") and p_sub not in json.dumps(entry["query"]),
                                        "I-05: a request after the switch names P")
                self.judge("I-05", c, "settled", role="recipient")
            with self.step("MU-F"):
                self.list_variant(c, "MU-F", lambda data: data["items"].insert(0, copy.deepcopy(p_item)), "I-05 MU-F",
                                  ("row-not-for-session",))
            with self.step("RF-6"):
                w = self.sign_in("clinician2", "W")
                self.first_list(w)
                expect(self.rows(w.page).filter(has_text=m6)).to_have_count(0)
                self.judge("I-05 RF-6", w, "settled", role="recipient")
                self.written_through_pages()


def load_tests(loader: unittest.TestLoader, standard_tests: unittest.TestSuite, pattern: str | None) -> unittest.TestSuite:
    """Each local class's own declared cases, in declaration order: never the 15 WorklistE2E cases the screens class
    inherits (scripts/run-tests.py module_plan picks the same set per class with --class)."""
    suite = unittest.TestSuite()
    for cls in (CriticalResultE2E, CriticalResultScreensE2E):
        suite.addTests(cls(name) for name in loader.getTestCaseNames(cls) if name in cls.__dict__)
    return suite


if __name__ == "__main__":
    unittest.main(verbosity=2)
