"""Failure-path checks for backup/restore safety; no Docker mutations in this file."""
from __future__ import annotations

import json
import io
from pathlib import Path
import subprocess
import stat
import sys
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

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
                if args[:3] == ["docker", "image", "inspect"]:
                    return '[{"RepoDigests": []}]'
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
            self.assertEqual(manifest["backup_error"]["stage"], "dump kin")

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

    def test_09_daemon_failure_is_not_successful_cleanup(self):
        failure = SimpleNamespace(returncode=1, stdout=b"", stderr=b"Cannot connect to the Docker daemon")
        with patch.object(ops, "run", return_value=failure):
            with self.assertRaisesRegex(RuntimeError, "Could not verify"):
                ops.remove_owned_if_present("container", "kin-rehearsal-owned", "token")

    def test_10_unsafe_archive_is_refused_even_with_matching_checksums(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            for name in ops.FILES:
                (directory / name).write_bytes(b"test fixture")
            with tarfile.open(directory / "orthanc.tgz", "w:gz") as archive:
                entry = tarfile.TarInfo("../outside")
                entry.size = 1
                archive.addfile(entry, io.BytesIO(b"x"))
            ops.write_json(directory / "manifest.json", {
                "format": 1, "complete": True, "resume_failures": [],
                "sha256": {name: ops.digest(directory / name) for name in ops.FILES},
            })
            with patch.object(ops, "run") as command:
                with self.assertRaisesRegex(RuntimeError, "Unsafe Orthanc archive"):
                    ops.validate_backup(directory)
                command.assert_not_called()

    def test_11_existing_shared_or_foreign_parent_is_never_chmodded(self):
        for mode, owner in ((0o1777, 1000), (0o700, 1001)):
            parent = Mock()
            parent.exists.return_value = True
            parent.is_dir.return_value = True
            parent.stat.return_value = SimpleNamespace(st_mode=stat.S_IFDIR | mode, st_uid=owner)
            with self.subTest(mode=mode, owner=owner), patch.object(ops.os, "name", "posix"), \
                    patch.object(ops.os, "geteuid", return_value=1000, create=True):
                with self.assertRaisesRegex(RuntimeError, "must be private"):
                    ops.prepare_backup_parent(parent)
            parent.chmod.assert_not_called()
            parent.mkdir.assert_not_called()

    def test_12_only_new_backup_parent_gets_private_creation_mode(self):
        parent = Mock()
        parent.exists.return_value = False
        ops.prepare_backup_parent(parent)
        parent.mkdir.assert_called_once_with(parents=True, mode=0o700)
        parent.chmod.assert_not_called()

    def test_13_intact_snapshot_remains_usable_when_source_resume_failed(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            for name in ops.FILES:
                (directory / name).write_bytes(b"test fixture")
            with tarfile.open(directory / "orthanc.tgz", "w:gz") as archive:
                entry = tarfile.TarInfo("./index")
                entry.size = 1
                archive.addfile(entry, io.BytesIO(b"x"))
            ops.write_json(directory / "manifest.json", {
                "format": 1, "complete": True, "ready": False, "resume_failures": ["kin-api"],
                "postgres_image": "sha256:" + "a"*64, "orthanc_image": "sha256:" + "b"*64,
                "sha256": {name: ops.digest(directory / name) for name in ops.FILES},
            })
            with patch.object(ops, "run"):
                _, manifest = ops.validate_backup(directory)
            self.assertTrue(manifest["complete"])
            self.assertFalse(manifest["ready"])

    def test_14_readiness_failure_blocks_deploy_but_preserves_completed_backup(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "repo"
            root.mkdir()
            for filename in ops.FILES[3:]:
                (root / filename).write_text("TEST_ONLY=placeholder")
            info = [{"Name": "/" + name, "State": {"Running": True}, "Image": "sha256:" + "a"*64,
                     "Config": {"Labels": {"com.docker.compose.project": "fixture",
                                           "com.docker.compose.project.working_dir": str(root)}},
                     "Mounts": [{"Destination": "/var/lib/orthanc/db", "Type": "volume", "Name": "fixture-volume"}]}
                    for name in ops.CONTAINERS]

            def fake_text(args, **kwargs):
                if args[:2] == ["docker", "inspect"]:
                    return "false" if "--format" in args else json.dumps(info)
                if args[:3] == ["docker", "image", "inspect"]:
                    return '[{"RepoDigests": []}]'
                if "pg_database_size('kin')" in " ".join(args):
                    return "4096"
                return "" if "status" in args else "a"*40

            def fake_run(args, **kwargs):
                if "pg_dump" in args:
                    kwargs["output"].write(b"fixture dump")
                return SimpleNamespace(returncode=0, stdout=b"")

            def fake_archive(args, **kwargs):
                if "-sk" in args:
                    return "8 /source"
                mount = next(value for value in args if value.startswith("type=bind,source="))
                destination = Path(mount.split("source=", 1)[1].split(",target=", 1)[0])
                (destination / "orthanc.tgz").write_bytes(b"fixture archive")
                return ""

            output = Path(temporary) / "backups"
            with patch.object(ops, "ROOT", root), patch.object(ops, "text", side_effect=fake_text), \
                    patch.object(ops, "run", side_effect=fake_run), patch.object(ops, "temporary_run", side_effect=fake_archive), \
                    patch.object(ops, "counts", return_value={"Report": 5}), \
                    patch.object(ops, "wait_ready", side_effect=RuntimeError("fixture timeout")):
                with self.assertRaisesRegex(RuntimeError, "readiness needs recovery"):
                    ops.backup(output)
            manifest = json.loads(next(output.glob("*/manifest.json")).read_text())
            self.assertTrue(manifest["complete"])
            self.assertFalse(manifest["ready"])
            self.assertEqual(manifest["resume_failures"], [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
