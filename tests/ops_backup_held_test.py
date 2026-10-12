"""Held capture (INTERIM-RELEASE-TOOLS item 2): the B0/B1 snapshot taken while the caller keeps every writer fenced.

No Docker: a fake host answers the inspections and streams; the files, modes, checksums and the manifest the capture
writes are real. The contract: running writers refuse the capture before anything is written; the capture itself never
stops or starts a container (also not on failure); the pre-EMR shape refuses EMR storage and the post-EMR shape
requires it; the result validates as a held capture and as the legacy backup format that ops.rehearse() restores.
"""
from __future__ import annotations

import contextlib
import io
import json
import os
from pathlib import Path
import stat
import sys
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import ops_backup as ops

RESOURCES = {"containers": {"db": "kin-rh-db", "api": "kin-rh-api", "keycloak": "kin-rh-keycloak", "orthanc": "kin-rh-orthanc",
                            "proxy": "kin-rh-proxy"},
             "volumes": {"pg": "kin-rh_pg-db", "orthanc": "kin-rh_orthanc-db", "emr_access": "kin-rh_emr-access",
                         "emr_state": "kin-rh_emr-state"}}


def archive(entries=(("./index", b"x"),)):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w:gz") as handle:
        for name, data in entries:
            item = tarfile.TarInfo(name)
            item.size = len(data)
            handle.addfile(item, io.BytesIO(data))
    return stream.getvalue()


class FakeHost:
    def __init__(self, folder, shape="pre"):
        self.repo = Path(folder) / "repo"
        self.repo.mkdir()
        for name in (".env", "docker-compose.yml", "docker-compose.prod.yml", "docker-compose.monitor.yml"):
            (self.repo / name).write_text("SYNTHETIC=placeholder\n")
        self.parent = Path(folder) / "backups"
        self.shape = shape
        self.running = {role: False for role in ops.WRITER_ROLES}
        self.clients = "0"
        self.commands = []
        self.dump_failure = None
        self.emr_roles = shape == "post"

    def containers(self):
        out = []
        for role, name in RESOURCES["containers"].items():
            mounts = []
            if role == "db":
                mounts.append({"Destination": "/var/lib/postgresql/data", "Type": "volume", "Name": RESOURCES["volumes"]["pg"]})
            if role == "orthanc":
                mounts.append({"Destination": "/var/lib/orthanc/db", "Type": "volume", "Name": RESOURCES["volumes"]["orthanc"]})
            if role == "api" and self.shape == "post":
                mounts.append({"Destination": ops.EMR_STATE, "Type": "volume", "Name": RESOURCES["volumes"]["emr_state"]})
            out.append({"Name": "/" + name, "Image": "sha256:" + str(len(out)) * 64,
                        "State": {"Running": role == "db" or self.running.get(role, False)},
                        "Config": {"Image": role + ":synthetic"}, "Mounts": mounts})
        return out

    def catalog(self):
        roles = [{"rolname": "kin"}] + ([{"rolname": name} for name in ops.EMR_ROLES] if self.emr_roles else [])
        return {"roles": roles, "memberships": [], "databases": [], "tablespaces": [],
                "schemas": ["public", *(["emr_access"] if self.emr_roles else [])]}

    def text(self, args, **kwargs):
        self.commands.append(list(args))
        joined = " ".join(args)
        if args[:2] == ["docker", "inspect"]:
            return json.dumps(self.containers())
        if "pg_stat_activity" in joined:
            return self.clients
        if "pg_database_size" in joined:
            return "4096"
        if args[:2] == ["git", "rev-parse"]:
            return "a" * 40
        if args[:2] == ["git", "status"]:
            return ""
        if ops.ROLE_CATALOG_SQL in args:
            return json.dumps(self.catalog())
        if ops.MIGRATIONS_SQL in args:
            return json.dumps([["0_init", "1" * 64, True, False]])
        if "information_schema.columns" in joined:
            return json.dumps({"Report": ["id", "body"]})
        if "json_object_agg(name, d)" in joined:
            return json.dumps({"Report": [2, "c" * 64]})
        raise AssertionError("unexpected command " + joined[:80])

    def run(self, args, *, output=None, input_file=None, timeout=600, check=True):
        self.commands.append(list(args))
        if "pg_dump" in args or "pg_dumpall" in args:
            if self.dump_failure and "pg_dump" in args:
                raise self.dump_failure
            output.write(b"synthetic dump")
        if args[:3] == ["docker", "volume", "inspect"]:
            return SimpleNamespace(returncode=0, stdout=json.dumps([{"Name": args[3], "CreatedAt": "2026-10-12T00:00:00Z",
                                                                     "Driver": "local"}]).encode(), stderr=b"")
        return SimpleNamespace(returncode=0, stdout=b"", stderr=b"")

    def temporary(self, args, *, timeout=600, output=None):
        self.commands.append(["docker", "run", *args])
        if "du" in args:
            return "8 /source"
        if output is not None:
            output.write(archive())
            return ""
        if "python3" in args:
            return json.dumps({"integrity": "ok", "attachments": 0, "attachment_bytes": 0})
        return ""

    @contextlib.contextmanager
    def bound(self):
        with patch.object(ops, "ROOT", self.repo), patch.object(ops, "text", side_effect=self.text), \
                patch.object(ops, "run", side_effect=self.run), patch.object(ops, "temporary_run", side_effect=self.temporary), \
                patch.object(ops, "counts", return_value={"public.Report": 2}), \
                patch.object(ops, "emr_catalog", return_value={"synthetic": "emr catalog"}), contextlib.redirect_stdout(io.StringIO()):
            yield

    def capture(self, **kwargs):
        with self.bound():
            return ops.capture_held(self.parent, RESOURCES, shape=self.shape, label=kwargs.pop("label", "emr-b0"),
                                    config={"docker-compose.monitor.yml": self.repo / "docker-compose.monitor.yml"}, **kwargs)

    def lifecycle_commands(self):
        return [command for command in self.commands if command[:2] in (["docker", "start"], ["docker", "stop"], ["docker", "restart"])]


class HeldCaptureTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.folder = folder.name

    def test_01_pre_emr_capture_is_complete_private_and_validates_both_ways(self):
        host = FakeHost(self.folder)
        directory = host.capture()
        directory_, manifest, digest = ops.validate_held(directory)
        self.assertEqual(directory_, directory.resolve())
        self.assertEqual(manifest["shape"], "pre")
        self.assertIs(manifest["hold"]["resumed_by_capture"], False)
        self.assertEqual(set(manifest["sha256"]), set(ops.held_components(manifest, ["docker-compose.monitor.yml"])))
        self.assertNotIn("emr", manifest)
        self.assertEqual(manifest["resources"], RESOURCES)
        self.assertEqual(manifest["running_images"]["kin-api"]["id"], "sha256:" + "1" * 64)
        metadata = json.loads((directory / "metadata.json").read_text())
        self.assertEqual(metadata["env_names"], ["SYNTHETIC"])
        self.assertNotIn("placeholder", json.dumps(metadata))
        self.assertEqual(host.lifecycle_commands(), [])
        self.assertTrue(ops.HELD_NAME.fullmatch(directory.name) and not ops.DAILY_NAME.fullmatch(directory.name))
        if os.name == "posix":
            self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o700)
            for path in directory.iterdir():
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600, path.name)
        with host.bound(), patch.object(ops, "run", side_effect=host.run):
            ops.validate_backup(directory)
        self.assertEqual(len(digest), 64)

    def test_02_running_writers_refuse_before_anything_is_written(self):
        for role in ops.WRITER_ROLES:
            host = FakeHost(tempfile.mkdtemp(dir=self.folder))
            host.running[role] = True
            with self.subTest(role=role), self.assertRaisesRegex(RuntimeError, "Writers are not fenced: " + role):
                host.capture()
            self.assertFalse(host.parent.exists())
            self.assertFalse(any("pg_dump" in command for command in host.commands))

    def test_03_database_clients_refuse(self):
        host = FakeHost(self.folder)
        host.clients = "1"
        with self.assertRaisesRegex(RuntimeError, "Database clients remain"):
            host.capture()
        self.assertFalse(host.parent.exists())

    def test_04_shape_must_match_the_storage(self):
        host = FakeHost(tempfile.mkdtemp(dir=self.folder))
        host.emr_roles = True
        with self.assertRaisesRegex(RuntimeError, "pre-EMR capture found EMR storage"):
            host.capture()
        for extra in ({"schemas": ["public", "emr_clinical"]}, {"tablespaces": [{"name": "kin_emr_access"}]}):
            host = FakeHost(tempfile.mkdtemp(dir=self.folder))
            original = host.catalog
            host.catalog = lambda original=original, extra=extra: {**original(), **extra}
            with self.subTest(extra=extra), self.assertRaisesRegex(RuntimeError, "pre-EMR capture found EMR storage"):
                host.capture()
        host = FakeHost(tempfile.mkdtemp(dir=self.folder), shape="post")
        host.emr_roles = False
        with self.assertRaisesRegex(RuntimeError, "Post-EMR capture resources differ"):
            host.capture(label="emr-b1")
        host = FakeHost(tempfile.mkdtemp(dir=self.folder), shape="post")
        directory = host.capture(label="emr-b1")
        _, manifest, _ = ops.validate_held(directory)
        self.assertEqual(manifest["emr"], {"state_volume": RESOURCES["volumes"]["emr_state"], "tablespace": "kin_emr_access", "same_pause": True})
        self.assertTrue({"emr-state.tgz", "emr-catalog.json", "cluster-roles.sql"} <= set(manifest["sha256"]))

    def test_05_volumes_must_be_the_manifests(self):
        host = FakeHost(self.folder)
        other = dict(RESOURCES, volumes=dict(RESOURCES["volumes"], orthanc="pacs-starter-kit_orthanc-db"))
        with host.bound(), self.assertRaisesRegex(RuntimeError, "Orthanc volume differs"):
            ops.capture_held(host.parent, other, shape="pre", label="emr-b0")

    def test_06_a_failed_capture_keeps_writers_fenced_and_records_the_stage(self):
        host = FakeHost(self.folder)
        host.dump_failure = RuntimeError("simulated dump failure")
        with self.assertRaisesRegex(RuntimeError, "simulated dump failure"):
            host.capture()
        (directory,) = host.parent.iterdir()
        manifest = json.loads((directory / "manifest.json").read_text())
        self.assertFalse(manifest["complete"])
        self.assertEqual(manifest["backup_error"], {"stage": "dump kin", "type": "RuntimeError"})
        self.assertEqual(host.lifecycle_commands(), [])
        with self.assertRaisesRegex(RuntimeError, "incomplete"):
            ops.validate_held(directory)

    def test_07_tampered_unsafe_or_other_manifests_refuse(self):
        host = FakeHost(self.folder)
        directory = host.capture()
        _, _, digest = ops.validate_held(directory)
        with self.assertRaisesRegex(RuntimeError, "differs from the recorded one"):
            ops.validate_held(directory, "0" * 64)
        ops.validate_held(directory, digest)
        (directory / "kin.dump").write_bytes(b"changed")
        with self.assertRaisesRegex(RuntimeError, "checksum mismatch: kin.dump"):
            ops.validate_held(directory)
        host = FakeHost(tempfile.mkdtemp(dir=self.folder))
        directory = host.capture()
        unsafe = archive((("./index", b"x"), ("../escape", b"y")))
        (directory / "orthanc.tgz").write_bytes(unsafe)
        manifest = json.loads((directory / "manifest.json").read_text())
        manifest["sha256"]["orthanc.tgz"] = ops.digest(directory / "orthanc.tgz")
        (directory / "manifest.json").write_text(json.dumps(manifest))
        with self.assertRaisesRegex(RuntimeError, "Unsafe archive entry"):
            ops.validate_held(directory)

    def test_08_invalid_requests_refuse(self):
        host = FakeHost(self.folder)
        for kwargs in ({"shape": "other"}, {"label": "Bad Label"}, {"label": "../x"}):
            with host.bound(), self.subTest(kwargs=kwargs), self.assertRaises(RuntimeError):
                ops.capture_held(host.parent, RESOURCES, **{"shape": "pre", "label": "emr-b0", **kwargs})
        with host.bound(), self.assertRaisesRegex(RuntimeError, "outside the Git repository"):
            ops.capture_held(host.repo / "inside", RESOURCES, shape="pre", label="emr-b0")
        with host.bound(), self.assertRaisesRegex(RuntimeError, "Invalid configuration component"):
            ops.capture_held(host.parent, RESOURCES, shape="pre", label="emr-b0", config={"kin.dump": host.repo / ".env"})
        for facts in ({"origin": 1}, {"../x": "y"}, {"origin": "x" * 2000}):
            with host.bound(), self.subTest(facts=facts), self.assertRaisesRegex(RuntimeError, "Invalid capture facts"):
                ops.capture_held(host.parent, RESOURCES, shape="pre", label="emr-b0", facts=facts)
        self.assertFalse(host.parent.exists())
        directory = host.capture(facts={"origin": "https://pacs.example.invalid", "tls_certificate": "/etc/x/fullchain.pem"})
        self.assertEqual(json.loads((directory / "metadata.json").read_text())["facts"],
                         {"origin": "https://pacs.example.invalid", "tls_certificate": "/etc/x/fullchain.pem"})

    def test_09_rehearse_restores_a_held_capture_in_isolation(self):
        host = FakeHost(self.folder)
        directory = host.capture()
        host.commands.clear()
        with host.bound(), patch.object(ops, "remove_owned_if_present") as cleanup:
            ops.rehearse(directory)
        (record,) = directory.glob("rehearsal-*.json")
        result = json.loads(record.read_text())
        self.assertTrue(result["success"])
        self.assertEqual(result["audit"], "not_sealed")
        started = [command for command in host.commands if command[:3] == ["docker", "run", "-d"]]
        self.assertEqual(len(started), 1)
        self.assertIn("--network", started[0])
        self.assertEqual(started[0][started[0].index("--network") + 1], "none")
        self.assertTrue(cleanup.called)
        # A record beside the snapshot is not a component: the capture still validates exactly.
        ops.validate_held(directory)


if __name__ == "__main__":
    unittest.main(verbosity=2)
