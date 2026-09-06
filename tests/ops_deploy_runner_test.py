"""C1RUN contracts: real temporary Git, journal and process locks; synthetic host.

Docker inspection/replace/smoke/notification are simulated, never operational.
"""
from dataclasses import FrozenInstanceError
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import ops_backup as ops
import ops_deploy_preflight as pre
import ops_deploy_runner as runner


class SyntheticHost:
    def __init__(self, root):
        self.root = root
        self.calls = []
        self.events = []
        self.notifications = []
        self.faults = {}
        self.competitor_phases = set()
        self.images = ("sha256:" + "c" * 64, "sha256:" + "d" * 64)
        self.git("init")
        self.git("config", "user.email", "fixture@example.invalid")
        self.git("config", "user.name", "Synthetic C1 host")
        for relative in pre.PROTECTED:
            path = root / relative
            if "." not in path.name:
                path = path / "fixture.txt"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("fixed configuration\n")
        app = root / "api/app.txt"
        app.write_text("previous\n")
        self.git("add", "--all")
        self.git("commit", "-m", "previous")
        previous = self.git("rev-parse", "HEAD")
        app.write_text("target\n")
        self.git("add", "api/app.txt")
        self.git("commit", "-m", "target")
        target = self.git("rev-parse", "HEAD")
        self.git("checkout", "--detach", previous)
        self.body = {"version": 1, "previous_sha": previous, "target_sha": target,
                     "previous_api_image": self.images[0], "target_api_image": self.images[1],
                     "compose_files": list(pre.COMPOSE)}
        self.raw = json.dumps(self.body).encode()
        self.digest = hashlib.sha256(self.raw).hexdigest()
        self.runtime = root / "runtime.json"
        self.runtime.write_text(json.dumps({"sha": previous, "image": self.images[0]}))
        self.data = root / "synthetic-data.txt"
        self.data.write_bytes(b"synthetic report history must survive\n")
        self.journal = root / "journal.jsonl"

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.root, stderr=subprocess.PIPE).decode().strip()

    def call(self, phase):
        self.calls.append(phase)
        assert (self.root / ".kin-ops.lock").is_file(), "adapter call escaped shared lock"
        if phase in self.competitor_phases:
            source = ("import sys,pathlib;sys.path.insert(0,sys.argv[1]);import ops_backup as o;"
                      "o.ROOT=pathlib.Path(sys.argv[2]);\nwith o.lock(): pass")
            result = subprocess.run([sys.executable, "-B", "-c", source,
                                     str(Path(ops.__file__).parent), str(self.root)], capture_output=True)
            assert result.returncode != 0 and b"FileExistsError" in result.stderr
        fault = self.faults.get(phase)
        if isinstance(fault, BaseException):
            raise fault
        return fault

    def authorize(self, plan):
        fault = self.call("authorize")
        if fault is not None:
            return fault
        # This is a synthetic one-use gate, not a substitute for protected host
        # authorization, offsite restore or application compatibility evidence.
        with (self.root / "approval-used").open("x") as handle:
            handle.write(plan.request_sha256)
            handle.flush()
            os.fsync(handle.fileno())
        return {"request_sha256": plan.request_sha256, "approval_sha256": "a" * 64,
                "restore_sha256": "b" * 64, "compatibility_sha256": "c" * 64, "consumed": True}

    def inspect(self, args):
        if args[:2] == ["image", "inspect"]:
            index = self.images.index(args[2])
            revision = self.body[("previous", "target")[index] + "_sha"]
            return {"Id": args[2], "Config": {"User": "node", "Labels": {
                "org.opencontainers.image.revision": revision}}}
        assert args == ["inspect", "kin-api"]
        return {"Name": "/kin-api", "Image": json.loads(self.runtime.read_text())["image"],
                "State": {"Running": True}, "Config": {
                    "User": "node", "Env": ["DEPLOYMENT_MODE=production", "AUTH_REQUIRED=true"],
                    "Labels": {"com.docker.compose.project.working_dir": str(self.root),
                               "com.docker.compose.service": "api"}}, "Mounts": [],
                "NetworkSettings": {"Ports": {"3000/tcp": None}},
                "HostConfig": {"NetworkMode": "synthetic_default", "PortBindings": {}}}

    def observe(self, plan):
        fault = self.call("observe")
        if fault is not None:
            return fault
        with patch.object(ops, "require_local_docker"), patch.object(pre, "inspect_one", side_effect=self.inspect):
            return pre.observe(plan.request())

    def record(self, event):
        self.call("record_" + event["status"])
        # Use a real durable journal so terminal ordering and pending delivery can
        # be verified independently of the returned in-memory result.
        with self.journal.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        self.events.append(dict(event))

    def apply_api(self, sha, image):
        prefix = "target" if sha == self.body["target_sha"] else "previous"
        assert (sha, image) == (self.body[prefix + "_sha"], self.body[prefix + "_api_image"])
        fault = self.call("apply_" + prefix)
        if fault is not None:
            return fault
        self.runtime.write_text(json.dumps({"sha": sha, "image": image}))
        return {"settled": True, "succeeded": True}

    def smoke(self, sha, image):
        prefix = "target" if sha == self.body["target_sha"] else "previous"
        fault = self.call("smoke_" + prefix)
        if fault is not None:
            return fault
        return {**json.loads(self.runtime.read_text()), "health": True, "auth": True, "image_read": True}

    def notify_failure(self, event):
        fault = self.call("notify")
        if fault is not None:
            return fault
        self.notifications.append(dict(event))
        return True


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        self.host = SyntheticHost(self.root)
        self.root_patch = patch.object(ops, "ROOT", self.root)
        self.root_patch.start()
        self.addCleanup(self.root_patch.stop)

    def execute(self):
        result = runner.execute(self.host.raw, self.host.digest, self.host)
        self.assertEqual(self.host.data.read_bytes(), b"synthetic report history must survive\n")
        self.assertEqual((self.root / ".kin-ops.lock").exists(), result["lock_retained"])
        return result

    def test_01_success_is_exact_and_durable(self):
        self.assertEqual(self.execute()["status"], "DEPLOYED")
        self.assertEqual(self.host.calls, ["authorize", "observe", "record_STARTED", "apply_target",
                                          "smoke_target", "record_DEPLOYED"])
        records = [json.loads(line) for line in self.host.journal.read_text().splitlines()]
        self.assertEqual([r["status"] for r in records], ["STARTED", "DEPLOYED"])
        self.assertEqual(records[-1]["target_sha"], self.host.body["target_sha"])
        self.assertEqual(records[-1]["restore_sha256"], "b" * 64)
        self.assertEqual(records[-1]["compatibility_sha256"], "c" * 64)
        self.assertEqual(self.host.notifications, [])

    def test_02_invalid_bytes_never_reach_host(self):
        for raw, digest in ((self.host.raw, "0" * 64), (b"[]", hashlib.sha256(b"[]").hexdigest()),
                            (b" " * 8193, hashlib.sha256(b" " * 8193).hexdigest())):
            with self.assertRaises(RuntimeError):
                runner.execute(raw, digest, self.host)
        self.assertEqual(self.host.calls, [])
        self.assertFalse((self.root / ".kin-ops.lock").exists())

    def test_03_plan_is_immutable_and_requests_are_copies(self):
        plan = runner.make_plan(self.host.raw, self.host.digest)
        with self.assertRaises(FrozenInstanceError):
            plan.target_sha = "f" * 40
        body = plan.request()
        body["compose_files"].clear()
        body["target_sha"] = "f" * 40
        self.assertEqual(plan.request(), self.host.body)

    def test_04_evidence_must_bind_all_proofs_and_one_use(self):
        plan = runner.make_plan(self.host.raw, self.host.digest)
        good = {"request_sha256": plan.request_sha256, "approval_sha256": "a" * 64,
                "restore_sha256": "b" * 64, "compatibility_sha256": "c" * 64, "consumed": True}
        runner.check_authorization(good, plan)
        for key, value in (("request_sha256", "f" * 64), ("restore_sha256", ""),
                           ("compatibility_sha256", "missing"), ("approval_sha256", True),
                           ("consumed", 1), ("extra", "command")):
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                runner.check_authorization({**good, key: value}, plan)
        self.host.faults["authorize"] = {**good, "consumed": False}
        self.assertEqual(self.execute()["status"], "REJECTED")
        self.assertNotIn("apply_target", self.host.calls)

    def test_05_approval_replay_is_rejected(self):
        self.execute()
        self.host.calls.clear()
        self.assertEqual(self.execute()["status"], "REJECTED")
        self.assertNotIn("observe", self.host.calls)
        self.assertNotIn("apply_target", self.host.calls)

    def test_06_changed_running_image_rejects_before_apply(self):
        self.host.runtime.write_text(json.dumps({"sha": self.host.body["previous_sha"], "image": "foreign"}))
        self.assertEqual(self.execute()["status"], "REJECTED")
        self.assertNotIn("apply_target", self.host.calls)

    def test_07_dirty_git_and_changed_schema_reject(self):
        (self.root / "api/prisma/fixture.txt").write_text("changed\n")
        self.assertEqual(self.execute()["status"], "REJECTED")
        self.assertNotIn("apply_target", self.host.calls)

    def test_08_changed_observation_is_not_a_token(self):
        plan = runner.make_plan(self.host.raw, self.host.digest)
        with ops.lock():
            good = self.host.observe(plan)
        for key, value in (("preflight_passed", 1), ("target_sha", "f" * 40),
                           ("schema_unchanged", False), ("deployment_authorized", True)):
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                runner.check_observation({**good, key: value}, plan)

    def test_09_backup_competitor_cannot_enter_any_transition(self):
        self.host.faults["smoke_target"] = {"health": True}
        self.host.competitor_phases = {"authorize", "observe", "record_STARTED", "apply_target",
                                      "smoke_target", "record_ROLLING_BACK", "apply_previous",
                                      "smoke_previous", "record_ROLLED_BACK", "notify"}
        self.assertEqual(self.execute()["status"], "ROLLED_BACK")
        self.assertTrue(self.host.competitor_phases.issubset(self.host.calls))

    def test_10_existing_lock_stops_all_host_calls(self):
        with ops.lock():
            with self.assertRaises(FileExistsError):
                self.execute()
        self.assertEqual(self.host.calls, [])

    def test_11_settled_migration_failure_rolls_back_once(self):
        self.host.faults["apply_target"] = {"settled": True, "succeeded": False}
        result = self.execute()
        self.assertEqual(result["status"], "ROLLED_BACK")
        self.assertEqual(result["stage"], "apply")
        self.assertEqual(self.host.calls.count("apply_previous"), 1)
        self.assertNotIn("smoke_target", self.host.calls)
        self.assertEqual(json.loads(self.host.runtime.read_text())["image"], self.host.images[0])

    def test_12_each_smoke_dimension_is_required(self):
        plan = runner.make_plan(self.host.raw, self.host.digest)
        good = {"sha": plan.target_sha, "image": plan.target_api_image,
                "health": True, "auth": True, "image_read": True}
        for key in good:
            for value in (False, 1, None, "wrong"):
                with self.subTest(key=key, value=value):
                    self.assertFalse(runner.smoke_passed({**good, key: value}, plan.target_sha, plan.target_api_image))
        self.host.faults["smoke_target"] = {**good, "auth": False}
        self.assertEqual(self.execute()["status"], "ROLLED_BACK")

    def test_13_smoke_exception_can_roll_back_settled_apply(self):
        self.host.faults["smoke_target"] = RuntimeError("SECRET must not appear")
        self.assertEqual(self.execute()["status"], "ROLLED_BACK")
        self.assertNotIn("SECRET", self.host.journal.read_text())

    def test_14_unsettled_target_never_starts_rollback(self):
        self.host.faults["apply_target"] = {"settled": False, "succeeded": False}
        self.assertEqual(self.execute()["status"], "NEEDS_ATTENTION")
        self.assertNotIn("apply_previous", self.host.calls)
        with self.assertRaises(FileExistsError):
            with ops.lock():
                pass

    def test_15_actual_subprocess_timeout_retains_lock(self):
        def timeout(sha, image):
            self.host.call("apply_target")
            subprocess.run([sys.executable, "-c", "import time;time.sleep(10)"],
                           timeout=0.02, capture_output=True)
        with patch.object(self.host, "apply_api", side_effect=timeout):
            result = self.execute()
        self.assertEqual(result["status"], "NEEDS_ATTENTION")
        self.assertEqual(result["stage"], "apply")
        self.assertNotIn("apply_previous", self.host.calls)

    def test_16_malformed_mutation_is_unknown(self):
        for value in ({}, None, True, {"settled": 1, "succeeded": True},
                      {"settled": True, "succeeded": 1}, {"settled": True, "succeeded": True, "extra": 1}):
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                runner.mutation_result(value)
        self.host.faults["apply_target"] = {}
        self.assertEqual(self.execute()["status"], "NEEDS_ATTENTION")
        self.assertNotIn("apply_previous", self.host.calls)

    def test_17_rollback_failure_retains_lock_without_retry(self):
        self.host.faults["smoke_target"] = {}
        self.host.faults["apply_previous"] = {"settled": True, "succeeded": False}
        result = self.execute()
        self.assertEqual((result["status"], result["stage"]), ("NEEDS_ATTENTION", "rollback"))
        self.assertEqual(self.host.calls.count("apply_previous"), 1)
        self.assertNotIn("smoke_previous", self.host.calls)

    def test_18_rollback_unknown_retains_lock(self):
        self.host.faults["smoke_target"] = {}
        self.host.faults["apply_previous"] = RuntimeError("secret failure")
        self.assertEqual(self.execute()["status"], "NEEDS_ATTENTION")
        self.assertEqual(self.host.calls.count("apply_previous"), 1)

    def test_19_rollback_smoke_failure_retains_lock(self):
        self.host.faults["smoke_target"] = {}
        self.host.faults["smoke_previous"] = {}
        self.assertEqual(self.execute()["stage"], "rollback_smoke")

    def test_20_started_record_failure_prevents_mutation(self):
        self.host.faults["record_STARTED"] = OSError("secret journal path")
        self.assertEqual(self.execute()["status"], "NEEDS_ATTENTION")
        self.assertNotIn("apply_target", self.host.calls)

    def test_21_terminal_record_failure_is_not_success(self):
        self.host.faults["record_DEPLOYED"] = OSError("secret journal path")
        result = self.execute()
        self.assertEqual((result["status"], result["stage"]), ("NEEDS_ATTENTION", "record"))
        self.assertTrue(self.host.notifications)

    def test_22_notification_failure_leaves_durable_pending(self):
        self.host.faults["smoke_target"] = {}
        self.host.faults["notify"] = RuntimeError("SMTP secret")
        result = self.execute()
        self.assertEqual((result["status"], result["notification"]), ("ROLLED_BACK", "pending"))
        self.assertEqual(self.host.events[-1]["notification"], "pending")
        self.assertNotIn("SMTP", self.host.journal.read_text())

    def test_23_notification_only_accepts_boolean_true(self):
        self.host.faults["authorize"] = RuntimeError("secret")
        self.host.faults["notify"] = 1
        self.assertEqual(self.execute()["notification"], "pending")

    def test_24_interruption_after_started_retains_lock(self):
        self.host.faults["apply_target"] = KeyboardInterrupt()
        with self.assertRaises(KeyboardInterrupt):
            self.execute()
        self.assertTrue((self.root / ".kin-ops.lock").exists())

    def test_25_foreign_lock_owner_is_never_removed(self):
        def apply(sha, image):
            (self.root / ".kin-ops.lock").write_text("foreign-owner")
            raise RuntimeError("uncertain")
        with patch.object(self.host, "apply_api", side_effect=apply), self.assertRaisesRegex(RuntimeError, "ownership"):
            self.execute()
        self.assertEqual((self.root / ".kin-ops.lock").read_text(), "foreign-owner")

    def test_26_cli_cannot_select_adapter_or_execute(self):
        result = subprocess.run([sys.executable, "-B", runner.__file__, "--adapter", "SECRET"], capture_output=True)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, b"")
        self.assertNotIn(b"SECRET", result.stderr)
        self.assertEqual(self.host.calls, [])

    def test_27_record_failure_does_not_hide_notification_pending(self):
        self.host.faults["smoke_target"] = {}
        record = self.host.record
        def fail_after_accept(event):
            if event["notification"] == "accepted":
                raise OSError("secret")
            record(event)
        with patch.object(self.host, "record", side_effect=fail_after_accept):
            result = self.execute()
        self.assertEqual((result["status"], result["notification"]), ("NEEDS_ATTENTION", "pending"))
        self.assertEqual(self.host.events[-1]["notification"], "pending")

    def test_28_pending_and_accepted_share_event_identity(self):
        self.host.faults["smoke_target"] = {}
        self.execute()
        terminal = [e for e in self.host.events if e["status"] == "ROLLED_BACK"]
        self.assertEqual([e["notification"] for e in terminal], ["pending", "accepted"])
        self.assertEqual(terminal[0]["event_id"], terminal[1]["event_id"])

    def test_29_killed_process_leaves_shared_lock(self):
        source = ("import sys,pathlib,time;sys.path.insert(0,sys.argv[1]);import ops_backup as o;"
                  "o.ROOT=pathlib.Path(sys.argv[2]);\nwith o.lock():\n"
                  " (o.ROOT/'child-ready').write_text('ready')\n time.sleep(30)")
        child = subprocess.Popen([sys.executable, "-B", "-c", source,
                                  str(Path(ops.__file__).parent), str(self.root)],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic() + 5
            while not (self.root / "child-ready").exists() and time.monotonic() < deadline:
                if child.poll() is not None:
                    self.fail("child exited before owning lock")
                time.sleep(0.02)
            self.assertTrue((self.root / "child-ready").exists())
            child.terminate()
            child.communicate(timeout=5)
            with self.assertRaises(FileExistsError):
                with ops.lock():
                    pass
        finally:
            if child.poll() is None:
                child.kill()
            child.communicate(timeout=5)

    def test_30_rollback_start_record_failure_stops_replacement(self):
        self.host.faults["smoke_target"] = {}
        self.host.faults["record_ROLLING_BACK"] = OSError("secret")
        self.assertEqual(self.execute()["status"], "NEEDS_ATTENTION")
        self.assertNotIn("apply_previous", self.host.calls)


if __name__ == "__main__":
    unittest.main(verbosity=2)
