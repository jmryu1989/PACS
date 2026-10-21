"""Production image checks against a disposable PostgreSQL, with no host ports.

EMR-B1: the image has two entry modes. `start-production.sh migrate` applies the reviewed migrations with the installer
credential in its own one-shot container; `serve` (the default) opens the API with the least-privilege runtime role only
and refuses to start, in production, on any other credential. The disposable database is provisioned first with the
fixed provisioning SQL (roles, secrets, the dedicated tablespace on its own mount).

EMR-B2 (c): the served API is a client of the protected-state service (`state-serve-v3`, the third entry mode: UID 1000,
the reader credential, the state volume and the two IPC volumes). The API container here is the deployed shape: UID
1001 with group 2001, the runtime credential, `KIN_EMR_STATE_SOCKET` on the read-only API IPC volume and
`KIN_EMR_INSTANCE_ID`; it has no state volume. The service is started once the disposable database is migrated; an
API-only stop/start reconnects to the same service.
"""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import sys
import subprocess
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import ops_backup as ops

_spec = importlib.util.spec_from_file_location("emr_compose", ROOT / "scripts" / "emr-compose.py")
emr_compose = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(emr_compose)
INSTALLER_URL = "postgresql://postgres@127.0.0.1:5432/kin"
RUNTIME_URL = "postgresql://kin_runtime@127.0.0.1:5432/kin"
READER_URL = "postgresql://kin_emr_reader@127.0.0.1:5432/kin"
INSTANCE_ID = "production-image-synthetic-pair"
API_IPC = "/run/kin-emr-api"
RETENTION_IPC = "/run/kin-emr-retention"


class ProductionImageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        ops.require_local_docker()
        cls.image = json.loads(ops.text([
            "docker", "image", "inspect", os.environ.get("KIN_TEST_API_IMAGE", "kin-api:c1-candidate")
        ]))[0]
        cls.image_id = cls.image["Id"]
        cls.db = cls.container("db", [
            "--network", "none", "--tmpfs", "/var/lib/postgresql/data",
            "--tmpfs", "/var/lib/postgresql/emr-access:uid=70,gid=70,mode=0700",
            "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=kin",
            "postgres:16-alpine",
        ])
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if ops.run(["docker", "exec", cls.db, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"],
                       check=False).returncode == 0:
                break
            time.sleep(0.5)
        else:
            raise RuntimeError("Disposable PostgreSQL did not start")
        # Trust authentication in this networkless fixture; the provisioning still requires its secret input.
        ops.run(["docker", "exec", "-u", "postgres", cls.db, "mkdir", "-m", "700", "/var/lib/postgresql/emr-access/ts"])
        provisioned = subprocess.run(["docker", "exec", "-i", "-e", "KIN_EMR_RUNTIME_PASSWORD=" + uuid.uuid4().hex,
                                      "-e", "KIN_EMR_READER_PASSWORD=" + uuid.uuid4().hex, cls.db,
                                      "psql", "-X", "-U", "postgres", "-d", "kin"], input=emr_compose.PROVISION_SQL.encode(),
                                     capture_output=True, timeout=120)
        if provisioned.returncode:
            raise RuntimeError("EMR provisioning of the disposable database failed")
        # EMR-B2 (c): the protected-state resources of this disposable pair - created empty here, owned by the
        # state service alone once it starts (after the migration in test_02).
        cls.volumes = {}
        for suffix in ("state", "api-ipc", "retention-ipc"):
            token = uuid.uuid4().hex
            name = "kin-rehearsal-" + token[:16] + "-" + suffix
            cls.addClassCleanup(ops.remove_owned_if_present, "volume", name, token)
            ops.run(["docker", "volume", "create", "--label", "kin.ops.run=" + token, name])
            cls.volumes[suffix] = name
        cls.service = None
        print(json.dumps({"code_sha": ops.text(["git", "rev-parse", "HEAD"]),
                          "image_id": cls.image_id,
                          "revision": cls.image["Config"].get("Labels", {}).get("org.opencontainers.image.revision")}),
              flush=True)

    @classmethod
    def container(cls, suffix, arguments):
        token = uuid.uuid4().hex
        name = "kin-rehearsal-" + token[:16] + "-" + suffix
        # Register before create/start, so a Docker-client timeout cannot leak it.
        cls.addClassCleanup(ops.remove_owned_if_present, "container", name, token)
        ops.run(["docker", "create", "--name", name, "--label", "kin.ops.run=" + token, *arguments])
        ops.run(["docker", "start", name])
        return name

    @classmethod
    def start_service(cls):
        """EMR-B2 (c): the protected-state service of this pair in the same image - the only process with the state
        volume, the reader credential and both IPC volumes (UID 1000, groups 2001/2002). Started once, after the
        migration; ready when it prints its readiness marker."""
        if cls.service:
            return cls.service
        cls.service = cls.container("state-service", [
            "--network", "container:" + cls.db, "--user", "1000:1000", "--group-add", "2001", "--group-add", "2002",
            "--stop-timeout", "20",
            "-e", "DATABASE_URL=" + READER_URL, "-e", "KIN_EMR_STATE_DIR=" + ops.EMR_STATE,
            "-e", "KIN_EMR_INSTANCE_ID=" + INSTANCE_ID,
            "-e", "KIN_EMR_API_SOCKET=" + API_IPC + "/writer.sock",
            "-e", "KIN_EMR_RETENTION_SOCKET=" + RETENTION_IPC + "/writer.sock",
            "--mount", "type=volume,source=" + cls.volumes["state"] + ",target=" + ops.EMR_STATE,
            "--mount", "type=volume,source=" + cls.volumes["api-ipc"] + ",target=" + API_IPC,
            "--mount", "type=volume,source=" + cls.volumes["retention-ipc"] + ",target=" + RETENTION_IPC,
            "--entrypoint", "sh", cls.image_id, "/app/start-production.sh", "state-serve-v3"])
        deadline = time.monotonic() + 120
        while True:
            result = ops.run(["docker", "logs", cls.service])
            text = (result.stdout + result.stderr).decode("utf-8", errors="replace")
            if "EMR_STATE_READY" in text:
                return cls.service
            running = json.loads(ops.text(["docker", "inspect", cls.service]))[0]["State"]["Running"]
            if not running or time.monotonic() > deadline:
                raise RuntimeError("State service did not become ready: " + text[-1500:])
            time.sleep(0.5)

    def migrate(self, suffix, url=INSTALLER_URL):
        """The production image's one-shot migration mode with the installer credential; returns (exit, logs)."""
        name = self.container(suffix, ["--network", "container:" + self.db, "-e", "DATABASE_URL=" + url,
                                       self.image_id, "sh", "/app/start-production.sh", "migrate"])
        code = int(ops.text(["docker", "wait", name], timeout=180))
        return code, self.logs(name)

    def api(self, suffix, **overrides):
        env = {
            "DATABASE_URL": RUNTIME_URL,
            "DEPLOYMENT_MODE": "production", "AUTH_REQUIRED": "true",
            "KC_ISSUER": "http://127.0.0.1:1/auth/realms/kin",
            "KC_JWKS_URL": "http://127.0.0.1:1/certs", "KC_AUDIENCE": "kin-api",
            "KC_WEB_SECRET": "disposable-ci-only", "KIN_COOKIE_SECRET": uuid.uuid4().hex,
            "PUBLIC_ORIGIN": "http://127.0.0.1:3000",
            "ORTHANC_USER": "disposable-ci-only", "ORTHANC_PASS": uuid.uuid4().hex,
            "KC_ADMIN_URL": "http://127.0.0.1:1/auth", "KC_REALM": "kin",
            "KC_CLIENT_ID": "kin-api", "KC_CLIENT_SECRET": uuid.uuid4().hex,
            # EMR-B2 (c): a client of the state service; the deployed API has no state directory.
            "KIN_EMR_STATE_SOCKET": API_IPC + "/writer.sock", "KIN_EMR_INSTANCE_ID": INSTANCE_ID,
        }
        env.update(overrides)
        # The image's own user (1001:1001) plus the API client group of the IPC socket; the API IPC volume read-only.
        args = ["--network", "container:" + self.db, "--group-add", "2001",
                "--mount", "type=volume,source=" + self.volumes["api-ipc"] + ",target=" + API_IPC + ",readonly"]
        for key, value in env.items():
            args += ["-e", key + "=" + value]
        return self.container(suffix, [*args, self.image_id])

    def wait_running_api(self, name):
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            probe = ops.run(["docker", "exec", name, "node", "-e",
                "fetch('http://127.0.0.1:3000/api/health').then(async r=>{"
                "const h=await r.json();if(r.status!==200||!h.ok||!h.auth)process.exit(1)"
                "}).catch(()=>process.exit(1))"], check=False)
            if probe.returncode == 0:
                return
            if not json.loads(ops.text(["docker", "inspect", name]))[0]["State"]["Running"]:
                self.fail("Production API exited before ready: " + self.logs(name))
            time.sleep(0.5)
        self.fail("Production API readiness timed out")

    def psql(self, sql):
        return ops.text(["docker", "exec", self.db, "psql", "-X", "-U", "postgres", "-d", "kin",
                         "-v", "ON_ERROR_STOP=1", "-qAt", "-c", sql])

    def logs(self, name):
        result = ops.run(["docker", "logs", name])
        return (result.stdout + result.stderr).decode("utf-8", errors="replace")

    def stopped_with_error(self, name):
        code = int(ops.text(["docker", "wait", name], timeout=90))
        self.assertNotEqual(code, 0)
        logs = self.logs(name)
        self.assertNotIn("Nest application successfully started", logs)
        return logs

    def test_01_runtime_contains_compiled_code_without_build_tools(self):
        """TEST-C1-01: runtime packaging and non-root user are checked inside the image."""
        self.assertEqual(self.image["Config"]["User"], "1001:1001")
        self.assertIn("NODE_ENV=production", self.image["Config"]["Env"])
        self.assertEqual(self.image["Config"]["Cmd"], ["sh", "/app/start-production.sh", "serve"])
        expected = os.environ.get("KIN_EXPECTED_REVISION", "C1-working-tree")
        self.assertEqual(self.image["Config"]["Labels"]["org.opencontainers.image.revision"], expected)
        script = """
const fs=require('fs'), assert=require('assert');
assert.notStrictEqual(process.getuid(),0);
for(const p of ['dist/main.js','dist/emr-runtime/store.js','prisma/migrations/0_init/migration.sql',
  'prisma/migrations/20261008120000_emr_b/migration.sql', 'prisma/migrations/20261010120000_emr_seal_attempts/migration.sql', 'prisma/migrations/20261010150000_emr_read_jit_off/migration.sql', 'prisma/migrations/20261011120000_filter_shortcuts/migration.sql',
  'node_modules/prisma/build/index.js','node_modules/.prisma/client/index.js']) assert(fs.existsSync(p),p);
for(const p of ['src','node_modules/@nestjs/cli','node_modules/typescript']) assert(!fs.existsSync(p),p);
assert.strictEqual(require('@prisma/client/package.json').version,'5.22.0');
assert.strictEqual(require('prisma/package.json').version,'5.22.0');
assert(!fs.readFileSync('start-production.sh').includes(13));
// The API is a client even when it runs a former owner entry module. Only UID 1000 can open state.
const state=fs.statSync('/var/lib/kin-emr');
assert(state.isDirectory()); assert.strictEqual(state.uid,1000); assert.strictEqual(state.mode&0o777,0o700);
assert.strictEqual(process.getuid(),1001);
assert.throws(()=>fs.readdirSync('/var/lib/kin-emr'),e=>e.code==='EACCES');
assert.throws(()=>fs.writeFileSync('/var/lib/kin-emr/forbidden','x'),e=>e.code==='EACCES');
"""
        ops.temporary_run(["--network", "none", "--entrypoint", "node", self.image_id, "-e", script])

    def test_02_migrate_boot_restart_preserves_data_and_history(self):
        """TEST-C1-02/03: real Prisma engines, empty migration, auth guard and exec signal path.

        EMR-B1: the migration runs in the image's own `migrate` mode with the installer credential; the server then
        starts as the runtime role and never migrates."""
        code, logs = self.migrate("migrate")
        self.assertEqual(code, 0, logs[-2000:])
        # This image-only fixture has no realm server. Exercise the supported operator import with an empty realm
        # before boot; onModuleInit must see its real completion marker and never contact the unreachable provider.
        ops.run(["docker", "run", "--rm", "--network", "container:" + self.db,
                 "-e", "DATABASE_URL=" + INSTALLER_URL,
                 "--entrypoint", "node", self.image_id, "-e",
                 "const {PrismaService}=require('./dist/prisma.service');const db=new PrismaService();"
                 "require('./dist/member-rights-import').importMemberRights(db,{listUsers:async()=>({total:0,users:[]})})"
                 ".finally(()=>db.$disconnect()).catch(()=>process.exit(1));"])
        self.assertEqual(self.psql('SELECT id FROM "MemberRightsImport";'), "realm-v1")
        # EMR-B2 (c): the state service of this pair opens over the migrated database before any API client.
        self.start_service()
        name = self.api("healthy")
        # A failed migration assertion must not leave port3000 occupied for the drain test.
        self.addCleanup(ops.run, ["docker", "stop", "--time", "10", name])
        self.wait_running_api(name)
        # Heap order can change when Prisma marks a migration finished. Compare
        # the same ordered history before and after restart, independent of locale.
        history_query = 'SELECT migration_name,checksum,finished_at FROM "_prisma_migrations" ORDER BY migration_name COLLATE "C";'
        history = self.psql(history_query)
        self.assertTrue(history.startswith("0_init|"))
        self.assertEqual(sorted(line.split('|')[0] for line in history.splitlines()),
                         ['0_init', '20260907040000_viewer_history', '20260908020000_workspace_layout',
                          '20260908081500_connect_gate', '20260908120000_manual_sr',
                          '20260908180000_viewer_jobs', '20260908200000_manual_sr_recovery',
                          '20260909060000_saved_filter_organization', '20260909100000_tech_note_revision',
                           '20260909180000_worklist_columns', '20260909220000_favorite_workspace', '20260909233000_study_tags', '20260910000500_reader_assignment', '20260910013000_reading_preferences', '20260910023000_reading_appearance', '20260910044500_workspace_shortcuts', '20260910090000_filter_folders', '20260910100000_shared_filters', '20260910110000_study_consultation', '20260910123000_consultation_predicates', '20260910130000_study_access', '20260910133000_study_access_subject', '20260912100000_hanging_protocol_preferences', '20260917120000_findings', '20260920120000_report_citations', '20260921120000_report_structure', '20260924120000_order_accession', '20260924130000_gateway_receipt', '20260924140000_gateway_retry_request', '20260926120000_study_questions', '20260926130000_study_image_requests', '20260928120000_critical_result', '20260928130000_reader_assignment_scope', '20260930120000_audit_log_append_only', '20261004120000_draft_revision_session_entry',
                          '20261005120000_idp_session_end', '20261005130000_member_isolation',
                          '20261006000000_tech_note_attempt_id',
                          '20261006120000_member_isolation_call', '20261007120000_provider_change', '20261007170000_member_db_rights', '20261007200000_designation_subjects',
                          '20261008120000_emr_b', '20261010120000_emr_seal_attempts', '20261010150000_emr_read_jit_off', '20261011120000_filter_shortcuts'])
        self.psql("CREATE TABLE c1_probe(value text); INSERT INTO c1_probe VALUES ('preserved');")
        ops.run(["docker", "exec", name, "node", "-e",
            "fetch('http://127.0.0.1:3000/api/me').then(r=>{if(r.status!==401)process.exit(1)})"
            ".catch(()=>process.exit(1))"])
        self.assertEqual(ops.text(["docker", "exec", name, "node", "-e",
            "console.log(require('fs').readFileSync('/proc/1/cmdline').toString().split('\\0').filter(Boolean).join(' '))"]),
            "node dist/main.js")
        ops.run(["docker", "stop", "--time", "10", name])
        state = json.loads(ops.text(["docker", "inspect", name]))[0]["State"]
        self.assertFalse(state["Running"])
        self.assertNotEqual(state["ExitCode"], 137, "Shutdown needed SIGKILL")
        ops.run(["docker", "start", name])
        self.wait_running_api(name)
        # The API-only restart reconnected to the same running service; the service never restarted.
        self.assertTrue(json.loads(ops.text(["docker", "inspect", self.service]))[0]["State"]["Running"])
        self.assertEqual(ops.text(["docker", "inspect", "-f", "{{.RestartCount}}", self.service]), "0")
        self.assertEqual(self.psql(history_query), history)
        self.assertEqual(self.psql("SELECT value FROM c1_probe;"), "preserved")
        code, logs = self.migrate("migrate-again")
        self.assertEqual(code, 0)
        self.assertIn("No pending migrations to apply", logs)
        self.assertEqual(self.psql(history_query), history)

    def test_03_unreachable_database_prevents_api_start(self):
        """TEST-C1-02: a failed migration exits non-zero; a server whose database is unreachable never starts."""
        code, logs = self.migrate("bad-migrate", "postgresql://postgres@127.0.0.1:1/kin?connect_timeout=2")
        self.assertNotEqual(code, 0)
        self.assertIn("P1001", logs)
        name = self.api("bad-db", DATABASE_URL="postgresql://kin_runtime@127.0.0.1:1/kin?connect_timeout=2")
        self.stopped_with_error(name)

    def test_06_production_refuses_the_installer_credential(self):
        """EMR-B1 start boundary: in production the server opens only as the least-privilege runtime role."""
        name = self.api("installer", DATABASE_URL=INSTALLER_URL)
        logs = self.stopped_with_error(name)
        # EMR-B2 (c): the launcher prints one closed line - the phase and the refusal class, never the problems,
        # a connection string or provider text - and the role phase precedes any state-service session.
        self.assertIn("기동 실패(role/EmrRuntimeRefused)", logs)
        self.assertNotIn("postgresql://", logs)
        for problem in ("not-the-runtime-role", "rolsuper"):
            self.assertNotIn(problem, logs)
        # The refusal itself still names the installer's problems: the same compiled check, in the image, over the
        # same connection the API was handed.
        problems = ops.text(["docker", "run", "--rm", "--network", "container:" + self.db,
                             "-e", "DATABASE_URL=" + INSTALLER_URL, "--entrypoint", "node", self.image_id, "-e",
                             "const {PrismaService}=require('./dist/prisma.service');"
                             "const {verifyRuntimeConnection}=require('./dist/emr-runtime/manifest');const db=new PrismaService();"
                             "verifyRuntimeConnection(db).then(()=>{console.log('accepted');process.exitCode=1},"
                             "e=>{console.log(JSON.stringify(e.name==='EmrRuntimeRefused'?e.problems:['unexpected']))})"
                             ".finally(()=>db.$disconnect())"])
        problems = json.loads(problems.splitlines()[-1])
        for problem in ("not-the-runtime-role", "rolsuper"):
            self.assertIn(problem, problems)

    def test_04_production_refuses_disabled_auth(self):
        """TEST-C1-03: packaging must retain the production authentication guard."""
        name = self.api("no-auth", AUTH_REQUIRED="false")
        self.assertIn("AUTH_REQUIRED=true", self.stopped_with_error(name))

    def test_05_shutdown_finishes_an_active_database_request(self):
        """TEST-C1-02: the actual Prisma lifecycle provider must outlive HTTP draining."""
        self.psql("CREATE TABLE c1_drain(value integer);")
        # Test-only Nest controller, using the image's real compiled Prisma provider.
        # There is no test route or authentication exception in the product API.
        script = """
require('reflect-metadata');
const {NestFactory}=require('@nestjs/core'), c=require('@nestjs/common');
const {PrismaService}=require('./dist/prisma.service');
class Probe {
  constructor(db){this.db=db}
  async wait(){await this.db.$executeRawUnsafe('INSERT INTO c1_drain SELECT 1 FROM pg_sleep(3) /* C1_ACTIVE_WRITE */');return {ok:true}}
}
c.Controller()(Probe);
Reflect.defineMetadata('design:paramtypes',[PrismaService],Probe);
c.Get('wait')(Probe.prototype,'wait',Object.getOwnPropertyDescriptor(Probe.prototype,'wait'));
class ProbeModule{}
c.Module({controllers:[Probe],providers:[PrismaService]})(ProbeModule);
(async()=>{const app=await NestFactory.create(ProbeModule);app.enableShutdownHooks();await app.listen(3000,'0.0.0.0')})();
"""
        name = self.container("drain", ["--network", "container:" + self.db,
            "-e", "DATABASE_URL=postgresql://postgres@127.0.0.1:5432/kin",
            "--entrypoint", "node", self.image_id, "-e", script])
        deadline = time.monotonic() + 30
        while "Nest application successfully started" not in self.logs(name):
            if time.monotonic() >= deadline:
                self.fail("Test-only Nest lifecycle harness did not start")
            time.sleep(0.2)
        client = subprocess.Popen(["docker", "exec", self.db, "wget", "-qO-", "http://127.0.0.1:3000/wait"],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic() + 10
            while self.psql("SELECT count(*) FROM pg_stat_activity WHERE state='active' "
                            "AND query LIKE 'INSERT INTO c1_drain%';") != "1":
                if time.monotonic() >= deadline:
                    self.fail("Database write was not active before SIGTERM")
                time.sleep(0.1)
            ops.run(["docker", "stop", "--time", "10", name])
            body, errors = client.communicate(timeout=15)
            self.assertEqual(client.returncode, 0, errors.decode(errors="replace"))
            self.assertEqual(json.loads(body), {"ok": True})
            self.assertEqual(self.psql("SELECT value FROM c1_drain;"), "1")
            state = json.loads(ops.text(["docker", "inspect", name]))[0]["State"]
            self.assertNotEqual(state["ExitCode"], 137)
        finally:
            if client.poll() is None:
                client.kill()
                client.communicate(timeout=15)


def _hash_volume(image_id, volume):
    """sha256 of every file of a (stopped) state volume, read by a throwaway root container of the same image."""
    script = ("const fs=require('fs'),p=require('path'),c=require('crypto');const out={};"
              "(function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=p.join(d,e.name);"
              "if(e.isDirectory())walk(f);else if(e.isFile())out[p.relative('/state',f)]=c.createHash('sha256').update(fs.readFileSync(f)).digest('hex');}})('/state');"
              "process.stdout.write('KIN_RESULT '+JSON.stringify(out)+'\\n');")
    output = ops.text(["docker", "run", "--rm", "--network", "none", "--user", "0:0", "--read-only",
                       "--mount", "type=volume,source=" + volume + ",target=/state,readonly",
                       "--entrypoint", "node", image_id, "-e", script])
    line = [item for item in output.splitlines() if item.startswith("KIN_RESULT ")][-1]
    return json.loads(line[len("KIN_RESULT "):])


def _volume_entries(image_id, volume):
    """Every entry of a (stopped) volume with its type (file, directory, socket, other): the complete inventory a refused
    launch must leave unchanged, including owner registry files and IPC sockets."""
    script = ("const fs=require('fs'),p=require('path');const out=[];"
              "(function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=p.join(d,e.name);"
              "out.push([p.relative('/state',f),e.isDirectory()?'directory':e.isFile()?'file':e.isSocket()?'socket':'other']);"
              "if(e.isDirectory())walk(f);}})('/state');out.sort();"
              "process.stdout.write('KIN_RESULT '+JSON.stringify(out)+'\\n');")
    output = ops.text(["docker", "run", "--rm", "--network", "none", "--user", "0:0", "--read-only",
                       "--mount", "type=volume,source=" + volume + ",target=/state,readonly",
                       "--entrypoint", "node", image_id, "-e", script])
    line = [item for item in output.splitlines() if item.startswith("KIN_RESULT ")][-1]
    return json.loads(line[len("KIN_RESULT "):])


def _volume_archive(image_id, volume):
    """The volume's bytes as the tar.gz stream the legacy copy route's format gate reads (read-only)."""
    return ops.run(["docker", "run", "--rm", "--network", "none", "--user", "0:0", "--read-only",
                    "--mount", "type=volume,source=" + volume + ",target=/state,readonly",
                    "--entrypoint", "tar", image_id, "-czf", "-", "-C", "/state", "."]).stdout


class StateServiceCutpointTests(unittest.TestCase):
    """EMR-B2 (c) C-P01..C-P11 (the preserved P00..P12 mapping): the real API image in both roles over a disposable
    PostgreSQL. The suite tests/emr/b/startup_pg_test.cjs runs as the API user inside the image and drives the real
    API in child processes; this orchestrator owns the state service container (the same image, the service fixture
    entry of startup_fixture.cjs as UID 1000 over the state and IPC volumes) and answers the suite's control requests
    (start, stop, terminate, restart, volume hashes) from the bind-mounted control directory. Only owned synthetic
    containers are ever signalled; the PG backend a cut terminates is the request's own, reported by the API."""

    INSTANCE = "cutpoint-synthetic-pair"

    @classmethod
    def setUpClass(cls):
        ops.require_local_docker()
        cls.image = json.loads(ops.text(["docker", "image", "inspect", os.environ.get("KIN_TEST_API_IMAGE", "kin-api:c1-candidate")]))[0]
        cls.image_id = cls.image["Id"]
        cls.stamp = time.strftime("%Y%m%d-%H%M%S")
        cls.evidence = ROOT / "tmp" / "emr-b2-c-14" / ("pg-" + cls.stamp)
        cls.control = cls.evidence / "control"
        cls.control.mkdir(parents=True)
        cls.db = cls.container("db", ["--network", "none", "--tmpfs", "/var/lib/postgresql/data",
                                      "--tmpfs", "/var/lib/postgresql/emr-access:uid=70,gid=70,mode=0700",
                                      "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=kin", "postgres:16-alpine"])
        deadline = time.monotonic() + 60
        while ops.run(["docker", "exec", cls.db, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"], check=False).returncode:
            if time.monotonic() > deadline:
                raise RuntimeError("Disposable PostgreSQL did not start")
            time.sleep(0.5)
        ops.run(["docker", "exec", "-u", "postgres", cls.db, "mkdir", "-m", "700", "/var/lib/postgresql/emr-access/ts"])
        provisioned = subprocess.run(["docker", "exec", "-i", "-e", "KIN_EMR_RUNTIME_PASSWORD=" + uuid.uuid4().hex,
                                      "-e", "KIN_EMR_READER_PASSWORD=" + uuid.uuid4().hex, cls.db, "psql", "-X", "-U", "postgres", "-d", "kin"],
                                     input=emr_compose.PROVISION_SQL.encode(), capture_output=True, timeout=120)
        if provisioned.returncode:
            raise RuntimeError("EMR provisioning of the disposable database failed")
        migrated = subprocess.run(["docker", "run", "--rm", "--network", "container:" + cls.db, "-e", "DATABASE_URL=" + INSTALLER_URL,
                                   cls.image_id, "sh", "/app/start-production.sh", "migrate"], capture_output=True, timeout=300)
        if migrated.returncode:
            raise RuntimeError("Migration failed: " + migrated.stdout.decode(errors="replace")[-800:])
        cls.volumes = {}
        for suffix in ("state", "api-ipc", "retention-ipc"):
            token = uuid.uuid4().hex
            name = "kin-rehearsal-" + token[:16] + "-" + suffix
            cls.addClassCleanup(ops.remove_owned_if_present, "volume", name, token)
            ops.run(["docker", "volume", "create", "--label", "kin.ops.run=" + token, name])
            cls.volumes[suffix] = name
        cls.service = None
        cls.services = []
        print(json.dumps({"code_sha": ops.text(["git", "rev-parse", "HEAD"]), "image_id": cls.image_id, "evidence": str(cls.evidence)}), flush=True)

    @classmethod
    def container(cls, suffix, arguments):
        token = uuid.uuid4().hex
        name = "kin-rehearsal-" + token[:16] + "-" + suffix
        cls.addClassCleanup(ops.remove_owned_if_present, "container", name, token)
        ops.run(["docker", "create", "--name", name, "--label", "kin.ops.run=" + token, *arguments])
        ops.run(["docker", "start", name])
        return name

    @classmethod
    def logs(cls, name):
        result = ops.run(["docker", "logs", name])
        return (result.stdout + result.stderr).decode("utf-8", errors="replace")

    @classmethod
    def running(cls, name):
        return json.loads(ops.text(["docker", "inspect", name]))[0]["State"]["Running"]

    def service_start(self, label, scenario, *, instance_id=None, database_port=None, wait_for=None, extra=False):
        """The real state-serve-v3 entry (launchStateService) with its seal observed by the service fixture."""
        url = READER_URL if database_port is None else READER_URL.replace(":5432/", ":" + str(database_port) + "/") + "?connect_timeout=2"
        name = self.container("state-" + label, [
            "--network", "container:" + self.db, "--user", "1000:1000", "--group-add", "2001", "--group-add", "2002",
            "--stop-timeout", "20",
            "-e", "DATABASE_URL=" + url, "-e", "KIN_EMR_STATE_DIR=" + ops.EMR_STATE,
            "-e", "KIN_EMR_INSTANCE_ID=" + (instance_id or self.INSTANCE),
            "-e", "KIN_EMR_API_SOCKET=" + API_IPC + "/writer.sock", "-e", "KIN_EMR_RETENTION_SOCKET=" + RETENTION_IPC + "/writer.sock",
            "-e", "KIN_EMR_B2_SERVICE_EVENTS=/control/service-events.jsonl", "-e", "NODE_OPTIONS=--max-old-space-size=3072",
            "--mount", "type=volume,source=" + self.volumes["state"] + ",target=" + ops.EMR_STATE,
            "--mount", "type=volume,source=" + self.volumes["api-ipc"] + ",target=" + API_IPC,
            "--mount", "type=volume,source=" + self.volumes["retention-ipc"] + ",target=" + RETENTION_IPC,
            "--mount", "type=bind,source=" + str(ROOT / "tests" / "emr" / "b") + ",target=/emr-b,readonly",
            "--mount", "type=bind,source=" + str(self.control) + ",target=/control",
            "--entrypoint", "node", self.image_id, "/emr-b/startup_fixture.cjs", "--service", json.dumps(scenario)])
        self.services.append({"label": label, "name": name, "scenario": scenario})
        deadline = time.monotonic() + 120
        while True:
            text = self.logs(name)
            if "EMR_STATE_READY" in text:
                if not extra:
                    self.service = name
                return {"ready": True, "name": name, "tail": text[-400:]}
            if wait_for and self._service_event(label, wait_for):
                # A start held inside its recovery is the owner of the pair until it ends: it is what a later
                # stop/terminate request acts on.
                if not extra:
                    self.service = name
                return {"ready": None, "held": wait_for, "name": name}
            if not self.running(name):
                code = int(ops.text(["docker", "wait", name], timeout=60))
                return {"ready": False, "exit": code, "name": name, "tail": text[-600:]}
            if time.monotonic() > deadline:
                return {"ready": False, "exit": None, "name": name, "tail": "timeout: " + text[-600:]}
            time.sleep(0.3)

    def _service_event(self, label, what):
        file = self.control / "service-events.jsonl"
        if not file.exists():
            return False
        for line in file.read_text(encoding="utf-8").splitlines():
            if line.strip():
                event = json.loads(line)
                if event.get("label") == label and event.get("what") == what:
                    return True
        return False

    def service_stop(self, signal="TERM", name=None):
        name = name or self.service
        if not name:
            return {"stopped": None}
        if self.running(name):
            if signal == "KILL":
                ops.run(["docker", "kill", "--signal", "KILL", name])
            else:
                ops.run(["docker", "stop", "--time", "20", name], timeout=120)
        code = int(ops.text(["docker", "wait", name], timeout=120))
        text = self.logs(name)
        if name == self.service:
            self.service = None
        return {"stopped": name, "signal": signal, "exit": code, "tail": text[-400:],
                "closed": text.rstrip().endswith("EMR_STATE_CLOSED")}

    def serve(self, request):
        action = request["action"]
        scenario = {**(request.get("scenario") or {}), "label": request.get("label")}
        if action == "service-start":
            return self.service_start(request["label"], scenario, instance_id=request.get("instanceId"),
                                      database_port=request.get("databasePort"), wait_for=request.get("waitFor"), extra=request.get("extra", False))
        if action == "service-stop":
            return self.service_stop(request.get("signal", "TERM"))
        if action == "service-restart":
            stopped = self.service_stop("TERM")
            return {"restarted": stopped, **self.service_start(request["label"], scenario)}
        if action == "service-wait":
            return {"running": bool(self.service) and self.running(self.service)}
        if action == "volume-hashes":
            if self.service and self.running(self.service):
                return {"error": "service running"}
            return {"hashes": _hash_volume(self.image_id, self.volumes["state"])}
        return {"error": "unknown action " + action}

    def test_01_cutpoints_over_the_real_service_and_database(self):
        env = {"KIN_EMR_B2_RUNTIME_URL": RUNTIME_URL, "KIN_EMR_B2_INSTALLER_URL": INSTALLER_URL,
               "KIN_EMR_STATE_SOCKET": API_IPC + "/writer.sock", "KIN_EMR_INSTANCE_ID": self.INSTANCE,
               "KIN_EMR_B2_CONTROL": "/control", "KIN_EMR_B2_KEEP_RUNS": "1", "NODE_OPTIONS": "--max-old-space-size=3072"}
        args = ["--network", "container:" + self.db, "--user", "1001:1001", "--group-add", "2001",
                "--mount", "type=volume,source=" + self.volumes["api-ipc"] + ",target=" + API_IPC + ",readonly",
                "--mount", "type=bind,source=" + str(ROOT / "tests" / "emr" / "b") + ",target=/emr-b,readonly",
                "--mount", "type=bind,source=" + str(self.control) + ",target=/control"]
        for key, value in env.items():
            args += ["-e", key + "=" + value]
        suite = self.container("pg-suite", [*args, "--entrypoint", "node", self.image_id, "--test", "--test-concurrency=1", "/emr-b/startup_pg_test.cjs"])
        answered = set()
        deadline = time.monotonic() + 3600
        while True:
            for file in sorted(self.control.glob("req-*.json")):
                if file.name in answered:
                    continue
                request = json.loads(file.read_text(encoding="utf-8"))
                try:
                    reply = self.serve(request)
                except Exception as error:  # the suite judges; the orchestrator reports
                    reply = {"error": type(error).__name__ + ": " + str(error)[:500]}
                target = self.control / ("res-" + request["id"] + ".json")
                temporary = target.with_suffix(".tmp")
                temporary.write_text(json.dumps(reply), encoding="utf-8")
                temporary.replace(target)
                answered.add(file.name)
            if not self.running(suite):
                break
            if time.monotonic() > deadline:
                ops.run(["docker", "kill", suite], check=False)
                self.fail("the cutpoint suite exceeded its wall budget")
            time.sleep(0.2)
        code = int(ops.text(["docker", "wait", suite], timeout=60))
        logs = self.logs(suite)
        (self.evidence / "suite.log").write_text(logs, encoding="utf-8")
        for item in self.services:
            (self.evidence / ("service-" + item["label"] + ".log")).write_text(self.logs(item["name"]), encoding="utf-8")
        cells = [json.loads(line[len("B2C_PG_EVIDENCE "):]) for line in logs.splitlines() if line.startswith("B2C_PG_EVIDENCE ")]
        summary = {"exit": code, "cells": [cell["cell"] for cell in cells], "services": [item["label"] for item in self.services],
                   "pass": next((line for line in logs.splitlines() if line.startswith("# pass ")), None),
                   "fail": next((line for line in logs.splitlines() if line.startswith("# fail ")), None)}
        print(json.dumps({"b2c_pg_cutpoints": summary}), flush=True)
        self.assertEqual(code, 0, logs[-6000:])
        self.assertEqual(summary["fail"], "# fail 0", logs[-6000:])


class LegacyImageTests(unittest.TestCase):
    """A03 old-reader cells against reconstructed legacy images (D1656-T01/T02/T05 and the pre-EMR start path).

    KIN_TEST_LEGACY_B1_IMAGE: the image rebuilt from the fixed B1 source (a86ecf1; v1+v2 reader, former API owner).
    KIN_TEST_LEGACY_PRE_EMR_IMAGE: the image rebuilt from the pre-EMR source (b9690cc; migrate-then-serve, no reader).
    Both are reconstructed artifacts: their digests authenticate the reconstruction only, never the historic deployed
    image (that provenance is RO-01/RO-02, commander-owned). The v3 pair is a fresh disposable one written by the real
    current service; every legacy start runs against a private clone of that state volume and must change no byte."""

    INSTANCE = "legacy-synthetic-pair"

    @classmethod
    def setUpClass(cls):
        if not os.environ.get("KIN_TEST_LEGACY_B1_IMAGE"):
            raise unittest.SkipTest("KIN_TEST_LEGACY_B1_IMAGE not given")
        ops.require_local_docker()
        cls.image_id = json.loads(ops.text(["docker", "image", "inspect", os.environ["KIN_TEST_API_IMAGE"]]))[0]["Id"]
        cls.legacy = json.loads(ops.text(["docker", "image", "inspect", os.environ["KIN_TEST_LEGACY_B1_IMAGE"]]))[0]
        pre = os.environ.get("KIN_TEST_LEGACY_PRE_EMR_IMAGE")
        cls.pre_emr = json.loads(ops.text(["docker", "image", "inspect", pre]))[0] if pre else None
        # Compose binds images by reference; the consumers compare the resolved immutable IDs.
        cls.tags = {cls.image_id: os.environ["KIN_TEST_API_IMAGE"], cls.legacy["Id"]: os.environ["KIN_TEST_LEGACY_B1_IMAGE"]}
        if pre:
            cls.tags[cls.pre_emr["Id"]] = pre
        cls.db = cls.container("db", [
            "--network", "none", "--tmpfs", "/var/lib/postgresql/data",
            "--tmpfs", "/var/lib/postgresql/emr-access:uid=70,gid=70,mode=0700",
            "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=kin", "postgres:16-alpine"])
        deadline = time.monotonic() + 60
        while ops.run(["docker", "exec", cls.db, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"], check=False).returncode:
            if time.monotonic() > deadline:
                raise RuntimeError("Disposable PostgreSQL did not start")
            time.sleep(0.5)
        ops.run(["docker", "exec", "-u", "postgres", cls.db, "mkdir", "-m", "700", "/var/lib/postgresql/emr-access/ts"])
        provisioned = subprocess.run(["docker", "exec", "-i", "-e", "KIN_EMR_RUNTIME_PASSWORD=" + uuid.uuid4().hex,
                                      "-e", "KIN_EMR_READER_PASSWORD=" + uuid.uuid4().hex, cls.db, "psql", "-X", "-U", "postgres", "-d", "kin"],
                                     input=emr_compose.PROVISION_SQL.encode(), capture_output=True, timeout=120)
        if provisioned.returncode:
            raise RuntimeError("EMR provisioning of the disposable database failed")
        migrated = subprocess.run(["docker", "run", "--rm", "--network", "container:" + cls.db, "-e", "DATABASE_URL=" + INSTALLER_URL,
                                   cls.image_id, "sh", "/app/start-production.sh", "migrate"], capture_output=True, timeout=300)
        if migrated.returncode:
            raise RuntimeError("Migration failed: " + migrated.stdout.decode(errors="replace")[-800:])
        cls.volumes = {}
        for suffix in ("state", "api-ipc", "retention-ipc", "clone"):
            token = uuid.uuid4().hex
            name = "kin-rehearsal-" + token[:16] + "-" + suffix
            cls.addClassCleanup(ops.remove_owned_if_present, "volume", name, token)
            ops.run(["docker", "volume", "create", "--label", "kin.ops.run=" + token, name])
            cls.volumes[suffix] = name
        # The v3 pair: the current service recovers the fresh pair, one client appends one synthetic event, the service closes.
        service = cls.container("state-service", [
            "--network", "container:" + cls.db, "--user", "1000:1000", "--group-add", "2001", "--group-add", "2002", "--stop-timeout", "20",
            "-e", "DATABASE_URL=" + READER_URL, "-e", "KIN_EMR_STATE_DIR=" + ops.EMR_STATE, "-e", "KIN_EMR_INSTANCE_ID=" + cls.INSTANCE,
            "-e", "KIN_EMR_API_SOCKET=" + API_IPC + "/writer.sock", "-e", "KIN_EMR_RETENTION_SOCKET=" + RETENTION_IPC + "/writer.sock",
            "--mount", "type=volume,source=" + cls.volumes["state"] + ",target=" + ops.EMR_STATE,
            "--mount", "type=volume,source=" + cls.volumes["api-ipc"] + ",target=" + API_IPC,
            "--mount", "type=volume,source=" + cls.volumes["retention-ipc"] + ",target=" + RETENTION_IPC,
            "--entrypoint", "sh", cls.image_id, "/app/start-production.sh", "state-serve-v3"])
        ops.wait_state_service(service, 0, timeout=120)
        import ops_emr_probe as probe
        event = probe.probe_event({"study": "SYNTHETIC-legacy-cells", "event_id": str(uuid.uuid4()), "institution": "synthetic-institution"})
        appended = subprocess.run(["docker", "run", "--rm", "--network", "container:" + cls.db, "--user", "1001:1001", "--group-add", "2001", "--read-only",
                                   "-e", "DATABASE_URL=" + RUNTIME_URL, "-e", "KIN_EMR_INSTANCE_ID=" + cls.INSTANCE, "-e", "KIN_EMR_STATE_SOCKET=" + API_IPC + "/writer.sock",
                                   "--mount", "type=volume,source=" + cls.volumes["api-ipc"] + ",target=" + API_IPC + ",readonly",
                                   "--entrypoint", "node", cls.image_id, "-e", probe.PROBE_SCRIPT, "append", json.dumps({"event": event})],
                                  capture_output=True, timeout=180)
        if appended.returncode:
            raise RuntimeError("Synthetic append failed: " + appended.stdout.decode(errors="replace")[-800:] + appended.stderr.decode(errors="replace")[-800:])
        ops.run(["docker", "stop", "--time", "20", service], timeout=120)
        ops.state_service_closed(service)
        cls.pair_hashes = _hash_volume(cls.image_id, cls.volumes["state"])
        cls.counts = cls.psql("SELECT count(*) FROM emr_access.access_entry") + "/" + cls.psql("SELECT count(*) FROM emr_access.commit_marker")
        print(json.dumps({"legacy_images": {"b1": {"id": cls.legacy["Id"], "labels": cls.legacy["Config"].get("Labels"), "reconstructed": True},
                                            "pre_emr": cls.pre_emr and {"id": cls.pre_emr["Id"], "labels": cls.pre_emr["Config"].get("Labels"), "reconstructed": True}},
                          "pair_files": sorted(cls.pair_hashes)}), flush=True)

    @classmethod
    def container(cls, suffix, arguments):
        token = uuid.uuid4().hex
        name = "kin-rehearsal-" + token[:16] + "-" + suffix
        cls.addClassCleanup(ops.remove_owned_if_present, "container", name, token)
        ops.run(["docker", "create", "--name", name, "--label", "kin.ops.run=" + token, *arguments])
        ops.run(["docker", "start", name])
        return name

    @classmethod
    def psql(cls, sql):
        return ops.text(["docker", "exec", cls.db, "psql", "-X", "-U", "postgres", "-d", "kin", "-v", "ON_ERROR_STOP=1", "-qAt", "-c", sql])

    @staticmethod
    def changed(before, after):
        return sorted({name for name in set(before) | set(after) if before.get(name) != after.get(name)})

    def clone(self, source=None, target=None):
        """A private clone of a state volume (by default the v3 pair volume, which itself is never mounted by any cell)."""
        source, target = source or self.volumes["state"], target or self.volumes["clone"]
        ops.run(["docker", "run", "--rm", "--network", "none", "--user", "0:0",
                 "--mount", "type=volume,source=" + source + ",target=/source,readonly",
                 "--mount", "type=volume,source=" + target + ",target=/clone",
                 "--entrypoint", "sh", self.image_id, "-c", "rm -rf /clone/* /clone/.[!.]* 2>/dev/null; cp -a /source/. /clone/ && chown -R 1000:1000 /clone"])
        return target

    def legacy_run(self, image, suffix, arguments, timeout=120):
        """A legacy container started and observed for at most `timeout` seconds: (exit code or None if still running
        - then stopped -, logs, docker inspect). Nothing is inferred from a hang; the logs are the evidence."""
        token = uuid.uuid4().hex
        name = "kin-rehearsal-" + token[:16] + "-" + suffix
        self.addCleanup(ops.remove_owned_if_present, "container", name, token)
        ops.run(["docker", "create", "--name", name, "--label", "kin.ops.run=" + token, *arguments, image])
        ops.run(["docker", "start", name])
        deadline = time.monotonic() + timeout
        code = None
        while time.monotonic() < deadline:
            state = json.loads(ops.text(["docker", "inspect", name]))[0]["State"]
            if not state["Running"]:
                code = state["ExitCode"]
                break
            time.sleep(1)
        inspected = json.loads(ops.text(["docker", "inspect", name]))[0]
        result = ops.run(["docker", "logs", name])
        logs = (result.stdout + result.stderr).decode("utf-8", errors="replace")
        if code is None:
            ops.run(["docker", "stop", "--time", "10", name], check=False, timeout=60)
        self.legacy_inspect = inspected
        return code, logs

    # ----- the supported launch boundary (D1684 item 7 / F-A03-01, F-A03-02) -------------------------------------------
    # The acceptance cells exercise the actual launch consumers (ops_emr_introduction.state_start_admission ->
    # ops_deploy_preflight.check_state_service + check_state_owners; ops_backup.admit_legacy_archive ->
    # check_legacy_restore_format) over containers Docker Compose created in the real emr-state launch shape and never
    # started: the refusal binds to the immutable image identity before incompatible code gets writable execution, and
    # the complete inventory (every file of the pair volume, the IPC volumes' entries, the ledger rows, the container's
    # own state) is compared before/after. Historical-behaviour diagnostics (test_06/test_07) are retained as
    # counterexamples, not as reject-before-mutation acceptance.

    def compose_create(self, suffix, image_id, state_volume, *, restart="no", command=("state-serve-v3",)):
        """The emr-state launch shape of docker-compose.yml, created by Docker Compose and never started here: the
        two-token entrypoint + command the launch admission binds (a CLI --entrypoint cannot express it), UID 1000 with
        the IPC groups, three RW volumes, the compose role label, the reader credential and the instance pair."""
        import shutil
        import tempfile
        token = uuid.uuid4().hex
        name = "kin-rehearsal-" + token[:16] + "-" + suffix
        project = "kinrehearsal" + token[:12]
        folder = Path(tempfile.mkdtemp(prefix="kin-legacy-shape-"))
        self.addCleanup(shutil.rmtree, folder, True)
        self.addCleanup(ops.run, ["docker", "network", "rm", project + "_default"], check=False)
        self.addCleanup(ops.remove_owned_if_present, "container", name, token)
        service = {"image": self.tags.get(image_id, image_id), "container_name": name, "user": "1000:1000", "group_add": ["2001", "2002"],
                   "entrypoint": ["sh", "/app/start-production.sh"], "command": list(command), "restart": restart,
                   "stop_grace_period": "20s", "network_mode": "container:" + self.db, "labels": {"kin.ops.run": token},
                   "environment": {"DATABASE_URL": READER_URL, "KIN_EMR_STATE_DIR": ops.EMR_STATE, "KIN_EMR_INSTANCE_ID": self.INSTANCE,
                                   "KIN_EMR_API_SOCKET": API_IPC + "/writer.sock", "KIN_EMR_RETENTION_SOCKET": RETENTION_IPC + "/writer.sock"},
                   "volumes": [state_volume + ":" + ops.EMR_STATE, self.volumes["api-ipc"] + ":" + API_IPC,
                               self.volumes["retention-ipc"] + ":" + RETENTION_IPC]}
        spec = {"services": {"emr-state": service},
                "volumes": {state_volume: {"external": True}, self.volumes["api-ipc"]: {"external": True}, self.volumes["retention-ipc"]: {"external": True}}}
        (folder / "compose.yaml").write_text(json.dumps(spec), encoding="utf-8")
        ops.run(["docker", "compose", "--project-directory", str(folder), "--project-name", project, "-f", str(folder / "compose.yaml"),
                 "create", "--no-build", "--pull", "never", "emr-state"], timeout=180)
        return name

    def admission(self, name, *, existing=False):
        """The launch consumer's checks over a created container, exactly as state_start_admission applies them: the
        reviewed release (this checkout's HEAD, this candidate image) and the inventory of every container holding the
        same state volume. Raises RuntimeError with the consumer's refusal; returns the observation on admission."""
        import ops_deploy_preflight as preflight
        container = json.loads(ops.text(["docker", "inspect", name]))[0]
        release = {"sha": ops.text(["git", "rev-parse", "HEAD"]), "images": {"api": self.image_id}}
        reviewed = json.loads(ops.text(["docker", "image", "inspect", self.image_id]))[0]
        state_volume = next(m["Name"] for m in container["Mounts"] if m.get("Destination") == ops.EMR_STATE)
        preflight.check_state_service(container, release=release, image=reviewed, state_volume=state_volume,
                                      api_ipc_volume=self.volumes["api-ipc"], retention_ipc_volume=self.volumes["retention-ipc"],
                                      instance_id=self.INSTANCE, database_host="127.0.0.1")
        names = ops.text(["docker", "container", "ls", "--all", "--filter", "volume=" + state_volume, "--format", "{{.Names}}"]).splitlines()
        owners = [json.loads(ops.text(["docker", "inspect", item]))[0] for item in names if item]
        preflight.check_state_owners(owners, state_volume, name if existing else "")
        return container

    def inventory(self, state_volume):
        """Everything the boundary must leave unchanged: every file's digest and every entry (files, directories,
        sockets) of the state volume and of both IPC volumes, and the ledger row counts."""
        return {"state_files": _hash_volume(self.image_id, state_volume), "state_entries": _volume_entries(self.image_id, state_volume),
                "api_ipc": _volume_entries(self.image_id, self.volumes["api-ipc"]),
                "retention_ipc": _volume_entries(self.image_id, self.volumes["retention-ipc"]),
                "ledger": self.psql("SELECT count(*) FROM emr_access.access_entry") + "/" + self.psql("SELECT count(*) FROM emr_access.commit_marker")}

    def never_started(self, name):
        state = json.loads(ops.text(["docker", "inspect", name]))[0]["State"]
        self.assertEqual((state.get("Status"), state.get("Running"), state.get("StartedAt")), ("created", False, "0001-01-01T00:00:00Z"),
                         "the refused container must never have executed: " + json.dumps(state))
        return state

    def refused_before_execution(self, label, image, cell):
        clone = self.clone()
        before = self.inventory(clone)
        self.assertEqual(before["state_files"], self.pair_hashes, "the private clone starts byte-identical to the v3 pair")
        name = self.compose_create(label, image["Id"], clone)
        with self.assertRaises(RuntimeError) as refused:
            self.admission(name)
        self.assertEqual(str(refused.exception), "State service image differs from the reviewed artifact",
                         "the supported launch refuses the former image by its immutable identity, before any other difference")
        state = self.never_started(name)
        after = self.inventory(clone)
        self.assertEqual(after, before, "a refused launch changes nothing: no file, no owner registry, no socket, no ledger row")
        # Recreate under the same shape with the reviewed image: the same consumer admits it (the sibling is started in test_03).
        ops.run(["docker", "rm", name])
        sibling = self.compose_create(label + "-recreated", self.image_id, clone)
        self.admission(sibling)
        self.never_started(sibling)
        self.assertEqual(self.inventory(clone), before)
        print(json.dumps({cell: {"image": image["Id"], "labels": image["Config"].get("Labels"), "reconstructed": True,
                                 "refusal": str(refused.exception), "container_state": state, "recreated_reviewed_sibling_admitted": True}}), flush=True)

    def test_01_supported_launch_refuses_the_former_owner_image_before_execution(self):
        """D1656-T01 (acceptance): the former API owner (v1+v2 reader) in the exact emr-state launch shape over a private
        v3 clone is refused by the launch consumer before it executes; the complete inventory is unchanged."""
        self.refused_before_execution("legacy-owner", self.legacy, "D1656-T01")

    def test_02_supported_launch_refuses_the_pre_emr_image_before_execution(self):
        """D1656-T02 (acceptance): the pre-EMR image, whose start script ignores its argument (it would migrate and
        serve), is refused by the same identity binding before execution; `state-serve-v3` is not its protection."""
        if not self.pre_emr:
            self.skipTest("KIN_TEST_LEGACY_PRE_EMR_IMAGE not given")
        text = ops.text(["docker", "run", "--rm", "--network", "none", "--entrypoint", "cat", self.pre_emr["Id"], "/app/start-production.sh"])
        self.assertNotIn("state-serve-v3", text)
        self.assertNotIn('case "${1', text)
        self.refused_before_execution("pre-emr-owner", self.pre_emr, "D1656-T02-launch")

    def test_03_supported_launch_admits_the_reviewed_image_which_serves_and_resumes(self):
        """The positive reviewed-v3 sibling: the same consumer admits the reviewed image in the same shape; started, it
        recovers the clone and serves (EMR_STATE_READY), closes completely, and is admitted again for resume as the
        existing stopped owner - unless a restart policy would revive it outside launch admission."""
        clone = self.clone()
        before = self.inventory(clone)
        name = self.compose_create("reviewed-owner", self.image_id, clone)
        admitted = self.admission(name)
        self.never_started(name)
        self.assertEqual(self.inventory(clone), before, "admission itself changes nothing")
        ops.run(["docker", "start", name])
        ops.wait_state_service(name, 0, timeout=120)
        ops.run(["docker", "stop", "--time", "20", name], timeout=120)
        ops.state_service_closed(name)
        after = self.inventory(clone)
        self.assertEqual(_hash_volume(self.image_id, self.volumes["state"]), self.pair_hashes, "the source pair volume is never mounted")
        self.assertEqual(after["ledger"], before["ledger"], "recovery of an already sealed pair appends no ledger row")
        changed = sorted(set(before["state_files"]) ^ set(after["state_files"]) |
                         {item for item in before["state_files"] if before["state_files"][item] != after["state_files"].get(item)})
        self.assertTrue(all(item.startswith("seal/") or item.startswith("journal/") for item in changed),
                        "the reviewed service writes only its own pair files: " + json.dumps(changed))
        # Resume of the existing stopped owner: admitted; a restart policy that could revive it outside admission: refused.
        self.admission(name, existing=True)
        ops.run(["docker", "update", "--restart", "always", name])
        with self.assertRaises(RuntimeError) as restartable:
            self.admission(name, existing=True)
        self.assertEqual(str(restartable.exception), "State owner restart must pass launch admission")
        ops.run(["docker", "update", "--restart", "no", name])
        self.admission(name, existing=True)
        print(json.dumps({"D1656-reviewed-sibling": {"image": self.image_id, "admitted_entry": [admitted["Path"], *admitted["Args"]],
                                                     "served": True, "files_written_by_recovery": changed}}), flush=True)

    def test_04_stale_owner_inventory_refuses_restartable_or_running_owners_until_quiesced(self):
        """A retained old container of the same state volume (the former image, created with a restart policy; or any
        running holder) keeps the new reviewed owner out of launch admission until it is quiesced (stopped, restart
        policy `no`); then the reviewed owner is admitted. Nothing is started from the former image at any point."""
        clone = self.clone()
        before = self.inventory(clone)
        stale = self.compose_create("stale-legacy", self.legacy["Id"], clone, restart="always")
        fresh = self.compose_create("fresh-reviewed", self.image_id, clone)
        with self.assertRaises(RuntimeError) as held:
            self.admission(fresh)
        self.assertEqual(str(held.exception), "A legacy state owner is running or eligible for restart")
        ops.run(["docker", "update", "--restart", "no", stale])
        self.admission(fresh)
        # A running holder of the volume (a sleeper of the reviewed image; it executes nothing of the pair).
        token = uuid.uuid4().hex
        sleeper = "kin-rehearsal-" + token[:16] + "-holder"
        self.addCleanup(ops.remove_owned_if_present, "container", sleeper, token)
        ops.run(["docker", "run", "-d", "--name", sleeper, "--label", "kin.ops.run=" + token, "--network", "none", "--user", "1000:1000",
                 "--mount", "type=volume,source=" + clone + ",target=" + ops.EMR_STATE, "--entrypoint", "sleep", self.image_id, "300"])
        with self.assertRaises(RuntimeError) as running:
            self.admission(fresh)
        self.assertEqual(str(running.exception), "A legacy state owner is running or eligible for restart")
        ops.run(["docker", "stop", "--time", "5", sleeper], timeout=60)
        self.admission(fresh)
        self.never_started(stale)
        self.never_started(fresh)
        self.assertEqual(self.inventory(clone), before, "owner-inventory refusals and quiescing change nothing")
        print(json.dumps({"D1656-stale-owner": {"held": str(held.exception), "running_holder": str(running.exception), "admitted_after_quiesce": True}}), flush=True)

    @classmethod
    def legacy_database(cls):
        """A second disposable database for the original-format control: the former image migrates it itself, so its
        recovery entry can initialize and re-admit its own (v1/v2) pair without the v3 pair's chains."""
        if getattr(cls, "legacy_db", None):
            return cls.legacy_db
        cls.legacy_db = cls.container("legacy-db", [
            "--network", "none", "--tmpfs", "/var/lib/postgresql/data",
            "--tmpfs", "/var/lib/postgresql/emr-access:uid=70,gid=70,mode=0700",
            "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=kin", "postgres:16-alpine"])
        deadline = time.monotonic() + 60
        while ops.run(["docker", "exec", cls.legacy_db, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"], check=False).returncode:
            if time.monotonic() > deadline:
                raise RuntimeError("Disposable PostgreSQL (legacy) did not start")
            time.sleep(0.5)
        ops.run(["docker", "exec", "-u", "postgres", cls.legacy_db, "mkdir", "-m", "700", "/var/lib/postgresql/emr-access/ts"])
        provisioned = subprocess.run(["docker", "exec", "-i", "-e", "KIN_EMR_RUNTIME_PASSWORD=" + uuid.uuid4().hex,
                                      "-e", "KIN_EMR_READER_PASSWORD=" + uuid.uuid4().hex, cls.legacy_db, "psql", "-X", "-U", "postgres", "-d", "kin"],
                                     input=emr_compose.PROVISION_SQL.encode(), capture_output=True, timeout=120)
        if provisioned.returncode:
            raise RuntimeError("EMR provisioning of the legacy disposable database failed")
        migrated = subprocess.run(["docker", "run", "--rm", "--network", "container:" + cls.legacy_db, "-e", "DATABASE_URL=" + INSTALLER_URL,
                                   "--entrypoint", "sh", cls.legacy["Id"], "/app/start-production.sh", "migrate"], capture_output=True, timeout=300)
        if migrated.returncode:
            raise RuntimeError("Legacy migration failed: " + migrated.stdout.decode(errors="replace")[-800:])
        return cls.legacy_db

    def test_05_original_format_copy_is_admitted_by_the_legacy_route_and_v3_is_refused_by_its_format_gate(self):
        """The separately restored original-format sibling (positive control, reconstructed image): the former image's
        own recovery entry initializes its v2 pair, and a private copy of it is admitted by that same entry; the
        retained legacy copy route's format gate (ops_backup.admit_legacy_archive -> check_legacy_restore_format) admits
        that copy's bytes and refuses the v3 pair's bytes. No v3 byte is executed by the former image."""
        db = self.legacy_database()
        own = self.fresh_volume("legacy-own")
        code, logs = self._legacy_node(own, self.LEGACY_RECOVERY, db=db)
        self.assertEqual(code, 3, logs[-1500:])
        self.assertIn('"recovered":true', logs)
        initialized = _hash_volume(self.image_id, own)
        self.assertIn("seal/settlement.json", initialized)
        copy = self.clone(own, self.fresh_volume("legacy-copy"))
        code, logs = self._legacy_node(copy, self.LEGACY_RECOVERY, db=db)
        self.assertEqual(code, 3, "the original-format private copy is admitted by the legacy recovery entry: " + logs[-1500:])
        self.assertEqual(_hash_volume(self.image_id, own), initialized, "the copy's source is untouched")
        import io
        fingerprint = ops.admit_legacy_archive(io.BytesIO(_volume_archive(self.image_id, copy)))
        self.assertTrue(fingerprint)
        with self.assertRaises(RuntimeError) as refused:
            ops.admit_legacy_archive(io.BytesIO(_volume_archive(self.image_id, self.volumes["state"])))
        self.assertEqual(str(refused.exception), "Legacy restore refuses unknown/v3 state; verified state-service copy admission required")
        self.assertEqual(_hash_volume(self.image_id, self.volumes["state"]), self.pair_hashes)
        print(json.dumps({"D1656-original-format-control": {"legacy_image": self.legacy["Id"], "reconstructed": True,
                                                            "legacy_pair_files": sorted(initialized), "copy_fingerprint": fingerprint,
                                                            "v3_refusal": str(refused.exception)}}), flush=True)

    LEGACY_RECOVERY = ("const {AccessSeal}=require('/app/dist/emr-runtime/seal');const {PrismaLedgerSql}=require('/app/dist/emr-runtime/store');"
                       "const {FailureJournal}=require('/app/dist/emr-runtime/failure-journal');const {PrismaClient}=require('@prisma/client');"
                       "const db=new PrismaClient();const dir=process.env.KIN_EMR_STATE_DIR;"
                       "new AccessSeal(dir,new PrismaLedgerSql(db),new FailureJournal(dir)).recoverAtStart().then(r=>{console.log('KIN_RESULT '+JSON.stringify({recovered:true,r}));process.exit(3)},"
                       "e=>{console.log('KIN_RESULT '+JSON.stringify({refused:String(e&&(e.code||e.name))}));process.exit(1)});")

    def fresh_volume(self, suffix):
        token = uuid.uuid4().hex
        name = "kin-rehearsal-" + token[:16] + "-" + suffix
        self.addCleanup(ops.remove_owned_if_present, "volume", name, token)
        ops.run(["docker", "volume", "create", "--label", "kin.ops.run=" + token, name])
        ops.run(["docker", "run", "--rm", "--network", "none", "--user", "0:0", "--mount", "type=volume,source=" + name + ",target=/state",
                 "--entrypoint", "sh", self.image_id, "-c", "chown 1000:1000 /state && chmod 700 /state"])
        return name

    # ----- historical-behaviour diagnostics (retained counterexamples; not reject-before-mutation acceptance) ---------

    def test_06_diagnostic_former_owner_serve_over_a_v3_clone(self):
        """Diagnostic (D1656-T01 history): the former owner's `serve` over a private v3 clone. Its launcher has no
        start-time recovery, so the server may open over a v3 pair (idle Nest startup) and its owner registry may add
        files - recorded as facts; the acceptance boundary is test_01. The source pair volume is never mounted."""
        clone = self.clone()
        before = _hash_volume(self.image_id, clone)
        code, logs = self.legacy_run(self.legacy["Id"], "legacy-serve", [
            "--network", "container:" + self.db, "-e", "DATABASE_URL=" + RUNTIME_URL, "-e", "KIN_EMR_STATE_DIR=" + ops.EMR_STATE,
            "-e", "DEPLOYMENT_MODE=production", "-e", "AUTH_REQUIRED=true", "-e", "KC_ISSUER=http://127.0.0.1:1/auth/realms/kin",
            "-e", "KC_JWKS_URL=http://127.0.0.1:1/certs", "-e", "KC_AUDIENCE=kin-api", "-e", "KC_WEB_SECRET=disposable-ci-only",
            "-e", "KIN_COOKIE_SECRET=" + uuid.uuid4().hex, "-e", "PUBLIC_ORIGIN=http://127.0.0.1:3000", "-e", "ORTHANC_USER=disposable-ci-only",
            "-e", "ORTHANC_PASS=" + uuid.uuid4().hex, "-e", "KC_ADMIN_URL=http://127.0.0.1:1/auth", "-e", "KC_REALM=kin", "-e", "KC_CLIENT_ID=kin-api",
            "-e", "KC_CLIENT_SECRET=" + uuid.uuid4().hex, "--stop-timeout", "20",
            "--mount", "type=volume,source=" + clone + ",target=" + ops.EMR_STATE])
        after = _hash_volume(self.image_id, clone)
        added = sorted(name for name in after if name not in before)
        changed = sorted(name for name in before if before[name] != after.get(name))
        self.assertEqual(_hash_volume(self.image_id, self.volumes["state"]), self.pair_hashes, "the source pair volume is never mounted")
        self.assertEqual(self.psql("SELECT count(*) FROM emr_access.access_entry") + "/" + self.psql("SELECT count(*) FROM emr_access.commit_marker"), self.counts)
        print(json.dumps({"D1656-T01-diagnostic": {"counterexample": True, "exit": code, "nest_started_over_v3_pair": "Nest application successfully started" in logs,
                                                   "added_files": added, "changed_pair_files": changed,
                                                   "line": [line for line in logs.splitlines() if "湲곕룞 ?ㅽ뙣" in line or "Seal" in line][:3]}}), flush=True)

    def test_07_diagnostic_former_owner_recovery_entry_over_a_v3_clone(self):
        """Diagnostic (D1656-T01 restore route history): the former copy launcher's recovery (AccessSeal.recoverAtStart
        of that image) over a private v3 clone refuses the format (SealCorrupt) but writes its owner registry first -
        a counterexample to reject-before-mutation, which is why the supported route never reaches it (test_05 gate)."""
        clone = self.clone()
        before = _hash_volume(self.image_id, clone)
        code, logs = self._legacy_node(clone, self.LEGACY_RECOVERY)
        self.assertEqual(code, 1, logs[-1500:])
        self.assertIn('"refused"', logs)
        after = _hash_volume(self.image_id, clone)
        added = sorted(name for name in after if name not in before)
        changed = sorted(name for name in before if before[name] != after.get(name))
        self.assertEqual(_hash_volume(self.image_id, self.volumes["state"]), self.pair_hashes, "the source pair volume is never mounted")
        print(json.dumps({"D1656-T01-restore-diagnostic": {"counterexample": True, "exit": code, "added_files_before_refusal": added, "changed_pair_files": changed,
                                                           "result": [line for line in logs.splitlines() if line.startswith("KIN_RESULT")]}}), flush=True)

    def _legacy_node(self, volume, script, db=None):
        token = uuid.uuid4().hex
        name = "kin-rehearsal-" + token[:16] + "-legacy-node"
        self.addCleanup(ops.remove_owned_if_present, "container", name, token)
        ops.run(["docker", "create", "--name", name, "--label", "kin.ops.run=" + token, "--network", "container:" + (db or self.db),
                 "-e", "DATABASE_URL=" + RUNTIME_URL, "-e", "KIN_EMR_STATE_DIR=" + ops.EMR_STATE,
                 "--mount", "type=volume,source=" + volume + ",target=" + ops.EMR_STATE, "--entrypoint", "node", self.legacy["Id"], "-e", script])
        ops.run(["docker", "start", name])
        code = int(ops.text(["docker", "wait", name], timeout=180))
        result = ops.run(["docker", "logs", name])
        return code, (result.stdout + result.stderr).decode("utf-8", errors="replace")

    def test_08_legacy_start_script_has_no_state_service_entry(self):
        """D1656-T02 (script layer): the legacy script refuses `state-serve-v3` (exit 64); the pre-EMR script takes no mode
        at all - one layer only; the launch boundary of test_02 is the image identity."""
        code, logs = self._entry_run(self.legacy["Id"], "legacy-entry")
        self.assertEqual(code, 64, logs)
        self.assertIn("expected migrate or serve", logs)
        if self.pre_emr:
            text = ops.text(["docker", "run", "--rm", "--network", "none", "--entrypoint", "cat", self.pre_emr["Id"], "/app/start-production.sh"])
            self.assertNotIn("state-serve-v3", text)
            self.assertNotIn('case "${1', text)
            print(json.dumps({"D1656-T02-pre-emr": {"script_ignores_argument": True, "refusal_by": "launch admission image identity (test_02)"}}), flush=True)
        print(json.dumps({"D1656-T02": {"exit": code}}), flush=True)

    def _entry_run(self, image, suffix):
        token = uuid.uuid4().hex
        name = "kin-rehearsal-" + token[:16] + "-" + suffix
        self.addCleanup(ops.remove_owned_if_present, "container", name, token)
        ops.run(["docker", "create", "--name", name, "--label", "kin.ops.run=" + token, "--network", "none", "--entrypoint", "sh", image,
                 "/app/start-production.sh", "state-serve-v3"])
        ops.run(["docker", "start", name])
        code = int(ops.text(["docker", "wait", name], timeout=60))
        result = ops.run(["docker", "logs", name])
        return code, (result.stdout + result.stderr).decode("utf-8", errors="replace")

    def test_09_former_owner_in_the_client_shape_gets_no_state_and_is_refused_as_client(self):
        """D1656-T05: the former owner image started with the (c) client shape: no state mount, no reader secret, the
        read-only API IPC volume only; the client admission (check_state_client) refuses it as the reviewed API."""
        before = _hash_volume(self.image_id, self.volumes["state"])
        code, logs = self.legacy_run(self.legacy["Id"], "legacy-client", [
            "--network", "container:" + self.db, "--group-add", "2001", "-e", "DATABASE_URL=" + RUNTIME_URL,
            "-e", "KIN_EMR_STATE_SOCKET=" + API_IPC + "/writer.sock", "-e", "KIN_EMR_INSTANCE_ID=" + self.INSTANCE,
            "-e", "DEPLOYMENT_MODE=production", "-e", "AUTH_REQUIRED=true", "-e", "KC_ISSUER=http://127.0.0.1:1/auth/realms/kin",
            "-e", "KC_JWKS_URL=http://127.0.0.1:1/certs", "-e", "KC_AUDIENCE=kin-api", "-e", "KC_WEB_SECRET=disposable-ci-only",
            "-e", "KIN_COOKIE_SECRET=" + uuid.uuid4().hex, "-e", "PUBLIC_ORIGIN=http://127.0.0.1:3000", "-e", "ORTHANC_USER=disposable-ci-only",
            "-e", "ORTHANC_PASS=" + uuid.uuid4().hex, "-e", "KC_ADMIN_URL=http://127.0.0.1:1/auth", "-e", "KC_REALM=kin", "-e", "KC_CLIENT_ID=kin-api",
            "-e", "KC_CLIENT_SECRET=" + uuid.uuid4().hex, "--stop-timeout", "20",
            "--mount", "type=volume,source=" + self.volumes["api-ipc"] + ",target=" + API_IPC + ",readonly"], timeout=60)
        mounts = [(m.get("Type"), m.get("Name"), m.get("Destination")) for m in self.legacy_inspect.get("Mounts") or []]
        self.assertEqual(mounts, [("volume", self.volumes["api-ipc"], API_IPC)], "the client shape mounts only the API IPC volume")
        self.assertEqual(_hash_volume(self.image_id, self.volumes["state"]), before, "the v3 pair is untouched")
        self.assertEqual(self.psql("SELECT count(*) FROM emr_access.access_entry") + "/" + self.psql("SELECT count(*) FROM emr_access.commit_marker"), self.counts)
        import ops_deploy_preflight as preflight
        release = {"sha": ops.text(["git", "rev-parse", "HEAD"]), "images": {"api": self.image_id}}
        with self.assertRaises(RuntimeError) as refused:
            preflight.check_state_client(self.legacy_inspect, release=release, image=self.legacy, state_volume=self.volumes["state"],
                                         api_ipc_volume=self.volumes["api-ipc"], instance_id=self.INSTANCE, database_host="127.0.0.1")
        self.assertIn("reviewed", str(refused.exception))
        print(json.dumps({"D1656-T05": {"exit": code, "running_after_60s": code is None, "preflight_refusal": str(refused.exception),
                                        "line": [line for line in logs.splitlines() if "湲곕룞 ?ㅽ뙣" in line or "EMR" in line][:3]}}), flush=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
