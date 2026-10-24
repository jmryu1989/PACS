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


def role(name, *, superuser=False, login=False, inherit=True, connlimit=-1, valid=None, config=None):
    """One pg_roles row as the role catalog reads it."""
    return {"rolname": name, "rolsuper": superuser, "rolcreaterole": superuser, "rolcreatedb": superuser, "rolcanlogin": login,
            "rolreplication": superuser, "rolbypassrls": superuser, "rolinherit": inherit, "rolconnlimit": connlimit,
            "rolvaliduntil": valid, "rolconfig": config}


def inventory(database, records=()):
    return {"version": ops.RESTORE_INVENTORY, "server_major": 16,
            "catalogs": sorted(name for group in ops.INVENTORY_COVERAGE.values() for name in group.split()),
            "records": list(records), "unsupported": []}


def object_row(database, kind, name, **attributes):
    return {"key": [database, "public", kind, name, None],
            "attributes": {**dict.fromkeys(ops.INVENTORY_ATTRIBUTES[kind].split()), **attributes}}


def catalog_globals(roles):
    return {"server_major": 16, "unsupported_verifiers": [], "login_verifiers": sorted(row["rolname"] for row in roles if row["rolcanlogin"]), "builtin_roles": [], "settings": [],
            "setting_names": ["search_path", "statement_timeout", "work_mem"],
            "role_comments": [[row["rolname"], None] for row in sorted(roles, key=lambda row: row["rolname"])]}


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
        self.extra_roles, self.memberships, self.extra_databases, self.extra_tablespaces = [], [], [], []
        self.verifiers = {RESOURCES["containers"]["db"]: {"kin", *({"kin_runtime"} if shape == "post" else set())}}
        (self.repo / ".env").write_text("POSTGRES_PASSWORD=synthetic-fixture\nKIN_EMR_RUNTIME_PASSWORD=synthetic-runtime\n")

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

    def catalog(self, container=None):
        roles = [{**role("kin", superuser=True, login=True), **getattr(self, "kin_changes", {})}] + ([role(name, login=name == "kin_runtime") for name in ops.EMR_ROLES]
                                                              if self.emr_roles else []) + list(self.extra_roles)
        return {**catalog_globals(roles), "login_verifiers": sorted(self.verifiers[container or RESOURCES["containers"]["db"]]), "roles": roles, "memberships": list(self.memberships),
                "databases": [{"name": name, "owner": "kin", "acl": None, "attributes": {"datistemplate": False, "datallowconn": True}} for name in ("keycloak", "kin", "postgres", "template0", "template1", *self.extra_databases)],
                "tablespaces": [{"name": "pg_default", "owner": "kin", "location": ""}, {"name": "pg_global", "owner": "kin", "location": ""},
                                *([{"name": "kin_emr_access", "owner": "kin_emr_owner", "location": ops.EMR_TABLESPACE}] if self.emr_roles else []),
                                *self.extra_tablespaces],
                "schemas": ["public", *(["emr_access"] if self.emr_roles else [])]}

    def objects(self, database):
        return inventory(database, [object_row(database, "schema", "public", owner="pg_database_owner", acl=[])])

    def values(self, container, database, schema, table, user="kin"):
        changed = getattr(self, "value_changes", {}).get(database, {}).get(schema + "." + table)
        return ["id", "body"], [["1", "changed" if changed else "before"], ["2", None]]

    def text(self, args, **kwargs):
        self.commands.append(list(args))
        joined = " ".join(args)
        if "emr_access.restore_expiry_sweep()" in joined:
            return json.dumps({"ran": True, "complete": True, "checkedAt": "2026-10-23T00:00:00Z",
                               "deletedEntries": 0, "deletedFailures": 0,
                               "retainedByDutyOrHold": 0, "historyRetainedUnknownLifetime": 0})
        if args[:2] == ["docker", "inspect"]:
            return json.dumps(self.containers())
        if "pg_stat_activity" in joined:
            return self.clients
        if ops.OBJECT_CATALOG_SQL in args:
            return json.dumps(self.objects(args[args.index("-d") + 1]))
        if "datname='keycloak'" in joined:
            return "0:1"
        if "n.nspname='public'" in joined:
            return "0"
        if "pg_database_size" in joined:
            return "4096"
        if args[:2] == ["git", "rev-parse"]:
            return "a" * 40
        if args[:2] == ["git", "status"]:
            return ""
        if ops.ROLE_CATALOG_SQL in args:
            return json.dumps(self.catalog(args[args.index("psql") - 1]))
        if ops.MIGRATIONS_SQL in args:
            return json.dumps([["0_init", "1" * 64, True, False]])
        if ops.VALUE_TABLES_SQL in args:
            database = args[args.index("-d") + 1]
            rows = [["public", "Report"]] if database == "kin" else [["public", "realm"]]
            rows += [name.split(".", 1) for name in getattr(self, "value_changes", {}).get(database, {}) if name.split(".", 1) not in rows]
            return json.dumps(rows)
        if "information_schema.columns" in joined:
            return json.dumps({"Report": ["id", "body"]})
        if "json_object_agg(name, d)" in joined:
            return json.dumps({"Report": [2, "c" * 64]})
        raise AssertionError("unexpected command " + joined[:80])

    def run(self, args, *, output=None, input_file=None, timeout=600, check=True):
        self.commands.append(list(args))
        if args[:3] == ["docker", "run", "-d"]:
            self.verifiers[args[args.index("--name") + 1]] = set()
        if "psql" in args and input_file is not None and "-f" not in args:
            import re
            container = args[args.index("psql") - 1]
            sql = input_file.read().decode()
            for name in re.findall(r'ALTER ROLE "([^"]+)" PASSWORD ', sql):
                self.verifiers[container].add(name)

        if "psql" in args and "-f" in args and input_file is not None:
            database = args[args.index("-d") + 1]
            return SimpleNamespace(returncode=0, stdout=json.dumps(self.objects(database)).encode(), stderr=b"")
        if "pg_dump" in args or "pg_dumpall" in args:
            if self.dump_failure and "pg_dump" in args:
                raise self.dump_failure
            output.write(b"synthetic dump")
        if args[:3] == ["docker", "volume", "inspect"]:
            return SimpleNamespace(returncode=0, stdout=json.dumps([{"Name": args[3], "CreatedAt": "2026-10-12T00:00:00Z",
                                                                     "Driver": "local"}]).encode(), stderr=b"")
        return SimpleNamespace(returncode=0, stdout=b"", stderr=b"")

    def temporary(self, args, *, timeout=600, output=None, input_file=None):
        self.commands.append(["docker", "run", *args])
        if "du" in args:
            return "8 /source"
        if output is not None:
            output.write(archive())
            return ""
        if "python3" in args:
            return json.dumps({"integrity": "ok", "attachments": 0, "attachment_bytes": 0})
        if "node" in args:
            return "EMR_RESTORE_VERIFIED"
        return ""

    @contextlib.contextmanager
    def bound(self):
        with patch.object(ops, "ROOT", self.repo), patch.object(ops, "text", side_effect=self.text), \
                patch.object(ops, "run", side_effect=self.run), patch.object(ops, "temporary_run", side_effect=self.temporary), \
                patch.object(ops, "boundary_proof", return_value={"fixture": "private PG16 baseline"}), \
                patch.object(ops, "value_rows", side_effect=self.values), \
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
        self.assertEqual(metadata["env_names"], ["KIN_EMR_RUNTIME_PASSWORD", "POSTGRES_PASSWORD"])
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
            host.catalog = lambda container=None, original=original, extra=extra: {**original(container), **extra}
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
        self.assertEqual(result["catalog"]["catalog"], "equal")
        # Owners and privileges are restored, never stripped (IRT-07): no --no-owner/--no-privileges restore.
        restores = [command for command in host.commands if "pg_restore" in command]
        self.assertEqual(len(restores), 2)
        self.assertTrue(all("--create" in command and "--no-owner" not in command and "--no-privileges" not in command for command in restores))

    def test_13_a_restore_whose_row_values_differ_is_refused_with_equal_counts(self):
        """IRT2-24: the held restore check compares every table's value digest of both databases (any schema) with the
        capture's values.json: a changed Keycloak value, a changed row of the kin database, or a table of another schema
        that appeared is a refused rehearsal although the row counts agree; the record says so."""
        for name, change in (("a Keycloak row value", {"keycloak": {"public.realm": [2, "d" * 64]}}),
                             ("a kin row value", {"kin": {"public.Report": [2, "e" * 64]}}),
                             ("a non-public table", {"kin": {"archive.kept": [1, "f" * 64]}})):
            host = FakeHost(tempfile.mkdtemp(dir=self.folder))
            directory = host.capture()
            captured = json.loads((directory / "values.json").read_text())
            self.assertEqual(captured["version"], ops.RESTORE_INVENTORY)
            self.assertEqual({tuple(row["key"]) for row in captured["tables"]},
                             {("kin", "public", "table", "Report", None), ("keycloak", "public", "table", "realm", None)})
            host.value_changes = change
            with self.subTest(change=name), host.bound(), patch.object(ops, "remove_owned_if_present"):
                with self.assertRaisesRegex(RuntimeError, "Restored row values differ from the snapshot"):
                    ops.rehearse(directory)
                (record,) = directory.glob("rehearsal-*.json")
                self.assertFalse(json.loads(record.read_text())["success"])

    def test_11_a_post_emr_capture_is_restored_exactly_in_a_kin_bootstrap_cluster(self):
        """B1's restore check replays its roles, stored LOGIN verifiers and memberships as the cluster's own
        superuser, creates the EMR tablespace, restores with owners and privileges, and compares the whole catalog."""
        host = FakeHost(tempfile.mkdtemp(dir=self.folder), shape="post")
        host.extra_roles.append(role("legacy_reader"))
        host.memberships.append({"granted": "legacy_reader", "member": "kin_emr_reader", "grantor": "kin", "admin_option": False,
                                 "inherit_option": True, "set_option": True})
        directory = host.capture(label="emr-b1")
        host.commands.clear()
        with host.bound(), patch.object(ops, "remove_owned_if_present"):
            ops.rehearse(directory)
        (record,) = directory.glob("rehearsal-*.json")
        result = json.loads(record.read_text())
        self.assertTrue(result["success"] and result["emr"]["database_state_verified"])
        self.assertTrue(result["emr"]["expiry_sweep"]["ran"])
        self.assertTrue(result["emr"]["expiry_sweep"]["complete"])
        started = next(command for command in host.commands if command[:3] == ["docker", "run", "-d"])
        self.assertIn("POSTGRES_USER=kin", started)
        self.assertTrue(any("CREATE TABLESPACE kin_emr_access OWNER kin_emr_owner" in " ".join(command) for command in host.commands))
        self.assertFalse(any("cluster-roles.sql" in str(command) or "--no-owner" in command for command in host.commands))

    def test_d1796_held_restore_keeps_unknown_history_and_requires_the_sweep(self):
        receipt = {"ran": True, "complete": True, "historyRetainedUnknownLifetime": 1}
        for outcome in (receipt, {**receipt, "ran": False}, RuntimeError("synthetic sweep failure")):
            with self.subTest(outcome=outcome):
                host = FakeHost(tempfile.mkdtemp(dir=self.folder), shape="post")
                directory = host.capture(label="emr-b1")
                expiry = {"side_effect": outcome} if isinstance(outcome, Exception) else {"return_value": outcome}
                succeeds = outcome is receipt
                with host.bound(), patch.object(ops, "remove_owned_if_present"), \
                        patch.object(ops, "restored_emr_expiry", **expiry):
                    if succeeds:
                        ops.rehearse(directory)
                    else:
                        with self.assertRaises(RuntimeError):
                            ops.rehearse(directory)
                (record,) = directory.glob("rehearsal-*.json")
                result = json.loads(record.read_text())
                self.assertIs(result["success"], succeeds)
                if succeeds:
                    self.assertEqual(result["emr"]["expiry_sweep"], receipt)

    @unittest.skipUnless(os.name == "posix" and hasattr(os, "geteuid") and os.geteuid() == 0, "Linux root (the protected entry's user)")
    def test_12_root_captures_into_the_operating_accounts_private_backup_root_and_gives_the_capture_to_it(self):
        """IRT2-03: the protected entry (root) writes B0 into the operating account's 0700 backup root as production has
        it; the capture becomes that account's (its daily backups, rotation and ledger stay its own); an open root or
        root-owned one is not changed; a group/other-accessible parent is refused before anything is written."""
        host = FakeHost(self.folder)
        host.parent.mkdir(mode=0o700)
        os.chown(host.parent, 1000, 1000)
        try:
            directory = host.capture()
        except RuntimeError as error:
            self.fail("the operating account's private backup root was refused: " + str(error))
        for path in (directory, *directory.iterdir()):
            self.assertEqual((path.stat().st_uid, path.stat().st_gid), (1000, 1000), path.name)
        info = host.parent.stat()
        self.assertEqual((info.st_uid, info.st_mode & 0o777), (1000, 0o700))
        host = FakeHost(tempfile.mkdtemp(dir=self.folder))
        host.parent.mkdir()
        host.parent.chmod(0o750)
        os.chown(host.parent, 1000, 1000)
        with self.assertRaisesRegex(RuntimeError, "must be private"):
            host.capture()
        self.assertEqual(list(host.parent.iterdir()), [])

    def test_10_an_unsupported_pre_emr_catalog_is_refused_before_anything_is_written(self):
        """IRT-07: a B0 that a rollback could not rebuild exactly never becomes a B0."""
        cases = {"further login role": lambda host: host.extra_roles.append(role("legacy_app", login=True)),
                 # IRT2-17: a kin the fresh cluster's bootstrap kin is not (it would only fail in the restore).
                 "kin with its own connection limit": lambda host: setattr(host, "kin_changes", {"rolconnlimit": 7}),
                 "kin with a validity": lambda host: setattr(host, "kin_changes", {"rolvaliduntil": "2027-01-01 00:00:00+00"}),
                 # IRT2-16: a membership another role granted (the replay grants as kin).
                 "a membership granted by another role": lambda host: (host.extra_roles.extend([role("delegate"), role("leaf")]),
                                                                      host.memberships.append({"granted": "delegate", "member": "leaf", "grantor": "delegate",
                                                                                               "admin_option": False, "inherit_option": True, "set_option": True})),
                 "unknown role settings": lambda host: host.extra_roles.append(role("legacy_cfg", config=["unknown.setting=x"])),
                 "another database": lambda host: host.extra_databases.append("orthanc_index"),
                 "another tablespace": lambda host: host.extra_tablespaces.append({"name": "fast", "owner": "kin", "location": "/x"})}
        for name, change in cases.items():
            host = FakeHost(tempfile.mkdtemp(dir=self.folder))
            change(host)
            with self.subTest(case=name), self.assertRaisesRegex(RuntimeError, "Unsupported pre-EMR catalog"):
                host.capture()
            self.assertFalse(host.parent.exists())
            self.assertFalse(any("pg_dump" in command or "pg_dumpall" in command for command in host.commands))
        host = FakeHost(tempfile.mkdtemp(dir=self.folder))
        host.extra_roles.append(role("legacy_reader"))
        host.memberships.append({"granted": "pg_read_all_data", "member": "legacy_reader", "grantor": "kin", "admin_option": False,
                                 "inherit_option": True, "set_option": True})
        directory = host.capture()
        self.assertIn("legacy_reader", {item["rolname"] for item in json.loads((directory / "catalog.json").read_text())["roles"]})


