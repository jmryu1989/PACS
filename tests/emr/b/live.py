"""EMR-B1 live ledger cases L01-L08 and L17-L19 (REQ-EMR-01/02/06/07/19/20 -> RISK-EMR-* -> TEST-EMR-B-L01..L08/L17..L19).

Runs only through scripts/run-tests.py in live mode. Every database this class uses is a PostgreSQL 16 container it
creates itself: no network, tmpfs data, its own tmpfs tablespace mount, generated credentials, this run's label. The
product code is the production API image built from this checkout (KIN_TEST_API_IMAGE, else built here and removed at the
end): its one-shot `migrate` mode applies the migrations with the installer credential, and its compiled store runs
through the contract file's driver (tests/emr/b/contract_test.cjs --emr-b-live) with the runtime role. No port is
published, no compose stack or foreign container is touched, and everything created here carries this run's label and is
removed by class cleanup, including setup failures. Assertions are SQLSTATEs, returned/stored facts and closed error codes.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tests"))
import live_test_gate as gate  # noqa: E402

_spec = importlib.util.spec_from_file_location("emr_compose", ROOT / "scripts" / "emr-compose.py")
emr_compose = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(emr_compose)

POSTGRES = "postgres:16-alpine"
DRIVER_DIR = ROOT / "tests" / "emr" / "b"
STATE = "/var/lib/kin-emr"
TABLESPACE = "/var/lib/postgresql/emr-access/ts"
REFUSED = "42501"
OLD = ["2020-01-0%dT00:00:00.000Z" % day for day in range(1, 10)]


def run(args, *, env=None, input=None, timeout=300, check=True):
    result = subprocess.run(args, input=input, capture_output=True, timeout=timeout, env=env)
    if check and result.returncode:
        raise RuntimeError("%s %s failed (exit %d): %s" % (args[0], args[1], result.returncode,
                                                          result.stderr.decode("utf-8", "replace")[-1500:]))
    return result


class EmrBLedgerLive(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        gate.require_live_run()
        cls.token = uuid.uuid4().hex[:12]
        cls.label = "kin.emrb.live=" + cls.token
        cls.created = {"container": [], "volume": [], "image": []}
        cls.addClassCleanup(cls.cleanup_resources)
        cls.secrets = {name: secrets.token_hex(24) for name in
                       ("POSTGRES_PASSWORD", "KIN_EMR_RUNTIME_PASSWORD", "KIN_EMR_READER_PASSWORD", "KIN_EMR_RETENTION_PASSWORD")}
        cls.env = {**os.environ, **cls.secrets}
        image = os.environ.get("KIN_TEST_API_IMAGE")
        if image:
            cls.image = json.loads(run(["docker", "image", "inspect", image]).stdout)[0]["Id"]
        else:
            tag = "kin-emrb-live:" + cls.token
            run(["docker", "build", "--target", "production", "--label", cls.label, "--build-arg", "VCS_REF=emr-b-live",
                 "-t", tag, str(ROOT / "api")], timeout=1800)
            cls.created["image"].append(tag)
            cls.image = json.loads(run(["docker", "image", "inspect", tag]).stdout)[0]["Id"]
        cls.db = cls.start_db("main")
        cls.provision(cls.db)
        cls.migrate(cls.db)
        cls.state = cls.volume("main")

    @classmethod
    def cleanup_resources(cls):
        problems = []
        for kind in ("container", "volume", "image"):
            for name in reversed(cls.created[kind]):
                args = {"container": ["docker", "rm", "-f", "-v", name], "volume": ["docker", "volume", "rm", "-f", name],
                        "image": ["docker", "image", "rm", "-f", name]}[kind]
                if run(args, check=False, timeout=120).returncode:
                    problems.append(kind + " " + name)
        leftover = run(["docker", "ps", "-aq", "--filter", "label=" + cls.label], check=False).stdout.split()
        leftover += run(["docker", "volume", "ls", "-q", "--filter", "label=" + cls.label], check=False).stdout.split()
        if problems or leftover:
            raise RuntimeError("EMR-B live cleanup incomplete: %s %s" % (problems, leftover))

    # ── disposable environment ──

    @classmethod
    def start_db(cls, suffix):
        name = "kin-emrb-%s-%s" % (cls.token, suffix)
        cls.created["container"].append(name)
        run(["docker", "run", "-d", "--name", name, "--label", cls.label, "--network", "none",
             "--tmpfs", "/var/lib/postgresql/data", "--tmpfs", "/var/lib/postgresql/emr-access:uid=70,gid=70,mode=0700",
             "-e", "POSTGRES_USER=kin", "-e", "POSTGRES_PASSWORD", "-e", "POSTGRES_DB=kin", POSTGRES], env=cls.env)
        for _ in range(240):
            if run(["docker", "exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "kin"], check=False).returncode == 0:
                break
            time.sleep(0.25)
        else:
            raise RuntimeError("disposable database did not start")
        run(["docker", "exec", "-u", "postgres", name, "mkdir", "-m", "700", TABLESPACE])
        return name

    @classmethod
    def provision(cls, db, sql=None):
        result = run(["docker", "exec", "-i", "-e", "KIN_EMR_RUNTIME_PASSWORD", "-e", "KIN_EMR_READER_PASSWORD", "-e",
                      "KIN_EMR_RETENTION_PASSWORD", db, "psql", "-X", "-U", "kin", "-d", "kin"],
                     env=cls.env, input=(sql or emr_compose.PROVISION_SQL).encode(), check=False)
        if result.returncode:
            raise RuntimeError("provisioning failed: " + result.stderr.decode("utf-8", "replace")[-800:])

    @classmethod
    def url(cls, role="kin_runtime", database="kin"):
        password = {"kin_runtime": "KIN_EMR_RUNTIME_PASSWORD", "kin": "POSTGRES_PASSWORD",
                    "kin_emr_retention": "KIN_EMR_RETENTION_PASSWORD", "kin_emr_reader": "KIN_EMR_READER_PASSWORD"}[role]
        return "postgresql://%s:%s@127.0.0.1:5432/%s" % (role, cls.secrets[password], database)

    @classmethod
    def migrate(cls, db, database="kin"):
        env = {**cls.env, "DATABASE_URL": cls.url("kin", database)}
        result = run(["docker", "run", "--rm", "--label", cls.label, "--network", "container:" + db, "-e", "DATABASE_URL",
                      cls.image, "sh", "/app/start-production.sh", "migrate"], env=env, check=False, timeout=300)
        if result.returncode:
            raise RuntimeError("migration failed: " + (result.stdout + result.stderr).decode("utf-8", "replace")[-1500:])
        return result.stdout.decode("utf-8", "replace")

    @classmethod
    def volume(cls, suffix):
        name = "kin-emrb-%s-state-%s" % (cls.token, suffix)
        cls.created["volume"].append(name)
        run(["docker", "volume", "create", "--label", cls.label, name])
        return name

    def copy_volume(self, source, suffix):
        target = self.volume(suffix)
        run(["docker", "run", "--rm", "--label", self.label, "--network", "none", "-u", "0", "-v", source + ":/s", "-v", target + ":/d",
             "--entrypoint", "sh", self.image, "-c", "cp -a /s/. /d/"])
        return target

    def as_root(self, volume, command):
        run(["docker", "run", "--rm", "--label", self.label, "--network", "none", "-u", "0", "-v", volume + ":" + STATE,
             "--entrypoint", "sh", self.image, "-c", command])

    def driver(self, operation, args=None, *, db=None, volume=None, url=None):
        env = {**self.env, "DATABASE_URL": url or self.url(), "EMR_READER_URL": self.url("kin_emr_reader")}
        result = run(["docker", "run", "--rm", "--label", self.label, "--network", "container:" + (db or self.db),
                      "-e", "DATABASE_URL", "-e", "EMR_READER_URL", "-e", "KIN_EMR_STATE_DIR=" + STATE, "-v", (volume or self.state) + ":" + STATE,
                      "-v", str(DRIVER_DIR) + ":/emr-b:ro", "--entrypoint", "node", self.image,
                      "/emr-b/contract_test.cjs", "--emr-b-live", operation, json.dumps(args or {})], env=env, check=False, timeout=300)
        lines = [line for line in result.stdout.decode("utf-8", "replace").splitlines() if line.startswith("EMR_B_RESULT ")]
        if len(lines) != 1:
            if result.returncode == 0 and not lines:
                return {"exited": True}
            self.fail("driver %s gave no single result (exit %d): %s" % (operation, result.returncode,
                                                                          result.stderr.decode("utf-8", "replace")[-1500:]))
        return json.loads(lines[0][len("EMR_B_RESULT "):])

    def psql(self, sql, *, user="kin", database="kin", db=None):
        """(exit, stdout lines, first SQLSTATE) of one psql run as the given role (local socket, trust)."""
        result = run(["docker", "exec", "-i", db or self.db, "psql", "-X", "-q", "-A", "-t", "-U", user, "-d", database, "-v", "ON_ERROR_STOP=1"],
                     input=("\\set VERBOSITY sqlstate\n" + sql).encode(), check=False)
        stderr = result.stderr.decode("utf-8", "replace")
        state = next((line.split()[1] for line in stderr.splitlines() if line.startswith("ERROR:") and len(line.split()) > 1), None)
        return result.returncode, result.stdout.decode("utf-8", "replace").splitlines(), state

    def ok(self, sql, **kwargs):
        code, lines, state = self.psql(sql, **kwargs)
        self.assertEqual((code, state), (0, None), sql[:200])
        return lines

    def refused(self, sql, **kwargs):
        code, _, state = self.psql(sql, **kwargs)
        self.assertNotEqual(code, 0, sql[:200])
        return state

    def entries(self, **kwargs):
        return self.driver("entries", **kwargs)

    def tamper(self, statement, database, db=None):
        """A superuser change past the append-only guard (replica mode for this one transaction): a fixture only."""
        self.ok("BEGIN; SET LOCAL session_replication_role = replica; %s; COMMIT;" % statement, database=database, db=db)

    def auth_event(self, occurred="2026-10-09T00:00:00.000Z", subject=None):
        who = {"id": str(uuid.uuid4()), "issuer": "https://identity.example.test", "subject": subject or "sub-" + uuid.uuid4().hex[:8]}
        return {"formatVersion": 2, "branch": "online-auth", "surface": "GET auth/callback", "eventId": str(uuid.uuid4()),
                "userId": {"status": "known", "value": who}, "rolesAtTime": {"status": "known", "value": ["radiologist"]},
                "rightsVersion": {"status": "known", "value": 1}, "actingInstitution": {"status": "known", "value": "hospital-a"},
                "managingInstitution": {"status": "known", "value": "hospital-a"}, "occurredAt": occurred,
                "trustedProxyIp": {"status": "known", "value": {"address": "192.0.2.10", "source": "trusted-proxy"}},
                "cause": "user-view", "executor": "member", "affectedIdentity": {"status": "known", "value": who},
                "context": {"basis": "authentication", "studyId": None, "relatedStudyId": None, "reason": None},
                "session": {"status": "known", "value": "authref:" + str(uuid.uuid4())}, "targets": [], "action": "auth.login",
                "result": "succeeded", "auth": {"endCause": None, "failureCause": None, "trigger": None},
                "requestId": "request-" + uuid.uuid4().hex, "auditLinkId": "audit:" + str(uuid.uuid4()), "relatedEventId": None}

    def provide_event(self, occurred="2026-10-09T00:00:00.000Z", **overrides):
        """A provision before a report version's body: an event about an EMR record (열람), A's v1 format; with overrides
        (surface, action, result) the same shape is a change of that record (기재), recorded in both streams (D-1)."""
        who = {"id": str(uuid.uuid4()), "issuer": "https://identity.example.test", "subject": "sub-" + uuid.uuid4().hex[:8]}
        return {"formatVersion": 1, "surface": "GET studies/:uid/report/versions", "eventId": "provide-" + str(uuid.uuid4()),
                "userId": {"status": "known", "value": who}, "rolesAtTime": {"status": "known", "value": ["radiologist"]},
                "actingInstitution": {"status": "known", "value": "hospital-a"}, "managingInstitution": {"status": "known", "value": "hospital-a"},
                "occurredAt": occurred, "trustedProxyIp": {"status": "known", "value": {"address": "192.0.2.1", "source": "trusted-proxy"}},
                "cause": "user-view", "executor": "member",
                "context": {"basis": "assigned-reading", "studyId": "study-1", "relatedStudyId": None, "reason": None},
                "targets": [{"kind": "report-version", "patientLinkSnapshot": {"status": "known", "value": {"linkId": "link-1", "patientId": "SYN-1", "assigningAuthority": "hospital-a"}},
                             "studyId": {"status": "known", "value": "study-1"}, "recordId": {"status": "known", "value": "report-1"},
                             "versionId": {"status": "known", "value": "version-1"}}],
                "action": "provide-prepared", "result": "prepared", "requestId": "request-" + uuid.uuid4().hex,
                "auditLinkId": "audit:" + str(uuid.uuid4()), "relatedEventId": None, **overrides}

    def change_event(self, occurred="2026-10-09T00:00:00.000Z"):
        return self.provide_event(occurred, eventId="change-" + str(uuid.uuid4()), surface="POST studies/:uid/report/commit",
                                  action="approve-sign", result="succeeded")

    def chain_ok(self, entries):
        """Recompute A's chain bytes over the stored payloads (independently of the product code)."""
        previous = None
        for entry in entries:
            if previous is not None:
                self.assertEqual((entry["sequence"], entry["previousHash"]), (previous["sequence"] + 1, previous["hash"]))
            text = '{"sequence":%d,"previousHash":"%s","payload":%s}' % (entry["sequence"], entry["previousHash"], entry["payload"])
            self.assertEqual(hashlib.sha256(text.encode("utf-8")).hexdigest(), entry["hash"])
            previous = entry

    # ── L01 ──
    def test_b01_ledger_roles_and_restart(self):
        """Runtime appends and reads back after a restart; every way back to owner/superuser power is refused."""
        # The dedicated owner, schema, tablespace and its own mount.
        self.assertEqual(self.ok("SELECT pg_tablespace_location(oid) FROM pg_tablespace WHERE spcname = 'kin_emr_access'"), [TABLESPACE])
        placement = self.ok("SELECT relation || '=' || tablespace FROM emr_access.storage_placement()", user="kin_runtime")
        self.assertGreaterEqual(len(placement), 14)
        self.assertTrue(all(line.endswith("=kin_emr_access") for line in placement), placement)
        self.assertEqual(self.ok("SELECT DISTINCT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
                                 "WHERE n.nspname = 'emr_access'") + self.ok("SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'emr_access'"),
                         ["kin_emr_owner", "kin_emr_owner"])
        mounts = run(["docker", "exec", self.db, "cat", "/proc/mounts"]).stdout.decode()
        self.assertIn(" /var/lib/postgresql/emr-access ", mounts)
        self.assertIn(" /var/lib/postgresql/data ", mounts)
        self.assertEqual(self.ok("SELECT string_agg(rolname || ':' || rolsuper || rolcreaterole || rolcreatedb || rolreplication || rolbypassrls || ':' || rolcanlogin, ',' ORDER BY rolname) "
                                 "FROM pg_roles WHERE rolname IN ('kin_emr_owner', 'kin_runtime', 'kin_emr_reader', 'kin_emr_retention')"),
                         ["kin_emr_owner:falsefalsefalsefalsefalse:false,kin_emr_reader:falsefalsefalsefalsefalse:true,"
                          "kin_emr_retention:falsefalsefalsefalsefalse:true,kin_runtime:falsefalsefalsefalsefalse:true"])
        self.assertEqual(self.ok("SELECT count(*) FROM pg_auth_members m JOIN pg_roles r ON r.oid IN (m.member, m.roleid) "
                                 "WHERE r.rolname IN ('kin_emr_owner', 'kin_runtime', 'kin_emr_reader', 'kin_emr_retention')"), ["0"])
        # The runtime's start check and two appends; a restarted process reads the same chain and seal back.
        verified = self.driver("verify-runtime")
        self.assertEqual(verified["role"], "kin_runtime", verified)
        appended = self.driver("append", {"count": 2})
        self.assertTrue(all("receipt" in result for result in appended["results"]), appended)
        recovered = self.driver("recover")
        self.assertEqual((recovered["recovered"], recovered["notCommitted"]), (0, 0), recovered)
        tail = self.driver("tail")
        self.assertEqual((recovered["seal"]["sequence"], recovered["seal"]["hash"]), (tail["sequence"], tail["hash"]))
        stored = self.entries()
        self.chain_ok(stored)
        self.assertEqual([entry["eventId"] for entry in stored[-2:]], [result["eventId"] for result in appended["results"]])
        # Refused for the runtime role: direct ledger DML, DDL, trigger and replication switches, role escalation, expiry.
        before = self.ok("SELECT count(*) || ':' || max(hash) FROM emr_access.access_entry")
        statements = [
            "INSERT INTO emr_access.access_entry SELECT * FROM emr_access.access_entry LIMIT 0",
            "UPDATE emr_access.access_entry SET payload = payload", "DELETE FROM emr_access.access_entry",
            "TRUNCATE emr_access.access_entry", "UPDATE emr_access.chain_head SET sequence = 0",
            "SELECT count(*) FROM emr_access.access_entry",
            "ALTER TABLE emr_access.access_entry DISABLE TRIGGER ALL", "DROP TABLE emr_access.access_entry",
            "CREATE TABLE emr_access.syn_probe (a integer)", "CREATE TABLE public.syn_probe (a integer)",
            "ALTER TABLE \"AuditLog\" DISABLE TRIGGER USER", "UPDATE \"AuditLog\" SET detail = detail", "DELETE FROM \"AuditLog\"",
            "SET session_replication_role = replica", "SET ROLE kin_emr_owner", "SET ROLE kin", "GRANT kin_emr_owner TO kin_runtime",
            "ALTER ROLE kin_runtime SUPERUSER", "ALTER ROLE kin_runtime CREATEROLE", "CREATE ROLE syn_probe",
            "SELECT emr_access.expire_prefix(1)",
            "SELECT emr_access.record_clause_version('syn', 'syn', 'syn', 'syn', '2026-01-01', '2026-01-01')",
        ]
        for statement in statements:
            with self.subTest(statement=statement):
                self.assertEqual(self.refused(statement, user="kin_runtime"), REFUSED)
        self.assertEqual(self.ok("SELECT count(*) || ':' || max(hash) FROM emr_access.access_entry"), before)
        # The owner path itself is append-only too, and the installer credential is refused as the server's.
        self.assertEqual(self.refused("DELETE FROM emr_access.access_entry"), REFUSED)
        installer = self.driver("verify-runtime", url=self.url("kin"))
        self.assertEqual(installer.get("error"), "EmrRuntimeRefused", installer)
        self.assertTrue({"not-the-runtime-role", "rolsuper"} <= set(installer.get("problems") or []), installer)

    # ── L02 ──
    def test_b02_business_commit_and_failure_journal(self):
        """The business row, its projection and its ledger fact commit together; a rollback or ledger failure leaves no
        success and a journal record that outlives it; a broken journal is an explicit failure, never a success."""
        rows = lambda: int(self.ok("SELECT count(*) FROM \"AuditLog\" WHERE actor = 'SYNTHETIC-emr-b'")[0])
        count0 = rows()
        done = self.driver("business")
        self.assertIn("receipt", done, done)
        eid = done["eventId"]
        self.assertEqual(rows(), count0 + 1)
        self.assertEqual(self.ok("SELECT count(*) FROM emr_access.access_entry e JOIN emr_access.audit_projection p ON p.event_id = e.event_id "
                                 "JOIN \"AuditLog\" a ON a.id = p.audit_log_id WHERE e.event_id = '%s'" % eid), ["1"])
        seal = self.driver("seal")
        # A business rollback after the append: nothing of it stays in the database, its journal record does.
        failed = self.driver("business", {"fail": "business-after-append"})
        self.assertEqual((failed["error"], failed["settled"]), ("SyntheticBusinessRefusal", None), failed)
        self.assertEqual(rows(), count0 + 1)
        self.assertEqual(self.ok("SELECT count(*) FROM emr_access.access_entry WHERE event_id = '%s'" % failed["eventId"]), ["0"])
        journal = self.driver("journal")
        self.assertIn("append-rolled-back:%s:business-rollback" % failed["eventId"], [record["id"] for record in journal])
        self.assertEqual(self.driver("seal")["sequence"], seal["sequence"])
        # The ledger refuses (its storage moved off the dedicated tablespace): the business change rolls back with it.
        self.ok("ALTER TABLE emr_access.member_identity SET TABLESPACE pg_default")
        try:
            broken = self.driver("business")
            self.assertEqual(broken["error"], "EB001", broken)
        finally:
            self.ok("ALTER TABLE emr_access.member_identity SET TABLESPACE kin_emr_access")
        self.assertEqual(rows(), count0 + 1)
        self.assertIn("append-rolled-back:%s:ledger-refused" % broken["eventId"], [record["id"] for record in self.driver("journal")])
        # The intent cannot be made durable: the transaction aborts before its commit, and that is journaled.
        self.as_root(self.state, "chmod 500 %s/seal/pending" % STATE)
        try:
            no_intent = self.driver("business")
        finally:
            self.as_root(self.state, "chmod 700 %s/seal/pending" % STATE)
        self.assertEqual(no_intent["error"], "SealUnavailable", no_intent)
        self.assertEqual(rows(), count0 + 1)
        # The journal itself fails: the failure is reported as such and nothing claims success.
        self.as_root(self.state, "chmod 400 %s/journal/failure-journal.jsonl" % STATE)
        try:
            dark = self.driver("business", {"fail": "business-after-append"})
        finally:
            self.as_root(self.state, "chmod 600 %s/journal/failure-journal.jsonl" % STATE)
        self.assertEqual((dark["error"], dark["settled"]), ("SyntheticBusinessRefusal", "LedgerUnreachable"), dark)
        self.assertEqual(rows(), count0 + 1)
        recovered = self.driver("recover")
        self.assertEqual(recovered["recovered"], 0, recovered)

    # ── L03 ──
    def test_b03_idempotency_and_concurrent_append(self):
        """Concurrent original events are all ordered once; the same event resent is the same receipt; another content
        under its ID is refused; one verified subject is one identity however many resolve it at once. The appends run
        at once in one server process (its connection pool), the deployment's one API per state volume."""
        start = self.driver("tail")["sequence"]
        results = self.driver("append", {"count": 24, "concurrent": True})["results"]
        self.assertEqual(len(results), 24)
        self.assertTrue(all("receipt" in r for r in results), [r for r in results if "receipt" not in r][:3])
        stored = [e for e in self.entries() if e["sequence"] > start]
        self.assertEqual([e["sequence"] for e in stored], list(range(start + 1, start + 25)))
        self.assertEqual(sorted(e["eventId"] for e in stored), sorted(r["eventId"] for r in results))
        self.chain_ok(stored)
        self.assertEqual(self.driver("recover")["recovered"], 0)
        # The same event again: the same receipt, no new entry; another content under the ID: refused, still one entry.
        event = self.auth_event()
        first = self.driver("append", {"events": [event]})["results"][0]
        again = self.driver("append", {"events": [event]})["results"][0]
        self.assertEqual(first["receipt"], again["receipt"])
        changed = dict(event, requestId="request-other")
        conflict = self.driver("append", {"events": [changed]})["results"][0]
        self.assertIn(conflict["error"], ("AccessEventIdConflict", "EB002"), conflict)
        self.assertEqual(self.ok("SELECT count(*) FROM emr_access.access_entry WHERE event_id = '%s'" % event["eventId"]), ["1"])
        # One verified issuer+subject, one immutable ID; namesakes and other issuers are other members.
        pairs = [["https://identity.example.test", "sub-a"]] * 4 + [["https://identity.example.test", "sub-b"], ["https://other.example.test", "sub-a"]]
        ids = self.driver("identity", {"pairs": pairs})
        self.assertEqual(len(set(ids[:4])), 1)
        self.assertEqual(len(set(ids)), 3)
        self.assertEqual(self.ok("SELECT count(*) FROM emr_access.member_identity WHERE subject IN ('sub-a', 'sub-b')"), ["3"])
        # A change of a record commits in both streams with its business row and is sealed in both (D-1); a resend is the
        # same two entries.
        change = self.change_event()
        done = self.driver("business", {"event": change})
        self.assertIn("receipt", done, done)
        history = self.driver("entries", {"stream": "history"})
        self.assertEqual([e["eventId"] for e in history][-1:], [change["eventId"]])
        self.chain_ok(history)
        sealed = self.driver("seal")
        self.assertEqual((sealed["streams"]["history"]["sequence"], sealed["streams"]["history"]["hash"]), (history[-1]["sequence"], history[-1]["hash"]))
        self.assertIn("receipt", self.driver("append", {"events": [change]})["results"][0])
        self.assertEqual(self.ok("SELECT stream || ':' || count(*) FROM emr_access.access_entry WHERE event_id = '%s' GROUP BY stream ORDER BY stream" % change["eventId"]),
                         ["history:1", "viewing:1"])

    # ── L04 ──
    def test_b04_chain_tail_and_crash_recovery(self):
        """A commit before its seal and an intent before its commit are each settled once at start; a deleted middle or
        tail, a changed entry, an unexplained tail and a lost or damaged seal refuse start."""
        db = self.start_db("l04")
        self.provision(db)
        self.migrate(db)
        state = self.volume("l04")
        for _ in range(3):
            self.assertIn("receipt", self.driver("business", db=db, volume=state))
        self.assertEqual(self.driver("recover", db=db, volume=state)["recovered"], 0)
        # Crash after the commit, before the seal: the next start seals it from the entry and its intent.
        crashed = self.driver("business", {"exit": "after-commit"}, db=db, volume=state)
        self.assertEqual(crashed, {"exited": True})
        after = self.driver("recover", db=db, volume=state)
        self.assertEqual((after["recovered"], after["notCommitted"]), (1, 0), after)
        self.assertEqual(after["seal"]["sequence"], 4)
        self.assertTrue(any(r["kind"] == "seal-recovered" for r in self.driver("journal", db=db, volume=state)))
        # Crash inside the transaction, before its commit: the intent proves an attempt that never committed.
        event = self.auth_event()
        self.assertEqual(self.driver("business", {"exit": "before-commit", "event": event}, db=db, volume=state), {"exited": True})
        before = self.driver("recover", db=db, volume=state)
        self.assertEqual((before["recovered"], before["notCommitted"]), (0, 1), before)
        self.assertIn("commit-not-found:viewing:" + event["eventId"], [r["id"] for r in self.driver("journal", db=db, volume=state)])
        resent = self.driver("append", {"events": [event]}, db=db, volume=state)["results"][0]
        self.assertIn("receipt", resent)
        self.assertEqual(self.ok("SELECT count(*) FROM emr_access.access_entry WHERE event_id = '%s'" % event["eventId"], db=db), ["1"])
        base = self.entries(db=db, volume=state)
        self.chain_ok(base)
        # Each tamper on its own copy of the database and of the state volume.
        def copy(name):
            self.ok("CREATE DATABASE %s TEMPLATE kin" % name, db=db)
            return self.copy_volume(state, name)
        cases = {
            "l04_middle": ("DELETE FROM emr_access.access_entry WHERE stream = 'viewing' AND sequence = 2", "LedgerChainBroken"),
            "l04_tail": ("DELETE FROM emr_access.access_entry WHERE stream = 'viewing' AND sequence = %d; UPDATE emr_access.chain_head SET sequence = %d, hash = '%s' WHERE stream = 'viewing'"
                         % (base[-1]["sequence"], base[-2]["sequence"], base[-2]["hash"]), "LedgerBehindSeal"),
            "l04_changed": ("UPDATE emr_access.access_entry SET payload = replace(payload, 'radiologist', 'admin') WHERE stream = 'viewing' AND sequence = 1", "LedgerChainBroken"),
        }
        forged_payload = json.dumps({"kind": "access", "event": {"eventId": str(uuid.uuid4()), "occurredAt": "2026-10-09T00:00:00.000Z"}}, separators=(",", ":"))
        sequence, previous = base[-1]["sequence"] + 1, base[-1]["hash"]
        forged_hash = hashlib.sha256(('{"sequence":%d,"previousHash":"%s","payload":%s}' % (sequence, previous, forged_payload)).encode()).hexdigest()
        cases["l04_forged"] = ("INSERT INTO emr_access.access_entry (stream, sequence, previous_hash, hash, kind, event_id, payload, content_sha256, statutory_act, occurred_at, stored_at) "
                               "VALUES ('viewing', %d, '%s', '%s', 'access', '%s', '%s', '%s', 'none', now(), now()); "
                               "UPDATE emr_access.chain_head SET sequence = %d, hash = '%s' WHERE stream = 'viewing'"
                               % (sequence, previous, forged_hash, json.loads(forged_payload)["event"]["eventId"], forged_payload.replace("'", "''"),
                                  hashlib.sha256(forged_payload.encode()).hexdigest(), sequence, forged_hash), "UnsealedEntryUnexplained")
        for name, (statement, expected) in cases.items():
            with self.subTest(case=name):
                volume = copy(name)
                self.tamper(statement, name, db=db)
                self.assertEqual(self.driver("recover", db=db, volume=volume, url=self.url(database=name)).get("error"), expected)
        # A lost or damaged seal is never rebuilt from the database's end.
        for name, command, expected in (("l04_noseal", "rm %s/seal/tail.json" % STATE, "SealMissing"),
                                        ("l04_badseal", "sed -i 's/\"sequence\":/\"sequence\":1/' %s/seal/tail.json" % STATE, "SealCorrupt")):
            with self.subTest(case=name):
                volume = copy(name)
                self.as_root(volume, command)
                self.assertEqual(self.driver("recover", db=db, volume=volume, url=self.url(database=name)).get("error"), expected)
        self.assertEqual(self.driver("recover", db=db, volume=state)["recovered"], 0, "the original stays intact")

    # ── L05 ──
    def test_b05_expiry_checkpoint_and_holds(self):
        """The retention role removes only an expired, unheld prefix with its checkpoint in one transaction, under the one
        retention rule: an old event about no record goes at the floor, an old event about an EMR record stays while that
        record's retention is not established (B1 has no record store); an unexpired, held, record-bound or direct
        deletion and any runtime call are refused; an interrupted expiry changes nothing."""
        db = self.start_db("l05")
        self.provision(db)
        self.migrate(db)
        state = self.volume("l05")
        old = [self.auth_event(OLD[n]) for n in range(3)]
        change_old = self.change_event(OLD[3])
        recent = [self.auth_event() for _ in range(2)]
        events = old + [change_old] + recent
        appended = self.driver("append", {"events": events}, db=db, volume=state)
        self.assertTrue(all("receipt" in r for r in appended["results"]), appended)
        # One retention rule: the database's single floor is the runtime rule's floor at every civil edge; no entry stores
        # a deadline; each event's record targets are bound exactly as the rule reads them from the same event.
        utc = "to_char(%s AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')"
        edges = ["2024-02-28T15:00:00.000Z", "2024-02-28T15:00:00.001Z", "2026-10-04T15:00:00.000Z", "2026-10-05T00:00:00.000Z", "2023-12-31T14:59:59.999Z"]
        from_rule = self.driver("civil", {"at": edges}, db=db, volume=state)
        from_sql = [self.ok("SELECT " + utc % ("emr_access.access_retention_floor('%s')" % at), db=db)[0] for at in edges]
        self.assertEqual(from_sql, from_rule)
        # PostgreSQL resolves this dependency itself; no SQL-text matching or intermediate-name pin.
        self.assertEqual(self.ok("SELECT count(*) FROM pg_depend d JOIN pg_proc p ON p.oid=d.objid "
            "WHERE d.classid='pg_proc'::regclass AND d.refclassid='pg_proc'::regclass "
            "AND d.refobjid='emr_access.civil_period_end(timestamptz,integer)'::regprocedure "
            "AND p.pronamespace='emr_access'::regnamespace", db=db), ["1"])
        self.assertEqual(self.ok("SELECT count(*) FROM information_schema.columns WHERE table_schema = 'emr_access' "
                                 "AND column_name IN ('expires_at', 'expiry', 'deadline')", db=db), ["0"])
        bound = [[{"index": int(i), "kind": k, "recordId": r or None, "versionId": v or None} for i, k, r, v in
                  (line.split("|") for line in self.ok("SELECT target_index, target_kind, coalesce(record_id, ''), coalesce(version_id, '') "
                   "FROM emr_access.access_target WHERE stream = 'viewing' AND event_id = '%s' ORDER BY target_index" % e["eventId"], db=db))] for e in events]
        self.assertEqual(bound, self.driver("targets", {"events": events}, db=db, volume=state))
        self.assertEqual([len(b) for b in bound], [0, 0, 0, 1, 0, 0])
        deadlines = self.driver("deadline", {"events": events}, db=db, volume=state)
        floors = self.driver("civil", {"at": [e["occurredAt"] for e in old + [change_old]]}, db=db, volume=state)
        self.assertEqual(deadlines[:3], [{"viewing": end} for end in floors[:3]])
        self.assertEqual(deadlines[3], {"viewing": floors[3], "history": None}, "a change: its viewing copy ends at the floor, its history with the record")
        # A hold on the second old event keeps it and everything after it.
        hold = {"holdId": "hold-l05", "recordId": old[1]["eventId"], "actorId": "custodian", "at": "2026-10-01T00:00:00.000Z", "release": None,
                "basis": {"type": "court-order", "clause": {"law": "synthetic-law", "article": "article-1", "version": "2026-v1"},
                          "clauseId": "synthetic-law:article-1", "authorityKind": "court", "managingInstitutionId": "hospital-a",
                          "requestId": "order-l05", "authorityId": "court-1", "scope": [old[1]["eventId"]], "verified": True,
                          "validity": {"from": "2026-10-01T00:00:00.000Z", "until": None, "condition": "order-in-force"}}}
        self.driver("holds", {"place": [hold]}, db=db, volume=state)
        retention = self.url("kin_emr_retention")
        self.assertEqual(self.refused("SELECT emr_access.expire_prefix(2)", user="kin_emr_retention", db=db), "EB005")
        first = self.driver("expire", url=retention, db=db, volume=state)
        self.assertIsInstance(first, dict)
        self.assertNotIn("error", first, "L05 expiry must return a committed deletion result")
        self.assertEqual(set(first), {"deleted", "checkpointSequence", "checkpointHash"})
        self.assertEqual(first["deleted"], 1, first)
        # Unexpired, held, middle and runtime deletions are refused; nothing moved.
        snapshot = self.ok("SELECT string_agg(sequence::text, ',' ORDER BY sequence) FROM emr_access.access_entry", db=db)
        self.assertEqual(self.refused("SELECT emr_access.expire_prefix(%d)" % (first["checkpointSequence"]), user="kin_emr_retention", db=db), "EB004")
        self.assertEqual(self.refused("DELETE FROM emr_access.access_entry WHERE sequence = 5", user="kin_emr_retention", db=db), REFUSED)
        self.assertEqual(self.refused("SELECT emr_access.expire_prefix(2)", user="kin_runtime", db=db), REFUSED)
        self.assertEqual(self.ok("SELECT string_agg(sequence::text, ',' ORDER BY sequence) FROM emr_access.access_entry", db=db), snapshot)
        # The retention view never shows the payload.
        self.assertEqual(self.refused("SELECT * FROM emr_access.entries_after('viewing', 0, 10)", user="kin_emr_retention", db=db), REFUSED)
        # An expiry interrupted before its commit: everything is as before.
        released = dict(hold, release={"holdId": "hold-l05", "actorId": "custodian", "at": "2026-10-09T00:00:00.000Z",
                                       "evidenceId": "order-l05-ended", "authorityVerified": True, "reason": "order-ended"})
        self.driver("holds", {"release": [released]}, db=db, volume=state)
        session = subprocess.Popen(["docker", "exec", "-i", db, "psql", "-X", "-q", "-A", "-t", "-U", "kin_emr_retention", "-d", "kin"],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        session.stdin.write(b"BEGIN;\nSELECT deleted_count FROM emr_access.expire_prefix(3);\nSELECT pg_sleep(30);\n"); session.stdin.flush()
        for _ in range(100):
            if self.ok("SELECT count(*) FROM pg_stat_activity WHERE usename = 'kin_emr_retention' AND query LIKE '%pg_sleep%'", db=db) == ["1"]:
                break
            time.sleep(0.2)
        self.ok("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'kin_emr_retention'", db=db)
        session.communicate(timeout=60)
        self.assertEqual(self.ok("SELECT string_agg(sequence::text, ',' ORDER BY sequence) FROM emr_access.access_entry", db=db), snapshot)
        # After the release the rest of the expired prefix goes with its own checkpoint - the old change's viewing copy too, at
        # its floor - while that change stays in the history stream, which no retention call touches; the chains stay verifiable.
        second = self.driver("expire", url=retention, db=db, volume=state)
        self.assertIsInstance(second, dict)
        self.assertNotIn("error", second, "L05 released prefix must expire successfully")
        self.assertEqual(set(second), {"deleted", "checkpointSequence", "checkpointHash"})
        self.assertEqual(second["deleted"], 3, second)
        remaining = self.entries(db=db, volume=state)
        self.assertEqual([e["kind"] for e in remaining], ["access", "access", "expiry", "expiry"])
        self.assertEqual(sorted(e["eventId"] for e in remaining if e["kind"] == "access"), sorted(e["eventId"] for e in recent))
        history = self.driver("entries", {"stream": "history"}, db=db, volume=state)
        self.assertEqual([(e["kind"], e["eventId"], e["statutoryAct"]) for e in history], [("history", change_old["eventId"], "기재")])
        self.chain_ok(history)
        self.assertEqual(self.ok("SELECT count(*) FROM emr_access.access_target WHERE stream = 'history' AND event_id = '%s'" % change_old["eventId"], db=db), ["1"])
        self.assertEqual(self.refused("DELETE FROM emr_access.access_entry WHERE stream = 'history'", user="kin_emr_retention", db=db), REFUSED)
        for checkpoint in (e for e in remaining if e["kind"] == "expiry"):
            self.assertNotIn("sub-", checkpoint["payload"])
        recovered = self.driver("recover", db=db, volume=state)
        self.assertEqual((recovered["recovered"], recovered["seal"]["sequence"]), (1, remaining[-1]["sequence"]), recovered)

    # ── L06 ──
    def test_b06_complete_reload_and_clause_history(self):
        """Every hold - active, ended and released - and the reviewed clause history reload complete in a new process;
        a failed read is never an empty set; a changed or deleted historical version is refused."""
        record = self.auth_event()["eventId"]
        clause = lambda publication, published, effective: (
            "SELECT emr_access.record_clause_version('synthetic-law:article-1', 'synthetic-law', 'article-1', '%s', '%s', '%s')"
            % (publication, published, effective))
        self.ok(clause("2026-v1", "2026-01-01", "2026-01-01"))
        self.assertEqual(self.refused(clause("2026-v9", "2026-01-01", "2026-02-01"), user="kin_runtime"), REFUSED)
        def hold(hold_id, at, version):
            return {"holdId": hold_id, "recordId": record, "actorId": "custodian", "at": at, "release": None,
                    "basis": {"type": "court-order", "clause": {"law": "synthetic-law", "article": "article-1", "version": version},
                              "clauseId": "synthetic-law:article-1", "authorityKind": "court", "managingInstitutionId": "hospital-a",
                              "requestId": "order-" + hold_id, "authorityId": "court-1", "scope": [record], "verified": True,
                              "validity": {"from": at, "until": None, "condition": "order-in-force"}}}
        active, lifted = hold("hold-active", "2026-10-05T00:00:00.000Z", "2026-v1"), hold("hold-lifted", "2026-10-05T00:00:00.000Z", "2026-v1")
        released = dict(lifted, release={"holdId": "hold-lifted", "actorId": "custodian", "at": "2026-10-07T00:00:00.000Z",
                                         "evidenceId": "order-ended-1", "authorityVerified": True, "reason": "order-ended"})
        placed = self.driver("holds", {"place": [active, lifted], "release": [released], "recordIds": [record], "clauseIds": ["synthetic-law:article-1"]})
        expected = [{"recordId": record, "holds": [{"holdId": "hold-active", "released": False, "version": "2026-v1", "at": active["at"]},
                                                   {"holdId": "hold-lifted", "released": True, "version": "2026-v1", "at": lifted["at"]}]}]
        self.assertEqual(placed, expected)
        request = {"recordIds": [record], "clauseIds": ["synthetic-law:article-1"]}
        self.assertEqual(self.driver("reload", request), expected, "a new process reloads the same complete set")
        # A later reviewed version is added; the history keeps the one these holds were registered under.
        self.ok(clause("2026-v2", "2026-11-01", "2026-11-15"))
        self.assertEqual(self.driver("reload", request), expected)
        for statement in ("UPDATE emr_access.clause_version SET publication = '2026-v1x' WHERE publication = '2026-v1'",
                          "DELETE FROM emr_access.clause_version WHERE publication = '2026-v1'",
                          "UPDATE emr_access.legal_hold_event SET body = body", "DELETE FROM emr_access.legal_hold_event"):
            with self.subTest(statement=statement):
                self.assertEqual(self.refused(statement), REFUSED)
        # A read that fails is an error, not an empty hold set.
        self.ok("REVOKE EXECUTE ON FUNCTION emr_access.holds_for(text) FROM kin_runtime")
        try:
            failed = self.driver("reload", request)
        finally:
            self.ok("GRANT EXECUTE ON FUNCTION emr_access.holds_for(text) TO kin_runtime")
        self.assertIn("error", failed)
        self.assertNotEqual(failed.get("error"), None)
        # A historical version removed past the guard: the old holds no longer reload as valid.
        self.ok("CREATE DATABASE l06_tampered TEMPLATE kin")
        self.tamper("DELETE FROM emr_access.clause_version WHERE publication = '2026-v1'", "l06_tampered")
        tampered = self.driver("reload", request, url=self.url(database="l06_tampered"))
        self.assertEqual(tampered, [{"recordId": record, "error": "HoldClauseRequired"}])

    # ── L07 ──
    def test_b07_migration_backup_restore_roles(self):
        """A clean install, a dump and a provisioned restore give back the same ledger, guards, grants, placement and
        trusted tail; a restore without roles, off its tablespace, with a stale or missing state, or without the
        migration is refused; the source never changes."""
        history = self.ok("SELECT migration_name || ':' || (finished_at IS NOT NULL) FROM _prisma_migrations ORDER BY migration_name COLLATE \"C\"")
        self.assertEqual(len(history), 43)
        self.assertEqual(history[-1], "20261008120000_emr_b:true")
        self.driver("append", {"count": 3})
        source_entries = self.entries()
        catalog_sql = ("SELECT string_agg(x, '|' ORDER BY x) FROM ("
                       "SELECT c.relname::text || ':' || pg_get_userbyid(c.relowner)::text || ':' || COALESCE(t.spcname::text, 'default') || ':' || "
                       "COALESCE((SELECT string_agg(a.acl::text, ',' ORDER BY a.acl::text) FROM unnest(c.relacl) AS a(acl)), '') AS x "
                       "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_tablespace t ON t.oid = c.reltablespace "
                       "WHERE n.nspname = 'emr_access' AND c.relkind IN ('r', 'i') UNION ALL "
                       "SELECT p.oid::regprocedure::text || ':' || pg_get_userbyid(p.proowner)::text || ':' || p.prosecdef::text || ':' || "
                       "COALESCE(array_to_string(p.proconfig, ';'), '') || ':' || COALESCE((SELECT string_agg(a.acl::text, ',' ORDER BY a.acl::text) FROM unnest(p.proacl) AS a(acl)), '') "
                       "FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'emr_access' UNION ALL "
                       "SELECT c.relname::text || ':' || g.tgname::text || ':' || g.tgenabled::text FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid "
                       "JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'emr_access' AND NOT g.tgisinternal UNION ALL "
                       "SELECT 'grant:' || table_schema::text || '.' || table_name::text || ':' || privilege_type::text "
                       "FROM information_schema.role_table_grants WHERE grantee = 'kin_runtime') q")
        source_catalog = self.ok(catalog_sql)
        before = (self.ok("SELECT count(*) || ':' || max(sequence) || ':' || (SELECT hash FROM emr_access.chain_head WHERE stream = 'viewing') FROM emr_access.access_entry WHERE stream = 'viewing'"),
                  self.ok("SELECT count(*) FROM \"AuditLog\""))
        with tempfile.TemporaryDirectory(prefix="kin-emrb-dump-") as folder:
            dump = Path(folder) / "kin.dump"
            with dump.open("wb") as handle:
                result = subprocess.run(["docker", "exec", self.db, "pg_dump", "-U", "kin", "-Fc", "kin"], stdout=handle, stderr=subprocess.PIPE, timeout=300)
            self.assertEqual(result.returncode, 0, result.stderr)
            backup_state = self.copy_volume(self.state, "l07-backup")
            def restore(db, *options):
                with dump.open("rb") as handle:
                    return subprocess.run(["docker", "exec", "-i", db, "pg_restore", "-U", "kin", "-d", "kin", "--exit-on-error", *options],
                                          stdin=handle, capture_output=True, timeout=300)
            # The documented restore: provision, restore with owners and privileges, restore the state from the same point.
            target = self.start_db("l07-target")
            self.provision(target)
            self.assertEqual(restore(target).returncode, 0)
            self.assertEqual(self.ok(catalog_sql, db=target), source_catalog)
            restored_state = self.copy_volume(backup_state, "l07-restored")
            self.assertEqual(self.driver("entries", db=target, volume=restored_state), source_entries)
            recovered = self.driver("recover", db=target, volume=restored_state)
            self.assertEqual((recovered["recovered"], recovered["notCommitted"]), (0, 0), recovered)
            self.assertEqual(self.driver("verify-runtime", db=target, volume=restored_state)["role"], "kin_runtime")
            self.assertIn("receipt", self.driver("append", {"count": 1}, db=target, volume=restored_state)["results"][0])
            self.assertEqual(self.refused("SELECT emr_access.expire_prefix(1)", user="kin_emr_retention", db=target), "EB004")
            self.assertEqual(self.refused("DELETE FROM emr_access.access_entry", user="kin_runtime", db=target), REFUSED)
            # Refused: no roles in the target cluster; the ledger off its tablespace; a state ahead of the restored data;
            # no state at all; and a database without the EMR migration.
            bare = self.start_db("l07-bare")
            self.assertNotEqual(restore(bare).returncode, 0)
            loose = self.start_db("l07-loose")
            self.provision(loose)
            self.assertEqual(restore(loose, "--no-tablespaces").returncode, 0)
            self.assertIn("ledger-placement", self.driver("verify-runtime", db=loose, volume=self.volume("l07-loose")).get("problems") or [])
            self.assertEqual(self.driver("append", {"count": 1}, db=loose, volume=self.copy_volume(backup_state, "l07-loose2"))["results"][0]["error"], "EB001")
            self.driver("append", {"count": 1})  # the source moves on after its backup
            ahead = self.copy_volume(self.state, "l07-ahead")
            stale = self.start_db("l07-stale")
            self.provision(stale)
            self.assertEqual(restore(stale).returncode, 0)
            self.assertEqual(self.driver("recover", db=stale, volume=ahead).get("error"), "LedgerBehindSeal")
            self.assertEqual(self.driver("recover", db=stale, volume=self.volume("l07-empty")).get("error"), "SealMissing")
        partial = self.start_db("l07-partial")
        self.provision(partial)
        for path in sorted((ROOT / "api/prisma/migrations").glob("*/migration.sql")):
            if path.parent.name != "20261008120000_emr_b":
                self.ok(path.read_text(encoding="utf-8"), db=partial)
        self.assertIn("ledger-missing", self.driver("verify-runtime", db=partial, volume=self.volume("l07-partial")).get("problems") or [])
        # The source's data is unchanged by its backup (only the deliberate later append moved it on, by exactly one).
        count, last, _ = before[0][0].split(":")
        self.assertEqual(self.ok("SELECT count(*) || ':' || max(sequence) FROM emr_access.access_entry WHERE stream = 'viewing'"), ["%d:%d" % (int(count) + 1, int(last) + 1)])
        self.assertEqual(self.ok("SELECT count(*) FROM \"AuditLog\""), before[1])

    # ── L08 ──
    def test_b08_receipt_before_body(self):
        """The first body byte comes after the committed, sealed receipt; with the database, the seal or the journal in
        doubt there is no body; the resend after a lost response is the same fact, never a second one."""
        done = self.driver("provide")
        self.assertEqual(done.get("body"), "SYNTHETIC body", done)
        [seen] = done["order"]
        self.assertTrue(seen["stored"] and seen["sealedThrough"] >= seen["entry"], seen)
        unreachable = self.driver("provide", url="postgresql://kin_runtime:wrong@127.0.0.1:1/kin?connect_timeout=2")
        self.assertIn("error", unreachable)
        self.assertEqual(unreachable.get("order", []), [])
        # The seal cannot be written: the provision is committed, no body leaves; the resend seals it and sends once.
        self.as_root(self.state, "chmod 500 %s/seal" % STATE)
        try:
            stuck = self.driver("provide")
        finally:
            self.as_root(self.state, "chmod 700 %s/seal" % STATE)
        self.assertEqual((stuck.get("error"), stuck.get("order")), ("SealUnavailable", []), stuck)
        self.assertEqual(self.ok("SELECT count(*) FROM emr_access.access_entry WHERE event_id = '%s'" % stuck["eventId"]), ["1"])
        stuck_event = json.loads(self.ok("SELECT payload FROM emr_access.access_entry WHERE event_id = '%s'" % stuck["eventId"])[0])["event"]
        resent = self.driver("provide", {"event": stuck_event})
        self.assertEqual(resent.get("body"), "SYNTHETIC body", resent)
        self.assertEqual(len(resent["order"]), 1)
        self.assertEqual(self.ok("SELECT count(*) FROM emr_access.access_entry WHERE event_id = '%s'" % stuck["eventId"]), ["1"])
        # The ledger refuses and the journal is unwritable: an explicit failure, no body.
        self.ok("ALTER TABLE emr_access.member_identity SET TABLESPACE pg_default")
        self.as_root(self.state, "chmod 400 %s/journal/failure-journal.jsonl" % STATE)
        try:
            dark = self.driver("provide")
        finally:
            self.as_root(self.state, "chmod 600 %s/journal/failure-journal.jsonl" % STATE)
            self.ok("ALTER TABLE emr_access.member_identity SET TABLESPACE kin_emr_access")
        self.assertEqual((dark.get("error"), dark.get("order")), ("LedgerUnreachable", []), dark)
        self.assertEqual(self.driver("recover")["recovered"], 0)


    def test_b17_order_fact_history_and_classification(self):
        """D24: order facts survive restart, replay is exact, lifecycle facts preserve the original clinical clock."""
        record_id = "SYNTHETIC-order-" + self.token
        at = "2026-01-02T00:00:00.000Z"
        facts = dict(objectKind="order-indication", origin="product-authored", authorId="physician", authorRole="physician",
            requestingClinicianId="physician", directionSourceRef=None, examCodes=["CT-CHEST"], source=None, feed=None,
            inherited=[], firstReceivedAt=None, firstReceiptEventId=None, duplicateOf=None, scheduledAt=None,
            scheduleChangeEvidenceId=None, status="closed", statusEvent=dict(eventId="original", actorId="physician", at=at, reason="synthetic"),
            fulfilment=None, chartIncorporation=None, procedure=None, synthetic=None)
        event = dict(eventId="original", recordId=record_id, versionId="v1", sha256="ab"*32, contentSha256="ab"*32, at=at,
            act="entry", signature=dict(versionId="v1", sha256="ab"*32, signedAt=at, verified=True), predecessor=None, components=[], processing=None)
        first = dict(recordId=record_id, eventId="original", previousEventId=None, facts=facts, event=event)
        one = self.driver("order-facts", dict(recordId=record_id, facts=[first]))
        self.assertNotIn("error", one, one)
        self.assertEqual(one["kinds"], ["order-indication"])
        self.assertEqual(one["duties"], [dict(kind="order-indication", startedAt=at, years=10)])
        self.assertEqual(self.driver("order-facts", dict(recordId=record_id, facts=[first])), one)
        second = json.loads(json.dumps(first))
        second.update(eventId="cancelled", previousEventId="original")
        second["facts"].update(status="cancelled", statusEvent=dict(eventId="cancelled", actorId="physician", at="2027-01-01T00:00:00.000Z", reason="no longer required"))
        two = self.driver("order-facts", dict(recordId=record_id, facts=[second]))
        self.assertNotIn("error", two, two)
        self.assertEqual(len(two["history"]), 2); self.assertEqual(two["duties"], one["duties"])
        changed = json.loads(json.dumps(second)); changed["facts"]["examCodes"] = ["DIFFERENT"]
        self.assertEqual(self.driver("order-facts", dict(recordId=record_id, facts=[changed])).get("error"), "OrderEventIdConflict")
        shorter = json.loads(json.dumps(second)); shorter.update(eventId="downgrade", previousEventId="cancelled")
        shorter["facts"]["statusEvent"]["eventId"] = "downgrade"; shorter["facts"]["objectKind"] = "exam-clinical-info"
        self.assertEqual(self.driver("order-facts", dict(recordId=record_id, facts=[shorter])).get("error"), "NoShorteningOfEstablishedDuty")
        for verb in ["UPDATE emr_access.order_fact SET body='{}'", "DELETE FROM emr_access.order_fact", "TRUNCATE emr_access.order_fact"]:
            self.assertEqual(self.refused(verb, user="kin_runtime"), REFUSED)
        self.assertEqual(self.driver("order-facts", dict(recordId=record_id)), two)

    def test_b18_external_expiry_proof_and_torn_journal_restarts(self):
        """The two review counterexamples on real persisted storage, independent of the in-memory contract model."""
        db = self.start_db("l18"); self.provision(db); self.migrate(db); state = self.volume("l18")
        first = self.driver("append", {"events": [self.auth_event(OLD[0])]}, db=db, volume=state)
        self.assertIn("receipt", first["results"][0], first)
        # Record 2 commits with an external append intent, but the last trusted seal is still 1.
        self.assertEqual(self.driver("business", {"event": self.auth_event(OLD[1]), "exit": "after-commit"}, db=db, volume=state), {"exited": True})
        self.ok("SELECT * FROM emr_access.expire_prefix(2)", user="kin_emr_retention", db=db)
        rejected = self.driver("recover", db=db, volume=state)
        self.assertEqual(rejected.get("error"), "SealTailMismatch", rejected)
        self.assertEqual(self.driver("seal", db=db, volume=state)["sequence"], 1)
        # A separate clean state exercises the journal; the damaged raw bytes survive all later appends.
        state2 = self.volume("l18-journal")
        self.as_root(state2, "mkdir -p /var/lib/kin-emr/journal; chmod 700 /var/lib/kin-emr; chown -R 1000:1000 /var/lib/kin-emr")
        # The driver's failure journal can be read without sealing this independent state over a populated DB.
        self.assertEqual(self.driver("journal", volume=state2), [])
        self.as_root(state2, "printf '%s' '{\"id\":\"incomplete\"' > /var/lib/kin-emr/journal/failure-journal.jsonl; chown 1000:1000 /var/lib/kin-emr/journal/failure-journal.jsonl")
        self.assertEqual(self.driver("journal", volume=state2), [])
        self.assertEqual(self.driver("journal", volume=state2), [])
        archive = run(["docker", "run", "--rm", "--label", self.label, "--network", "none", "-v", state2+":/s:ro", "--entrypoint", "sh", self.image,
            "-c", "cat /s/journal/torn-*.bin; wc -c < /s/journal/failure-journal.jsonl"]).stdout
        self.assertEqual(archive, b'{"id":"incomplete"0\n')
        for index in (1, 2):
            self.assertEqual(self.driver("journal-add", {"id": "after-torn-"+str(index)}, volume=state2)["id"], "after-torn-"+str(index))
            self.assertEqual(len(self.driver("journal", volume=state2)), index)

    def test_b19_backup_rehearsal_preserves_database_and_external_state(self):
        """The real backup/rehearse functions over owned disposable resources; only source names and HTTP probes are adapted.

        There is no shared stack: Docker argv target names map exclusively to this run. The clinical source is an empty
        synthetic SQLite index; all PostgreSQL dumps, role/catalog checks, state archives and seal recovery are real.
        """
        import contextlib
        import sqlite3
        from unittest.mock import patch
        sys.path.insert(0, str(ROOT / "scripts"))
        import ops_backup as backup
        import ops_audit_integrity as audit
        self.assertNotIn("error", self.driver("recover"))
        seeded = self.driver("append", {"count": 2})
        self.assertNotIn("error", seeded, seeded)
        self.assertEqual(len(seeded["results"]), 2)
        self.assertTrue(all("receipt" in row for row in seeded["results"]), seeded)
        self.ok("CREATE DATABASE keycloak OWNER kin")
        self.ok("CREATE TABLE synthetic_realm(id text PRIMARY KEY); INSERT INTO synthetic_realm VALUES ('EMR-B-L19')", database="keycloak")
        orthanc_image = json.loads(run(["docker", "image", "inspect", "orthancteam/orthanc:24.12.0"]).stdout)[0]["Id"]
        with tempfile.TemporaryDirectory(prefix="kin-emrb-backup-") as temporary:
            root = Path(temporary); repo = root / "repo"; repo.mkdir(); output = root / "backups"; output.mkdir()
            for filename in backup.FILES[3:]:
                (repo / filename).write_text("SYNTHETIC_ONLY=no_production_secret\n", encoding="utf-8")
            sqlite = root / "index"
            with contextlib.closing(sqlite3.connect(sqlite)) as connection:
                connection.execute("CREATE TABLE AttachedFiles(uuid TEXT, compressedSize INTEGER)")
            orthanc_volume = self.volume("l19-orthanc")
            aliases = {"kin-db": self.db}
            for role, image, mount in [("api", self.image, self.state+":"+STATE),
                    ("keycloak", self.image, None), ("orthanc", orthanc_image, orthanc_volume+":/var/lib/orthanc/db"),
                    ("proxy", self.image, None)]:
                name = "kin-emrb-"+self.token+"-l19-"+role
                self.created["container"].append(name); aliases["kin-"+role] = name
                run(["docker", "run", "-d", "--name", name, "--label", self.label, "--network", "none",
                    *(["-v", mount] if mount else []), "--entrypoint", "sleep", image, "infinity"])
            run(["docker", "cp", str(sqlite), aliases["kin-orthanc"]+":/var/lib/orthanc/db/index"])
            actual_run = backup.run
            def isolated_run(argv, **kwargs):
                if argv[0] == "git":
                    return subprocess.run(argv, cwd=ROOT, capture_output=True, check=True)
                mapped = [aliases.get(value, value) for value in argv]
                result = actual_run(mapped, **kwargs)
                if argv[:2] == ["docker", "inspect"] and "--format" not in argv:
                    facts = json.loads(result.stdout)
                    reverse = {value: key for key, value in aliases.items()}
                    for item in facts:
                        actual_name = item["Name"].lstrip("/")
                        self.assertIn(actual_name, reverse)
                        self.assertEqual(item["Config"]["Labels"]["kin.emrb.live"], self.token)
                        item["Name"] = "/"+reverse[actual_name]
                        item["Config"]["Labels"].update({"com.docker.compose.project": "synthetic-emr-b",
                            "com.docker.compose.project.working_dir": str(repo)})
                    result.stdout = json.dumps(facts).encode()
                return result
            with patch.object(backup, "ROOT", repo), patch.object(backup, "run", side_effect=isolated_run), \
                    patch.object(backup, "reload_proxy"), patch.object(backup, "wait_ready"):
                self.assertEqual(audit.main(["init", str(output)]), 0)
                backup.backup(output)
                folder, = [p for p in output.iterdir() if p.is_dir()]
                manifest = json.loads((folder / "manifest.json").read_text())
                self.assertTrue(manifest["complete"]); self.assertTrue(manifest["emr"]["same_pause"])
                self.assertTrue(set(backup.EMR_FILES).issubset(manifest["sha256"]))
                backup.rehearse(folder)
                result_file, = folder.glob("rehearsal-*.json")
                result = json.loads(result_file.read_text())
                self.assertTrue(result["success"], result)
                self.assertEqual(result["emr"], {"owner_acl_preserved": True, "database_state_verified": True})
                self.assertTrue(result["audit"]["verified"], result)
                self.assertEqual(result["cleanup_failures"], [])
        self.assertNotIn("error", self.driver("recover"), "backup did not alter the source ledger or seal")


if __name__ == "__main__":
    raise SystemExit("Run through scripts/run-tests.py --module tests/emr/b/live.py --class EmrBLedgerLive --mode live")
