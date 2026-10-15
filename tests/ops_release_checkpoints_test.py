"""RELEASE-TOOLS-CHECKPOINTS pure contracts (Astra spec D1336, order D1338). REQ/RISK/TEST ids appear in docstrings as
trace only; the assertions are on behaviour. No Docker, browser or live stack: a fake daemon backend, temporary folders,
and the real scripts/run-tests.py, tests/live_test_gate.py and scripts/record-run.py in synthetic subprocesses with their
own state directories (never the account's real ledger).

Byte pins, with their reason (AGENTS.md section 1-B item 14): CheckpointImpactTests compares raw bytes of the product
tool on purpose - the cross-tree admission is a cache contract that proves an already executed prefix is byte-identical,
so byte identity itself is the requirement. CheckpointTimeTests asserts the product's 7-day receipt age and 5-minute
skew because the spec (section 6) requires that a checkpoint never changes those contracts.

CheckpointMutationContracts (T18) applies M01-M30 to temporary copies of tests/ops_release_checkpoints.py and (M15-M17)
tests/ops_deploy_host_container_test.py only, runs the named contract against the unmodified copies (control) and the
mutant in fresh processes, and counts a kill only when the control passes and the mutant fails an assertion (an import,
launch or fixture error is not a kill). M01-M14 are the spec's contracts; M15-M30 were added by hardening round 1 for
CKPT-01..09 (one or more per finding).

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
from pathlib import Path
import shutil
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


def snapshot_fixture(state, plan, target, sid, *, running=None):
    """The product's observation schema at a boundary (intro.observed/checkpoint_valid), all facts OK."""
    side = "release" if state["checkout"] == "target" else "previous"
    desired = set(intro.ROLES) if intro.BOUNDARY_RUNNING[sid] == "all" else set(intro.BOUNDARY_RUNNING[sid].split())
    desired = desired if running is None else running
    containers = {role: {"outcome": "OK", "value": {"id": "c" + str(index) * 8, "image": plan[side]["images"][role],
                                                     "running": role in desired, "restarting": False, "project": target["project"],
                                                     "service": role}} for index, role in enumerate(intro.ROLES)}
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
    """A synthetic daemon: owned containers/volumes of PROJECT, optional foreign resources, recorded calls."""

    def __init__(self, names, volumes=None, *, foreign=(), running=None):
        self.calls, self.names = [], names
        running = set(intro.ROLES) if running is None else running
        self.containers = {name: {"id": "id-" + name, "name": name, "labels": {"com.docker.compose.project": PROJECT},
                                  "running": role in running} for role, name in names.items() if role in intro.ROLES}
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
        return [call for call in self.calls if call[0] not in ("inventory", "volume_exists", "diff")]


LEGACY = {"roles": [["kin_legacy_group", False, False, -1], ["kin_legacy_reader", False, True, 3]],
          "members": ["kin_legacy_group>kin_legacy_reader"], "schema_owner": "kin_legacy_group", "table_acl": "{kin_legacy_reader=r/kin}",
          "column_acl": "{kin_legacy_group=r/kin}", "type_acl": "{kin_legacy_reader=U/kin}", "database_acl": "{kin_legacy_reader=c/kin}"}
B0_MANIFESTS = {"source": b'{"b0":"source"}\n', "clone": b'{"b0":"clone"}\n', "failure": b'{"b0":"failure"}\n'}


def realistic(root, checkpoint_id, *, tamper=None):
    """A completed boundary inside a fixture root as the harness binds it: the lineage stack's state and result, the
    sibling secrets, the Compose pointer, the ledger, the lock, the stage context (with the stack's plan document and
    target), the source B0 and its seed copy, the stack's own B0 - and the identity of exactly those bytes. `tamper`
    may change the context, state or B0 files after the identity was taken (a bundle whose bytes contradict it)."""
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
        files["lock"] = (stack + "/repo/.kin-ops.lock", (parts["state"].get("lock_token") or "").encode())
    bindings = {}
    for name, (rel, value) in files.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(value)
        bindings[name] = {"path": rel, "sha256": hashlib.sha256(value).hexdigest()}
    return SimpleNamespace(plan=plan, target=target, state=parts["state"], result=result, raw=raw, bindings=bindings, identity=identity,
                           root=root)


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
    state, result, raw = made.state, made.result, made.raw
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
    boundary = cp.boundary_publishable(checkpoint_id, state=state, result=result, result_raw=raw)
    return pending.seal(identity=made.identity, boundary=boundary, bindings=bindings,
                        owned={"token": TOKEN, "projects": [PROJECT], "volumes": {}, "networks": []}, execution_kind="fresh",
                        parent=parent, derived=derived)


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


