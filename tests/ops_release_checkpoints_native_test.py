"""RELEASE-TOOLS-CHECKPOINTS round 5: the native adapter smoke (Astra consultation consult-checkpoints-r5-20261016,
adapter_smoke A01-A12 and the native parts of the negative oracles N01-N05). Test harness only; scripts/** is unchanged.

Run as one process, never collected by a test runner: `python -B tests/ops_release_checkpoints_native_test.py --evidence
<new folder>`. `tests/ops_release_checkpoints.py commands` runs it (through scripts/record-run.py, with the leaves'
`--python`) after the host preconditions and before any byte of proof.sh, and the CI `runtime` job runs the same entrypoint
under sudo. It holds the live gate's own lease (tests/live_test_gate.exclusive on STATE/live.lock) for the whole run and
refuses an existing inspection marker, an earlier smoke's unreleased residue, anything but root on native Linux with one
local daemon, and a foreign `kin-*` container; it never uses live_run, a gate attempt or the gate ledger.

The fixture is tiny and throwaway: a PostgreSQL 16 with a minimal SQL model (Prisma history, a study row, legacy roles
and grants, a tablespace in the emr-access volume, a realm), the real Orthanc image with the synthetic instance, and three
roles that are harmless waiting processes of fixed images; its own Git donor and clones, its own ComposeEntry generations,
its own explicit phase-end records (plan, results, command records, state, history). It is an adapter transport and
observation proof (CheckpointDocker and every HostOps/Engine/Runner path its observations reach, and the live
capture/restore consumers seal_boundary/restore_boundary), never a product seed, migration, authentication or reading
proof and never a T16 phase PASS. Docker, Git, Compose and Engine calls are real; there is no fake backend here.

Every check is recorded with its outcome (smoke-log.jsonl) and grouped by path (A01-A12) and oracle (N01-N05) in
smoke-result.json; a path or oracle without a check, a skip, a failure, an UNKNOWN or an unconfirmed cleanup is a failed
smoke (exit 1). The assertions are on behaviour (resources, bytes, uid/gid/mode, archive members, snapshot facts, worker
settlement, refusals), never on argv strings (AGENTS.md section 1-B). The byte identity of the original records is the
requirement itself (consultation observe_fix) and is asserted as such.
"""
import argparse
import copy
from datetime import datetime, timedelta, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import traceback
import unittest
from unittest.mock import patch
import uuid

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "tests") not in sys.path:
    sys.path.insert(0, str(ROOT / "tests"))
import live_test_gate as gate  # noqa: E402
import ops_release_checkpoints as cp  # noqa: E402
import ops_deploy_host_container_test as rehearsal  # noqa: E402
import ops_release_checkpoints_live_test as live  # noqa: E402

intro = cp.intro
DB_IMAGE, ORTHANC_IMAGE = "postgres:16-alpine", "orthancteam/orthanc:24.12.0"
# Initial acceptance targets of the consultation: the smoke body at most 5 minutes with prepared images, cleanup bounded
# apart (60 s). Exceeding either fails the smoke; the measured times are recorded either way.
BODY_SECONDS, CLEANUP_SECONDS = 300, 60
# The tiny fixture's own needs (distinct from T16's D1034: >= 10 GiB RAM, 20 GiB disk, which `commands` requires apart).
SMOKE_RAM, SMOKE_DISK = 2 * 1024 ** 3, 4 * 1024 ** 3
# A waiting process that ends with exit 0 on the image's stop signal (TERM, or INT for the postgres image).
SLEEPER = ["sh", "-c", "trap 'exit 0' TERM INT; while :; do sleep 1 & wait $$!; done"]
STATE_TMPFS = ["/var/lib/postgresql/data"]  # the postgres image's VOLUME: never an anonymous volume on a waiting role
SMOKE_TIME = "2026-10-16T00:00:00+00:00"


def hexdigest(text):
    return hashlib.sha256(text.encode()).hexdigest()


MIGRATIONS_BEFORE = [["0_init", hexdigest("kin-smoke 0_init")],
                     ["20260926130000_study_image_requests", hexdigest("kin-smoke study_image_requests")]]
MIGRATIONS_AFTER = MIGRATIONS_BEFORE + [[intro.EMR_MIGRATION, hexdigest("kin-smoke emr_b")]]
BASE_COMPOSE = {
    "services": {
        "db": {"entrypoint": ["sh", "-c", "install -d -o postgres -g postgres -m 700 /var/lib/postgresql/emr-access/ts && "
                                          "exec docker-entrypoint.sh postgres"],
               "environment": {"POSTGRES_USER": "kin", "POSTGRES_PASSWORD": "${POSTGRES_PASSWORD:?}", "POSTGRES_DB": "kin"},
               "volumes": ["pg-db:/var/lib/postgresql/data", "emr-access:/var/lib/postgresql/emr-access"],
               "healthcheck": {"test": ["CMD-SHELL", "pg_isready -U kin"], "interval": "5s", "timeout": "5s", "retries": 10}},
        "orthanc": {"environment": {"ORTHANC__REGISTERED_USERS": '{"admin":"${ORTHANC_PASS:?}"}'},
                    "volumes": ["orthanc-db:/var/lib/orthanc/db"]},
        "keycloak": {"entrypoint": SLEEPER, "tmpfs": STATE_TMPFS, "volumes": ["kc-extra:/opt/kin-smoke-extra"]},
        "api": {"entrypoint": SLEEPER, "tmpfs": STATE_TMPFS, "volumes": ["emr-state:" + intro.EMR_STATE_DIR]},
        "proxy": {"entrypoint": SLEEPER, "tmpfs": STATE_TMPFS, "volumes": ["proxy-certs:/etc/nginx/certs"]}},
    "volumes": {name: {} for name in ("pg-db", "orthanc-db", "emr-access", "emr-state", "proxy-certs", "kc-extra")}}
SCHEMA_SQL = """CREATE TABLE "_prisma_migrations" (id text PRIMARY KEY, checksum varchar(64) NOT NULL, finished_at timestamptz,
  migration_name varchar(255) NOT NULL, logs text, rolled_back_at timestamptz, started_at timestamptz NOT NULL DEFAULT now(),
  applied_steps_count integer NOT NULL DEFAULT 0);
CREATE TABLE "StudyState" (uid text PRIMARY KEY, "institutionId" text NOT NULL, rs text NOT NULL, "updatedAt" timestamptz NOT NULL);
CREATE TABLE "AuditLog" (id serial PRIMARY KEY, actor text, action text, target text, detail jsonb);
INSERT INTO "StudyState" VALUES ('%(study)s', 'hallym', 'P', '%(time)s');
CREATE TABLESPACE kin_emr_access LOCATION '%(tablespace)s';
CREATE TABLE kin_smoke_placement (id integer) TABLESPACE kin_emr_access;
INSERT INTO kin_smoke_placement VALUES (1);
"""
REALM_SQL = """CREATE TABLE realm (id text PRIMARY KEY, name text NOT NULL);
CREATE TABLE user_entity (id text PRIMARY KEY, username text NOT NULL, enabled boolean NOT NULL, service_account_client_link text,
  realm_id text NOT NULL);
INSERT INTO realm VALUES ('r1', 'kin');
INSERT INTO user_entity VALUES ('u1', 'doctor', true, NULL, 'r1'), ('u2', 'tech', false, NULL, 'r1'),
  ('u3', 'service-account-kin-api', true, 'c1', 'r1');
"""
ORTHANC_READY = r"""
import base64, json, os, urllib.request
password = json.loads(os.environ['ORTHANC__REGISTERED_USERS'])['admin']
request = urllib.request.Request('http://127.0.0.1:8042/system', headers={'Authorization': 'Basic ' + base64.b64encode(('admin:' + password).encode()).decode()})
print(json.loads(urllib.request.urlopen(request, timeout=5).read())['Version'])
"""
# Known bytes with an owner and a mode in every volume category (A03), planted through the role that mounts it.
MARKERS = {"pg": ("db", "/var/lib/postgresql/data/kin-smoke-marker", "70:70", 0o600, b"pg marker\n"),
           "orthanc": ("orthanc", "/var/lib/orthanc/db/kin-smoke-marker", "0:0", 0o640, b"orthanc marker\n"),
           "emr_access": ("db", "/var/lib/postgresql/emr-access/kin-smoke-marker", "70:70", 0o600, b"emr access marker\n"),
           "emr_state": ("api", intro.EMR_STATE_DIR + "/kin-smoke-marker", "1000:1000", 0o640, b"emr state marker\n"),
           "proxy_certs": ("proxy", "/etc/nginx/certs/kin-smoke-marker", "0:0", 0o644, b"proxy certs marker\n"),
           "extra": ("keycloak", "/opt/kin-smoke-extra/kin-smoke-marker", "4242:4242", 0o600, b"extra volume marker\n")}
PLANT = 'cat > "$1" && chown "$2" "$1" && chmod "$3" "$1"'


class SmokeFailure(AssertionError):
    pass


def residue_dir():
    """The smoke's own residue ledger, beside (never inside) the gate's state: a pending file per unfinished smoke."""
    return Path(gate.STATE).parent / "checkpoint-smoke"


def frozen_observe_48a28dd(stack, records, checkpoint_id, *, request_sha256=None):
    """N01/N02 diagnostic only, never a candidate path: CheckpointDocker.observe exactly as 48a28dd wrote it
    (tests/ops_deploy_host_container_test.py:971-983), with the closed phase's Records replaced by a copy of them so the
    fixture's own records stay as they are. Its HostOps gets the ComposeEntry root its default resolved to there (the
    stack root). `request_sha256` set is the digest-only incomplete fix (N02). Returns the snapshot; the contract is the
    caller's."""
    runner = intro.Runner(stack.repo)
    host_ops = intro.HostOps(target=stack.target, plan=stack.plan_document, runner=runner, records=records,
                             entry_root=stack.root / "compose-entries")
    machine = intro.Introduction(plan=stack.plan_document, plan_sha256=stack.plan_sha256, target=stack.target,
                                 production=copy.deepcopy(intro.EXAMPLE_POLICY["production"]) | {"host_key_sha256": "a" * 64},
                                 ops=host_ops, records=records, repository=stack.repo,
                                 host_key=stack.target["host_key_sha256"], tool=intro.tool_hashes())
    machine.state, machine.phase = records.state(), "checkpoint-observe"
    if request_sha256 is not None:
        machine.request_sha256 = request_sha256
    with intro.bound_ops(stack.repo, runner):
        return host_ops.snapshot(machine)