class FakeCluster:
    """A fresh product-shaped PostgreSQL cluster (POSTGRES_USER kin) that applies what a restore sends it: CREATE ROLE /
    GRANT statements on stdin, DROP DATABASE, and pg_restore --create of a dump, which brings the snapshot's database
    and the owners/privileges of its objects (as the real pg_restore does); `strip` simulates a restore that lost some."""

    def __init__(self, snapshot):
        self.snapshot = snapshot
        self.roles = {"kin": role("kin", superuser=True, login=True)}
        self.memberships = []
        self.verifiers = set()
        self.databases = {name: {"name": name, "owner": "kin", "acl": None, "attributes": {"datistemplate": False, "datallowconn": True}} for name in ("kin", "postgres", "template0", "template1")}
        self.objects = {}
        self.commands = []
        self.strip = None

    def catalog(self):
        return {**catalog_globals(list(self.roles.values())), "login_verifiers": sorted(self.verifiers), "roles": [self.roles[name] for name in sorted(self.roles)], "memberships": sorted(self.memberships, key=lambda m: (m["granted"], m["member"])),
                "databases": [self.databases[name] for name in sorted(self.databases)], "tablespaces": self.snapshot["tablespaces"],
                "schemas": self.snapshot["schemas"] if "kin" in self.objects else ["public"]}

    def apply(self, sql):
        import re as pattern
        self.verifiers.update(pattern.findall(r'ALTER ROLE "([^"]+)" PASSWORD ', sql))
        for name, flags in pattern.findall(r'CREATE ROLE "([^"]+)" WITH ([^;]+);', sql):
            words = flags.split()
            self.roles[name] = {"rolname": name, "rolsuper": "SUPERUSER" in words, "rolcreaterole": "CREATEROLE" in words,
                                "rolcreatedb": "CREATEDB" in words, "rolcanlogin": "LOGIN" in words, "rolreplication": "REPLICATION" in words,
                                "rolbypassrls": "BYPASSRLS" in words, "rolinherit": "INHERIT" in words,
                                "rolconnlimit": int(words[words.index("LIMIT") + 1]), "rolvaliduntil": None, "rolconfig": None}
        for granted, member, admin, inherit, setting in pattern.findall(
                r'GRANT "([^"]+)" TO "([^"]+)" WITH ADMIN (TRUE|FALSE), INHERIT (TRUE|FALSE), SET (TRUE|FALSE);', sql):
            self.memberships.append({"granted": granted, "member": member, "grantor": "kin", "admin_option": admin == "TRUE",
                                     "inherit_option": inherit == "TRUE", "set_option": setting == "TRUE"})

    def text(self, args, **kwargs):
        self.commands.append(list(args))
        joined = " ".join(args)
        if ops.ROLE_CATALOG_SQL in args:
            return json.dumps(self.catalog())
        if ops.OBJECT_CATALOG_SQL in args:
            database = args[args.index("-d") + 1]
            return json.dumps(self.objects.get(database, {"schemas": [], "relations": [], "functions": [], "default_acl": []}))
        if "datname='keycloak'" in joined:
            return "%d:%d" % ("keycloak" in self.databases, "kin" in self.databases)
        if "n.nspname='public'" in joined:
            return str(len((self.objects.get("kin") or {}).get("relations", [])))
        raise AssertionError("unexpected command " + joined[:80])

    def run(self, args, *, output=None, input_file=None, timeout=600, check=True):
        self.commands.append(list(args))
        if "psql" in args and input_file is not None:
            if "-f" in args:
                database = args[args.index("-d") + 1]
                return SimpleNamespace(returncode=0, stdout=json.dumps(self.objects.get(database, inventory(database))).encode(), stderr=b"")
            self.apply(input_file.read().decode())
        elif "DROP DATABASE kin WITH (FORCE);" in args:
            self.databases.pop("kin")
        elif "pg_restore" in args:
            database = Path(input_file.name).name.split(".")[0]
            self.databases[database] = dict(next(item for item in self.snapshot["databases"] if item["name"] == database))
            self.objects[database] = json.loads(json.dumps(self.snapshot["objects"][database]))
            if self.strip and database == "kin":
                self.objects[database]["records"][1]["attributes"]["acl"] = None
        return SimpleNamespace(returncode=0, stdout=b"", stderr=b"")


