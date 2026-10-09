"""Failure-path checks for backup/restore safety; no Docker mutations in this file.

test_18..test_23 (S7-AUDIT-STORE OB-01..OB-05): the audit seal and the rehearsal's restored-copy verification inside the
real backup/rehearse flow. The isolated verifier boundary is answered with synthetic digest streams (its PostgreSQL
behaviour is tests/audit_store_db_test.py); the manifest the flow wrote is fed to the unchanged ops_monitor.backup_status.
test_24 (OB-06, S7-AUDIT-STORE-F02) runs the real verifier boundary with a short time limit against the test-side fake
docker CLI of tests/ops_audit_integrity_test.py.
"""
from __future__ import annotations

import contextlib
from datetime import datetime, timedelta, timezone
import hashlib
import json
import io
from pathlib import Path
import subprocess
import stat
import sys
import tarfile
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import ops_backup as ops
import ops_audit_integrity as audit
import ops_monitor as monitor
from ops_audit_integrity_test import FakeDocker, verifier_answer

PRESENT = {"state": "present", "statements": {"insert": "accepted", "update": "refused", "delete": "refused",
                                              "truncate": "refused"}}
INEFFECTIVE = {"state": "ineffective", "statements": {"insert": "accepted", "update": "accepted", "delete": "refused",
                                                      "truncate": "refused"}}


def rows_stream(rows, guard=PRESENT, schema=()):
    """A synthetic isolated-verifier answer: {id: content} as the (id, count, digest) stream."""
    return audit.Evaluation(table=True, rows=[(key, 1, hashlib.sha256(value.encode()).hexdigest())
                                              for key, value in rows.items()], guard=dict(guard), schema=list(schema))


def orthanc_archive():
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w:gz") as archive:
        entry = tarfile.TarInfo("./index")
        entry.size = 1
        archive.addfile(entry, io.BytesIO(b"x"))
    return stream.getvalue()