class TinyStack:
    """One tiny synthetic stack: a --shared clone of the smoke's donor repository, its own project, names, ports, volumes,
    ComposeEntry generations and explicit phase-end records. Owned by its token label and Compose project only."""

    def __init__(self, smoke, label, *, rebuild=None):
        self.smoke, self.label = smoke, label
        if rebuild is not None:
            self.__dict__.update(rebuild)
            self.root, self.repo = Path(self.root), Path(self.root) / "repo"
            self.overlay = self.root / "overlay-halo.yml"
            self.records, self.backups = intro.Records(self.root / "records"), self.root / "backups"
            self.docker = rehearsal.CheckpointDocker(self, smoke.helper)
            return
        self.token = smoke.token
        self.project = "kin-ckptsmoke-" + label + "-" + smoke.token[:10]
        self.root = smoke.fixture_root / label
        self.root.mkdir(mode=0o700)
        self.repo = self.root / "repo"
        smoke.git("clone", "-q", "-c", "core.autocrlf=false", "--shared", "--no-checkout", str(smoke.donor), str(self.repo))
        smoke.git("-C", str(self.repo), "-c", "advice.detachedHead=false", "checkout", "-q", "--detach", smoke.previous_sha)
        self.repo.chmod(0o700)
        self.halo_network = self.project + "-halo"
        self.overlay = self.root / "overlay-halo.yml"
        self.overlay.write_text(json.dumps({"services": {"proxy": {"networks": {"default": {}, "halo": {}}}},
                                            "networks": {"halo": {"external": True, "name": self.halo_network}}}) + "\n", encoding="utf-8")
        self.public = rehearsal.free_port()
        self.maintenance = rehearsal.free_port()
        while self.maintenance == self.public:
            self.maintenance = rehearsal.free_port()
        names = {role: self.project + "-" + role + "-1" for role in (*intro.ROLES, *intro.ONE_SHOTS)}
        self.target = {"schema": 1, "kind": "rehearsal", "host_key_sha256": smoke.host_key, "origin": "https://localhost:%d" % self.public,
                       "project": self.project, "repository": str(self.repo), "compose_files": ["docker-compose.yml", str(self.overlay)],
                       "containers": names,
                       "volumes": {"pg": self.project + "_pg-db", "orthanc": self.project + "_orthanc-db",
                                   "emr_access": self.project + "_emr-access", "emr_state": self.project + "_emr-state"},
                       "networks": {"default": self.project + "_default", "workflow": self.project + "-workflow"},
                       "ports": {"maintenance": "127.0.0.1:%d:443" % self.maintenance, "public": ["127.0.0.1:%d:443" % self.public]},
                       "tls_certificate": "/etc/nginx/certs/kin.crt", "cron": None, "ca_file": str(self.root / "ca.pem"),
                       "keycloak_admin": "admin", "external_networks": {"proxy": {"halo_reports": self.halo_network}},
                       "declared_overlays": [], "tracked_overlay_reconcile": [], "fix_checkout_mode": False}
        self.values = {"POSTGRES_PASSWORD": secrets.token_urlsafe(24), "ORTHANC_PASS": secrets.token_urlsafe(24)}
        self.backups = self.root / "backups"
        self.backups.mkdir(mode=0o700)
        import ops_audit_integrity as audit
        audit.init(self.backups, audit.MIN_YEARS)
        self.records = intro.Records(self.root / "records")
        now = datetime.now(timezone.utc)
        images = smoke.images
        plan = {"schema": 1, "mode": intro.MODE, "unit": "RELEASE-TOOLS-CHECKPOINTS-SMOKE", "target_kind": "rehearsal",
                "target_manifest_sha256": hashlib.sha256(intro.canonical(self.target)).hexdigest(),
                "previous": {"sha": smoke.previous_sha, "images": dict(images["previous"])},
                "release": {"sha": smoke.target_sha, "images": dict(images["release"])},
                "compose": {"before_sha256": hexdigest("before " + self.project), "after_sha256": hexdigest("after " + self.project)},
                "secrets": {"required": ["POSTGRES_PASSWORD", "KIN_EMR_RUNTIME_PASSWORD", "ORTHANC_PASS"],
                            "absent": ["KIN_EMR_READER_PASSWORD", "KIN_EMR_RETENTION_PASSWORD"], "runtime": "KIN_EMR_RUNTIME_PASSWORD",
                            "installer": "POSTGRES_PASSWORD", "logins": {"kin_emr_reader": False, "kin_emr_retention": False},
                            "env_next_sha256": hexdigest("env.next " + self.project)},
                "migrations": {"before": copy.deepcopy(MIGRATIONS_BEFORE), "after": copy.deepcopy(MIGRATIONS_AFTER)},
                "storage": {"tablespace_path": intro.TABLESPACE, "postgres_uid": 70, "postgres_gid": 70, "node_uid": 1000, "node_gid": 1000},
                "members": {"realm_members": 2, "disabled": 1, "service_accounts": 1},
                "smoke": {"frame": dict(rehearsal.SYNTHETIC_FRAME), "member": {"roles": ["radiologist"], "group": "hallym"}},
                "probe": {"study": "SYNTHETIC-smoke", "event_id": str(uuid.uuid4()), "institution": "kin-center",
                          "approved_by": "native-smoke", "approved_at": now.isoformat()},
                "window": {"start": (now - timedelta(hours=1)).isoformat(), "end": (now + timedelta(hours=8)).isoformat()},
                "budget": {"capture_s": 3600, "introduce_s": 5400, "verify_s": 3600, "reopen_s": 1800, "rollback_s": 3600, "seed_s": 3600,
                           "min_free_bytes": 1024 ** 3},
                "backup_root": str(self.backups), "tool": intro.tool_hashes(),
                "seed": {"b0_dir": str(self.root / "unused-seed"), "b0_manifest_sha256": "0" * 64, "production_plan_sha256": "0" * 64},
                "projection_exempt": [], "rehearsal_host": None}
        self.plan_document = intro.plan_valid(plan)
        self.plan_sha256 = intro.plan_identity(plan)
        self.docker = rehearsal.CheckpointDocker(self, smoke.helper)

    # ── what bundle_inputs and a restore need again ──
    def descriptor(self):
        return {"label": self.label, "token": self.token, "project": self.project, "root": str(self.root), "target": self.target,
                "plan_document": self.plan_document, "plan_sha256": self.plan_sha256, "halo_network": self.halo_network,
                "values": self.values, "public": self.public, "maintenance": self.maintenance}

    @classmethod
    def restored(cls, smoke, descriptor):
        return cls(smoke, descriptor["label"], rebuild=dict(descriptor))

    def owned(self):
        return {"token": self.token, "projects": {self.project}, "tags": list(self.smoke.owned_tags.get(self.label, ()))}

    def names(self):
        return {role: self.target["containers"][role] for role in intro.ROLES}

    # ── the stack ──
    def publish(self, side, *, maintenance):
        """A ComposeEntry generation of this stack (the product's own publish/load/argv): pinned image IDs of one side,
        the proxy published on the public or the maintenance port, the halo overlay's external network."""
        services = {role: {"image": self.plan_document[side]["images"][role]} for role in intro.ROLES}
        services["proxy"]["ports"] = ("!override", [self.target["ports"]["maintenance"] if maintenance else self.target["ports"]["public"][0]])
        sources = [("docker-compose.yml", (self.repo / "docker-compose.yml").read_bytes()), (str(self.overlay), self.overlay.read_bytes())]

        def validate(command, effective):
            rendered = self.docker.run(command, cwd=str(self.repo), env={**cp.daemon_environment(), **effective}, timeout=60)
            cp.require(type(json.loads(rendered.stdout)) is dict, "SMOKE_FIXTURE", "the pinned Compose model does not render")
        entry = intro.ComposeEntry(self.root / "compose-entries")
        env_raw = "".join(key + "=" + value + "\n" for key, value in sorted(self.values.items())).encode()
        pointer = entry.publish(repository=self.repo, project=self.project, sources=sources, env_raw=env_raw, values=dict(self.values),
                                runtime=intro.override_yaml(services), plan_sha256=self.plan_sha256, validate=validate)
        return {**pointer, "root": str(entry.root)}

    def psql(self, sql, database="kin"):
        return self.docker.run(["docker", "exec", self.target["containers"]["db"], "psql", "-X", "-U", "kin", "-d", database, "-qAt",
                                "-v", "ON_ERROR_STOP=1", "-c", sql], timeout=120).stdout.decode().strip()

    def sql_file(self, sql, database="kin"):
        self.docker.run(["docker", "exec", "-i", self.target["containers"]["db"], "psql", "-X", "-U", "kin", "-d", database, "-q",
                         "-v", "ON_ERROR_STOP=1", "-f", "-"], input=sql.encode(), timeout=120)

    def exec(self, role, *args, user=None, data=None, check=True):
        command = ["docker", "exec", *(["-i"] if data is not None else []), *(["-u", user] if user else []),
                   self.target["containers"][role], *args]
        return self.docker.run(command, input=data, check=check, timeout=120)

    def wait_orthanc(self, seconds=90):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if self.exec("orthanc", "python3", "-c", ORTHANC_READY, check=False).returncode == 0:
                return
            time.sleep(1)
        raise SmokeFailure("Orthanc did not answer within %d s" % seconds)

    def model_phase(self, phase, **updates):
        """The explicit phase-end model of one phase (a fixture input, never a product phase): the phase's request, its own
        command record as HostOps writes one (Records.begin/command; the Records keep it as their commands file, as after a
        phase in the same process), plan.json, the complete PASS result of the product's STEPS, the history row binding it,
        the journal row and the state."""
        request = {"version": 1, "mode": intro.MODE, "phase": phase, "plan_sha256": self.plan_sha256, "nonce": uuid.uuid4().hex}
        digest = hashlib.sha256(intro.canonical(request)).hexdigest()
        records = self.records
        records.begin(phase, digest)
        records.put("plan.json", self.plan_document)
        steps = []
        for sid, name, _, _ in intro.STEPS[phase]:
            records.context = {"step": sid, "part": "step"}
            seq = records.command({"argv": ["docker", "inspect", self.target["containers"]["db"]], "env": [], "mutating": False,
                                   "timeout_s": 60, "started_utc": intro.utc_now().isoformat(), "outcome": "exit", "exit": 0,
                                   "seconds": 0.0, "stdout": None, "stderr": None, "model": "native-smoke phase-end model"})
            steps.append({"step": sid, "action": name, "outcome": "PASS", "seconds": 0.0,
                          "commands": {"file": records.commands_file, "first": seq, "last": seq}})
        records.context = {}
        written = {"steps": steps, "status": intro.DONE[phase], "phase": phase, "request_sha256": digest, "plan_sha256": self.plan_sha256,
                   "commands_file": records.commands_file, "model": "native-smoke phase-end model"}
        result_sha = records.put("result-" + phase + "-" + digest[:16] + ".json", written)
        state = records.state() or intro.new_state(self.plan_sha256, self.plan_document)
        state.update(updates)
        state.update(status=intro.DONE[phase], running=None)
        state["history"].append({"phase": phase, "status": "PASS", "request_sha256": digest, "seconds": 0.0, "result_sha256": result_sha,
                                 "steps": [[sid, "PASS"] for sid, _, _, _ in intro.STEPS[phase]]})
        records.save(state)
        records.journal({"event": "phase-end", "plan_sha256": self.plan_sha256, "phase": phase, "status": intro.DONE[phase],
                         "model": "native-smoke phase-end model"})
        with records.lease():  # a real phase holds the per-plan lease, so its lease file exists after it
            pass
        return state


