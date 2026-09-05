"""Failure-path checks for backup/restore safety; no Docker mutations in this file."""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import ops_backup as ops


class BackupSafetyTests(unittest.TestCase):
    def test_01_dump_failure_resumes_only_originally_running_writers(self):
        """TEST-OPS-01: a partial snapshot must never leave the original writers stopped."""
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "repo"
            root.mkdir()
            (root / ".env").write_text("TEST_ONLY=placeholder")
            info = []
            for name in ops.CONTAINERS:
                info.append({"Name": "/" + name, "State": {"Running": name != "kin-keycloak"},
                             "Image": "sha256:" + "a" * 64,
                             "Config": {"Labels": {"com.docker.compose.project": "fixture",
                                                   "com.docker.compose.project.working_dir": str(root)}},
                             "Mounts": [{"Destination": "/var/lib/orthanc/db", "Type": "volume", "Name": "fixture-volume"}]})

            def fake_text(args, **kwargs):
                if args[:2] == ["docker", "inspect"]:
                    return "false" if "--format" in args else json.dumps(info)
                if "pg_database_size('kin')" in " ".join(args):
                    return "4096"
                return "" if "status" in args else "a" * 40

            def fake_run(args, **kwargs):
                if "pg_dump" in args:
                    raise RuntimeError("simulated dump failure")
                return SimpleNamespace(returncode=0, stdout=b"")

            output = Path(temporary) / "backups"
            with patch.object(ops, "ROOT", root), patch.object(ops, "text", side_effect=fake_text), \
                    patch.object(ops, "run", side_effect=fake_run) as commands, \
                    patch.object(ops, "temporary_run", return_value="8 /source"), \
                    patch.object(ops, "counts", return_value={"Report": 5}):
                with self.assertRaisesRegex(RuntimeError, "simulated dump failure"):
                    ops.backup(output)
            starts = [call.args[0] for call in commands.call_args_list if call.args[0][1] == "start"]
            self.assertEqual(starts, [["docker", "start", "kin-api"], ["docker", "start", "kin-orthanc"]])
            manifest = json.loads(next(output.glob("*/manifest.json")).read_text())
            self.assertFalse(manifest["complete"])
            self.assertEqual(manifest["resume_failures"], [])

    def test_02_secret_backup_inside_repository_is_refused(self):
        with patch.object(ops, "text") as command:
            with self.assertRaisesRegex(RuntimeError, "outside the Git repository"):
                ops.backup(ops.ROOT / "backups")
            command.assert_not_called()

    def test_03_changed_backup_fails_before_restore(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            for name in ops.FILES:
                (directory / name).write_bytes(b"test fixture")
            manifest = {"format": 1, "complete": True, "resume_failures": [],
                        "sha256": {name: ops.digest(directory / name) for name in ops.FILES}}
            ops.write_json(directory / "manifest.json", manifest)
            (directory / "kin.dump").write_bytes(b"corrupted")
            with patch.object(ops, "run") as command:
                with self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
                    ops.validate_backup(directory)
                command.assert_not_called()

    def test_04_cleanup_requires_generated_name_and_ownership(self):
        with patch.object(ops, "text", return_value="someone-else"), patch.object(ops, "run") as command:
            for name in ("kin-db", "kin-rehearsal-another-run"):
                with self.assertRaises(RuntimeError):
                    ops.remove_owned("container", name, "my-token")
                command.assert_not_called()

    def test_05_cleanup_removes_only_owned_temporary_resources(self):
        with patch.object(ops, "text", return_value="my-token"), patch.object(ops, "run") as command:
            ops.remove_owned("container", "kin-rehearsal-owned", "my-token")
            command.assert_called_once_with(["docker", "rm", "-f", "-v", "kin-rehearsal-owned"])

    def test_06_failed_commands_do_not_echo_secret_output(self):
        result = SimpleNamespace(returncode=1, stdout=b"private value", stderr=b"credential text")
        with patch.object(subprocess, "run", return_value=result):
            with self.assertRaises(RuntimeError) as caught:
                ops.run(["docker", "exec", "credential-in-arguments"])
        self.assertNotIn("credential", str(caught.exception))
        self.assertNotIn("private", str(caught.exception))

    def test_07_remote_docker_refused_before_inspection(self):
        with patch.dict(ops.os.environ, {"DOCKER_HOST": "ssh://remote"}, clear=True), patch.object(ops, "text") as command:
            with self.assertRaises(RuntimeError):
                ops.require_local_docker()
            command.assert_not_called()

    def test_08_operations_lock_does_not_remove_another_owner(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(ops, "ROOT", Path(temporary)):
            path = Path(temporary) / ".kin-ops.lock"
            with ops.lock():
                with self.assertRaises(FileExistsError):
                    with ops.lock():
                        self.fail("Second operation acquired an existing lock")
                self.assertTrue(path.exists())
            self.assertFalse(path.exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
