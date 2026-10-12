"""CI-only real API replacement/return, Prisma and DB preservation.

Refuses existing kin-api/kin-proxy. All data/config are disposable; full HTTPS
authentication/frame contracts are separately exercised by ops_deploy_host_test.
This test calls apply_api directly, never substitutes synthetic smoke for a
successful operational deployment. No SMTP or operational approval is used.

EmrIntroductionRehearsal (INTERIM-RELEASE-TOOLS, opt-in: KIN_TEST_EMR_REHEARSAL=1 with the four images below) is the
fully synthetic rehearsal of the EMR-introduction release mode on a local Docker daemon, with the product's own compose
files at the previous (Stage-5-shaped) and target commits. A source stack S stands in for production: it starts the
previous release with a synthetic realm, a synthetic study row and a disabled member, and the mode's capture phase takes
B0 from it. S is then removed. A clone stack C (other names, other secrets, its own Keycloak administrator) is seeded
from that B0 copy and runs seed -> capture -> introduce (provision, installer migration, Keycloak cache option, member
import, API as node/kin_runtime, UI/proxy) -> verify (fenced HTTPS smoke with a test-minted token, the EMR probe, B1 and
its same-point restore) -> rollback (B0 into fresh recovery volumes, previous images) -> receipt; the receipt is then
checked as production's introduce would check it. Every resource is named kin-rehearsal-*, labelled and removed.
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
import importlib.util

_spec = importlib.util.spec_from_file_location("emr_compose", Path(__file__).resolve().parents[1] / "scripts" / "emr-compose.py")
emr_compose = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(emr_compose)


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

    def remove_volume(self, name):
        result = subprocess.run(["docker", "volume", "inspect", name], capture_output=True, timeout=30)
        if result.returncode:
            self.command(["docker", "info", "--format", "{{.ServerVersion}}"])
            return
        item = json.loads(result.stdout)[0]
        self.assertEqual((item.get("Labels") or {}).get("kin.ops.run"), self.token)
        self.command(["docker", "volume", "rm", item["Name"]])

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
        # EMR-B1: the server holds only the runtime role (trust authentication in this internal fixture network) and its
        # state volume; the installer credential migrates once, in its own container, before the server exists.
        env = {"DATABASE_URL": "postgresql://kin_runtime@" + self.db + ":5432/kin", "KIN_EMR_STATE_DIR": pre.EMR_STATE,
               "DEPLOYMENT_MODE": "production", "AUTH_REQUIRED": "true",
               "KC_ISSUER": "http://127.0.0.1:1/auth/realms/kin", "KC_JWKS_URL": "http://127.0.0.1:1/certs",
               "KC_AUDIENCE": "kin-api", "KC_WEB_SECRET": uuid.uuid4().hex, "KIN_COOKIE_SECRET": uuid.uuid4().hex,
               "PUBLIC_ORIGIN": "http://127.0.0.1:3000", "ORTHANC_USER": "synthetic-fixture", "ORTHANC_PASS": uuid.uuid4().hex,
               "KC_ADMIN_URL": "http://127.0.0.1:1/auth", "KC_REALM": "kin", "KC_CLIENT_ID": "kin-api", "KC_CLIENT_SECRET": uuid.uuid4().hex}
        state_volume = self.network + "-emr-state"
        compose = {"name": self.network, "services": {"api": {"container_name": "kin-api", "image": previous_image,
                   "environment": env, "labels": {"kin.ops.run": self.token}, "networks": ["fixture"],
                   "volumes": ["emr-state:" + pre.EMR_STATE]}},
                   "networks": {"fixture": {"external": True, "name": self.network}},
                   "volumes": {"emr-state": {"name": state_volume, "labels": {"kin.ops.run": self.token}}}}
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
                      "--network", self.network, "--tmpfs", "/var/lib/postgresql/data",
                      "--tmpfs", "/var/lib/postgresql/emr-access:uid=70,gid=70,mode=0700", "-e", "POSTGRES_HOST_AUTH_METHOD=trust",
                      "-e", "POSTGRES_DB=kin", "postgres:16-alpine"])
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            result = subprocess.run(["docker", "exec", self.db, "pg_isready", "-U", "postgres"], capture_output=True, timeout=10)
            if result.returncode == 0:
                break
            time.sleep(0.5)
        else:
            self.fail("Disposable database readiness timed out")
        self.addCleanup(self.remove_volume, state_volume)
        self.command(["docker", "exec", "-u", "postgres", self.db, "mkdir", "-m", "700", "/var/lib/postgresql/emr-access/ts"])
        self.command(["docker", "exec", "-i", "-e", "KIN_EMR_RUNTIME_PASSWORD=" + uuid.uuid4().hex, self.db, "psql", "-X", "-U", "postgres",
                      "-d", "kin"], input=emr_compose.PROVISION_SQL.encode())
        self.command(["docker", "run", "--rm", "--label", "kin.ops.run=" + self.token, "--network", self.network,
                      "-e", "DATABASE_URL=postgresql://postgres@" + self.db + ":5432/kin", previous_image,
                      "sh", "/app/start-production.sh", "migrate"], timeout=180)
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
            history_query = 'SELECT migration_name,checksum,finished_at FROM "_prisma_migrations" ORDER BY migration_name COLLATE "C";'
            migration = self.psql(history_query)
            self.assertTrue(migration.startswith("0_init|"))
            adapter.authorize(plan)
            self.assertTrue(adapter.observe(plan)["preflight_passed"])
            for sha, identity in ((target_sha, target_image), (previous_sha, previous_image)):
                self.assertEqual(adapter.apply_api(sha, identity), {"settled": True, "succeeded": True})
                self.readiness()
                container = self.inspect("kin-api")
                self.assertNotEqual(container["Id"], before)
                pre.check_running_api(container, identity, emr=True)
                self.assertEqual(container["Config"]["Labels"]["kin.deploy.release"], sha)
                self.assertEqual(self.git("rev-parse", "HEAD"), sha)
                self.assertEqual(self.inspect(self.db)["Id"], database_id)
                self.assertEqual(self.psql("SELECT value FROM host_probe;"), "preserved")
                self.assertEqual(self.psql(history_query), migration)
                before = container["Id"]
        print(json.dumps({"actual_api_replacements": 2, "database_preserved": True, "migration_preserved": True,
                          "full_product_https_smoke": False, "smtp_sent": False}), flush=True)


# ── EMR introduction: fully synthetic rehearsal (opt-in) ──

import copy  # noqa: E402
import hashlib  # noqa: E402
import secrets  # noqa: E402
import socket  # noqa: E402
from datetime import datetime, timedelta, timezone  # noqa: E402
from types import SimpleNamespace  # noqa: E402

import ops_emr_introduction as intro  # noqa: E402

REHEARSAL_IMAGES = ("KIN_TEST_PREVIOUS_API_IMAGE", "KIN_TEST_PREVIOUS_PROXY_IMAGE", "KIN_TEST_API_IMAGE", "KIN_TEST_PROXY_IMAGE")
SYNTHETIC_STUDY = "1.2.826.0.1.3680043.10.543.7001"
KC_SCRIPT = r"""
const base='http://keycloak:8080/auth', admin=async()=>{const form=new URLSearchParams({grant_type:'password',client_id:'admin-cli',
 username:process.env.KC_USER,password:process.env.KC_PASS});const r=await fetch(base+'/realms/master/protocol/openid-connect/token',{method:'POST',body:form});
 if(r.status!==200)throw new Error('admin token '+r.status);return (await r.json()).access_token;};