class Smoke:
    def __init__(self, evidence):
        self.evidence = Path(evidence)
        self.token = uuid.uuid4().hex[:12]
        self.foreign_token = uuid.uuid4().hex[:12]
        self.started = time.monotonic()
        self.rows = []
        self.coverage = {key: [] for key in cp.SMOKE_PATHS}
        self.oracles = {key: [] for key in cp.SMOKE_ORACLES}
        self.owned_tags = {}
        self.stacks = {}
        self.extra_cleanup = []
        self.timings = {}
        self.private = self.fixture_root = None

    # ── recording ──
    def log(self, row):
        with open(self.evidence / "smoke-log.jsonl", "ab") as stream:
            stream.write(cp.canonical(row) + b"\n")

    def check(self, ids, name, condition, detail=None):
        row = {"ids": list(ids), "check": name, "outcome": "PASS" if condition else "FAIL",
               "t": round(time.monotonic() - self.started, 2), "detail": detail}
        self.log(row)
        for key in ids:
            (self.coverage if key in self.coverage else self.oracles)[key].append(row)
        if not condition:
            raise SmokeFailure(name + ": " + json.dumps(detail, default=str)[:600])
        return True

    def refusal(self, ids, name, code, action, *args, **kwargs):
        """`action` must refuse with exactly this code (another code, an exception or a success fails the check)."""
        try:
            action(*args, **kwargs)
        except cp.Refused as error:
            return self.check(ids, name, error.code == code, {"code": error.code, "message": str(error)[:400]})
        except Exception as error:
            return self.check(ids, name, False, {"expected": code, "raised": type(error).__name__, "message": str(error)[:400]})
        return self.check(ids, name, False, {"expected": code, "outcome": "success"})

    def raw(self, name, value):
        path = self.evidence / name
        path.write_bytes(cp.canonical(value) + b"\n")
        return name

    def budget(self, stage):
        self.timings[stage] = round(time.monotonic() - self.started, 1)
        if time.monotonic() - self.started > BODY_SECONDS:
            raise SmokeFailure("the smoke body exceeded %d s at %s" % (BODY_SECONDS, stage))

    def git(self, *args, cwd=None):
        return subprocess.run(["git", "-c", "user.name=kin-smoke", "-c", "user.email=kin-smoke@invalid", "-c", "commit.gpgsign=false",
                               "-c", "core.hooksPath=/dev/null", *args], cwd=cwd, check=True, capture_output=True, text=True, timeout=120)

    def docker(self):
        return rehearsal.CheckpointDocker(None, self.helper)

    # ── the run (smoke_run below gives the order) ──
    def prepare(self):
        """A02/A10: the fixed images by ID (present and absent), the host and runtime facts, the foreign sentinel."""
        docker = rehearsal.CheckpointDocker(None, None)
        ids = {}
        for name in (DB_IMAGE, ORTHANC_IMAGE):
            listed = docker.run(["docker", "image", "inspect", name], check=False)
            self.check(["A02"], "image prepared before the smoke: " + name, listed.returncode == 0,
                       "pull it before the smoke (a pull is preparation, never part of it)")
            ids[name] = json.loads(listed.stdout)[0]["Id"]
        self.helper = ids[DB_IMAGE]
        docker = self.docker()
        self.check(["A02"], "image_present for a present image ID", docker.image_present(ids[ORTHANC_IMAGE]) is True)
        self.check(["A02"], "image_present for an absent image ID", docker.image_present("sha256:" + "0" * 64) is False)
        previous = {"db": ids[DB_IMAGE], "keycloak": ids[DB_IMAGE], "orthanc": ids[ORTHANC_IMAGE], "api": ids[DB_IMAGE], "proxy": ids[DB_IMAGE]}
        self.images = {"previous": previous, "release": {**previous, "api": ids[ORTHANC_IMAGE]}}
        runtime = rehearsal.CheckpointDocker.runtime_facts()
        try:
            t16 = cp.host_admission(self.facts)
        except cp.Refused as error:
            t16 = {"admitted": False, "code": error.code, "detail": str(error)[:200]}
        self.raw("host-facts.json", {"host_facts": self.facts, "runtime": runtime, "smoke_needs": {"ram": SMOKE_RAM, "disk": SMOKE_DISK},
                                     "t16_needs": {"ram": cp.MIN_HOST_RAM, "disk": self.facts.get("required_disk_bytes")},
                                     "t16_admission_here": t16})
        self.runtime = runtime
        self.check(["A10"], "host facts observed now (daemon, endpoint, RAM, disk, labelled containers)",
                   self.facts["daemon_ok"] is True and self.facts["docker_endpoint"].startswith("unix:///") and self.facts["available_ram_bytes"] > 0,
                   {key: self.facts.get(key) for key in ("os", "docker_os", "daemon_identity", "architecture", "available_ram_bytes",
                                                         "available_disk_bytes", "foreign_containers")})
        self.check(["A10"], "runtime facts observed (Docker server, Compose, architecture)",
                   bool(runtime["docker_server"]) and bool(runtime["compose"]) and bool(runtime["arch"]), runtime)
        self.check(["A10"], "the smoke's tiny needs are not T16's D1034", SMOKE_RAM < cp.MIN_HOST_RAM,
                   {"smoke_ram": SMOKE_RAM, "t16_ram": cp.MIN_HOST_RAM, "t16_admission_here": t16})
        # A foreign sentinel of another owner (its own token and ledger): every cleanup must keep it.
        name = "kin-ckptsmoke-foreign-" + self.foreign_token[:10]
        labels = ["--label", "kin.ops.run=" + self.foreign_token]
        docker.run(["docker", "volume", "create", *labels, name])
        docker.run(["docker", "network", "create", *labels, name])
        docker.run(["docker", "create", "--name", name, *labels, "--network", "none", "--entrypoint", "true", self.helper])
        self.foreign = {"token": self.foreign_token, "projects": set(), "name": name}
        self.extra_cleanup.append(("foreign sentinel", self.foreign))

    def make_donor(self):
        """The fixture repository: the base Compose model at the previous commit, a marker added at the target commit."""
        donor = self.private / "donor"
        self.git("init", "-q", str(donor))
        (donor / "docker-compose.yml").write_text(json.dumps(BASE_COMPOSE, indent=1) + "\n", encoding="utf-8")
        self.git("-C", str(donor), "add", "docker-compose.yml")
        self.git("-C", str(donor), "commit", "-q", "-m", "native smoke previous")
        self.previous_sha = self.git("-C", str(donor), "rev-parse", "HEAD").stdout.strip()
        (donor / "target.txt").write_text("native smoke target\n", encoding="utf-8")
        self.git("-C", str(donor), "add", "target.txt")
        self.git("-C", str(donor), "commit", "-q", "-m", "native smoke target")
        self.target_sha = self.git("-C", str(donor), "rev-parse", "HEAD").stdout.strip()
        self.donor = donor

    def bootstrap(self, stack):
        """A04: the pinned generation, create without build/pull, the database started alone and judged ready, its SQL
        model, Orthanc with the synthetic instance, the waiting roles, the markers; then SEEDED's phase-end model."""
        pointer = stack.publish("previous", maintenance=False)
        docker = stack.docker
        docker.run(["docker", "network", "create", "--label", "kin.ops.run=" + stack.token, stack.halo_network])
        docker.compose_create(list(intro.ROLES))
        listed = {item["name"]: item for item in self.docker().inventory()["containers"]}
        self.check(["A04"], "compose create (no build, no pull) made every role from the pinned image IDs, none running",
                   all(listed.get(name, {}).get("image") == self.images["previous"][role] and listed[name]["running"] is False
                       for role, name in stack.names().items()), {role: listed.get(name, {}).get("image") for role, name in stack.names().items()})
        try:
            docker.wait_db_ready(seconds=4)
            ready = True
        except RuntimeError:
            ready = False
        self.check(["A04"], "a database that was never started is not judged ready", ready is False)
        docker.compose_start("db")
        docker.wait_db_ready()
        self.check(["A04"], "pg_isready answers once the database alone is started", True)
        stack.sql_file(SCHEMA_SQL % {"study": rehearsal.SYNTHETIC_STUDY, "time": SMOKE_TIME, "tablespace": intro.TABLESPACE})
        stack.sql_file("".join("INSERT INTO \"_prisma_migrations\"(id, checksum, finished_at, migration_name, applied_steps_count) "
                               "VALUES ('m%d', '%s', now(), '%s', 1);\n" % (index, checksum, name)
                               for index, (name, checksum) in enumerate(MIGRATIONS_BEFORE)))
        stack.sql_file(rehearsal.LEGACY_ROLES_SQL)
        stack.psql("CREATE DATABASE keycloak;")
        stack.sql_file(REALM_SQL, "keycloak")
        docker.compose_start("orthanc")
        stack.wait_orthanc()
        uploaded = stack.exec("orthanc", "python3", "-c", rehearsal.UPLOAD_SCRIPT, data=rehearsal.synthetic_dicom())
        self.check(["A08"], "the synthetic instance is stored in the real Orthanc", uploaded.returncode == 0)
        for role in ("keycloak", "api", "proxy"):
            docker.compose_start(role)
        for category, (role, path, owner, mode, data) in MARKERS.items():
            stack.exec(role, "sh", "-c", PLANT, "sh", path, owner, "%o" % mode, user="0", data=data)
        running = {item["name"] for item in self.docker().inventory()["containers"] if item["running"]}
        self.check(["A04"], "every role runs after its start", set(stack.names().values()) <= running)
        stack.model_phase("seed", compose_entry=pointer, entry_checkout="previous", checkout="previous", lock_token=None)

    def adapter_paths(self, stack):
        """A01/A02/A03: inventory over owned and foreign resources and an empty listing, existence checks and their daemon
        error, an owned alias on a shared image, the archive refusals before any write."""
        docker = stack.docker
        inventory = docker.inventory()
        mine = stack.owned()
        owned = {kind: sorted(item["name"] for item in inventory[kind] if cp.owned_resource(item, mine)) for kind in ("containers", "volumes", "networks")}
        foreign = [item["name"] for kind in ("containers", "volumes", "networks") for item in inventory[kind] if cp.owned_resource(item, self.foreign)]
        self.check(["A01"], "the inventory lists this stack's containers, volumes and networks by their labels",
                   owned["containers"] == sorted(stack.names().values()) and len(owned["volumes"]) == 6
                   and sorted(owned["networks"]) == sorted([stack.halo_network, stack.target["networks"]["default"]]), owned)
        self.check(["A01"], "the inventory lists the foreign sentinel, never as this stack's", sorted(foreign) == [self.foreign["name"]] * 3
                   and not any(cp.owned_resource(item, mine) for kind in ("containers", "volumes", "networks") for item in inventory[kind]
                               if item["name"] == self.foreign["name"]), foreign)
        empty = docker.inspect_all(["volume"], ["docker", "volume", "ls", "-q", "--filter", "label=kin.ckpt.smoke.none=" + self.token])
        self.check(["A01"], "an empty listing inspects nothing", empty == [])
        alias = stack.project + "-alias:smoke"
        docker.run(["docker", "tag", self.helper, alias])
        self.owned_tags.setdefault(stack.label, []).append(alias)
        images = {image["id"]: image["tags"] for image in docker.inventory()["images"]}
        self.check(["A01"], "the image listing names the owned alias beside the shared image's own name",
                   alias in images.get(self.helper, []) and DB_IMAGE in images.get(self.helper, []), images.get(self.helper))
        volume = stack.target["volumes"]["pg"]
        self.check(["A02"], "volume_exists for an existing volume", docker.volume_exists(volume) is True)
        self.check(["A02"], "volume_exists for an absent volume (the daemon answered)", docker.volume_exists(volume + "-absent") is False)
        unreachable = lambda environ=None: {**{k: v for k, v in os.environ.items() if not k.startswith(("DOCKER_", "COMPOSE_"))},
                                           "DOCKER_HOST": "unix:///nonexistent/kin-ckpt-smoke.sock"}
        with patch.object(cp, "daemon_environment", unreachable):
            try:
                docker.volume_exists(volume)
                outcome = "answered"
            except RuntimeError:
                outcome = "raised"
        self.check(["A02"], "a daemon that does not answer is an error, never an absent volume", outcome == "raised", outcome)
        # A03: damaged or link-carrying archives are refused before the daemon writes anything into the new volume.
        scratch = self.project_volume(stack, "scratch")
        for label, data in (("a link outside the declared tablespace", self.tar([("./escape", tarfile.SYMTYPE, "/etc")])),
                            ("a truncated archive", self.tar([("./data.bin", tarfile.REGTYPE, b"x" * 4096)])[:700])):
            path = self.private / "bad.tar"
            path.write_bytes(data)
            self.refusal(["A03", "N05"], "load_volume refuses " + label, "ARCHIVE_INVALID", docker.load_volume, scratch, path, "emr_state")
        listing = self.members(stack, scratch)
        self.check(["A03"], "nothing was written into the volume by a refused load", sorted(listing) == ["."], sorted(listing))
        docker.remove("volumes", scratch)

    def project_volume(self, stack, suffix):
        name = stack.project + "_" + suffix
        stack.docker.create_volume(name, {"com.docker.compose.project": stack.project, "kin.ops.run": stack.token})
        return name

    @staticmethod
    def tar(entries):
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode="w:", format=tarfile.PAX_FORMAT) as archive:
            for name, kind, value in [(".", tarfile.DIRTYPE, None), *entries]:
                info = tarfile.TarInfo(name)
                info.type, info.mode = kind, 0o700
                if kind == tarfile.SYMTYPE:
                    info.linkname = value
                if kind == tarfile.REGTYPE:
                    info.size = len(value)
                    archive.addfile(info, io.BytesIO(value))
                else:
                    archive.addfile(info)
        return stream.getvalue()

    def members(self, stack, volume, category=None):
        """{member: (type, uid, gid, mode, sha256 or link target)} of a real readonly export of one volume (A01's stdout
        branch, A03's re-export)."""
        path = self.private / ("export-" + uuid.uuid4().hex + ".tar")
        stack.docker.export_volume(volume, path)
        try:
            return self.listing(path, category)
        finally:
            path.unlink(missing_ok=True)

    @staticmethod
    def listing(path, category=None):
        cp.archive_members(path, category=category)
        out = {}
        with tarfile.open(path, "r:") as archive:
            for member in archive.getmembers():
                name = (member.name[2:] if member.name.startswith("./") else member.name).rstrip("/") or "."
                marker = member.isfile() and name.endswith("kin-smoke-marker")
                digest = hashlib.sha256(archive.extractfile(member).read()).hexdigest() if marker else None
                out[name] = ("link" if member.issym() else "file" if member.isfile() else "dir", member.uid, member.gid,
                             member.mode & 0o7777, member.linkname if member.issym() else digest)
        return out

    @staticmethod
    def found(listings):
        out = {category: listing.get("kin-smoke-marker") for category, listing in listings.items()}
        out["pg_tablespace_links"] = sorted((name, entry[4]) for name, entry in listings["pg"].items() if entry[0] == "link")
        return out

    def markers(self, stack):
        """The markers as a real readonly re-export of each restored volume shows them."""
        volumes = {**stack.target["volumes"], "proxy_certs": stack.project + "_proxy-certs", "extra": stack.project + "_kc-extra"}
        return self.found({category: self.members(stack, volumes[category], None if category == "extra" else category) for category in MARKERS})

    def sealed_markers(self, sealed):
        """The markers as the sealed bundle's own volume archives (the captured readonly exports) carry them."""
        payload = Path(sealed["bundle"]) / "payload"
        listings = {}
        for category, volume in sealed["manifest"]["owned"]["volumes"].items():
            key = "extra" if category.startswith("extra:") else category
            listings[key] = self.listing(payload / volume["member"], None if key == "extra" else key)
        return self.found(listings)

    def expected_markers(self):
        out = {category: ("file", int(owner.split(":")[0]), int(owner.split(":")[1]), mode, hashlib.sha256(data).hexdigest())
               for category, (_, _, owner, mode, data) in MARKERS.items()}
        return out

    # ── N01/N02: the 48a28dd observation and the digest-only fix, on copies of the SEEDED records ──
    def diagnostic_records(self, stack, name):
        folder = self.evidence / name / "records"
        shutil.copytree(stack.records.directory, folder)
        records = intro.Records(folder)
        # As in the T16 r4 process after the seed phase: the Records still name the closed phase's command record.
        records.commands_file, records.seq = stack.records.commands_file, stack.records.seq
        return records

    def baseline_oracles(self, stack):
        entry_root, lock = stack.root / "compose-entries", intro.lock_path(stack.repo)
        state = stack.records.state()
        diag = self.diagnostic_records(stack, "n01-48a28dd")
        before = cp.original_records(diag.directory, entry_root=entry_root, lock_path=lock)
        try:
            snapshot = frozen_observe_48a28dd(stack, diag, "seeded")
            error = None
        except Exception as raised:
            snapshot, error = None, type(raised).__name__
        facts = (snapshot or {}).get("facts") or {}
        self.raw("n01-48a28dd/snapshot.json", snapshot)
        self.check(["N01"], "48a28dd's observation of SEEDED leaves the database and fences facts as observation errors (no request digest)",
                   error is None and facts.get("database") == {"outcome": "ERROR", "reason": "AttributeError"}
                   and facts.get("fences") == {"outcome": "ERROR", "reason": "AttributeError"},
                   {"error": error, "database": facts.get("database"), "fences": facts.get("fences")})
        stored = len(list(self.store.root.iterdir()))
        self.refusal(["N01"], "48a28dd's observation is NOT_A_BOUNDARY at SEEDED", "NOT_A_BOUNDARY", cp.boundary_contract, "seeded", snapshot,
                     state=state, plan=stack.plan_document, target=stack.target)
        self.check(["N01"], "no bundle was sealed", len(list(self.store.root.iterdir())) == stored)
        after = cp.original_records(diag.directory, entry_root=entry_root, lock_path=lock)
        changed = sorted(key for key in set(before) | set(after) if before.get(key) != after.get(key))
        self.check(["N01"], "48a28dd appended its observation commands to the closed phase's command record (the r4 raw: seq 6899-6916)",
                   changed == ["records/" + stack.records.commands_file], changed)
        # N02: the same frozen context with only a request digest added, on another copy.
        diag = self.diagnostic_records(stack, "n02-digest-only")
        before = cp.original_records(diag.directory, entry_root=entry_root, lock_path=lock)
        snapshot = frozen_observe_48a28dd(stack, diag, "seeded", request_sha256=hexdigest("digest-only " + self.token))
        self.raw("n02-digest-only/snapshot.json", snapshot)
        try:
            cp.boundary_contract("seeded", snapshot, state=state, plan=stack.plan_document, target=stack.target)
            contract = "PASS"
        except cp.Refused as refused:
            contract = refused.code
        after = cp.original_records(diag.directory, entry_root=entry_root, lock_path=lock)
        changed = sorted(key for key in set(before) | set(after) if before.get(key) != after.get(key))
        workers = (json.loads((diag.directory / "state.json").read_bytes()).get("workers") or {})
        self.check(["N02"], "the digest-only fix settles its exec workers and its snapshot meets the contract",
                   contract == "PASS" and workers and all(row["state"] == "QUIET" for row in workers.values()),
                   {"contract": contract, "workers": len(workers)})
        self.check(["N02"], "the digest-only fix rewrote the closed phase's state.json and command record (caught by the byte guard)",
                   changed == sorted(["records/state.json", "records/" + stack.records.commands_file]), changed)

    # ── A07: further commands in the same observation context ──
    def engine_probe(self, ops, context, snapshot):
        db = ops.names["db"]
        failed = ops.cmd(["docker", "exec", db, "sh", "-c", "exit 3"], check=False)
        passed = ops.cmd(["docker", "exec", db, "sh", "-c", "printf out; printf err >&2"])
        absent = ops.inspect_container(db + "-absent")
        workers = list(context.state["workers"].values())
        last, previous = workers[-1], workers[-2]
        self.check(["A07"], "a nonzero exec: the command exit is the Engine's own exit of the server process",
                   failed.returncode == 3 and previous["server_exit"] == 3 and previous["client_exit"] == 3 and previous["state"] == "QUIET",
                   {key: previous.get(key) for key in ("server_exit", "client_exit", "state")})
        self.check(["A07"], "a passing exec keeps stdout and stderr apart and settles QUIET with its exec ID and container",
                   passed.stdout == b"out" and passed.stderr == b"err" and last["server_exit"] == 0 and last["state"] == "QUIET"
                   and last["exec_observation"]["ContainerID"] == last["container_id"] and last["exec_observation"]["Running"] is False,
                   {key: last.get(key) for key in ("server_exit", "state", "exec_id")})
        self.check(["A06"], "an exact-name lookup of an absent container is an observed absence", absent is None)
        context.state["workers"]["synthetic-unsettled"] = {"nonce": "synthetic-unsettled", "kind": "exec", "state": "PLANNED"}
        try:
            ops.cmd(["docker", "exec", db, "true"])
            refused = False
        except intro.Unknown:
            refused = True
        finally:
            del context.state["workers"]["synthetic-unsettled"]
        self.check(["A07"], "no new exec starts while a registered worker is unsettled", refused)

    # ── A06/A12: one checkpoint through the live consumers ──
    def write_context(self):
        stacks = {label: stack.descriptor() for label, stack in self.stacks.items() if stack.root.exists()}
        document = {"previous_sha": self.previous_sha, "target_sha": self.target_sha, "images": self.images, "legacy": None,
                    "members": None, "b0": None, "copy_dir": None, "production_plan": None, "stacks": stacks}
        (self.fixture_root / cp.CONTEXT_FILE).write_bytes(cp.canonical(document) + b"\n")
        (self.fixture_root / cp.SECRETS_INVENTORY).write_bytes(cp.canonical([]) + b"\n")

    def identity(self, stack, checkpoint_id):
        actual = cp.source_identity(ROOT)

        def build(state):
            return {"tool_tree_sha256_at_checkpoint": actual["tool"]["sha256"], "tool_tree_sha256_at_resume": None,
                    "source_tree_sha256": actual["source"]["sha256"], "harness_tree_sha256": actual["harness"]["sha256"],
                    "tool_files_actual_raw_sha256": actual["tool_files"], "source_b0_manifest_sha256": None, "clone_b0_manifest_sha256": None,
                    "payload_manifest_sha256": "0" * 64, "image_ids": {**self.images, "helper": self.helper}, "plan_sha256": stack.plan_sha256,
                    "target_manifest_sha256": stack.plan_document["target_manifest_sha256"], "phase_reached": checkpoint_id,
                    "created_utc": cp.now_utc().isoformat(), "resumed_utc": None, "host_key_sha256": self.host_key,
                    "daemon_identity": self.facts["daemon_identity"], "absolute_fixture_root": str(self.fixture_root),
                    "runtime_identity": dict(self.runtime), "segment_source_map": {}}
        return build

    def capture(self, stack, checkpoint_id, *, probe=None):
        owned = {"token": stack.token, "projects": {stack.project}, "networks": [{"name": stack.halo_network, "labels": {"kin.ops.run": stack.token}}],
                 "stack": {"root": str(stack.root), "containers": stack.names()}}
        records_before = cp.original_records(stack.records.directory, entry_root=stack.root / "compose-entries",
                                             lock_path=intro.lock_path(stack.repo))
        state_raw = (stack.records.directory / "state.json").read_bytes()
        bundle, observation = live.seal_boundary(checkpoint_id, stack, store=self.store, fixture_root=self.fixture_root, helper=self.helper,
                                                 identity=self.identity(stack, checkpoint_id), owned=owned, execution_kind="fresh",
                                                 tls_not_after=(datetime.now(timezone.utc) + timedelta(days=30)).isoformat(),
                                                 before_seal=self.write_context, leaf={"unit": "native-smoke", "attempt": 1},
                                                 source={"smoke": self.token}, probe=probe)
        self.observed(stack, checkpoint_id, observation, "capture")
        records_after = cp.original_records(stack.records.directory, entry_root=stack.root / "compose-entries",
                                            lock_path=intro.lock_path(stack.repo))
        manifest, _ = cp.load_bundle(bundle)
        self.raw("bundle-" + checkpoint_id + ".json", manifest)
        self.check(["A12", "N02"], checkpoint_id + ": the original records are byte-identical before and after the capture",
                   records_before == records_after, sorted(k for k in records_before if records_before.get(k) != records_after.get(k)))
        self.check(["A12"], checkpoint_id + ": the bundle binds the state boundary_publishable judged (S) and its capture observation",
                   manifest["bindings"]["state"]["sha256"] == hashlib.sha256(state_raw).hexdigest()
                   and manifest["bindings"]["observation"]["sha256"] == observation["result_sha256"], manifest["bindings"]["state"])
        stopped = {item["name"]: item for item in stack.docker.inventory()["containers"] if item["name"] in stack.names().values()}
        exits = {name: json.loads(stack.docker.run(["docker", "inspect", name]).stdout)[0]["State"] for name in stopped}
        self.check(["A05"], checkpoint_id + ": every role was stopped normally (exit 0/143, no OOM kill), none still running",
                   all(not item["running"] for item in stopped.values()) and all(state["ExitCode"] in (0, 143) and not state["OOMKilled"]
                                                                                for state in exits.values()),
                   {name: (state["ExitCode"], state["OOMKilled"]) for name, state in exits.items()})
        return {"bundle": bundle, "manifest": manifest, "observation": observation}

    def observed(self, stack, checkpoint_id, observation, purpose):
        """A06/A07 over one observation record: the complete product snapshot and its own settled workers."""
        spec = cp.CHECKPOINTS[checkpoint_id]
        snapshot, folder = observation["snapshot"], observation["folder"]
        facts = {key: value.get("value") for key, value in snapshot["facts"].items()}
        state = json.loads((folder / "state.json").read_bytes())
        mine = [row for row in state.get("workers", {}).values() if row.get("request_sha256") == observation["summary"]["request_sha256"]]
        running = {role for role, fact in facts["containers"].items() if fact["value"]["running"]}
        desired = set(intro.ROLES) if intro.BOUNDARY_RUNNING[spec["boundary"]] == "all" else set(intro.BOUNDARY_RUNNING[spec["boundary"]].split())
        after = spec["phase"] in ("introduce", "verify")
        self.check(["A06"], checkpoint_id + " " + purpose + ": every product fact observed OK (containers, checkout, entry, lock, database, fences, workers)",
                   all(value.get("outcome") == "OK" for value in snapshot["facts"].values()) and running == desired
                   and facts["database"]["ready"] is True
                   and [row[:2] for row in facts["database"]["migrations"]] == (MIGRATIONS_AFTER if after else MIGRATIONS_BEFORE)
                   and facts["checkout"]["sha"] == (self.target_sha if after else self.previous_sha)
                   and facts["fences"]["cron"] == "not-managed" and facts["workers"] == {"quiet": True, "pending": []},
                   {"running": sorted(running), "fences": facts["fences"], "entry": facts["compose_entry"], "lock": facts["lock"]})
        self.check(["A06"], checkpoint_id + " " + purpose + ": the observed entry is the stack's own generation (its ComposeEntry root kept)",
                   facts["compose_entry"] == {key: json.loads((stack.records.directory / "state.json").read_bytes())["compose_entry"][key]
                                              for key in ("generation", "sha256")})
        self.check(["A07"], checkpoint_id + " " + purpose + ": the observation's own exec workers settled QUIET with Engine exec IDs and server exits",
                   len(mine) >= 3 and all(row["kind"] == "exec" and row["state"] == "QUIET" and cp.HASH.fullmatch(row["exec_id"])
                                          and type(row["server_exit"]) is int for row in mine), len(mine))
        self.check(["A06"], checkpoint_id + " " + purpose + ": its observation record is complete and bound (request, state, snapshot, commands, logs)",
                   cp.observation_valid(cp.folder_files(folder), checkpoint_id=checkpoint_id, purpose=purpose, plan_sha256=stack.plan_sha256) is not None)

    def roundtrip(self, stack, checkpoint_id, sealed, *, all_running):
        """A11/A12/A03/A04/A08/N05: cleanup by exact ownership, refusals before a restore creates anything, the cold restore
        into new resources, the restore observation, the product facts and the volume bytes again."""
        manifest, bundle = sealed["manifest"], sealed["bundle"]
        facts = manifest["boundary"]["facts"]
        self.check(["A08"], checkpoint_id + ": the boundary facts read the real database (migrations, legacy grants, realm, study, roles)",
                   [row[:2] for row in facts["migrations"]] == MIGRATIONS_BEFORE and facts["legacy"]["schema_owner"] == "kin_legacy_group"
                   and facts["realm"] == {"realm_members": 2, "disabled": 1, "service_accounts": 1}
                   and [row["uid"] for row in facts["data"]["study"]] == [rehearsal.SYNTHETIC_STUDY], {k: facts.get(k) for k in ("realm", "migrations")})
        if all_running:
            self.check(["A08"], checkpoint_id + ": Orthanc running: the synthetic frame through the real lookup and frame path",
                       facts.get("frame") == {"instances": 1, "frame_sha256": rehearsal.SYNTHETIC_FRAME["sha256"]}, facts.get("frame"))
        else:
            self.check(["A08"], checkpoint_id + ": Orthanc stopped: no frame is read, the stopped roles are facts",
                       "frame" not in facts and not facts["containers"]["orthanc"]["running"] and facts["containers"]["db"]["running"],
                       {role: value["running"] for role, value in facts["containers"].items()})
        markers = self.sealed_markers(sealed)
        self.check(["A03", "A01"], checkpoint_id + ": the readonly exports the bundle sealed carry each volume's marker (bytes, owner, mode) and the "
                   "tablespace link", {k: markers.get(k) for k in MARKERS} == self.expected_markers()
                   and len(markers["pg_tablespace_links"]) == 1 and markers["pg_tablespace_links"][0][1] == intro.TABLESPACE, markers)
        inventory = self.docker().inventory()
        cleanup = cp.cleanup_owned(self.docker(), stack.owned())
        after = self.docker().inventory()
        self.check(["A11"], checkpoint_id + ": cleanup removed exactly this stack's containers, volumes, networks and owned aliases",
                   cleanup["complete"] and not cp.owned_remaining(after, stack.owned()), cleanup)
        self.check(["A11"], checkpoint_id + ": the foreign sentinel, the shared image and its own name are kept",
                   sorted(item["name"] for kind in ("containers", "volumes", "networks") for item in after[kind] if cp.owned_resource(item, self.foreign))
                   == [self.foreign["name"]] * 3 and any(DB_IMAGE in image["tags"] for image in after["images"] if image["id"] == self.helper),
                   len(inventory["containers"]))
        self.owned_tags[stack.label] = []
        cp.remove_private_root(self.fixture_root, owner_root=self.private)
        # N05: an occupied volume name and an absent image refuse before the restore creates anything.
        occupied = manifest["owned"]["volumes"]["pg"]["name"]
        stack.docker.create_volume(occupied, {"kin.ops.run": stack.token})
        before = self.docker().inventory()
        self.refusal(["N05"], checkpoint_id + ": an occupied volume name refuses the restore", "RESOURCE_EXISTS", cp.restore_checkpoint, manifest, bundle,
                     backend=stack.docker, fixture_root=self.fixture_root, names=stack.names(), images_present=stack.docker.image_present,
                     observe=lambda sid: None)
        stale = copy.deepcopy(manifest)
        stale["identity"]["image_ids"]["helper"] = "sha256:" + "0" * 64
        self.refusal(["N05"], checkpoint_id + ": an image that is not present refuses the restore", "STALE_IMAGE", cp.restore_checkpoint, stale, bundle,
                     backend=stack.docker, fixture_root=self.fixture_root, names=stack.names(), images_present=stack.docker.image_present,
                     observe=lambda sid: None)
        ids = lambda listing: {kind: sorted(item["id"] for item in listing[kind]) for kind in ("containers", "volumes", "networks")}
        self.check(["N05"], checkpoint_id + ": the refused restores created no resource and no fixture root",
                   ids(self.docker().inventory()) == ids(before) and not self.fixture_root.exists())
        stack.docker.remove("volumes", occupied)
        holder = {}

        def load(root):
            holder["stack"] = TinyStack.restored(self, json.loads((root / cp.CONTEXT_FILE).read_bytes())["stacks"][stack.label])
            self.stacks[stack.label] = holder["stack"]
            return holder["stack"]
        restored, observation, mapping = live.restore_boundary(manifest, bundle, fixture_root=self.fixture_root, helper=self.helper, load=load,
                                                               leaf={"unit": "native-smoke", "attempt": 1}, source={"smoke": self.token})
        running = {item["name"] for item in self.docker().inventory()["containers"] if item["running"] and item["name"] in restored.names().values()}
        expected = set(restored.names().values()) if all_running else {restored.target["containers"]["db"]}
        self.check(["A04", "A12"], checkpoint_id + ": the cold restore runs exactly the boundary's roles from the pinned generation",
                   running == expected, sorted(running))
        self.observed(restored, checkpoint_id, observation, "restore")
        self.check(["A12", "A08"], checkpoint_id + ": the restored product facts equal the checkpoint's (only container IDs differ)",
                   sorted(mapping["compared"]) == sorted(facts) and all(row["checkpoint"] != row["restored"] for row in mapping["container_ids"].values()),
                   mapping)
        self.check(["A12"], checkpoint_id + ": the restore observation names the parent bundle and leaves the parent untouched",
                   json.loads((observation["folder"] / "request.json").read_bytes())["parent_manifest_sha256"] == bundle.name
                   and cp.load_bundle(bundle)[0] == manifest)
        markers = self.markers(restored)
        self.check(["A03"], checkpoint_id + ": the restored volumes carry the markers with their bytes, owner and mode, and the tablespace link",
                   {k: markers[k] for k in MARKERS} == self.expected_markers() and markers["pg_tablespace_links"][0][1] == intro.TABLESPACE, markers)
        return restored

    def held(self, stack):
        """HELD: the fence's stop order (writers, then the database alone remains), the operations lock taken, capture's
        phase-end model; capture and the database-only roundtrip."""
        for role in intro.FENCE_ORDER:
            outcome = stack.docker.stop(stack.target["containers"][role])
            self.check(["A05"], "stop " + role + " normally", outcome["exit_code"] in (0, 143) and not outcome["forced"] and outcome["running"] is False,
                       outcome)
        token = intro.acquire_lock(stack.repo)
        stack.model_phase("capture", lock_token=token, fenced={"at": intro.utc_now().isoformat(), "model": True})
        sealed = self.capture(stack, "held")
        self.budget("held capture")
        return self.roundtrip(stack, "held", sealed, all_running=False)

    def late_boundaries(self, stack):
        """INTRODUCED and VERIFIED after migration with the maintenance ingress (the release generation), then N03/N04 on
        VERIFIED: a wrong migration checksum, an unsettled worker in the boundary state, a state changed during the
        observation and the database stopped are each refused; a tampered observation folder is refused at consumption."""
        self.git("-C", str(stack.repo), "-c", "advice.detachedHead=false", "checkout", "-q", "--detach", self.target_sha)
        pointer = stack.publish("release", maintenance=True)
        stack.sql_file("INSERT INTO \"_prisma_migrations\"(id, checksum, finished_at, migration_name, applied_steps_count) "
                       "VALUES ('m2', '%s', now(), '%s', 1);\nCREATE ROLE kin_runtime NOLOGIN;\nCREATE ROLE kin_emr_owner NOLOGIN;\n"
                       % (MIGRATIONS_AFTER[-1][1], MIGRATIONS_AFTER[-1][0]))
        stack.docker.compose(["up", "-d", "--no-build", "--pull", "never", *intro.ROLES])
        stack.model_phase("introduce", checkout="target", entry_checkout="target", compose_entry=pointer, db_changed=True)
        observe = lambda checkpoint_id, **kwargs: stack.docker.observe(checkpoint_id, purpose="capture", leaf={"unit": "native-smoke"}, **kwargs)
        with stack.records.lease():
            self.observed(stack, "introduced", observe("introduced"), "capture")
        stack.model_phase("verify")
        with stack.records.lease():
            self.observed(stack, "verified", observe("verified"), "capture")
        self.tampered(stack)
        state_path = stack.records.directory / "state.json"
        model = state_path.read_bytes()
        # N03: facts that are wrong now, whatever the earlier phase PASS says.
        stack.psql("UPDATE \"_prisma_migrations\" SET checksum='%s' WHERE id='m2';" % ("0" * 64))
        with stack.records.lease():
            self.refusal(["N03"], "a wrong migration checksum is NOT_A_BOUNDARY", "NOT_A_BOUNDARY", observe, "verified")
        stack.psql("UPDATE \"_prisma_migrations\" SET checksum='%s' WHERE id='m2';" % MIGRATIONS_AFTER[-1][1])
        unsettled = json.loads(model)
        unsettled.setdefault("workers", {})["w-planned"] = {"nonce": "w-planned", "kind": "exec", "state": "PLANNED"}
        stack.records.save(unsettled)
        with stack.records.lease():
            self.refusal(["N03"], "a boundary state with an unsettled worker is refused before any command", "OBSERVATION_REFUSED", observe, "verified")
        folders = sorted((stack.records.directory / cp.OBSERVATION_DIR).iterdir(), key=lambda path: path.stat().st_mtime_ns)
        self.check(["N03"], "the refused observation ran no command", not any(folders[-1].glob("commands-*.jsonl")), folders[-1].name)
        state_path.write_bytes(model)

        def rewrite(ops, context, snapshot):
            state_path.write_bytes(model.replace(b'"status":"VERIFIED"', b'"status":"VERIFIED","edited":true'))
        with stack.records.lease():
            self.refusal(["N04"], "the original state changed during the observation refuses it", "ORIGINAL_CHANGED", observe, "verified", probe=rewrite)
        state_path.write_bytes(model)
        stack.docker.stop(stack.target["containers"]["db"])
        with stack.records.lease():
            try:
                observe("verified")
                code = "PASS"
            except cp.Refused as error:
                code = error.code
        latest = sorted((stack.records.directory / cp.OBSERVATION_DIR).iterdir(), key=lambda p: p.stat().st_mtime_ns)[-1]
        snapshot = json.loads((latest / "snapshot.json").read_bytes())
        summary = json.loads((latest / cp.OBSERVATION_RESULT).read_bytes())
        # The database-clients exec meets a stopped container: its worker is UNKNOWN, so the refusal may name the unsettled
        # observation before the contract; either way nothing passes on an earlier PASS.
        self.check(["N03"], "a stopped database refuses the observation (its fact is an observation error, not a past PASS)",
                   code in ("NOT_A_BOUNDARY", "OBSERVATION_UNSETTLED") and summary["outcome"] != "PASS"
                   and snapshot["facts"]["database"]["outcome"] == "ERROR", {"code": code, "database": snapshot["facts"]["database"]})
        cleanup = cp.cleanup_owned(self.docker(), stack.owned())
        self.check(["A11"], "the late stack's resources are removed by ownership", cleanup["complete"], cleanup)
        cp.preserve_records({stack.label: stack.records.directory}, self.evidence)
        del self.stacks[stack.label]

    def tampered(self, stack):
        """N04 on real records: copies of a VERIFIED observation folder with one request, command record, snapshot or worker
        record changed or deleted are refused at consumption."""
        folder = sorted((stack.records.directory / cp.OBSERVATION_DIR).iterdir(), key=lambda path: path.stat().st_mtime_ns)[-1]
        files = cp.folder_files(folder)
        commands = next(name for name in files if name.startswith("commands-"))
        self.check(["N04"], "the untouched observation folder is valid",
                   cp.observation_valid(files, checkpoint_id="verified", purpose="capture") is not None)
        state = json.loads(files["state.json"])
        nonce = next(iter(state["workers"]))
        state["workers"][nonce]["state"] = "UNKNOWN"
        changes = {"the request edited": ("request.json", files["request.json"].replace(b'"capture"', b'"restore"')),
                   "the request deleted": ("request.json", None), "the command record deleted": (commands, None),
                   "the snapshot edited": ("snapshot.json", files["snapshot.json"].replace(b'"ready":true', b'"ready":false')),
                   "a worker record made UNKNOWN": ("state.json", cp.canonical(state) + b"\n")}
        for label, (name, data) in changes.items():
            copied = dict(files)
            if data is None:
                del copied[name]
            else:
                copied[name] = data
            self.refusal(["N04"], "an observation folder with " + label + " is refused", "OBSERVATION_INVALID", cp.observation_valid, copied,
                         checkpoint_id="verified", purpose="capture")

    def failure_lineage(self):
        """failure-held, the separate forced lineage: its own stack, observed at HELD; then a persistent file in a stopped
        role's writable layer (beside an allowed transient one) refuses its capture before any member is written."""
        stack = self.stacks["failure"] = TinyStack(self, "failure")
        pointer = stack.publish("previous", maintenance=False)
        stack.docker.run(["docker", "network", "create", "--label", "kin.ops.run=" + stack.token, stack.halo_network])
        stack.docker.compose_create(list(intro.ROLES))
        stack.docker.compose_start("db")
        stack.docker.wait_db_ready()
        stack.sql_file(SCHEMA_SQL % {"study": rehearsal.SYNTHETIC_STUDY, "time": SMOKE_TIME, "tablespace": intro.TABLESPACE})
        stack.sql_file("".join("INSERT INTO \"_prisma_migrations\"(id, checksum, finished_at, migration_name, applied_steps_count) "
                               "VALUES ('m%d', '%s', now(), '%s', 1);\n" % (index, checksum, name)
                               for index, (name, checksum) in enumerate(MIGRATIONS_BEFORE)))
        stack.psql("CREATE DATABASE keycloak;")
        stack.sql_file(REALM_SQL, "keycloak")
        stack.docker.compose_start("api")
        stack.exec("api", "sh", "-c", "echo transient > /tmp/kin-smoke-transient && echo persistent > /etc/kin-smoke-persistent")
        stack.docker.stop(stack.target["containers"]["api"])
        token = intro.acquire_lock(stack.repo)
        stack.model_phase("capture", compose_entry=pointer, entry_checkout="previous", checkout="previous", lock_token=token,
                          fenced={"at": intro.utc_now().isoformat(), "model": True})
        with stack.records.lease():
            self.observed(stack, "failure-held", stack.docker.observe("failure-held", purpose="capture", leaf={"unit": "native-smoke"}), "capture")
        changes = stack.docker.writable_changes(stack.target["containers"]["api"])
        self.check(["A05"], "docker diff of a stopped role lists its transient and its persistent change",
                   any("/tmp/kin-smoke-transient" in line for line in changes) and any("/etc/kin-smoke-persistent" in line for line in changes), changes)
        stored = sorted(path.name for path in self.store.root.iterdir())
        owned = {"token": stack.token, "projects": {stack.project}, "networks": [], "stack": {"root": str(stack.root), "containers": stack.names()}}
        try:
            live.seal_boundary("failure-held", stack, store=self.store, fixture_root=self.fixture_root, helper=self.helper,
                               identity=self.identity(stack, "failure-held"), owned=owned, execution_kind="fresh",
                               tls_not_after=(datetime.now(timezone.utc) + timedelta(days=30)).isoformat(), before_seal=self.write_context)
            outcome = "sealed"
        except cp.Refused as error:
            outcome = error.code + ": " + str(error)
        self.check(["A05", "N05"], "a persistent writable-layer file refuses the capture (WRITABLE_LAYER), the transient one is allowed",
                   outcome.startswith("WRITABLE_LAYER") and "/etc/kin-smoke-persistent" in outcome and "kin-smoke-transient" not in outcome, outcome)
        self.check(["A05"], "the refused capture wrote no bundle", sorted(path.name for path in self.store.root.iterdir()) == stored)
        # A11: two owned aliases of an image that has no other name: one is kept (its last name), never the image.
        name = stack.target["containers"]["keycloak"]
        image = stack.docker.run(["docker", "commit", "--change", "LABEL kin.ops.run=" + stack.token, name,
                                  stack.project + "-private:a"]).stdout.decode().strip()
        stack.docker.run(["docker", "tag", image, stack.project + "-private:b"])
        self.owned_tags["failure"] = [stack.project + "-private:a", stack.project + "-private:b"]
        self.private_image = image
        cleanup = cp.cleanup_owned(self.docker(), stack.owned())
        left = [tags for ident, tags in ((item["id"], item["tags"]) for item in self.docker().inventory()["images"]) if ident == image]
        self.check(["A11"], "the last owned alias of an image without another name is kept and the cleanup is incomplete",
                   cleanup["complete"] is False and left and len(left[0]) == 1 and any("last name" in error for error in cleanup["errors"]),
                   {"cleanup": cleanup, "left": left})
        inspected = json.loads(stack.docker.run(["docker", "image", "inspect", image]).stdout)[0]
        if (inspected["Config"].get("Labels") or {}).get("kin.ops.run") == stack.token:
            stack.docker.run(["docker", "image", "rm", image])
        self.owned_tags["failure"] = []
        self.check(["A11"], "its owner removed the private image by its own label", not stack.docker.image_present(image))
        self.check(["A11"], "nothing of the failure stack remains", not cp.owned_remaining(self.docker().inventory(), stack.owned()))
        cp.preserve_records({stack.label: stack.records.directory}, self.evidence)
        del self.stacks["failure"]

    def git_closure(self):
        """A09: the seal left each clone with its own object closure (checked with the donor moved away), and the r4 real
        Git contracts (CheckpointGitClosureTests) pass on this host's git."""
        import ops_release_checkpoints_test as contracts
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(contracts.CheckpointGitClosureTests)
        result = unittest.TestResult()
        suite.run(result)
        self.check(["A09"], "the r4 real-Git contracts pass here (shared and shallow clones, a missing object is the error path)",
                   result.testsRun == 2 and not result.failures and not result.errors and not result.skipped,
                   {"run": result.testsRun, "failures": [text[-300:] for _, text in result.failures + result.errors]})

    def sealed_clone_closure(self, stack):
        moved = self.donor.with_name("donor-moved")
        self.donor.rename(moved)
        try:
            rehearsal.CheckpointDocker.git_connected(stack.repo)
            tree = self.git("-C", str(stack.repo), "cat-file", "-t", "HEAD^{tree}").stdout.strip()
            shown = self.git("-C", str(stack.repo), "show", "HEAD:docker-compose.yml").stdout
            alternates = (stack.repo / ".git" / "objects" / "info" / "alternates").exists()
        finally:
            moved.rename(self.donor)
        self.check(["A09"], "the sealed clone reads its tree and files with the donor moved away (no alternate left)",
                   tree == "tree" and json.loads(shown) == BASE_COMPOSE and not alternates)

    # ── cleanup ──
    def cleanup(self):
        """Every owned stack, alias and the foreign sentinel by its own ledger, then the private root; absence observed."""
        started, errors, remaining = time.monotonic(), [], []
        docker = rehearsal.CheckpointDocker(None, getattr(self, "helper", None))
        for label, stack in list(self.stacks.items()):
            try:
                cp.preserve_records({label: stack.records.directory}, self.evidence)
            except Exception as error:
                errors.append("preserve " + label + ": " + type(error).__name__)
            result = cp.cleanup_owned(docker, stack.owned())
            errors += result["errors"]
            remaining += result["remaining"]
        if getattr(self, "private_image", None) and docker.image_present(self.private_image):
            docker.run(["docker", "image", "rm", "-f", self.private_image], check=False)
        for label, owned in self.extra_cleanup:
            result = cp.cleanup_owned(docker, owned)
            errors += [label + ": " + error for error in result["errors"]]
            remaining += result["remaining"]
        if self.private is not None and self.private.exists():
            shutil.rmtree(self.private, ignore_errors=True)
            if self.private.exists():
                errors.append("the private root is not removed: " + str(self.private))
        try:
            tokens = {self.token, self.foreign_token}
            left = [item["name"] for kind in ("containers", "volumes", "networks") for item in docker.inventory()[kind]
                    if (item.get("labels") or {}).get("kin.ops.run") in tokens
                    or str((item.get("labels") or {}).get("com.docker.compose.project", "")).endswith(self.token[:10])]
        except Exception as error:
            left, errors = [], errors + ["re-query: " + type(error).__name__]
        remaining = sorted(set(remaining) | set(left))
        seconds = round(time.monotonic() - started, 1)
        if seconds > CLEANUP_SECONDS:
            errors.append("cleanup took %s s (bound %d s)" % (seconds, CLEANUP_SECONDS))
        return {"complete": not remaining and not errors, "remaining": remaining, "errors": errors, "seconds": seconds}


