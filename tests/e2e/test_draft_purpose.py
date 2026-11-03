"""CD-09-P served: a private draft work's purpose end, its destruction, re-reading and the restore re-application.

REQ: consult-cd09-split-report.md section 5 (unit P) acceptance 1-3 and 5 -> RISK: an ended draft's text survives, is
served again, or comes back from an older backup -> TEST: this file (HTTP through the HTTPS proxy, real PostgreSQL, the
API's own startup gate and sweep process, the external ledger file in the API's purpose volume).

Run only through the guarded runner on an operator-owned synthetic stack (KIN_SYNTHETIC_REALM=1 and its Compose
project). LiveStack supplies the accounts and the study; every row read or changed belongs to this file's fixture study
or its synthetic accounts. The restore case drops and restores the synthetic stack's own `kin` database from a dump taken
in the same case: never run it against any other stack.

What is asserted is behaviour: HTTP statuses and envelopes, the stored rows, the ledger's lines. A ledger line may carry
only the opaque unit and the destruction facts; the test reads the whole file for the study, author and text.
Not here: the browser (acceptance 4, pending the screen unit), and a response held open by a slow client (the HTTPS
proxy buffers the API's answer, so the delivery wait is covered by tests/emr/retention/draft_purpose_test.cjs P13).
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import unittest
import uuid
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from invariants_live import LiveStack, ROOT, psql

LEDGER = "/var/lib/kin-purpose/purpose-ledger.jsonl"
RECORD_FIELDS = sorted(["formatVersion", "phase", "day", "disposalUnitId", "classes", "clauseIds", "partCount", "expiryDay",
                        "extensionUsed", "dueDay", "timeliness", "method", "basis"])


def event(stage, **result):
    print("CD09P " + json.dumps({"stage": stage, **result}, ensure_ascii=True), flush=True)


def _checked(result, what, check=True):
    if check and result.returncode:
        raise RuntimeError("compose " + what + " failed: " + result.stdout.decode(errors="replace")[-1500:]
                           + result.stderr.decode(errors="replace")[-1500:])
    return result


# Each Compose verb is literal at its call (the guarded runner's inherited project selection, tests/execution_guard_test.py TG-02).
def compose_exec(*args, timeout=300, check=True, stdin=None):
    return _checked(subprocess.run(["docker", "compose", "exec", *args], cwd=ROOT, capture_output=True, timeout=timeout,
                                   input=stdin), "exec " + " ".join(args[:3]), check)


def compose_stop_api():
    return _checked(subprocess.run(["docker", "compose", "stop", "api"], cwd=ROOT, capture_output=True, timeout=120), "stop api")


def compose_start_api():
    return _checked(subprocess.run(["docker", "compose", "start", "api"], cwd=ROOT, capture_output=True, timeout=120), "start api")


def compose_restart_api():
    return _checked(subprocess.run(["docker", "compose", "restart", "api"], cwd=ROOT, capture_output=True, timeout=300), "restart api")


def compose_api_logs(since):
    return subprocess.run(["docker", "compose", "logs", "--no-color", "--since", since, "api"], cwd=ROOT, capture_output=True,
                          timeout=120).stdout.decode(errors="replace")


def sql_text(value):
    return "'" + str(value).replace("'", "''") + "'"


class DraftPurposeServed(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if os.environ.get("KIN_SYNTHETIC_REALM") != "1" or not os.environ.get("COMPOSE_PROJECT_NAME"):
            raise RuntimeError("NOT_RUN_ENV: operator-owned synthetic realm and Compose project required")
        cls.stack = LiveStack()
        cls.addClassCleanup(cls.stack.cleanup_test_identities)
        cls.addClassCleanup(cls.stack.cleanup_all)
        cls.stack.require_stack()

    def setUp(self):
        self.fixture = self.stack.create_fixture()
        self.uid = self.fixture.uid
        self.addCleanup(self.drop_ended_rows)

    def drop_ended_rows(self):
        # Ended rows (held or refused cases) of this fixture study only; the study's own cleanup removes the drafts.
        psql(f'DELETE FROM "ReportDraftPurposeEnd" WHERE uid={sql_text(self.uid)}')

    # ── product calls (a commit is a POST: 201 Created; the draft routes answer 200) ──

    def path(self, tail=""):
        return f"/studies/{quote(self.uid)}" + tail

    def save(self, user, text, *, revision=None, base=0):
        body = {"findings": text, "conclusion": "SYN conclusion", "recommendation": "", "baseVersion": base,
                "citationIds": [], "structureIds": []}
        if revision is not None:
            body.update(expectedOwner=self.owner(user), expectedRevision=revision)
        return self.stack.request("PUT", self.path("/report"), user, body)

    def discard(self, user, revision=None):
        body = {} if revision is None else {"expectedOwner": self.owner(user), "expectedRevision": revision}
        return self.stack.request("DELETE", self.path("/draft"), user, body)

    def read(self, user):
        result = self.stack.request("GET", self.path("/draft"), user)
        self.assertEqual(result.status, 200, result.text)
        return result.body

    def owner(self, user):
        me = self.stack.request("GET", "/me", user).body
        return {"institution": me["institution"], "sub": me["sub"], "author": me["actor"]}

    # ── stored facts ──

    def row(self, user):
        actor = self.stack.actor(user)
        lines = psql('SELECT row_to_json(d)::text FROM (SELECT present, findings, conclusion, revision, "workUnit", "workIntent" '
                     f'FROM "ReportDraft" WHERE uid={sql_text(self.uid)} AND author={sql_text(actor)}) d')
        return json.loads(lines[0]) if lines else None

    def ended(self, unit):
        lines = psql('SELECT row_to_json(e)::text FROM (SELECT trigger, findings, "lastRefusal", "deliverySettled" '
                     f'FROM "ReportDraftPurposeEnd" WHERE "disposalUnitId"={sql_text(unit)}) e')
        return json.loads(lines[0]) if lines else None

    def ledger_bytes(self):
        result = compose_exec("-T", "api", "sh", "-c", f"if [ -f {LEDGER} ]; then cat {LEDGER}; fi")
        return result.stdout

    def ledger(self):
        text = self.ledger_bytes().decode()
        lines = [json.loads(line) for line in text.splitlines()]
        return lines[0] if lines else None, lines[1:]

    def phases(self, unit):
        return [entry["record"]["phase"] for entry in self.ledger()[1] if entry["record"]["disposalUnitId"] == unit]

    def wait_destroyed(self, unit, timeout=60):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.ended(unit) is None and "completed" in self.phases(unit):
                return
            time.sleep(0.5)
        self.fail(f"unit not destroyed within {timeout}s: phases={self.phases(unit)} row={self.ended(unit)}")

    def assert_ledger_names_nothing(self, *secrets):
        text = self.ledger_bytes().decode()
        for secret in secrets:
            self.assertNotIn(secret, text, "the operational ledger carries a record identifier or text")
        header, entries = self.ledger()
        for entry in entries:
            self.assertEqual(sorted(entry["record"]), RECORD_FIELDS)

    def sweep(self):
        result = compose_exec("-T", "api", "node", "dist/emr-retention/draft-purpose-sweep.js", check=False)
        out = result.stdout.decode(errors="replace").strip().splitlines()
        return result.returncode, json.loads(out[-1]) if out else None

    def access_entries(self):
        return int(psql("SELECT count(*) FROM emr_access.access_entry")[0])

    # ── A1/A2: the author's discard ──

    def test_p1_discard_destroys_exactly_the_authors_work_and_keeps_everything_else(self):
        doctor, other = "doctor", "doctor2"
        secret, kept = "SYN-P1 private " + uuid.uuid4().hex, "SYN-P1 colleague " + uuid.uuid4().hex
        self.assertEqual(self.save(doctor, secret).status, 200)
        self.assertEqual(self.save(other, kept).status, 200)
        mine = self.row(doctor)
        self.assertTrue(mine["present"])
        self.assertRegex(mine["workUnit"], r"^disposal:[0-9a-f-]{36}$")
        before_access = self.access_entries()
        # Save again: the same work continues (one unit for one work).
        again = self.save(doctor, secret + " more")
        self.assertEqual(again.status, 200)
        self.assertEqual(self.row(doctor)["workUnit"], mine["workUnit"])
        stale = self.read(doctor)["revision"]
        discarded = self.discard(doctor)
        self.assertEqual(discarded.status, 200, discarded.text)
        self.assertFalse(discarded.body["present"])
        unit = mine["workUnit"]
        self.wait_destroyed(unit)
        self.assertEqual(self.phases(unit), ["started", "completed"])
        row = self.row(doctor)
        self.assertEqual((row["present"], row["findings"], row["workUnit"]), (False, "", None))
        self.assertGreater(row["revision"], mine["revision"] + 1)
        self.assertEqual(self.ended(unit), None)
        # Re-read: no content, the empty boundary only.
        envelope = self.read(doctor)
        self.assertEqual((envelope["present"], envelope["snapshot"]), (False, None))
        # The colleague's work, the access records and the ledger's privacy all hold.
        self.assertEqual((self.row(other)["present"], self.row(other)["findings"]), (True, kept))
        self.assertGreaterEqual(self.access_entries(), before_access)
        self.assert_ledger_names_nothing(self.uid, self.stack.actor(doctor), secret)
        # A request of the ended work (its old revision) cannot write it back.
        late = self.save(doctor, secret, revision=stale)
        self.assertEqual(late.status, 409, late.text)
        self.assertEqual(self.row(doctor)["findings"], "")
        # The author can start a new work explicitly; it has its own unit.
        fresh = self.save(doctor, "SYN-P1 new work")
        self.assertEqual(fresh.status, 200, fresh.text)
        self.assertNotEqual(self.row(doctor)["workUnit"], unit)
        event("p1", unit_destroyed=True, late_write=late.status)

    def test_p2_clear_and_own_reset_end_the_work_but_save_and_forced_release_do_not(self):
        doctor, admin = "doctor", "jmryu"
        # Clear: every field emptied by the author.
        self.assertEqual(self.save(doctor, "SYN-P2 clear").status, 200)
        unit = self.row(doctor)["workUnit"]
        cleared = self.stack.request("PUT", self.path("/report"), doctor,
                                     {"findings": "", "conclusion": "", "recommendation": "", "baseVersion": 0})
        self.assertEqual(cleared.status, 200, cleared.text)
        self.wait_destroyed(unit)
        # Save (an unsigned version): the text lives on in the report version; no purpose end is recorded.
        self.assertEqual(self.save(doctor, "SYN-P2 saved").status, 200)
        unit = self.row(doctor)["workUnit"]
        saved = self.stack.request("POST", self.path("/report/commit"), doctor,
                                   {"action": "save", "baseVersion": 0, "findings": "SYN-P2 saved", "conclusion": "SYN conclusion",
                                    "recommendation": ""})
        self.assertEqual(saved.status, 201, saved.text)
        self.assertEqual(self.phases(unit), [])
        self.assertIsNone(self.ended(unit))
        self.assertEqual(psql(f'SELECT findings FROM "ReportVersion" WHERE uid={sql_text(self.uid)} AND action=\'save\''), ["SYN-P2 saved"])
        # Forced release by the administrator keeps the text as a discarded version: no purpose end.
        self.assertEqual(self.save(doctor, "SYN-P2 forced", base=1).status, 200)
        unit = self.row(doctor)["workUnit"]
        forced = self.stack.request("DELETE", self.path("/draft/force"), admin, {})
        self.assertEqual(forced.status, 200, forced.text)
        self.assertEqual(self.phases(unit), [])
        self.assertEqual(psql(f'SELECT count(*) FROM "ReportVersion" WHERE uid={sql_text(self.uid)} AND action=\'discarded\' '
                              f'AND findings=\'SYN-P2 forced\''), ["1"])
        # The author's own Reset keeps nothing of the draft: an explicit discard.
        self.assertEqual(self.save(doctor, "SYN-P2 reset draft", base=1).status, 200)
        unit = self.row(doctor)["workUnit"]
        reset = self.stack.request("POST", self.path("/report/commit"), doctor,
                                   {"action": "reset", "baseVersion": 1, "reason": "SYN reset", "findings": "", "conclusion": "",
                                    "recommendation": ""})
        self.assertEqual(reset.status, 201, reset.text)
        self.wait_destroyed(unit)
        event("p2", clear=True, save_kept=True, forced_kept=True, reset=True)

    def test_p3_signed_result_ends_the_signers_work_and_not_a_colleagues(self):
        doctor, other = "doctor", "doctor2"
        self.assertEqual(self.save(doctor, "SYN-P3 to sign").status, 200)
        self.assertEqual(self.save(other, "SYN-P3 colleague").status, 200)
        unit = self.row(doctor)["workUnit"]
        approved = self.stack.request("POST", self.path("/report/commit"), doctor,
                                      {"action": "approve", "baseVersion": 0, "findings": "SYN-P3 to sign",
                                       "conclusion": "SYN conclusion", "recommendation": ""})
        self.assertEqual(approved.status, 201, approved.text)
        self.wait_destroyed(unit)
        self.assertEqual(psql(f'SELECT action FROM "ReportVersion" WHERE uid={sql_text(self.uid)} AND findings=\'SYN-P3 to sign\''),
                         ["approve"])
        # Another member's approval is not an end of this colleague's draft (intent-superseded is not supported natively).
        self.assertEqual((self.row(other)["present"], self.row(other)["findings"]), (True, "SYN-P3 colleague"))
        self.assertEqual(self.read(other)["present"], True)
        event("p3", signed_destroyed=True, colleague_kept=True)

    # ── A3: overlap, retry and failure recovery ──

    def test_p4_save_and_discard_overlap_one_wins_and_the_loser_changes_nothing(self):
        doctor = "doctor"
        outcomes = []
        for attempt in range(8):
            self.assertEqual(self.save(doctor, f"SYN-P4 base {attempt}").status, 200)
            unit, revision = self.row(doctor)["workUnit"], self.read(doctor)["revision"]
            owner = self.owner(doctor)
            results = {}
            body_save = {"findings": f"SYN-P4 late {attempt}", "conclusion": "", "recommendation": "", "baseVersion": 0,
                         "citationIds": [], "structureIds": [], "expectedOwner": owner, "expectedRevision": revision}
            body_discard = {"expectedOwner": owner, "expectedRevision": revision}
            go = threading.Barrier(2)

            def run(name, method, path, body):
                go.wait()
                results[name] = self.stack._send(method, path, doctor, body)
            threads = [threading.Thread(target=run, args=("save", "PUT", self.path("/report"), body_save)),
                       threading.Thread(target=run, args=("discard", "DELETE", self.path("/draft"), body_discard))]
            for thread in threads: thread.start()
            for thread in threads: thread.join(60)
            statuses = (results["save"].status, results["discard"].status)
            self.assertIn(statuses, [(200, 409), (409, 200)], f"exactly one of the same-boundary writes wins: {statuses}")
            row = self.row(doctor)
            if statuses == (409, 200):
                self.wait_destroyed(unit)
                self.assertEqual((row["present"], row["findings"]), (False, ""))
            else:
                self.assertEqual((row["present"], row["findings"]), (True, f"SYN-P4 late {attempt}"))
                self.assertEqual(self.phases(unit), [])
                self.assertEqual(self.discard(doctor).status, 200)
                self.wait_destroyed(unit)
            outcomes.append(statuses)
        event("p4", outcomes=outcomes)

    def test_p5_lost_answer_and_concurrent_retry_end_the_work_once(self):
        doctor = "doctor"
        self.assertEqual(self.save(doctor, "SYN-P5").status, 200)
        unit, revision = self.row(doctor)["workUnit"], self.read(doctor)["revision"]
        owner, results = self.owner(doctor), []
        go = threading.Barrier(3)

        def run():
            go.wait()
            results.append(self.stack._send("DELETE", self.path("/draft"), doctor, {"expectedOwner": owner, "expectedRevision": revision}).status)
        threads = [threading.Thread(target=run) for _ in range(3)]
        for thread in threads: thread.start()
        for thread in threads: thread.join(60)
        self.assertEqual(sorted(results), [200, 409, 409])
        self.wait_destroyed(unit)
        self.assertEqual(self.phases(unit), ["started", "completed"])
        # The client that lost its answer re-reads: the end is visible as the empty boundary, not as an error or a draft.
        envelope = self.read(doctor)
        self.assertEqual((envelope["present"], envelope["snapshot"]), (False, None))
        event("p5", retries=sorted(results))

    def test_p6_reads_overlapping_the_discard_never_return_the_text_after_the_end(self):
        doctor, secret = "doctor", "SYN-P6 " + uuid.uuid4().hex
        self.assertEqual(self.save(doctor, secret).status, 200)
        unit, stop, after_end, seen = self.row(doctor)["workUnit"], threading.Event(), threading.Event(), []

        def reader():
            while not stop.is_set():
                started_after = after_end.is_set()
                result = self.stack._send("GET", self.path("/draft"), doctor, None)
                if result.status == 200:
                    seen.append((started_after, bool(result.body.get("present"))))
        threads = [threading.Thread(target=reader) for _ in range(3)]
        for thread in threads: thread.start()
        time.sleep(1)
        self.assertEqual(self.discard(doctor).status, 200)
        after_end.set()
        self.wait_destroyed(unit)
        time.sleep(1)
        stop.set()
        for thread in threads: thread.join(60)
        self.assertTrue(any(not started for started, _ in seen))
        self.assertFalse([1 for started, present in seen if started and present], "a read begun after the end returned the draft")
        event("p6", reads=len(seen))

    def test_p7_a_hold_keeps_the_payload_until_its_release_then_the_sweep_destroys_it(self):
        doctor, secret = "doctor", "SYN-P7 held " + uuid.uuid4().hex
        self.assertEqual(self.save(doctor, secret).status, 200)
        unit = self.row(doctor)["workUnit"]
        record = json.dumps([self.uid, self.stack.actor(doctor)], separators=(",", ":"))
        # A hold binds this work only from its own placement on (never before the work started): place it a second later.
        time.sleep(1.1)
        at = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
        hold_id = "syn-cd09p-" + uuid.uuid4().hex
        hold = {"holdId": hold_id, "recordId": record, "actorId": "syn-custodian", "at": at, "release": None,
                "basis": {"type": "court-order", "clause": {"law": "synthetic-law", "article": "article-1", "version": "2026-v1"},
                          "clauseId": "synthetic-law:article-1", "authorityKind": "court", "managingInstitutionId": "hallym",
                          "requestId": "syn-request", "authorityId": "syn-court", "scope": [record], "verified": True,
                          "validity": {"from": at, "until": None, "condition": "order-in-force"}}}
        psql("INSERT INTO emr_access.clause_version SELECT 'synthetic-law:article-1','2026-v1','synthetic-law','article-1',"
             "'2026-01-01','2026-01-01',now() WHERE NOT EXISTS (SELECT 1 FROM emr_access.clause_version "
             "WHERE clause_id='synthetic-law:article-1')")
        psql(f"SELECT emr_access.place_hold({sql_text(hold_id)}, {sql_text(record)}, {sql_text(json.dumps(hold))})::text")
        self.assertEqual(self.discard(doctor).status, 200)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline and (self.ended(unit) or {}).get("lastRefusal") is None:
            time.sleep(0.5)
        held = self.ended(unit)
        self.assertEqual((held["findings"], held["lastRefusal"]), (secret, "LegalHoldActive"))
        self.assertEqual(self.phases(unit), [], "nothing recorded while the hold is live")
        # The author's view is the empty boundary; the held payload is not served.
        self.assertEqual(self.read(doctor)["present"], False)
        code, report = self.sweep()
        self.assertEqual(code, 0, report)
        self.assertIn({"unit": unit, "outcome": "held", "code": "LegalHoldActive"}, report["results"])
        released_at = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(time.time() + 1))
        time.sleep(1.5)
        released = {**hold, "release": {"holdId": hold_id, "actorId": "syn-custodian", "at": released_at,
                                        "evidenceId": "syn-ending", "authorityVerified": True, "reason": "order-ended"}}
        psql(f"SELECT emr_access.release_hold({sql_text(hold_id)}, {sql_text(json.dumps(released))})::text")
        code, report = self.sweep()
        self.assertEqual(code, 0, report)
        self.assertIn(unit, [r["unit"] for r in report["results"] if r["outcome"] == "destroyed"])
        self.assertIsNone(self.ended(unit))
        self.assertEqual(self.phases(unit), ["started", "completed"])
        event("p7", held=True, released_then_destroyed=True)

    def test_p8_a_ledger_failure_keeps_the_payload_pending_and_the_sweep_resumes_exactly(self):
        doctor, secret = "doctor", "SYN-P8 " + uuid.uuid4().hex
        # A first destruction so that the ledger exists.
        self.assertEqual(self.save(doctor, "SYN-P8 first").status, 200)
        first = self.row(doctor)["workUnit"]
        self.assertEqual(self.discard(doctor).status, 200)
        self.wait_destroyed(first)
        original = self.ledger_bytes()
        self.assertEqual(self.save(doctor, secret).status, 200)
        unit = self.row(doctor)["workUnit"]
        try:
            compose_exec("-T", "api", "sh", "-c", f"printf '%s' '{{\"kind\":\"entry\"' >> {LEDGER}")
            self.assertEqual(self.discard(doctor).status, 200, "the end itself does not depend on the ledger")
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline and (self.ended(unit) or {}).get("lastRefusal") is None:
                time.sleep(0.5)
            pending = self.ended(unit)
            self.assertEqual((pending["findings"], pending["lastRefusal"]), (secret, "PurposeLedgerPartialTail"))
            code, report = self.sweep()
            self.assertEqual(code, 1, "an unreadable ledger is a failed sweep, never a success")
        finally:
            compose_exec("-T", "api", "sh", "-c", f"cat > {LEDGER}", stdin=original)
        self.assertEqual(self.ledger_bytes(), original)
        code, report = self.sweep()
        self.assertEqual(code, 0, report)
        self.assertIsNone(self.ended(unit))
        self.assertEqual(self.phases(unit), ["started", "completed"])
        event("p8", failure_kept_pending=True, resumed=True)

    # ── A5: restore re-application and the closed gate ──

    def restart_api(self):
        compose_restart_api()

    def wait_api(self, healthy=True, timeout=240, code=None, since=None):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                health = self.stack.request("GET", "/health")
                if health.status == 200 and health.body.get("ok"):
                    if healthy:
                        return
                    self.fail("the API opened although its draft ledger could not be matched")
            except Exception:
                pass
            if not healthy and code:
                logs = compose_api_logs(since)
                if code in logs:
                    return
            time.sleep(2)
        self.fail(f"API {'did not open' if healthy else 'did not report ' + str(code)} within {timeout}s")

    def reload_proxy(self):
        compose_exec("-T", "proxy", "nginx", "-s", "reload", check=False)

    def closed_then_reopened(self, code, damage, repair):
        since = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        damage()
        try:
            self.restart_api()
            self.wait_api(healthy=False, code=code, since=since)
        finally:
            repair()
            self.restart_api()
            self.reload_proxy()
            self.wait_api()
        event("gate_closed", code=code)

    def test_p9_restore_reapplies_the_destruction_and_a_mismatched_ledger_keeps_the_server_closed(self):
        doctor, other = "doctor", "doctor2"
        secret, kept = "SYN-P9 destroyed " + uuid.uuid4().hex, "SYN-P9 colleague " + uuid.uuid4().hex
        self.assertEqual(self.save(doctor, secret).status, 200)
        self.assertEqual(self.save(other, kept).status, 200)
        unit, colleague = self.row(doctor)["workUnit"], self.row(other)["workUnit"]
        compose_exec("-T", "db", "pg_dump", "-U", "kin", "-d", "kin", "-Fc", "--create", "-f", "/tmp/cd09p-before.dump")
        self.assertEqual(self.discard(doctor).status, 200)
        self.wait_destroyed(unit)
        ledger_after = self.ledger_bytes()
        header, entries = self.ledger()
        completed_day = [e["record"]["day"] for e in entries if e["record"]["disposalUnitId"] == unit and e["record"]["phase"] == "completed"]
        # The old copy is restored over the live database while the API is stopped; the ledger volume is not touched.
        compose_stop_api()
        try:
            compose_exec("-T", "db", "psql", "-U", "kin", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c",
                    "DROP DATABASE kin WITH (FORCE)")
            compose_exec("-T", "db", "pg_restore", "-U", "kin", "-d", "postgres", "--create", "--exit-on-error",
                    "/tmp/cd09p-before.dump", timeout=600)
            restored = psql(f'SELECT findings FROM "ReportDraft" WHERE "workUnit"={sql_text(unit)}')
            self.assertEqual(restored, [secret], "the restored copy holds the destroyed text before the gate")
        finally:
            compose_start_api()
            self.reload_proxy()
        self.wait_api()
        row = self.row(doctor)
        self.assertEqual((row["present"], row["findings"], row["workUnit"]), (False, "", None))
        self.assertEqual(self.read(doctor)["present"], False)
        self.assertEqual((self.row(other)["present"], self.row(other)["findings"], self.row(other)["workUnit"]), (True, kept, colleague))
        self.assertEqual(self.ledger_bytes(), ledger_after, "re-application writes no new record and no new five-day clock")
        self.assertEqual([e["record"]["day"] for e in self.ledger()[1] if e["record"]["disposalUnitId"] == unit and e["record"]["phase"] == "completed"],
                         completed_day)
        # A second re-application (restart) changes nothing; a new work started now survives it.
        self.assertEqual(self.save(doctor, "SYN-P9 after restore").status, 200)
        fresh = self.row(doctor)["workUnit"]
        self.restart_api(); self.reload_proxy(); self.wait_api()
        self.assertEqual((self.row(doctor)["findings"], self.row(doctor)["workUnit"]), ("SYN-P9 after restore", fresh))
        self.assertEqual(self.row(other)["findings"], kept)
        self.assertEqual(self.ledger_bytes(), ledger_after)
        event("p9_restore", reapplied=True, idempotent=True)
        # One more completed destruction, so that this database has seen the ledger (the gate cases below need it).
        self.assertEqual(self.save(other, "SYN-P9 anchor").status, 200)
        moved = self.row(other)["workUnit"]
        self.assertEqual(self.discard(other).status, 200)
        self.wait_destroyed(moved)
        self.assertGreater(int(psql('SELECT seq FROM "PurposeLedgerAnchor" WHERE id=1')[0]), 0)

        anchor = psql('SELECT "ledgerId"::text FROM "PurposeLedgerAnchor" WHERE id=1')[0]
        # A copy that never saw this ledger (as a restore from before the migration gets: a new ledger ID) stays closed.
        self.closed_then_reopened("PurposeLedgerMismatch",
            lambda: psql('UPDATE "PurposeLedgerAnchor" SET "ledgerId"=gen_random_uuid() WHERE id=1'),
            lambda: psql(f'UPDATE "PurposeLedgerAnchor" SET "ledgerId"={sql_text(anchor)}::uuid WHERE id=1'))
        # The ledger is missing beside a copy that saw completions.
        self.closed_then_reopened("PurposeLedgerMissing",
            lambda: compose_exec("-T", "api", "mv", LEDGER, LEDGER + ".moved"),
            lambda: compose_exec("-T", "api", "mv", LEDGER + ".moved", LEDGER))
        # A started attempt this copy cannot settle (its end is not in this copy).
        header, entries = self.ledger()
        started = dict(entries[-1]["record"], phase="started", disposalUnitId="disposal:" + str(uuid.uuid4()))
        line = json.dumps({"kind": "entry", "seq": len(entries) + 1, "ledgerId": header["ledgerId"],
                           "appendedAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()), "record": started}) + "\n"
        whole = self.ledger_bytes()
        self.closed_then_reopened("PurposeIntentIncomplete",
            lambda: compose_exec("-T", "api", "sh", "-c", f"cat >> {LEDGER}", stdin=line.encode()),
            lambda: compose_exec("-T", "api", "sh", "-c", f"cat > {LEDGER}", stdin=whole))
        self.assertEqual(self.ledger_bytes(), whole)
        event("p9_gate", closed=["PurposeLedgerMismatch", "PurposeLedgerMissing", "PurposeIntentIncomplete"])


if __name__ == "__main__":
    unittest.main()
