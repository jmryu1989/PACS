"""TEST-S7-AUDIT-STORE-DB (REQ-S7-AUDIT-STORE -> RISK-S7-AUDIT-TAMPER, RISK-S7-AUDIT-LOSS; RA-1, RA-2, RA-4).

On a disposable networkless postgres:16-alpine holding the API image's own migrations (KIN_TEST_API_IMAGE, prisma migrate
deploy), the runtime role kin (owner and superuser, as in docker-compose.yml) keeps INSERT and SELECT on AuditLog while
UPDATE, DELETE and TRUNCATE are refused with SQLSTATE 42501; seals are made by the public seal function over pg_dump
snapshots and judged by the public `ops_audit_integrity.py verify` on copies a superuser tampered with: rows, the guard,
the digest computation itself (pg_catalog.sha256 replaced, or a public.sha256 on the search path), and the relation. A
rehearse restore is reproduced by the harness (same image, --network none, createdb, pg_restore --no-owner
--no-privileges --exit-on-error) and the restored copy alone is changed afterwards.

Negative controls are database and file states (a database built from every migration but the guard's, superuser
copies, a restored copy changed after the restore) - no product source is substituted. Assertions are the SQLSTATE of a
refused statement, the tool's exit code and report kinds/ids; no trigger, function or SQL text of the product is
asserted (the harness discovers the guard's triggers from the catalog when a case has to disable or drop them).
Every container is created here with this run's label and removed at the end; the verifier's own containers must be
gone after each call.

IV-DB-13..18 (S7-AUDIT-STORE-F02/F03, SPEC-F01..F03) judge a named database's export as the remote job it is in the
target container, on this host's real docker client (the Windows client boundary here, Linux in CI): its sessions are
read from pg_stat_activity (every client session in the case's database other than the test's own), its processes are
the ones `docker exec` started in the container (their parent is outside it) other than the test's psql sessions.
Failures are injected at those boundaries only after the intended state was observed: the verifier container killed,
the local docker client killed, the remote pg_dump stopped (SIGSTOP) once its lock wait is over, the caller's process
killed, the target paused. Another run of the tool and a session whose name differs from the run's only in the run's
own characters must come through untouched.
"""
from __future__ import annotations

import contextlib
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import ops_audit_integrity as audit  # noqa: E402

POSTGRES = "postgres:16-alpine"
TOOL = ROOT / "scripts" / "ops_audit_integrity.py"
MIGRATIONS = ROOT / "api" / "prisma" / "migrations"
# This unit's migration, found by its directory name like other migration tests find theirs.
GUARD_MIGRATION = next(MIGRATIONS.glob("*_audit_log_append_only"))
SENTINEL = "syn-private-sentinel"


