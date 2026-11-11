"""Production image checks against a disposable PostgreSQL, with no host ports.

EMR-B1: the image has two entry modes. `start-production.sh migrate` applies the reviewed migrations with the installer
credential in its own one-shot container; `serve` (the default) opens the API with the least-privilege runtime role only
and refuses to start, in production, on any other credential. The disposable database is provisioned first with the
fixed provisioning SQL (roles, secrets, the dedicated tablespace on its own mount).
"""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import subprocess
import tempfile
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
# The one expected migration list, in order: the image must package exactly these and the migrate mode must apply exactly
# these. Adding a migration means adding it here (and to the restore fixture, tests/ops_product_transfer_fixture.py).
MIGRATIONS = [
    '0_init', '20260907040000_viewer_history', '20260908020000_workspace_layout',
    '20260908081500_connect_gate', '20260908120000_manual_sr',
    '20260908180000_viewer_jobs', '20260908200000_manual_sr_recovery',
    '20260909060000_saved_filter_organization', '20260909100000_tech_note_revision',
    '20260909180000_worklist_columns', '20260909220000_favorite_workspace', '20260909233000_study_tags', '20260910000500_reader_assignment', '20260910013000_reading_preferences', '20260910023000_reading_appearance', '20260910044500_workspace_shortcuts', '20260910090000_filter_folders', '20260910100000_shared_filters', '20260910110000_study_consultation', '20260910123000_consultation_predicates', '20260910130000_study_access', '20260910133000_study_access_subject', '20260912100000_hanging_protocol_preferences', '20260917120000_findings', '20260920120000_report_citations', '20260921120000_report_structure', '20260924120000_order_accession', '20260924130000_gateway_receipt', '20260924140000_gateway_retry_request', '20260926120000_study_questions', '20260926130000_study_image_requests', '20260928120000_critical_result', '20260928130000_reader_assignment_scope', '20260930120000_audit_log_append_only', '20261004120000_draft_revision_session_entry',
    '20261005120000_idp_session_end', '20261005130000_member_isolation',
    '20261006000000_tech_note_attempt_id',
    '20261006120000_member_isolation_call', '20261007120000_provider_change', '20261007170000_member_db_rights', '20261007200000_designation_subjects',
    '20261008120000_emr_b', '20261010120000_emr_seal_attempts', '20261010150000_emr_read_jit_off', '20261011120000_filter_shortcuts',
    '20261015013945_import_operation', '20261016120000_related_report_insert_receipt', '20261023180000_emr_pg_ledger', '20261023200000_emr_server_signing', '20261024120000_emr_d_online', '20261025000000_emr_e_online', '20261025120000_access_review', '20261025120000_auth_flow_subtraction', '20261025150000_emr_f_link', '20261026120000_assignment_access_stream', '20261026180000_emr_signing_key_admin', '20261026210000_emr_e_source_manifest', '20261027090000_emr_e_study_delivery', '20261027150000_emr_e_observation_delivery', '20261027180000_emr_image_object_digest', '20261027230000_caution_app_limits', '20261028120000_held_unknown_source', '20261029120000_emr_image_retention', '20261029130000_emr_preparation_manifest_index', '20261030120000_preload_cache_key', '20261030130000_writer_institution', '20261102140000_cd10_access_seen', '20261103150000_cd09p_draft_purpose', '20261105120000_cd09d_report_retention', '20261111120000_critical_result_study_label', '20261111160000_institution_emr_link',
]
# docker-compose.yml refuses to resolve without these; the compose reads below give each a synthetic value.
COMPOSE_SECRETS = ("ORTHANC_PASS", "POSTGRES_PASSWORD", "KIN_EMR_RUNTIME_PASSWORD", "KC_ADMIN_PASSWORD",
                   "KC_CLIENT_SECRET", "KC_WEB_SECRET", "KIN_COOKIE_SECRET")
SSL_PRESET = ("SSL_CERT_FILE", "SSL_CERT_DIR")
NO_OVERLAY = "services: {}\n"


