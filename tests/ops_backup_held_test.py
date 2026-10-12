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
        roles = [role("kin", superuser=True, login=True)] + ([role(name, login=name == "kin_runtime") for name in ops.EMR_ROLES]
                                                              if self.emr_roles else []) + list(self.extra_roles)
        return {"roles": roles, "memberships": list(self.memberships),
                "databases": [{"name": name, "owner": "kin", "acl": None} for name in ("keycloak", "kin", "postgres", *self.extra_databases)],
                "tablespaces": [{"name": "pg_default", "owner": "kin", "location": ""}, {"name": "pg_global", "owner": "kin", "location": ""},
                                *([{"name": "kin_emr_access", "owner": "kin_emr_owner", "location": ops.EMR_TABLESPACE}] if self.emr_roles else []),
                                *self.extra_tablespaces],
                "schemas": ["public", *(["emr_access"] if self.emr_roles else [])]}

    def objects(self, database):
        return {"schemas": [{"name": "public", "owner": "pg_database_owner", "acl": None}],
                "relations": [{"name": "public.Report", "kind": "r", "owner": "kin", "acl": None}] if database == "kin" else [],
                "functions": [], "default_acl": []}

    def text(self, args, **kwargs):
        self.commands.append(list(args))
        joined = " ".join(args)
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
            return json.dumps(self.catalog())
        if ops.MIGRATIONS_SQL in args:
            return json.dumps([["0_init", "1" * 64, True, False]])
        if ops.VALUE_TABLES_SQL in args:
            return json.dumps([["public", "Report"]] if args[args.index("-d") + 1] == "kin" else [["public", "realm"]])
        if "information_schema.columns" in joined:
            return json.dumps({"Report": ["id", "body"]})
        if "json_object_agg(name, d)" in joined:
            return json.dumps({"Report": [2, "c" * 64]})
        raise AssertionError("unexpected command " + joined[:80])

    def run(self, args, *, output=None, input_file=None, timeout=600, check=True):
        self.commands.append(list(args))
        if "psql" in args and "-f" in args and input_file is not None:
            # The value catalog (IRT2-24): one digest per table of the database asked.
            database = args[args.index("-d") + 1]
            name = "public.Report" if database == "kin" else "public.realm"
            return SimpleNamespace(returncode=0, stdout=json.dumps({name: [2, "c" * 64]}).encode(), stderr=b"")
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
        if "node" in args:
            return "EMR_RESTORE_VERIFIED"
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
        self.assertEqual(result["catalog"]["catalog"], "equal")
        # Owners and privileges are restored, never stripped (IRT-07): no --no-owner/--no-privileges restore.
        restores = [command for command in host.commands if "pg_restore" in command]
        self.assertEqual(len(restores), 2)
        self.assertTrue(all("--create" in command and "--no-owner" not in command and "--no-privileges" not in command for command in restores))

    def test_11_a_post_emr_capture_is_restored_exactly_in_a_kin_bootstrap_cluster(self):
        """B1's restore check replays its roles (EMR logins without a password) and memberships as the cluster's own
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
        started = next(command for command in host.commands if command[:3] == ["docker", "run", "-d"])
        self.assertIn("POSTGRES_USER=kin", started)
        self.assertTrue(any("CREATE TABLESPACE kin_emr_access OWNER kin_emr_owner" in " ".join(command) for command in host.commands))
        self.assertFalse(any("cluster-roles.sql" in str(command) or "--no-owner" in command for command in host.commands))

    def test_10_an_unsupported_pre_emr_catalog_is_refused_before_anything_is_written(self):
        """IRT-07: a B0 that a rollback could not rebuild exactly never becomes a B0."""
        cases = {"further login role": lambda host: host.extra_roles.append(role("legacy_app", login=True)),
                 "role settings": lambda host: host.extra_roles.append(role("legacy_cfg", config=["search_path=x"])),
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
        self.databases = {"kin": {"name": "kin", "owner": "kin", "acl": None}, "postgres": {"name": "postgres", "owner": "kin", "acl": None}}
        self.objects = {}
        self.commands = []
        self.strip = None

    def catalog(self):
        return {"roles": [self.roles[name] for name in sorted(self.roles)], "memberships": sorted(self.memberships, key=lambda m: (m["granted"], m["member"])),
                "databases": [self.databases[name] for name in sorted(self.databases)], "tablespaces": self.snapshot["tablespaces"],
                "schemas": self.snapshot["schemas"] if "kin" in self.objects else ["public"]}

    def apply(self, sql):
        import re as pattern
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
            self.apply(input_file.read().decode())
        elif "DROP DATABASE kin WITH (FORCE);" in args:
            self.databases.pop("kin")
        elif "pg_restore" in args:
            database = Path(input_file.name).name.split(".")[0]
            self.databases[database] = dict(next(item for item in self.snapshot["databases"] if item["name"] == database))
            self.objects[database] = json.loads(json.dumps(self.snapshot["objects"][database]))
            if self.strip and database == "kin":
                self.objects[database]["relations"][0]["acl"] = None
        return SimpleNamespace(returncode=0, stdout=b"", stderr=b"")


class ExactRestoreTests(unittest.TestCase):
    """IRT-07: a pre-EMR B0 with further NOLOGIN roles, memberships and their owned/granted objects is rebuilt exactly."""

    def snapshot(self, folder):
        roles = [role("kin", superuser=True, login=True), role("legacy_group", inherit=False), role("legacy_reader", connlimit=3)]
        catalog = {"roles": roles,
                   "memberships": [{"granted": "legacy_group", "member": "legacy_reader", "grantor": "kin", "admin_option": False, "inherit_option": True,
                                    "set_option": True},
                                   {"granted": "pg_read_all_data", "member": "legacy_group", "grantor": "kin", "admin_option": True, "inherit_option": False,
                                    "set_option": False}],
                   "databases": [{"name": "keycloak", "owner": "kin", "acl": None},
                                 {"name": "kin", "owner": "kin", "acl": "{=Tc/kin,kin=CTc/kin,legacy_reader=c/kin}"},
                                 {"name": "postgres", "owner": "kin", "acl": None}],
                   "tablespaces": [{"name": "pg_default", "owner": "kin", "location": ""}, {"name": "pg_global", "owner": "kin", "location": ""}],
                   "schemas": ["legacy_archive", "public"],
                   "objects": {"kin": {"schemas": [{"name": "legacy_archive", "owner": "legacy_group", "acl": None}],
                                       "relations": [{"name": "public.AuditLog", "kind": "r", "owner": "kin",
                                                      "acl": "{kin=arwdDxtm/kin,legacy_reader=r/kin}"}],
                                       "functions": [], "default_acl": []},
                               "keycloak": {"schemas": [], "relations": [], "functions": [], "default_acl": []}}}
        directory = Path(folder)
        (directory / "catalog.json").write_text(json.dumps(catalog))
        for database in ("kin", "keycloak"):
            (directory / (database + ".dump")).write_bytes(b"synthetic dump")
        return directory, catalog

    def restore(self, cluster, directory):
        with patch.object(ops, "text", side_effect=cluster.text), patch.object(ops, "run", side_effect=cluster.run):
            return ops.restore_pre_snapshot("kin-rh-db", directory)

    def test_01_roles_memberships_owners_and_grants_are_rebuilt_and_compared(self):
        with tempfile.TemporaryDirectory() as folder:
            directory, catalog = self.snapshot(folder)
            cluster = FakeCluster(catalog)
            result = self.restore(cluster, directory)
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
            catalog["objects"]["kin"]["columns"] = [{"name": "public.AuditLog.actor", "acl": ["legacy_reader=r/kin"]}]
            (directory / "catalog.json").write_text(json.dumps(catalog))
            self.restore(FakeCluster(catalog), directory)
            cluster = FakeCluster(catalog)
            original = cluster.run

            def losing(args, **kwargs):
                result = original(args, **kwargs)
                if "pg_restore" in args and "kin" in cluster.objects:
                    cluster.objects["kin"]["columns"] = []
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

    def start(self, superuser="kin"):
        import subprocess
        import time as clock
        import uuid
        token = uuid.uuid4().hex
        name = "kin-rehearsal-" + token[:16]
        subprocess.run(["docker", "run", "-d", "--name", name, "--label", "kin.ops.run=" + token, "--network", "none",
                        "-e", "POSTGRES_USER=" + superuser, "-e", "POSTGRES_DB=kin", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", POSTGRES_IMAGE],
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
        for database in ("kin", "keycloak"):
            with open(directory / (database + ".dump"), "wb") as handle:
                subprocess.run(["docker", "exec", name, "pg_dump", "-U", "kin", "-d", database, "-Fc", "--create"], stdout=handle, check=True)
        return directory

    def test_d22_column_type_large_object_publication_event_trigger_and_fdw_privileges_restore_exactly(self):
        """D22: the extended catalog reads column, type, large-object, foreign-server privileges, publications, event
        triggers and user mappings; pg_dump/pg_restore --create reproduce all of them exactly (no false refusal of a
        rollback); a dump that lost one column grant is refused by restore_pre_snapshot."""
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
            SELECT lo_from_bytea(424242, 'synthetic');
            GRANT SELECT ON LARGE OBJECT 424242 TO kin_legacy_reader;
            CREATE PUBLICATION kin_pub FOR TABLE public."Report";
            CREATE FUNCTION public.kin_evt() RETURNS event_trigger LANGUAGE plpgsql AS $$BEGIN END$$;
            CREATE EVENT TRIGGER kin_evt ON ddl_command_end EXECUTE FUNCTION public.kin_evt();
            CREATE EXTENSION postgres_fdw;
            CREATE SERVER kin_remote FOREIGN DATA WRAPPER postgres_fdw OPTIONS (host 'remote.invalid', dbname 'x');
            GRANT USAGE ON FOREIGN SERVER kin_remote TO kin_legacy_reader;
            CREATE USER MAPPING FOR kin_legacy_reader SERVER kin_remote OPTIONS (user 'x');
        """)
        catalog = ops.cluster_catalog(source)
        objects = catalog["objects"]["kin"]
        self.assertIn({"name": "public.Report.id", "acl": ["kin_legacy_reader=r/kin"]}, objects["columns"])
        mood = next(item for item in objects["types"] if item["name"] == "public.kin_mood")
        self.assertIn("kin_legacy_reader=U/kin", mood["acl"])
        self.assertTrue(any(item["name"] == "public.kin_code" and item["kind"] == "d" for item in objects["types"]))
        self.assertEqual([item["id"] for item in objects["large_objects"]], [424242])
        self.assertIn("kin_legacy_reader=r/kin", objects["large_objects"][0]["acl"])
        self.assertEqual([(item["name"], item["relations"]) for item in objects["publications"]], [("kin_pub", ['"Report"'])])
        self.assertEqual([item["name"] for item in objects["event_triggers"]], ["kin_evt"])
        self.assertEqual([item["name"] for item in objects["foreign_data_wrappers"]], ["postgres_fdw"])
        self.assertIn("kin_legacy_reader=U/kin", objects["foreign_servers"][0]["acl"])
        self.assertEqual(objects["user_mappings"], [{"server": "kin_remote", "member": "kin_legacy_reader"}])
        with tempfile.TemporaryDirectory() as folder:
            whole = self.dump(source, Path(folder) / "whole", catalog)
            self.ok(source, 'REVOKE SELECT (id) ON public."Report" FROM kin_legacy_reader;')
            lost = self.dump(source, Path(folder) / "lost", catalog)
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(ops.restore_pre_snapshot(self.start(), whole)["catalog"], "equal")
                with self.assertRaisesRegex(RuntimeError, "Restored catalog differs from the snapshot: objects"):
                    ops.restore_pre_snapshot(self.start(), lost)

    def test_irt2_16_24_every_lost_or_changed_object_privilege_grantor_value_or_sequence_is_seen(self):
        """IRT2-16/IRT2-24 on real PostgreSQL: after one exact restore (catalog and values equal), each single change -
        a column, type, large-object or server privilege, a publication, an event trigger, a user mapping, a function or
        view definition, a trigger's state, a membership's grantor, a sequence state, a Keycloak row value, a row of a
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
            SELECT lo_create(123456); GRANT SELECT ON LARGE OBJECT 123456 TO reader;
            CREATE FOREIGN DATA WRAPPER dummy; CREATE SERVER srv FOREIGN DATA WRAPPER dummy; GRANT USAGE ON FOREIGN SERVER srv TO reader;
            CREATE USER MAPPING FOR reader SERVER srv;
            CREATE PUBLICATION pub FOR TABLE public.r;
            CREATE FUNCTION public.onddl() RETURNS event_trigger LANGUAGE plpgsql AS $$BEGIN END$$;
            CREATE EVENT TRIGGER et ON ddl_command_end EXECUTE FUNCTION public.onddl();
            CREATE FUNCTION public.guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$;
            CREATE TRIGGER r_guard BEFORE UPDATE ON public.r FOR EACH ROW EXECUTE FUNCTION public.guard();
            CREATE VIEW public.v AS SELECT id FROM public.r;
            GRANT reader TO leaf;
        """)
        self.ok(source, "CREATE TABLE public.sessions(id int, value text); INSERT INTO public.sessions VALUES (1, 'before');", database="keycloak")
        catalog = ops.cluster_catalog(source)
        values = ops.value_catalog(source)
        self.assertEqual(set(values["kin"]), {"archive.kept", "public.r"})
        self.assertEqual(set(values["keycloak"]), {"public.sessions"})
        with tempfile.TemporaryDirectory() as folder:
            whole = self.dump(source, Path(folder) / "whole", catalog)
            target = self.start()
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(ops.restore_pre_snapshot(target, whole)["catalog"], "equal")
        self.assertEqual(ops.value_catalog(target), values, "the restore reproduces every row value")
        changes = [("column privilege", "REVOKE SELECT (n) ON public.r FROM reader", "kin", "catalog"),
                   ("type privilege", "REVOKE USAGE ON TYPE public.choice FROM reader", "kin", "catalog"),
                   ("large object", "SELECT lo_unlink(123456)", "kin", "catalog"),
                   ("user mapping", "DROP USER MAPPING FOR reader SERVER srv", "kin", "catalog"),
                   ("foreign server privilege", "REVOKE USAGE ON FOREIGN SERVER srv FROM reader", "kin", "catalog"),
                   ("publication", "DROP PUBLICATION pub", "kin", "catalog"),
                   ("event trigger", "DROP EVENT TRIGGER et", "kin", "catalog"),
                   ("function definition", "CREATE OR REPLACE FUNCTION public.guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN OLD; END$$",
                    "kin", "catalog"),
                   ("trigger state", "ALTER TABLE public.r DISABLE TRIGGER r_guard", "kin", "catalog"),
                   ("view definition", "CREATE OR REPLACE VIEW public.v AS SELECT id FROM public.r WHERE id > 0", "kin", "catalog"),
                   ("membership grantor", "GRANT reader TO delegator WITH ADMIN OPTION; REVOKE reader FROM leaf; "
                                          "SET ROLE delegator; GRANT reader TO leaf; RESET ROLE", "kin", "catalog"),
                   ("sequence state", "ALTER SEQUENCE public.seq RESTART WITH 987654; SELECT nextval('public.seq')", "kin", "catalog"),
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
        result = ops.replay_roles(target, catalog, shape="pre")
        self.assertEqual(sorted(result["created"]), ["kin_legacy_group", "kin_legacy_reader"])
        self.assertEqual(ops.role_catalog(target)["memberships"], catalog["memberships"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