class Host:
    """The fake host of test_14 (all writers running) with a private backup parent beside the repository, recording
    every command and the order of pause, resume, readiness and seal."""

    def __init__(self, temporary):
        self.repo = Path(temporary) / "repo"
        self.repo.mkdir()
        for filename in ops.FILES[3:]:
            (self.repo / filename).write_text("TEST_ONLY=placeholder")
        self.parent = Path(temporary) / "backups"
        self.parent.mkdir(mode=0o700)
        self.info = [{"Name": "/" + name, "State": {"Running": True}, "Image": "sha256:" + "a" * 64,
                      "Config": {"Labels": {"com.docker.compose.project": "fixture",
                                            "com.docker.compose.project.working_dir": str(self.repo)}},
                      "Mounts": [{"Destination": "/var/lib/orthanc/db", "Type": "volume", "Name": "fixture-volume"}, {"Destination": ops.EMR_STATE, "Type": "volume", "Name": "fixture-emr-state"}]}
                     for name in (*ops.CONTAINERS, "kin-proxy")]
        self.events = []
        self.sources = []
        # Backups a minute apart within the monitor's 30-hour window: the monitor orders manifests by whole seconds.
        self.clock = datetime.now(timezone.utc) - timedelta(hours=1)

    def now(self, tz=None):
        self.clock += timedelta(minutes=1)
        return self.clock

    def init_ledger(self):
        with patch.object(ops, "ROOT", self.repo), contextlib.redirect_stdout(io.StringIO()):
            assert audit.main(["init", str(self.parent)]) == 0

    def fake_text(self, args, **kwargs):
        self.events.append(("command", list(args)))
        if args[:2] == ["docker", "inspect"]:
            return "false" if "--format" in args else json.dumps(self.info)
        if args[:3] == ["docker", "image", "inspect"]:
            return '[{"RepoDigests": []}]'
        if "pg_database_size('kin')" in " ".join(args):
            return "4096"
        if "pg_stat_activity" in " ".join(args):
            return "0"
        return "" if "status" in args else "a" * 40

    def fake_run(self, args, **kwargs):
        self.events.append(("command", list(args)))
        if "pg_dump" in args or "pg_dumpall" in args:
            kwargs["output"].write(b"fixture dump " + str(time.monotonic_ns()).encode())
        return SimpleNamespace(returncode=0, stdout=b"", stderr=b"")

    def fake_archive(self, args, **kwargs):
        if "-sk" in args:
            return "8 /source"
        if kwargs.get("output") is not None:
            kwargs["output"].write(orthanc_archive())
            return ""
        return json.dumps({"integrity": "ok", "attachments": 0, "attachment_bytes": 0}) if "python3" in args else "EMR_RESTORE_VERIFIED"

    def boundary(self, answer):
        def evaluate(source, *args, **kwargs):
            self.events.append(("evaluate", source))
            self.sources.append(source)
            if isinstance(answer, BaseException):
                raise answer
            return answer(source) if callable(answer) else answer
        return evaluate

    def backup(self, answer):
        """One ops.backup run whose seal is answered with `answer`; returns (folder, manifest, error)."""
        before = {entry.name for entry in self.parent.iterdir()}
        error = None
        clock = type("Clock", (datetime,), {"now": staticmethod(self.now)})
        with patch.object(ops, "ROOT", self.repo), patch.object(ops, "datetime", clock), \
                patch.object(ops, "text", side_effect=self.fake_text), \
                patch.object(ops, "run", side_effect=self.fake_run), \
                patch.object(ops, "temporary_run", side_effect=self.fake_archive), \
                patch.object(ops, "emr_catalog", return_value={"synthetic": "catalog"}), \
                patch.object(ops, "counts", return_value={"public.Report": 5}), \
                patch.object(ops, "wait_ready", side_effect=lambda *a: self.events.append(("ready",))), \
                patch.object(audit, "evaluate", side_effect=self.boundary(answer)), \
                contextlib.redirect_stdout(io.StringIO()):
            try:
                ops.backup(self.parent)
            except RuntimeError as caught:
                error = caught
        folder = next(self.parent / name for name in {entry.name for entry in self.parent.iterdir()} - before)
        return folder, json.loads((folder / "manifest.json").read_text(encoding="utf-8")), error

    def rehearse(self, folder, answer):
        """One ops.rehearse run whose restored-copy verification is answered with `answer`."""
        self.events.clear()
        self.sources.clear()
        error = None
        cleanup = Mock()
        earlier = set(folder.glob("rehearsal-*.json"))
        with patch.object(ops, "run", side_effect=self.fake_run), \
                patch.object(ops, "temporary_run", side_effect=self.fake_archive), \
                patch.object(ops, "emr_catalog", return_value={"synthetic": "catalog"}), \
                patch.object(ops, "counts", return_value={"public.Report": 5}), \
                patch.object(ops, "remove_owned_if_present", cleanup), \
                patch.object(audit, "evaluate", side_effect=self.boundary(answer)), \
                contextlib.redirect_stdout(io.StringIO()):
            try:
                ops.rehearse(folder)
            except RuntimeError as caught:
                error = caught
        (written,) = set(folder.glob("rehearsal-*.json")) - earlier
        result = json.loads(written.read_text())
        started = [cmd for kind, cmd in self.events if kind == "command" and cmd[:3] == ["docker", "run", "-d"]]
        container = started[0][started[0].index("--name") + 1] if started else None
        return result, error, container, cleanup

    def status(self):
        return monitor.backup_status(self.parent, self.parent / ".no-lock", int(time.time()))[0]

    def files(self, folder):
        return {path.name: path.read_bytes() for path in folder.iterdir() if not path.name.startswith("rehearsal-")}


