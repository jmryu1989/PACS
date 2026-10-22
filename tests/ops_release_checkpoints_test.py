"""RELEASE-TOOLS-CHECKPOINTS pure contracts (Astra spec D1336, order D1338). REQ/RISK/TEST ids appear in docstrings as
trace only; the assertions are on behaviour. No Docker, browser or live stack: a fake daemon backend, temporary folders,
and the real scripts/run-tests.py, tests/live_test_gate.py and scripts/record-run.py in synthetic subprocesses with their
own state directories (never the account's real ledger).

Byte pins, with their reason (AGENTS.md section 1-B item 14): CheckpointImpactTests compares raw bytes of the product
tool on purpose - the cross-tree admission is a cache contract that proves an already executed prefix is byte-identical,
so byte identity itself is the requirement. CheckpointTimeTests asserts the product's 7-day receipt age and 5-minute
skew because the spec (section 6) requires that a checkpoint never changes those contracts.

CheckpointMutationContracts (T18) applies M01-M44 and M46-M79 (78 mutants; there is no M45) to temporary copies of
tests/ops_release_checkpoints.py, (M15-M17, M35) tests/ops_deploy_host_container_test.py, (M51, M56, M72-M77, M79)
tests/ops_release_checkpoints_native_test.py and (M64) tests/ops_release_checkpoints_live_test.py only, runs
the named contract against the unmodified copies (control) and the mutant in fresh processes, and counts a kill only when
the control passes and the mutant fails an assertion (an import, launch or fixture error is not a kill). M01-M14 are the
spec's contracts; M15-M30 were added by hardening round 1 for CKPT-01..09 (one or more per finding); M31-M42 by round 3
for CKPT2-01..06 (M30 retargeted to the new alias keep); M43, M44 and M46 by round 5 (consult-checkpoints-r5-20261016
new_mutants); M47-M51 by round 6 (consult-checkpoints-r6-20261017 new_mutants M47-M49 and the optional library-bytes and
residue-release ones); M52-M54 by round 7 (consult-checkpoints-r7-20261017 mutants: a non-object row skipped, an absence
not corroborated, a row's image not bound); M55-M57 by round 8 (consult-checkpoints-r8-20261017 R8-06: the layer binding
unchecked, the native evidence taking the caller's descriptor, a fact kind looked up before its type is checked);
M58-M59 by the r8 self-review (D1556: bundle_inputs' B0 type unchecked, the verified descriptor shared between reads);
M60-M66 by round 9 (D1575 CKPT8-1/CKPT8-2 and the typed-read inventory: the loader's parent, phase_reached, identity and
owned guards, parent_chain's link type, resolve_parent's checkpoint type, restore_boundary's stack type); M67-M79 by
round 10 (D1600: the omission/type guards at the restore and verified native boundaries). Rounds 11 to 13 add no mutant
(their adapter faults run as separate executed variants outside this suite).

Round 13 (consult-checkpoints-r13-plan-20261022, D1688): CheckpointStopDiffIdentityTests runs the real capture_checkpoint
over the real CheckpointDocker stop and diff (a finite ContainerDaemon process table of the five roles) - the capture
stops and observes exactly its inventoried containers by ID, refuses replacements and unstopped containers with no
bundle, and leaves the native smoke's standalone diagnostics on their actual subject (CKPT12-01); the NUL containerd
endpoint and the reason-wording contract are in CheckpointLayerStorageTests (CKPT12-02/04).

Round 11 (consult-checkpoints-t16-host-20261021 option b, D1666/D1669): CheckpointLayerStorageTests runs the real
CheckpointDocker.layer_facts over a fake process table (docker info/inspect, containerd's ctr) and a real upper folder:
overlay2 and containerd-snapshotter fact parity, every unestablished mapping without facts, and the live judgement's seal
or WRITABLE_LAYER refusal (TEST-CKPT-STORAGE-01/02).

Round 8 (consult-checkpoints-r8-20261017, CKPT7-01/02): the judgement is one call over the current bytes and the seal's
bindings that returns what it verified (CheckpointVerifiedCaptureTests: R8-02 the bindings and the returned value, R8-03
the real native Smoke.regenerated contrast, R8-04 the finite typed-refusal table and the adapters, R8-05 the executed
consumer inventory). Its oracle helpers use only entry points de02468 has as well, so they ran red there and green here.

Round 7 (consult-checkpoints-r7-20261017, CKPT6-01): the writable-layer record is a closed five-role map judged against
the capture it describes (CheckpointLayerContractTests, oracles O7-*) at its generation, load_bundle, the index, every
consumption of a BOUND index, parent admission and the restore. The synthetic fixtures now draw every container fact from
one source (container_ids, boundary_facts_of; the r6 control had two unrelated container IDs and no boundary facts), the
proof layout seals a real bundle, and the parent-map tests bind their parent through a really recorded index.

Round 6 (consult-checkpoints-r6-20261017): the regenerated-artifact contract of the Orthanc role on its pinned image
(CheckpointRegeneratedTests: P5 the role x image x kind/type/content/ancestor/mount matrix, P6 the required layer raw at
load_bundle/index/BOUND consumers, P7 the descriptor from a pristine probe) and real deadlines (CheckpointDeadlineTests:
P8 real local children cut on the bounded path, P9 the cleanup's own end and the kept residue), and the `commands`
diagnostics in CheckpointSmokeTests. Pure only: no Docker daemon is queried (the real entrypoint's host observation is
answered by its bootstrap).

Round 5 (consult-checkpoints-r5-20261016): the observation-only context over a synthetic Engine behind the product's
own Runner interface (CheckpointObservationTests: P1 its own request, Records and settled workers; P2 the original records
byte-identical, the judged state bound, 48a28dd's and the digest-only contexts as diagnostics), the observation raw at the
seal, the index and its consumers (CheckpointRecordTests P3), and the `commands` smoke precondition (CheckpointSmokeTests
P4). These are pure controls; the adapter's own commands run in tests/ops_release_checkpoints_native_test.py only. The
original records' byte identity is the requirement itself (consultation observe_fix), so P2 compares bytes.

Round 3 (consult answer.json round3_acceptance): the index reads the raw evidence (CheckpointRecordTests, CKPT2-01) and
every consumer re-checks a BOUND index (CKPT2-03); the product's supervised browser command leaves the frozen source
admissible (CheckpointBytecodeTests, CKPT2-02, with P3's own test_120); fixture containment is normalised
(CheckpointInputsTests, CKPT2-04); one owned alias is kept per image (CheckpointCleanupTests, CKPT2-05); retries use
per-attempt request/run/evidence paths (CheckpointLineageTests, CKPT2-06).

Round 4 (T16 run-d1428): the seal's Git calls run against the real git (CheckpointGitClosureTests), and `commands`
refuses a host whose --python lacks Playwright or pydicom or whose proof root or candidate is not on a root-owned chain
outside every user home (CheckpointHostPreconditionTests).

Hardening round 1 (Astra review of 460b4a9): T15 runs the real RehearsalStages methods of the three scenarios over a
synthetic product (FakeProduct: realm, data, frame, overlay, ordinary entry, receipt) and requires every wrong outcome to
fail in the stage that owns its assertion (CKPT-05); the host adapter is exercised with a fake process table (CKPT-01);
bundle inputs, runtime pins and restored facts are recomputed (CKPT-04); raw records, identities and the parent chain
survive a bundle-less leaf (CKPT-03); the evidence index is checked over the real recorder (CKPT-02); the parent map,
requests and the generated Linux commands are fixed (CKPT-06).
"""
import ast
import contextlib
import copy
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import textwrap
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
TESTS = ROOT / "tests"
if str(TESTS) not in sys.path:
    sys.path.append(str(TESTS))
import ops_release_checkpoints as cp  # noqa: E402
import live_test_gate as gate  # noqa: E402

intro = cp.intro
RUNNER = ROOT / "scripts" / "run-tests.py"
RECORDER = ROOT / "scripts" / "record-run.py"
PROJECT, TOKEN = "kin-ck-0001", "0123456789"
MIGRATIONS_BEFORE = [["0_init", "1" * 64], ["20260926130000_study_image_requests", "2" * 64]]
MIGRATIONS_AFTER = MIGRATIONS_BEFORE + [[intro.EMR_MIGRATION, "4" * 64]]
SECRET_VALUE = "SYNTHETIC-PRIVATE-VALUE-7f3a"


def image(char):
    return "sha256:" + char * 64


def target_fixture(root=None):
    names = {role: PROJECT + "-" + role for role in (*intro.ROLES, *intro.ONE_SHOTS)}
    base = str(Path(root) / "clone") if root is not None else "/srv/fixture/clone"
    return {"schema": 1, "kind": "rehearsal", "host_key_sha256": "b" * 64, "origin": "https://localhost:21443", "project": PROJECT,
            "repository": base + "/repo",
            "compose_files": ["docker-compose.yml", "docker-compose.prod.yml", base + "/rehearsal-override.yml"],
            "containers": names, "volumes": {"pg": PROJECT + "_pg-db", "orthanc": PROJECT + "_orthanc-db",
                                             "emr_access": PROJECT + "_emr-access", "emr_state": PROJECT + "_emr-state"},
            "networks": {"default": PROJECT + "_default", "workflow": PROJECT + "-workflow"},
            "ports": {"maintenance": "127.0.0.1:21444:443", "public": ["127.0.0.1:21443:443"]},
            "tls_certificate": "/etc/nginx/certs/kin.crt", "cron": None, "ca_file": base + "/clone-ca.pem",
            "keycloak_admin": "kin-clone-admin", "external_networks": {}, "declared_overlays": [], "tracked_overlay_reconcile": [],
            "fix_checkout_mode": False}


def plan_fixture(target=None, root=None):
    target = target or target_fixture(root)
    base = str(Path(root)) if root is not None else "/srv/fixture"
    now = datetime.now(timezone.utc)
    plan = {"schema": 1, "mode": intro.MODE, "unit": "INTERIM-RELEASE-SYNTHETIC", "target_kind": "rehearsal",
            "target_manifest_sha256": hashlib.sha256(intro.canonical(target)).hexdigest(),
            "previous": {"sha": "a" * 40, "images": {"api": image("1"), "proxy": image("2"), "db": image("3"), "keycloak": image("4"),
                                                       "orthanc": image("5")}},
            "release": {"sha": "b" * 40, "images": {"api": image("6"), "proxy": image("7"), "db": image("3"), "keycloak": image("4"),
                                                      "orthanc": image("5")}},
            "compose": {"before_sha256": "c" * 64, "after_sha256": "d" * 64},
            "secrets": {"required": ["POSTGRES_PASSWORD", "KIN_EMR_RUNTIME_PASSWORD"], "absent": ["KIN_EMR_READER_PASSWORD",
                                                                                               "KIN_EMR_RETENTION_PASSWORD"],
                        "runtime": "KIN_EMR_RUNTIME_PASSWORD", "installer": "POSTGRES_PASSWORD",
                        "logins": {"kin_emr_reader": False, "kin_emr_retention": False}, "env_next_sha256": "e" * 64},
            "migrations": {"before": copy.deepcopy(MIGRATIONS_BEFORE), "after": copy.deepcopy(MIGRATIONS_AFTER)},
            "storage": {"tablespace_path": intro.TABLESPACE, "postgres_uid": 70, "postgres_gid": 70, "node_uid": 1000, "node_gid": 1000},
            "members": {"realm_members": 3, "disabled": 1, "service_accounts": 1},
            "smoke": {"frame": {"path": "/dicom-web/studies/1.2/series/1.3/instances/1.4/frames/1", "bytes": 64, "sha256": "f" * 64},
                      "member": {"roles": ["radiologist"], "group": "hallym"}},
            "probe": {"study": "SYNTHETIC-rehearsal", "event_id": "12345678-1234-4123-8123-123456789abc", "institution": "kin-center",
                      "approved_by": "synthetic-rehearsal", "approved_at": now.isoformat()},
            "window": {"start": (now - timedelta(hours=1)).isoformat(), "end": (now + timedelta(hours=8)).isoformat()},
            "budget": {"capture_s": 3600, "introduce_s": 5400, "verify_s": 3600, "reopen_s": 1800, "rollback_s": 3600, "seed_s": 3600,
                       "min_free_bytes": 1024 ** 3},
            "backup_root": base + "/clone/backups", "tool": {name: "9" * 64 for name in intro.TOOL_FILES},
            "seed": {"b0_dir": base + "/b0-copy/emr-b0", "b0_manifest_sha256": "8" * 64, "production_plan_sha256": "7" * 64},
            "projection_exempt": [], "rehearsal_host": None}
    return intro.plan_valid(plan)


def boundary_fixture(checkpoint_id, plan=None):
    """A completed boundary as the product writes it: the phase's PASS result file, its history row, quiet workers."""
    plan = plan or plan_fixture()
    plan_sha = intro.plan_identity(plan)
    spec = cp.CHECKPOINTS[checkpoint_id]
    sids = [sid for sid, _, _, _ in intro.STEPS[spec["phase"]]]
    request = "a" * 64
    result = {"steps": [{"step": sid, "outcome": "PASS", "seconds": 0.5} for sid in sids], "status": spec["status"],
              "phase": spec["phase"], "request_sha256": request, "plan_sha256": plan_sha, "commands_file": "commands.jsonl"}
    raw = intro.canonical(result) + b"\n"
    state = intro.new_state(plan_sha, plan)
    state.update(status=spec["status"], lock_token="f" * 32 if spec["lock"] else None, fenced={"at": "x"} if spec["lock"] else None,
                 checkout="target" if spec["phase"] in ("introduce", "verify") else "previous", db_changed=spec["phase"] in ("introduce", "verify"),
                 history=[{"phase": spec["phase"], "status": "PASS", "request_sha256": request, "seconds": 1.0,
                           "result_sha256": hashlib.sha256(raw).hexdigest(), "steps": [[sid, "PASS"] for sid in sids]}],
                 workers={"w1": {"state": "QUIET", "kind": "compose-run"}},
                 compose_entry={"generation": "1" * 64, "sha256": "2" * 64, "root": "/srv/fixture/clone/compose-entries"},
                 entry_checkout="target" if spec["phase"] in ("introduce", "verify") else "previous")
    return plan, state, result, raw


def container_ids(target, ids=None):
    """r7: the one source of truth of the synthetic containers' IDs: the ID FakeBackend gives a role's container (or the
    new IDs a case names), used alike by the snapshot, the boundary facts, the descriptor and the layer rows
    (consult-checkpoints-r7-20261017 design_doubts_now: the r6 fixture used two unrelated IDs)."""
    return {role: (ids or {}).get(role, "id-" + target["containers"][role]) for role in intro.ROLES}


def snapshot_fixture(state, plan, target, sid, *, running=None, ids=None, absent=()):
    """The product's observation schema at a boundary (intro.observed/checkpoint_valid), all facts OK (`absent` roles
    observed ABSENT, a fact the product's schema allows)."""
    side = "release" if state["checkout"] == "target" else "previous"
    desired = set(intro.ROLES) if intro.BOUNDARY_RUNNING[sid] == "all" else set(intro.BOUNDARY_RUNNING[sid].split())
    desired = (desired if running is None else running) - set(absent)
    known = container_ids(target, ids)
    containers = {role: {"outcome": "ABSENT"} if role in absent else
                  {"outcome": "OK", "value": {"id": known[role], "image": plan[side]["images"][role], "running": role in desired,
                                              "restarting": False, "project": target["project"], "service": role}} for role in intro.ROLES}
    after = sid in ("L-09b", "L-10e")
    rows = [[name, checksum, True, False] for name, checksum in plan["migrations"]["after" if after else "before"]]
    ingress = "public" if sid in intro.PUBLIC_BOUNDARIES else ("maintenance" if "proxy" in desired else "closed")
    facts = {"checkout": {"sha": plan[side]["sha"]},
             "compose_entry": {"generation": state["compose_entry"]["generation"], "sha256": state["compose_entry"]["sha256"]},
             "lock": {"owned": bool(state["lock_token"])}, "containers": containers,
             "database": {"ready": True, "migrations": rows},
             "fences": {"writers": {role: role in desired for role in intro.WRITERS}, "cron": "not-managed", "ingress": ingress,
                        "db_clients": 0},
             "workers": {"quiet": True, "pending": []}}
    return {"schema": 1, "checkpoint": [sid, "after"], "facts": {key: {"outcome": "OK", "value": value} for key, value in facts.items()}}


class RefusalAssertions:
    def assertRefused(self, code, action, *args, **kwargs):
        """Any outcome other than this exact refusal (success, another code, an unexpected exception) is a failure."""
        try:
            action(*args, **kwargs)
        except cp.Refused as error:
            self.assertEqual(error.code, code, str(error))
            return error
        except Exception as error:  # an unexpected exception is a contract failure here, not an error of the test
            self.fail("expected refusal %s, got %s: %s" % (code, type(error).__name__, error))
        self.fail("expected refusal " + code + ", got success")

    def admitted(self, action, *args, **kwargs):
        try:
            return action(*args, **kwargs)
        except Exception as error:
            self.fail("expected success, got %s: %s" % (type(error).__name__, error))


def volume_tar(category, *, extra=None):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w:", format=tarfile.PAX_FORMAT) as archive:
        for name, kind, value in [(".", tarfile.DIRTYPE, None), ("./PG_VERSION" if category == "pg" else "./data.bin", tarfile.REGTYPE, b"16\n"),
                                  *((("./pg_tblspc", tarfile.DIRTYPE, None), ("./pg_tblspc/16384", tarfile.SYMTYPE, intro.TABLESPACE))
                                    if category == "pg" else ()), *(extra or [])]:
            info = tarfile.TarInfo(name)
            info.type, info.uid, info.gid, info.mode = kind, 70, 70, 0o700
            if kind == tarfile.SYMTYPE:
                info.linkname = value
            if kind == tarfile.REGTYPE:
                info.size = len(value)
                archive.addfile(info, io.BytesIO(value))
            else:
                archive.addfile(info)
    return stream.getvalue()


def raw_tar(entries):
    """A tar of exactly these (name, type, value) members in this order (duplicates and odd orders included)."""
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w:", format=tarfile.PAX_FORMAT) as archive:
        for name, kind, value in entries:
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


class FakeBackend:
    """A synthetic daemon: owned containers/volumes of PROJECT, optional foreign resources, recorded calls. `images` gives
    each role's container image; `layers` (name -> {path: lstat facts}) is what layer_facts reads from a writable layer."""

    def __init__(self, names, volumes=None, *, foreign=(), running=None, images=None):
        self.calls, self.names = [], names
        running = set(intro.ROLES) if running is None else running
        self.containers = {name: {"id": "id-" + name, "name": name, "labels": {"com.docker.compose.project": PROJECT},
                                  "running": role in running, "image": (images or {}).get(role)}
                           for role, name in names.items() if role in intro.ROLES}
        self.layers = {}
        self.volumes = {name: {"id": name, "name": name, "labels": {"com.docker.compose.project": PROJECT,
                                                                    "com.docker.compose.volume": category}}
                        for category, name in (volumes or {}).items()}
        self.networks = {}
        for item in foreign:
            getattr(self, item["kind"])[item["name"]] = {"id": "id-" + item["name"], "name": item["name"], "labels": item.get("labels", {}),
                                                        "running": True}
        self.stop_outcome, self.diffs, self.sticky, self.fail_inventory = {}, {}, set(), False
        self.image_tags, self.loaded = {}, []

    def inventory(self):
        self.calls.append(("inventory",))
        if self.fail_inventory:
            raise RuntimeError("daemon unreachable")
        listed = {kind: [dict(item) for item in getattr(self, kind).values()] for kind in ("containers", "volumes", "networks")}
        return {**listed, "images": [{"id": ident, "tags": sorted(tags)} for ident, tags in sorted(self.image_tags.items())]}

    def stop(self, name):
        self.calls.append(("stop", name))
        self.containers[name]["running"] = False
        return self.stop_outcome.get(name, {"exit_code": 0, "forced": False, "oom_killed": False, "running": False})

    def writable_changes(self, name):
        self.calls.append(("diff", name))
        return self.diffs.get(name, ["C /run", "A /run/nginx.pid", "C /var", "C /var/cache", "A /var/cache/nginx/proxy_temp"])

    def layer_facts(self, name, paths):
        self.calls.append(("layer_facts", name))
        if name not in self.layers:
            return None
        return {path: self.layers[name][path] for path in paths if path in self.layers[name]}

    def export_volume(self, name, destination):
        self.calls.append(("export", name))
        category = self.volumes[name]["labels"]["com.docker.compose.volume"]
        Path(destination).write_bytes(volume_tar(category))

    def volume_exists(self, name):
        self.calls.append(("volume_exists", name))
        return name in self.volumes

    def create_volume(self, name, labels):
        self.calls.append(("create_volume", name))
        self.volumes[name] = {"id": name, "name": name, "labels": dict(labels)}

    def load_volume(self, name, archive, category):
        self.calls.append(("load_volume", name))
        cp.archive_members(archive, category=category)
        self.loaded.append(name)

    def create_network(self, name, labels):
        self.calls.append(("create_network", name))
        self.networks[name] = {"id": "id-" + name, "name": name, "labels": dict(labels)}

    def compose_create(self, roles):
        self.calls.append(("compose_create", tuple(roles)))
        for role in roles:
            name = self.names[role]
            self.containers[name] = {"id": "new-" + name, "name": name, "labels": {"com.docker.compose.project": PROJECT}, "running": False}

    def compose_start(self, role):
        self.calls.append(("compose_start", role))
        self.containers[self.names[role]]["running"] = True

    def wait_db_ready(self):
        self.calls.append(("wait_db_ready",))

    def remove(self, kind, ident):
        self.calls.append(("remove", kind, ident))
        if kind == "tags":
            # As the daemon does: untagging the last name of an image deletes the image itself.
            for image, tags in list(self.image_tags.items()):
                if ident in tags:
                    tags.discard(ident)
                    if not tags:
                        del self.image_tags[image]
            return
        table = getattr(self, kind)
        name = next(key for key, item in table.items() if item.get("id") == ident or key == ident)
        if name not in self.sticky:
            del table[name]

    def mutations(self):
        return [call for call in self.calls if call[0] not in ("inventory", "volume_exists", "diff", "layer_facts")]

    def boundary_facts(self):
        """What CheckpointDocker.boundary_facts records of these containers (one inspection with the inventory's mounts)."""
        return {"containers": {role: {"id": item["id"], "image": item["image"], "running": item["running"],
                                      "project": item["labels"].get("com.docker.compose.project"),
                                      "mounts": sorted([mount["destination"], mount.get("name") or mount.get("source") or "", True]
                                                       for mount in item.get("mounts") or [] if mount.get("destination")),
                                      "networks": []}
                               for role, name in self.names.items() if role in intro.ROLES
                               for item in [self.containers.get(name)] if item is not None}}


# ── r6 (consult-checkpoints-r6-20261017 ckpt5_01): a synthetic regenerated-artifact descriptor of the pinned Orthanc
# image, shaped as regenerated_descriptor derives one from a probe, and the writable-layer facts of a normal start ──
def _file(sha, size, mode=0o644, uid=0, gid=0, text="other"):
    return {"type": "file", "mode": mode, "uid": uid, "gid": gid, "size": size, "sha256": sha, "text": text}


def _dir(mode=0o755, uid=0, gid=0):
    return {"type": "dir", "mode": mode, "uid": uid, "gid": gid}


ORTHANC_IMAGE = image("5")
AVAILABLE = {"libOrthancGdcm.so": _file("a" * 64, 40960, 0o755, 999, 999), "libOrthancDicomWeb.so": _file("b" * 64, 81920, 0o755, 999, 999),
             "libOrthancTcia.so": _file("c" * 64, 20480, 0o755, 999, 999)}   # available, not enabled by the start input
ENABLED = ("libOrthancDicomWeb.so", "libOrthancGdcm.so")
PYC = {"configurator.cpython-311.pyc": _file("d" * 64, 9000), "helpers.cpython-311.pyc": _file("e" * 64, 3000)}
ORTHANC_START = ["C /etc", "C /etc/hostid", "C /startup", "A /startup/__pycache__", *("A /startup/__pycache__/" + name for name in sorted(PYC)),
                 "C /tmp", "A /tmp/orthanc.json", "C /usr", "C /usr/share", "C /usr/share/orthanc", "C /usr/share/orthanc/plugins",
                 *("A /usr/share/orthanc/plugins/" + name for name in ENABLED)]


def regenerated_fixture(container_id, *, pinned=ORTHANC_IMAGE, actual=None, applicable=True, hostid=True):
    ancestors = {path: _dir() for path in ("/etc", "/startup", "/usr", "/usr/share", "/usr/share/orthanc")}
    ancestors[cp.PLUGINS] = _dir(0o755, 999, 999)
    inventory = {"entrypoint": _file("f" * 64, 2068, 0o755), "python": {"cache_tag": "cpython-311", "optimize": 0, "version": "3.11.2", "no_bytecode": False},
                 "startup": {"configurator.py": _file("1" * 64, 11100), "generateConfiguration.py": _file("2" * 64, 3157), "helpers.py": _file("3" * 64, 2455)},
                 "hostid": _file(hashlib.sha256(b"not-generated\n").hexdigest(), 14, 0o644, 999, 999, "placeholder"),
                 "available": copy.deepcopy(AVAILABLE), "plugins": {}, "pycache": {"type": "absent"}, "ancestors": ancestors}
    generated = {"hostid": _file("9" * 64, 9, 0o644, 999, 999, "hex8-lf"), "pycache_dir": _dir(), "pycache": copy.deepcopy(PYC),
                 "plugins": {name: {**AVAILABLE[name], "link": "hard link"} for name in ENABLED}, "entry_exit": 0}
    return {"schema": 1, "kind": cp.REGENERATED_KIND, "role": cp.REGENERATED_ROLE, "container_name": PROJECT + "-orthanc", "pinned_image": pinned,
            "container_id": container_id, "actual_image": actual or pinned, "applicable": applicable, "reasons": [] if applicable else ["synthetic"],
            "hostid_regenerated": applicable and hostid, "hostid_reasons": [] if hostid else ["synthetic"],
            "startup": {"entrypoint": ["/docker-entrypoint.sh"], "cmd": ["/tmp/orthanc.json"], "user": "", "env_names": ["ORTHANC__REGISTERED_USERS"],
                        "env_sha256": "4" * 64, "conditions": {"force_host_id": False, "generate_host_id": "default", "before_startup_script": False},
                        "config_mounts": [], "input_sha256": "5" * 64},
            "image": inventory, "generated": generated, "probe": {"helper": {"name": "kin-ckpt-regen-synthetic", "removed": True}, "entry_exit": 0}}


def start_facts(descriptor):
    """The writable-layer facts a normal Orthanc start leaves: exactly the descriptor's generated set and ancestors."""
    generated, inventory = descriptor["generated"], descriptor["image"]
    facts = {cp.HOSTID: dict(generated["hostid"]), cp.PYCACHE: dict(generated["pycache_dir"])}
    facts.update({cp.PYCACHE + "/" + name: dict(fact) for name, fact in generated["pycache"].items()})
    facts.update({cp.PLUGINS + "/" + name: {k: v for k, v in fact.items() if k != "link"} for name, fact in generated["plugins"].items()})
    facts.update({path: dict(fact) for path, fact in inventory["ancestors"].items()})
    return facts


def fixture_roles(target, images, ids=None):
    known = container_ids(target, ids)
    return {role: {"absent": False, "container_id": known[role], "container_name": target["containers"][role],
                   "image": images[role], "mounts": [], "changes": [], "facts": {}, "layer_observable": True, "verdicts": []}
            for role in intro.ROLES}


def boundary_facts_of(snapshot, mounts=None):
    """The boundary facts CheckpointDocker.boundary_facts takes beside a capture (before the stop), coherent with the
    capture snapshot: per present role its container ID, image, running state, project, mounts and networks."""
    return {"containers": {role: {"id": item["value"]["id"], "image": item["value"]["image"], "running": item["value"]["running"],
                                  "project": item["value"]["project"], "mounts": sorted((mounts or {}).get(role, [])),
                                  "networks": [item["value"]["project"] + "_default"]}
                           for role, item in snapshot["facts"]["containers"]["value"].items() if item["outcome"] == "OK"}}


LEGACY = {"roles": [["kin_legacy_group", False, False, -1], ["kin_legacy_reader", False, True, 3]],
          "members": ["kin_legacy_group>kin_legacy_reader"], "schema_owner": "kin_legacy_group", "table_acl": "{kin_legacy_reader=r/kin}",
          "column_acl": "{kin_legacy_group=r/kin}", "type_acl": "{kin_legacy_reader=U/kin}", "database_acl": "{kin_legacy_reader=c/kin}"}
B0_MANIFESTS = {"source": b'{"b0":"source"}\n', "clone": b'{"b0":"clone"}\n', "failure": b'{"b0":"failure"}\n'}


def realistic(root, checkpoint_id, *, tamper=None, layer=True, descriptor=None, ids=None, absent=()):
    """A completed boundary inside a fixture root as the harness binds it: the lineage stack's state and result, the
    sibling secrets, the Compose pointer, the ledger, the lock, the stage context (with the stack's plan document and
    target), the source B0 and its seed copy, the stack's own B0 - and the identity of exactly those bytes. `tamper`
    may change the context, state or B0 files after the identity was taken (a bundle whose bytes contradict it). A
    volume checkpoint also has its capture observation (with `descriptor`) and, unless `layer` is false (capture_checkpoint
    writes its own), a writable-layer record of containers without changes."""
    root = Path(root)
    stack = cp.LINEAGE_STACK[checkpoint_id]
    target = target_fixture(root)
    plan, state, result, raw = boundary_fixture(checkpoint_id, plan_fixture(target, root))
    plan_sha = intro.plan_identity(plan)
    created = datetime.now(timezone.utc).isoformat()
    b0_files = {}
    source_dir = root / "source" / "backups" / "emr-b0-source"
    source_b0 = {"dir": str(source_dir), "manifest_sha256": hashlib.sha256(B0_MANIFESTS["source"]).hexdigest(), "created_utc": created}
    if stack != "failure":
        b0_files[source_dir / "manifest.json"] = B0_MANIFESTS["source"]
    copy_dir = root / "b0-copy" / "emr-b0-source" if checkpoint_id in ("seeded", "held", "introduced", "verified") else None
    if copy_dir is not None:
        b0_files[copy_dir / "manifest.json"] = B0_MANIFESTS["source"]
    if checkpoint_id == "source-b0":
        state["b0"] = dict(source_b0)
    elif checkpoint_id != "seeded":
        own = root / stack / "backups" / ("emr-b0-" + stack)
        b0_files[own / "manifest.json"] = B0_MANIFESTS[stack]
        state["b0"] = {"dir": str(own), "manifest_sha256": hashlib.sha256(B0_MANIFESTS[stack]).hexdigest(), "created_utc": created}
    context = {"previous_sha": "a" * 40, "target_sha": "b" * 40,
               "images": {"previous": dict(plan["previous"]["images"]), "release": dict(plan["release"]["images"])},
               "legacy": LEGACY, "members": plan["members"], "b0": None if stack == "failure" else dict(source_b0),
               "copy_dir": str(copy_dir) if copy_dir else None, "production_plan": None,
               "stacks": {stack: {"label": stack, "root": str(root / stack), "plan_document": copy.deepcopy(plan), "plan_sha256": plan_sha,
                                  "target": copy.deepcopy(target)}}}
    identity = identity_fixture(phase_reached=checkpoint_id, plan_sha256=plan_sha, target_manifest_sha256=plan["target_manifest_sha256"],
                                tool_files_actual_raw_sha256=dict(plan["tool"]),
                                image_ids={"previous": dict(plan["previous"]["images"]), "release": dict(plan["release"]["images"]),
                                           "helper": image("3")},
                                source_b0_manifest_sha256=None if stack == "failure" else source_b0["manifest_sha256"],
                                clone_b0_manifest_sha256=(state.get("b0") or {}).get("manifest_sha256") if stack != "source" else None,
                                absolute_fixture_root=str(root))
    parts = {"context": context, "state": state, "b0": b0_files}
    if tamper:
        tamper(parts)
    for path, value in parts["b0"].items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(value)
    files = {"state": (stack + "/records/state.json", intro.canonical(parts["state"]) + b"\n"),
             "result": (stack + "/records/result-phase.json", raw),
             "secrets": (stack + "/records.secrets/compose-env-values.json", json.dumps({"VALUE": SECRET_VALUE}).encode()),
             "compose_entry": (stack + "/compose-entries/active.json", b'{"generation":"1","sha256":"2"}\n'),
             "ledger": (stack + "/backups/audit-ledger.json", b'{"entries":[]}\n'),
             "context": (cp.CONTEXT_FILE, cp.canonical(parts["context"]) + b"\n")}
    if cp.CHECKPOINTS[checkpoint_id]["lock"]:
        files["lock"] = (stack + "/repo/.kin-ops.lock", ((parts["state"].get("lock_token") if type(parts["state"]) is dict else None) or "").encode())
    bindings = {}
    for name, (rel, value) in files.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(value)
        bindings[name] = {"path": rel, "sha256": hashlib.sha256(value).hexdigest()}
    facts = None
    if cp.CHECKPOINTS[checkpoint_id]["volumes"]:
        # r5: the capture observation of exactly this state, bound beside it.
        folder = write_observation(root / stack / "records", checkpoint_id, "capture", plan=plan, target=target, state_raw=files["state"][1],
                                   descriptor=descriptor, ids=ids, absent=absent)
        result_file = folder / cp.OBSERVATION_RESULT
        bindings["observation"] = {"path": result_file.relative_to(root).as_posix(), "sha256": hashlib.sha256(result_file.read_bytes()).hexdigest()}
        # r7: the boundary facts the seal takes beside that observation (the same containers).
        facts = boundary_facts_of(json.loads((folder / "snapshot.json").read_bytes()))
        if layer:
            # r6: the post-stop judgement beside it (here: containers whose writable layers did not change).
            roles = fixture_roles(target, cp.pinned_images(plan, parts["state"]), ids=ids)
            roles.update({role: {"absent": True, "container_name": target["containers"][role]} for role in absent})
            bindings["layer"], _ = cp.write_layer(root, bindings, roles, checkpoint_id=checkpoint_id, summary=json.loads(result_file.read_bytes()),
                                                  descriptor_raw=(folder / cp.REGENERATED_FILE).read_bytes())
    return SimpleNamespace(plan=plan, target=target, state=parts["state"], result=result, raw=raw, bindings=bindings, identity=identity,
                           root=root, facts=facts, stack={"root": str(root / stack), "containers": {role: target["containers"][role]
                                                                                                     for role in intro.ROLES}})


def sealed_boundary(checkpoint_id, made):
    """The manifest boundary the seal records: the product's boundary_publishable and, at a volume checkpoint, the
    boundary facts taken beside the capture observation (seal_boundary)."""
    boundary = cp.boundary_publishable(checkpoint_id, state=made.state, result=made.result, result_raw=made.raw)
    return {**boundary, "facts": made.facts} if made.facts is not None else boundary


def sealed_owned(made, **extra):
    return {"token": TOKEN, "projects": [PROJECT], "volumes": {}, "networks": [], "stack": made.stack, **extra}


def absent_descriptor(target):
    """The descriptor regenerated_descriptor gives when the stack has no Orthanc container (it applies to nothing)."""
    return {**regenerated_fixture(None, applicable=False), "container_name": target["containers"]["orthanc"], "container_id": None,
            "actual_image": None, "reasons": ["no container of the role"], "startup": None, "image": None, "generated": None, "probe": None}


def write_observation(records_dir, checkpoint_id, purpose, *, plan, target, state_raw, parent=None, descriptor=None, ids=None, absent=()):
    """A complete observation folder as cp.observe_boundary leaves one (r5): the canonical request, the observation state
    with this request's settled Engine exec worker on the database container, the product snapshot, the command record and
    the log it refers to, the journal and, last, observation.json; a capture keeps its regenerated-artifact descriptor
    (r6; by default one that applies to nothing, of the observed Orthanc container). Returns the folder."""
    plan_sha = intro.plan_identity(plan)
    if purpose == "capture" and descriptor is None:
        descriptor = absent_descriptor(target) if "orthanc" in absent else \
            regenerated_fixture(container_ids(target, ids)["orthanc"], applicable=False)
    descriptor_raw = cp.canonical(descriptor) + b"\n" if purpose == "capture" else None
    request = cp.observation_request(checkpoint_id, purpose=purpose, plan_sha256=plan_sha, state_raw=state_raw, parent_manifest_sha256=parent,
                                     regenerated_sha256=cp.sha256(descriptor_raw) if descriptor_raw else None)
    digest = cp.sha256(cp.canonical(request))
    folder = Path(records_dir) / cp.OBSERVATION_DIR / (checkpoint_id + "-" + purpose + "-" + digest[:16])
    (folder / "logs").mkdir(parents=True)
    (folder / "request.json").write_bytes(cp.canonical(request) + b"\n")
    if descriptor_raw:
        (folder / cp.REGENERATED_FILE).write_bytes(descriptor_raw)
    state = json.loads(state_raw)
    basis = {"checkout": "previous", "lock_token": None, "compose_entry": {"generation": "1" * 64, "sha256": "2" * 64}, **state}
    snapshot = snapshot_fixture(basis, plan, target, cp.CHECKPOINTS[checkpoint_id]["boundary"], ids=ids, absent=absent)
    db = snapshot["facts"]["containers"]["value"]["db"]["value"]["id"]
    observed = copy.deepcopy(state)
    observed.setdefault("workers", {})["observation-1"] = {
        "nonce": "observation-1", "kind": "exec", "resource": target["containers"]["db"], "state": "QUIET", "plan_sha256": plan_sha,
        "request_sha256": digest, "container_id": db, "exec_id": "e" * 64, "client_exit": 0, "server_exit": 0,
        "exec_observation": {"ID": "e" * 64, "ContainerID": db, "Running": False, "ExitCode": 0}}
    (folder / "state.json").write_bytes(intro.canonical(observed) + b"\n")
    (folder / "snapshot.json").write_bytes(cp.canonical(snapshot) + b"\n")
    log = b"synthetic observation stderr\n"
    (folder / "logs" / "failed-0.err").write_bytes(log)
    row = {"seq": 1, "argv": ["docker", "exec"], "outcome": "exit", "exit": 0, "failure_log": {"file": "logs/failed-0.err", "sha256": cp.sha256(log)}}
    (folder / ("commands-" + cp.OBSERVATION_PHASE + "-" + digest[:16] + ".jsonl")).write_bytes(intro.canonical(row) + b"\n")
    (folder / "journal.jsonl").write_bytes(intro.canonical({"event": "observation-end", "outcome": "PASS"}) + b"\n")
    originals = {"records/state.json": cp.sha256(state_raw), "lock": None}
    cp.write_observation_result(folder, request_sha256=digest, checkpoint_id=checkpoint_id, purpose=purpose, outcome="PASS", code=None,
                                before=originals, after=dict(originals), original_state_sha256=cp.sha256(state_raw),
                                started_utc=datetime.now(timezone.utc).isoformat())
    return folder


def identity_fixture(**changes):
    identity = {"tool_tree_sha256_at_checkpoint": "1" * 64, "tool_tree_sha256_at_resume": None, "source_tree_sha256": "2" * 64,
                "harness_tree_sha256": "3" * 64, "tool_files_actual_raw_sha256": {name: "9" * 64 for name in intro.TOOL_FILES},
                "source_b0_manifest_sha256": "4" * 64, "clone_b0_manifest_sha256": "5" * 64, "payload_manifest_sha256": "0" * 64,
                "image_ids": {"previous": {"api": image("1"), "db": image("3")}, "release": {"api": image("6"), "db": image("3")},
                              "helper": image("3")},
                "plan_sha256": "6" * 64, "target_manifest_sha256": "7" * 64, "phase_reached": "introduced",
                "created_utc": datetime.now(timezone.utc).isoformat(), "resumed_utc": None, "host_key_sha256": "8" * 64,
                "daemon_identity": "DAEMON:SYNTHETIC", "absolute_fixture_root": "/srv/checkpoints/fixture",
                "runtime_identity": {"python": "3.12", "docker": "27.0", "arch": "x86_64"}, "segment_source_map": {}}
    identity.update(changes)
    return identity


class TempCase(unittest.TestCase):
    def tempdir(self, prefix="kin-checkpoint-"):
        parent = "/root" if os.name == "posix" and os.geteuid() == 0 else None
        folder = tempfile.TemporaryDirectory(prefix=prefix, dir=parent)
        self.addCleanup(folder.cleanup)
        path = Path(folder.name)
        if os.name == "posix":
            path.chmod(0o700)
        return path


def seal(test, store_root, checkpoint_id, *, faults=None, absent=(), drop=(), extra_bindings=None, fixture=None, parent=None,
         derived=False, tamper=None):
    fixture = fixture or test.tempdir("kin-fixture-")
    made = realistic(fixture, checkpoint_id, tamper=tamper)
    bindings = dict(made.bindings)
    bindings.update(extra_bindings or {})
    for name in drop:
        bindings.pop(name, None)
    store = cp.BundleStore(store_root, forbidden=[fixture], faults=faults)
    pending = store.begin(checkpoint_id)
    for category in cp.VOLUME_CATEGORIES:
        if category in absent:
            pending.declare_absent(category)
        elif category != "skip":
            pending.add("volume-" + category + ".tar", "volume:" + category, volume_tar(category))
    tree = pending.directory / "export-fixture.tar"
    cp.write_tree_archive(fixture, tree)
    pending.add("fixture-tree.tar", "fixture-tree", tree)
    tree.unlink()
    return pending.seal(identity=made.identity, boundary=sealed_boundary(checkpoint_id, made), bindings=bindings, owned=sealed_owned(made),
                        execution_kind="fresh", parent=parent, derived=derived)


class CheckpointBoundaryTests(RefusalAssertions, TempCase):
    def test_only_completed_quiet_pre_ponr_boundaries_publish(self):
        """T01 (RQC-01/RSK-01): the product's PASS result, history and worker facts and its own boundary contract."""
        target = target_fixture()
        for checkpoint_id, spec in cp.CHECKPOINTS.items():
            with self.subTest(checkpoint=checkpoint_id):
                plan, state, result, raw = boundary_fixture(checkpoint_id)
                snapshot = snapshot_fixture(state, plan, target, spec["boundary"])
                published = self.admitted(cp.boundary_publishable, checkpoint_id, state=state, result=result, result_raw=raw,
                                          snapshot=snapshot, plan=plan, target=target)
                self.assertEqual((published["status"], published["boundary"]), (spec["status"], spec["boundary"]))
        plan, state, result, raw = boundary_fixture("verified")
        cases = {
            "running phase": lambda s, r: s.update(running={"phase": "verify", "request_sha256": "a" * 64}),
            "UNKNOWN hold": lambda s, r: s.update(unknown_hold={"step": "L-10c"}),
            "NEEDS_ATTENTION": lambda s, r: s.update(status="NEEDS_ATTENTION"),
            "CAPTURE_FAILED": lambda s, r: (s.update(status="CAPTURE_FAILED"), r.update(status="CAPTURE_FAILED")),
            "past the point of no return": lambda s, r: s.update(ponr={"step": "L-11b"}),
            "recovery attempted": lambda s, r: s.update(rollback_attempted=True),
            "a partial step list": lambda s, r: r["steps"].pop(),
            "a step that did not pass": lambda s, r: r["steps"][-1].update(outcome="STOP"),
            "history of another result": lambda s, r: s["history"][-1].update(result_sha256="0" * 64),
            "history that failed": lambda s, r: s["history"][-1].update(status="VERIFY_FAILED"),
            "a worker not settled": lambda s, r: s["workers"]["w1"].update(state="LAUNCHED"),
            "the lock released": lambda s, r: s.update(lock_token=None),
        }
        for name, change in cases.items():
            with self.subTest(refused=name):
                changed_state, changed_result = copy.deepcopy(state), copy.deepcopy(result)
                change(changed_state, changed_result)
                self.assertRefused("NOT_A_BOUNDARY", cp.boundary_publishable, "verified", state=changed_state, result=changed_result,
                                   result_raw=raw)
        with self.subTest(refused="an unsettled browser"):
            self.assertRefused("NOT_A_BOUNDARY", cp.boundary_publishable, "verified", state=state, result=result, result_raw=raw,
                               pending_browsers=1)
        with self.subTest(refused="a mid-phase L-step"):
            self.assertRefused("NOT_A_BOUNDARY", cp.boundary_publishable, "L-10c", state=state, result=result, result_raw=raw)
        with self.subTest(refused="a HELD that a failed introduce returned to"):
            plan, held, held_result, held_raw = boundary_fixture("held")
            held["history"].append({"phase": "introduce", "status": "HELD", "request_sha256": "b" * 64, "seconds": 1.0,
                                    "result_sha256": "c" * 64, "steps": [["I-00", "PASS"], ["L-06a", "STOP"], ["I-RV", "PASS"]]})
            self.assertRefused("NOT_A_BOUNDARY", cp.boundary_publishable, "held", state=held, result=held_result, result_raw=held_raw)
        with self.subTest(refused="a boundary whose running services differ from the product contract"):
            plan, state, result, raw = boundary_fixture("held")
            snapshot = snapshot_fixture(state, plan, target, "L-04c", running={"db", "api"})
            self.assertRefused("NOT_A_BOUNDARY", cp.boundary_publishable, "held", state=state, result=result, result_raw=raw,
                               snapshot=snapshot, plan=plan, target=target)
        with self.subTest(refused="an interrupted (partial) bundle"):
            store = self.tempdir()
            partial = cp.BundleStore(store / "bundles").begin("held").directory
            self.assertRefused("PARTIAL_BUNDLE", cp.load_bundle, partial)


class CheckpointBundleTests(RefusalAssertions, TempCase):
    def test_complete_private_bundle_is_atomic_and_secret_free_in_evidence(self):
        """T02 (RQC-02/08/11): atomic seal, complete inventory, member hashes, archive member rules, no private values."""
        root = self.tempdir()
        printed = io.StringIO()
        with contextlib.redirect_stdout(printed):
            final = seal(self, root / "bundles", "introduced")
        manifest, _ = self.admitted(cp.load_bundle, final)
        raw = (final / "manifest.json").read_bytes()
        self.assertEqual(final.name, hashlib.sha256(raw).hexdigest())
        self.assertTrue(raw.endswith(b"\n") and b"\r\n" not in raw)
        self.assertEqual({m["category"] for m in manifest["members"]}, {"fixture-tree", *("volume:" + c for c in cp.VOLUME_CATEGORIES)})
        self.assertNotIn(SECRET_VALUE.encode(), raw)
        self.assertNotIn(SECRET_VALUE, printed.getvalue())
        self.assertEqual((manifest["fresh_e2e"], manifest["release_gate_eligible"]), (False, False))
        if os.name == "posix":
            self.assertEqual(final.stat().st_mode & 0o777, 0o700)
            self.assertEqual((final / "payload" / "fixture-tree.tar").stat().st_mode & 0o777, 0o600)
        self.assertEqual(cp.tree_member_sha256(final / "payload" / "fixture-tree.tar", manifest["bindings"]["secrets"]["path"]),
                         manifest["bindings"]["secrets"]["sha256"])
        for point in ("member:volume-pg.tar", "member:fixture-tree.tar", "manifest", "rename"):
            with self.subTest(interrupted=point):
                store = self.tempdir() / "bundles"

                def fault(where, point=point):
                    if where == point:
                        raise OSError("synthetic interruption at " + where)
                with self.assertRaises(OSError):
                    seal(self, store, "introduced", faults=fault)
                left = sorted(path.name for path in store.iterdir())
                self.assertEqual(len(left), 1)
                self.assertTrue(left[0].startswith(".partial-"), left)
                self.assertRefused("PARTIAL_BUNDLE", cp.load_bundle, store / left[0])
        for name, kwargs in (("a volume neither captured nor absent", {"absent": ("skip",)}),
                             ("missing secrets binding", {"drop": ("secrets",)}), ("missing entry binding", {"drop": ("compose_entry",)}),
                             ("missing ledger binding", {"drop": ("ledger",)}), ("missing lock binding", {"drop": ("lock",)}),
                             ("missing state binding", {"drop": ("state",)})):
            with self.subTest(incomplete=name):
                store = self.tempdir() / "bundles"
                if name.startswith("a volume"):
                    fixture = self.tempdir()
                    bindings = realistic(fixture, "introduced").bindings
                    pending = cp.BundleStore(store, forbidden=[fixture]).begin("introduced")
                    tree = pending.directory / "t.tar"
                    cp.write_tree_archive(fixture, tree)
                    pending.add("fixture-tree.tar", "fixture-tree", tree)
                    self.assertRefused("BUNDLE_INVALID", pending.seal, identity=identity_fixture(), boundary={}, bindings=bindings,
                                       owned={}, execution_kind="fresh")
                else:
                    self.assertRefused("BUNDLE_INVALID", seal, self, store, "introduced", **kwargs)
        with self.subTest(incomplete="a lock bound at a boundary that released it"):
            plan, state, result, raw_result = boundary_fixture("seeded")
            fixture = self.tempdir()
            self.assertRefused("BUNDLE_INVALID", seal, self, self.tempdir() / "bundles", "seeded", fixture=fixture,
                               extra_bindings={"lock": {"path": "checkpoint-context.json", "sha256": "0" * 64}})
        for name, damage in (("member bytes changed", lambda d: (d / "payload" / "volume-pg.tar").write_bytes(volume_tar("pg") + b"x")),
                             ("extra payload member", lambda d: (d / "payload" / "extra.bin").write_bytes(b"x")),
                             ("member removed", lambda d: (d / "payload" / "volume-orthanc.tar").unlink())):
            with self.subTest(tampered=name):
                copy_dir = self.tempdir() / final.name
                shutil.copytree(final, copy_dir)
                damage(copy_dir)
                self.assertRefused("BUNDLE_INVALID", cp.load_bundle, copy_dir)
        with self.subTest(tampered="renamed bundle"):
            renamed = self.tempdir() / ("0" * 64)
            shutil.copytree(final, renamed)
            self.assertRefused("BUNDLE_INVALID", cp.load_bundle, renamed)
        with self.subTest(duplicate="member name"):
            pending = cp.BundleStore(self.tempdir() / "bundles").begin("held")
            pending.add("volume-pg.tar", "volume:pg", volume_tar("pg"))
            self.assertRefused("BUNDLE_INVALID", pending.add, "volume-pg.tar", "volume:pg", volume_tar("pg"))
        hostile = {"path traversal": [("./../escape", tarfile.REGTYPE, b"x")], "absolute path": [("/etc/passwd", tarfile.REGTYPE, b"x")],
                   "undeclared link": [("./link", tarfile.SYMTYPE, "/etc")],
                   "link escape": [("./pg_tblspc/16385", tarfile.SYMTYPE, "/var/lib/postgresql/elsewhere")],
                   "member under a link": [("./pg_tblspc/16384/inner", tarfile.REGTYPE, b"x")],
                   "device": [("./dev", tarfile.CHRTYPE, None)], "fifo": [("./fifo", tarfile.FIFOTYPE, None)],
                   "hard link": [("./hard", tarfile.LNKTYPE, "./PG_VERSION")]}
        for name, extra in hostile.items():
            with self.subTest(archive=name):
                path = self.tempdir() / "volume.tar"
                path.write_bytes(volume_tar("pg", extra=extra))
                self.assertRefused("ARCHIVE_INVALID", cp.archive_members, path, category="pg")
        # CKPT-07: the whole archive is judged first, so neither a duplicate path nor the member order decides.
        link = ("./pg_tblspc/16384", tarfile.SYMTYPE, intro.TABLESPACE)
        ordered = {"the same path twice (state.json)": [("state.json", tarfile.REGTYPE, b"first"), ("state.json", tarfile.REGTYPE, b"second")],
                   "one path with and without ./": [("./PG_VERSION", tarfile.REGTYPE, b"16\n"), ("PG_VERSION", tarfile.REGTYPE, b"16\n")],
                   "one path as a folder and a file": [("./base", tarfile.DIRTYPE, None), ("./base", tarfile.REGTYPE, b"x")],
                   "a member before the link it lies under": [(".", tarfile.DIRTYPE, None), ("./pg_tblspc", tarfile.DIRTYPE, None),
                                                              ("./pg_tblspc/16384/inner", tarfile.REGTYPE, b"x"), link],
                   "a member after the link it lies under": [(".", tarfile.DIRTYPE, None), ("./pg_tblspc", tarfile.DIRTYPE, None), link,
                                                             ("./pg_tblspc/16384/inner", tarfile.REGTYPE, b"x")]}
        for name, entries in ordered.items():
            with self.subTest(archive=name):
                path = self.tempdir() / "volume.tar"
                path.write_bytes(raw_tar(entries))
                self.assertRefused("ARCHIVE_INVALID", cp.archive_members, path, category="pg")
        path = self.tempdir() / "volume.tar"
        path.write_bytes(raw_tar([(".", tarfile.DIRTYPE, None), ("./pg_tblspc", tarfile.DIRTYPE, None), link, ("./PG_VERSION", tarfile.REGTYPE, b"16\n")]))
        self.assertEqual(len(self.admitted(cp.archive_members, path, category="pg")), 4)
        path = self.tempdir() / "volume.tar"
        path.write_bytes(volume_tar("pg"))
        self.assertEqual(len(self.admitted(cp.archive_members, path, category="pg")), 4)
        path.write_bytes(volume_tar("orthanc", extra=[("./pg_tblspc/16384", tarfile.SYMTYPE, intro.TABLESPACE)]))
        self.assertRefused("ARCHIVE_INVALID", cp.archive_members, path, category="orthanc")
        # r5 (found by the native smoke): a cut archive is refused before the daemon's tar writes any part of it.
        raw = volume_tar("pg", extra=[("./big.bin", tarfile.REGTYPE, b"x" * 4096)])
        with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
            last = archive.getmembers()[-1]
        end = last.offset_data + -(-last.size // tarfile.BLOCKSIZE) * tarfile.BLOCKSIZE
        for label, data in (("a cut header", raw[:700]), ("cut member data", raw[:last.offset_data + 100]), ("no end-of-archive marker", raw[:end])):
            with self.subTest(archive=label):
                path.write_bytes(data)
                self.assertRefused("ARCHIVE_INVALID", cp.archive_members, path, category="pg")
        with self.subTest(overlap="bundle root inside the fixture"):
            fixture = self.tempdir()
            self.assertRefused("BUNDLE_INVALID", cp.BundleStore, fixture / "bundles", forbidden=[fixture])


class CheckpointIdentityTests(RefusalAssertions, TempCase):
    def source_repo(self):
        root = self.tempdir("kin-source-")
        for name in ("scripts/" + item for item in intro.TOOL_FILES):
            (root / name).parent.mkdir(parents=True, exist_ok=True)
            (root / name).write_bytes(("# " + name + "\nvalue = 1\n").encode())
        for name in cp.HARNESS_FILES + ("README.md",):
            (root / name).parent.mkdir(parents=True, exist_ok=True)
            if not (root / name).exists():
                (root / name).write_bytes(("# " + name + "\n").encode())
        git = ["git", "-C", str(root), "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.autocrlf=false"]
        subprocess.run([*git, "init", "-q"], check=True, capture_output=True)
        subprocess.run([*git, "add", "-A"], check=True, capture_output=True)
        subprocess.run([*git, "commit", "-q", "-m", "fixture"], check=True, capture_output=True)
        return root

    def observed(self, root, recorded):
        actual = cp.source_identity(root)
        return {**recorded, "tool_tree_sha256_at_checkpoint": actual["tool"]["sha256"], "source_tree_sha256": actual["source"]["sha256"],
                "harness_tree_sha256": actual["harness"]["sha256"], "tool_files_actual_raw_sha256": actual["tool_files"]}

    def test_actual_bytes_and_all_bound_inputs_must_match(self):
        """T03 (RQC-03/11): raw bytes before and after, separate B0 fields, image IDs, host/daemon/runtime identity."""
        root = self.source_repo()
        actual = cp.source_identity(root)
        recorded = identity_fixture(tool_tree_sha256_at_checkpoint=actual["tool"]["sha256"], source_tree_sha256=actual["source"]["sha256"],
                                    harness_tree_sha256=actual["harness"]["sha256"], tool_files_actual_raw_sha256=actual["tool_files"])
        manifest = {"checkpoint": "introduced", "identity": recorded}
        resumed = self.admitted(cp.admit_same_tree, manifest, self.observed(root, recorded), source_root=root)
        self.assertEqual(resumed["tool_tree_sha256_at_resume"], actual["tool"]["sha256"])
        self.assertTrue(resumed["resumed_utc"])
        head = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout
        tool = root / "scripts" / "ops_backup.py"
        original = tool.read_bytes()
        with self.subTest(changed="actual bytes under the same HEAD (CRLF only)"):
            tool.write_bytes(original.replace(b"\n", b"\r\n"))
            self.assertEqual(subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"], capture_output=True, text=True).stdout, head)
            self.assertRefused("IDENTITY_MISMATCH", cp.admit_same_tree, manifest, self.observed(root, recorded))
            with self.subTest(claim="a caller's claimed hash instead of the actual bytes"):
                self.assertRefused("IDENTITY_MISMATCH", cp.admit_same_tree, manifest, dict(recorded), source_root=root)
            self.assertRefused("SOURCE_CHANGED", cp.unchanged, actual["tool"], root)
            tool.write_bytes(original)
        self.assertEqual(self.admitted(cp.unchanged, actual["tool"], root), actual["tool"])
        with self.subTest(changed="untracked explicit helper"):
            helper = root / "scripts" / "local-helper.py"
            helper.write_bytes(b"x = 1\n")
            before = cp.source_identity(root, helpers=["scripts/local-helper.py"])["tool"]["sha256"]
            helper.write_bytes(b"x = 2\n")
            self.assertNotEqual(cp.source_identity(root, helpers=["scripts/local-helper.py"])["tool"]["sha256"], before)
            helper.unlink()
            self.assertRefused("INPUT_MISSING", cp.source_identity, root, helpers=["scripts/local-helper.py"])
        with self.subTest(refused="duplicate and invalid inputs"):
            self.assertRefused("INPUT_DUPLICATE", cp.tree_manifest, root, ["README.md", "./README.md"])
            self.assertRefused("INPUT_INVALID", cp.tree_manifest, root, ["../outside"])
            self.assertRefused("INPUT_INVALID", cp.tree_manifest, root, ["scripts"])
            self.assertRefused("INPUT_MISSING", cp.tree_manifest, root, ["missing.py"])
        observed = self.observed(root, recorded)
        swapped = {**observed, "source_b0_manifest_sha256": recorded["clone_b0_manifest_sha256"],
                   "clone_b0_manifest_sha256": recorded["source_b0_manifest_sha256"]}
        with self.subTest(refused="source and clone B0 exchanged"):
            self.assertRefused("IDENTITY_MISMATCH", cp.admit_same_tree, manifest, swapped)
        for field, value in (("plan_sha256", "a" * 64), ("target_manifest_sha256", "a" * 64), ("daemon_identity", "OTHER"),
                             ("runtime_identity", {"python": "3.13"}), ("host_key_sha256", "a" * 64),
                             ("absolute_fixture_root", "/srv/other"),
                             ("image_ids", {**recorded["image_ids"], "release": {"api": image("e"), "db": image("3")}})):
            with self.subTest(refused=field):
                self.assertRefused("IDENTITY_MISMATCH", cp.admit_same_tree, manifest, {**observed, field: value})
        with self.subTest(refused="an image tag instead of an image ID"):
            tagged = {**observed, "image_ids": {**observed["image_ids"], "helper": "postgres:16-alpine"}}
            self.assertRefused("IDENTITY_INVALID", cp.identity_valid, {**tagged})
            self.assertRefused("IDENTITY_INVALID", cp.admit_same_tree, manifest, tagged)
        with self.subTest(refused="naive creation time"):
            self.assertRefused("TIME_INVALID", cp.identity_valid, identity_fixture(created_utc="2026-10-15T00:00:00"))


class CheckpointImpactTests(RefusalAssertions, unittest.TestCase):
    """Raw-byte comparison of the product tool is the admission requirement itself (see the module header)."""

    @classmethod
    def setUpClass(cls):
        cls.text = (ROOT / cp.PRODUCT_FILE).read_bytes().decode("utf-8")

    def change(self, *edits):
        text = self.text
        for edit in edits:
            text = edit(text)
        return cp.classify_change({cp.PRODUCT_FILE: self.text.encode()}, {cp.PRODUCT_FILE: text.encode()})

    def body(self, name, line="return None"):
        return lambda text: cp.mutate_body(text, name, [line])

    def test_closed_body_changes_select_only_unexecuted_phases(self):
        """T04 (RQC-04/RSK-04): AST body ranges over the actual product file; the earliest affected phase rules."""
        suffix = {"held": ("introduce", "verify", "reopen"), "failure-held": ("introduce", "rollback_reopen"),
                  "introduced": ("verify", "reopen")}
        expected = {"HostOps.proxy_ui": {"held", "failure-held"}, "HostOps.fenced_smoke": {"held", "introduced"},
                    "HostOps.probe": {"held", "introduced"}, "HostOps.final_allowlist": {"held", "introduced"},
                    "HostOps.backup_readiness": {"held", "introduced"}}
        for name, allowed in expected.items():
            classification = self.change(self.body(name))
            self.assertEqual(classification, {"changed_bodies": [name], "prefix": [], "unclassified": []}, name)
            for checkpoint_id in ("held", "failure-held", "introduced"):
                with self.subTest(body=name, checkpoint=checkpoint_id):
                    if checkpoint_id in allowed:
                        admission = self.admitted(cp.admit_changed_tree, checkpoint_id, classification, suffix_phases=suffix[checkpoint_id])
                        self.assertEqual((admission["execution_kind"], admission["fresh_e2e"], admission["release_gate_eligible"]),
                                         ("diagnostic-fork", False, False))
                        self.assertEqual(admission["earliest_phase"], cp.ALLOWLIST[name]["earliest_phase"])
                    else:
                        self.assertRefused("PREFIX_CHANGED", cp.admit_changed_tree, checkpoint_id, classification,
                                           suffix_phases=suffix[checkpoint_id])
            with self.subTest(body=name, checkpoint="verified"):
                self.assertRefused("VERIFIED_PLAN_BINDING", cp.admit_changed_tree, "verified", classification,
                                   suffix_phases=("reopen",))
            for checkpoint_id in ("seeded", "source-b0"):
                with self.subTest(body=name, checkpoint=checkpoint_id):
                    self.assertRefused("CROSS_TREE_REFUSED", cp.admit_changed_tree, checkpoint_id, classification,
                                       suffix_phases=("seed", "capture", "introduce", "verify", "reopen"))
        late = self.body("HostOps.backup_readiness")
        refusals = {
            "prepare": ("PREFIX_CHANGED", self.change(self.body("HostOps.prepare", "return {}"))),
            "prepare and a late body": ("PREFIX_CHANGED", self.change(self.body("HostOps.prepare", "return {}"), late)),
            "a shared helper": ("PREFIX_CHANGED", self.change(self.body("require", "return None"))),
            "the phase machine": ("PREFIX_CHANGED", self.change(self.body("Introduction.phase_verify", "return None"))),
            "Records": ("PREFIX_CHANGED", self.change(self.body("Records.state", "return None"))),
            "an import": ("UNCLASSIFIED_CHANGE", self.change(lambda t: t.replace("import argparse", "import argparse\nimport zlib", 1))),
            "a global constant": ("UNCLASSIFIED_CHANGE", self.change(lambda t: t.replace("SMOKE_RETRY_S = 120", "SMOKE_RETRY_S = 121", 1))),
            "a default": ("UNCLASSIFIED_CHANGE", self.change(lambda t: t.replace("def backup_readiness(self, intro):",
                                                                                 "def backup_readiness(self, intro, strict=True):", 1))),
            "a decorator": ("UNCLASSIFIED_CHANGE", self.change(lambda t: t.replace("    def backup_readiness(self, intro):",
                                                                                   "    @staticmethod\n    def backup_readiness(self, intro):", 1))),
            "a comment between functions": ("UNCLASSIFIED_CHANGE", self.change(lambda t: t.replace("    # ── reopen ──", "    # ── reopen (edited) ──", 1))),
            "a new function": ("UNCLASSIFIED_CHANGE", self.change(lambda t: t + "\n\ndef added_helper():\n    return 1\n")),
            "another scripts file": ("UNCLASSIFIED_CHANGE", cp.classify_change({"scripts/ops_backup.py": b"a"}, {"scripts/ops_backup.py": b"b"})),
        }
        for name, (code, classification) in refusals.items():
            with self.subTest(refused=name):
                self.assertTrue(classification["prefix"] or classification["unclassified"], classification)
                self.assertRefused(code, cp.admit_changed_tree, "introduced", classification, suffix_phases=("verify", "reopen"))
        classification = self.change(late)
        for name, kwargs, code in (("harness change", {"harness_changed": True}, "HARNESS_CHANGED"),
                                   ("source outside scripts", {"source_changed": True}, "UNCLASSIFIED_CHANGE"),
                                   ("a derived donor (second fork)", {"parent_derived": True}, "DERIVED_DONOR")):
            with self.subTest(refused=name):
                self.assertRefused(code, cp.admit_changed_tree, "introduced", classification, suffix_phases=("verify", "reopen"), **kwargs)
        with self.subTest(refused="the suffix skips the first affected phase"):
            self.assertRefused("SUFFIX_INCOMPLETE", cp.admit_changed_tree, "introduced", classification, suffix_phases=("verify",))
        with self.subTest(earliest="two late bodies take the earliest phase"):
            both = self.change(late, self.body("HostOps.probe"))
            admission = self.admitted(cp.admit_changed_tree, "introduced", both, suffix_phases=("verify", "reopen"))
            self.assertEqual(admission["earliest_phase"], "verify")
            self.assertRefused("PREFIX_CHANGED", cp.admit_changed_tree, "introduced", self.change(late, self.body("HostOps.proxy_ui")),
                               suffix_phases=("verify", "reopen"))


class CheckpointForkTests(RefusalAssertions, TempCase):
    def parent(self):
        if os.name == "posix" and os.geteuid() != 0:
            self.skipTest("ComposeEntry protection requires root on Linux; the CI step runs this module with sudo")
        root = self.tempdir()
        repo = root / "repo"
        repo.mkdir()
        plan, state, result, raw = boundary_fixture("introduced")
        plan_sha = intro.plan_identity(plan)
        entry = intro.ComposeEntry(root / "compose-entries")
        validated = []
        sources = [("docker-compose.yml", b"services: {}\n"), ("/srv/fixture/overlay.yml", b"services: {}\n")]
        pointer = entry.publish(repository=repo, project=PROJECT, sources=sources, env_raw=b"VALUE=1\n", values={"VALUE": "1"},
                                runtime="services: {}\n", plan_sha256=plan_sha, validate=lambda command, env: validated.append(command))
        state["compose_entry"] = {**pointer, "root": str(entry.root)}
        state["previous_operating_entry"] = None
        return root, entry, plan, plan_sha, state, validated

    def test_real_plan_and_compose_binding_preserve_parent_and_deny_receipt(self):
        """T05 (RQC-04/05): product canonical plan and ComposeEntry; parent bytes unchanged; empty child history."""
        root, entry, plan, plan_sha, state, validated = self.parent()
        parent_tree = {path.relative_to(entry.root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
                       for path in sorted(entry.root.rglob("*")) if path.is_file() and path.name != "active.json"}
        parent_state = copy.deepcopy(state)
        child_tool = {name: "c" * 64 for name in intro.TOOL_FILES}
        child_plan, child_sha = self.admitted(cp.fork_plan, plan, child_tool)
        self.assertEqual(child_plan["tool"], child_tool)
        self.assertEqual(child_sha, intro.plan_identity(child_plan))
        self.assertNotEqual(child_sha, plan_sha)
        self.assertEqual({key: value for key, value in child_plan.items() if key != "tool"}, {key: value for key, value in plan.items() if key != "tool"})
        child_pointer = self.admitted(cp.fork_compose_entry, entry.root, state["compose_entry"], parent_plan_sha256=plan_sha,
                                      child_plan_sha256=child_sha, validate=lambda command, env: validated.append(command))
        self.assertIn("config", validated[-1])
        _, child_manifest, _ = entry.load(child_pointer)
        self.assertEqual(child_manifest["plan_sha256"], child_sha)
        _, parent_manifest, _ = entry.load({key: state["compose_entry"][key] for key in ("generation", "sha256")})
        self.assertEqual(parent_manifest["plan_sha256"], plan_sha)
        for name, digest in parent_tree.items():
            self.assertEqual(hashlib.sha256((entry.root / name).read_bytes()).hexdigest(), digest, name)
        child_state = self.admitted(cp.fork_state, state, checkpoint_id="introduced", child_plan_sha256=child_sha, child_pointer=child_pointer)
        self.assertEqual(state, parent_state, "the parent state is not modified")
        self.assertEqual(child_state["plan_sha256"], child_sha)
        self.assertEqual(child_state["history"], [])
        self.assertEqual({key: child_state["compose_entry"][key] for key in ("generation", "sha256")}, child_pointer)
        self.assertEqual(child_state["compose_entry"]["root"], state["compose_entry"]["root"])
        kept = {key for key in state if key not in ("plan_sha256", "history", "compose_entry")}
        self.assertEqual({key: child_state[key] for key in kept}, {key: state[key] for key in kept})
        records = intro.Records(root / "records")
        self.assertTrue(cp.receipt_refused(child_state, child_plan, child_sha, records), "an empty child history cannot be receipted")
        self.assertRefused("FORK_REFUSED", cp.fork_plan, plan, dict(plan["tool"]))
        self.assertRefused("FORK_REFUSED", cp.fork_plan, plan, {"ops_backup.py": "c" * 64})
        self.assertIs(intro.tool_hashes, cp.intro.tool_hashes)

    def test_changed_tool_cannot_inherit_verified_smoke(self):
        """T06 (RQC-04): VERIFIED refuses before restore; INTRODUCED admits; only the child's own smoke is valid."""
        text = (ROOT / cp.PRODUCT_FILE).read_bytes()
        changed = cp.mutate_body(text.decode("utf-8"), "HostOps.backup_readiness", ["return None"]).encode()
        restored = []
        for checkpoint_id, outcome in (("verified", "VERIFIED_PLAN_BINDING"), ("introduced", None)):
            with self.subTest(checkpoint=checkpoint_id):
                manifest = {"checkpoint": checkpoint_id, "identity": identity_fixture(phase_reached=checkpoint_id), "derived": False}
                observed = {**manifest["identity"], "tool_tree_sha256_at_checkpoint": "e" * 64}
                kwargs = dict(old_tool_files={cp.PRODUCT_FILE: text}, new_tool_files={cp.PRODUCT_FILE: changed},
                              suffix_phases=("verify", "reopen"), parent_manifest_sha256="d" * 64, restore=restored.append)
                if outcome:
                    self.assertRefused(outcome, cp.resume_or_refuse, manifest, observed, **kwargs)
                    self.assertEqual(restored, [], "no restore before the admission")
                else:
                    decision, _ = self.admitted(cp.resume_or_refuse, manifest, observed, **kwargs)
                    self.assertEqual(decision["execution_kind"], "diagnostic-fork")
                    self.assertEqual(len(restored), 1)
        plan, state, result, raw = boundary_fixture("introduced")
        child_plan, child_sha = cp.fork_plan(plan, {name: "c" * 64 for name in intro.TOOL_FILES})
        parent_smoke = {"schema": 1, "kind": "operator-smoke", "plan_sha256": intro.plan_identity(plan),
                        "checks": {name: True for name in intro.OPERATOR_SMOKE_CHECKS}, "passed": True, "by": intro.SMOKE_BY,
                        "at": datetime.now(timezone.utc).isoformat()}
        with self.assertRaises(intro.Stop):
            intro.operator_smoke_valid(parent_smoke, child_sha)
        intro.operator_smoke_valid({**parent_smoke, "plan_sha256": child_sha}, child_sha)
        state["operator_smoke"] = {"file": "operator-smoke.json", "sha256": "a" * 64}
        self.assertRefused("FORK_REFUSED", cp.fork_state, state, checkpoint_id="introduced", child_plan_sha256=child_sha,
                           child_pointer={"generation": "3" * 64, "sha256": "4" * 64})
        verified_state = boundary_fixture("verified")[1]
        self.assertRefused("FORK_REFUSED", cp.fork_state, verified_state, checkpoint_id="verified", child_plan_sha256=child_sha,
                           child_pointer={"generation": "3" * 64, "sha256": "4" * 64})


def segment(kind="fresh", stage=None, case=None, **changes):
    request = {"unit": "unit-a", "case": case or cp.FRESH_CASES["forward"], "stage": stage, "scenario": "forward", "execution_kind": kind}
    record = cp.segment_record(request=request, request_sha256="a" * 64, marker={}, identity={}, executed_phases=["seed"],
                               inherited_phases=[], results={}, cleanup={"complete": True}, run_json="/x/run.json",
                               started_utc="t0", ended_utc="t1", selected_tests=[request["case"]])
    record.update(exit_code=0, skipped=0, tests_run=1, results_complete=True)
    record.update(changes)
    return record


class CheckpointClaimTests(unittest.TestCase):
    def test_inherited_or_missing_segments_never_become_fresh_pass(self):
        """T07 (RQC-05/11): only one whole fresh method run counts; expected STOP is a proof, not a fresh pass."""
        self.assertTrue(cp.fresh_gate_verdict({"segments": [segment()]})["fresh_pass"])
        for kind in ("checkpoint-resume", "diagnostic-fork", "reseed-from-recorded-b0"):
            record = segment(kind, stage="verify", case=cp.STAGES["verify"]["case"])
            self.assertIs(record["fresh_e2e"], False, kind)
            self.assertIs(record["release_gate_eligible"], False, kind)
        self.assertIs(segment("fresh", stage="source", case=cp.STAGES["source"]["case"])["fresh_e2e"], False)
        self.assertIs(segment()["release_gate_eligible"], False)
        refused = {
            "same-tree resumed": [segment("checkpoint-resume", stage="verify", case=cp.STAGES["verify"]["case"])],
            "mixed fork": [segment("diagnostic-fork", stage="verify", case="CheckpointSegments.test_late_change_resume")],
            "prefix plus tail (branch mix)": [segment("fresh", stage="source", case=cp.STAGES["source"]["case"]),
                                              segment("checkpoint-resume", stage="forward-tail", case=cp.STAGES["forward-tail"]["case"])],
            "missing results": [segment(results_complete=False)], "duplicate": [segment(), segment()], "none": [],
            "skip": [segment(skipped=1)], "wrong exit": [segment(exit_code=1)], "no test ran": [segment(tests_run=0)],
            "cleanup failure": [segment(cleanup={"complete": False})],
            "a stage leaf claiming fresh": [segment("fresh", stage="source", case=cp.STAGES["source"]["case"], fresh_e2e=True)],
        }
        for name, segments in refused.items():
            with self.subTest(refused=name):
                verdict = cp.fresh_gate_verdict({"segments": segments})
                self.assertFalse(verdict["fresh_pass"], name)
                self.assertTrue(verdict["reasons"])
        stop = {"outcome": "STOP", "step": "L-11a"}
        self.assertEqual(cp.segment_outcome(segment(expected=stop, observed=stop)), "EXPECTED_STOP")
        self.assertEqual(cp.segment_outcome(segment(expected=stop, observed={"outcome": "STOP", "step": "L-10a"})), "FAIL")
        self.assertEqual(cp.segment_outcome(segment(expected=stop, observed={"outcome": "PASS"})), "FAIL")
        self.assertEqual(cp.segment_outcome(segment(expected=stop, observed=stop, exit_code=1)), "FAIL")
        self.assertEqual(cp.segment_outcome(segment(observed={"outcome": "UNKNOWN"})), "FAIL")
        self.assertFalse(cp.fresh_gate_verdict({"segments": [segment(expected=stop, observed=stop)]})["fresh_pass"],
                         "a met negative proof is not a fresh pass")


class CaptureFixture:
    def captured(self, checkpoint_id, backend=None, *, running=None, descriptor=None, fixture=None, store_root=None, before=None, ids=None,
                 absent=()):
        target = target_fixture()
        names = {role: target["containers"][role] for role in intro.ROLES}
        volumes = {**target["volumes"], "proxy_certs": PROJECT + "_proxy-certs"}
        backend = backend or FakeBackend(names, volumes, running=running)
        fixture = fixture or self.tempdir()
        made = realistic(fixture, checkpoint_id, layer=False, descriptor=descriptor, ids=ids, absent=absent)
        # r7: the containers run the boundary generation's pinned images unless a case gives another one, and the seal's
        # boundary facts are taken from the same daemon before the stop (seal_boundary).
        pins = cp.pinned_images(made.plan, made.state)
        for role, name in names.items():
            if backend.containers.get(name, {}).get("image", "") is None:
                backend.containers[name]["image"] = pins[role]
        boundary = {**cp.boundary_publishable(checkpoint_id, state=made.state, result=made.result, result_raw=made.raw),
                    "facts": backend.boundary_facts()}
        if before is not None:   # r8: a fixture file changed after its binding was taken (the hash not updated)
            before(fixture, made)
        store = cp.BundleStore(store_root or self.tempdir() / "bundles", forbidden=[fixture])
        final = cp.capture_checkpoint(checkpoint_id=checkpoint_id, store=store, backend=backend, boundary=boundary, names=names,
                                      volumes=volumes, fixture_root=fixture, bindings=made.bindings, identity=made.identity,
                                      owned={"token": TOKEN, "projects": {PROJECT}, "networks": [{"name": PROJECT + "-halo",
                                                                                                   "labels": {"kin.ops.run": TOKEN}}],
                                             "stack": made.stack},
                                      execution_kind="fresh")
        return final, backend, names, fixture


class CheckpointRestoreTests(CaptureFixture, RefusalAssertions, TempCase):
    def test_restore_preserves_boundary_and_uses_only_owned_empty_targets(self):
        """T08 (RQC-02): stop order, writable-layer rule, new volumes only, boundary roles, no seed/provision/migrate."""
        for checkpoint_id, started in (("held", ["db"]), ("introduced", ["db", *intro.RESUME_ORDER]), ("verified", ["db", *intro.RESUME_ORDER])):
            with self.subTest(checkpoint=checkpoint_id):
                running = {"db"} if checkpoint_id == "held" else None
                final, backend, names, fixture = self.captured(checkpoint_id, running=running)
                stops = [call[1] for call in backend.calls if call[0] == "stop"]
                self.assertEqual(stops, [names[role] for role in (*intro.FENCE_ORDER, "db") if role in (running or intro.ROLES)])
                manifest, directory = cp.load_bundle(final)
                fresh = FakeBackend(names, {}, running=set())
                fresh.containers.clear()
                observed = []
                target_root = self.tempdir() / "restored"
                actions = self.admitted(cp.restore_checkpoint, manifest, directory, backend=fresh, fixture_root=target_root, names=names,
                                        images_present=lambda image_id: True, observe=observed.append)
                self.assertEqual([call[1] for call in fresh.calls if call[0] == "compose_start"], started)
                self.assertEqual([call for call in fresh.calls if call[0] == "compose_create"], [("compose_create", tuple(intro.ROLES))])
                self.assertEqual(observed, [cp.CHECKPOINTS[checkpoint_id]["boundary"]])
                self.assertEqual(sorted(fresh.loaded), sorted(v["name"] for v in manifest["owned"]["volumes"].values()))
                self.assertEqual(fresh.networks[PROJECT + "-halo"]["labels"], {"kin.ops.run": TOKEN})
                self.assertFalse([a for a in actions if any(word in str(a) for word in ("seed", "provision", "migrate"))])
                self.assertEqual({name for name, item in fresh.containers.items() if item["running"]},
                                 {names[role] for role in started})
                self.assertTrue((target_root / "clone/records/state.json").is_file())
        final, backend, names, fixture = self.captured("introduced")
        manifest, directory = cp.load_bundle(final)
        cases = {
            "an existing volume": ("RESOURCE_EXISTS", lambda b: b.volumes.update({PROJECT + "_pg-db": {"id": "x", "name": PROJECT + "_pg-db",
                                                                                                         "labels": {}}})),
            "a container name in use": ("RESOURCE_EXISTS", lambda b: b.containers.update({names["api"]: {"id": "x", "name": names["api"],
                                                                                                          "labels": {}, "running": True}})),
        }
        for name, (code, prepare) in cases.items():
            with self.subTest(refused=name):
                fresh = FakeBackend(names, {}, running=set())
                fresh.containers.clear()
                prepare(fresh)
                root = self.tempdir() / "restored"
                self.assertRefused(code, cp.restore_checkpoint, manifest, directory, backend=fresh, fixture_root=root, names=names,
                                   images_present=lambda image_id: True, observe=lambda sid: None)
                self.assertEqual(fresh.mutations(), [])
                self.assertFalse(root.exists())
        with self.subTest(refused="a stale image"):
            fresh = FakeBackend(names, {}, running=set())
            self.assertRefused("STALE_IMAGE", cp.restore_checkpoint, manifest, directory, backend=fresh, fixture_root=self.tempdir() / "r",
                               names=names, images_present=lambda image_id: image_id != image("6"), observe=lambda sid: None)
            self.assertEqual(fresh.mutations(), [])
        with self.subTest(refused="a non-empty fixture root"):
            fresh = FakeBackend(names, {}, running=set())
            fresh.containers.clear()
            occupied = self.tempdir()
            (occupied / "other").write_text("x")
            self.assertRefused("RESOURCE_EXISTS", cp.restore_checkpoint, manifest, directory, backend=fresh, fixture_root=occupied,
                               names=names, images_present=lambda image_id: True, observe=lambda sid: None)
        with self.subTest(refused="a lock token that differs from the state"):
            # r7: the restore judges the bundle's current bytes again, so the lock that differs from the state is sealed
            # with its own binding (a bundle edited after its seal is BUNDLE_INVALID before this check).
            fresh = FakeBackend(names, {}, running=set())
            fresh.containers.clear()
            fixture = self.tempdir()
            made = realistic(fixture, "introduced")
            lock = fixture / made.bindings["lock"]["path"]
            lock.write_text("another-token")
            made.bindings["lock"] = {**made.bindings["lock"], "sha256": hashlib.sha256(lock.read_bytes()).hexdigest()}
            locked, locked_dir = cp.load_bundle(bundle_from(self, fixture, made))
            self.assertRefused("LOCK_MISMATCH", cp.restore_checkpoint, locked, locked_dir, backend=fresh, fixture_root=self.tempdir() / "r",
                               names=names, images_present=lambda image_id: True, observe=lambda sid: None)
        with self.subTest(refused="a bundle edited after its seal"):
            fresh = FakeBackend(names, {}, running=set())
            fresh.containers.clear()
            altered = self.tempdir() / directory.name
            shutil.copytree(directory, altered)
            tree = altered / "payload" / "fixture-tree.tar"
            work = self.tempdir()
            cp.extract_tree(tree, work / "x")
            (work / "x" / "clone/repo/.kin-ops.lock").write_text("another-token")
            tree.unlink()
            cp.write_tree_archive(work / "x", tree)
            self.assertRefused("BUNDLE_INVALID", cp.restore_checkpoint, manifest, altered, backend=fresh, fixture_root=self.tempdir() / "r",
                               names=names, images_present=lambda image_id: True, observe=lambda sid: None)
            self.assertEqual(fresh.mutations(), [])
        target = target_fixture()
        names = {role: target["containers"][role] for role in intro.ROLES}
        volumes = {**target["volumes"], "proxy_certs": PROJECT + "_proxy-certs"}
        for name, (code, prepare) in {
            "a forced kill": ("STOP_UNCONFIRMED", lambda b: b.stop_outcome.update({names["keycloak"]: {"exit_code": 137, "forced": True,
                                                                                                       "running": False}})),
            "an unconfirmed stop": ("STOP_UNCONFIRMED", lambda b: b.stop_outcome.update({names["db"]: {"exit_code": 0, "running": True}})),
            "unknown writable-layer state": ("WRITABLE_LAYER", lambda b: b.diffs.update({names["orthanc"]: ["A /etc/orthanc/extra.json"]})),
            "a non-owned volume": ("NOT_OWNED", lambda b: b.volumes[PROJECT + "_pg-db"].update(labels={"com.docker.compose.project": "other"})),
            "a non-owned container with our name": ("NOT_OWNED", lambda b: b.containers[names["api"]].update(labels={})),
            "an anonymous volume": ("UNDECLARED_STATE", lambda b: (
                b.volumes.update({"a" * 64: {"id": "a" * 64, "name": "a" * 64, "labels": {"com.docker.compose.project": PROJECT}}}),
                b.containers[names["orthanc"]].update(mounts=[{"type": "volume", "name": "a" * 64}]))),
            "a foreign volume": ("UNDECLARED_STATE", lambda b: (
                b.volumes.update({"shared-data": {"id": "shared-data", "name": "shared-data", "labels": {}}}),
                b.containers[names["api"]].update(mounts=[{"type": "volume", "name": "shared-data"}]))),
            "a bind outside the fixture tree": ("UNDECLARED_STATE", lambda b: b.containers[names["proxy"]].update(
                mounts=[{"type": "bind", "source": str(outside)}])),
        }.items():
            with self.subTest(refused=name):
                outside = self.tempdir()
                backend = FakeBackend(names, volumes)
                prepare(backend)
                self.assertRefused(code, self.captured, "introduced", backend)
                self.assertFalse([call for call in backend.calls if call[0] == "export"], "nothing exported before the refusal")
        with self.subTest(captured="another volume of the project"):
            backend = FakeBackend(names, volumes)
            extra = PROJECT + "_rehearsal-workflow"
            backend.volumes[extra] = {"id": extra, "name": extra, "labels": {"com.docker.compose.project": PROJECT,
                                                                               "com.docker.compose.volume": "rehearsal-workflow"}}
            backend.containers[names["proxy"]]["mounts"] = [{"type": "volume", "name": extra},
                                                           {"type": "volume", "name": PROJECT + "_proxy-certs"}]
            final, backend, names, fixture = self.captured("introduced", backend)
            manifest, directory = cp.load_bundle(final)
            self.assertEqual(manifest["owned"]["volumes"]["extra:" + extra]["name"], extra)
            fresh = FakeBackend(names, {}, running=set())
            fresh.containers.clear()
            cp.restore_checkpoint(manifest, directory, backend=fresh, fixture_root=self.tempdir() / "restored", names=names,
                                  images_present=lambda image_id: True, observe=lambda sid: None)
            self.assertIn(extra, fresh.loaded)
        # r5 (the native smoke): the mount point a declared mount needs, and the folder made to hold it, are no layer
        # state; a file stored beside it is. r6 (CKPT5-01): the Orthanc image's own start is accepted on the Orthanc role
        # with the descriptor of its pinned image, and the same changes on another role are refused.
        descriptor = regenerated_fixture("id-" + names["orthanc"])
        images = cp.pinned_images(plan_fixture(), {"entry_checkout": "target"})
        for name, role, diffs, allowed in (("a mount point and the folder made for it", "proxy", ["A /etc/nginx", "A /etc/nginx/certs"], True),
                                           ("a file beside the mount point", "proxy", ["A /etc/nginx", "A /etc/nginx/certs", "A /etc/nginx/extra.conf"], False),
                                           ("the Orthanc image's own start on the Orthanc role", "orthanc", ORTHANC_START, True),
                                           ("the same start changes on another role", "proxy", ORTHANC_START, False),
                                           ("a mount point of another container", "proxy", ["A /var/lib/postgresql/emr-access"], False)):
            with self.subTest(layer=name):
                backend = FakeBackend(names, volumes, images=images)
                backend.containers[names["proxy"]]["mounts"] = [{"type": "volume", "name": PROJECT + "_proxy-certs",
                                                                 "destination": "/etc/nginx/certs"}]
                backend.diffs.update({names[role]: diffs})
                backend.layers[names[role]] = start_facts(descriptor)
                if allowed:
                    final, _, _, _ = self.admitted(self.captured, "introduced", backend, descriptor=descriptor)
                    self.admitted(cp.load_bundle, final)
                else:
                    self.assertRefused("WRITABLE_LAYER", self.captured, "introduced", backend, descriptor=descriptor)


class CheckpointBudgetTests(RefusalAssertions, TempCase):
    """Real scripts/run-tests.py in a synthetic repository with its own gate state (never the account's ledger)."""

    def setUp(self):
        self.path = self.tempdir("kin-checkpoint-runner-")
        self.repo, self.state = self.path / "repo", self.path / "state"
        (self.repo / "tests").mkdir(parents=True)
        self.bootstrap = self.path / "bootstrap.py"
        self.bootstrap.write_text(
            "import importlib.util\nfrom pathlib import Path\n"
            "spec=importlib.util.spec_from_file_location('runner', " + repr(str(RUNNER)) + ")\n"
            "runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)\n"
            "runner.ROOT=Path(" + repr(str(self.repo)) + ")\n"
            "runner.gate.STATE=Path(" + repr(str(self.state)) + ")\n"
            "runner.__file__=__file__\nraise SystemExit(runner.main())\n", encoding="utf-8")
        (self.repo / cp.LIVE_FILE).write_text(textwrap.dedent("""\
            import time, unittest
            from live_test_gate import require_live_run
            class CheckpointSegments(unittest.TestCase):
                def test_source_checkpoint(self):
                    require_live_run(); self.fail("synthetic stage failure")
                def test_seed_checkpoint(self):
                    require_live_run()
                def test_capture_checkpoint(self):
                    require_live_run(); time.sleep(30)
            """), encoding="utf-8")
        shutil.copyfile(TESTS / "live_test_gate.py", self.repo / "tests" / "live_test_gate.py")
        self.leaves = [dict(leaf) for leaf in cp.DEFAULT_PROOF_LEAVES[:3]]

    def run_leaf(self, unit, timeout=30, name=None):
        plan = cp.leaf_plan(self.leaves, unit, timeout_seconds=timeout)
        path = self.path / ((name or unit) + "-" + str(time.time_ns()) + ".json")
        path.write_text(json.dumps(plan), encoding="utf-8")
        return subprocess.run([sys.executable, "-B", str(self.bootstrap), "--plan", str(path)], capture_output=True, timeout=90)

    def inspect_and_release(self):
        marker = self.state / "live-needs-inspection.json"
        with patch.object(gate, "STATE", self.state):
            record = self.path / ("inspection-" + str(time.time_ns()) + ".json")
            record.write_text(json.dumps(cp.inspection_record(gate, exit_code=125, artifacts=["run.log"],
                                                              stack={"remaining": [], "preserved": []}, inspector="fixture-owner")))
            stamp = max(time.time_ns(), marker.stat().st_mtime_ns + 1_000_000)
            os.utime(record, ns=(stamp, stamp))
            gate.release_after_inspection(record)

    def ledger(self, unit):
        return json.loads((self.state / (unit + ".json")).read_text())

    def test_real_runner_preserves_leaf_attempts_and_refusals(self):
        """T09 (RQC-06/RSK-06): registry units only; 3 attempts; 3600 s; passed/running/interrupted are final."""
        failing, passing, hanging = (leaf["unit"] for leaf in self.leaves)
        for attempt in (1, 2, 3):
            result = self.run_leaf(failing, name="output-root-" + str(attempt))
            self.assertEqual(result.returncode, 125, result.stderr[-2000:])
            self.assertEqual(len(self.ledger(failing)["attempts"]), attempt)
            blocked = self.run_leaf(failing)
            self.assertIn(b"fixture inspection", blocked.stderr)
            self.assertEqual(len(self.ledger(failing)["attempts"]), attempt, "a refused start consumes no attempt")
            self.inspect_and_release()
        exhausted = self.run_leaf(failing, timeout=600)
        self.assertIn(b"budget exhausted", exhausted.stderr)
        self.assertEqual(self.run_leaf(passing).returncode, 0)
        self.assertIn(b"already passed", self.run_leaf(passing).stderr)
        interrupted = self.run_leaf(hanging, timeout=3)
        self.assertEqual(interrupted.returncode, 124)
        self.assertEqual(self.ledger(hanging)["attempts"][-1]["status"], "interrupted")
        self.inspect_and_release()
        self.assertIn(b"needs inspection", self.run_leaf(hanging).stderr)
        self.assertEqual(len(self.ledger(hanging)["attempts"]), 1)
        self.assertRefused("REGISTRY_INVALID", cp.leaf_plan, self.leaves, passing, timeout_seconds=3601)
        too_long = self.path / "too-long.json"
        too_long.write_text(json.dumps({**cp.leaf_plan(self.leaves, passing), "timeout_seconds": 3601}))
        self.assertEqual(subprocess.run([sys.executable, "-B", str(self.bootstrap), "--plan", str(too_long)], capture_output=True,
                                        timeout=60).returncode, 125)
        self.assertEqual(cp.leaf_plan(self.leaves, passing, timeout_seconds=600)["unit"], passing)
        source = self.path / "source-manifest.json"
        source.write_bytes(b"{}\n")
        renamed = {"schema": 1, "unit": failing + "-output-2", "case": self.leaves[0]["case"], "scenario": "forward", "stage": "source",
                   "execution_kind": "fresh", "parent_manifest": None,
                   "source_manifest": {"path": str(source), "sha256": hashlib.sha256(b"{}\n").hexdigest()},
                   "output_root": str(self.path / "out-2"), "evidence_root": str(self.path / "evidence-2")}
        request = self.path / "renamed-request.json"
        request.write_text(json.dumps(renamed))
        self.assertRefused("REQUEST_INVALID", cp.load_request, str(request), self.leaves, case=self.leaves[0]["case"])
        self.assertRefused("REGISTRY_INVALID", cp.leaf_plan, self.leaves, failing + "-output-2")
        registered = dict(renamed, unit=failing)
        request.write_text(json.dumps(registered))
        loaded, digest = self.admitted(cp.load_request, str(request), self.leaves, case=self.leaves[0]["case"])
        self.assertEqual(loaded["unit"], failing)
        request.write_text(json.dumps({**registered, "source_manifest": {"path": str(source), "sha256": "0" * 64}}))
        self.assertRefused("REQUEST_INVALID", cp.load_request, str(request), self.leaves, case=self.leaves[0]["case"])
        request.write_text(json.dumps({**registered, "execution_kind": "checkpoint-resume"}))
        self.assertRefused("REQUEST_INVALID", cp.load_request, str(request), self.leaves, case=self.leaves[0]["case"])
        duplicate = self.leaves + [dict(self.leaves[0], unit="another-name")]
        self.assertRefused("REGISTRY_INVALID", cp.registry_valid, duplicate)


class CheckpointGateTests(RefusalAssertions, TempCase):
    def setUp(self):
        self.state = self.tempdir("kin-checkpoint-gate-")
        patcher = patch.object(gate, "STATE", self.state)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.facts = {"os": "linux", "docker_os": "Ubuntu 24.04 LTS", "daemon_ok": True, "daemon_identity": "DAEMON:SYNTHETIC",
                      "available_ram_bytes": 16 * 1024 ** 3, "available_disk_bytes": 100 * 1024 ** 3, "required_disk_bytes": 10 * 1024 ** 3,
                      "foreign_containers": [], "host_key_sha256": "8" * 64, "architecture": "x86_64",
                      "absolute_fixture_root": "/srv/checkpoints/fixture", "gate_state": str(self.state),
                      "docker_endpoint": "unix:///var/run/docker.sock", "endpoint_selectors": []}
        self.identity = dict(unit="release-tools-checkpoints-proof-prefix-seed", module=cp.LIVE_FILE, plan_sha256="a" * 64, attempt=1)

    def test_permission_slot_and_marker_precede_every_mutation(self):
        """T10 (RQC-07/RSK-07): process-local permission, one slot, marker kept until a real inspection."""
        target = target_fixture()
        backend = FakeBackend({role: target["containers"][role] for role in intro.ROLES})
        with self.assertRaises(gate.Refused):
            cp.stage_entry(gate, self.facts)
        with patch.dict(os.environ, {cp.OPT_IN_ENV: "1", cp.REQUEST_ENV: "/tmp/request.json"}):
            with self.assertRaises(gate.Refused):
                cp.stage_entry(gate, self.facts)
        self.assertEqual(backend.calls, [], "nothing reaches the daemon before the gate")
        with gate.live_run(**self.identity):
            self.assertTrue(self.admitted(cp.stage_entry, gate, self.facts)["admitted"])
            marker = cp.bind_marker(gate, {"unit": self.identity["unit"]})
            self.assertEqual((marker["unit"], marker["attempt"], marker["pid"]), (self.identity["unit"], 1, os.getpid()))
            self.assertRefused("REQUEST_INVALID", cp.bind_marker, gate, {"unit": "another-unit"})
            with self.assertRaises(gate.Refused):
                with gate.live_run(**self.identity):
                    self.fail("a second entry into the same slot")
            with self.subTest(io="checkpoint IO never touches the gate state"):
                before = sorted(path.name for path in self.state.iterdir())
                self.assertRefused("BUNDLE_INVALID", cp.BundleStore, self.state / "bundles", forbidden=[self.state])
                store = cp.BundleStore(self.tempdir() / "bundles", forbidden=[self.state])
                store.begin("held")
                self.assertEqual(sorted(path.name for path in self.state.iterdir()), before)
        marker_path = self.state / "live-needs-inspection.json"
        with self.assertRaisesRegex(RuntimeError, "synthetic"):
            with gate.live_run(**self.identity):
                cp.finish_segment(gate, passed=False, segment={"unit": self.identity["unit"]}, evidence_root=self.tempdir())
                raise RuntimeError("synthetic stage failure")
        self.assertTrue(marker_path.is_file(), "a failed segment keeps the marker")
        with self.assertRaises(gate.Refused):
            with gate.live_run(**{**self.identity, "unit": "another-unit"}):
                self.fail("a failed run's marker admits no other live run")
        self.assertRefused("INSPECTION_INCOMPLETE", cp.inspection_record, gate, exit_code=125, artifacts=["run.log"], stack={},
                           inspector="executor")
        record = self.tempdir() / "inspection.json"
        record.write_text(json.dumps(cp.inspection_record(gate, exit_code=125, artifacts=["run.log", "segment.json"],
                                                          stack={"remaining": [], "preserved": ["bundle"]}, inspector="executor")))
        stamp = max(time.time_ns(), marker_path.stat().st_mtime_ns + 1_000_000)
        os.utime(record, ns=(stamp, stamp))
        gate.release_after_inspection(record)
        self.assertFalse(marker_path.exists())
        self.assertEqual(len((self.state / "inspections.jsonl").read_text().splitlines()), 1)
        with gate.live_run(**{**self.identity, "attempt": 2}):
            self.assertTrue(cp.stage_entry(gate, self.facts)["admitted"])


class CheckpointTimeTests(RefusalAssertions, unittest.TestCase):
    def test_expiry_and_real_time_inputs_are_not_rewritten(self):
        """T11 (RQC-09/RSK-09): min(8 h, window end, TLS notAfter) with suffix and teardown; nothing rewritten."""
        now = datetime(2026, 10, 15, 6, 0, tzinfo=timezone.utc)
        base = {"created_utc": (now - timedelta(hours=1)).isoformat(), "window_end": (now + timedelta(hours=6)).isoformat(),
                "tls_not_after": (now + timedelta(days=29)).isoformat(), "suffix_seconds": 3600, "teardown_seconds": 600}
        original = copy.deepcopy(base)
        admitted = self.admitted(cp.time_admission, now=now, **base)
        self.assertEqual(admitted["deadline_utc"], (now + timedelta(hours=6)).isoformat())
        self.assertTrue(admitted["approval"].startswith("N/A"))
        self.assertEqual(base, original)
        for name, change in (("TTL", {"created_utc": (now - timedelta(hours=7, minutes=30)).isoformat()}),
                             ("window end", {"window_end": (now + timedelta(minutes=50)).isoformat()}),
                             ("TLS notAfter", {"tls_not_after": (now + timedelta(minutes=30)).isoformat()}),
                             ("teardown margin", {"window_end": (now + timedelta(seconds=4199)).isoformat()})):
            with self.subTest(expired=name):
                changed = {**base, **change}
                snapshot = copy.deepcopy(changed)
                self.assertRefused("EXPIRED", cp.time_admission, now=now, **changed)
                self.assertEqual(changed, snapshot, "no input is extended or rewritten")
        self.admitted(cp.time_admission, now=now, **{**base, "window_end": (now + timedelta(seconds=4200)).isoformat()})
        self.assertRefused("TIME_INVALID", cp.time_admission, now=now, **{**base, "created_utc": "2026-10-15T05:00:00"})
        self.assertRefused("CLOCK_INVALID", cp.time_admission, now=now, **{**base, "created_utc": (now + timedelta(seconds=1)).isoformat()})
        self.assertRefused("TIME_INVALID", cp.time_admission, now=now, **{**base, "suffix_seconds": 0})
        approval = {"expires_at": (now + timedelta(minutes=30)).isoformat()}
        self.assertRefused("EXPIRED", cp.time_admission, now=now, approval=approval, **base)
        self.assertEqual(approval, {"expires_at": (now + timedelta(minutes=30)).isoformat()})
        self.assertIn("valid until", self.admitted(cp.time_admission, now=now, approval={"expires_at": (now + timedelta(hours=2)).isoformat()},
                                                   **base)["approval"])
        restored = now.isoformat()
        self.assertTrue(cp.login_after_restore(int(now.timestamp()) + 5, restored))
        self.assertRefused("LOGIN_REQUIRED", cp.login_after_restore, int(now.timestamp()) - 60, restored)
        self.assertRefused("LOGIN_REQUIRED", cp.login_after_restore, None, restored)
        self.assertEqual((intro.RECEIPT_MAX_AGE, intro.CLOCK_SKEW), (timedelta(days=7), timedelta(minutes=5)))


class CheckpointCleanupTests(RefusalAssertions, TempCase):
    def test_only_owned_resources_are_removed_and_absence_is_observed(self):
        """T12 (RQC-08/RSK-08): exact labels or IDs, never a name prefix; re-query decides completeness."""
        target = target_fixture()
        names = {role: target["containers"][role] for role in intro.ROLES}
        foreign = [{"kind": "containers", "name": PROJECT + "-db-foreign", "labels": {}},
                   {"kind": "containers", "name": "kin-other-api", "labels": {"kin.ops.run": "another-token"}},
                   {"kind": "volumes", "name": PROJECT + "_pg-db-copy", "labels": {"com.docker.compose.project": PROJECT + "x"}},
                   {"kind": "networks", "name": PROJECT + "-halo-shared", "labels": {}}]
        owned = {"token": TOKEN, "projects": {PROJECT}}
        backend = FakeBackend(names, target["volumes"], foreign=foreign)
        backend.networks[PROJECT + "-halo"] = {"id": "id-halo", "name": PROJECT + "-halo", "labels": {"kin.ops.run": TOKEN}}
        result = cp.cleanup_owned(backend, owned)
        self.assertTrue(result["complete"], result)
        left = {name for kind in ("containers", "volumes", "networks") for name in getattr(backend, kind)}
        self.assertEqual(left, {item["name"] for item in foreign})
        backend = FakeBackend(names, target["volumes"])
        backend.sticky.add(names["api"])
        result = cp.cleanup_owned(backend, owned)
        self.assertFalse(result["complete"])
        self.assertEqual(result["remaining"], [names["api"]])
        backend = FakeBackend(names, target["volumes"])
        backend.fail_inventory = True
        self.assertFalse(cp.cleanup_owned(backend, owned)["complete"])
        with self.subTest(images="CKPT-09: only this run's exact aliases; never the shared image or another tag"):
            api, proxy = PROJECT + "-api:latest", PROJECT + "-proxy:latest"
            tagged = {**owned, "tags": [api, proxy]}
            backend = FakeBackend(names, target["volumes"])
            backend.image_tags = {image("1"): {"kin-api:ci", api}, image("2"): {"kin-proxy:ci", proxy},
                                  image("e"): {"other-project-api:latest", PROJECT + "x-api:latest"}}
            self.assertEqual([name for name in cp.owned_remaining(backend.inventory(), tagged) if ":" in name], [api, proxy])
            result = cp.cleanup_owned(backend, tagged)
            self.assertTrue(result["complete"], result)
            self.assertEqual(backend.image_tags, {image("1"): {"kin-api:ci"}, image("2"): {"kin-proxy:ci"},
                                                  image("e"): {"other-project-api:latest", PROJECT + "x-api:latest"}})
            backend = FakeBackend(names, target["volumes"])
            backend.image_tags = {image("1"): {"kin-api:ci", api}, image("2"): {proxy}}
            result = cp.cleanup_owned(backend, tagged)
            self.assertFalse(result["complete"], "the last name of a shared image is kept and reported")
            self.assertEqual(result["remaining"], [proxy])
            self.assertTrue(any("last name" in error for error in result["errors"]), result)
            self.assertEqual(backend.image_tags[image("2")], {proxy}, "the shared image and its only tag stay")
            self.assertNotIn(("remove", "tags", proxy), backend.calls)
        with self.subTest(images="CKPT2-05: two owned aliases are the image's only names"):
            alias = PROJECT + "-api:rehearsal"
            both = {**owned, "tags": [api, alias]}
            backend = FakeBackend(names, target["volumes"])
            backend.image_tags = {image("1"): {api, alias}}
            result = cp.cleanup_owned(backend, both)
            self.assertIn(image("1"), backend.image_tags, "the image ID stays")
            self.assertEqual(len(backend.image_tags[image("1")]), 1, "its last owned alias stays")
            self.assertFalse(result["complete"], result)
            self.assertEqual(result["remaining"], sorted(backend.image_tags[image("1")]), "the kept alias is reported as remaining")
            self.assertTrue(any("last name" in error for error in result["errors"]), result)
            self.assertFalse([error for error in result["errors"] if error.startswith("image removed")], result)
            backend = FakeBackend(names, target["volumes"])
            backend.image_tags = {image("1"): {api, alias, "kin-api:ci"}}
            result = cp.cleanup_owned(backend, both)
            self.assertTrue(result["complete"], result)
            self.assertEqual(backend.image_tags, {image("1"): {"kin-api:ci"}}, "only the owned aliases go; the image and the foreign name stay")
        root = self.tempdir()
        (root / "fixture").mkdir()
        self.assertEqual(self.admitted(cp.remove_private_root, root / "fixture", owner_root=root)["removed"], str(root / "fixture"))
        self.assertFalse((root / "fixture").exists())
        outside = self.tempdir()
        self.assertRefused("NOT_OWNED", cp.remove_private_root, outside, owner_root=root)
        self.assertRefused("NOT_OWNED", cp.remove_private_root, root, owner_root=root)
        self.assertRefused("NOT_OWNED", cp.remove_private_root, root / ".." / outside.name, owner_root=root)
        self.assertTrue(outside.exists())
        store = cp.BundleStore(self.tempdir() / "bundles")
        final = seal(self, store.root, "held")
        self.assertRefused("NOT_OWNED", cp.discard_bundle, store, final.name, reason="expired")
        self.assertTrue(final.exists(), "expiry never deletes a bundle")
        cp.discard_bundle(store, final.name, reason="completed")
        self.assertFalse(final.exists())


class CheckpointPlatformTests(RefusalAssertions, unittest.TestCase):
    def test_native_linux_host_is_required_and_d1034_is_measured(self):
        """T13 (RQC-07/10): Windows, Desktop, other host/daemon/root/arch, RAM/disk, foreign containers, daemon failure."""
        facts = {"os": "linux", "docker_os": "Ubuntu 24.04 LTS", "daemon_ok": True, "daemon_identity": "DAEMON:A",
                 "available_ram_bytes": 12 * 1024 ** 3, "available_disk_bytes": 50 * 1024 ** 3, "required_disk_bytes": 20 * 1024 ** 3,
                 "foreign_containers": [], "host_key_sha256": "8" * 64, "architecture": "x86_64",
                 "absolute_fixture_root": "/srv/checkpoints/fixture", "is_root": True, "systemd": True,
                 "docker_endpoint": "unix:///var/run/docker.sock", "endpoint_selectors": []}
        expected = {key: facts[key] for key in ("host_key_sha256", "daemon_identity", "architecture", "absolute_fixture_root")}
        self.assertTrue(self.admitted(cp.host_admission, facts, expected)["admitted"])
        for name, change, code in (
                ("Windows", {"os": "nt"}, "UNSUPPORTED_HOST"), ("Docker Desktop", {"docker_os": "Docker Desktop"}, "UNSUPPORTED_HOST"),
                ("unknown daemon OS", {"docker_os": ""}, "UNSUPPORTED_HOST"), ("daemon query failed", {"daemon_ok": False}, "DAEMON_UNAVAILABLE"),
                ("RAM below 10 GiB", {"available_ram_bytes": 10 * 1024 ** 3 - 1}, "INSUFFICIENT_RAM"),
                ("disk", {"available_disk_bytes": 1024 ** 3}, "INSUFFICIENT_DISK"),
                ("a foreign running container", {"foreign_containers": ["kin-db"]}, "FOREIGN_RESOURCES"),
                ("a foreign stopped container", {"foreign_containers": ["kin-rehearsal-old-proxy (exited)"]}, "FOREIGN_RESOURCES"),
                ("no host identity (root/systemd alone)", {"host_key_sha256": None}, "HOST_REFUSED"),
                ("another host", {"host_key_sha256": "9" * 64}, "HOST_MISMATCH"),
                ("another daemon", {"daemon_identity": "DAEMON:B"}, "HOST_MISMATCH"),
                ("another architecture", {"architecture": "aarch64"}, "HOST_MISMATCH"),
                ("another root", {"absolute_fixture_root": "/srv/other"}, "HOST_MISMATCH"),
                ("a remote context", {"docker_endpoint": "tcp://10.0.0.5:2376"}, "REMOTE_DAEMON"),
                ("an unobserved context", {"docker_endpoint": None}, "REMOTE_DAEMON"),
                ("DOCKER_HOST in the environment", {"endpoint_selectors": ["DOCKER_HOST"]}, "REMOTE_DAEMON"),
                ("unobserved selectors", {"endpoint_selectors": None}, "REMOTE_DAEMON")):
            with self.subTest(refused=name):
                self.assertRefused(code, cp.host_admission, {**facts, **change}, expected)
        with self.subTest(refused="no live permission in this process"):
            with self.assertRaises(gate.Refused):
                cp.host_admission(facts, expected, gate=gate)


class CheckpointRecordTests(RefusalAssertions, TempCase):
    """T14 / CKPT-02 / CKPT2-01 / CKPT2-03: the real scripts/record-run.py around a synthetic leaf command in a real proof
    layout; the evidence index derives every expectation from that layout (registry, plan, request, source and parent
    manifests) and reads the raw evidence the segment describes: the raw product records (plan, state, journal, results,
    command records, logs) written as the product writes them, the sealed checkpoint's manifest and a fork's admission.
    A consumer (parent request, T16 comparison) re-checks every bound byte."""

    UNIT = "release-tools-checkpoints-proof-prefix-seed"
    GOOD_VERDICT = {"status": "DEPLOYED", "release_images": {"api": image("6")}, "health": {"ok": True}, "migrations_after": True,
                    "smoke_member_absent": True, "ordinary_entry_side": "release", "ordinary_entry_images": True, "frame_sha256": "f" * 64}
    COMMAND = textwrap.dedent("""\
        import hashlib, json, sys
        from pathlib import Path
        spec = json.loads(Path(sys.argv[1]).read_text())
        mode, run_dir = spec["mode"], Path(sys.argv[2])
        print("EXACT_TESTS " + json.dumps(spec["tests"] if mode != "selection" else ["other.Case.test_x"]))
        if mode == "change-input":
            Path("tests/ops_release_checkpoints.py").write_text("# changed during the run\\n")
        if spec.get("verdict"):
            print(json.dumps({"forward_verdict": spec["verdict"]}))
        segment = dict(spec["segment"], run_json=str(run_dir / "run.json"))
        segment.update(spec.get("changes") or {})
        path = Path(spec["segment_path"])
        path.parent.mkdir(parents=True, exist_ok=True)
        raw = (json.dumps(segment, sort_keys=True, separators=(",", ":")) + "\\n").encode()
        path.write_bytes(raw)
        print(json.dumps({"segment": str(path), "sha256": hashlib.sha256(raw).hexdigest()}))
        print("PLAN_RESULT " + json.dumps({"status": "failed" if mode == "exit" else "passed", "exit_code": 1 if mode == "exit" else 0}))
        sys.exit(1 if mode == "exit" else 0)
        """)

    def layout(self, unit=None, *, root=None, attempt=1, alter=None):
        """A proof root as `commands` lays it out for one attempt of one leaf: registry, plan, the leaf's source copy and
        manifest, a sealed parent manifest in the shared store, the request; the raw records the product run leaves in
        the attempt's evidence root (per stack: plan.json, state.json with the history rows, journal.jsonl, one result,
        command record and step log per phase of the fixed leaf contract), the sealed checkpoint and a fork's admission;
        and the segment that describes exactly those bytes. `alter(kind, value, stack)` changes one generated value
        before it is written and described ("result", "state", "plan", "files", "current", "manifest", "admission"), so
        the segment stays consistent with the altered raw bytes and only the raw contract can refuse them."""
        unit = unit or self.UNIT
        alter = alter or (lambda kind, value, stack=None: value)
        root = root or self.tempdir("kin-proof-")
        leaves = [dict(leaf) for leaf in cp.DEFAULT_PROOF_LEAVES]
        if not (root / "registry.json").exists():
            (root / "registry.json").write_bytes(cp.canonical(leaves) + b"\n")
        leaf = cp.registry_leaf(leaves, unit)
        (root / ("plan-" + unit + ".json")).write_bytes(cp.canonical(cp.leaf_plan(leaves, unit)) + b"\n")
        copy_root = root / leaf["source"]
        for name in cp.LEAF_INPUT_FILES + ("scripts/tool.py",):
            (copy_root / name).parent.mkdir(parents=True, exist_ok=True)
            if not (copy_root / name).exists():
                (copy_root / name).write_bytes(("# " + name + "\n").encode())
        inputs = {"tool": "1" * 64, "source": "2" * 64, "harness": "3" * 64, "tool_files": {}}
        source = {"schema": 1, "kind": "release-tools-source", "root": str(copy_root), "tool": {"sha256": "1" * 64},
                  "source": {"sha256": "2" * 64}, "harness": {"sha256": "3" * 64}, "tool_files": {}}
        source_path = root / (leaf["source"] + ".source-manifest.json")
        source_path.write_bytes(cp.canonical(source) + b"\n")
        parent_sha = parent_state = None
        if leaf["parent"]:
            consumes = cp.STAGES[leaf["stage"]]["consumes"]
            # The state the parent bundle binds: a restore observes exactly these bytes (r5).
            parent_state = intro.canonical({"plan_sha256": "f" * 64, "status": cp.CHECKPOINTS[consumes]["status"], "history": []}) + b"\n"
            parent_raw = cp.canonical({"checkpoint": consumes, "kind": "release-tools-checkpoint", "lineage": cp.CHECKPOINTS[consumes]["lineage"],
                                       "bindings": {"state": {"path": cp.LINEAGE_STACK[consumes] + "/records/state.json",
                                                              "sha256": hashlib.sha256(parent_state).hexdigest()}}}) + b"\n"
            parent_sha = hashlib.sha256(parent_raw).hexdigest()
            parent_path = root / "out" / "bundles" / parent_sha / "manifest.json"
            parent_path.parent.mkdir(parents=True, exist_ok=True)
            parent_path.write_bytes(parent_raw)
        paths = cp.attempt_paths(root, unit, attempt)
        evidence = paths["evidence"]
        if leaf["stage"] is not None:
            request = {"schema": 1, "unit": unit, "case": leaf["case"], "scenario": leaf["scenario"], "stage": leaf["stage"],
                       "execution_kind": leaf["execution_kind"],
                       "parent_manifest": {"path": str(parent_path), "sha256": parent_sha} if parent_sha else None,
                       "source_manifest": {"path": str(source_path), "sha256": hashlib.sha256(source_path.read_bytes()).hexdigest()},
                       "output_root": str(root / "out"), "evidence_root": str(evidence)}
            paths["request"].write_bytes(cp.canonical(request) + b"\n")
        expectation = cp.leaf_expectation(leaves, unit, root, attempt)
        expect = expectation["expect"]
        plans, executing, sealed = {}, None, None
        for stack in sorted({row["stack"] for row in expect["results"]}):
            records = evidence / ("records-" + stack)
            (records / "logs").mkdir(parents=True)
            plan = plan_fixture(root=root / stack)
            plans[stack] = intro.plan_identity(plan)
            history, journal = [], []
            for index, row in enumerate(item for item in expect["results"] if item["stack"] == stack):
                request_sha = hashlib.sha256(("%s-%s-%d" % (stack, row["phase"], index)).encode()).hexdigest()
                commands = "commands-" + row["phase"] + "-" + request_sha[:16] + ".jsonl"
                log_raw = ("synthetic log of " + stack + " " + row["phase"] + "\n").encode()
                log = {"file": "logs/" + row["phase"] + "-" + request_sha[:8] + ".out", "sha256": hashlib.sha256(log_raw).hexdigest(),
                       "bytes": len(log_raw)}
                (records / log["file"]).write_bytes(log_raw)
                failure_raw = b"synthetic stderr\n"
                failure = {"file": "logs/failed-" + request_sha[:8] + ".err", "sha256": hashlib.sha256(failure_raw).hexdigest()}
                (records / failure["file"]).write_bytes(failure_raw)
                (records / commands).write_bytes(intro.canonical({"seq": 1, "step": row["steps"][0][0], "exit": 0, "failure_log": failure}) + b"\n")
                steps = [{"step": sid, "outcome": outcome, "seconds": 0.5,
                          "commands": {"file": commands, "first": 1 if position == 0 else 2, "last": 1},
                          **({"detail": {"log": log}} if position == 0 else {})} for position, (sid, outcome) in enumerate(row["steps"])]
                result = alter("result", {"steps": steps, "status": row["status"], "phase": row["phase"], "request_sha256": request_sha,
                                          "plan_sha256": plans[stack], "commands_file": commands}, stack)
                result_raw = intro.canonical(result) + b"\n"
                (records / ("result-" + row["phase"] + "-" + request_sha[:16] + ".json")).write_bytes(result_raw)
                history.append({"phase": result["phase"], "status": "PASS" if result["status"] == intro.DONE.get(result["phase"])
                                and all(step["outcome"] == "PASS" for step in result["steps"]) else result["status"],
                                "request_sha256": request_sha, "seconds": 1.0, "result_sha256": hashlib.sha256(result_raw).hexdigest(),
                                "steps": [[step["step"], step["outcome"]] for step in result["steps"]]})
                journal.append({"event": "phase-end", "phase": row["phase"], "status": result["status"]})
            # r7: the side the boundary's pinned images come from is part of S (layer_valid picks the pins by it).
            state = alter("state", {"plan_sha256": plans[stack], "status": history[-1]["status"], "history": history, "checkout": "previous",
                                    "entry_checkout": "previous"}, stack)
            (records / "state.json").write_bytes(intro.canonical(state) + b"\n")
            (records / "journal.jsonl").write_bytes(b"".join(intro.canonical(entry) + b"\n" for entry in journal))
            plan_raw = alter("plan", intro.canonical(plan) + b"\n", stack)
            if plan_raw is not None:
                (records / "plan.json").write_bytes(plan_raw)
            # r5: the restore observation of the consumed checkpoint and the capture observation of the sealed one, as the
            # leaf's preserved records carry them.
            target = target_fixture(root)
            consumed = expect["consumes"]
            if (consumed and cp.CHECKPOINTS[consumed]["volumes"] and cp.LINEAGE_STACK[consumed] == stack
                    and expect["outcome"]["outcome"] != "REFUSED"):
                write_observation(records, consumed, "restore", plan=plan, target=target, state_raw=parent_state, parent=parent_sha)
            if expect["produces"] and cp.LINEAGE_STACK[expect["produces"]] == stack:
                folder = None
                if cp.CHECKPOINTS[expect["produces"]]["volumes"]:
                    folder = write_observation(records, expect["produces"], "capture", plan=plan, target=target,
                                               state_raw=(records / "state.json").read_bytes())
                # r7: the checkpoint this leaf sealed is a real bundle of the request's store, made from these records.
                sealed = self.seal_leaf(root, expect["produces"], stack=stack, records=records, plan=plan, target=target, observation=folder,
                                        parent_sha=parent_sha, execution_kind=leaf["execution_kind"])
            alter("files", records, stack)
            executing = executing or plans[stack]
        raw_rows = sorted([path.relative_to(evidence).as_posix(), hashlib.sha256(path.read_bytes()).hexdigest()]
                          for path in sorted(evidence.glob("records-*/**/*")) if path.is_file())
        phase_rows = cp.phase_results({stack: evidence / ("records-" + stack) for stack in plans})
        results, admission = {}, None
        if expect["produces"]:
            manifest = json.loads((sealed / "manifest.json").read_bytes())
            altered = alter("manifest", copy.deepcopy(manifest))
            folder = sealed
            if altered != manifest:
                # A manifest changed after the seal: another bundle name over the same payload.
                manifest_raw = cp.canonical(altered) + b"\n"
                folder = root / "out" / "bundles" / hashlib.sha256(manifest_raw).hexdigest()
                shutil.copytree(sealed / "payload", folder / "payload")
                (folder / "manifest.json").write_bytes(manifest_raw)
            results["checkpoint"] = {"path": str(folder), "manifest_sha256": folder.name}
        if expect["admission"]:
            admission = alter("admission", {"schema": 1, "kind": "checkpoint-admission", "checkpoint": expect["consumes"],
                                            "execution_kind": "diagnostic-fork", "fresh_e2e": False, "release_gate_eligible": False,
                                            "changed_bodies": ["HostOps.fenced_smoke"], "earliest_phase": "verify",
                                            "suffix_phases": ["verify", "reopen"], "parent_manifest_sha256": parent_sha})
            evidence.mkdir(parents=True, exist_ok=True)
            (evidence / "admission.json").write_bytes(cp.canonical(admission) + b"\n")
        now = datetime.now(timezone.utc).isoformat()
        marker = {"unit": unit, "module": leaf["file"], "plan_sha256": expect["marker_plan_sha256"], "attempt": attempt, "pid": 4242,
                  "started_at": now}
        kind = leaf["execution_kind"]
        current = alter("current", cp.current_identity(
            inputs, execution_kind=kind, plan_sha256=executing if leaf["stage"] is not None else None, root=copy_root,
            resumed_utc=None if kind == "fresh" else now,
            admission_sha256=hashlib.sha256(cp.canonical(admission)).hexdigest() if admission else None))
        identity = {"parent": identity_fixture(phase_reached=expect["consumes"]) if parent_sha else None, "current": current,
                    "parent_reference": {"manifest_sha256": parent_sha, "payload_manifest_sha256": "0" * 64, "checkpoint": expect["consumes"],
                                         "lineage": cp.CHECKPOINTS[expect["consumes"]]["lineage"]} if parent_sha else None}
        segment = cp.segment_record(
            request={key: leaf[key] for key in ("unit", "case", "stage", "scenario", "execution_kind")}, request_sha256=expect["request_sha256"],
            marker=marker, identity=identity, executed_phases=expect["executed"], inherited_phases=expect["inherited"], results=results,
            admission=admission, cleanup={"complete": True, "removed": ["x"], "remaining": [], "errors": []}, run_json="(the command sets it)",
            started_utc=now, ended_utc=now, selected_tests=[leaf["case"]], phase_results=phase_rows, raw_records=raw_rows, inputs_before=inputs,
            inputs_after=inputs,
            parent_chain=[{"manifest_sha256": parent_sha, "checkpoint": expect["consumes"], "execution_kind": "fresh",
                           "payload_manifest_sha256": "0" * 64}] if parent_sha else [])
        segment.update(observed=expect["outcome"], expected=expect["outcome"], passed=True)
        command = root / "command.py"
        command.write_text(self.COMMAND, encoding="utf-8")
        return SimpleNamespace(root=root, leaves=leaves, expectation=expectation, segment=segment, copy_root=copy_root, command=command,
                               unit=unit, attempt=attempt, evidence=evidence, plans=plans, results=results)

    def seal_leaf(self, root, checkpoint_id, *, stack, records, plan, target, observation, parent_sha, execution_kind):
        """r7: the checkpoint a leaf sealed, as a real bundle in <root>/out/bundles that load_bundle accepts, made from the
        leaf's own records: its state S and last result, and at a volume checkpoint its capture observation, the boundary
        facts of the same containers and the writable-layer record (written beside the observation and kept in the leaf's
        records, as seal_boundary leaves them). Returns the bundle folder."""
        spec = cp.CHECKPOINTS[checkpoint_id]
        fixture = self.tempdir("kin-leaf-fixture-")
        own = fixture / stack / "records"
        own.mkdir(parents=True)
        state_raw = (records / "state.json").read_bytes()
        state = json.loads(state_raw)
        last = (state.get("history") or [{}])[-1]
        result = records / ("result-" + str(last.get("phase")) + "-" + str(last.get("request_sha256"))[:16] + ".json")
        names = {role: target["containers"][role] for role in intro.ROLES}
        context = {"previous_sha": "a" * 40, "target_sha": "b" * 40,
                   "images": {"previous": dict(plan["previous"]["images"]), "release": dict(plan["release"]["images"])}, "legacy": None,
                   "members": plan["members"], "b0": None, "copy_dir": None, "production_plan": None,
                   "stacks": {stack: {"label": stack, "root": str(fixture / stack), "plan_document": plan, "plan_sha256": intro.plan_identity(plan),
                                      "target": target_fixture(root / stack)}}}   # the plan's own target (the same names)
        files = {"state": (stack + "/records/state.json", state_raw),
                 "result": (stack + "/records/" + result.name, result.read_bytes() if result.is_file() else b"{}\n"),
                 "secrets": (stack + "/records.secrets/compose-env-values.json", b"{}\n"),
                 "compose_entry": (stack + "/compose-entries/active.json", b'{"generation":"1","sha256":"2"}\n'),
                 "ledger": (stack + "/backups/audit-ledger.json", b'{"entries":[]}\n'), "context": (cp.CONTEXT_FILE, cp.canonical(context) + b"\n")}
        if spec["lock"]:
            files["lock"] = (stack + "/repo/.kin-ops.lock", str(state.get("lock_token") or "").encode())
        bindings = {}
        for name, (rel, value) in files.items():
            (fixture / rel).parent.mkdir(parents=True, exist_ok=True)
            (fixture / rel).write_bytes(value)
            bindings[name] = {"path": rel, "sha256": hashlib.sha256(value).hexdigest()}
        boundary = {"checkpoint": checkpoint_id, "status": spec["status"], "boundary": spec["boundary"],
                    "window_end": plan["window"]["end"], "tls_not_after": plan["window"]["end"]}
        if observation is not None:
            copied = own / cp.OBSERVATION_DIR / observation.name
            shutil.copytree(observation, copied)
            bindings["observation"] = {"path": (copied / cp.OBSERVATION_RESULT).relative_to(fixture).as_posix(),
                                       "sha256": hashlib.sha256((copied / cp.OBSERVATION_RESULT).read_bytes()).hexdigest()}
            boundary["facts"] = boundary_facts_of(json.loads((copied / "snapshot.json").read_bytes()))
            bindings["layer"], _ = cp.write_layer(fixture, bindings, fixture_roles(target, cp.pinned_images(plan, state)), checkpoint_id=checkpoint_id,
                                                  summary=json.loads((copied / cp.OBSERVATION_RESULT).read_bytes()),
                                                  descriptor_raw=(copied / cp.REGENERATED_FILE).read_bytes())
            kept = records / bindings["layer"]["path"].split("/records/", 1)[1]
            kept.parent.mkdir()
            kept.write_bytes((fixture / bindings["layer"]["path"]).read_bytes())
        store = cp.BundleStore(root / "out" / "bundles", forbidden=[fixture])
        pending = store.begin(checkpoint_id)
        if spec["volumes"]:
            for category in cp.VOLUME_CATEGORIES:
                pending.declare_absent(category)
        tree = pending.directory / "export-fixture.tar"
        cp.write_tree_archive(fixture, tree)
        pending.add("fixture-tree.tar", "fixture-tree", tree)
        tree.unlink()
        identity = identity_fixture(phase_reached=checkpoint_id, plan_sha256=intro.plan_identity(plan),
                                    target_manifest_sha256=plan["target_manifest_sha256"], tool_files_actual_raw_sha256=dict(plan["tool"]),
                                    image_ids={"previous": dict(plan["previous"]["images"]), "release": dict(plan["release"]["images"]),
                                               "helper": image("3")}, absolute_fixture_root=str(fixture))
        parent = {"manifest_sha256": parent_sha, "payload_manifest_sha256": "0" * 64,
                  "checkpoint": cp.STAGES[next(name for name, item in cp.STAGES.items() if item["produces"] == checkpoint_id)]["consumes"]} \
            if parent_sha else None
        return pending.seal(identity=identity, boundary=boundary, bindings=bindings,
                            owned={"token": TOKEN, "projects": [PROJECT], "volumes": {}, "networks": [],
                                   "stack": {"root": str(fixture / stack), "containers": names}},
                            execution_kind=execution_kind, parent=parent)

    def record(self, proof, mode="ok", *, changes=None, files=None, verdict=None):
        spec = proof.root / ("spec-" + proof.unit + "-" + str(proof.attempt) + ".json")
        forward = proof.expectation["expect"]["forward_verdict"]
        spec.write_text(json.dumps({"mode": mode, "tests": proof.expectation["expected_tests"], "segment": proof.segment,
                                    "segment_path": str(proof.expectation["segment_path"]), "changes": changes,
                                    "verdict": (verdict or self.GOOD_VERDICT) if forward else None}), encoding="utf-8")
        run_dir = proof.expectation["run_dir"]
        declared = proof.expectation["required_files"] if files is None else files
        completed = subprocess.run([sys.executable, "-B", str(RECORDER), "--run-dir", str(run_dir), "--cwd", str(proof.copy_root),
                                    *[item for name in declared for item in ("--file", name)], "--tree", "scripts", "--",
                                    sys.executable, "-B", str(proof.command), str(spec), str(run_dir)], capture_output=True, timeout=120)
        return run_dir, completed

    def verdict(self, proof, **kwargs):
        run_dir, _ = self.record(proof, **kwargs)
        return cp.leaf_index(proof.leaves, proof.unit, proof.root, run_dir, proof.attempt)

    def test_existing_record_run_binds_exact_inputs_outputs_and_exit(self):
        """T14 (RQC-03/05/06/11, CKPT-02): the real recorder; AND of run.json, every recorded input before/after, the
        leaf's complete required inputs, logs, exact selection, the runner's result, the announced segment and its claims."""
        proof = self.layout()
        run_dir, completed = self.record(proof)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        bound = cp.leaf_index(proof.leaves, self.UNIT, proof.root, run_dir)
        self.assertEqual(bound["verdict"], "BOUND", bound["reasons"])
        self.assertEqual(bound["run_json_sha256"], hashlib.sha256((run_dir / "run.json").read_bytes()).hexdigest())
        self.assertEqual(bound["segment_sha256"], hashlib.sha256(proof.expectation["segment_path"].read_bytes()).hexdigest())
        self.assertNotIn("segment_sha256", json.loads(proof.expectation["segment_path"].read_bytes()), "no circular hash")
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(cp.main(["index", "--registry", str(proof.root / "registry.json"), "--unit", self.UNIT,
                                      "--proof-root", str(proof.root), "--run-dir", str(run_dir)]), 0)
            self.assertEqual(json.loads((proof.root / "index" / (self.UNIT + ".json")).read_bytes())["verdict"], "BOUND")
            self.assertEqual(cp.main(["index", "--registry", str(proof.root / "registry.json"), "--unit", self.UNIT,
                                      "--proof-root", str(proof.root), "--run-dir", str(run_dir)]), 2, "an index is written once")
        again = subprocess.run([sys.executable, "-B", str(RECORDER), "--run-dir", str(run_dir), "--cwd", str(proof.copy_root), "--",
                                sys.executable, "-c", "print(1)"], capture_output=True, timeout=60)
        self.assertEqual(again.returncode, 125, "a run directory is never reused")
        parent = str(proof.root / "out" / "bundles")
        cases = {
            "a declared input changed during the run": dict(mode="change-input"),
            "a failed exit": dict(mode="exit"),
            "another selection": dict(mode="selection"),
            "a shrunk --file list (the parent manifest undeclared)": dict(files=[name for name in proof.expectation["required_files"]
                                                                               if not name.startswith(parent)]),
            "a missing identity": dict(changes={"identity": None}),
            "the parent identity reported as the resume": dict(changes={"identity": {**proof.segment["identity"],
                                                                                   "current": {**proof.segment["identity"]["current"], "resumed_utc": None}}}),
            "no phase results": dict(changes={"phase_results": []}),
            "no raw records": dict(changes={"raw_records": []}),
            "another case": dict(changes={"case": "CheckpointSegments.test_capture_checkpoint"}),
            "a failed segment": dict(changes={"passed": False}),
            "an incomplete cleanup": dict(changes={"cleanup": {"complete": False, "removed": [], "remaining": ["x"], "errors": []}}),
            "another marker plan": dict(changes={"marker": {**proof.segment["marker"], "plan_sha256": "0" * 64}}),
            "changed inputs": dict(changes={"inputs_after": {**proof.segment["inputs_after"], "tool": "9" * 64}}),
            "no sealed checkpoint": dict(changes={"results": {}}),
            "another parent chain": dict(changes={"parent_chain": []}),
        }
        for name, kwargs in cases.items():
            with self.subTest(refused=name):
                verdict = self.verdict(self.layout(), **kwargs)
                self.assertEqual(verdict["verdict"], "UNVERIFIED", name)
                self.assertTrue(verdict["reasons"])
        with self.subTest(refused="the segment edited after the run announced it"):
            proof = self.layout()
            run_dir, _ = self.record(proof)
            path = proof.expectation["segment_path"]
            # A semantically neutral edit: only the announced hash can reveal it.
            path.write_bytes(path.read_bytes().replace(b'"ended_utc":"', b'"ended_utc":"0'))
            verdict = cp.leaf_index(proof.leaves, self.UNIT, proof.root, run_dir)
            self.assertEqual(verdict["verdict"], "UNVERIFIED")
            self.assertIn("the segment differs from the one the run announced", verdict["reasons"])
        with self.subTest(refused="stderr tampered after recording"):
            proof = self.layout()
            run_dir, _ = self.record(proof)
            with open(run_dir / "stderr.log", "ab") as stream:
                stream.write(b"appended later\n")
            self.assertEqual(cp.leaf_index(proof.leaves, self.UNIT, proof.root, run_dir)["verdict"], "UNVERIFIED")
        with self.subTest(refused="no run.json"):
            proof = self.layout()
            self.assertEqual(cp.leaf_index(proof.leaves, self.UNIT, proof.root)["verdict"], "UNVERIFIED")
        with self.subTest(refused="another attempt's run folder"):
            proof = self.layout()
            self.assertRefused("INDEX_INPUT", cp.leaf_index, proof.leaves, self.UNIT, proof.root, self.tempdir())
        with self.subTest(refused="a plan that is not the leaf's registered plan"):
            proof = self.layout()
            (proof.root / ("plan-" + self.UNIT + ".json")).write_bytes(
                cp.canonical(cp.leaf_plan(proof.leaves, self.UNIT, timeout_seconds=600)) + b"\n")
            self.assertRefused("INDEX_INPUT", cp.leaf_expectation, proof.leaves, self.UNIT, proof.root)

    def test_raw_evidence_is_bound_not_only_the_segment_claims(self):
        """CKPT2-01 (consult round3_acceptance): the index reads the raw records, results, plans, command records, logs,
        the sealed checkpoint and a fork's admission themselves. The normal controls of a stage leaf, a fork, the expected
        late STOP, the fresh control (source and clone plans apart) and the refusal proof (no phase, no plan) are BOUND;
        a missing, changed or unlisted raw file, a failure hidden behind passed=true, a missing executed plan, a result
        under another plan, a missing referenced log or command record, and a missing or foreign checkpoint or admission
        are UNVERIFIED."""
        late = "release-tools-checkpoints-proof-late-fault"
        fork = "release-tools-checkpoints-proof-late-resume"
        fresh = "release-tools-checkpoints-proof-fresh-control"
        refusal = "release-tools-checkpoints-proof-early-refusal"
        for unit in (self.UNIT, late, fork, fresh, refusal):
            with self.subTest(bound=unit):
                proof = self.layout(unit)
                verdict = self.verdict(proof)
                self.assertEqual(verdict["verdict"], "BOUND", verdict["reasons"])
                self.assertEqual(sorted(verdict["raw"]["plans"]), sorted({row["stack"] for row in proof.expectation["expect"]["results"]}))
                self.assertEqual({rel for rel, _ in verdict["raw"]["files"]},
                                 {path.relative_to(proof.evidence).as_posix() for path in proof.evidence.glob("records-*/**/*") if path.is_file()})
        proof = self.layout(fresh)
        self.assertEqual(sorted(proof.plans), ["clone", "source"])
        self.assertNotEqual(proof.plans["source"], proof.plans["clone"], "the fresh control binds the source and clone plans apart")
        self.assertEqual([row["stack"] for row in cp.expected_results(cp.registry_leaf(proof.leaves, fresh))],
                         ["source", "clone", "clone", "clone", "clone", "clone"])
        self.assertEqual([(row["phase"], row["status"], row["steps"]) for row in cp.expected_results(cp.registry_leaf(proof.leaves, late))],
                         [("reopen", "VERIFIED", [["L-11a", "STOP"]])])

        def after_run(change):
            """Changed after the run (the segment still names the old bytes)."""
            def apply(proof):
                change(proof)
                return proof
            return apply

        def failed(kind, value, stack=None):
            if kind == "result":
                value.update(status="FAILED", steps=[{**value["steps"][0], "outcome": "STOP"}])
            return value

        def other_plan(kind, value, stack=None):
            if kind == "result":
                value["plan_sha256"] = "e" * 64
            return value

        def status_only(kind, value, stack=None):
            if kind == "state":
                value["history"][-1]["status"] = "PASS"
                value["history"][-1]["steps"] = [[sid, "PASS"] for sid, _, _, _ in intro.STEPS[value["history"][-1]["phase"]]]
            return value

        def no_plan(kind, value, stack=None):
            return None if kind == "plan" else value

        def no_executed_plan(kind, value, stack=None):
            return {**value, "plan_sha256": None} if kind == "current" else value

        def without(name):
            def change(kind, value, stack=None):
                if kind == "files":
                    for path in sorted(value.rglob(name)):
                        path.unlink()
                return value
            return change

        def foreign_manifest(kind, value, stack=None):
            return {**value, "checkpoint": "held"} if kind == "manifest" else value

        def no_bodies(kind, value, stack=None):
            return {**value, "changed_bodies": []} if kind == "admission" else value

        def deployed(kind, value, stack=None):
            if kind == "result":
                value.update(status="DEPLOYED", steps=[{**value["steps"][0], "step": sid, "outcome": "PASS"} for sid, _, _, _ in intro.STEPS["reopen"]])
            return value

        cases = {
            "a raw record deleted after the run": (self.UNIT, None, after_run(lambda proof: next(proof.evidence.rglob("journal.jsonl")).unlink())),
            "a raw record changed after the run": (self.UNIT, None, after_run(
                lambda proof: next(proof.evidence.rglob("state.json")).write_bytes(b'{"status":"SEEDED"}\n'))),
            "the raw journal changed after the run": (self.UNIT, None, after_run(
                lambda proof: next(proof.evidence.rglob("journal.jsonl")).write_bytes(b'{"event":"edited"}\n'))),
            "a raw record not listed in the segment": (self.UNIT, None, after_run(
                lambda proof: (proof.evidence / "records-clone" / "extra.json").write_bytes(b"{}\n"))),
            "a failed phase (S-01 STOP, FAILED) behind passed=true": (self.UNIT, failed, None),
            "a FAILED result whose history row claims PASS": (self.UNIT, lambda kind, value, stack=None: status_only(kind, failed(kind, value)), None),
            "a result under another plan": (self.UNIT, other_plan, None),
            "no plan.json": (self.UNIT, no_plan, None),
            "no executed plan in the current identity": (self.UNIT, no_executed_plan, None),
            "no executed plan (a leaf that seals nothing)": (late, no_executed_plan, None),
            "a referenced step log missing": (self.UNIT, without("*.out"), None),
            "a log referenced by the command record missing": (self.UNIT, without("failed-*.err"), None),
            "the referenced command record missing": (self.UNIT, without("commands-*.jsonl"), None),
            "the sealed checkpoint's manifest deleted after the run": (self.UNIT, None, after_run(
                lambda proof: (Path(proof.results["checkpoint"]["path"]) / "manifest.json").unlink())),
            "a sealed checkpoint of another kind": (self.UNIT, foreign_manifest, None),
            "a fork without its admission.json": (fork, None, after_run(lambda proof: (proof.evidence / "admission.json").unlink())),
            "a fork admission that admits no body": (fork, no_bodies, None),
            "the late fault reported as a deployed reopen": (late, deployed, None),
            "a fresh clone result under another plan than the clone's own": (fresh, lambda kind, value, stack=None: other_plan(kind, value) if stack == "clone" else value, None),
            "a fresh method that names one plan for its stacks": (fresh, lambda kind, value, stack=None:
                                                                  {**value, "plan_sha256": "e" * 64} if kind == "current" else value, None),
        }
        for name, (unit, alter, after) in cases.items():
            with self.subTest(refused=name):
                proof = self.layout(unit, alter=alter)
                run_dir, completed = self.record(proof)
                self.assertEqual(completed.returncode, 0, completed.stderr)
                if after:
                    after(proof)
                verdict = cp.leaf_index(proof.leaves, proof.unit, proof.root, run_dir)
                self.assertEqual(verdict["verdict"], "UNVERIFIED", name)
                self.assertTrue(verdict["reasons"])
        with self.subTest(refused="a refusal proof that names a plan"):
            proof = self.layout(refusal, alter=lambda kind, value, stack=None: {**value, "plan_sha256": "e" * 64} if kind == "current" else value)
            self.assertEqual(self.verdict(proof)["verdict"], "UNVERIFIED")

    def bound_pair(self):
        """The late-resume fork and the fresh control under one proof root, each recorded and BOUND by `index`."""
        root = self.tempdir("kin-proof-")
        units = ("release-tools-checkpoints-proof-late-resume", "release-tools-checkpoints-proof-fresh-control")
        proofs = []
        for unit in units:
            proof = self.layout(unit, root=root)
            run_dir, _ = self.record(proof)
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(cp.main(["index", "--registry", str(root / "registry.json"), "--unit", unit, "--proof-root", str(root),
                                          "--run-dir", str(run_dir)]), 0)
            proofs.append(proof)
        return root, proofs

    def test_bound_index_is_rechecked_when_consumed(self):
        """CKPT2-03 (consult round3_acceptance): parent and compare re-read run.json, stdout/stderr, the segment and every
        bound raw record and admission and compare them with the index; a changed stdout forward_verdict, a deleted raw
        record or a read error is UNVERIFIED/PARENT_UNBOUND, never a pass and never a traceback taken as success."""
        root, (fork, fresh) = self.bound_pair()
        leaves = fork.leaves
        self.assertTrue(cp.t16_comparison(leaves, root)["t16_pass"], cp.t16_comparison(leaves, root))
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(cp.main(["compare", "--registry", str(root / "registry.json"), "--proof-root", str(root)]), 0)
        stdout = fresh.expectation["run_dir"] / "stdout.log"
        original = stdout.read_bytes()
        stdout.write_bytes(original.replace(b'"status": "DEPLOYED"', b'"status": "DEPLOYED", "edited": true'))
        self.assertNotEqual(stdout.read_bytes(), original)
        compared = cp.t16_comparison(leaves, root)
        self.assertFalse(compared["t16_pass"], "a forward_verdict edited after its index is never compared")
        self.assertTrue(any("stdout.log changed after its index" in reason for reason in compared["reasons"]), compared["reasons"])
        stdout.write_bytes(original)
        self.assertTrue(cp.t16_comparison(leaves, root)["t16_pass"])
        consumed = {
            "a raw record deleted after the index": lambda proof: next(proof.evidence.rglob("journal.jsonl")).unlink(),
            "the admission changed after the index": lambda proof: (proof.evidence / "admission.json").write_bytes(b"{}\n"),
            "run.json changed after the index": lambda proof: (proof.expectation["run_dir"] / "run.json").write_bytes(b"{}\n"),
            "stderr.log changed after the index": lambda proof: (proof.expectation["run_dir"] / "stderr.log").write_bytes(b"x\n"),
            "the segment replaced by a folder (a read error)": lambda proof: (proof.expectation["segment_path"].unlink(),
                                                                               proof.expectation["segment_path"].mkdir()),
        }
        for name, change in consumed.items():
            with self.subTest(refused=name):
                other, (changed, _) = self.bound_pair()
                change(changed)
                self.assertRefused("PARENT_UNBOUND", cp.bound_index, other, changed.unit)
                compared = cp.t16_comparison(leaves, other)
                self.assertFalse(compared["t16_pass"], name)
                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(cp.main(["compare", "--registry", str(other / "registry.json"), "--proof-root", str(other)]), 1)
        # A parent request through a BOUND index whose raw record went missing: PARENT_UNBOUND before any request exists.
        root = self.tempdir("kin-proof-")
        introduce = "release-tools-checkpoints-proof-prefix-introduce"
        parent = self.layout(introduce, root=root)
        run_dir, _ = self.record(parent)
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(cp.main(["index", "--registry", str(root / "registry.json"), "--unit", introduce, "--proof-root", str(root),
                                      "--run-dir", str(run_dir)]), 0)
        (root / "b.source-manifest.json").write_bytes(cp.canonical({"root": str(root / "b")}) + b"\n")
        self.assertEqual(self.admitted(cp.resolve_parent, parent.leaves, "release-tools-checkpoints-proof-late-resume", root)["sha256"],
                         Path(parent.results["checkpoint"]["path"]).name)
        next(parent.evidence.rglob("state.json")).write_bytes(b'{"history":[]}\n')
        self.assertRefused("PARENT_UNBOUND", cp.leaf_request, parent.leaves, "release-tools-checkpoints-proof-late-resume", root)

    def test_observation_raw_is_required_and_rechecked_when_consumed(self):
        """r5 P3 (consult observe_fix raw_evidence_after, R5-ACCEPTANCE item 2, N04): a volume checkpoint's capture
        observation is bound by the seal and re-read from the fixture member (load_bundle) and from the evidence (index); a
        leaf that restored a volume checkpoint carries its own restore observation naming that parent and observing the
        state the parent bound. A missing observation - also when its files left the raw list with it (M46) -, a changed
        observation file, an observation of another parent, and an observation file edited after the index (PARENT_UNBOUND)
        are refused."""
        capture = "release-tools-checkpoints-proof-prefix-capture"
        late = "release-tools-checkpoints-proof-late-fault"
        for unit in (self.UNIT, capture, late):
            with self.subTest(bound=unit):
                proof = self.layout(unit)
                verdict = self.verdict(proof)
                self.assertEqual(verdict["verdict"], "BOUND", verdict["reasons"])
                self.assertTrue(any("/" + cp.OBSERVATION_DIR + "/" in rel for rel, _ in verdict["raw"]["files"]))

        def drop(purpose):
            def change(kind, value, stack=None):
                if kind == "files":
                    for request in sorted(value.glob(cp.OBSERVATION_DIR + "/*/request.json")):
                        if json.loads(request.read_bytes())["purpose"] == purpose:
                            shutil.rmtree(request.parent)
                return value
            return change

        def edit(purpose, name, old, new):
            def change(kind, value, stack=None):
                if kind == "files":
                    for request in sorted(value.glob(cp.OBSERVATION_DIR + "/*/request.json")):
                        if json.loads(request.read_bytes())["purpose"] == purpose:
                            path = request.parent / name
                            path.write_bytes(path.read_bytes().replace(old, new))
                return value
            return change

        def unbound(kind, value, stack=None):
            return {**value, "bindings": {"state": value["bindings"]["state"]}} if kind == "manifest" else value

        cases = {"the capture observation removed with its raw rows": (self.UNIT, drop("capture"), None, "capture observation"),
                 "the restore observation removed with its raw rows (M46)": (capture, drop("restore"), None, "no restore observation"),
                 "the restore observation removed with its raw rows, late fault": (late, drop("restore"), None, "no restore observation"),
                 "a capture observation snapshot changed (rows rewritten)": (self.UNIT, edit("capture", "snapshot.json", b'"ready":true', b'"ready":false'),
                                                                           None, "capture observation"),
                 "a restore observation of another parent": (capture, edit("restore", "request.json", b'"parent_manifest_sha256":"',
                                                                           b'"parent_manifest_sha256":"0'), None, "restore observation"),
                 "a seal that binds no observation": (self.UNIT, unbound, None, "binds no capture observation"),
                 "an observation file changed after the run": (capture, None, lambda proof: next(proof.evidence.rglob("snapshot.json")).write_bytes(b"{}\n"),
                                                              "raw record changed")}
        for name, (unit, alter, after, reason) in cases.items():
            with self.subTest(refused=name):
                proof = self.layout(unit, alter=alter)
                run_dir, completed = self.record(proof)
                self.assertEqual(completed.returncode, 0, completed.stderr)
                if after:
                    after(proof)
                verdict = cp.leaf_index(proof.leaves, proof.unit, proof.root, run_dir)
                self.assertEqual(verdict["verdict"], "UNVERIFIED", name)
                self.assertTrue(any(reason in item for item in verdict["reasons"]), verdict["reasons"])
        with self.subTest(refused="an observation file edited after the BOUND index"):
            root = self.tempdir("kin-proof-")
            proof = self.layout(capture, root=root)
            run_dir, _ = self.record(proof)
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(cp.main(["index", "--registry", str(root / "registry.json"), "--unit", capture, "--proof-root", str(root),
                                          "--run-dir", str(run_dir)]), 0)
            self.admitted(cp.bound_index, root, capture)
            path = next(path for path in proof.evidence.rglob(cp.OBSERVATION_RESULT))
            path.write_bytes(path.read_bytes() + b" ")
            self.assertRefused("PARENT_UNBOUND", cp.bound_index, root, capture)
        # The fixture member of a volume bundle: the bound observation must be there, complete, and observe the bound state.
        with self.subTest(bundle="the capture observation re-read from the fixture member"):
            self.admitted(cp.load_bundle, seal(self, self.tempdir() / "bundles", "held"))
            self.assertRefused("BUNDLE_INVALID", seal, self, self.tempdir() / "bundles", "held", drop=("observation",))

            def damaged(store_root, change):
                fixture = self.tempdir("kin-fixture-")
                made = realistic(fixture, "held")
                folder = fixture / Path(made.bindings["observation"]["path"]).parent
                change(folder, made)
                store = cp.BundleStore(store_root, forbidden=[fixture])
                pending = store.begin("held")
                for category in cp.VOLUME_CATEGORIES:
                    pending.add("volume-" + category + ".tar", "volume:" + category, volume_tar(category))
                tree = pending.directory / "export-fixture.tar"
                cp.write_tree_archive(fixture, tree)
                pending.add("fixture-tree.tar", "fixture-tree", tree)
                tree.unlink()
                return pending.seal(identity=made.identity, boundary=sealed_boundary("held", made), bindings=made.bindings,
                                    owned=sealed_owned(made), execution_kind="fresh")
            for label, change in (("its snapshot deleted", lambda folder, made: (folder / "snapshot.json").unlink()),
                                  ("an observation of another state", lambda folder, made: (folder.parent.parent / "state.json").write_bytes(b"{}\n"))):
                with self.subTest(damaged=label):
                    try:
                        final = damaged(self.tempdir() / "bundles", change)
                    except cp.Refused as error:
                        # A changed state no longer matches its own binding: the seal itself refuses.
                        self.assertEqual(error.code, "BUNDLE_INVALID")
                        continue
                    self.assertRefused("BUNDLE_INVALID", cp.load_bundle, final)


STAGE_IMAGES = {"previous": {"api": image("1"), "proxy": image("2"), "db": image("3"), "keycloak": image("4"), "orthanc": image("5")},
                "release": {"api": image("6"), "proxy": image("7"), "db": image("3"), "keycloak": image("4"), "orthanc": image("5")}}
STAGE_MEMBERS = {"realm_members": 3, "disabled": 1, "service_accounts": 1}
# The product's phase order as the fake product enforces it (a phase from another status ends NEEDS_ATTENTION).
PHASE_FROM = {"capture": (None, "SEEDED"), "seed": (None,), "introduce": ("HELD",), "verify": ("INTRODUCED",), "reopen": ("VERIFIED",),
              "rollback": ("VERIFIED",), "rollback_reopen": ("RESTORED",), "receipt": ("ROLLED_BACK",)}
# T15 injections: (outcome kind, the stage whose own assertions must catch it), per scenario.
WRONG_OUTCOMES = {
    "normal": (("data", "seed"), ("rights", "seed"), ("realm", "introduce"), ("rights", "introduce"), ("data", "introduce"),
               ("realm", "verify"), ("frame", "verify"), ("overlay", "verify"), ("frame", "normal-tail"), ("rights", "normal-tail"),
               ("realm", "normal-tail"), ("data", "normal-tail"), ("overlay", "normal-tail"), ("ordinary-entry", "normal-tail"),
               ("receipt", "normal-tail")),
    "forward": (("data", "seed"), ("realm", "verify"), ("frame", "verify"), ("overlay", "verify"), ("ordinary-entry", "forward-tail"),
                ("data", "forward-tail"), ("realm", "forward-tail")),
    "forced": (("data", "forced-capture"), ("overlay", "forced-tail"), ("rights", "forced-tail"), ("data", "forced-tail"),
               ("image", "forced-tail")),
}


class FakeProductError(Exception):
    """A call the fake product does not model: an error of the test, never counted as a caught outcome."""


class FakeProduct:
    """T15 (CKPT-05): a synthetic product, daemon and realm under the real RehearsalStages methods. `bad` = (kind, stage)
    makes exactly one product outcome wrong while that stage runs; the stage's own assertions must catch it there."""

    def __init__(self, rehearsal, bad=None):
        self.rehearsal, self.bad, self.stage = rehearsal, bad, None
        self.stacks, self.volumes, self.filled = {}, set(), set()
        self.smoke_present, self.counter = False, 0

    def wrong(self, kind):
        return self.bad == (kind, self.stage)

    def next(self):
        self.counter += 1
        return self.counter

    def container(self, name):
        for stack in self.stacks.values():
            for role, item in stack.containers.items():
                if stack.target["containers"][role] == name:
                    return item
        raise FakeProductError("no such container in the fake daemon: " + name)

    # ── the daemon (rehearsal.subprocess) ──

    def run(self, args, **kwargs):
        args = [str(item) for item in args]
        code, out = 0, b""
        if args[0] != "docker":
            raise FakeProductError("the fake daemon only answers docker: " + args[0])
        if args[1] == "inspect":
            out = json.dumps([self.container(args[2])]).encode()
        elif args[1] == "volume" and args[2] == "inspect":
            code = 0 if args[3] in self.volumes else 1
        elif args[1] in ("ps", "exec", "rm", "tag", "image"):
            pass
        else:
            raise FakeProductError("unexpected daemon call: " + " ".join(args[:3]))
        if kwargs.get("check") and code:
            raise subprocess.CalledProcessError(code, args)
        text = kwargs.get("text")
        return subprocess.CompletedProcess(args, code, out.decode() if text else out, "" if text else b"")

    def processes(self):
        return SimpleNamespace(run=self.run, PIPE=subprocess.PIPE, CalledProcessError=subprocess.CalledProcessError)

    # ── the product (phase), the database and the realm (psql) ──

    def psql(self, stack, sql, database):
        rehearsal = self.rehearsal
        if sql.startswith("INSERT") or sql == rehearsal.LEGACY_ROLES_SQL:
            return ""
        if sql == rehearsal.LEGACY_FACTS_SQL:
            return json.dumps({**LEGACY, "database_acl": "{someone=c/kin}"} if self.wrong("rights") else LEGACY)
        if sql == intro.REALM_MEMBERS_SQL:
            return json.dumps(STAGE_MEMBERS)
        if sql == rehearsal.REALM_SMOKE_SQL:
            return "1" if self.smoke_present else "0"
        if 'SELECT "preDoc" FROM' in sql:
            return "someone@kin.kr" if self.wrong("data") else "doctor@kin.kr"
        if "FROM user_entity WHERE username='tech'" in sql:
            enabled = stack.status in ("INTRODUCED", "VERIFIED", "DEPLOYED")
            return "t" if enabled is not self.wrong("realm") else "f"
        if 'SELECT suspended FROM "MemberRights"' in sql:
            return "f" if self.wrong("rights") else "t"
        if '"preDocSub" IS NOT NULL' in sql:
            return "f" if self.wrong("data") else "t"
        if "json_build_object('suspended', suspended" in sql:
            return json.dumps({"suspended": False, "approved": True, "roles": [] if self.wrong("rights") else ["radiologist"],
                               "institution": "hallym"})
        if "rolled_back_at IS NOT NULL) ORDER BY" in sql:
            rows = [[name, checksum, True, False] for name, checksum in stack.plan_document["migrations"]["before"]]
            return json.dumps(rows[:-1] if self.wrong("data") else rows)
        if "WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL" in sql:
            rows = [[name, checksum] for name, checksum in stack.plan_document["migrations"]["after"]]
            return json.dumps(rows[:-1] if self.wrong("data") else rows)
        if "rolname LIKE 'kin_emr_%' OR rolname='kin_runtime';" in sql:
            return "0"
        raise FakeProductError("unexpected SQL in the fake product: " + sql[:80])

    def phase(self, stack, phase, ops_class):
        """The product's phase transitions as the stages observe them (state, result, records, containers)."""
        require_from = PHASE_FROM[phase]
        state = stack.records.state() or {"plan_sha256": stack.plan_sha256, "status": None}
        if state.get("status") not in require_from:
            return {"phase": phase, "status": "NEEDS_ATTENTION", "steps": [{"step": "X-00", "outcome": "STOP"}], "warnings": []}
        plan, now = stack.plan_document, datetime.now(timezone.utc).isoformat()
        previous, release = plan["previous"]["images"], plan["release"]["images"]
        steps, warnings, extra = [{"step": phase[:1].upper() + "-01", "outcome": "PASS"}], [], {}
        forced = ops_class is not None and "proxy_ui" in vars(ops_class)
        if phase == "capture":
            b0 = stack.backups / ("emr-b0-" + stack.label)
            b0.mkdir()
            (b0 / "manifest.json").write_bytes(B0_MANIFESTS.get(stack.label, b"{}\n"))
            state["b0"] = {"dir": str(b0), "manifest_sha256": hashlib.sha256((b0 / "manifest.json").read_bytes()).hexdigest(), "created_utc": now}
            for role in intro.ROLES:
                stack.containers[role]["State"]["Running"] = role == "db"
            steps = [{"step": "L-01", "outcome": "PASS", "detail": {"smoke_browser": {"browser": "chromium 130.0.6723.31"},
                                                                     "smoke_member_realm": {"roles": ["radiologist"], "group": "hallym"}}}]
            if stack.label == "failure":
                state["compose_env"] = {"KIN_MONITOR_PUBLIC_DIR": {"from": ["env"] if self.wrong("data") else ["mount:proxy"]}}
                stack.records.write_secret(intro.COMPOSE_VALUES, b'{"KIN_MONITOR_PUBLIC_DIR":"kept"}')
            status = "HELD"
        elif phase == "seed":
            stack.up(previous)
            self.volumes |= set(stack.target["volumes"].values())
            status = "SEEDED"
        elif phase == "introduce" and forced:
            steps = [{"step": "I-00", "outcome": "PASS"}, {"step": "L-09b", "outcome": "STOP"}, {"step": "RB-01", "outcome": "PASS"}]
            warnings = [] if self.wrong("overlay") else [{"kind": "declared-overlay"}]
            stack.records.journal({"event": "compose-environment", "resolved_from_running_stack": {"KIN_MONITOR_PUBLIC_DIR": {"from": ["kept"]}}})
            stack.up(previous)
            status = "RESTORED"
        elif phase == "introduce":
            stack.up(release)
            state["smoke_member"] = {"username": "kin-smoke-0001"}
            status = "INTRODUCED"
        elif phase == "verify":
            self.smoke_present = self.wrong("realm")
            state["smoke_retry"] = {"passed": True, "reason": "The smoke browser login failed: forced first-attempt failure (rehearsal D07)",
                                    "seconds": 5.0}
            state["b1"] = {"manifest_sha256": "b" * 64}
            checks = {name: not (name == "ohif_frame" and self.wrong("frame")) for name in intro.OPERATOR_SMOKE_CHECKS}
            stack.records.put("operator-smoke.json", {"by": intro.SMOKE_BY, "passed": all(checks.values()), "checks": checks})
            if self.wrong("overlay"):
                stack.containers["proxy"]["Mounts"] = [mount for mount in stack.containers["proxy"]["Mounts"] if mount["Type"] != "bind"
                                                       or mount["Destination"] != stack.halo_bind["target"]]
            extra = {"probe": {"receipt": {"eventId": plan["probe"]["event_id"]}}}
            status = "VERIFIED"
        elif phase == "rollback":
            stack.recovery = {"project": stack.project + "-recovery", "pg": stack.project + "-recovery_pg",
                              "orthanc": stack.project + "-recovery_orthanc"}
            state["recovery"], state["bfail"] = dict(stack.recovery), {"manifest_sha256": "f" * 64}
            stack.up(previous, running={"db"})
            status = "RESTORED"
        elif phase == "rollback_reopen":
            steps = [{"step": "RR-%02d" % index, "outcome": "PASS"} for index in range(1, 6)]
            stack.up(release if self.wrong("image") else previous, only=("api",) if self.wrong("image") else None)
            stack.up(previous, only=tuple(role for role in intro.ROLES if role != "api") if self.wrong("image") else None)
            stack.records.put("operator-smoke-previous.json", {"passed": True})
            state["rollback_smoke"] = {"frame_sha256": "0" * 64 if self.wrong("frame") else self.rehearsal.SYNTHETIC_FRAME["sha256"]}
            if self.wrong("overlay"):
                stack.containers["proxy"]["NetworkSettings"]["Networks"].pop(stack.halo_network, None)
            if stack.label == "failure":
                warnings = [{"kind": "declared-overlay"}]
                if not self.wrong("data"):
                    (stack.records.secrets / intro.COMPOSE_VALUES).unlink()
            status = "ROLLED_BACK"
        elif phase == "reopen":
            self.smoke_present = self.smoke_present or self.wrong("realm")
            status = "DEPLOYED"
        elif phase == "receipt":
            receipt = {"kind": "local-restore-receipt", "plan_sha256": stack.plan_sha256}
            stack.records.put("local-restore-receipt.json", receipt)
            extra = {"receipt": {"sha256": intro.receipt_sha256(receipt)}}
            status = "RECEIPTED"
        else:
            raise FakeProductError("unexpected phase " + phase)
        state["status"] = stack.status = status
        stack.records.save(state)
        return {"phase": phase, "status": status, "steps": steps, "warnings": warnings, **extra}

    def receipt_valid(self, receipt, plan, b0_manifest_sha256, production, *, now=None, b0_created_utc=None, used=(), bundle=None):
        if self.wrong("receipt"):
            raise intro.Stop("The receipt does not bind the rehearsed production plan")
        if bundle is None:
            raise intro.Stop("A receipt is accepted only with its run bundle")
        if intro.receipt_sha256(receipt) in used:
            raise intro.Stop("The receipt was already used")
        return True

    def stack_class(product):
        class FakeStack:
            """SyntheticStack's interface over the fake product (no clone, network, file outside the fixture or process)."""

            def __init__(self, test, root, label, previous_sha, target_sha):
                self.test, self.label, self.status, self.recovery, self.containers = test, label, None, None, {}
                self.token = "%010d" % (len(product.stacks) + 1)
                self.project = "kin-rehearsal-" + label + "-" + self.token
                self.root = root / label
                self.root.mkdir()
                self.repo = self.root / "repo"
                self.repo.mkdir()
                self.ca = self.root / "clone-ca.pem"
                self.monitor_dir = self.repo / ".kin-monitor-public"
                self.monitor_dir.mkdir()
                self.halo_conf = self.root / "halo-reports" / "report.conf"
                self.halo_conf.parent.mkdir()
                self.halo_conf.write_text("# synthetic\n", encoding="utf-8")
                self.halo_network = self.project + "-halo"
                self.halo_bind = {"source": str(self.halo_conf), "target": "/etc/nginx/conf.d/halo-report.conf", "read_only": True}
                overlay = self.root / "docker-compose.halo-reports.yml"
                overlay.write_text("services: {}\n", encoding="utf-8")
                self.target = {"host_key_sha256": "b" * 64, "project": self.project, "origin": "https://localhost:21443",
                               "containers": {role: self.project + "-" + role for role in intro.ROLES},
                               "volumes": {"pg": self.project + "_pg-db", "orthanc": self.project + "_orthanc-db",
                                           "emr_access": self.project + "_emr-access", "emr_state": self.project + "_emr-state"},
                               "networks": {"default": self.project + "_default"},
                               "declared_overlays": [{"file": str(overlay), "sha256": hashlib.sha256(overlay.read_bytes()).hexdigest(),
                                                      "service": "proxy", "binds": [dict(self.halo_bind)]}]}
                self.origin = self.target["origin"]
                (self.repo / ".env").write_text("POSTGRES_PASSWORD=synthetic\n" + ("" if label == "failure" else
                                                "KIN_MONITOR_PUBLIC_DIR=" + str(self.monitor_dir) + "\n"), encoding="utf-8")
                self.records = intro.Records(self.root / "records")
                self.backups = self.root / "backups"
                self.backups.mkdir()
                self.previous_sha, self.target_sha = previous_sha, target_sha
                product.stacks[self.project] = self

            def plan(self, images, seed=None, members=None, frame=None):
                now = datetime.now(timezone.utc)
                plan = {**plan_fixture(), "target_manifest_sha256": hashlib.sha256(intro.canonical(self.target)).hexdigest(),
                        "previous": {"sha": self.previous_sha, "images": dict(images["previous"])},
                        "release": {"sha": self.target_sha, "images": dict(images["release"])},
                        "members": members or {"realm_members": 0, "disabled": 0, "service_accounts": 0},
                        "smoke": {"frame": frame or product.rehearsal.SYNTHETIC_FRAME, "member": {"roles": ["radiologist"], "group": "hallym"}},
                        "window": {"start": (now - timedelta(hours=1)).isoformat(), "end": (now + timedelta(hours=8)).isoformat()},
                        "backup_root": str(self.backups),
                        "seed": seed or {"b0_dir": str(self.root / "unused-seed"), "b0_manifest_sha256": "0" * 64,
                                         "production_plan_sha256": "0" * 64}}
                self.plan_document = intro.plan_valid(plan)
                self.plan_sha256 = intro.plan_identity(plan)
                return plan

            def mounts(self, role):
                volume = lambda kind: self.recovery[kind] if self.recovery else self.target["volumes"][kind]
                return {"db": [{"Type": "volume", "Destination": "/var/lib/postgresql/data", "Name": volume("pg"), "RW": True}],
                        "orthanc": [{"Type": "volume", "Destination": "/var/lib/orthanc/db", "Name": volume("orthanc"), "RW": True}],
                        "proxy": [{"Type": "bind", "Destination": self.halo_bind["target"], "Source": self.halo_bind["source"], "RW": False},
                                  {"Type": "bind", "Destination": "/var/run/kin-monitor-public", "Source": str(self.monitor_dir), "RW": True}]
                        }.get(role, [])

            def up(self, images, running=None, only=None):
                for role in only or intro.ROLES:
                    networks = {self.target["networks"]["default"]: {}, **({self.halo_network: {}} if role == "proxy" else {})}
                    self.containers[role] = {"Id": "%064x" % product.next(), "Image": images[role], "Mounts": self.mounts(role),
                                             "NetworkSettings": {"Networks": networks},
                                             "Config": {"Labels": {"com.docker.compose.project": self.recovery["project"] if self.recovery
                                                                   else self.project}},
                                             "State": {"Running": running is None or role in running}}

            def certificates(self, proxy_image, fill=True):
                product.volumes.add(self.project + "_proxy-certs")
                if fill:
                    product.filled.add(self.project + "_proxy-certs")
                    self.ca.write_bytes(b"synthetic CA\n")

            def compose_up(self, images, roles):
                self.up(images)
                product.volumes.update(self.target["volumes"].values())
                return self.ops()[1]

            def psql(self, sql, database="kin"):
                return product.psql(self, sql, database)

            def keycloak(self, image_id, operation, admin_user, network=None):
                return {"password": "synthetic"}

            def phase(self, phase, expected, ops_class=None):
                result = product.phase(self, phase, ops_class)
                self.records.write(self.records.directory / ("result-%s-%04d.json" % (phase, product.next())), intro.canonical(result) + b"\n")
                self.test.assertEqual(result["status"], expected, json.dumps(result)[:400])
                return result

            def ops(self, ops_class=None):
                stack = self

                class Ops:
                    def certificate_volume_check(self, context, model):
                        volume = stack.project + "_proxy-certs"
                        if volume not in product.volumes:
                            raise intro.Stop("The certificate volume " + volume + " does not exist")
                        if not stack.ca.exists():
                            raise intro.Stop("The CA file is missing")
                        if volume not in product.filled:
                            raise intro.Stop("The certificate volume is empty")
                        return {"volume": volume}

                    def db_ready(self, *args):
                        return None

                    def api_health(self, **kwargs):
                        return None

                    def reload_proxy(self):
                        return None
                return None, Ops()

            def bootstrap_model(self, host_ops, context):
                return {}

            def ordinary_recreate(self, images, *, side):
                self.test.assertEqual(self.status, "DEPLOYED" if side == "release" else "ROLLED_BACK")
                other = "release" if side == "previous" else "previous"
                for role in intro.ROLES:
                    self.containers[role] = {**self.containers[role], "Id": "%064x" % product.next(),
                                             "Image": images[other if role == "api" and product.wrong("ordinary-entry") else side][role]}

            def remove(self):
                return None
        return FakeStack

    def scenario(self, test, scenario):
        """Run the real stage methods of one scenario over this product; returns the stage that failed (None = PASS)."""
        rehearsal = self.rehearsal

        class StageProbe(rehearsal.RehearsalStages, unittest.TestCase):
            def runTest(self):
                pass
        probe = StageProbe()
        table = {}
        for stage, method in probe.stage_table().items():
            def traced(ctx, stage=stage, method=method):
                self.stage = stage
                method(ctx)
            table[stage] = traced
        root = test.tempdir("kin-stages-")
        context = SimpleNamespace(root=root, previous_sha="a" * 40, target_sha="b" * 40, images=copy.deepcopy(STAGE_IMAGES))
        with patch.object(rehearsal, "SyntheticStack", self.stack_class()), patch.object(rehearsal, "subprocess", self.processes()), \
                patch.object(rehearsal, "time", SimpleNamespace(sleep=lambda seconds: None, monotonic=time.monotonic)), \
                patch.object(rehearsal, "synthetic_dicom", lambda: b"DICM"), \
                patch.object(intro, "bound_ops", lambda repository, runner: contextlib.nullcontext()), \
                patch.object(intro, "health_check", lambda *args, **kwargs: {"ok": True}), \
                patch.object(intro, "receipt_valid", self.receipt_valid), patch.object(intro, "bundle_valid", lambda receipt, bundle: True), \
                patch.object(intro, "DirectoryBundle", lambda directory: ("bundle", str(directory))), \
                contextlib.redirect_stdout(io.StringIO()):
            try:
                cp.run_scenario(scenario, table, context, environ={})
            except (AssertionError, intro.Stop, RuntimeError) as error:
                if isinstance(error, FakeProductError):
                    raise
                return self.stage
        return None


class CheckpointScenarioTests(RefusalAssertions, TempCase):
    def test_fresh_scenarios_keep_their_phase_and_data_contracts(self):
        """T15 (RQC-01/12, CKPT-05): the explicit stage table; the real stage methods catch every wrong product outcome in
        their own stage; a request never shortens a fresh method; the three selectors and the collections stay."""
        for scenario, stages in cp.SCENARIOS.items():
            with self.subTest(scenario=scenario):
                calls = []
                table = {stage: (lambda context, stage=stage: calls.append(stage)) for stage in cp.STAGES}
                self.assertEqual(cp.run_scenario(scenario, table, {}, environ={}), list(stages))
                self.assertEqual(calls, list(stages))
                for index, failing in enumerate(stages):
                    for kind in ("data", "rights", "realm", "frame", "overlay", "ordinary-entry", "receipt"):
                        calls.clear()

                        def fail(context, kind=kind):
                            raise AssertionError(kind + " contract")
                        broken = {**table, failing: fail}
                        with self.assertRaisesRegex(AssertionError, kind + " contract"):
                            cp.run_scenario(scenario, broken, {}, environ={})
                        self.assertEqual(calls, list(stages[:index]))
                calls.clear()
                self.assertRefused("FRESH_WITH_REQUEST", cp.run_scenario, scenario, table, {}, environ={cp.REQUEST_ENV: "/x.json"})
                self.assertEqual(calls, [], "a request never runs part of a fresh method")
        import ops_deploy_host_container_test as rehearsal
        cls = rehearsal.EmrIntroductionRehearsal
        self.assertEqual(sorted(name for name in unittest.defaultTestLoader.getTestCaseNames(cls)),
                         sorted(case.split(".", 1)[1] for case in cp.FRESH_CASES.values()))
        self.assertEqual(set(rehearsal.STAGE_METHODS), set(cp.STAGES))
        for stage, method in rehearsal.STAGE_METHODS.items():
            self.assertTrue(callable(getattr(rehearsal.RehearsalStages, method, None)), method)
        for scenario, case in cp.FRESH_CASES.items():
            with self.subTest(fresh=case):
                seen = []
                with patch.object(cls, "run_fresh", lambda self, name: seen.append(name)):
                    getattr(cls(case.split(".", 1)[1]), case.split(".", 1)[1])()
                self.assertEqual(seen, [scenario])
        spec = importlib.util.spec_from_file_location("run_tests_for_selection", RUNNER)
        runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runner)
        # The runner collects the repository's own file; a mutation run's temporary copy must not make it ambiguous.
        with patch.dict(sys.modules), patch.object(sys, "path", list(sys.path)):
            sys.modules.pop("ops_deploy_host_container_test", None)
            selected = runner.module_plan(cp.REHEARSAL_FILE, "selection-only", "live", 3600, "EmrIntroductionRehearsal")["tests"]
        self.assertEqual(sorted(item["case"] for item in selected), sorted(cp.FRESH_CASES.values()))
        loaded = unittest.defaultTestLoader.loadTestsFromModule(rehearsal)
        names = sorted(test.id().split(".", 1)[1] for suite in loaded for test in suite)
        self.assertEqual(names, sorted(["ContainerTests.test_real_target_and_previous_preserve_database", *cp.FRESH_CASES.values()]))
        import ops_release_checkpoints_live_test as live
        live_cases = sorted("CheckpointSegments." + name for name in unittest.defaultTestLoader.getTestCaseNames(live.CheckpointSegments))
        self.assertEqual(live_cases, sorted({item["case"] for item in cp.STAGES.values()} | set(cp.PROOF_CASES)))
        self.assertEqual({leaf["case"] for leaf in cp.DEFAULT_PROOF_LEAVES if leaf["file"] == cp.LIVE_FILE} - set(live_cases), set())
        # CKPT-05: the real RehearsalStages methods of normal/forward/forced over a synthetic product. The correct outcomes
        # pass every stage; each wrong data, rights, realm, frame, overlay, ordinary-entry, image or receipt outcome fails
        # in exactly the stage whose own assertion owns it (a deleted stage or assertion lets it pass or fail later).
        for scenario in cp.SCENARIOS:
            with self.subTest(real_stages=scenario):
                self.assertIsNone(FakeProduct(rehearsal).scenario(self, scenario), "the correct product outcomes pass every stage")
            for kind, stage in WRONG_OUTCOMES[scenario]:
                with self.subTest(real_stages=scenario, wrong=kind, stage=stage):
                    self.assertEqual(FakeProduct(rehearsal, bad=(kind, stage)).scenario(self, scenario), stage,
                                     "a wrong " + kind + " outcome during " + stage + " must fail there")
        self.assertLessEqual({"data", "rights", "realm", "frame", "overlay", "ordinary-entry", "receipt"},
                             {kind for outcomes in WRONG_OUTCOMES.values() for kind, _ in outcomes})


class CheckpointHostAdapterTests(RefusalAssertions, TempCase):
    """CKPT-01: the real adapter (CheckpointDocker.host_facts/run) over a fake process table, judged by host_admission."""

    INFO = {"ID": "DAEMON:A", "OperatingSystem": "Ubuntu 24.04 LTS", "Architecture": "x86_64", "ServerVersion": "27.0.3"}

    def observe(self, rows, *, info=0, listing=0, endpoint="unix:///var/run/docker.sock", environ=None, owned_ids=()):
        import ops_deploy_host_container_test as rehearsal
        calls = []

        def run(args, **kwargs):
            calls.append((list(args), dict(kwargs.get("env") or {})))
            if args[1] == "info":
                return subprocess.CompletedProcess(args, info, json.dumps(self.INFO).encode() if info == 0 else b"", b"")
            if args[1] == "context":
                return subprocess.CompletedProcess(args, 0, endpoint + "\n", "")
            if args[1] == "ps":
                return subprocess.CompletedProcess(args, listing, "".join("\t".join(row) + "\n" for row in rows), "")
            raise AssertionError("unexpected adapter call " + " ".join(args[:3]))
        clean = {key: value for key, value in os.environ.items() if not key.startswith(("DOCKER_", "COMPOSE_"))}
        with patch.object(rehearsal, "subprocess", SimpleNamespace(run=run, PIPE=subprocess.PIPE)), \
                patch.object(rehearsal.intro, "local_host_key", lambda *args: "8" * 64), \
                patch.dict(os.environ, {**clean, **(environ or {})}, clear=True):
            facts = rehearsal.CheckpointDocker.host_facts(self.tempdir() / "fixture", owned_ids=owned_ids)
        # Platform facts this Windows/CI host cannot have; the adapter's own observations stay as observed.
        facts.update(os="linux", available_ram_bytes=16 * 1024 ** 3, available_disk_bytes=100 * 1024 ** 3, host_key_sha256="8" * 64)
        return facts, calls

    def test_adapter_admission_counts_labels_and_binds_one_local_daemon(self):
        """CKPT-01 (RQC-07/10): name, kin.ops.run and kin.emrb.live, running or stopped, refuse; a failed or malformed query
        is an unavailable daemon; a remote context or a DOCKER_* selection refuses; every call runs without DOCKER_*."""
        quiet = [("a" * 64, "postgres-unrelated", "running", "", "")]
        facts, calls = self.observe(quiet)
        self.assertTrue(self.admitted(cp.host_admission, facts)["admitted"])
        self.assertEqual(facts["foreign_containers"], [])
        foreign = {
            "a labelled container with another name (kin.ops.run), running": ("b" * 64, "other-worker", "running", "token-9", ""),
            "a labelled container with another name (kin.emrb.live), stopped": ("c" * 64, "foreign-owner", "exited", "", "1"),
            "a kin- named container, stopped": ("d" * 64, "kin-rehearsal-old-proxy", "exited", "", ""),
            "a kin- named container, running": ("e" * 64, "kin-db", "running", "", ""),
        }
        for name, row in foreign.items():
            with self.subTest(refused=name):
                facts, _ = self.observe(quiet + [row])
                self.assertEqual(facts["foreign_containers"], [row[1] + " (" + row[2] + ")"])
                self.assertRefused("FOREIGN_RESOURCES", cp.host_admission, facts)
        with self.subTest(admitted="this stage's own exact container ID"):
            facts, _ = self.observe(quiet + [foreign["a labelled container with another name (kin.ops.run), running"]], owned_ids=("b" * 64,))
            self.assertTrue(self.admitted(cp.host_admission, facts)["admitted"])
        for name, kwargs in (("the listing fails", {"listing": 1}), ("the daemon info fails", {"info": 1}),
                             ("a malformed listing row", {"rows": quiet + [("f" * 64, "kin-x")]})):
            with self.subTest(refused=name):
                facts, _ = self.observe(kwargs.pop("rows", quiet), **kwargs)
                self.assertRefused("DAEMON_UNAVAILABLE", cp.host_admission, facts)
        for name, kwargs in (("a remote context", {"endpoint": "tcp://10.0.0.5:2376"}),
                             ("an ssh context", {"endpoint": "ssh://builder@remote"}),
                             ("DOCKER_HOST set", {"environ": {"DOCKER_HOST": "unix:///run/other.sock"}}),
                             ("DOCKER_CONTEXT set", {"environ": {"DOCKER_CONTEXT": "remote"}}),
                             ("DOCKER_CONFIG set", {"environ": {"DOCKER_CONFIG": "/tmp/other-config"}})):
            with self.subTest(refused=name):
                facts, calls = self.observe(quiet, **kwargs)
                self.assertRefused("REMOTE_DAEMON", cp.host_admission, facts)
                self.assertTrue(calls and all(not key.startswith(("DOCKER_", "COMPOSE_")) for _, env in calls for key in env),
                                "every observation call runs without DOCKER_*/COMPOSE_*")
        import ops_deploy_host_container_test as rehearsal
        seen = []
        fake = SimpleNamespace(run=lambda args, **kwargs: (seen.append(kwargs.get("env")), subprocess.CompletedProcess(args, 0, b"", b""))[1],
                               PIPE=subprocess.PIPE)
        with patch.object(rehearsal, "subprocess", fake), patch.dict(os.environ, {"DOCKER_HOST": "tcp://elsewhere:2376", "COMPOSE_FILE": "x.yml"}):
            rehearsal.CheckpointDocker(None, None).run(["docker", "version"])
        self.assertEqual([key for key in seen[0] if key.startswith(("DOCKER_", "COMPOSE_"))], [],
                         "raw adapter calls reach the same daemon as the Compose calls")


class CheckpointInputsTests(RefusalAssertions, TempCase):
    """CKPT-04: plan, target and both B0 recomputed from the bundle before any restore; runtime and module origins pinned
    from observation; the product facts of a restored boundary compared with those of the checkpoint."""

    def bundle(self, checkpoint_id="introduced", tamper=None):
        """A sealed bundle. A tampered one (bytes that contradict its identity) is read by its manifest bytes: since r7 the
        writable layer's bound context makes load_bundle refuse those whose plan or state changed, and bundle_inputs and
        the restore must still refuse every one of them on their own, before any daemon call."""
        final = seal(self, self.tempdir() / "bundles", checkpoint_id, tamper=tamper)
        if tamper is None:
            return cp.load_bundle(final)
        return json.loads((final / "manifest.json").read_bytes()), final

    def test_bundle_inputs_runtime_and_restored_facts_are_recomputed(self):
        """CKPT-04 (RQC-02/03): mismatches refuse with zero daemon calls; runtime pins; only IDs may differ after a restore."""
        for checkpoint_id in cp.CHECKPOINTS:
            with self.subTest(consistent=checkpoint_id):
                manifest, directory = self.bundle(checkpoint_id)
                facts = self.admitted(cp.bundle_inputs, manifest, directory)
                self.assertEqual(facts["plan_sha256"], manifest["identity"]["plan_sha256"])
                self.assertEqual(facts["clone_b0_manifest_sha256"], manifest["identity"]["clone_b0_manifest_sha256"])

        def plan_changed(parts):
            descriptor = next(iter(parts["context"]["stacks"].values()))
            descriptor["plan_document"]["members"] = {"realm_members": 9, "disabled": 1, "service_accounts": 1}

        def plan_consistent_but_outside(parts):
            descriptor = next(iter(parts["context"]["stacks"].values()))
            descriptor["plan_document"]["backup_root"] = "/var/backups/elsewhere"
            descriptor["plan_sha256"] = intro.plan_identity(descriptor["plan_document"])
            parts["state"]["plan_sha256"] = descriptor["plan_sha256"]

        def b0_file(which):
            def change(parts):
                for path in parts["b0"]:
                    if path.parent.name == which:
                        parts["b0"][path] = b'{"b0":"altered"}\n'
            return change
        cases = {
            "the plan document differs from the identity": (plan_changed, "BUNDLE_INPUT_MISMATCH"),
            "the state names another plan": (lambda parts: parts["state"].update(plan_sha256="a" * 64), "BUNDLE_INPUT_MISMATCH"),
            "the target document differs": (lambda parts: next(iter(parts["context"]["stacks"].values()))["target"].update(project="other"),
                                            "BUNDLE_INPUT_MISMATCH"),
            "the source B0 manifest bytes differ": (b0_file("emr-b0-source"), "BUNDLE_INPUT_MISMATCH"),
            "the clone B0 manifest bytes differ": (b0_file("emr-b0-clone"), "BUNDLE_INPUT_MISMATCH"),
            "the context images differ": (lambda parts: parts["context"]["images"]["release"].update(api=image("e")), "BUNDLE_INPUT_MISMATCH"),
            "an unexpected context field": (lambda parts: parts["context"].update(extra={"plan": "dependent"}), "BUNDLE_INPUT_MISMATCH"),
            "a plan input outside the fixture root": (plan_consistent_but_outside, "BUNDLE_INPUT_MISMATCH"),
        }
        for name, (tamper, code) in cases.items():
            with self.subTest(refused=name):
                manifest, directory = self.bundle("introduced", tamper=tamper)
                if name == "a plan input outside the fixture root":
                    # The identity follows the changed (self-consistent) plan; only the outside path remains wrong.
                    plan = json.loads(cp.tree_member_bytes(directory / "payload" / "fixture-tree.tar", cp.CONTEXT_FILE))["stacks"]["clone"]
                    manifest = {**manifest, "identity": {**manifest["identity"], "plan_sha256": plan["plan_sha256"]}}
                    code = "PLAN_INPUT_OUTSIDE"
                self.assertRefused(code, cp.bundle_inputs, manifest, directory)
                backend = FakeBackend({role: PROJECT + "-" + role for role in intro.ROLES}, {}, running=set())
                backend.containers.clear()
                target_root = self.tempdir() / "restored"
                self.assertRefused(code, cp.restore_checkpoint, manifest, directory, backend=backend, fixture_root=target_root,
                                   names={role: PROJECT + "-" + role for role in intro.ROLES}, images_present=lambda image_id: True,
                                   observe=lambda sid: None)
                self.assertEqual(backend.calls, [], "nothing reached the daemon")
                self.assertFalse(target_root.exists(), "no fixture root was created")
        # CKPT2-04: every path a restore consumes, written as <root>/../elsewhere in an otherwise self-consistent bundle (plan,
        # target, state and identity agree), is outside after normalisation: refused before any daemon call or fixture root.
        # A '..' that stays inside is the normal control.

        def moved(field, inside=False):
            def change(parts):
                descriptor = next(iter(parts["context"]["stacks"].values()))
                root = str(Path(descriptor["root"]).parent)
                away = root + "/" + Path(descriptor["root"]).name + "/../" + Path(descriptor["root"]).name + "/backups" if inside \
                    else root + "/../outside-" + field.replace(" ", "-")
                plan, target = descriptor["plan_document"], descriptor["target"]
                if field == "plan backup_root":
                    plan["backup_root"] = away
                elif field == "plan seed b0_dir":
                    plan["seed"]["b0_dir"] = away
                elif field == "stack root":
                    descriptor["root"] = away
                elif field == "target repository":
                    target["repository"] = away
                elif field == "target ca_file":
                    target["ca_file"] = away + "/clone-ca.pem"
                elif field == "an absolute compose file":
                    target["compose_files"][-1] = away + "/rehearsal-override.yml"
                elif field == "a relative compose file":
                    target["compose_files"][0] = "../../../outside/docker-compose.yml"
                elif field == "a declared overlay":
                    target["declared_overlays"] = [{"file": away + "/overlay.yml", "sha256": "1" * 64, "service": "proxy", "binds": []}]
                elif field == "an overlay bind":
                    target["declared_overlays"] = [{"file": root + "/clone/overlay.yml", "sha256": "1" * 64, "service": "proxy",
                                                    "binds": [{"source": away, "target": "/etc/x", "read_only": True}]}]
                elif field == "the source B0":
                    parts["context"]["b0"]["dir"] = away
                elif field == "the seed's B0 copy":
                    parts["context"]["copy_dir"] = away
                elif field == "the clone B0":
                    parts["state"]["b0"]["dir"] = away
                plan["target_manifest_sha256"] = hashlib.sha256(intro.canonical(target)).hexdigest()
                descriptor["plan_sha256"] = intro.plan_identity(plan)
                parts["state"]["plan_sha256"] = descriptor["plan_sha256"]
            return change

        def consistent(manifest, directory):
            descriptor = json.loads(cp.tree_member_bytes(directory / "payload" / "fixture-tree.tar", cp.CONTEXT_FILE))["stacks"]["clone"]
            return {**manifest, "identity": {**manifest["identity"], "plan_sha256": descriptor["plan_sha256"],
                                             "target_manifest_sha256": descriptor["plan_document"]["target_manifest_sha256"]}}
        manifest, directory = self.bundle("introduced", tamper=moved("plan backup_root", inside=True))
        self.assertEqual(self.admitted(cp.bundle_inputs, consistent(manifest, directory), directory)["plan_sha256"],
                         consistent(manifest, directory)["identity"]["plan_sha256"], "a '..' that stays inside is accepted")
        for field in ("plan backup_root", "plan seed b0_dir", "stack root", "target repository", "target ca_file", "an absolute compose file",
                      "a relative compose file", "a declared overlay", "an overlay bind", "the source B0", "the seed's B0 copy", "the clone B0"):
            with self.subTest(escape=field):
                manifest, directory = self.bundle("introduced", tamper=moved(field))
                manifest = consistent(manifest, directory)
                self.assertRefused("PLAN_INPUT_OUTSIDE", cp.bundle_inputs, manifest, directory)
                backend = FakeBackend({role: PROJECT + "-" + role for role in intro.ROLES}, {}, running=set())
                backend.containers.clear()
                target_root = self.tempdir() / "restored"
                self.assertRefused("PLAN_INPUT_OUTSIDE", cp.restore_checkpoint, manifest, directory, backend=backend, fixture_root=target_root,
                                   names={role: PROJECT + "-" + role for role in intro.ROLES}, images_present=lambda image_id: True,
                                   observe=lambda sid: None)
                self.assertEqual(backend.calls, [], "no restore or create call reached the daemon")
                self.assertFalse(target_root.exists(), "no fixture root was created")
        # Runtime and module origins (observed, never declared).
        facts = {"python": "3.12.7", "docker_server": "27.0.3", "compose": "2.29.1", "playwright": "1.48.2",
                 "chromium": "chromium-1140", "arch": "x86_64"}
        root = self.tempdir("kin-source-")
        (root / "scripts").mkdir()
        (root / "tests").mkdir()
        module = root / "tests" / "probe_module.py"
        module.write_text("x = 1\n", encoding="utf-8")
        modules = {"probe": SimpleNamespace(__file__=str(module))}
        pinned = self.admitted(cp.runtime_identity, facts, modules=modules, root=root)
        self.assertEqual(pinned["modules"], {"probe": "tests/probe_module.py"})
        for key in cp.RUNTIME_KEYS:
            with self.subTest(unpinned=key):
                self.assertRefused("RUNTIME_UNPINNED", cp.runtime_identity, {**facts, key: ""}, modules=modules, root=root)
        outside = self.tempdir("kin-elsewhere-") / "probe_module.py"
        outside.write_text("x = 1\n", encoding="utf-8")
        self.assertRefused("RUNTIME_UNPINNED", cp.runtime_identity, facts, modules={"probe": SimpleNamespace(__file__=str(outside))}, root=root)
        (root / "scripts" / "__pycache__").mkdir()
        self.assertRefused("RUNTIME_UNPINNED", cp.runtime_identity, facts, modules=modules, root=root)
        # Restored product facts: only container IDs may differ, and their correspondence is recorded.
        recorded = {"containers": {role: {"id": "old-" + role, "image": image("1"), "running": True, "project": PROJECT,
                                          "mounts": [["/data", PROJECT + "_" + role, True]], "networks": [PROJECT + "_default"]}
                                   for role in intro.ROLES},
                    "migrations": [["0_init", "1" * 64, True, False]], "legacy": LEGACY, "realm": {"realm_members": 3},
                    "data": {"study": [{"uid": "1.2"}], "emr_roles": None}, "frame": {"instances": 1, "frame_sha256": "f" * 64}}
        observed = copy.deepcopy(recorded)
        for role in intro.ROLES:
            observed["containers"][role]["id"] = "new-" + role
        mapping = self.admitted(cp.restored_mapping, recorded, observed)
        self.assertEqual(mapping["container_ids"]["db"], {"checkpoint": "old-db", "restored": "new-db"})
        for name, change in (("legacy grants", lambda facts: facts["legacy"].update(database_acl="{}")),
                             ("realm members", lambda facts: facts["realm"].update(realm_members=2)),
                             ("frame bytes", lambda facts: facts["frame"].update(frame_sha256="0" * 64)),
                             ("study data", lambda facts: facts["data"]["study"].append({"uid": "9.9"})),
                             ("migrations", lambda facts: facts["migrations"].clear()),
                             ("a mount", lambda facts: facts["containers"]["db"]["mounts"].append(["/x", "other", True])),
                             ("an image", lambda facts: facts["containers"]["api"].update(image=image("6"))),
                             ("a running role", lambda facts: facts["containers"]["proxy"].update(running=False)),
                             ("a missing fact", lambda facts: facts.pop("frame"))):
            with self.subTest(refused=name):
                changed = copy.deepcopy(observed)
                if name == "legacy grants":
                    changed["legacy"] = dict(changed["legacy"])
                change(changed)
                self.assertRefused("RESTORE_MISMATCH", cp.restored_mapping, recorded, changed)


LAUNCHER = textwrap.dedent("""\
    # Runs one supervised browser command exactly as built: on POSIX the real /usr/bin/env -i argv; on Windows (no
    # /usr/bin/env) the same semantics - an environment of exactly the K=V assignments, plus SYSTEMROOT, without which a
    # Windows interpreter cannot start. stdin is closed, as the supervisor's is: the entry reads an empty spec.
    import json, os, re, subprocess, sys
    spec = json.loads(open(sys.argv[1], encoding="utf-8").read())
    argv, env = spec["argv"], None
    if os.name != "posix":
        assert argv[:2] == ["/usr/bin/env", "-i"], argv
        argv, env = argv[2:], {"SYSTEMROOT": os.environ["SYSTEMROOT"]}
        while argv and re.fullmatch(r"[A-Z_][A-Z0-9_]*=.*", argv[0]):
            key, _, value = argv.pop(0).partition("=")
            env[key] = value
    argv = [spec["interpreter"] if item == spec["alias"] else item for item in argv]
    sys.exit(subprocess.run(argv, env=env, stdin=subprocess.DEVNULL).returncode)
    """)


class CheckpointBytecodeTests(RefusalAssertions, TempCase):
    """CKPT2-02 (consult round3_acceptance): the product's supervised browser command (RELEASE-TOOLS-P3, RT-P3-PYCACHE:
    SystemdBrowser.command adds -B and PYTHONDONTWRITEBYTECODE; its own test_120) run against a frozen source copy, under
    the real recorder with the leaf's `--tree scripts`: the child imports the product and writes no bytecode into
    scripts/ or tests/, the input trees stay byte-identical, and the next runtime_identity and the index's input binding
    both pass. The policy's command without the product's -B (the control) writes a cache, which both refuse. The harness
    adds no -B of its own and relaxes no product check; only the host admission of the command (root, systemd with cgroup
    v2, protected paths) is given here, as test_120 gives it. The real browser and the following leaf stay T16 conditions."""

    class HostOs:
        """intro's `os` as a root systemd host shows it to SystemdBrowser.command; every other attribute is the real one."""
        name = "posix"

        @staticmethod
        def geteuid():
            return 0

        def __getattr__(self, attribute):
            return getattr(os, attribute)

    def frozen_source(self):
        root = self.tempdir("kin-frozen-")
        (root / "scripts").mkdir()
        (root / "tests").mkdir()
        for path in sorted((ROOT / "scripts").glob("ops_*.py")):
            shutil.copy2(path, root / "scripts" / path.name)
        for name in cp.LEAF_INPUT_FILES:
            shutil.copy2(ROOT / name, root / name)
        return root

    @staticmethod
    def tree(root):
        return {path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
                for folder in ("scripts", "tests") for path in sorted((root / folder).rglob("*")) if path.is_file()}

    def supervised(self, browsers):
        """The command the product's supervisor runs for the policy's browser argv (built by SystemdBrowser.command)."""
        alias = sys.executable if re.fullmatch(r"python(?:3(?:\.\d+)?)?", Path(sys.executable).name) else \
            str(Path(sys.executable).with_name("python3"))
        policy = ["/usr/bin/env", "PLAYWRIGHT_BROWSERS_PATH=" + browsers, alias, intro.__file__, "browser-smoke"]
        import ops_deploy_host
        host = {"/run/systemd/system", "/sys/fs/cgroup/cgroup.controllers"}
        real_dir, real_file = Path.is_dir, Path.is_file
        with patch.object(intro, "os", self.HostOs()), patch.object(ops_deploy_host, "protected"), \
                patch.object(Path, "is_dir", lambda path: path.as_posix() in host or real_dir(path)), \
                patch.object(Path, "is_file", lambda path: path.as_posix() in host or real_file(path)):
            command = intro.SystemdBrowser.command(policy)
        return command, policy, alias

    def recorded(self, source, argv, alias):
        """The child under the real recorder, from the frozen copy, with the leaf's input trees declared."""
        tool = str(source / "scripts" / Path(intro.__file__).name)
        spec = self.tempdir("kin-launch-") / "spec.json"
        spec.write_text(json.dumps({"argv": [tool if item == intro.__file__ else item for item in argv], "alias": alias,
                                    "interpreter": sys.executable}), encoding="utf-8")
        launcher = spec.with_name("launch.py")
        launcher.write_text(LAUNCHER, encoding="utf-8")
        run_dir = self.tempdir("kin-run-") / "run"
        completed = subprocess.run([sys.executable, "-B", str(RECORDER), "--run-dir", str(run_dir), "--cwd", str(source),
                                    "--tree", "scripts", "--tree", "tests", "--", sys.executable, "-B", str(launcher), str(spec)],
                                   capture_output=True, timeout=300)
        run = json.loads((run_dir / "run.json").read_bytes())
        stderr = (run_dir / "stderr.log").read_bytes()
        self.assertEqual(run.get("exit_code"), 1, completed.stderr[-2000:])
        self.assertIn(b'"valid": false', stderr, "the entry ran after its imports and refused the empty spec")
        return run

    def test_supervised_browser_child_keeps_the_frozen_source_admissible(self):
        """CKPT2-02 (RQC-03/09/12): child import through the real SystemdBrowser.command; no bytecode in scripts/tests,
        the same input trees, runtime_identity and the index's input binding pass; the control without -B is refused."""
        browsers = str(self.tempdir("kin-browsers-"))
        command, policy, alias = self.supervised(browsers)
        self.assertEqual(command[:2], ["/usr/bin/env", "-i"])
        self.assertIn("-B", command, "the product command itself carries -B (P3); the harness adds none")
        self.assertEqual([item for item in command if item in (alias, intro.__file__, "browser-smoke")], [alias, intro.__file__, "browser-smoke"])
        facts = {"python": "3.12.7", "docker_server": "27.0.3", "compose": "2.29.1", "playwright": "1.48.2", "chromium": "chromium-1140",
                 "arch": "x86_64"}

        def modules(source):
            return {"ops_emr_introduction": SimpleNamespace(__file__=str(source / "scripts" / "ops_emr_introduction.py")),
                    "ops_release_checkpoints": SimpleNamespace(__file__=str(source / "tests" / "ops_release_checkpoints.py"))}
        source = self.frozen_source()
        before = self.tree(source)
        self.admitted(cp.runtime_identity, facts, modules=modules(source), root=source)
        run = self.recorded(source, command, alias)
        self.assertEqual([path for path in source.rglob("__pycache__")], [], "the supervised child wrote no bytecode")
        self.assertEqual(self.tree(source), before, "the input trees are byte-identical after the child")
        self.assertEqual(cp.recorded_inputs(run, required_trees=cp.LEAF_INPUT_TREES), [], "the index's input binding passes")
        pinned = self.admitted(cp.runtime_identity, facts, modules=modules(source), root=source)
        self.assertEqual(pinned["modules"]["ops_emr_introduction"], "scripts/ops_emr_introduction.py")
        with self.subTest(control="the policy's command without the product's -B"):
            control = self.frozen_source()
            run = self.recorded(control, ["/usr/bin/env", "-i", "PATH=/usr/bin:/bin", "HOME=/nonexistent", *policy[1:]], alias)
            self.assertTrue(list((control / "scripts").rglob("__pycache__")), "the control writes bytecode beside the tool")
            self.assertTrue([reason for reason in cp.recorded_inputs(run, required_trees=cp.LEAF_INPUT_TREES)
                             if reason.startswith("input appeared during the run: scripts/__pycache__")])
            self.assertRefused("RUNTIME_UNPINNED", cp.runtime_identity, facts, modules=modules(control), root=control)


class CheckpointLeafTests(RefusalAssertions, TempCase):
    """CKPT-03: the end of a leaf without a bundle (late success / expected STOP): raw records preserved under the
    secrets policy before the fixture goes, parent and current identities apart, manifest vs payload SHA, parent chain."""

    def records(self, fixture):
        records = fixture / "clone" / "records"
        (records / "logs").mkdir(parents=True)
        (records / "state.json").write_bytes(b'{"status":"VERIFIED"}\n')
        (records / "journal.jsonl").write_bytes(b'{"event":"phase-start","phase":"reopen"}\n')
        (records / "result-verify-0001.json").write_bytes(b'{"phase":"verify","status":"VERIFIED","steps":[{"step":"L-10a","outcome":"PASS"}]}\n')
        (records / "logs" / "step-L-11a.log").write_bytes(b"backup readiness: STOP\n")
        (records / intro.COMPOSE_VALUES).write_bytes(SECRET_VALUE.encode())
        (records / "smoke-member-kin-smoke-1.json").write_bytes(SECRET_VALUE.encode())
        secrets = fixture / "clone" / "records.secrets"
        secrets.mkdir()
        (secrets / "smoke-member.json").write_bytes(SECRET_VALUE.encode())
        return records

    def test_raw_records_identities_and_parent_chain_survive_a_bundleless_leaf(self):
        """CKPT-03 (RQC-11): preserve -> re-hash inputs -> remove the fixture only when passed -> one announced segment."""
        output = self.tempdir("kin-leaf-out-")
        store = cp.BundleStore(output / "bundles")
        grand = seal(self, store.root, "held")
        grand_manifest, grand_dir = cp.load_bundle(grand)
        parent = seal(self, store.root, "introduced", parent=cp.parent_reference(grand_manifest, grand_dir))
        parent_manifest, parent_dir = cp.load_bundle(parent)
        reference = cp.parent_reference(parent_manifest, parent_dir)
        self.assertEqual(reference["manifest_sha256"], hashlib.sha256((parent / "manifest.json").read_bytes()).hexdigest())
        self.assertEqual(reference["manifest_sha256"], parent.name)
        self.assertEqual(reference["payload_manifest_sha256"], parent_manifest["identity"]["payload_manifest_sha256"])
        self.assertNotEqual(reference["manifest_sha256"], reference["payload_manifest_sha256"])
        self.assertEqual(parent_manifest["parent"]["manifest_sha256"], grand.name, "a child names its parent's manifest SHA")
        chain = cp.parent_chain(store.root, parent.name)
        self.assertEqual([(link["manifest_sha256"], link["checkpoint"]) for link in chain], [(parent.name, "introduced"), (grand.name, "held")])
        with self.subTest(refused="a missing ancestor"):
            other = self.tempdir() / "bundles"
            shutil.copytree(parent, other / parent.name)
            self.assertRefused("CHAIN_BROKEN", cp.parent_chain, other, parent.name)
        source_root = CheckpointIdentityTests.source_repo(self)
        inputs = cp.inputs_summary(source_root)
        now = datetime.now(timezone.utc).isoformat()
        current = cp.current_identity(inputs, execution_kind="checkpoint-resume", plan_sha256=parent_manifest["identity"]["plan_sha256"],
                                      root=source_root, resumed_utc=now)
        identity = cp.segment_identity(current, parent_manifest=parent_manifest, parent_dir=parent_dir)
        self.assertEqual(identity["parent"], parent_manifest["identity"])
        self.assertEqual((identity["current"]["resumed_utc"], identity["current"]["tool_tree_sha256_at_resume"]), (now, inputs["tool"]))
        self.assertIsNone(identity["parent"]["resumed_utc"], "the parent identity is never reported as this leaf's resume")
        self.assertRefused("TIME_INVALID", cp.current_identity, inputs, execution_kind="diagnostic-fork", plan_sha256=None, root=source_root)
        request = {"unit": "release-tools-checkpoints-proof-late-fault", "case": "CheckpointSegments.test_original_late_fault",
                   "stage": "forward-tail", "scenario": "forward", "execution_kind": "checkpoint-resume"}

        def close(fixture, evidence, *, passed=True, inputs_before=inputs):
            records = self.records(fixture)
            before = {"clone": set()}
            (records / "result-reopen-0002.json").write_bytes(
                b'{"phase":"reopen","status":"VERIFIED","steps":[{"step":"L-11a","outcome":"STOP"}]}\n')
            before["clone"] = {"result-verify-0001.json"}
            printed = io.StringIO()
            with contextlib.redirect_stdout(printed):
                record, path = cp.close_leaf(
                    None, request=request, request_sha256="a" * 64, marker={"unit": request["unit"]}, identity=identity,
                    executed=["reopen"], inherited=["capture", "seed", "capture", "introduce", "verify"],
                    phase_rows=cp.phase_results({"clone": records}, before), results={}, admission=None,
                    cleanup={"complete": True, "removed": [], "remaining": [], "errors": []}, observed={"outcome": "STOP", "step": "L-11a"},
                    expected={"outcome": "STOP", "step": "L-11a"}, records={"clone": records}, evidence=evidence, fixture_root=fixture,
                    output_root=output, source_root=source_root, inputs_before=inputs_before, run_json="/x/run.json", started_utc=now,
                    selected_tests=[request["case"]], passed=passed, chain=chain)
            return record, path, printed.getvalue()
        fixture, evidence = output / "fixture", self.tempdir("kin-leaf-evidence-") / "late-fault"
        record, path, printed = close(fixture, evidence)
        self.assertTrue(record["passed"])
        self.assertFalse(fixture.exists(), "a passed leaf removes its private fixture - after preserving its records")
        preserved = {item.relative_to(evidence).as_posix(): item.read_bytes() for item in evidence.rglob("*") if item.is_file()}
        self.assertIn("records-clone/journal.jsonl", preserved, "the raw records are preserved before the fixture is removed")
        self.assertEqual(preserved["records-clone/journal.jsonl"], b'{"event":"phase-start","phase":"reopen"}\n')
        self.assertIn("records-clone/result-reopen-0002.json", preserved)
        self.assertIn("records-clone/logs/step-L-11a.log", preserved)
        self.assertFalse([name for name in preserved if intro.COMPOSE_VALUES in name or "smoke-member" in name], preserved.keys())
        self.assertFalse([name for name, raw in preserved.items() if SECRET_VALUE.encode() in raw], "no private value in the evidence")
        rows = {name: digest for name, digest in record["raw_records"]}
        self.assertEqual(set(rows), set(preserved) - {"segment.json"})
        self.assertTrue(all(hashlib.sha256(preserved[name]).hexdigest() == digest for name, digest in rows.items()))
        self.assertEqual([(row["phase"], row["status"], row["steps"]) for row in record["phase_results"]], [("reopen", "VERIFIED", [["L-11a", "STOP"]])])
        self.assertEqual(record["parent_chain"], chain)
        self.assertEqual(record["identity"]["parent_reference"]["manifest_sha256"], parent.name)
        self.assertTrue(record["inputs_unchanged"])
        announced = json.loads(printed.strip().splitlines()[-1])
        self.assertEqual((announced["segment"], announced["sha256"]), (str(path), hashlib.sha256(path.read_bytes()).hexdigest()))
        with self.assertRaises(FileExistsError):
            cp.finish_segment(None, passed=True, segment={}, evidence_root=evidence)
        with self.subTest(kept="a failed leaf keeps its fixture for inspection but still preserves its records"):
            fixture, evidence = output / "fixture-failed", self.tempdir("kin-leaf-evidence-") / "failed"
            record, _, _ = close(fixture, evidence, passed=False)
            self.assertFalse(record["passed"])
            self.assertTrue(fixture.exists())
            self.assertTrue((evidence / "records-clone" / "journal.jsonl").is_file())
        with self.subTest(kept="inputs that changed during the leaf fail it"):
            fixture, evidence = output / "fixture-changed", self.tempdir("kin-leaf-evidence-") / "changed"
            record, _, _ = close(fixture, evidence, inputs_before={**inputs, "tool": "0" * 64})
            self.assertFalse(record["passed"])
            self.assertFalse(record["inputs_unchanged"])
            self.assertTrue(fixture.exists())


class CheckpointLineageTests(RefusalAssertions, TempCase):
    """CKPT-06: the nine leaves' parent map, requests resolved from BOUND parent indices, lineage refused before any
    restore, and the generated Linux command sequence with every recorder input."""

    def proof(self):
        root = self.tempdir("kin-proof-")
        leaves = [dict(leaf) for leaf in cp.DEFAULT_PROOF_LEAVES]
        (root / "registry.json").write_bytes(cp.canonical(leaves) + b"\n")
        for source in ("a", "b", "c"):
            (root / (source + ".source-manifest.json")).write_bytes(cp.canonical({"root": str(root / source), "source": source}) + b"\n")
        store = root / "out" / "bundles"
        sealed = {name: seal(self, store, name) for name in ("introduced", "verified")}
        return root, leaves, sealed

    def bound(self, root, unit):
        """r7: a parent leaf's BOUND index as `index` writes it over really recorded evidence (CheckpointRecordTests.layout:
        its raw records, capture observation and writable-layer record, and the real sealed bundle in <root>/out/bundles),
        which every consumption judges again. Returns the sealed bundle."""
        records = CheckpointRecordTests(methodName="test_existing_record_run_binds_exact_inputs_outputs_and_exit")
        records.tempdir = self.tempdir
        proof = records.layout(unit, root=root)
        run_dir, completed = records.record(proof)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(cp.main(["index", "--registry", str(root / "registry.json"), "--unit", unit, "--proof-root", str(root),
                                      "--run-dir", str(run_dir)]), 0)
        return Path(proof.results["checkpoint"]["path"])

    def bind(self, root, unit, bundle, *, verdict="BOUND"):
        """A parent leaf's index as `index` writes it, over a segment that names the bundle it sealed. Its evidence is not
        recorded: since r7 every consumption judges a BOUND index's evidence again, so such an index is a refused one."""
        segment = root / "evidence" / unit / "attempt-1" / "segment.json"
        segment.parent.mkdir(parents=True)
        segment.write_bytes(cp.canonical({"results": {"checkpoint": {"path": str(bundle), "manifest_sha256": bundle.name}}}) + b"\n")
        run_dir = root / "runs" / (unit + "-1")
        run_dir.mkdir(parents=True)
        logs = {}
        for name in ("run.json", "stdout.log", "stderr.log"):
            (run_dir / name).write_bytes(("synthetic " + name + "\n").encode())
            logs[name] = hashlib.sha256((run_dir / name).read_bytes()).hexdigest()
        manifest = bundle / "manifest.json"
        (root / "index").mkdir(exist_ok=True)
        (root / "index" / (unit + ".json")).write_bytes(cp.canonical({
            "verdict": verdict, "unit": unit, "segment": str(segment), "segment_sha256": hashlib.sha256(segment.read_bytes()).hexdigest(),
            "run_dir": str(run_dir), "run_json_sha256": logs.pop("run.json"), "logs": logs,
            "raw": {"evidence": str(segment.parent), "files": [], "plans": {}, "admission": None,
                    "checkpoint": {"path": str(manifest), "sha256": hashlib.sha256(manifest.read_bytes()).hexdigest()}}}) + b"\n")
        return segment

    def test_parent_map_requests_and_commands_are_fixed_before_restore(self):
        """CKPT-06 (RQC-06/12): source->seed->capture->introduce->verify on A, verified->late-fault, introduced->late-resume
        (B) and early-refusal (C), a parentless fresh control; wrong maps, parents and lineages refuse."""
        leaves = cp.registry_valid([dict(leaf) for leaf in cp.DEFAULT_PROOF_LEAVES])
        unit = lambda suffix: "release-tools-checkpoints-proof-" + suffix
        self.assertEqual({leaf["unit"][len(unit("")):]: (leaf["source"], leaf["parent"] and leaf["parent"][len(unit("")):],
                                                         cp.STAGES[leaf["stage"]]["consumes"] if leaf["stage"] else None) for leaf in leaves},
                         {"prefix-source": ("a", None, None), "prefix-seed": ("a", "prefix-source", "source-b0"),
                          "prefix-capture": ("a", "prefix-seed", "seeded"), "prefix-introduce": ("a", "prefix-capture", "held"),
                          "prefix-verify": ("a", "prefix-introduce", "introduced"), "late-fault": ("a", "prefix-verify", "verified"),
                          "late-resume": ("b", "prefix-introduce", "introduced"), "fresh-control": ("b", None, None),
                          "early-refusal": ("c", "prefix-introduce", "introduced")})
        self.assertEqual(cp.leaf_phases(cp.registry_leaf(leaves, unit("late-fault"))), (["reopen"], ["capture", "seed", "capture", "introduce", "verify"]))
        self.assertEqual(cp.leaf_phases(cp.registry_leaf(leaves, unit("late-resume"))), (["verify", "reopen"], ["capture", "seed", "capture", "introduce"]))
        self.assertEqual(cp.leaf_phases(cp.registry_leaf(leaves, unit("early-refusal"))), ([], ["capture", "seed", "capture", "introduce"]))
        self.assertEqual(cp.leaf_phases(cp.registry_leaf(leaves, unit("fresh-control")))[0],
                         ["capture", "seed", "capture", "introduce", "verify", "reopen"])
        self.assertEqual([cp.leaf_produces(cp.registry_leaf(leaves, unit(name))) for name in ("prefix-verify", "late-fault", "late-resume")],
                         ["verified", None, None])
        wrong = {"late-resume takes the previous leaf (verified)": (unit("late-resume"), {"parent": unit("prefix-verify")}),
                 "late-fault takes introduced": (unit("late-fault"), {"parent": unit("prefix-introduce")}),
                 "a fresh control with a parent": (unit("fresh-control"), {"parent": unit("prefix-verify")}),
                 "a fork from the same source copy": (unit("late-resume"), {"source": "a"}),
                 "a resume from another source copy": (unit("prefix-capture"), {"source": "b"}),
                 "an unregistered parent": (unit("prefix-seed"), {"parent": unit("prefix-elsewhere")}),
                 "a proof case as a parent": (unit("early-refusal"), {"parent": unit("late-resume")})}
        for name, (target, change) in wrong.items():
            with self.subTest(refused=name):
                self.assertRefused("REGISTRY_INVALID", cp.registry_valid, [dict(leaf, **change) if leaf["unit"] == target else dict(leaf)
                                                                           for leaf in leaves])
        with self.subTest(refused="a parent listed after its child"):
            self.assertRefused("REGISTRY_INVALID", cp.registry_valid, [leaves[1], leaves[0], *leaves[2:]])
        root, leaves, sealed = self.proof()
        with self.subTest(refused="no BOUND parent index yet"):
            self.assertRefused("PARENT_UNBOUND", cp.leaf_request, leaves, unit("late-resume"), root)
        introduced = self.bound(root, unit("prefix-introduce"))
        for name, source in (("late-resume", "b"), ("early-refusal", "c"), ("prefix-verify", "a")):
            with self.subTest(request=name):
                request = self.admitted(cp.leaf_request, leaves, unit(name), root)
                self.assertEqual(request["parent_manifest"], {"path": str((introduced / "manifest.json").resolve()), "sha256": introduced.name})
                self.assertEqual(Path(request["source_manifest"]["path"]).name, source + ".source-manifest.json")
                self.assertEqual((request["output_root"], request["evidence_root"]),
                                 (str((root / "out").resolve()), str((root / "evidence" / unit(name) / "attempt-1").resolve())))
                path = root / ("request-" + unit(name) + ".json")
                path.write_bytes(cp.canonical(request) + b"\n")
                loaded, _ = self.admitted(cp.load_request, str(path), leaves, case=request["case"])
                self.assertEqual(loaded["unit"], unit(name))
        self.assertRefused("REQUEST_INVALID", cp.leaf_request, leaves, unit("fresh-control"), root)
        self.bind(root, unit("prefix-verify"), sealed["introduced"])
        with self.subTest(refused="a parent index whose leaf sealed another checkpoint"):
            self.assertRefused("PARENT_UNBOUND", cp.leaf_request, leaves, unit("late-fault"), root)
        with self.subTest(refused="a parent segment changed after its index"):
            segment = root / "evidence" / unit("prefix-introduce") / "attempt-1" / "segment.json"
            segment.write_bytes(segment.read_bytes().replace(b"}\n", b" }\n"))
            self.assertRefused("PARENT_UNBOUND", cp.leaf_request, leaves, unit("late-resume"), root)
        with self.subTest(refused="an UNVERIFIED parent index"):
            other, other_leaves, other_sealed = self.proof()
            self.bind(other, unit("prefix-introduce"), other_sealed["introduced"], verdict="UNVERIFIED")
            self.assertRefused("PARENT_UNBOUND", cp.leaf_request, other_leaves, unit("late-resume"), other)
        # load_request: the parent's checkpoint kind, lineage, derived flag and store, before anything is restored.
        late_resume = cp.registry_leaf(leaves, unit("late-resume"))
        good = {"schema": 1, "unit": late_resume["unit"], "case": late_resume["case"], "scenario": "forward", "stage": "verify",
                "execution_kind": "diagnostic-fork", "source_manifest": {"path": str(root / "b.source-manifest.json"),
                                                                         "sha256": hashlib.sha256((root / "b.source-manifest.json").read_bytes()).hexdigest()},
                "output_root": str(root / "out"), "evidence_root": str(root / "evidence" / "lineage")}

        def reference(bundle):
            return {"path": str(bundle / "manifest.json"), "sha256": bundle.name}
        outside = self.tempdir() / "bundles" / sealed["introduced"].name
        shutil.copytree(sealed["introduced"], outside)
        derived = seal(self, root / "out" / "bundles", "introduced", derived=True)
        for name, parent in (("the verified checkpoint for a verify stage", reference(sealed["verified"])),
                             ("a copy outside the request's store", reference(outside)), ("a derived bundle", reference(derived))):
            with self.subTest(refused=name):
                path = root / "request-lineage.json"
                path.write_bytes(cp.canonical({**good, "parent_manifest": parent}) + b"\n")
                self.assertRefused("REQUEST_INVALID", cp.load_request, str(path), leaves, case=late_resume["case"])
        path = root / "request-lineage.json"
        path.write_bytes(cp.canonical({**good, "parent_manifest": reference(sealed["introduced"])}) + b"\n")
        self.admitted(cp.load_request, str(path), leaves, case=late_resume["case"])
        # The generated sequence: every leaf in order, its source copy, request and recorder inputs; the fresh control
        # through its existing selector with no request, its own evidence folder and the same recorder inputs.
        script = cp.proof_commands(leaves, proof_root="/srv/proof", candidate="/srv/candidate")
        lines = script.splitlines()
        self.assertEqual([line.split(" --out ")[1] for line in lines if " source-copy " in line],
                         ["/srv/proof/a --mutant backup-readiness-stop", "/srv/proof/b", "/srv/proof/c --mutant prepare-change"])
        runs = [line for line in lines if "scripts/record-run.py" in line]
        self.assertEqual(len(runs), 9)
        for leaf, line in zip(leaves, runs):
            with self.subTest(command=leaf["unit"]):
                self.assertIn("(cd /srv/proof/" + leaf["source"] + " && env ", line)
                self.assertIn("--run-dir /srv/proof/runs/" + leaf["unit"] + "-1 ", line)
                for name in ["/srv/proof/plan-" + leaf["unit"] + ".json", "/srv/proof/registry.json",
                             "/srv/proof/" + leaf["source"] + ".source-manifest.json", *cp.LEAF_INPUT_FILES]:
                    self.assertIn("--file " + name + " ", line)
                self.assertIn("--tree scripts -- python3 -B scripts/run-tests.py --plan /srv/proof/plan-" + leaf["unit"] + ".json)", line)
                if leaf["stage"] is None:
                    self.assertIn("env -u KIN_TEST_EMR_CHECKPOINT_REQUEST -u KIN_TEST_EMR_CHECKPOINTS KIN_TEST_EMR_REHEARSAL=1 "
                                  "KIN_TEST_EMR_REHEARSAL_EVIDENCE=/srv/proof/evidence/" + leaf["unit"] + "/attempt-1 ", line)
                    self.assertNotIn("request-", line)
                else:
                    self.assertIn("KIN_TEST_EMR_CHECKPOINT_REQUEST=/srv/proof/request-" + leaf["unit"] + "-1.json ", line)
                    self.assertIn("--file /srv/proof/request-" + leaf["unit"] + "-1.json ", line)
                    self.assertEqual("parent-manifest --request" in line, leaf["parent"] is not None)
                    self.assertIn(" request --registry /srv/proof/registry.json --unit " + leaf["unit"] + " --attempt 1 --proof-root /srv/proof "
                                  "--out /srv/proof/request-" + leaf["unit"] + "-1.json", script)
                self.assertIn("index --registry /srv/proof/registry.json --unit " + leaf["unit"] + " --attempt 1 --proof-root /srv/proof --run-dir "
                              "/srv/proof/runs/" + leaf["unit"] + "-1", script)
        order = [script.index("# " + leaf["unit"] + " (attempt 1):") for leaf in leaves]
        self.assertEqual(order, sorted(order))
        self.assertTrue(lines[-1].endswith("compare --registry /srv/proof/registry.json --proof-root /srv/proof"))
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(cp.main(["commands", "--registry", str(self.tempdir() / "registry.json"), "--proof-root", str(root),
                                      "--candidate", "/srv/candidate"]), 2, "the registry is the one frozen in the proof root")
        expectation = cp.leaf_expectation(leaves, unit("fresh-control"), self.fresh_layout(root, leaves))
        self.assertEqual(expectation["expected_tests"], ["ops_deploy_host_container_test." + cp.FRESH_CASES["forward"]])
        self.assertEqual((expectation["expect"]["fresh_e2e"], expectation["expect"]["forward_verdict"], expectation["expect"]["request_sha256"]),
                         (True, True, None))
        self.assertFalse([name for name in expectation["required_files"] if "request-" in name])
        self.assertEqual(expectation["segment_path"], root / "evidence" / unit("fresh-control") / "attempt-1" / "segment.json")

    @staticmethod
    def tree_hashes(root):
        return {path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(Path(root).rglob("*"))
                if path.is_file()}

    def leaf_output(self, evidence, *, passed, attempt):
        """What a leaf leaves in its evidence root (the close_leaf writers): its preserved raw records and one segment."""
        records = self.tempdir("kin-records-") / "records"
        (records / "logs").mkdir(parents=True)
        (records / "state.json").write_bytes(b'{"attempt":%d}\n' % attempt)
        (records / "logs" / "step.log").write_bytes(b"attempt %d\n" % attempt)
        rows = cp.preserve_records({"clone": records}, evidence)
        cp.finish_segment(None, passed=passed, segment={"attempt": attempt, "raw_records": rows}, evidence_root=evidence)

    def test_retry_attempts_keep_unit_plan_parent_and_earlier_raw_bytes(self):
        """CKPT2-06 (RQC-06/11): an allowed retry keeps the unit, its gate plan file, its parent and the gate ledger; only its
        request, run folder and evidence root are new; commands, request and index select the same attempt; the source
        copies and the BOUND prefix are not made or run again; the earlier attempt's raw bytes stay as they were, for a
        checkpoint leaf and for the fresh control; reuse is refused before anything is overwritten; an interrupted attempt
        is never retried on an inspection alone."""
        name = "release-tools-checkpoints-proof-late-resume"
        root, leaves, sealed = self.proof()
        self.fresh_layout(root, leaves)
        self.bound(root, "release-tools-checkpoints-proof-prefix-introduce")
        (root / ("plan-" + name + ".json")).write_bytes(cp.canonical(cp.leaf_plan(leaves, name)) + b"\n")
        first, second = cp.attempt_paths(root, name, 1), cp.attempt_paths(root, name, 2)
        request = self.admitted(cp.leaf_request, leaves, name, root)
        self.assertEqual(Path(request["evidence_root"]), first["evidence"].resolve())
        first["request"].write_bytes(cp.canonical(request) + b"\n")
        loaded, _ = self.admitted(cp.load_request, str(first["request"]), leaves, case=request["case"])
        # Attempt 1 runs and fails: its run folder, raw records and segment.
        first["run"].mkdir(parents=True)
        (first["run"] / "stdout.log").write_bytes(b"attempt 1\n")
        self.leaf_output(first["evidence"], passed=False, attempt=1)
        state = self.tempdir("kin-gate-state-")
        (state / (name + ".json")).write_text(json.dumps({"attempts": [{"status": "failed", "attempt": 1}], "max_attempts": 3}))
        (state / "live-needs-inspection.json").write_text("{}")
        with self.subTest(refused="the failed run's marker is not released yet"):
            self.assertRefused("RETRY_REFUSED", cp.retry_admission, state, leaves, name, 2, root)
        (state / "live-needs-inspection.json").unlink()
        with self.subTest(refused="the failed attempt's kept fixture root is not cleared yet"):
            (root / "out" / "fixture").mkdir()
            self.assertRefused("RETRY_REFUSED", cp.retry_admission, state, leaves, name, 2, root)
            (root / "out" / "fixture").rmdir()
        for label, ledger, code in (("an interrupted attempt (inspection alone never reopens it)", ["interrupted"], "RETRY_REFUSED"),
                                    ("an earlier interrupted attempt", ["interrupted", "failed"], "RETRY_REFUSED"),
                                    ("a passed unit", ["passed"], "RETRY_REFUSED"), ("a running attempt", ["running"], "RETRY_REFUSED"),
                                    ("the budget", ["failed", "failed", "failed"], "RETRY_REFUSED")):
            with self.subTest(refused=label):
                other = self.tempdir("kin-gate-state-")
                (other / (name + ".json")).write_text(json.dumps({"attempts": [{"status": status} for status in ledger], "max_attempts": 3}))
                self.assertRefused(code, cp.retry_admission, other, leaves, name, 2, root)
        with self.subTest(refused="attempt 3 before attempt 2"):
            self.assertRefused("RETRY_REFUSED", cp.retry_admission, state, leaves, name, 3, root)
        with self.subTest(refused="attempt 1 named again"):
            self.assertRefused("EVIDENCE_EXISTS", cp.leaf_request, leaves, name, root)
            self.assertRefused("EVIDENCE_EXISTS", cp.load_request, str(first["request"]), leaves, case=request["case"])
        before = self.tree_hashes(root)
        admitted = self.admitted(cp.retry_admission, state, leaves, name, 2, root)
        self.assertEqual(admitted["ledger"], ["failed"])
        retried = self.admitted(cp.leaf_request, leaves, name, root, 2)
        self.assertEqual({key: retried[key] for key in ("unit", "case", "parent_manifest", "source_manifest", "output_root")},
                         {key: loaded[key] for key in ("unit", "case", "parent_manifest", "source_manifest", "output_root")},
                         "the same unit, parent, source copy and bundle store")
        self.assertEqual(Path(retried["evidence_root"]), second["evidence"].resolve())
        second["request"].write_bytes(cp.canonical(retried) + b"\n")
        self.admitted(cp.load_request, str(second["request"]), leaves, case=request["case"])
        second["run"].mkdir(parents=True)
        self.leaf_output(second["evidence"], passed=True, attempt=2)
        after = self.tree_hashes(root)
        self.assertEqual({key: after.get(key) for key in before}, before, "every earlier byte (attempt 1, plan, registry, parent) is unchanged")
        new = sorted(set(after) - set(before))
        prefixes = [path.relative_to(root).as_posix() for path in (second["request"], second["run"], second["evidence"])]
        self.assertTrue(new and all(any(item == prefix or item.startswith(prefix + "/") for prefix in prefixes) for item in new), new)
        self.assertRefused("EVIDENCE_EXISTS", cp.retry_admission, state, leaves, name, 2, root)
        # The index selects the attempt the request names, and the attempt's own run folder.
        expectation = cp.leaf_expectation(leaves, name, root, 2)
        self.assertEqual(expectation["segment_path"], second["evidence"] / "segment.json")
        self.assertEqual(cp.leaf_expectation(leaves, name, root, 1)["segment_path"], first["evidence"] / "segment.json")
        self.assertRefused("INDEX_INPUT", cp.leaf_index, leaves, name, root, first["run"], 2)
        second["request"].write_bytes(cp.canonical({**retried, "evidence_root": request["evidence_root"]}) + b"\n")
        self.assertRefused("INDEX_INPUT", cp.leaf_expectation, leaves, name, root, 2)
        # The generated retry: no source copy, no earlier leaf, the same plan file, the attempt's request/run/evidence.
        script = cp.proof_commands(leaves, proof_root="/srv/proof", candidate="/srv/candidate", from_unit=name, attempt=2)
        self.assertNotIn(" source-copy ", script)
        self.assertFalse([leaf["unit"] for leaf in leaves[:[item["unit"] for item in leaves].index(name)] if leaf["unit"] + " " in script])
        retry = script.index(" retry --registry /srv/proof/registry.json --unit " + name + " --attempt 2 --proof-root /srv/proof")
        self.assertLess(retry, script.index("# " + name + " (attempt 2)"))
        self.assertIn("test -f /srv/proof/plan-" + name + ".json", script)
        self.assertNotIn(" plan --registry /srv/proof/registry.json --unit " + name + " ", script)
        self.assertIn(" request --registry /srv/proof/registry.json --unit " + name + " --attempt 2 --proof-root /srv/proof --out "
                      "/srv/proof/request-" + name + "-2.json", script)
        self.assertIn("KIN_TEST_EMR_CHECKPOINT_REQUEST=/srv/proof/request-" + name + "-2.json ", script)
        self.assertIn("--run-dir /srv/proof/runs/" + name + "-2 ", script)
        self.assertIn(" index --registry /srv/proof/registry.json --unit " + name + " --attempt 2 --proof-root /srv/proof --run-dir "
                      "/srv/proof/runs/" + name + "-2", script)
        for later in ("release-tools-checkpoints-proof-fresh-control", "release-tools-checkpoints-proof-early-refusal"):
            self.assertIn(" plan --registry /srv/proof/registry.json --unit " + later + " --out", script)
            self.assertIn("--run-dir /srv/proof/runs/" + later + "-1 ", script)
        fresh = "release-tools-checkpoints-proof-fresh-control"
        self.assertIn("KIN_TEST_EMR_REHEARSAL_EVIDENCE=/srv/proof/evidence/" + fresh + "/attempt-3 ",
                      cp.proof_commands(leaves, proof_root="/srv/proof", candidate="/srv/candidate", from_unit=fresh, attempt=3))
        for kwargs in ({"from_unit": name, "attempt": 1}, {"from_unit": name, "attempt": 4}, {"attempt": 2}, {"from_unit": "unregistered", "attempt": 2}):
            with self.subTest(refused=str(kwargs)):
                self.assertRefused("REGISTRY_INVALID", cp.proof_commands, leaves, proof_root="/srv/proof", candidate="/srv/candidate", **kwargs)
        # The fresh control: an existing evidence folder is refused before any stage; a retry writes a new folder only.
        import ops_deploy_host_container_test as rehearsal

        class Probe(rehearsal.RehearsalStages, unittest.TestCase):
            def runTest(self):
                pass

            def rehearsal_context(self, prefix, root=None):
                raise AssertionError("no stage may start")
        probe = Probe()
        fresh_first, fresh_second = cp.attempt_paths(root, fresh, 1)["evidence"], cp.attempt_paths(root, fresh, 2)["evidence"]
        records = self.tempdir("kin-fresh-records-") / "records"
        (records / "logs").mkdir(parents=True)
        (records / "state.json").write_bytes(b'{"fresh":1}\n')
        (records / "result-capture-0001.json").write_bytes(b'{"phase":"capture"}\n')
        stack = SimpleNamespace(records=SimpleNamespace(directory=records), label="clone")
        gate_state = self.tempdir("kin-fresh-gate-")
        inputs = {"tool": "1" * 64, "source": "2" * 64, "harness": "3" * 64, "tool_files": {}}
        with patch.object(gate, "STATE", gate_state), patch.object(cp, "inputs_summary", lambda root: inputs), \
                contextlib.redirect_stdout(io.StringIO()):
            for evidence in (fresh_first, fresh_second):
                with patch.dict(os.environ, {"KIN_TEST_EMR_REHEARSAL_EVIDENCE": str(evidence)}):
                    rehearsal.SyntheticStack.keep_records(stack)
                    with self.assertRaises(FileExistsError, msg="raw records are copied once, never over an earlier copy"):
                        rehearsal.SyntheticStack.keep_records(stack)
                with self.assertRaises(RuntimeError):
                    with gate.live_run(unit=fresh, module=cp.REHEARSAL_FILE, plan_sha256="a" * 64, attempt=1 if evidence == fresh_first else 2):
                        with self.assertRaises(AssertionError):   # no owned stack was observed: the fresh segment fails
                            probe.fresh_segment({"scenario": "forward", "evidence": evidence, "executed": [], "passed": False, "owned": [],
                                                 "started": datetime.now(timezone.utc).isoformat(), "inputs_before": inputs})
                        raise RuntimeError("the failed fresh attempt keeps its marker")
                (gate_state / "live-needs-inspection.json").unlink()
                if evidence == fresh_first:
                    fresh_before = self.tree_hashes(fresh_first)
        self.assertEqual(self.tree_hashes(fresh_first), fresh_before, "the first fresh attempt's raw records and segment are unchanged")
        self.assertTrue((fresh_second / "segment.json").is_file() and (fresh_second / "records-clone" / "state.json").is_file())
        for evidence in (fresh_first, fresh_second):
            with self.subTest(refused="fresh evidence reused: " + evidence.name):
                snapshot = self.tree_hashes(evidence)
                with patch.dict(os.environ, {"KIN_TEST_EMR_REHEARSAL_EVIDENCE": str(evidence)}):
                    os.environ.pop(cp.REQUEST_ENV, None)
                    self.assertRefused("EVIDENCE_EXISTS", probe.run_fresh, "forward")
                self.assertEqual(self.tree_hashes(evidence), snapshot)
        with patch.dict(os.environ, {"KIN_TEST_EMR_REHEARSAL_EVIDENCE": str(cp.attempt_paths(root, fresh, 3)["evidence"])}):
            os.environ.pop(cp.REQUEST_ENV, None)
            with self.assertRaises(gate.Refused, msg="a new folder passes to the live permission, still before any stage"):
                probe.run_fresh("forward")
        self.assertFalse(cp.attempt_paths(root, fresh, 3)["evidence"].exists())

    def fresh_layout(self, root, leaves):
        name = "release-tools-checkpoints-proof-fresh-control"
        (root / ("plan-" + name + ".json")).write_bytes(cp.canonical(cp.leaf_plan(leaves, name)) + b"\n")
        (root / "b.source-manifest.json").write_bytes(cp.canonical({"root": str(root / "b"), "tool": {"sha256": "1" * 64},
                                                                     "source": {"sha256": "2" * 64}, "harness": {"sha256": "3" * 64}}) + b"\n")
        return root


def git(*args, cwd=None, check=True):
    """The real git, with a fixed identity so a commit needs no account configuration (on the bounded path, so the native
    smoke's deadline bounds these calls when the smoke runs this class)."""
    return cp.run_bounded(["git", "-c", "user.name=checkpoint-test", "-c", "user.email=checkpoint-test@invalid", "-c", "commit.gpgsign=false",
                           *args], cwd=cwd, check=check, capture_output=True, text=True, timeout=120, plain=subprocess.run)


def drop_object(repo, digest):
    """Remove one loose object from a repository's own store (Git writes them read-only)."""
    path = Path(repo) / ".git" / "objects" / digest[:2] / digest[2:]
    path.chmod(0o600)
    path.unlink()


class CheckpointGitClosureTests(TempCase):
    """Round 4 (T16 run-d1428): the seal step CheckpointDocker.self_contained_git ran `git fsck --connectivity-only -q`,
    which git does not accept (exit 129), so no checkpoint could be sealed; the r3 suite never ran the seal's Git calls.
    These run them against the real git on tiny temporary repositories, the way a checkpoint leaf meets them: each
    fixture clone made with --shared (one of them from a shallow source, as the T16 candidate is) must end with its own
    object closure, and a missing object must be the error path (CalledProcessError), never a silent success."""

    def repository(self, base):
        source = base / "src"
        git("init", "-q", str(source))
        for number in (1, 2):
            (source / "a.txt").write_text("synthetic %d\n" % number, encoding="utf-8")
            git("-C", str(source), "add", "a.txt")
            git("-C", str(source), "commit", "-q", "-m", "synthetic %d" % number)
        return source

    def test_the_seal_keeps_each_shared_clone_self_contained(self):
        import ops_deploy_host_container_test as rehearsal
        base = self.tempdir("kin-git-")
        source = self.repository(base)
        shallow = base / "shallow"
        git("clone", "-q", "--depth", "1", source.as_uri(), str(shallow))
        self.assertTrue((shallow / ".git" / "shallow").is_file(), "the second source is shallow")
        fixture = base / "fixture"
        clones = {"source": source, "clone": shallow}
        for name, origin in clones.items():
            (fixture / name).mkdir(parents=True)
            git("clone", "-q", "--shared", str(origin), str(fixture / name / "repo"))
        # Git borrows the store of a complete source; from a shallow one it copies the objects and stays shallow (the
        # T16 fixture repositories are of this kind: shallow, no alternate).
        self.assertTrue((fixture / "source" / "repo" / ".git" / "objects" / "info" / "alternates").is_file())
        self.assertTrue((fixture / "clone" / "repo" / ".git" / "shallow").is_file())
        # A dangling object is reported by fsck but is not a broken closure.
        cp.run_bounded(["git", "-C", str(fixture / "clone" / "repo"), "hash-object", "-w", "--stdin"], input="dangling\n", text=True,
                       check=True, capture_output=True, timeout=60, plain=subprocess.run)
        rehearsal.CheckpointDocker.self_contained_git(fixture)
        heads = {}
        for name in clones:
            repo = fixture / name / "repo"
            self.assertFalse((repo / ".git" / "objects" / "info" / "alternates").exists(), name + ": the alternate is gone")
            heads[name] = git("-C", str(repo), "rev-parse", "HEAD").stdout.strip()
        # Without the borrowed stores the clones still hold every object they reach.
        source.rename(base / "src-moved")
        shallow.rename(base / "shallow-moved")
        for name in clones:
            repo = fixture / name / "repo"
            rehearsal.CheckpointDocker.git_connected(repo)
            self.assertEqual(git("-C", str(repo), "cat-file", "-t", heads[name] + "^{tree}").stdout.strip(), "tree")
            self.assertEqual(git("-C", str(repo), "show", heads[name] + ":a.txt").stdout, "synthetic 2\n")

    def test_a_missing_object_is_the_error_path(self):
        import ops_deploy_host_container_test as rehearsal
        base = self.tempdir("kin-git-")
        source = self.repository(base)
        rehearsal.CheckpointDocker.git_connected(source)
        blob = git("-C", str(source), "rev-parse", "HEAD:a.txt").stdout.strip()
        drop_object(source, blob)
        with self.assertRaises(subprocess.CalledProcessError) as raised:
            rehearsal.CheckpointDocker.git_connected(source)
        self.assertIn("fsck", raised.exception.cmd)
        self.assertNotIn(raised.exception.returncode, (0, 129), "git accepted the arguments and found the broken closure")
        self.assertIn(blob, raised.exception.stdout.decode() + raised.exception.stderr.decode())
        # Through the seal: a clone whose borrowed store lost an object is refused, whichever Git call meets it first.
        other = self.tempdir("kin-git-")
        origin = self.repository(other)
        (other / "fixture" / "source").mkdir(parents=True)
        git("clone", "-q", "--shared", str(origin), str(other / "fixture" / "source" / "repo"))
        drop_object(origin, git("-C", str(origin), "rev-parse", "HEAD:a.txt").stdout.strip())
        with self.assertRaises(subprocess.CalledProcessError) as raised:
            rehearsal.CheckpointDocker.self_contained_git(other / "fixture")
        self.assertNotIn(raised.exception.returncode, (0, 129))


def stub_package(site, name, version, modules):
    """A minimal installed distribution: importable modules and the metadata importlib.metadata reads."""
    package = Path(site) / name
    package.mkdir(parents=True)
    for module in modules:
        (package / (module + ".py")).write_text("", encoding="utf-8")
    info = Path(site) / ("%s-%s.dist-info" % (name, version))
    info.mkdir()
    (info / "METADATA").write_text("Metadata-Version: 2.1\nName: %s\nVersion: %s\n" % (name, version), encoding="utf-8")


def fake_lstat(entries):
    """os.lstat over a declared tree {path: (uid, mode)}; anything undeclared does not exist."""
    def lstat(path):
        if path not in entries:
            raise FileNotFoundError(2, "No such file or directory", path)
        uid, mode = entries[path]
        return SimpleNamespace(st_uid=uid, st_mode=mode)
    return lstat


class CheckpointHostPreconditionTests(RefusalAssertions, TempCase):
    """Round 4 (T16 run-d1428 attempts 1 and 2 spent gate attempts on the host): `commands` refuses, before any byte of
    proof.sh, a --python interpreter without Playwright or pydicom and a proof root or candidate that is not on a
    root-owned chain outside every user home (the product refuses the declared overlay and the browser module there)."""

    GOOD ={"/": (0, 0o040755), "/srv": (0, 0o040755), "/srv/kin-ckpt": (0, 0o040700), "/srv/kin-ckpt/proof": (0, 0o040700),
            "/srv/kin-ckpt/candidate": (0, 0o040755)}

    def venv(self):
        """A real virtual environment without pip (no package of the host interpreter is visible in it)."""
        folder = self.tempdir("kin-venv-") / "py"
        subprocess.run([sys.executable, "-m", "venv", "--without-pip", str(folder)], check=True, capture_output=True, timeout=300)
        python = folder / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        site = subprocess.run([str(python), "-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"], check=True,
                              capture_output=True, text=True, timeout=60).stdout.strip()
        return str(python), Path(site)

    def test_the_proof_root_and_candidate_need_a_root_owned_chain_outside_user_homes(self):
        homes = [PurePosixPath("/home/ubuntu")]
        chain = self.admitted(cp.root_owned_chain, "/srv/kin-ckpt/proof", "--proof-root", homes=homes, lstat=fake_lstat(self.GOOD))
        self.assertEqual([item["path"] for item in chain], ["/", "/srv", "/srv/kin-ckpt", "/srv/kin-ckpt/proof"])
        under_home = {"/": (0, 0o040755), "/home": (0, 0o040755), "/home/ubuntu": (1000, 0o040750),
                      "/home/ubuntu/kin-ckpt": (0, 0o040700), "/home/ubuntu/kin-ckpt/proof": (0, 0o040700)}
        root_home = {path: (0, mode) for path, (_, mode) in under_home.items()}
        cases = (("a proof root inside a user home (run-d1428 attempt 2)", "/home/ubuntu/kin-ckpt/proof", under_home, homes, "user home"),
                 ("a folder owned by a user on the path", "/home/ubuntu/kin-ckpt/proof", under_home, [], "owned by uid 1000"),
                 ("a root-owned folder inside a user home", "/home/ubuntu/kin-ckpt/proof", root_home, homes, "user home"),
                 ("a group-writable folder on the path", "/srv/kin-ckpt/proof", {**self.GOOD, "/srv/kin-ckpt": (0, 0o040770)}, homes,
                  "writable by group or others"),
                 ("a sticky world-writable /tmp", "/tmp/proof", {"/": (0, 0o040755), "/tmp": (0, 0o041777), "/tmp/proof": (0, 0o040700)},
                  homes, "writable by group or others"),
                 ("a link on the path", "/srv/kin-ckpt/proof", {**self.GOOD, "/srv/kin-ckpt": (0, stat.S_IFLNK | 0o777)}, homes, "link"),
                 ("a missing folder", "/srv/kin-ckpt/absent", self.GOOD, homes, "cannot be read"),
                 ("a relative path", "srv/kin-ckpt/proof", self.GOOD, homes, "absolute"),
                 ("a path with ..", "/srv/kin-ckpt/../kin-ckpt/proof", self.GOOD, homes, ".."))
        for label, path, entries, user_homes, reason in cases:
            with self.subTest(refused=label):
                error = self.assertRefused("HOST_PRECONDITION", cp.root_owned_chain, path, "--proof-root", homes=user_homes,
                                           lstat=fake_lstat(entries))
                self.assertIn(reason, str(error))
        answer = SimpleNamespace(returncode=0, stderr="", stdout=json.dumps({"python": "3.12.3", "executable": "/opt/kin-smoke/py/bin/python3",
                                                                             "modules": {"playwright": {"version": "1.60.0"},
                                                                                         "pydicom": {"version": "2.4.4"}}}) + "\n")
        facts = self.admitted(cp.host_preconditions, "/opt/kin-smoke/py/bin/python3", "/srv/kin-ckpt/proof", "/srv/kin-ckpt/candidate",
                              platform="posix", homes=["/home/ubuntu"], lstat=fake_lstat(self.GOOD), run=lambda *a, **k: answer)
        self.assertEqual(sorted(facts["paths"]), ["--candidate", "--proof-root"])
        self.assertEqual(facts["python"]["modules"], {"playwright": "1.60.0", "pydicom": "2.4.4"})
        with self.subTest(refused="the candidate under a user home"):
            self.assertRefused("HOST_PRECONDITION", cp.host_preconditions, "/opt/kin-smoke/py/bin/python3", "/srv/kin-ckpt/proof",
                               "/home/ubuntu/kin-ckpt/proof", platform="posix", homes=["/home/ubuntu"], lstat=fake_lstat({**self.GOOD, **under_home}),
                               run=lambda *a, **k: answer)
        with self.subTest(refused="a host that is not POSIX"):
            self.assertRefused("HOST_PRECONDITION", cp.host_preconditions, "python3", "/srv/kin-ckpt/proof", "/srv/kin-ckpt/candidate",
                               platform="nt", homes=[], lstat=fake_lstat(self.GOOD), run=lambda *a, **k: answer)

    def test_the_python_interpreter_must_import_playwright_and_pydicom(self):
        python, site = self.venv()
        error = self.assertRefused("HOST_PRECONDITION", cp.python_precondition, python)
        self.assertIn("lacks playwright (", str(error))
        self.assertIn("pydicom (", str(error))
        stub_package(site, "playwright", "1.60.0", ["__init__", "sync_api"])
        error = self.assertRefused("HOST_PRECONDITION", cp.python_precondition, python)
        self.assertIn("lacks pydicom (ModuleNotFoundError", str(error), "run-d1428 attempt 1: Playwright only")
        stub_package(site, "pydicom", "2.4.4", ["__init__"])
        facts = self.admitted(cp.python_precondition, python)
        self.assertEqual(facts["modules"], {"playwright": "1.60.0", "pydicom": "2.4.4"})
        self.assertEqual(Path(facts["executable"]).parent.parent, Path(python).parent.parent, "the probe ran in that interpreter")
        with self.subTest(refused="an interpreter that does not exist"):
            error = self.assertRefused("HOST_PRECONDITION", cp.python_precondition, str(self.tempdir() / "no-python"))
            self.assertIn("cannot run", str(error))
        with self.subTest(refused="an interpreter that does not answer the probe"):
            error = self.assertRefused("HOST_PRECONDITION", cp.python_precondition, python,
                                       run=lambda *a, **k: SimpleNamespace(returncode=1, stdout="", stderr="Traceback: boom"))
            self.assertIn("did not answer", str(error))
        # `commands`: a refused host writes no byte of proof.sh and exits 2; an admitted one prints the versions.
        empty, _ = self.venv()

        def commands(root, candidate, interpreter):
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = cp.main(["commands", "--registry", str(root / "registry.json"), "--proof-root", str(root), "--candidate",
                                str(candidate), "--python", interpreter])
            return code, out.getvalue(), err.getvalue()
        root, candidate = self.tempdir("kin-proof-"), self.tempdir("kin-candidate-")
        (root / "registry.json").write_bytes(cp.canonical([dict(leaf) for leaf in cp.DEFAULT_PROOF_LEAVES]) + b"\n")
        if os.name == "posix" and os.geteuid() == 0:
            # Root (CI): the temporary folders are under /root, a root-owned chain. r5: an admitted host then runs the native
            # smoke (CheckpointSmokeTests); a passing one stands in for it here.
            with patch.object(cp, "_smoke_run", fake_smoke()[0]):
                code, out, err = commands(root, candidate, python)
            self.assertEqual(code, 0, err)
            self.assertTrue(out.startswith("#!/usr/bin/env bash\n"))
            facts = json.loads(err.strip().splitlines()[-1])["host_preconditions"]
            self.assertEqual(facts["python"]["modules"], {"playwright": "1.60.0", "pydicom": "2.4.4"})
            refusals = [(candidate, empty, "lacks playwright")]
            (candidate / "open").mkdir()
            (candidate / "open").chmod(0o777)
            refusals.append((candidate / "open", python, "writable by group or others"))
        else:
            # Elsewhere (Windows, or a non-root account under a sticky /tmp) the host itself is refused.
            refusals = [(candidate, python, "HOST_PRECONDITION"), (candidate, empty, "HOST_PRECONDITION")]
        for where, interpreter, reason in refusals:
            with self.subTest(refused=reason):
                code, out, err = commands(root, where, interpreter)
                self.assertEqual((code, out), (2, ""), "refused before any byte of proof.sh")
                self.assertIn("CHECKPOINT_REFUSED HOST_PRECONDITION", err)
                self.assertIn(reason, err)


# ── r5 (consult-checkpoints-r5-20261016): the observation-only context, the original records, the observation raw and
# the native smoke of `commands`; pure controls only - the native backend is tests/ops_release_checkpoints_native_test.py ──

def engine_response(status, body=b"", *, stream=b""):
    """One Engine HTTP answer as `docker system dial-stdio` relays it (101 carries the multiplexed exec stream)."""
    if status == 101:
        return b"HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n" + stream
    reason = {200: "OK", 201: "Created"}[status]
    return ("HTTP/1.1 %d %s\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n" % (status, reason, len(body))).encode() + body


class FakeEngine:
    """A synthetic daemon behind the product's Runner interface, answering exactly what HostOps.snapshot asks: exact-name
    container listings, inspect, git rev-parse, the worker label listing, and Engine exec create/start/inspect over
    `docker system dial-stdio` with the Engine's HTTP and stream framing. A pure control: it never stands in for the native
    smoke (no claim about the real adapter's argv). `exec_running` answers an exec that never ends; `on_call` sees every
    call (to change a file mid-observation)."""

    def __init__(self, target, plan, state, *, boundary, exec_running=False, on_call=None):
        self.calls, self.execs, self.exec_running, self.on_call = [], {}, exec_running, on_call
        side = "release" if state["checkout"] == "target" else "previous"
        self.sha = plan[side]["sha"]
        running = set(intro.ROLES) if intro.BOUNDARY_RUNNING[boundary] == "all" else set(intro.BOUNDARY_RUNNING[boundary].split())
        after = boundary in ("L-09b", "L-10e")
        self.migrations = plan["migrations"]["after" if after else "before"]
        port = (target["ports"]["public"][0] if boundary in intro.PUBLIC_BOUNDARIES else target["ports"]["maintenance"]).split(":")[1]
        self.items = {}
        for index, role in enumerate(intro.ROLES):
            name = target["containers"][role]
            self.items[name] = {"Id": "%064x" % (index + 1), "Name": "/" + name, "Image": plan[side]["images"][role], "ExecIDs": [],
                                "State": {"Running": role in running, "Restarting": False, "Status": "running" if role in running else "exited",
                                          "ExitCode": 0},
                                "Config": {"Labels": {"com.docker.compose.project": target["project"], "com.docker.compose.service": role}},
                                "HostConfig": {"PortBindings": {"443/tcp": [{"HostIp": "127.0.0.1", "HostPort": port}]} if role == "proxy" else {}}}

    def __call__(self, args, *, input=None, timeout=60, env=None, output=None, stdin=None):
        self.calls.append(list(args))
        if self.on_call is not None:
            self.on_call(list(args))
        answer = lambda out, code=0: subprocess.CompletedProcess(args, code, out, b"")
        if args[:3] == ["docker", "container", "ls"]:
            name = next(arg for arg in args if arg.startswith("name=^/"))[len("name=^/"):-1]
            return answer((name + "\n").encode() if name in self.items else b"")
        if args[:2] == ["docker", "inspect"]:
            return answer(json.dumps([self.items[args[2]]]).encode())
        if args[:3] == ["git", "rev-parse", "HEAD"]:
            return answer((self.sha + "\n").encode())
        if args[:2] == ["docker", "ps"]:
            return answer(b"")
        if args[:3] == ["docker", "system", "dial-stdio"]:
            return answer(self.engine(input))
        raise AssertionError("FakeEngine does not model " + " ".join(args[:3]))

    def engine(self, raw):
        from urllib.parse import unquote
        head, _, rest = raw.partition(b"\r\n\r\n")
        method, path, _ = head.split(b"\r\n")[0].decode().split(" ")
        length = int(next(line.split(b":", 1)[1] for line in head.split(b"\r\n") if line.lower().startswith(b"content-length:")))
        body, path = (json.loads(rest[:length]) if length else None), path[len("/v1.45"):]
        if method == "POST" and path.startswith("/containers/") and path.endswith("/exec"):
            ident = hashlib.sha256(("exec %d" % len(self.execs)).encode()).hexdigest()
            self.execs[ident] = {"container": unquote(path[len("/containers/"):-len("/exec")]), "cmd": body["Cmd"]}
            return engine_response(201, json.dumps({"Id": ident}).encode())
        ident = path.split("/")[2]
        if method == "POST" and path.endswith("/start"):
            code, out = self.output(self.execs[ident]["cmd"])
            self.execs[ident]["exit"] = code
            return engine_response(101, stream=(bytes([1, 0, 0, 0]) + len(out).to_bytes(4, "big") + out) if out else b"")
        if method == "GET" and path.endswith("/json"):
            row = self.execs[ident]
            return engine_response(200, json.dumps({"ID": ident, "ContainerID": row["container"], "Running": self.exec_running,
                                                    "ExitCode": None if self.exec_running else row.get("exit", 0)}).encode())
        raise AssertionError("FakeEngine does not model " + method + " " + path)

    def output(self, cmd):
        text = " ".join(cmd)
        if cmd[0] == "pg_isready":
            return 0, b"accepting connections\n"
        if "_prisma_migrations" in text:
            return 0, json.dumps([[name, checksum, True, False] for name, checksum in self.migrations]).encode()
        if "pg_stat_activity" in text:
            return 0, b"0\n"
        if cmd[:2] == ["sh", "-c"] and cmd[2].startswith("exit "):
            return int(cmd[2].split()[1]), b""
        return 0, b""


class CheckpointObservationTests(RefusalAssertions, TempCase):
    """r5 P1/P2 (consult observe_fix, R5-ACCEPTANCE items 1 and 4): CheckpointDocker.observe runs the product's HostOps
    and Introduction (constructed, never run) over a synthetic Engine; the stack holds a closed phase's real records."""

    def stack(self, checkpoint_id):
        root = self.tempdir("kin-observe-")
        target = target_fixture(root)
        plan, state, result, raw = boundary_fixture(checkpoint_id, plan_fixture(target, root))
        plan_sha = intro.plan_identity(plan)
        clone = root / "clone"
        clone.mkdir(mode=0o700)
        repo = Path(target["repository"])
        repo.mkdir(mode=0o700)
        entry = intro.ComposeEntry(clone / "compose-entries")
        pointer = entry.publish(repository=repo, project=PROJECT, sources=[("docker-compose.yml", b"services: {}\n")], env_raw=b"",
                                values={}, runtime="services: {}\n", plan_sha256=plan_sha, validate=lambda command, environment: None)
        state["compose_entry"] = {**pointer, "root": str(entry.root)}
        if state["lock_token"]:
            (repo / ".kin-ops.lock").write_text(state["lock_token"])
        records = intro.Records(clone / "records")
        phase = cp.CHECKPOINTS[checkpoint_id]["phase"]
        # The closed phase's own records, as a phase run in this process leaves them (its command record still named).
        records.begin(phase, result["request_sha256"])
        records.command({"step": intro.STEPS[phase][-1][0], "argv": ["docker", "inspect", target["containers"]["db"]], "exit": 0})
        records.put("plan.json", plan)
        records.write(records.directory / ("result-" + phase + "-" + result["request_sha256"][:16] + ".json"), raw)
        records.save(state)
        records.journal({"event": "phase-end", "phase": phase})
        with records.lease():
            pass
        return SimpleNamespace(root=clone, repo=repo, target=target, plan_document=plan, plan_sha256=plan_sha, records=records), state

    def engine(self, stack, state, checkpoint_id, **kwargs):
        return FakeEngine(stack.target, stack.plan_document, state, boundary=cp.CHECKPOINTS[checkpoint_id]["boundary"], **kwargs)

    @staticmethod
    def observe(stack, engine, checkpoint_id, **kwargs):
        import ops_deploy_host_container_test as rehearsal
        # r6: the capture's regenerated-artifact descriptor is given (a pure control never asks a daemon for one).
        kwargs.setdefault("regenerated", regenerated_fixture("id-" + stack.target["containers"]["orthanc"]))
        with patch.object(rehearsal.intro, "Runner", lambda cwd, **options: engine):
            return rehearsal.CheckpointDocker(stack, None).observe(checkpoint_id, purpose="capture", **kwargs)

    @staticmethod
    def files(stack):
        return {path.relative_to(stack.root).as_posix(): path.read_bytes() for path in sorted(stack.root.rglob("*"))
                if path.is_file() and cp.OBSERVATION_DIR not in path.parts}

    def test_observation_context_settles_its_own_workers_and_refuses_an_unsettled_state(self):
        """P1: the observation has its own request digest, its own Records and a copy of S; every docker exec of the product
        snapshot is a registered Engine exec worker of that request, settled QUIET with its server exit; the boundary's own
        workers and history are kept as they were; an unsettled boundary state, an exec that never ends, and a database
        fact this observation did not read itself are refused (M43)."""
        stack, state = self.stack("held")
        state_raw = (stack.records.directory / "state.json").read_bytes()
        engine = self.engine(stack, state, "held")
        record = self.admitted(self.observe, stack, engine, "held")
        folder = record["folder"]
        self.assertEqual(folder.parent, stack.records.directory / cp.OBSERVATION_DIR)
        files = cp.folder_files(folder)
        summary, request = self.admitted(cp.observation_valid, files, checkpoint_id="held", purpose="capture", plan_sha256=stack.plan_sha256,
                                         state_sha256=hashlib.sha256(state_raw).hexdigest())
        self.assertNotEqual(summary["request_sha256"], state["history"][-1]["request_sha256"], "never the phase's request digest")
        self.assertEqual(request["phase_request_sha256"], state["history"][-1]["request_sha256"])
        observed = json.loads(files["state.json"])
        mine = [row for nonce, row in observed["workers"].items() if nonce not in state["workers"]]
        db = engine.items[stack.target["containers"]["db"]]["Id"]
        self.assertGreaterEqual(len(mine), 3, "pg_isready, the migration rows and the database clients")
        for row in mine:
            self.assertEqual((row["kind"], row["state"], row["request_sha256"], row["container_id"], row["server_exit"]),
                             ("exec", "QUIET", summary["request_sha256"], db, 0))
            self.assertIn(row["exec_id"], engine.execs, "an Engine exec ID the daemon issued")
            self.assertEqual(row["exec_observation"], {"ID": row["exec_id"], "ContainerID": db, "Running": False, "ExitCode": 0})
        self.assertEqual({nonce: observed["workers"][nonce] for nonce in state["workers"]}, state["workers"], "the boundary's workers kept")
        self.assertEqual(observed["history"], state["history"], "an observation is never a phase history row")
        self.assertEqual(record["snapshot"]["facts"]["database"]["value"]["migrations"],
                         [[name, checksum, True, False] for name, checksum in stack.plan_document["migrations"]["before"]])
        rows = [json.loads(line) for line in files["commands-" + cp.OBSERVATION_PHASE + "-" + summary["request_sha256"][:16] + ".jsonl"].splitlines()]
        # One row per HostOps command: the plain daemon and Git calls, and each registered exec (carried by the Engine).
        self.assertEqual(len(rows), len([call for call in engine.calls if call[:3] != ["docker", "system", "dial-stdio"]]) + len(mine),
                         "every command of the observation is in its own command record")
        with self.subTest(probe="a nonzero exec in the same context"):
            other, other_state = self.stack("held")
            probe_engine = self.engine(other, other_state, "held")

            def probe(ops, context, snapshot):
                result = ops.cmd(["docker", "exec", ops.names["db"], "sh", "-c", "exit 3"], check=False)
                worker = list(context.state["workers"].values())[-1]
                probe.seen = (result.returncode, worker["server_exit"], worker["client_exit"], worker["state"])
            self.admitted(self.observe, other, probe_engine, "held", probe=probe)
            self.assertEqual(probe.seen, (3, 3, 3, "QUIET"))
        with self.subTest(refused="an unsettled worker in the boundary state"):
            other, other_state = self.stack("held")
            other_state["workers"]["w1"]["state"] = "PLANNED"
            other.records.save(other_state)
            refused_engine = self.engine(other, other_state, "held")
            self.assertRefused("OBSERVATION_REFUSED", self.observe, other, refused_engine, "held")
            self.assertEqual(refused_engine.calls, [], "refused before any command")
        with self.subTest(refused="an exec whose end the Engine never reports"):
            other, other_state = self.stack("held")
            hanging = self.engine(other, other_state, "held", exec_running=True)
            self.assertRefused("OBSERVATION_UNSETTLED", self.observe, other, hanging, "held")
            latest = next((other.records.directory / cp.OBSERVATION_DIR).iterdir())
            self.assertEqual(json.loads((latest / cp.OBSERVATION_RESULT).read_bytes())["outcome"], "REFUSED", "the failed observation is kept")
            self.assertIn("UNKNOWN", [row["state"] for row in json.loads((latest / "state.json").read_bytes())["workers"].values()])
        with self.subTest(refused="a database fact this observation did not read (M43)"):
            other, other_state = self.stack("held")
            reused = copy.deepcopy(record["snapshot"])
            entry_root = other.root / "compose-entries"
            self.assertRefused("NOT_A_BOUNDARY", cp.observe_boundary, "held", purpose="capture", records_dir=other.records.directory,
                               secrets_dir=other.records.secrets, entry_root=entry_root, lock_path=intro.lock_path(other.repo),
                               plan=other.plan_document, plan_sha256=other.plan_sha256, target=other.target, repository=other.repo,
                               host_key="b" * 64, tool=intro.tool_hashes(),
                               make_ops=lambda records: intro.HostOps(target=other.target, plan=other.plan_document,
                                                                      runner=self.engine(other, other_state, "held"), records=records,
                                                                      entry_root=entry_root),
                               snapshot=lambda ops, context: copy.deepcopy(reused),
                               regenerated=regenerated_fixture("id-" + other.target["containers"]["orthanc"]))
            without = dict(files)
            stripped = json.loads(without["state.json"])
            stripped["workers"] = {nonce: row for nonce, row in stripped["workers"].items() if nonce in state["workers"]}
            without["state.json"] = intro.canonical(stripped) + b"\n"
            summary_doc = json.loads(without[cp.OBSERVATION_RESULT])
            summary_doc["files"]["state.json"] = hashlib.sha256(without["state.json"]).hexdigest()
            without[cp.OBSERVATION_RESULT] = cp.canonical(summary_doc) + b"\n"
            self.assertRefused("OBSERVATION_INVALID", cp.observation_valid, without, checkpoint_id="held", purpose="capture")

    def test_the_original_records_stay_byte_identical_and_bind_the_sealed_state(self):
        """P2: the closed phase's state, result, journal, command record, the ComposeEntry and the lock are byte-identical
        before and after an observation, which writes only its own folder (M44); 48a28dd's observation context leaves the
        database and fences facts as errors and appends to the closed command record (N01), the digest-only fix rewrites the
        state and the closed command record (N02); a state changed during the observation refuses it; the seal binds the
        state that was judged, so a different archived state refuses."""
        import ops_release_checkpoints_native_test as native
        import ops_deploy_host_container_test as rehearsal
        stack, state = self.stack("seeded")
        before = self.files(stack)
        record = self.admitted(self.observe, stack, self.engine(stack, state, "seeded"), "seeded")
        self.assertEqual(self.files(stack), before, "the original records are byte-identical")
        self.assertEqual(record["summary"]["original"]["before"], record["summary"]["original"]["after"])
        self.assertEqual(sorted({path.relative_to(stack.root).parts[1] for path in stack.root.rglob("*") if path.is_file()
                                 and path.relative_to(stack.root).as_posix() not in before}), [cp.OBSERVATION_DIR])
        for name, digest in (("n01", None), ("n02", "d" * 64)):
            with self.subTest(diagnostic=name):
                copied = self.tempdir("kin-diagnostic-") / "records"
                shutil.copytree(stack.records.directory, copied, ignore=shutil.ignore_patterns(cp.OBSERVATION_DIR))
                records = intro.Records(copied)
                records.commands_file, records.seq = stack.records.commands_file, 1
                listing = lambda: {path.name: path.read_bytes() for path in copied.iterdir() if path.is_file()}
                prior = listing()
                engine = self.engine(stack, state, "seeded")
                with patch.object(rehearsal.intro, "Runner", lambda cwd, **options: engine):
                    snapshot = native.frozen_observe_48a28dd(stack, records, "seeded", request_sha256=digest)
                changed = sorted(key for key in set(prior) | set(listing()) if prior.get(key) != listing().get(key))
                if digest is None:
                    self.assertEqual((snapshot["facts"]["database"], snapshot["facts"]["fences"]),
                                     ({"outcome": "ERROR", "reason": "AttributeError"}, {"outcome": "ERROR", "reason": "AttributeError"}))
                    self.assertRefused("NOT_A_BOUNDARY", cp.boundary_contract, "seeded", snapshot, state=state, plan=stack.plan_document,
                                       target=stack.target)
                    self.assertEqual(changed, [stack.records.commands_file], "48a28dd appended to the closed command record")
                else:
                    self.admitted(cp.boundary_contract, "seeded", snapshot, state=state, plan=stack.plan_document, target=stack.target)
                    self.assertEqual(changed, sorted([stack.records.commands_file, "state.json"]), "the digest-only fix rewrote both")
        with self.subTest(refused="the state changed during the observation"):
            other, other_state = self.stack("seeded")
            path = other.records.directory / "state.json"

            def rewrite(args):
                if args[:3] == ["docker", "system", "dial-stdio"] and b'"edited"' not in path.read_bytes():
                    path.write_bytes(path.read_bytes().replace(b'"status":"SEEDED"', b'"status":"SEEDED","edited":true'))
            self.assertRefused("ORIGINAL_CHANGED", self.observe, other, self.engine(other, other_state, "seeded", on_call=rewrite), "seeded")
            latest = next((other.records.directory / cp.OBSERVATION_DIR).iterdir())
            self.assertEqual(json.loads((latest / cp.OBSERVATION_RESULT).read_bytes())["outcome"], "REFUSED")
        with self.subTest(refused="an archived state that is not the judged one"):
            state_raw = (stack.records.directory / "state.json").read_bytes()
            bindings = {"state": {"path": "clone/records/state.json", "sha256": hashlib.sha256(state_raw).hexdigest()}}
            tree = self.tempdir() / "tree.tar"
            cp.write_tree_archive(stack.root.parent, tree, exclude=("clone/compose-entries",))
            self.admitted(cp.check_bindings, tree, bindings, required=["state"])
            (stack.records.directory / "state.json").write_bytes(state_raw.replace(b'"SEEDED"', b'"SEEDED "'))
            changed = self.tempdir() / "tree.tar"
            cp.write_tree_archive(stack.root.parent, changed, exclude=("clone/compose-entries",))
            self.assertRefused("BUNDLE_INVALID", cp.check_bindings, changed, bindings, required=["state"])


def fake_smoke(outcome="PASS", *, exit_code=0, skipped=0, missing=(), cleanup=None, host=None, error=None, result=True, before=None, result_code=None):
    """A stand-in for the recorded native smoke run (pure control of `commands` only): it writes the recorder's run.json and
    the smoke's result where `commands` told it to, and records whether stdout was still empty when it ran."""
    seen = []

    def run(command, **kwargs):
        seen.append(before() if before else None)
        if error is not None:
            raise error
        run_dir, evidence = Path(command[command.index("--run-dir") + 1]), Path(command[command.index("--evidence") + 1])
        run_dir.mkdir(parents=True)
        (run_dir / "run.json").write_text(json.dumps({"status": "completed", "exit_code": exit_code, "recorder_exit_code": 0}))
        if result:
            evidence.mkdir(parents=True)
            row = {"outcome": "PASS", "checks": 2}
            document = {"outcome": outcome, "code": result_code, "skipped": skipped, "host_facts": host or HOST_FACTS,
                        "coverage": {key: row for key in cp.SMOKE_PATHS if key not in missing},
                        "oracles": {key: row for key in cp.SMOKE_ORACLES if key not in missing},
                        "cleanup": cleanup or {"complete": True, "remaining": [], "errors": []}}
            (evidence / cp.SMOKE_RESULT).write_bytes(cp.canonical(document) + b"\n")
        return subprocess.CompletedProcess(command, exit_code, b"NATIVE_SMOKE synthetic\n", b"")
    return run, seen


HOST_FACTS = {"os": "linux", "docker_os": "Ubuntu 24.04 LTS", "daemon_ok": True, "daemon_identity": "DAEMON:SYNTHETIC",
              "available_ram_bytes": 16 * 1024 ** 3, "available_disk_bytes": 100 * 1024 ** 3, "required_disk_bytes": 20 * 1024 ** 3,
              "foreign_containers": [], "host_key_sha256": "8" * 64, "architecture": "x86_64", "absolute_fixture_root": "/root",
              "docker_endpoint": "unix:///var/run/docker.sock", "endpoint_selectors": []}
# The real entrypoint with its gate state redirected and (r6) its host observation answered without a daemon: the
# pure suite queries no Docker daemon (consultation pure_proof); the admission judges these facts as it judges real ones.
NATIVE_BOOTSTRAP = ("import sys\nfrom pathlib import Path\nsys.path.insert(0, sys.argv[1])\nimport ops_release_checkpoints_native_test as native\n"
                    "native.gate.STATE = Path(sys.argv[2])\n"
                    "native.observe_host = lambda root: {'os': 'linux' if sys.platform.startswith('linux') else sys.platform, 'docker_os': 'synthetic',"
                    " 'daemon_ok': True, 'daemon_identity': 'DAEMON:SYNTHETIC', 'docker_endpoint': 'unix:///var/run/docker.sock',"
                    " 'endpoint_selectors': native.cp.endpoint_selectors(), 'available_ram_bytes': 0, 'available_disk_bytes': 0, 'foreign_containers': []}\n"
                    "raise SystemExit(native.main(sys.argv[3:]))\n")


class CheckpointSmokeTests(RefusalAssertions, TempCase):
    """r5 P4 (consult adapter_smoke, R5-ACCEPTANCE item 3, N05): `commands` runs the native smoke after the host
    preconditions and before any byte of proof.sh, also for a retry; a smoke that fails, is skipped, is incomplete, did not
    clean up or did not run writes no script and spends no gate attempt; the T16 host admission is checked apart from the
    smoke; the real smoke entrypoint refuses a busy lease, an inspection marker, unreleased residue and a host that is not
    native before it creates anything."""

    def test_commands_runs_the_native_smoke_before_any_byte_and_spends_no_attempt(self):
        root, candidate, state = self.tempdir("kin-proof-"), self.tempdir("kin-candidate-"), self.tempdir("kin-gate-") / "test-gate"
        state.mkdir()
        (root / "registry.json").write_bytes(cp.canonical([dict(leaf) for leaf in cp.DEFAULT_PROOF_LEAVES]) + b"\n")
        (state / "release-tools-checkpoints-proof-prefix-source.json").write_text('{"attempts":[{"status":"failed"}]}\n')
        (state / "inspections.jsonl").write_text('{"record_sha256":"' + "0" * 64 + '"}\n')
        ledger = lambda: {path.name: path.read_bytes() for path in state.iterdir()}
        kept = ledger()
        out = io.StringIO()

        def commands(*extra, smoke):
            out.seek(0)
            out.truncate()
            err = io.StringIO()
            with patch.object(cp, "host_preconditions", lambda *args, **kwargs: {"paths": {}, "python": {"modules": {}}}), \
                    patch.object(cp, "_smoke_run", smoke), patch.object(gate, "STATE", state), \
                    contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = cp.main(["commands", "--registry", str(root / "registry.json"), "--proof-root", str(root), "--candidate", str(candidate),
                                "--python", sys.executable, *extra])
            return code, out.getvalue(), err.getvalue()
        cases = {"a smoke that failed": dict(outcome="FAIL", exit_code=1), "a skipped smoke": dict(skipped=1),
                 "a path without its checks (A07)": dict(missing=("A07",)), "an oracle without its checks (N01)": dict(missing=("N01",)),
                 "an unconfirmed cleanup": dict(cleanup={"complete": False, "remaining": ["kin-ckptsmoke-x"], "errors": []}),
                 "a smoke that left no result": dict(result=False), "a smoke that could not run": dict(error=subprocess.TimeoutExpired("x", 1)),
                 "the smoke's own refusal (a busy lease)": dict(outcome="REFUSED", exit_code=3),
                 "a smoke that met its deadline (r6)": dict(outcome="FAIL", exit_code=1, result_code="DEADLINE",
                                                           cleanup={"complete": False, "remaining": ["unverified: private root /root/x"],
                                                                    "errors": [], "verification": "UNKNOWN"})}

        def smoke_only(**kwargs):
            run, _ = fake_smoke(**kwargs)
            with patch.object(cp, "_smoke_run", run), contextlib.redirect_stderr(io.StringIO()):
                return cp.native_smoke(sys.executable, candidate, root)
        self.assertEqual(self.admitted(smoke_only)["outcome"], "PASS")
        for name, kwargs in cases.items():
            with self.subTest(verdict=name):
                self.assertRefused("SMOKE_FAILED", smoke_only, **kwargs)
        if os.name == "posix":
            run, seen = fake_smoke(before=lambda: out.getvalue())
            code, script, err = commands(smoke=run)
            self.assertEqual((code, seen), (0, [""]), err)
            self.assertTrue(script.startswith("#!/usr/bin/env bash\n"), "the script follows the passed smoke")
            self.assertEqual(json.loads(err.strip().splitlines()[-1])["native_smoke"]["outcome"], "PASS")
            run, seen = fake_smoke(before=lambda: out.getvalue())
            code, script, err = commands("--from-unit", "release-tools-checkpoints-proof-prefix-seed", "--attempt", "2", smoke=run)
            self.assertEqual((code, seen, script.startswith("#!/usr/bin/env bash\n")), (0, [""], True), "a retry runs the smoke as well")
            for name, kwargs in cases.items():
                with self.subTest(refused=name):
                    run, seen = fake_smoke(**kwargs)
                    for extra in ((), ("--from-unit", "release-tools-checkpoints-proof-prefix-seed", "--attempt", "2")):
                        code, script, err = commands(*extra, smoke=run)
                        self.assertEqual((code, script), (2, ""), name)
                        self.assertIn("CHECKPOINT_REFUSED SMOKE_FAILED", err)
            with self.subTest(refused="a host that passes the tiny smoke but not T16's D1034"):
                run, _ = fake_smoke(host={**HOST_FACTS, "available_ram_bytes": 4 * 1024 ** 3})
                code, script, err = commands(smoke=run)
                self.assertEqual((code, script), (2, ""))
                self.assertIn("CHECKPOINT_REFUSED INSUFFICIENT_RAM", err)
            for diagnostic in ("body", "cleanup"):
                with self.subTest(refused="a deadline diagnostic, even one whose smoke reported a pass (r6)", diagnostic=diagnostic):
                    run, seen = fake_smoke(before=lambda: out.getvalue())
                    code, script, err = commands("--smoke-diagnostic", diagnostic, smoke=run)
                    self.assertEqual((code, script, seen), (2, "", [""]))
                    self.assertIn("CHECKPOINT_REFUSED SMOKE_FAILED", err)
        else:
            # Elsewhere the proof's Linux paths refuse first, still before the smoke and before any byte.
            run, seen = fake_smoke()
            code, script, err = commands(smoke=run)
            self.assertEqual((code, script, seen), (2, "", []), err)
        self.assertEqual(ledger(), kept, "the gate ledger and inspections are never touched")
        self.assertEqual(sorted(path.name for path in root.iterdir()), ["registry.json", "smoke"], "no plan, request, run or index")
        # The real entrypoint, with its gate state redirected: each refusal comes before anything is created.
        bootstrap = self.tempdir("kin-native-") / "bootstrap.py"
        bootstrap.write_text(NATIVE_BOOTSTRAP, encoding="utf-8")
        smoke_roots = lambda: sorted(Path("/root").glob("kin-ckpt-smoke-*")) if os.name == "posix" and Path("/root").is_dir() else []
        roots = smoke_roots()

        def native(environment=None):
            evidence = self.tempdir("kin-native-evidence-") / "evidence"
            completed = subprocess.run([sys.executable, "-B", str(bootstrap), str(TESTS), str(state), "--evidence", str(evidence)],
                                       capture_output=True, timeout=300, env={**os.environ, **(environment or {})})
            return completed, json.loads((evidence / cp.SMOKE_RESULT).read_bytes())
        with self.subTest(refused="the live lease held by another run"):
            with gate.exclusive(state / "live.lock"):
                completed, result = native()
            self.assertEqual((completed.returncode, result["outcome"], result["code"]), (3, "REFUSED", "SMOKE_BUSY"), completed.stderr[-800:])
        with self.subTest(refused="an inspection marker"):
            (state / "live-needs-inspection.json").write_text("{}\n")
            completed, result = native()
            (state / "live-needs-inspection.json").unlink()
            self.assertEqual((completed.returncode, result["code"]), (3, "SMOKE_INSPECTION"), completed.stderr[-800:])
        with self.subTest(refused="an earlier smoke's unreleased residue"):
            residue = state.parent / "checkpoint-smoke"
            residue.mkdir()
            (residue / "pending-0123456789ab.json").write_text("{}\n")
            completed, result = native()
            shutil.rmtree(residue)
            self.assertEqual((completed.returncode, result["code"]), (3, "SMOKE_RESIDUE"), completed.stderr[-800:])
        with self.subTest(refused="a host that is not root on native Linux with one local daemon"):
            completed, result = native({"DOCKER_HOST": "unix:///nonexistent/kin-ckpt-smoke.sock"})
            self.assertEqual(completed.returncode, 3, completed.stderr[-800:])
            self.assertIn(result["code"], ("UNSUPPORTED_HOST", "REMOTE_DAEMON"))
            self.assertEqual(sorted((state.parent / "checkpoint-smoke").glob("pending-*.json")), [],
                             "an admission refusal created nothing, so its pending residue is released at once")
        self.assertEqual(smoke_roots(), roots, "no smoke fixture was created")
        self.assertEqual({name: data for name, data in ledger().items() if name != "live.lock"}, kept)


class CheckpointCompareTests(RefusalAssertions, TempCase):
    """CKPT-08: an equal verdict is not a T16 pass: both sides DEPLOYED with every required fact true, both runs BOUND."""

    def test_equal_failures_are_not_a_t16_pass(self):
        good = {"status": "DEPLOYED", "release_images": {"api": image("6")}, "health": {"ok": True}, "migrations_after": True,
                "smoke_member_absent": True, "ordinary_entry_side": "release", "ordinary_entry_images": True, "frame_sha256": "f" * 64}
        self.assertEqual(cp.forward_verdict_reasons(good), [])
        passed = cp.compare_forward_verdicts(good, good, resumed_bound=True, fresh_bound=True)
        self.assertEqual((passed["equal"], passed["t16_pass"], passed["reasons"]), (True, True, []))
        failed = {"status": "FAILED", "release_images": {}, "health": False, "migrations_after": False, "smoke_member_absent": False,
                  "ordinary_entry_side": "bad", "ordinary_entry_images": False, "frame_sha256": "bad"}
        both_failed = cp.compare_forward_verdicts(failed, failed, resumed_bound=True, fresh_bound=True)
        self.assertEqual((both_failed["equal"], both_failed["t16_pass"]), (True, False))
        self.assertTrue(both_failed["reasons"])
        for key, value in (("status", "VERIFIED"), ("health", {}), ("migrations_after", False), ("smoke_member_absent", False),
                           ("ordinary_entry_images", False), ("ordinary_entry_side", "previous")):
            with self.subTest(both_equal_but_wrong=key):
                verdict = {**good, key: value}
                self.assertFalse(cp.compare_forward_verdicts(verdict, verdict, resumed_bound=True, fresh_bound=True)["t16_pass"])
        for name, kwargs in (("the resumed run unbound", {"fresh_bound": True}), ("the fresh control unbound", {"resumed_bound": True})):
            with self.subTest(refused=name):
                self.assertFalse(cp.compare_forward_verdicts(good, good, **kwargs)["t16_pass"])
        self.assertFalse(cp.compare_forward_verdicts(good, {**good, "frame_sha256": "e" * 64}, resumed_bound=True, fresh_bound=True)["t16_pass"])
        root = self.tempdir("kin-proof-")
        (root / "registry.json").write_bytes(cp.canonical(list(cp.DEFAULT_PROOF_LEAVES)) + b"\n")
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(cp.main(["compare", "--registry", str(root / "registry.json"), "--proof-root", str(root)]), 1,
                             "without two BOUND runs there is no T16 pass")


# ── r6 (consult-checkpoints-r6-20261017): the regenerated-artifact contract (CKPT5-01) and real deadlines (CKPT5-02) ──

def bundle_from(test, fixture, made, checkpoint_id="introduced"):
    """A sealed bundle of an already prepared fixture (its bindings as given), the way seal() makes one."""
    store = cp.BundleStore(test.tempdir() / "bundles", forbidden=[fixture])
    pending = store.begin(checkpoint_id)
    for category in cp.VOLUME_CATEGORIES:
        pending.add("volume-" + category + ".tar", "volume:" + category, volume_tar(category))
    tree = pending.directory / "export-fixture.tar"
    cp.write_tree_archive(fixture, tree)
    pending.add("fixture-tree.tar", "fixture-tree", tree)
    tree.unlink()
    return pending.seal(identity=made.identity, boundary=sealed_boundary(checkpoint_id, made), bindings=made.bindings,
                        owned=sealed_owned(made), execution_kind="fresh")


class CheckpointRegeneratedTests(CaptureFixture, RefusalAssertions, TempCase):
    """r6 CKPT5-01 (consultation ckpt5_01, negative oracles O6-A/O6-B/O6-C): the Orthanc image's start artifacts are a
    typed exception of the Orthanc role on its pinned image, judged against the image's own regeneration (the
    descriptor), never global prefixes; the judgement is a required raw that every consumer re-judges."""

    def judged(self, role, extra, *, facts=None, descriptor=None, images=None, base=True, drop=()):
        """capture_checkpoint at INTRODUCED with one role's writable layer: a normal Orthanc start (on the Orthanc role)
        plus `extra` changes, its facts with `facts` changed. Returns (code, layer record, store listing)."""
        target = target_fixture()
        names = {item: target["containers"][item] for item in intro.ROLES}
        volumes = {**target["volumes"], "proxy_certs": PROJECT + "_proxy-certs"}
        descriptor = descriptor or regenerated_fixture("id-" + names["orthanc"])
        backend = FakeBackend(names, volumes, images=images or cp.pinned_images(plan_fixture(), {"entry_checkout": "target"}))
        backend.diffs[names[role]] = [change for change in (ORTHANC_START if base else []) if change not in drop] + list(extra)
        backend.layers[names[role]] = {**start_facts(descriptor), **(facts or {})}
        fixture, store_root = self.tempdir(), self.tempdir() / "bundles"
        try:
            self.captured("introduced", backend, descriptor=descriptor, fixture=fixture, store_root=store_root)
            code = "SEALED"
        except cp.Refused as error:
            code = error.code
        layers = sorted(fixture.glob("*/records/" + cp.OBSERVATION_DIR + "/layer-*/" + cp.LAYER_FILE))
        record = json.loads(layers[-1].read_bytes()) if len(layers) == 1 else None
        return code, record, sorted(path.name for path in store_root.iterdir())

    def assertLayerRefused(self, role, extra, refused, **kwargs):
        code, record, stored = self.judged(role, extra, **kwargs)
        self.assertEqual((code, stored), ("WRITABLE_LAYER", []), "refused before store.begin: no bundle, no partial")
        self.assertEqual((record or {}).get("outcome"), "REFUSED", "the refused judgement is kept as a raw")
        self.assertEqual(record["refused"], sorted(role + ": " + change for change in refused))

    def test_the_regenerated_exception_is_typed_and_bound_to_the_orthanc_role_and_image(self):
        """P5 (R6 ①, O6-A, O6-B): exactly the five typed entries on the Orthanc role's container of the pinned image
        and its descriptor; every other role, image, container, kind, type, content and ancestor refuses before any
        bundle byte; the mount-point rule and the mount-sibling refusal stay (M47, M48, M50)."""
        code, record, stored = self.judged("orthanc", [])
        self.assertEqual((code, record["outcome"], len(stored)), ("SEALED", "ACCEPTED", 1))
        verdicts = {row["change"]: row["verdict"] for row in record["roles"]["orthanc"]["verdicts"]}
        self.assertEqual(verdicts["C /etc/hostid"], "regenerated:hostid")
        self.assertEqual({verdicts[change] for change in ("C /etc", "C /startup", "C /usr", "C /usr/share", "C /usr/share/orthanc",
                                                          "C /usr/share/orthanc/plugins")}, {"regenerated:ancestor"})
        self.assertEqual(verdicts["A /startup/__pycache__"], "regenerated:pycache")
        self.assertEqual({verdicts["A /startup/__pycache__/" + name] for name in PYC}, {"regenerated:pyc"})
        self.assertEqual({verdicts["A /usr/share/orthanc/plugins/" + name] for name in ENABLED}, {"regenerated:plugin"})
        self.assertEqual(verdicts["A /tmp/orthanc.json"], "transient-or-mount")
        same_image = {**cp.pinned_images(plan_fixture(), {"entry_checkout": "target"}), "api": ORTHANC_IMAGE}
        hostid = {cp.HOSTID: _file("9" * 64, 9, 0o644, 999, 999, "hex8-lf"), "/etc": _dir()}
        start = [change for change in ORTHANC_START if not cp.writable_layer_allowed(change)]   # /tmp stays transient everywhere
        cases = {
            # role and image (M48: the role guard alone refuses the API role on the same image ID)
            "the API role on the pinned Orthanc image with the same start": ("api", ORTHANC_START, start, dict(images=same_image, base=False)),
            "the API role on the pinned Orthanc image with a regenerated-shaped hostid": (
                "api", ["C /etc", "C /etc/hostid"], ["C /etc", "C /etc/hostid"], dict(images=same_image, base=False, facts=hostid)),
            "the database role's C /etc/hostid (O6-A)": ("db", ["C /etc", "C /etc/hostid"], ["C /etc", "C /etc/hostid"], dict(base=False, facts=hostid)),
            "the Orthanc role on another image ID": ("orthanc", [], start,
                                                    dict(images={**cp.pinned_images(plan_fixture(), {"entry_checkout": "target"}), "orthanc": image("8")})),
            "a descriptor that applies to nothing (a custom startup)": ("orthanc", [], start,
                                                                       dict(descriptor=regenerated_fixture("id-" + PROJECT + "-orthanc", applicable=False))),
            "another Orthanc container than the one the descriptor observed": ("orthanc", [], start,
                                                                              dict(descriptor=regenerated_fixture("id-other-orthanc"))),
            # /etc/hostid
            "an added hostid": ("orthanc", ["A /etc/hostid/kept"], ["A /etc/hostid/kept"], {}),
            "a hostid that is a folder": ("orthanc", [], ["C /etc", "C /etc/hostid"], dict(facts={cp.HOSTID: _dir(0o644, 999, 999)})),
            "a hostid that is a link": ("orthanc", [], ["C /etc", "C /etc/hostid"], dict(facts={cp.HOSTID: {"type": "link", "mode": 0o777, "uid": 999, "gid": 999}})),
            "a hostid of another content": ("orthanc", [], ["C /etc", "C /etc/hostid"], dict(facts={cp.HOSTID: _file("8" * 64, 21, 0o644, 999, 999, "other")})),
            "a hostid of another mode": ("orthanc", [], ["C /etc", "C /etc/hostid"], dict(facts={cp.HOSTID: _file("9" * 64, 9, 0o666, 999, 999, "hex8-lf")})),
            "a forced hostid (not the default generation)": ("orthanc", [], ["C /etc", "C /etc/hostid"],
                                                            dict(descriptor=regenerated_fixture("id-" + PROJECT + "-orthanc", hostid=False))),
            # /startup/__pycache__
            "an arbitrary .pyc": ("orthanc", ["A /startup/__pycache__/persistent.pyc"], ["A /startup/__pycache__/persistent.pyc"],
                                  dict(facts={cp.PYCACHE + "/persistent.pyc": _file("7" * 64, 10)})),
            "a state file in the cache (O6-A)": ("orthanc", ["A /startup/__pycache__/durable-state.json"], ["A /startup/__pycache__/durable-state.json"],
                                                 dict(facts={cp.PYCACHE + "/durable-state.json": _file("7" * 64, 10)})),
            "a folder named like a cache file": ("orthanc", [], ["A /startup/__pycache__/helpers.cpython-311.pyc"],
                                                 dict(facts={cp.PYCACHE + "/helpers.cpython-311.pyc": _dir()})),
            "a cache file of other bytes": ("orthanc", [], ["A /startup/__pycache__/helpers.cpython-311.pyc"],
                                            dict(facts={cp.PYCACHE + "/helpers.cpython-311.pyc": _file("6" * 64, 3000)})),
            "a nested cache file": ("orthanc", ["A /startup/__pycache__/sub/helpers.cpython-311.pyc"],
                                    ["A /startup/__pycache__/sub/helpers.cpython-311.pyc"], {}),
            "a changed (not added) cache folder": ("orthanc", ["C /startup/__pycache__"], ["C /startup/__pycache__"],
                                                   dict(drop=("A /startup/__pycache__",))),
            "a deleted cache file": ("orthanc", ["D /startup/__pycache__/helpers.cpython-311.pyc"], ["D /startup/__pycache__/helpers.cpython-311.pyc"],
                                     dict(drop=("A /startup/__pycache__/helpers.cpython-311.pyc",))),
            # /usr/share/orthanc/plugins (M47: anything but an enabled, available library refuses; M50: its bytes)
            "a non-plugin file among the plugins (O6-A)": ("orthanc", ["A /usr/share/orthanc/plugins/persistent-state.json"],
                                                          ["A /usr/share/orthanc/plugins/persistent-state.json"],
                                                          dict(facts={cp.PLUGINS + "/persistent-state.json": _file("7" * 64, 30)})),
            "an unlisted library (O6-A)": ("orthanc", ["A /usr/share/orthanc/plugins/custom-local.so"], ["A /usr/share/orthanc/plugins/custom-local.so"],
                                           dict(facts={cp.PLUGINS + "/custom-local.so": _file("7" * 64, 4096, 0o755, 999, 999)})),
            "an available library the start does not enable": ("orthanc", ["A /usr/share/orthanc/plugins/libOrthancTcia.so"],
                                                               ["A /usr/share/orthanc/plugins/libOrthancTcia.so"],
                                                               dict(facts={cp.PLUGINS + "/libOrthancTcia.so": dict(AVAILABLE["libOrthancTcia.so"])})),
            "an enabled library with other bytes (O6-B)": ("orthanc", [], ["A /usr/share/orthanc/plugins/libOrthancGdcm.so"],
                                                          dict(facts={cp.PLUGINS + "/libOrthancGdcm.so": _file("6" * 64, 40960, 0o755, 999, 999)})),
            "an enabled library that is a link": ("orthanc", [], ["A /usr/share/orthanc/plugins/libOrthancGdcm.so"],
                                                  dict(facts={cp.PLUGINS + "/libOrthancGdcm.so": {"type": "link", "mode": 0o777, "uid": 999, "gid": 999}})),
            "a folder among the plugins": ("orthanc", ["A /usr/share/orthanc/plugins/sub"], ["A /usr/share/orthanc/plugins/sub"],
                                           dict(facts={cp.PLUGINS + "/sub": _dir()})),
            "a changed enabled library": ("orthanc", ["C /usr/share/orthanc/plugins/libOrthancGdcm.so"], ["C /usr/share/orthanc/plugins/libOrthancGdcm.so"],
                                          dict(drop=("A /usr/share/orthanc/plugins/libOrthancGdcm.so",))),
            "a deleted library on another role (O6-A)": ("proxy", ["D /usr/share/orthanc/plugins/libOrthancGdcm.so"],
                                                         ["D /usr/share/orthanc/plugins/libOrthancGdcm.so"], dict(base=False)),
            # ancestors
            "a changed folder without an approved child": ("orthanc", [], ["C /etc"], dict(drop=("C /etc/hostid",))),
            "the plugins-available folder": ("orthanc", ["C /usr/share/orthanc/plugins-available"], ["C /usr/share/orthanc/plugins-available"], {}),
            "an ancestor of another mode": ("orthanc", [], ["C /usr/share/orthanc/plugins"], dict(facts={cp.PLUGINS: _dir(0o777, 999, 999)})),
            "an added ancestor": ("orthanc", ["A /usr/share/orthanc/extra"], ["A /usr/share/orthanc/extra"], {}),
            # the API role's state in the startup cache and the plugins (O6-A, r5 probe inputs)
            "the API role's file among the plugins (O6-A)": ("api", ["A /usr/share/orthanc/plugins/persistent-state.json"],
                                                            ["A /usr/share/orthanc/plugins/persistent-state.json"], dict(base=False)),
            "the API role's state in the startup cache (O6-A)": ("api", ["A /startup/__pycache__/durable-state.json"],
                                                                ["A /startup/__pycache__/durable-state.json"], dict(base=False)),
        }
        for name, (role, extra, refused, kwargs) in cases.items():
            with self.subTest(refused=name):
                self.assertLayerRefused(role, extra, refused, **kwargs)
        with self.subTest(kept="the mount point and the folder made for it, never a file beside it"):
            target = target_fixture()
            names = {item: target["containers"][item] for item in intro.ROLES}
            for diffs, expected in ((["A /etc/nginx", "A /etc/nginx/certs"], "SEALED"),
                                    (["A /etc/nginx", "A /etc/nginx/certs", "A /etc/nginx/extra.conf"], "WRITABLE_LAYER")):
                backend = FakeBackend(names, {**target["volumes"], "proxy_certs": PROJECT + "_proxy-certs"},
                                      images=cp.pinned_images(plan_fixture(), {"entry_checkout": "target"}))
                backend.containers[names["proxy"]]["mounts"] = [{"type": "volume", "name": PROJECT + "_proxy-certs", "destination": "/etc/nginx/certs"}]
                backend.diffs[names["proxy"]] = diffs
                try:
                    self.captured("introduced", backend, descriptor=regenerated_fixture("id-" + names["orthanc"]))
                    code = "SEALED"
                except cp.Refused as error:
                    code = error.code
                self.assertEqual(code, expected, diffs)

    def test_the_layer_record_is_required_and_rejudged_when_consumed(self):
        """P6 (R6 ②, O6-C): the descriptor is bound by the capture observation and the post-stop judgement by the
        manifest; load_bundle, the evidence index and a BOUND index's consumers refuse it missing (also with its raw rows),
        changed, or with a role, container, image or descriptor substituted; a normal bundle and index stay valid."""
        target = target_fixture()
        names = {role: target["containers"][role] for role in intro.ROLES}
        descriptor = regenerated_fixture("id-" + names["orthanc"])
        backend = FakeBackend(names, {**target["volumes"], "proxy_certs": PROJECT + "_proxy-certs"},
                              images=cp.pinned_images(plan_fixture(), {"entry_checkout": "target"}))
        backend.diffs[names["orthanc"]] = list(ORTHANC_START)
        backend.layers[names["orthanc"]] = start_facts(descriptor)
        final, _, _, _ = self.captured("introduced", backend, descriptor=descriptor)
        manifest, _ = self.admitted(cp.load_bundle, final)
        tree = final / "payload" / "fixture-tree.tar"
        raw = cp.tree_member_bytes(tree, manifest["bindings"]["layer"]["path"])
        files = cp.tree_folder(tree, manifest["bindings"]["observation"]["path"].rsplit("/", 1)[0])
        # r7: the record is judged in its whole bound context (the capture folder, plan, S, boundary facts, names).
        arguments = cp.layer_context(manifest, lambda rel: cp.tree_member_bytes(tree, rel), lambda rel: cp.tree_folder(tree, rel))
        self.assertEqual(arguments["observation_files"], files)
        self.admitted(cp.layer_valid, raw, **arguments)
        record = json.loads(raw)

        def edited(change):
            value = copy.deepcopy(record)
            change(value)
            return cp.canonical(value) + b"\n"

        def swap(value):
            value["roles"]["api"], value["roles"]["orthanc"] = value["roles"]["orthanc"], value["roles"]["api"]

        def refused_to_pass(value):
            value["roles"]["proxy"]["changes"].append("A /etc/kin-kept")
            value["roles"]["proxy"]["verdicts"].append({"change": "A /etc/kin-kept", "verdict": "transient-or-mount"})
        cases = {"the Orthanc row under another role": (edited(swap), {}),
                 "another container ID": (edited(lambda value: value["roles"]["orthanc"].update(container_id="id-other")), {}),
                 "another image ID": (edited(lambda value: value["roles"]["orthanc"].update(image=image("8"))), {}),
                 "a refused change recorded as accepted": (edited(refused_to_pass), {}),
                 "a role left out": (edited(lambda value: value["roles"].pop("keycloak")), {}),
                 "a refused judgement": (edited(lambda value: value.update(outcome="REFUSED", refused=["api: A /x"])), {}),
                 "another capture observation": (raw, {"observation": {**arguments["observation"], "sha256": "0" * 64}}),
                 "another descriptor": (raw, {"observation_files": {**files, cp.REGENERATED_FILE: cp.canonical(regenerated_fixture("id-other")) + b"\n"}}),
                 "a descriptor of another image": (raw, {"identity": {**arguments["identity"], "image_ids": {
                     "previous": {"orthanc": image("8")}, "release": {"orthanc": image("8")}}}}),
                 "a missing record": (None, {})}
        for name, (data, changes) in cases.items():
            with self.subTest(refused=name):
                # r8: an edited record has its layer binding rebound, so the refusal is the contract's, not the hash's.
                bound = {"layer_binding": {**arguments["layer_binding"], "sha256": cp.sha256(data)}} if data is not None else {}
                self.assertRefused("LAYER_INVALID", cp.layer_valid, data, **{**arguments, **bound, **changes})
        # load_bundle: the binding missing, beside another observation, or the record substituted with its binding.
        self.assertRefused("BUNDLE_INVALID", seal, self, self.tempdir() / "bundles", "introduced", drop=("layer",))
        fixture = self.tempdir()
        made = realistic(fixture, "introduced")
        made.bindings["layer"] = dict(made.bindings["secrets"])
        self.assertRefused("BUNDLE_INVALID", cp.load_bundle, bundle_from(self, fixture, made))
        fixture = self.tempdir()
        made = realistic(fixture, "introduced")
        path = fixture / made.bindings["layer"]["path"]
        substituted = json.loads(path.read_bytes())
        substituted["roles"]["api"]["changes"] = ["A /etc/kin-kept"]
        substituted["roles"]["api"]["verdicts"] = [{"change": "A /etc/kin-kept", "verdict": "regenerated:hostid"}]
        path.write_bytes(cp.canonical(substituted) + b"\n")
        made.bindings["layer"] = {**made.bindings["layer"], "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
        self.assertRefused("BUNDLE_INVALID", cp.load_bundle, bundle_from(self, fixture, made))
        # The evidence index and its consumers (CheckpointRecordTests' real recorder over a proof layout).
        records = CheckpointRecordTests(methodName="test_existing_record_run_binds_exact_inputs_outputs_and_exit")
        records.tempdir = self.tempdir
        unit = CheckpointRecordTests.UNIT

        def layer_files(change):
            def alter(kind, value, stack=None):
                if kind == "files":
                    for found in sorted(value.glob(cp.OBSERVATION_DIR + "/layer-*/" + cp.LAYER_FILE)):
                        change(found)
                return value
            return alter

        def rejudged(found):
            document = json.loads(found.read_bytes())
            document["roles"]["api"]["changes"] = ["A /etc/kin-kept"]
            document["roles"]["api"]["verdicts"] = [{"change": "A /etc/kin-kept", "verdict": "transient-or-mount"}]
            found.write_bytes(cp.canonical(document) + b"\n")
        removed = layer_files(lambda found: shutil.rmtree(found.parent))
        for name, alter, reason in (("the record removed with its raw rows", removed, "writable-layer record the checkpoint binds is not in the raw"),
                                    ("the record rewritten (rows rewritten)", layer_files(rejudged), "writable-layer record the checkpoint binds is not in the raw")):
            with self.subTest(index=name):
                proof = records.layout(unit, alter=alter)
                run_dir, completed = records.record(proof)
                self.assertEqual(completed.returncode, 0, completed.stderr)
                verdict = cp.leaf_index(proof.leaves, proof.unit, proof.root, run_dir)
                self.assertEqual(verdict["verdict"], "UNVERIFIED", name)
                self.assertTrue(any(reason in item for item in verdict["reasons"]), verdict["reasons"])
        with self.subTest(index="the record substituted together with the seal's binding"):
            def rebind(kind, value, stack=None):
                if kind == "files":
                    for found in sorted(value.glob(cp.OBSERVATION_DIR + "/layer-*/" + cp.LAYER_FILE)):
                        rejudged(found)
                        rebind.sha = hashlib.sha256(found.read_bytes()).hexdigest()
                if kind == "manifest":
                    value["bindings"]["layer"] = {**value["bindings"]["layer"], "sha256": rebind.sha}
                return value
            proof = records.layout(unit, alter=rebind)
            run_dir, completed = records.record(proof)
            verdict = cp.leaf_index(proof.leaves, proof.unit, proof.root, run_dir)
            self.assertEqual(verdict["verdict"], "UNVERIFIED")
            self.assertTrue(any("writable-layer record: " in item for item in verdict["reasons"]), verdict["reasons"])
        with self.subTest(index="the record changed after the BOUND index"):
            root = self.tempdir("kin-proof-")
            proof = records.layout(unit, root=root)
            run_dir, _ = records.record(proof)
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(cp.main(["index", "--registry", str(root / "registry.json"), "--unit", unit, "--proof-root", str(root),
                                          "--run-dir", str(run_dir)]), 0)
            self.admitted(cp.bound_index, root, unit)
            found = next(proof.evidence.rglob(cp.LAYER_FILE))
            found.write_bytes(found.read_bytes() + b" ")
            self.assertRefused("PARENT_UNBOUND", cp.bound_index, root, unit)

    def test_the_descriptor_is_derived_from_the_pinned_image_never_from_the_running_diff(self):
        """P7 (R6 ①②, consultation binding): the descriptor comes from a pristine probe of the pinned image ID with the
        container's own startup input, cached per image ID and startup-input hash; an absent container, another image, a
        custom startup or an incomplete probe applies to nothing; FORCE_HOST_ID or disabled generation drop the hostid
        entry only; no environment value reaches it."""
        compile(cp.REGENERATED_PROBE, "regenerated-probe", "exec")
        pre = {"stage": "pre", "hostid": _file(hashlib.sha256(b"not-generated\n").hexdigest(), 14, 0o644, 999, 999, "placeholder"),
               "pycache_dir": {"type": "absent"}, "pycache": None, "plugins_dir": _dir(0o755, 999, 999), "plugins": {},
               "python": {"cache_tag": "cpython-311", "optimize": 0, "version": "3.11.2", "no_bytecode": False}, "entrypoint": _file("f" * 64, 2068, 0o755),
               "startup": {"configurator.py": _file("1" * 64, 11100), "generateConfiguration.py": _file("2" * 64, 3157), "helpers.py": _file("3" * 64, 2455)},
               "available": {name: {**fact, "inode": index + 10, "links": 2} for index, (name, fact) in enumerate(sorted(AVAILABLE.items()))},
               "ancestors": regenerated_fixture("x")["image"]["ancestors"]}
        post = {"stage": "post", "hostid": _file("9" * 64, 9, 0o644, 999, 999, "hex8-lf"), "pycache_dir": _dir(), "pycache": copy.deepcopy(PYC),
                "plugins_dir": _dir(0o755, 999, 999), "plugins": {name: {**pre["available"][name]} for name in ENABLED}}

        class Backend:
            def __init__(self, *, env=("ORTHANC__REGISTERED_USERS={\"admin\":\"" + SECRET_VALUE + "\"}",), entrypoint=("/docker-entrypoint.sh",),
                         image=ORTHANC_IMAGE, probe=None, absent=False):
                self.probes, self.absent, self.probe = 0, absent, probe
                self.config = {"id": "id-orthanc", "name": PROJECT + "-orthanc", "image": image, "entrypoint": list(entrypoint),
                               "cmd": ["/tmp/orthanc.json"], "user": "", "env": ["PATH=/usr/bin", *env], "mounts": []}

            def container_config(self, name):
                return None if self.absent else copy.deepcopy(self.config)

            def image_config(self, image_id):
                return {"id": image_id, "entrypoint": ["/docker-entrypoint.sh"], "cmd": ["/tmp/orthanc.json"], "env": ["PATH=/usr/bin"], "user": ""}

            config_input_digest = staticmethod(lambda mount: None)

            def probe_regenerated(self, image_id, **kwargs):
                self.probes += 1
                return copy.deepcopy(self.probe or {"pre": pre, "post": post, "entry_exit": 0, "probe_exit": 0,
                                                    "helper": {"name": "kin-ckpt-regen-x", "id": "h" * 64, "removed": True}})
        with patch.dict(cp.REGENERATED_CACHE, clear=True), patch.dict(cp.REGENERATED_INVENTORY, clear=True):
            backend = Backend()
            descriptor = self.admitted(cp.regenerated_descriptor, backend, PROJECT + "-orthanc", pinned=ORTHANC_IMAGE, token=TOKEN)
            self.assertEqual((descriptor["applicable"], descriptor["hostid_regenerated"], backend.probes), (True, True, 1))
            self.assertEqual(sorted(descriptor["generated"]["pycache"]), sorted(PYC))
            self.assertEqual(sorted(descriptor["generated"]["plugins"]), sorted(ENABLED))
            self.assertEqual({fact["link"] for fact in descriptor["generated"]["plugins"].values()}, {"hard link"})
            self.assertNotIn(SECRET_VALUE, cp.canonical(descriptor).decode(), "names and a hash of the environment only")
            again = cp.regenerated_descriptor(backend, PROJECT + "-orthanc", pinned=ORTHANC_IMAGE, token=TOKEN)
            self.assertEqual((backend.probes, again["probe"].get("reused"), again["generated"]), (1, True, descriptor["generated"]),
                             "the same image ID and startup input reuse the first probe")
            other = Backend(env=("ORTHANC__REGISTERED_USERS=other",))
            cp.regenerated_descriptor(other, PROJECT + "-orthanc", pinned=ORTHANC_IMAGE, token=TOKEN)
            self.assertEqual(other.probes, 1, "another startup input is probed again")
            for name, backend, applicable, hostid, probes in (
                    ("no container", Backend(absent=True), False, False, 0),
                    ("another image", Backend(image=image("8")), False, False, 0),
                    ("a custom entrypoint", Backend(entrypoint=("/custom.sh",)), False, False, 0),
                    ("a custom startup script", Backend(env=("BEFORE_ORTHANC_STARTUP_SCRIPT=/x.sh",)), False, False, 0),
                    ("a forced hostid", Backend(env=("FORCE_HOST_ID=12345678",)), True, False, 1),
                    ("hostid generation disabled", Backend(env=("GENERATE_HOST_ID_IF_MISSING=false",)), True, False, 1),
                    ("the image's start failed in the probe", Backend(env=("A=1",), probe={"pre": pre, "post": post, "entry_exit": 1,
                                                                                         "helper": {"removed": True}}), False, False, 1),
                    ("a cache file of another interpreter", Backend(env=("A=2",), probe={"pre": pre, "post": {**post, "pycache": {"helpers.cpython-312.pyc": _file("e" * 64, 1)}},
                                                                                        "entry_exit": 0, "helper": {"removed": True}}), False, False, 1),
                    ("a generated library unlike the image's", Backend(env=("A=3",), probe={"pre": pre, "post": {**post, "plugins": {"libOrthancGdcm.so": _file("6" * 64, 40960, 0o755, 999, 999)}},
                                                                                         "entry_exit": 0, "helper": {"removed": True}}), False, False, 1),
                    ("a probe helper not observed removed", Backend(env=("A=4",), probe={"pre": pre, "post": post, "entry_exit": 0,
                                                                                       "helper": {"removed": False}}), False, False, 1)):
                with self.subTest(descriptor=name):
                    result = cp.regenerated_descriptor(backend, PROJECT + "-orthanc", pinned=ORTHANC_IMAGE, token=TOKEN)
                    self.assertEqual((result["applicable"], result["hostid_regenerated"], backend.probes), (applicable, hostid, probes), result["reasons"])
                    self.assertTrue(result["reasons"] or result["hostid_reasons"])


DEADLINE_SCENARIO = textwrap.dedent("""\
    import json, os, subprocess, sys, time
    sys.path[:0] = [sys.argv[1], sys.argv[2], sys.argv[3]]
    from unittest.mock import patch
    import ops_release_checkpoints as cp
    mode, out = sys.argv[4], {}
    sleeper = lambda seconds, *prefix: [sys.executable, "-c", "import sys, time; print(*sys.argv[1:], flush=True); time.sleep(%s); print('finished', flush=True)" % seconds, *prefix]
    tree = ("import subprocess, sys, time; print('started', flush=True); child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(2)'],"
            " stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); print('grandchild', child.pid, flush=True); time.sleep(2); print('finished', flush=True)")

    def cut(deadline, args, timeout=30):
        start = time.monotonic()
        try:
            with cp.deadline_scope(deadline):
                result = cp.run_bounded(args, timeout=timeout, capture_output=True)
            return {"outcome": "completed", "stdout": result.stdout.decode(), "elapsed": time.monotonic() - start}
        except cp.DeadlineExpired as error:
            return {"outcome": error.code, "event": error.event, "elapsed": time.monotonic() - start}

    def alive(pid):
        try:
            with open("/proc/%d/stat" % pid) as stream:
                return stream.read().rsplit(") ", 1)[1].split()[0] != "Z"
        except OSError:
            return False

    if mode == "cut":
        out = cut(cp.Deadline(0.5, label="body"), [sys.executable, "-c", tree])
        head = ((out.get("event") or {}).get("partial") or {}).get("stdout") or {}
        words = (head.get("head") or "").split()
        if os.name == "posix" and "grandchild" in words:
            time.sleep(0.2)
            out["grandchild_alive"] = alive(int(words[words.index("grandchild") + 1]))
    elif mode == "shared":
        deadline = cp.Deadline(1.2, label="body")
        out = {"first": cut(deadline, sleeper(0.6, "first")), "second": cut(deadline, sleeper(2, "second"))}
    elif mode == "expired":
        import ops_deploy_host_container_test as rehearsal
        deadline = cp.Deadline(0.05, label="cleanup")
        time.sleep(0.1)
        calls, refused = [], {}
        inner = lambda args, **kwargs: calls.append(args)
        with patch.object(cp.subprocess, "Popen", lambda *args, **kwargs: calls.append(args)), cp.deadline_scope(deadline):
            for name, action in (("run_bounded", lambda: cp.run_bounded(sleeper(0), timeout=30)),
                                 ("adapter inventory", lambda: rehearsal.CheckpointDocker(None, None).inventory()),
                                 ("poll sleep", lambda: cp.pause(1)), ("product runner", lambda: cp.DeadlineRunner(inner)(["git", "status"]))):
                try:
                    action()
                    refused[name] = "started"
                except cp.DeadlineExpired as error:
                    refused[name] = error.event["kind"]
        out = {"refused": refused, "transport_calls": len(calls), "events": len(deadline.events)}
    elif mode == "runner":
        import ops_emr_introduction as intro
        given = []
        def inner(args, *, timeout=60, **kwargs):
            given.append(timeout)
            try:
                return subprocess.run(sleeper(2), capture_output=True, timeout=timeout)
            except subprocess.TimeoutExpired:
                raise intro.Unknown("a client timeout of the product transport") from None
        deadline = cp.Deadline(0.3, label="body")
        start = time.monotonic()
        try:
            with cp.deadline_scope(deadline):
                cp.DeadlineRunner(inner)(["git", "status"], timeout=60)
            out["outcome"] = "completed"
        except intro.Unknown:
            out["outcome"] = "UNKNOWN"
        out.update(elapsed=time.monotonic() - start, given=given, events=deadline.events)
    print("DEADLINE_SCENARIO " + json.dumps(out, default=str))
    """)


# ── r11 (consult-checkpoints-t16-host-20261021 option b, D1666/D1669): the stopped writable layer on the daemon's own
# storage backend. REQ-CKPT-STORAGE-01 (observe the deployment backend's stopped writable layer) -> RISK-CKPT-STORAGE-01
# (a wrong or unobserved layer accepted as regenerated) -> TEST-CKPT-STORAGE-01 (overlay2/containerd fact parity), -02
# (a missing, malformed or wrong-identity mapping gives no facts and the capture refuses with no bundle byte); -03 (the
# native seeded/held regeneration and cold restore) is the smoke and T16 on the containerd VM, not a pure test. ──
STORAGE_CONTAINER_ID = "4" * 64
STORAGE_INFO = {
    "overlay2": {"ID": "DAEMON:OVERLAY2", "ServerVersion": "28.5.1", "Driver": "overlay2",
                 "DriverStatus": [["Backing Filesystem", "extfs"], ["Supports d_type", "true"], ["Using metacopy", "false"],
                                  ["Native Overlay Diff", "true"], ["userxattr", "false"]],
                 "Containerd": {"Address": "/run/containerd/containerd.sock", "Namespaces": {"Containers": "moby", "Plugins": "plugins.moby"}}},
    # As the T16 VM (Docker 29.1.3) and production (2026-10-12 observation) report the containerd image store.
    "containerd": {"ID": "DAEMON:CONTAINERD", "ServerVersion": "29.1.3", "Driver": "overlayfs",
                   "DriverStatus": [["driver-type", "io.containerd.snapshotter.v1"]],
                   "Containerd": {"Address": "/run/containerd/containerd.sock", "Namespaces": {"Containers": "moby", "Plugins": "plugins.moby"}}},
}


class StorageDaemon:
    """A fake process table for CheckpointDocker's storage reads: `docker info`, `docker container inspect` and
    containerd's client (`ctr ... snapshots info|mounts`), and (r12) the reads of CheckpointDocker.inventory - the
    capture's own listing (`docker ps`, `docker inspect <ids>`, volume/network/image listings) whose container identity
    the layer read is bound to. An answer is (exit, stdout bytes), an exception to raise, or a callable of the call's
    ordinal for its kind (0 = the resolution before the read, 1 = after). Every call is recorded; any other command
    fails the test (the adapter may only read)."""

    INVENTORY = ("ps", "listed", "volumes", "networks", "images")

    def __init__(self, answers):
        self.answers, self.calls, self.seen = answers, [], {}

    @staticmethod
    def kind(args):
        if args[:2] == ["docker", "info"]:
            return "info"
        if args[:3] == ["docker", "container", "inspect"]:
            return "inspect"
        if args[:2] == ["docker", "ps"]:
            return "ps"
        if args[:2] == ["docker", "inspect"]:
            return "listed"
        if args[:3] in (["docker", "volume", "ls"], ["docker", "network", "ls"], ["docker", "image", "ls"]):
            return {"volume": "volumes", "network": "networks", "image": "images"}[args[1]]
        if args[:1] == ["ctr"] and "snapshots" in args and args[-2:-1] == ["info"]:
            return "snapshot"
        if args[:1] == ["ctr"] and "snapshots" in args and args[-3:-2] == ["mounts"]:
            return "mounts"
        raise AssertionError("not a storage read: " + " ".join(args[:4]))

    def run(self, args, **kwargs):
        kind = self.kind(list(args))
        ordinal = self.seen.get(kind, 0)
        self.seen[kind] = ordinal + 1
        self.calls.append((kind, list(args), sorted(kwargs.get("env") or {})))
        answer = self.answers[kind]
        answer = answer(ordinal) if callable(answer) else answer
        if isinstance(answer, BaseException):
            raise answer
        return subprocess.CompletedProcess(args, answer[0], answer[1], b"")


class LayerAdapterBackend(FakeBackend):
    """FakeBackend whose layer_facts is the real CheckpointDocker.layer_facts over a StorageDaemon and a real folder.
    r12 (CKPT11-01): the capture's inventory lists the Orthanc container as the same real adapter's inventory parsed it
    from the daemon, so the identity capture_checkpoint seals and the one the layer read is bound to come from one
    listing (the r11 fixture sealed id-<name> while the adapter read another ID)."""
    adapter = None

    def inventory(self):
        listing = super().inventory()
        real = {item["name"]: item for item in self.adapter.inventory()["containers"]}
        listing["containers"] = [real.get(item["name"], item) for item in listing["containers"]]
        return listing

    def layer_facts(self, name, paths):
        self.calls.append(("layer_facts", name))
        return self.adapter(name, paths, listed=False)   # bound to the capture's own inventory above, not a new one


class CheckpointLayerStorageTests(CaptureFixture, RefusalAssertions, TempCase):
    """r11 (D1666/D1669, TEST-CKPT-STORAGE-01/02): CheckpointDocker.layer_facts reads a stopped container's upper folder on
    overlay2 (GraphDriver.Data.UpperDir) and on the containerd overlayfs snapshotter (the daemon's containerd endpoint
    and namespace, the active snapshot keyed by the container ID, the upper folder containerd names), with the same
    facts; every other backend, and any mapping that is missing, malformed, ambiguous, of another container or changed
    during the read, gives no facts, and the live judgement then refuses before store.begin."""

    NAME = PROJECT + "-orthanc"

    def tree(self):
        """A writable upper folder of a normal Orthanc start inside a snapshotter-shaped root (snapshots/<n>/fs and
        work), with two lower layers and a second snapshot folder; real files and folders, and a real symlink and
        whiteout (a 0/0 character device) where the platform lets this process make them (else their lstat is given)."""
        root = self.tempdir("kin-layer-")
        for number in ("2", "3", "17", "18"):
            (root / "snapshots" / number / "fs").mkdir(parents=True)
            (root / "snapshots" / number / "work").mkdir()
        upper = root / "snapshots" / "17" / "fs"
        files = {cp.HOSTID: b"1a2b3c4d\n", "/etc/kin-placeholder": b"not-generated\n",
                 cp.PYCACHE + "/configurator.cpython-311.pyc": b"\x00pyc-configurator" * 40, cp.PYCACHE + "/helpers.cpython-311.pyc": b"\x00pyc-helpers" * 30,
                 cp.PLUGINS + "/libOrthancDicomWeb.so": b"\x7fELF-dicomweb" * 100, cp.PLUGINS + "/libOrthancGdcm.so": b"\x7fELF-gdcm" * 90}
        for path, data in files.items():
            (upper / path.lstrip("/")).parent.mkdir(parents=True, exist_ok=True)
            (upper / path.lstrip("/")).write_bytes(data)
        (upper / "tmp").mkdir()
        given = {}
        try:
            os.symlink("hostid", str(upper / "etc" / "kin-link"))
        except (OSError, NotImplementedError):
            given[str(upper / "etc" / "kin-link")] = os.stat_result((stat.S_IFLNK | 0o777, 0, 0, 1, 0, 0, 6, 0, 0, 0))
        try:
            os.mknod(str(upper / "etc" / "kin-whiteout"), stat.S_IFCHR | 0o000, os.makedev(0, 0))
        except (AttributeError, OSError):
            given[str(upper / "etc" / "kin-whiteout")] = os.stat_result((stat.S_IFCHR, 0, 0, 1, 0, 0, 0, 0, 0, 0))
        return SimpleNamespace(root=root, upper=upper, work=root / "snapshots" / "17" / "work", files=files, given=given)

    @staticmethod
    def mount_line(tree, number="17", **options):
        snapshot = tree.root / "snapshots" / number
        values = {"index": "off", "workdir": (snapshot / "work").as_posix(), "upperdir": (snapshot / "fs").as_posix(),
                  "lowerdir": (tree.root / "snapshots" / "3" / "fs").as_posix() + ":" + (tree.root / "snapshots" / "2" / "fs").as_posix()}
        values.update(options)
        text = ",".join(key + "=" + value if value is not True else key for key, value in values.items() if value is not None)
        return ("mount -t overlay overlay /kin-ckpt-not-mounted -o " + text + "\n").encode()

    def answers(self, backend, tree, *, name=None, edit=None, raw=None, listed_id=None):
        """The daemon's normal answers for one stopped container of `backend`, each edited (`edit`: kind -> function of
        a deep copy) or replaced (`raw`: kind -> answer). `listed` is the same container as the capture's inventory saw
        it before the stop (running, ID `listed_id`, default the resolved one): the identity the read is bound to."""
        name = name or self.NAME
        container = {"Id": STORAGE_CONTAINER_ID, "Name": "/" + name, "Image": ORTHANC_IMAGE,
                     "Config": {"Labels": {"com.docker.compose.project": PROJECT}}, "Mounts": [],
                     "State": {"Status": "exited", "Running": False, "Paused": False, "Restarting": False, "ExitCode": 0}}
        if backend == "overlay2":
            container["GraphDriver"] = {"Name": "overlay2", "Data": {"LowerDir": str(tree.root / "lower"), "MergedDir": str(tree.root / "merged"),
                                                                      "UpperDir": str(tree.upper), "WorkDir": str(tree.work)}}
        else:
            container.update(GraphDriver=None, Storage={"RootFS": {"Snapshot": {"Name": "overlayfs"}}})
        listed = {**copy.deepcopy(container), "Id": listed_id or STORAGE_CONTAINER_ID,
                  "State": {"Status": "running", "Running": True, "Paused": False, "Restarting": False, "ExitCode": 0}}
        documents = {"info": copy.deepcopy(STORAGE_INFO[backend]), "inspect": [container], "listed": [listed],
                     "snapshot": {"Kind": "Active", "Name": STORAGE_CONTAINER_ID, "Parent": "sha256:" + "6" * 64,
                                  "Labels": {"containerd.io/gc.root": "2026-10-21T10:17:30Z"}, "Created": "2026-10-21T10:17:20Z"}}
        for kind, change in (edit or {}).items():
            documents[kind] = change(copy.deepcopy(documents[kind]))
        answers = {kind: (0, json.dumps(document).encode()) for kind, document in documents.items()}
        answers.update(mounts=(0, self.mount_line(tree)), ps=(0, (documents["listed"][0]["Id"] + "\n").encode()),
                       volumes=(0, b""), networks=(0, b""), images=(0, b""))
        answers.update(raw or {})
        return answers

    def adapter(self, backend, tree, **changes):
        """(layer_facts callable, the StorageDaemon, the observations it records) of one real adapter. The callable
        takes the adapter's own inventory first (as capture_checkpoint does before the stop) unless `listed` is False
        in `changes` or it is called with listed=False; `.inventory` runs that inventory alone (the capture's listing)."""
        import ops_deploy_host_container_test as rehearsal
        daemon = StorageDaemon(self.answers(backend, tree, **{key: changes[key] for key in ("name", "edit", "raw", "listed_id") if key in changes}))
        given = {**tree.given, **changes.get("given", {})}
        real = Path.lstat
        start = len(rehearsal.LAYER_RESOLUTIONS)
        docker = rehearsal.CheckpointDocker(None, None)

        def lstat(path, *args, **kwargs):
            fact = given.get(str(path))
            if isinstance(fact, BaseException):
                raise fact
            return fact if fact is not None else real(path, *args, **kwargs)

        def patched(call):
            clean = {key: value for key, value in os.environ.items() if not key.startswith(("DOCKER_", "COMPOSE_"))}
            with patch.object(rehearsal, "subprocess", SimpleNamespace(run=daemon.run, PIPE=subprocess.PIPE)), \
                    patch.object(Path, "lstat", lstat), patch.dict(os.environ, {**clean, "DOCKER_HOST": "tcp://elsewhere:2376"}, clear=True):
                return call()

        def facts(name, paths, listed=changes.get("listed", True)):
            if listed:
                patched(docker.inventory)
            return patched(lambda: docker.layer_facts(name, paths))
        facts.inventory = lambda: patched(docker.inventory)
        return facts, daemon, lambda: rehearsal.LAYER_RESOLUTIONS[start:]

    PATHS = sorted([*cp.REGENERATED_ANCESTORS, cp.HOSTID, cp.PYCACHE, *(cp.PYCACHE + "/" + name for name in PYC),
                    *(cp.PLUGINS + "/" + name for name in ENABLED), "/etc/kin-placeholder", "/etc/kin-link", "/etc/kin-whiteout",
                    "/etc/kin-absent", "/tmp"])

    def test_overlay2_and_containerd_give_the_same_facts_through_their_own_metadata(self):
        """TEST-CKPT-STORAGE-01: the same upper folder read through either backend gives the same lstat facts (type, mode,
        uid/gid, size/SHA-256, the hostid content class, links, whiteouts, absences); each resolves twice (before and after
        the read) only from its owner's metadata, with read-only calls, no DOCKER_* selection, and records the mapping."""
        tree = self.tree()
        observed = {}
        for backend in ("overlay2", "containerd"):
            facts, daemon, records = self.adapter(backend, tree)
            observed[backend] = facts(self.NAME, self.PATHS)
            with self.subTest(backend=backend):
                self.assertEqual(sorted(observed[backend] or {}), self.PATHS)
                kinds = [call[0] for call in daemon.calls]
                expected = ["info", "inspect"] + (["snapshot", "mounts"] if backend == "containerd" else [])
                listing = [kind for kind in kinds if kind in StorageDaemon.INVENTORY]
                self.assertEqual(kinds[:len(listing)], listing, "the capture's inventory comes first")
                self.assertEqual(kinds[len(listing):], expected * 2, "one resolution before and one after the read, reads only")
                self.assertTrue(all(not key.startswith(("DOCKER_", "COMPOSE_")) for call in daemon.calls for key in call[2]))
                for kind, args, _ in daemon.calls:
                    if args[0] == "ctr":
                        self.assertEqual(args[1:8], ["--address", "/run/containerd/containerd.sock", "--namespace", "moby", "snapshots",
                                                     "--snapshotter", "overlayfs"], "the daemon's own containerd endpoint and namespace")
                        self.assertEqual(args[-1], STORAGE_CONTAINER_ID, "the snapshot keyed by the inspected container ID")
                record = records()[-1]
                self.assertEqual((record["outcome"], record["before"], record["after"]["upper"]), ("observed", record["after"], str(tree.upper)))
                self.assertEqual((record["before"]["container_id"], record["before"]["backend"]), (STORAGE_CONTAINER_ID, backend))
                self.assertEqual(record["capture_identity"], {"id": STORAGE_CONTAINER_ID, "image": ORTHANC_IMAGE}, "bound to the inventory's identity")
        self.assertEqual(observed["overlay2"], observed["containerd"], "TEST-CKPT-STORAGE-01: fact parity")
        facts = observed["containerd"]
        data = tree.files[cp.HOSTID]
        self.assertEqual({key: facts[cp.HOSTID][key] for key in ("type", "size", "sha256", "text")},
                         {"type": "file", "size": len(data), "sha256": hashlib.sha256(data).hexdigest(), "text": "hex8-lf"})
        self.assertEqual(facts["/etc/kin-placeholder"]["text"], "placeholder")
        for path in (cp.PYCACHE + "/helpers.cpython-311.pyc", cp.PLUGINS + "/libOrthancGdcm.so"):
            self.assertEqual((facts[path]["size"], facts[path]["sha256"], facts[path]["text"]),
                             (len(tree.files[path]), hashlib.sha256(tree.files[path]).hexdigest(), "other"))
            self.assertEqual(facts[path]["mode"], stat.S_IMODE(os.lstat(str(tree.upper / path.lstrip("/"))).st_mode))
        self.assertEqual({facts[path]["type"] for path in (*cp.REGENERATED_ANCESTORS, cp.PYCACHE, "/tmp")}, {"dir"})
        self.assertEqual((facts["/etc/kin-link"]["type"], facts["/etc/kin-whiteout"]["type"], facts["/etc/kin-absent"]),
                         ("link", "whiteout", {"type": "absent"}))
        self.assertTrue(all(set(fact) == cp.LAYER_FACT_KEYS[fact["type"]] for fact in facts.values()), "the record's closed fact shapes")

    def unestablished(self, tree):
        """name -> (backend, changes): every mapping the adapter must not read through."""
        other = "7" * 64

        def inspect(**fields):
            return lambda items: [{**items[0], **fields}]

        def info(**fields):
            return lambda document: {**document, **fields}
        line = self.mount_line
        swap = lambda first, second: (lambda ordinal: first if ordinal == 0 else second)  # noqa: E731
        normal_inspect = self.answers("containerd", tree)["inspect"]
        return {
            # the daemon's storage facts
            "the daemon does not answer": ("containerd", {"raw": {"info": (1, b"")}}),
            "the daemon's answer is not JSON": ("containerd", {"raw": {"info": (0, b"{not json")}}),
            "a malformed DriverStatus": ("containerd", {"edit": {"info": info(DriverStatus="driver-type")}}),
            "a DriverStatus row that is not a pair": ("containerd", {"edit": {"info": info(DriverStatus=[["driver-type"]])}}),
            "two driver types (ambiguous)": ("containerd", {"edit": {"info": info(DriverStatus=[["driver-type", "io.containerd.snapshotter.v1"]] * 2)}}),
            "the containerd native snapshotter": ("containerd", {"edit": {"info": info(Driver="native")}}),
            "a containerd stargz snapshotter": ("containerd", {"edit": {"info": info(Driver="stargz")}}),
            "a btrfs graph driver": ("overlay2", {"edit": {"info": info(Driver="btrfs", DriverStatus=[["Build Version", "Btrfs v6.6"]])}}),
            "a vfs graph driver": ("overlay2", {"edit": {"info": info(Driver="vfs", DriverStatus=[])}}),
            "a fuse-overlayfs graph driver": ("overlay2", {"edit": {"info": info(Driver="fuse-overlayfs", DriverStatus=[])}}),
            "overlay2 named with a containerd driver type": ("overlay2", {"edit": {"info": info(DriverStatus=[["driver-type", "io.containerd.snapshotter.v1"]])}}),
            "no containerd endpoint": ("containerd", {"edit": {"info": lambda document: {k: v for k, v in document.items() if k != "Containerd"}}}),
            "a remote containerd endpoint": ("containerd", {"edit": {"info": info(Containerd={"Address": "tcp://10.0.0.5:1234", "Namespaces": {"Containers": "moby"}})}}),
            "no containerd namespace": ("containerd", {"edit": {"info": info(Containerd={"Address": "/run/containerd/containerd.sock", "Namespaces": {}})}}),
            "a namespace that is an option": ("containerd", {"edit": {"info": info(Containerd={"Address": "/run/containerd/containerd.sock", "Namespaces": {"Containers": "--all"}})}}),
            # the container
            "the inspection fails": ("containerd", {"raw": {"inspect": (1, b"")}}),
            "two inspections": ("containerd", {"edit": {"inspect": lambda items: items * 2}}),
            "an inspection that is not a list": ("containerd", {"edit": {"inspect": lambda items: items[0]}}),
            "another container's inspection": ("containerd", {"edit": {"inspect": inspect(Name="/kin-other-orthanc-1")}}),
            "a short container ID": ("containerd", {"edit": {"inspect": inspect(Id="4" * 12)}}),
            "a running container": ("containerd", {"edit": {"inspect": inspect(State={"Running": True, "Restarting": False})}}),
            "a restarting container": ("containerd", {"edit": {"inspect": inspect(State={"Running": False, "Restarting": True})}}),
            "no state": ("containerd", {"edit": {"inspect": inspect(State=None)}}),
            "an overlay2 upper folder under the containerd daemon": ("containerd", {"edit": {"inspect": inspect(GraphDriver={"Name": "overlay2", "Data": {"UpperDir": str(tree.upper)}})}}),
            "another snapshotter declared by the container": ("containerd", {"edit": {"inspect": inspect(Storage={"RootFS": {"Snapshot": {"Name": "native"}}})}}),
            "a malformed GraphDriver": ("containerd", {"edit": {"inspect": inspect(GraphDriver=["overlayfs"])}}),
            # containerd's own metadata
            "no containerd client on the host": ("containerd", {"raw": {"snapshot": FileNotFoundError(2, "ctr")}}),
            "containerd has no snapshot of that key": ("containerd", {"raw": {"snapshot": (1, b"")}}),
            "the snapshot answer is not JSON": ("containerd", {"raw": {"snapshot": (0, b"Active")}}),
            "a snapshot keyed by another ID": ("containerd", {"edit": {"snapshot": lambda document: {**document, "Name": other}}}),
            "a committed (image) snapshot": ("containerd", {"edit": {"snapshot": lambda document: {**document, "Kind": "Committed"}}}),
            "no mounts": ("containerd", {"raw": {"mounts": (1, b"")}}),
            "two mounts": ("containerd", {"raw": {"mounts": (0, line(tree) + line(tree, "18"))}}),
            "a bind mount (a layer without a parent)": ("containerd", {"raw": {"mounts": (0, ("mount -t bind " + tree.upper.as_posix()
                                                                                             + " /kin-ckpt-not-mounted -o rbind,rw\n").encode())}}),
            "a mount without upperdir": ("containerd", {"raw": {"mounts": (0, line(tree, upperdir=None))}}),
            "a mount with two upperdirs": ("containerd", {"raw": {"mounts": (0, line(tree).replace(b",lowerdir=", b",upperdir="
                                                                                                    + (tree.root / "snapshots" / "18" / "fs").as_posix().encode() + b",lowerdir="))}}),
            "a read-only mount without workdir": ("containerd", {"raw": {"mounts": (0, line(tree, workdir=None, upperdir=None))}}),
            "an upper folder outside the snapshotter's folders": ("containerd", {"raw": {"mounts": (0, line(tree, upperdir=(tree.root / "fs").as_posix()))}}),
            "an upper folder that is a lower layer": ("containerd", {"raw": {"mounts": (0, line(tree, "3"))}}),
            "a work folder of another snapshot": ("containerd", {"raw": {"mounts": (0, line(tree, workdir=(tree.root / "snapshots" / "18" / "work").as_posix()))}}),
            "an upper folder that does not exist": ("containerd", {"raw": {"mounts": (0, line(tree, "19"))}}),
            "an upper folder that is a file": ("containerd", {"given": {str(tree.upper): os.stat_result((stat.S_IFREG | 0o644, 0, 0, 1, 0, 0, 1, 0, 0, 0))}}),
            "an unreadable upper folder": ("containerd", {"given": {str(tree.upper): PermissionError(13, "denied")}}),
            # the read itself and the mapping after it
            "a changed path that cannot be read": ("containerd", {"given": {str(tree.upper / "etc" / "hostid"): PermissionError(13, "denied")}}),
            "the snapshot's upper folder changes during the read": ("containerd", {"raw": {"mounts": swap((0, line(tree)), (0, line(tree, "18")))}}),
            "the container is replaced during the read": ("containerd", {"raw": {"inspect": swap(normal_inspect, (0, json.dumps(
                [{**json.loads(normal_inspect[1])[0], "Id": other}]).encode()))}}),
            "the container is started during the read": ("containerd", {"raw": {"inspect": swap(normal_inspect, (0, json.dumps(
                [{**json.loads(normal_inspect[1])[0], "State": {"Running": True}}]).encode()))}}),
            "the daemon is another one after the read": ("containerd", {"raw": {"info": swap((0, json.dumps(STORAGE_INFO["containerd"]).encode()), (0, json.dumps(
                {**STORAGE_INFO["containerd"], "ID": "DAEMON:OTHER"}).encode()))}}),
            # overlay2
            "overlay2 without an upper folder": ("overlay2", {"edit": {"inspect": inspect(GraphDriver={"Name": "overlay2", "Data": {}})}}),
            "overlay2 with a null GraphDriver": ("overlay2", {"edit": {"inspect": inspect(GraphDriver=None)}}),
            "another driver's GraphDriver on an overlay2 daemon": ("overlay2", {"edit": {"inspect": inspect(GraphDriver={"Name": "devicemapper", "Data": {"UpperDir": str(tree.upper)}})}}),
            "a running overlay2 container": ("overlay2", {"edit": {"inspect": inspect(State={"Running": True})}}),
            "an overlay2 upper folder that does not exist": ("overlay2", {"edit": {"inspect": inspect(GraphDriver={"Name": "overlay2", "Data": {"UpperDir": str(tree.root / "absent")}})}}),
            "a relative overlay2 upper folder": ("overlay2", {"edit": {"inspect": inspect(GraphDriver={"Name": "overlay2", "Data": {"UpperDir": "snapshots/17/fs"}})}}),
            **self.unestablished_r12(tree),
        }

    def unestablished_r12(self, tree):
        """r12 (CKPT11-01..03), on both backends where the field is consumed by both: the capture's identity, present
        malformed metadata, an invalid upper path and an unavailable metadata client."""
        other, image7 = "7" * 64, "sha256:" + "7" * 64
        normal = {backend: self.answers(backend, tree)["inspect"] for backend in ("overlay2", "containerd")}

        def inspect(**fields):
            return {"edit": {"inspect": lambda items: [{**items[0], **fields}]}}

        def state(value):
            return inspect(State={"Status": "exited", "Running": False, "Paused": False, "Restarting": value, "ExitCode": 0})

        def replaced_after(backend, **fields):
            first = normal[backend]
            return {"raw": {"inspect": lambda ordinal: first if ordinal == 0 else (0, json.dumps([{**json.loads(first[1])[0], **fields}]).encode())}}
        nul = {"overlay2": inspect(GraphDriver={"Name": "overlay2", "Data": {"UpperDir": str(tree.upper) + "\x00"}}),
               # the snapshotter's own layout (snapshots/<n>/fs beside work) under a root that has the NUL
               "containerd": {"raw": {"mounts": (0, self.mount_line(tree, upperdir=tree.root.as_posix() + "\x00/snapshots/17/fs",
                                                                     workdir=tree.root.as_posix() + "\x00/snapshots/17/work"))}}}
        cases = {}
        for backend in ("overlay2", "containerd"):
            per = {
                # CKPT11-01: the capture's identity (its inventory's ID and image) across both resolutions
                "the name resolves to another container than the capture's inventory listed": inspect(Id=other),
                "the capture's inventory listed another container under the name": {"listed_id": other},
                "no capture inventory listed the container": {"listed": False},
                "the capture's inventory listed another image": {"edit": {"listed": lambda items: [{**items[0], "Image": image7}]}},
                "the capture's inventory listed an image that is not a string": {"edit": {"listed": lambda items: [{**items[0], "Image": 7}]}},
                "the inspected image is not the capture's": inspect(Image=image7),
                "the inspected image is missing": {"edit": {"inspect": lambda items: [{k: v for k, v in items[0].items() if k != "Image"}]}},
                "the container is replaced by another ID between the resolutions": replaced_after(backend, Id=other),
                "the image changes between the resolutions": replaced_after(backend, Image=image7),
                # CKPT11-02: present malformed state and daemon identity are no facts
                **{"State.Restarting is %s" % label: state(value) for label, value in
                   (("'true'", "true"), ("1", 1), ("[]", []), ("{}", {}), ("null", None))},
                "State.Restarting is missing": inspect(State={"Status": "exited", "Running": False}),
                "State.Running is 0": inspect(State={"Running": 0, "Restarting": False}),
                "the daemon reports no ID": {"edit": {"info": lambda document: {k: v for k, v in document.items() if k != "ID"}}},
                "the daemon's ID is empty": {"edit": {"info": lambda document: {**document, "ID": ""}}},
                "the daemon's ID is not a string": {"edit": {"info": lambda document: {**document, "ID": 7}}},
                "a GraphDriver without a string Name": inspect(GraphDriver={"Name": 7, "Data": None}),
                "a GraphDriver whose Data is a string": inspect(GraphDriver={"Name": "overlay2", "Data": "upper"}),
                "a GraphDriver UpperDir that is a list": inspect(GraphDriver={"Name": "overlay2", "Data": {"UpperDir": [str(tree.upper)]}}),
                # CKPT11-03: an invalid upper path and an unavailable metadata client
                "an upper folder with an embedded NUL": nul[backend],
                "docker is not installed (info)": {"raw": {"info": FileNotFoundError(2, "docker")}},
                "docker is not executable (inspect)": {"raw": {"inspect": PermissionError(13, "docker")}},
            }
            cases.update({backend + ": " + name: (backend, changes) for name, changes in per.items()})
        for value in ([], "overlayfs", 7, {"RootFS": []}, {"RootFS": "overlayfs"}, {"RootFS": {"Snapshot": []}},
                      {"RootFS": {"Snapshot": "overlayfs"}}, {"RootFS": {"Snapshot": {}}}, {"RootFS": {"Snapshot": {"Name": None}}},
                      {"RootFS": {"Snapshot": {"Name": []}}}):
            cases["containerd: Storage = " + json.dumps(value)] = ("containerd", inspect(Storage=value))
        return cases

    def optional_absences(self, tree):
        """name -> (backend, changes): metadata the Engine legitimately omits (omitempty) - still facts (CKPT11-02's
        controls: the strict checks refuse a present malformed value, not an allowed absence)."""
        def inspect(transform):
            return {"edit": {"inspect": lambda items: [transform(dict(items[0]))]}}

        def without(*keys):
            return inspect(lambda item: {k: v for k, v in item.items() if k not in keys})
        return {
            "containerd: no Storage (an older Engine API)": ("containerd", without("Storage")),
            "containerd: Storage null": ("containerd", inspect(lambda item: {**item, "Storage": None})),
            "containerd: Storage without RootFS": ("containerd", inspect(lambda item: {**item, "Storage": {}})),
            "containerd: RootFS null": ("containerd", inspect(lambda item: {**item, "Storage": {"RootFS": None}})),
            "containerd: Snapshot null": ("containerd", inspect(lambda item: {**item, "Storage": {"RootFS": {"Snapshot": None}}})),
            "containerd: no GraphDriver": ("containerd", without("GraphDriver")),
            "containerd: a GraphDriver of the snapshotter without Data": ("containerd", inspect(lambda item: {**item, "GraphDriver": {"Name": "overlayfs", "Data": None}})),
            "overlay2: no Containerd section in docker info": ("overlay2", {"edit": {"info": lambda document: {k: v for k, v in document.items() if k != "Containerd"}}}),
            "overlay2: no Storage": ("overlay2", without("Storage")),
            # recorded only, never judged: another shape is kept as recorded (None for a non-string Parent)
            "overlay2: ServerVersion that is not a string": ("overlay2", {"edit": {"info": lambda document: {**document, "ServerVersion": [29]}}}),
            "containerd: a snapshot Parent that is not a string": ("containerd", {"edit": {"snapshot": lambda document: {**document, "Parent": []}}}),
        }

    def test_a_mapping_that_is_not_established_gives_no_facts(self):
        """TEST-CKPT-STORAGE-02 (adapter): every unsupported backend and every missing, malformed, ambiguous, wrong-identity,
        unreadable or changed mapping gives no facts (None, never a partial map or an exception), keeps its reason in the
        recorded observation and reads nothing but storage metadata."""
        tree = self.tree()
        for name, (backend, changes) in self.unestablished(tree).items():
            with self.subTest(refused=name):
                facts, daemon, records = self.adapter(backend, tree, **changes)
                try:
                    value = facts(self.NAME, self.PATHS)
                except Exception as error:   # CKPT11-03: an unestablished mapping is no facts, never an exception
                    self.fail("raised %s: %s" % (type(error).__name__, error))
                self.assertIsNone(value)
                self.assertTrue(records(), "the observation is recorded")
                record = records()[-1]
                reason = record.get("reason") or (record.get("before") or {}).get("reason")
                self.assertEqual(record["outcome"], "unobservable")
                self.assertTrue(type(reason) is str and reason, record)
                self.assertTrue(daemon.calls and all(kind in ("info", "inspect", "snapshot", "mounts", *StorageDaemon.INVENTORY)
                                                     for kind, _, _ in daemon.calls))

    def test_an_allowed_omission_is_not_a_malformed_field(self):
        """CKPT11-02 controls: fields the Engine omits (omitempty) where it has nothing to declare still give the same
        facts as the normal answer; only a present value of another shape is refused."""
        tree = self.tree()
        expected = {backend: self.adapter(backend, tree)[0](self.NAME, self.PATHS) for backend in ("overlay2", "containerd")}
        for name, (backend, changes) in self.optional_absences(tree).items():
            with self.subTest(allowed=name):
                facts, _, records = self.adapter(backend, tree, **changes)
                self.assertEqual(facts(self.NAME, self.PATHS), expected[backend])
                self.assertEqual(records()[-1]["outcome"], "observed")

    def test_an_observation_failure_is_recorded_and_only_a_stop_escapes(self):
        """CKPT11-03: a changed path the OS cannot name (an embedded NUL) gives no facts like an unreadable one, with its
        observation kept; a deadline cut and a programming error are not observation failures - they still end the
        capture as before (never read as 'unobservable' and continued), and their observation is kept too."""
        tree = self.tree()
        for backend in ("overlay2", "containerd"):
            with self.subTest(backend=backend, case="a changed path with an embedded NUL"):
                facts, _, records = self.adapter(backend, tree)
                try:
                    value = facts(self.NAME, [cp.HOSTID, "/etc/kin\x00hostid"])
                except Exception as error:
                    self.fail("raised %s: %s" % (type(error).__name__, error))
                self.assertIsNone(value)
                # r13 (CKPT12-04, D73): the contract is no facts, an unobservable outcome and a retained explanatory reason -
                # not one free-form sentence.
                record = records()[-1]
                self.assertEqual(record["outcome"], "unobservable")
                self.assertTrue(type(record.get("reason")) is str and record["reason"].strip(), record)
            for kind, error in (("info", cp.DeadlineExpired("cut", {"kind": "cut"})), ("inspect", cp.DeadlineExpired("cut", {"kind": "cut"})),
                                ("inspect", TypeError("a programming error"))):
                with self.subTest(backend=backend, stop=type(error).__name__, at=kind):
                    facts, _, records = self.adapter(backend, tree, raw={kind: error})
                    with self.assertRaises(type(error)):
                        facts(self.NAME, self.PATHS)
                    self.assertEqual([(row["outcome"], row.get("interrupted")) for row in records()[-1:]], [("unobservable", type(error).__name__)])

    def live_descriptor(self, tree):
        """The descriptor of the live judgement's normal Orthanc start over `tree` (as test_the_live_judgement builds it)."""
        read = self.adapter("overlay2", tree, name=PROJECT + "-orthanc")[0](PROJECT + "-orthanc", cp.regenerated_candidates(ORTHANC_START))
        descriptor = regenerated_fixture(STORAGE_CONTAINER_ID)
        descriptor["image"]["hostid"] = {**{key: read[cp.HOSTID][key] for key in ("type", "mode", "uid", "gid")}, "size": 14,
                                         "sha256": hashlib.sha256(b"not-generated\n").hexdigest(), "text": "placeholder"}
        descriptor["image"]["ancestors"] = {path: dict(read[path]) for path in cp.REGENERATED_ANCESTORS}
        descriptor["generated"].update(hostid=dict(read[cp.HOSTID]), pycache_dir=dict(read[cp.PYCACHE]),
                                       pycache={name: dict(read[cp.PYCACHE + "/" + name]) for name in PYC})
        for name in ENABLED:
            descriptor["generated"]["plugins"][name] = {**read[cp.PLUGINS + "/" + name], "link": "hard link"}
            descriptor["image"]["available"][name] = dict(read[cp.PLUGINS + "/" + name])
        return descriptor, read

    def test_an_unnameable_containerd_endpoint_is_refused_before_any_process(self):
        """r13 (CKPT12-02, TEST-CKPT-STORAGE-02 endpoint subcase): a Containerd.Address the OS cannot pass as an argument
        (an embedded NUL) at the first or the second resolution gives no facts with its reason kept, and the live
        judgement refuses WRITABLE_LAYER with no bundle - before any process is created. The ctr argv goes to this host's
        real process-creation boundary (a local Python child with the same arguments; no ctr, no daemon). A local pathname
        and a unix:/// endpoint still seal."""
        import ops_deploy_host_container_test as rehearsal
        tree = self.tree()
        descriptor, _ = self.live_descriptor(tree)
        normal = json.loads(self.answers("containerd", tree)["info"][1])

        def info(first, second):
            def answer(ordinal):
                document = copy.deepcopy(normal)
                document["Containerd"]["Address"] = first if ordinal == 0 else second
                return 0, json.dumps(document).encode()
            return answer
        created, real_run = [], StorageDaemon.run

        def run(daemon, args, **kwargs):
            if args[0] == "ctr":
                created.append(list(args))
                subprocess.run([sys.executable, "-c", "pass", *args[1:]], capture_output=True, timeout=60)
            return real_run(daemon, args, **kwargs)
        good, nul = "/run/containerd/containerd.sock", "/run/containerd\x00.sock"
        for label, first, second, expected in (("a local pathname", good, good, "SEALED"),
                                               ("a unix:/// endpoint", "unix://" + good, "unix://" + good, "SEALED"),
                                               ("a NUL at the first resolution", nul, good, "WRITABLE_LAYER"),
                                               ("a NUL at the second resolution", good, nul, "WRITABLE_LAYER")):
            with self.subTest(endpoint=label):
                created.clear()
                with patch.object(StorageDaemon, "run", run):
                    code, record, stored = self.judged("containerd", tree, descriptor, raw={"info": info(first, second)})
                self.assertEqual(code, expected)
                self.assertFalse(any("\x00" in arg for args in created for arg in args), "no process was created with the NUL")
                if expected == "SEALED":
                    self.assertEqual((len(stored), record["roles"]["orthanc"]["layer_observable"]), (1, True))
                    self.assertTrue(created and all(args[2] == first for args in created))
                    continue
                self.assertEqual((stored, record["outcome"], record["roles"]["orthanc"]["layer_observable"]), ([], "REFUSED", False))
                observation = rehearsal.LAYER_RESOLUTIONS[-1]
                reason = observation.get("reason") or (observation.get("before") or {}).get("reason")
                self.assertEqual((observation["outcome"], observation.get("interrupted")), ("unobservable", None))
                self.assertTrue(type(reason) is str and reason.strip(), observation)

    def judged(self, backend, tree, descriptor, **changes):
        """capture_checkpoint at INTRODUCED with the Orthanc role's normal start, its writable layer read by the real
        adapter over `backend`. r12: the capture's identity is the descriptor's container ID - the capture's inventory
        lists the Orthanc container under it through the same real adapter, and the boundary facts and capture
        observation carry it - so what is sealed and what the layer read is bound to are one identity. Returns (code,
        layer record, store listing)."""
        target = target_fixture()
        names = {item: target["containers"][item] for item in intro.ROLES}
        volumes = {**target["volumes"], "proxy_certs": PROJECT + "_proxy-certs"}
        capture = descriptor["container_id"]
        layered = LayerAdapterBackend(names, volumes, images=cp.pinned_images(plan_fixture(), {"entry_checkout": "target"}))
        layered.adapter = self.adapter(backend, tree, name=names["orthanc"], **{"listed_id": capture, **changes})[0]
        layered.containers[names["orthanc"]]["id"] = capture
        layered.diffs[names["orthanc"]] = list(ORTHANC_START)
        fixture, store_root = self.tempdir(), self.tempdir() / "bundles"
        try:
            self.captured("introduced", layered, descriptor=descriptor, fixture=fixture, store_root=store_root, ids={"orthanc": capture})
            code = "SEALED"
        except cp.Refused as error:
            code = error.code
        except Exception as error:   # CKPT11-03: an observation failure is the typed refusal, never another exception
            self.fail("the capture raised %s: %s" % (type(error).__name__, error))
        layers = sorted(fixture.glob("*/records/" + cp.OBSERVATION_DIR + "/layer-*/" + cp.LAYER_FILE))
        record = json.loads(layers[-1].read_bytes()) if len(layers) == 1 else None
        return code, record, sorted(path.name for path in store_root.iterdir()) if store_root.exists() else []

    def test_the_live_judgement_seals_only_an_established_layer(self):
        """TEST-CKPT-STORAGE-01/02 through the live judgement: a normal Orthanc start read on the containerd snapshotter
        or on overlay2 is accepted as the pinned image's regeneration and sealed; the same start whose mapping is not
        established is refused WRITABLE_LAYER before store.begin (no bundle, no partial), its record kept unobservable."""
        import ops_deploy_host_container_test as rehearsal
        tree = self.tree()
        paths = cp.regenerated_candidates(ORTHANC_START)
        read = self.adapter("overlay2", tree, name=PROJECT + "-orthanc")[0](PROJECT + "-orthanc", paths)
        names = {item: target_fixture()["containers"][item] for item in intro.ROLES}
        descriptor = regenerated_fixture(STORAGE_CONTAINER_ID)   # r12: the container the daemon resolves (r11 sealed id-<name>)
        meta = {key: read[cp.HOSTID][key] for key in ("type", "mode", "uid", "gid")}
        descriptor["image"]["hostid"] = {**meta, "size": 14, "sha256": hashlib.sha256(b"not-generated\n").hexdigest(), "text": "placeholder"}
        descriptor["image"]["ancestors"] = {path: dict(read[path]) for path in cp.REGENERATED_ANCESTORS}
        generated = descriptor["generated"]
        generated.update(hostid=dict(read[cp.HOSTID]), pycache_dir=dict(read[cp.PYCACHE]),
                         pycache={name: dict(read[cp.PYCACHE + "/" + name]) for name in PYC})
        for name in ENABLED:
            generated["plugins"][name] = {**read[cp.PLUGINS + "/" + name], "link": "hard link"}
            descriptor["image"]["available"][name] = dict(read[cp.PLUGINS + "/" + name])
        for backend in ("containerd", "overlay2"):
            with self.subTest(sealed=backend):
                code, record, stored = self.judged(backend, tree, descriptor)
                row = record["roles"]["orthanc"]
                self.assertEqual((code, record["outcome"], row["layer_observable"], len(stored)), ("SEALED", "ACCEPTED", True, 1))
                self.assertEqual(row["facts"], read)
                self.assertEqual({item["verdict"] for item in row["verdicts"]} - {"transient-or-mount"},
                                 {"regenerated:hostid", "regenerated:pycache", "regenerated:pyc", "regenerated:plugin", "regenerated:ancestor"})
                observation = rehearsal.LAYER_RESOLUTIONS[-1]
                self.assertEqual((row["container_id"], observation["capture_identity"]["id"], observation["before"]["container_id"],
                                  observation["after"]["container_id"]), (descriptor["container_id"],) * 4, "sealed = listed = resolved twice")
        start = [change for change in ORTHANC_START if not cp.writable_layer_allowed(change)]
        refused = ["a snapshot keyed by another ID", "the containerd native snapshotter", "no containerd client on the host",
                   "the snapshot's upper folder changes during the read", "a changed path that cannot be read", "a btrfs graph driver"]
        # r12 (CKPT11-01..03) through capture_checkpoint on both backends: Astra's capture probes and their kin.
        refused += [backend + ": " + name for backend in ("overlay2", "containerd") for name in (
            "the name resolves to another container than the capture's inventory listed",
            "the container is replaced by another ID between the resolutions", "the inspected image is not the capture's",
            "the image changes between the resolutions", "State.Restarting is 'true'", "the daemon reports no ID",
            "an upper folder with an embedded NUL", "docker is not installed (info)", "docker is not executable (inspect)")]
        refused += ["containerd: Storage = []", 'containerd: Storage = {"RootFS": {"Snapshot": []}}']
        cases = self.unestablished(tree)
        for name in refused:
            backend, changes = cases[name]
            with self.subTest(refused=name):
                code, record, stored = self.judged(backend, tree, descriptor, **changes)
                self.assertEqual((code, stored), ("WRITABLE_LAYER", []), "refused before store.begin: no bundle, no partial")
                row = record["roles"]["orthanc"]
                self.assertEqual((record["outcome"], row["layer_observable"], row["facts"]), ("REFUSED", False, {}))
                self.assertEqual(record["refused"], sorted("orthanc: " + change for change in start))
                observation = rehearsal.LAYER_RESOLUTIONS[-1]
                reason = observation.get("reason") or observation["before"].get("reason")
                self.assertEqual(observation["outcome"], "unobservable")
                self.assertTrue(type(reason) is str and reason, observation)


REPLACEMENT_IMAGE = image("e")   # another image than any role's pinned one


class ContainerDaemon:
    """r13 (CKPT12-01): a finite fake process table of one stack's five role containers for the real CheckpointDocker
    capture path (inventory, stop, diff, the Orthanc layer read): each container has a full 64-hex ID, its image, state
    and `docker diff` lines, and is found by its exact name or ID as the daemon finds it. `replace` recreates a role under
    the same name as Compose does (the original is renamed and kept, its state unchanged; a new ID takes the name), so a
    name stops resolving to the inventoried container. `hooks` (when, verb, role) -> function run once before or after
    the daemon answers that call for the role (its name or any ID it had); `raw` verb -> an answer (exit, stdout), an
    exception to raise or a function of the argv. Every call and every effect (stop) is recorded; any other command fails."""

    VERBS = {("docker", "ps"): "ps", ("docker", "inspect"): "listed", ("docker", "stop"): "stop", ("docker", "diff"): "diff",
             ("docker", "info"): "info"}

    def __init__(self, backend, names, images, *, diffs=None, running=None, tree=None):
        self.backend, self.names, self.tree = backend, dict(names), tree
        self.calls, self.effects, self.hooks, self.raw, self.history = [], [], {}, {}, {}
        self.containers = {}
        running = set(intro.ROLES) if running is None else set(running)
        for role in intro.ROLES:
            if role not in names:
                continue
            ident = STORAGE_CONTAINER_ID if role == "orthanc" else hashlib.sha256(("ckpt12 " + role).encode()).hexdigest()
            self.containers[ident] = {"name": names[role], "image": images[role], "running": role in running, "restarting": False,
                                      "exit": 0, "oom": False, "diff": list((diffs or {}).get(role, []))}
            self.history[role] = [ident]

    def ident(self, role):
        return next((ident for ident, item in self.containers.items() if item["name"] == self.names.get(role)), None)

    def lookup(self, ref):
        return ref if ref in self.containers else next((ident for ident, item in self.containers.items() if item["name"] == ref), None)

    def replace(self, role, *, image=None, running=True, diff=()):
        """Returns (original ID, replacement ID)."""
        old = self.ident(role)
        self.containers[old]["name"] = self.names[role] + "-old-" + old[:12]
        new = hashlib.sha256(("ckpt12 replacement %s %d" % (role, len(self.containers))).encode()).hexdigest()
        self.containers[new] = {"name": self.names[role], "image": image or self.containers[old]["image"], "running": running,
                                "restarting": False, "exit": 0, "oom": False, "diff": list(diff)}
        self.history[role].append(new)
        return old, new

    def verb(self, args):
        if args[:3] == ["docker", "container", "inspect"]:
            return "inspect"
        if args[:3] in (["docker", "volume", "ls"], ["docker", "network", "ls"], ["docker", "image", "ls"]):
            return {"volume": "volumes", "network": "networks", "image": "images"}[args[1]]
        if args[:1] == ["ctr"] and "snapshots" in args:
            return "snapshot" if args[-2:-1] == ["info"] else "mounts"
        if tuple(args[:2]) in self.VERBS:
            return self.VERBS[tuple(args[:2])]
        raise AssertionError("not a command of the capture path: " + " ".join(args[:4]))

    def inspected(self, ident):
        item = self.containers[ident]
        document = {"Id": ident, "Name": "/" + item["name"], "Image": item["image"], "Config": {"Labels": {"com.docker.compose.project": PROJECT}},
                    "Mounts": [], "State": item.get("state", {"Status": "running" if item["running"] else "exited", "Running": item["running"],
                                                              "Paused": False, "Restarting": item["restarting"], "ExitCode": item["exit"],
                                                              "OOMKilled": item["oom"]})}
        upper = self.tree.upper if self.tree is not None else Path("/nonexistent/kin-upper")
        if self.backend == "overlay2":
            document["GraphDriver"] = {"Name": "overlay2", "Data": {"UpperDir": str(upper), "WorkDir": str(upper.parent / "work"),
                                                                    "LowerDir": str(upper.parent / "lower"), "MergedDir": str(upper.parent / "merged")}}
        else:
            document.update(GraphDriver=None, Storage={"RootFS": {"Snapshot": {"Name": "overlayfs"}}})
        return document

    def fire(self, when, verb, ref):
        for (at, kind, role), action in list(self.hooks.items()):
            if at == when and kind == verb and (ref == self.names[role] or ref in self.history[role]):
                del self.hooks[(at, kind, role)]
                action()

    def run(self, args, **kwargs):
        args = list(args)
        verb = self.verb(args)
        self.calls.append((verb, args))
        ref = args[-1] if verb in ("inspect", "stop", "diff") else None
        self.fire("before", verb, ref)
        answer = self.raw.get(verb)
        if callable(answer) and not isinstance(answer, BaseException):
            answer = answer(args)
        if isinstance(answer, BaseException):
            raise answer
        if answer is None:
            answer = self.answer(verb, args)
        self.fire("after", verb, ref)
        return subprocess.CompletedProcess(args, answer[0], answer[1], b"")

    def answer(self, verb, args):
        if verb == "ps":
            return 0, "".join(ident + "\n" for ident in self.containers).encode()
        if verb == "listed":   # the inventory's `docker inspect <ids>` (and 458142a's stop, which inspected by name)
            found = [self.lookup(ref) for ref in args[2:]]
            return (0, json.dumps([self.inspected(ident) for ident in found]).encode()) if None not in found else (1, b"")
        if verb in ("volumes", "networks", "images"):
            return 0, b""
        if verb == "info":
            return 0, json.dumps(STORAGE_INFO[self.backend]).encode()
        if verb == "snapshot":
            known = args[-1] in self.containers
            return (0, json.dumps({"Kind": "Active", "Name": args[-1], "Parent": "sha256:" + "6" * 64}).encode()) if known else (1, b"")
        if verb == "mounts":
            return 0, CheckpointLayerStorageTests.mount_line(self.tree)
        ident = self.lookup(args[-1])
        if ident is None:
            return 1, b""
        if verb == "inspect":
            return 0, json.dumps([self.inspected(ident)]).encode()
        if verb == "stop":
            self.effects.append(("stop", ident))
            item = self.containers[ident]
            item.update(running=item.get("stays_running", False), exit=0 if not item.get("stays_running") else item["exit"])
            return 0, (ident + "\n").encode()
        return 0, "".join(line + "\n" for line in self.containers[ident]["diff"]).encode()


class AdapterCaptureBackend(FakeBackend):
    """FakeBackend for the volumes and exports; the capture's inventory, stop, diff and layer read are the real
    CheckpointDocker over a ContainerDaemon (r13: FakeBackend's own stop and diff are not the paths under test). `at`
    (verb, role) -> function runs when capture_checkpoint calls that adapter method for the role, before it runs."""

    def attach(self, daemon, tree=None):
        import ops_deploy_host_container_test as rehearsal
        self.daemon, self.docker, self.at, self.rehearsal = daemon, rehearsal.CheckpointDocker(None, None), {}, rehearsal
        self.given = dict(tree.given) if tree is not None else {}
        for role, name in self.names.items():
            if role in intro.ROLES and daemon.ident(role) is not None:
                self.containers[name].update(id=daemon.ident(role), image=daemon.containers[daemon.ident(role)]["image"])
            elif role in intro.ROLES:
                self.containers.pop(name, None)
        return self

    def real(self, call):
        real_lstat = Path.lstat

        def lstat(path, *args, **kwargs):
            fact = self.given.get(str(path))
            return fact if fact is not None else real_lstat(path, *args, **kwargs)
        with patch.object(self.rehearsal, "subprocess", SimpleNamespace(run=self.daemon.run, PIPE=subprocess.PIPE)), \
                patch.object(Path, "lstat", lstat):
            return call()

    def fire(self, verb, name):
        role = next(role for role, item in self.names.items() if item == name)
        action = self.at.pop((verb, role), None)
        if action is not None:
            action()

    def inventory(self):
        listing = super().inventory()
        listing["containers"] = self.real(self.docker.inventory)["containers"]
        return listing

    def stop(self, name):
        self.calls.append(("stop", name))
        self.fire("stop", name)
        return self.real(lambda: self.docker.stop(name))

    def writable_changes(self, name):
        self.calls.append(("diff", name))
        self.fire("diff", name)
        return self.real(lambda: self.docker.writable_changes(name))

    def layer_facts(self, name, paths):
        self.calls.append(("layer_facts", name))
        self.fire("layer_facts", name)
        return self.real(lambda: self.docker.layer_facts(name, paths))


TRANSIENT = ["C /run", "A /run/nginx.pid", "C /var", "C /var/cache", "A /var/cache/nginx/proxy_temp"]


class CheckpointStopDiffIdentityTests(CaptureFixture, RefusalAssertions, TempCase):
    """r13 (CKPT12-01, TEST-CKPT-STORAGE-01/02 stop/diff-identity subcases; consult-checkpoints-r13-plan-20261022): the
    real capture_checkpoint over the real CheckpointDocker stop and diff (a ContainerDaemon process table, all five roles,
    full 64-hex IDs, pinned images) stops and observes exactly the containers its inventory listed: a same- or
    other-image replacement before the stop is never stopped (STOP_UNCONFIRMED, the original keeps running); a
    replacement before or during the diff, a container that is not definitely stopped, failed metadata and a failed diff
    refuse WRITABLE_LAYER - empty and transient-only diffs (Orthanc without a layer read) included - before store.begin,
    any export or bundle, with the reason kept; a matching capture still seals. The native smoke's standalone stop and
    diff observe their actual subject without the capture binding."""

    BACKENDS = ("overlay2", "containerd")

    def capture(self, backend, *, diffs=None, running=None, before=None, at=None, absent=(), descriptor=None, tree=None):
        """capture_checkpoint at INTRODUCED. Returns a namespace: code, reason, the daemon, the stop effects, store.begin and
        export counts, the bundles, the layer record and this capture's adapter observations."""
        import ops_deploy_host_container_test as rehearsal
        target = target_fixture()
        names = {role: target["containers"][role] for role in intro.ROLES}
        volumes = {**target["volumes"], "proxy_certs": PROJECT + "_proxy-certs"}
        pins = cp.pinned_images(plan_fixture(), {"entry_checkout": "target"})
        present = {role: name for role, name in names.items() if role not in absent}
        daemon = ContainerDaemon(backend, present, pins, diffs={role: TRANSIENT for role in intro.ROLES} if diffs is None else diffs,
                                 running=running, tree=tree)
        layered = AdapterCaptureBackend(names, volumes, images=pins).attach(daemon, tree)
        for key, action in (at or {}).items():
            layered.at[key] = (lambda action=action: action(daemon))
        if before is not None:
            before(daemon)
        ids = {role: daemon.ident(role) for role in present}
        descriptor = descriptor or (absent_descriptor(target) if "orthanc" in absent else regenerated_fixture(ids["orthanc"]))
        fixture, store_root = self.tempdir(), self.tempdir() / "bundles"
        begun, start = [], len(rehearsal.LAYER_RESOLUTIONS)
        real_begin = cp.BundleStore.begin

        def begin(store, *args, **kwargs):
            begun.append(args)
            return real_begin(store, *args, **kwargs)
        code, reason = "SEALED", None
        with patch.object(cp.BundleStore, "begin", begin):
            try:
                self.captured("introduced", layered, descriptor=descriptor, fixture=fixture, store_root=store_root, ids=ids,
                              absent=tuple(absent))
            except cp.Refused as error:
                code, reason = error.code, str(error)
        layers = sorted(fixture.glob("*/records/" + cp.OBSERVATION_DIR + "/layer-*/" + cp.LAYER_FILE))
        return SimpleNamespace(code=code, reason=reason, daemon=daemon, ids=ids, stops=[ident for kind, ident in daemon.effects if kind == "stop"],
                               begun=len(begun), exports=sum(1 for call in layered.calls if call[0] == "export"),
                               bundles=sorted(path.name for path in store_root.iterdir()) if store_root.exists() else [],
                               layer=json.loads(layers[-1].read_bytes()) if len(layers) == 1 else None,
                               observations=list(rehearsal.LAYER_RESOLUTIONS[start:]), calls=list(layered.calls))

    def assertNothingSealed(self, result, code):
        self.assertEqual((result.code, result.begun, result.exports, result.bundles), (code, 0, 0, []),
                         "refused before store.begin, any export or bundle: " + str(result.reason))
        refused = [row for row in result.observations if row.get("outcome") != "observed"]
        reason = (refused[-1].get("reason") or (refused[-1].get("before") or {}).get("reason")) if refused else None
        self.assertTrue(type(reason) is str and reason.strip(), "the reason is kept: %s" % result.observations)

    def test_a_matching_capture_seals_and_acts_only_on_the_inventoried_ids(self):
        """Positive controls: empty and transient-only diffs on both backends seal one bundle; every role was stopped by its
        inventoried ID and diffed by it (stopped before and after); a persistent change is still refused by the judgement
        (its REFUSED layer record kept); an absent role and source-b0 (no daemon side) stay as they were."""
        for backend in self.BACKENDS:
            for label, diffs in (("empty", {role: [] for role in intro.ROLES}), ("transient-only", None)):
                with self.subTest(backend=backend, diffs=label):
                    result = self.capture(backend, diffs=diffs)
                    self.assertEqual((result.code, result.begun, len(result.bundles)), ("SEALED", 1, 1), result.reason)
                    self.assertEqual(sorted(result.stops), sorted(result.ids.values()), "each running role stopped once, by its own ID")
                    self.assertTrue(all(args[-1] in result.ids.values() for verb, args in result.daemon.calls if verb in ("stop", "diff")),
                                    "stop and diff name the inventoried IDs, never a name")
                    self.assertEqual([call for call in result.calls if call[0] == "layer_facts"], [], "no regenerated candidate: no layer read")
                    diffs_seen = {row["container_name"]: row for row in result.observations if row.get("observation") == "diff"}
                    self.assertEqual(sorted(diffs_seen), sorted(result.daemon.names.values()))
                    for row in diffs_seen.values():
                        self.assertEqual((row["outcome"], row["before"]["id"], row["after"]["id"]),
                                         ("observed", row["capture_identity"]["id"], row["capture_identity"]["id"]))
                    self.assertEqual(result.layer["outcome"], "ACCEPTED")
            with self.subTest(backend=backend, case="a persistent change in each role"):
                for role in intro.ROLES:
                    result = self.capture(backend, diffs={**{item: [] for item in intro.ROLES}, role: ["A /opt/kin-persistent"]})
                    self.assertEqual((result.code, result.begun, result.bundles, result.layer["outcome"]), ("WRITABLE_LAYER", 0, [], "REFUSED"))
                    self.assertEqual(result.layer["refused"], [role + ": A /opt/kin-persistent"])
            with self.subTest(backend=backend, case="an absent role is recorded, never stopped or diffed"):
                result = self.capture(backend, absent=("api",))
                self.assertEqual((result.code, result.layer["roles"]["api"]), ("SEALED", {"absent": True, "container_name": PROJECT + "-api"}))
                self.assertNotIn(PROJECT + "-api", [args[-1] for verb, args in result.daemon.calls if verb in ("stop", "diff", "inspect")])
        fixture = self.tempdir()
        made = realistic(fixture, "source-b0")
        store = cp.BundleStore(self.tempdir() / "bundles", forbidden=[fixture])
        sealed = cp.capture_checkpoint(checkpoint_id="source-b0", store=store, backend=None,
                                       boundary=cp.boundary_publishable("source-b0", state=made.state, result=made.result, result_raw=made.raw),
                                       names={role: made.target["containers"][role] for role in intro.ROLES}, volumes={}, fixture_root=fixture,
                                       bindings=made.bindings, identity=made.identity,
                                       owned={"token": TOKEN, "projects": {PROJECT}, "networks": [], "stack": made.stack}, execution_kind="fresh")
        self.assertTrue(Path(sealed).is_dir(), "source-b0 has no daemon side and seals as before")

    def replacements(self):
        """name -> (when, function of (daemon, role), the originals' diffs): every replacement and state change the capture
        must refuse. `when`: before-stop / before-diff run as capture_checkpoint calls the adapter for the role; at-stop /
        during-diff run inside the daemon's answer to that command (after the name was checked); running-during-diff
        starts the original before the diff and stops it again right after the diff's answer."""
        def replace(image=None, running=True, diff=()):
            return lambda daemon, role: daemon.replace(role, image=image, running=running, diff=diff)

        def restart(daemon, role):
            daemon.containers[daemon.ident(role)]["running"] = True
        empty = {role: [] for role in intro.ROLES}
        return {
            "a same-image replacement before the stop": ("before-stop", replace(), None),
            "another-image replacement before the stop": ("before-stop", replace(image=REPLACEMENT_IMAGE), None),
            "a same-image replacement at the stop call": ("at-stop", replace(), None),
            "a stopped same-image replacement with an empty diff before the diff": ("before-diff", replace(running=False), None),
            "a stopped other-image replacement with an empty diff before the diff": ("before-diff", replace(image=REPLACEMENT_IMAGE, running=False), None),
            "a same-image replacement during the diff": ("during-diff", replace(running=False), None),
            "another-image replacement during the diff": ("during-diff", replace(image=REPLACEMENT_IMAGE, running=False), None),
            "a same-image replacement during an empty diff": ("during-diff", replace(running=False), empty),
            "the captured container started again before the diff": ("before-diff", restart, None),
            "the captured container running at its empty diff, stopped right after": ("running-during-diff", restart, empty),
        }

    def test_a_replaced_or_running_container_is_never_stopped_or_sealed_as_the_inventoried_one(self):
        """CKPT12-01 (Astra's additional_probes and stop_and_consumer_probe as tests): each role on both backends; the
        replacement's own diff is empty, so a name-based diff would seal it; the inventoried original's diff is
        transient-only or empty, so only its identity and state decide. Before the stop: STOP_UNCONFIRMED, the replacement
        not stopped and the original still running; at the stop call: the original stopped by its ID, never the
        replacement; before or during the diff, or an original not stopped at its diff: WRITABLE_LAYER."""
        for backend in self.BACKENDS:
            for role in intro.ROLES:
                for label, (when, change, diffs) in self.replacements().items():
                    with self.subTest(backend=backend, role=role, case=label):
                        holder = {}

                        def act(daemon, role=role, change=change):
                            holder["ids"] = change(daemon, role)

                        def stop_again(daemon, role=role):
                            daemon.containers[daemon.history[role][0]]["running"] = False
                        if when == "before-stop":
                            result = self.capture(backend, diffs=diffs, at={("stop", role): act})
                        elif when == "at-stop":
                            result = self.capture(backend, diffs=diffs, before=lambda daemon, role=role: daemon.hooks.update(
                                {("before", "stop", role): lambda: act(daemon)}))
                        elif when == "before-diff":
                            result = self.capture(backend, diffs=diffs, at={("diff", role): act})
                        elif when == "running-during-diff":
                            result = self.capture(backend, diffs=diffs, at={("diff", role): act}, before=lambda daemon, role=role: daemon.hooks.update(
                                {("after", "diff", role): lambda: stop_again(daemon)}))
                        else:
                            result = self.capture(backend, diffs=diffs, before=lambda daemon, role=role: daemon.hooks.update(
                                {("after", "diff", role): lambda: act(daemon)}))
                        self.assertNothingSealed(result, "STOP_UNCONFIRMED" if when in ("before-stop", "at-stop") else "WRITABLE_LAYER")
                        original = result.ids[role]
                        replacement = (holder.get("ids") or (None, None))[1]
                        self.assertNotIn(replacement, result.stops, "the replacement is never stopped")
                        if when == "before-stop":
                            self.assertNotIn(original, result.stops)
                            self.assertTrue(result.daemon.containers[original]["running"], "the inventoried original is left running")
                        self.assertTrue(all(args[-1] != PROJECT + "-" + role for verb, args in result.daemon.calls if verb in ("stop", "diff")),
                                        "no stop or diff by name")

    def test_the_orthanc_layer_read_and_its_replacement_during_the_observation(self):
        """The populated Orthanc start through the real stop, diff and layer read seals on both backends; a same-image
        replacement during the layer read refuses WRITABLE_LAYER (the layer record kept unobservable)."""
        storage = CheckpointLayerStorageTests()
        storage.tempdir = self.tempdir
        tree = storage.tree()
        descriptor, read = storage.live_descriptor(tree)
        diffs ={**{role: [] for role in intro.ROLES}, "orthanc": list(ORTHANC_START)}
        for backend in self.BACKENDS:
            with self.subTest(backend=backend, case="sealed"):
                result = self.capture(backend, diffs=diffs, descriptor=descriptor, tree=tree)
                self.assertEqual((result.code, len(result.bundles)), ("SEALED", 1), result.reason)
                self.assertEqual(result.layer["roles"]["orthanc"]["facts"], read)
            with self.subTest(backend=backend, case="a same-image replacement during the layer read"):
                result = self.capture(backend, diffs=diffs, descriptor=descriptor, tree=tree,
                                      at={("layer_facts", "orthanc"): lambda daemon: daemon.replace("orthanc", running=False)})
                self.assertNothingSealed(result, "WRITABLE_LAYER")
                self.assertEqual((result.layer["roles"]["orthanc"]["layer_observable"], result.layer["outcome"]), (False, "REFUSED"))

    def adapter(self, backend="containerd", *, inventory=True, roles=None):
        """(a real adapter over a ContainerDaemon of `roles` (default all), the daemon, call(fn) running fn with it)."""
        import ops_deploy_host_container_test as rehearsal
        names = {role: PROJECT + "-" + role for role in (roles or intro.ROLES)}
        daemon = ContainerDaemon(backend, names, cp.pinned_images(plan_fixture(), {"entry_checkout": "target"}),
                                 diffs={role: TRANSIENT for role in names}, running=set())
        docker = rehearsal.CheckpointDocker(None, None)

        def call(function):
            with patch.object(rehearsal, "subprocess", SimpleNamespace(run=daemon.run, PIPE=subprocess.PIPE)):
                return function()
        if inventory:
            call(docker.inventory)
        return docker, daemon, call

    def test_missing_identity_state_metadata_and_diff_failures_are_typed_refusals(self):
        """Each is the typed refusal with its reason kept, never an exception or an empty list: no inventory taken, an
        empty inventory, a name the inventory did not list (three distinct reasons); a running, restarting, malformed or
        missing state; a failed, non-JSON or unavailable inspection; a failed, unavailable or non-text diff; a stop that
        leaves the container running or restarting. A deadline cut, a call timeout, an interrupt and a programming error
        propagate with their observation kept (interrupted)."""
        import ops_deploy_host_container_test as rehearsal
        name = PROJECT + "-db"
        reasons = []
        for label, setup in (("no inventory taken", dict(inventory=False)), ("an empty inventory", dict(roles=("api",))),
                             ("a name the inventory did not list", dict(roles=("db", "api")))):
            with self.subTest(case=label):
                docker, daemon, call = self.adapter(**setup)
                if label == "an empty inventory":
                    daemon.containers.clear()
                    call(docker.inventory)
                    self.assertEqual(docker.listed, {}, "an empty inventory is not no inventory")
                if label == "a name the inventory did not list":
                    docker.listed.pop(name)
                for method, code in ((docker.writable_changes, "WRITABLE_LAYER"), (docker.stop, "STOP_UNCONFIRMED")):
                    self.assertRefused(code, call, lambda method=method: method(name))
                    reasons.append(rehearsal.LAYER_RESOLUTIONS[-1]["reason"])
        self.assertEqual(len(set(reasons[0::2])), 2, "no inventory and a missing identity are told apart: %s" % reasons)

        def state(**fields):
            return lambda daemon: daemon.containers[daemon.ident("db")].update(state=fields)

        def field(**fields):
            return lambda daemon: daemon.containers[daemon.ident("db")].update(**fields)
        diff_cases = {
            "a running container": field(running=True), "a restarting container": field(restarting=True),
            "Restarting missing": state(Running=False), "Running is the string false": state(Running="false", Restarting=False),
            "no state": lambda daemon: daemon.containers[daemon.ident("db")].update(state=None),
            "a failed inspection": lambda daemon: daemon.raw.update(inspect=(1, b"")),
            "an inspection that is not JSON": lambda daemon: daemon.raw.update(inspect=(0, b"{not json")),
            "two inspections": lambda daemon: daemon.raw.update(inspect=lambda args: (0, json.dumps([daemon.inspected(daemon.ident("db"))] * 2).encode())),
            "a short ID": lambda daemon: daemon.raw.update(inspect=lambda args: (0, json.dumps([{**daemon.inspected(daemon.ident("db")), "Id": "4" * 12}]).encode())),
            "docker is not installed (inspect)": lambda daemon: daemon.raw.update(inspect=FileNotFoundError(2, "docker")),
            "a failed diff": lambda daemon: daemon.raw.update(diff=(1, b"")),
            "docker is not executable (diff)": lambda daemon: daemon.raw.update(diff=PermissionError(13, "docker")),
            "a diff that is not text": lambda daemon: daemon.raw.update(diff=(0, b"A /etc/\xff\xfe\n")),
            "the name moves after the diff": lambda daemon: daemon.hooks.update({("after", "diff", "db"): lambda: daemon.replace("db", running=False)}),
        }
        for backend in self.BACKENDS:
            for label, setup in diff_cases.items():
                with self.subTest(backend=backend, diff=label):
                    docker, daemon, call = self.adapter(backend)
                    setup(daemon)
                    self.assertRefused("WRITABLE_LAYER", call, lambda: docker.writable_changes(name))
                    record = rehearsal.LAYER_RESOLUTIONS[-1]
                    self.assertEqual((record["observation"], record["scope"], record["outcome"]), ("diff", "capture", "refused"))
                    self.assertTrue(type(record.get("reason")) is str and record["reason"].strip(), record)
            for label, setup in (("the container keeps running", field(stays_running=True, running=True)),
                                 ("the container is restarting after the stop", field(restarting=True, running=True)),
                                 ("a failed inspection", lambda daemon: daemon.raw.update(inspect=(1, b""))),
                                 ("the name moves at the stop", lambda daemon: daemon.hooks.update({("before", "stop", "db"): lambda: daemon.replace("db")}))):
                with self.subTest(backend=backend, stop=label):
                    docker, daemon, call = self.adapter(backend)
                    setup(daemon)
                    if label == "the container is restarting after the stop":
                        daemon.hooks[("after", "stop", "db")] = lambda: daemon.containers[daemon.history["db"][0]].update(restarting=True)
                    self.assertRefused("STOP_UNCONFIRMED", call, lambda: docker.stop(name))
                    self.assertTrue(rehearsal.LAYER_RESOLUTIONS[-1]["reason"].strip())
            for verb in ("inspect", "stop", "diff"):
                for error in (cp.DeadlineExpired("cut", {"kind": "cut"}), subprocess.TimeoutExpired(["docker"], 1), KeyboardInterrupt(),
                              TypeError("a programming error")):
                    for method in ("stop", "writable_changes"):
                        if verb == "stop" and method == "writable_changes" or verb == "diff" and method == "stop":
                            continue
                        with self.subTest(backend=backend, method=method, at=verb, stop=type(error).__name__):
                            docker, daemon, call = self.adapter(backend)
                            daemon.raw[verb] = error
                            with self.assertRaises(type(error)):
                                call(lambda: getattr(docker, method)(name))
                            record = rehearsal.LAYER_RESOLUTIONS[-1]
                            self.assertEqual((record["outcome"], record["interrupted"]), ("interrupted", type(error).__name__))

    def test_standalone_diagnostics_observe_their_actual_subject_without_the_capture_binding(self):
        """The native smoke's standalone consumers (Smoke.held/late_boundaries/failure_lineage stops, regenerated_negatives'
        running-database diff, negative's diff before its capture): without any inventory, of a running container, and
        after an inventory then an owned recreation, they observe and stop what the name names now - by that ID - and the
        capture binding (`listed`) is neither read nor changed. A naive global stopped-only or stale-inventory diff would
        refuse each of these; the capture methods on the same adapter still refuse the stale identity."""
        name = PROJECT + "-db"
        for backend in self.BACKENDS:
            with self.subTest(backend=backend, case="no inventory, a running database"):
                docker, daemon, call = self.adapter(backend, inventory=False)
                daemon.containers[daemon.ident("db")].update(running=True, diff=["C /etc/hostid"])
                # a refusal or an exception of the standalone path is a failure of this contract (admitted), not an error
                self.assertEqual(self.admitted(call, lambda: docker.standalone_changes(name)), ["C /etc/hostid"])
                self.assertIsNone(docker.listed, "a standalone call takes no capture inventory")
                outcome = self.admitted(call, lambda: docker.standalone_stop(name))
                self.assertEqual((outcome["running"], outcome["container_id"], daemon.effects), (False, daemon.ident("db"), [("stop", daemon.ident("db"))]))
            with self.subTest(backend=backend, case="inventory, an owned recreation, then the diagnostic"):
                docker, daemon, call = self.adapter(backend)
                listed = copy.deepcopy(docker.listed)
                original, new = daemon.replace("db", running=True, diff=["A /etc/hostid"])
                self.assertEqual(self.admitted(call, lambda: docker.standalone_changes(name)), ["A /etc/hostid"], "the recreated container's own diff")
                self.assertEqual(self.admitted(call, lambda: docker.standalone_stop(name))["container_id"], new)
                self.assertEqual((daemon.effects, daemon.containers[original]["running"]), ([("stop", new)], False))
                self.assertEqual(docker.listed, listed, "the capture binding is unchanged")
                self.assertRefused("WRITABLE_LAYER", call, lambda: docker.writable_changes(name))
                self.assertRefused("STOP_UNCONFIRMED", call, lambda: docker.stop(name))
            with self.subTest(backend=backend, case="the standalone subject moves during its diff"):
                docker, daemon, call = self.adapter(backend, inventory=False)
                daemon.hooks[("after", "diff", "db")] = lambda: daemon.replace("db")
                with self.assertRaises(RuntimeError):
                    call(lambda: docker.standalone_changes(name))

    def test_the_native_capture_evidence_names_exactly_the_sealed_containers(self):
        """The native smoke's consumer of these observations (native capture_bound over layer-storage.json rows and the
        verified layer record): a real matching capture's rows are bound; a diff row of another ID, a refused row, a
        missing role and a stop of another container are not."""
        import ops_release_checkpoints_native_test as native
        result = self.capture("containerd")
        rows = [row for row in result.observations if row.get("observation")]
        bound, detail = native.capture_bound(rows, result.layer)
        self.assertTrue(bound, detail)
        self.assertEqual((len(detail["diffs"]), len(detail["stops"])), (5, 5))
        other = "f" * 64
        changed = {
            "a diff of another ID": lambda rows: rows[next(i for i, row in enumerate(rows) if row["observation"] == "diff")]["after"].update(id=other),
            "a refused diff": lambda rows: rows[next(i for i, row in enumerate(rows) if row["observation"] == "diff")].update(outcome="refused"),
            "a missing role": lambda rows: rows.pop(next(i for i, row in enumerate(rows) if row["observation"] == "diff")),
            "a stop of another container": lambda rows: rows[next(i for i, row in enumerate(rows) if row["observation"] == "stop")]["after"].update(id=other),
        }
        for label, change in changed.items():
            with self.subTest(case=label):
                copied = copy.deepcopy(rows)
                change(copied)
                self.assertFalse(native.capture_bound(copied, result.layer)[0])


class CheckpointDeadlineTests(RefusalAssertions, TempCase):
    """r6 CKPT5-02 (consultation ckpt5_02 pure_proof, O6-D/O6-E): real local Python children on the harness's bounded
    path - never a fake that times itself out - each scenario in its own process under a 5 s watchdog; no daemon."""

    def scenario(self, mode):
        completed = subprocess.run([sys.executable, "-B", "-c", DEADLINE_SCENARIO, str(Path(cp.__file__).parent), str(ROOT / "scripts"), str(TESTS), mode],
                                   capture_output=True, timeout=5)
        line = next((line for line in completed.stdout.decode("utf-8", "replace").splitlines() if line.startswith("DEADLINE_SCENARIO ")), None)
        self.assertIsNotNone(line, completed.stderr.decode("utf-8", "replace")[-2000:])
        return json.loads(line[len("DEADLINE_SCENARIO "):])

    def test_a_bounded_call_is_cut_at_the_shared_end_and_its_client_tree_ended(self):
        """P8 (R6 ③, O6-D): a child that would sleep 2 s, started with 0.5 s left, is cut before it ends, with its start
        handshake kept and its tree ended and collected; two calls share one end; nothing starts once the end has passed
        (0 transport calls); the product Runner gets the time left and its UNKNOWN stays UNKNOWN (M49)."""
        out = self.scenario("cut")
        self.assertEqual(out["outcome"], "DEADLINE", "the call ended normally after its deadline: " + json.dumps(out)[:400])
        self.assertLess(out["elapsed"], 1.5, "cut near 0.5 s, never at the child's own 2 s end")
        event = out["event"]
        self.assertEqual((event["kind"], event["client_tree"]["collected"]), ("cut", True))
        self.assertLessEqual(event["effective_timeout"], 0.5)
        self.assertTrue(event["partial"]["stdout"]["head"].startswith("started"), "the child's start handshake is kept")
        self.assertNotIn("finished", event["partial"]["stdout"]["head"])
        if os.name == "posix":
            self.assertIs(out.get("grandchild_alive"), False, "the client's whole process group ended")
        shared = self.scenario("shared")
        self.assertEqual(shared["first"]["outcome"], "completed")
        self.assertEqual(shared["second"]["outcome"], "DEADLINE")
        self.assertLess(shared["second"]["event"]["effective_timeout"], 0.75, "the second call got only what the first left")
        self.assertLess(shared["first"]["elapsed"] + shared["second"]["elapsed"], 2.2)
        expired = self.scenario("expired")
        self.assertEqual(expired["transport_calls"], 0, "nothing started after the end")
        self.assertEqual(expired["refused"], {name: "not-started" for name in ("run_bounded", "adapter inventory", "poll sleep", "product runner")})
        runner = self.scenario("runner")
        self.assertEqual(runner["outcome"], "UNKNOWN", "the product transport's own UNKNOWN is kept")
        self.assertLess(runner["elapsed"], 1.5)
        self.assertTrue(runner["given"] and runner["given"][0] <= 0.3, runner["given"])
        self.assertEqual([(row["kind"], row["outcome"]) for row in runner["events"]], [("cut", "UNKNOWN")])

    def test_the_cleanup_has_its_own_end_and_a_deadline_keeps_the_residue(self):
        """P9 (R6 ③, O6-D/O6-E): the cleanup's own end cuts a removal and reports the last-known owned names and the
        private root as remaining with verification UNKNOWN; a smoke whose body or host observation met its deadline
        fails DEADLINE and keeps its pending residue although its cleanup then observed nothing left, and the next
        entry refuses SMOKE_RESIDUE; a normal smoke's observed cleanup still releases it; an admission refusal releases
        it at once without a daemon query (M51)."""
        import ops_release_checkpoints_native_test as native
        state = self.tempdir("kin-gate-") / "test-gate"
        state.mkdir()
        sleeping = {"inventory": 0.0, "remove": 0.0}
        calls = []

        class SleepingDocker:
            """An adapter double whose every call is a real local child on the bounded path (no daemon)."""

            def __init__(self, stack, helper):
                pass

            def call(self, what):
                calls.append(what)
                cp.run_bounded([sys.executable, "-c", "import time; time.sleep(%s)" % sleeping[what]], timeout=60, capture_output=True)

            def inventory(self):
                self.call("inventory")
                owned = [{"id": "c1", "name": "kin-ckptsmoke-left", "labels": {"kin.ops.run": SleepingDocker.token}}] if SleepingDocker.left else []
                return cp.note_inventory({"containers": owned, "volumes": [], "networks": [], "images": []})

            def remove(self, kind, ident):
                self.call("remove")

            def image_present(self, image_id):
                return False
        SleepingDocker.left, SleepingDocker.token = True, None
        quiet = {"os": "linux", "daemon_ok": True}
        with patch.object(gate, "STATE", state), patch.object(native.rehearsal, "CheckpointDocker", SleepingDocker):
            residue = native.residue_dir()
            with self.subTest(cut="the cleanup's own end"):
                smoke = native.Smoke(self.tempdir("kin-native-evidence-"), cleanup_seconds=0.5)
                SleepingDocker.token = smoke.token
                smoke.private = self.tempdir("kin-ckpt-smoke-")
                sleeping.update(inventory=0.0, remove=2.0)
                deadline = cp.Deadline(0.5, label="cleanup")
                started = time.monotonic()
                with cp.deadline_scope(deadline):
                    smoke.extra_cleanup.append(("owned", {"token": smoke.token, "projects": set()}))
                    result = smoke.cleanup(deadline)
                self.assertLess(time.monotonic() - started, 0.5 + cp.REAP_SECONDS + 1.0, "bounded by its own end, not by its calls")
                self.assertEqual((result["complete"], result["verification"]), (False, "UNKNOWN"))
                self.assertIn("last seen: kin-ckptsmoke-left", result["remaining"])
                self.assertIn("unverified: private root " + str(smoke.private), result["remaining"])
                self.assertEqual([event["kind"] for event in deadline.events][:1], ["cut"])
                self.assertEqual((deadline.calls, calls[:2]), (2, ["inventory", "remove"]), "no call started after the end")
                self.assertTrue(all(event["kind"] == "not-started" for event in deadline.events[1:]))
            sleeping.update(inventory=0.0, remove=0.0)
            SleepingDocker.left = False

            def entry(**kwargs):
                evidence = self.tempdir("kin-native-evidence-") / "evidence"
                evidence.mkdir()
                result = {"started_utc": cp.now_utc().isoformat(), "outcome": "REFUSED"}
                with contextlib.redirect_stderr(io.StringIO()):
                    code = native.run_smoke(evidence, result, admit=lambda facts: True, **kwargs)
                return code, result, sorted(residue.glob("pending-*.json"))

            def deadline_work(smoke, facts):
                cp.run_bounded([sys.executable, "-c", "import time; time.sleep(2)"], timeout=60, capture_output=True)
            for name, kwargs in (("the body", dict(observe=lambda root: quiet, work=deadline_work, body_seconds=0.3)),
                                 ("the host observation", dict(observe=lambda root: deadline_work(None, None), body_seconds=0.3))):
                with self.subTest(deadline=name):
                    del calls[:]
                    code, result, pending = entry(**kwargs)
                    self.assertEqual((code, result["outcome"], result["code"]), (1, "FAIL", "DEADLINE"), result.get("failure"))
                    self.assertTrue(result["cleanup"]["complete"], "the cleanup observed nothing left")
                    self.assertEqual(len(pending), 1, "a deadline event keeps the residue whatever the cleanup observed")
                    self.assertTrue(result["pending"]["kept"])
                    self.assertTrue(any(event["kind"] == "cut" for event in result["deadline"]["body"]["events"]))
                    evidence = Path(json.loads(pending[0].read_bytes())["evidence"])
                    self.assertTrue((evidence / "failure.txt").is_file())
                    second = self.tempdir("kin-native-evidence-") / "next"
                    with contextlib.redirect_stderr(io.StringIO()):
                        self.assertEqual(native.main(["--evidence", str(second)]), 3)
                    self.assertEqual(json.loads((second / cp.SMOKE_RESULT).read_bytes())["code"], "SMOKE_RESIDUE")
                    pending[0].unlink()   # this test's own synthetic residue (no daemon was involved)
            with self.subTest(released="a normal smoke's observed complete cleanup"):
                code, result, pending = entry(observe=lambda root: quiet, work=lambda smoke, facts: None)
                self.assertEqual((code, result["outcome"], result["code"], pending), (1, "FAIL", None, []))
                self.assertFalse(result["pending"]["kept"])
            with self.subTest(released="an admission refusal before any resource"):
                del calls[:]

                def refuse(facts):
                    raise cp.Refused("UNSUPPORTED_HOST", "synthetic")
                evidence = self.tempdir("kin-native-evidence-") / "evidence"
                evidence.mkdir()
                result = {"started_utc": cp.now_utc().isoformat()}
                with contextlib.redirect_stderr(io.StringIO()):
                    code = native.run_smoke(evidence, result, observe=lambda root: quiet, admit=refuse)
                self.assertEqual((code, result["outcome"], result["code"], sorted(residue.glob("pending-*.json")), calls),
                                 (3, "REFUSED", "UNSUPPORTED_HOST", [], []))


# ── r7 (consult-checkpoints-r7-20261017, CKPT6-01): the closed writable-layer row contract at every consumer (O7) ──
# Each substitution is applied alone to one coherent synthetic capture (snapshot, boundary facts, owned and target names,
# plan, S and record from one source of truth) and every envelope hash that names the changed bytes is rebound (the layer
# bytes and the manifest binding, then a new seal; the raw rows; the index), so a refusal is the contract's, never a
# plain hash mismatch. The oracle helpers use only APIs 0535bc8 has as well: the same oracle ran red on the baseline and
# green on r7 (evidence oracles-on-0535bc8.json / oracles-on-r7.json).
O7_ROW_CHANGES = {
    # O7-SCHEMA (accepted by 0535bc8)
    "orthanc row null": lambda record: record["roles"].update(orthanc=None),
    "keycloak row a list": lambda record: record["roles"].update(keycloak=[]),
    "proxy row without container_name": lambda record: record["roles"]["proxy"].pop("container_name"),
    "proxy row without layer_observable": lambda record: record["roles"]["proxy"].pop("layer_observable"),
    # O7-PRESENCE
    "orthanc falsely absent": lambda record: record["roles"].update(orthanc={"absent": True,
                                                                            "container_name": record["roles"]["orthanc"]["container_name"]}),
    # O7-IDENTITY
    "api container ID substituted": lambda record: record["roles"]["api"].update(container_id="id-other-api"),
    "api image substituted": lambda record: record["roles"]["api"].update(image="sha256:" + "8" * 64),
    "api and orthanc rows exchanged": lambda record: record["roles"].update(api=record["roles"]["orthanc"], orthanc=record["roles"]["api"]),
    # O7-MOUNT-VERDICT
    "api mount invented for an accepted change": lambda record: record["roles"]["api"].update(
        mounts=["/etc/kin-kept"], changes=["A /etc/kin-kept"], verdicts=[{"change": "A /etc/kin-kept", "verdict": "transient-or-mount"}]),
}
# Regressions: refused by 0535bc8 already (kept, never counted as red).
O7_REFUSED_BEFORE = {
    "keycloak role left out": lambda record: record["roles"].pop("keycloak"),
    "an extra role": lambda record: record["roles"].update(extra=dict(record["roles"]["db"])),
    "proxy refused change recorded accepted": lambda record: record["roles"]["proxy"].update(
        changes=["A /etc/kin-kept"], verdicts=[{"change": "A /etc/kin-kept", "verdict": "transient-or-mount"}]),
}


def _outcome(action):
    try:
        action()
        return "ACCEPTED"
    except cp.Refused as error:
        return error.code + ": " + str(error)


def o7_bundle(test, change=None, *, checkpoint_id="introduced", descriptor=None, absent=(), ids=None):
    """A sealed bundle of one coherent capture with `change(record)` applied to its writable-layer record and the record's
    binding rebound before the seal. Returns (outcome of load_bundle, bundle folder)."""
    fixture = test.tempdir("kin-o7-")
    made = realistic(fixture, checkpoint_id, descriptor=descriptor, absent=absent, ids=ids)
    if change is not None:
        path = fixture / made.bindings["layer"]["path"]
        record = json.loads(path.read_bytes())
        change(record)
        path.write_bytes(cp.canonical(record) + b"\n")
        made.bindings["layer"] = {**made.bindings["layer"], "sha256": cp.sha256(path.read_bytes())}
    final = bundle_from(test, fixture, made, checkpoint_id)
    return _outcome(lambda: cp.load_bundle(final)), final


def o7_index(test, change=None, *, unit=None, root=None):
    """One recorded leaf (CheckpointRecordTests.layout + the real recorder) whose raw writable-layer record has `change`
    applied, with the seal's binding rebound to it. Returns (proof, run folder, leaf_index result)."""
    records = CheckpointRecordTests(methodName="test_existing_record_run_binds_exact_inputs_outputs_and_exit")
    records.tempdir = test.tempdir

    def alter(kind, value, stack=None):
        if change is not None and kind == "files":
            for found in sorted(value.glob(cp.OBSERVATION_DIR + "/layer-*/" + cp.LAYER_FILE)):
                record = json.loads(found.read_bytes())
                change(record)
                found.write_bytes(cp.canonical(record) + b"\n")
                alter.sha = cp.sha256(found.read_bytes())
        if change is not None and kind == "manifest":
            value["bindings"]["layer"] = {**value["bindings"]["layer"], "sha256": alter.sha}
        return value
    proof = records.layout(unit or CheckpointRecordTests.UNIT, root=root, alter=alter)
    run_dir, completed = records.record(proof)
    test.assertEqual(completed.returncode, 0, completed.stderr)
    return proof, run_dir, cp.leaf_index(proof.leaves, proof.unit, proof.root, run_dir)


def o7_forged_parent(test, change):
    """The parent leaf (prefix-introduce) recorded over a substituted record, its index written BOUND/[] as the 0535bc8
    validator wrote it over exactly such evidence; then the BOUND consumers. Returns their outcomes."""
    root = test.tempdir("kin-proof-")
    unit = "release-tools-checkpoints-proof-prefix-introduce"
    proof, run_dir, index = o7_index(test, change, unit=unit, root=root)
    cp.write_index(root, {**index, "verdict": "BOUND", "reasons": []})
    (root / "b.source-manifest.json").write_bytes(cp.canonical({"root": str(root / "b")}) + b"\n")
    return {"bound_index": _outcome(lambda: cp.bound_index(root, unit)),
            "leaf_request": _outcome(lambda: cp.leaf_request(proof.leaves, "release-tools-checkpoints-proof-late-resume", root))}


def o7_restore(test, final, forge=None):
    """restore_checkpoint over the bundle's manifest bytes (as an earlier consumer read them; `forge(manifest)` alters
    that in-memory copy only, the bundle untouched) with a synthetic daemon: the outcome, the daemon calls and whether a
    fixture root was created."""
    names = {role: PROJECT + "-" + role for role in intro.ROLES}
    backend = FakeBackend(names, {}, running=set())
    backend.containers.clear()
    target_root = test.tempdir() / "restored"
    manifest = json.loads((Path(final) / "manifest.json").read_bytes())
    if forge is not None:
        forge(manifest)
    outcome = _outcome(lambda: cp.restore_checkpoint(manifest, final, backend=backend, fixture_root=target_root, names=names,
                                                     images_present=lambda image_id: True, observe=lambda sid: None))
    return {"outcome": outcome, "daemon_calls": len(backend.calls), "fixture_root_created": target_root.exists()}


def layer_oracles(test):
    """The O7 matrix through the consumers both trees have: load_bundle over a rebound seal (the reviewer's
    layer-substitution probe and its extensions), leaf_index over a rebound raw record (the layer-index probe and its
    extensions), a BOUND index the old validator wrote over such evidence consumed by bound_index and leaf_request, and
    restore_checkpoint over a rebound bundle. Returns {case: outcome}."""
    rows = {}
    bundle = lambda change=None, **kwargs: o7_bundle(test, change, **kwargs)[0]  # noqa: E731
    rows["bundle: control"] = bundle()
    rows["bundle: held control (db running, the rest stopped but present)"] = bundle(checkpoint_id="held")
    rows["bundle: control with new container IDs (a later capture after a cold restore)"] = bundle(
        ids={role: "new-" + PROJECT + "-" + role for role in intro.ROLES})
    rows["bundle: orthanc observed ABSENT and recorded absent (format positive)"] = bundle(absent=("orthanc",))
    for name, change in {**O7_ROW_CHANGES, **O7_REFUSED_BEFORE}.items():
        rows["bundle: " + name] = bundle(change)
    rows["bundle: held: stopped api falsely absent"] = bundle(
        lambda record: record["roles"].update(api={"absent": True, "container_name": record["roles"]["api"]["container_name"]}), checkpoint_id="held")
    rows["bundle: orthanc descriptor of another container"] = bundle(descriptor=regenerated_fixture("id-other-orthanc", applicable=False))
    for name in ("control", "orthanc row null", "orthanc falsely absent", "api container ID substituted", "api image substituted",
                 "api mount invented for an accepted change"):
        _, _, index = o7_index(test, O7_ROW_CHANGES.get(name))
        rows["index: " + name] = index["verdict"] + ": " + json.dumps(index["reasons"])
    forged = o7_forged_parent(test, O7_ROW_CHANGES["orthanc row null"])
    rows["bound_index: BOUND index over a null orthanc row"] = forged["bound_index"]
    rows["leaf_request: parent BOUND over a null orthanc row"] = forged["leaf_request"]
    rows["restore: bundle with a null orthanc row"] = json.dumps(o7_restore(test, o7_bundle(test, O7_ROW_CHANGES["orthanc row null"])[1]))
    rows["restore: control"] = json.dumps(o7_restore(test, o7_bundle(test)[1]))
    return rows


def rebound(arguments, raw, *, record=None, snapshot=None, boundary=None):
    """layer_valid's arguments and record with `snapshot(value)`, `boundary(value)` or `record(value)` applied and every hash
    naming the changed bytes rebound (snapshot.json -> observation.json's file list -> the seal's observation binding ->
    the record's observation SHA-256; r8: the record's bytes -> the seal's layer binding)."""
    arguments, document = copy.deepcopy(arguments), json.loads(raw)
    if snapshot is not None:
        files = dict(arguments["observation_files"])
        value = json.loads(files["snapshot.json"])
        snapshot(value)
        files["snapshot.json"] = cp.canonical(value) + b"\n"
        summary = json.loads(files[cp.OBSERVATION_RESULT])
        summary["files"] = {name: cp.sha256(data) for name, data in files.items() if name != cp.OBSERVATION_RESULT}
        files[cp.OBSERVATION_RESULT] = cp.canonical(summary) + b"\n"
        arguments["observation_files"] = files
        arguments["observation"] = {**arguments["observation"], "sha256": cp.sha256(files[cp.OBSERVATION_RESULT])}
        document["observation"]["sha256"] = arguments["observation"]["sha256"]
    if boundary is not None:
        boundary(arguments["boundary"])
    if record is not None:
        record(document)
    data = cp.canonical(document) + b"\n"
    if "layer_binding" in arguments:   # the r8 judgement checks the record's own binding (0535bc8/de02468 have none)
        arguments["layer_binding"] = {**arguments["layer_binding"], "sha256": cp.sha256(data)}
    return data, arguments


class CheckpointLayerContractTests(CaptureFixture, RefusalAssertions, TempCase):
    """r7 CKPT6-01 (consult-checkpoints-r7-20261017 layer_valid_contract, oracles O7-*): the writable-layer record is a
    closed five-role map whose rows are judged against the capture they describe - the bound snapshot, the boundary
    facts taken before the stop, the owned and target names and the side's pinned image - at its generation (before
    store.begin), by load_bundle, by the index from the raw records, at every consumption of a BOUND index, at parent
    admission and before a restore. Assertions name the requirement (CKPT7_*) and the role; no message text is pinned."""

    def context(self, checkpoint_id="introduced", **kwargs):
        """A coherent sealed capture's record and the bound context load_bundle judges it in."""
        outcome, final = o7_bundle(self, checkpoint_id=checkpoint_id, **kwargs)
        self.assertEqual(outcome, "ACCEPTED", "CKPT7_VALID_CAPTURE_ACCEPTED")
        manifest, _ = cp.load_bundle(final)
        tree = final / "payload" / "fixture-tree.tar"
        return (cp.tree_member_bytes(tree, manifest["bindings"]["layer"]["path"]),
                cp.layer_context(manifest, lambda rel: cp.tree_member_bytes(tree, rel), lambda rel: cp.tree_folder(tree, rel)), final)

    def refusedFor(self, requirement, role, action, *args, code="LAYER_INVALID", **kwargs):
        error = self.assertRefused(code, action, *args, **kwargs)
        if role is not None:
            self.assertIn(role, str(error), requirement + ": the refusal names the role")
        return error

    def test_a_closed_role_row_is_judged_against_its_bound_capture(self):
        """O7-CONTROL/SCHEMA/PRESENCE/IDENTITY/MOUNT-VERDICT (R7 1-2): the record and each row are closed and typed; presence,
        container ID, name, image and mount destinations are the bound capture's; the recorded verdicts are re-judged.
        A substitution with its hashes rebound is LAYER_INVALID directly and BUNDLE_INVALID at load_bundle; the coherent
        seeded/held/new-ID/absent-format captures and the normal mount and Orthanc start are accepted (M52-M54)."""
        # Controls (CKPT7_VALID_CAPTURE_ACCEPTED, CKPT7_STOPPED_IS_PRESENT).
        for name, kwargs in (("introduced", {}), ("seeded", {"checkpoint_id": "seeded"}), ("held: db running, the rest stopped", {"checkpoint_id": "held"}),
                             ("new container IDs", {"ids": {role: "new-" + PROJECT + "-" + role for role in intro.ROLES}}),
                             ("orthanc observed ABSENT, recorded absent (a format positive, not a native absent boundary)", {"absent": ("orthanc",)})):
            with self.subTest(control=name):
                raw, arguments, final = self.context(**kwargs)
                self.admitted(cp.layer_valid, raw, **arguments)
                self.assertEqual(self.admitted(cp.verify_bundle, final).capture.layer["outcome"], "ACCEPTED")
        # Rebound row substitutions at load_bundle (the reviewer's probe and its extensions): never sealed and loadable.
        for name, change in {**O7_ROW_CHANGES, **O7_REFUSED_BEFORE}.items():
            with self.subTest(bundle=name):
                outcome, _ = o7_bundle(self, change)
                self.assertTrue(outcome.startswith("BUNDLE_INVALID: ") and "writable layer: LAYER_INVALID" in outcome,
                                {"orthanc row null": "CKPT7_ROW_REQUIRED", "orthanc falsely absent": "CKPT7_ABSENCE_CORROBORATED",
                                 "api image substituted": "CKPT7_IMAGE_PIN_BOUND"}.get(name, "CKPT7_ROW_SCHEMA_CLOSED") + ": " + name + ": " + outcome)
        with self.subTest(bundle="held: a stopped container recorded absent"):
            for role in ("api", "orthanc"):
                outcome, _ = o7_bundle(self, lambda record: record["roles"].update(
                    **{role: {"absent": True, "container_name": record["roles"][role]["container_name"]}}), checkpoint_id="held")
                self.assertTrue(outcome.startswith("BUNDLE_INVALID: ") and role in outcome, "CKPT7_STOPPED_IS_PRESENT: " + outcome)
        with self.subTest(bundle="the Orthanc descriptor of another container"):
            outcome, _ = o7_bundle(self, descriptor=regenerated_fixture("id-other-orthanc", applicable=False))
            self.assertTrue(outcome.startswith("BUNDLE_INVALID: ") and "orthanc" in outcome, "CKPT7_CONTAINER_ID_BOUND: " + outcome)
        raw, arguments, _ = self.context()
        record = json.loads(raw)
        names = {role: record["roles"][role]["container_name"] for role in intro.ROLES}

        def row(role, **changes):
            return lambda value: value["roles"][role].update(changes)

        def drop(role, key):
            return lambda value: value["roles"][role].pop(key)
        # CKPT7_EXACT_ROLE_SET, CKPT7_ROW_REQUIRED, CKPT7_ROW_SCHEMA_CLOSED: direct, with the role named.
        schema = {
            "orthanc row null": ("orthanc", lambda value: value["roles"].update(orthanc=None)),
            "api row a list": ("api", lambda value: value["roles"].update(api=[])),
            "db row a string": ("db", lambda value: value["roles"].update(db="present")),
            "keycloak row a number": ("keycloak", lambda value: value["roles"].update(keycloak=1)),
            "proxy row a boolean": ("proxy", lambda value: value["roles"].update(proxy=True)),
            "api row an empty object": ("api", lambda value: value["roles"].update(api={})),
            "proxy row with an extra key": ("proxy", row("proxy", note="kept")),
            "api absent missing": ("api", drop("api", "absent")),
            "api absent null": ("api", row("api", absent=None)),
            "api absent 0": ("api", row("api", absent=0)),
            "api absent 1": ("api", row("api", absent=1)),
            "api absent a string": ("api", row("api", absent="false")),
            "proxy container_id not a string": ("proxy", row("proxy", container_id=7)),
            "proxy container_name not a string": ("proxy", row("proxy", container_name=None)),
            "proxy image not an image ID": ("proxy", row("proxy", image="nginx:latest")),
            "proxy mounts a string": ("proxy", row("proxy", mounts="/etc/nginx/certs")),
            "proxy mounts unsorted": ("proxy", row("proxy", mounts=["/b", "/a"])),
            "proxy mounts relative": ("proxy", row("proxy", mounts=["etc/nginx"])),
            "proxy changes a string": ("proxy", row("proxy", changes="A /x")),
            "proxy changes of another kind": ("proxy", row("proxy", changes=["R /x"], verdicts=[{"change": "R /x", "verdict": "refused"}])),
            "proxy changes listing a path twice": ("proxy", row("proxy", changes=["C /run", "A /run"],
                                                                verdicts=[{"change": "C /run", "verdict": "transient-or-mount"},
                                                                          {"change": "A /run", "verdict": "transient-or-mount"}])),
            "proxy facts a list": ("proxy", row("proxy", facts=[])),
            "proxy facts with an untyped fact": ("proxy", row("proxy", facts={"/etc/hostid": {"type": "file"}})),
            "proxy facts with a boolean mode": ("proxy", row("proxy", facts={"/etc": {"type": "dir", "mode": True, "uid": 0, "gid": 0}})),
            "proxy layer_observable null": ("proxy", row("proxy", layer_observable=None)),
            "proxy unobservable with facts": ("proxy", row("proxy", layer_observable=False, facts={"/etc": _dir()})),
            "proxy verdicts a dict": ("proxy", row("proxy", verdicts={})),
            "proxy verdict with an extra key": ("proxy", row("proxy", changes=["C /run"], verdicts=[{"change": "C /run", "verdict": "transient-or-mount",
                                                                                                     "note": 1}])),
            "an absent row with present fields": ("orthanc", lambda value: value["roles"]["orthanc"].update(absent=True)),
            "an absent row of another name": ("orthanc", lambda value: value["roles"].update(orthanc={"absent": True, "container_name": "other"})),
            "a role left out": (None, lambda value: value["roles"].pop("keycloak")),
            "an extra role": (None, lambda value: value["roles"].update(worker=dict(value["roles"]["db"]))),
            "a missing refused list": (None, lambda value: value.pop("refused")),
            "refused null": (None, lambda value: value.update(refused=None)),
            "schema true": (None, lambda value: value.update(schema=True)),
            "an extra envelope key": (None, lambda value: value.update(note="x")),
        }
        for name, (role, change) in schema.items():
            with self.subTest(schema=name):
                data, changed = rebound(arguments, raw, record=change)
                self.refusedFor("CKPT7_ROW_SCHEMA_CLOSED", role, cp.layer_valid, data, **changed)
        # CKPT7_ABSENCE_CORROBORATED, CKPT7_STOPPED_IS_PRESENT: presence against the snapshot and the boundary facts.
        absent_raw, absent_arguments, _ = self.context(absent=("orthanc",))
        present_row = {**record["roles"]["orthanc"]}
        presence = {
            "orthanc falsely absent": (raw, arguments, dict(record=lambda value: value["roles"].update(
                orthanc={"absent": True, "container_name": names["orthanc"]}))),
            "orthanc absent with the boundary row removed too": (raw, arguments, dict(
                record=lambda value: value["roles"].update(orthanc={"absent": True, "container_name": names["orthanc"]}),
                boundary=lambda value: value["facts"]["containers"].pop("orthanc"))),
            "orthanc observed ABSENT, recorded present": (absent_raw, absent_arguments, dict(record=lambda value: value["roles"].update(orthanc=present_row))),
            "orthanc observed ABSENT, a boundary row present": (absent_raw, absent_arguments, dict(
                boundary=lambda value: value["facts"]["containers"].update(orthanc={"id": present_row["container_id"], "image": present_row["image"],
                                                                                    "running": True, "project": PROJECT, "mounts": [], "networks": []}))),
        }
        for status in ({"outcome": "ERROR", "reason": "OSError"}, {"outcome": "UNKNOWN"}, None, "missing"):
            presence["the snapshot's orthanc " + json.dumps(status) + " taken as absent"] = (absent_raw, absent_arguments, dict(
                snapshot=lambda value, status=status: (value["facts"]["containers"]["value"].pop("orthanc") if status == "missing"
                                                       else value["facts"]["containers"]["value"].update(orthanc=status))))
        for name, (data, context, changes) in presence.items():
            with self.subTest(presence=name):
                changed_raw, changed = rebound(context, data, **changes)
                self.refusedFor("CKPT7_ABSENCE_CORROBORATED", None, cp.layer_valid, changed_raw, **changed)
        # CKPT7_CONTAINER_ID_BOUND, CKPT7_CONTAINER_NAME_BOUND, CKPT7_IMAGE_PIN_BOUND, CKPT7_ROLE_ROW_BOUND.
        other_side = arguments["identity"]["image_ids"]["previous"]["api"]
        identity = {
            "api container ID (an empty diff)": ("api", row("api", container_id="id-other-api")),
            "api container name": ("api", row("api", container_name=names["proxy"])),
            "orthanc container name": ("orthanc", row("orthanc", container_name=names["api"])),
            "api image sha256:888...": ("api", row("api", image="sha256:" + "8" * 64)),
            "api image of the other side": ("api", row("api", image=other_side)),
            "api image of the helper": ("api", row("api", image=arguments["identity"]["image_ids"]["helper"])),
            "api and orthanc rows exchanged": ("api", lambda value: value["roles"].update(api=value["roles"]["orthanc"], orthanc=value["roles"]["api"])),
        }
        for name, (role, change) in identity.items():
            with self.subTest(identity=name):
                data, changed = rebound(arguments, raw, record=change)
                self.refusedFor("CKPT7_IMAGE_PIN_BOUND" if "image" in name else "CKPT7_CONTAINER_ID_BOUND", role, cp.layer_valid, data, **changed)
        with self.subTest(identity="the snapshot, the boundary facts and the row agree on an image outside the side's pin"):
            outside = "sha256:" + "9" * 64
            data, changed = rebound(arguments, raw, record=row("api", image=outside),
                                    snapshot=lambda value: value["facts"]["containers"]["value"]["api"]["value"].update(image=outside),
                                    boundary=lambda value: value["facts"]["containers"]["api"].update(image=outside))
            self.refusedFor("CKPT7_IMAGE_PIN_BOUND", "api", cp.layer_valid, data, **changed)
        with self.subTest(identity="the bound inputs: another plan side, no stack names, another target"):
            for change in (lambda value: value["identity"]["image_ids"].update(release=value["identity"]["image_ids"]["previous"]),
                           lambda value: value["owned"].pop("stack"), lambda value: value["target_names"].update(api="other-api"),
                           lambda value: value.update(plan=None), lambda value: value.update(state_raw=None)):
                changed = copy.deepcopy(arguments)
                change(changed)
                self.refusedFor("CKPT7_ROLE_ROW_BOUND", None, cp.layer_valid, raw, **changed)
        # CKPT7_MOUNT_OBSERVATION_BOUND, CKPT7_RECORDED_VERDICT_REJUDGED.
        mounted = dict(record=row("api", mounts=["/etc/kin-kept"], changes=["A /etc/kin-kept"],
                                  verdicts=[{"change": "A /etc/kin-kept", "verdict": "transient-or-mount"}]))
        verdicts = {
            "an invented mount for an accepted change": ("api", mounted),
            "the same change accepted without the mount": ("api", dict(record=row("api", changes=["A /etc/kin-kept"],
                                                                                   verdicts=[{"change": "A /etc/kin-kept", "verdict": "transient-or-mount"}]))),
            "a verdict left out": ("proxy", dict(record=row("proxy", changes=["C /run"], verdicts=[]))),
            "a verdict added": ("proxy", dict(record=row("proxy", verdicts=[{"change": "C /run", "verdict": "transient-or-mount"}]))),
            "verdicts reordered": ("proxy", dict(record=row("proxy", changes=["C /run", "A /run/nginx.pid"], verdicts=[
                {"change": "A /run/nginx.pid", "verdict": "transient-or-mount"}, {"change": "C /run", "verdict": "transient-or-mount"}]))),
            "another regenerated kind": ("proxy", dict(record=row("proxy", changes=["C /run"], verdicts=[{"change": "C /run",
                                                                                                       "verdict": "regenerated:hostid"}]))),
            "a mount observed but not recorded": ("api", dict(boundary=lambda value: value["facts"]["containers"]["api"].update(
                mounts=[["/var/lib/kin-emr", PROJECT + "_emr-state", True]]))),
        }
        for name, (role, changes) in verdicts.items():
            with self.subTest(verdict=name):
                data, changed = rebound(arguments, raw, **changes)
                self.refusedFor("CKPT7_MOUNT_OBSERVATION_BOUND", role, cp.layer_valid, data, **changed)
        with self.subTest(verdict="a real mount point and its folder, observed and recorded, are accepted; a sibling is not"):
            for diffs, expected in ((["C /var", "C /var/lib", "A /var/lib/kin-emr"], "SEALED"),
                                    (["C /var", "C /var/lib", "A /var/lib/kin-emr", "A /var/lib/kept"], "WRITABLE_LAYER")):
                target = target_fixture()
                backend = FakeBackend({role: target["containers"][role] for role in intro.ROLES}, {**target["volumes"], "proxy_certs": PROJECT + "_proxy-certs"})
                backend.containers[target["containers"]["api"]]["mounts"] = [{"type": "volume", "name": PROJECT + "_emr-state", "destination": "/var/lib/kin-emr"}]
                backend.diffs[target["containers"]["api"]] = diffs
                code = _outcome(lambda: cp.load_bundle(self.captured("introduced", backend)[0]))
                self.assertEqual(code if code == "ACCEPTED" else code.split(":")[0], "ACCEPTED" if expected == "SEALED" else expected,
                                 "CKPT7_MOUNT_OBSERVATION_BOUND: " + code)
        # Generation: the same judgement right after write_layer, before store.begin (the raw kept, nothing sealed).
        target = target_fixture()
        names = {role: target["containers"][role] for role in intro.ROLES}
        for name, prepare in (("the daemon reports another image than the capture observed", lambda b: b.containers[names["api"]].update(image="sha256:" + "8" * 64)),
                              ("a container left between the capture observation and the stop", lambda b: b.containers.pop(names["keycloak"]))):
            with self.subTest(generation=name):
                backend = FakeBackend(names, {**target["volumes"], "proxy_certs": PROJECT + "_proxy-certs"})
                prepare(backend)
                fixture, store_root = self.tempdir(), self.tempdir() / "bundles"
                self.assertRefused("LAYER_INVALID", self.captured, "introduced", backend, fixture=fixture, store_root=store_root)
                self.assertEqual(sorted(path.name for path in store_root.iterdir()), [], "CKPT7_REQUIRED_RAW_RETAINED: nothing sealed, no partial")
                self.assertEqual(len(list(fixture.glob("*/records/" + cp.OBSERVATION_DIR + "/layer-*/" + cp.LAYER_FILE))), 1,
                                 "CKPT7_REQUIRED_RAW_RETAINED: the judged record is kept")
                self.assertFalse([call for call in backend.calls if call[0] == "export"], "no volume was exported")

    def test_every_consumer_rejudges_the_row_with_its_hashes_rebound(self):
        """O7-CONSUMERS/O7-RAW (R7 3-4): the index over a rebound raw record is UNVERIFIED with the layer reason, never
        BOUND; a BOUND index the old validator wrote over such evidence is PARENT_UNBOUND at every consumption and no
        parent request is issued from it; a rebound bundle is refused by restore_checkpoint before any daemon call or
        fixture root; repeated consumption of a valid BOUND index stays accepted and a raw change after it is refused."""
        rows = layer_oracles(self)
        for name, outcome in rows.items():
            with self.subTest(oracle=name):
                consumer, _, case = name.partition(": ")
                control = case.startswith(("control", "held control", "orthanc observed ABSENT"))
                if consumer == "bundle":
                    self.assertEqual(outcome == "ACCEPTED", control, "CKPT7_REBOUND_RAW_UNVERIFIED: " + outcome)
                elif consumer == "index":
                    self.assertEqual(outcome.startswith("BOUND: []"), control, "CKPT7_REBOUND_RAW_UNVERIFIED: " + outcome)
                    if not control:
                        self.assertIn("writable-layer record: LAYER_INVALID", outcome, "CKPT7_REBOUND_RAW_UNVERIFIED")
                elif consumer in ("bound_index", "leaf_request"):
                    self.assertTrue(outcome.startswith("PARENT_UNBOUND: ") and "LAYER_INVALID" in outcome, "CKPT7_BOUND_CONSUMPTION_REJUDGES: " + outcome)
                else:
                    result = json.loads(outcome)
                    if control:
                        self.assertEqual(result["outcome"], "ACCEPTED", "CKPT7_VALID_CAPTURE_ACCEPTED")
                    else:
                        self.assertEqual((result["outcome"].split(":")[0], result["daemon_calls"], result["fixture_root_created"]),
                                         ("BUNDLE_INVALID", 0, False), "CKPT7_PARENT_REFUSED_BEFORE_RESTORE: " + outcome)
        # SR7-1: the restore takes nothing from a manifest read earlier but the bundle's own - an owned network, an owned
        # volume or the boundary changed in the caller's copy (the bundle intact) refuses before any daemon call.
        final = o7_bundle(self)[1]
        for name, forge in {
            "an owned network added": lambda manifest: manifest["owned"].setdefault("networks", []).append({"name": "forged-net", "labels": {}}),
            "an owned volume added": lambda manifest: manifest["owned"].setdefault("volumes", {}).update(
                {"extra:forged-volume": {"name": "forged-volume", "labels": {}, "member": "fixture-tree.tar"}}),
            "the boundary replaced": lambda manifest: manifest.update(boundary={"forged": True}),
        }.items():
            with self.subTest(forged_manifest=name):
                result = o7_restore(self, final, forge)
                self.assertEqual((result["outcome"].split(":")[0], result["daemon_calls"], result["fixture_root_created"]),
                                 ("BUNDLE_INVALID", 0, False), "CKPT7_PARENT_REFUSED_BEFORE_RESTORE: " + name + ": " + json.dumps(result))
        self.assertEqual(o7_restore(self, final)["outcome"], "ACCEPTED", "CKPT7_VALID_CAPTURE_ACCEPTED")
        # Repeated consumption of one valid BOUND index; a raw change after it; a forged BOUND over rebound evidence.
        root = self.tempdir("kin-proof-")
        unit = "release-tools-checkpoints-proof-prefix-introduce"
        proof, run_dir, index = o7_index(self, unit=unit, root=root)
        self.assertEqual(index["verdict"], "BOUND", index["reasons"])
        cp.write_index(root, index)
        (root / "b.source-manifest.json").write_bytes(cp.canonical({"root": str(root / "b")}) + b"\n")
        for attempt in (1, 2):
            with self.subTest(consumed=attempt):
                self.admitted(cp.bound_index, root, unit)
                self.admitted(cp.resolve_parent, proof.leaves, "release-tools-checkpoints-proof-late-resume", root)
        record = next(proof.evidence.rglob(cp.LAYER_FILE))
        original = record.read_bytes()
        record.write_bytes(original.replace(b'"absent":false', b'"absent":true', 1))
        self.refusedFor("CKPT7_BOUND_CONSUMPTION_REJUDGES", None, cp.bound_index, root, unit, code="PARENT_UNBOUND")
        record.write_bytes(original)
        self.admitted(cp.bound_index, root, unit)
        # The parent bundle itself is loaded when the parent reference is issued: a damaged one is no parent.
        tree = Path(proof.results["checkpoint"]["path"]) / "payload" / "fixture-tree.tar"
        kept = tree.read_bytes()
        tree.write_bytes(kept[:-1] + bytes([kept[-1] ^ 1]))
        self.refusedFor("CKPT7_PARENT_REFUSED_BEFORE_RESTORE", None, cp.resolve_parent, proof.leaves, "release-tools-checkpoints-proof-late-resume",
                        root, code="PARENT_UNBOUND")
        tree.write_bytes(kept)
        # The original capture observation and S stay byte-identical through every consumption (CKPT7_ORIGINAL_OBSERVATION_UNCHANGED).
        before = {path.relative_to(proof.evidence).as_posix(): cp.sha256(path.read_bytes()) for path in proof.evidence.rglob("*") if path.is_file()}
        self.admitted(cp.bound_index, root, unit)
        cp.leaf_index(proof.leaves, proof.unit, proof.root, run_dir)
        self.assertEqual({path.relative_to(proof.evidence).as_posix(): cp.sha256(path.read_bytes()) for path in proof.evidence.rglob("*")
                          if path.is_file()}, before, "CKPT7_ORIGINAL_OBSERVATION_UNCHANGED")


# ── r8 (consult-checkpoints-r8-20261017, CKPT7-01/02): one verified-return judgement at every consumer ──
# The oracle helpers (native_contrast, typed_refusal_table, typed_refusal_adapters) use only entry points de02468 has as
# well (Smoke.regenerated, capture_checkpoint, load_bundle, layer_context/layer_valid, restore_checkpoint, leaf_index,
# bound_index, leaf_request), so the same oracle ran red on de02468 and green on r8 (evidence native-contrast-on-*.json,
# typed-refusals-on-*.json). A consumer that raises anything but a typed refusal is recorded as an EXCEPTION row, which
# the r8 assertions count as a failure: never a pass, never skipped.
R8_MISSING, R8_NORMAL = object(), object()
R8_KINDS = (("normal", R8_NORMAL), ("missing", R8_MISSING), ("null", None), ("true", True), ("false", False), ("integer", 7), ("number", 1.5),
            ("string", "x"), ("array", ["x"]), ("object", {"x": 1}), ("empty string", ""), ("empty array", []), ("empty object", {}))
# The closed layer schema's declared fields (consult-checkpoints-r7-20261017 layer_valid_contract) as paths into the record
# of an Orthanc-start capture (its api row: transient changes, no facts; its orthanc row: typed facts and regenerated
# verdicts), and the absent row of a capture that observed Orthanc ABSENT.
R8_RECORD_FIELDS = (("schema",), ("kind",), ("checkpoint",), ("observation",), ("observation", "path"), ("observation", "sha256"),
                    ("observation", "request_sha256"), ("descriptor_sha256",), ("roles",), ("outcome",), ("refused",), ("judged_utc",),
                    ("roles", "api"), *(("roles", "api", key) for key in ("absent", "container_id", "container_name", "image", "mounts", "changes",
                                                                          "facts", "layer_observable", "verdicts")),
                    ("roles", "api", "changes", 0), ("roles", "api", "verdicts", 0), ("roles", "api", "verdicts", 0, "change"),
                    ("roles", "api", "verdicts", 0, "verdict"), ("roles", "orthanc", "facts"), ("roles", "orthanc", "layer_observable"),
                    ("roles", "orthanc", "verdicts"), ("roles", "orthanc", "facts", "/etc/hostid"),
                    *(("roles", "orthanc", "facts", "/etc/hostid", key) for key in ("type", "mode", "uid", "gid", "size", "sha256", "text")),
                    *(("roles", "orthanc", "facts", "/etc", key) for key in ("type", "mode", "uid", "gid")))
R8_ABSENT_FIELDS = (("roles", "orthanc"), ("roles", "orthanc", "absent"), ("roles", "orthanc", "container_name"))
# The context and binding boundary the judgement reads: its arguments and the fields it reads in them (a missing argument
# is None, what an adapter passes for an input it could not read).
R8_ARGUMENT_FIELDS = (("layer_binding",), ("layer_binding", "path"), ("layer_binding", "sha256"), ("state_binding",), ("state_binding", "path"),
                      ("state_binding", "sha256"), ("checkpoint_id",), ("observation",), ("observation", "path"), ("observation", "sha256"),
                      ("observation_files",), ("identity",), ("identity", "plan_sha256"), ("identity", "image_ids"),
                      ("identity", "image_ids", "release"), ("boundary",), ("boundary", "facts"), ("boundary", "facts", "containers"),
                      ("boundary", "facts", "containers", "api"), ("boundary", "facts", "containers", "api", "id"),
                      ("boundary", "facts", "containers", "api", "mounts"), ("owned",), ("owned", "projects"), ("owned", "stack"),
                      ("owned", "stack", "containers"), ("owned", "stack", "containers", "api"), ("plan",), ("plan", "release"),
                      ("plan", "release", "images"), ("plan", "release", "images", "api"), ("state_raw",), ("target_names",),
                      ("target_names", "api"))
# The bound capture snapshot rows the judgement cross-checks (their hashes rebound up to the seal's observation binding).
R8_SNAPSHOT_FIELDS = (("facts", "containers", "value", "api"), ("facts", "containers", "value", "api", "value", "image"))
# The descriptor fields the judgement reads (regenerated_applicable, regenerated_entry, layer_verdicts), mistyped in the
# descriptor a capture whose Orthanc role starts normally is judged against: the typed entries are refused, typed.
R8_DESCRIPTOR_FIELDS = ("applicable", "hostid_regenerated", "container_id", "actual_image", "pinned_image", "image", "generated")
# Kinds the contract accepts besides the normal value itself, with the reason.
R8_ACCEPTED_BY_CONTRACT = {
    ("judged_utc",): {"string", "empty string"},                          # a string: no time format is part of the record contract
    ("roles", "api", "layer_observable"): {"false"},                      # no facts and no regenerated verdict depend on it
    ("roles", "orthanc", "facts", "/etc/hostid", "size"): {"integer"},    # the hostid entry is judged by its content class only
}
R8_MALFORMED_FACTS = {"fact.type a list": lambda record: record["roles"]["api"].update(facts={"/tmp": {"type": []}}),
                      "fact.type an object": lambda record: record["roles"]["api"].update(facts={"/tmp": {"type": {}}})}
R8_SUBSTITUTED_CHANGE = "A /tmp/kin-r8-substituted"
# D1556 SRCK8-1: context/state fields the restore inputs read and no loader judges, mistyped (realistic's tamper).
R8_INPUT_SHAPES = (("source-b0", "context.b0 = 'x'", lambda parts: parts["context"].update(b0="x")),
                   ("source-b0", "context.b0 = [1]", lambda parts: parts["context"].update(b0=[1])),
                   ("source-b0", "context.stacks = [1]", lambda parts: parts["context"].update(stacks=[1])),
                   ("source-b0", "context.stacks = 's'", lambda parts: parts["context"].update(stacks="s")),
                   ("source-b0", "state.b0 = 'x'", lambda parts: parts["state"].update(b0="x")),
                   ("introduced", "state.b0 = 'x'", lambda parts: parts["state"].update(b0="x")),
                   ("introduced", "context.b0 = 'x'", lambda parts: parts["context"].update(b0="x")))


def _typed(action):
    """'ACCEPTED', '<CODE>: <reason>' for a typed refusal, or 'EXCEPTION <type>: <message>'."""
    try:
        action()
        return "ACCEPTED"
    except cp.Refused as error:
        return error.code + ": " + str(error)
    except Exception as error:  # an oracle records what the consumer did; the r8 assertions count this row as a failure
        return "EXCEPTION " + type(error).__name__ + ": " + str(error)[:300]


def _row(action):
    """action()'s row, or {"outcome": "EXCEPTION ..."} (as _typed) when it raised."""
    try:
        return action()
    except Exception as error:  # as _typed: a red row, never a pass
        return {"outcome": "EXCEPTION " + type(error).__name__ + ": " + str(error)[:300]}


def _get(document, path):
    for key in path:
        document = document[key]
    return document


def _put(document, path, value):
    """The value at `path` replaced in place (R8_MISSING removes it, R8_NORMAL keeps it)."""
    node = _get(document, path[:-1])
    if value is R8_MISSING:
        del node[path[-1]]
    elif value is not R8_NORMAL:
        node[path[-1]] = copy.deepcopy(value)


def _normal(document, path, value):
    """Whether the cell's value is the document's own (its normal value, or a kind equal to it with its JSON type)."""
    return value is R8_NORMAL or (value is not R8_MISSING and _strict(_get(document, path), value))


def _strict(a, b):
    """JSON equality with types (True is not 1)."""
    if type(a) is not type(b):
        return False
    if type(a) is dict:
        return a.keys() == b.keys() and all(_strict(a[key], b[key]) for key in a)
    if type(a) is list:
        return len(a) == len(b) and all(_strict(x, y) for x, y in zip(a, b))
    return a == b


def r8_bundle(test, change=None, *, checkpoint_id="introduced", absent=()):
    """o7_bundle's sealed bundle (one coherent capture, `change(record)` applied with the record's binding rebound before the
    seal), without loading it. Returns the bundle folder."""
    fixture = test.tempdir("kin-r8-")
    made = realistic(fixture, checkpoint_id, absent=absent)
    if change is not None:
        path = fixture / made.bindings["layer"]["path"]
        record = json.loads(path.read_bytes())
        change(record)
        path.write_bytes(cp.canonical(record) + b"\n")
        made.bindings["layer"] = {**made.bindings["layer"], "sha256": cp.sha256(path.read_bytes())}
    return bundle_from(test, fixture, made, checkpoint_id)


def orthanc_capture(test, *, api_change=False, judged=None):
    """A capture at INTRODUCED sealed by the real capture_checkpoint over FakeBackend, its Orthanc role started normally on
    its pinned image (the five typed regenerated entries); `api_change` adds a transient change to the API role, `judged`
    is another descriptor the capture is judged against. Returns (bundle folder, descriptor)."""
    target = target_fixture()
    names = {role: target["containers"][role] for role in intro.ROLES}
    descriptor = regenerated_fixture("id-" + names["orthanc"])
    backend = FakeBackend(names, {**target["volumes"], "proxy_certs": PROJECT + "_proxy-certs"})
    backend.diffs[names["orthanc"]] = list(ORTHANC_START)
    backend.layers[names["orthanc"]] = start_facts(descriptor)
    if api_change:
        backend.diffs[names["api"]] = [R8_SUBSTITUTED_CHANGE]
    final = CaptureFixture.captured(test, "introduced", backend, descriptor=judged or descriptor)[0]
    return Path(final), descriptor


def substitute_api_change(record):
    """An allowed transient change written into the API row (a record the contract accepts, apart from its binding)."""
    record["roles"]["api"].update(changes=[R8_SUBSTITUTED_CHANGE], verdicts=[{"change": R8_SUBSTITUTED_CHANGE, "verdict": "transient-or-mount"}])


def swap_member(bundle, rel, data):
    """One member of a sealed bundle's fixture-tree.tar replaced and nothing rebound (the manifest, its member hash and the
    layer binding keep the old values): a raw changed after a normal load."""
    tree = Path(bundle) / "payload" / "fixture-tree.tar"
    buffer = io.BytesIO()
    with tarfile.open(fileobj=io.BytesIO(tree.read_bytes()), mode="r:") as source, \
            tarfile.open(fileobj=buffer, mode="w:", format=tarfile.PAX_FORMAT) as target:
        found = False
        for member in source.getmembers():
            content = source.extractfile(member).read() if member.isfile() else None
            if member.isfile() and (member.name[2:] if member.name.startswith("./") else member.name) == rel:
                found = True
                if data is None:
                    continue
                content, member.size = data, len(data)
            target.addfile(member, io.BytesIO(content) if content is not None else None)
        if not found and data is not None:
            member = tarfile.TarInfo(rel)
            member.size = len(data)
            target.addfile(member, io.BytesIO(data))
    tree.write_bytes(buffer.getvalue())


def swapped_layer(bundle):
    """The bundle's layer record replaced by substitute_api_change's, its hash not updated. Returns (bound, current SHA)."""
    manifest = json.loads((Path(bundle) / "manifest.json").read_bytes())
    binding = manifest["bindings"]["layer"]
    record = json.loads(cp.tree_member_bytes(Path(bundle) / "payload" / "fixture-tree.tar", binding["path"]))
    substitute_api_change(record)
    data = cp.canonical(record) + b"\n"
    swap_member(bundle, binding["path"], data)
    return binding["sha256"], cp.sha256(data)


def rebound_archive(bundle):
    """A copy of a bundle whose changed fixture-tree.tar is re-hashed in its manifest (member, payload manifest, the bundle
    name) while the writable-layer binding keeps the sealed record's SHA-256. Returns the new bundle folder."""
    bundle = Path(bundle)
    manifest = json.loads((bundle / "manifest.json").read_bytes())
    tree = bundle / "payload" / "fixture-tree.tar"
    for member in manifest["members"]:
        if member["name"] == "fixture-tree.tar":
            member.update(sha256=cp.sha256(tree.read_bytes()), bytes=tree.stat().st_size)
    manifest["identity"]["payload_manifest_sha256"] = cp.sha256(cp.canonical(sorted(manifest["members"], key=lambda m: m["name"])))
    raw = cp.canonical(manifest) + b"\n"
    folder = bundle.parent / cp.sha256(raw)
    shutil.copytree(bundle / "payload", folder / "payload")
    (folder / "manifest.json").write_bytes(raw)
    return folder


def sealed_of(bundle, descriptor=None):
    """What the native smoke holds after a capture: the bundle, the manifest of a normal load (read here from its own bytes,
    so it also exists for a bundle no loader accepts) and the observation's descriptor."""
    bundle = Path(bundle)
    manifest = json.loads((bundle / "manifest.json").read_bytes())
    if descriptor is None:
        folder = manifest["bindings"]["observation"]["path"].rsplit("/", 1)[0]
        descriptor = json.loads(cp.tree_member_bytes(bundle / "payload" / "fixture-tree.tar", folder + "/" + cp.REGENERATED_FILE))
    return {"bundle": bundle, "manifest": manifest, "observation": {"regenerated": copy.deepcopy(descriptor)}}


def native_regenerated(test, sealed, checkpoint_id="introduced"):
    """The real native Smoke.regenerated method on a pure Smoke object (its own evidence folder; the method makes no Docker
    call): its outcome, the A05/A12 PASS rows it recorded, the raw files it wrote and the digests of what it emitted."""
    import ops_release_checkpoints_native_test as native
    evidence = test.tempdir("kin-r8-native-")
    smoke = native.Smoke(evidence)
    outcome = _typed(lambda: smoke.regenerated(checkpoint_id, sealed))
    log = evidence / "smoke-log.jsonl"
    rows = [json.loads(line) for line in log.read_bytes().splitlines()] if log.exists() else []
    out = {"outcome": outcome, "a05_a12_pass_rows": sum(1 for row in rows if row["outcome"] == "PASS" and {"A05", "A12"} & set(row["ids"])),
           "check_rows": len(rows), "raw_files": sorted(path.name for path in evidence.iterdir() if path.name.startswith("regenerated-"))}
    emitted = evidence / ("regenerated-" + checkpoint_id + ".json")
    if emitted.exists():
        document = json.loads(emitted.read_bytes())
        out.update(emitted_descriptor_sha256=cp.sha256(cp.canonical(document["descriptor"]) + b"\n"),
                   record_descriptor_sha256=document["layer"]["descriptor_sha256"],
                   emitted_layer_sha256=cp.sha256(cp.canonical(document["layer"]) + b"\n"))
    return out


def native_contrast(test):
    """R8-03 (consult-checkpoints-r8-20261017): the real Smoke.regenerated over a normal capture; the same with a stale
    descriptor argument; a raw swap after a normal load with no hash updated; a legal new seal of the same change; and
    bundles sealed with their hashes rebound over a semantic contradiction or a malformed fact. Returns {case: row}."""
    rows = {}
    final, descriptor = orthanc_capture(test)
    bound = json.loads((final / "manifest.json").read_bytes())["bindings"]["layer"]["sha256"]
    rows["control"] = {**native_regenerated(test, sealed_of(final, descriptor)), "bound_layer_sha256": bound}
    stale = sealed_of(final, descriptor)
    stale["observation"]["regenerated"]["generated"] = {}
    rows["a stale descriptor argument"] = {**native_regenerated(test, stale), "bound_layer_sha256": bound,
                                           "argument_descriptor_sha256": cp.sha256(cp.canonical(stale["observation"]["regenerated"]) + b"\n")}
    final, descriptor = orthanc_capture(test)
    loaded = sealed_of(final, descriptor)   # the manifest of a normal load, before the raw changes
    bound, current = swapped_layer(final)
    rows["a raw swap after a normal load (no hash updated)"] = {**native_regenerated(test, loaded), "bound_layer_sha256": bound,
                                                                "current_layer_sha256": current}
    resealed = rebound_archive(final)
    rows["a raw swap with the archive re-hashed, the layer binding not updated"] = {
        **native_regenerated(test, sealed_of(resealed, descriptor)), "bound_layer_sha256": bound, "current_layer_sha256": current}
    final, descriptor = orthanc_capture(test, api_change=True)
    rows["a legal new seal of the same change"] = {**native_regenerated(test, sealed_of(final, descriptor)),
                                                   "bound_layer_sha256": json.loads((final / "manifest.json").read_bytes())["bindings"]["layer"]["sha256"]}
    for name, change in (("a semantic contradiction, hashes rebound (api image substituted)", O7_ROW_CHANGES["api image substituted"]),
                         *(("a malformed fact, hashes rebound (" + key + ")", value) for key, value in R8_MALFORMED_FACTS.items())):
        rows[name] = native_regenerated(test, sealed_of(r8_bundle(test, change)))
    return rows


def _bundle_arguments(bundle):
    """The record bytes and layer_valid's arguments of a sealed bundle, read from its fixture member (layer_context)."""
    manifest = json.loads((Path(bundle) / "manifest.json").read_bytes())
    tree = Path(bundle) / "payload" / "fixture-tree.tar"
    return (cp.tree_member_bytes(tree, manifest["bindings"]["layer"]["path"]),
            cp.layer_context(manifest, lambda rel: cp.tree_member_bytes(tree, rel), lambda rel: cp.tree_folder(tree, rel)))


def typed_refusal_table(test):
    """R8-04 at the judgement itself: every declared field of the closed layer schema (the record, the absent row), every
    field of the context and binding boundary it reads (its arguments) and the bound snapshot rows it cross-checks, each as
    missing/null/bool/number/string/array/object/empty and as its normal value, every other hash rebound so a refusal is
    the contract's. Returns {cell: {"expected", "outcome"}}: ACCEPTED for the normal value and the R8_ACCEPTED_BY_CONTRACT
    kinds, LAYER_INVALID for every other cell."""
    rows = {}
    final, _ = orthanc_capture(test)
    raw, arguments = _bundle_arguments(final)
    absent_raw, absent_arguments = _bundle_arguments(r8_bundle(test, absent=("orthanc",)))
    for label, base_raw, base_arguments, fields in (("record", raw, arguments, R8_RECORD_FIELDS),
                                                    ("absent row", absent_raw, absent_arguments, R8_ABSENT_FIELDS)):
        original = json.loads(base_raw)
        for path in fields:
            for kind, value in R8_KINDS:
                data, changed = rebound(base_arguments, base_raw, record=lambda document, path=path, value=value: _put(document, path, value))
                normal = _normal(original, path, value)
                rows[label + " " + " > ".join(map(str, path)) + " = " + kind] = {
                    "expected": "ACCEPTED" if normal or kind in R8_ACCEPTED_BY_CONTRACT.get(path, ()) else "LAYER_INVALID",
                    "outcome": _typed(lambda: cp.layer_valid(data, **changed))}
    for path in R8_ARGUMENT_FIELDS:
        for kind, value in R8_KINDS:
            cell = "argument " + " > ".join(map(str, path)) + " = " + kind
            if path[0] not in arguments:
                rows[cell] = {"expected": "NOT APPLICABLE", "outcome": "NOT APPLICABLE: this tree's judgement has no " + path[0]}
                continue
            changed = copy.deepcopy(arguments)
            if value is R8_MISSING and len(path) == 1:
                changed[path[0]] = None
            else:
                _put(changed, path, value)
            normal = _normal(arguments, path, value)
            rows[cell] = {"expected": "ACCEPTED" if normal else "LAYER_INVALID", "outcome": _typed(lambda: cp.layer_valid(raw, **changed))}
    snapshot = json.loads(arguments["observation_files"]["snapshot.json"])
    for path in R8_SNAPSHOT_FIELDS:
        for kind, value in R8_KINDS:
            data, changed = rebound(arguments, raw, snapshot=lambda document, path=path, value=value: _put(document, path, value))
            normal = _normal(snapshot, path, value)
            rows["snapshot " + " > ".join(map(str, path)) + " = " + kind] = {"expected": "ACCEPTED" if normal else "LAYER_INVALID",
                                                                            "outcome": _typed(lambda: cp.layer_valid(data, **changed))}
    return rows


def typed_refusal_adapters(test):
    """R8-04 through the adapters: a malformed fact (fact.type a list, an object) sealed with its hashes rebound is
    BUNDLE_INVALID at load_bundle and before a restore, UNVERIFIED with its reason in the index, PARENT_UNBOUND at a stored
    BOUND index's consumption and parent issuance, and leaves no native success evidence; and every descriptor field the
    judgement reads, mistyped in the descriptor of a capture whose Orthanc role starts normally, is the capture's typed
    refusal before store.begin. Returns {cell: {"expected", ...observed}}."""
    rows = {}
    for name, change in R8_MALFORMED_FACTS.items():
        final = r8_bundle(test, change)
        cause = {"cause": "LAYER_INVALID"}
        rows[name + ": load_bundle"] = {"expected": "BUNDLE_INVALID", **cause, "outcome": _typed(lambda: cp.load_bundle(final))}
        rows[name + ": restore_checkpoint"] = {"expected": "BUNDLE_INVALID", **cause, **_row(lambda: o7_restore(test, final))}
        index = _row(lambda: o7_index(test, change)[2])
        rows[name + ": leaf_index"] = {"expected": "UNVERIFIED", **cause,
                                       "outcome": index["verdict"] + ": " + json.dumps(index["reasons"]) if "verdict" in index else index["outcome"]}
        forged = _row(lambda: o7_forged_parent(test, change))
        rows[name + ": bound_index (a stored BOUND)"] = {"expected": "PARENT_UNBOUND", **cause, "outcome": forged.get("bound_index", forged.get("outcome"))}
        rows[name + ": leaf_request (parent issuance)"] = {"expected": "PARENT_UNBOUND", **cause,
                                                           "outcome": forged.get("leaf_request", forged.get("outcome"))}
        rows[name + ": Smoke.regenerated"] = {"expected": "BUNDLE_INVALID", **cause, **native_regenerated(test, sealed_of(final))}
    # D1556 SRCK8-1: the restore inputs (bundle_inputs) of bundles the loader accepts - a source-b0 bundle judges no layer,
    # and the layer judgement reads no B0 field - with a mistyped context or state field, the hashes rebound (sealed so).
    for checkpoint_id, unit in (("source-b0", "release-tools-checkpoints-proof-prefix-seed"), ("introduced", "release-tools-checkpoints-proof-prefix-verify")):
        fixture = test.tempdir("kin-r8-inputs-")
        bundle = bundle_from(test, fixture, realistic(fixture, checkpoint_id), checkpoint_id)
        rows[checkpoint_id + " control: restore_checkpoint"] = {"expected": "ACCEPTED", **_row(lambda: o7_restore(test, bundle))}
        rows[checkpoint_id + " control: live leaf admission"] = {"expected": "SYNTHETIC_TRANSPORT_END", **_row(lambda: live_admission(test, bundle, unit=unit))}
    for checkpoint_id, name, tamper in R8_INPUT_SHAPES:
        fixture = test.tempdir("kin-r8-inputs-")
        bundle = bundle_from(test, fixture, realistic(fixture, checkpoint_id, tamper=tamper), checkpoint_id)
        label = checkpoint_id + " " + name
        unit = "release-tools-checkpoints-proof-prefix-seed" if checkpoint_id == "source-b0" else "release-tools-checkpoints-proof-prefix-verify"
        rows[label + ": load_bundle (it judges no B0 field)"] = {"expected": "ACCEPTED", "outcome": _typed(lambda: cp.load_bundle(bundle))}
        rows[label + ": restore_checkpoint"] = {"expected": "BUNDLE_INPUT_MISMATCH", **_row(lambda: o7_restore(test, bundle))}
        rows[label + ": restore_boundary (live wrapper)"] = {"expected": "BUNDLE_INPUT_MISMATCH", **_row(lambda: restore_wrapper(test, bundle))}
        rows[label + ": live leaf admission (" + unit.rsplit("-", 2)[-2] + "-" + unit.rsplit("-", 1)[-1] + ")"] = {
            "expected": "BUNDLE_INPUT_MISMATCH", **_row(lambda: live_admission(test, bundle, unit=unit))}
    good = regenerated_fixture("id-" + PROJECT + "-orthanc")
    for field in R8_DESCRIPTOR_FIELDS:
        for kind, value in R8_KINDS:
            judged = copy.deepcopy(good)
            _put(judged, (field,), value)
            normal = _normal(good, (field,), value)
            rows["capture with descriptor " + field + " = " + kind] = {
                "expected": "ACCEPTED" if normal else "WRITABLE_LAYER|LAYER_INVALID",
                "outcome": _typed(lambda: orthanc_capture(test, judged=judged))}
    return rows


def _tree_digest(folder):
    """{relative path: SHA-256} of every file under a folder (a consumer's write to a bundle or an evidence root)."""
    folder = Path(folder)
    return {path.relative_to(folder).as_posix(): cp.sha256(path.read_bytes()) for path in sorted(folder.rglob("*")) if path.is_file()} \
        if folder.exists() else {}


def _layer_digests(bundle):
    """(current layer bytes' SHA-256 in the fixture member, the seal's layer binding SHA-256) of a sealed bundle."""
    manifest = json.loads((Path(bundle) / "manifest.json").read_bytes())
    data = cp.tree_member_bytes(Path(bundle) / "payload" / "fixture-tree.tar", manifest["bindings"]["layer"]["path"])
    return (cp.sha256(data) if data is not None else None), manifest["bindings"]["layer"]["sha256"]


def _raw_layer_digests(proof):
    """(the raw layer record's SHA-256 in a leaf's evidence, the sealed manifest's layer binding SHA-256)."""
    found = sorted(proof.evidence.rglob(cp.LAYER_FILE))
    manifest = json.loads((Path(proof.results["checkpoint"]["path"]) / "manifest.json").read_bytes()) if proof.results.get("checkpoint") else {}
    return (cp.sha256(found[0].read_bytes()) if found else None), ((manifest.get("bindings") or {}).get("layer") or {}).get("sha256")


def forged_parent(test, change):
    """o7_forged_parent's proof root (the parent leaf prefix-introduce recorded over a rebound record, its index written BOUND
    as 0535bc8 wrote one over such evidence, the late-resume source manifest in place). Returns (root, proof)."""
    root = test.tempdir("kin-proof-")
    proof, _, index = o7_index(test, change, unit="release-tools-checkpoints-proof-prefix-introduce", root=root)
    cp.write_index(root, {**index, "verdict": "BOUND", "reasons": []})
    (root / "b.source-manifest.json").write_bytes(cp.canonical({"root": str(root / "b")}) + b"\n")
    return root, proof


def live_admission(test, bundle, unit="release-tools-checkpoints-proof-prefix-verify"):
    """The live leaf's real admission (ops_release_checkpoints_live_test.CheckpointSegments.segment, the leaf `unit`) of a
    stored request naming `bundle` as its parent, in this test's own gate state (gate.live_run grants the permission there)
    and with the host and runtime observations answered synthetically (the executing tree's source and runtime identity,
    CheckpointDocker.runtime_facts; host_facts ends the run the first time it is reached, after the parent was admitted).
    The request, marker and parent loader are the real ones. Returns its row."""
    import ops_release_checkpoints_live_test as live
    bundle = Path(bundle)
    leaf = cp.registry_leaf(list(cp.DEFAULT_PROOF_LEAVES), unit)
    folder, state = test.tempdir("kin-r8-request-"), test.tempdir("kin-r8-gate-")
    source = {"tool": {"sha256": "1" * 64}, "source": {"sha256": "2" * 64}, "harness": {"sha256": "3" * 64}, "tool_files": {}}
    source_path = folder / "source-manifest.json"
    source_path.write_bytes(cp.canonical(source) + b"\n")
    request = {"schema": 1, "unit": unit, "case": leaf["case"], "scenario": leaf["scenario"], "stage": leaf["stage"],
               "execution_kind": leaf["execution_kind"], "parent_manifest": {"path": str(bundle / "manifest.json"), "sha256": bundle.name},
               "source_manifest": {"path": str(source_path), "sha256": cp.sha256(source_path.read_bytes())},
               "output_root": str(bundle.parent.parent), "evidence_root": str(folder / "evidence")}
    request_path = folder / "request.json"
    request_path.write_bytes(cp.canonical(request) + b"\n")
    calls = {"load_bundle": 0, "host_facts": 0, "restore_boundary": 0}
    real_load = cp.load_bundle

    def load(directory):
        calls["load_bundle"] += 1
        return real_load(directory)

    def host_facts(fixture_root, owned_ids=()):
        calls["host_facts"] += 1
        raise cp.Refused("SYNTHETIC_TRANSPORT_END", "the parent was admitted; this test observes no host")

    def restore(*args, **kwargs):
        calls["restore_boundary"] += 1
        raise AssertionError("a restore after a refused admission")
    before = _tree_digest(bundle)
    with patch.object(gate, "STATE", state), patch.dict(os.environ, {cp.REQUEST_ENV: str(request_path)}), \
            patch.object(cp, "source_identity", lambda root, helpers=(): copy.deepcopy(source)), \
            patch.object(cp, "runtime_identity", lambda facts, modules, root: {"synthetic": True}), \
            patch.object(live.rehearsal.CheckpointDocker, "runtime_facts", staticmethod(lambda: {})), \
            patch.object(live.rehearsal.CheckpointDocker, "host_facts", staticmethod(host_facts)), \
            patch.object(cp, "load_bundle", load), patch.object(live, "restore_boundary", restore):
        with gate.live_run(unit, cp.LIVE_FILE, "a" * 64, 1):   # the gate's own API, in this test's state folder
            outcome = _typed(lambda: live.CheckpointSegments(leaf["case"].split(".", 1)[1]).segment(leaf["stage"]))
    return {"outcome": outcome, **calls, "fixture_root_created": (bundle.parent.parent / "fixture").exists(),
            "bundle_changed": _tree_digest(bundle) != before}


def restore_wrapper(test, bundle):
    """ops_release_checkpoints_live_test.restore_boundary over a bundle with a synthetic transport in place of
    CheckpointDocker (FakeBackend's daemon; the restore observation and the restored boundary facts answered from the
    bundle's own facts with new container IDs): its outcome, the daemon mutations and whether a fixture root exists."""
    import ops_release_checkpoints_live_test as live
    bundle = Path(bundle)
    manifest = json.loads((bundle / "manifest.json").read_bytes())
    facts = _obj_or_none(_obj_or_none(manifest.get("boundary")).get("facts"))
    made = []

    class Synthetic(FakeBackend):
        def __init__(self, stack, helper):
            known = _obj_or_none(stack.target.get("containers")) if stack is not None else {}
            super().__init__({role: known[role] for role in intro.ROLES if type(known.get(role)) is str}, {})
            self.containers.clear()
            made.append(self)

        def image_present(self, image_id):
            self.calls.append(("image_present", image_id))
            return True

        def observe(self, checkpoint_id, **kwargs):
            self.calls.append(("observe", checkpoint_id))
            return {"synthetic_observation": checkpoint_id}

        def boundary_facts(self):
            self.calls.append(("boundary_facts",))
            return {**facts, "containers": {role: {**fact, "id": "restored-" + role} for role, fact in _obj_or_none(facts.get("containers")).items() if type(fact) is dict}}
    # The synthetic stack's names, read with type checks (this helper must not raise where the harness would refuse).
    owned = manifest.get("owned") if type(manifest.get("owned")) is dict else {}
    stack_value = owned.get("stack") if type(owned.get("stack")) is dict else {}
    stack = SimpleNamespace(records=SimpleNamespace(lease=contextlib.nullcontext),
                            target={"containers": stack_value.get("containers") if type(stack_value.get("containers")) is dict else {}})
    root = test.tempdir("kin-r8-restore-") / "restored"
    with patch.object(live.rehearsal, "CheckpointDocker", Synthetic):
        outcome = _typed(lambda: live.restore_boundary(manifest, bundle, fixture_root=root, helper=image("3"), load=lambda path: stack))
    return {"outcome": outcome, "daemon_mutations": sum(len(item.mutations()) for item in made), "fixture_root_created": root.exists()}


def consumer_inventory(test):
    """R8-05 (consult-checkpoints-r8-20261017 consumer_inventory_rule): every real entry point that reads a writable-layer
    record, descriptor, manifest or BOUND index, or writes success evidence from one, run (never its judgement stubbed)
    with a normal input and refused ones: per raw adapter (fixture, tar, raw records) a normal one, a raw changed with its
    hash not updated, a semantic contradiction and a malformed fact with their hashes rebound; per wrapper a normal and a
    refused one through its real judgement. Transport only is synthetic (FakeBackend, a synthetic CheckpointDocker, the
    live leaf's host/runtime observation); the live gate is its own API in a test state folder. Each row: consumer, entry
    point, raw source, contract, case, raw and binding SHA-256, result, expected prefix, side effects (`zero`: those that
    must be 0). Diagnostic helpers are rows of their own (classification "diagnostic"), never an admission."""
    import ops_release_checkpoints_native_test as native
    rows = []

    def row(consumer, entry, source, contract, case, result, expected, side_effects, *, zero=(), raw=None, binding=None,
            classification="consumer", note=None):
        rows.append({"consumer": consumer, "entry_point": entry, "raw_source": source, "contract": contract, "case": case,
                     "raw_sha256": raw, "binding_sha256": binding, "result": result, "expected": expected, "side_effects": side_effects,
                     "zero": list(zero), "classification": classification, **({"note": note} if note else {})})
    normal_case, stale_case = "normal", "raw changed, hash not updated"
    rebound_case = "semantic contradiction, hashes rebound (api image substituted)"
    contradiction = O7_ROW_CHANGES["api image substituted"]
    malformed = {"malformed fact, hashes rebound (" + key + ")": value for key, value in R8_MALFORMED_FACTS.items()}
    target = target_fixture()
    names = {role: target["containers"][role] for role in intro.ROLES}

    # 1. The fixture adapter: capture_checkpoint -> judge_layer -> write_layer -> fixture_layer -> layer_valid, before store.begin.
    def capture(case, expected, prepare=None, before=None):
        descriptor = regenerated_fixture("id-" + names["orthanc"])
        backend = FakeBackend(names, {**target["volumes"], "proxy_certs": PROJECT + "_proxy-certs"})
        backend.diffs[names["orthanc"]] = list(ORTHANC_START)
        backend.layers[names["orthanc"]] = start_facts(descriptor)
        if prepare:
            prepare(backend)
        fixture, store_root = test.tempdir(), test.tempdir() / "bundles"
        outcome = _typed(lambda: CaptureFixture.captured(test, "introduced", backend, descriptor=descriptor, fixture=fixture,
                                                         store_root=store_root, before=before))
        layers = sorted(fixture.glob("*/records/" + cp.OBSERVATION_DIR + "/layer-*/" + cp.LAYER_FILE))
        bundles = sorted(path.name for path in store_root.iterdir()) if store_root.exists() else []
        binding = None
        if bundles:
            binding = json.loads((store_root / bundles[0] / "manifest.json").read_bytes())["bindings"]["layer"]["sha256"]
        row("capture_checkpoint (fixture adapter)", "ops_release_checkpoints.capture_checkpoint", "the fixture root before the seal",
            "WRITABLE_LAYER / LAYER_INVALID before store.begin; the judged record kept", case, outcome, expected,
            {"bundles_sealed": len(bundles), "volume_exports": sum(1 for call in backend.calls if call[0] == "export"), "layer_records_kept": len(layers)},
            zero=() if expected == "ACCEPTED" else ("bundles_sealed", "volume_exports"), raw=cp.sha256(layers[0].read_bytes()) if layers else None,
            binding=binding)
    capture(normal_case, "ACCEPTED")
    capture("the state S changed after its binding, hash not updated", "LAYER_INVALID",
            before=lambda fixture, made: (fixture / made.bindings["state"]["path"]).write_bytes((fixture / made.bindings["state"]["path"]).read_bytes() + b" "))
    capture("semantic contradiction: the daemon reports another API image than the capture observed", "LAYER_INVALID",
            prepare=lambda backend: backend.containers[names["api"]].update(image=image("8")))
    capture("malformed fact from the daemon (the hostid fact's type a list)", "WRITABLE_LAYER",
            prepare=lambda backend: backend.layers[names["orthanc"]].update({cp.HOSTID: {**backend.layers[names["orthanc"]][cp.HOSTID], "type": []}}))

    # 2. The tar adapter: verify_bundle (and load_bundle, BundleStore.load over it).
    def tar(consumer, entry, bundle, case, expected, action):
        before = _tree_digest(bundle)
        current, binding = _layer_digests(bundle)
        outcome = _typed(action)
        row(consumer, entry, "the sealed bundle's fixture-tree.tar", "BUNDLE_INVALID (writable layer: LAYER_INVALID ...)", case, outcome,
            expected, {"bundle_bytes_changed": int(_tree_digest(bundle) != before)}, zero=("bundle_bytes_changed",), raw=current, binding=binding)
    def verified_bound(bundle):
        verified = cp.verify_bundle(bundle)
        current, binding = _layer_digests(bundle)
        cp.require(verified.capture.layer_sha256 == binding == current == cp.sha256(verified.capture.layer_raw), "ORACLE",
                   "the verified record is not the bound bytes")
    normal_bundle, _ = orthanc_capture(test)
    tar("verify_bundle (tar adapter)", "ops_release_checkpoints.verify_bundle", normal_bundle, normal_case, "ACCEPTED",
        lambda: verified_bound(normal_bundle))
    stale_bundle, _ = orthanc_capture(test)
    swapped_layer(stale_bundle)
    tar("verify_bundle (tar adapter)", "ops_release_checkpoints.verify_bundle", stale_bundle, stale_case, "BUNDLE_INVALID",
        lambda: cp.verify_bundle(stale_bundle))
    resealed = rebound_archive(stale_bundle)
    tar("verify_bundle (tar adapter)", "ops_release_checkpoints.verify_bundle", resealed,
        "raw changed, the archive's member hash rebound and the layer binding not updated", "BUNDLE_INVALID", lambda: cp.verify_bundle(resealed))
    contradicted = r8_bundle(test, contradiction)
    tar("verify_bundle (tar adapter)", "ops_release_checkpoints.verify_bundle", contradicted, rebound_case, "BUNDLE_INVALID",
        lambda: cp.verify_bundle(contradicted))
    malformed_bundles = {case: r8_bundle(test, change) for case, change in malformed.items()}
    for case, bundle in malformed_bundles.items():
        tar("verify_bundle (tar adapter)", "ops_release_checkpoints.verify_bundle", bundle, case, "BUNDLE_INVALID",
            lambda bundle=bundle: cp.verify_bundle(bundle))
    any_malformed = next(iter(malformed_bundles.values()))
    for consumer, entry, action in (("load_bundle", "ops_release_checkpoints.load_bundle", cp.load_bundle),
                                    ("BundleStore.load", "ops_release_checkpoints.BundleStore.load",
                                     lambda bundle: cp.BundleStore(Path(bundle).parent).load(Path(bundle).name))):
        tar(consumer, entry, normal_bundle, normal_case, "ACCEPTED", lambda action=action: action(normal_bundle))
        tar(consumer, entry, any_malformed, next(iter(malformed)), "BUNDLE_INVALID", lambda action=action: action(any_malformed))

    # 3. The raw-records adapter: leaf_index -> evidence_index -> raw_contract -> observation_reasons -> layer_valid, and its CLI.
    def index_row(consumer, entry, proof, case, expected, result, side):
        current, binding = _raw_layer_digests(proof)
        row(consumer, entry, "the leaf's raw records (evidence root) and its sealed manifest", "UNVERIFIED with a non-empty reason, never BOUND",
            case, result, expected, side, zero=("bound_index_written",) if expected != "BOUND" else (), raw=current, binding=binding)

    def cli_index(proof, run_dir, case, expected):
        """The index CLI over the same attempt: its exit (0 BOUND, 1 UNVERIFIED; a traceback is an EXCEPTION row)."""
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            outcome = _typed(lambda: exits.append(cp.main(["index", "--registry", str(proof.root / "registry.json"), "--unit", proof.unit,
                                                           "--proof-root", str(proof.root), "--run-dir", str(run_dir)])))
        result = {0: "BOUND: exit 0", 1: "UNVERIFIED: exit 1"}.get(exits[-1], "exit %s" % exits[-1]) if outcome == "ACCEPTED" else outcome
        index_row("index CLI", "tests/ops_release_checkpoints.py index", proof, case, expected, result,
                  {"bound_index_written": int((proof.root / "index" / (proof.unit + ".json")).exists())})
    exits = []
    proof, run_dir, index = o7_index(test)
    index_row("leaf_index (raw-records adapter)", "ops_release_checkpoints.leaf_index", proof, normal_case, "BOUND",
              index["verdict"] + ": " + json.dumps(index["reasons"]), {"bound_index_written": 0})
    cli_index(proof, run_dir, normal_case, "BOUND")
    found = next(proof.evidence.rglob(cp.LAYER_FILE))
    found.write_bytes(found.read_bytes().replace(b'"absent":false', b'"absent":true', 1))
    stale = cp.leaf_index(proof.leaves, proof.unit, proof.root, run_dir)
    index_row("leaf_index (raw-records adapter)", "ops_release_checkpoints.leaf_index", proof, stale_case, "UNVERIFIED",
              stale["verdict"] + ": " + json.dumps(stale["reasons"]), {"bound_index_written": 0})
    for case, change in ((rebound_case, contradiction), *malformed.items()):
        proof, run_dir, index = o7_index(test, change)
        index_row("leaf_index (raw-records adapter)", "ops_release_checkpoints.leaf_index", proof, case, "UNVERIFIED",
                  index["verdict"] + ": " + json.dumps(index["reasons"]), {"bound_index_written": 0})
        cli_index(proof, run_dir, case, "UNVERIFIED")

    # 4. A stored BOUND index at every consumption (bound_index -> rejudged_reasons), parent issuance and the request CLI.
    root = test.tempdir("kin-proof-")
    unit, child = "release-tools-checkpoints-proof-prefix-introduce", "release-tools-checkpoints-proof-late-resume"
    proof, run_dir, index = o7_index(test, unit=unit, root=root)
    cp.write_index(root, index)
    (root / "b.source-manifest.json").write_bytes(cp.canonical({"root": str(root / "b")}) + b"\n")
    for attempt in (1, 2):
        row("bound_index (a stored BOUND index)", "ops_release_checkpoints.bound_index", "the index, its raw records and sealed manifest",
            "PARENT_UNBOUND re-judged from the current bytes", normal_case + " (consumption %d)" % attempt, _typed(lambda: cp.bound_index(root, unit)),
            "ACCEPTED", {}, raw=_raw_layer_digests(proof)[0], binding=_raw_layer_digests(proof)[1])
    request_path = cp.attempt_paths(root, child, 1)["request"]
    row("resolve_parent / leaf_request", "ops_release_checkpoints.leaf_request", "the parent leaf's BOUND index and bundle",
        "PARENT_UNBOUND, no request", normal_case, _typed(lambda: cp.require(cp.leaf_request(proof.leaves, child, root)["parent_manifest"] is not None,
                                                                             "ORACLE", "no parent")), "ACCEPTED", {})
    with contextlib.redirect_stdout(io.StringIO()):
        code = cp.main(["request", "--registry", str(root / "registry.json"), "--unit", child, "--proof-root", str(root), "--out", str(request_path)])
    row("request CLI", "tests/ops_release_checkpoints.py request", "the parent leaf's BOUND index and bundle", "exit 2 CHECKPOINT_REFUSED, no request file",
        normal_case, "ACCEPTED: exit %d" % code if code == 0 else "exit %d" % code, "ACCEPTED", {"request_files": int(request_path.exists())})
    found = next(proof.evidence.rglob(cp.LAYER_FILE))
    kept = found.read_bytes()
    found.write_bytes(kept.replace(b'"absent":false', b'"absent":true', 1))
    row("bound_index (a stored BOUND index)", "ops_release_checkpoints.bound_index", "the index, its raw records and sealed manifest",
        "PARENT_UNBOUND re-judged from the current bytes", stale_case, _typed(lambda: cp.bound_index(root, unit)), "PARENT_UNBOUND", {},
        raw=_raw_layer_digests(proof)[0], binding=_raw_layer_digests(proof)[1])
    found.write_bytes(kept)
    tree = Path(proof.results["checkpoint"]["path"]) / "payload" / "fixture-tree.tar"
    tree_bytes = tree.read_bytes()
    tree.write_bytes(tree_bytes[:-1] + bytes([tree_bytes[-1] ^ 1]))
    row("resolve_parent / leaf_request", "ops_release_checkpoints.resolve_parent", "the parent leaf's BOUND index and bundle",
        "PARENT_UNBOUND, no request", "the parent bundle damaged after its index", _typed(lambda: cp.resolve_parent(proof.leaves, child, root)),
        "PARENT_UNBOUND", {})
    tree.write_bytes(tree_bytes)
    for case, change in ((rebound_case, contradiction), *malformed.items()):
        forged_root, forged = forged_parent(test, change)
        digests = _raw_layer_digests(forged)
        row("bound_index (a stored BOUND index)", "ops_release_checkpoints.bound_index", "a BOUND index 0535bc8 wrote over this evidence",
            "PARENT_UNBOUND re-judged from the current bytes", case, _typed(lambda: cp.bound_index(forged_root, forged.unit)), "PARENT_UNBOUND", {},
            raw=digests[0], binding=digests[1])
        row("resolve_parent / leaf_request", "ops_release_checkpoints.leaf_request", "a BOUND index 0535bc8 wrote over this evidence",
            "PARENT_UNBOUND, no request", case, _typed(lambda: cp.leaf_request(forged.leaves, child, forged_root)), "PARENT_UNBOUND", {},
            raw=digests[0], binding=digests[1])
        out = cp.attempt_paths(forged_root, child, 1)["request"]
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            code = cp.main(["request", "--registry", str(forged_root / "registry.json"), "--unit", child, "--proof-root", str(forged_root),
                            "--out", str(out)])
        row("request CLI", "tests/ops_release_checkpoints.py request", "a BOUND index 0535bc8 wrote over this evidence",
            "exit 2 CHECKPOINT_REFUSED, no request file", case, "PARENT_UNBOUND: exit %d" % code if code == 2 else "exit %d" % code,
            "PARENT_UNBOUND", {"request_files": int(out.exists())}, zero=("request_files",), raw=digests[0], binding=digests[1])

    # 5. The live leaf's admission of a stored request (live_test.py segment: load_request, bind_marker, cp.load_bundle at the
    # parent, then bundle_inputs and parent_chain before the first host observation).
    admission_bundles = {normal_case: orthanc_capture(test)[0]}
    admission_bundles[stale_case] = orthanc_capture(test)[0]
    swapped_layer(admission_bundles[stale_case])
    admission_bundles[rebound_case] = r8_bundle(test, contradiction)
    admission_bundles.update({case: r8_bundle(test, change) for case, change in malformed.items()})
    for case, bundle in admission_bundles.items():
        result = live_admission(test, bundle)
        current, binding = _layer_digests(bundle)
        row("live leaf admission (CheckpointSegments.segment)", "tests/ops_release_checkpoints_live_test.py CheckpointSegments.segment",
            "the stored request's parent bundle", "BUNDLE_INVALID before any host observation, restore, create or product phase", case,
            result["outcome"], "SYNTHETIC_TRANSPORT_END" if case == normal_case else "BUNDLE_INVALID",
            {key: int(result[key]) for key in ("load_bundle", "host_facts", "restore_boundary", "fixture_root_created", "bundle_changed")},
            zero=("restore_boundary", "fixture_root_created", "bundle_changed") + (("host_facts",) if case != normal_case else ()),
            raw=current, binding=binding, note="host and runtime observations synthetic; the parent loader, request and marker real")

    # 6. The restore entries: restore_checkpoint (FakeBackend) and the live wrapper restore_boundary (synthetic transport).
    restore_bundles = {normal_case: orthanc_capture(test)[0]}
    restore_bundles[stale_case] = orthanc_capture(test)[0]
    swapped_layer(restore_bundles[stale_case])
    restore_bundles[rebound_case] = r8_bundle(test, contradiction)
    restore_bundles.update({case: r8_bundle(test, change) for case, change in malformed.items()})
    for case, bundle in restore_bundles.items():
        current, binding = _layer_digests(bundle)
        result = o7_restore(test, bundle)
        row("restore_checkpoint", "ops_release_checkpoints.restore_checkpoint", "the bundle's current bytes (verify_bundle)",
            "BUNDLE_INVALID before any image, daemon, fixture or product call", case, result["outcome"],
            "ACCEPTED" if case == normal_case else "BUNDLE_INVALID",
            {"daemon_calls": result["daemon_calls"], "fixture_root_created": int(result["fixture_root_created"])},
            zero=() if case == normal_case else ("daemon_calls", "fixture_root_created"), raw=current, binding=binding)
    for case in (normal_case, next(iter(malformed))):
        bundle = restore_bundles[case] if case == normal_case else r8_bundle(test, malformed[case])
        current, binding = _layer_digests(bundle)
        result = restore_wrapper(test, bundle)
        row("restore_boundary (live wrapper)", "tests/ops_release_checkpoints_live_test.py restore_boundary", "the bundle's current bytes",
            "BUNDLE_INVALID before any daemon call", case, result["outcome"], "ACCEPTED" if case == normal_case else "BUNDLE_INVALID",
            {"daemon_mutations": result["daemon_mutations"], "fixture_root_created": int(result["fixture_root_created"])},
            zero=() if case == normal_case else ("daemon_mutations", "fixture_root_created"), raw=current, binding=binding,
            note="CheckpointDocker replaced by a synthetic transport; restore_checkpoint and verify_bundle real")

    # 7. The native success evidence: Smoke.regenerated (A05/A12) and the roundtrip's rows (A08/A03/A01).
    for case, result in native_contrast(test).items():
        refused = not case.startswith(("control", "a stale descriptor", "a legal new seal"))
        row("Smoke.regenerated (native A05/A12)", "tests/ops_release_checkpoints_native_test.py Smoke.regenerated",
            "the bundle, verified at the start of the call", "BUNDLE_INVALID before any A05/A12 row; only the verified record and descriptor recorded",
            case, result["outcome"], "BUNDLE_INVALID" if refused else "ACCEPTED",
            {"a05_a12_pass_rows": result["a05_a12_pass_rows"], "raw_files": len(result["raw_files"])},
            zero=("a05_a12_pass_rows", "raw_files") if refused else (), raw=result.get("current_layer_sha256") or result.get("emitted_layer_sha256"),
            binding=result.get("bound_layer_sha256"),
            note=None if refused else "emitted descriptor %s / the record's %s" % (result.get("emitted_descriptor_sha256"), result.get("record_descriptor_sha256")))
    marker_bundle, _ = orthanc_capture(test)
    smoke = native.Smoke(test.tempdir("kin-r8-native-"))
    smoke.private = test.tempdir("kin-r8-private-")
    row("Smoke.sealed_markers (native A03/A01)", "tests/ops_release_checkpoints_native_test.py Smoke.sealed_markers",
        "the bundle's volume exports, verified", "BUNDLE_INVALID before a listing", normal_case,
        _typed(lambda: smoke.sealed_markers(cp.verify_bundle(marker_bundle))), "ACCEPTED", {})
    checked = cp.verify_bundle(marker_bundle)
    volume = checked.manifest["owned"]["volumes"]["pg"]["member"]
    (marker_bundle / "payload" / volume).write_bytes(volume_tar("pg", extra=[("./kin-r8-extra", tarfile.REGTYPE, b"x\n")]))
    row("Smoke.sealed_markers (native A03/A01)", "tests/ops_release_checkpoints_native_test.py Smoke.sealed_markers",
        "the bundle's volume exports, verified", "BUNDLE_INVALID before a listing", "a volume export changed after its verification",
        _typed(lambda: smoke.sealed_markers(checked)), "BUNDLE_INVALID", {})
    for case in (stale_case, "the manifest argument not the bundle's (a stale copy)"):
        stale_bundle, descriptor = orthanc_capture(test)
        held = sealed_of(stale_bundle, descriptor)
        if case == stale_case:
            swapped_layer(stale_bundle)
        else:
            held["manifest"]["owned"].update(networks=[{"name": "kin-r8-stale"}])
        evidence = test.tempdir("kin-r8-native-")
        roundtrip = native.Smoke(evidence)
        outcome = _typed(lambda: roundtrip.roundtrip(None, "introduced", held, all_running=True))
        log = evidence / "smoke-log.jsonl"
        row("Smoke.roundtrip (native A08/A03/A11/N05/A04/A12)", "tests/ops_release_checkpoints_native_test.py Smoke.roundtrip",
            "the bundle, verified at the start of the call", "BUNDLE_INVALID before any row", case, outcome, "BUNDLE_INVALID",
            {"check_rows": len(log.read_bytes().splitlines()) if log.exists() else 0}, zero=("check_rows",),
            note="the normal roundtrip runs on real Docker in the CI native smoke only")

    # 8. The T16 comparison over BOUND indexes (bundle-less leaves) and its CLI.
    records = CheckpointRecordTests(methodName="test_existing_record_run_binds_exact_inputs_outputs_and_exit")
    records.tempdir = test.tempdir
    compare_root, (fork, fresh) = records.bound_pair()
    for case in (normal_case, stale_case):
        if case == stale_case:
            next(fork.evidence.rglob("journal.jsonl")).write_bytes(b"{}\n")
        result = cp.t16_comparison(fork.leaves, compare_root)
        with contextlib.redirect_stdout(io.StringIO()):
            code = cp.main(["compare", "--registry", str(compare_root / "registry.json"), "--proof-root", str(compare_root)])
        row("t16_comparison / compare CLI", "ops_release_checkpoints.t16_comparison; tests/ops_release_checkpoints.py compare",
            "the late-resume and fresh-control BOUND indexes (no bundle sealed by either)", "t16_pass false and exit 1 on a refused consumption", case,
            "t16_pass=%s exit %d" % (result["t16_pass"], code), "t16_pass=True exit 0" if case == normal_case else "t16_pass=False exit 1", {})

    # 9a. No layer is required where none exists (R8-02; D1550 (d)): a source-b0 bundle (no volumes, no writable layer)
    # verifies with no capture and restores; a leaf sealing source-b0 indexes BOUND; leaves that seal nothing (the
    # late-resume fork, which consumes a volume checkpoint through its restore observation, and the fresh control) stay
    # BOUND at every consumption.
    no_layer = "no writable layer exists here (no new requirement)"
    fixture = test.tempdir("kin-r8-source-")
    source_bundle = bundle_from(test, fixture, realistic(fixture, "source-b0"), "source-b0")
    row("verify_bundle (tar adapter)", "ops_release_checkpoints.verify_bundle", "a source-b0 bundle (no volume checkpoint)", "accepted, capture None",
        no_layer + ": source-b0", _typed(lambda: cp.require(cp.verify_bundle(source_bundle).capture is None and "layer" not in
                                                            json.loads((source_bundle / "manifest.json").read_bytes())["bindings"],
                                                            "ORACLE", "a layer appeared")), "ACCEPTED", {})
    result = o7_restore(test, source_bundle)
    row("restore_checkpoint", "ops_release_checkpoints.restore_checkpoint", "a source-b0 bundle (no volume checkpoint)", "accepted", no_layer + ": source-b0",
        result["outcome"], "ACCEPTED", {"daemon_calls": result["daemon_calls"], "fixture_root_created": int(result["fixture_root_created"])})
    proof, run_dir, index = o7_index(test, unit="release-tools-checkpoints-proof-prefix-source")
    row("leaf_index (raw-records adapter)", "ops_release_checkpoints.leaf_index", "the prefix-source leaf's raw records (it seals source-b0)",
        "BOUND without a layer", no_layer + ": a leaf sealing source-b0", index["verdict"] + ": " + json.dumps(index["reasons"]), "BOUND", {})
    pair_root, pair = records.bound_pair()
    for leaf in pair:
        row("bound_index (a stored BOUND index)", "ops_release_checkpoints.bound_index", "a BOUND index of a leaf that seals no bundle",
            "accepted at every consumption", no_layer + ": " + leaf.unit, _typed(lambda leaf=leaf: cp.bound_index(pair_root, leaf.unit)),
            "ACCEPTED", {})

    # 9. Diagnostics and generation inputs (never an admission or a BOUND by themselves).
    diagnostic = next(iter(malformed_bundles.values()))
    manifest = json.loads((diagnostic / "manifest.json").read_bytes())
    row("parent_chain", "ops_release_checkpoints.parent_chain", "manifests by name", "lineage listing only", "over a malformed bundle",
        _typed(lambda: cp.parent_chain(diagnostic.parent, diagnostic.name)), "ACCEPTED", {}, classification="diagnostic",
        note="the live leaf calls it after cp.load_bundle admitted the parent (row 5)")
    row("bundle_inputs", "ops_release_checkpoints.bundle_inputs", "the fixture member's plan/target/B0 bytes", "input recomputation only",
        "over a malformed bundle", _typed(lambda: cp.bundle_inputs(manifest, diagnostic)), "ACCEPTED", {}, classification="diagnostic",
        note="its callers verify the bundle as well: the live leaf before it, restore_checkpoint before any daemon call (rows 5, 6)")
    request_file = test.tempdir("kin-r8-parent-") / "request.json"
    request_file.write_bytes(cp.canonical({"parent_manifest": {"path": str(diagnostic / "manifest.json"), "sha256": diagnostic.name}}) + b"\n")
    with contextlib.redirect_stdout(io.StringIO()) as printed:
        code = cp.main(["parent-manifest", "--request", str(request_file)])
    row("parent-manifest CLI", "tests/ops_release_checkpoints.py parent-manifest", "a request file", "the parent's path only", "over a malformed bundle",
        "ACCEPTED" if code == 0 and printed.getvalue().strip() == str(diagnostic / "manifest.json") else "exit %d" % code, "ACCEPTED", {},
        classification="diagnostic", note="proof.sh passes this path to the leaf, whose admission loads it (row 5)")
    for name, entry, note in (("Smoke.negative (native N05/A05)", "tests/ops_release_checkpoints_native_test.py Smoke.negative",
                               "keeps a REFUSED record's raw (CI native smoke only); no ACCEPTED judgement"),
                              ("bound_descriptor (capture generation input)", "ops_release_checkpoints.bound_descriptor",
                               "the descriptor a capture judges against, before its record exists; that record is judged by fixture_layer (row 1)"),
                              ("Smoke.observed / Smoke.tampered (native A06/A07/N04)", "tests/ops_release_checkpoints_native_test.py",
                               "live observation folders judged by observation_valid itself; no bundle, layer or BOUND read")):
        row(name, entry, "-", "-", "classification", "NOT A SUCCESS CONSUMER", "NOT A SUCCESS CONSUMER", {}, classification="diagnostic", note=note)
    return rows


class CheckpointVerifiedCaptureTests(CaptureFixture, RefusalAssertions, TempCase):
    """r8 CKPT7-01/02 (consult-checkpoints-r8-20261017 r8_acceptance R8-02..R8-05): the writable-layer judgement is one call
    over the current bytes and the seal's bindings that returns what it verified (VerifiedCapture, VerifiedBundle); the
    native smoke records nothing else; a malformed field is each consumer's typed refusal; every real consumer runs
    against it. Assertions name the requirement (CKPT8_*); no message text is pinned."""

    def test_one_call_checks_the_current_bytes_against_the_bindings_and_returns_them(self):
        """R8-02 (M55): the judgement checks the record's bytes against the seal's layer binding and the state S against its
        binding in the same call and judges exactly those bytes; a record the contract accepts but whose binding names
        other bytes is refused; the returned value carries the bytes, identifiers and digests and shares nothing with a
        caller; the fixture adapter refuses before store.begin."""
        final, _ = orthanc_capture(self)
        manifest = json.loads((final / "manifest.json").read_bytes())
        verified = self.admitted(cp.verify_bundle, final)
        capture, bindings = verified.capture, manifest["bindings"]
        self.assertEqual((capture.checkpoint, capture.layer_path, capture.layer_sha256, cp.sha256(capture.layer_raw)),
                         ("introduced", bindings["layer"]["path"], bindings["layer"]["sha256"], bindings["layer"]["sha256"]), "CKPT8_VERIFIED_BYTES_RETURNED")
        self.assertEqual((capture.observation_path, capture.observation_sha256, capture.state_sha256),
                         (bindings["observation"]["path"], bindings["observation"]["sha256"], bindings["state"]["sha256"]), "CKPT8_VERIFIED_BYTES_RETURNED")
        self.assertEqual((capture.descriptor_sha256, cp.sha256(capture.descriptor_raw)), (capture.layer["descriptor_sha256"],) * 2,
                         "CKPT8_VERIFIED_DESCRIPTOR_IS_THE_RECORD_S")
        record, copy_of_manifest, descriptor = capture.layer, verified.manifest, capture.descriptor
        record["roles"].clear()
        copy_of_manifest["bindings"].clear()
        descriptor.clear()
        # Digests only in the assertion (no large objects): each read is a new parse of the verified bytes.
        self.assertEqual((sorted(capture.layer["roles"]), cp.sha256(cp.canonical(verified.manifest) + b"\n"),
                          cp.sha256(cp.canonical(capture.descriptor) + b"\n")),
                         (sorted(intro.ROLES), final.name, capture.descriptor_sha256), "CKPT8_NO_SHARED_MUTABLE_VALUE")
        raw, arguments = _bundle_arguments(final)
        self.assertEqual(self.admitted(cp.layer_valid, raw, **arguments), capture, "CKPT8_ONE_CALL_SAME_VALUE")
        # The same record with an accepted transient change: the contract accepts it with its binding rebound, and refuses it
        # while the binding still names the sealed bytes (CKPT7-01's record, judged directly).
        document = json.loads(raw)
        substitute_api_change(document)
        changed = cp.canonical(document) + b"\n"
        self.admitted(cp.layer_valid, changed, **{**arguments, "layer_binding": {**arguments["layer_binding"], "sha256": cp.sha256(changed)}})
        error = self.assertRefused("LAYER_INVALID", cp.layer_valid, changed, **arguments)
        self.assertIn("layer binding", str(error), "CKPT8_LAYER_BINDING_CHECKED_IN_THE_SAME_CALL")
        error = self.assertRefused("LAYER_INVALID", cp.layer_valid, raw, **{**arguments, "state_raw": arguments["state_raw"] + b" "})
        self.assertIn("state binding", str(error), "CKPT8_STATE_BINDING_CHECKED_IN_THE_SAME_CALL")
        for name, binding in (("a binding not beside the capture observation",
                               {**arguments["layer_binding"], "path": arguments["layer_binding"]["path"].replace(capture.request_sha256[:16], "0" * 16)}),
                              ("no layer binding", None)):
            with self.subTest(binding=name):
                self.assertRefused("LAYER_INVALID", cp.layer_valid, raw, **{**arguments, "layer_binding": binding})
        self.assertRefused("LAYER_INVALID", cp.layer_valid, raw, **{**arguments, "state_binding": {**arguments["state_binding"],
                                                                                                  "path": "other/records/state.json"}})
        # The fixture adapter: S changed after its binding was taken refuses the capture before store.begin, its record kept.
        target = target_fixture()
        names = {role: target["containers"][role] for role in intro.ROLES}
        descriptor = regenerated_fixture("id-" + names["orthanc"])
        backend = FakeBackend(names, {**target["volumes"], "proxy_certs": PROJECT + "_proxy-certs"})
        backend.diffs[names["orthanc"]] = list(ORTHANC_START)
        backend.layers[names["orthanc"]] = start_facts(descriptor)
        fixture, store_root = self.tempdir(), self.tempdir() / "bundles"

        def touch_state(root, made):
            path = root / made.bindings["state"]["path"]
            path.write_bytes(path.read_bytes() + b" ")
        error = self.assertRefused("LAYER_INVALID", self.captured, "introduced", backend, descriptor=descriptor, fixture=fixture,
                                   store_root=store_root, before=touch_state)
        self.assertIn("state binding", str(error), "CKPT8_FIXTURE_ADAPTER_BINDS")
        self.assertEqual((sorted(path.name for path in store_root.iterdir()), [call for call in backend.calls if call[0] == "export"]), ([], []),
                         "CKPT8_REFUSED_BEFORE_STORE_BEGIN")

    def test_the_native_regenerated_evidence_comes_only_from_the_verified_bundle(self):
        """R8-03 (M56): the real Smoke.regenerated accepts a normal capture and a legal new seal, records only the verified
        record and descriptor (a stale descriptor argument never reaches the evidence; the emitted descriptor is the one
        the record's binding names), and refuses a raw changed after a normal load with no hash updated, and rebound
        contradiction or malformed bundles, before any A05/A12 row."""
        rows = native_contrast(self)
        for name, result in rows.items():
            with self.subTest(case=name):
                if name in ("control", "a stale descriptor argument", "a legal new seal of the same change"):
                    self.assertEqual((result["outcome"], result["a05_a12_pass_rows"]), ("ACCEPTED", 1), "CKPT8_NATIVE_CONTROL_ACCEPTED: " + json.dumps(result))
                    self.assertEqual(result["emitted_descriptor_sha256"], result["record_descriptor_sha256"],
                                     "CKPT8_NATIVE_DESCRIPTOR_IS_THE_VERIFIED_ONE: " + json.dumps(result))
                    self.assertEqual(result["emitted_layer_sha256"], result["bound_layer_sha256"], "CKPT8_NATIVE_RECORD_IS_THE_BOUND_ONE")
                else:
                    self.assertTrue(result["outcome"].startswith("BUNDLE_INVALID: "), "CKPT8_NATIVE_REFUSED_TYPED: " + json.dumps(result))
                    self.assertEqual((result["a05_a12_pass_rows"], result["check_rows"], result["raw_files"]), (0, 0, []),
                                     "CKPT8_NO_NATIVE_SUCCESS_RECORD: " + json.dumps(result))
        swap = rows["a raw swap after a normal load (no hash updated)"]
        self.assertNotEqual(swap["bound_layer_sha256"], swap["current_layer_sha256"], "the contrast changed the raw")
        stale = rows["a stale descriptor argument"]
        self.assertNotEqual(stale["argument_descriptor_sha256"], stale["emitted_descriptor_sha256"], "CKPT8_STALE_ARGUMENT_NOT_EMITTED")

    def test_the_declared_fields_are_typed_refusals_at_the_judgement(self):
        """R8-04 (M57): every declared field of the closed layer schema, every field of the context and binding boundary
        the judgement reads and the bound snapshot rows, as missing/null/bool/number/string/array/object/empty and as their
        normal value (every other hash rebound): the normal values and the contract's own alternatives are accepted, every
        other cell is LAYER_INVALID - never a TypeError or another exception (fact.type a list or an object included)."""
        rows = typed_refusal_table(self)
        self.assertGreater(len(rows), 800, "the finite table")
        for name, row in rows.items():
            with self.subTest(cell=name):
                self.assertEqual(row["outcome"] if row["outcome"] == "ACCEPTED" else row["outcome"].split(":", 1)[0], row["expected"],
                                 "CKPT8_TYPED_REFUSAL: " + row["outcome"])
        for kind in ("array", "object"):
            self.assertEqual(rows["record roles > orthanc > facts > /etc/hostid > type = " + kind]["outcome"].split(":", 1)[0], "LAYER_INVALID",
                             "CKPT8_FACT_TYPE_TYPED (CKPT7-02)")

    def test_a_malformed_fact_is_each_consumer_s_typed_refusal(self):
        """R8-04 through the adapters: fact.type a list or an object with the hashes rebound is BUNDLE_INVALID at load_bundle
        and before a restore (no daemon call, no fixture root), UNVERIFIED with the layer reason in the index,
        PARENT_UNBOUND with it at a stored BOUND index's consumption and parent issuance, and no native success record; a
        mistyped descriptor field leaves a normal Orthanc start the capture's typed refusal before store.begin; and (D1556
        SRCK8-1, M58) a mistyped context.b0, context.stacks or state.b0 of a bundle the loader accepts (source-b0,
        introduced) is BUNDLE_INPUT_MISMATCH at restore_checkpoint, restore_boundary and the live leaf's admission, before
        any daemon call, host observation, restore or fixture root."""
        for name, row in typed_refusal_adapters(self).items():
            with self.subTest(cell=name):
                outcome = row.get("outcome", "")
                if row["expected"] in ("ACCEPTED", "SYNTHETIC_TRANSPORT_END"):
                    self.assertTrue(outcome.startswith(row["expected"]), "CKPT8_NORMAL_ACCEPTED: " + json.dumps(row))
                    continue
                self.assertIn(outcome.split(":", 1)[0], row["expected"].split("|"), "CKPT8_TYPED_REFUSAL: " + outcome)
                if "cause" in row:
                    self.assertIn(row["cause"], outcome, "CKPT8_REFUSAL_KEEPS_ITS_CAUSE: " + outcome)
                for key in ("daemon_calls", "daemon_mutations", "host_facts", "restore_boundary", "a05_a12_pass_rows"):
                    if key in row:
                        self.assertEqual(row[key], 0, "CKPT8_REFUSED_BEFORE_ANY_EFFECT: " + key + ": " + json.dumps(row))
                for key in ("fixture_root_created", "bundle_changed"):
                    if key in row:
                        self.assertIs(row[key], False, "CKPT8_REFUSED_BEFORE_ANY_EFFECT: " + key + ": " + json.dumps(row))
                if "raw_files" in row:
                    self.assertEqual(row["raw_files"], [], "CKPT8_NO_NATIVE_SUCCESS_RECORD")

    def test_every_consumer_entry_point_runs_against_the_verified_boundary(self):
        """R8-05: the executed consumer inventory (consumer_inventory): each row's real entry point gave its contract's
        result for its case, a refusal left the side effects it names at 0, every raw adapter ran its normal, stale,
        rebound-contradiction and malformed-fact cases, and no layer is required of a source-b0 bundle or of a leaf that
        seals none (no new false refusal)."""
        rows = consumer_inventory(self)
        for item in rows:
            with self.subTest(consumer=item["consumer"], case=item["case"]):
                self.assertTrue(item["result"].startswith(item["expected"]), "CKPT8_CONSUMER_RESULT: " + json.dumps(item))
                self.assertEqual({key: item["side_effects"].get(key) for key in item["zero"]}, {key: 0 for key in item["zero"]},
                                 "CKPT8_NO_SIDE_EFFECT_ON_REFUSAL: " + json.dumps(item))
        for adapter in ("capture_checkpoint (fixture adapter)", "verify_bundle (tar adapter)", "leaf_index (raw-records adapter)"):
            cases = [item["case"] for item in rows if item["consumer"] == adapter]
            self.assertTrue(len(cases) >= 4 and "normal" in cases and any("hash not updated" in case for case in cases)
                            and any("contradiction" in case for case in cases) and any("malformed" in case for case in cases),
                            "CKPT8_RAW_ADAPTER_CASES: " + adapter + ": " + json.dumps(cases))
        no_layer = [item for item in rows if item["case"].startswith("no writable layer exists here")]
        self.assertEqual((len(no_layer), sorted({item["result"].split(":", 1)[0] for item in no_layer})), (5, ["ACCEPTED", "BOUND"]),
                         "CKPT8_NO_NEW_LAYER_REQUIREMENT: " + json.dumps(no_layer))


# ── r9 (D1575, Astra r8 delta CKPT8-1/2): every JSON read on the admission and restore paths is a typed refusal ──
# Each read of a manifest, identity, context, state, plan, target, parent, segment or BOUND-index field reached by load_bundle /
# verify_bundle, bundle_inputs, restore_checkpoint, restore_boundary, the live leaf's stored-request admission (prefix-seed,
# prefix-verify, through the real admit_resume), parent_chain and resolve_parent/leaf_request is substituted with [], {},
# a string and an integer (hashes and the bundle name rebound, sequential, no concurrent swap) and run through the real
# caller: a substitution of another JSON type than the field's is each caller's typed refusal with no effect, and no
# substitution raises. The helpers use only entry points a9f9b69 has as well (its red run is kept apart).
R9_SUBSTITUTIONS = (("[]", []), ("{}", {}), ("str", "x"), ("int", 7))
R9_MANIFEST_FIELDS = (("checkpoint",), ("schema",), ("kind",), ("lineage",), ("execution_kind",), ("fresh_e2e",), ("release_gate_eligible",),
                      ("derived",), ("parent",), ("members",), ("absent",), ("bindings",), ("bindings", "context"), ("bindings", "state"),
                      ("boundary",), ("boundary", "window_end"), ("boundary", "tls_not_after"), ("owned",), ("owned", "token"),
                      ("owned", "projects"), ("owned", "volumes"), ("owned", "networks"), ("owned", "stack"), ("owned", "stack", "root"),
                      ("owned", "stack", "containers"), ("identity",), ("identity", "phase_reached"), ("identity", "image_ids"),
                      ("identity", "created_utc"), ("identity", "runtime_identity"), ("identity", "absolute_fixture_root"),
                      ("identity", "host_key_sha256"), ("identity", "daemon_identity"), ("identity", "tool_tree_sha256_at_checkpoint"),
                      ("identity", "payload_manifest_sha256"), ("identity", "source_b0_manifest_sha256"), ("identity", "segment_source_map"),
                      ("identity", "tool_files_actual_raw_sha256"))
# Fixture-tree documents (realistic's tamper parts; the plan/target identity rebound so the field itself is read).
R9_TREE_FIELDS = (("context",), ("state",), ("context", "stacks"), ("context", "b0"), ("context", "copy_dir"), ("context", "images"), ("context", "stacks", "source"),
                  ("context", "stacks", "source", "plan_document"), ("context", "stacks", "source", "target"), ("context", "stacks", "source", "root"),
                  ("context", "stacks", "source", "plan_document", "previous"), ("context", "stacks", "source", "plan_document", "release"),
                  ("context", "stacks", "source", "plan_document", "tool"), ("context", "stacks", "source", "plan_document", "backup_root"),
                  ("context", "stacks", "source", "plan_document", "seed"), ("context", "stacks", "source", "target", "repository"),
                  ("context", "stacks", "source", "target", "ca_file"), ("context", "stacks", "source", "target", "compose_files"),
                  ("context", "stacks", "source", "target", "declared_overlays"), ("state", "b0"), ("state", "plan_sha256"), ("state", "status"))
R9_SEGMENT_FIELDS = (("results",), ("results", "checkpoint"), ("results", "checkpoint", "path"), ("results", "checkpoint", "manifest_sha256"))
# The parent leaf's BOUND index (bound_index and rejudged_reasons read these before the segment is trusted).
R9_INDEX_FIELDS = ((), ("run_dir",), ("logs",), ("raw",), ("raw", "evidence"), ("raw", "files"), ("raw", "admission"), ("raw", "checkpoint"),
                   ("segment",), ("segment_sha256",))
# What parent_chain (a lineage listing) reads of each link; it reads nothing else.
R9_CHAIN_READS = (("checkpoint",), ("execution_kind",), ("identity",), ("identity", "payload_manifest_sha256"), ("parent",))
R9_EFFECTS = ("admission_success", "restore_boundary", "daemon_calls", "daemon_mutations")


def _json_type(value):
    if value is R8_MISSING:
        return "MISSING-KEY"
    return {dict: "object", list: "array", str: "string", int: "integer", bool: "boolean", type(None): "null", float: "number"}[type(value)]


def _obj_or_none(value):
    return value if type(value) is dict else {}


def admission_bundle(test, checkpoint_id="source-b0", *, manifest_change=None, tamper=None):
    """A sealed bundle the live leaf can resume from (the seal fixture, a tool-tree member, its time window), with
    `tamper(parts)` applied to its fixture documents (the plan/target identity rebound) and `manifest_change(manifest)` to
    its manifest, the manifest's hashes and the bundle's name rebound. Returns the bundle folder."""
    stack_name = cp.LINEAGE_STACK[checkpoint_id]

    def coherent(parts):
        tamper(parts)
        descriptor = _obj_or_none(_obj_or_none(_obj_or_none(parts["context"]).get("stacks")).get(stack_name))
        if type(descriptor.get("plan_document")) is dict and type(descriptor.get("target")) is dict:
            descriptor["plan_document"]["target_manifest_sha256"] = hashlib.sha256(intro.canonical(descriptor["target"])).hexdigest()
            descriptor["plan_sha256"] = _obj_or_none(parts["state"])["plan_sha256"] = intro.plan_identity(descriptor["plan_document"])
        tamper(parts)   # again: a rebinding never undoes the substitution itself (state.plan_sha256)
    bundle = seal(test, test.tempdir() / "bundles", checkpoint_id, tamper=coherent if tamper else None)
    manifest = json.loads((bundle / "manifest.json").read_bytes())
    tool = raw_tar([])
    (bundle / "payload" / "tool-tree.tar").write_bytes(tool)
    manifest["members"] = sorted(manifest["members"] + [{"name": "tool-tree.tar", "category": "tool-tree", "sha256": cp.sha256(tool),
                                                         "bytes": len(tool)}], key=lambda member: member["name"])
    manifest["identity"]["payload_manifest_sha256"] = cp.sha256(cp.canonical(manifest["members"]))
    manifest["identity"]["tool_tree_sha256_at_checkpoint"] = cp.tree_manifest_from_bytes({})["sha256"]
    if tamper:
        context = json.loads(cp.tree_member_bytes(bundle / "payload" / "fixture-tree.tar", cp.CONTEXT_FILE))
        descriptor = _obj_or_none(_obj_or_none(_obj_or_none(context).get("stacks")).get(stack_name))
        if type(descriptor.get("plan_sha256")) is str:
            manifest["identity"]["plan_sha256"] = descriptor["plan_sha256"]
            manifest["identity"]["target_manifest_sha256"] = _obj_or_none(descriptor.get("plan_document")).get("target_manifest_sha256")
    now = datetime.now(timezone.utc)
    manifest["boundary"].update(window_end=(now + timedelta(days=1)).isoformat(), tls_not_after=(now + timedelta(days=2)).isoformat())
    if manifest_change is not None:
        manifest_change(manifest)
    raw = cp.canonical(manifest) + b"\n"
    renamed = bundle.parent / cp.sha256(raw)
    bundle.rename(renamed)
    (renamed / "manifest.json").write_bytes(raw)
    return renamed


def deep_admission(test, bundle, unit="release-tools-checkpoints-proof-prefix-seed", *, request_change=None):
    """The live leaf's stored-request admission (CheckpointSegments.segment) of `bundle` past the host observation and
    through the real admit_resume (a call-through spy that ends the run once it has returned, before any restore): the
    gate permission from gate.live_run in this test's own state folder; host, runtime, source, tool-tree (the bundle's
    empty tool tree, no Git listing of the running copy) and image observations answered synthetically from the recorded
    identity (they match it). Returns the outcome and the effect counters."""
    import ops_release_checkpoints_live_test as live
    bundle = Path(bundle)
    manifest = json.loads((bundle / "manifest.json").read_bytes())
    recorded = _obj_or_none(manifest.get("identity"))
    runtime, images = _obj_or_none(recorded.get("runtime_identity")), _obj_or_none(recorded.get("image_ids"))
    observed_runtime = {**runtime, "arch": identity_fixture()["runtime_identity"]["arch"]}
    source = {"tool": {"sha256": recorded.get("tool_tree_sha256_at_checkpoint")}, "source": {"sha256": recorded.get("source_tree_sha256")},
              "harness": {"sha256": recorded.get("harness_tree_sha256")}, "tool_files": recorded.get("tool_files_actual_raw_sha256")}
    leaf = cp.registry_leaf(list(cp.DEFAULT_PROOF_LEAVES), unit)
    folder, state = test.tempdir("kin-r9-request-"), test.tempdir("kin-r9-gate-")
    source_path = folder / "source.json"
    source_path.write_bytes(cp.canonical(source) + b"\n")
    request = {"schema": 1, **{key: leaf[key] for key in ("unit", "case", "scenario", "stage", "execution_kind")},
               "parent_manifest": {"path": str(bundle / "manifest.json"), "sha256": bundle.name},
               "source_manifest": {"path": str(source_path), "sha256": cp.sha256(source_path.read_bytes())},
               "output_root": str(bundle.parent.parent), "evidence_root": str(folder / "evidence")}
    request_path = folder / "request.json"
    if request_change is not None:
        request_change(request)
    request_path.write_bytes(cp.canonical(request) + b"\n")
    calls = {"host_reads": 0, "admit_resume": 0, "admission_success": 0, "restore_boundary": 0}
    facts = {"os": "linux", "docker_os": "Ubuntu 24.04 LTS", "daemon_ok": True, "daemon_identity": recorded.get("daemon_identity"),
             "available_ram_bytes": 12 * 1024 ** 3, "available_disk_bytes": 50 * 1024 ** 3, "required_disk_bytes": 20 * 1024 ** 3,
             "foreign_containers": [], "host_key_sha256": recorded.get("host_key_sha256"), "architecture": observed_runtime["arch"],
             "absolute_fixture_root": recorded.get("absolute_fixture_root"), "docker_endpoint": "unix:///var/run/docker.sock",
             "endpoint_selectors": [], "gate_state": str(state)}

    def host(*args, **kwargs):
        calls["host_reads"] += 1
        return dict(facts)
    real_admit = cp.admit_resume

    def admit(*args, **kwargs):
        calls["admit_resume"] += 1
        real_admit(*args, **kwargs)
        calls["admission_success"] += 1
        raise cp.Refused("SYNTHETIC_ADMISSION_END", "the real resume admission accepted; the run ends before any restore")

    def restore(*args, **kwargs):
        calls["restore_boundary"] += 1
        raise AssertionError("a restore")

    def docker_text(argv, *args, **kwargs):
        if list(argv[:3]) == ["docker", "context", "inspect"]:
            return "unix:///var/run/docker.sock"
        raise AssertionError("an unplanned transport call")
    before = _tree_digest(bundle)
    with patch.object(gate, "STATE", state), patch.dict(os.environ, {cp.REQUEST_ENV: str(request_path), "DOCKER_HOST": ""}), \
            patch.object(cp, "source_identity", lambda *args, **kwargs: copy.deepcopy(source)), \
            patch.object(cp, "runtime_identity", lambda *args, **kwargs: copy.deepcopy(observed_runtime)), \
            patch.object(live, "tool_tree_files", lambda root: {}), \
            patch.object(live.rehearsal.CheckpointDocker, "runtime_facts", staticmethod(lambda: {})), \
            patch.object(live.rehearsal.CheckpointDocker, "host_facts", staticmethod(host)), \
            patch.object(live.rehearsal.ops, "text", docker_text), \
            patch.object(live.CheckpointSegments, "image_id", lambda self, reference: images.get("helper")), \
            patch.object(live.CheckpointSegments, "rehearsal_images",
                         lambda self: {side: copy.deepcopy(images.get(side)) for side in ("previous", "release")}), \
            patch.object(cp, "admit_resume", admit), patch.object(live, "restore_boundary", restore):
        with gate.live_run(unit, cp.LIVE_FILE, "a" * 64, 1):   # the gate's own API, in this test's state folder
            outcome = _typed(lambda: live.CheckpointSegments(leaf["case"].split(".", 1)[1]).segment(leaf["stage"]))
    return {"outcome": outcome, **calls, "fixture_root_created": (bundle.parent.parent / "fixture").exists(),
            "bundle_changed": _tree_digest(bundle) != before}


def _r9_cell(path, value, normal, caller, result, *, read=True):
    """One substitution through one caller: its outcome, effects and verdict (a refusal of a mistyped value with no effect,
    never an exception; a value of the field's own JSON type may be accepted; `read=False`: the caller does not read the
    field - the loader binds a non-volume checkpoint's fixture documents by SHA-256 only - so it may accept it)."""
    outcome = result.get("outcome", "") if type(result) is dict else result
    effects = {key: result[key] for key in (*R9_EFFECTS, "fixture_root_created") if type(result) is dict and key in result}
    if type(result) is dict:
        effects.update(result.get("effects", {}))
    mistyped = _json_type(value) != _json_type(normal) or (path == ("parent",) and value is not None)
    refused = not outcome.startswith(("ACCEPTED", "SYNTHETIC_ADMISSION_END", "EXCEPTION"))
    if outcome.startswith("EXCEPTION"):
        verdict = "FAIL: exception"
    elif mistyped and not refused and not read:
        verdict = "PASS (not read by this caller)"
    elif mistyped and not refused:
        verdict = "FAIL: a mistyped value accepted"
    elif refused and any(effects.values()):
        verdict = "FAIL: effects after a refusal"
    else:
        verdict = "PASS"
    return {"field": ".".join(map(str, path)), "substitution": _json_type(value), "normal": _json_type(normal), "caller": caller,
            "outcome": outcome[:220], "effects": effects, "verdict": verdict}


def typed_reads_matrix(test, *, fields=None, include_tree=True, include_segment=True):
    """The r9 substitution matrix (see the section comment): manifest fields through load_bundle, restore_checkpoint,
    restore_boundary, the live leaf's admission (prefix-seed over source-b0; prefix-verify over introduced for the two
    named fields) and parent_chain (the fields it reads); fixture-tree documents through the same callers; the parent
    leaf's segment and BOUND-index fields through resolve_parent and leaf_request. Returns the cell rows."""
    rows = []
    base = json.loads((admission_bundle(test) / "manifest.json").read_bytes())
    for path in R9_MANIFEST_FIELDS if fields is None else fields:
        normal = _get(base, path)
        for name, value in R9_SUBSTITUTIONS:
            bundle = admission_bundle(test, manifest_change=lambda manifest, path=path, value=value: _put(manifest, path, value))
            rows.append(_r9_cell(path, value, normal, "load_bundle", _typed(lambda: cp.load_bundle(bundle))))
            rows.append(_r9_cell(path, value, normal, "restore_checkpoint", _row(lambda: o7_restore(test, bundle))))
            rows.append(_r9_cell(path, value, normal, "restore_boundary", _row(lambda: restore_wrapper(test, bundle))))
            rows.append(_r9_cell(path, value, normal, "live admission (prefix-seed)", _row(lambda: deep_admission(test, bundle))))
            if path in R9_CHAIN_READS:
                rows.append(_r9_cell(path, value, normal, "parent_chain", _typed(lambda: cp.parent_chain(bundle.parent, bundle.name))))
    if fields is None:
        introduced = json.loads((admission_bundle(test, "introduced") / "manifest.json").read_bytes())
        for path in (("identity", "phase_reached"), ("parent",)):
            for name, value in (*R9_SUBSTITUTIONS, ("[1]", [1])):
                bundle = admission_bundle(test, "introduced", manifest_change=lambda manifest, path=path, value=value: _put(manifest, path, value))
                rows.append(_r9_cell(path, value, _get(introduced, path), "live admission (prefix-verify, introduced)",
                                     _row(lambda: deep_admission(test, bundle, unit="release-tools-checkpoints-proof-prefix-verify"))))
    if include_tree:
        parts_base = {}
        realistic(test.tempdir("kin-r9-parts-"), "source-b0", tamper=lambda parts: parts_base.update(copy.deepcopy(parts)))
        for path in R9_TREE_FIELDS:
            normal = _get(parts_base, path)
            for name, value in R9_SUBSTITUTIONS:
                bundle = _row(lambda: admission_bundle(test, tamper=lambda parts, path=path, value=value: _put(parts, path, value)))
                if type(bundle) is dict:   # the fixture itself cannot be written with this value: recorded, never a caller row
                    rows.append({"field": ".".join(map(str, path)), "substitution": _json_type(value), "normal": _json_type(normal),
                                 "caller": "fixture", "outcome": bundle["outcome"], "effects": {}, "verdict": "NOT RUN (fixture)"})
                    continue
                rows.append(_r9_cell(path, value, normal, "load_bundle", _typed(lambda: cp.load_bundle(bundle)), read=False))
                rows.append(_r9_cell(path, value, normal, "restore_checkpoint", _row(lambda: o7_restore(test, bundle))))
                rows.append(_r9_cell(path, value, normal, "restore_boundary", _row(lambda: restore_wrapper(test, bundle))))
                rows.append(_r9_cell(path, value, normal, "live admission (prefix-seed)", _row(lambda: deep_admission(test, bundle))))
    if include_segment:
        child, unit = "release-tools-checkpoints-proof-late-resume", "release-tools-checkpoints-proof-prefix-introduce"
        for document, path in [("segment", path) for path in R9_SEGMENT_FIELDS] + [("index", path) for path in R9_INDEX_FIELDS]:
            for name, value in R9_SUBSTITUTIONS:
                root = test.tempdir("kin-proof-")
                proof, _, index = o7_index(test, unit=unit, root=root)
                cp.write_index(root, index)
                (root / "b.source-manifest.json").write_bytes(cp.canonical({"root": str(root / "b")}) + b"\n")
                index_path = root / "index" / (unit + ".json")
                if document == "index":   # the parent leaf's BOUND index itself (bound_index, rejudged_reasons)
                    bound = json.loads(index_path.read_bytes())
                    normal = bound if not path else _get(bound, path)
                    if not path:
                        bound = value
                    else:
                        _put(bound, path, value)
                    if bound is R8_MISSING:
                        index_path.unlink()
                    else:
                        index_path.write_bytes(cp.canonical(bound) + b"\n")
                else:
                    segment_path = Path(index["segment"])
                    segment = json.loads(segment_path.read_bytes())
                    normal = _get(segment, path)
                    _put(segment, path, value)
                    segment_raw = (json.dumps(segment, sort_keys=True, separators=(",", ":")) + "\n").encode()
                    segment_path.write_bytes(segment_raw)
                    index_path.write_bytes(cp.canonical({**json.loads(index_path.read_bytes()), "segment_sha256": cp.sha256(segment_raw)}) + b"\n")
                field = ("index",) + path if document == "index" else path
                rows.append(_r9_cell(field, value, normal, "resolve_parent", r10_effects(lambda: cp.resolve_parent(proof.leaves, child, root))))
                rows.append(_r9_cell(field, value, normal, "leaf_request", r10_effects(lambda: cp.leaf_request(proof.leaves, child, root))))
    return rows


def named_admission_contrasts(test):
    """CKPT8-1 and CKPT8-2 through the real stored-request admission: phase_reached normal/[]/{} past the host observation
    into admit_resume (prefix-seed over source-b0); the parent reference null/a valid reference/[1] through the same
    admission and parent_chain. Returns {case: row}."""
    rows = {}
    for name, value in (("normal", R8_NORMAL), ("[]", []), ("{}", {})):
        bundle = admission_bundle(test, manifest_change=None if value is R8_NORMAL else
                                  lambda manifest, value=value: manifest["identity"].update(phase_reached=value))
        rows["CKPT8-1 phase_reached " + name] = deep_admission(test, bundle)
    root = admission_bundle(test)
    reference = cp.parent_reference(json.loads((root / "manifest.json").read_bytes()), root)
    for name, value in (("null (a root)", None), ("a valid parent reference", reference), ("[1]", [1])):
        bundle = admission_bundle(test, manifest_change=lambda manifest, value=value: manifest.update(parent=copy.deepcopy(value)))
        if value is reference:   # the referenced parent lives in the same store, as a real chain does
            shutil.copytree(root, bundle.parent / root.name)
        row = deep_admission(test, bundle)
        row["parent_chain"] = _typed(lambda: cp.parent_chain(bundle.parent, bundle.name))
        rows["CKPT8-2 parent " + name] = row
    return rows


class CheckpointTypedReadTests(RefusalAssertions, TempCase):
    """r9 (D1575, Astra r8 delta CKPT8-1/2 and their class): every JSON read on the loader, restore and live-admission
    paths is a typed refusal before any effect. Assertions name the requirement (CKPT9_*); no message text is pinned."""

    def test_the_named_admission_contrasts_refuse_typed_after_the_host_observation(self):
        """CKPT8-1 (M61) and CKPT8-2 (M60, M62): phase_reached normal reaches the real admit_resume and is admitted; []/{}
        are refused typed (the loader now types the identity) with no admission, restore or fixture root; the parent null
        and a valid reference are admitted (the chain listed); [1] is refused typed, never read as a root, and parent_chain
        itself refuses it CHAIN_BROKEN (M62)."""
        rows = named_admission_contrasts(self)
        for name in ("CKPT8-1 phase_reached normal", "CKPT8-2 parent null (a root)", "CKPT8-2 parent a valid parent reference"):
            with self.subTest(case=name):
                row = rows[name]
                self.assertTrue(row["outcome"].startswith("SYNTHETIC_ADMISSION_END") and row["admission_success"] == 1 and row["host_reads"] >= 1,
                                "CKPT9_NORMAL_ADMITTED_AFTER_HOST: " + json.dumps(row))
        self.assertEqual(rows["CKPT8-2 parent a valid parent reference"]["parent_chain"], "ACCEPTED", "CKPT9_VALID_CHAIN_LISTED")
        for name in ("CKPT8-1 phase_reached []", "CKPT8-1 phase_reached {}", "CKPT8-2 parent [1]"):
            with self.subTest(case=name):
                row = rows[name]
                self.assertEqual((row["outcome"].split(":", 1)[0], row["admission_success"], row["restore_boundary"], row["fixture_root_created"],
                                  row["bundle_changed"]), ("BUNDLE_INVALID", 0, 0, False, False), "CKPT9_TYPED_BEFORE_ANY_EFFECT: " + json.dumps(row))
        self.assertTrue(rows["CKPT8-2 parent [1]"]["parent_chain"].startswith("CHAIN_BROKEN"), "CKPT9_MALFORMED_PARENT_IS_NO_ROOT")
        identity = identity_fixture(phase_reached=[])
        self.assertRefused("IDENTITY_INVALID", cp.identity_valid, identity)

    def test_one_mistyped_read_per_guard_is_its_caller_s_typed_refusal(self):
        """The guard families (M63-M65): resolve_parent's segment results; restore_boundary's owned stack; the loader's
        manifest envelope and owned shapes - one substitution each through its real caller, refused typed with no effect."""
        rows = typed_reads_matrix(self, fields=(("owned", "stack"), ("derived",)), include_tree=False, include_segment=False)
        rows += [row for row in typed_reads_matrix(self, fields=(), include_tree=False) if row["field"] == "results"]
        manifest = json.loads((admission_bundle(self) / "manifest.json").read_bytes())
        manifest["owned"]["stack"] = []
        root = self.tempdir("kin-r9-restore-") / "restored"
        rows.append(_r9_cell(("owned", "stack"), [], {}, "restore_boundary (a caller's mistyped manifest)",
                             _typed(lambda: __import__("ops_release_checkpoints_live_test").restore_boundary(
                                 manifest, Path("."), fixture_root=root, helper=image("3"), load=lambda path: None))))
        for row in rows:
            with self.subTest(field=row["field"], substitution=row["substitution"], caller=row["caller"]):
                self.assertEqual(row["verdict"], "PASS", "CKPT9_TYPED_READ: " + json.dumps(row))

    def test_every_json_read_on_the_admission_paths_is_a_typed_refusal(self):
        """The executed matrix (typed_reads_matrix) over every manifest, fixture-tree and segment field the listed callers
        read: no exception, every mistyped substitution refused typed, no effect after a refusal."""
        rows = typed_reads_matrix(self)
        self.assertGreater(len(rows), 700, "the finite matrix")
        for row in rows:
            with self.subTest(field=row["field"], substitution=row["substitution"], caller=row["caller"]):
                self.assertIn(row["verdict"], ("PASS", "PASS (not read by this caller)", "NOT RUN (fixture)"), "CKPT9_TYPED_READ: " + json.dumps(row))


# ── r10 (D1600, CKPT8-3/4): missing keys, populated volume restores and native A08 ──
R10_SUBSTITUTIONS = (("MISSING-KEY", R8_MISSING), *R9_SUBSTITUTIONS)
R10_STACK = ("context", "stacks", "source")
R10_NESTED_TREE_FIELDS = (("context", "b0", "dir"), ("context", "b0", "manifest_sha256"), R10_STACK + ("plan_sha256",),
                          R10_STACK + ("plan_document", "seed", "b0_dir"), R10_STACK + ("plan_document", "target_manifest_sha256"),
                          R10_STACK + ("target", "compose_files", 0), R10_STACK + ("target", "declared_overlays", 0),
                          R10_STACK + ("target", "declared_overlays", 0, "file"), R10_STACK + ("target", "declared_overlays", 0, "binds"),
                          R10_STACK + ("target", "declared_overlays", 0, "binds", 0),
                          R10_STACK + ("target", "declared_overlays", 0, "binds", 0, "source"))
R10_INDEX_FIELDS = (*R9_INDEX_FIELDS, ("verdict",), ("unit",), ("run_json_sha256",), ("logs", "stdout.log"), ("logs", "stderr.log"),
                    *(("raw", key, field) for key in ("checkpoint",) for field in ("path", "sha256")))
R10_LAYER_READ_FIELDS = (("roles",), ("roles", "orthanc"), ("descriptor_sha256",), ("outcome",),
                         *(("roles", "orthanc", key) for key in ("container_id", "image", "changes", "verdicts")),
                         ("roles", "orthanc", "changes", 0), ("roles", "orthanc", "verdicts", 0),
                         ("roles", "orthanc", "verdicts", 0, "verdict"))


def r10_rebind(bundle, manifest):
    """A finite malformed-input fixture: rebind its manifest name without replacing any judgement."""
    raw = cp.canonical(manifest) + b"\n"
    destination = bundle.parent / cp.sha256(raw)
    if destination != bundle:
        bundle.rename(destination)
    (destination / "manifest.json").write_bytes(raw)
    return destination


def r10_copy(test, bundle):
    destination = test.tempdir("kin-r10-bundle-") / "bundles" / bundle.name
    shutil.copytree(bundle, destination)
    return destination


def r10_bound_member(bundle, manifest, binding, data):
    """Rebind one fixture member's bytes, its binding, the archive and the payload inventory for finite negative cases."""
    swap_member(bundle, manifest["bindings"][binding]["path"], data)
    manifest["bindings"][binding]["sha256"] = cp.sha256(data)
    tree = bundle / "payload/fixture-tree.tar"
    for member in manifest["members"]:
        if member["name"] == "fixture-tree.tar":
            member.update(sha256=cp.sha256(tree.read_bytes()), bytes=tree.stat().st_size)
    manifest["identity"]["payload_manifest_sha256"] = cp.sha256(cp.canonical(manifest["members"]))
    return r10_rebind(bundle, manifest)


def r10_volume_bundle(test):
    """The real capture/seal over populated synthetic volumes, with the native database facts and a tool-tree member."""
    import ops_release_checkpoints_native_test as native
    real_seal = cp.PendingBundle.seal

    def seal_with_facts(pending, **kwargs):
        boundary = copy.deepcopy(kwargs["boundary"])
        boundary["facts"].update(migrations=copy.deepcopy(native.MIGRATIONS_BEFORE), legacy={"schema_owner": "kin_legacy_group"},
                                 realm={"realm_members": 2, "disabled": 1, "service_accounts": 1},
                                 data={"study": [{"uid": native.rehearsal.SYNTHETIC_STUDY}]},
                                 frame={"instances": 1, "frame_sha256": native.rehearsal.SYNTHETIC_FRAME["sha256"]})
        now = datetime.now(timezone.utc)
        boundary.update(window_end=(now + timedelta(days=1)).isoformat(), tls_not_after=(now + timedelta(days=2)).isoformat())
        tool = raw_tar([])
        pending.add("tool-tree.tar", "tool-tree", tool)
        identity = {**kwargs["identity"], "tool_tree_sha256_at_checkpoint": cp.tree_manifest_from_bytes({})["sha256"]}
        return real_seal(pending, **{**kwargs, "boundary": boundary, "identity": identity})
    with patch.object(cp.PendingBundle, "seal", seal_with_facts):
        bundle, _ = orthanc_capture(test)
    return bundle


def r10_native_roundtrip(test, bundle):
    """Real verify_bundle, A08 predicates and Smoke.check/log; stop after both A08 checks, before any Docker access."""
    import ops_release_checkpoints_native_test as native
    smoke = native.Smoke(test.tempdir("kin-r10-native-"))
    manifest = json.loads((bundle / "manifest.json").read_bytes())
    checks, docker_calls = [], []
    real_check = smoke.check

    def check(*args, **kwargs):
        result = real_check(*args, **kwargs)
        checks.append(args[1])
        if len(checks) == 2:
            raise cp.Refused("SYNTHETIC_A08_END", "both actual A08 predicates and their log writes completed")
        return result

    def docker(*args, **kwargs):
        docker_calls.append(1)
        raise AssertionError("unexpected Docker access")
    with patch.object(smoke, "check", check), patch.object(smoke, "docker", docker):
        try:
            smoke.roundtrip(None, manifest.get("checkpoint"), {"bundle": bundle, "manifest": manifest}, all_running=True)
            outcome = "ACCEPTED"
        except native.SmokeFailure as error:
            outcome = "A08_PREDICATE_FAILED: " + str(error)
        except cp.Refused as error:
            outcome = error.code + ": " + str(error)
        except Exception as error:
            outcome = "EXCEPTION " + type(error).__name__ + ": " + str(error)
    log = smoke.evidence / "smoke-log.jsonl"
    rows = [json.loads(line) for line in log.read_bytes().splitlines()] if log.exists() else []
    return {"outcome": outcome, "a08_rows": sum("A08" in row["ids"] for row in rows),
            "a08_pass_rows": sum("A08" in row["ids"] and row["outcome"] == "PASS" for row in rows),
            "docker_calls": len(docker_calls), "native_log": str(log)}


def r10_effects(action):
    """Call-through counters around the actual extraction/network operations; exceptions keep their effect counts."""
    effects = {"extraction": 0, "create_network": 0, "a08_rows": 0, "native_temp_archives": 0}
    extract, network, write = cp.extract_tree, FakeBackend.create_network, Path.write_bytes

    def extracting(*args, **kwargs):
        effects["extraction"] += 1
        return extract(*args, **kwargs)

    def networking(*args, **kwargs):
        effects["create_network"] += 1
        return network(*args, **kwargs)

    def writing(path, data):
        if path.name.startswith("sealed-") and path.suffix == ".tar":
            effects["native_temp_archives"] += 1
        return write(path, data)
    with patch.object(cp, "extract_tree", extracting), patch.object(FakeBackend, "create_network", networking), patch.object(Path, "write_bytes", writing), \
            contextlib.redirect_stdout(io.StringIO()):
        try:
            result = action()
            result = result if type(result) is dict and "outcome" in result else {"outcome": "ACCEPTED"}
        except cp.Refused as error:
            result = {"outcome": error.code + ": " + str(error)}
        except Exception as error:
            result = {"outcome": "EXCEPTION " + type(error).__name__ + ": " + str(error)}
    return {**result, "effects": {**effects, **{key: result[key] for key in ("a08_rows", "docker_calls", "check_rows") if key in result},
                                 **({"native_raw_files": len(result["raw_files"])} if "raw_files" in result else {})}}


def r10_sealed_markers(test, bundle):
    import ops_release_checkpoints_native_test as native
    smoke = native.Smoke(test.tempdir("kin-r10-markers-"))
    smoke.private = smoke.evidence
    return smoke.sealed_markers(cp.verify_bundle(bundle))


def r10_callers(test, bundle, *, native=False, chain=False):
    callers = {
        "load_bundle": lambda: cp.load_bundle(bundle),
        "restore_checkpoint": lambda: o7_restore(test, bundle),
        "restore_boundary": lambda: restore_wrapper(test, bundle),
        "live admission": lambda: deep_admission(test, bundle, "release-tools-checkpoints-proof-prefix-verify" if native
                                                   else "release-tools-checkpoints-proof-prefix-seed"),
    }
    if chain:
        callers["parent_chain"] = lambda: cp.parent_chain(bundle.parent, bundle.name)
    if native:
        callers["native roundtrip"] = lambda: r10_native_roundtrip(test, bundle)
        callers["native sealed_markers"] = lambda: r10_sealed_markers(test, bundle)
        callers["native regenerated"] = lambda: native_regenerated(test, sealed_of(bundle, {}))
    results = {}
    for name, action in callers.items():
        before = _tree_digest(bundle)
        results[name] = {**r10_effects(action), "bundle": str(bundle), "input_sha256": cp.sha256(cp.canonical(before)),
                         "inputs_unchanged": before == _tree_digest(bundle)}
    return results


def r10_cell(path, label, value, normal, caller, result, *, optional=False, read=True, native_facts=False):
    outcome = result["outcome"]
    accepted = outcome.startswith(("ACCEPTED", "SYNTHETIC_ADMISSION_END", "SYNTHETIC_A08_END"))
    malformed = (value is R8_MISSING and not optional) or (value is not R8_MISSING and type(value) is not type(normal))
    effects = result["effects"]
    # Generic capture/restore compares these facts opaquely; only the native predicate indexes their inner shape.
    if native_facts and path[2:3] in (("migrations",), ("legacy",), ("data",), ("realm",), ("frame",)) and caller != "native roundtrip":
        read = False
    if path in (("state", "status"), ("state", "lock_token")) and caller == "live admission":
        read = False  # this call-through admission sentinel stops before restore/bundle_inputs
    if path in (("identity", "image_ids", "previous"), ("identity", "image_ids", "release")) and caller not in ("restore_checkpoint", "restore_boundary", "live admission"):
        read = False  # bundle_inputs is the consumer requiring these image groups
    if path == ("identity", "runtime_identity", "arch") and caller != "live admission":
        read = False  # the generic identity permits runtime keys; admission reads the architecture
    if path == ("identity", "image_ids", "helper") and caller != "native roundtrip":
        read = False  # generic identity image groups are maps or scalar IDs; only native requires this scalar key
    if label == "normal" and not accepted:
        verdict = "FAIL: normal control refused"
    elif label == "normal" and caller == "native roundtrip" and result.get("a08_pass_rows") != 2:
        verdict = "FAIL: normal A08 predicates did not both pass"
    elif result.get("inputs_unchanged") is False:
        verdict = "FAIL: bundle inputs changed"
    elif outcome.startswith("EXCEPTION"):
        verdict = "FAIL: exception"
    elif outcome.startswith("A08_PREDICATE_FAILED"):
        verdict = "FAIL: malformed input reached A08" if malformed else "PASS: normal-type predicate rejection"
    elif accepted and malformed and read:
        verdict = "FAIL: malformed input accepted"
    elif not accepted and any(effects.values()):
        verdict = "FAIL: effects before refusal"
    elif not read:
        verdict = "NOT_READ"
    else:
        verdict = "PASS"
    return {"field": ".".join(map(str, path)), "substitution": label, "normal": _json_type(normal), "caller": caller,
            "outcome": outcome, "effects": effects, "verdict": verdict, "optional": optional,
            **{key: result[key] for key in ("a08_pass_rows", "native_log", "bundle", "input_sha256", "inputs_unchanged") if key in result}}


def r10_volume_fields(manifest):
    paths = list(R9_MANIFEST_FIELDS)
    paths += [("identity", key) for key in cp.IDENTITY_FIELDS]
    paths += [("identity", "image_ids", key) for key in ("helper", "previous", "release")]
    paths += [("identity", "runtime_identity", "arch")]
    paths += [("members", 0), *(("members", 0, key) for key in ("name", "category", "sha256"))]
    for name in manifest["bindings"]:
        paths += [("bindings", name), ("bindings", name, "path"), ("bindings", name, "sha256")]
    for category in manifest["owned"]["volumes"]:
        paths += [("owned", "volumes", category), *(("owned", "volumes", category, key) for key in ("name", "labels", "member"))]
    paths += [("owned", "networks", 0), ("owned", "networks", 0, "name"), ("owned", "networks", 0, "labels")]
    paths += [("owned", "stack", "containers", role) for role in intro.ROLES]
    facts = ("boundary", "facts")
    paths += [facts, facts + ("migrations",), facts + ("migrations", 0), facts + ("legacy",), facts + ("legacy", "schema_owner"),
              facts + ("data",), facts + ("data", "study"), facts + ("data", "study", 0), facts + ("data", "study", 0, "uid"),
              facts + ("realm",), facts + ("frame",), facts + ("containers",)]
    paths += [facts + ("realm", key) for key in ("realm_members", "disabled", "service_accounts")]
    paths += [facts + ("frame", key) for key in ("instances", "frame_sha256")]
    paths += [facts + ("containers", role) for role in intro.ROLES]
    paths += [facts + ("containers", role, key) for role in intro.ROLES for key in ("id", "image", "running", "project", "mounts")]
    return list(dict.fromkeys(paths))


def r10_matrix(test, *, volume_only=False, fields=None, source_fields=None, tree_fields=None, include_parents=True, include_request=True):
    """Finite actual-caller table. A normal control precedes each family; optional/not-read cells are explicit.

    The source-b0 fixture documents are changed after an ordinary seal, so even a missing state/status reaches the
    real readers (the former eight NOT RUN fixture cells). All current bytes/bindings are rebound; no validator is mocked.
    """
    rows = test.r10_rows = []
    volume = r10_volume_bundle(test)
    volume_manifest = json.loads((volume / "manifest.json").read_bytes())
    for caller, result in r10_callers(test, volume, native=True, chain=True).items():
        rows.append(r10_cell(("control", "populated-volume"), "normal", {}, {}, caller, result))
    paths = r10_volume_fields(volume_manifest) if fields is None else fields
    for path in paths:
        normal = _get(volume_manifest, path)
        for label, value in R10_SUBSTITUTIONS:
            bundle = r10_copy(test, volume)
            manifest = copy.deepcopy(volume_manifest)
            _put(manifest, path, value)
            bundle = r10_rebind(bundle, manifest)
            # A missing sequence element is a smaller sequence, not a missing object key.
            optional = isinstance(path[-1], int) or path in (("parent",), ("boundary", "window_end"), ("boundary", "tls_not_after"),
                                                          ("owned", "networks"), ("owned", "networks", 0, "labels"))
            for caller, result in r10_callers(test, bundle, native=True, chain=path in R9_CHAIN_READS).items():
                collection_entry = len(path) == 3 and path[:2] == ("owned", "volumes")
                required_native_pg = caller in ("native roundtrip", "native sealed_markers") and path == ("owned", "volumes", "pg")
                rows.append(r10_cell(path, label, value, normal, caller, result, optional=optional or (collection_entry and not required_native_pg),
                                     native_facts=path[:2] == ("boundary", "facts")))
    if volume_only:
        return rows
    # Preserve r9's source-b0 and fixture-tree coverage; missing is now a first-class substitution.
    def populated(parts):
        stack = parts["context"]["stacks"]["source"]
        stack["plan_document"]["seed"] = {"b0_dir": parts["context"]["b0"]["dir"]}
        stack["target"]["declared_overlays"] = [{"file": stack["root"] + "/overlay.yml", "binds": [{"source": stack["root"] + "/inputs"}]}]
    source = admission_bundle(test, tamper=populated)
    source_manifest = json.loads((source / "manifest.json").read_bytes())
    for caller, result in r10_callers(test, source, chain=True).items():
        rows.append(r10_cell(("control", "source-b0"), "normal", {}, {}, caller, result))
    for path in R9_MANIFEST_FIELDS if source_fields is None else source_fields:
        for label, value in R10_SUBSTITUTIONS:
            bundle = r10_copy(test, source)
            manifest = copy.deepcopy(source_manifest)
            _put(manifest, path, value)
            bundle = r10_rebind(bundle, manifest)
            optional = path in (("parent",), ("boundary", "window_end"), ("boundary", "tls_not_after"), ("owned", "volumes"), ("owned", "networks"))
            for caller, result in r10_callers(test, bundle, chain=path in R9_CHAIN_READS).items():
                rows.append(r10_cell(path, label, value, _get(source_manifest, path), caller, result, optional=optional))
    documents = {name: json.loads(cp.tree_member_bytes(source / "payload/fixture-tree.tar", source_manifest["bindings"][name]["path"]))
                 for name in ("context", "state")}
    for path in (*R9_TREE_FIELDS, ("state", "lock_token"), *R10_NESTED_TREE_FIELDS) if tree_fields is None else tree_fields:
        normal = _get(documents, path)
        for label, value in R10_SUBSTITUTIONS:
            bundle = r10_copy(test, source)
            manifest, parts = copy.deepcopy(source_manifest), copy.deepcopy(documents)
            # A whole document cannot lose its root key; missing means the bound archive member is absent.
            if len(path) == 1 and value is R8_MISSING:
                raw = None
            else:
                _put(parts, path, value)
                descriptor = _obj_or_none(_obj_or_none(_obj_or_none(parts.get("context")).get("stacks")).get("source"))
                if type(descriptor.get("plan_document")) is dict and type(descriptor.get("target")) is dict:
                    descriptor["plan_document"]["target_manifest_sha256"] = cp.sha256(intro.canonical(descriptor["target"]))
                    descriptor["plan_sha256"] = intro.plan_identity(descriptor["plan_document"])
                    if type(parts.get("state")) is dict:
                        parts["state"]["plan_sha256"] = descriptor["plan_sha256"]
                    manifest["identity"].update(plan_sha256=descriptor["plan_sha256"],
                                                 target_manifest_sha256=descriptor["plan_document"]["target_manifest_sha256"])
                if value is R8_MISSING:
                    node = _get(parts, path[:-1])
                    if type(node) is dict:
                        node.pop(path[-1], None)
                    # A list element was already deleted by the first substitution above.
                else:
                    _put(parts, path, value)
                raw = cp.canonical(parts[path[0]]) + b"\n"
            for name in ("context", "state"):
                data = raw if name == path[0] else cp.canonical(parts[name]) + b"\n"
                swap_member(bundle, manifest["bindings"][name]["path"], data)
                if data is not None:
                    manifest["bindings"][name]["sha256"] = cp.sha256(data)
            tree = bundle / "payload/fixture-tree.tar"
            for member in manifest["members"]:
                if member["name"] == "fixture-tree.tar":
                    member.update(sha256=cp.sha256(tree.read_bytes()), bytes=tree.stat().st_size)
            manifest["identity"]["payload_manifest_sha256"] = cp.sha256(cp.canonical(manifest["members"]))
            bundle = r10_rebind(bundle, manifest)
            optional = isinstance(path[-1], int) or path[-1] in ("binds", "b0_dir") or path in (("context", "stacks", "source", "plan_document", "seed"), ("state", "b0"))
            for caller, result in r10_callers(test, bundle).items():
                rows.append(r10_cell(path, label, value, normal, caller, result, optional=optional, read=caller != "load_bundle"))
    # The existing actual BOUND parent reader/request cases, extended with missing keys (whole-index missing is no file).
    if include_parents:
        reference = cp.parent_reference(source_manifest, source)
        for key in reference:
            for label, value in (("normal", R8_NORMAL), *R10_SUBSTITUTIONS):
                bundle = r10_copy(test, source)
                parent = bundle.parent / source.name
                manifest = copy.deepcopy(source_manifest)
                manifest["parent"] = copy.deepcopy(reference)
                _put(manifest["parent"], (key,), value)
                bundle = r10_rebind(bundle, manifest)
                shutil.copytree(source, parent)
                for caller, result in r10_callers(test, bundle, chain=True).items():
                    rows.append(r10_cell(("parent", key), label, reference[key] if value is R8_NORMAL else value, reference[key],
                                         caller, result, optional=key != "manifest_sha256",
                                         read=key != "payload_manifest_sha256" and (caller != "parent_chain" or key == "manifest_sha256")))
        with patch.dict(globals(), {"R9_SUBSTITUTIONS": R10_SUBSTITUTIONS, "R9_INDEX_FIELDS": R10_INDEX_FIELDS}):
            rows.extend(typed_reads_matrix(test, fields=(), include_tree=False))
    if include_request:
        paths = [(key,) for key in cp.REQUEST_KEYS]
        paths += [(key, part) for key in ("parent_manifest", "source_manifest") for part in ("path", "sha256")]
        for path in paths:
            for label, value in R10_SUBSTITUTIONS:
                original = []

                def change(request):
                    original.append(copy.deepcopy(_get(request, path)))
                    _put(request, path, value)
                result = r10_effects(lambda: deep_admission(test, source, request_change=change))
                rows.append(r10_cell(("request",) + path, label, value, original[0], "live admission", result))
    if fields is None:
        state = json.loads(cp.tree_member_bytes(volume / "payload/fixture-tree.tar", volume_manifest["bindings"]["state"]["path"]))
        for key in ("dir", "manifest_sha256"):
            for label, value in R10_SUBSTITUTIONS:
                changed = copy.deepcopy(state)
                _put(changed, ("b0", key), value)
                bundle = r10_bound_member(r10_copy(test, volume), copy.deepcopy(volume_manifest), "state", cp.canonical(changed) + b"\n")
                for caller, result in r10_callers(test, bundle, native=True).items():
                    rows.append(r10_cell(("state", "b0", key), label, value, state["b0"][key], caller, result))
        layer = json.loads(cp.tree_member_bytes(volume / "payload/fixture-tree.tar", volume_manifest["bindings"]["layer"]["path"]))
        for path in R10_LAYER_READ_FIELDS:
            for label, value in R10_SUBSTITUTIONS:
                record = copy.deepcopy(layer)
                _put(record, path, value)
                bundle = r10_bound_member(r10_copy(test, volume), copy.deepcopy(volume_manifest), "layer", cp.canonical(record) + b"\n")
                for caller, result in r10_callers(test, bundle, native=True).items():
                    rows.append(r10_cell(("layer",) + path, label, value, _get(layer, path), caller, result, optional=isinstance(path[-1], int)))
        rows.extend(r10_native_details(test))
        rows.extend(r10_conditional_reads(test, volume, volume_manifest))
    return rows


def r10_conditional_reads(test, volume=None, volume_manifest=None):
    """Inputs that exist only on a volume capture or diagnostic-fork index use those actual consumer paths."""
    rows = []
    volume = volume or r10_volume_bundle(test)
    volume_manifest = volume_manifest or json.loads((volume / "manifest.json").read_bytes())
    context = json.loads(cp.tree_member_bytes(volume / "payload/fixture-tree.tar", volume_manifest["bindings"]["context"]["path"]))
    path = ("stacks", cp.LINEAGE_STACK[volume_manifest["checkpoint"]], "target", "containers")
    for label, value in R10_SUBSTITUTIONS:
        changed = copy.deepcopy(context)
        _put(changed, path, value)
        bundle = r10_bound_member(r10_copy(test, volume), copy.deepcopy(volume_manifest), "context", cp.canonical(changed) + b"\n")
        for caller, result in r10_callers(test, bundle, native=True).items():
            rows.append(r10_cell(("context",) + path, label, value, _get(context, path), caller, result))
    unit = "release-tools-checkpoints-proof-late-resume"
    for key in ("path", "sha256"):
        for label, value in (("normal", R8_NORMAL), *R10_SUBSTITUTIONS):
            proof, _, index = o7_index(test, unit=unit)
            normal = index["raw"]["admission"][key]
            _put(index, ("raw", "admission", key), value)
            cp.write_index(proof.root, index)
            result = r10_effects(lambda: cp.bound_index(proof.root, unit))
            rows.append(r10_cell(("index", "raw", "admission", key), label, normal if value is R8_NORMAL else value, normal,
                                 "bound_index (diagnostic-fork)", result))
    return rows


def r10_native_details(test, *, check_shared=False):
    rows = []
    original, descriptor = orthanc_capture(test)
    original_manifest = json.loads((original / "manifest.json").read_bytes())
    observation = original_manifest["bindings"]["observation"]["path"].rsplit("/", 1)[0]
    files = cp.tree_folder(original / "payload/fixture-tree.tar", observation)
    for key in ("reasons", "hostid_reasons", "applicable", "hostid_regenerated", "pinned_image", "container_id", "image", "generated", "probe"):
        for label, value in (("normal", R8_NORMAL), *R10_SUBSTITUTIONS):
            changed = copy.deepcopy(descriptor)
            _put(changed, (key,), value)
            bundle = r10_copy(test, original)
            manifest, current = copy.deepcopy(original_manifest), dict(files)
            current[cp.REGENERATED_FILE] = cp.canonical(changed) + b"\n"
            request = json.loads(current["request.json"])
            request["regenerated_sha256"] = cp.sha256(current[cp.REGENERATED_FILE])
            current["request.json"] = cp.canonical(request) + b"\n"
            digest = cp.sha256(cp.canonical(request))
            summary = json.loads(current[cp.OBSERVATION_RESULT])
            old_commands = "commands-" + cp.OBSERVATION_PHASE + "-" + summary["request_sha256"][:16] + ".jsonl"
            new_commands = "commands-" + cp.OBSERVATION_PHASE + "-" + digest[:16] + ".jsonl"
            current[new_commands] = current.pop(old_commands)
            state = json.loads(current["state.json"])
            for worker in state["workers"].values():
                worker["request_sha256"] = digest
            current["state.json"] = cp.canonical(state) + b"\n"
            summary["request_sha256"] = digest
            summary["files"] = {name: cp.sha256(data) for name, data in current.items() if name != cp.OBSERVATION_RESULT}
            current[cp.OBSERVATION_RESULT] = cp.canonical(summary) + b"\n"
            for name in files.keys() | current.keys():
                swap_member(bundle, observation + "/" + name, current.get(name))
            manifest["bindings"]["observation"]["sha256"] = cp.sha256(current[cp.OBSERVATION_RESULT])
            layer = json.loads(cp.tree_member_bytes(bundle / "payload/fixture-tree.tar", manifest["bindings"]["layer"]["path"]))
            layer["observation"]["sha256"] = manifest["bindings"]["observation"]["sha256"]
            layer["observation"]["request_sha256"] = digest
            layer["descriptor_sha256"] = request["regenerated_sha256"]
            # The layer path binds the observation request too; keep that binding coherent so the substituted
            # descriptor reaches its actual consumer instead of failing at an unrelated stale request path.
            old_layer = manifest["bindings"]["layer"]["path"]
            manifest["bindings"]["layer"]["path"] = old_layer.rsplit("/", 2)[0] + "/layer-" + digest[:16] + "/" + cp.LAYER_FILE
            if manifest["bindings"]["layer"]["path"] != old_layer:
                swap_member(bundle, old_layer, None)
            bundle = r10_bound_member(bundle, manifest, "layer", cp.canonical(layer) + b"\n")
            if check_shared:
                raw, arguments = _bundle_arguments(bundle)
                direct = _typed(lambda: cp.layer_valid(raw, **arguments))
                loaded = _typed(lambda: cp.verify_bundle(bundle))
                malformed = key != "probe" and (value is R8_MISSING or
                            (value is not R8_NORMAL and type(value) is not type(descriptor[key])))
                if malformed:
                    test.assertTrue(direct.startswith("LAYER_INVALID"), "CKPT10_SHARED_DESCRIPTOR: " + direct)
                    test.assertTrue(loaded.startswith("BUNDLE_INVALID"), "CKPT10_SHARED_BUNDLE: " + loaded)
                elif value is R8_NORMAL or key == "probe" or key in ("reasons", "hostid_reasons"):
                    test.assertEqual(direct, "ACCEPTED", "CKPT10_SHARED_NORMAL: " + direct)
                    test.assertEqual(loaded, "ACCEPTED", "CKPT10_SHARED_NORMAL_BUNDLE: " + loaded)
            result = r10_effects(lambda: native_regenerated(test, sealed_of(bundle, changed)))
            # probe is diagnostic metadata returned unchanged: no native predicate or typed read depends on its shape.
            rows.append(r10_cell(("descriptor", key), label, descriptor[key] if value is R8_NORMAL else value, descriptor[key],
                                 "native regenerated", result, optional=key == "probe", read=key != "probe"))
    return rows


class CheckpointMissingReadTests(RefusalAssertions, TempCase):
    def test_volume_fields_refuse_before_extraction_or_network_creation(self):
        fields = (("owned", "volumes"), ("owned", "volumes", "pg", "labels"))
        rows = r10_matrix(self, volume_only=True, fields=fields)
        for row in rows:
            with self.subTest(field=row["field"], substitution=row["substitution"], caller=row["caller"]):
                self.assertEqual(row["verdict"], "PASS", "CKPT10_VOLUME_BEFORE_EFFECT: " + json.dumps(row))

    def test_native_boundary_fact_shapes_refuse_before_any_a08_output(self):
        fields = (("boundary", "facts", "migrations", 0), ("boundary", "facts", "legacy"), ("boundary", "facts", "data", "study", 0))
        rows = r10_matrix(self, volume_only=True, fields=fields)
        for row in rows:
            with self.subTest(field=row["field"], substitution=row["substitution"], caller=row["caller"]):
                self.assertIn(row["verdict"], ("PASS", "NOT_READ", "PASS: normal-type predicate rejection"), "CKPT10_NATIVE_BEFORE_A08: " + json.dumps(row))

    def test_restore_members_and_state_are_checked_before_effects(self):
        rows = r10_matrix(self, fields=(("owned", "volumes", "pg", "member"),), source_fields=(),
                          tree_fields=(("state", "status"), ("state", "lock_token")), include_parents=False, include_request=False)
        for row in rows:
            with self.subTest(field=row["field"], substitution=row["substitution"], caller=row["caller"]):
                self.assertIn(row["verdict"], ("PASS", "NOT_READ"), "CKPT10_RESTORE_PREFLIGHT: " + json.dumps(row))

    def test_native_realm_frame_and_resources_are_checked_before_a08(self):
        fields = (("boundary", "facts", "realm"), ("boundary", "facts", "frame"), ("owned", "volumes", "pg"), ("identity", "image_ids", "helper"))
        for row in r10_matrix(self, volume_only=True, fields=fields):
            with self.subTest(field=row["field"], substitution=row["substitution"], caller=row["caller"]):
                self.assertIn(row["verdict"], ("PASS", "NOT_READ", "PASS: normal-type predicate rejection"),
                              "CKPT10_NATIVE_REQUIRED_READS: " + json.dumps(row))

    def test_regenerated_detail_fields_are_checked_before_output(self):
        for row in r10_native_details(self, check_shared=True):
            self.assertIn(row["verdict"], ("PASS", "NOT_READ"), "CKPT10_NATIVE_DETAIL_TYPED: " + json.dumps(row))
        descriptor = regenerated_fixture("id-" + target_fixture()["containers"]["orthanc"])
        descriptor["reasons"] = {}
        # Observe the ordinary capture path, before archive export or seal; do not construct a malformed verified value.
        with patch.object(cp.PendingBundle, "seal", autospec=True, side_effect=cp.PendingBundle.seal) as seal_call, \
                patch.object(FakeBackend, "export_volume", autospec=True, side_effect=FakeBackend.export_volume) as export_call, \
                patch.object(cp, "write_tree_archive", wraps=cp.write_tree_archive) as tree_call:
            result = _typed(lambda: orthanc_capture(self, judged=descriptor))
        self.assertTrue(result.startswith("LAYER_INVALID"), "CKPT10_CAPTURE_DESCRIPTOR: " + result)
        self.assertEqual((seal_call.call_count, export_call.call_count, tree_call.call_count), (0, 0, 0),
                         "CKPT10_CAPTURE_BEFORE_EXPORT")

    def test_missing_and_mistyped_fields_through_every_real_caller(self):
        rows = r10_matrix(self)
        print("R10_MATRIX " + json.dumps(rows, separators=(",", ":")), flush=True)
        for row in rows:
            with self.subTest(field=row["field"], substitution=row["substitution"], caller=row["caller"]):
                self.assertIn(row["verdict"], ("PASS", "NOT_READ", "PASS: normal-type predicate rejection"),
                              "CKPT10_TYPED_READ: " + json.dumps(row))


# ── T18: mutants of the checkpoint logic (temporary copies of the harness files only) ──

# The harness file each mutant edits (a temporary copy; the product scripts are never copied or changed).
MUTANT_TARGETS = {"checkpoints": "ops_release_checkpoints.py", "rehearsal": "ops_deploy_host_container_test.py",
                  "native": "ops_release_checkpoints_native_test.py", "live": "ops_release_checkpoints_live_test.py"}
MUTANTS = (
    ("M01", "CheckpointBoundaryTests.test_only_completed_quiet_pre_ponr_boundaries_publish",
     'require(state.get("status") == spec["status"] and state.get("running") is None and state.get("unknown_hold") is None,',
     'require(state.get("status") == spec["status"],', "checkpoints"),
    ("M02", "CheckpointBundleTests.test_complete_private_bundle_is_atomic_and_secret_free_in_evidence",
     'require(digest.hexdigest() == member["sha256"], "BUNDLE_INVALID", "member hash " + name)', 'pass', "checkpoints"),
    ("M03", "CheckpointIdentityTests.test_actual_bytes_and_all_bound_inputs_must_match",
     'return [key for key in fields if recorded.get(key) != observed.get(key)]',
     'b0 = ("source_b0_manifest_sha256", "clone_b0_manifest_sha256")\n'
     '    pair = lambda value: sorted(str(value.get(key)) for key in b0)\n'
     '    return [key for key in fields if key not in b0 and recorded.get(key) != observed.get(key)] + (["b0"] if pair(recorded) != pair(observed) else [])',
     "checkpoints"),
    ("M04", "CheckpointIdentityTests.test_actual_bytes_and_all_bound_inputs_must_match",
     'require(all(type(item) is str and IMAGE_ID.fullmatch(item) for item in flat), "IDENTITY_INVALID", "image_ids." + side)',
     'require(all(type(item) is str and item for item in flat), "IDENTITY_INVALID", "image_ids." + side)', "checkpoints"),
    ("M05", "CheckpointIdentityTests.test_actual_bytes_and_all_bound_inputs_must_match",
     '    if source_root is not None:\n        actual = source_identity(source_root, helpers=helpers)',
     '    if False:\n        actual = source_identity(source_root, helpers=helpers)', "checkpoints"),
    ("M06", "CheckpointImpactTests.test_closed_body_changes_select_only_unexecuted_phases",
     '(changed if body in ALLOWLIST else prefix).append(body)',
     '(changed if body in ALLOWLIST or body.startswith("HostOps.") else prefix).append(body)', "checkpoints"),
    ("M07", "CheckpointForkTests.test_real_plan_and_compose_binding_preserve_parent_and_deny_receipt",
     'child["compose_entry"] = {**child_pointer, "root": parent_state["compose_entry"]["root"]}',
     'child["compose_entry"] = dict(parent_state["compose_entry"])', "checkpoints"),
    ("M08", "CheckpointForkTests.test_real_plan_and_compose_binding_preserve_parent_and_deny_receipt",
     'child["history"] = []', 'child["history"] = list(parent_state.get("history") or [])', "checkpoints"),
    ("M09", "CheckpointClaimTests.test_inherited_or_missing_segments_never_become_fresh_pass",
     '"fresh_e2e": kind == "fresh" and request["stage"] is None,', '"fresh_e2e": kind in ("fresh", "checkpoint-resume"),', "checkpoints"),
    ("M10", "CheckpointBudgetTests.test_real_runner_preserves_leaf_attempts_and_refusals",
     'leaf = next((item for item in registry_valid(leaves) if item["unit"] == request["unit"]), None)',
     'leaf = next((item for item in registry_valid(leaves) if request["unit"].startswith(item["unit"])), None)', "checkpoints"),
    ("M11", "CheckpointGateTests.test_permission_slot_and_marker_precede_every_mutation",
     '    path = Path(evidence_root) / "segment.json"\n',
     '    path = Path(evidence_root) / "segment.json"\n    if not passed:\n        (Path(gate.STATE) / "live-needs-inspection.json").unlink(missing_ok=True)\n',
     "checkpoints"),
    ("M12", "CheckpointCleanupTests.test_only_owned_resources_are_removed_and_absence_is_observed",
     'or labels.get("com.docker.compose.project") in owned["projects"])',
     'or labels.get("com.docker.compose.project") in owned["projects"]\n'
     '            or any(str(item.get("name", "")).startswith(project) for project in owned["projects"]))', "checkpoints"),
    ("M13", "CheckpointTimeTests.test_expiry_and_real_time_inputs_are_not_rewritten",
     'require(current + timedelta(seconds=suffix_seconds + teardown_seconds) <= deadline, "EXPIRED",', 'require(True, "EXPIRED",', "checkpoints"),
    ("M14", "CheckpointRecordTests.test_existing_record_run_binds_exact_inputs_outputs_and_exit",
     'elif first["sha256"] != last["sha256"]:', 'elif False:', "checkpoints"),
    # Hardening round 1 (CKPT-01..09).
    ("M15", "CheckpointScenarioTests.test_fresh_scenarios_keep_their_phase_and_data_contracts",   # CKPT-05: Astra's no-op probe
     '    def stage_verify(self, ctx):\n        clone = ctx.clone\n', '    def stage_verify(self, ctx):\n        return\n        clone = ctx.clone\n',
     "rehearsal"),
    ("M16", "CheckpointScenarioTests.test_fresh_scenarios_keep_their_phase_and_data_contracts",   # CKPT-05: one assertion removed
     '        self.assertEqual(clone.psql(REALM_SMOKE_SQL, "keycloak"), "0", "the smoke member is gone before any reopen")\n',
     '        pass\n', "rehearsal"),
    ("M17", "CheckpointHostAdapterTests.test_adapter_admission_counts_labels_and_binds_one_local_daemon",   # CKPT-01: names only
     '"foreign_containers": checkpoints.foreign_containers(rows or [], owned_ids=owned_ids),',
     '"foreign_containers": [row["name"] for row in rows or [] if row["name"].startswith("kin-")],', "rehearsal"),
    ("M18", "CheckpointHostAdapterTests.test_adapter_admission_counts_labels_and_binds_one_local_daemon",   # CKPT-01: any context
     '    require(str(facts.get("docker_endpoint", "")).startswith("unix:///"), "REMOTE_DAEMON",', '    require(True, "REMOTE_DAEMON",',
     "checkpoints"),
    ("M19", "CheckpointRecordTests.test_existing_record_run_binds_exact_inputs_outputs_and_exit",   # CKPT-02: announced SHA unchecked
     '                                      or announced[0].get("sha256") != sha256(segment_raw)):', '                                      or False):',
     "checkpoints"),
    ("M20", "CheckpointRecordTests.test_existing_record_run_binds_exact_inputs_outputs_and_exit",   # CKPT-02: shrunk --file accepted
     '    reasons += ["required input not declared: " + name for name in required_files if _resolved(cwd, name) not in declared_files]',
     '    reasons += []', "checkpoints"),
    ("M21", "CheckpointLeafTests.test_raw_records_identities_and_parent_chain_survive_a_bundleless_leaf",   # CKPT-03: payload as manifest
     '    return {"manifest_sha256": sha256(raw), "payload_manifest_sha256": manifest["identity"]["payload_manifest_sha256"],',
     '    return {"manifest_sha256": manifest["identity"]["payload_manifest_sha256"], '
     '"payload_manifest_sha256": manifest["identity"]["payload_manifest_sha256"],', "checkpoints"),
    ("M22", "CheckpointLeafTests.test_raw_records_identities_and_parent_chain_survive_a_bundleless_leaf",   # CKPT-03: secrets copied
     '                if name in SECRET_RECORD_NAMES or SECRET_RECORD_PATTERN.fullmatch(name):\n                    continue\n',
     '                if False:\n                    continue\n', "checkpoints"),
    ("M23", "CheckpointLeafTests.test_raw_records_identities_and_parent_chain_survive_a_bundleless_leaf",   # CKPT-03: nothing preserved
     '    raw = preserve_records(records, evidence) if records else []', '    raw = []', "checkpoints"),
    ("M24", "CheckpointInputsTests.test_bundle_inputs_runtime_and_restored_facts_are_recomputed",   # CKPT-04: plan bytes not recomputed
     '    require(plan_sha == descriptor.get("plan_sha256") == identity.get("plan_sha256") == state.get("plan_sha256"), "BUNDLE_INPUT_MISMATCH",',
     '    require(True, "BUNDLE_INPUT_MISMATCH",', "checkpoints"),
    ("M25", "CheckpointInputsTests.test_bundle_inputs_runtime_and_restored_facts_are_recomputed",   # CKPT-04: only containers compared
     '    differences += [key for key in sorted(recorded) if key != "containers" and recorded[key] != observed[key]]', '    differences += []',
     "checkpoints"),
    ("M26", "CheckpointLineageTests.test_parent_map_requests_and_commands_are_fixed_before_restore",   # CKPT-06: lineage unchecked
     '    if not fresh:\n        parent_lineage(request, leaf)\n', '    if False:\n        parent_lineage(request, leaf)\n', "checkpoints"),
    ("M27", "CheckpointLineageTests.test_parent_map_requests_and_commands_are_fixed_before_restore",   # CKPT-06: any parent
     '            require(parent is not None and parent["stage"] is not None and STAGES[parent["stage"]]["produces"] == consumes',
     '            require(True or parent is not None and parent["stage"] is not None and STAGES[parent["stage"]]["produces"] == consumes',
     "checkpoints"),
    ("M28", "CheckpointBundleTests.test_complete_private_bundle_is_atomic_and_secret_free_in_evidence",   # CKPT-07: duplicates
     '        require(key not in names, "ARCHIVE_INVALID", "duplicate member " + key)', '        pass', "checkpoints"),
    ("M29", "CheckpointCompareTests.test_equal_failures_are_not_a_t16_pass",   # CKPT-08: status ignored
     '    reasons = [] if verdict.get("status") == "DEPLOYED" else ["status " + str(verdict.get("status"))]', '    reasons = []',
     "checkpoints"),
    ("M30", "CheckpointCleanupTests.test_only_owned_resources_are_removed_and_absence_is_observed",   # CKPT-09: last tag removed
     '        keep = None if names - tags else (mine[-1] if mine else None)', '        keep = None', "checkpoints"),
    # Round 3 (CKPT2-01..06, consult answer.json round3_acceptance).
    ("M31", "CheckpointCleanupTests.test_only_owned_resources_are_removed_and_absence_is_observed",   # CKPT2-05: a stale tag count
     '        keep = None if names - tags else (mine[-1] if mine else None)',
     '        keep = None if names - tags or len(mine) > 1 else (mine[-1] if mine else None)', "checkpoints"),
    ("M32", "CheckpointInputsTests.test_bundle_inputs_runtime_and_restored_facts_are_recomputed",   # CKPT2-04: lexical containment
     '    base, path = flavour(module.normpath(root)), flavour(module.normpath(value))', '    base, path = flavour(root), flavour(value)',
     "checkpoints"),
    ("M33", "CheckpointLineageTests.test_retry_attempts_keep_unit_plan_parent_and_earlier_raw_bytes",   # CKPT2-06: one evidence root
     '            "evidence": root / "evidence" / unit / ("attempt-" + str(attempt))}', '            "evidence": root / "evidence" / unit}',
     "checkpoints"),
    ("M34", "CheckpointLineageTests.test_retry_attempts_keep_unit_plan_parent_and_earlier_raw_bytes",   # CKPT2-06: interrupted retried
     '    require("interrupted" not in statuses, "RETRY_REFUSED",', '    require(True, "RETRY_REFUSED",', "checkpoints"),
    ("M35", "CheckpointLineageTests.test_retry_attempts_keep_unit_plan_parent_and_earlier_raw_bytes",   # CKPT2-06: fresh evidence reused
     '        checkpoints.require(not evidence or not Path(evidence).exists(), "EVIDENCE_EXISTS", str(evidence))',
     '        checkpoints.require(True, "EVIDENCE_EXISTS", str(evidence))', "rehearsal"),
    ("M36", "CheckpointRecordTests.test_raw_evidence_is_bound_not_only_the_segment_claims",   # CKPT2-01: raw hashes unchecked
     '        if sha256(data) != digest:\n            reasons.append("raw record changed: " + rel)\n            continue\n',
     '        if False:\n            reasons.append("raw record changed: " + rel)\n            continue\n', "checkpoints"),
    ("M37", "CheckpointRecordTests.test_raw_evidence_is_bound_not_only_the_segment_claims",   # CKPT2-01: raw result unread
     '            if (result.get("phase") != item["phase"] or result.get("status") != item["status"] or steps != item["steps"]',
     '            if False and (result.get("phase") != item["phase"] or result.get("status") != item["status"] or steps != item["steps"]',
     "checkpoints"),
    ("M38", "CheckpointRecordTests.test_raw_evidence_is_bound_not_only_the_segment_claims",   # CKPT2-01: executed plan optional
     '    elif current.get("plan_sha256") is None or current.get("plan_sha256") != plans.get(expected[0]["stack"]):',
     '    elif False:', "checkpoints"),
    ("M39", "CheckpointRecordTests.test_bound_index_is_rechecked_when_consumed",   # CKPT2-03: raw records not re-read
     '            current(evidence / rel, digest, "raw record " + rel)', '            pass', "checkpoints"),
    ("M40", "CheckpointRecordTests.test_bound_index_is_rechecked_when_consumed",   # CKPT2-03: stdout trusted after the index
     '        stdout = current(run_dir / "stdout.log", logs["stdout.log"], "stdout.log")',
     '        stdout = (run_dir / "stdout.log").read_bytes()', "checkpoints"),
    ("M41", "CheckpointBytecodeTests.test_supervised_browser_child_keeps_the_frozen_source_admissible",   # CKPT2-02: cache admitted
     '        require(not any((root / folder).rglob("__pycache__")), "RUNTIME_UNPINNED", "a bytecode cache in the frozen " + folder)',
     '        require(True, "RUNTIME_UNPINNED", "a bytecode cache in the frozen " + folder)', "checkpoints"),
    ("M42", "CheckpointBytecodeTests.test_supervised_browser_child_keeps_the_frozen_source_admissible",   # CKPT2-02: new files ignored
     '    reasons += ["input appeared during the run: " + after[path]["requested"] for path in sorted(set(after) - set(before))]',
     '    reasons += []', "checkpoints"),
    # Round 5 (consult-checkpoints-r5-20261016 new_mutants).
    ("M43", "CheckpointObservationTests.test_observation_context_settles_its_own_workers_and_refuses_an_unsettled_state",   # database fact not read
     '    require(execs, "NOT_A_BOUNDARY", "no settled exec of this observation read the database")', '    pass', "checkpoints"),
    ("M44", "CheckpointObservationTests.test_the_original_records_stay_byte_identical_and_bind_the_sealed_state",   # the original Records as sink
     '    sink = intro.Records(folder, secrets=secrets_dir)', '    sink = intro.Records(records_dir, secrets=secrets_dir)', "checkpoints"),
    ("M46", "CheckpointRecordTests.test_observation_raw_is_required_and_rechecked_when_consumed",   # required observation unchecked
     '        if not restores and parent is not None:', '        if False:', "checkpoints"),
    # Round 6 (consult-checkpoints-r6-20261017 new_mutants; M50 and M51 are the optional ones the contract needs).
    ("M47", "CheckpointRegeneratedTests.test_the_regenerated_exception_is_typed_and_bound_to_the_orthanc_role_and_image",   # any plugins file
     '        return "plugin" if kind == "A" and fact.get("type") == "file" and listed and content and _same(fact, expected) else None',
     '        return "plugin" if kind == "A" and fact.get("type") == "file" else None', "checkpoints"),
    ("M48", "CheckpointRegeneratedTests.test_the_regenerated_exception_is_typed_and_bound_to_the_orthanc_role_and_image",   # role guard removed
     '    return (role == REGENERATED_ROLE and type(descriptor) is dict and descriptor.get("applicable") is True',
     '    return (type(descriptor) is dict and descriptor.get("applicable") is True', "checkpoints"),
    ("M49", "CheckpointDeadlineTests.test_a_bounded_call_is_cut_at_the_shared_end_and_its_client_tree_ended",   # remaining ignored
     '        effective = self.timeout(timeout, what=what)', '        effective = self.timeout(timeout, what=what) and timeout', "checkpoints"),
    ("M50", "CheckpointRegeneratedTests.test_the_regenerated_exception_is_typed_and_bound_to_the_orthanc_role_and_image",   # library bytes unchecked
     '        content = listed and fact.get("sha256") == expected.get("sha256") == origin.get("sha256") and fact.get("size") == origin.get("size")',
     '        content = listed', "checkpoints"),
    ("M51", "CheckpointDeadlineTests.test_the_cleanup_has_its_own_end_and_a_deadline_keeps_the_residue",   # residue released after a deadline
     '    keep = bool(events) or not cleanup["complete"]', '    keep = not cleanup["complete"]', "native"),
    # Round 7 (consult-checkpoints-r7-20261017 mutants R7-M-ROW/ABSENT/IMAGE).
    ("M52", "CheckpointLayerContractTests.test_a_closed_role_row_is_judged_against_its_bound_capture",   # a non-object row skipped
     '        if type(row) is not dict:\n            fail(role + ": the role row is not an object")',
     '        if type(row) is not dict:\n            continue', "checkpoints"),
    ("M53", "CheckpointLayerContractTests.test_a_closed_role_row_is_judged_against_its_bound_capture",   # absence not corroborated
     '            if role in present:\n                fail(role + ": recorded absent', '            if False:\n                fail(role + ": recorded absent',
     "checkpoints"),
    ("M54", "CheckpointLayerContractTests.test_a_closed_role_row_is_judged_against_its_bound_capture",   # a row's image not bound
     '        if row["image"] != present[role]["image"] or row["image"] != pins[role]:', '        if False:', "checkpoints"),
    # Round 8 (consult-checkpoints-r8-20261017 R8-06: a binding bypass, the native source mixing and a typed-refusal omission).
    ("M55", "CheckpointVerifiedCaptureTests.test_one_call_checks_the_current_bytes_against_the_bindings_and_returns_them",   # layer binding unchecked
     '    if type(raw) is not bytes or not _binding(layer_binding) or sha256(raw) != layer_binding["sha256"]:',
     '    if type(raw) is not bytes or not _binding(layer_binding):', "checkpoints"),
    ("M56", "CheckpointVerifiedCaptureTests.test_the_native_regenerated_evidence_comes_only_from_the_verified_bundle",   # caller's descriptor recorded
     '        record, descriptor = capture.layer, capture.descriptor', '        record, descriptor = capture.layer, sealed["observation"]["regenerated"]',
     "native"),
    ("M57", "CheckpointVerifiedCaptureTests.test_the_declared_fields_are_typed_refusals_at_the_judgement",   # fact kind looked up before its type
     '    if type(fact) is not dict or type(fact.get("type")) is not str or fact["type"] not in LAYER_FACT_KEYS:',
     '    if type(fact) is not dict or fact.get("type") not in LAYER_FACT_KEYS:', "checkpoints"),
    # Round 8 self-review (D1556: SRCK8-1, B9/F3).
    ("M58", "CheckpointVerifiedCaptureTests.test_a_malformed_fact_is_each_consumer_s_typed_refusal",   # bundle_inputs' B0 type unchecked
     '    require(context["b0"] is None or type(context["b0"]) is dict, "BUNDLE_INPUT_MISMATCH", "the context\'s source B0 is not an object")',
     '    pass', "checkpoints"),
    ("M59", "CheckpointVerifiedCaptureTests.test_one_call_checks_the_current_bytes_against_the_bindings_and_returns_them",   # descriptor shared
     '    def descriptor(self):\n        return json.loads(self.descriptor_raw)',
     "    def descriptor(self):\n        if '_d' not in self.__dict__:\n            self.__dict__['_d'] = json.loads(self.descriptor_raw)\n"
     "        return self.__dict__['_d']", "checkpoints"),
    # Round 9 (D1575: CKPT8-1, CKPT8-2 and one per new guard family).
    ("M60", "CheckpointTypedReadTests.test_the_named_admission_contrasts_refuse_typed_after_the_host_observation",   # loader: parent untyped
     '    require(parent is None or (type(parent) is dict and type(parent.get("manifest_sha256")) is str',
     '    require(True or parent is None or (type(parent) is dict and type(parent.get("manifest_sha256")) is str', "checkpoints"),
    ("M61", "CheckpointTypedReadTests.test_the_named_admission_contrasts_refuse_typed_after_the_host_observation",   # CKPT8-1 phase membership
     '    require(type(identity["phase_reached"]) is str and identity["phase_reached"] in CHECKPOINTS, "IDENTITY_INVALID", "phase_reached")',
     '    require(identity["phase_reached"] in CHECKPOINTS, "IDENTITY_INVALID", "phase_reached")', "checkpoints"),
    ("M62", "CheckpointTypedReadTests.test_the_named_admission_contrasts_refuse_typed_after_the_host_observation",   # CKPT8-2 parent_chain
     '                and (parent is None or (type(parent) is dict and type(parent.get("manifest_sha256")) is str)),',
     '                and True,', "checkpoints"),
    ("M63", "CheckpointTypedReadTests.test_one_mistyped_read_per_guard_is_its_caller_s_typed_refusal",   # resolve_parent segment untyped
     '    require(type(checkpoint) is dict and type(checkpoint.get("path")) is str and type(checkpoint.get("manifest_sha256")) is str,',
     '    require(True,', "checkpoints"),
    ("M64", "CheckpointTypedReadTests.test_one_mistyped_read_per_guard_is_its_caller_s_typed_refusal",   # restore_boundary owned untyped
     '    cp.require(type(stack) is dict and type(stack.get("root")) is str and type(stack.get("containers")) is dict and type(owned.get("token")) is str,',
     '    cp.require(True,', "live"),
    ("M65", "CheckpointTypedReadTests.test_the_named_admission_contrasts_refuse_typed_after_the_host_observation",   # loader: identity untyped
     '        identity_valid(manifest["identity"])\n    except Refused as error:\n        raise Refused("BUNDLE_INVALID", "identity: "',
     '        pass\n    except Refused as error:\n        raise Refused("BUNDLE_INVALID", "identity: "', "checkpoints"),
    ("M66", "CheckpointTypedReadTests.test_one_mistyped_read_per_guard_is_its_caller_s_typed_refusal",   # loader: owned untyped
     '    require(type(owned) is dict and type(owned.get("token")) is str and _texts(owned.get("projects"))',
     '    require(True or type(owned) is dict and type(owned.get("token")) is str and _texts(owned.get("projects"))', "checkpoints"),
    # r10 (D1600): omission/type guards at the restore and verified native boundaries, each killed by a behavioral assertion.
    ("M67", "CheckpointMissingReadTests.test_volume_fields_refuse_before_extraction_or_network_creation",
     'owned.get("volumes", None if spec["volumes"] else {})', 'owned.get("volumes", {})', "checkpoints"),
    ("M68", "CheckpointMissingReadTests.test_volume_fields_refuse_before_extraction_or_network_creation",
     'type(item.get("labels")) is dict\n                    and all', 'type(item.get("labels", {})) is dict\n                    and all', "checkpoints"),
    ("M69", "CheckpointMissingReadTests.test_restore_members_and_state_are_checked_before_effects",
     '    require(all(any(member["name"] == volume["member"]', '    require(True or all(any(member["name"] == volume["member"]', "checkpoints"),
    ("M70", "CheckpointMissingReadTests.test_restore_members_and_state_are_checked_before_effects",
     '    require(state.get("status") == CHECKPOINTS[checkpoint]["status"], "LOCK_MISMATCH"',
     '    require(True, "LOCK_MISMATCH"', "checkpoints"),
    ("M71", "CheckpointMissingReadTests.test_restore_members_and_state_are_checked_before_effects",
     '        require(_binding(lock) and type(state.get("lock_token")) is str',
     '        require(True or _binding(lock) and type(state.get("lock_token")) is str', "checkpoints"),
    ("M72", "CheckpointMissingReadTests.test_native_boundary_fact_shapes_refuse_before_any_a08_output",
     '        cp.require(type(facts.get("migrations")) is list', '        cp.require(True or type(facts.get("migrations")) is list', "native"),
    ("M73", "CheckpointMissingReadTests.test_native_boundary_fact_shapes_refuse_before_any_a08_output",
     '        cp.require(type(facts.get("legacy")) is dict', '        cp.require(True or type(facts.get("legacy")) is dict', "native"),
    ("M74", "CheckpointMissingReadTests.test_native_boundary_fact_shapes_refuse_before_any_a08_output",
     '        cp.require(type(facts.get("data")) is dict', '        cp.require(True or type(facts.get("data")) is dict', "native"),
    ("M75", "CheckpointMissingReadTests.test_native_realm_frame_and_resources_are_checked_before_a08",
     '        cp.require(type(facts.get("realm")) is dict', '        cp.require(True or type(facts.get("realm")) is dict', "native"),
    ("M76", "CheckpointMissingReadTests.test_native_realm_frame_and_resources_are_checked_before_a08",
     '        cp.require((type(facts.get("frame")) is dict', '        cp.require(True or (type(facts.get("frame")) is dict', "native"),
    ("M77", "CheckpointMissingReadTests.test_native_realm_frame_and_resources_are_checked_before_a08",
     '        cp.require(type(manifest["owned"]["volumes"].get("pg")) is dict and',
     '        cp.require(True or type(manifest["owned"]["volumes"].get("pg")) is dict and', "native"),
    ("M78", "CheckpointMissingReadTests.test_regenerated_detail_fields_are_checked_before_output",
     '    if not (all(_texts(descriptor.get(key))', '    if False and not (all(_texts(descriptor.get(key))', "checkpoints"),
    ("M79", "CheckpointMissingReadTests.test_native_realm_frame_and_resources_are_checked_before_a08",
     '        cp.require(type(manifest["owned"]["volumes"].get("pg")) is dict, "BUNDLE_INVALID", "native markers require the database volume")',
     '        pass', "native"),
)
RUN_ONE = textwrap.dedent("""\
    import json, sys, unittest
    sys.path.insert(0, sys.argv[3])
    sys.path.insert(0, sys.argv[1])
    sys.path.insert(2, sys.argv[2])
    import ops_release_checkpoints
    import ops_deploy_host_container_test
    import ops_release_checkpoints_native_test
    import ops_release_checkpoints_live_test
    import ops_release_checkpoints_test as contracts
    suite = unittest.defaultTestLoader.loadTestsFromName(sys.argv[4], contracts)
    result = unittest.TestResult()
    suite.run(result)
    print("MUTANT_RESULT " + json.dumps({"origins": [ops_release_checkpoints.__file__, ops_deploy_host_container_test.__file__,
                                                     ops_release_checkpoints_native_test.__file__, ops_release_checkpoints_live_test.__file__],
          "run": result.testsRun, "skipped": len(result.skipped),
          "failures": [text.strip().splitlines()[-1][:300] for _, text in result.failures],
          "errors": [text.strip().splitlines()[-1][:300] for _, text in result.errors]}))
    """)


class CheckpointMutationContracts(TempCase):
    def run_contract(self, directory, case):
        script = directory.parent / "run_one.py"
        script.write_text(RUN_ONE, encoding="utf-8")
        completed = subprocess.run([sys.executable, "-B", str(script), str(directory), str(TESTS), str(ROOT / "scripts"), case],
                                   capture_output=True, timeout=600, cwd=str(directory))
        line = next((line for line in completed.stdout.decode("utf-8", "replace").splitlines() if line.startswith("MUTANT_RESULT ")), None)
        self.assertIsNotNone(line, completed.stderr.decode("utf-8", "replace")[-3000:])
        result = json.loads(line[len("MUTANT_RESULT "):])
        for origin in result["origins"]:
            self.assertEqual(Path(origin).resolve().parent, directory.resolve(), "the copy under test was imported")
        return result

    def copies(self, base, sources, target=None, old=None, new=None):
        """<base>/tests holds both harness copies (one possibly mutated); <base>/scripts holds the one product helper the
        rehearsal module loads by its own path (emr-compose.py, copied unchanged)."""
        tests = base / "tests"
        tests.mkdir(parents=True)
        (base / "scripts").mkdir()
        shutil.copyfile(ROOT / "scripts" / "emr-compose.py", base / "scripts" / "emr-compose.py")
        for name, filename in MUTANT_TARGETS.items():
            text = sources[name].replace(old, new) if name == target else sources[name]
            (tests / filename).write_text(text, encoding="utf-8")
        return tests

    def test_m01_to_m30_each_killed_by_its_contract(self):
        """T18 (RQC-01..09, 11, CKPT-01..09, CKPT2-01..06, r5, r6, r7, r8): control PASS, then an assertion failure in the named
        contract for each mutant (M01-M44, M46-M79)."""
        sources = {name: (TESTS / filename).read_text(encoding="utf-8") for name, filename in MUTANT_TARGETS.items()}
        outcomes = []
        for identifier, case, old, new, target in MUTANTS:
            with self.subTest(mutant=identifier):
                self.assertEqual(sources[target].count(old), 1, identifier + " must apply to exactly one site")
                base = self.tempdir("kin-mutant-" + identifier.lower() + "-")
                control = self.copies(base / "control", sources)
                mutant = self.copies(base / "mutant", sources, target, old, new)
                first = self.run_contract(control, case)
                self.assertEqual((first["run"], first["failures"], first["errors"], first["skipped"]), (1, [], [], 0),
                                 identifier + " control must pass")
                second = self.run_contract(mutant, case)
                killed = second["run"] == 1 and bool(second["failures"]) and not second["errors"]
                outcomes.append({"id": identifier, "case": case, "file": MUTANT_TARGETS[target], "control": "PASS",
                                 "mutant": "KILLED" if killed else "SURVIVED", "assertion": (second["failures"] or second["errors"] or [""])[0]})
                print("MUTANT " + json.dumps(outcomes[-1]), flush=True)
                self.assertTrue(killed, identifier + " survived or errored: " + json.dumps(second))
        self.assertEqual(len(outcomes), len(MUTANTS))


if __name__ == "__main__":
    unittest.main(verbosity=2)