class ExactRestoreTests(unittest.TestCase):
    """IRT-07: a pre-EMR B0 with further NOLOGIN roles, memberships and their owned/granted objects is rebuilt exactly."""

    def snapshot(self, folder):
        roles = [role("kin", superuser=True, login=True), role("legacy_group", inherit=False), role("legacy_reader", connlimit=3)]
        catalog = {**catalog_globals(roles), "roles": roles,
                   "memberships": [{"granted": "legacy_group", "member": "legacy_reader", "grantor": "kin", "admin_option": False, "inherit_option": True,
                                    "set_option": True},
                                   {"granted": "pg_read_all_data", "member": "legacy_group", "grantor": "kin", "admin_option": True, "inherit_option": False,
                                    "set_option": False}],
                   "databases": [{"name": "keycloak", "owner": "kin", "acl": None, "attributes": {"datistemplate": False, "datallowconn": True}},
                                 {"name": "kin", "owner": "kin", "acl": "{=Tc/kin,kin=CTc/kin,legacy_reader=c/kin}", "attributes": {"datistemplate": False, "datallowconn": True}},
                                 *[{"name": name, "owner": "kin", "acl": None, "attributes": {"datistemplate": False, "datallowconn": True}} for name in ("postgres", "template0", "template1")]],
                   "tablespaces": [{"name": "pg_default", "owner": "kin", "location": ""}, {"name": "pg_global", "owner": "kin", "location": ""}],
                   "schemas": ["legacy_archive", "public"],
                   "objects": {"kin": inventory("kin", [object_row("kin", "schema", "legacy_archive", owner="legacy_group", acl=[]),
                        object_row("kin", "relation", "AuditLog", owner="kin", acl=["kin=arwdDxtm/kin", "legacy_reader=r/kin"])]),
                               "keycloak": inventory("keycloak")}}
        directory = Path(folder)
        (directory / "catalog.json").write_text(json.dumps(catalog))
        (directory / ".env").write_text("POSTGRES_PASSWORD=synthetic-placeholder\n")
        for database in ("kin", "keycloak"):
            (directory / (database + ".dump")).write_bytes(b"synthetic dump")
        return directory, catalog

    def restore(self, cluster, directory):
        with patch.object(ops, "text", side_effect=cluster.text), patch.object(ops, "run", side_effect=cluster.run):
            return ops.restore_pre_snapshot("kin-rh-db", directory)

    def test_login_verifiers_are_restored_from_credentials_and_missing_or_extra_verifiers_are_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            directory, catalog = self.snapshot(folder)
            cluster = FakeCluster(catalog)
            self.assertEqual(cluster.verifiers, set())
            try:
                self.restore(cluster, directory)
            except RuntimeError as error:
                self.fail("supported credential restoration refused: " + str(error))
            self.assertEqual(cluster.verifiers, {"kin"})
            for change in (lambda values: values.discard("kin"), lambda values: values.add("unexpected-login")):
                cluster = FakeCluster(catalog)
                apply = cluster.apply
                def changed(sql):
                    apply(sql)
                    change(cluster.verifiers)
                cluster.apply = changed
                with self.assertRaises(RuntimeError):
                    self.restore(cluster, directory)

    def test_01_roles_memberships_owners_and_grants_are_rebuilt_and_compared(self):
        with tempfile.TemporaryDirectory() as folder:
            directory, catalog = self.snapshot(folder)
            cluster = FakeCluster(catalog)
            try:
                result = self.restore(cluster, directory)
            except RuntimeError as error:
                self.fail("the supported role and privilege snapshot must restore: " + str(error))
            self.assertEqual(result["roles_created"], ["legacy_group", "legacy_reader"])
            self.assertEqual(result["memberships_granted"], 2)
            self.assertEqual(cluster.catalog()["roles"], catalog["roles"])
            restores = [command for command in cluster.commands if "pg_restore" in command]
            self.assertTrue(all("--create" in command and "--no-owner" not in command for command in restores))

    def test_02_a_restore_that_loses_a_grant_or_meets_another_role_is_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            directory, catalog = self.snapshot(folder)
            cluster = FakeCluster(catalog)
            cluster.strip = True
            with self.assertRaisesRegex(RuntimeError, "Restored catalog differs from the snapshot: objects"):
                self.restore(cluster, directory)
            cluster = FakeCluster(catalog)
            cluster.roles["legacy_reader"] = role("legacy_reader", connlimit=7)
            with self.assertRaisesRegex(RuntimeError, "fresh cluster differs from the snapshot: legacy_reader"):
                self.restore(cluster, directory)
            self.assertFalse(any("pg_restore" in command for command in cluster.commands))
            cluster = FakeCluster(catalog)
            cluster.objects["kin"] = {"relations": [{"name": "public.Old"}]}
            with self.assertRaisesRegex(RuntimeError, "not a fresh cluster"):
                self.restore(cluster, directory)


    def test_03_a_restore_that_loses_a_column_grant_is_refused(self):
        """D22: column privileges are part of the compared catalog; a restore without one is refused."""
        with tempfile.TemporaryDirectory() as folder:
            directory, catalog = self.snapshot(folder)
            catalog["objects"]["kin"]["records"].append(object_row("kin", "column", "AuditLog.actor", acl=["legacy_reader=r/kin"]))
            (directory / "catalog.json").write_text(json.dumps(catalog))
            self.restore(FakeCluster(catalog), directory)
            cluster = FakeCluster(catalog)
            original = cluster.run

            def losing(args, **kwargs):
                result = original(args, **kwargs)
                if "pg_restore" in args and "kin" in cluster.objects:
                    cluster.objects["kin"]["records"] = [row for row in cluster.objects["kin"]["records"] if row["key"][2] != "column"]
                return result
            cluster.run = losing
            with self.assertRaisesRegex(RuntimeError, "Restored catalog differs from the snapshot: objects"):
                self.restore(cluster, directory)


