"""CI-only real API replacement/return, Prisma and DB preservation.

Refuses existing kin-api/kin-proxy. All data/config are disposable; full HTTPS
authentication/frame contracts are separately exercised by ops_deploy_host_test.
This test calls apply_api directly, never substitutes synthetic smoke for a
successful operational deployment. No SMTP or operational approval is used.

EmrIntroductionRehearsal (INTERIM-RELEASE-TOOLS, opt-in: KIN_TEST_EMR_REHEARSAL=1 with the four images below) is the
fully synthetic rehearsal of the EMR-introduction release mode on a local Docker daemon, with the product's own compose
files at the previous (Stage-5-shaped) and target commits. A source stack S stands in for production: it starts the
previous release with a synthetic realm, a synthetic study (row and one DICOM instance whose frame is every plan's smoke
frame), further NOLOGIN roles with a membership, an owned schema and grants, and a disabled member; the mode's capture
phase takes B0 from it. S is then removed. A clone stack C (other names, other secrets, its own Keycloak administrator)
is seeded from that B0 copy and runs seed -> capture -> introduce (provision, installer migration, Keycloak cache option,
member import, API as node/kin_runtime, UI/proxy) -> verify (fenced HTTPS smoke with an interactive login, worklist UID
and frame bytes, the EMR probe, B1 and its same-point restore) -> rollback (B0 into fresh recovery volumes of a recovery
project, previous images; RESTORED) -> rollback_reopen (refused with the pre-restore token, then passed with a login made
after the restore) -> an ordinary compose recreate (still the recovery volumes and previous images) -> receipt; the
receipt is then checked as production's introduce would check it (and refused a second time). Every resource is named
kin-rehearsal-*, labelled and removed.

RELEASE-TOOLS-CHECKPOINTS (Astra spec D1336): the three rehearsal methods are written as an explicit stage table
(STAGE_METHODS, run by tests/ops_release_checkpoints.run_scenario) and still run whole, in one process, under the live
gate (scripts/run-tests.py); a checkpoint request in their environment refuses them. SyntheticStack.descriptor/restored
and CheckpointDocker serve tests/ops_release_checkpoints_live_test.CheckpointSegments only (opt-in, native Linux).
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

    def database_ready(self, seconds):
        """Synchronisation only: the image's first boot runs initdb, then a temporary server on the Unix socket alone
        (listen_addresses=''), creates POSTGRES_DB, stops it and starts the final server, the only one on TCP. pg_isready
        over the socket already answers the temporary server before kin exists (runtime jobs 116188557336/116220212621:
        'database "kin" does not exist'), so wait for the final server over TCP and for the database row, as the
        product's db_ready and the other harnesses do."""
        deadline, last = time.monotonic() + seconds, ""
        while time.monotonic() < deadline:
            try:
                self.command(["docker", "exec", self.db, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"], timeout=10)
                if self.command(["docker", "exec", self.db, "psql", "-X", "-h", "127.0.0.1", "-U", "postgres", "-d", "postgres",
                                 "-Atc", "SELECT 1 FROM pg_database WHERE datname='kin'"], timeout=10) == "1":
                    return
                last = "database kin is not listed yet"
            except (RuntimeError, subprocess.TimeoutExpired) as error:
                last = str(error)[-500:]
            time.sleep(1)
        raise RuntimeError("Disposable database did not reach its final server with database kin within %d s: %s" % (seconds, last))

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
        self.network = os.environ.get("KIN_TEST_RESOURCE_PREFIX", "kin-rehearsal-") + self.token[:16]
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
        self.database_ready(120)
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
import ops_audit_integrity as audit  # noqa: E402
import live_test_gate  # noqa: E402
import ops_release_checkpoints as checkpoints  # noqa: E402

REHEARSAL_IMAGES = ("KIN_TEST_PREVIOUS_API_IMAGE", "KIN_TEST_PREVIOUS_PROXY_IMAGE", "KIN_TEST_API_IMAGE", "KIN_TEST_PROXY_IMAGE")
SYNTHETIC_STUDY = "1.2.826.0.1.3680043.10.543.7001"
SYNTHETIC_SERIES, SYNTHETIC_SOP = SYNTHETIC_STUDY + ".1", SYNTHETIC_STUDY + ".1.1"
# One synthetic 16x16 16-bit CT frame: the smoke frame of every plan (forward and previous-version smoke read it).
SYNTHETIC_PIXELS = bytes(range(256)) * 2
SYNTHETIC_FRAME = {"path": "/dicom-web/studies/%s/series/%s/instances/%s/frames/1" % (SYNTHETIC_STUDY, SYNTHETIC_SERIES, SYNTHETIC_SOP),
                   "bytes": len(SYNTHETIC_PIXELS), "sha256": hashlib.sha256(SYNTHETIC_PIXELS).hexdigest()}
# Further pre-EMR roles the B0 must carry through seed and rollback (IRT-07): NOLOGIN, a membership, an owned schema,
# a table grant and a database grant.
LEGACY_ROLES_SQL = ("CREATE ROLE kin_legacy_group NOLOGIN NOINHERIT; CREATE ROLE kin_legacy_reader NOLOGIN CONNECTION LIMIT 3; "
                    "GRANT kin_legacy_group TO kin_legacy_reader; GRANT SELECT ON \"AuditLog\" TO kin_legacy_reader; "
                    "CREATE SCHEMA legacy_archive AUTHORIZATION kin_legacy_group; GRANT CONNECT ON DATABASE kin TO kin_legacy_reader; "
                    # D22: a column grant and a type's privileges the exact restore must carry too.
                    "GRANT SELECT (actor) ON \"AuditLog\" TO kin_legacy_group; CREATE TYPE legacy_archive.kin_legacy_mood AS ENUM ('a', 'b'); "
                    "REVOKE USAGE ON TYPE legacy_archive.kin_legacy_mood FROM PUBLIC; GRANT USAGE ON TYPE legacy_archive.kin_legacy_mood TO kin_legacy_reader;")
LEGACY_FACTS_SQL = ("SELECT json_build_object("
                    "'roles', (SELECT json_agg(json_build_array(rolname, rolcanlogin, rolinherit, rolconnlimit) ORDER BY rolname) "
                    "FROM pg_roles WHERE rolname LIKE 'kin_legacy_%'), "
                    "'members', (SELECT json_agg(a.rolname || '>' || b.rolname) FROM pg_auth_members m JOIN pg_roles a ON a.oid=m.roleid "
                    "JOIN pg_roles b ON b.oid=m.member WHERE a.rolname LIKE 'kin_legacy_%'), "
                    "'schema_owner', (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='legacy_archive'), "
                    "'table_acl', (SELECT relacl::text FROM pg_class WHERE relname='AuditLog' AND relnamespace='public'::regnamespace), "
                    "'column_acl', (SELECT attacl::text FROM pg_attribute WHERE attrelid='public.\"AuditLog\"'::regclass AND attname='actor'), "
                    "'type_acl', (SELECT typacl::text FROM pg_type WHERE typname='kin_legacy_mood'), "
                    "'database_acl', (SELECT datacl::text FROM pg_database WHERE datname='kin'))")
UPLOAD_SCRIPT = r"""
import base64, json, os, sys, urllib.request
password = json.loads(os.environ['ORTHANC__REGISTERED_USERS'])['admin']
request = urllib.request.Request('http://127.0.0.1:8042/instances', data=sys.stdin.buffer.read(), method='POST',
    headers={'Content-Type': 'application/dicom', 'Authorization': 'Basic ' + base64.b64encode(('admin:' + password).encode()).decode()})
print(json.loads(urllib.request.urlopen(request, timeout=30).read())['Status'])
"""


def synthetic_dicom():
    """The synthetic study's one instance (pydicom, as the product's tests make theirs)."""
    import io
    from pydicom.dataset import FileDataset, FileMetaDataset
    from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID, meta.MediaStorageSOPInstanceUID, meta.TransferSyntaxUID = CTImageStorage, SYNTHETIC_SOP, ExplicitVRLittleEndian
    data = FileDataset(None, {}, file_meta=meta, preamble=b"\0" * 128)
    data.SOPClassUID, data.SOPInstanceUID = CTImageStorage, SYNTHETIC_SOP
    data.StudyInstanceUID, data.SeriesInstanceUID = SYNTHETIC_STUDY, SYNTHETIC_SERIES
    data.PatientName, data.PatientID, data.Modality, data.StudyDate = "SYNTHETIC^REHEARSAL", "SYNTHETIC-RH", "CT", "20261012"
    data.InstitutionName, data.SeriesNumber, data.InstanceNumber = "hallym", 1, 1
    data.Rows = data.Columns = 16
    data.BitsAllocated, data.BitsStored, data.HighBit, data.PixelRepresentation = 16, 16, 15, 0
    data.SamplesPerPixel, data.PhotometricInterpretation = 1, "MONOCHROME2"
    data.PixelData = SYNTHETIC_PIXELS
    data.is_little_endian, data.is_implicit_VR = True, False
    stream = io.BytesIO()
    data.save_as(stream, write_like_original=False)
    return stream.getvalue()
KC_SCRIPT = r"""
const base='http://keycloak:8080/auth', admin=async()=>{const form=new URLSearchParams({grant_type:'password',client_id:'admin-cli',
 username:process.env.KC_USER,password:process.env.KC_PASS});const r=await fetch(base+'/realms/master/protocol/openid-connect/token',{method:'POST',body:form});
 if(r.status!==200)throw new Error('admin token '+r.status);return (await r.json()).access_token;};
const call=async(token,method,path,body)=>{const r=await fetch(base+'/admin/realms/kin'+path,{method,headers:{Authorization:'Bearer '+token,
 'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});if(r.status>=300)throw new Error(method+' '+path+' '+r.status);
 const text=await r.text();return text?JSON.parse(text):null;};
(async()=>{const token=await admin();
 if(process.argv[1]==='origin'){
  // The stand-in for production's realm, which names its own origin: the BFF client's callback at this stack's origin.
  const [client]=await call(token,'GET','/clients?clientId=kin-bff');
  const redirectUris=[...new Set([...(client.redirectUris||[]),process.env.KC_ORIGIN+'/api/auth/callback'])];
  await call(token,'PUT','/clients/'+client.id,{...client,redirectUris});
  process.stdout.write('KIN_RESULT {"origin":true}\n');return;}
 const [user]=await call(token,'GET','/users?exact=true&username='+process.env.KC_MEMBER);
 if(process.argv[1]==='disable'){await call(token,'PUT','/users/'+user.id,{enabled:false});process.stdout.write('KIN_RESULT {"disabled":true}\n');return;}
 // A temporary PKCE client for one real authorization-code login: Keycloak 26.7.3 direct grants never carry the
 // authentication time (AUTH_TIME) that the product requires after the member import (newAuthAfter).
 const clientId='kin-rehearsal-smoke-'+Date.now();
 await call(token,'POST','/clients',{clientId,enabled:true,publicClient:true,standardFlowEnabled:true,directAccessGrantsEnabled:false,protocol:'openid-connect',
  redirectUris:[process.env.KC_REDIRECT],attributes:{'pkce.code.challenge.method':'S256'},
  protocolMappers:[{name:'kin-api-audience',protocol:'openid-connect',protocolMapper:'oidc-audience-mapper',config:{'included.custom.audience':'kin-api','access.token.claim':'true','id.token.claim':'false'}},
   {name:'kin-institution-groups',protocol:'openid-connect',protocolMapper:'oidc-group-membership-mapper',config:{'full.path':'false','access.token.claim':'true','id.token.claim':'false','userinfo.token.claim':'false','claim.name':'groups'}},
   {name:'kin-authentication-time',protocol:'openid-connect',protocolMapper:'oidc-usersessionmodel-note-mapper',config:{'user.session.note':'AUTH_TIME','claim.name':'auth_time','jsonType.label':'long','access.token.claim':'true','id.token.claim':'true'}}]});
 await call(token,'PUT','/users/'+user.id+'/reset-password',{type:'password',value:process.env.KC_MEMBER_PASS,temporary:false});
 await call(token,'PUT','/users/'+user.id,{requiredActions:[],emailVerified:true});
 process.stdout.write('KIN_RESULT '+JSON.stringify({client_id:clientId})+'\n');})().catch(e=>{process.stderr.write(String(e.message)+'\n');process.exitCode=1;});
"""


def interactive_token(origin, connect, ca_file, client_id, username, password):
    """One real Authorization Code + PKCE login through the clone's fenced (loopback) ingress, as tests/invariants_live.py
    does through its proxy: Keycloak supplies auth_time itself. Returns {"access_token", "subject"} for the mode's smoke."""
    import base64
    import html
    import re
    import ssl
    from urllib.parse import parse_qs, urlencode, urlsplit
    parsed = urlsplit(origin)
    context = ssl.create_default_context(cafile=ca_file)
    cookies = {}

    def call(method, target, body=None, headers=None):
        url = urlsplit(target)
        connection = intro.PinnedHTTPS(connect[0], connect[1], parsed.hostname, context)
        try:
            sent = {"Host": parsed.netloc, **(headers or {})}
            if cookies:
                sent["Cookie"] = "; ".join(name + "=" + value for name, value in cookies.items())
            connection.request(method, (url.path or "/") + ("?" + url.query if url.query else ""), body=body, headers=sent)
            response = connection.getresponse()
            raw = response.read()
            for value in response.headers.get_all("Set-Cookie") or []:
                name, _, rest = value.partition("=")
                cookies[name.strip()] = rest.split(";", 1)[0]
            return response.status, response.headers, raw
        finally:
            connection.close()

    redirect = origin + "/worklist/hpacs-lite/index.html"
    state, verifier = uuid.uuid4().hex, uuid.uuid4().hex + uuid.uuid4().hex
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).decode("ascii").rstrip("=")
    query = urlencode({"client_id": client_id, "response_type": "code", "scope": "openid profile email", "redirect_uri": redirect,
                       "state": state, "nonce": state, "code_challenge": challenge, "code_challenge_method": "S256"})
    status, _, page = call("GET", origin + "/auth/realms/kin/protocol/openid-connect/auth?" + query)
    form = re.search(r'<form[^>]+action="([^"]+)"', page.decode("utf-8", errors="replace"), re.I)
    if status != 200 or not form:
        raise RuntimeError("The clone did not show its credential form (HTTP %d)" % status)
    status, headers, _ = call("POST", html.unescape(form.group(1)),
                              urlencode({"username": username, "password": password, "credentialId": ""}).encode("utf-8"),
                              {"Content-Type": "application/x-www-form-urlencoded"})
    location = urlsplit(headers.get("Location", "") if status == 302 else "")
    params = parse_qs(location.query)
    if location._replace(query="", fragment="").geturl() != redirect or params.get("state") != [state] or len(params.get("code", [])) != 1:
        raise RuntimeError("The interactive login did not return this login's authorization code (HTTP %d)" % status)
    status, _, raw = call("POST", origin + "/auth/realms/kin/protocol/openid-connect/token",
                          urlencode({"client_id": client_id, "grant_type": "authorization_code", "code": params["code"][0],
                                     "redirect_uri": redirect, "code_verifier": verifier}).encode("ascii"),
                          {"Content-Type": "application/x-www-form-urlencoded"})
    if status != 200:
        raise RuntimeError("The authorization code was not exchanged (HTTP %d)" % status)
    access = json.loads(raw)["access_token"]
    claims = json.loads(base64.urlsafe_b64decode(access.split(".")[1] + "=" * (-len(access.split(".")[1]) % 4)))
    if type(claims.get("auth_time")) is not int or claims["auth_time"] <= 0:
        raise RuntimeError("Keycloak did not provide the interactive authentication time")
    return {"access_token": access, "subject": claims["sub"]}


FLAKY_BROWSER = r'''
import json, os, subprocess, sys
raw = sys.stdin.buffer.read()
spec = json.loads(raw)
marker = %(marker)r
if spec.get("product_session") and not os.path.exists(marker):
    # D07 (rehearsal): the first login of the release smoke fails once, as a browser hiccup would; every other call is the
    # mode's reference browser itself.
    with open(marker, "w") as handle:
        handle.write("failed once")
    print(json.dumps({"valid": False, "error": "forced first-attempt failure (rehearsal D07)"}), file=sys.stderr)
    sys.exit(1)
sys.exit(subprocess.run([sys.executable, %(tool)r, "browser-smoke"], input=raw).returncode)
'''


def free_port():
    # Docker Desktop also publishes the port on the Windows host, where Hyper-V/WinNAT reserve blocks of the dynamic range
    # (normal-08 drew 50557 inside a reserved 50544-50643: "bind ... forbidden by its access permissions"). A port below
    # both the Windows dynamic range (49152+) and the Linux ephemeral default (32768+) that binds here is used instead.
    for _ in range(500):
        port = 20000 + secrets.randbelow(12000)
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind(("127.0.0.1", port))
            except OSError:
                continue
        return port
    raise AssertionError("no free port in 20000-31999")


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
        self.project = os.environ.get("KIN_TEST_RESOURCE_PREFIX", "kin-rehearsal-") + label + "-" + self.token
        self.root = root / label
        self.root.mkdir(mode=0o700)
        self.repo = self.root / "repo"
        source = Path(__file__).resolve().parents[1]
        # --shared: the disposable clone reads the source object store (never written, never garbage-collected here).
        subprocess.run(["git", "-c", "safe.directory=*", "clone", "-q", "-c", "core.autocrlf=false", "--shared", "--no-checkout",
                        str(source), str(self.repo)], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(self.repo), "-c", "advice.detachedHead=false", "checkout", "-q", "--detach", previous_sha],
                       check=True, capture_output=True)
        if os.name == "posix":
            self.repo.chmod(0o700)
        self.public = free_port()
        self.maintenance = free_port()
        while self.maintenance == self.public:
            self.maintenance = free_port()
        self.origin = "https://localhost:" + str(self.public)
        names = {role: self.project + "-" + role for role in (*intro.ROLES, *intro.ONE_SHOTS)}
        self.ca = self.root / "clone-ca.pem"
        self.override_path = self.root / "rehearsal-override.yml"
        self.halo_network, declared, external, overlay, monitor = None, [], {}, [], []
        if label in ("source", "clone", "failure"):
            # D04: production's monitor file binds ${KIN_MONITOR_PUBLIC_DIR} into the proxy and its .env lacks it (the
            # operator's shell gave it when the stack started); the tool resolves it from the running proxy. A rehearsal
            # binds nothing outside its checkout but declared overlay binds, so the folder is an untracked one inside it.
            self.monitor_dir = self.repo / ".kin-monitor-public"
            self.monitor_dir.mkdir()
            monitor = ["docker-compose.monitor.yml"]
        if label in ("source", "clone", "failure"):
            # IRT-11 (D1066): a declared overlay outside the checkout, listed after the rehearsal override, that joins the
            # proxy to an external network and binds one host file (a synthetic stand-in for the Halo Reports wiring).
            self.halo_conf = self.root / "halo-reports" / "nginx" / "report.conf"
            self.halo_conf.parent.mkdir(parents=True)
            self.halo_conf.write_text("# synthetic Halo Reports stand-in (IRT-11)\n", encoding="utf-8", newline="\n")
            self.halo_network = self.project + "-halo"
            path = self.root / "kin-deploy" / "overlays" / "docker-compose.halo-reports.yml"
            path.parent.mkdir(parents=True)
            path.write_text("services:\n  proxy:\n    networks:\n      halo_reports: {}\n    volumes:\n      - type: bind\n        source: "
                            + json.dumps(str(self.halo_conf)) + "\n        target: /etc/nginx/conf.d/halo-report.conf\n        read_only: true\n\n"
                            "networks:\n  halo_reports:\n    external: true\n    name: " + self.halo_network + "\n", encoding="utf-8", newline="\n")
            self.halo_bind = {"source": str(self.halo_conf), "target": "/etc/nginx/conf.d/halo-report.conf", "read_only": True}
            declared = [{"file": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "service": "proxy",
                         "binds": [dict(self.halo_bind)]}]
            external, overlay = {"proxy": {"halo_reports": self.halo_network}}, [str(path)]
        self.target = {"schema": 1, "kind": "rehearsal", "host_key_sha256": intro.local_host_key() if os.name == "posix" else "b" * 64,
                       "origin": self.origin, "project": self.project,
                       "repository": str(self.repo),
                       "compose_files": ["docker-compose.yml", "docker-compose.prod.yml", str(self.override_path), *overlay, *monitor],
                       "containers": names,
                       "volumes": {"pg": self.project + "_pg-db", "orthanc": self.project + "_orthanc-db",
                                   "emr_access": self.project + "_emr-access", "emr_state": self.project + "_emr-state"},
                       "networks": {"default": self.project + "_default", "workflow": self.project + "-workflow"},
                       "ports": {"maintenance": "127.0.0.1:%d:443" % self.maintenance, "public": ["127.0.0.1:%d:443" % self.public]},
                       "tls_certificate": "/etc/nginx/certs/kin.crt", "cron": None, "ca_file": str(self.ca),
                       "keycloak_admin": "kin-clone-admin" if label == "clone" else "admin",
                       "external_networks": external, "declared_overlays": declared, "tracked_overlay_reconcile": [], "fix_checkout_mode": False}
        intro.target_valid(self.target)
        self.override_path.write_text(intro.rehearsal_override(self.target, self.origin), encoding="utf-8", newline="\n")
        self.env = {"POSTGRES_PASSWORD": secrets.token_urlsafe(24), "KC_ADMIN_PASSWORD": secrets.token_urlsafe(24),
                    "KC_CLIENT_SECRET": secrets.token_urlsafe(24), "KC_WEB_SECRET": secrets.token_urlsafe(24),
                    "KIN_COOKIE_SECRET": secrets.token_urlsafe(24), "ORTHANC_PASS": secrets.token_urlsafe(24),
                    "PUBLIC_ORIGIN": self.origin, "KIN_REVISION": previous_sha}
        if label != "failure":
            self.env["KIN_MONITOR_PUBLIC_DIR"] = str(self.monitor_dir)
        if declared:
            # IRT2-10: with a declared overlay the checkout's .env names the declared list (the VM preparer writes it).
            self.env["COMPOSE_FILE"] = intro.declared_compose_file(self.target)
        self.write_env(self.repo / ".env", self.env)
        self.env_next = self.root / "env.next"
        self.write_env(self.env_next, {**self.env, "KIN_EMR_RUNTIME_PASSWORD": secrets.token_urlsafe(32)})
        self.token_file = self.root / "smoke-token.json"
        self.records = intro.Records(self.root / "records")
        self.backups = self.root / "backups"
        # G09, as the runbook does before the capture takes the lock: the private backup root carries its audit ledger,
        # initialised once with the product's own tool. The introduced release's daily backup seals into it, and reopen
        # (L-11a) refuses a root without one - the first forward rehearsal (forward-01) stopped there.
        self.backups.mkdir(mode=0o700)
        audit.init(self.backups, audit.MIN_YEARS)
        self.previous_sha, self.target_sha = previous_sha, target_sha
        test.addCleanup(self.remove)
        test.addCleanup(self.keep_records)
        if self.halo_network:
            subprocess.run(["docker", "network", "create", "--label", "kin.ops.run=" + self.token, self.halo_network], check=True, capture_output=True)

    def keep_records(self):
        """KIN_TEST_EMR_REHEARSAL_EVIDENCE: copy this stack's run records (journal, step results, one-shot logs; synthetic
        values only) out of the temporary folder before it is removed."""
        target = os.environ.get("KIN_TEST_EMR_REHEARSAL_EVIDENCE")
        if target and self.records.directory.exists():
            # The private values file (D04) is never evidence, whatever it holds. Raw records are written once into a new
            # folder (CKPT2-06): an existing copy is an error, never overwritten.
            shutil = __import__("shutil")
            shutil.copytree(self.records.directory, Path(target) / ("records-" + self.label), dirs_exist_ok=False,
                            ignore=shutil.ignore_patterns(intro.COMPOSE_VALUES))

    @staticmethod
    def write_env(path, values):
        path.write_bytes("".join(f"{key}={value}\n" for key, value in values.items()).encode())
        if os.name == "posix":
            path.chmod(0o600)

    def plan(self, images, seed=None, members=None, frame=None):
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
                # Phase P's read-only observation of the realm; a stack still being set up plans with zero members first.
                "members": members or {"realm_members": 0, "disabled": 0, "service_accounts": 0},
                "smoke": {"frame": frame or SYNTHETIC_FRAME, "member": {"roles": ["radiologist"], "group": "hallym"}},
                "probe": {"study": "SYNTHETIC-rehearsal", "event_id": str(uuid.uuid4()), "institution": "kin-center",
                          "approved_by": "synthetic-rehearsal", "approved_at": now.isoformat()},
                "window": {"start": (now - timedelta(hours=1)).isoformat(), "end": (now + timedelta(hours=8)).isoformat()},
                "budget": {"capture_s": 3600, "introduce_s": 5400, "verify_s": 3600, "reopen_s": 1800, "rollback_s": 3600, "seed_s": 3600,
                           "min_free_bytes": 1024 ** 3},
                "backup_root": str(self.backups), "tool": intro.tool_hashes(),
                "seed": seed or {"b0_dir": str(self.root / "unused-seed"), "b0_manifest_sha256": "0" * 64, "production_plan_sha256": "0" * 64},
                "projection_exempt": [], "rehearsal_host": None}
        self.plan_document = intro.plan_valid(plan)
        self.plan_sha256 = hashlib.sha256(intro.canonical(plan)).hexdigest()
        return plan

    def ops(self, ops_class=None):
        """The unattended smoke (D1062) with the reference headless browser of the mode (Playwright Chromium); with
        fail_first_login (D07) the browser command is a wrapper whose first login of the release smoke fails once."""
        runner = intro.Runner(self.repo)
        browser = [sys.executable, intro.__file__, "browser-smoke"]
        if os.name == "posix":
            browser = ["/usr/bin/env", "PLAYWRIGHT_BROWSERS_PATH=" + os.environ["PLAYWRIGHT_BROWSERS_PATH"], *browser]
        if getattr(self, "fail_first_login", False) and os.name == "nt":
            wrapper = self.root / "flaky-browser.py"
            if not wrapper.exists():
                wrapper.write_text(FLAKY_BROWSER % {"marker": str(self.root / "first-login-failed"), "tool": intro.__file__},
                                   encoding="utf-8", newline="\n")
            browser = [sys.executable, str(wrapper)]
        selected = ops_class or intro.HostOps
        if getattr(self, "fail_first_login", False) and os.name == "posix":
            marker = self.root / "first-login-failed"
            class OneFailedLogin(selected):
                def browser_login(self, machine, **kwargs):
                    if machine.state.get("checkout") == "target" and not marker.exists():
                        marker.write_text("one synthetic refusal\n")
                        raise intro.Stop("The smoke browser login failed: forced first-attempt failure (rehearsal D07)")
                    return super().browser_login(machine, **kwargs)
            selected = OneFailedLogin
        return runner, selected(target=self.target, plan=self.plan_document, runner=runner, records=self.records,
                                                    env_next=self.env_next, token_reader=lambda: json.loads(self.token_file.read_text()),
                                                    browser_cmd=browser)

    def phase(self, phase, expected, ops_class=None):
        runner, host_ops = self.ops(ops_class)
        machine = intro.Introduction(plan=self.plan_document, plan_sha256=self.plan_sha256, target=self.target,
                                     production=copy.deepcopy(intro.EXAMPLE_POLICY["production"]) | {"host_key_sha256": "a" * 64},
                                     ops=host_ops, records=self.records, repository=self.repo,
                                     host_key=self.target["host_key_sha256"], tool=intro.tool_hashes())
        request = {"version": 1, "mode": intro.MODE, "phase": phase, "plan_sha256": self.plan_sha256, "nonce": uuid.uuid4().hex}
        started = time.monotonic()
        with intro.bound_ops(self.repo, runner):
            result = machine.run(request, hashlib.sha256(intro.canonical(request)).hexdigest())
        summary = {"stack": self.label, "phase": phase, "status": result["status"], "seconds": round(time.monotonic() - started, 1),
                   "steps": result["steps"]}
        print(json.dumps(summary), flush=True)
        self.test.assertEqual(result["status"], expected, json.dumps(result)[:4000])
        return result

    def bootstrap_model(self, host_ops, context):
        """Read only the fresh fixture's explicit model before seed has published an operational entry."""
        from unittest.mock import patch
        runtime = self.root / "certificate-check-runtime.yml"
        runtime.write_text(host_ops.pins(context, maintenance=False), encoding="utf-8", newline="\n")
        argv = ["docker", "compose", "--project-directory", str(self.repo), "--project-name", self.project,
                "--env-file", str(self.repo / ".env")]
        for name in self.target["compose_files"]:
            argv.extend(("-f", str(self.repo / name) if not os.path.isabs(name) else name))
        argv.extend(("-f", str(runtime), "config", "--format", "json"))
        model = subprocess.run(argv, cwd=self.repo, capture_output=True, check=True, timeout=60)
        with patch.object(host_ops, "compose", return_value=model):
            return host_ops.resolved(context, maintenance=False)

    def ordinary_recreate(self, images, *, side):
        """Fresh process, completed state, immutable inputs; Linux additionally uses the real protected entry."""
        import shutil
        state = self.records.state()
        self.test.assertEqual(state["status"], "DEPLOYED" if side == "release" else "ROLLED_BACK")
        source_entry = intro.ComposeEntry(self.root / "compose-entries")
        pointer, manifest, _ = source_entry.load()
        self.test.assertEqual(pointer, {key: state["compose_entry"][key] for key in pointer})
        before = {role: json.loads(subprocess.run(["docker", "inspect", self.target["containers"][role]],
                      check=True, capture_output=True).stdout)[0] for role in intro.ROLES}
        self.test.assertFalse((self.records.secrets / intro.COMPOSE_VALUES).exists())
        self.test.assertEqual(list(self.records.secrets.glob("browser-*")), [])
        subprocess.run(["docker", "rm", "-f", self.target["containers"]["proxy"]], check=True, capture_output=True)
        poisoned = {**os.environ, "COMPOSE_FILE": str(self.root / "nonexistent.yml"), "COMPOSE_PROJECT_NAME": "wrong-project"}
        for declared in self.target["declared_overlays"]:
            Path(declared["file"]).unlink(missing_ok=True)
        (self.repo / ".env").unlink(missing_ok=True)
        # Deliberately repoint only this fixture's mutable tags; the command must use immutable image IDs.
        for role in ("api", "proxy"):
            subprocess.run(["docker", "tag", images["previous" if side == "release" else "release"][role],
                            manifest["project"] + "-" + role + ":latest"], check=True, capture_output=True)
            # RELEASE-TOOLS-CHECKPOINTS (CKPT-09): the exact aliases this fixture created, so cleanup removes only them.
            self.created_tags = sorted(set(getattr(self, "created_tags", ())) | {manifest["project"] + "-" + role + ":latest"})
        if os.name == "posix":
            self.test.assertEqual(os.environ.get("KIN_TEST_ISOLATED_INSTALL"), "1")
            library = Path("/opt/kin-deploy/lib")
            library.mkdir(parents=True, exist_ok=True, mode=0o755)
            scripts = Path(intro.__file__).parent
            for name in set(intro.TOOL_FILES) | {"ops_email_monitor.py", "ops_monitor.py", "ops_notify.py"}:
                source = scripts / Path(name).name
                shutil.copyfile(source, library / source.name)
                (library / source.name).chmod(0o644)
            shutil.copyfile(scripts / "ops_deploy_entry.py", "/opt/kin-deploy/entry.py")
            Path("/opt/kin-deploy/entry.py").chmod(0o755)
            operating = self.root / "operating-state"
            operating.mkdir(mode=0o700)
            for name in intro.EMR_DIRS:
                (operating / name).mkdir(mode=0o700)
            for name, document in (("emr-plans", self.plan_document), ("emr-targets", self.target)):
                raw = intro.canonical(document)
                path = operating / name / (intro.sha256_bytes(raw) + ".json")
                path.write_bytes(raw)
                path.chmod(0o600)
            shutil.copytree(source_entry.root, operating / "compose-entries")
            record = operating / "emr-runs" / self.plan_sha256
            record.mkdir(mode=0o700)
            (record / "state.json").write_bytes(intro.canonical(state))
            (record / "state.json").chmod(0o600)
            policy = copy.deepcopy(intro.EXAMPLE_POLICY)
            policy.update(enabled=True, repository=str(self.repo), state_dir=str(operating), targets_allowed=["rehearsal"], repository_owner=None)
            policy["production"]["host_key_sha256"] = "a" * 64
            path = Path("/etc/kin-deploy/emr-introduction.json")
            path.write_bytes(intro.canonical(policy))
            path.chmod(0o600)
            command = ["/usr/bin/python3", "-I", "/opt/kin-deploy/entry.py", "compose", "recreate"]
        else:
            # The Windows rehearsal proves the shared Compose boundary. Protected installation remains Linux evidence.
            script = self.root / "ordinary-entry.py"
            script.write_text("import os,subprocess,sys\nsys.path.insert(0,sys.argv[1])\n"
                              "from ops_emr_introduction import ComposeEntry\n"
                              "a,e=ComposeEntry(sys.argv[2]).argv(['up','-d','--no-deps','--no-build','--pull','never','--force-recreate',*sys.argv[3:]])\n"
                              "env={k:v for k,v in os.environ.items() if not k.startswith(('COMPOSE_','DOCKER_'))}\n"
                              "raise SystemExit(subprocess.run(a,env={**env,**e}).returncode)\n", encoding="utf-8", newline="\n")
            command = [sys.executable, str(script), str(Path(intro.__file__).parent), str(source_entry.root)]
        result = subprocess.run([*command, *intro.ROLES], cwd=self.repo, env=poisoned, capture_output=True, timeout=900)
        self.test.assertEqual(result.returncode, 0, result.stderr[-3000:])
        for role in intro.ROLES:
            current = json.loads(subprocess.run(["docker", "inspect", self.target["containers"][role]], check=True, capture_output=True).stdout)[0]
            self.test.assertNotEqual(current["Id"], before[role]["Id"], role)
            self.test.assertEqual(current["Image"], images[side][role], role)
            self.test.assertEqual(current["Config"]["Labels"]["com.docker.compose.project"], manifest["project"], role)
            mounts = lambda container: sorted((m["Destination"], m.get("Name"), m.get("RW")) for m in container["Mounts"])
            self.test.assertEqual(mounts(current), mounts(before[role]), role)
            self.test.assertEqual(set(current["NetworkSettings"]["Networks"]), set(before[role]["NetworkSettings"]["Networks"]), role)
        print(json.dumps({"ordinary_entry_new_process": True, "protected_linux": os.name == "posix", "side": side,
                          "source_overlay_and_env_removed": True, "proxy_absent_before_recreate": True,
                          "working_secrets_removed": True, "mutable_tags_poisoned": True, "entry": pointer}), flush=True)

    def compose_up(self, images, roles):
        """Test-side bring-up of the source stack (the stand-in for a running Stage-5 host)."""
        runner, host_ops = self.ops()
        if self.label == "failure":
            # The operator's shell gave the monitor folder when the production stack was started (its .env lacks it).
            host_ops.compose_env = {"KIN_MONITOR_PUBLIC_DIR": str(self.monitor_dir)}
        context = SimpleNamespace(state={"checkout": "previous"}, plan={"previous": {"sha": self.previous_sha, "images": images}})
        # Fixture bootstrap precedes the release's first admission. It is not an operational bypass of the common
        # entry: the source is a new, owned synthetic stack whose running baseline the tool will subsequently capture.
        runtime = self.root / "fixture-bootstrap-runtime.yml"
        runtime.write_text(host_ops.pins(context, maintenance=False), encoding="utf-8", newline="\n")
        command = ["docker", "compose", "--project-directory", str(self.repo), "--project-name", self.project,
                   "--env-file", str(self.repo / ".env")]
        for name in self.target["compose_files"]:
            command.extend(("-f", str(self.repo / name) if not os.path.isabs(name) else name))
        command.extend(("-f", str(runtime)))
        with intro.bound_ops(self.repo, runner):
            for role in roles:
                host_ops.cmd([*command, "up", "-d", "--no-deps", "--no-build", "--pull", "never", role],
                             env=host_ops.compose_env, mutating=True, timeout=300)
                if role == "db":
                    # As the product's installation does (tests/measurement_ci.py): Keycloak's database is created once.
                    host_ops.db_ready(120, "Source database did not start")
                    host_ops.cmd(["docker", "exec", self.target["containers"]["db"], "createdb", "-U", "kin", "keycloak"])
            host_ops.api_health(member_rights=False)
        return host_ops

    def certificates(self, proxy_image, fill=True):
        """The clone's own TLS certificate in its proxy volume before the first proxy start, and its CA file (fill=False:
        the volume only, empty)."""
        volume = self.project + "_proxy-certs"
        subprocess.run(["docker", "volume", "create", "--label", "com.docker.compose.project=" + self.project,
                        "--label", "com.docker.compose.volume=proxy-certs", "--label", "kin.ops.run=" + self.token, volume],
                       check=True, capture_output=True)
        if not fill:
            return
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

    def keycloak(self, image, operation, admin_user, network=None):
        """Test-side realm work through the admin REST API (as the executor would): Keycloak may still be starting.
        'disable' disables the member tech; 'client' prepares one interactive login of doctor (a temporary PKCE client and
        a new synthetic password) and returns the client and that password for interactive_token(). After a rollback the
        services live in the recovery project, whose default network is named after it."""
        password = secrets.token_urlsafe(18)
        environment = {**os.environ, "KC_USER": admin_user, "KC_PASS": self.env["KC_ADMIN_PASSWORD"],
                       "KC_MEMBER": "tech" if operation == "disable" else "doctor", "KC_MEMBER_PASS": password,
                       "KC_REDIRECT": self.origin + "/worklist/hpacs-lite/index.html", "KC_ORIGIN": self.origin}
        deadline = time.monotonic() + 420
        while True:
            result = subprocess.run(["docker", "run", "--rm", "--network", network or self.target["networks"]["default"], "--label", "kin.ops.run=" + self.token,
                                     "-e", "KC_USER", "-e", "KC_PASS", "-e", "KC_MEMBER", "-e", "KC_MEMBER_PASS", "-e", "KC_REDIRECT", "-e", "KC_ORIGIN",
                                     "--entrypoint", "node", image, "-e", KC_SCRIPT, operation], env=environment, capture_output=True, timeout=180)
            if result.returncode == 0 or time.monotonic() > deadline:
                break
            time.sleep(5)
        self.test.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace")[-1000:])
        return {**intro.result_line(result.stdout), "password": password}

    def remove(self):
        """Only resources carrying this stack's compose project or its recovery label; never anything else."""
        def ids(kind, label):
            listing = ["docker", kind, "ls", "-q", "--filter", "label=" + label] if kind != "container" else \
                ["docker", "ps", "-a", "-q", "--filter", "label=" + label]
            return subprocess.run(listing, capture_output=True, text=True).stdout.split()
        projects = [self.project]
        try:
            recovered = (json.loads((self.records.directory / "state.json").read_text()).get("recovery") or {}).get("project")
        except (OSError, ValueError):
            recovered = None
        if recovered and recovered.startswith(self.project):
            projects.append(recovered)
            for role in ("api", "proxy"):
                subprocess.run(["docker", "image", "rm", recovered + "-" + role + ":latest"], capture_output=True)
        for project in ("com.docker.compose.project=" + name for name in projects):
            for container in ids("container", project):
                subprocess.run(["docker", "rm", "-f", "-v", container], capture_output=True)
        for container in ids("container", "kin.ops.run=" + self.token):
            subprocess.run(["docker", "rm", "-f", "-v", container], capture_output=True)
        plan16 = getattr(self, "plan_sha256", "")[:16]
        volumes = [volume for name in projects for volume in ids("volume", "com.docker.compose.project=" + name)]
        volumes += ids("volume", "kin.ops.recovery=" + plan16) if plan16 else []
        for volume in volumes:
            subprocess.run(["docker", "volume", "rm", volume], capture_output=True)
        for network in (network for name in projects for network in ids("network", "com.docker.compose.project=" + name)):
            subprocess.run(["docker", "network", "rm", network], capture_output=True)
        for network in ids("network", "kin.ops.run=" + self.token):
            subprocess.run(["docker", "network", "rm", network], capture_output=True)
        # The aliases ordinary_recreate tagged (CKPT-09): only while another tag still names the shared image, so the
        # image ID itself is never removed with them.
        for tag in getattr(self, "created_tags", ()):
            listed = subprocess.run(["docker", "image", "inspect", "--format", "{{json .RepoTags}}", tag], capture_output=True, text=True)
            if listed.returncode == 0 and len(json.loads(listed.stdout or "[]")) > 1:
                subprocess.run(["docker", "image", "rm", tag], capture_output=True)

    # ── RELEASE-TOOLS-CHECKPOINTS: an explicit descriptor, so a later stage process can rebuild this object ──

    def descriptor(self):
        """Everything a later stage needs to rebuild this stack object over its restored fixture tree (no clone, network
        or file is created again). It holds the synthetic secrets: it lives only inside the private fixture tree."""
        out = {"label": self.label, "token": self.token, "project": self.project, "root": str(self.root), "public": self.public,
               "maintenance": self.maintenance, "origin": self.origin, "target": self.target, "env": self.env,
               "previous_sha": self.previous_sha, "target_sha": self.target_sha, "halo_network": self.halo_network,
               "fail_first_login": bool(getattr(self, "fail_first_login", False)),
               "plan_document": getattr(self, "plan_document", None), "plan_sha256": getattr(self, "plan_sha256", None)}
        if hasattr(self, "monitor_dir"):
            out["monitor_dir"] = str(self.monitor_dir)
        if self.halo_network:
            out.update(halo_conf=str(self.halo_conf), halo_bind=dict(self.halo_bind))
        return out

    @classmethod
    def restored(cls, test, descriptor):
        """The stack object over a restored fixture tree at the same absolute root; the same cleanups as __init__."""
        stack = cls.__new__(cls)
        stack.test, stack.label, stack.token, stack.project = test, descriptor["label"], descriptor["token"], descriptor["project"]
        stack.root = Path(descriptor["root"])
        stack.repo = stack.root / "repo"
        stack.public, stack.maintenance, stack.origin = descriptor["public"], descriptor["maintenance"], descriptor["origin"]
        stack.ca, stack.override_path = stack.root / "clone-ca.pem", stack.root / "rehearsal-override.yml"
        stack.halo_network = descriptor["halo_network"]
        if "monitor_dir" in descriptor:
            stack.monitor_dir = Path(descriptor["monitor_dir"])
        if stack.halo_network:
            stack.halo_conf, stack.halo_bind = Path(descriptor["halo_conf"]), dict(descriptor["halo_bind"])
        stack.target, stack.env = descriptor["target"], descriptor["env"]
        stack.env_next, stack.token_file = stack.root / "env.next", stack.root / "smoke-token.json"
        stack.records, stack.backups = intro.Records(stack.root / "records"), stack.root / "backups"
        stack.previous_sha, stack.target_sha = descriptor["previous_sha"], descriptor["target_sha"]
        if descriptor["plan_document"] is not None:
            stack.plan_document, stack.plan_sha256 = descriptor["plan_document"], descriptor["plan_sha256"]
        if descriptor["fail_first_login"]:
            stack.fail_first_login = True
        test.addCleanup(stack.remove)
        test.addCleanup(stack.keep_records)
        return stack


