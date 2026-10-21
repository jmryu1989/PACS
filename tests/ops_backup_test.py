"""Failure-path checks for backup/restore safety; no Docker mutations in this file.

test_18..test_23 (S7-AUDIT-STORE OB-01..OB-05): the audit seal and the rehearsal's restored-copy verification inside the
real backup/rehearse flow. The isolated verifier boundary is answered with synthetic digest streams (its PostgreSQL
behaviour is tests/audit_store_db_test.py); the manifest the flow wrote is fed to the unchanged ops_monitor.backup_status.
test_24 (OB-06, S7-AUDIT-STORE-F02) runs the real verifier boundary with a short time limit against the test-side fake
docker CLI of tests/ops_audit_integrity_test.py.
"""
from __future__ import annotations

import contextlib
import copy
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


def orthanc_archive(*, state=False, version=2, wal=None, extra=()):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w:gz") as archive:
        # This transport double declares the legacy state format; actual recovery
        # and its provenance are exercised separately against the immutable image.
        payload = json.dumps({"state": {"version": version}}).encode() if state else b"x"
        entry = tarfile.TarInfo("./seal/settlement.json" if state else "./index")
        entry.size = len(payload)
        archive.addfile(entry, io.BytesIO(payload))
        for name, data in ([('seal/settlement.jsonl', wal)] if wal is not None else []) + list(extra):
            entry = tarfile.TarInfo(name)
            entry.size = len(data)
            archive.addfile(entry, io.BytesIO(data))
    return stream.getvalue()


def daily_containers(repo):
    mounts = {
        'kin-api': [(ops.EMR_STATE, 'fixture-emr-state')],
        'kin-db': [('/var/lib/postgresql/data', 'fixture-pg')],
        'kin-orthanc': [('/var/lib/orthanc/db', 'fixture-volume')],
    }
    return [{"Name": "/" + name, "Id": hashlib.sha256(name.encode()).hexdigest(),
             "State": {"Running": True, "Restarting": False}, "Image": "sha256:" + "a" * 64,
             "Path": "sh", "Args": ["/app/start-production.sh", "serve"],
             "HostConfig": {"RestartPolicy": {"Name": "no"}},
             "Config": {"Labels": {"com.docker.compose.project": "fixture",
                                   "com.docker.compose.project.working_dir": str(repo)}},
             "Mounts": [{"Destination": target, "Type": "volume", "Name": volume, "RW": True}
                        for target, volume in mounts.get(name, [])]}
            for name in (*ops.CONTAINERS, "kin-proxy")]


def daily_inspection(args, info):
    if args[:2] == ['docker', 'inspect']:
        return 'false' if '--format' in args else json.dumps([row for row in info if row['Name'][1:] in args[2:]])
    if args[:3] == ['docker', 'volume', 'inspect']:
        return json.dumps([{'Name': args[-1], 'CreatedAt': '2026-10-21T00:00:00Z',
                            'Mountpoint': '/var/lib/docker/volumes/' + args[-1] + '/_data'}])
    if args[:3] == ['docker', 'container', 'ls']:
        return '\n'.join(row['Name'][1:] for row in info
                         if any(m.get('Name') == 'fixture-emr-state' for m in row['Mounts']))
    return None


def pg_role(name, *, superuser=False, login=False, inherit=True, connlimit=-1):
    return {"rolname": name, "rolsuper": superuser, "rolcreaterole": superuser, "rolcreatedb": superuser, "rolcanlogin": login,
            "rolreplication": superuser, "rolbypassrls": superuser, "rolinherit": inherit, "rolconnlimit": connlimit,
            "rolvaliduntil": None, "rolconfig": None}


def daily_role_catalog():
    """The role catalog of a post-EMR production cluster (bootstrap superuser kin) as a daily backup reads it (D23): the
    EMR roles and a further NOLOGIN role with a membership that pg_dumpall records as GRANTED BY kin."""
    roles = [pg_role("kin", superuser=True, login=True), pg_role("kin_emr_owner"), pg_role("kin_emr_reader"),
                      pg_role("kin_emr_retention"), pg_role("kin_legacy_group", inherit=False), pg_role("kin_legacy_reader", connlimit=3),
                      pg_role("kin_runtime", login=True)]
    return {"server_major": 16, "unsupported_verifiers": [], "login_verifiers": sorted(row["rolname"] for row in roles if row["rolcanlogin"]), "builtin_roles": [], "settings": [],
            "setting_names": ["search_path", "statement_timeout", "work_mem"],
            "role_comments": [[row["rolname"], None] for row in roles], "roles": roles,
            "memberships": [{"granted": "kin_legacy_group", "member": "kin_legacy_reader", "grantor": "kin", "admin_option": False, "inherit_option": True,
                             "set_option": True}],
            "databases": [{"name": "keycloak", "owner": "kin", "acl": ["=Tc/kin", "kin=CTc/kin"], "attributes": {"datistemplate": False, "datallowconn": True}},
                          {"name": "kin", "owner": "kin", "acl": ["=Tc/kin", "kin=CTc/kin", "kin_legacy_reader=c/kin"], "attributes": {"datistemplate": False, "datallowconn": True}},
                          *[{"name": name, "owner": "kin", "acl": ["=Tc/kin", "kin=CTc/kin"], "attributes": {"datistemplate": False, "datallowconn": True}} for name in ("postgres", "template0", "template1")]],
            "tablespaces": [{"name": "kin_emr_access", "owner": "kin_emr_owner", "location": ops.EMR_TABLESPACE},
                            {"name": "pg_default", "owner": "kin", "location": ""}, {"name": "pg_global", "owner": "kin", "location": ""}],
            "schemas": ["emr_access", "public"]}


