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
        self.halo_network, declared, external, overlay, monitor = None, [], {}, [], []
        if label == "failure":
            # D04: production's monitor file binds ${KIN_MONITOR_PUBLIC_DIR} into the proxy and its .env lacks it (the
            # operator's shell gave it when the stack started); the tool resolves it from the running proxy. A rehearsal
            # binds nothing outside its checkout but declared overlay binds, so the folder is an untracked one inside it.
            self.monitor_dir = self.repo / ".kin-monitor-public"
            self.monitor_dir.mkdir()
            monitor = ["docker-compose.monitor.yml"]
        if label in ("clone", "failure"):
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
        self.target = {"schema": 1, "kind": "rehearsal", "host_key_sha256": "b" * 64, "origin": self.origin, "project": self.project,
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
        if declared:
            # IRT2-10: with a declared overlay the checkout's .env names the declared list (the VM preparer writes it).
            self.env["COMPOSE_FILE"] = intro.declared_compose_file(self.target)
        self.write_env(self.repo / ".env", self.env)
        self.env_next = self.root / "env.next"
        self.write_env(self.env_next, {**self.env, "KIN_EMR_RUNTIME_PASSWORD": secrets.token_urlsafe(32)})
        self.token_file = self.root / "smoke-token.json"
        self.records = intro.Records(self.root / "records")
        self.backups = self.root / "backups"
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
            # The private values file (D04) is never evidence, whatever it holds.
            shutil = __import__("shutil")
            shutil.copytree(self.records.directory, Path(target) / ("records-" + self.label), dirs_exist_ok=True,
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
        if getattr(self, "fail_first_login", False):
            wrapper = self.root / "flaky-browser.py"
            if not wrapper.exists():
                wrapper.write_text(FLAKY_BROWSER % {"marker": str(self.root / "first-login-failed"), "tool": intro.__file__},
                                   encoding="utf-8", newline="\n")
            browser = [sys.executable, str(wrapper)]
        return runner, (ops_class or intro.HostOps)(target=self.target, plan=self.plan_document, runner=runner, records=self.records,
                                                    env_next=self.env_next, token_reader=lambda: json.loads(self.token_file.read_text()),
                                                    browser_cmd=browser)

    def phase(self, phase, expected, ops_class=None):
        runner, host_ops = self.ops(ops_class)
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
        if self.label == "failure":
            # The operator's shell gave the monitor folder when the production stack was started (its .env lacks it).
            host_ops.compose_env = {"KIN_MONITOR_PUBLIC_DIR": str(self.monitor_dir)}
        context = SimpleNamespace(state={"checkout": "previous"}, plan={"previous": {"sha": self.previous_sha, "images": images}})
        with intro.bound_ops(self.repo, runner):
            for role in roles:
                host_ops.compose(["up", "-d", "--no-deps", "--no-build", "--pull", "never", role],
                                 override=host_ops.pins(context, maintenance=False), timeout=300)
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

        # C: the disposable clone, seeded from S's B0 copy (no S resource is reachable any more). The production plan the
        # rehearsal rehearses exists first; the clone's plan names its identity.
        clone = SyntheticStack(self, root, "clone", previous_sha, target_sha)
        copy_dir = root / "b0-copy" / Path(b0["dir"]).name
        shutil_copy = __import__("shutil").copytree
        shutil_copy(b0["dir"], copy_dir)
        production_target = intro.example_target()
        production_target.update(host_key_sha256="a" * 64)
        production_plan = copy.deepcopy(clone.plan(images, members=members))
        production_plan.update(target_kind="production", seed=None, rehearsal_host="b" * 64,
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
            model = host_ops.resolved(context, maintenance=False)
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
        self.assertEqual(json.loads(clone.psql(LEGACY_FACTS_SQL)), legacy, "the seed keeps the further roles, owners and grants")
        # D07: the clone's browser command fails the release smoke's first login once (forced); every other call is real.
        clone.fail_first_login = True
        clone.phase("capture", "HELD")
        (captured,) = clone.records.directory.glob("result-capture-*.json")
        baseline = next(step for step in json.loads(captured.read_text())["steps"] if step["step"] == "L-01")["detail"]
        # D01/D02: the browser itself and the smoke member's roles and group were proved before the fence.
        self.assertTrue(baseline["smoke_browser"]["browser"].startswith("chromium "), baseline["smoke_browser"])
        self.assertEqual(baseline["smoke_member_realm"], {"roles": ["radiologist"], "group": "hallym"})
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
        realm_smoke = "SELECT count(*) FROM user_entity u JOIN realm r ON r.id=u.realm_id WHERE r.name='kin' AND u.username LIKE 'kin-smoke-%';"
        self.assertEqual(clone.psql(realm_smoke, "keycloak"), "0", "the smoke member is gone before any reopen")
        self.assertEqual(list(clone.records.secrets.glob("smoke-member-*.json")), [], "its password is gone with it")

        def halo_wired(stage):
            """IRT-11: every proxy (re)creation used the declared file set: the overlay's bind and network are there."""
            item = json.loads(subprocess.run(["docker", "inspect", clone.target["containers"]["proxy"]], check=True, capture_output=True).stdout)[0]
            binds = [(m.get("Destination"), m.get("RW")) for m in item["Mounts"] if m.get("Type") == "bind"]
            self.assertIn((clone.halo_bind["target"], False), binds, stage)
            self.assertIn(clone.halo_network, item["NetworkSettings"]["Networks"], stage)
        halo_wired("release proxy after verify")
        clone.phase("rollback", "RESTORED")
        state = json.loads((clone.records.directory / "state.json").read_text())
        recovery = state["recovery"]
        # RESTORED: nothing reopened; rollback_reopen makes a smoke member in the restored realm (a login necessarily
        # after the restore), proves the previous version, deletes the member, and only then opens.
        reopened = clone.phase("rollback_reopen", "ROLLED_BACK")
        halo_wired("previous proxy after the rollback")
        self.assertEqual(clone.psql(realm_smoke, "keycloak"), "0")
        self.assertEqual(list(clone.records.secrets.glob("smoke-member-*.json")), [])
        self.assertTrue(json.loads((clone.records.directory / "operator-smoke-previous.json").read_text())["passed"])
        self.assertEqual([step["outcome"] for step in reopened["steps"]], ["PASS"] * len(intro.STEPS["rollback_reopen"]))
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
        # IRT-05 / IRT2-10: an ordinary compose recreate in this checkout - no project flag, no file list, no pins, as an
        # operator would type it - keeps pg and Orthanc on the recovery volumes and the previous images, and the proxy
        # keeps the declared overlay's bind and network (the .env names the project and the declared compose list).
        recreate = subprocess.run(["docker", "compose", "up", "-d", "--no-deps", "--no-build", "--pull", "never", "--force-recreate",
                                   "db", "orthanc", "api", "proxy"], cwd=str(clone.repo), capture_output=True, timeout=600)
        self.assertEqual(recreate.returncode, 0, recreate.stderr[-3000:])
        halo_wired("previous proxy after an ordinary recreate")
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
        print(json.dumps({"recreated_with_ordinary_compose": True, "health": intro.health_check(clone.origin, ca_file=str(clone.ca), member_rights=False)}),
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

    def test_emr_introduction_rehearsal_forced_l09b_failure_rolls_back_with_kept_values_and_the_pinned_overlay(self):
        """Round 3 (D04/D05): a production-shaped stack whose monitor file binds ${KIN_MONITOR_PUBLIC_DIR} (absent from its
        .env, given by the operator's shell at start) and whose declared overlay joins the Halo network. capture -> introduce,
        where L-09b fails as a failed proxy recreate leaves it: the proxy container is gone, and meanwhile the overlay file
        was edited by hand. The automatic rollback resolves the variable from the kept value and recreates the services
        from the overlay bytes pinned at the capture (warning recorded): RESTORED; rollback_reopen (a new process, overlay
        still edited) proves the previous version and reopens: ROLLED_BACK."""
        ops.require_local_docker()
        folder = tempfile.TemporaryDirectory(prefix="kin-emr-failure-")
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
        stack = SyntheticStack(self, root, "failure", previous_sha, target_sha)
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
        print(json.dumps({"forced_l09b_failure": "RESTORED then ROLLED_BACK", "warnings": introduced["warnings"],
                          "kept_value_used": True, "legacy_roles": legacy}), flush=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
