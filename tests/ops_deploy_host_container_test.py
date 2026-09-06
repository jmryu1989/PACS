"""CI-only real API replacement/return, Prisma and DB preservation.

Refuses existing kin-api/kin-proxy. All data/config are disposable; full HTTPS
authentication/frame contracts are separately exercised by ops_deploy_host_test.
This test calls apply_api directly, never substitutes synthetic smoke for a
successful operational deployment. No SMTP or operational approval is used.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import ops_backup as ops
import ops_deploy_host as host
import ops_deploy_preflight as pre
import ops_deploy_runner as runner
from ops_deploy_host_test import approve, encoded, policy_fixture, private


class ContainerTests(unittest.TestCase):
    def command(self, args, **kwargs):
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=kwargs.pop("timeout", 120), **kwargs)
        if result.returncode:
            raise RuntimeError("Rehearsal command failed: " + args[0] + " " + args[1]
                               + "\n" + result.stderr.decode(errors="replace")[:4000])
        return result.stdout.decode().strip()

    def git(self, *args):
        return self.command(["git", "-c", "user.name=Host fixture", "-c", "user.email=fixture@example.invalid",
                             "-c", "core.hooksPath=/dev/null", *args], cwd=self.repo)

    def inspect(self, name):
        return json.loads(self.command(["docker", "inspect", name]))[0]

    def remove_container(self, name):
        result = subprocess.run(["docker", "inspect", name], capture_output=True, timeout=30)
        if result.returncode:
            # Distinguish absence from a disconnected daemon before declaring clean.
            self.command(["docker", "info", "--format", "{{.ServerVersion}}"])
            return
        item = json.loads(result.stdout)[0]
        self.assertEqual(item["Config"]["Labels"].get("kin.ops.run"), self.token)
        self.command(["docker", "rm", "-f", item["Id"]])

    def remove_network(self):
        result = subprocess.run(["docker", "network", "inspect", self.network], capture_output=True, timeout=30)
        if result.returncode:
            self.command(["docker", "info", "--format", "{{.ServerVersion}}"])
            return
        item = json.loads(result.stdout)[0]
        self.assertEqual(item["Labels"].get("kin.ops.run"), self.token)
        self.command(["docker", "network", "rm", item["Id"]])

    def psql(self, sql):
        return self.command(["docker", "exec", self.db, "psql", "-X", "-U", "postgres", "-d", "kin",
                             "-v", "ON_ERROR_STOP=1", "-qAt", "-c", sql])

    def readiness(self):
        script = """Promise.all([fetch('http://127.0.0.1:3000/api/health'),fetch('http://127.0.0.1:3000/api/me')])