class DailyCluster:
    """The fresh networkless rehearsal cluster of a daily EMR set restored by the catalog replay (D23): bootstrap superuser
    kin; it applies the CREATE ROLE / GRANT statements sent on stdin, the EMR tablespace and pg_restore --create; its
    databases, tablespaces and schemas are then the snapshot's (or `restored`, a restore that came out differently)."""

    def __init__(self, source, restored=None):
        self.source, self.restored = source, restored
        self.roles = {"kin": next(role for role in source["roles"] if role["rolname"] == "kin")}
        self.memberships, self.tablespace, self.restored_databases, self.statements = [], False, set(), []
        self.verifiers = set()

    def catalog(self):
        base = self.restored or self.source
        whole = self.restored_databases >= {"kin", "keycloak"}
        # A fresh cluster holds the image's postgres and templates and what pg_restore --create brought back: a source
        # database the set does not hold (and a setting scoped to it) never exists there. `restored` is echoed as given.
        present = {"postgres", "template0", "template1", *self.restored_databases}
        databases = base["databases"] if self.restored else [item for item in base["databases"] if item["name"] in present]
        settings = base["settings"] if self.restored else [entry for entry in base["settings"] if entry["database"] in (None, *present)]
        return {**{key: base[key] for key in ("server_major", "unsupported_verifiers", "login_verifiers", "builtin_roles", "setting_names")},
                "settings": settings,
                "login_verifiers": sorted(self.verifiers), "role_comments": [[name, None] for name in sorted(self.roles)], "roles": [self.roles[name] for name in sorted(self.roles)],
                "memberships": sorted(self.memberships, key=lambda item: (item["granted"], item["member"])),
                "databases": databases if whole else [{"name": "kin", "owner": "kin", "acl": []}, {"name": "postgres", "owner": "kin", "acl": []}],
                "tablespaces": base["tablespaces"] if self.tablespace else [item for item in base["tablespaces"] if item["name"].startswith("pg_")],
                "schemas": base["schemas"] if whole else ["public"]}

    def text(self, args, **kwargs):
        joined = " ".join(args)
        if ops.ROLE_CATALOG_SQL in args:
            return json.dumps(self.catalog())
        if "datname='keycloak'" in joined:
            return "%d:%d" % ("keycloak" in self.restored_databases, "kin" not in self.restored_databases)
        if "n.nspname='public'" in joined:
            return "0"
        raise AssertionError("unexpected rehearsal query " + joined[:80])

    def observe(self, args, input_file):
        import re as pattern
        joined = " ".join(args)
        if "psql" in args and input_file is not None:
            sql = input_file.read().decode("utf-8", errors="replace")
            self.statements.append(sql)
            self.verifiers.update(pattern.findall(r'ALTER ROLE "([^"]+)" PASSWORD ', sql))
            for name, flags in pattern.findall(r'CREATE ROLE "([^"]+)" WITH ([^;]+);', sql):
                words = flags.split()
                self.roles[name] = {**pg_role(name), "rolsuper": "SUPERUSER" in words, "rolcreaterole": "CREATEROLE" in words,
                                    "rolcreatedb": "CREATEDB" in words, "rolcanlogin": "LOGIN" in words, "rolreplication": "REPLICATION" in words,
                                    "rolbypassrls": "BYPASSRLS" in words, "rolinherit": "INHERIT" in words,
                                    "rolconnlimit": int(words[words.index("LIMIT") + 1])}
            for granted, member, admin, inherit, setting in pattern.findall(
                    r'GRANT "([^"]+)" TO "([^"]+)" WITH ADMIN (TRUE|FALSE), INHERIT (TRUE|FALSE), SET (TRUE|FALSE);', sql):
                self.memberships.append({"granted": granted, "member": member, "grantor": "kin", "admin_option": admin == "TRUE",
                                         "inherit_option": inherit == "TRUE", "set_option": setting == "TRUE"})
        elif "CREATE TABLESPACE kin_emr_access" in joined:
            self.tablespace = True
        elif "pg_restore" in args and input_file is not None:
            self.restored_databases.add(Path(input_file.name).name.split(".")[0])


class Host:
    """The fake host of test_14 (all writers running) with a private backup parent beside the repository, recording
    every command and the order of pause, resume, readiness and seal."""

    def __init__(self, temporary):
        self.repo = Path(temporary) / "repo"
        self.repo.mkdir()
        for filename in ops.FILES[3:]:
            (self.repo / filename).write_text("TEST_ONLY=placeholder")
        (self.repo / ".env").write_text("POSTGRES_PASSWORD=synthetic-fixture\nKIN_EMR_RUNTIME_PASSWORD=synthetic-runtime\n")
        self.parent = Path(temporary) / "backups"
        self.parent.mkdir(mode=0o700)
        self.info = daily_containers(self.repo)
        self.events = []
        self.sources = []
        self.catalog = {"synthetic": "catalog"}
        self.restored_catalog = None
        self.restore_answer = "EMR_RESTORE_VERIFIED"
        self.state_archive = orthanc_archive(state=True)
        # D23: the cluster's role catalog the backup records, and (when set) what a rehearsal's restore comes out with.
        self.role_catalog = daily_role_catalog()
        self.restored_role_catalog = None
        self.cluster = None
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
        inspection = daily_inspection(args, self.info)
        if inspection is not None:
            return inspection
        if args[:3] == ["docker", "image", "inspect"]:
            return '[{"RepoDigests": []}]'
        if "pg_database_size('kin')" in " ".join(args):
            return "4096"
        if "pg_stat_activity" in " ".join(args):
            return "0"
        if ops.ROLE_CATALOG_SQL in args:
            return json.dumps(self.role_catalog)
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
            kwargs["output"].write(self.state_archive if any("emr-state" in word for word in args) else orthanc_archive())
            return ""
        return json.dumps({"integrity": "ok", "attachments": 0, "attachment_bytes": 0}) if "python3" in args else self.restore_answer

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
                patch.object(ops, "emr_catalog", return_value=self.catalog), \
                patch.object(ops, "counts", return_value={"public.Report": 5}), \
                patch.object(ops, "wait_ready", side_effect=lambda *a: self.events.append(("ready",))), \
                patch.object(audit, "evaluate", side_effect=self.boundary(answer)), \
                contextlib.redirect_stdout(io.StringIO()):
            try:
                ops.backup(self.parent)
            except RuntimeError as caught:
                error = caught
        folders = {entry.name for entry in self.parent.iterdir()} - before
        if not folders:
            return None, None, error
        folder = next(self.parent / name for name in folders)
        return folder, json.loads((folder / "manifest.json").read_text(encoding="utf-8")), error

    def rehearse(self, folder, answer):
        """One ops.rehearse run whose restored-copy verification is answered with `answer`."""
        self.events.clear()
        self.sources.clear()
        error = None
        cleanup = Mock()
        earlier = set(folder.glob("rehearsal-*.json"))
        recorded = json.loads((folder / "manifest.json").read_text(encoding="utf-8")).get("role_catalog")
        self.cluster = DailyCluster(recorded or self.role_catalog, self.restored_role_catalog)

        def rehearsal_run(args, **kwargs):
            self.events.append(("command", list(args)))
            self.cluster.observe(args, kwargs.get("input_file"))
            return SimpleNamespace(returncode=0, stdout=b"", stderr=b"")
        with patch.object(ops, "run", side_effect=rehearsal_run), patch.object(ops, "text", side_effect=self.cluster.text), \
                patch.object(ops, "temporary_run", side_effect=self.fake_archive), \
                patch.object(ops, "emr_catalog", return_value=self.restored_catalog or self.catalog), \
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
            info = daily_containers(root)
            next(item for item in info if item['Name'] == '/kin-keycloak')['State']['Running'] = False

            def fake_text(args, **kwargs):
                inspection = daily_inspection(args, info)
                if inspection is not None:
                    return inspection
                if "pg_database_size('kin')" in " ".join(args):
                    return "4096"
                if args[:3] == ["docker", "image", "inspect"]:
                    return '[{"RepoDigests": []}]'
                if "pg_stat_activity" in " ".join(args):
                    return "0"
                if ops.ROLE_CATALOG_SQL in args:
                    return json.dumps(daily_role_catalog())
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
                    patch.object(ops, "temporary_run", side_effect=lambda args, **kw:
                        "8 /source" if "-sk" in args else kw["output"].write(orthanc_archive(state=True))), \
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
            info = daily_containers(root)

            def fake_text(args, **kwargs):
                inspection = daily_inspection(args, info)
                if inspection is not None:
                    return inspection
                if args[:3] == ["docker", "image", "inspect"]:
                    return '[{"RepoDigests": []}]'
                if "pg_database_size('kin')" in " ".join(args):
                    return "4096"
                if "pg_stat_activity" in " ".join(args):
                    return "0"
                if ops.ROLE_CATALOG_SQL in args:
                    return json.dumps(daily_role_catalog())
                return "" if "status" in args else "a"*40

            def fake_run(args, **kwargs):
                if "pg_dump" in args or "pg_dumpall" in args:
                    kwargs["output"].write(b"fixture dump")
                return SimpleNamespace(returncode=0, stdout=b"")

            def fake_archive(args, **kwargs):
                if "-sk" in args:
                    return "8 /source"
                kwargs["output"].write(orthanc_archive(state=any("emr-state" in word for word in args)))
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
            clusters = []

            def rehearsal_run(args, **kwargs):
                # This boundary test simulates provisioning and the catalog replay of the fresh cluster (D23) only; the
                # real verifier/exporter still hits FakeDocker and its watchdog. B L07/L19 exercise these statements on
                # PostgreSQL itself.
                if args[:3] == ["docker", "run", "-d"]:
                    clusters.append(DailyCluster(json.loads((sealed / "manifest.json").read_text(encoding="utf-8"))["role_catalog"]))
                if args[:2] == ["docker", "exec"] and "pg_restore" in args:
                    clusters[-1].observe(args, kwargs.get("input_file"))
                elif args[:2] == ["docker", "exec"] and ("mkdir" in args or "psql" in args):
                    clusters[-1].observe(args, kwargs.get("input_file"))
                    try:
                        answer = clusters[-1].text(args)
                    except AssertionError:
                        answer = ""
                    return SimpleNamespace(returncode=0, stdout=answer.encode(), stderr=b"")
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
                        # D23: the restored copy is a cluster whose bootstrap superuser is kin (the catalog replay).
                        self.assertEqual((proof["target"]["database"], proof["target"]["role"]), ("kin", "kin"))
                    self.assertEqual(result["cleanup_failures"], [])
                    self.assertFalse((host.repo / ".kin-ops.lock").exists(), "the operations lock is released")
                    self.assertEqual(fake.running(), [])
                    self.assertEqual((fake.names("containers"), fake.names("volumes")), ([], []))
                    self.assertEqual(host.files(sealed), before)