def production_compose(overlay, extra=NO_OVERLAY):
    """docker-compose.yml with these overlay texts, as Compose itself merges and resolves them (quoting, comments, per-service
    environment). Synthetic secrets only: an empty env file stands in for the checkout's .env and COMPOSE_* is not inherited.
    The file count is fixed (the default extra overlay adds nothing) so the Compose argv stays one literal that the TG-02
    guard (tests/execution_guard_test.py) can resolve to its `config` verb."""
    with tempfile.TemporaryDirectory() as folder:
        env_file, first, second = (Path(folder) / name for name in ("synthetic.env", "overlay-0.yml", "overlay-1.yml"))
        env_file.write_text("", encoding="utf-8")
        first.write_text(overlay, encoding="utf-8", newline="\n")
        second.write_text(extra, encoding="utf-8", newline="\n")
        env = {key: value for key, value in os.environ.items() if not key.startswith("COMPOSE_")}
        env.update({name: "synthetic-" + uuid.uuid4().hex for name in COMPOSE_SECRETS})
        result = subprocess.run(["docker", "compose", "--project-directory", str(ROOT), "--env-file", str(env_file),
                                 "-f", str(ROOT / "docker-compose.yml"), "-f", str(first), "-f", str(second),
                                 "config", "--format", "json"], cwd=ROOT, env=env, capture_output=True, timeout=60)
    if result.returncode:
        raise RuntimeError("docker compose config failed: " + result.stderr.decode("utf-8", errors="replace"))
    return json.loads(result.stdout)


def api_ssl_preset(rendered):
    """The two values the API service's effective environment holds; KeyError when the API lacks either."""
    environment = rendered["services"]["api"].get("environment") or {}
    return tuple(environment[name] for name in SSL_PRESET)