class CheckpointRestoreTests(RefusalAssertions, TempCase):
    def captured(self, checkpoint_id, backend=None, *, running=None):
        target = target_fixture()
        names = {role: target["containers"][role] for role in intro.ROLES}
        volumes = {**target["volumes"], "proxy_certs": PROJECT + "_proxy-certs"}
        backend = backend or FakeBackend(names, volumes, running=running)
        fixture = self.tempdir()
        made = realistic(fixture, checkpoint_id)
        store = cp.BundleStore(self.tempdir() / "bundles", forbidden=[fixture])
        boundary = cp.boundary_publishable(checkpoint_id, state=made.state, result=made.result, result_raw=made.raw)
        final = cp.capture_checkpoint(checkpoint_id=checkpoint_id, store=store, backend=backend, boundary=boundary, names=names,
                                      volumes=volumes, fixture_root=fixture, bindings=made.bindings, identity=made.identity,
                                      owned={"token": TOKEN, "projects": {PROJECT}, "networks": [{"name": PROJECT + "-halo",
                                                                                                   "labels": {"kin.ops.run": TOKEN}}]},
                                      execution_kind="fresh")
        return final, backend, names, fixture

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
            fresh = FakeBackend(names, {}, running=set())
            fresh.containers.clear()
            altered = self.tempdir() / ("f" * 64)
            shutil.copytree(directory, altered)
            tree = altered / "payload" / "fixture-tree.tar"
            work = self.tempdir()
            cp.extract_tree(tree, work / "x")
            (work / "x" / "clone/repo/.kin-ops.lock").write_text("another-token")
            tree.unlink()
            cp.write_tree_archive(work / "x", tree)
            self.assertRefused("LOCK_MISMATCH", cp.restore_checkpoint, manifest, altered, backend=fresh, fixture_root=self.tempdir() / "r",
                               names=names, images_present=lambda image_id: True, observe=lambda sid: None)
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
    """T14 / CKPT-02: the real scripts/record-run.py around a synthetic leaf command in a real proof layout; the evidence
    index derives every expectation from that layout (registry, plan, request, source and parent manifests)."""

    UNIT = "release-tools-checkpoints-proof-prefix-seed"
    COMMAND = textwrap.dedent("""\
        import hashlib, json, sys
        from pathlib import Path
        spec = json.loads(Path(sys.argv[1]).read_text())
        mode, run_dir = spec["mode"], Path(sys.argv[2])
        print("EXACT_TESTS " + json.dumps(spec["tests"] if mode != "selection" else ["other.Case.test_x"]))
        if mode == "change-input":
            Path("tests/ops_release_checkpoints.py").write_text("# changed during the run\\n")
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

    def layout(self):
        """A proof root as `commands` lays it out: registry, plan, the leaf's source copy and manifest, a sealed parent
        manifest in the shared store, the request; and a segment that satisfies the expectation."""
        root = self.tempdir("kin-proof-")
        leaves = [dict(leaf) for leaf in cp.DEFAULT_PROOF_LEAVES]
        (root / "registry.json").write_bytes(cp.canonical(leaves) + b"\n")
        leaf = cp.registry_leaf(leaves, self.UNIT)
        (root / ("plan-" + self.UNIT + ".json")).write_bytes(cp.canonical(cp.leaf_plan(leaves, self.UNIT)) + b"\n")
        copy_root = root / leaf["source"]
        for name in cp.LEAF_INPUT_FILES + ("scripts/tool.py",):
            (copy_root / name).parent.mkdir(parents=True, exist_ok=True)
            (copy_root / name).write_bytes(("# " + name + "\n").encode())
        inputs = {"tool": "1" * 64, "source": "2" * 64, "harness": "3" * 64, "tool_files": {}}
        source = {"schema": 1, "kind": "release-tools-source", "root": str(copy_root), "tool": {"sha256": "1" * 64},
                  "source": {"sha256": "2" * 64}, "harness": {"sha256": "3" * 64}, "tool_files": {}}
        source_path = root / (leaf["source"] + ".source-manifest.json")
        source_path.write_bytes(cp.canonical(source) + b"\n")
        parent_raw = b'{"checkpoint":"source-b0","kind":"release-tools-checkpoint","lineage":"source"}\n'
        parent_sha = hashlib.sha256(parent_raw).hexdigest()
        parent_path = root / "out" / "bundles" / parent_sha / "manifest.json"
        parent_path.parent.mkdir(parents=True)
        parent_path.write_bytes(parent_raw)
        request = {"schema": 1, "unit": self.UNIT, "case": leaf["case"], "scenario": leaf["scenario"], "stage": leaf["stage"],
                   "execution_kind": leaf["execution_kind"], "parent_manifest": {"path": str(parent_path), "sha256": parent_sha},
                   "source_manifest": {"path": str(source_path), "sha256": hashlib.sha256(source_path.read_bytes()).hexdigest()},
                   "output_root": str(root / "out"), "evidence_root": str(root / "evidence" / self.UNIT)}
        request_raw = cp.canonical(request) + b"\n"
        (root / ("request-" + self.UNIT + ".json")).write_bytes(request_raw)
        expectation = cp.leaf_expectation(leaves, self.UNIT, root)
        now = datetime.now(timezone.utc).isoformat()
        marker = {"unit": self.UNIT, "module": leaf["file"], "plan_sha256": expectation["expect"]["marker_plan_sha256"], "attempt": 1,
                  "pid": 4242, "started_at": now}
        current = cp.current_identity(inputs, execution_kind=leaf["execution_kind"], plan_sha256="6" * 64, root=copy_root, resumed_utc=now)
        identity = {"parent": identity_fixture(phase_reached="source-b0"), "current": current,
                    "parent_reference": {"manifest_sha256": parent_sha, "payload_manifest_sha256": "0" * 64, "checkpoint": "source-b0",
                                         "lineage": "source"}}
        segment = cp.segment_record(
            request={key: leaf[key] for key in ("unit", "case", "stage", "scenario", "execution_kind")},
            request_sha256=hashlib.sha256(request_raw).hexdigest(), marker=marker, identity=identity, executed_phases=["seed"],
            inherited_phases=["capture"], results={"checkpoint": {"path": str(root / "out" / "bundles" / ("e" * 64)), "manifest_sha256": "e" * 64}},
            cleanup={"complete": True, "removed": ["x"], "remaining": [], "errors": []}, run_json="(the command sets it)", started_utc=now,
            ended_utc=now, selected_tests=[leaf["case"]],
            phase_results=[{"stack": "clone", "file": "result-seed-1.json", "sha256": "a" * 64, "phase": "seed", "status": "SEEDED",
                            "steps": [["S-01", "PASS"]]}],
            raw_records=[["records-clone/state.json", "b" * 64]], inputs_before=inputs, inputs_after=inputs,
            parent_chain=[{"manifest_sha256": parent_sha, "checkpoint": "source-b0", "execution_kind": "fresh", "payload_manifest_sha256": "0" * 64}])
        segment.update(observed={"outcome": "PASS"}, expected={"outcome": "PASS"}, passed=True)
        command = root / "command.py"
        command.write_text(self.COMMAND, encoding="utf-8")
        return SimpleNamespace(root=root, leaves=leaves, expectation=expectation, segment=segment, copy_root=copy_root, command=command)

    def record(self, proof, mode="ok", *, changes=None, files=None, run="1"):
        spec = proof.root / ("spec-" + run + ".json")
        spec.write_text(json.dumps({"mode": mode, "tests": proof.expectation["expected_tests"], "segment": proof.segment,
                                    "segment_path": str(proof.expectation["segment_path"]), "changes": changes}), encoding="utf-8")
        run_dir = proof.root / "runs" / (self.UNIT + "-" + run)
        declared = proof.expectation["required_files"] if files is None else files
        completed = subprocess.run([sys.executable, "-B", str(RECORDER), "--run-dir", str(run_dir), "--cwd", str(proof.copy_root),
                                    *[item for name in declared for item in ("--file", name)], "--tree", "scripts", "--",
                                    sys.executable, "-B", str(proof.command), str(spec), str(run_dir)], capture_output=True, timeout=120)
        return run_dir, completed

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
                proof = self.layout()
                run_dir, completed = self.record(proof, **kwargs)
                verdict = cp.leaf_index(proof.leaves, self.UNIT, proof.root, run_dir)
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
            self.assertEqual(cp.leaf_index(proof.leaves, self.UNIT, proof.root, self.tempdir())["verdict"], "UNVERIFIED")
        with self.subTest(refused="a plan that is not the leaf's registered plan"):
            proof = self.layout()
            (proof.root / ("plan-" + self.UNIT + ".json")).write_bytes(
                cp.canonical(cp.leaf_plan(proof.leaves, self.UNIT, timeout_seconds=600)) + b"\n")
            self.assertRefused("INDEX_INPUT", cp.leaf_expectation, proof.leaves, self.UNIT, proof.root)


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
        store = self.tempdir() / "bundles"
        return cp.load_bundle(seal(self, store, checkpoint_id, tamper=tamper))

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

    def bind(self, root, unit, bundle, *, verdict="BOUND"):
        """A parent leaf's index as `index` writes it, over a segment that names the bundle it sealed."""
        segment = root / "evidence" / unit / "segment.json"
        segment.parent.mkdir(parents=True)
        segment.write_bytes(cp.canonical({"results": {"checkpoint": {"path": str(bundle), "manifest_sha256": bundle.name}}}) + b"\n")
        (root / "index").mkdir(exist_ok=True)
        (root / "index" / (unit + ".json")).write_bytes(cp.canonical({"verdict": verdict, "unit": unit, "segment": str(segment),
                                                                       "segment_sha256": hashlib.sha256(segment.read_bytes()).hexdigest(),
                                                                       "run_dir": str(root / "runs" / (unit + "-1"))}) + b"\n")
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
        self.bind(root, unit("prefix-introduce"), sealed["introduced"])
        for name, source in (("late-resume", "b"), ("early-refusal", "c"), ("prefix-verify", "a")):
            with self.subTest(request=name):
                request = self.admitted(cp.leaf_request, leaves, unit(name), root)
                self.assertEqual(request["parent_manifest"], {"path": str((sealed["introduced"] / "manifest.json").resolve()),
                                                              "sha256": sealed["introduced"].name})
                self.assertEqual(Path(request["source_manifest"]["path"]).name, source + ".source-manifest.json")
                self.assertEqual((request["output_root"], request["evidence_root"]),
                                 (str((root / "out").resolve()), str((root / "evidence" / unit(name)).resolve())))
                path = root / ("request-" + unit(name) + ".json")
                path.write_bytes(cp.canonical(request) + b"\n")
                loaded, _ = self.admitted(cp.load_request, str(path), leaves, case=request["case"])
                self.assertEqual(loaded["unit"], unit(name))
        self.assertRefused("REQUEST_INVALID", cp.leaf_request, leaves, unit("fresh-control"), root)
        self.bind(root, unit("prefix-verify"), sealed["introduced"])
        with self.subTest(refused="a parent index whose leaf sealed another checkpoint"):
            self.assertRefused("PARENT_UNBOUND", cp.leaf_request, leaves, unit("late-fault"), root)
        with self.subTest(refused="a parent segment changed after its index"):
            segment = root / "evidence" / unit("prefix-introduce") / "segment.json"
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
                                  "KIN_TEST_EMR_REHEARSAL_EVIDENCE=/srv/proof/evidence/" + leaf["unit"] + " ", line)
                    self.assertNotIn("request-", line)
                else:
                    self.assertIn("KIN_TEST_EMR_CHECKPOINT_REQUEST=/srv/proof/request-" + leaf["unit"] + ".json ", line)
                    self.assertIn("--file /srv/proof/request-" + leaf["unit"] + ".json ", line)
                    self.assertEqual("parent-manifest --request" in line, leaf["parent"] is not None)
                self.assertIn("index --registry /srv/proof/registry.json --unit " + leaf["unit"] + " --proof-root /srv/proof --run-dir "
                              "/srv/proof/runs/" + leaf["unit"] + "-1", script)
        order = [script.index("# " + leaf["unit"] + ":") for leaf in leaves]
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
        self.assertEqual(expectation["segment_path"], root / "evidence" / unit("fresh-control") / "segment.json")

    def fresh_layout(self, root, leaves):
        name = "release-tools-checkpoints-proof-fresh-control"
        (root / ("plan-" + name + ".json")).write_bytes(cp.canonical(cp.leaf_plan(leaves, name)) + b"\n")
        (root / "b.source-manifest.json").write_bytes(cp.canonical({"root": str(root / "b"), "tool": {"sha256": "1" * 64},
                                                                     "source": {"sha256": "2" * 64}, "harness": {"sha256": "3" * 64}}) + b"\n")
        return root


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