def smoke_admission(facts):
    """The smoke's own host rule (before any resource): root on native Linux, one local daemon socket, no endpoint
    selection, a daemon that answers, not Docker Desktop, the tiny fixture's RAM and disk, no foreign kin container."""
    cp.require(facts.get("os") == "linux" and hasattr(os, "geteuid") and os.geteuid() == 0, "UNSUPPORTED_HOST",
               "the native smoke runs as root on native Linux (this host: %s)" % facts.get("os"))
    cp.require(facts.get("endpoint_selectors") == [], "REMOTE_DAEMON", ",".join(facts.get("endpoint_selectors") or []))
    cp.require(str(facts.get("docker_endpoint", "")).startswith("unix:///"), "REMOTE_DAEMON", str(facts.get("docker_endpoint"))[:120])
    cp.require(facts.get("daemon_ok") is True and facts.get("daemon_identity"), "DAEMON_UNAVAILABLE", "daemon query failed")
    cp.require(facts.get("docker_os") and "docker desktop" not in str(facts.get("docker_os")).lower(), "UNSUPPORTED_HOST",
               "Docker Desktop is not a native Linux daemon")
    cp.require(facts.get("available_ram_bytes", 0) >= SMOKE_RAM and facts.get("available_disk_bytes", 0) >= SMOKE_DISK,
               "INSUFFICIENT_RAM", "the tiny fixture needs %d bytes RAM and %d bytes disk" % (SMOKE_RAM, SMOKE_DISK))
    cp.require(not facts.get("foreign_containers"), "FOREIGN_RESOURCES", ",".join(facts.get("foreign_containers") or [])[:400])
    return True