class BackupSafetyTests(unittest.TestCase):
    def test_01_dump_failure_resumes_only_originally_running_writers(self):
        """TEST-OPS-01: a partial snapshot must never leave the original writers stopped."""
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "repo"
            root.mkdir()
            (root / ".env").write_text("TEST_ONLY=placeholder")
            info = []
            for name in (*ops.CONTAINERS, "kin-proxy"):
                info.append({"Name": "/" + name, "State": {"Running": name != "kin-keycloak"},
                             "Image": "sha256:" + "a" * 64,
                             "Config": {"Labels": {"com.docker.compose.project": "fixture",
                                                   "com.docker.compose.project.working_dir": str(root)}},
                             "Mounts": [{"Destination": "/var/lib/orthanc/db", "Type": "volume", "Name": "fixture-volume"}, {"Destination": ops.EMR_STATE, "Type": "volume", "Name": "fixture-emr-state"}]})

            def fake_text(args, **kwargs):
                if args[:2] == ["docker", "inspect"]:
                    return "false" if "--format" in args else json.dumps(info)
                if "pg_database_size('kin')" in " ".join(args):
                    return "4096"
                if args[:3] == ["docker", "image", "inspect"]:
                    return '[{"RepoDigests": []}]'
                if "pg_stat_activity" in " ".join(args):
                    return "0"
                return "" if "status" in args else "a" * 40

            def fake_run(args, **kwargs):
                if "pg_dumpall" in args:
                    kwargs["output"].write(b"synthetic roles")
                if "pg_dump" in args:
                    raise RuntimeError("simulated dump failure")
                return SimpleNamespace(returncode=0, stdout=b"")

            output = Path(temporary) / "backups"
            with patch.object(ops, "ROOT", root), patch.object(ops, "text", side_effect=fake_text), \
                    patch.object(ops, "run", side_effect=fake_run) as commands, \
                    patch.object(ops, "temporary_run", return_value="8 /source"), \
                    patch.object(ops, "emr_catalog", return_value={"synthetic": "catalog"}), \
                    patch.object(ops, "counts", return_value={"public.Report": 5}):
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
            command.assert_called_once()
            self.assertEqual(command.call_args.args[0], ["docker", "rm", "-f", "-v", "kin-rehearsal-owned"])

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
                     "Mounts": [{"Destination": "/var/lib/orthanc/db", "Type": "volume", "Name": "fixture-volume"}, {"Destination": ops.EMR_STATE, "Type": "volume", "Name": "fixture-emr-state"}]}
                    for name in (*ops.CONTAINERS, "kin-proxy")]

            def fake_text(args, **kwargs):
                if args[:2] == ["docker", "inspect"]:
                    return "false" if "--format" in args else json.dumps(info)
                if args[:3] == ["docker", "image", "inspect"]:
                    return '[{"RepoDigests": []}]'
                if "pg_database_size('kin')" in " ".join(args):
                    return "4096"
                if "pg_stat_activity" in " ".join(args):
                    return "0"
                return "" if "status" in args else "a"*40

            def fake_run(args, **kwargs):
                if "pg_dump" in args or "pg_dumpall" in args:
                    kwargs["output"].write(b"fixture dump")
                return SimpleNamespace(returncode=0, stdout=b"")

            def fake_archive(args, **kwargs):
                if "-sk" in args:
                    return "8 /source"
                kwargs["output"].write(b"fixture archive")
                return ""

            output = Path(temporary) / "backups"
            # S7-AUDIT-STORE NR-20: the complete snapshot is sealed after the readiness failure, so the parent holds an
            # initialised ledger and the seal's isolated verifier answers; the readiness error keeps its priority.
            output.mkdir(mode=0o700)
            with patch.object(ops, "ROOT", root), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(audit.main(["init", str(output)]), 0)
            with patch.object(ops, "ROOT", root), patch.object(ops, "text", side_effect=fake_text), \
                    patch.object(ops, "run", side_effect=fake_run), patch.object(ops, "temporary_run", side_effect=fake_archive), \
                    patch.object(ops, "emr_catalog", return_value={"synthetic": "catalog"}), \
                patch.object(ops, "counts", return_value={"public.Report": 5}), \
                    patch.object(ops, "wait_ready", side_effect=RuntimeError("fixture timeout")), \
                    patch.object(audit, "evaluate", return_value=rows_stream({1: "fixture"})):
                with self.assertRaisesRegex(RuntimeError, "readiness needs recovery"):
                    ops.backup(output)
            manifest = json.loads(next(output.glob("*/manifest.json")).read_text())
            self.assertTrue(manifest["complete"])
            self.assertFalse(manifest["ready"])
            self.assertEqual(manifest["resume_failures"], [])
            self.assertTrue(manifest["proxy_reloaded"])

    def test_17_invalid_proxy_configuration_is_never_reloaded(self):
        with patch.object(ops, "run", side_effect=RuntimeError("invalid proxy config")) as command:
            with self.assertRaisesRegex(RuntimeError, "invalid proxy config"):
                ops.reload_proxy()
            command.assert_called_once_with(["docker", "exec", "kin-proxy", "nginx", "-t"], timeout=30)

    def test_15_binary_archive_stream_does_not_decode_or_buffer_stdout(self):
        payload = b"\x1f\x8b\xff\x00binary archive"
        with tempfile.TemporaryFile() as output:
            def produce(args, **kwargs):
                self.assertIs(kwargs["stdout"], output)
                kwargs["stdout"].write(payload)
                return SimpleNamespace(returncode=0, stdout=None, stderr=b"")

            with patch.object(subprocess, "run", side_effect=produce), \
                    patch.object(ops, "remove_owned_if_present") as cleanup:
                self.assertEqual(ops.temporary_run(["fixture-image"], output=output), "")
            output.seek(0)
            self.assertEqual(output.read(), payload)
            cleanup.assert_called_once()

    def test_16_stream_timeout_still_cleans_the_owned_helper(self):
        with tempfile.TemporaryFile() as output, \
                patch.object(ops, "run", side_effect=subprocess.TimeoutExpired("docker", 1)), \
                patch.object(ops, "remove_owned_if_present") as cleanup:
            with self.assertRaises(subprocess.TimeoutExpired):
                ops.temporary_run(["fixture-image"], output=output, timeout=1)
            cleanup.assert_called_once()

    def test_18_ob01_seal_follows_resume_reads_the_snapshot_and_a_seal_failure_alarms(self):
        """OB-01 (SE-01, SE-02): pause -> dump -> resume -> readiness -> seal over the snapshot's own kin.dump."""
        with tempfile.TemporaryDirectory() as temporary:
            host = Host(temporary)
            host.init_ledger()
            folder, manifest, error = host.backup(rows_stream({1: "a", 2: "b"}))
            self.assertIsNone(error)
            kinds = [event[0] if event[0] != "command" else " ".join(event[1][:2]) for event in host.events]
            self.assertIn("evaluate", kinds, "the complete snapshot is sealed")
            order = [kinds.index("docker stop"), max(i for i, k in enumerate(kinds) if k == "docker start"),
                     kinds.index("ready"), kinds.index("evaluate")]
            self.assertEqual(order, sorted(order), "the seal runs after the writers resumed and readiness")
            dumped = [i for i, (kind, *rest) in enumerate(host.events) if kind == "command" and "pg_dump" in rest[0]]
            self.assertLess(max(dumped), kinds.index("docker start"), "the dump is taken inside the writer pause")
            # the judged input is the snapshot's kin.dump with the recorded image; kin-db is not contacted by the seal
            self.assertEqual(len(host.sources), 1, "one isolated evaluation seals the snapshot")
            source = host.sources[0]
            self.assertIsInstance(source, audit.SnapshotDump)
            self.assertEqual((source.path, source.image), (folder / "kin.dump", manifest["postgres_image"]))
            after_seal = [event for event in host.events[kinds.index("evaluate"):] if event[0] == "command"]
            self.assertFalse([cmd for _, cmd in after_seal if "kin-db" in cmd])
            self.assertTrue(manifest["complete"])
            self.assertNotIn("backup_error", manifest)
            self.assertEqual(host.status(), [])

            ledger_before = (host.parent / audit.LEDGER).read_bytes()
            folder, manifest, error = host.backup(audit.InputError("synthetic verifier start failure"))
            self.assertRegex(str(error), "seal audit")
            self.assertTrue(manifest["complete"])
            self.assertEqual(manifest.get("backup_error"), {"stage": "seal audit", "type": "InputError"})
            self.assertNotIn(audit.CHECKPOINT, manifest["sha256"])
            self.assertEqual((host.parent / audit.LEDGER).read_bytes(), ledger_before)
            self.assertEqual(host.status(), ["backup_failed"], "the unchanged monitor alarms from the manifest")

    def test_19_ob02_declared_checkpoint_is_a_validated_component_and_old_backups_stay_valid(self):
        """OB-02 (SE-01, SE-11)."""
        with tempfile.TemporaryDirectory() as temporary:
            host = Host(temporary)
            host.init_ledger()
            folder, manifest, _ = host.backup(rows_stream({1: "a"}))
            self.assertEqual(manifest["format"], 1)
            self.assertEqual(manifest["sha256"][audit.CHECKPOINT], ops.digest(folder / audit.CHECKPOINT))
            self.assertEqual(manifest["bytes"][audit.CHECKPOINT], (folder / audit.CHECKPOINT).stat().st_size)
            with patch.object(ops, "run"):
                ops.validate_backup(folder)
                kept = (folder / audit.CHECKPOINT).read_bytes()
                (folder / audit.CHECKPOINT).write_bytes(kept + b" ")
                with self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
                    ops.validate_backup(folder)
                (folder / audit.CHECKPOINT).unlink()
                with self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
                    ops.validate_backup(folder)
                # an older six-file backup (nothing declared) is unchanged, even with a stray undeclared file
                for field in ("sha256", "bytes"):
                    manifest[field].pop(audit.CHECKPOINT)
                ops.write_json(folder / "manifest.json", manifest)
                (folder / audit.CHECKPOINT).write_bytes(b"undeclared")
                ops.validate_backup(folder)

    def test_20_ob03_previous_comes_from_the_ledger_and_no_ledger_is_never_a_first_seal(self):
        """OB-03 (SE-04, SE-06, SE-12, DP-02)."""
        with tempfile.TemporaryDirectory() as temporary:
            host = Host(temporary)
            folder, manifest, error = host.backup(rows_stream({1: "a"}))
            self.assertEqual(manifest.get("backup_error"), {"stage": "seal audit", "type": "LedgerMissing"})
            self.assertIsNotNone(error)
            self.assertFalse((host.parent / audit.LEDGER).exists())
            self.assertFalse((folder / audit.CHECKPOINT).exists())

            host.init_ledger()
            first, manifest, error = host.backup(rows_stream({1: "a"}))
            self.assertIsNone(error)
            body = json.loads((first / audit.CHECKPOINT).read_text())
            self.assertEqual((body["previous"], body["previous_verification"]), (None, {"state": "none"}))
            # a newer sealed folder that the ledger does not list (another ledger's) is never taken as the endpoint
            decoy = host.parent / "29991231-235959-deadbeef"
            decoy.mkdir(mode=0o700)
            other = dict(body, ledger_id="0" * 32)
            (decoy / audit.CHECKPOINT).write_text(json.dumps(other))
            ops.write_json(decoy / "manifest.json", {"format": 1, "complete": True, "ready": True, "resume_failures": [],
                                                     "created_utc": "2999-12-31T23:59:59+00:00",
                                                     "sha256": {audit.CHECKPOINT: ops.digest(decoy / audit.CHECKPOINT)}})
            second, _, error = host.backup(rows_stream({1: "a", 2: "b"}))
            self.assertIsNone(error)
            seal = json.loads((host.parent / audit.LEDGER).read_text())["entries"][1]
            body = json.loads((second / audit.CHECKPOINT).read_text())
            self.assertEqual(body["previous"], {"backup": first.name, "sha256": seal["checkpoint_sha256"], "seq": 1})
            self.assertEqual(body["previous_verification"], {"state": "verified"})
            for path in decoy.iterdir():
                path.unlink()
            decoy.rmdir()

            latest = json.loads((host.parent / audit.LEDGER).read_text())["entries"][-1]
            for path in second.iterdir():
                path.unlink()
            second.rmdir()
            third, manifest, error = host.backup(rows_stream({1: "a", 2: "b", 3: "c"}))
            body = json.loads((third / audit.CHECKPOINT).read_text())
            self.assertEqual(body["previous"], {"backup": latest["backup"], "sha256": latest["checkpoint_sha256"],
                                                "seq": latest["seq"]})
            self.assertEqual(body["previous_verification"], {"state": "unverifiable", "reason": "previous_missing"})
            self.assertEqual((manifest.get("backup_error") or {}).get("stage"), "audit integrity")
            self.assertIsNotNone(error)

    def test_21_ob04_past_event_restores_verified_current_defect_restores_but_fails(self):
        """OB-04 (SE-05, SE-07, SE-14, RS-08, RS-09) [OP-3 (a)]."""
        with tempfile.TemporaryDirectory() as temporary:
            host = Host(temporary)
            host.init_ledger()
            host.backup(rows_stream({1: "a", 2: "b"}))
            # (1) a past event: a sealed row changed since the previous seal; this snapshot's own guard and shape are sound
            past, manifest, error = host.backup(rows_stream({1: "a", 2: "B"}))
            body = json.loads((past / audit.CHECKPOINT).read_text())
            self.assertEqual(body["previous_verification"]["state"], "failed")
            self.assertEqual((body["guard"]["state"], body["schema"]), ("present", []))
            self.assertTrue(manifest["complete"])
            self.assertEqual(manifest.get("backup_error"), {"stage": "audit integrity", "type": "AuditIntegrityMismatch"})
            self.assertIsNotNone(error)
            self.assertEqual(host.status(), ["backup_failed"])
            with patch.object(ops, "run"):
                ops.validate_backup(past)
            result, error, _, _ = host.rehearse(past, rows_stream({1: "a", 2: "B"}))
            self.assertIsNone(error)
            self.assertTrue(result["success"])
            self.assertTrue(result["audit"]["verified"])
            self.assertEqual(result["audit"]["previous_verification"]["state"], "failed")

            # (2) a current defect: this snapshot's own guard is ineffective (variant: an inheritance finding)
            for label, answer in (("guard", rows_stream({1: "a", 2: "B"}, guard=INEFFECTIVE)),
                                  ("inheritance", rows_stream({1: "a", 2: "B"}, schema=["inheritance"]))):
                with self.subTest(label):
                    current, manifest, error = host.backup(answer)
                    body = json.loads((current / audit.CHECKPOINT).read_text())
                    self.assertEqual((body["guard"], body["schema"]), (answer.guard, answer.schema))
                    self.assertEqual((manifest.get("backup_error") or {}).get("stage"), "audit integrity")
                    self.assertTrue(manifest["complete"])
                    self.assertIsNotNone(error)
                    self.assertEqual(host.status(), ["backup_failed"])
                    with patch.object(ops, "run"):
                        ops.validate_backup(current)
                    before = host.files(current)
                    result, error, _, cleanup = host.rehearse(current, answer)
                    self.assertIsNotNone(error)
                    self.assertFalse(result["success"])
                    self.assertFalse(result["audit"]["verified"])
                    self.assertEqual((result["audit"]["guard"], result["audit"]["schema"]), (answer.guard, answer.schema))
                    self.assertTrue(cleanup.called)
                    self.assertEqual(host.files(current), before, "the snapshot, its manifest and checkpoint are kept")

    def test_22_ob05_rehearse_verifies_the_export_of_its_own_restored_copy(self):
        """OB-05 (RS-01, RS-03, RS-07, RS-08, RS-09, RS-10)."""
        with tempfile.TemporaryDirectory() as temporary:
            host = Host(temporary)
            old, _, _ = host.backup(rows_stream({1: "a"}))            # no ledger: an unsealed snapshot
            result, error, _, _ = host.rehearse(old, rows_stream({1: "a"}))
            self.assertIsNone(error)
            self.assertEqual((result["success"], result["audit"]), (True, "not_sealed"))
            self.assertEqual(host.sources, [])

            host.init_ledger()
            host.backup(rows_stream({1: "a", 2: "b"}))
            verified, _, _ = host.backup(rows_stream({1: "a", 2: "b", 3: "c"}))
            past, manifest, _ = host.backup(rows_stream({1: "a", 2: "B", 3: "c"}))
            self.assertEqual((manifest.get("backup_error") or {}).get("stage"), "audit integrity")
            defect, manifest, _ = host.backup(rows_stream({1: "a", 2: "B", 3: "c"}, guard=INEFFECTIVE))
            self.assertEqual((manifest.get("backup_error") or {}).get("stage"), "audit integrity")
            cases = {"(a) verified": (verified, rows_stream({1: "a", 2: "b", 3: "c"}), True, "verified"),
                     "(b) past event": (past, rows_stream({1: "a", 2: "B", 3: "c"}), True, "failed"),
                     "(c) restored copy differs": (verified, rows_stream({1: "a", 2: "x", 3: "c"}), False, "verified"),
                     "(d) current guard defect": (defect, rows_stream({1: "a", 2: "B", 3: "c"}, guard=INEFFECTIVE),
                                                  False, "verified"),
                     "(e) input error": (verified, audit.InputError("synthetic export failure"), False, "verified")}
            for label, (folder, answer, success, previous) in cases.items():
                with self.subTest(label):
                    before = host.files(folder)
                    result, error, container, cleanup = host.rehearse(folder, answer)
                    self.assertEqual(len(host.sources), 1, "a sealed backup's rehearsal verifies its restored copy")
                    source = host.sources[0]
                    self.assertIsInstance(source, audit.DatabaseExport, "the restored copy, never the snapshot file")
                    self.assertEqual((source.container, source.database), (container, "kin"))
                    self.assertEqual(result["success"], success)
                    self.assertEqual(result["audit"]["verified"], success)
                    self.assertEqual(error is None, success)
                    self.assertTrue(cleanup.called)
                    self.assertEqual(result["cleanup_failures"], [])
                    self.assertEqual(host.files(folder), before)
                    if label.startswith("(e)"):
                        self.assertEqual(result["audit"]["exit"], 2)
                    else:
                        self.assertEqual(result["audit"]["previous_verification"]["state"], previous)
                    if label.startswith("(c)"):
                        self.assertEqual(result["audit"]["changed"]["ids"], [2])

    def test_23_ob04_an_unrecovered_declaration_is_a_past_event_that_restores_and_stays_reported(self):
        """OB-04 with SE-13 (RS-08, RT-13; S7-AUDIT-STORE-F01): a seal that stopped after its manifest declaration and
        does not continue the ledger makes the next backup alarm with a past event; that snapshot still restores verified,
        the backups after it are sealed without an alarm, and retention keeps reporting the unresolved declaration."""
        with tempfile.TemporaryDirectory() as temporary:
            host = Host(temporary)
            host.init_ledger()
            first, _, _ = host.backup(rows_stream({1: "a"}))
            ledger = (host.parent / audit.LEDGER).read_bytes()
            broken, _, _ = host.backup(rows_stream({1: "a", 2: "b"}))
            body = json.loads((broken / audit.CHECKPOINT).read_text())
            body["previous"] = {"backup": first.name, "sha256": "0" * 64, "seq": 1}
            (broken / audit.CHECKPOINT).write_text(json.dumps(body))
            manifest = json.loads((broken / "manifest.json").read_text())
            manifest["sha256"][audit.CHECKPOINT] = ops.digest(broken / audit.CHECKPOINT)
            manifest["bytes"][audit.CHECKPOINT] = (broken / audit.CHECKPOINT).stat().st_size
            ops.write_json(broken / "manifest.json", manifest)
            (host.parent / audit.LEDGER).write_bytes(ledger)        # the seal stopped before its ledger step

            rows = {1: "a", 2: "b", 3: "c"}
            past, manifest, error = host.backup(rows_stream(rows))
            body = json.loads((past / audit.CHECKPOINT).read_text())
            self.assertEqual(body["previous_verification"], {"state": "unverifiable", "reason": "uncommitted_checkpoint"})
            self.assertEqual((body["guard"]["state"], body["schema"]), ("present", []))
            self.assertEqual(manifest.get("backup_error"), {"stage": "audit integrity", "type": "AuditPreviousUnverifiable"})
            self.assertTrue(manifest["complete"])
            self.assertIsNotNone(error)
            self.assertEqual(host.status(), ["backup_failed"])
            # the snapshot itself is sound: its restored copy verifies and the rehearsal succeeds carrying the past event
            result, error, _, _ = host.rehearse(past, rows_stream(rows))
            self.assertIsNone(error)
            self.assertEqual((result["success"], result["audit"]["verified"]), (True, True))
            self.assertEqual(result["audit"]["previous_verification"]["state"], "unverifiable")

            # the backups after it are sealed and verified against the ledger without an alarm
            later, manifest, error = host.backup(rows_stream({**rows, 4: "d"}))
            self.assertIsNone(error)
            self.assertNotIn("backup_error", manifest)
            self.assertEqual(json.loads((later / audit.CHECKPOINT).read_text())["previous_verification"],
                             {"state": "verified"})
            self.assertEqual(host.status(), [])
            # and retention still reports the declaration the ledger never received
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                code = audit.main(["retention", str(host.parent),
                                   "--as-of", (host.clock + timedelta(minutes=1)).isoformat()])
            report = json.loads(output.getvalue())
            self.assertEqual((code, report["uncommitted"], report["latest"]), (1, [broken.name], later.name))

    def test_24_ob06_a_stalled_verification_fails_seal_and_rehearse_within_the_time_limit(self):
        """OB-06 (S7-AUDIT-STORE-F02; SE-02, RS-07): the real verifier boundary with a 3 s limit, against the fake docker
        CLI. A verifier that never answers fails the seal as 'seal audit' (the snapshot stays complete, the ledger is
        unchanged, the monitor alarms, and the record carries the confirmed termination proof); a rehearsal whose
        restored copy's export stalls fails with its record written (audit exit 2 with the proof of the remote export's
        cancellation), every container and volume it made removed and the operations lock released - each within the
        limit and the cleanup budget. With a sound verifier the same seal and rehearsal succeed."""
        limit, grace = 3, 15
        with tempfile.TemporaryDirectory() as temporary:
            host = Host(temporary)
            host.init_ledger()
            fake = FakeDocker(temporary)
            self.addCleanup(fake.kill_all)
            real_evaluate, real_run, real_text = audit.evaluate, ops.run, ops.text

            def limited(source):
                # the verifier's own docker commands reach the fake CLI even where the flow's other commands are faked
                with patch.object(ops, "run", real_run), patch.object(ops, "text", real_text):
                    return real_evaluate(source, timeout=limit)

            rows = {1: "a", 2: "b"}
            fake.plan(answer=verifier_answer(rows))
            with fake.active():
                sealed, manifest, error = host.backup(limited)
            self.assertIsNone(error)
            self.assertNotIn("backup_error", manifest)
            self.assertIn(audit.CHECKPOINT, manifest["sha256"])
            self.assertEqual((fake.running(), fake.names("containers")), ([], []))

            ledger = (host.parent / audit.LEDGER).read_bytes()
            fake.plan(verifier="stall_after_read")
            started = time.monotonic()
            with fake.active():
                stalled, manifest, error = host.backup(limited)
            self.assertLess(time.monotonic() - started, limit + grace)
            self.assertIsNotNone(error)
            self.assertTrue(manifest["complete"])
            record = manifest.get("backup_error") or {}
            self.assertEqual((record.get("stage"), record.get("type")), ("seal audit", "InputError"))
            self.assertTrue(record["cleanup"]["confirmed"], record)
            self.assertTrue(record["cleanup"]["steps"]["verifier"]["confirmed"])
            self.assertNotIn(audit.CHECKPOINT, manifest["sha256"])
            self.assertEqual((host.parent / audit.LEDGER).read_bytes(), ledger)
            self.assertEqual(host.status(), ["backup_failed"])
            self.assertEqual((fake.running(), fake.names("containers")), ([], []))

            def rehearse():
                with patch.object(sys, "argv", ["ops_backup.py", "rehearse", str(sealed)]):
                    ops.main()
            def rehearsal_run(args, **kwargs):
                # This boundary test simulates provisioning only; the real verifier/exporter still hits FakeDocker
                # and its watchdog. B L07/L19 exercise these provisioning statements on PostgreSQL itself.
                if args[:2] == ["docker", "exec"] and ("mkdir" in args or "psql" in args):
                    return SimpleNamespace(returncode=0, stdout=b"", stderr=b"")
                return real_run(args, **kwargs)
            for label, plan, success in (("sound", dict(answer=verifier_answer(rows)), True),
                                         ("the restored copy's export stalls", dict(exporter="stall"), False)):
                with self.subTest(label):
                    fake.plan(**plan)
                    earlier = set(sealed.glob("rehearsal-*.json"))
                    before = host.files(sealed)
                    with fake.active(), patch.object(ops, "ROOT", host.repo), patch.object(ops, "require_local_docker"), \
                            patch.object(ops, "run", side_effect=rehearsal_run), \
                            patch.object(ops, "emr_catalog", return_value={"synthetic": "catalog"}), \
                            patch.object(ops, "counts", return_value={"public.Report": 5}), \
                            patch.object(ops, "temporary_run", side_effect=host.fake_archive), \
                            patch.object(audit, "evaluate", side_effect=limited), \
                            contextlib.redirect_stdout(io.StringIO()):
                        outcome, elapsed, finished = fake.bounded(rehearse, limit + grace)
                    self.assertTrue(finished, "the rehearsal was still running after its limit and a bounded stop")
                    self.assertEqual(isinstance(outcome.get("error"), RuntimeError), not success, outcome)
                    (written,) = set(sealed.glob("rehearsal-*.json")) - earlier
                    result = json.loads(written.read_text())
                    self.assertEqual((result["success"], result["audit"]["verified"]), (success, success))
                    if not success:
                        self.assertEqual(result["audit"]["exit"], 2)
                        proof = result["audit"]["cleanup"]
                        self.assertTrue(proof["confirmed"], proof)
                        self.assertTrue(proof["steps"]["remote"]["confirmed"], "the restored copy's export was ended")
                        self.assertEqual((proof["target"]["database"], proof["target"]["role"]), ("kin", "postgres"))
                    self.assertEqual(result["cleanup_failures"], [])
                    self.assertFalse((host.repo / ".kin-ops.lock").exists(), "the operations lock is released")
                    self.assertEqual(fake.running(), [])
                    self.assertEqual((fake.names("containers"), fake.names("volumes")), ([], []))
                    self.assertEqual(host.files(sealed), before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