POSTGRES_IMAGE = "postgres:16-alpine"


def _image_present(name):
    import shutil
    import subprocess
    return bool(shutil.which("docker")) and subprocess.run(["docker", "image", "inspect", name], capture_output=True).returncode == 0


@unittest.skipUnless(_image_present(POSTGRES_IMAGE), "needs the docker daemon and the local image " + POSTGRES_IMAGE)
class RealClusterTests(unittest.TestCase):
    """D22/D23 against real PostgreSQL 16 (postgres:16-alpine): networkless single containers named kin-rehearsal-*,
    labelled and removed. Proves on the real catalog what the fake clusters above assume."""

    def setUp(self):
        self.enterContext(ops.resource_names(os.environ.get("KIN_TEST_RESOURCE_PREFIX", "kin-rehearsal-")))

    def start(self, superuser="kin"):
        import subprocess
        import time as clock
        import uuid
        token = uuid.uuid4().hex
        name = os.environ.get("KIN_TEST_RESOURCE_PREFIX", "kin-rehearsal-") + token[:16]
        subprocess.run(["docker", "run", "-d", "--name", name, "--label", "kin.ops.run=" + token, "--network", "none",
                        "-e", "POSTGRES_USER=" + superuser, "-e", "POSTGRES_DB=kin", "-e", "POSTGRES_PASSWORD=r4-synthetic-fixture-only",
                        "-e", "POSTGRES_HOST_AUTH_METHOD=trust", POSTGRES_IMAGE],
                       check=True, capture_output=True)
        self.addCleanup(subprocess.run, ["docker", "rm", "-f", "-v", name], capture_output=True)
        deadline = clock.monotonic() + 90
        while subprocess.run(["docker", "exec", name, "pg_isready", "-h", "127.0.0.1", "-U", superuser], capture_output=True).returncode:
            self.assertLess(clock.monotonic(), deadline, "PostgreSQL did not start")
            clock.sleep(0.5)
        return name

    def sql(self, name, statement, database="kin", user="kin"):
        import subprocess
        result = subprocess.run(["docker", "exec", "-i", name, "psql", "-X", "-U", user, "-d", database, "-v", "ON_ERROR_STOP=1", "-qAt"],
                                input=statement.encode(), capture_output=True)
        return result

    def ok(self, name, statement, database="kin"):
        result = self.sql(name, statement, database)
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace")[-800:])
        return result.stdout.decode().strip()

    def dump(self, name, directory, catalog):
        import subprocess
        directory.mkdir()
        (directory / "catalog.json").write_text(json.dumps(catalog))
        (directory / ".env").write_text("POSTGRES_PASSWORD=r4-synthetic-fixture-only\n")
        for database in ("kin", "keycloak"):
            with open(directory / (database + ".dump"), "wb") as handle:
                subprocess.run(["docker", "exec", name, "pg_dump", "-U", "kin", "-d", database, "--encoding=UTF8", "-Fc", "--create"], stdout=handle, check=True)
        return directory

    def test_r5_clone_credentials_replace_source_passwords_and_preserve_catalog(self):
        import ops_emr_introduction as release
        import shlex
        import subprocess
        source = self.start()
        self.ok(source, "CREATE ROLE kin_runtime LOGIN PASSWORD 'source-runtime'; ALTER ROLE kin_runtime SET work_mem='8MB';")
        subprocess.run(["docker", "exec", "-i", source, "sh", "-c", "cat > \"$PGDATA/pg_hba.conf\""],
                       input=b"local all all trust\nhost all all 127.0.0.1/32 scram-sha-256\n", check=True, capture_output=True)
        self.ok(source, "SELECT pg_reload_conf();")
        catalog = ops.role_catalog(source)
        original = {"POSTGRES_PASSWORD": "r4-synthetic-fixture-only", "KIN_EMR_RUNTIME_PASSWORD": "source-runtime"}
        clone = {"POSTGRES_PASSWORD": "clone'private\\installer", "KIN_EMR_RUNTIME_PASSWORD": "clone'private\\runtime"}
        def run(args, *, input=None, env=None, stdin=None, output=None, timeout=60):
            return subprocess.run(args, input=input, stdin=stdin, stdout=output or subprocess.PIPE,
                                  stderr=subprocess.PIPE, env=env, timeout=timeout)
        with tempfile.TemporaryDirectory() as root:
            host = release.HostOps(target={"repository": root, "containers": {"db": source}}, plan={}, runner=run,
                                   records=release.Records(Path(root) / "records"))
            try:
                isolated = host.isolate_database_credentials(catalog, original, clone)
            except release.Stop as error:
                self.fail("Valid clone credential transition was refused: " + str(error))
            self.assertEqual(set(isolated), {"kin", "kin_runtime"})
            self.assertEqual(ops.role_catalog(source), catalog)
            for role, key in (("kin", "POSTGRES_PASSWORD"), ("kin_runtime", "KIN_EMR_RUNTIME_PASSWORD")):
                for passwords, accepted in ((clone, True), (original, False)):
                    script = "export PGPASSWORD=" + shlex.quote(passwords[key]) + "\npsql -h 127.0.0.1 -U " + role + " -d kin -XqAt --no-password -c 'SELECT 1'\n"
                    result = subprocess.run(["docker", "exec", "-i", source, "sh", "-s"], input=script.encode(), capture_output=True)
                    self.assertEqual(result.returncode == 0, accepted, role)
            evidence = b"\n".join(p.read_bytes() for p in (Path(root) / "records").rglob("*") if p.is_file())
            self.assertTrue(all(password.encode() not in evidence for password in [*original.values(), *clone.values()]))
            # A successful client without an applied password change must not permit service startup.
            for role, key in (("kin", "POSTGRES_PASSWORD"), ("kin_runtime", "KIN_EMR_RUNTIME_PASSWORD")):
                self.ok(source, "ALTER ROLE " + ops._identifier(role) + " PASSWORD " + ops._sql_literal(original[key]))
            def lost_write(args, **kwargs):
                return subprocess.CompletedProcess(args, 0, b"", b"") if "psql" in args else run(args, **kwargs)
            with patch.object(host, "run", side_effect=lost_write), self.assertRaises(release.Stop):
                host.isolate_database_credentials(catalog, original, clone)

    def test_r5_renamed_keycloak_index_columns_and_nested_checks_roundtrip(self):
        source = self.start()
        self.ok(source, "CREATE DATABASE keycloak")
        # Keycloak's Liquibase history retains old index attribute labels after these table-column renames.
        self.ok(source, """CREATE TABLE client_scope_attributes(template_id text, name text, value text,
            CONSTRAINT pk_cl_tmpl_attr PRIMARY KEY(template_id,name));
            ALTER TABLE client_scope_attributes RENAME COLUMN template_id TO scope_id;
            CREATE TABLE client_scope_client(id text, name text);
            CREATE UNIQUE INDEX uk_b71cjlbenv945rb6gcon438at ON client_scope_client(id,name);
            ALTER TABLE client_scope_client RENAME COLUMN name TO client_id;""", "keycloak")
        # The product's migration shape (20260917120000_findings): BETWEEN is expanded into its own AND after the parser
        # flattened the outer AND, so the stored tree is AND(AND(>=,<=),=). pg_dump's text re-parses flat, which is
        # exactly the representation-only difference a restore must not report. (A written "(a AND b) AND c" is
        # flattened by the parser and would not exercise this case.)
        self.ok(source, """CREATE TABLE finding_revision(id int PRIMARY KEY, payload jsonb, bytes int,
            CONSTRAINT finding_payload_check CHECK (bytes BETWEEN 1 AND 65536 AND bytes = octet_length(payload::text)));
            INSERT INTO finding_revision SELECT 1, p, octet_length(p::text) FROM (SELECT '{"schema":1,"items":[]}'::jsonb p) s;""")
        raw = "SELECT pg_get_constraintdef(oid,false) FROM pg_constraint WHERE conname='finding_payload_check'"
        source_raw = self.ok(source, raw)
        catalog = ops.cluster_catalog(source)
        ops.supported_pre_catalog(catalog)
        with tempfile.TemporaryDirectory() as root:
            snapshot = self.dump(source, Path(root) / "snapshot", catalog)
            restored = self.start()
            try:
                result = ops.restore_pre_snapshot(restored, snapshot)
            except RuntimeError as error:
                self.fail("renamed columns and equivalent CHECK expressions must restore: " + str(error))
            self.assertEqual(result["catalog"], "equal")
            self.assertNotEqual(self.ok(restored, raw), source_raw,
                                "the fixture must carry a dump/restore representation difference (else this case is vacuous)")
            self.assertEqual(ops.cluster_catalog(restored), catalog)
            self.ok(restored, "ALTER TABLE finding_revision DROP CONSTRAINT finding_payload_check; "
                              "ALTER TABLE finding_revision ADD CONSTRAINT finding_payload_check "
                              "CHECK (bytes BETWEEN 1 AND 65535 AND bytes = octet_length(payload::text))")
            self.assertNotEqual(ops.cluster_catalog(restored), catalog, "a single semantic CHECK change must remain visible")

    def test_r5_comments_membership_database_flags_and_real_temp_history_have_closed_admission(self):
        source = self.start()
        self.ok(source, "CREATE DATABASE keycloak")
        self.ok(source, """CREATE TABLE rows(id int);
            CREATE FUNCTION noop() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$;
            CREATE TRIGGER kept BEFORE INSERT ON rows FOR EACH ROW EXECUTE FUNCTION noop();
            ALTER TABLE rows ENABLE ROW LEVEL SECURITY; CREATE POLICY kept ON rows USING(id>0);
            CREATE VIEW rows_view AS SELECT * FROM rows;
            CREATE TEMP TABLE history(id int); INSERT INTO history VALUES(1);""")
        # The connection ended: PG's empty pg_temp_N and pg_toast_temp_N namespaces legitimately remain.
        try:
            catalog, _ = ops.restore_admission(source, shape="pre")
        except RuntimeError as error:
            self.fail("closed temporary-table history must remain admissible: " + str(error))
        with tempfile.TemporaryDirectory() as root:
            snapshot = self.dump(source, Path(root) / "snapshot", catalog)
            restored = self.start()
            try:
                result = ops.restore_pre_snapshot(restored, snapshot)
            except RuntimeError as error:
                self.fail("unchanged supported source must restore: " + str(error))
            self.assertEqual(result["catalog"], "equal")
        for sql, undo in (("COMMENT ON TRIGGER kept ON rows IS 'must preserve'", "COMMENT ON TRIGGER kept ON rows IS NULL"),
                          ("COMMENT ON POLICY kept ON rows IS 'must preserve'", "COMMENT ON POLICY kept ON rows IS NULL"),
                          ("COMMENT ON RULE \"_RETURN\" ON rows_view IS 'must preserve'", 'COMMENT ON RULE "_RETURN" ON rows_view IS NULL'),
                          ("ALTER DATABASE kin IS_TEMPLATE true", "ALTER DATABASE kin IS_TEMPLATE false"),
                          ("GRANT pg_monitor TO pg_read_all_data", "REVOKE pg_monitor FROM pg_read_all_data")):
            self.ok(source, sql)
            with self.subTest(change=sql), self.assertRaises(ops.RestoreAdmissionError):
                ops.restore_admission(source, shape="pre")
            self.ok(source, undo)

    def test_r5_each_source_login_verifier_is_replayed_and_single_missing_or_extra_is_refused(self):
        import subprocess
        source = self.start()
        self.ok(source, "CREATE DATABASE keycloak")
        self.ok(source, "CREATE ROLE kin_runtime LOGIN PASSWORD 'synthetic-runtime'; "
                        "CREATE ROLE kin_emr_reader LOGIN; CREATE ROLE kin_emr_owner NOLOGIN;")
        subprocess.run(["docker", "exec", source, "sh", "-c",
                        "mkdir -p " + ops.EMR_TABLESPACE + "; chown postgres:postgres " + ops.EMR_TABLESPACE],
                       check=True, capture_output=True)
        self.ok(source, "CREATE TABLESPACE kin_emr_access OWNER kin_emr_owner LOCATION '" + ops.EMR_TABLESPACE + "'")
        catalog = ops.role_catalog(source)
        self.assertEqual(catalog["login_verifiers"], ["kin", "kin_runtime"])
        credentials = {"kin": "r4-synthetic-fixture-only", "kin_runtime": "synthetic-runtime"}
        restored = self.start()
        ops.replay_roles(restored, catalog, shape="post", credentials=credentials)
        self.assertEqual(ops.role_catalog(restored)["login_verifiers"], catalog["login_verifiers"])
        original = ops.run_private_sql
        for statement, expected in (("ALTER ROLE kin_runtime PASSWORD NULL", ["kin"]),
                                    ("ALTER ROLE kin_emr_reader PASSWORD 'unexpected'", ["kin", "kin_emr_reader", "kin_runtime"])):
            target = self.start()

            def changed(container, statements, user="kin"):
                original(container, statements, user)
                self.ok(container, statement)

            with self.subTest(statement=statement), patch.object(ops, "run_private_sql", side_effect=changed):
                with self.assertRaisesRegex(RuntimeError, "Replayed roles or memberships differ"):
                    ops.replay_roles(target, catalog, shape="post", credentials=credentials)
            self.assertEqual(ops.role_catalog(target)["login_verifiers"], expected)

    def test_r4_fresh_restore_ignores_physical_holes_but_refuses_altered_internal_triggers(self):
        source = self.start()
        self.ok(source, "CREATE DATABASE keycloak;")
        self.ok(source, """CREATE TABLE parent(id int PRIMARY KEY);
            CREATE TABLE child(id int UNIQUE DEFERRABLE, dropped text, parent int REFERENCES parent(id) DEFERRABLE);
            ALTER TABLE child DROP COLUMN dropped;
            CREATE TABLE cached(id int, body text);
            CREATE INDEX dropped_index ON cached(id); DROP INDEX dropped_index;
            CREATE FUNCTION noop() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$;
            CREATE TRIGGER removed BEFORE INSERT ON cached FOR EACH ROW EXECUTE FUNCTION noop();
            DROP TRIGGER removed ON cached;
            INSERT INTO parent VALUES(1); INSERT INTO child VALUES(1,1); INSERT INTO cached VALUES(1,'kept');""")
        catalog = ops.cluster_catalog(source)
        self.assertIs(ops.supported_pre_catalog(catalog), catalog)
        with tempfile.TemporaryDirectory() as folder:
            snapshot = self.dump(source, Path(folder) / "snapshot", catalog)
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(ops.restore_pre_snapshot(self.start(), snapshot)["catalog"], "equal")
        self.ok(source, "ALTER TABLE cached SET(toast.autovacuum_enabled=false);")
        self.assertNotEqual(ops.cluster_catalog(source), catalog, "effective TOAST options remain logical restore content")
        self.ok(source, "ALTER TABLE child DISABLE TRIGGER ALL;")
        with self.assertRaises(ops.RestoreAdmissionError):
            ops.object_catalog(source, "kin")
        self.ok(source, "ALTER TABLE child ENABLE TRIGGER ALL;")
        self.assertIsInstance(ops.object_catalog(source, "kin"), dict)

    def test_r4_partial_index_included_columns_restore_and_compare_semantically(self):
        source = self.start()
        self.ok(source, "CREATE DATABASE keycloak;")
        self.ok(source, "CREATE TABLE r(id int, body text); INSERT INTO r VALUES(1,'before'); "
                "CREATE INDEX partial ON r(body) INCLUDE(id) WHERE id>0;")
        catalog = ops.cluster_catalog(source)
        ops.supported_pre_catalog(catalog)
        with tempfile.TemporaryDirectory() as folder:
            snapshot = self.dump(source, Path(folder) / "snapshot", catalog)
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(ops.restore_pre_snapshot(self.start(), snapshot)["catalog"], "equal")
        self.ok(source, "DROP INDEX partial; CREATE INDEX partial ON r(body) WHERE id>0;")
        self.assertNotEqual(ops.cluster_catalog(source), catalog)

    def test_r4_installer_defaults_and_catalog_named_user_tables_restore_unchanged(self):
        source = self.start()
        self.ok(source, "CREATE DATABASE keycloak;")
        self.ok(source, "CREATE TABLE realm(id text, name text); INSERT INTO realm VALUES('fixture-master','master');", "keycloak")
        self.ok(source, "CREATE TABLE public.pg_roles(body text); "
                "INSERT INTO public.pg_roles VALUES('ordinary user data'); "
                "CREATE TABLE public.pg_class(body text); INSERT INTO public.pg_class VALUES('more user data'); "
                "ALTER ROLE kin SET search_path=public,pg_catalog; "
                "ALTER ROLE kin SET default_transaction_read_only=on;")
        catalog, values = ops.cluster_catalog(source), ops.value_catalog(source)
        ops.supported_pre_catalog(catalog)
        self.assertEqual(ops.psql_json(source, "keycloak", "SELECT json_agg(id) FROM realm WHERE name='master'"), ["fixture-master"])
        with tempfile.TemporaryDirectory() as folder:
            snapshot = self.dump(source, Path(folder) / "snapshot", catalog)
            target = self.start()
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(ops.restore_pre_snapshot(target, snapshot)["catalog"], "equal")
            self.assertEqual(ops.cluster_catalog(target), catalog)
            self.assertEqual(ops.value_catalog(target), values)
            self.assertEqual(ops.psql_json(target, "keycloak", "SELECT json_agg(id) FROM realm WHERE name='master'"), ["fixture-master"])

    def test_d22_column_type_large_object_publication_event_trigger_and_fdw_privileges_restore_exactly(self):
        """D22/C-RESTORE: supported column/type ACLs restore exactly. LO/publication/event-trigger/FDW content is
        explicitly unsupported in v1 and refuses admission; no names-only projection can call it exact."""
        source = self.start()
        self.ok(source, "CREATE DATABASE keycloak OWNER kin;")
        self.ok(source, """
            CREATE ROLE kin_legacy_reader NOLOGIN;
            CREATE TABLE public."Report"(id int, body text, secret text);
            GRANT SELECT (id, body) ON public."Report" TO kin_legacy_reader;
            CREATE TYPE public.kin_mood AS ENUM ('a', 'b');
            REVOKE USAGE ON TYPE public.kin_mood FROM PUBLIC;
            GRANT USAGE ON TYPE public.kin_mood TO kin_legacy_reader;
            CREATE DOMAIN public.kin_code AS text;
        """)
        catalog = ops.cluster_catalog(source)
        objects = catalog["objects"]["kin"]["records"]
        column = next(item for item in objects if item["key"][2:] == ["column", "Report", 1])
        self.assertEqual(column["attributes"]["acl"], ["kin_legacy_reader=r/kin"])
        mood = next(item for item in objects if item["key"][2:4] == ["type", "kin_mood"])
        self.assertIn("kin_legacy_reader=U/kin", mood["attributes"]["acl"])
        with tempfile.TemporaryDirectory() as folder:
            whole = self.dump(source, Path(folder) / "whole", catalog)
            self.ok(source, 'REVOKE SELECT (id) ON public."Report" FROM kin_legacy_reader;')
            lost = self.dump(source, Path(folder) / "lost", catalog)
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(ops.restore_pre_snapshot(self.start(), whole)["catalog"], "equal")
                with self.assertRaisesRegex(RuntimeError, "Restored catalog differs from the snapshot: objects"):
                    ops.restore_pre_snapshot(self.start(), lost)
        unsupported = [
            ("LO bytes", "SELECT lo_from_bytea(424242, 'synthetic');", "SELECT lo_unlink(424242);"),
            ("publication", 'CREATE PUBLICATION kin_pub FOR TABLE public."Report" WHERE (id>0);', "DROP PUBLICATION kin_pub;"),
            ("event trigger", "CREATE FUNCTION public.kin_evt() RETURNS event_trigger LANGUAGE plpgsql AS $$BEGIN END$$; "
             "CREATE EVENT TRIGGER kin_evt ON ddl_command_end EXECUTE FUNCTION public.kin_evt();", "DROP EVENT TRIGGER kin_evt; DROP FUNCTION public.kin_evt();"),
            ("FDW", "CREATE EXTENSION postgres_fdw; CREATE SERVER kin_remote FOREIGN DATA WRAPPER postgres_fdw OPTIONS(host 'remote.invalid'); "
             "CREATE USER MAPPING FOR kin_legacy_reader SERVER kin_remote OPTIONS(user 'synthetic');", "DROP EXTENSION postgres_fdw CASCADE;"),
            ("materialized values", "CREATE MATERIALIZED VIEW mv AS SELECT 7 AS n;", "DROP MATERIALIZED VIEW mv;")]
        for label, create, remove in unsupported:
            self.ok(source, create)
            try:
                with self.subTest(kind=label), self.assertRaises(ops.RestoreAdmissionError):
                    ops.object_catalog(source, "kin")
            finally:
                self.ok(source, remove)

    def test_irt2_16_24_every_lost_or_changed_object_privilege_grantor_value_or_sequence_is_seen(self):
        """IRT2-16/IRT2-24 on real PostgreSQL: after one exact restore (catalog and values equal), each single change -
        a column/type privilege, a policy, settings, a function or view definition, a trigger's state, a membership's
        grantor, a sequence state, a Keycloak row value, a row of a
        non-public kin schema - makes the compared catalog or value catalog differ; a membership granted by another role
        than kin and a kin with non-default attributes (IRT2-17) are refused at capture."""
        source = self.start()
        self.ok(source, "CREATE DATABASE keycloak OWNER kin;")
        self.ok(source, """
            CREATE ROLE reader NOLOGIN; CREATE ROLE delegator NOLOGIN; CREATE ROLE leaf NOLOGIN;
            CREATE TABLE public.r(id int, n text); INSERT INTO public.r VALUES (1, 'before');
            CREATE SCHEMA archive; CREATE TABLE archive.kept(id int); INSERT INTO archive.kept VALUES (1), (2);
            CREATE SEQUENCE public.seq; SELECT nextval('public.seq');
            CREATE TYPE public.choice AS ENUM ('a', 'b'); GRANT SELECT (n) ON public.r TO reader; GRANT USAGE ON TYPE public.choice TO reader;
            CREATE FUNCTION public.guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$;
            CREATE TRIGGER r_guard BEFORE UPDATE ON public.r FOR EACH ROW EXECUTE FUNCTION public.guard();
            CREATE VIEW public.v AS SELECT id FROM public.r;
            GRANT reader TO leaf;
            ALTER ROLE reader SET search_path=public;
            ALTER ROLE reader IN DATABASE kin SET statement_timeout='7s';
            ALTER DATABASE keycloak SET work_mem='8MB';
            ALTER TABLE public.r ENABLE ROW LEVEL SECURITY;
            CREATE POLICY read_rows ON public.r TO reader USING(id>0);
        """)
        self.ok(source, "CREATE TABLE public.sessions(id int, value text); INSERT INTO public.sessions VALUES (1, 'before');", database="keycloak")
        catalog = ops.cluster_catalog(source)
        values = ops.value_catalog(source)
        self.assertEqual({tuple(row["key"]) for row in values["tables"]}, {("kin", "archive", "table", "kept", None),
            ("kin", "public", "table", "r", None), ("keycloak", "public", "table", "sessions", None)})
        with tempfile.TemporaryDirectory() as folder:
            whole = self.dump(source, Path(folder) / "whole", catalog)
            target = self.start()
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(ops.restore_pre_snapshot(target, whole)["catalog"], "equal")
        self.assertEqual(ops.value_catalog(target), values, "the restore reproduces every row value")
        changes = [("column privilege", "REVOKE SELECT (n) ON public.r FROM reader", "kin", "catalog"),
                   ("type privilege", "REVOKE USAGE ON TYPE public.choice FROM reader", "kin", "catalog"),
                   ("policy expression", "ALTER POLICY read_rows ON public.r USING(true)", "kin", "catalog"),
                   ("RLS enabled", "ALTER TABLE public.r DISABLE ROW LEVEL SECURITY", "kin", "catalog"),
                   ("column default", "ALTER TABLE public.r ALTER COLUMN id SET DEFAULT 99", "kin", "catalog"),
                   ("enum labels", "ALTER TYPE public.choice ADD VALUE 'c'", "kin", "catalog"),
                   ("role-in-database setting", "ALTER ROLE reader IN DATABASE kin SET statement_timeout='9s'", "kin", "catalog"),
                   ("function definition", "CREATE OR REPLACE FUNCTION public.guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN OLD; END$$",
                    "kin", "catalog"),
                   ("trigger state", "ALTER TABLE public.r DISABLE TRIGGER r_guard", "kin", "catalog"),
                   ("view definition", "CREATE OR REPLACE VIEW public.v AS SELECT id FROM public.r WHERE id > 0", "kin", "catalog"),
                   ("membership grantor", "GRANT reader TO delegator WITH ADMIN OPTION; REVOKE reader FROM leaf; "
                                          "SET ROLE delegator; GRANT reader TO leaf; RESET ROLE", "kin", "catalog"),
                   ("sequence state", "ALTER SEQUENCE public.seq RESTART WITH 987654; SELECT nextval('public.seq')", "kin", "catalog"),
                   # A RESTART never followed by nextval: pg_sequence_last_value shows NULL before and after; the
                   # sequence's own last_value/is_called differ (Astra's postgres_catalog_repros sequence_value case).
                   ("sequence restart without a call", "ALTER SEQUENCE public.seq RESTART WITH 555", "kin", "catalog"),
                   ("sequence parameters", "ALTER SEQUENCE public.seq INCREMENT BY 5", "kin", "catalog"),
                   ("Keycloak row value", "UPDATE public.sessions SET value = 'changed'", "keycloak", "values"),
                   ("non-public row", "DELETE FROM archive.kept WHERE id = 2", "kin", "values")]
        for name, statement, database, compared in changes:
            before = ops.cluster_catalog(target) if compared == "catalog" else ops.value_catalog(target)
            self.ok(target, statement, database)
            after = ops.cluster_catalog(target) if compared == "catalog" else ops.value_catalog(target)
            with self.subTest(change=name):
                self.assertNotEqual(after, before)
        # The grantor change above made a membership that kin did not grant: such a cluster is refused at capture.
        with self.assertRaisesRegex(RuntimeError, "granted by another role than kin"):
            ops.supported_pre_catalog(ops.role_catalog(target))
        self.ok(target, "ALTER ROLE kin CONNECTION LIMIT 7;")
        with self.assertRaisesRegex(RuntimeError, "attributes a fresh cluster's kin does not"):
            ops.supported_pre_catalog(ops.role_catalog(target))

    def test_r4_closed_boundary_and_nologin_verifiers_refuse_before_mutation(self):
        source = self.start()
        self.ok(source, "CREATE DATABASE keycloak OWNER kin;")
        image = json.loads(ops.run(["docker", "inspect", source]).stdout)[0]["Image"]
        ops.restore_admission(source, shape="pre", image=image)
        self.ok(source, "CREATE ROLE dormant NOLOGIN PASSWORD 'synthetic-dormant-only';")
        with self.assertRaises(ops.RestoreAdmissionError):
            ops.restore_admission(source, shape="pre", image=image)
        self.ok(source, "ALTER ROLE dormant PASSWORD NULL;")
        self.ok(source, "ALTER ROLE dormant SET random_page_cost=3;")
        with self.assertRaises(ops.RestoreAdmissionError):
            ops.restore_admission(source, shape="pre", image=image)
        self.ok(source, "ALTER ROLE dormant RESET random_page_cost;")
        for database in ("postgres", "template1"):
            self.ok(source, "CREATE TABLE public.outside_inventory(n int);", database)
            try:
                with self.subTest(database=database), self.assertRaises(ops.RestoreAdmissionError):
                    ops.restore_admission(source, shape="pre", image=image)
            finally:
                self.ok(source, "DROP TABLE public.outside_inventory;", database)

    def test_r4_structured_quoted_names_and_both_database_values(self):
        source = self.start()
        self.ok(source, "CREATE DATABASE keycloak OWNER kin;")
        for database in ("kin", "keycloak"):
            self.ok(source, '''CREATE SCHEMA "a.b"; CREATE SCHEMA a;
                CREATE TABLE "a.b".c("x.y" text); CREATE TABLE a."b.c"("x.y" text);
                INSERT INTO "a.b".c VALUES ('one'), ('one'), (NULL);
                INSERT INTO a."b.c" VALUES ('two');''', database)
        values = ops.value_catalog(source)
        keys = {tuple(row["key"]) for row in values["tables"]}
        self.assertEqual(len(keys), 4)
        self.assertIn(("kin", "a.b", "table", "c", None), keys)
        self.assertIn(("kin", "a", "table", "b.c", None), keys)
        for database in ("kin", "keycloak"):
            before = ops.value_catalog(source)
            self.ok(source, '''UPDATE a."b.c" SET "x.y"='changed';''', database)
            self.assertNotEqual(ops.value_catalog(source), before)

    def test_r4_literal_values_and_restore_are_independent_of_session_string_defaults(self):
        """Stored GUCs remain intact while private SQL transports quoted/backslash/Unicode data literally."""
        source = self.start()
        self.ok(source, "CREATE DATABASE keycloak OWNER kin;")
        self.ok(source, "CREATE ROLE reader NOLOGIN;")
        schema, table = "quoted\\'schema", "한글.table"
        value = "literal\\n'\n한글; SELECT 9; -- $tag$"
        relation = ops._identifier(schema) + "." + ops._identifier(table)
        for database in ops.PRE_DATABASES:
            self.ok(source, "CREATE SCHEMA " + ops._identifier(schema) + "; CREATE TABLE " + relation +
                    "(body text); INSERT INTO " + relation + " VALUES (" + ops._sql_literal(value) + ");", database)
        self.ok(source, "COMMENT ON ROLE reader IS " + ops._sql_literal(value) + "; "
                "ALTER ROLE kin SET standard_conforming_strings=off; ALTER ROLE kin SET client_encoding='LATIN1'; "
                "ALTER ROLE reader SET client_encoding='LATIN1'; "
                "ALTER ROLE reader SET transaction_read_only=on; ALTER ROLE reader SET statement_timeout='1ms'; "
                "ALTER ROLE reader SET search_path=public," + ops._identifier(schema) + ";")
        for database in ops.PRE_DATABASES:
            self.assertEqual(ops.psql_json(source, database, "SELECT json_build_array(" + ops._sql_literal(value) + ");"), [value])
            self.assertEqual(ops.value_rows(source, database, schema, table), (["body"], [[value]]))
        catalog, values = ops.cluster_catalog(source), ops.value_catalog(source)
        with tempfile.TemporaryDirectory() as folder:
            # Exercise the capture's actual export command against PG16. Only the unrelated host/storage envelope
            # is synthetic, so omitting the export encoding fails here even if this class's dump helper is correct.
            host = FakeHost(folder)
            (host.repo / ".env").write_text("POSTGRES_PASSWORD=r4-synthetic-fixture-only\n")
            host.catalog = lambda container=None: {key: value for key, value in catalog.items() if key != "objects"}
            host.objects = lambda database: catalog["objects"][database]
            envelope_run, database_run = host.run, ops.run
            def capture_run(args, **kwargs):
                if "pg_dump" in args or "pg_dumpall" in args:
                    command = list(args)
                    command[2] = source
                    # ROOT is bound to the synthetic checkout during capture, as on the deployed host.
                    return database_run(command, **kwargs)
                return envelope_run(args, **kwargs)
            host.run = capture_run
            whole = host.capture()
            target = self.start()
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(ops.restore_pre_snapshot(target, whole)["catalog"], "equal")
            self.assertEqual(ops.value_catalog(target), values)

    def test_d23_pg_dumpall_roles_fail_in_a_postgres_cluster_and_the_catalog_replay_rebuilds_them(self):
        """D23: a kin-bootstrapped cluster's membership is dumped by pg_dumpall as GRANTED BY kin, which PostgreSQL 16
        refuses when replayed in a cluster whose bootstrap superuser is postgres (the older daily rehearsal); the catalog
        replay rebuilds the same roles and memberships in a cluster bootstrapped as kin."""
        import subprocess
        source = self.start()
        self.ok(source, "CREATE DATABASE keycloak OWNER kin;")
        self.ok(source, "CREATE ROLE kin_legacy_group NOLOGIN NOINHERIT; CREATE ROLE kin_legacy_reader NOLOGIN CONNECTION LIMIT 3; "
                        "GRANT kin_legacy_group TO kin_legacy_reader;")
        roles = subprocess.run(["docker", "exec", source, "pg_dumpall", "-U", "kin", "--roles-only", "--no-role-passwords"],
                               check=True, capture_output=True).stdout
        self.assertIn(b"GRANTED BY", roles)
        legacy = self.start("postgres")
        replayed = subprocess.run(["docker", "exec", "-i", legacy, "psql", "-X", "-U", "postgres", "-v", "ON_ERROR_STOP=1"], input=roles,
                                  capture_output=True)
        self.assertNotEqual(replayed.returncode, 0)
        self.assertIn(b"ADMIN option", replayed.stderr)
        catalog = ops.role_catalog(source)
        target = self.start()
        result = ops.replay_roles(target, catalog, shape="pre", credentials={"kin": "r4-synthetic-fixture-only"})
        self.assertEqual(sorted(result["created"]), ["kin_legacy_group", "kin_legacy_reader"])
        self.assertEqual(ops.role_catalog(target)["memberships"], catalog["memberships"])