def observe_host(root):
    """CheckpointDocker.host_facts (A10); a host without an ed25519 host key (a CI runner) records none."""
    try:
        return rehearsal.CheckpointDocker.host_facts(root)
    except (OSError, intro.Stop):
        with patch.object(intro, "local_host_key", lambda *args: None):
            facts = rehearsal.CheckpointDocker.host_facts(root)
        facts["host_key_unreadable"] = True
        return facts


def write_result(evidence, result):
    (Path(evidence) / cp.SMOKE_RESULT).write_bytes(cp.canonical(result) + b"\n")


def main(argv=None):
    parser = argparse.ArgumentParser(description="RELEASE-TOOLS-CHECKPOINTS native adapter smoke (creates and removes a tiny synthetic "
                                                 "Docker fixture; root on native Linux only)")
    parser.add_argument("--evidence", required=True, help="a new folder for the raw results")
    parser.add_argument("--release-pending", help="release an unfinished smoke's residue file after its owned resources are observed gone")
    args = parser.parse_args(argv)
    evidence = Path(args.evidence).absolute()
    evidence.mkdir(mode=0o700, parents=True, exist_ok=False)
    started = cp.now_utc().isoformat()
    result = {"schema": 1, "kind": "release-tools-checkpoints-native-smoke", "outcome": "REFUSED", "skipped": 0, "started_utc": started,
              "coverage": {}, "oracles": {}, "cleanup": {"complete": False, "remaining": [], "errors": ["not started"]}}
    try:
        with gate.exclusive(Path(gate.STATE) / "live.lock"):
            if (Path(gate.STATE) / "live-needs-inspection.json").exists():
                raise cp.Refused("SMOKE_INSPECTION", "a live run needs fixture inspection first: " + str(gate.STATE))
            if args.release_pending:
                return release_pending(Path(args.release_pending), evidence, result)
            pending = sorted(residue_dir().glob("pending-*.json")) if residue_dir().is_dir() else []
            cp.require(not pending, "SMOKE_RESIDUE", "an earlier smoke left unreleased residue: " + ",".join(str(path) for path in pending))
            facts = observe_host(Path("/root") if Path("/root").is_dir() else Path(tempfile.gettempdir()))
            result["host_facts"] = facts
            smoke_admission(facts)
            return run_smoke(evidence, facts, result)
    except (cp.Refused, gate.Refused) as error:
        # Every refusal comes before the smoke creates anything (the run itself reports its own failures).
        result.update(outcome="REFUSED", code=getattr(error, "code", "SMOKE_BUSY"), failure=str(error)[:600],
                      cleanup={"complete": True, "remaining": [], "errors": []})
        write_result(evidence, result)
        print("NATIVE_SMOKE_REFUSED " + json.dumps({"code": result["code"], "failure": result["failure"]}), file=sys.stderr)
        return 3