# ── T18: mutants of the checkpoint logic (temporary copies of the harness files only) ──

# The harness file each mutant edits (a temporary copy; the product scripts are never copied or changed).
MUTANT_TARGETS = {"checkpoints": "ops_release_checkpoints.py", "rehearsal": "ops_deploy_host_container_test.py"}
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
     '    require(plan_sha == descriptor["plan_sha256"] == identity["plan_sha256"] == state.get("plan_sha256"), "BUNDLE_INPUT_MISMATCH",',
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
     '            if len(set(image["tags"])) < 2:', '            if False:', "checkpoints"),
)
RUN_ONE = textwrap.dedent("""\
    import json, sys, unittest
    sys.path.insert(0, sys.argv[3])
    sys.path.insert(0, sys.argv[1])
    sys.path.insert(2, sys.argv[2])
    import ops_release_checkpoints
    import ops_deploy_host_container_test
    import ops_release_checkpoints_test as contracts
    suite = unittest.defaultTestLoader.loadTestsFromName(sys.argv[4], contracts)
    result = unittest.TestResult()
    suite.run(result)
    print("MUTANT_RESULT " + json.dumps({"origins": [ops_release_checkpoints.__file__, ops_deploy_host_container_test.__file__],
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
        """T18 (RQC-01..09, 11, CKPT-01..09): control PASS, then an assertion failure in the named contract for each mutant."""
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
        self.assertEqual(len(outcomes), 30)


if __name__ == "__main__":
    unittest.main(verbosity=2)