class ProductionComposeSslPresetTests(unittest.TestCase):
    def test_08_the_ssl_preset_is_the_api_services_resolved_environment(self):
        """GPT r1 F1: test_07 takes the preset from the API service as Compose resolves base + docker-compose.prod.yml, not from
        the overlay's spelling. Removing the two names from the resolved API, or moving them to another service, leaves the API
        without them and is refused; the same values written as equivalent YAML (quoted, with a trailing comment) read the
        same. docker-compose.yml declares them too (test_09), so removing them means resetting them in the overlay."""
        overlay = (ROOT / "docker-compose.prod.yml").read_text(encoding="utf-8")
        file, directory = api_ssl_preset(production_compose(overlay))
        self.assertTrue(all(isinstance(value, str) and value for value in (file, directory)), (file, directory))
        # Fixture construction: the overlay with its two declarations replaced by Compose resets, which also drop the base
        # file's (exactly two lines, so a reshaped overlay fails here loudly rather than producing a variant that tests nothing).
        lines = overlay.splitlines(keepends=True)
        pattern = re.compile(r"^(\s+)(" + "|".join(SSL_PRESET) + r")\s*:.*")
        stripped = [pattern.sub(r"\1\2: !reset null", line) for line in lines]
        self.assertEqual(sum(a != b for a, b in zip(lines, stripped)), 2)
        stripped = "".join(stripped)
        declared = f"      SSL_CERT_FILE: \"{file}\"   # the image's CA bundle\n      SSL_CERT_DIR: '{directory}'   # its hashed directory\n"
        with self.assertRaises(KeyError):
            api_ssl_preset(production_compose(stripped))
        moved = production_compose(stripped, "services:\n  api-migrate:\n    environment:\n" + declared)
        self.assertEqual(tuple(moved["services"]["api-migrate"]["environment"].get(name) for name in SSL_PRESET), (file, directory))
        with self.assertRaises(KeyError):
            api_ssl_preset(moved)
        self.assertEqual(api_ssl_preset(production_compose(stripped, "services:\n  api:\n    environment:\n" + declared)),
                         (file, directory))

    def test_09_the_development_api_has_the_production_preset(self):
        """The development API (docker-compose.yml alone) runs the same Prisma library engine from the same base stage, so it
        carries the same preset as production, whose values test_07 checks against the image."""
        production = api_ssl_preset(production_compose((ROOT / "docker-compose.prod.yml").read_text(encoding="utf-8")))
        self.assertEqual(api_ssl_preset(production_compose(NO_OVERLAY)), production)


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
        provisioned = subprocess.run(["docker", "exec", "-i", "-e", "KIN_EMR_RUNTIME_PASSWORD=" + uuid.uuid4().hex, cls.db,
                                      "psql", "-X", "-U", "postgres", "-d", "kin"], input=emr_compose.PROVISION_SQL.encode(),
                                     capture_output=True, timeout=120)
        if provisioned.returncode:
            raise RuntimeError("EMR provisioning of the disposable database failed")
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

    def migrate(self, suffix, url=INSTALLER_URL):
        """The production image's one-shot migration mode with the installer credential; returns (exit, logs)."""
        name = self.container(suffix, ["--network", "container:" + self.db, "-e", "DATABASE_URL=" + url,
                                       self.image_id, "sh", "/app/start-production.sh", "migrate"])
        code = int(ops.text(["docker", "wait", name], timeout=180))
        return code, self.logs(name)

    def api(self, suffix, **overrides):
        env = {
            "DATABASE_URL": RUNTIME_URL,
            "KIN_EMR_STATE_DIR": "/var/lib/kin-emr",
            "DEPLOYMENT_MODE": "production", "AUTH_REQUIRED": "true",
            "KC_ISSUER": "http://127.0.0.1:1/auth/realms/kin",
            "KC_JWKS_URL": "http://127.0.0.1:1/certs", "KC_AUDIENCE": "kin-api",
            "KC_WEB_SECRET": "disposable-ci-only", "KIN_COOKIE_SECRET": uuid.uuid4().hex,
            "PUBLIC_ORIGIN": "http://127.0.0.1:3000",
            "ORTHANC_USER": "disposable-ci-only", "ORTHANC_PASS": uuid.uuid4().hex,
            "KC_ADMIN_URL": "http://127.0.0.1:1/auth", "KC_REALM": "kin",
            "KC_CLIENT_ID": "kin-api", "KC_CLIENT_SECRET": uuid.uuid4().hex,
        }
        env.update(overrides)
        args = ["--network", "container:" + self.db]
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
        self.assertEqual(self.image["Config"]["User"], "node")
        self.assertIn("NODE_ENV=production", self.image["Config"]["Env"])
        self.assertEqual(self.image["Config"]["Cmd"], ["sh", "/app/start-production.sh", "serve"])
        expected = os.environ.get("KIN_EXPECTED_REVISION", "C1-working-tree")
        self.assertEqual(self.image["Config"]["Labels"]["org.opencontainers.image.revision"], expected)
        # CD-01: GET /api/version reports the build argument the label carries. A 40-hex VCS_REF is the
        # revision; anything else (the default "unknown", this fixture's working-tree name) is no revision at all.
        self.assertIn("KIN_BUILD_REVISION=" + expected, self.image["Config"]["Env"])
        script = """
const fs=require('fs'), assert=require('assert');
assert.notStrictEqual(process.getuid(),0);
const expected=JSON.parse(process.argv[1]);
const packaged=fs.readdirSync('prisma/migrations',{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>e.name)
  .sort((a,b)=>a<b?-1:a>b?1:0);
assert.deepStrictEqual(packaged,expected);
for(const name of expected) assert(fs.existsSync('prisma/migrations/'+name+'/migration.sql'),name);
for(const p of ['dist/main.js','dist/emr-runtime/store.js',
  'node_modules/prisma/build/index.js','node_modules/.prisma/client/index.js']) assert(fs.existsSync(p),p);
for(const p of ['src','node_modules/@nestjs/cli','node_modules/typescript']) assert(!fs.existsSync(p),p);
assert.strictEqual(require('@prisma/client/package.json').version,'5.22.0');
assert.strictEqual(require('prisma/package.json').version,'5.22.0');
// The Orthanc connection pools (orthanc-transport.ts) are a runtime dependency the prune must keep.
assert.strictEqual(require('undici/package.json').version,'6.29.1');
assert(!fs.readFileSync('start-production.sh').includes(13));
// EMR-B1 protected state directory: the API's own user only (a named volume inherits this on first mount).
const state=fs.statSync('/var/lib/kin-emr');
assert(state.isDirectory()); assert.strictEqual(state.uid,process.getuid()); assert.strictEqual(state.mode&0o777,0o700);
// CD-01: the compiled version route answers this image's own label.
const facts=require('./dist/product-info.controller').buildFacts();
const label=process.argv[2];
assert.strictEqual(facts.build.revision,/^[0-9a-f]{40}$/.test(label)?label:null);
"""
        ops.temporary_run(["--network", "none", "--entrypoint", "node", self.image_id, "-e", script,
                           json.dumps(MIGRATIONS), expected])

    def test_02_migrate_boot_restart_preserves_data_and_history(self):
        """TEST-C1-02/03: real Prisma engines, empty migration, auth guard and exec signal path.

        EMR-B1: the migration runs in the image's own `migrate` mode with the installer credential; the server then
        starts as the runtime role and never migrates."""
        code, logs = self.migrate("migrate")
        self.assertEqual(code, 0, logs[-2000:])
        # This image-only fixture has no realm server. Exercise the supported operator import with an empty realm
        # before boot; onModuleInit must see its real completion marker and never contact the unreachable provider.
        script = """
const {PrismaService}=require('./dist/prisma.service');
const {EmrRuntime}=require('./dist/emr-runtime/application');
const {importMemberRights}=require('./dist/member-rights-import');
const db=new PrismaService();
const runtime=new EmrRuntime(process.env.DATABASE_URL, '/var/lib/kin-emr/outage');
(async()=>{
  try {
    await runtime.start();
    const imported=await importMemberRights(db,{listUsers:async()=>({total:0,users:[]})},runtime.port);
    await imported?.publication;
  } finally {
    try { await runtime.stop(Date.now()+5000); }
    finally { await db.$disconnect(); }
  }
})().catch(error=>{console.error(error);process.exitCode=1});
"""
        ops.run(["docker", "run", "--rm", "--network", "container:" + self.db,
                 "-e", "DATABASE_URL=" + RUNTIME_URL,
                 "-e", "KC_ISSUER=http://127.0.0.1:1/auth/realms/kin",
                 "--entrypoint", "node", self.image_id, "-e", script])
        self.assertEqual(self.psql('SELECT id FROM "MemberRightsImport";'), "realm-v1")
        name = self.api("healthy")
        # A failed migration assertion must not leave port3000 occupied for the drain test.
        self.addCleanup(ops.run, ["docker", "stop", "--time", "10", name])
        self.wait_running_api(name)
        # Heap order can change when Prisma marks a migration finished. Compare
        # the same ordered history before and after restart, independent of locale.
        history_query = 'SELECT migration_name,checksum,finished_at FROM "_prisma_migrations" ORDER BY migration_name COLLATE "C";'
        history = self.psql(history_query)
        self.assertTrue(history.startswith("0_init|"))
        self.assertEqual(sorted(line.split('|')[0] for line in history.splitlines()), MIGRATIONS)
        self.assertEqual(self.psql("SELECT string_agg(table_name, ',' ORDER BY table_name) FROM information_schema.tables WHERE table_schema='emr_image';"), "expiring_delivery_link,object_digest,observation,preparation,source_manifest")
        self.assertEqual(self.psql("SELECT concat_ws(',', has_table_privilege('kin_runtime','emr_image.preparation','INSERT'), has_table_privilege('kin_runtime','emr_image.observation','INSERT'), has_sequence_privilege('kin_runtime','emr_image.observation_sequence_seq','USAGE'), has_table_privilege('kin_runtime','emr_image.object_digest','SELECT,INSERT'), has_table_privilege('kin_runtime','emr_image.object_digest','UPDATE,DELETE,TRUNCATE'));"), "t,t,t,t,f")
        self.psql("CREATE TABLE c1_probe(value text); INSERT INTO c1_probe VALUES ('preserved');")
        # S9-U4b: the runtime role reads exactly the three history columns of the import readiness fact, and an
        # ImportOperation row written now survives the restart below with its owner and kind.
        self.assertEqual(self.psql("SELECT concat_ws(',', has_column_privilege('kin_runtime', 'public._prisma_migrations', 'migration_name', 'SELECT'),"
                                   " has_column_privilege('kin_runtime', 'public._prisma_migrations', 'finished_at', 'SELECT'),"
                                   " has_column_privilege('kin_runtime', 'public._prisma_migrations', 'rolled_back_at', 'SELECT'),"
                                   " has_column_privilege('kin_runtime', 'public._prisma_migrations', 'checksum', 'SELECT'),"
                                   " has_column_privilege('kin_runtime', 'public._prisma_migrations', 'logs', 'SELECT'));"),
                         "t,t,t,f,f")
        self.psql("INSERT INTO \"ImportOperation\" (id,\"institutionId\",\"ownerIssuer\",\"ownerSubject\",actor,kind,status)"
                  " VALUES ('00000000-0000-4000-8000-0000000c1001','c1-hospital','https://c1.test/realm','c1-sub','c1-actor','import','open');")
        import_row = "SELECT concat_ws('|', kind, status, \"ownerSubject\", actor, results::text) FROM \"ImportOperation\";"
        self.assertEqual(self.psql(import_row), "import|open|c1-sub|c1-actor|[]")
        # W5-API: the runtime role writes insert receipts through the EMR-B1 default privileges (the migration grants
        # nothing), an applied receipt written now survives the restart below, and its guard refuses UPDATE and DELETE.
        self.assertEqual(self.psql("SELECT concat_ws(',', has_table_privilege('kin_runtime', 'public.\"ReportDraftInsertReceipt\"', 'SELECT'),"
                                   " has_table_privilege('kin_runtime', 'public.\"ReportDraftInsertReceipt\"', 'INSERT'),"
                                   " has_table_privilege('kin_runtime', 'public.\"ReportDraftInsertReceipt\"', 'UPDATE'));"),
                         "t,t,t")
        self.psql("INSERT INTO \"ReportDraftInsertReceipt\" (\"insertRequestId\",\"targetUid\",\"ownerInstitution\",\"ownerSub\",\"ownerAuthor\","
                  "\"requestHash\",\"proposalHash\",\"expectedEpoch\",\"expectedRevision\",\"sourceUid\",\"sourceVersion\",\"targetBaseVersion\","
                  "section,state,\"appliedRevision\",\"updatedAt\") VALUES ('00000000-0000-4000-8000-0000000c1501','2.25.1501','c1-hospital',"
                  "'c1-sub','c1-reader','" + "1" * 64 + "','" + "2" * 64 + "','00000000-0000-4000-8000-0000000c15e1',4,'2.25.1502',2,1,"
                  "'findings','applied',5,CURRENT_TIMESTAMP);")
        receipt_row = "SELECT concat_ws('|', state, \"appliedRevision\", \"receiptRevision\", \"ownerAuthor\") FROM \"ReportDraftInsertReceipt\";"
        self.assertEqual(self.psql(receipt_row), "applied|5|1|c1-reader")
        self.psql("DO $$ BEGIN"
                  " BEGIN UPDATE \"ReportDraftInsertReceipt\" SET \"receiptRevision\" = 2;"
                  " RAISE EXCEPTION 'terminal receipt changed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;"
                  " BEGIN DELETE FROM \"ReportDraftInsertReceipt\";"
                  " RAISE EXCEPTION 'receipt removed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END; END $$;")
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
        self.assertEqual(self.psql(history_query), history)
        self.assertEqual(self.psql("SELECT value FROM c1_probe;"), "preserved")
        self.assertEqual(self.psql(import_row), "import|open|c1-sub|c1-actor|[]")
        self.assertEqual(self.psql(receipt_row), "applied|5|1|c1-reader")
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
        self.assertIn("EmrRuntimeRefused", logs)
        for problem in ("rolsuper", "audit-append-only-required"):
            self.assertIn(problem, logs)

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

    def test_07_production_ssl_cert_preset_is_what_the_image_uses_unset(self):
        """exp-node-sigsegv: docker-compose.prod.yml presets SSL_CERT_FILE/SSL_CERT_DIR for the API so the Prisma library
        engine's setenv on its first TLS connector updates them in place instead of adding them under the server's
        environment reads. The preset must change nothing else: it is this image's OpenSSL default (OPENSSLDIR) and what
        the engine writes itself when nothing is set, and both paths exist with certificates. A base image that moves
        them fails here instead of a deployment pinning a stale path. The values are the API service's environment as Compose
        resolves the production files (test_08)."""
        file, directory = api_ssl_preset(production_compose((ROOT / "docker-compose.prod.yml").read_text(encoding="utf-8")))
        script = """
const fs=require('fs'), path=require('path'), assert=require('assert'), {execFileSync}=require('child_process');
const [file,dir,url]=process.argv.slice(1);
assert.strictEqual(process.env.SSL_CERT_FILE,undefined); assert.strictEqual(process.env.SSL_CERT_DIR,undefined);
const openssldir=/^OPENSSLDIR: "([^"]+)"$/m.exec(execFileSync('openssl',['version','-d'],{encoding:'utf8'}))[1];
assert.deepStrictEqual([file,dir],[path.posix.join(openssldir,'cert.pem'),path.posix.join(openssldir,'certs')]);
assert(fs.statSync(file).isFile()); assert(fs.readFileSync(file,'utf8').includes('-----BEGIN CERTIFICATE-----'));
assert(fs.statSync(dir).isDirectory()); assert(fs.readdirSync(dir).length>0);
const {PrismaClient}=require('@prisma/client');
const db=new PrismaClient({datasources:{db:{url}}});
db.$connect().then(()=>db.$queryRawUnsafe('SELECT 1')).then(async()=>{
  assert.deepStrictEqual([process.env.SSL_CERT_FILE,process.env.SSL_CERT_DIR],[file,dir]);
  await db.$disconnect();
}).catch(e=>{console.error(e);process.exit(1);});
"""
        ops.temporary_run(["--network", "container:" + self.db, "--entrypoint", "node", self.image_id, "-e", script,
                           file, directory, RUNTIME_URL])


if __name__ == "__main__":
    unittest.main(verbosity=2)