def trust_checkout():
    """The candidate checkout may belong to another account (CI runs the smoke under sudo over the runner's checkout); the
    bundle identity's own `git ls-files` of it names it safe for this process only (command-line scope)."""
    if hasattr(os, "geteuid") and ROOT.stat().st_uid != os.geteuid():
        count = int(os.environ.get("GIT_CONFIG_COUNT", "0") or 0)
        os.environ.update({"GIT_CONFIG_COUNT": str(count + 1), "GIT_CONFIG_KEY_%d" % count: "safe.directory",
                           "GIT_CONFIG_VALUE_%d" % count: str(ROOT)})


def run_smoke(evidence, facts, result):
    trust_checkout()
    smoke = Smoke(evidence)
    residue_dir().mkdir(mode=0o700, parents=True, exist_ok=True)
    pending = residue_dir() / ("pending-" + smoke.token + ".json")
    pending.write_bytes(cp.canonical({"token": smoke.token, "foreign_token": smoke.foreign_token, "evidence": str(evidence),
                                      "started_utc": result["started_utc"], "projects_suffix": smoke.token[:10]}) + b"\n")
    failure = None
    try:
        smoke_run(smoke, facts)
    except Exception as error:
        failure = type(error).__name__ + ": " + str(error)[:1500]
        (Path(evidence) / "failure.txt").write_text(traceback.format_exc(), encoding="utf-8")
    finally:
        body = round(time.monotonic() - smoke.started, 1)
        cleanup = smoke.cleanup()
    coverage = {key: {"outcome": "PASS" if rows and all(row["outcome"] == "PASS" for row in rows) else "FAIL", "checks": len(rows)}
                for key, rows in smoke.coverage.items()}
    oracles = {key: {"outcome": "PASS" if rows and all(row["outcome"] == "PASS" for row in rows) else "FAIL", "checks": len(rows)}
               for key, rows in smoke.oracles.items()}
    passed = failure is None and cleanup["complete"] and all(row["outcome"] == "PASS" for row in (*coverage.values(), *oracles.values()))
    result.update(outcome="PASS" if passed else "FAIL", failure=failure, coverage=coverage, oracles=oracles, cleanup=cleanup,
                  seconds={"body": body, "cleanup": cleanup["seconds"], "stages": smoke.timings},
                  targets={"body_s": BODY_SECONDS, "cleanup_s": CLEANUP_SECONDS}, ended_utc=cp.now_utc().isoformat())
    write_result(evidence, result)
    if cleanup["complete"]:
        with open(residue_dir() / "released.jsonl", "ab") as stream:
            stream.write(cp.canonical({"token": smoke.token, "evidence": str(evidence), "outcome": result["outcome"],
                                       "released_utc": cp.now_utc().isoformat(), "by": "the smoke's own observed cleanup"}) + b"\n")
        pending.unlink()
    print("NATIVE_SMOKE " + json.dumps({"outcome": result["outcome"], "seconds": result["seconds"], "failure": failure,
                                        "cleanup": cleanup}), flush=True)
    return 0 if passed else 1