class PgLedgerCopyRetirement(unittest.TestCase):
    """REQ-B2R-05: no ending by silence or unknown dependent-copy status."""
    def copy(self, copy_id='backup', **changes):
        value = ops.copy_manifest(copy_id=copy_id, location='owned-synthetic', custodian='fixture',
            manifest={'sha256': {'kin.dump': 'a'*64}}, installation_id='synthetic-installation',
            data_classes=['RET-06', 'RET-11'], restorable=False,
            disposition={'action': 'existing rotation removed archive', 'verification': 'fixture-receipt'})
        return {**value, **changes}

    def evidence(self, copies):
        result = {name: {'met': True, 'evidence': 'synthetic-receipt'} for name in ops.RETIREMENT_CONDITIONS}
        result['consumers_ended']['basis'] = 'installation decommissioned'
        result['no_restorable_copy_remains'].update(copies=copies, inventory_complete=True)
        return result

    def test_purpose_and_complete_copy_ending(self):
        def decide(copies):
            return ops.retirement('synthetic-installation', self.evidence(copies))['retire']
        self.assertTrue(decide([self.copy()]))
        for changes in ({'restorable': True}, {'restorable': None}, {'restorable': 0},
                        {'disposition': None}, {'dependent_copy_ids': ['missing']},
                        {'hold': {'basis': 'actual hold', 'closure_evidence': None}},
                        {'installation_id': 'other'}):
            with self.subTest(changes=changes):
                self.assertFalse(decide([self.copy(**changes)]))
        absent = self.copy(); del absent['restorable']
        self.assertFalse(decide([absent]))
        self.assertFalse(decide([None]))
        self.assertTrue(decide([self.copy(dependent_copy_ids=['restore']), self.copy('restore')]))
        for basis in ops.NOT_AN_ENDING:
            facts = self.evidence([self.copy()]); facts['consumers_ended']['basis'] = basis
            self.assertFalse(ops.retirement('synthetic-installation', facts)['retire'])
        facts = self.evidence([]); facts['no_restorable_copy_remains'].pop('inventory_complete')
        self.assertFalse(ops.retirement('synthetic-installation', facts)['retire'])
        facts = self.evidence([]); facts['retired_from_service']['met'] = 1
        with self.assertRaises(ValueError):
            ops.retirement('synthetic-installation', facts)


if __name__ == "__main__":
    unittest.main(verbosity=2)
