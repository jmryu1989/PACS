# coding: utf-8
"""TEST-S5-U3-LIVE: the clinician patient timeline on the real Nest guard, Prisma, Keycloak, Orthanc and nginx.

REQ-S5-U3-PATIENT-TIMELINE -> RISK-S5-U3-NAME-MERGE / ID-ONLY-IDENTITY / TENANT.
Hosted synthetic stack only, through scripts/run-tests.py (never the original DB, DICOM or accounts):

    python scripts/run-tests.py --module tests/clinician_timeline_live.py --mode live --unit s5-u3-clinician-timeline --timeout 900

GET /api/clinician/studies/:uid/timeline?limit=1..100[&after=<signed cursor>] answers every study the caller can read whose
server patient key (institution|original DICOM PatientID) is the anchor study's, with the list row fields, and the relation
of the original DICOM birth date / sex across the timeline (identity) and against the anchor (studies[].identity).

  01 NAME-MERGE: the same name with another PatientID is never in the timeline; another name with the same PatientID is.
  02 ID-ONLY-IDENTITY: the same PatientID with another birth date or sex is one timeline with identity.conflict and the
     per-study relation (not_comparable for an empty birth date); a technician overlay that displays the anchor's birth
     date does not remove the marker; the same PatientID with the same values is a match.
  03 TENANT: a tele referral shows the sender's same-key studies to the receiving clinician only while each referral is
     open; the receiver's own study with the same PatientID is another key; a cancelled referral leaves the timeline and a
     cancelled anchor is 404; the sender-only study is 404 for the receiver and the receiver's study 404 for the sender.
  04 contract: role gates, 400 shapes, 409 for a forged cursor and for cursors of another timeline or of the list, limit=1
     paging with each cursor verbatim, field sets and no writer field, no body or draft, no-store, no audit row.

Each case prints one `S5-U3-TIMELINE {json}` marker line with what it observed. Owned data only: run-created Keycloak
users (kin-test-*), the run's password-grant client, the realm role `clinician` only when this run had to create it, and
C-STORE fixtures (SYN names, run-unique S5U3-* PatientIDs) removed by the stack's own cleanup.
"""
from __future__ import annotations

import json
import re
import sys
import unittest
import uuid
from contextlib import ExitStack, contextmanager
from pathlib import Path
from typing import Iterator
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request

from invariants_live import Fixture, LiveStack, psql

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = json.loads((ROOT / "tests" / "clinician_policy_fixtures.json").read_text(encoding="utf-8"))
C = FIXTURES["read_contract"]
DENIED = FIXTURES["denied_code"]
FORBIDDEN = set(C["forbidden_keys"])
# The S5-U3 answer (api/src/clinician-policy.ts clinicianTimeline): the shared read_contract, like the other clinician reads.
TIMELINE_KEYS = C["timeline_response_keys"]
IDENTITY_KEYS = C["timeline_identity_keys"]
ROW_KEYS = C["list_row_keys"] + C["timeline_row_extra_keys"]
ROW_IDENTITY_KEYS = C["timeline_row_identity_keys"]
RELATIONS = set(C["timeline_relations"])
HALLYM, KIN = "한림병원", "KIN 판독센터"


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


def marker(case: str, **seen) -> None:
    print("S5-U3-TIMELINE " + json.dumps({"case": case, **seen}, ensure_ascii=True, sort_keys=True), flush=True)


class TimelineStack(LiveStack):
    """LiveStack whose C-STORE fixtures carry a chosen name, birth date and sex (scripts/send_cstore.py --name/--birth/--sex)."""

    demographics: dict[str, str] | None = None

    def fixture_command(self, institution: str, name: str, patient_id: str) -> list[str]:
        command = super().fixture_command(institution, name, patient_id)
        wanted = self.demographics or {}
        if "name" in wanted:
            command[command.index("--name") + 1] = wanted["name"]
        for flag in ("birth", "sex"):
            if flag in wanted:
                command += ["--" + flag, wanted[flag]]
        return command

    @contextmanager
    def patient(self, institution: str = HALLYM, *, patient_id: str, name: str, birth: str, sex: str) -> Iterator[Fixture]:
        self.demographics = {"name": name, "birth": birth, "sex": sex}
        try:
            fixture = self.create_fixture(institution, patient_id=patient_id)
        finally:
            self.demographics = None
        try:
            yield fixture
        finally:
            self.cleanup_fixture(fixture.uid)