def smoke_run(smoke, facts):
    smoke.private = Path(tempfile.mkdtemp(prefix="kin-ckpt-smoke-", dir="/root"))
    smoke.private.chmod(0o700)
    smoke.fixture_root = smoke.private / "fixture"
    smoke.fixture_root.mkdir(mode=0o700)
    smoke.store = cp.BundleStore(smoke.private / "bundles", forbidden=[smoke.fixture_root, smoke.evidence, gate.STATE])
    smoke.host_key = facts.get("host_key_sha256") or hexdigest("no host key: " + str(facts.get("daemon_identity")))
    smoke.facts = facts
    smoke.prepare()
    smoke.make_donor()
    clone = smoke.stacks["clone"] = TinyStack(smoke, "clone")
    smoke.bootstrap(clone)
    smoke.budget("bootstrap")
    smoke.adapter_paths(clone)
    smoke.baseline_oracles(clone)
    smoke.budget("baseline oracles")
    clone.exec("api", "sh", "-c", "echo transient > /tmp/kin-smoke-transient")
    sealed = smoke.capture(clone, "seeded", probe=smoke.engine_probe)
    smoke.sealed_clone_closure(clone)
    smoke.budget("seeded capture")
    clone = smoke.roundtrip(clone, "seeded", sealed, all_running=True)
    smoke.budget("seeded roundtrip")
    clone = smoke.held(clone)
    smoke.budget("held roundtrip")
    smoke.late_boundaries(clone)
    smoke.budget("introduced/verified")
    smoke.failure_lineage()
    smoke.budget("failure-held")
    smoke.git_closure()
    smoke.budget("git closure")