.then(async([r,m])=>{const h=await r.json();if(r.status!==200||!h.ok||!h.auth||m.status!==401)process.exit(1)})
.catch(()=>process.exit(1))"""
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            result = subprocess.run(["docker", "exec", "kin-api", "node", "-e", script], capture_output=True, timeout=10)
            if result.returncode == 0:
                return
            time.sleep(0.5)
        self.fail("Disposable API health/auth-refusal timed out")

    def test_real_target_and_previous_preserve_database(self):
        self.assertEqual(os.geteuid(), 0, "Linux root in isolated CI required")
        ops.require_local_docker()
        existing = self.command(["docker", "ps", "-a", "--format", "{{.Names}}"])
        self.assertFalse({"kin-api", "kin-proxy"} & set(existing.splitlines()), "Existing stack; refusing rehearsal")
        self.token = uuid.uuid4().hex
        self.network = "kin-rehearsal-" + self.token[:16]
        self.db = self.network + "-db"
        folder = tempfile.TemporaryDirectory(prefix="kin-host-docker-")
        self.addCleanup(folder.cleanup)
        root = Path(folder.name)
        self.repo, state = root / "repo", root / "state"
        state.mkdir(mode=0o700)
        source = Path(__file__).resolve().parents[1]
        self.command(["git", "-c", "safe.directory=" + str(source), "clone", "--no-hardlinks", str(source), str(self.repo)])
        self.repo.chmod(0o700)
        self.git("checkout", "--detach", self.command(["git", "-c", "safe.directory=" + str(source), "rev-parse", "HEAD"], cwd=source))
        image = os.environ.get("KIN_TEST_API_IMAGE", "kin-api:ci")
        previous_image = json.loads(self.command(["docker", "image", "inspect", image]))[0]["Id"]
        env = {"DATABASE_URL": "postgresql://postgres@" + self.db + ":5432/kin",
               "DEPLOYMENT_MODE": "production", "AUTH_REQUIRED": "true",
               "KC_ISSUER": "http://127.0.0.1:1/auth/realms/kin", "KC_JWKS_URL": "http://127.0.0.1:1/certs",
               "KC_AUDIENCE": "kin-api", "KC_WEB_SECRET": uuid.uuid4().hex, "KIN_COOKIE_SECRET": uuid.uuid4().hex,
               "PUBLIC_ORIGIN": "http://127.0.0.1:3000", "ORTHANC_USER": "synthetic-fixture", "ORTHANC_PASS": uuid.uuid4().hex,
               "KC_ADMIN_URL": "http://127.0.0.1:1/auth", "KC_REALM": "kin", "KC_CLIENT_ID": "kin-api", "KC_CLIENT_SECRET": uuid.uuid4().hex}
        compose = {"name": self.network, "services": {"api": {"container_name": "kin-api", "image": previous_image,
                   "environment": env, "labels": {"kin.ops.run": self.token}, "networks": ["fixture"]}},
                   "networks": {"fixture": {"external": True, "name": self.network}}}
        private(self.repo / pre.COMPOSE[0], encoded(compose))
        for name in pre.COMPOSE[1:]:
            private(self.repo / name, b'{"services":{}}\n')
        self.git("add", *pre.COMPOSE)
        self.git("commit", "-m", "synthetic deployment configuration")
        previous_sha = self.git("rev-parse", "HEAD")
        private(self.repo / "host-fixture.txt", b"target release identity only\n")
        self.git("add", "host-fixture.txt")
        self.git("commit", "-m", "synthetic target identity")
        target_sha = self.git("rev-parse", "HEAD")
        self.git("checkout", "--detach", previous_sha)
        tag = self.network + ":target"
        # The base image is already built by CI, including its real Prisma engines.
        self.command(["docker", "build", "--pull=false", "-t", tag, "-"],
                     input=("FROM " + image + "\nLABEL org.opencontainers.image.revision=" + target_sha + "\n").encode())
        target_image = json.loads(self.command(["docker", "image", "inspect", tag]))[0]["Id"]
        self.addCleanup(self.command, ["docker", "image", "rm", tag])
        self.addCleanup(self.remove_network)
        self.command(["docker", "network", "create", "--internal", "--label", "kin.ops.run=" + self.token, self.network])
        self.addCleanup(self.remove_container, self.db)
        self.command(["docker", "run", "-d", "--name", self.db, "--label", "kin.ops.run=" + self.token,
                      "--network", self.network, "--tmpfs", "/var/lib/postgresql/data", "-e", "POSTGRES_HOST_AUTH_METHOD=trust",
                      "-e", "POSTGRES_DB=kin", "postgres:16-alpine"])
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            result = subprocess.run(["docker", "exec", self.db, "pg_isready", "-U", "postgres"], capture_output=True, timeout=10)
            if result.returncode == 0:
                break
            time.sleep(0.5)
        else:
            self.fail("Disposable database readiness timed out")
        nginx = private(root / "nginx.conf", b"events {}\nhttp { server { listen 8080; return 200; } }\n")
        self.addCleanup(self.remove_container, "kin-proxy")
        self.command(["docker", "run", "-d", "--name", "kin-proxy", "--label", "kin.ops.run=" + self.token,
                      "--network", "none", "--mount", "type=bind,src=" + str(nginx) + ",dst=/etc/nginx/nginx.conf,readonly",
                      "--entrypoint", "nginx", "kin-proxy:ci", "-g", "daemon off;"])
        policy = policy_fixture(self.repo, state)
        adapter = host.HostAdapter(private(root / "policy.json", encoded(policy)))
        body = {"version": 1, "previous_sha": previous_sha, "target_sha": target_sha,
                "previous_api_image": previous_image, "target_api_image": target_image, "compose_files": list(pre.COMPOSE)}
        raw = encoded(body)
        plan = runner.make_plan(raw, host.hashlib.sha256(raw).hexdigest())
        approve(state, plan)
        self.addCleanup(self.remove_container, "kin-api")
        with adapter.bound(), ops.lock():
            args = ["docker", "compose", "--project-directory", str(self.repo)]
            for name in pre.COMPOSE:
                args += ["-f", str(self.repo / name)]
            adapter.command([*args, "up", "-d", "--no-deps", "--no-build", "--pull", "never", "api"])
            self.readiness()
            before = self.inspect("kin-api")["Id"]
            database_id = self.inspect(self.db)["Id"]
            self.psql("CREATE TABLE host_probe(value text); INSERT INTO host_probe VALUES ('preserved');")
            migration = self.psql('SELECT migration_name,checksum,finished_at FROM "_prisma_migrations";')
            self.assertTrue(migration.startswith("0_init|"))
            adapter.authorize(plan)
            self.assertTrue(adapter.observe(plan)["preflight_passed"])
            for sha, identity in ((target_sha, target_image), (previous_sha, previous_image)):
                self.assertEqual(adapter.apply_api(sha, identity), {"settled": True, "succeeded": True})
                self.readiness()
                container = self.inspect("kin-api")
                self.assertNotEqual(container["Id"], before)
                pre.check_running_api(container, identity)
                self.assertEqual(container["Config"]["Labels"]["kin.deploy.release"], sha)
                self.assertEqual(self.git("rev-parse", "HEAD"), sha)
                self.assertEqual(self.inspect(self.db)["Id"], database_id)
                self.assertEqual(self.psql("SELECT value FROM host_probe;"), "preserved")
                self.assertEqual(self.psql('SELECT migration_name,checksum,finished_at FROM "_prisma_migrations";'), migration)
                before = container["Id"]
        print(json.dumps({"actual_api_replacements": 2, "database_preserved": True, "migration_preserved": True,
                          "full_product_https_smoke": False, "smtp_sent": False}), flush=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