def docker(*args, input=None, check=True, timeout=600):
    result = subprocess.run(["docker", *args], input=input, capture_output=True, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError("docker %s failed: %s" % (args[0], result.stderr.decode("utf-8", "replace")[-800:]))
    return result


def wait_ready(name, user):
    for _ in range(240):
        if docker("exec", name, "pg_isready", "-h", "127.0.0.1", "-U", user, check=False).returncode == 0:
            return
        time.sleep(0.25)
    raise RuntimeError("database container did not become ready")


def verifier_containers():
    return docker("ps", "-aq", "--filter", "label=kin.ops.run", "--filter", "name=-audit").stdout.decode().split()


GRACE = 15        # the cleanup budget after a failure, as the product documents it


def remote_step(proof):
    return (proof or {}).get("steps", {}).get("remote", {})


class Session:
    """A psql session the test keeps open through `docker exec -i`: send() a statement without output, ask() one with a
    one-line answer (None once the session is gone)."""

    def __init__(self, container, database, user="kin", application_name=None):
        env = ["-e", "PGAPPNAME=" + application_name] if application_name else []
        self.process = subprocess.Popen(["docker", "exec", "-i", *env, container, "psql", "-X", "-q", "-A", "-t", "-U",
                                         user, "-d", database], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL)
        self.lines = queue.Queue()
        threading.Thread(target=self._read, daemon=True).start()
        self.pid = int(self.ask("SELECT pg_catalog.pg_backend_pid()"))

    def _read(self):
        for line in self.process.stdout:
            self.lines.put(line.decode("utf-8", "replace").strip())
        self.lines.put(None)

    def send(self, statement):
        try:
            self.process.stdin.write((statement + ";\n").encode())
            self.process.stdin.flush()
            return True
        except OSError:
            return False

    def ask(self, statement, timeout=30):
        if not self.send(statement):
            return None
        try:
            return self.lines.get(timeout=timeout)
        except queue.Empty:
            return None

    def close(self):
        try:
            self.process.communicate(b"ROLLBACK;\n\\q\n", timeout=30)
        except (OSError, ValueError, subprocess.TimeoutExpired):
            self.process.kill()


class Recorder:
    """Every docker process the product starts while active, through the real docker client (nothing is changed)."""

    def __init__(self):
        self.launched = []

    @contextlib.contextmanager
    def active(self):
        real = subprocess.Popen

        def popen(args, *rest, **kwargs):
            process = real(args, *rest, **kwargs)
            if isinstance(args, (list, tuple)) and args and args[0] == "docker":
                self.launched.append((list(args), process))
            return process
        with patch.object(subprocess, "Popen", popen):
            yield self

    def running_against(self, container_id):
        """The product's docker clients still running against the container (by its ID)."""
        return [(args, process) for args, process in self.launched if container_id in args and process.poll() is None]


class Background:
    """A call in a thread: result() is (outcome, seconds from start); outcome holds 'value' or 'error'."""

    def __init__(self, call):
        self.outcome, self.started = {}, time.monotonic()
        self.thread = threading.Thread(target=self._run, args=(call,), daemon=True)
        self.thread.start()

    def _run(self, call):
        try:
            self.outcome["value"] = call()
        except BaseException as error:   # judged by the case
            self.outcome["error"] = error
        self.finished = time.monotonic()

    def result(self, timeout):
        self.thread.join(timeout)
        if self.thread.is_alive():
            raise AssertionError("the call was still running after %s s" % timeout)
        return self.outcome, self.finished


class AuditStoreDB(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.api_image = os.environ.get("KIN_TEST_API_IMAGE")
        if not cls.api_image:
            raise RuntimeError("set KIN_TEST_API_IMAGE to the API image built from this checkout (CI: kin-api:ci)")
        cls.token = uuid.uuid4().hex
        cls.label = "s7.audit.store.test=" + cls.token
        cls.work = Path(tempfile.mkdtemp(prefix="kin-audit-db-"))
        cls.db = "kin-audit-db-" + cls.token[:12]
        docker("run", "-d", "--name", cls.db, "--label", cls.label, "--network", "none",
               "--tmpfs", "/var/lib/postgresql/data", "-e", "POSTGRES_USER=kin", "-e", "POSTGRES_DB=kin",
               "-e", "POSTGRES_HOST_AUTH_METHOD=trust", POSTGRES)
        wait_ready(cls.db, "kin")
        cls.db_image = docker("inspect", "--format", "{{.Image}}", cls.db).stdout.decode().strip()
        cls.deploy("kin")
        # every later database is a copy of this migrated, empty one (CREATE DATABASE ... TEMPLATE)
        cls.sql("CREATE DATABASE audit_template TEMPLATE kin")

    @classmethod
    def tearDownClass(cls):
        for identity in docker("ps", "-aq", "--filter", "label=" + cls.label).stdout.decode().split():
            docker("rm", "-f", "-v", identity, check=False)
        shutil.rmtree(cls.work, ignore_errors=True)

    def tearDown(self):
        self.assertEqual(verifier_containers(), [], "the isolated verifier's containers are removed after each call")

    # ── harness ──

    @classmethod
    def deploy(cls, database, schema="/app/prisma/schema.prisma", mount=None):
        args = ["run", "--rm", "--network", "container:" + cls.db, "--label", cls.label, "--tmpfs", "/tmp",
                "-e", "DATABASE_URL=postgresql://kin@127.0.0.1:5432/" + database, "-e", "HOME=/tmp",
                "-e", "CHECKPOINT_DISABLE=1"]
        if mount:
            args += ["-v", "%s:/base:ro" % mount]
        result = docker(*args, "--entrypoint", "/app/node_modules/.bin/prisma", cls.api_image,
                        "migrate", "deploy", "--schema", schema, check=False)
        if result.returncode:
            raise RuntimeError("migrate deploy failed: " + (result.stdout + result.stderr).decode("utf-8", "replace")[-1500:])
        return result.stdout.decode("utf-8", "replace")

    @classmethod
    def sql(cls, text, database="kin", user="kin", container=None):
        """Run SQL through psql as the given role; returns (exit, stdout lines, SQLSTATE of the first error)."""
        result = docker("exec", "-i", container or cls.db, "psql", "-X", "-q", "-A", "-t", "-U", user, "-d", database,
                        "-v", "ON_ERROR_STOP=1", input=("\\set VERBOSITY sqlstate\n" + text).encode(), check=False)
        state = re.search(r"ERROR:\s+([0-9A-Z]{5})", result.stderr.decode("utf-8", "replace"))
        return result.returncode, result.stdout.decode("utf-8").splitlines(), state.group(1) if state else None

    def ok(self, text, database="kin", user="kin", container=None):
        code, lines, state = self.sql(text, database, user, container)
        self.assertEqual((code, state), (0, None), text[:200])
        return lines

    def refused(self, text, database="kin"):
        code, _, state = self.sql(text, database)
        return code != 0 and state

    def rows(self, database, container=None, user="kin"):
        return self.ok('SELECT to_jsonb(t)::text FROM "AuditLog" t ORDER BY id', database, user, container)

    def new_database(self, name, rows=0, source="audit_template"):
        self.ok('CREATE DATABASE "%s" TEMPLATE "%s"' % (name, source))
        if rows:
            self.write_rows(name, rows)
        return name

    def write_rows(self, database, count, start=None):
        self.ok("INSERT INTO \"AuditLog\" (actor, action, target, detail) SELECT 'syn-actor-' || g, 'syn.action', "
                "'syn-target-' || g, CASE WHEN g %% 3 = 0 THEN NULL ELSE '{\"n\":' || g || ',\"s\":\"%s\"}' END "
                "FROM generate_series(1, %d) g" % (SENTINEL, count), database)

    def gap(self, database):
        """A rolled-back insert: the id it took is left unused (AO-07). Returns that id."""
        (taken,) = self.ok("BEGIN; INSERT INTO \"AuditLog\" (actor, action, target) VALUES ('syn-rollback', 'syn.gap', 'syn') "
                           "RETURNING id; ROLLBACK;", database)
        return int(taken)

    def as_superuser(self, statement, database, container=None, user="kin"):
        """A superuser change past the guard: replica mode for this statement only, reset at once."""
        self.ok("BEGIN; SET LOCAL session_replication_role = replica; %s; SET LOCAL session_replication_role = origin; "
                "COMMIT;" % statement, database, user, container)

    def guard_triggers(self, database, container=None, user="kin"):
        (raw,) = self.ok("SELECT coalesce(json_agg(json_build_object('name', t.tgname, 'def', pg_get_triggerdef(t.oid), "
                         "'function', t.tgfoid::regproc::text)), '[]') FROM pg_trigger t "
                         "WHERE t.tgrelid = 'public.\"AuditLog\"'::regclass AND NOT t.tgisinternal",
                         database, user, container)
        return json.loads(raw)

    def new_root(self):
        root = Path(tempfile.mkdtemp(prefix="root-", dir=self.work))
        os.chmod(root, 0o700)
        result = subprocess.run([sys.executable, str(TOOL), "init", str(root)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return root

    def snapshot(self, database, root, container=None, user="kin"):
        """A backup folder as ops_backup writes it for the seal: kin.dump and a manifest with its digest and image."""
        created = datetime.now(timezone.utc)
        folder = root / (created.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8])
        folder.mkdir(mode=0o700)
        with (folder / "kin.dump").open("wb") as handle:
            result = subprocess.run(["docker", "exec", container or self.db, "pg_dump", "-U", user, "-d", database, "-Fc"],
                                    stdout=handle, stderr=subprocess.PIPE)
        self.assertEqual(result.returncode, 0, result.stderr)
        data = (folder / "kin.dump").read_bytes()
        manifest = {"format": 1, "complete": True, "created_utc": created.isoformat(), "postgres_image": self.db_image,
                    "sha256": {"kin.dump": hashlib.sha256(data).hexdigest()}, "bytes": {"kin.dump": len(data)}}
        (folder / "manifest.json").write_text(json.dumps(manifest))
        return folder, manifest

    def seal(self, database, root, container=None, user="kin"):
        folder, manifest = self.snapshot(database, root, container, user)
        alarm = audit.seal(folder, root, manifest)
        return folder, json.loads((folder / audit.CHECKPOINT).read_text()), alarm

    def verify(self, *args):
        result = subprocess.run([sys.executable, str(TOOL), "verify", *map(str, args)], capture_output=True, text=True,
                                encoding="utf-8")
        self.assertIn(result.returncode, (0, 1, 2), result.stderr)
        self.assertNotIn(SENTINEL, result.stdout + result.stderr, "row content never leaves the verifier")
        return result.returncode, json.loads(result.stdout)

    def verify_db(self, database, folder, container=None, user="kin"):
        return self.verify("--container", container or self.db, "--database", database, "--user", user,
                           "--checkpoint", folder / audit.CHECKPOINT)

    def restore(self, folder):
        """The rehearse restore, reproduced: the recorded image, no network, the whole dump as the superuser."""
        name = "kin-audit-restore-" + uuid.uuid4().hex[:12]
        docker("run", "-d", "--name", name, "--label", self.label, "--network", "none", "--tmpfs", "/var/lib/postgresql/data",
               "-e", "POSTGRES_HOST_AUTH_METHOD=trust", self.db_image)
        wait_ready(name, "postgres")
        docker("exec", name, "createdb", "-U", "postgres", "kin")
        docker("exec", "-i", name, "pg_restore", "-U", "postgres", "-d", "kin", "--no-owner", "--no-privileges",
               "--exit-on-error", input=(folder / "kin.dump").read_bytes())
        return name

    def hashes(self, folder, root):
        return {name: audit.sha256_file(folder / name) for name in ("kin.dump", "manifest.json", audit.CHECKPOINT)} | \
            {"ledger": audit.sha256_file(root / audit.LEDGER)}

    def replace_sha256(self, database, marker, sealed_hex, variant, container=None, user="kin"):
        """The F01 counterexample's computation tamper: row k's digest comes back as the sealed value. Returns False when
        this PostgreSQL refuses the variant (recorded as not constructible)."""
        original = "CREATE FUNCTION public.syn_real_sha256(bytea) RETURNS bytea LANGUAGE internal IMMUTABLE STRICT AS 'sha256_bytea'; "
        body = ("SELECT CASE WHEN position(convert_to('%s', 'UTF8') in $1) > 0 THEN decode('%s', 'hex') "
                "ELSE public.syn_real_sha256($1) END" % (marker, sealed_hex))
        if variant == "pg_catalog":
            text = original + ("SET allow_system_table_mods = on; CREATE OR REPLACE FUNCTION pg_catalog.sha256(bytea) "
                               "RETURNS bytea LANGUAGE sql AS $f$ %s $f$;" % body)
        else:
            text = original + ("CREATE FUNCTION public.sha256(bytea) RETURNS bytea LANGUAGE sql AS $f$ %s $f$; "
                               "ALTER DATABASE \"%s\" SET search_path = public, pg_catalog;" % (body, database))
        code, _, state = self.sql(text, database, user, container)
        if code:
            print(json.dumps({"variant": variant, "constructible": False, "sqlstate": state}), flush=True)
        return code == 0

    # ── the remote export's boundary (IV-DB-13..18) ──

    @classmethod
    def container_id(cls):
        return docker("inspect", "--format", "{{.Id}}", cls.db).stdout.decode().strip()

    def sessions(self, database, *own):
        """Client sessions in the database other than this observation and own: {pid: (name, state, wait type)}."""
        lines = self.ok("SELECT pid || '|' || application_name || '|' || coalesce(state, '') || '|' || "
                        "coalesce(wait_event_type, '') FROM pg_catalog.pg_stat_activity WHERE datname = '%s' "
                        "AND backend_type = 'client backend' AND pid <> pg_catalog.pg_backend_pid()" % database)
        found = {}
        for line in lines:
            pid, name, state, wait = line.split("|")
            if int(pid) not in own:
                found[int(pid)] = (name, state, wait)
        return found

    def processes(self):
        """Every process in the target container other than the server's and this observation: {pid: (name, parent)}."""
        script = ('for s in /proc/[0-9]*/stat; do read -r pid name state parent rest 2>/dev/null < "$s" || continue; '
                  'if [ "$pid" != 1 ] && [ "$pid" != "$$" ] && [ "$name" != "(postgres)" ]; then '
                  'echo "$pid $name $parent"; fi; done')
        found = {}
        for line in docker("exec", self.db, "sh", "-c", script).stdout.decode().splitlines():
            if line.strip():
                pid, name, parent = line.split()
                found[int(pid)] = (name, int(parent))
        return found

    def exec_processes(self):
        """Processes `docker exec` started in the target container (their parent is outside it, 0 inside) other than
        psql sessions: {pid: name}."""
        return {pid: name for pid, (name, parent) in self.processes().items() if parent == 0 and name != "(psql)"}

    def until(self, condition, seconds, step=0.25):
        end = time.monotonic() + seconds
        while True:
            value = condition()
            if value or time.monotonic() >= end:
                return value
            time.sleep(step)

    def lock(self, database):
        """A session holding ACCESS EXCLUSIVE on AuditLog: an export waits for it before it reads anything."""
        holder = Session(self.db, database)
        holder.send('BEGIN; LOCK TABLE "AuditLog" IN ACCESS EXCLUSIVE MODE')
        granted = self.until(lambda: self.ok(
            "SELECT count(*) FROM pg_catalog.pg_locks l JOIN pg_catalog.pg_class c ON c.oid = l.relation "
            "WHERE c.relname = 'AuditLog' AND l.mode = 'AccessExclusiveLock' AND l.granted AND l.pid = %d"
            % holder.pid, database) == ["1"], 30)
        self.assertTrue(granted, "the lock holder got its lock")
        return holder

    def waiting(self, database, own, count):
        """The sessions other than own once at least count of them wait on a lock (the intended state is reached)."""
        def reached():
            found = self.sessions(database, *own)
            return found if sum(wait == "Lock" for _, _, wait in found.values()) >= count else None
        found = self.until(reached, 120)
        self.assertTrue(found, "%d export(s) observed waiting on the lock" % count)
        return found

    def start_verify(self, database, folder):
        return subprocess.Popen([sys.executable, str(TOOL), "verify", "--container", self.db, "--database", database,
                                 "--user", "kin", "--checkpoint", str(folder / audit.CHECKPOINT)],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def start_caller(self, database, timeout):
        """A caller of the public evaluate in its own process, so that the case can kill it."""
        program = ("import sys; sys.path.insert(0, sys.argv[1]); import ops_audit_integrity as a; "
                   "a.evaluate(a.DatabaseExport(sys.argv[2], sys.argv[3], 'kin'), timeout=float(sys.argv[4]))")
        return subprocess.Popen([sys.executable, "-c", program, str(ROOT / "scripts"), self.db, database, str(timeout)],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def finish(self, process, seconds):
        """The output of a process that has to end within seconds (otherwise the case fails)."""
        try:
            out, _ = process.communicate(timeout=seconds)
        except subprocess.TimeoutExpired:
            self.fail("the run was still running %s s later" % seconds)
        return out

    def remove_left_verifiers(self):
        """The verifier a killed caller could not remove (its removal is the caller's own cleanup)."""
        for identity in verifier_containers():
            docker("rm", "-f", "-v", identity, check=False)

    def restarts(self):
        """How often the server has stopped every session after a child died abnormally (its crash recovery)."""
        return docker("logs", self.db).stderr.decode("utf-8", "replace").count(
            "terminating any other active server processes")

    def live_digest(self, database, identity, qualified, container=None, user="kin"):
        """The digest as the rejected in-database design computed it (scenario §1 d(r)), run on the tampered server."""
        function = "pg_catalog.sha256" if qualified else "sha256"
        (value,) = self.ok("SELECT encode(%s(convert_to(jsonb_build_array(id, at, actor, action, target, detail)::text, "
                           "'UTF8')), 'hex') FROM \"AuditLog\" WHERE id = %d" % (function, identity), database, user, container)
        return value

    # ── RA-1: the append-only guard ──

    def test_as01_insert_kept_update_delete_truncate_refused_42501(self):
        """AS-01 (AO-01..AO-04, AO-08)."""
        db = self.new_database("as01", rows=3)
        self.ok("INSERT INTO \"UserFilter\" (owner, name) VALUES ('syn-owner', 'SYNTHETIC A'), ('syn-owner', 'SYNTHETIC B')", db)
        before = self.rows(db)
        self.assertEqual(len(before), 3)
        statements = ['UPDATE "AuditLog" SET detail = \'x\' WHERE id = 2',
                      'UPDATE "AuditLog" SET detail = \'x\'',
                      'BEGIN; UPDATE "AuditLog" SET actor = \'x\' WHERE id = 1; COMMIT;',
                      'DELETE FROM "AuditLog" WHERE id = 3',
                      'DELETE FROM "AuditLog"',
                      'BEGIN; DELETE FROM "AuditLog" WHERE id IN (1, 2); COMMIT;',
                      'TRUNCATE "AuditLog"',
                      'TRUNCATE "AuditLog", "UserFilter"',
                      'TRUNCATE "AuditLog" RESTART IDENTITY CASCADE',
                      'WITH gone AS (DELETE FROM "AuditLog" WHERE id = 1 RETURNING id) SELECT count(*) FROM gone']
        for statement in statements:
            with self.subTest(statement):
                self.assertEqual(self.refused(statement, db), "42501")
        self.assertEqual(self.rows(db), before)
        self.assertEqual(self.ok('SELECT count(*) FROM "UserFilter"', db), ["2"], "the other table named with it is kept")
        # the guard is on AuditLog only
        self.ok("UPDATE \"UserFilter\" SET name = 'SYNTHETIC A2' WHERE name = 'SYNTHETIC A'", db)
        self.ok("DELETE FROM \"UserFilter\" WHERE name = 'SYNTHETIC B'", db)
        self.ok("INSERT INTO \"AuditLog\" (actor, action, target) VALUES ('syn', 'syn.more', 'syn')", db)
        self.assertEqual(len(self.rows(db)), 4)

        # negative control (H-2): every migration but the guard's, applied in order -> the same UPDATE is accepted
        control = "as01_unguarded"
        self.ok('CREATE DATABASE "%s"' % control)
        for folder in sorted(p for p in MIGRATIONS.iterdir() if p.is_dir() and p != GUARD_MIGRATION):
            self.ok((folder / "migration.sql").read_text(encoding="utf-8"), control)
        self.write_rows(control, 3)
        self.assertEqual(self.sql('UPDATE "AuditLog" SET detail = \'x\' WHERE id = 2', control)[:1], (0,))
        self.assertEqual(self.sql('TRUNCATE "AuditLog"', control)[:1], (0,))

    def test_as02_connect_shaped_cte_insert_and_concurrent_writers(self):
        """AS-02 (AO-05, AO-07, WR-02)."""
        db = self.new_database("as02")
        self.ok("""INSERT INTO "Institution" (id, name) VALUES ('syn-from', 'SYNTHETIC FROM'), ('syn-to', 'SYNTHETIC TO');
            INSERT INTO "StudyState" (uid, "institutionId", "updatedAt") VALUES ('1.2.999.1', 'syn-from', now()), ('1.2.999.2', 'syn-from', now());
            INSERT INTO "TransferBasis" (id, "studyUid", "institutionId", kind, reference, "obtainedAt", "recordedBy")
              VALUES ('00000000-0000-4000-8000-000000000001', '1.2.999.1', 'syn-from', 'LEGAL_BASIS', 'SYNTHETIC', now(), 'syn');
            INSERT INTO "ProcessingAgreement" (id, "fromInstitutionId", "toInstitutionId", kind, reference, "validFrom", "recordedBy")
              VALUES ('00000000-0000-4000-8000-000000000002', 'syn-from', 'syn-to', 'CONTRACT', 'SYNTHETIC', now(), 'syn');
            INSERT INTO "Transfer" (id, "studyUid", "fromInstitutionId", "toInstitutionId", "basisId", "agreementId", status,
              "sourcePatientKey", "requestedBy", "expiresAt")
            SELECT gen_random_uuid(), s, 'syn-from', 'syn-to', '00000000-0000-4000-8000-000000000001',
              '00000000-0000-4000-8000-000000000002', 'OPEN', 'SYN-KEY', 'syn', now() + interval '1 day'
            FROM unnest(ARRAY['1.2.999.1', '1.2.999.2']) s;""", db)
        revoke = """WITH prior AS (SELECT t.id, t.status FROM "Transfer" t WHERE t."fromInstitutionId" = 'syn-from'
              AND t.status IN ('OPEN','ACCEPTED') FOR UPDATE),
            changed AS (UPDATE "Transfer" t SET status = 'REVOKED', "decidedBy" = 'syn', "decidedAt" = now(),
              "decisionReason" = 'SYNTHETIC' FROM prior p WHERE t.id = p.id RETURNING t.id, t."studyUid", p.status AS before)
            INSERT INTO "AuditLog" (actor, action, target, detail, at)
              SELECT 'syn', 'transfer.revoke', "studyUid", json_build_object('transferId', id, 'before', before)::text, now()
              FROM changed"""
        self.ok(revoke, db)
        self.assertEqual(self.ok("SELECT count(*) FROM \"Transfer\" WHERE status = 'REVOKED'", db), ["2"])
        self.assertEqual(self.ok("SELECT count(*) FROM \"AuditLog\" WHERE action = 'transfer.revoke'", db), ["2"])
        self.ok(revoke, db)   # nothing left to revoke: no audit row, no error
        self.assertEqual(self.ok('SELECT count(*) FROM "AuditLog"', db), ["2"])
        # the same CTE shape aimed at AuditLog is refused as a whole: neither table changes
        before = (self.rows(db), self.ok('SELECT status FROM "Transfer" ORDER BY id', db))
        self.assertEqual(self.refused("""WITH changed AS (UPDATE "AuditLog" SET detail = 'x' RETURNING target)
            INSERT INTO "AuditLog" (actor, action, target) SELECT 'syn', 'syn.cte', target FROM changed""", db), "42501")
        self.assertEqual((self.rows(db), self.ok('SELECT status FROM "Transfer" ORDER BY id', db)), before)

        # two writers at once, one rolls back: only committed rows, the rolled-back id is a gap
        holder = subprocess.Popen(["docker", "exec", "-i", self.db, "psql", "-X", "-q", "-U", "kin", "-d", db],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        holder.stdin.write(b"BEGIN; INSERT INTO \"AuditLog\" (actor, action, target) VALUES ('syn-a', 'syn.concurrent', 'a');\n")
        holder.stdin.flush()
        time.sleep(1)
        self.ok("INSERT INTO \"AuditLog\" (actor, action, target) VALUES ('syn-b', 'syn.concurrent', 'b')", db)
        holder.communicate(b"ROLLBACK;\n", timeout=60)
        self.assertEqual(self.ok("SELECT count(*) FROM \"AuditLog\" WHERE action = 'syn.concurrent'", db), ["1"])
        self.assertEqual(self.ok('SELECT id FROM "AuditLog" ORDER BY id', db), ["1", "2", "4"],
                         "only the committed writer's row; the rolled-back writer's id is a gap")

    def test_as03_compiled_client_delegates_refused_with_42501(self):
        """AS-03 (AO-06): the runtime role through the compiled PrismaService of the image."""
        db = self.new_database("as03")
        self.ok("INSERT INTO \"Institution\" (id, name) VALUES ('syn-inst-a', 'SYNTHETIC A')", db)
        script = r"""
const { PrismaService } = require('/app/dist/prisma.service');
(async () => {
  const p = new PrismaService(); await p.$connect(); const out = {};
  const attempt = async (name, fn) => { try { await fn(); out[name] = { ok: true }; }
    catch (e) { out[name] = { ok: false, text: [e.code, JSON.stringify(e.meta ?? null), String(e.message)].join(' ') }; } };
  const made = await p.auditLog.create({ data: { actor: 'syn-prisma', action: 'syn.prisma', target: 'syn-as03' } });
  out.create = { ok: true };
  await attempt('update', () => p.auditLog.update({ where: { id: made.id }, data: { detail: 'x' } }));
  await attempt('delete', () => p.auditLog.delete({ where: { id: made.id } }));
  await attempt('updateMany', () => p.auditLog.updateMany({ where: { target: 'syn-as03' }, data: { detail: 'x' } }));
  await attempt('deleteMany', () => p.auditLog.deleteMany({ where: { target: 'syn-as03' } }));
  await attempt('executeRaw', () => p.$executeRaw`DELETE FROM "AuditLog" WHERE target = ${'syn-as03'}`);
  await attempt('otherTable', () => p.institution.update({ where: { id: 'syn-inst-a' }, data: { name: 'SYNTHETIC A2' } }));
  console.log(JSON.stringify(out)); await p.$disconnect();
})().catch(e => { console.error(String(e)); process.exit(1); });
"""
        result = docker("run", "--rm", "--network", "container:" + self.db, "--label", self.label, "--tmpfs", "/tmp",
                        "-e", "DATABASE_URL=postgresql://kin@127.0.0.1:5432/" + db, "-e", "HOME=/tmp", "--entrypoint", "node",
                        self.api_image, "-e", script, check=False)
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", "replace"))
        out = json.loads(result.stdout.decode().strip().splitlines()[-1])
        self.assertEqual((out["create"]["ok"], out["otherTable"]["ok"]), (True, True))
        for name in ("update", "delete", "updateMany", "deleteMany", "executeRaw"):
            with self.subTest(name):
                self.assertFalse(out[name]["ok"])
                self.assertIn("42501", out[name]["text"])
        self.assertEqual(len(self.rows(db)), 1)
        self.assertEqual(self.ok("SELECT detail IS NULL FROM \"AuditLog\"", db), ["t"])

    def test_as04_superuser_cleanup_bypass_is_scoped_to_the_audit_statement(self):
        """AS-04 (AO-12, AO-13, TC-02, TC-04): the rule the synthetic-stack cleanups follow."""
        db = self.new_database("as04", rows=2)
        self.ok("""INSERT INTO "Institution" (id, name) VALUES ('syn-ref', 'SYNTHETIC REFERENCED');
            INSERT INTO "StudyAccessPolicy" (institution, subject, revision, policy, reason, "updatedBy", "updatedAt")
              VALUES ('syn-ref', 'syn-subject', 1, '{"version":1,"restricted":false,"rules":[]}'::jsonb, 'SYNTHETIC policy',
                      'syn-admin', now());""", db)
        self.assertEqual(self.refused('DELETE FROM "AuditLog" WHERE id = 1', db), "42501",
                         "the guard holds for a superuser cleanup that does not bypass it")
        lines = self.ok('BEGIN; SET LOCAL session_replication_role = replica; DELETE FROM "AuditLog" WHERE id = 1 RETURNING 1; '
                        'SET LOCAL session_replication_role = origin; COMMIT;', db)
        self.assertEqual(lines, ["1"])
        # after the reset, in the same transaction, a foreign-key RESTRICT target is still protected
        code, _, state = self.sql('BEGIN; SET LOCAL session_replication_role = replica; DELETE FROM "AuditLog" WHERE id = 2; '
                                  'SET LOCAL session_replication_role = origin; '
                                  "DELETE FROM \"Institution\" WHERE id = 'syn-ref'; COMMIT;", db)
        self.assertEqual((code != 0, state), (True, "23503"))
        self.assertEqual(len(self.rows(db)), 1, "the refused transaction kept the audit row too")
        # violation control: replica mode over the whole transaction also drops the foreign-key check
        self.ok("BEGIN; SET LOCAL session_replication_role = replica; DELETE FROM \"AuditLog\" WHERE id = 2; "
                "DELETE FROM \"Institution\" WHERE id = 'syn-ref'; COMMIT;", db)
        self.assertEqual(self.ok("SELECT count(*) FROM \"Institution\" WHERE id = 'syn-ref'", db), ["0"])

    def test_as05_dump_restore_carries_rows_and_guard(self):
        """AS-05 (AO-14, RS-06): the restore options of rehearse and the product transfer fixture."""
        db = self.new_database("as05", rows=6)
        before = self.rows(db)
        dump = docker("exec", self.db, "pg_dump", "-U", "kin", "-d", db, "-Fc").stdout
        for target in ("as05_restored", "as05_restored_again"):
            with self.subTest(target):
                self.ok('CREATE DATABASE "%s"' % target)
                docker("exec", "-i", self.db, "pg_restore", "-U", "kin", "-d", target, "--no-owner", "--no-privileges",
                       "--exit-on-error", input=dump)
                self.assertEqual(self.rows(target), before)
                self.assertEqual(self.refused('UPDATE "AuditLog" SET detail = \'x\' WHERE id = 1', target), "42501")
                self.assertEqual(self.refused('DELETE FROM "AuditLog"', target), "42501")

    def test_as06_boot_migration_on_existing_rows_applies_one_and_later_updates_stop(self):
        """AS-06 (AO-09, AO-11): the image's newest migration onto a database holding every earlier one."""
        names = sorted(p.name for p in MIGRATIONS.iterdir() if p.is_dir())
        base = self.work / "base-migrations"

        def subset(count):
            shutil.rmtree(base, ignore_errors=True)
            (base / "migrations").mkdir(parents=True)
            shutil.copyfile(ROOT / "api/prisma/schema.prisma", base / "schema.prisma")
            shutil.copyfile(MIGRATIONS / "migration_lock.toml", base / "migrations" / "migration_lock.toml")
            for name in names[:count]:
                shutil.copytree(MIGRATIONS / name, base / "migrations" / name)
            for path in [base, *base.rglob("*")]:
                os.chmod(path, 0o755 if path.is_dir() else 0o644)   # read by the image's unprivileged user

        def applied(database):
            return sorted(self.ok("SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL "
                                  "AND rolled_back_at IS NULL", database))

        # control: one fewer than the base -> the initial-state check refuses it before anything is judged
        self.ok('CREATE DATABASE "as06_short"')
        subset(len(names) - 2)
        self.deploy("as06_short", "/base/schema.prisma", base)
        self.assertNotEqual(applied("as06_short"), names[:-1])

        self.ok('CREATE DATABASE "as06"')
        subset(len(names) - 1)
        self.deploy("as06", "/base/schema.prisma", base)
        self.assertEqual(applied("as06"), names[:-1], "(1) the initial database holds every earlier migration")
        self.assertEqual(sorted(set(names) - set(applied("as06"))), [names[-1]], "(2) the candidate adds exactly one")
        self.write_rows("as06", 5)
        before = self.rows("as06")
        self.deploy("as06")
        self.assertEqual(applied("as06"), names)
        self.assertEqual(self.rows("as06"), before, "rows, ids and contents are unchanged by the migration")
        again = self.deploy("as06")
        self.assertIn("No pending migrations", again)
        self.assertEqual(applied("as06"), names)
        # a later migration may add a column, but a backfill UPDATE of AuditLog stops at the guard
        self.ok('ALTER TABLE "AuditLog" ADD COLUMN syn_probe text', "as06")
        self.assertEqual(self.refused("UPDATE \"AuditLog\" SET syn_probe = 'x'", "as06"), "42501")

    # ── RA-2 / RA-3: seal and verify, computed in the isolated verifier ──

    def test_iv01_clean_database_verifies_in_a_networkless_verifier(self):
        """IV-DB-01 (IV-01, IV-02, IV-16)."""
        root = self.new_root()
        db = self.new_database("iv01")
        folder, checkpoint, alarm = self.seal(db, root)
        self.assertEqual((checkpoint["through_id"], checkpoint["count"], checkpoint["rows"], alarm), (None, 0, [], None))
        seen, stop = {}, threading.Event()

        def watch():
            while not stop.is_set():
                for identity in verifier_containers():
                    if identity not in seen:
                        found = docker("inspect", identity, check=False).stdout
                        if found:
                            info = json.loads(found)[0]
                            seen[identity] = (info["HostConfig"]["NetworkMode"], info["Image"],
                                              [m["Type"] for m in info.get("Mounts", [])])
                time.sleep(0.05)
        watcher = threading.Thread(target=watch)
        watcher.start()
        try:
            code, report = self.verify_db(db, folder)
        finally:
            stop.set()
            watcher.join()
        self.assertEqual(code, 0, report)
        self.assertEqual((report["tail"], report["guard"]["state"], report["schema"]), (0, "present", []))
        self.assertTrue(seen, "the verifier container was observed")
        for network, image, mounts in seen.values():
            self.assertEqual((network, image), ("none", self.db_image))
            self.assertNotIn("bind", mounts)

        self.write_rows(db, 30)
        self.gap(db)
        self.write_rows(db, 20)
        folder, checkpoint, alarm = self.seal(db, root)
        self.assertEqual((checkpoint["count"], alarm, checkpoint["previous_verification"]["state"]), (50, None, "verified"))
        self.assertEqual(self.verify_db(db, folder)[0], 0)
        self.ok("ALTER DATABASE iv01 SET TimeZone = 'Asia/Seoul'; ALTER DATABASE iv01 SET DateStyle = 'SQL, DMY'")
        code, report = self.verify_db(db, folder)
        self.assertEqual((code, report["changed"]["count"]), (0, 0), "server settings do not change a digest")
        self.assertNotIn(SENTINEL, (folder / audit.CHECKPOINT).read_text() + (root / audit.LEDGER).read_text())

    def test_iv02_one_column_of_one_row_changed_is_reported(self):
        """IV-DB-02 (IV-03, SE-08)."""
        root = self.new_root()
        db = self.new_database("iv02", rows=10)
        folder, _, _ = self.seal(db, root)
        values = {"actor": "'syn-changed'", "action": "'syn.changed'", "target": "'syn-changed'", "detail": "'{}'",
                  "at": "at + interval '1 millisecond'"}
        for column, value in values.items():
            with self.subTest(column):
                copy = self.new_database("iv02_" + column, source=db)
                self.as_superuser('UPDATE "AuditLog" SET %s = %s WHERE id = 4' % (column, value), copy)
                if column == "detail":   # unrelated changes elsewhere in the database do not move the verdict
                    self.ok("INSERT INTO \"Institution\" (id, name) VALUES ('syn-x', 'SYNTHETIC'); "
                            "SELECT setval(pg_get_serial_sequence('\"AuditLog\"', 'id'), 2)", copy)
                code, report = self.verify_db(copy, folder)
                self.assertEqual((code, report["changed"]["ids"], report["deleted"]["count"], report["inserted"]["count"]),
                                 (1, [4], 0, 0))
        same = self.new_database("iv02_same", source=db)
        self.as_superuser('UPDATE "AuditLog" SET actor = actor WHERE id = 4', same)
        self.assertEqual(self.verify_db(same, folder)[0], 0, "an update to the same value is no change")

    def test_iv03_deleted_rows_are_reported_smallest_first(self):
        """IV-DB-03 (IV-04, IV-10)."""
        root = self.new_root()
        db = self.new_database("iv03", rows=120)
        folder, _, _ = self.seal(db, root)
        one = self.new_database("iv03_one", source=db)
        self.as_superuser('DELETE FROM "AuditLog" WHERE id = 7', one)
        code, report = self.verify_db(one, folder)
        self.assertEqual((code, report["deleted"]["ids"], report["changed"]["count"]), (1, [7], 0))
        everything = self.new_database("iv03_all", source=db)
        self.as_superuser('DELETE FROM "AuditLog"', everything)
        code, report = self.verify_db(everything, folder)
        self.assertEqual((code, report["deleted"]["count"], report["deleted"]["ids"]), (1, 120, list(range(1, 101))))
        # one deletion hidden behind one new row keeps the count, not the verdict
        swapped = self.new_database("iv03_swap", source=db)
        self.as_superuser('DELETE FROM "AuditLog" WHERE id = 9', swapped)
        self.write_rows(swapped, 1)
        code, report = self.verify_db(swapped, folder)
        self.assertEqual((code, report["deleted"]["ids"], report["tail"]), (1, [9], 1))

    def test_iv04_row_inserted_into_a_gap_is_reported(self):
        """IV-DB-04 (IV-05)."""
        root = self.new_root()
        db = self.new_database("iv04", rows=3)
        gap = self.gap(db)
        self.write_rows(db, 3)
        folder, checkpoint, _ = self.seal(db, root)
        self.assertNotIn(gap, [row[0] for row in checkpoint["rows"]])
        self.ok("INSERT INTO \"AuditLog\" (id, actor, action, target) VALUES (%d, 'syn-inserted', 'syn.x', 'syn')" % gap, db)
        code, report = self.verify_db(db, folder)
        self.assertEqual((code, report["inserted"]["ids"], report["changed"]["count"], report["deleted"]["count"]),
                         (1, [gap], 0, 0))

    def test_iv05_rows_after_the_seal_are_tail_and_verify_writes_nothing(self):
        """IV-DB-05 (IV-06, IV-07, IV-14)."""
        root = self.new_root()
        db = self.new_database("iv05", rows=4)
        folder, _, _ = self.seal(db, root)
        self.write_rows(db, 3)
        catalog = ("SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
                   "WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')), "
                   "(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public')")
        before = (self.rows(db), self.ok(catalog, db))
        code, report = self.verify_db(db, folder)
        self.assertEqual((code, report["tail"]), (0, 3))
        self.assertEqual((self.rows(db), self.ok(catalog, db)), before, "verify reads through pg_dump only")
        # writers keep inserting while verify runs
        writer = subprocess.Popen(["docker", "exec", "-i", self.db, "psql", "-X", "-q", "-U", "kin", "-d", db],
                                  stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        writer.stdin.write(b"".join(b"INSERT INTO \"AuditLog\" (actor, action, target) VALUES ('syn-live', 'syn.live', 'x'); "
                                    b"SELECT pg_sleep(0.1);\n" for _ in range(40)))
        writer.stdin.close()
        code, report = self.verify_db(db, folder)
        writer.wait(timeout=120)
        self.assertEqual(code, 0, report)
        self.assertGreaterEqual(report["tail"], 3)

    def test_iv06_snapshots_against_older_and_newer_checkpoints(self):
        """IV-DB-06 (IV-08, RS-02, RS-04, RS-05)."""
        root = self.new_root()
        db = self.new_database("iv06", rows=5)
        first, _, _ = self.seal(db, root)
        self.write_rows(db, 3)
        second, checkpoint, _ = self.seal(db, root)
        self.assertEqual(checkpoint["previous_verification"]["state"], "verified")
        code, report = self.verify("--backup", second, "--checkpoint", first / audit.CHECKPOINT)
        self.assertEqual((code, report["tail"]), (0, 3))
        self.assertEqual(self.verify("--backup", second)[0], 0)
        code, report = self.verify("--backup", first, "--checkpoint", second / audit.CHECKPOINT)
        self.assertEqual((code, report["deleted"]["ids"]), (1, [6, 7, 8]))
        # a dump whose one row differs, with a manifest that matches it: counts agree, content does not
        changed = self.new_database("iv06_changed", source=db)
        self.as_superuser("UPDATE \"AuditLog\" SET detail = 'syn-other' WHERE id = 2", changed)
        third, _ = self.snapshot(changed, Path(tempfile.mkdtemp(prefix="loose-", dir=self.work)))
        self.assertEqual(len(self.rows(changed)), len(self.rows(db)))
        code, report = self.verify("--backup", third, "--checkpoint", second / audit.CHECKPOINT)
        self.assertEqual((code, report["changed"]["ids"]), (1, [2]))
        self.assertEqual(self.verify("--backup", second), self.verify("--backup", second), "the same input, the same report")

    def test_iv07_guard_disabled_dropped_or_emptied_is_detected(self):
        """IV-DB-07 (IV-09)."""
        root = self.new_root()
        db = self.new_database("iv07", rows=5)
        folder, _, _ = self.seal(db, root)
        triggers = self.guard_triggers(db)
        self.assertTrue(triggers)
        function = triggers[0]["function"]
        variants = {"disabled": 'ALTER TABLE "AuditLog" DISABLE TRIGGER USER',
                    "dropped": "; ".join('DROP TRIGGER "%s" ON "AuditLog"' % t["name"] for t in triggers),
                    "emptied": "CREATE OR REPLACE FUNCTION %s() RETURNS trigger LANGUAGE plpgsql AS "
                               "$$ BEGIN RETURN COALESCE(NEW, OLD); END $$" % function}
        for label, statement in variants.items():
            with self.subTest(label):
                copy = self.new_database("iv07_" + label, source=db)
                self.ok(statement, copy)
                code, report = self.verify_db(copy, folder)
                self.assertEqual((code, report["guard"]["state"]), (1, "ineffective"))
                self.assertEqual([report[k]["count"] for k in ("changed", "deleted", "inserted")], [0, 0, 0])

    def test_iv08_a_column_added_later_leaves_old_digests(self):
        """IV-DB-08 (IV-15)."""
        root = self.new_root()
        db = self.new_database("iv08", rows=5)
        folder, _, _ = self.seal(db, root)
        self.ok('ALTER TABLE "AuditLog" ADD COLUMN syn_extra text', db)
        self.as_superuser("UPDATE \"AuditLog\" SET syn_extra = 'x' WHERE id <= 3", db)
        code, report = self.verify_db(db, folder)
        self.assertEqual(code, 0, report)

    def test_iv09_rows_and_the_digest_computation_tampered_together(self):
        """IV-DB-09 (IV-17, SE-08; Astra F01): SQL-level tampering of the server cannot pass."""
        root = self.new_root()
        db = self.new_database("iv09", rows=6)
        folder, checkpoint, _ = self.seal(db, root)
        sealed = dict(map(tuple, checkpoint["rows"]))
        same = self.new_database("iv09_same", source=db)
        self.as_superuser("UPDATE \"AuditLog\" SET detail = detail WHERE id = 3", same)
        self.assertEqual(self.verify_db(same, folder)[0], 0)
        constructed = []
        for variant in ("pg_catalog", "search_path"):
            with self.subTest(variant):
                copy = self.new_database("iv09_" + variant, source=db)
                marker = "SYN-TAMPERED-" + variant
                self.as_superuser("UPDATE \"AuditLog\" SET detail = '%s' WHERE id = 3" % marker, copy)
                if not self.replace_sha256(copy, marker, sealed[3], variant):
                    continue
                constructed.append(variant)
                # the counterexample holds: an in-database computation now returns the sealed digest for the changed row
                self.assertEqual(self.live_digest(copy, 3, qualified=variant == "pg_catalog"), sealed[3])
                code, report = self.verify_db(copy, folder)
                self.assertEqual((code, report["changed"]["ids"], report["guard"]["state"], report["schema"]),
                                 (1, [3], "present", []))
                if variant == "pg_catalog":
                    second, next_checkpoint, alarm = self.seal(copy, root)
                    self.assertEqual(next_checkpoint["previous_verification"]["state"], "failed")
                    self.assertEqual(next_checkpoint["previous_verification"]["changed"]["ids"], [3])
                    self.assertEqual(alarm, "AuditIntegrityMismatch")
        self.assertTrue(constructed, "at least one computation-tamper variant must be constructible")

    def test_iv10_relation_substitution_is_detected(self):
        """IV-DB-10 (IV-18)."""
        root = self.new_root()
        db = self.new_database("iv10", rows=4)
        folder, _, _ = self.seal(db, root)
        view = self.new_database("iv10_view", source=db)
        self.ok('ALTER TABLE "AuditLog" RENAME TO "AuditLogKept"; CREATE VIEW "AuditLog" AS SELECT * FROM "AuditLogKept"', view)
        code, report = self.verify_db(view, folder)
        self.assertEqual((code, report["deleted"]["ids"]), (1, [1, 2, 3, 4]))
        self.assertIn("not_a_table", report["schema"])
        shadow = self.new_database("iv10_shadow", source=db)
        self.ok('CREATE SCHEMA syn_shadow; CREATE TABLE syn_shadow."AuditLog" AS SELECT * FROM public."AuditLog"; '
                'ALTER DATABASE iv10_shadow SET search_path = syn_shadow, public', shadow)
        code, report = self.verify_db(shadow, folder)
        self.assertEqual(code, 1)
        self.assertIn("shadow_relation", report["schema"])
        child = self.new_database("iv10_child", source=db)
        self.ok('CREATE TABLE "AuditLogChild" () INHERITS ("AuditLog")', child)
        code, report = self.verify_db(child, folder)
        self.assertEqual(code, 1)
        self.assertIn("inheritance", report["schema"])
        unrelated = self.new_database("iv10_unrelated", source=db)
        self.ok('CREATE SCHEMA syn_other; CREATE TABLE syn_other."AuditTrail" (id int); CREATE TABLE "AuditLogArchive" (id int)',
                unrelated)
        self.assertEqual(self.verify_db(unrelated, folder)[0], 0)

    # ── RA-4: the restored copy, not the snapshot file ──

    def test_iv11_restored_copy_changed_after_the_restore_is_reported(self):
        """IV-DB-11 (RS-01, RS-10; Astra B-F01)."""
        root = self.new_root()
        db = self.new_database("iv11", rows=6)
        folder, checkpoint, _ = self.seal(db, root)
        sealed = dict(map(tuple, checkpoint["rows"]))
        files = self.hashes(folder, root)
        restored = self.restore(folder)
        restored_rows = len(self.rows("kin", restored, "postgres"))
        code, report = self.verify_db("kin", folder, restored, "postgres")
        self.assertEqual((code, report["tail"], report["guard"]["state"], report["schema"]), (0, 0, "present", []))
        self.as_superuser("UPDATE \"AuditLog\" SET detail = detail WHERE id = 5", "kin", restored, "postgres")
        self.assertEqual(self.verify_db("kin", folder, restored, "postgres")[0], 0)
        self.as_superuser("UPDATE \"AuditLog\" SET detail = 'syn-restored-only' WHERE id = 5", "kin", restored, "postgres")
        code, report = self.verify_db("kin", folder, restored, "postgres")
        self.assertEqual((code, report["changed"]["ids"], report["guard"]["state"], report["schema"]), (1, [5], "present", []))
        self.assertEqual(len(self.rows("kin", restored, "postgres")), restored_rows)
        self.assertEqual(self.hashes(folder, root), files)
        self.assertEqual(self.verify("--backup", folder)[0], 0, "a check of the snapshot file alone misses this difference")
        constructed = []
        for variant in ("pg_catalog", "search_path"):
            with self.subTest(variant):
                copy = self.restore(folder)
                marker = "SYN-RESTORED-" + variant
                self.as_superuser("UPDATE \"AuditLog\" SET detail = '%s' WHERE id = 5" % marker, "kin", copy, "postgres")
                if not self.replace_sha256("kin", marker, sealed[5], variant, copy, "postgres"):
                    continue
                constructed.append(variant)
                self.assertEqual(self.live_digest("kin", 5, variant == "pg_catalog", copy, "postgres"), sealed[5])
                code, report = self.verify_db("kin", folder, copy, "postgres")
                self.assertEqual((code, report["changed"]["ids"]), (1, [5]))
                self.assertEqual(self.hashes(folder, root), files)
        self.assertTrue(constructed)

    def test_iv12_past_events_pass_current_guard_or_shape_defects_fail(self):
        """IV-DB-12 (SE-05, SE-14, RS-08, RS-09; Astra B-F02)."""
        root = self.new_root()
        db = self.new_database("iv12", rows=5)
        self.seal(db, root)
        self.as_superuser("UPDATE \"AuditLog\" SET detail = 'syn-past' WHERE id = 2", db)
        past, checkpoint, alarm = self.seal(db, root)
        self.assertEqual((checkpoint["previous_verification"]["state"], checkpoint["guard"]["state"], checkpoint["schema"],
                          alarm), ("failed", "present", [], "AuditIntegrityMismatch"))
        code, report = self.verify_db("kin", past, self.restore(past), "postgres")
        self.assertEqual((code, report["tail"]), (0, 0), "a past event does not fail the restored copy")
        self.assertEqual(self.verify("--backup", past)[0], 0)

        triggers = self.guard_triggers(db)
        self.ok("; ".join('DROP TRIGGER "%s" ON "AuditLog"' % t["name"] for t in triggers), db)
        current, checkpoint, alarm = self.seal(db, root)
        self.assertEqual((checkpoint["guard"]["state"], alarm), ("ineffective", "AuditGuardIneffective"))
        code, report = self.verify_db("kin", current, self.restore(current), "postgres")
        self.assertEqual((code, report["guard"]["state"], report["changed"]["count"], report["deleted"]["count"]),
                         (1, "ineffective", 0, 0))
        self.assertEqual(self.verify("--backup", current)[0], 1)

        self.ok("; ".join(t["def"] for t in triggers) + '; CREATE TABLE "AuditLogChild" () INHERITS ("AuditLog")', db)
        shaped, checkpoint, alarm = self.seal(db, root)
        self.assertEqual((checkpoint["guard"]["state"], checkpoint["schema"], alarm),
                         ("present", ["inheritance"], "AuditSchemaFinding"))
        code, report = self.verify_db("kin", shaped, self.restore(shaped), "postgres")
        self.assertEqual((code, report["schema"]), (1, ["inheritance"]))
        self.assertEqual(self.verify("--backup", shaped)[0], 1)

        self.ok('ALTER TABLE "AuditLogChild" NO INHERIT "AuditLog"', db)
        sound, checkpoint, alarm = self.seal(db, root)
        self.assertEqual((checkpoint["previous_verification"]["state"], alarm), ("verified", None))
        self.assertEqual(self.verify_db("kin", sound, self.restore(sound), "postgres")[0], 0)

    def test_iv13_an_export_waiting_on_a_lock_fails_within_the_time_limit(self):
        """IV-DB-13 (S7-AUDIT-STORE-F02): while another session holds ACCESS EXCLUSIVE on AuditLog, the export of the
        named database cannot start; evaluate with an 8 s limit fails as an input error within the limit and the cleanup
        budget with a confirmed termination proof, its verifier is removed (tearDown), and neither the export's session
        nor a process docker exec started for it stays behind. Released, the same database verifies."""
        limit = 8
        root = self.new_root()
        db = self.new_database("iv13", rows=4)
        folder, _, _ = self.seal(db, root)
        holder = self.lock(db)
        try:
            seen, stop = [], threading.Event()

            def watch():
                while not stop.is_set():
                    if any(wait == "Lock" for _, _, wait in self.sessions(db, holder.pid).values()):
                        seen.append(True)
                    time.sleep(0.25)
            watcher = threading.Thread(target=watch)
            watcher.start()
            started = time.monotonic()
            try:
                with self.assertRaises(audit.InputError) as caught:
                    audit.evaluate(audit.DatabaseExport(self.db, db, "kin"), timeout=limit)
            finally:
                stop.set()
                watcher.join()
            self.assertLess(time.monotonic() - started, limit + GRACE)
            self.assertTrue(seen, "the export was observed waiting on the lock (not an unrelated early failure)")
            self.assertTrue(caught.exception.cleanup["confirmed"], caught.exception.cleanup)
            self.assertEqual(self.sessions(db, holder.pid), {}, "the export that waited for the lock does not stay behind")
            self.assertEqual(self.exec_processes(), {}, "nor does any process started for it")
        finally:
            holder.close()
        self.assertEqual(self.verify_db(db, folder)[0], 0, "without the lock the same export verifies")

    def test_iv14_an_early_verifier_failure_ends_only_its_own_run(self):
        """IV-DB-14 (S7-AUDIT-STORE-F02; SPEC-F01, SPEC-F03 verifier early failure and the foreign job kept): two
        `verify --container` runs of the same database and role wait on a held lock, beside a session of that database
        and role named like the first run's session except in the run's own characters. The first run's verifier
        container is killed: that run exits 2 within the cleanup budget, long before its time limit, with a confirmed
        proof naming its run, the target container's ID and the whole session name the server showed; its session and
        the processes docker exec started for it are gone. The second run's session (same pid, still waiting) and
        processes and the foreign session (same pid, still answering) are untouched. Released, the second run verifies
        (exit 0) and nothing of either run is left."""
        root = self.new_root()
        db = self.new_database("iv14", rows=4)
        folder, _, _ = self.seal(db, root)
        holder = self.lock(db)
        own, runs, foreign = {holder.pid}, [], None
        try:
            first = self.start_verify(db, folder)
            runs.append(first)
            ((a_pid, (a_name, _, _)),) = self.waiting(db, own, 1).items()
            a_processes = self.exec_processes()
            self.assertTrue(a_processes, "the run's remote processes are seen")
            (a_verifier,) = verifier_containers()
            foreign_name = a_name[:-8] + ("0" * 8 if a_name[-8:] != "0" * 8 else "f" * 8)
            foreign = Session(self.db, db, application_name=foreign_name)
            own.add(foreign.pid)
            second = self.start_verify(db, folder)
            runs.append(second)
            both = self.waiting(db, own, 2)
            (b_pid,) = set(both) - {a_pid}
            b_processes = {pid: name for pid, name in self.exec_processes().items() if pid not in a_processes}
            self.assertEqual(sorted(b_processes.values()), sorted(a_processes.values()), "the second run's processes")

            killed_at = time.monotonic()
            docker("kill", a_verifier)
            out = self.finish(first, GRACE + 60)
            self.assertLess(time.monotonic() - killed_at, GRACE + 3,
                            "the failure is not waited out until the run's time limit")
            after = self.sessions(db, *own)
            self.assertEqual(set(after), {b_pid}, "only the other run's session is left")
            self.assertEqual(after[b_pid][2], "Lock", "and it still waits")
            self.assertEqual(self.exec_processes(), b_processes, "only the other run's processes are left")
            self.assertEqual(foreign.ask("SELECT pg_catalog.pg_backend_pid()"), str(foreign.pid),
                             "the foreign session is the same and still answers")
            self.assertEqual(holder.ask("SELECT 1"), "1")

            report = json.loads(out)
            self.assertEqual((first.returncode, report["exit"]), (2, 2), report)
            proof = report.get("cleanup") or {}
            self.assertTrue(proof.get("confirmed"), proof)
            self.assertLessEqual(proof["elapsed_seconds"], GRACE)
            self.assertEqual(proof["target"], {"container": self.container_id(), "database": db, "role": "kin",
                                               "application_name": a_name}, "the whole name the server showed")
            self.assertIn(proof["run"], a_name)
            self.assertIn(a_pid, [session["pid"] for session in remote_step(proof).get("sessions", [])])

            holder.send("ROLLBACK")
            out = self.finish(second, 180)
            self.assertEqual((second.returncode, json.loads(out)["exit"]), (0, 0), "the other run verifies")
            self.assertEqual(self.sessions(db, *own), {})
            self.assertTrue(self.until(lambda: self.exec_processes() == {}, 10), self.exec_processes())
        finally:
            for process in runs:
                if process.poll() is None:
                    process.kill()
                    process.communicate()
            if foreign is not None:
                foreign.close()
            holder.close()

    def test_iv15_the_local_docker_client_alone_does_not_end_the_export(self):
        """IV-DB-15 (SPEC-F01, SPEC-F03 local client only; no late connection): on this host's docker client, killing the
        client of a `docker exec ... pg_dump` that waits on a lock leaves its session and its pg_dump in the container
        (the boundary, shown with the test's own export). The tool's run whose export client is killed the same way
        fails within the cleanup budget with a confirmed proof that names the remote pg_dump it ended and the session it
        terminated; nothing of the run is left. The run's own export command started again afterwards (as a docker start
        that arrives late) exits by itself without opening a session."""
        root = self.new_root()
        db = self.new_database("iv15", rows=4)
        folder, _, _ = self.seal(db, root)
        holder = self.lock(db)
        replay = None
        try:
            control_name = "syn-control-" + uuid.uuid4().hex[:12]
            control = subprocess.Popen(["docker", "exec", "-e", "PGAPPNAME=" + control_name, self.db, "pg_dump", "-U",
                                        "kin", "-d", db, "-Fc"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            self.waiting(db, {holder.pid}, 1)
            control.kill()
            control.wait()
            time.sleep(3)
            self.assertEqual([name for name, _, _ in self.sessions(db, holder.pid).values()], [control_name],
                             "the session stays after its client was killed")
            self.assertIn("(pg_dump)", self.exec_processes().values(), "and so does its pg_dump")
            self.ok("SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity "
                    "WHERE application_name = '%s'" % control_name, db)
            self.assertTrue(self.until(lambda: not self.sessions(db, holder.pid) and not self.exec_processes(), 15))

            recorder = Recorder()
            with recorder.active():
                call = Background(lambda: audit.evaluate(audit.DatabaseExport(self.db, db, "kin"), timeout=120))
                ((a_pid, (a_name, _, _)),) = self.waiting(db, {holder.pid}, 1).items()
                (dump,) = [pid for pid, name in self.exec_processes().items() if name == "(pg_dump)"]
                ((export_args, client),) = recorder.running_against(self.container_id())
                killed_at = time.monotonic()
                client.kill()
                outcome, finished = call.result(GRACE + 60)
            error = outcome.get("error")
            self.assertIsInstance(error, audit.InputError, outcome)
            self.assertLess(finished - killed_at, GRACE + 2)
            self.assertEqual(self.sessions(db, holder.pid), {}, "the run's session is gone")
            self.assertEqual(self.exec_processes(), {}, "and so is every process docker exec started for it")
            proof = error.cleanup or {}
            self.assertTrue(proof.get("confirmed"), proof)
            self.assertIn(dump, remote_step(proof).get("killed", []), "the proof names the remote pg_dump it ended")
            self.assertIn(a_pid, [session["pid"] for session in remote_step(proof).get("sessions", [])])

            replay = subprocess.Popen(export_args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            seen, end = [], time.monotonic() + 15
            while replay.poll() is None and time.monotonic() < end:
                seen += [name for name, _, _ in self.sessions(db, holder.pid).values()]
                time.sleep(0.2)
            self.assertIsNotNone(replay.poll(), "the late start ended by itself")
            self.assertNotEqual(replay.returncode, 0)
            seen += [name for name, _, _ in self.sessions(db, holder.pid).values()]
            self.assertNotIn(a_name, seen, "the late start of a cancelled run opens no session")
            self.assertEqual(self.exec_processes(), {})
        finally:
            if replay is not None and replay.poll() is None:
                replay.kill()
                replay.wait()
            holder.close()
        self.assertEqual(self.verify_db(db, folder)[0], 0)

    def test_iv16_the_deadline_and_the_runs_life_bound_the_remote_export(self):
        """IV-DB-16 (SPEC-F01 whole-life limit; SPEC-F03 producer stall, deadline, caller gone). (a) Past its lock wait
        (the lock released while its pg_dump was stopped) the export's session waits for its client, not a lock: at the
        15 s limit evaluate fails with a confirmed proof naming the stopped pg_dump and nothing is left. (b) The caller's
        process is killed while its export waits on the lock: the server ends that wait at the run's deadline, not
        later. (c) The caller's process is killed while its export's pg_dump is stopped past its lock wait: two seconds
        later the run is still in the container, and the run's watchdog ends it by the end of the run's life (its
        deadline plus the cleanup budget). Nothing of a run is left in any case."""
        db = self.new_database("iv16", rows=4)

        def stop_past_the_lock(holder, pid):
            (dump,) = [found for found, name in self.exec_processes().items() if name == "(pg_dump)"]
            docker("exec", self.db, "kill", "-STOP", str(dump))
            holder.close()
            self.assertTrue(self.until(lambda: self.sessions(db).get(pid, ("", "", "Lock"))[2] not in ("Lock", ""), 15),
                            "the export's session left its lock wait")
            return dump

        with self.subTest("(a) the deadline past the lock wait"):
            holder = self.lock(db)
            call = Background(lambda: audit.evaluate(audit.DatabaseExport(self.db, db, "kin"), timeout=15))
            ((pid, _),) = self.waiting(db, {holder.pid}, 1).items()
            dump = stop_past_the_lock(holder, pid)
            outcome, finished = call.result(15 + GRACE + 30)
            error = outcome.get("error")
            self.assertIsInstance(error, audit.InputError, outcome)
            self.assertGreaterEqual(finished - call.started, 15 - 0.5, "it ran until its limit")
            self.assertLess(finished - call.started, 15 + GRACE + 5)
            self.assertEqual((self.sessions(db), self.exec_processes()), ({}, {}), "nothing of the run is left")
            self.assertTrue((error.cleanup or {}).get("confirmed"), error.cleanup)
            self.assertIn(dump, remote_step(error.cleanup).get("killed", []), "the proof names the stopped pg_dump")

        with self.subTest("(b) the caller gone during the lock wait"):
            holder = self.lock(db)
            try:
                caller = self.start_caller(db, 10)
                self.waiting(db, {holder.pid}, 1)
                seen_at = time.monotonic()
                caller.kill()
                caller.wait()
                ended = self.until(lambda: not self.sessions(db, holder.pid)
                                   and "(pg_dump)" not in self.exec_processes().values(), 10 + 6)
                self.assertTrue(ended, "the server ended the lock wait at the run's deadline")
                self.assertLess(time.monotonic() - seen_at, 10 + 6)
            finally:
                holder.close()
            self.assertTrue(self.until(lambda: self.exec_processes() == {}, 10), "the watchdog leaves after the export")
            self.remove_left_verifiers()

        with self.subTest("(c) the caller gone past the lock wait"):
            holder = self.lock(db)
            caller = self.start_caller(db, 8)
            ((pid, _),) = self.waiting(db, {holder.pid}, 1).items()
            seen_at = time.monotonic()
            dump = stop_past_the_lock(holder, pid)
            caller.kill()
            caller.wait()
            time.sleep(2)
            self.assertIn(pid, self.sessions(db), "the run outlives its caller")
            self.assertIn(dump, self.exec_processes())
            ended = self.until(lambda: not self.sessions(db) and not self.exec_processes(),
                               8 + GRACE + 10 - (time.monotonic() - seen_at))
            self.assertTrue(ended, "the run's watchdog ended it by the end of the run's life")
            self.assertLess(time.monotonic() - seen_at, 8 + GRACE + 10)
            self.remove_left_verifiers()

    def test_iv17_a_cleanup_it_cannot_confirm_is_not_reported_as_done(self):
        """IV-DB-17 (SPEC-F01: a termination that fails or cannot be confirmed is kept with the failure, never reported
        as done). (a) The target container is paused when the verifier fails, so the remote cancellation cannot run:
        evaluate still fails within the cleanup budget with the original failure, and its proof says the remote export
        was not confirmed ended - which is true: once the target runs again the export's session is still waiting; the
        harness then ends it. (b) A session of another role carries the run's own session name: the cancellation, bound
        to the export's role, ends the run's session but not that one, and a new observation still finds the name, so
        the proof is not confirmed; the other role's session is the same afterwards and still answers."""
        db = self.new_database("iv17", rows=4)
        with self.subTest("(a) the target cannot be reached"):
            holder = self.lock(db)
            try:
                call = Background(lambda: audit.evaluate(audit.DatabaseExport(self.db, db, "kin"), timeout=60))
                ((pid, _),) = self.waiting(db, {holder.pid}, 1).items()
                (verifier,) = verifier_containers()
                docker("pause", self.db)
                try:
                    killed_at = time.monotonic()
                    docker("kill", verifier)
                    outcome, finished = call.result(GRACE + 60)
                finally:
                    docker("unpause", self.db)
                error = outcome.get("error")
                self.assertIsInstance(error, audit.InputError, outcome)
                self.assertLess(finished - killed_at, GRACE + 2)
                proof = error.cleanup or {}
                self.assertIn(pid, self.sessions(db, holder.pid), "the export the proof did not confirm is still there")
                self.assertFalse(proof.get("confirmed"), proof)
                self.assertFalse(remote_step(proof).get("confirmed"))
                self.assertTrue(proof["steps"]["verifier"]["confirmed"])
                self.ok("SELECT pg_catalog.pg_terminate_backend(%d)" % pid, db)
                self.assertTrue(self.until(lambda: not self.sessions(db, holder.pid) and not self.exec_processes(), 20))
            finally:
                holder.close()

        with self.subTest("(b) the run's name under another role"):
            self.ok("DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'syn_other') "
                    "THEN CREATE ROLE syn_other LOGIN; END IF; END $$")
            holder = self.lock(db)
            other = None
            try:
                call = Background(lambda: audit.evaluate(audit.DatabaseExport(self.db, db, "kin"), timeout=60))
                ((pid, (name, _, _)),) = self.waiting(db, {holder.pid}, 1).items()
                other = Session(self.db, db, user="syn_other", application_name=name)
                (verifier,) = verifier_containers()
                docker("kill", verifier)
                outcome, _ = call.result(GRACE + 60)
                error = outcome.get("error")
                self.assertIsInstance(error, audit.InputError, outcome)
                self.assertEqual(set(self.sessions(db, holder.pid)), {other.pid}, "the run's own session is gone")
                self.assertEqual(other.ask("SELECT pg_catalog.pg_backend_pid()"), str(other.pid),
                                 "the other role's session is the same and still answers")
                self.assertEqual(self.exec_processes(), {})
                proof = error.cleanup or {}
                self.assertFalse(proof.get("confirmed"), proof)
                self.assertEqual(remote_step(proof).get("sessions_left"), 1, "a new observation still finds the name")
            finally:
                if other is not None:
                    other.close()
                holder.close()

    def test_iv18_a_process_of_the_run_that_docker_did_not_start_is_never_signalled(self):
        """IV-DB-18 (SPEC-F01 exactly the run's own processes; PostgreSQL boundary: a process forked in the container whose
        parent is gone is a child of the postmaster, and the postmaster stops every session when such a child dies by a
        signal): the run's own export command is
        started once more so that its process is orphaned at once (the run's identity, parent PID 1). When the run fails,
        its cancellation ends its own exec'd pg_dump and both sessions of the run but never signals the orphan, which
        ends by itself once its session is gone; the proof is confirmed and the server did not restart (the lock
        holder's session is the same and answers, no new crash recovery in the server log)."""
        db = self.new_database("iv18", rows=4)
        holder = self.lock(db)
        try:
            recorder = Recorder()
            with recorder.active():
                call = Background(lambda: audit.evaluate(audit.DatabaseExport(self.db, db, "kin"), timeout=120))
                ((a_pid, (a_name, _, _)),) = self.waiting(db, {holder.pid}, 1).items()
                ((export_args, _),) = recorder.running_against(self.container_id())
                (dump,) = [pid for pid, name in self.exec_processes().items() if name == "(pg_dump)"]
                at = export_args.index(self.container_id())
                docker(*export_args[1:at + 1], "sh", "-c", '"$@" > /dev/null 2>&1 & exit 0', "sh",
                       *export_args[at + 1:])
                sessions = self.until(lambda: (lambda found: found if [name for name, _, _ in found.values()]
                                               == [a_name, a_name] else None)(self.sessions(db, holder.pid)), 30)
                self.assertTrue(sessions, "the orphaned copy waits under the run's name too")
                (orphan,) = [pid for pid, (name, parent) in self.processes().items()
                             if name == "(pg_dump)" and pid != dump]
                self.assertEqual(self.processes()[orphan][1], 1, "its parent is the container's PID 1")
                restarts = self.restarts()
                (verifier,) = verifier_containers()
                docker("kill", verifier)
                outcome, _ = call.result(GRACE + 60)
            error = outcome.get("error")
            self.assertIsInstance(error, audit.InputError, outcome)
            self.assertEqual(holder.ask("SELECT pg_catalog.pg_backend_pid()"), str(holder.pid), "no server restart")
            self.assertEqual(self.restarts(), restarts)
            self.assertEqual(self.sessions(db, holder.pid), {})
            self.assertNotIn("(pg_dump)", [name for name, _ in self.processes().values()])
            proof = error.cleanup or {}
            self.assertTrue(proof.get("confirmed"), proof)
            self.assertIn(dump, remote_step(proof).get("killed", []))
            self.assertNotIn(orphan, remote_step(proof).get("killed", []), "the orphan is never signalled")
            self.assertEqual(sorted(session["pid"] for session in remote_step(proof).get("sessions", [])),
                             sorted(sessions))
        finally:
            holder.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