def release_pending(path, evidence, result):
    """An unfinished smoke's residue is released only when nothing it owned is observed any more (its token and its
    projects) and its private root is gone; the release is appended to the ledger, nothing is deleted but the pending file."""
    pending = json.loads(path.read_bytes())
    cp.require(path.parent.resolve() == residue_dir().resolve() and path.name.startswith("pending-"), "SMOKE_RESIDUE", "not a pending file")
    docker = rehearsal.CheckpointDocker(None, None)
    tokens = {pending["token"], pending["foreign_token"]}
    inventory = docker.inventory()
    left = [item["name"] for kind in ("containers", "volumes", "networks") for item in inventory[kind]
            if (item.get("labels") or {}).get("kin.ops.run") in tokens
            or str((item.get("labels") or {}).get("com.docker.compose.project", "")).endswith(pending["projects_suffix"])]
    roots = sorted(str(item) for item in Path("/root").glob("kin-ckpt-smoke-*")) if Path("/root").is_dir() else []
    cp.require(not left and not roots, "SMOKE_RESIDUE", "still present: " + ",".join(left + roots)[:400])
    with open(residue_dir() / "released.jsonl", "ab") as stream:
        stream.write(cp.canonical({"token": pending["token"], "evidence": pending["evidence"], "outcome": "released after inspection",
                                   "released_utc": cp.now_utc().isoformat(), "inspected": {"remaining": [], "roots": []}}) + b"\n")
    path.unlink()
    result.update(outcome="RELEASED", cleanup={"complete": True, "remaining": [], "errors": []})
    write_result(evidence, result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