const call=async(token,method,path,body)=>{const r=await fetch(base+'/admin/realms/kin'+path,{method,headers:{Authorization:'Bearer '+token,
 'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});if(r.status>=300)throw new Error(method+' '+path+' '+r.status);
 const text=await r.text();return text?JSON.parse(text):null;};
(async()=>{const token=await admin();const [user]=await call(token,'GET','/users?exact=true&username='+process.env.KC_MEMBER);
 if(process.argv[1]==='disable'){await call(token,'PUT','/users/'+user.id,{enabled:false});process.stdout.write('KIN_RESULT {"disabled":true}\n');return;}
 const clientId='kin-rehearsal-smoke-'+Date.now();
 await call(token,'POST','/clients',{clientId,enabled:true,publicClient:true,standardFlowEnabled:false,directAccessGrantsEnabled:true,protocol:'openid-connect',
  protocolMappers:[{name:'kin-api-audience',protocol:'openid-connect',protocolMapper:'oidc-audience-mapper',config:{'included.custom.audience':'kin-api','access.token.claim':'true','id.token.claim':'false'}},
   {name:'kin-institution-groups',protocol:'openid-connect',protocolMapper:'oidc-group-membership-mapper',config:{'full.path':'false','access.token.claim':'true','id.token.claim':'false','userinfo.token.claim':'false','claim.name':'groups'}},
   {name:'kin-authentication-time',protocol:'openid-connect',protocolMapper:'oidc-usersessionmodel-note-mapper',config:{'user.session.note':'AUTH_TIME','claim.name':'auth_time','jsonType.label':'long','access.token.claim':'true','id.token.claim':'true'}}]});
 await call(token,'PUT','/users/'+user.id+'/reset-password',{type:'password',value:process.env.KC_MEMBER_PASS,temporary:false});
 await call(token,'PUT','/users/'+user.id,{requiredActions:[],emailVerified:true});
 const form=new URLSearchParams({grant_type:'password',client_id:clientId,username:process.env.KC_MEMBER,password:process.env.KC_MEMBER_PASS,scope:'openid'});
 const r=await fetch(base+'/realms/kin/protocol/openid-connect/token',{method:'POST',body:form});if(r.status!==200)throw new Error('member token '+r.status);
 const access=(await r.json()).access_token;const payload=JSON.parse(Buffer.from(access.split('.')[1],'base64url').toString());
 process.stdout.write('KIN_RESULT '+JSON.stringify({access_token:access,subject:payload.sub})+'\n');})().catch(e=>{process.stderr.write(String(e.message)+'\n');process.exitCode=1;});
"""


def free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def blob(repo, sha, path):
    return subprocess.run(["git", "-C", str(repo), "cat-file", "blob", sha + ":" + path], check=True, capture_output=True).stdout


def migrations(repo, sha):
    listing = subprocess.run(["git", "-C", str(repo), "ls-tree", "--name-only", sha + ":api/prisma/migrations"], check=True,
                             capture_output=True, text=True).stdout.split()
    return [[name, hashlib.sha256(blob(repo, sha, "api/prisma/migrations/" + name + "/migration.sql")).hexdigest()]
            for name in sorted(listing) if name != "migration_lock.toml"]


class SyntheticStack:
    """One disposable product stack: a clone of this repository, its own names, secrets, ports and records."""

    def __init__(self, test, root, label, previous_sha, target_sha):
        self.test, self.label = test, label
        self.token = uuid.uuid4().hex[:10]
        self.project = "kin-rehearsal-" + label + "-" + self.token
        self.root = root / label
        self.root.mkdir()
        self.repo = self.root / "repo"
        source = Path(__file__).resolve().parents[1]
        # --shared: the disposable clone reads the source object store (never written, never garbage-collected here).
        subprocess.run(["git", "-c", "safe.directory=*", "clone", "-q", "-c", "core.autocrlf=false", "--shared", "--no-checkout",
                        str(source), str(self.repo)], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(self.repo), "-c", "advice.detachedHead=false", "checkout", "-q", "--detach", previous_sha],
                       check=True, capture_output=True)
        self.public = free_port()
        self.maintenance = free_port()
        while self.maintenance == self.public:
            self.maintenance = free_port()
        self.origin = "https://localhost:" + str(self.public)
        names = {role: self.project + "-" + role for role in (*intro.ROLES, *intro.ONE_SHOTS)}
        self.ca = self.root / "clone-ca.pem"
        self.override_path = self.root / "rehearsal-override.yml"
        self.target = {"schema": 1, "kind": "rehearsal", "host_key_sha256": "b" * 64, "origin": self.origin, "project": self.project,
                       "repository": str(self.repo),
                       "compose_files": ["docker-compose.yml", "docker-compose.prod.yml", str(self.override_path)],
                       "containers": names,
                       "volumes": {"pg": self.project + "_pg-db", "orthanc": self.project + "_orthanc-db",
                                   "emr_access": self.project + "_emr-access", "emr_state": self.project + "_emr-state"},
                       "networks": {"default": self.project + "_default", "workflow": self.project + "-workflow"},
                       "ports": {"maintenance": "127.0.0.1:%d:443" % self.maintenance, "public": ["127.0.0.1:%d:443" % self.public]},
                       "tls_certificate": "/etc/nginx/certs/kin.crt", "cron": None, "ca_file": str(self.ca),
                       "keycloak_admin": "kin-clone-admin" if label == "clone" else "admin"}
        intro.target_valid(self.target)
        self.override_path.write_text(intro.rehearsal_override(self.target, self.origin), encoding="utf-8", newline="\n")
        self.env = {"POSTGRES_PASSWORD": secrets.token_urlsafe(24), "KC_ADMIN_PASSWORD": secrets.token_urlsafe(24),
                    "KC_CLIENT_SECRET": secrets.token_urlsafe(24), "KC_WEB_SECRET": secrets.token_urlsafe(24),
                    "KIN_COOKIE_SECRET": secrets.token_urlsafe(24), "ORTHANC_PASS": secrets.token_urlsafe(24),
                    "PUBLIC_ORIGIN": self.origin, "KIN_REVISION": previous_sha}
        self.write_env(self.repo / ".env", self.env)
        self.env_next = self.root / "env.next"
        self.write_env(self.env_next, {**self.env, "KIN_EMR_RUNTIME_PASSWORD": secrets.token_urlsafe(32)})
        self.token_file = self.root / "smoke-token.json"
        self.records = intro.Records(self.root / "records")
        self.backups = self.root / "backups"
        self.previous_sha, self.target_sha = previous_sha, target_sha
        test.addCleanup(self.remove)
        test.addCleanup(self.keep_records)

    def keep_records(self):
        """KIN_TEST_EMR_REHEARSAL_EVIDENCE: copy this stack's run records (journal, step results, one-shot logs; synthetic
        values only) out of the temporary folder before it is removed."""
        target = os.environ.get("KIN_TEST_EMR_REHEARSAL_EVIDENCE")
        if target and self.records.directory.exists():
            __import__("shutil").copytree(self.records.directory, Path(target) / ("records-" + self.label), dirs_exist_ok=True)

    @staticmethod
    def write_env(path, values):
        path.write_bytes("".join(f"{key}={value}\n" for key, value in values.items()).encode())
        if os.name == "posix":
            path.chmod(0o600)

    def plan(self, images, seed=None):
        def digest(sha, env_path):
            entries = [(item, blob(self.repo, sha, item) if not os.path.isabs(item) else Path(item).read_bytes())
                       for item in self.target["compose_files"]]
            return intro.compose_digest([*entries, (".env", env_path.read_bytes())])
        uid = lambda image, user, flag: int(subprocess.run(["docker", "run", "--rm", "--network", "none", "--entrypoint", "id", image, flag, user],
                                                           check=True, capture_output=True, text=True).stdout.strip())
        now = datetime.now(timezone.utc)
        plan = {"schema": 1, "mode": intro.MODE, "unit": "INTERIM-RELEASE-SYNTHETIC", "target_kind": "rehearsal",
                "target_manifest_sha256": hashlib.sha256(intro.canonical(self.target)).hexdigest(),
                "previous": {"sha": self.previous_sha, "images": dict(images["previous"])},
                "release": {"sha": self.target_sha, "images": dict(images["release"])},
                "compose": {"before_sha256": digest(self.previous_sha, self.repo / ".env"), "after_sha256": digest(self.target_sha, self.env_next)},
                "secrets": {"required": ["POSTGRES_PASSWORD", "KIN_EMR_RUNTIME_PASSWORD", "KC_ADMIN_PASSWORD", "KC_CLIENT_SECRET",
                                         "KC_WEB_SECRET", "KIN_COOKIE_SECRET", "ORTHANC_PASS"],
                            "absent": ["KIN_EMR_READER_PASSWORD", "KIN_EMR_RETENTION_PASSWORD"], "runtime": "KIN_EMR_RUNTIME_PASSWORD",
                            "installer": "POSTGRES_PASSWORD", "logins": {"kin_emr_reader": False, "kin_emr_retention": False},
                            "env_next_sha256": hashlib.sha256(self.env_next.read_bytes()).hexdigest()},
                "migrations": {"before": migrations(self.repo, self.previous_sha), "after": migrations(self.repo, self.target_sha)},
                "storage": {"tablespace_path": intro.TABLESPACE, "postgres_uid": uid(images["release"]["db"], "postgres", "-u"),
                            "postgres_gid": uid(images["release"]["db"], "postgres", "-g"),
                            "node_uid": uid(images["release"]["api"], "node", "-u"), "node_gid": uid(images["release"]["api"], "node", "-g")},
                "smoke": {"frame": None},
                "probe": {"study": "SYNTHETIC-rehearsal-" + self.token, "event_id": str(uuid.uuid4()), "institution": "kin-center",
                          "approved_by": "synthetic-rehearsal", "approved_at": now.isoformat()},
                "window": {"start": (now - timedelta(hours=1)).isoformat(), "end": (now + timedelta(hours=8)).isoformat()},
                "budget": {"capture_s": 3600, "introduce_s": 5400, "verify_s": 3600, "reopen_s": 1800, "rollback_s": 3600, "seed_s": 3600,
                           "min_free_bytes": 1024 ** 3},
                "backup_root": str(self.backups), "tool": intro.tool_hashes(),
                "seed": seed or {"b0_dir": str(self.root / "unused-seed"), "b0_manifest_sha256": "0" * 64}, "projection_exempt": []}
        self.plan_document = intro.plan_valid(plan)
        self.plan_sha256 = hashlib.sha256(intro.canonical(plan)).hexdigest()
        return plan

    def ops(self):
        runner = intro.Runner(self.repo)
        return runner, intro.HostOps(target=self.target, plan=self.plan_document, runner=runner, records=self.records, env_next=self.env_next,
                                     token_reader=lambda: json.loads(self.token_file.read_text()))

    def phase(self, phase, expected):
        runner, host_ops = self.ops()
        machine = intro.Introduction(plan=self.plan_document, plan_sha256=self.plan_sha256, target=self.target,
                                     production=copy.deepcopy(intro.EXAMPLE_POLICY["production"]) | {"host_key_sha256": "a" * 64},
                                     ops=host_ops, records=self.records, repository=self.repo, host_key="b" * 64, tool=intro.tool_hashes())
        request = {"version": 1, "mode": intro.MODE, "phase": phase, "plan_sha256": self.plan_sha256, "nonce": uuid.uuid4().hex}
        started = time.monotonic()
        with intro.bound_ops(self.repo, runner):
            result = machine.run(request, hashlib.sha256(intro.canonical(request)).hexdigest())
        summary = {"stack": self.label, "phase": phase, "status": result["status"], "seconds": round(time.monotonic() - started, 1),
                   "steps": result["steps"]}
        print(json.dumps(summary), flush=True)
        self.test.assertEqual(result["status"], expected, json.dumps(result)[:4000])
        return result

    def compose_up(self, images, roles):
        """Test-side bring-up of the source stack (the stand-in for a running Stage-5 host)."""
        runner, host_ops = self.ops()
        context = SimpleNamespace(state={"checkout": "previous"}, plan={"previous": {"sha": self.previous_sha, "images": images}})
        with intro.bound_ops(self.repo, runner):
            for role in roles:
                host_ops.compose(["up", "-d", "--no-deps", "--no-build", "--pull", "never", role],
                                 override=host_ops.pins(context, maintenance=False), timeout=300)
                if role == "db":
                    # As the product's installation does (tests/measurement_ci.py): Keycloak's database is created once.
                    host_ops.wait(lambda: host_ops.healthy("db"), 120, "Source database did not start")
                    host_ops.cmd(["docker", "exec", self.target["containers"]["db"], "createdb", "-U", "kin", "keycloak"])
            host_ops.api_health(member_rights=False)
        return host_ops

    def certificates(self, proxy_image):
        """The clone's own TLS certificate in its proxy volume before the first proxy start, and its CA file."""
        volume = self.project + "_proxy-certs"
        subprocess.run(["docker", "volume", "create", "--label", "com.docker.compose.project=" + self.project,
                        "--label", "com.docker.compose.volume=proxy-certs", "--label", "kin.ops.run=" + self.token, volume],
                       check=True, capture_output=True)
        subprocess.run(["docker", "run", "--rm", "--network", "none", "--mount", "type=volume,source=" + volume + ",target=/certs",
                        "--entrypoint", "sh", proxy_image, "-c",
                        "openssl req -x509 -nodes -newkey rsa:2048 -days 30 -keyout /certs/kin.key -out /certs/kin.crt "
                        "-subj /CN=localhost -addext subjectAltName=DNS:localhost,IP:127.0.0.1 2>/dev/null && chmod 600 /certs/kin.key"],
                       check=True, capture_output=True)
        pem = subprocess.run(["docker", "run", "--rm", "--network", "none", "--mount", "type=volume,source=" + volume + ",target=/certs,readonly",
                              "--entrypoint", "cat", proxy_image, "/certs/kin.crt"], check=True, capture_output=True).stdout
        self.ca.write_bytes(pem)

    def psql(self, sql, database="kin"):
        return subprocess.run(["docker", "exec", self.target["containers"]["db"], "psql", "-X", "-U", "kin", "-d", database, "-qAt", "-v",
                               "ON_ERROR_STOP=1", "-c", sql], check=True, capture_output=True, text=True).stdout.strip()

    def keycloak(self, image, operation, admin_user):
        """Test-side realm work through the admin REST API (as the executor would): Keycloak may still be starting."""
        environment = {**os.environ, "KC_USER": admin_user, "KC_PASS": self.env["KC_ADMIN_PASSWORD"],
                       "KC_MEMBER": "tech" if operation == "disable" else "doctor", "KC_MEMBER_PASS": secrets.token_urlsafe(18)}
        deadline = time.monotonic() + 420
        while True:
            result = subprocess.run(["docker", "run", "--rm", "--network", self.target["networks"]["default"], "--label", "kin.ops.run=" + self.token,
                                     "-e", "KC_USER", "-e", "KC_PASS", "-e", "KC_MEMBER", "-e", "KC_MEMBER_PASS", "--entrypoint", "node", image,
                                     "-e", KC_SCRIPT, operation], env=environment, capture_output=True, timeout=180)
            if result.returncode == 0 or time.monotonic() > deadline:
                break
            time.sleep(5)
        self.test.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace")[-1000:])
        return intro.result_line(result.stdout)

    def remove(self):
        """Only resources carrying this stack's compose project or its recovery label; never anything else."""
        def ids(kind, label):
            listing = ["docker", kind, "ls", "-q", "--filter", "label=" + label] if kind != "container" else \
                ["docker", "ps", "-a", "-q", "--filter", "label=" + label]
            return subprocess.run(listing, capture_output=True, text=True).stdout.split()
        project = "com.docker.compose.project=" + self.project
        for container in ids("container", project):
            subprocess.run(["docker", "rm", "-f", "-v", container], capture_output=True)
        for container in ids("container", "kin.ops.run=" + self.token):
            subprocess.run(["docker", "rm", "-f", "-v", container], capture_output=True)
        plan16 = getattr(self, "plan_sha256", "")[:16]
        volumes = ids("volume", project) + (ids("volume", "kin.ops.recovery=" + plan16) if plan16 else [])
        for volume in volumes:
            subprocess.run(["docker", "volume", "rm", volume], capture_output=True)
        for network in ids("network", project):
            subprocess.run(["docker", "network", "rm", network], capture_output=True)


@unittest.skipUnless(os.environ.get("KIN_TEST_EMR_REHEARSAL") == "1" and all(os.environ.get(name) for name in REHEARSAL_IMAGES),
                     "opt-in synthetic EMR-introduction rehearsal (KIN_TEST_EMR_REHEARSAL=1 and the four images)")
class EmrIntroductionRehearsal(unittest.TestCase):
    def image_id(self, reference):
        return json.loads(subprocess.run(["docker", "image", "inspect", reference], check=True, capture_output=True).stdout)[0]["Id"]

    def test_emr_introduction_rehearsal_seed_capture_introduce_verify_rollback_receipt(self):
        ops.require_local_docker()
        folder = tempfile.TemporaryDirectory(prefix="kin-emr-rehearsal-")
        self.addCleanup(folder.cleanup)
        root = Path(folder.name)
        previous_sha = os.environ.get("KIN_TEST_PREVIOUS_SHA", "b9690cc9790d5360829cee861462aac14f5ab0c7")
        source_repo = Path(__file__).resolve().parents[1]
        target_sha = os.environ.get("KIN_TEST_TARGET_SHA") or subprocess.run(["git", "-C", str(source_repo), "rev-parse", "HEAD"],
                                                                             check=True, capture_output=True, text=True).stdout.strip()
        shared = {"db": self.image_id("postgres:16-alpine"), "keycloak": self.image_id("quay.io/keycloak/keycloak:26.7.3"),
                  "orthanc": self.image_id("orthancteam/orthanc:24.12.0")}
        images = {"previous": {"api": self.image_id(os.environ["KIN_TEST_PREVIOUS_API_IMAGE"]),
                               "proxy": self.image_id(os.environ["KIN_TEST_PREVIOUS_PROXY_IMAGE"]), **shared},
                  "release": {"api": self.image_id(os.environ["KIN_TEST_API_IMAGE"]), "proxy": self.image_id(os.environ["KIN_TEST_PROXY_IMAGE"]), **shared}}

        # S: the stand-in for the running Stage-5 host, with synthetic data only.
        source = SyntheticStack(self, root, "source", previous_sha, target_sha)
        source.plan(images)
        source.certificates(images["previous"]["proxy"])
        source.compose_up(images["previous"], ("db", "keycloak", "orthanc", "api", "proxy"))
        source.psql('INSERT INTO "StudyState"(uid, "institutionId", rs, "preDoc", "preReviewer", "updatedAt") '
                    f"VALUES ('{SYNTHETIC_STUDY}', 'hallym', 'P', 'doctor@kin.kr', 'doctor2@kin.kr', now());"
                    " INSERT INTO \"AuditLog\"(actor, action, target, detail) VALUES ('SYNTHETIC-rehearsal', 'synthetic.seed', "
                    f"'{SYNTHETIC_STUDY}', '{{\"synthetic\":true}}');")
        source.keycloak(images["previous"]["api"], "disable", "admin")
        source.phase("capture", "HELD")
        b0 = json.loads((source.records.directory / "state.json").read_text())["b0"]
        source.remove()

        # C: the disposable clone, seeded from S's B0 copy (no S resource is reachable any more).
        clone = SyntheticStack(self, root, "clone", previous_sha, target_sha)
        copy_dir = root / "b0-copy" / Path(b0["dir"]).name
        shutil_copy = __import__("shutil").copytree
        shutil_copy(b0["dir"], copy_dir)
        clone.plan(images, seed={"b0_dir": str(copy_dir), "b0_manifest_sha256": b0["manifest_sha256"]})
        clone.certificates(images["previous"]["proxy"])
        clone.phase("seed", "SEEDED")
        self.assertEqual(clone.psql(f"SELECT \"preDoc\" FROM \"StudyState\" WHERE uid='{SYNTHETIC_STUDY}';"), "doctor@kin.kr")
        clone.phase("capture", "HELD")
        clone.phase("introduce", "INTRODUCED")
        realm = "(SELECT id FROM realm WHERE name='kin')"
        self.assertEqual(clone.psql(f"SELECT enabled FROM user_entity WHERE username='tech' AND realm_id={realm};", "keycloak"), "t")
        self.assertEqual(clone.psql("SELECT suspended FROM \"MemberRights\" WHERE username='tech';"), "t")
        self.assertEqual(clone.psql(f"SELECT \"preDocSub\" IS NOT NULL FROM \"StudyState\" WHERE uid='{SYNTHETIC_STUDY}';"), "t")
        token = clone.keycloak(images["release"]["api"], "token", clone.target["keycloak_admin"])
        clone.token_file.write_text(json.dumps(token))
        claims = json.loads(__import__("base64").urlsafe_b64decode(token["access_token"].split(".")[1] + "=="))
        rights = clone.psql("SELECT json_build_object('suspended', suspended, 'approved', approved, 'newAuthAfter', "
                            "extract(epoch from \"newAuthAfter\")) FROM \"MemberRights\" WHERE username='doctor';")
        print(json.dumps({"token_claims": sorted(claims), "auth_time": claims.get("auth_time"), "iss": claims.get("iss"),
                          "aud": claims.get("aud"), "doctor_rights": json.loads(rights or "null")}), flush=True)
        verified = clone.phase("verify", "VERIFIED")
        self.assertEqual(verified["probe"]["receipt"]["eventId"], clone.plan_document["probe"]["event_id"])
        clone.phase("rollback", "ROLLED_BACK")
        state = json.loads((clone.records.directory / "state.json").read_text())
        # Back at the same pre-EMR point: history, data, realm (kin and keycloak together) and the previous images.
        rows = json.loads(clone.psql("SELECT json_agg(json_build_array(migration_name, checksum, finished_at IS NOT NULL, rolled_back_at IS NOT NULL)"
                                     " ORDER BY migration_name COLLATE \"C\") FROM \"_prisma_migrations\";"))
        pre.check_migration_rows(rows, clone.plan_document["migrations"]["before"])
        self.assertEqual(clone.psql(f"SELECT enabled FROM user_entity WHERE username='tech' AND realm_id={realm};", "keycloak"), "f")
        self.assertEqual(clone.psql("SELECT count(*) FROM pg_roles WHERE rolname LIKE 'kin_emr_%' OR rolname='kin_runtime';"), "0")
        api = json.loads(subprocess.run(["docker", "inspect", clone.target["containers"]["api"]], check=True, capture_output=True).stdout)[0]
        self.assertEqual(api["Image"], images["previous"]["api"])
        db = json.loads(subprocess.run(["docker", "inspect", clone.target["containers"]["db"]], check=True, capture_output=True).stdout)[0]
        self.assertEqual({m["Destination"]: m.get("Name") for m in db["Mounts"]}["/var/lib/postgresql/data"], state["recovery"]["pg"])
        for name in (clone.target["volumes"]["pg"], clone.target["volumes"]["emr_access"], clone.target["volumes"]["emr_state"]):
            self.assertEqual(subprocess.run(["docker", "volume", "inspect", name], capture_output=True).returncode, 0, "failed volume kept: " + name)
        result = clone.phase("receipt", "RECEIPTED")
        receipt = json.loads((clone.records.directory / "local-restore-receipt.json").read_text())
        production_plan = copy.deepcopy(clone.plan_document)
        production_plan.update(target_kind="production", seed=None,
                               smoke={"frame": {"path": "/dicom-web/studies/1.2/series/1.3/instances/1.4/frames/1", "bytes": 1, "sha256": "0" * 64}})
        intro.plan_valid(production_plan)
        intro.receipt_valid(receipt, production_plan, b0["manifest_sha256"], {**intro.EXAMPLE_POLICY["production"], "host_key_sha256": "a" * 64})
        print(json.dumps({"synthetic_rehearsal": "PASS", "receipt_sha256": result["receipt"]["sha256"],
                          "source_b0_manifest_sha256": b0["manifest_sha256"], "b1_manifest_sha256": state["b1"]["manifest_sha256"],
                          "bfail": state["bfail"]["manifest_sha256"], "recovery": state["recovery"],
                          "migrations": [len(clone.plan_document["migrations"]["before"]), len(clone.plan_document["migrations"]["after"])]}),
              flush=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
