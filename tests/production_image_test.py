"""Production image checks against a disposable PostgreSQL, with no host ports."""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import time
import unittest
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import ops_backup as ops


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

    def api(self, suffix, **overrides):
        env = {
            "DATABASE_URL": "postgresql://postgres@127.0.0.1:5432/kin",
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
        expected = os.environ.get("KIN_EXPECTED_REVISION", "C1-working-tree")
        self.assertEqual(self.image["Config"]["Labels"]["org.opencontainers.image.revision"], expected)
        script = """
const fs=require('fs'), assert=require('assert');
assert.notStrictEqual(process.getuid(),0);
for(const p of ['dist/main.js','prisma/migrations/0_init/migration.sql',
  'node_modules/prisma/build/index.js','node_modules/.prisma/client/index.js']) assert(fs.existsSync(p),p);
for(const p of ['src','node_modules/@nestjs/cli','node_modules/typescript']) assert(!fs.existsSync(p),p);
assert.strictEqual(require('@prisma/client/package.json').version,'5.22.0');
assert.strictEqual(require('prisma/package.json').version,'5.22.0');
assert(!fs.readFileSync('start-production.sh').includes(13));
"""
        ops.temporary_run(["--network", "none", "--entrypoint", "node", self.image_id, "-e", script])

    def test_02_migrate_boot_restart_preserves_data_and_history(self):
        """TEST-C1-02/03: real Prisma engines, empty migration, auth guard and exec signal path."""
        name = self.api("healthy")
        self.wait_running_api(name)
        history = self.psql('SELECT migration_name,checksum,finished_at FROM "_prisma_migrations";')
        self.assertTrue(history.startswith("0_init|"))
        self.assertEqual(len(history.splitlines()), 1)
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
        self.assertEqual(self.psql('SELECT migration_name,checksum,finished_at FROM "_prisma_migrations";'), history)
        self.assertEqual(self.psql("SELECT value FROM c1_probe;"), "preserved")
        self.assertIn("No pending migrations to apply", ops.text(["docker", "logs", name]))
        ops.run(["docker", "stop", "--time", "10", name])

    def test_03_unreachable_database_prevents_api_start(self):
        """TEST-C1-02: a failed migration cannot fall through to Node startup."""
        name = self.api("bad-db", DATABASE_URL="postgresql://postgres@127.0.0.1:1/kin?connect_timeout=2")
        self.assertIn("P1001", self.stopped_with_error(name))

    def test_04_production_refuses_disabled_auth(self):
        """TEST-C1-03: packaging must retain the production authentication guard."""
        name = self.api("no-auth", AUTH_REQUIRED="false")
        self.assertIn("AUTH_REQUIRED=true", self.stopped_with_error(name))


if __name__ == "__main__":
    unittest.main(verbosity=2)
