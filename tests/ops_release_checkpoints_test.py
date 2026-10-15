"""RELEASE-TOOLS-CHECKPOINTS pure contracts (Astra spec D1336, order D1338). REQ/RISK/TEST ids appear in docstrings as
trace only; the assertions are on behaviour. No Docker, browser or live stack: a fake daemon backend, temporary folders,
and the real scripts/run-tests.py, tests/live_test_gate.py and scripts/record-run.py in synthetic subprocesses with their
own state directories (never the account's real ledger).

Byte pins, with their reason (AGENTS.md section 1-B item 14): CheckpointImpactTests compares raw bytes of the product
tool on purpose - the cross-tree admission is a cache contract that proves an already executed prefix is byte-identical,
so byte identity itself is the requirement. CheckpointTimeTests asserts the product's 7-day receipt age and 5-minute
skew because the spec (section 6) requires that a checkpoint never changes those contracts.

CheckpointMutationContracts (T18) applies M01-M14 to a temporary copy of tests/ops_release_checkpoints.py only, runs the
named contract against the unmodified copy (control) and the mutant in fresh processes, and counts a kill only when the
control passes and the mutant fails an assertion (an import, launch or fixture error is not a kill).
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


def target_fixture():
    names = {role: PROJECT + "-" + role for role in (*intro.ROLES, *intro.ONE_SHOTS)}
    return {"schema": 1, "kind": "rehearsal", "host_key_sha256": "b" * 64, "origin": "https://localhost:21443", "project": PROJECT,
            "repository": "/srv/fixture/clone/repo",
            "compose_files": ["docker-compose.yml", "docker-compose.prod.yml", "/srv/fixture/clone/rehearsal-override.yml"],
            "containers": names, "volumes": {"pg": PROJECT + "_pg-db", "orthanc": PROJECT + "_orthanc-db",
                                             "emr_access": PROJECT + "_emr-access", "emr_state": PROJECT + "_emr-state"},
            "networks": {"default": PROJECT + "_default", "workflow": PROJECT + "-workflow"},
            "ports": {"maintenance": "127.0.0.1:21444:443", "public": ["127.0.0.1:21443:443"]},
            "tls_certificate": "/etc/nginx/certs/kin.crt", "cron": None, "ca_file": "/srv/fixture/clone/clone-ca.pem",
            "keycloak_admin": "kin-clone-admin", "external_networks": {}, "declared_overlays": [], "tracked_overlay_reconcile": [],
            "fix_checkout_mode": False}


def plan_fixture(target=None):
    target = target or target_fixture()
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
            "backup_root": "/srv/fixture/clone/backups", "tool": {name: "9" * 64 for name in intro.TOOL_FILES},
            "seed": {"b0_dir": "/srv/fixture/b0-copy/emr-b0", "b0_manifest_sha256": "8" * 64, "production_plan_sha256": "7" * 64},
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
        self.images, self.loaded = set(), []

    def inventory(self):
        self.calls.append(("inventory",))
        if self.fail_inventory:
            raise RuntimeError("daemon unreachable")
        return {kind: [dict(item) for item in getattr(self, kind).values()] for kind in ("containers", "volumes", "networks")}

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
        table = getattr(self, kind)
        name = next(key for key, item in table.items() if item.get("id") == ident or key == ident)
        if name not in self.sticky:
            del table[name]

    def mutations(self):
        return [call for call in self.calls if call[0] not in ("inventory", "volume_exists", "diff")]


def fixture_tree(root, checkpoint_id, state, result_raw):
    """Fixture files a checkpoint binds: state, result, the sibling secrets, the Compose pointer, the ledger, the lock
    and the harness context. Returns {binding: {"path", "sha256"}}."""
    files = {"state": ("clone/records/state.json", intro.canonical(state) + b"\n"),
             "result": ("clone/records/result-phase.json", result_raw),
             "secrets": ("clone/records.secrets/compose-env-values.json", json.dumps({"VALUE": SECRET_VALUE}).encode()),
             "compose_entry": ("clone/compose-entries/active.json", b'{"generation":"1","sha256":"2"}\n'),
             "ledger": ("clone/backups/audit-ledger.json", b'{"entries":[]}\n'),
             "context": ("checkpoint-context.json", b'{"schema":1}\n')}
    if cp.CHECKPOINTS[checkpoint_id]["lock"]:
        files["lock"] = ("clone/repo/.kin-ops.lock", (state.get("lock_token") or "").encode())
    bindings = {}
    for name, (rel, raw) in files.items():
        path = Path(root) / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
        bindings[name] = {"path": rel, "sha256": hashlib.sha256(raw).hexdigest()}
    return bindings


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


def seal(test, store_root, checkpoint_id, *, faults=None, absent=(), drop=(), extra_bindings=None, fixture=None):
    plan, state, result, raw = boundary_fixture(checkpoint_id)
    fixture = fixture or test.tempdir("kin-fixture-")
    bindings = fixture_tree(fixture, checkpoint_id, state, raw)
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
    return pending.seal(identity=identity_fixture(phase_reached=checkpoint_id), boundary=boundary, bindings=bindings,
                        owned={"token": TOKEN, "projects": [PROJECT], "volumes": {}, "networks": []}, execution_kind="fresh")


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
                    plan, state, result, raw_result = boundary_fixture("introduced")
                    fixture = self.tempdir()
                    bindings = fixture_tree(fixture, "introduced", state, raw_result)
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
        plan, state, result, raw = boundary_fixture(checkpoint_id)
        fixture = self.tempdir()
        bindings = fixture_tree(fixture, checkpoint_id, state, raw)
        store = cp.BundleStore(self.tempdir() / "bundles", forbidden=[fixture])
        boundary = cp.boundary_publishable(checkpoint_id, state=state, result=result, result_raw=raw)
        final = cp.capture_checkpoint(checkpoint_id=checkpoint_id, store=store, backend=backend, boundary=boundary, names=names,
                                      volumes=volumes, fixture_root=fixture, bindings=bindings,
                                      identity=identity_fixture(phase_reached=checkpoint_id),
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
                      "absolute_fixture_root": "/srv/checkpoints/fixture", "gate_state": str(self.state)}
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
                 "absolute_fixture_root": "/srv/checkpoints/fixture", "is_root": True, "systemd": True}
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
                ("another root", {"absolute_fixture_root": "/srv/other"}, "HOST_MISMATCH")):
            with self.subTest(refused=name):
                self.assertRefused(code, cp.host_admission, {**facts, **change}, expected)
        with self.subTest(refused="no live permission in this process"):
            with self.assertRaises(gate.Refused):
                cp.host_admission(facts, expected, gate=gate)


class CheckpointRecordTests(RefusalAssertions, TempCase):
    SCRIPT = textwrap.dedent("""\
        import json, os, sys
        from pathlib import Path
        evidence, run_dir, mode = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
        print("EXACT_TESTS " + json.dumps(["ops_release_checkpoints_live_test.CheckpointSegments.test_seed_checkpoint"]
                                          if mode != "selection" else ["other.Case.test_x"]))
        if mode == "change-input":
            Path("input.json").write_text('{"changed": true}')
        if mode != "no-segment":
            evidence.mkdir(parents=True, exist_ok=True)
            (evidence / "segment.json").write_text(json.dumps({"run_json": str((run_dir if mode != "other-run" else run_dir.parent) / "run.json"),
                                                              "cleanup": {"complete": mode != "cleanup-failed"}, "skipped": 0}))
        sys.exit(1 if mode == "exit" else 0)
        """)

    def record(self, mode, *, declare_missing=False):
        work = self.tempdir("kin-checkpoint-record-")
        (work / "input.json").write_text('{"changed": false}')
        (work / "command.py").write_text(self.SCRIPT)
        run_dir, evidence = work / "runs" / "run-1", work / "evidence"
        files = ["--file", "input.json"] + (["--file", "missing.json"] if declare_missing else [])
        completed = subprocess.run([sys.executable, "-B", str(RECORDER), "--run-dir", str(run_dir), "--cwd", str(work), *files, "--",
                                    sys.executable, "-B", "command.py", str(evidence), str(run_dir), mode], capture_output=True, timeout=60)
        return work, run_dir, evidence, completed

    def index(self, run_dir, evidence, declared=("input.json",)):
        return cp.evidence_index(run_dir, segment_path=evidence / "segment.json", declared_inputs=list(declared),
                                 expected_tests=["ops_release_checkpoints_live_test.CheckpointSegments.test_seed_checkpoint"])

    def test_existing_record_run_binds_exact_inputs_outputs_and_exit(self):
        """T14 (RQC-03/05/06/11): the real recorder; AND of run.json, logs, inputs, exact selection and segment."""
        work, run_dir, evidence, completed = self.record("ok")
        self.assertEqual(completed.returncode, 0, completed.stderr)
        bound = self.index(run_dir, evidence)
        self.assertEqual(bound["verdict"], "BOUND", bound["reasons"])
        self.assertEqual(bound["run_json_sha256"], hashlib.sha256((run_dir / "run.json").read_bytes()).hexdigest())
        self.assertEqual(bound["segment_sha256"], hashlib.sha256((evidence / "segment.json").read_bytes()).hexdigest())
        self.assertNotIn("segment_sha256", json.loads((evidence / "segment.json").read_bytes()), "no circular hash")
        again = subprocess.run([sys.executable, "-B", str(RECORDER), "--run-dir", str(run_dir), "--cwd", str(work), "--",
                                sys.executable, "-c", "print(1)"], capture_output=True, timeout=60)
        self.assertEqual(again.returncode, 125, "a run directory is never reused")
        cases = {"change-input": {}, "exit": {}, "no-segment": {}, "other-run": {}, "cleanup-failed": {}, "selection": {},
                 "missing-input": {"declare_missing": True}}
        for mode, kwargs in cases.items():
            with self.subTest(refused=mode):
                work, run_dir, evidence, completed = self.record("ok" if mode == "missing-input" else mode, **kwargs)
                declared = ("input.json", "missing.json") if mode == "missing-input" else ("input.json",)
                verdict = self.index(run_dir, evidence, declared)
                self.assertEqual(verdict["verdict"], "UNVERIFIED", mode)
                self.assertTrue(verdict["reasons"])
        with self.subTest(refused="stderr tampered after recording"):
            work, run_dir, evidence, completed = self.record("ok")
            with open(run_dir / "stderr.log", "ab") as stream:
                stream.write(b"appended later\n")
            self.assertEqual(self.index(run_dir, evidence)["verdict"], "UNVERIFIED")
        with self.subTest(refused="no run.json"):
            self.assertEqual(cp.evidence_index(self.tempdir(), segment_path=evidence / "segment.json", expected_tests=[],
                                               declared_inputs=[])["verdict"], "UNVERIFIED")


class CheckpointScenarioTests(RefusalAssertions, unittest.TestCase):
    def test_fresh_scenarios_keep_their_phase_and_data_contracts(self):
        """T15 (RQC-01/12): the explicit stage table; failures propagate; a request never shortens a fresh method."""
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
        selected = runner.module_plan(cp.REHEARSAL_FILE, "selection-only", "live", 3600, "EmrIntroductionRehearsal")["tests"]
        self.assertEqual(sorted(item["case"] for item in selected), sorted(cp.FRESH_CASES.values()))
        loaded = unittest.defaultTestLoader.loadTestsFromModule(rehearsal)
        names = sorted(test.id().split(".", 1)[1] for suite in loaded for test in suite)
        self.assertEqual(names, sorted(["ContainerTests.test_real_target_and_previous_preserve_database", *cp.FRESH_CASES.values()]))
        import ops_release_checkpoints_live_test as live
        live_cases = sorted("CheckpointSegments." + name for name in unittest.defaultTestLoader.getTestCaseNames(live.CheckpointSegments))
        self.assertEqual(live_cases, sorted({item["case"] for item in cp.STAGES.values()} | set(cp.PROOF_CASES)))
        self.assertEqual({leaf["case"] for leaf in cp.DEFAULT_PROOF_LEAVES if leaf["file"] == cp.LIVE_FILE} - set(live_cases), set())


# ── T18: mutants of the checkpoint logic (temporary copies of tests/ops_release_checkpoints.py only) ──

MUTANTS = (
    ("M01", "CheckpointBoundaryTests.test_only_completed_quiet_pre_ponr_boundaries_publish",
     'require(state.get("status") == spec["status"] and state.get("running") is None and state.get("unknown_hold") is None,',
     'require(state.get("status") == spec["status"],'),
    ("M02", "CheckpointBundleTests.test_complete_private_bundle_is_atomic_and_secret_free_in_evidence",
     'require(digest.hexdigest() == member["sha256"], "BUNDLE_INVALID", "member hash " + name)', 'pass'),
    ("M03", "CheckpointIdentityTests.test_actual_bytes_and_all_bound_inputs_must_match",
     'return [key for key in fields if recorded.get(key) != observed.get(key)]',
     'b0 = ("source_b0_manifest_sha256", "clone_b0_manifest_sha256")\n'
     '    pair = lambda value: sorted(str(value.get(key)) for key in b0)\n'
     '    return [key for key in fields if key not in b0 and recorded.get(key) != observed.get(key)] + (["b0"] if pair(recorded) != pair(observed) else [])'),
    ("M04", "CheckpointIdentityTests.test_actual_bytes_and_all_bound_inputs_must_match",
     'require(all(type(item) is str and IMAGE_ID.fullmatch(item) for item in flat), "IDENTITY_INVALID", "image_ids." + side)',
     'require(all(type(item) is str and item for item in flat), "IDENTITY_INVALID", "image_ids." + side)'),
    ("M05", "CheckpointIdentityTests.test_actual_bytes_and_all_bound_inputs_must_match",
     '    if source_root is not None:\n        actual = source_identity(source_root, helpers=helpers)',
     '    if False:\n        actual = source_identity(source_root, helpers=helpers)'),
    ("M06", "CheckpointImpactTests.test_closed_body_changes_select_only_unexecuted_phases",
     '(changed if body in ALLOWLIST else prefix).append(body)',
     '(changed if body in ALLOWLIST or body.startswith("HostOps.") else prefix).append(body)'),
    ("M07", "CheckpointForkTests.test_real_plan_and_compose_binding_preserve_parent_and_deny_receipt",
     'child["compose_entry"] = {**child_pointer, "root": parent_state["compose_entry"]["root"]}',
     'child["compose_entry"] = dict(parent_state["compose_entry"])'),
    ("M08", "CheckpointForkTests.test_real_plan_and_compose_binding_preserve_parent_and_deny_receipt",
     'child["history"] = []', 'child["history"] = list(parent_state.get("history") or [])'),
    ("M09", "CheckpointClaimTests.test_inherited_or_missing_segments_never_become_fresh_pass",
     '"fresh_e2e": kind == "fresh" and request["stage"] is None,', '"fresh_e2e": kind in ("fresh", "checkpoint-resume"),'),
    ("M10", "CheckpointBudgetTests.test_real_runner_preserves_leaf_attempts_and_refusals",
     'leaf = next((item for item in registry_valid(leaves) if item["unit"] == request["unit"]), None)',
     'leaf = next((item for item in registry_valid(leaves) if request["unit"].startswith(item["unit"])), None)'),
    ("M11", "CheckpointGateTests.test_permission_slot_and_marker_precede_every_mutation",
     '    path = Path(evidence_root) / "segment.json"\n',
     '    path = Path(evidence_root) / "segment.json"\n    if not passed:\n        (Path(gate.STATE) / "live-needs-inspection.json").unlink(missing_ok=True)\n'),
    ("M12", "CheckpointCleanupTests.test_only_owned_resources_are_removed_and_absence_is_observed",
     'or labels.get("com.docker.compose.project") in owned["projects"])',
     'or labels.get("com.docker.compose.project") in owned["projects"]\n'
     '            or any(str(item.get("name", "")).startswith(project) for project in owned["projects"]))'),
    ("M13", "CheckpointTimeTests.test_expiry_and_real_time_inputs_are_not_rewritten",
     'require(current + timedelta(seconds=suffix_seconds + teardown_seconds) <= deadline, "EXPIRED",',
     'require(True, "EXPIRED",'),
    ("M14", "CheckpointRecordTests.test_existing_record_run_binds_exact_inputs_outputs_and_exit",
     'elif first["sha256"] != last["sha256"]:', 'elif False:'),
)
RUN_ONE = textwrap.dedent("""\
    import json, sys, unittest
    sys.path.insert(0, sys.argv[3])
    sys.path.insert(0, sys.argv[1])
    sys.path.insert(2, sys.argv[2])
    import ops_release_checkpoints
    import ops_release_checkpoints_test as contracts
    suite = unittest.defaultTestLoader.loadTestsFromName(sys.argv[4], contracts)
    result = unittest.TestResult()
    suite.run(result)
    print("MUTANT_RESULT " + json.dumps({"origin": ops_release_checkpoints.__file__, "run": result.testsRun,
          "skipped": len(result.skipped), "failures": [text.strip().splitlines()[-1][:300] for _, text in result.failures],
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
        self.assertEqual(Path(result["origin"]).resolve().parent, directory.resolve(), "the copy under test was imported")
        return result

    def test_m01_to_m14_each_killed_by_its_contract(self):
        """T18 (RQC-01..09, 11): control PASS, then an assertion failure in the named contract for each mutant."""
        source = (TESTS / "ops_release_checkpoints.py").read_text(encoding="utf-8")
        outcomes = []
        for identifier, case, old, new in MUTANTS:
            with self.subTest(mutant=identifier):
                self.assertEqual(source.count(old), 1, identifier + " must apply to exactly one site")
                base = self.tempdir("kin-mutant-" + identifier.lower() + "-")
                control, mutant = base / "control" / "tests", base / "mutant" / "tests"
                control.mkdir(parents=True)
                mutant.mkdir(parents=True)
                (control / "ops_release_checkpoints.py").write_text(source, encoding="utf-8")
                (mutant / "ops_release_checkpoints.py").write_text(source.replace(old, new), encoding="utf-8")
                first = self.run_contract(control, case)
                self.assertEqual((first["run"], first["failures"], first["errors"], first["skipped"]), (1, [], [], 0),
                                 identifier + " control must pass")
                second = self.run_contract(mutant, case)
                killed = second["run"] == 1 and bool(second["failures"]) and not second["errors"]
                outcomes.append({"id": identifier, "case": case, "control": "PASS", "mutant": "KILLED" if killed else "SURVIVED",
                                 "assertion": (second["failures"] or second["errors"] or [""])[0]})
                print("MUTANT " + json.dumps(outcomes[-1]), flush=True)
                self.assertTrue(killed, identifier + " survived or errored: " + json.dumps(second))
        self.assertEqual(len(outcomes), 14)


if __name__ == "__main__":
    unittest.main(verbosity=2)