class ClinicianTimelineLive(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.stack = TimelineStack()
        cls.addClassCleanup(cls.stack.cleanup_test_identities)
        cls.addClassCleanup(cls.stack.cleanup_all)
        cls.stack.require_stack()
        cls.created_role = False
        role = cls.stack.kc_admin("GET", "/roles/clinician")
        if role.status == 404:
            created = cls.stack.kc_admin("POST", "/roles", {"name": "clinician", "description": "temporary S5-U3 clinician role"})
            if created.status != 201:
                raise RuntimeError(f"clinician role creation failed: {created.status} {created.text}")
            cls.created_role = True
        elif role.status != 200:
            raise RuntimeError(f"clinician role lookup failed: {role.status} {role.text}")
        cls.addClassCleanup(cls.delete_role_if_created)
        cls.stack.create_test_identity("clinician", ["clinician"], "hallym")
        cls.stack.create_test_identity("kclinician", ["clinician"], "kin-center")
        for user in ("clinician", "kclinician"):
            cls.stack.token(user)

    @classmethod
    def delete_role_if_created(cls) -> None:
        if not cls.created_role:
            return
        cls.stack._admin_login()
        deleted = cls.stack.kc_admin("DELETE", "/roles/clinician")
        if deleted.status not in (204, 404):
            raise RuntimeError(f"temporary clinician role cleanup failed: {deleted.status}")
        cls.created_role = False

    # ── helpers ──

    def run_id(self) -> str:
        return uuid.uuid4().hex[:10].upper()

    def call(self, method: str, path: str, user: str, body=None, status: int = 200):
        result = self.stack.request(method, path, user, body)
        self.assertEqual(result.status, status, f"{method} {path} as {user}: {result.text[:400]}")
        return result

    def page(self, anchor: str, user: str = "clinician", query: str = "?limit=100", status: int = 200):
        return self.call("GET", f"/clinician/studies/{quote(anchor)}/timeline{query}", user, status=status)

    def timeline(self, anchor: str, user: str = "clinician", limit: int = 100) -> tuple[dict, list[dict]]:
        """Every page, each cursor passed back verbatim; the head fields must be the same on every page."""
        rows, after, head, total = [], None, None, None
        for _ in range(1000):
            query = f"?limit={limit}" + ("&after=" + quote(after, safe="") if after else "")
            body = self.page(anchor, user, query).body
            self.assert_shape(body, anchor)
            current = {"patientKey": body["patientKey"], "identity": body["identity"]}
            head = current if head is None else head
            self.assertEqual(current, head, "patient key and relation are the same on every page")
            pagination = body["pagination"]
            total = pagination["total"] if total is None else total
            self.assertEqual((pagination["total"], pagination["offset"], pagination["limit"]), (total, len(rows), limit))
            rows += body["studies"]
            after = pagination["next"]
            if after is None:
                break
        uids = [row["uid"] for row in rows]
        self.assertEqual(uids, sorted(uids), "UID order across pages")
        self.assertEqual(len(set(uids)), total, "total counts exactly the rows paged through")
        self.assertIn(anchor, uids, "the anchor is in its own timeline")
        return head, rows

    def assert_shape(self, body: dict, anchor: str) -> None:
        self.assertEqual(sorted(body), sorted(TIMELINE_KEYS))
        self.assertEqual(body["uid"], anchor)
        self.assertEqual(sorted(body["identity"]), sorted(IDENTITY_KEYS))
        self.assertIn(body["identity"]["birth"], RELATIONS)
        self.assertIn(body["identity"]["sex"], RELATIONS)
        self.assertEqual(body["identity"]["conflict"], "mismatch" in (body["identity"]["birth"], body["identity"]["sex"]))
        self.assertEqual(sorted(body["pagination"]), sorted(C["pagination_keys"]))
        for row in body["studies"]:
            self.assertEqual(sorted(row), sorted(ROW_KEYS), row.get("uid"))
            self.assertEqual(sorted(row["identity"]), sorted(ROW_IDENTITY_KEYS))
            self.assertEqual(row["sourcePatientKey"], body["patientKey"], "every row carries the anchor's server key")
            report = row["report"]
            self.assertEqual(sorted(report), sorted(C["report_final_keys"] if report["final"] else C["report_open_keys"]))
        self.assertEqual(sorted(deep_keys(body) & FORBIDDEN), [], "a writer/engineering field reached the clinician")

    def relations(self, rows: list[dict]) -> dict[str, tuple[str, str]]:
        return {row["uid"]: (row["identity"]["birth"], row["identity"]["sex"]) for row in rows}

    def raw(self, path: str, user: str) -> tuple[int, str | None]:
        request = Request(self.stack.api + path, headers={"Accept": "application/json",
                                                           "Authorization": "Bearer " + self.stack.token(user)})
        try:
            with self.stack._open(request) as response:
                response.read()
                return response.status, response.headers.get("Cache-Control")
        except HTTPError as error:
            error.read()
            return error.code, error.headers.get("Cache-Control")

    def listed_keys(self, user: str) -> dict[str, str | None]:
        return {row["uid"]: row["sourcePatientKey"] for row in self.call("GET", "/clinician/studies", user).body["studies"]}

    # ── tests ──

    def test_01_same_name_is_not_the_same_patient_and_another_name_does_not_split_one(self) -> None:
        run = self.run_id()
        name = f"S5U3^SAMENAME{run}"
        with ExitStack() as fixtures:
            first = fixtures.enter_context(self.stack.patient(patient_id=f"S5U3-A-{run}", name=name, birth="19800517", sex="M"))
            other = fixtures.enter_context(self.stack.patient(patient_id=f"S5U3-B-{run}", name=name, birth="19800517", sex="M"))
            renamed = fixtures.enter_context(self.stack.patient(patient_id=f"S5U3-A-{run}", name=f"S5U3^RENAMED{run}",
                                                                 birth="19800517", sex="M"))
            head, rows = self.timeline(first.uid)
            names = {row["uid"]: row["name"] for row in rows}
            self.assertEqual({first.uid, renamed.uid}, set(names), "the server key groups; the name neither merges nor splits")
            self.assertEqual((head["patientKey"], names[first.uid], names[renamed.uid]),
                             (f"hallym|S5U3-A-{run}", f"S5U3 SAMENAME{run}", f"S5U3 RENAMED{run}"))
            self.assertEqual(head["identity"], {"conflict": False, "birth": "match", "sex": "match"})
            alone, only = self.timeline(other.uid)
            self.assertEqual(([other.uid], f"hallym|S5U3-B-{run}", {"conflict": False, "birth": "not_comparable",
                                                                    "sex": "not_comparable"}),
                             ([row["uid"] for row in only], alone["patientKey"], alone["identity"]))
            marker("01-name-merge", anchor_members=len(rows), same_name_other_id_members=len(only),
                   same_name_other_id_in_anchor=other.uid in names)

    def test_02_same_patient_id_other_birth_or_sex_is_one_timeline_with_a_conflict_marker(self) -> None:
        run = self.run_id()
        pid = f"S5U3-ID-{run}"
        with ExitStack() as fixtures:
            def make(birth: str, sex: str, patient_id: str = pid) -> Fixture:
                return fixtures.enter_context(self.stack.patient(patient_id=patient_id, name=f"S5U3^IDENTITY{run}",
                                                                  birth=birth, sex=sex))
            base, same, birth_other, sex_other, no_birth = (make("19800517", "M"), make("19800517", "M"),
                                                             make("19810517", "M"), make("19800517", "F"), make("", "M"))
            head, rows = self.timeline(base.uid)
            self.assertEqual({base.uid, same.uid, birth_other.uid, sex_other.uid, no_birth.uid}, {row["uid"] for row in rows})
            self.assertEqual(head, {"patientKey": f"hallym|{pid}",
                                    "identity": {"conflict": True, "birth": "mismatch", "sex": "mismatch"}})
            self.assertEqual({base.uid: ("match", "match"), same.uid: ("match", "match"),
                              birth_other.uid: ("mismatch", "match"), sex_other.uid: ("match", "mismatch"),
                              no_birth.uid: ("not_comparable", "match")}, self.relations(rows))
            # Relations are to the anchor: from the other birth date the rest of the group is the mismatch.
            _, turned = self.timeline(birth_other.uid)
            self.assertEqual({base.uid: ("mismatch", "match"), same.uid: ("mismatch", "match"),
                              birth_other.uid: ("match", "match"), sex_other.uid: ("mismatch", "mismatch"),
                              no_birth.uid: ("not_comparable", "match")}, self.relations(turned))

            # A technician overlay displays the anchor's birth date over the other one (RS W): the display follows it,
            # the marker does not move — it is the original DICOM value's relation (S4-U5 P12).
            self.call("PATCH", f"/studies/{quote(birth_other.uid)}", "tech", {"ov": {"birth": "19800517"}})
            head_after, after = self.timeline(base.uid)
            shown = next(row for row in after if row["uid"] == birth_other.uid)
            self.assertEqual(("19800517", ("mismatch", "match")), (shown["birth"], self.relations(after)[birth_other.uid]))
            self.assertEqual(head_after["identity"], {"conflict": True, "birth": "mismatch", "sex": "mismatch"})

            # The same PatientID with the same values is a match, not a conflict.
            twin_pid = f"S5U3-MATCH-{run}"
            one, two = make("19800517", "M", twin_pid), make("19800517", "M", twin_pid)
            twins, twin_rows = self.timeline(one.uid)
            self.assertEqual(({one.uid, two.uid}, {"conflict": False, "birth": "match", "sex": "match"}),
                             ({row["uid"] for row in twin_rows}, twins["identity"]))
            marker("02-id-only-identity", members=len(rows), identity=head["identity"],
                   relations=sorted(self.relations(rows).values()), overlay_birth_shown=shown["birth"],
                   overlay_relation=self.relations(after)[birth_other.uid], match_identity=twins["identity"])

    def test_03_tele_referrals_bound_the_receiving_timeline_and_institutions_stay_apart(self) -> None:
        run = self.run_id()
        pid = f"S5U3-TELE-{run}"
        with ExitStack() as fixtures:
            sent_a = fixtures.enter_context(self.stack.patient(patient_id=pid, name=f"S5U3^TELE{run}", birth="19800517", sex="M"))
            sent_b = fixtures.enter_context(self.stack.patient(patient_id=pid, name=f"S5U3^TELE{run}", birth="19800517", sex="M"))
            own = fixtures.enter_context(self.stack.patient(KIN, patient_id=pid, name=f"S5U3^TELE{run}", birth="19800517", sex="M"))
            kept = fixtures.enter_context(self.stack.patient(patient_id=pid, name=f"S5U3^TELE{run}", birth="19800517", sex="M"))
            # Before any referral the receiver has only its own study; the sender's studies are 404 for it.
            self.page(sent_a.uid, "kclinician", status=404)
            for fixture in (sent_a, sent_b):
                self.call("PATCH", f"/studies/{quote(fixture.uid)}", "doctor", {"ts": "wait", "teleTo": "kin-center"})

            head, rows = self.timeline(sent_a.uid, "kclinician")
            self.assertEqual(({sent_a.uid, sent_b.uid}, f"hallym|{pid}"), ({row["uid"] for row in rows}, head["patientKey"]))
            self.assertTrue(all(row["tele"] is True and row["institutionName"] for row in rows))
            self.assertNotIn(kept.uid, {row["uid"] for row in rows}, "a study not referred stays with the sender")
            mine, mine_rows = self.timeline(own.uid, "kclinician")
            self.assertEqual(([own.uid], f"kin-center|{pid}", False),
                             ([row["uid"] for row in mine_rows], mine["patientKey"], mine_rows[0]["tele"]))
            # The sender sees its three studies and never the receiver's own; the receiver's study is 404 for it.
            _, sender_rows = self.timeline(sent_a.uid, "clinician")
            self.assertEqual({sent_a.uid, sent_b.uid, kept.uid}, {row["uid"] for row in sender_rows})
            self.page(own.uid, "clinician", status=404)
            # COUNT-LEAK: the timeline is exactly the listed studies of that key for the same caller.
            listed = self.listed_keys("kclinician")
            self.assertEqual({uid for uid, key in listed.items() if key == f"hallym|{pid}"}, {row["uid"] for row in rows})

            # Cancelling one referral takes it out; cancelling the anchor's makes the anchor 404.
            self.call("PATCH", f"/studies/{quote(sent_b.uid)}", "doctor", {"ts": "cancelled"})
            _, after_cancel = self.timeline(sent_a.uid, "kclinician")
            self.assertEqual([sent_a.uid], [row["uid"] for row in after_cancel])
            self.page(sent_b.uid, "kclinician", status=404)
            self.call("PATCH", f"/studies/{quote(sent_a.uid)}", "doctor", {"ts": "cancelled"})
            self.page(sent_a.uid, "kclinician", status=404)
            marker("03-tenant", receiver_open=len(rows), receiver_own=len(mine_rows), sender=len(sender_rows),
                   after_one_cancel=len(after_cancel), anchor_cancelled_status=404)

    def test_04_role_gates_shapes_cursors_paging_fields_and_no_audit(self) -> None:
        run = self.run_id()
        pid = f"S5U3-PAGE-{run}"
        with ExitStack() as fixtures:
            studies = [fixtures.enter_context(self.stack.patient(patient_id=pid, name=f"S5U3^PAGE{run}", birth="19800517",
                                                                  sex="M")) for _ in range(3)]
            anchor = studies[0]
            secret, draft = "S5U3-SECRET-" + uuid.uuid4().hex, "S5U3-DRAFT-" + uuid.uuid4().hex
            committed = self.call("POST", f"/studies/{quote(studies[1].uid)}/report/commit", "doctor",
                                  {"action": "approve", "baseVersion": 0, "findings": secret, "conclusion": "approved",
                                   "recommendation": ""}, status=201).body["version"]
            self.call("PUT", f"/studies/{quote(studies[2].uid)}/report", "doctor2",
                      {"findings": draft, "conclusion": "", "recommendation": "", "baseVersion": 0})

            # Role gates: the read is need('clinician'); other institutions' clinicians get 404 (existence is data too).
            for user in ("doctor", "tech"):
                with self.subTest(wrong_role=user):
                    result = self.page(anchor.uid, user, status=403)
                    self.assertNotEqual(result.body.get("code"), DENIED)
                    self.assertIn("clinician 권한", result.body.get("message", ""))
            self.page(anchor.uid, "kclinician", status=404)

            # 400 shapes: the UID, no query, a limit out of range, an unknown key, an overlong cursor.
            for query in ("", "?limit=0", "?limit=101", "?limit=1&x=1", "?after=abc", "?limit=1&after=" + "a" * 4097):
                with self.subTest(query=query[:30]):
                    self.page(anchor.uid, query=query, status=400)
            self.page("not-a-uid", status=400)
            # 409: a forged cursor, another anchor's cursor, and the clinician list's cursor.
            first = self.page(anchor.uid, query="?limit=1").body
            forged = first["pagination"]["next"][:-2] + ("AA" if not first["pagination"]["next"].endswith("AA") else "BB")
            other_anchor = self.page(studies[1].uid, query="?limit=1").body["pagination"]["next"]
            listed = self.call("GET", "/clinician/studies?limit=1", "clinician").body["pagination"]["next"]
            for name, cursor in (("forged", forged), ("other-anchor", other_anchor), ("list", listed)):
                with self.subTest(cursor=name):
                    result = self.page(anchor.uid, query="?limit=1&after=" + quote(cursor, safe=""), status=409)
                    self.assertEqual(result.body.get("code"), "STUDY_LIST_CHANGED")

            # limit=1 paging: three pages, each cursor verbatim, the same head fields on every page.
            head, rows = self.timeline(anchor.uid, limit=1)
            self.assertEqual(sorted(fixture.uid for fixture in studies), [row["uid"] for row in rows])
            reports = {row["uid"]: row["report"] for row in rows}
            self.assertEqual({"final": True, "rs": "A", "action": "approve", "version": committed},
                             {key: reports[studies[1].uid][key] for key in ("final", "rs", "action", "version")})
            self.assertEqual(reports[studies[2].uid], {"final": False, "rs": "W"})
            text = json.dumps([head, rows], ensure_ascii=False)
            for value in (secret, draft):
                self.assertNotIn(value, text, "the timeline carries status only, never a body or a draft")

            status, cache = self.raw(f"/clinician/studies/{quote(anchor.uid)}/timeline?limit=100", "clinician")
            self.assertEqual((200, "no-store"), (status, cache))
            actor = self.stack.actor("clinician").replace("'", "''")
            self.assertEqual(psql(f"SELECT count(*) FROM \"AuditLog\" WHERE actor='{actor}'"), ["0"], "reads write no audit")
            marker("04-contract", pages=len(rows), wrong_role=403, other_tenant=404, bad_shapes=400,
                   foreign_cursors=409, cache_control=cache)


if __name__ == "__main__":
    print("Run through scripts/run-tests.py --mode live; direct execution is refused by the gate.", file=sys.stderr)
    raise SystemExit(125)