class EmrRestoreVerification(unittest.TestCase):
    """REQ-EMR-19/20 -> RISK-EMR-LOSS/PRIVILEGE -> TEST-EMR-B-F09.

    Exercise the real backup validation and rehearsal verdict with file corruption and observed catalog differences.
    Only Docker/catalog and ledger IO are synthetic here; L19 verifies the same flow with real PostgreSQL and state.
    Audit-only scratch databases may ignore physical placement; the deployment rehearsal must never do so.
    """

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.host = Host(temporary.name)
        self.host.catalog = {
            "schema": {"owner": "kin_emr_owner", "acl": "kin_runtime=U/kin_emr_owner"},
            "roles": [{"rolname": name, "rolsuper": False, "rolcanlogin": name != "kin_emr_owner"}
                      for name in ("kin_emr_owner", "kin_runtime", "kin_emr_reader", "kin_emr_retention")],
            "memberships": None,
            "tablespace": {"name": "kin_emr_access", "owner": "kin_emr_owner", "acl": None},
            "tables": [{"name": "member_identity", "owner": "kin_emr_owner", "acl": None,
                        "tablespace": "kin_emr_access"}],
            "functions": [{"signature": "emr_access.append_access(text)", "owner": "kin_emr_owner",
                           "acl": "kin_runtime=X/kin_emr_owner", "security_definer": True,
                           "configuration": ["search_path=pg_catalog, emr_access"]}],
        }
        self.host.init_ledger()
        self.answer = rows_stream({1: "synthetic-audit"})
        self.folder, self.manifest, error = self.host.backup(self.answer)
        self.assertIsNone(error)

    def assert_restore_refused(self):
        before = self.host.files(self.folder)
        result, error, _, cleanup = self.host.rehearse(self.folder, self.answer)
        self.assertIsInstance(error, RuntimeError)
        self.assertFalse(result["success"])
        self.assertEqual(result["cleanup_failures"], [])
        self.assertEqual(cleanup.call_count, 3)
        self.assertEqual(self.host.files(self.folder), before)

    def test_b_layout_and_same_pause_components_restore(self):
        self.assertTrue(self.manifest["emr"]["same_pause"])
        self.assertTrue(set(ops.EMR_FILES).issubset(self.manifest["sha256"]))
        result, error, _, cleanup = self.host.rehearse(self.folder, self.answer)
        self.assertIsNone(error)
        self.assertTrue(result["success"])
        self.assertEqual(result["emr"], {"owner_acl_preserved": True, "database_state_verified": True})
        self.assertTrue(result["audit"]["verified"])
        self.assertEqual(cleanup.call_count, 3)

    def test_tampered_and_partial_components_refuse_before_restore(self):
        for name in ("kin.dump", *ops.EMR_FILES):
            path = self.folder / name
            original = path.read_bytes()
            for missing in (False, True):
                with self.subTest(component=name, missing=missing):
                    try:
                        if missing:
                            path.unlink()
                        else:
                            path.write_bytes(original + b"tampered")
                        with patch.object(ops, "run") as docker_boundary:
                            with self.assertRaises(RuntimeError):
                                ops.validate_backup(self.folder)
                            docker_boundary.assert_not_called()
                    finally:
                        path.write_bytes(original)

    def test_missing_or_moved_tablespace_refused(self):
        for missing in (False, True):
            with self.subTest(missing=missing):
                changed = copy.deepcopy(self.host.catalog)
                if missing:
                    changed["tablespace"] = None
                else:
                    changed["tables"][0]["tablespace"] = None
                self.host.restored_catalog = changed
                self.assert_restore_refused()

    def test_wrong_owner_refused(self):
        for field in ("schema", "tablespace", "tables", "functions"):
            with self.subTest(field=field):
                changed = copy.deepcopy(self.host.catalog)
                item = changed[field][0] if isinstance(changed[field], list) else changed[field]
                item["owner"] = "kin_runtime"
                self.host.restored_catalog = changed
                self.assert_restore_refused()

    def test_changed_acl_refused(self):
        changed = copy.deepcopy(self.host.catalog)
        changed["tables"][0]["acl"] = "kin_runtime=arwdDxt/kin_emr_owner"
        self.host.restored_catalog = changed
        self.assert_restore_refused()

    def test_changed_roles_refused(self):
        changed = copy.deepcopy(self.host.catalog)
        changed["roles"][0]["rolcanlogin"] = True
        self.host.restored_catalog = changed
        self.assert_restore_refused()

    def test_database_external_state_disagreement_refused(self):
        self.host.restore_answer = "unverified"
        self.assert_restore_refused()

    def test_unattested_pause_refused(self):
        self.manifest["emr"]["same_pause"] = False
        (self.folder / "manifest.json").write_text(json.dumps(self.manifest), encoding="utf-8")
        with patch.object(ops, "run") as docker_boundary:
            with self.assertRaises(RuntimeError):
                ops.rehearse(self.folder)
            docker_boundary.assert_not_called()

    def test_missing_state_volume_refuses_before_pause_or_dump(self):
        api = next(item for item in self.host.info if item['Name'] == '/kin-api')
        api['Mounts'] = [mount for mount in api['Mounts'] if mount['Destination'] != ops.EMR_STATE]
        before = set(self.host.parent.iterdir())
        with patch.object(ops, 'ROOT', self.host.repo), patch.object(ops, 'text', side_effect=self.host.fake_text), \
                patch.object(ops, 'run') as commands, patch.object(ops, 'temporary_run') as helpers:
            with self.assertRaisesRegex(RuntimeError, 'Expected one named EMR state volume'):
                ops.backup(self.host.parent)
            commands.assert_not_called()
            helpers.assert_not_called()
        self.assertEqual(set(self.host.parent.iterdir()), before)

    def test_connected_database_client_refuses_dump_and_resumes_writers(self):
        original = self.host.fake_text
        def connected(args, **kwargs):
            return '1' if 'pg_stat_activity' in ' '.join(args) else original(args, **kwargs)
        self.host.events.clear()
        with patch.object(self.host, 'fake_text', side_effect=connected):
            _, manifest, error = self.host.backup(self.answer)
        self.assertIsInstance(error, RuntimeError)
        self.assertIn('Database clients remain', str(error))
        self.assertFalse(manifest['complete'])
        commands = [event[1] for event in self.host.events if event[0] == 'command']
        self.assertFalse(any('pg_dump' in command or 'pg_dumpall' in command for command in commands))
        resumed = [name for command in commands if command[:2] == ['docker', 'start'] for name in command[2:]]
        self.assertCountEqual(resumed, ops.CONTAINERS[:-1])

    def test_d23_a_daily_set_is_rehearsed_by_the_catalog_replay_and_refuses_a_differing_restore(self):
        """D23: a daily EMR set records the cluster's role catalog inside the writer pause; its rehearsal starts a cluster
        whose bootstrap superuser is kin, replays the roles and memberships from that catalog (never pg_dumpall's
        GRANTED BY statements as postgres), compares the restored role catalog and verifies the seal as kin. A restore
        whose catalog differs is refused."""
        self.assertEqual(self.manifest["role_catalog"], daily_role_catalog())
        kinds = [" ".join(event[1][:2]) if event[0] == "command" else event[0] for event in self.host.events]
        read = next(index for index, event in enumerate(self.host.events) if event[0] == "command" and ops.ROLE_CATALOG_SQL in event[1])
        self.assertLess(kinds.index("docker stop"), read)
        self.assertLess(read, kinds.index("docker start"), "the role catalog is read inside the writer pause")
        result, error, _, cleanup = self.host.rehearse(self.folder, self.answer)
        self.assertIsNone(error, error)
        self.assertTrue(result["success"] and result["audit"]["verified"])
        self.assertEqual((result["roles"], result["catalog"]["catalog"]), ("catalog replay", "equal"))
        commands = [event[1] for event in self.host.events if event[0] == "command"]
        started = next(command for command in commands if command[:3] == ["docker", "run", "-d"])
        self.assertIn("POSTGRES_USER=kin", started)
        self.assertFalse(any("-U" in command and command[command.index("-U") + 1] == "postgres" for command in commands),
                         "nothing runs as postgres in the rehearsal cluster")
        self.assertEqual(self.host.cluster.memberships, daily_role_catalog()["memberships"])
        self.assertFalse(any("GRANTED BY" in sql for sql in self.host.cluster.statements))
        changed = daily_role_catalog()
        changed["databases"][1]["acl"] = ["=Tc/kin", "kin=CTc/kin"]
        self.host.restored_role_catalog = changed
        result, error, _, _ = self.host.rehearse(self.folder, self.answer)
        self.assertIsInstance(error, RuntimeError)
        self.assertIn("Restored catalog differs from the snapshot: databases", str(error))
        self.assertFalse(result["success"])

    def test_d23_an_older_daily_set_without_a_role_catalog_keeps_its_previous_rehearsal(self):
        """D23: a set made before the role catalog was recorded is rehearsed as before (pg_dumpall roles as postgres)."""
        manifest = dict(self.manifest)
        manifest.pop("role_catalog")
        ops.write_json(self.folder / "manifest.json", manifest)
        result, error, _, _ = self.host.rehearse(self.folder, self.answer)
        self.assertIsNone(error, error)
        self.assertTrue(result["success"])
        commands = [event[1] for event in self.host.events if event[0] == "command"]
        started = next(command for command in commands if command[:3] == ["docker", "run", "-d"])
        self.assertNotIn("POSTGRES_USER=kin", started)
        self.assertTrue(any(command[:3] == ["docker", "exec", "-i"] and "psql" in command and command[command.index("-U") + 1] == "postgres"
                            for command in commands))

    def test_r5_02_a_database_outside_the_daily_set_is_named_and_the_set_still_compared(self):
        """R5-02 (PR #175 CI emr-b, live L19): a daily set dumps kin and keycloak only, so a further database of the
        source cluster (L19's cluster still holds L06's l06_tampered) and a setting scoped to it are outside the set: the
        rehearsal names it instead of refusing a complete set, and replays and compares everything the set holds. A
        restore that yields a database the set does not hold, or whose kin ACL differs, is still refused; a held
        (whole-cluster) capture still refuses the further database."""
        def outside_database(name):
            return {"name": name, "owner": "kin", "acl": ["=Tc/kin", "kin=CTc/kin"], "attributes": {"datistemplate": False, "datallowconn": True}}
        captured = daily_role_catalog()
        captured["databases"] = sorted([*captured["databases"], outside_database("l06_tampered")], key=lambda item: item["name"])
        captured["settings"] = [{"database": "kin", "role": None, "config": ["work_mem=8MB"]},
                                {"database": "l06_tampered", "role": None, "config": ["work_mem=4MB"]}]
        self.host.role_catalog = captured
        folder, manifest, error = self.host.backup(self.answer)
        self.assertIsNone(error, error)
        self.assertEqual(manifest["role_catalog"], captured, "the manifest keeps the cluster as captured")
        result, error, _, _ = self.host.rehearse(folder, self.answer)
        self.assertIsNone(error, error)
        self.assertTrue(result["success"] and result["audit"]["verified"])
        self.assertEqual((result["databases_outside_set"], result["catalog"]["catalog"]), (["l06_tampered"], "equal"))
        replayed = "".join(self.host.cluster.statements)
        self.assertIn('ALTER ROLE ALL IN DATABASE "kin" SET "work_mem" TO', replayed)
        self.assertNotIn("l06_tampered", replayed)
        in_set = copy.deepcopy(captured)
        in_set["databases"] = [item for item in in_set["databases"] if item["name"] != "l06_tampered"]
        in_set["settings"] = in_set["settings"][:1]
        extra_restored = copy.deepcopy(in_set)
        extra_restored["databases"] = sorted([*extra_restored["databases"], outside_database("kin_scratch")], key=lambda item: item["name"])
        acl_changed = copy.deepcopy(in_set)
        next(item for item in acl_changed["databases"] if item["name"] == "kin")["acl"] = ["=Tc/kin", "kin=CTc/kin"]
        for label, restored in (("a database the set does not hold", extra_restored), ("kin's ACL", acl_changed)):
            with self.subTest(restored=label):
                self.host.restored_role_catalog = restored
                result, error, _, _ = self.host.rehearse(folder, self.answer)
                self.assertIsInstance(error, RuntimeError)
                self.assertIn("Restored catalog differs from the snapshot: databases", str(error))
                self.assertFalse(result["success"])
        with self.assertRaisesRegex(ops.RestoreAdmissionError, "the databases are not exactly kin and keycloak"):
            ops.supported_catalog(captured, shape="post")

    def test_unsafe_emr_archive_refused_despite_matching_checksum(self):
        archive_path = self.folder / 'emr-state.tgz'
        for name, kind in [('../outside', tarfile.REGTYPE), ('/absolute', tarfile.REGTYPE),
                           ('seal/link', tarfile.SYMTYPE), ('seal/device', tarfile.CHRTYPE)]:
            with self.subTest(name=name):
                with tarfile.open(archive_path, 'w:gz') as archive:
                    entry = tarfile.TarInfo(name)
                    entry.type = kind
                    entry.linkname = '../outside' if kind == tarfile.SYMTYPE else ''
                    archive.addfile(entry)
                self.manifest['sha256']['emr-state.tgz'] = ops.digest(archive_path)
                self.manifest['bytes']['emr-state.tgz'] = archive_path.stat().st_size
                ops.write_json(self.folder / 'manifest.json', self.manifest)
                with patch.object(ops, 'run') as commands:
                    with self.assertRaisesRegex(RuntimeError, 'Unsafe EMR archive entry'):
                        ops.validate_backup(self.folder)
                    commands.assert_not_called()