class CheckpointDocker:
    """RELEASE-TOOLS-CHECKPOINTS backend: the one place that builds Docker/Compose commands for a checkpoint of one
    synthetic stack. tests/ops_release_checkpoints.py decides ownership, order and admission; this adapter only runs
    exact commands against this stack's names, its pinned ComposeEntry and one fixed helper image ID. Every call runs
    without DOCKER_*/COMPOSE_* (checkpoints.daemon_environment), as the Compose calls do, so raw and Compose calls reach
    the one daemon the host admission observed (CKPT-01)."""

    STOP_SECONDS = 120

    def __init__(self, stack, helper_image):
        self.stack, self.helper = stack, helper_image

    def run(self, args, *, timeout=300, check=True, **kwargs):
        kwargs.setdefault("env", checkpoints.daemon_environment())
        result = subprocess.run(args, capture_output="stdout" not in kwargs, timeout=timeout, **kwargs)
        if check and result.returncode:
            raise RuntimeError("checkpoint command failed: " + " ".join(args[:3]) + " exit " + str(result.returncode))
        return result

    def inspect_all(self, kind, listing):
        ids = self.run(listing).stdout.decode().split()
        return json.loads(self.run(["docker", *kind, "inspect", *ids]).stdout) if ids else []

    def inventory(self):
        containers = [{"id": item["Id"], "name": item["Name"].lstrip("/"), "labels": item["Config"].get("Labels") or {},
                       "running": item["State"]["Running"], "image": item["Image"],
                       "mounts": [{"type": m.get("Type"), "name": m.get("Name"), "source": m.get("Source"),
                                   "destination": m.get("Destination")} for m in item.get("Mounts") or []]}
                      for item in self.inspect_all([], ["docker", "ps", "-a", "-q", "--no-trunc"])]
        volumes = [{"id": item["Name"], "name": item["Name"], "labels": item.get("Labels") or {}}
                   for item in self.inspect_all(["volume"], ["docker", "volume", "ls", "-q"])]
        networks = [{"id": item["Id"], "name": item["Name"], "labels": item.get("Labels") or {}}
                    for item in self.inspect_all(["network"], ["docker", "network", "ls", "-q", "--no-trunc"])]
        tags = {}
        for line in self.run(["docker", "image", "ls", "--no-trunc", "--format", "{{.ID}}\t{{.Repository}}:{{.Tag}}"]).stdout.decode().splitlines():
            ident, _, tag = line.partition("\t")
            tags.setdefault(ident, set())
            if tag and "<none>" not in tag:
                tags[ident].add(tag)
        images = [{"id": ident, "tags": sorted(names)} for ident, names in sorted(tags.items())]
        return {"containers": containers, "volumes": volumes, "networks": networks, "images": images}

    def stop(self, name):
        stopped = self.run(["docker", "stop", "-t", str(self.STOP_SECONDS), name], timeout=self.STOP_SECONDS + 60, check=False)
        state = json.loads(self.run(["docker", "inspect", name]).stdout)[0]["State"]
        return {"exit_code": state.get("ExitCode"), "forced": stopped.returncode != 0 or state.get("ExitCode") == 137,
                "oom_killed": state.get("OOMKilled"), "running": state.get("Running")}

    def writable_changes(self, name):
        return [line for line in self.run(["docker", "diff", name]).stdout.decode().splitlines() if line.strip()]

    def export_volume(self, name, destination):
        with open(destination, "xb") as out:
            self.run(["docker", "run", "--rm", "--network", "none", "--label", "kin.ops.run=" + self.stack.token,
                      "--mount", "type=volume,source=" + name + ",target=/volume,readonly", "--entrypoint", "tar", self.helper,
                      "-C", "/volume", "-cf", "-", "."], stdout=out, stderr=subprocess.PIPE, timeout=3600)

    def volume_exists(self, name):
        if self.run(["docker", "volume", "inspect", name], check=False).returncode == 0:
            return True
        self.run(["docker", "info", "--format", "{{.ServerVersion}}"])
        return False

    def image_present(self, image_id):
        return self.run(["docker", "image", "inspect", image_id], check=False).returncode == 0

    def create_volume(self, name, labels):
        self.run(["docker", "volume", "create", *[item for key, value in sorted(labels.items()) for item in ("--label", key + "=" + value)],
                  name])

    def load_volume(self, name, archive, category):
        checkpoints.archive_members(archive, category=category)
        with open(archive, "rb") as stream:
            self.run(["docker", "run", "--rm", "-i", "--network", "none", "--label", "kin.ops.run=" + self.stack.token,
                      "--mount", "type=volume,source=" + name + ",target=/volume", "--entrypoint", "tar", self.helper,
                      "-C", "/volume", "-xpf", "-"], stdin=stream, timeout=3600)

    def create_network(self, name, labels):
        self.run(["docker", "network", "create", *[item for key, value in sorted(labels.items()) for item in ("--label", key + "=" + value)],
                  name])

    def compose(self, args):
        """The stack's pinned ComposeEntry (immutable image IDs), never a build, pull or tag resolution."""
        argv, environment = intro.ComposeEntry(self.stack.root / "compose-entries").argv(args)
        inherited = {key: value for key, value in os.environ.items() if not key.startswith(("COMPOSE_", "DOCKER_"))}
        self.run(argv, cwd=self.stack.repo, env={**inherited, **environment}, timeout=900)

    def compose_create(self, roles):
        self.compose(["create", "--no-build", "--pull", "never", *roles])

    def compose_start(self, role):
        self.compose(["start", role])

    def wait_db_ready(self, seconds=180):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if self.run(["docker", "exec", self.stack.target["containers"]["db"], "pg_isready", "-h", "127.0.0.1", "-U", "kin"],
                        check=False, timeout=20).returncode == 0:
                return
            time.sleep(1)
        raise RuntimeError("restored database did not become ready within %d s" % seconds)

    def remove(self, kind, ident):
        """containers/volumes/networks by exact ID; `tags` removes one exact alias (cleanup_owned only asks while another
        tag keeps the image)."""
        command = {"containers": ["docker", "rm", "-f", "-v", ident], "volumes": ["docker", "volume", "rm", ident],
                   "networks": ["docker", "network", "rm", ident], "tags": ["docker", "image", "rm", ident]}[kind]
        self.run(command, check=False)

    def observe(self, checkpoint_id, *, purpose, state_raw=None, leaf=None, parent_manifest_sha256=None, source=None, probe=None):
        """The product's own observation (HostOps.snapshot) of this stack, judged by its boundary contract over the original
        state bytes, in an observation-only context (r5, checkpoints.observe_boundary): the real Introduction constructor
        without run(), a deep copy of the state, the observation's own request digest and its own Records under
        <records>/checkpoint-observations/. Its HostOps writes only those Records and keeps this stack's ComposeEntry root
        (HostOps would otherwise derive the root from the Records' location); repository, target and lock are the stack's
        own, and every docker exec is still registered and settled as an Engine exec worker. 48a28dd built the context
        without a request digest on the closed phase's Records (T16 r4: NOT_A_BOUNDARY at every volume boundary). Returns
        the observation record."""
        stack = self.stack
        runner = intro.Runner(stack.repo)
        entry_root = stack.root / "compose-entries"

        def make_ops(records):
            return intro.HostOps(target=stack.target, plan=stack.plan_document, runner=runner, records=records, entry_root=entry_root)

        def snapshot(ops, context):
            with intro.bound_ops(stack.repo, runner):
                return ops.snapshot(context)
        return checkpoints.observe_boundary(
            checkpoint_id, purpose=purpose, records_dir=stack.records.directory, secrets_dir=stack.records.secrets,
            entry_root=entry_root, lock_path=intro.lock_path(stack.repo), plan=stack.plan_document, plan_sha256=stack.plan_sha256,
            target=stack.target, repository=stack.repo, host_key=stack.target["host_key_sha256"], tool=intro.tool_hashes(),
            make_ops=make_ops, snapshot=snapshot, state_raw=state_raw, leaf=leaf, parent_manifest_sha256=parent_manifest_sha256,
            source=source, probe=probe)

    def boundary_facts(self):
        """The product facts a restore must reproduce (CKPT-04), observed through the stack's own containers: per role its
        container ID (history only), image, running state, Compose project, mounts and networks; with the database up the
        applied migrations, the legacy roles/owners/grants, the realm's members, the study rows and the EMR roles; with
        Orthanc up the synthetic frame's bytes. Compared by checkpoints.restored_mapping after the restore."""
        stack, containers, running = self.stack, {}, set()
        for role in intro.ROLES:
            found = self.run(["docker", "inspect", stack.target["containers"][role]], check=False)
            if found.returncode:
                continue
            item = json.loads(found.stdout)[0]
            containers[role] = {"id": item["Id"], "image": item["Image"], "running": item["State"]["Running"],
                                "project": (item["Config"].get("Labels") or {}).get("com.docker.compose.project"),
                                "mounts": sorted([m.get("Destination"), m.get("Name") or m.get("Source"), bool(m.get("RW"))]
                                                 for m in item.get("Mounts") or []),
                                "networks": sorted(item["NetworkSettings"]["Networks"])}
            if item["State"]["Running"]:
                running.add(role)
        facts = {"containers": containers}
        if "db" in running:
            facts["migrations"] = json.loads(stack.psql(MIGRATION_FACTS_SQL) or "null")
            facts["legacy"] = json.loads(stack.psql(LEGACY_FACTS_SQL))
            facts["realm"] = json.loads(stack.psql(intro.REALM_MEMBERS_SQL, "keycloak"))
            facts["data"] = json.loads(stack.psql(DATA_FACTS_SQL))
        if "orthanc" in running:
            frame = self.run(["docker", "exec", stack.target["containers"]["orthanc"], "python3", "-c", FRAME_SCRIPT, SYNTHETIC_SOP],
                             timeout=120)
            facts["frame"] = json.loads(frame.stdout)
        return facts

    @staticmethod
    def self_contained_git(fixture_root):
        """Each disposable clone keeps its own object closure (its --shared alternate is the source worktree)."""
        for git_dir in sorted(Path(fixture_root).glob("*/repo/.git")):
            subprocess.run(["git", "-C", str(git_dir.parent), "repack", "-a", "-d", "-q"], check=True, capture_output=True, timeout=600)
            (git_dir / "objects" / "info" / "alternates").unlink(missing_ok=True)
            CheckpointDocker.git_connected(git_dir.parent)

    @staticmethod
    def git_connected(repo):
        """Every object reachable from the clone's refs, reflogs and index is in its own object store (CalledProcessError
        otherwise). git-fsck(1) has no -q/--quiet (git 2.43 and 2.55 exit 129 on it, T16 run-d1428); --no-progress keeps
        stderr free of progress lines, and dangling objects are reported without failing."""
        subprocess.run(["git", "-C", str(repo), "fsck", "--connectivity-only", "--no-progress"], check=True, capture_output=True,
                       timeout=600)

    @staticmethod
    def host_facts(fixture_root, owned_ids=()):
        """D1034 and the host identity, observed now (never reused from an older gate observation): every container,
        running or stopped, with its kin.ops.run and kin.emrb.live labels (a labelled container is foreign whatever its
        name); the current context's endpoint and any DOCKER_* endpoint selection in this environment; a query that fails
        or prints an unexpected row is an unobservable daemon (daemon_ok false), never a clean one."""
        environment = checkpoints.daemon_environment()
        info_run = subprocess.run(["docker", "info", "--format", "{{json .}}"], capture_output=True, timeout=60, env=environment)
        try:
            info = json.loads(info_run.stdout or b"{}") if info_run.returncode == 0 else {}
        except ValueError:
            info = {}
        endpoint = subprocess.run(["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], capture_output=True,
                                  text=True, timeout=60, env=environment)
        listed = subprocess.run(["docker", "ps", "-a", "--no-trunc", "--format",
                                 '{{.ID}}\t{{.Names}}\t{{.State}}\t{{.Label "kin.ops.run"}}\t{{.Label "kin.emrb.live"}}'],
                                capture_output=True, text=True, timeout=60, env=environment)
        rows = []
        for line in listed.stdout.splitlines() if listed.returncode == 0 else []:
            parts = line.split("\t")
            if len(parts) != 5 or not parts[0] or not parts[1]:
                rows = None
                break
            rows.append({"id": parts[0], "name": parts[1], "state": parts[2], "kin.ops.run": parts[3], "kin.emrb.live": parts[4]})
        memory = 0
        if os.name == "posix" and Path("/proc/meminfo").is_file():
            fields = dict(line.split(":", 1) for line in Path("/proc/meminfo").read_text().splitlines() if ":" in line)
            memory = int(fields.get("MemAvailable", "0 kB").split()[0]) * 1024
        root = Path(fixture_root)
        usage = shutil_disk_usage(root.parent if not root.exists() else root)
        return {"os": "linux" if sys.platform.startswith("linux") else os.name, "docker_os": info.get("OperatingSystem", ""),
                "daemon_ok": listed.returncode == 0 and rows is not None and info_run.returncode == 0 and bool(info.get("ID")),
                "daemon_identity": info.get("ID", ""), "architecture": info.get("Architecture", ""), "available_ram_bytes": memory,
                "available_disk_bytes": usage, "required_disk_bytes": 20 * 1024 ** 3,
                "foreign_containers": checkpoints.foreign_containers(rows or [], owned_ids=owned_ids),
                "docker_endpoint": endpoint.stdout.strip() if endpoint.returncode == 0 else "",
                "endpoint_selectors": checkpoints.endpoint_selectors(), "absolute_fixture_root": str(root),
                "host_key_sha256": intro.local_host_key() if os.name == "posix" else None, "gate_state": str(live_test_gate.STATE),
                "runtime": {"python": sys.version.split()[0], "docker": info.get("ServerVersion", "")}}

    @staticmethod
    def runtime_facts():
        """The executing runtime (CKPT-04): interpreter, Docker server, Compose, the Playwright package the smoke browser
        imports from this interpreter and the Chromium builds of PLAYWRIGHT_BROWSERS_PATH, architecture."""
        environment = checkpoints.daemon_environment()

        def text(args):
            result = subprocess.run(args, capture_output=True, text=True, timeout=60, env=environment)
            return result.stdout.strip() if result.returncode == 0 else ""
        import importlib.metadata
        try:
            playwright = importlib.metadata.version("playwright")
        except importlib.metadata.PackageNotFoundError:
            playwright = ""
        browsers = Path(os.environ.get("PLAYWRIGHT_BROWSERS_PATH") or "/nonexistent")
        chromium = ",".join(sorted(path.name for path in browsers.glob("chromium*"))) if browsers.is_dir() else ""
        return {"python": sys.version.split()[0], "docker_server": text(["docker", "version", "--format", "{{.Server.Version}}"]),
                "compose": text(["docker", "compose", "version", "--short"]), "playwright": playwright, "chromium": chromium,
                "arch": text(["docker", "info", "--format", "{{.Architecture}}"])}


def shutil_disk_usage(path):
    return __import__("shutil").disk_usage(str(path)).free


# The explicit stage table of the three fresh rehearsals (RELEASE-TOOLS-CHECKPOINTS spec section 2): the fresh methods run
# every stage of their scenario in one process; CheckpointSegments (tests/ops_release_checkpoints_live_test.py) runs one
# stage after a cold restore. No stage is skipped by an environment variable.
STAGE_METHODS = {"source": "stage_source", "seed": "stage_seed", "capture": "stage_capture", "introduce": "stage_introduce",
                 "verify": "stage_verify", "normal-tail": "stage_normal_tail", "forward-tail": "stage_forward_tail",
                 "forced-capture": "stage_forced_capture", "forced-tail": "stage_forced_tail"}
REALM_SMOKE_SQL = "SELECT count(*) FROM user_entity u JOIN realm r ON r.id=u.realm_id WHERE r.name='kin' AND u.username LIKE 'kin-smoke-%';"
# RELEASE-TOOLS-CHECKPOINTS (CKPT-04): the restored boundary's data and rights, read as the checkpoint saw them.
MIGRATION_FACTS_SQL = ("SELECT json_agg(json_build_array(migration_name, checksum, finished_at IS NOT NULL, rolled_back_at IS NOT NULL) "
                       "ORDER BY migration_name COLLATE \"C\") FROM \"_prisma_migrations\";")
DATA_FACTS_SQL = ("SELECT json_build_object('study', (SELECT json_agg(to_jsonb(s) ORDER BY s.uid) FROM \"StudyState\" s), "
                  "'emr_roles', (SELECT json_agg(rolname ORDER BY rolname) FROM pg_roles WHERE rolname LIKE 'kin_emr_%' OR rolname='kin_runtime'));")
FRAME_SCRIPT = r"""
import base64, hashlib, json, os, sys, urllib.request
password = json.loads(os.environ['ORTHANC__REGISTERED_USERS'])['admin']
headers = {'Authorization': 'Basic ' + base64.b64encode(('admin:' + password).encode()).decode()}
def call(path, data=None):
    request = urllib.request.Request('http://127.0.0.1:8042' + path, data=data, headers=headers, method='POST' if data else 'GET')
    return urllib.request.urlopen(request, timeout=30).read()
found = [item['ID'] for item in json.loads(call('/tools/lookup', sys.argv[1].encode())) if item.get('Type') == 'Instance']
frame = hashlib.sha256(call('/instances/' + found[0] + '/frames/0/raw')).hexdigest() if len(found) == 1 else None
print(json.dumps({'instances': len(found), 'frame_sha256': frame}))
"""


class RehearsalStages:
    """The rehearsal's stages over one context (ctx); every assertion of the former monolithic methods is kept."""

    def image_id(self, reference):
        return json.loads(subprocess.run(["docker", "image", "inspect", reference], check=True, capture_output=True).stdout)[0]["Id"]

    def rehearsal_context(self, prefix, root=None):
        if root is None:
            folder = tempfile.TemporaryDirectory(prefix=prefix)
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
        return SimpleNamespace(root=root, previous_sha=previous_sha, target_sha=target_sha, images=images)

    def stage_table(self):
        return {stage: getattr(self, method) for stage, method in STAGE_METHODS.items()}

    def run_fresh(self, scenario):
        """One fresh end-to-end rehearsal: every stage of the scenario in this process, under the live gate; a checkpoint
        request in the environment refuses it rather than shortening it."""
        checkpoints.fresh_guard()
        evidence = os.environ.get("KIN_TEST_EMR_REHEARSAL_EVIDENCE")
        # CKPT2-06: every attempt writes a new evidence folder; an existing one (an earlier attempt's raw records and
        # segment) is refused before any stage, never overwritten.
        checkpoints.require(not evidence or not Path(evidence).exists(), "EVIDENCE_EXISTS", str(evidence))
        live_test_gate.require_live_run()
        ops.require_local_docker()
        record = None
        if evidence:
            # CKPT-06: with an evidence folder (the T16 fresh control) the fresh method writes its own segment. Registered
            # first, it runs last: after every stack's keep_records and removal, so it observes the real cleanup.
            record = {"scenario": scenario, "evidence": Path(evidence), "executed": [], "passed": False, "owned": [],
                      "started": checkpoints.now_utc().isoformat(), "inputs_before": checkpoints.inputs_summary(Path(__file__).resolve().parents[1])}
            self.addCleanup(self.fresh_segment, record)
        context = self.rehearsal_context("kin-emr-failure-" if scenario == "forced" else "kin-emr-rehearsal-")
        table = self.stage_table()
        if record is not None:
            def traced(stage, method):
                def run(ctx):
                    record["executed"].append(stage)
                    try:
                        method(ctx)
                    finally:
                        # What each stack owns, read while its records exist (the temporary folder is gone at the end).
                        record["owned"] = [self.owned_by(getattr(ctx, name)) for name in ("source", "clone", "failure") if hasattr(ctx, name)]
                return run
            table = {stage: traced(stage, method) for stage, method in table.items()}
        checkpoints.run_scenario(scenario, table, context)
        if record is not None:
            record["passed"] = True

    @staticmethod
    def owned_by(stack):
        """One stack's exact ownership: its token label, its Compose project and recovery project, its recovery volume
        label and the image aliases it created (never a name prefix)."""
        state = stack.records.state() or {}
        recovery = (state.get("recovery") or {}).get("project")
        return {"token": stack.token, "projects": sorted({stack.project} | ({recovery} if recovery else set())),
                "recovery": [stack.plan_sha256[:16]] if getattr(stack, "plan_sha256", None) else [],
                "tags": list(getattr(stack, "created_tags", ()))}

    def fresh_segment(self, record):
        """The fresh method's segment (CKPT-06): the live marker, its exact case, the raw records keep_records preserved,
        the phase results, the observed absence of every owned resource of its stacks, the unchanged inputs; written once
        and announced on stdout for the evidence index. A cleanup that is not observed complete fails the test."""
        case = checkpoints.FRESH_CASES[record["scenario"]]
        marker = checkpoints.marker_identity(live_test_gate)
        evidence = record["evidence"]
        evidence.mkdir(mode=0o700, parents=True, exist_ok=True)
        results = []
        for owned in record["owned"]:
            try:
                remaining = checkpoints.owned_remaining(CheckpointDocker(None, None).inventory(), owned)
                results.append({"complete": not remaining, "removed": [], "remaining": remaining, "errors": []})
            except Exception as error:  # an unobservable daemon is not a clean one
                results.append({"complete": False, "removed": [], "remaining": [], "errors": [type(error).__name__]})
        cleanup = {"complete": bool(results) and all(item["complete"] for item in results),
                   "removed": [], "remaining": [name for item in results for name in item["remaining"]],
                   "errors": [error for item in results for error in item["errors"]]}
        sources = {path.name[len("records-"):]: path for path in sorted(evidence.glob("records-*")) if path.is_dir()}
        raw = sorted([path.relative_to(evidence).as_posix(), hashlib.sha256(path.read_bytes()).hexdigest()]
                     for folder in sources.values() for path in sorted(folder.rglob("*")) if path.is_file())
        inputs_after = checkpoints.inputs_summary(Path(__file__).resolve().parents[1])
        request = {"unit": marker["unit"], "case": case, "stage": None, "scenario": record["scenario"], "execution_kind": "fresh"}
        current = checkpoints.current_identity(record["inputs_before"], execution_kind="fresh", root=Path(__file__).resolve().parents[1],
                                               plan_sha256=None)
        passed = record["passed"] and cleanup["complete"] and inputs_after == record["inputs_before"]
        segment = checkpoints.segment_record(
            request=request, request_sha256=None, marker=marker, identity=checkpoints.segment_identity(current),
            executed_phases=[phase for stage in record["executed"] for phase in checkpoints.STAGES[stage]["phases"]],
            inherited_phases=[], results={}, cleanup=cleanup, run_json=os.environ.get("KIN_TEST_EMR_CHECKPOINT_RUN_JSON", ""),
            started_utc=record["started"], ended_utc=checkpoints.now_utc().isoformat(), selected_tests=[case],
            phase_results=checkpoints.phase_results(sources), raw_records=[], inputs_before=record["inputs_before"],
            inputs_after=inputs_after)
        segment.update(raw_records=raw, observed={"outcome": "PASS"} if record["passed"] else {"outcome": "FAIL"}, expected={"outcome": "PASS"})
        path = checkpoints.finish_segment(live_test_gate, passed=passed, segment=segment, evidence_root=evidence)
        print(json.dumps({"segment": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}), flush=True)
        self.assertTrue(cleanup["complete"], json.dumps(cleanup))

    def halo_wired(self, stack, stage):
        """IRT-11: every proxy (re)creation used the declared file set: the overlay's bind and network are there."""
        item = json.loads(subprocess.run(["docker", "inspect", stack.target["containers"]["proxy"]], check=True, capture_output=True).stdout)[0]
        binds = [(m.get("Destination"), m.get("RW")) for m in item["Mounts"] if m.get("Type") == "bind"]
        self.assertIn((stack.halo_bind["target"], False), binds, stage)
        self.assertIn(stack.halo_network, item["NetworkSettings"]["Networks"], stage)

    def stage_source(self, ctx):
        root, images = ctx.root, ctx.images
        # S: the stand-in for the running Stage-5 host, with synthetic data only.
        source = SyntheticStack(self, root, "source", ctx.previous_sha, ctx.target_sha)
        source.plan(images)
        source.certificates(images["previous"]["proxy"])
        source.compose_up(images["previous"], ("db", "keycloak", "orthanc", "api", "proxy"))
        source.psql('INSERT INTO "StudyState"(uid, "institutionId", rs, "preDoc", "preReviewer", "updatedAt") '
                    f"VALUES ('{SYNTHETIC_STUDY}', 'hallym', 'P', 'doctor@kin.kr', 'doctor2@kin.kr', now());"
                    " INSERT INTO \"AuditLog\"(actor, action, target, detail) VALUES ('SYNTHETIC-rehearsal', 'synthetic.seed', "
                    f"'{SYNTHETIC_STUDY}', '{{\"synthetic\":true}}');")
        source.psql(LEGACY_ROLES_SQL)
        legacy = json.loads(source.psql(LEGACY_FACTS_SQL))
        uploaded = subprocess.run(["docker", "exec", "-i", source.target["containers"]["orthanc"], "python3", "-c", UPLOAD_SCRIPT],
                                  input=synthetic_dicom(), capture_output=True, timeout=120)
        self.assertEqual(uploaded.returncode, 0, uploaded.stderr[-2000:])
        source.keycloak(images["previous"]["api"], "disable", "admin")
        # Production's realm names its own origin for the BFF client; the seed rewrites it to the clone's.
        source.keycloak(images["previous"]["api"], "origin", "admin")
        # Phase P: the realm as observed read-only (counts only) becomes the plan's member-import expectation.
        members = json.loads(source.psql(intro.REALM_MEMBERS_SQL, "keycloak"))
        self.assertGreaterEqual(members["disabled"], 1)
        source.plan(images, members=members)
        source.phase("capture", "HELD")
        b0 = json.loads((source.records.directory / "state.json").read_text())["b0"]
        source.remove()
        ctx.source, ctx.legacy, ctx.members, ctx.b0 = source, legacy, members, b0

    def stage_seed(self, ctx):
        root, images, members, b0, source = ctx.root, ctx.images, ctx.members, ctx.b0, ctx.source
        # C: the disposable clone, seeded from S's B0 copy (no S resource is reachable any more). The production plan the
        # rehearsal rehearses exists first; the clone's plan names its identity.
        clone = SyntheticStack(self, root, "clone", ctx.previous_sha, ctx.target_sha)
        copy_dir = root / "b0-copy" / Path(b0["dir"]).name
        shutil_copy = __import__("shutil").copytree
        shutil_copy(b0["dir"], copy_dir)
        production_target = intro.example_target()
        production_target.update(host_key_sha256="a" * 64)
        production_target["declared_overlays"][0]["sha256"] = clone.target["declared_overlays"][0]["sha256"]
        intro.target_valid(production_target, operational=True)
        production_plan = copy.deepcopy(clone.plan(images, members=members))
        production_plan.update(target_kind="production", seed=None, rehearsal_host=clone.target["host_key_sha256"],
                               target_manifest_sha256=hashlib.sha256(intro.canonical(production_target)).hexdigest())
        intro.plan_valid(production_plan)
        clone.plan(images, seed={"b0_dir": str(copy_dir), "b0_manifest_sha256": b0["manifest_sha256"],
                                 "production_plan_sha256": intro.plan_identity(production_plan)}, members=members)
        self.assertEqual(intro.plan_core(clone.plan_document), intro.plan_core(production_plan))
        # D1066: the seed's read-only certificate check refuses an absent volume (and never creates it) and an empty one;
        # the clone's certificate goes into the volume before the first proxy start.
        runner, host_ops = clone.ops()
        context = SimpleNamespace(plan=clone.plan_document, state={"checkout": "previous"})
        volume = clone.project + "_proxy-certs"
        with intro.bound_ops(clone.repo, runner):
            model = clone.bootstrap_model(host_ops, context)
            with self.assertRaisesRegex(intro.Stop, "does not exist"):
                host_ops.certificate_volume_check(context, model)
            self.assertNotEqual(subprocess.run(["docker", "volume", "inspect", volume], capture_output=True).returncode, 0)
            with self.assertRaisesRegex(intro.Stop, "CA file is missing"):
                clone.certificates(images["previous"]["proxy"], fill=False)
                host_ops.certificate_volume_check(context, model)
            # An empty volume with a CA file in place (the source's, until the clone's own replaces it).
            clone.ca.write_bytes(source.ca.read_bytes())
            with self.assertRaisesRegex(intro.Stop, "empty"):
                host_ops.certificate_volume_check(context, model)
            clone.certificates(images["previous"]["proxy"])
            self.assertEqual(host_ops.certificate_volume_check(context, model)["volume"], volume)
        print(json.dumps({"certificate_volume_check": "absent and empty refused, filled accepted"}), flush=True)
        clone.phase("seed", "SEEDED")
        self.assertEqual(clone.psql(f"SELECT \"preDoc\" FROM \"StudyState\" WHERE uid='{SYNTHETIC_STUDY}';"), "doctor@kin.kr")
        self.assertEqual(json.loads(clone.psql(LEGACY_FACTS_SQL)), ctx.legacy, "the seed keeps the further roles, owners and grants")
        ctx.clone, ctx.copy_dir, ctx.production_plan = clone, copy_dir, production_plan

    def stage_capture(self, ctx):
        clone = ctx.clone
        # D07: the clone's browser command fails the release smoke's first login once (forced); every other call is real.
        clone.fail_first_login = True
        clone.phase("capture", "HELD")
        (captured,) = clone.records.directory.glob("result-capture-*.json")
        baseline = next(step for step in json.loads(captured.read_text())["steps"] if step["step"] == "L-01")["detail"]
        # D01/D02: the browser itself and the smoke member's roles and group were proved before the fence.
        self.assertTrue(baseline["smoke_browser"]["browser"].startswith("chromium "), baseline["smoke_browser"])
        self.assertEqual(baseline["smoke_member_realm"], {"roles": ["radiologist"], "group": "hallym"})

    def stage_introduce(self, ctx):
        clone = ctx.clone
        clone.phase("introduce", "INTRODUCED")
        realm = "(SELECT id FROM realm WHERE name='kin')"
        self.assertEqual(clone.psql(f"SELECT enabled FROM user_entity WHERE username='tech' AND realm_id={realm};", "keycloak"), "t")
        self.assertEqual(clone.psql("SELECT suspended FROM \"MemberRights\" WHERE username='tech';"), "t")
        self.assertEqual(clone.psql(f"SELECT \"preDocSub\" IS NOT NULL FROM \"StudyState\" WHERE uid='{SYNTHETIC_STUDY}';"), "t")
        # D1062 unattended: the smoke member was made before the import and imported like every member.
        smoke = json.loads((clone.records.directory / "state.json").read_text())["smoke_member"]
        rights = clone.psql("SELECT json_build_object('suspended', suspended, 'approved', approved, 'roles', roles, 'institution', institution) "
                            f"FROM \"MemberRights\" WHERE username='{smoke['username']}';")
        self.assertEqual(json.loads(rights), {"suspended": False, "approved": True, "roles": ["radiologist"], "institution": "hallym"})

    def stage_verify(self, ctx):
        clone = ctx.clone
        # auth_time and newAuthAfter have whole-second resolution: the browser logs in in a later second than the import.
        time.sleep(1.1)
        verified = clone.phase("verify", "VERIFIED")
        self.assertEqual(verified["probe"]["receipt"]["eventId"], clone.plan_document["probe"]["event_id"])
        # D07: the forced first failure was retried once (new login client, new profile) and passed; recorded.
        retry = json.loads((clone.records.directory / "state.json").read_text())["smoke_retry"]
        self.assertEqual((retry["passed"], retry["reason"]), (True, "The smoke browser login failed: forced first-attempt failure (rehearsal D07)"))
        self.assertLessEqual(retry["seconds"], intro.SMOKE_RETRY_S)
        print(json.dumps({"smoke_retry": retry}), flush=True)
        record = json.loads((clone.records.directory / "operator-smoke.json").read_text())
        self.assertEqual((record["by"], record["passed"], sorted(record["checks"])), ("Opus executor (D1062)", True, sorted(intro.OPERATOR_SMOKE_CHECKS)))
        self.assertTrue(all(record["checks"].values()))
        self.assertEqual(clone.psql(REALM_SMOKE_SQL, "keycloak"), "0", "the smoke member is gone before any reopen")
        self.assertEqual(list(clone.records.secrets.glob("smoke-member-*.json")), [], "its password is gone with it")
        self.halo_wired(clone, "release proxy after verify")

    def stage_normal_tail(self, ctx):
        clone, images, legacy, b0, production_plan = ctx.clone, ctx.images, ctx.legacy, ctx.b0, ctx.production_plan
        realm = "(SELECT id FROM realm WHERE name='kin')"
        clone.phase("rollback", "RESTORED")
        state = json.loads((clone.records.directory / "state.json").read_text())
        recovery = state["recovery"]
        # RESTORED: nothing reopened; rollback_reopen makes a smoke member in the restored realm (a login necessarily
        # after the restore), proves the previous version, deletes the member, and only then opens.
        reopened = clone.phase("rollback_reopen", "ROLLED_BACK")
        self.halo_wired(clone, "previous proxy after the rollback")
        self.assertEqual(clone.psql(REALM_SMOKE_SQL, "keycloak"), "0")
        self.assertEqual(list(clone.records.secrets.glob("smoke-member-*.json")), [])
        self.assertTrue(json.loads((clone.records.directory / "operator-smoke-previous.json").read_text())["passed"])
        self.assertEqual([step["outcome"] for step in reopened["steps"]], ["PASS"] * 5)
        state = json.loads((clone.records.directory / "state.json").read_text())
        self.assertEqual(state["rollback_smoke"]["frame_sha256"], SYNTHETIC_FRAME["sha256"])
        # Back at the same pre-EMR point: history, data, realm (kin and keycloak together), the further roles with their
        # owners and grants (IRT-07), and the previous images.
        rows = json.loads(clone.psql("SELECT json_agg(json_build_array(migration_name, checksum, finished_at IS NOT NULL, rolled_back_at IS NOT NULL)"
                                     " ORDER BY migration_name COLLATE \"C\") FROM \"_prisma_migrations\";"))
        pre.check_migration_rows(rows, clone.plan_document["migrations"]["before"])
        self.assertEqual(clone.psql(f"SELECT enabled FROM user_entity WHERE username='tech' AND realm_id={realm};", "keycloak"), "f")
        self.assertEqual(clone.psql("SELECT count(*) FROM pg_roles WHERE rolname LIKE 'kin_emr_%' OR rolname='kin_runtime';"), "0")
        self.assertEqual(json.loads(clone.psql(LEGACY_FACTS_SQL)), legacy, "the rollback keeps the further roles, owners and grants")
        inspect = lambda name: json.loads(subprocess.run(["docker", "inspect", name], check=True, capture_output=True).stdout)[0]
        self.assertEqual(inspect(clone.target["containers"]["api"])["Image"], images["previous"]["api"])
        self.assertEqual({m["Destination"]: m.get("Name") for m in inspect(clone.target["containers"]["db"])["Mounts"]}["/var/lib/postgresql/data"],
                         recovery["pg"])
        failed = (clone.target["volumes"]["pg"], clone.target["volumes"]["orthanc"], clone.target["volumes"]["emr_access"],
                  clone.target["volumes"]["emr_state"])
        for name in failed:
            self.assertEqual(subprocess.run(["docker", "volume", "inspect", name], capture_output=True).returncode, 0, "failed volume kept: " + name)
        # C-COMPOSE: the supported ordinary entry, in a new process after transient/source inputs are gone.
        clone.ordinary_recreate(images, side="previous")
        self.halo_wired(clone, "previous proxy after an ordinary recreate")
        mounts = lambda role, path: {m["Destination"]: m.get("Name") for m in inspect(clone.target["containers"][role])["Mounts"]}.get(path)
        self.assertEqual((mounts("db", "/var/lib/postgresql/data"), mounts("orthanc", "/var/lib/orthanc/db")), (recovery["pg"], recovery["orthanc"]))
        for role in ("db", "orthanc", "api"):
            item = inspect(clone.target["containers"][role])
            self.assertEqual((item["Image"], item["Config"]["Labels"]["com.docker.compose.project"]),
                             (images["previous"][role], recovery["project"]), role)
        for name in failed:
            users = subprocess.run(["docker", "ps", "-a", "--filter", "volume=" + name, "--format", "{{.Names}}"], capture_output=True, text=True).stdout
            self.assertEqual(users.strip(), "", "failed volume detached: " + name)
        runner, host_ops = clone.ops()
        with intro.bound_ops(clone.repo, runner):
            host_ops.db_ready(180, "Recreated database did not become ready")
            host_ops.api_health(member_rights=False)
            host_ops.reload_proxy()
        print(json.dumps({"recreated_with_ordinary_entry": True, "health": intro.health_check(clone.origin, ca_file=str(clone.ca), member_rights=False)}),
              flush=True)
        result = clone.phase("receipt", "RECEIPTED")
        receipt = json.loads((clone.records.directory / "local-restore-receipt.json").read_text())
        production = {**intro.EXAMPLE_POLICY["production"], "host_key_sha256": "a" * 64}
        bundle = intro.DirectoryBundle(clone.records.directory)
        intro.receipt_valid(receipt, production_plan, b0["manifest_sha256"], production, b0_created_utc=b0["created_utc"], bundle=bundle)
        self.assertTrue(intro.bundle_valid(receipt, clone.records.directory))
        with self.assertRaisesRegex(intro.Stop, "run bundle"):
            intro.receipt_valid(receipt, production_plan, b0["manifest_sha256"], production, b0_created_utc=b0["created_utc"])
        with self.assertRaisesRegex(intro.Stop, "already used"):
            intro.receipt_valid(receipt, production_plan, b0["manifest_sha256"], production, used=[intro.receipt_sha256(receipt)], bundle=bundle)
        print(json.dumps({"synthetic_rehearsal": "PASS", "receipt_sha256": result["receipt"]["sha256"],
                          "source_b0_manifest_sha256": b0["manifest_sha256"], "b1_manifest_sha256": state["b1"]["manifest_sha256"],
                          "bfail": state["bfail"]["manifest_sha256"], "recovery": recovery, "legacy_roles": legacy,
                          "migrations": [len(clone.plan_document["migrations"]["before"]), len(clone.plan_document["migrations"]["after"])]}),
              flush=True)

    def stage_forward_tail(self, ctx):
        """A separate forward branch: reopen reaches PONR, then ordinary operation keeps release image IDs."""
        stack = ctx.clone
        reopened = stack.phase("reopen", "DEPLOYED")
        images = {side: stack.plan_document[side]["images"] for side in ("previous", "release")}
        stack.ordinary_recreate(images, side="release")
        health = intro.health_check(stack.origin, ca_file=str(stack.ca), member_rights=True)
        self.assertTrue(health)
        self.forward_verdict(stack, reopened, health)

    def forward_verdict(self, stack, reopened, health):
        """The product verdict a resumed forward suffix and the fresh forward control must share (T16); IDs and times are
        bound to each run's own records and are not part of it."""
        inspect = lambda name: json.loads(subprocess.run(["docker", "inspect", name], check=True, capture_output=True).stdout)[0]
        running = {role: inspect(stack.target["containers"][role])["Image"] for role in intro.ROLES}
        rows = json.loads(stack.psql("SELECT json_agg(json_build_array(migration_name, checksum) ORDER BY migration_name COLLATE \"C\") "
                                     "FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;"))
        verdict = {"status": reopened["status"], "release_images": stack.plan_document["release"]["images"], "health": health,
                   "migrations_after": rows == stack.plan_document["migrations"]["after"],
                   "smoke_member_absent": stack.psql(REALM_SMOKE_SQL, "keycloak") == "0", "ordinary_entry_side": "release",
                   "ordinary_entry_images": running == stack.plan_document["release"]["images"],
                   "frame_sha256": stack.plan_document["smoke"]["frame"]["sha256"]}
        print(json.dumps({"forward_verdict": verdict}), flush=True)
        # CKPT-08: the verdict is the forward's own contract, not only material for a comparison.
        self.assertEqual(checkpoints.forward_verdict_reasons(verdict), [], "forward verdict")
        return verdict

    def stage_forced_capture(self, ctx):
        """Round 3 (D04/D05): a production-shaped stack whose monitor file binds ${KIN_MONITOR_PUBLIC_DIR} (absent from its
        .env, given by the operator's shell at start) and whose declared overlay joins the Halo network; then capture."""
        root, images = ctx.root, ctx.images
        stack = SyntheticStack(self, root, "failure", ctx.previous_sha, ctx.target_sha)
        stack.plan(images)
        stack.certificates(images["previous"]["proxy"])
        stack.compose_up(images["previous"], ("db", "keycloak", "orthanc", "api", "proxy"))
        self.assertNotIn("KIN_MONITOR_PUBLIC_DIR", (stack.repo / ".env").read_text())
        stack.psql('INSERT INTO "StudyState"(uid, "institutionId", rs, "preDoc", "preReviewer", "updatedAt") '
                   f"VALUES ('{SYNTHETIC_STUDY}', 'hallym', 'P', 'doctor@kin.kr', 'doctor2@kin.kr', now());")
        stack.psql(LEGACY_ROLES_SQL)
        legacy = json.loads(stack.psql(LEGACY_FACTS_SQL))
        uploaded = subprocess.run(["docker", "exec", "-i", stack.target["containers"]["orthanc"], "python3", "-c", UPLOAD_SCRIPT],
                                  input=synthetic_dicom(), capture_output=True, timeout=120)
        self.assertEqual(uploaded.returncode, 0, uploaded.stderr[-2000:])
        stack.keycloak(images["previous"]["api"], "origin", "admin")
        members = json.loads(stack.psql(intro.REALM_MEMBERS_SQL, "keycloak"))
        stack.plan(images, members=members)
        stack.phase("capture", "HELD")
        state = json.loads((stack.records.directory / "state.json").read_text())
        self.assertEqual(state["compose_env"]["KIN_MONITOR_PUBLIC_DIR"]["from"], ["mount:proxy"])
        self.assertTrue((stack.records.secrets / intro.COMPOSE_VALUES).is_file())
        ctx.failure, ctx.legacy = stack, legacy

    def stage_forced_tail(self, ctx):
        """introduce, where L-09b fails as a failed proxy recreate leaves it: the proxy container is gone, and meanwhile the
        overlay file was edited by hand. The automatic rollback resolves the variable from the kept value and recreates the
        services from the overlay bytes pinned at the capture (warning recorded): RESTORED; rollback_reopen (a new process,
        overlay still edited) proves the previous version and reopens: ROLLED_BACK."""
        stack, images, legacy = ctx.failure, ctx.images, ctx.legacy
        overlay = Path(stack.target["declared_overlays"][0]["file"])
        declared = overlay.read_bytes()

        class FailedProxyRecreate(intro.HostOps):
            def proxy_ui(self, machine):
                # What a failed `compose up --force-recreate proxy` leaves: no proxy container; meanwhile the overlay
                # file was edited by hand on the host.
                subprocess.run(["docker", "rm", "-f", self.names["proxy"]], check=True, capture_output=True)
                overlay.write_bytes(declared + b"# edited by hand during the window\n")
                raise intro.Stop("synthetic L-09b failure: the proxy recreate failed")
        introduced = stack.phase("introduce", "RESTORED", ops_class=FailedProxyRecreate)
        self.assertEqual([step["outcome"] for step in introduced["steps"] if step["step"] == "L-09b"], ["STOP"])
        self.assertEqual([warning["kind"] for warning in introduced["warnings"]], ["declared-overlay"])
        journal = [json.loads(line) for line in (stack.records.directory / "journal.jsonl").read_text().splitlines()]
        kept = [entry for entry in journal if entry["event"] == "compose-environment"
                and entry.get("resolved_from_running_stack", {}).get("KIN_MONITOR_PUBLIC_DIR", {}).get("from") == ["kept"]]
        self.assertTrue(kept, "the rollback resolved KIN_MONITOR_PUBLIC_DIR from the kept value")
        inspect = lambda name: json.loads(subprocess.run(["docker", "inspect", name], check=True, capture_output=True).stdout)[0]
        proxy = inspect(stack.target["containers"]["proxy"])
        monitor = [m for m in proxy["Mounts"] if m.get("Destination") == "/var/run/kin-monitor-public"]
        self.assertEqual(len(monitor), 1)
        self.assertEqual(Path(monitor[0]["Source"]).name, stack.monitor_dir.name)
        self.assertIn(stack.halo_network, proxy["NetworkSettings"]["Networks"])
        reopened = stack.phase("rollback_reopen", "ROLLED_BACK")
        self.assertEqual([warning["kind"] for warning in reopened["warnings"]], ["declared-overlay"])
        self.assertEqual(json.loads(stack.psql(LEGACY_FACTS_SQL)), legacy, "the rollback keeps the further roles, owners and grants")
        self.assertFalse((stack.records.secrets / intro.COMPOSE_VALUES).exists(), "the kept values end with the plan")
        self.assertEqual(inspect(stack.target["containers"]["api"])["Image"], images["previous"]["api"])
        stack.ordinary_recreate(images, side="previous")
        print(json.dumps({"forced_l09b_failure": "RESTORED then ROLLED_BACK", "warnings": introduced["warnings"],
                          "kept_value_used": True, "legacy_roles": legacy}), flush=True)


@unittest.skipUnless(os.environ.get("KIN_TEST_EMR_REHEARSAL") == "1" and all(os.environ.get(name) for name in REHEARSAL_IMAGES),
                     "opt-in synthetic EMR-introduction rehearsal (KIN_TEST_EMR_REHEARSAL=1 and the four images)")
class EmrIntroductionRehearsal(RehearsalStages, unittest.TestCase):
    def test_emr_introduction_rehearsal_seed_capture_introduce_verify_rollback_receipt(self):
        """source -> seed -> capture -> introduce -> verify -> rollback -> rollback_reopen -> ordinary recreate -> receipt."""
        self.run_fresh("normal")

    def test_emr_introduction_rehearsal_forced_l09b_failure_rolls_back_with_kept_values_and_the_pinned_overlay(self):
        """Round 3 (D04/D05): a production-shaped stack whose monitor file binds ${KIN_MONITOR_PUBLIC_DIR} (absent from its
        .env, given by the operator's shell at start) and whose declared overlay joins the Halo network. capture -> introduce,
        where L-09b fails as a failed proxy recreate leaves it: the proxy container is gone, and meanwhile the overlay file
        was edited by hand. The automatic rollback resolves the variable from the kept value and recreates the services
        from the overlay bytes pinned at the capture (warning recorded): RESTORED; rollback_reopen (a new process, overlay
        still edited) proves the previous version and reopens: ROLLED_BACK."""
        self.run_fresh("forced")

    def test_emr_introduction_rehearsal_forward_entry_after_reopen(self):
        """A separate forward branch: reopen reaches PONR, then ordinary operation keeps release image IDs. The common
        prefix runs with every assertion of the normal path up to verify (no monkeypatched early exit)."""
        self.run_fresh("forward")


if __name__ == "__main__":
    unittest.main(verbosity=2)