class DailyStateAdmissionTests(unittest.TestCase):
    """REQ-B2C-01/10 -> RISK-B2C-DUAL-OWNER/WRONG-STATE-RECOVERY -> D1656-T03/04/08.

    Run the daily backup consumer with a synthetic engine and actual archive bytes.
    These checks establish refusal/continuity, not original-reader or Linux acceptance.
    """
    def make_host(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        host = Host(temporary.name)
        host.init_ledger()
        return host

    @staticmethod
    def launches(host):
        return [event[1] for event in host.events if event[0] == 'command' and event[1][:2] == ['docker', 'start']]

    def test_original_format_backup_keeps_bytes_and_resumes_original_writers(self):
        host = self.make_host()
        host.state_archive = orthanc_archive(state=True, wal=b'{"version":2}\n{"torn":')
        before = host.state_archive
        folder, manifest, error = host.backup(rows_stream({1: 'synthetic-audit'}))
        self.assertIsNone(error)
        self.assertTrue(manifest['complete'])
        self.assertEqual((folder / 'emr-state.tgz').read_bytes(), before)
        self.assertEqual(host.state_archive, before)
        self.assertEqual(self.launches(host), [['docker', 'start', name] for name in ops.CONTAINERS[:-1]])

    def test_unsupported_state_refuses_before_pause_capture_or_launch(self):
        cases = {
            'v3': orthanc_archive(state=True, version=3),
            'unknown': orthanc_archive(state=True, version=99),
            'mixed-wal': orthanc_archive(state=True, wal=b'{"version":3}\n'),
            'missing-checkpoint': orthanc_archive(),
            'malformed-wal': orthanc_archive(state=True, wal=b'{bad}\n'),
            'duplicate-version': orthanc_archive(state=True, wal=b'{"version":2,"version":3}\n'),
            'duplicate-path': orthanc_archive(state=True, extra=[('seal/settlement.json', b'{}')]),
            'unsafe-path': orthanc_archive(state=True, extra=[('../outside', b'x')]),
        }
        for name, raw in cases.items():
            with self.subTest(name=name):
                host = self.make_host()
                host.state_archive = raw
                before = copy.deepcopy(host.info)
                folder, manifest, error = host.backup(rows_stream({1: 'synthetic-audit'}))
                self.assertIsInstance(error, RuntimeError)
                self.assertIsNone(folder)
                self.assertIsNone(manifest)
                self.assertEqual(host.info, before)
                self.assertEqual(host.state_archive, raw)
                self.assertFalse(any(event[0] == 'command' and
                    (event[1][:2] in (['docker', 'start'], ['docker', 'stop']) or 'pg_dump' in event[1])
                    for event in host.events))

    def test_changed_executable_or_volume_never_resumes_even_after_dump_failure(self):
        for field in ('Id', 'Image', 'Args', 'Config', 'Mounts', 'volume-created'):
            with self.subTest(field=field):
                host = self.make_host()
                original_run, original_text = host.fake_run, host.fake_text
                changed = False

                def fail_dump(args, **kwargs):
                    nonlocal changed
                    if 'pg_dump' in args:
                        changed = True
                        api = next(row for row in host.info if row['Name'] == '/kin-api')
                        if field == 'Id': api['Id'] = 'b' * 64
                        if field == 'Image': api['Image'] = 'sha256:' + 'b' * 64
                        if field == 'Args': api['Args'] = ['-e', 'unknown executable']
                        if field == 'Config': api['Config']['Env'] = ['NODE_OPTIONS=--require=/tmp/other.js']
                        if field == 'Mounts': api['Mounts'][0]['Name'] = 'other-state'
                        raise RuntimeError('synthetic dump failure')
                    return original_run(args, **kwargs)

                def inspect(args, **kwargs):
                    value = original_text(args, **kwargs)
                    if changed and field == 'volume-created' and args[:3] == ['docker', 'volume', 'inspect']:
                        rows = json.loads(value)
                        rows[0]['CreatedAt'] = '2026-10-21T01:00:00Z'
                        return json.dumps(rows)
                    return value

                with patch.object(host, 'fake_run', side_effect=fail_dump), patch.object(host, 'fake_text', side_effect=inspect):
                    folder, manifest, error = host.backup(rows_stream({1: 'synthetic-audit'}))
                self.assertIsInstance(error, RuntimeError)
                self.assertFalse(manifest['complete'])
                self.assertEqual(manifest['backup_error']['stage'], 'dump kin')
                self.assertIn('kin-api', manifest['resume_failures'])
                self.assertEqual(self.launches(host), [])
                self.assertTrue((folder / 'manifest.json').is_file())

    def test_state_replacement_before_finally_refuses_owner_resume_and_preserves_snapshot(self):
        host = self.make_host()
        original_archive = host.fake_archive
        captured = host.state_archive
        replacement = orthanc_archive(state=True, version=3)

        def archive(args, **kwargs):
            value = original_archive(args, **kwargs)
            output = kwargs.get('output')
            if output is not None and str(getattr(output, 'name', '')).endswith('emr-state.tgz'):
                host.state_archive = replacement
            return value

        with patch.object(host, 'fake_archive', side_effect=archive):
            folder, manifest, error = host.backup(rows_stream({1: 'synthetic-audit'}))
        self.assertIsInstance(error, RuntimeError)
        self.assertTrue(manifest['complete'])
        self.assertEqual(manifest['resume_failures'], ['kin-api'])
        self.assertNotIn(['docker', 'start', 'kin-api'], self.launches(host))
        self.assertEqual((folder / 'emr-state.tgz').read_bytes(), captured)
        self.assertEqual(host.state_archive, replacement)

    def test_same_volume_changed_bytes_at_inspection_handoff_refuse(self):
        host = self.make_host()
        original_archive = host.fake_archive
        count = 0
        replacement = orthanc_archive(state=True, extra=[('journal/records', b'changed')])

        def archive(args, **kwargs):
            nonlocal count
            value = original_archive(args, **kwargs)
            if kwargs.get('output') is not None:
                count += 1
                if count == 1:
                    host.state_archive = replacement
            return value

        with patch.object(host, 'fake_archive', side_effect=archive):
            folder, _, error = host.backup(rows_stream({1: 'synthetic-audit'}))
        self.assertIsInstance(error, RuntimeError)
        self.assertIsNone(folder)
        self.assertEqual(host.state_archive, replacement)
        self.assertEqual(self.launches(host), [])

    def test_additional_active_or_restartable_owner_refuses(self):
        for running, restart in ((True, 'no'), (False, 'always'), (False, 'unless-stopped')):
            with self.subTest(running=running, restart=restart):
                host = self.make_host()
                retained = copy.deepcopy(host.info[0])
                retained.update(Name='/retained-old-owner', Id='b' * 64)
                retained['State']['Running'] = running
                retained['HostConfig']['RestartPolicy']['Name'] = restart
                host.info.append(retained)
                folder, _, error = host.backup(rows_stream({1: 'synthetic-audit'}))
                self.assertIsInstance(error, RuntimeError)
                self.assertIsNone(folder)
                self.assertEqual(self.launches(host), [])

    def test_owner_inventory_is_rechecked_after_state_inspection(self):
        host = self.make_host()
        original_archive = host.fake_archive
        appeared = False

        def archive(args, **kwargs):
            nonlocal appeared
            value = original_archive(args, **kwargs)
            if kwargs.get('output') is not None and not appeared:
                appeared = True
                retained = copy.deepcopy(host.info[0])
                retained.update(Name='/late-owner', Id='b' * 64)
                host.info.append(retained)
            return value

        with patch.object(host, 'fake_archive', side_effect=archive):
            folder, _, error = host.backup(rows_stream({1: 'synthetic-audit'}))
        self.assertIsInstance(error, RuntimeError)
        self.assertIsNone(folder)
        self.assertEqual(self.launches(host), [])

    def test_unknown_start_retains_operations_lease_and_complete_snapshot(self):
        host = self.make_host()
        original_run = host.fake_run

        def run(args, **kwargs):
            value = original_run(args, **kwargs)
            if args == ['docker', 'start', 'kin-api']:
                raise subprocess.TimeoutExpired('synthetic docker start', 120)
            return value

        with patch.object(host, 'fake_run', side_effect=run):
            folder, manifest, error = host.backup(rows_stream({1: 'synthetic-audit'}))
        self.assertIsInstance(error, RuntimeError)
        self.assertTrue(manifest['complete'])
        self.assertEqual(manifest['resume_failures'], ['kin-api'])
        self.assertTrue((host.repo / '.kin-ops.lock').is_file())
        self.assertEqual((folder / 'emr-state.tgz').read_bytes(), host.state_archive)
        # The next cooperating operation cannot silently discard unknown work.
        with patch.object(ops, 'ROOT', host.repo), self.assertRaises(FileExistsError):
            with ops.lock():
                self.fail('retained lock was bypassed')

    def test_unknown_stop_never_races_a_resume_and_retains_incomplete_capture(self):
        host = self.make_host()
        original_run = host.fake_run

        def run(args, **kwargs):
            value = original_run(args, **kwargs)
            if args[:2] == ['docker', 'stop']:
                raise subprocess.TimeoutExpired('synthetic docker stop', 180)
            return value

        with patch.object(host, 'fake_run', side_effect=run):
            try:
                folder, manifest, error = host.backup(rows_stream({1: 'synthetic-audit'}))
            except subprocess.TimeoutExpired:
                # The old consumer lets the timeout escape after starting writers.
                folder = next(host.parent.glob('20*-*'))
                manifest = json.loads((folder / 'manifest.json').read_text())
        self.assertFalse(manifest['complete'])
        self.assertEqual(manifest['backup_error']['stage'], 'stop writers')
        self.assertEqual(self.launches(host), [])
        self.assertEqual(manifest['resume_failures'], list(ops.CONTAINERS[:-1]))
        self.assertTrue((host.repo / '.kin-ops.lock').is_file())


V3_ORIGIN = {"instanceId": "fixture-pair", "chains": {"viewing": "7c0b6e8e-1c1b-4a3a-8f2e-1a2b3c4d5e01", "history": "7c0b6e8e-1c1b-4a3a-8f2e-1a2b3c4d5e02"},
             "database": {"database": "kin", "oid": 16384, "address": "172.18.0.2", "port": 5432}}


def v3_archive(*, lineage="3b1c9d4e-0b7a-4c1d-9e8f-0a1b2c3d4e5f", origin=None, wal=b'{"version":3}\n', extra=(), checkpoint=None):
    """A v3 state capture as the service leaves it: checkpoint with its lineage/origin, WAL, tail; identifiers only."""
    stream = io.BytesIO()
    document = checkpoint if checkpoint is not None else {"state": {"version": 3, "revision": 4, "generation": 2, "lineage": {
        "version": 1, "id": lineage, "origin": origin or V3_ORIGIN}}}
    with tarfile.open(fileobj=stream, mode="w:gz") as archive:
        for name, data in ([("./seal/settlement.json", json.dumps(document).encode()), ("./seal/settlement.jsonl", wal),
                            ("./seal/tail.json", b'{"streams":{}}')] + list(extra)):
            entry = tarfile.TarInfo(name)
            entry.size, entry.uid, entry.gid, entry.mode = len(data), 1000, 1000, 0o600
            archive.addfile(entry, io.BytesIO(data))
    return stream.getvalue()


def service_containers(repo):
    """The (c) deployment: the state service owns the state volume; the API is its client over the read-only IPC volume."""
    info = daily_containers(repo)
    api = next(item for item in info if item["Name"] == "/kin-api")
    api["Mounts"] = [{"Destination": "/run/kin-emr-api", "Type": "volume", "Name": "fixture-api-ipc", "RW": False}]
    api["Config"]["Env"] = ["DATABASE_URL=postgresql://kin_runtime:synthetic-runtime@db:5432/kin", "KIN_EMR_INSTANCE_ID=fixture-pair",
                            "KIN_EMR_STATE_SOCKET=/run/kin-emr-api/writer.sock", "PUBLIC_ORIGIN=https://localhost:9443"]
    api["HostConfig"]["NetworkMode"] = "fixture_default"
    service = copy.deepcopy(api)
    service.update(Name="/" + ops.STATE_SERVICE, Id=hashlib.sha256(b"kin-emr-state").hexdigest(),
                   Path="sh", Args=["/app/start-production.sh", "state-serve-v3"])
    service["Config"]["Labels"]["com.docker.compose.service"] = "emr-state"
    service["Config"]["Env"] = ["DATABASE_URL=postgresql://kin_emr_reader:synthetic-reader@db:5432/kin", "KIN_EMR_STATE_DIR=" + ops.EMR_STATE,
                                "KIN_EMR_INSTANCE_ID=fixture-pair", "KIN_EMR_API_SOCKET=/run/kin-emr-api/writer.sock",
                                "KIN_EMR_RETENTION_SOCKET=/run/kin-emr-retention/writer.sock"]
    service["Mounts"] = [{"Destination": ops.EMR_STATE, "Type": "volume", "Name": "fixture-emr-state", "RW": True},
                         {"Destination": "/run/kin-emr-api", "Type": "volume", "Name": "fixture-api-ipc", "RW": True},
                         {"Destination": "/run/kin-emr-retention", "Type": "volume", "Name": "fixture-retention-ipc", "RW": True}]
    info.append(service)
    return info


class ServiceHost(Host):
    """The fake (c) host: the service's container state, exit code and closed lines follow the stop/start commands the
    backup issues; the readiness observer (a non-promoting client over the IPC socket) answers `ready`."""

    def __init__(self, temporary):
        super().__init__(temporary)
        self.info = service_containers(self.repo)
        self.state_archive = v3_archive()
        self.service = {"running": True, "exit_code": None, "lines": ["EMR_STATE_READY"]}
        self.close_lines = ["EMR_STATE_CLOSED"]
        self.close_exit = 0
        self.ready = True
        self.observer_runs = 0

    def fake_text(self, args, **kwargs):
        joined = " ".join(args)
        if args[:3] == ["docker", "container", "ls"] and "name=^/" + ops.STATE_SERVICE + "$" in joined:
            self.events.append(("command", list(args)))
            return ops.STATE_SERVICE if any(row["Name"] == "/" + ops.STATE_SERVICE for row in self.info) else ""
        if args[:2] == ["docker", "inspect"] and "--format" in args and args[-1] == ops.STATE_SERVICE:
            self.events.append(("command", list(args)))
            running = "true" if self.service["running"] else "false"
            return running + (" " + str(self.service["exit_code"]) if "ExitCode" in joined else "")
        value = super().fake_text(args, **kwargs)
        if args[:2] == ["docker", "inspect"] and "--format" not in args:
            # the service's live container state follows the fake's stop/start
            rows = json.loads(value)
            for row in rows:
                if row["Name"] == "/" + ops.STATE_SERVICE:
                    row["State"]["Running"] = self.service["running"]
            return json.dumps(rows)
        return value

    def fake_run(self, args, **kwargs):
        if args[:2] == ["docker", "stop"] and ops.STATE_SERVICE in args:
            self.events.append(("command", list(args)))
            self.service.update(running=False, exit_code=self.close_exit, lines=self.service["lines"] + self.close_lines)
            return SimpleNamespace(returncode=0, stdout=b"", stderr=b"")
        if args[:2] == ["docker", "start"] and ops.STATE_SERVICE in args:
            self.events.append(("command", list(args)))
            self.service.update(running=True, exit_code=0, lines=self.service["lines"] + ["EMR_STATE_READY"])
            return SimpleNamespace(returncode=0, stdout=b"", stderr=b"")
        if args[:2] == ["docker", "logs"] and args[-1] == ops.STATE_SERVICE:
            self.events.append(("command", list(args)))
            return SimpleNamespace(returncode=0, stdout=("\n".join(self.service["lines"]) + "\n").encode(), stderr=b"")
        return super().fake_run(args, **kwargs)

    def fake_archive(self, args, **kwargs):
        if "--env-file" in args:
            self.observer_runs += 1
            self.events.append(("observer", [word for word in args if not word.startswith("const ")]))
            path = Path(args[args.index("--env-file") + 1])
            self.assertion = path.read_text(encoding="utf-8")
            return "KIN_RESULT " + json.dumps({"ready": self.ready})
        return super().fake_archive(args, **kwargs)


class StateServiceDailyTests(unittest.TestCase):
    """EMR-B2 (c) daily capture over the protected-state service (D1656-T03/T04/T07/T08, C-O03): the service is stopped
    and its complete close verified before the paired capture; the v3 archive is admitted read-only against the
    captured pair; on resume the service recovers first and an independent client observes it ready before any client
    starts; every refusal leaves the source bytes and the writers as they were."""

    def make_host(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        host = ServiceHost(temporary.name)
        host.init_ledger()
        return host

    @staticmethod
    def commands(host):
        return [event[1] for event in host.events if event[0] == "command"]

    def test_v3_capture_stops_the_service_after_the_clients_and_resumes_it_first(self):
        host = self.make_host()
        before = host.state_archive
        folder, manifest, error = host.backup(rows_stream({1: "synthetic-audit"}))
        self.assertIsNone(error)
        self.assertTrue(manifest["complete"])
        self.assertEqual(manifest["resume_failures"], [])
        self.assertEqual((folder / "emr-state.tgz").read_bytes(), before)
        emr = manifest["emr"]
        self.assertEqual((emr["format"], emr["state_volume"], emr["same_pause"]), (3, "fixture-emr-state", True))
        self.assertEqual(emr["service"]["container"], ops.STATE_SERVICE)
        self.assertEqual((emr["service"]["exit_code"], emr["service"]["closed"], emr["service"]["resumed_ready"]), (0, True, True))
        self.assertEqual(emr["pair"]["origin"], V3_ORIGIN)
        self.assertEqual(emr["pair"]["lineage"], "3b1c9d4e-0b7a-4c1d-9e8f-0a1b2c3d4e5f")
        self.assertEqual(len(emr["pair"]["fingerprint"]), 64)
        commands = self.commands(host)
        stops = [cmd for cmd in commands if cmd[:2] == ["docker", "stop"]]
        starts = [cmd for cmd in commands if cmd[:2] == ["docker", "start"]]
        self.assertEqual(stops[0][4:], list(ops.CONTAINERS[:-1]), "clients are quiesced first")
        self.assertEqual(stops[1], ["docker", "stop", "--time", "45", ops.STATE_SERVICE], "then the service closes")
        self.assertEqual(starts, [["docker", "start", ops.STATE_SERVICE], *[["docker", "start", name] for name in ops.CONTAINERS[:-1]]],
                         "the service recovers before any client")
        service_stop = commands.index(["docker", "stop", "--time", "45", ops.STATE_SERVICE])
        self.assertTrue(all(service_stop < i for i, cmd in enumerate(commands) if "pg_dump" in cmd), "the capture follows the service close")
        self.assertEqual(host.observer_runs, 1, "one independent readiness observation per resume")
        observer_at = next(i for i, event in enumerate(host.events) if event[0] == "observer")
        api_start = next(i for i, event in enumerate(host.events) if event == ("command", ["docker", "start", "kin-api"]))
        self.assertLess(observer_at, api_start, "the client resumes only after the readiness observation")
        self.assertIn("--read-only", host.events[observer_at][1])
        self.assertIn("1001:1001", host.events[observer_at][1])
        self.assertNotIn("synthetic-runtime", " ".join(host.events[observer_at][1]), "the credential never reaches argv")
        self.assertIn("DATABASE_URL=postgresql://kin_runtime:synthetic-runtime@db:5432/kin", host.assertion)
        self.assertEqual(host.state_archive, before)

    def test_an_incomplete_service_close_refuses_the_capture_and_still_recovers_the_service_first(self):
        for close_lines, close_exit in ((["EMR_STATE_INCOMPLETE"], 0), (["EMR_STATE_CLOSED"], 1), ([], 0)):
            with self.subTest(close=close_lines, exit=close_exit):
                host = self.make_host()
                host.close_lines, host.close_exit = close_lines, close_exit
                folder, manifest, error = host.backup(rows_stream({1: "synthetic-audit"}))
                self.assertIsInstance(error, RuntimeError)
                self.assertFalse(manifest["complete"])
                self.assertEqual(manifest["backup_error"]["stage"], "stop state service")
                self.assertIsNone(manifest["emr"]["pair"])
                self.assertFalse(any("pg_dump" in cmd for cmd in self.commands(host)), "nothing is captured")
                starts = [cmd for cmd in self.commands(host) if cmd[:2] == ["docker", "start"]]
                self.assertEqual(starts[0], ["docker", "start", ops.STATE_SERVICE])
                self.assertEqual(manifest["resume_failures"], [])

    def test_a_service_that_is_not_ready_after_resume_keeps_every_client_stopped(self):
        host = self.make_host()
        host.ready = False
        folder, manifest, error = host.backup(rows_stream({1: "synthetic-audit"}))
        self.assertIsInstance(error, RuntimeError)
        self.assertTrue(manifest["complete"])
        self.assertEqual(manifest["resume_failures"], [ops.STATE_SERVICE, *ops.CONTAINERS[:-1]])
        self.assertEqual([cmd for cmd in self.commands(host) if cmd[:2] == ["docker", "start"]], [["docker", "start", ops.STATE_SERVICE]])
        self.assertFalse(manifest["emr"]["service"]["resumed_ready"])
        self.assertTrue((host.repo / ".kin-ops.lock").is_file(), "the operations lease is retained")

    def test_legacy_or_malformed_state_under_the_service_refuses_before_any_pause(self):
        cases = {
            "legacy v2": orthanc_archive(state=True, version=2),
            "mixed WAL": v3_archive(wal=b'{"version":2}\n'),
            "no lineage": v3_archive(checkpoint={"state": {"version": 3}}),
            "foreign origin shape": v3_archive(origin={"instanceId": "x", "chains": {"viewing": "a"}, "database": {}}),
            "duplicate path": v3_archive(extra=[("seal/settlement.json", b"{}")]),
            "unsafe path": v3_archive(extra=[("../outside", b"x")]),
        }
        for name, raw in cases.items():
            with self.subTest(name=name):
                host = self.make_host()
                host.state_archive = raw
                folder, manifest, error = host.backup(rows_stream({1: "synthetic-audit"}))
                self.assertIsInstance(error, RuntimeError)
                self.assertIsNone(folder)
                self.assertFalse(any(cmd[:2] in (["docker", "stop"], ["docker", "start"]) or "pg_dump" in cmd for cmd in self.commands(host)))
                self.assertEqual(host.state_archive, raw)

    def test_a_client_with_owner_configuration_or_a_foreign_service_refuses_before_any_pause(self):
        def with_state_mount(host):
            api = next(row for row in host.info if row["Name"] == "/kin-api")
            api["Mounts"].append({"Destination": ops.EMR_STATE, "Type": "volume", "Name": "fixture-emr-state", "RW": True})
        def with_state_dir(host):
            api = next(row for row in host.info if row["Name"] == "/kin-api")
            api["Config"]["Env"].append("KIN_EMR_STATE_DIR=" + ops.EMR_STATE)
        def other_image(host):
            next(row for row in host.info if row["Name"] == "/" + ops.STATE_SERVICE)["Image"] = "sha256:" + "b" * 64
        def legacy_serve(host):
            next(row for row in host.info if row["Name"] == "/" + ops.STATE_SERVICE)["Args"] = ["/app/start-production.sh", "serve"]
        def other_project(host):
            next(row for row in host.info if row["Name"] == "/" + ops.STATE_SERVICE)["Config"]["Labels"]["com.docker.compose.project"] = "other"
        def second_owner(host):
            retained = copy.deepcopy(next(row for row in host.info if row["Name"] == "/" + ops.STATE_SERVICE))
            retained.update(Name="/retained-old-owner", Id="c" * 64)
            retained["HostConfig"]["RestartPolicy"]["Name"] = "always"
            retained["State"]["Running"] = False
            host.info.append(retained)
        for label, mutate in (("API with a state mount", with_state_mount), ("API with KIN_EMR_STATE_DIR", with_state_dir),
                              ("service on another image", other_image), ("service in legacy serve mode", legacy_serve),
                              ("service of another project", other_project), ("a retained restartable owner", second_owner)):
            with self.subTest(case=label):
                host = self.make_host()
                mutate(host)
                folder, manifest, error = host.backup(rows_stream({1: "synthetic-audit"}))
                self.assertIsInstance(error, RuntimeError)
                self.assertIsNone(folder)
                self.assertFalse(any(cmd[:2] in (["docker", "stop"], ["docker", "start"]) or "pg_dump" in cmd for cmd in self.commands(host)))

    def test_v3_copy_admission_binds_the_archive_to_its_captured_pair(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            archive_path = directory / "emr-state.tgz"
            archive_path.write_bytes(v3_archive())
            with archive_path.open("rb") as stream:
                admitted = ops.admit_v3_archive(stream)
            manifest = {"sha256": {"emr-state.tgz": ops.digest(archive_path)}, "emr": {"format": 3, "pair": {
                "instance_id": "fixture-pair", "lineage": admitted["lineage"], "origin": admitted["origin"], "fingerprint": admitted["fingerprint"]}}}
            self.assertEqual(ops.admit_v3_copy(directory, manifest), admitted)
            for label, change in (("another lineage", lambda m: m["emr"]["pair"].update(lineage="0" * 36)),
                                  ("another origin", lambda m: m["emr"]["pair"]["origin"]["database"].update(oid=1)),
                                  ("another fingerprint", lambda m: m["emr"]["pair"].update(fingerprint="0" * 64)),
                                  ("no pair", lambda m: m["emr"].update(pair=None)),
                                  ("another digest", lambda m: m["sha256"].update({"emr-state.tgz": "0" * 64}))):
                with self.subTest(case=label):
                    changed = copy.deepcopy(manifest)
                    change(changed)
                    with self.assertRaises(RuntimeError):
                        ops.admit_v3_copy(directory, changed)
            # the legacy reader route never admits a v3 copy, and the v3 route never admits a legacy one
            with self.assertRaises(RuntimeError):
                ops.admit_legacy_copy(directory, manifest)
            archive_path.write_bytes(orthanc_archive(state=True, version=2))
            legacy = {"sha256": {"emr-state.tgz": ops.digest(archive_path)}, "emr": {}}
            ops.admit_legacy_copy(directory, legacy)
            with self.assertRaises(RuntimeError):
                ops.admit_v3_copy(directory, {**legacy, "emr": {"format": 3, "pair": manifest["emr"]["pair"]}})
            self.assertEqual(archive_path.read_bytes(), orthanc_archive(state=True, version=2))


class StateCopyAdmissionTests(unittest.TestCase):
    def test_v3_unknown_mixed_and_changed_capture_refuse_before_any_copy_command(self):
        """D1656-T03/T07: actual legacy restore consumers reject v3 before granting a mount."""
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            archive_path = directory / "emr-state.tgz"
            for version, wal in [(3, b''), (3, b'{"torn":'), (None, b''), (2, b'{"version":3}\n')]:
                with self.subTest(version=version, wal=wal):
                    with tarfile.open(archive_path, "w:gz") as archive:
                        entries = [("seal/settlement.json", json.dumps({"state": {"version": version}}).encode()),
                                   ("seal/settlement.jsonl", wal), ("journal/failure-journal.jsonl", b'good\n{"torn":')]
                        for name, data in entries:
                            entry = tarfile.TarInfo(name); entry.size = len(data)
                            archive.addfile(entry, io.BytesIO(data))
                    before = archive_path.read_bytes()
                    manifest = {"shape": "post", "emr": {}, "sha256": {"emr-state.tgz": ops.digest(archive_path)}}
                    with patch.object(ops, "run") as commands, patch.object(ops, "temporary_run") as owners:
                        with self.assertRaises(RuntimeError): ops.rehearse_held(directory, manifest)
                        with patch.object(ops, "validate_backup", return_value=(directory, manifest)):
                            with self.assertRaises(RuntimeError): ops.rehearse(directory)
                        commands.assert_not_called(); owners.assert_not_called()
                    self.assertEqual(archive_path.read_bytes(), before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
