"""C-RESTORE v1 admission and residual-value contracts. Docker cases live in ops_backup_held_test.

These tests supply catalog/row observations, never change product SQL to fit a parser or a test selector.

StateCopyRestoreContainerTests (opt-in: a production API image in KIN_TEST_API_IMAGE and a local Docker daemon) is the
EMR-B2 (c) positive v3 private restore (D1656-T07, C-O02): a state capture taken from the real state service is restored
on labelled private resources paired with a privately restored database through the launch-scoped copy mapping,
recovered by the same compiled service root, observed ready over the IPC socket, a second owner refused, closed
completely; the source capture's bytes stay unchanged, and a capture bound to another pair is refused before any command.
"""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
import uuid
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import ops_backup as ops
import ops_emr_introduction as intro
import ops_emr_probe as probe
import ops_backup_held_test as held
from ops_backup_held_test import FakeHost, FakeCluster, catalog_globals, inventory, object_row, role

ROOT = Path(__file__).resolve().parents[1]


class InventoryContracts(unittest.TestCase):
    def test_pg_settings_have_exact_role_database_scopes_and_unknown_settings_refuse(self):
        with tempfile.TemporaryDirectory() as folder:
            host = FakeHost(folder)
            host.extra_roles.append(role("reader", config=['search_path=public, "a.b"']))
            catalog = host.catalog()
        catalog["settings"] = [{"database": None, "role": "reader", "config": ['search_path=public, "a.b"']},
                               {"database": "kin", "role": "reader", "config": ["statement_timeout=7s"]},
                               {"database": "keycloak", "role": None, "config": ["work_mem=8MB"]}]
        self.assertEqual(ops.supported_pre_catalog(catalog), catalog)
        self.assertEqual(ops.configuration(catalog["roles"][-1]["rolconfig"], catalog["setting_names"]), [("search_path", 'public, "a.b"')])
        for scope in ("postgres", "template0", "unknown"):
            bad = copy.deepcopy(catalog)
            bad["settings"][1]["database"] = scope
            with self.subTest(scope=scope), self.assertRaises(RuntimeError):
                ops.supported_pre_catalog(bad)
        for setting in ("session_preload_libraries=unexpected", "unknown.secret=value", "search_path=x\x00y"):
            bad = copy.deepcopy(catalog)
            bad["settings"][1]["config"] = [setting]
            with self.subTest(setting=setting), self.assertRaises(RuntimeError):
                ops.supported_pre_catalog(bad)
        bad = copy.deepcopy(catalog)
        bad["setting_names"].append("random_page_cost")
        bad["settings"][1]["config"] = ["random_page_cost=3"]
        with self.assertRaises(RuntimeError):
            ops.supported_pre_catalog(bad)

    def test_source_admission_precedes_checkout_or_entry_preparation(self):
        host = object.__new__(intro.HostOps)
        context = SimpleNamespace(phase="capture")
        calls = []
        def refuse(context):
            calls.append("admission")
            raise intro.Stop("미지원 원본")
        host.admit_source = refuse
        with self.assertRaises(intro.Stop):
            host.prepare(context)
        self.assertEqual(calls, ["admission"])
        self.assertFalse(hasattr(host, "entry_inputs"), "no operational entry has been prepared")

    def test_every_supported_object_attribute_is_compared_after_restore(self):
        fixture = held.ExactRestoreTests()
        with tempfile.TemporaryDirectory() as folder:
            directory, catalog = fixture.snapshot(folder)
            for kind, fields in ops.INVENTORY_ATTRIBUTES.items():
                record = object_row("kin", kind, "comparison-object")
                catalog["objects"]["kin"]["records"] = [record]
                (directory / "catalog.json").write_text(json.dumps(catalog), encoding="utf-8")
                self.assertEqual(fixture.restore(FakeCluster(catalog), directory)["catalog"], "equal")
                for field in fields.split():
                    cluster = FakeCluster(catalog)
                    original = cluster.run
                    def corrupt(args, **kwargs):
                        result = original(args, **kwargs)
                        if "pg_restore" in args and "kin" in cluster.objects:
                            cluster.objects["kin"]["records"][0]["attributes"][field] = "unexpected"
                        return result
                    cluster.run = corrupt
                    with self.subTest(kind=kind, field=field), self.assertRaisesRegex(RuntimeError, "Restored catalog differs"):
                        fixture.restore(cluster, directory)

    def test_inventory_is_closed_on_version_catalog_kind_and_every_attribute(self):
        valid = inventory("kin", [object_row("kin", "column", "a.b", acl=["reader=r/kin"])])
        self.assertEqual(ops.inventory_valid(valid, "kin"), valid)
        mutations = [lambda x: x.update(server_major=17), lambda x: x["catalogs"].pop(),
                     lambda x: x["catalogs"].append("pg_future"), lambda x: x["records"][0]["attributes"].pop("acl"),
                     lambda x: x["records"][0]["attributes"].update(future_attribute=True),
                     lambda x: x["records"][0]["key"].__setitem__(2, "future-kind")]
        for mutate in mutations:
            value = copy.deepcopy(valid)
            mutate(value)
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                ops.inventory_valid(value, "kin")

    def test_outside_inventory_is_refused_before_capture_directory_or_dump(self):
        for kind in ("pg_largeobject", "pg_publication", "pg_event_trigger", "pg_foreign_table", "pg_partitioned_table"):
            with tempfile.TemporaryDirectory() as folder:
                host = FakeHost(folder)
                original = host.objects
                def objects(database):
                    value = original(database)
                    value["unsupported"] = [{"kind": kind, "count": 1}]
                    return value
                host.objects = objects
                with self.subTest(kind=kind), self.assertRaises(RuntimeError):
                    host.capture()
                self.assertFalse(host.parent.exists())
                self.assertFalse(any("pg_dump" in command for command in host.commands))

    def test_nologin_stored_verifier_refuses_admission(self):
        with tempfile.TemporaryDirectory() as folder:
            host = FakeHost(folder)
            host.extra_roles.append(role("legacy_reader", login=False))
            catalog = host.catalog()
            catalog["unsupported_verifiers"] = ["legacy_reader"]
            host.catalog = lambda container=None: catalog
            with self.assertRaises(RuntimeError):
                host.capture()
            self.assertFalse(host.parent.exists())

    def test_structured_keys_do_not_merge_quoted_dots_or_colons(self):
        one = object_row("kin", "column", "a.b")
        two = copy.deepcopy(one)
        two["key"][1], two["key"][3] = "public.a", "b"
        result = ops.inventory_valid(inventory("kin", [one, two]), "kin")
        self.assertEqual(len(result["records"]), 2)
        with self.assertRaises(RuntimeError):
            ops.inventory_valid(inventory("kin", [one, one]), "kin")
        a = ops.value_digest(("kin", "a.b", "table", "c:d", None), ["x"], [["same"]])
        b = ops.value_digest(("kin", "a", "table", "b.c:d", None), ["x"], [["same"]])
        self.assertNotEqual(a["key"], b["key"])

    def test_both_databases_all_schemas_and_values_remain_compared(self):
        rows = {("kin", "public", "r"): (["id", "json"], [["1", '{"x": 1}'], ["2", None]]),
                ("kin", "a.b", "r:c"): (["x"], [["a\nb"], [""]]),
                ("keycloak", "public", "client"): (["id", "secret", "other"], [["same", "secret", "preserve"]])}
        def tables(container, database, sql, user):
            return [[schema, table] for db, schema, table in rows if db == database]
        with patch.object(ops, "psql_json", side_effect=tables), patch.object(ops, "value_rows", side_effect=lambda c, d, s, t, u: rows[d, s, t]):
            before = ops.value_catalog("synthetic")
            rows["keycloak", "public", "client"][1][0][2] = "changed"
            after = ops.value_catalog("synthetic")
        self.assertEqual(intro.value_changes(before, after), {("keycloak", "public", "table", "client", None)})
        self.assertEqual(len(before["tables"]), 3)
        self.assertNotEqual(ops.value_digest(("x",), ["x"], [[None]]), ops.value_digest(("x",), ["x"], [[""]]))
        self.assertNotEqual(ops.value_digest(("x",), ["x"], [["a"], ["a"]]), ops.value_digest(("x",), ["x"], [["a"]]))

    def test_value_materialization_is_bounded_before_fetch(self):
        with patch.object(ops, "psql_json_stdin", side_effect=[["x"], [100001, 2]]) as query:
            with self.assertRaises(RuntimeError):
                ops.value_rows("synthetic", "kin", "public", "r")
            self.assertEqual(query.call_count, 2)

    def test_boundary_difference_and_unreadable_boundary_are_admission_refusals(self):
        with tempfile.TemporaryDirectory() as folder:
            catalog = FakeHost(folder).catalog()
        for row in catalog["databases"]:
            row["attributes"] = {"datallowconn": row["name"] != "template0"}
        fresh = copy.deepcopy(catalog)
        next(row for row in fresh["databases"] if row["name"] == "template0")["attributes"]["datallowconn"] = True
        facts = [{"catalog": "same"} for _ in range(9)] + [fresh]
        info = [{"Image": "sha256:" + "1" * 64, "Config": {"Env": ["POSTGRES_PASSWORD=synthetic-placeholder"]}}]
        with patch.object(ops, "text", return_value=json.dumps(info)), patch.object(ops, "psql_json", return_value=4096):
            for index in (0, 1, 2, 6, 7):
                bad = copy.deepcopy(facts)
                bad[index]["catalog"] = "unexpected object or value"
                with self.subTest(index=index), patch.object(ops, "temporary_run", return_value="\n".join(map(json.dumps, bad))), self.assertRaises(RuntimeError):
                    ops.boundary_proof("synthetic", catalog)
            with patch.object(ops, "temporary_run", return_value="\n".join(map(json.dumps, facts))):
                self.assertEqual(ops.boundary_proof("synthetic", catalog)["template0"], "private-physical-copy")
            multiline = "\n".join(json.dumps(row, indent=2) for row in facts)
            with patch.object(ops, "temporary_run", return_value=multiline):
                self.assertEqual(ops.boundary_proof("synthetic", catalog)["template0"], "private-physical-copy")
            for damaged in ("{}", multiline[:-1], multiline + "\ninvalid output"):
                with self.subTest(output=damaged[-30:]), patch.object(ops, "temporary_run", return_value=damaged), self.assertRaises(RuntimeError):
                    ops.boundary_proof("synthetic", catalog)


class CloneContracts(unittest.TestCase):
    def test_exact_rows_fields_and_other_realms_stay_compared(self):
        columns = ["id", "realm_id", "secret", "other"]
        before = [["a", "kin", "old", "kept"], ["b", "other-realm", "old", "kept"]]
        changed = intro.CloneFields()
        changed.change("client", columns, before[0], ["a", "kin", "new", "kept"])
        key = ("keycloak", "public", "table", "client", None)
        expected = changed.expected(key, columns, before)
        self.assertEqual(expected, [["a", "kin", "new", "kept"], before[1]])
        for row, column in ((0, 3), (1, 2), (1, 1)):
            actual = copy.deepcopy(expected)
            actual[row][column] = "unapproved"
            self.assertNotEqual(ops.value_digest(key, columns, expected), ops.value_digest(key, columns, actual))
        with self.assertRaises(intro.Stop):
            changed.expected(key, columns, before[1:])

    def test_origin_transform_is_a_prefix_boundary_not_substring_replacement(self):
        source, target = "https://source.invalid", "https://clone.invalid"
        for value, expected in ((source + "/auth", target + "/auth"), (source + "?x", target + "?x"),
                                (source + ".attacker.invalid", source + ".attacker.invalid"),
                                ("https://other.invalid/?next=" + source, "https://other.invalid/?next=" + source), (None, None)):
            self.assertEqual(intro.clone_origin(value, source, target), expected)

    def admin_fixture(self):
        uid, credential, attribute = "a" * 8 + "-" + "b" * 27, "c" * 8 + "-" + "d" * 27, "e" * 8 + "-" + "f" * 27
        rows = {"user_entity": {"id": uid, "username": "clone-admin", "realm_id": "master", "enabled": "true", "email_verified": "false",
            "not_before": "0", "created_timestamp": "100000", "last_modified_timestamp": "100000", "email_constraint": uid, "email": None,
            "federation_link": None, "first_name": None, "last_name": None, "service_account_client_link": None},
            "credential": {"id": credential, "user_id": uid, "type": "password", "created_date": "100000", "priority": "10", "version": "0",
                "salt": None, "user_label": None,
                "secret_data": json.dumps({"salt": "synthetic", "value": "synthetic-hash"}), "credential_data": json.dumps({"algorithm": "argon2"})},
            "user_attribute": {"id": attribute, "user_id": uid, "name": "is_temporary_admin", "value": "true",
                "long_value_hash": None, "long_value_hash_lower_case": None, "long_value": None}}
        before = {table: (list(row), []) for table, row in rows.items()}
        after = {table: (list(row), [list(row.values())]) for table, row in rows.items()}
        before["user_role_mapping"] = (["user_id", "role_id"], [])
        after["user_role_mapping"] = (["user_id", "role_id"], [[uid, "admin"], [uid, "default"]])
        return before, after

    def test_bootstrap_admin_has_one_new_owned_identity_and_keeps_residual_values(self):
        before, after = self.admin_fixture()
        args = dict(username="clone-admin", realm="master", role_ids=["admin", "default"], started_ms=99000, ended_ms=101000)
        try:
            uid, transform = intro.clone_admin_rows(before, after, **args)
        except intro.Stop as error:
            self.fail("Keycloak 26.7.3 bootstrap-admin rows were refused: " + str(error))
        self.assertTrue(uid)
        for table, (columns, rows) in after.items():
            self.assertEqual(transform(("keycloak", "public", "table", table, None), columns, rows), [])
        for table, field, value in (("user_entity", "realm_id", "other"), ("user_entity", "email", "unexpected@example.invalid"),
                                    ("credential", "user_id", "existing-user"), ("credential", "priority", "0"),
                                    ("credential", "priority", "11"), ("credential", "version", "1"),
                                    ("credential", "salt", "unexpected"), ("credential", "user_label", "unexpected"),
                                    ("user_attribute", "value", "false")):
            bad = copy.deepcopy(after)
            bad[table][1][0][bad[table][0].index(field)] = value
            with self.subTest(table=table, field=field), self.assertRaises(intro.Stop):
                intro.clone_admin_rows(before, bad, **args)


PROBE = {"study": "SYNTHETIC-restore-probe", "event_id": "12345678-1234-4123-8123-123456789abc", "institution": "kin-center",
         "approved_by": "commander", "approved_at": "2026-10-12T00:00:00Z"}
POSTGRES_IMAGE = "postgres:16-alpine"


@unittest.skipUnless(os.environ.get("KIN_TEST_API_IMAGE"), "a production API image in KIN_TEST_API_IMAGE is required")
class StateCopyRestoreContainerTests(unittest.TestCase):
    """EMR-B2 (c) positive v3 private restore (D1656-T07, C-O02) with the real image and real PostgreSQL."""

    PREFIX = os.environ.get("KIN_TEST_RESOURCE_PREFIX", "kin-rehearsal-")
    INSTANCE = "restore-synthetic-pair"
    API_IPC, RETENTION_IPC = "/run/kin-emr-api", "/run/kin-emr-retention"

    @classmethod
    def setUpClass(cls):
        cls.enterClassContext(ops.resource_names(cls.PREFIX))
        ops.require_local_docker()
        cls.image = os.environ["KIN_TEST_API_IMAGE"]
        cls.image_id = json.loads(ops.text(["docker", "image", "inspect", cls.image]))[0]["Id"]
        cls.token = uuid.uuid4().hex
        short = cls.token[:16]
        cls.names = {key: cls.PREFIX + short + "-" + key for key in
                     ("db", "state", "api-ipc", "retention-ipc", "service", "private-db", "private-state")}
        cls.reader_password = "Synthetic-Reader-" + uuid.uuid4().hex[:24]
        cls.runtime_password = "Synthetic-Runtime-" + uuid.uuid4().hex[:24]
        for kind, key in (("volume", "state"), ("volume", "api-ipc"), ("volume", "retention-ipc"), ("volume", "private-state"),
                          ("container", "service"), ("container", "db"), ("container", "private-db")):
            cls.addClassCleanup(ops.remove_owned_if_present, kind, cls.names[key], cls.token)
        cls.db = cls.start_postgres(cls.names["db"], "postgres", "kin")
        spec = importlib.util.spec_from_file_location("emr_compose", ROOT / "scripts" / "emr-compose.py")
        compose = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(compose)
        ops.run(["docker", "exec", "-u", "postgres", cls.db, "mkdir", "-m", "700", "/var/lib/postgresql/emr-access/ts"])
        provisioned = subprocess.run(["docker", "exec", "-i", "-e", "KIN_EMR_RUNTIME_PASSWORD=" + cls.runtime_password,
                                      "-e", "KIN_EMR_READER_PASSWORD=" + cls.reader_password, cls.db, "psql", "-X",
                                      "-U", "postgres", "-d", "kin"], input=compose.PROVISION_SQL.encode(), capture_output=True, timeout=120)
        if provisioned.returncode:
            raise RuntimeError("Provisioning failed")
        migrated = subprocess.run(["docker", "run", "--rm", "--network", "container:" + cls.db, "-e",
                                   "DATABASE_URL=postgresql://postgres@127.0.0.1:5432/kin", cls.image, "sh", "/app/start-production.sh",
                                   "migrate"], capture_output=True, timeout=300)
        if migrated.returncode:
            raise RuntimeError("Migration failed: " + migrated.stdout.decode(errors="replace")[-800:])
        for key in ("state", "api-ipc", "retention-ipc", "private-state"):
            ops.run(["docker", "volume", "create", "--label", "kin.ops.run=" + cls.token, cls.names[key]])
        # The source pair: the real service over the fresh pair, one synthetic event appended by a client, then closed.
        ops.run(["docker", "run", "-d", "--name", cls.names["service"], "--network", "container:" + cls.db,
                 "--label", "kin.ops.run=" + cls.token, "--user", "1000:1000", "--group-add", "2001", "--group-add", "2002",
                 "--stop-timeout", "20", "-e", "DATABASE_URL=postgresql://kin_emr_reader:" + cls.reader_password + "@127.0.0.1:5432/kin",
                 "-e", "KIN_EMR_STATE_DIR=" + ops.EMR_STATE, "-e", "KIN_EMR_INSTANCE_ID=" + cls.INSTANCE,
                 "-e", "KIN_EMR_API_SOCKET=" + cls.API_IPC + "/writer.sock", "-e", "KIN_EMR_RETENTION_SOCKET=" + cls.RETENTION_IPC + "/writer.sock",
                 "--mount", "type=volume,source=" + cls.names["state"] + ",target=" + ops.EMR_STATE,
                 "--mount", "type=volume,source=" + cls.names["api-ipc"] + ",target=" + cls.API_IPC,
                 "--mount", "type=volume,source=" + cls.names["retention-ipc"] + ",target=" + cls.RETENTION_IPC,
                 "--entrypoint", "sh", cls.image, "/app/start-production.sh", "state-serve-v3"])
        ops.wait_state_service(cls.names["service"], 0, timeout=120)
        event = probe.probe_event({**PROBE, "event_id": str(uuid.uuid4())})
        appended = subprocess.run(["docker", "run", "--rm", "--network", "container:" + cls.db, "--label", "kin.ops.run=" + cls.token,
                                   "--user", "1001:1001", "--group-add", "2001", "--read-only",
                                   "-e", "DATABASE_URL=postgresql://kin_runtime:" + cls.runtime_password + "@127.0.0.1:5432/kin",
                                   "-e", "KIN_EMR_INSTANCE_ID=" + cls.INSTANCE, "-e", "KIN_EMR_STATE_SOCKET=" + cls.API_IPC + "/writer.sock",
                                   "--mount", "type=volume,source=" + cls.names["api-ipc"] + ",target=" + cls.API_IPC + ",readonly",
                                   "--entrypoint", "node", cls.image, "-e", probe.PROBE_SCRIPT, "append", json.dumps({"event": event})],
                                  capture_output=True, timeout=180)
        if appended.returncode:
            raise RuntimeError("Synthetic append failed: " + appended.stdout.decode(errors="replace")[-800:] + appended.stderr.decode(errors="replace")[-800:])
        cls.appended = intro.result_line(appended.stdout)
        ops.run(["docker", "stop", "--time", "20", cls.names["service"]], timeout=120)
        ops.state_service_closed(cls.names["service"])
        # The capture: the closed state volume as the daily set archives it, the pair it carries, the database dumps.
        cls.temporary = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.directory = Path(cls.temporary.name) / "capture"
        cls.directory.mkdir(mode=0o700)
        with (cls.directory / "emr-state.tgz").open("wb") as handle:
            ops.temporary_run(["--network", "none", "--read-only", "--mount", "type=volume,source=" + cls.names["state"] + ",target=/source,readonly",
                               "--entrypoint", "tar", POSTGRES_IMAGE, "-czf", "-", "-C", "/source", "."], timeout=600, output=handle)
        with (cls.directory / "emr-state.tgz").open("rb") as handle:
            admitted = ops.admit_v3_archive(handle)
        cls.manifest = {"format": 1, "complete": True, "postgres_image": POSTGRES_IMAGE, "running_images": {"kin-api": {"id": cls.image_id}},
                        "sha256": {"emr-state.tgz": ops.digest(cls.directory / "emr-state.tgz")},
                        "emr": {"state_volume": cls.names["state"], "tablespace": "kin_emr_access", "same_pause": True, "format": 3,
                                "pair": {"instance_id": admitted["origin"]["instanceId"], "lineage": admitted["lineage"],
                                         "origin": admitted["origin"], "fingerprint": admitted["fingerprint"]}}}
        cls.source_bytes = (cls.directory / "emr-state.tgz").read_bytes()
        with (cls.directory / "roles.sql").open("wb") as handle:
            ops.run(["docker", "exec", cls.db, "pg_dumpall", "-U", "postgres", "--roles-only", "--no-role-passwords"], output=handle)
        with (cls.directory / "kin.dump").open("wb") as handle:
            ops.run(["docker", "exec", cls.db, "pg_dump", "-U", "postgres", "-d", "kin", "--encoding=UTF8", "-Fc"], output=handle)
        # The private database: another physical database (its own cluster, a later oid for kin), the source's roles,
        # tablespace and rows restored into it; bootstrap superuser kin as the product's clusters have.
        cls.private = cls.start_postgres(cls.names["private-db"], "kin", "kin_placeholder")
        with (cls.directory / "roles.sql").open("rb") as handle:
            ops.run(["docker", "exec", "-i", cls.private, "psql", "-X", "-U", "kin", "-d", "postgres", "-v", "ON_ERROR_STOP=0"], input_file=handle)
        ops.run(["docker", "exec", "-u", "postgres", cls.private, "mkdir", "-m", "700", "/var/lib/postgresql/emr-access/ts"])
        ops.run(["docker", "exec", cls.private, "psql", "-X", "-U", "kin", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c",
                 "CREATE TABLESPACE kin_emr_access OWNER kin_emr_owner LOCATION '/var/lib/postgresql/emr-access/ts'; CREATE DATABASE kin;"])
        with (cls.directory / "kin.dump").open("rb") as handle:
            ops.run(["docker", "exec", "-i", cls.private, "pg_restore", "-U", "kin", "-d", "kin", "--exit-on-error"], input_file=handle)

    @classmethod
    def start_postgres(cls, name, superuser, database):
        ops.run(["docker", "run", "-d", "--name", name, "--label", "kin.ops.run=" + cls.token, "--network", "none",
                 "--tmpfs", "/var/lib/postgresql/data", "--tmpfs", "/var/lib/postgresql/emr-access:uid=70,gid=70,mode=0700",
                 "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_USER=" + superuser, "-e", "POSTGRES_DB=" + database, POSTGRES_IMAGE])
        deadline = time.monotonic() + 60
        while ops.run(["docker", "exec", name, "pg_isready", "-h", "127.0.0.1", "-U", superuser], check=False).returncode:
            if time.monotonic() > deadline:
                raise RuntimeError("Disposable PostgreSQL did not start")
            time.sleep(0.5)
        return name

    def test_01_a_capture_bound_to_another_pair_is_refused_before_any_command(self):
        for label, change in (("another lineage", lambda m: m["emr"]["pair"].update(lineage=str(uuid.uuid4()))),
                              ("another origin database", lambda m: m["emr"]["pair"]["origin"]["database"].update(oid=1)),
                              ("another fingerprint", lambda m: m["emr"]["pair"].update(fingerprint="0" * 64))):
            with self.subTest(case=label):
                manifest = copy.deepcopy(self.manifest)
                change(manifest)
                with patch.object(ops, "run") as commands, patch.object(ops, "temporary_run") as helpers:
                    with self.assertRaises(RuntimeError):
                        ops.verify_v3_copy(self.directory, manifest, self.private, self.token, self.names["private-state"])
                    commands.assert_not_called()
                    helpers.assert_not_called()
        self.assertEqual((self.directory / "emr-state.tgz").read_bytes(), self.source_bytes)

    def test_02_the_private_copy_recovers_under_the_mapping_and_the_source_stays_unchanged(self):
        result = ops.verify_v3_copy(self.directory, self.manifest, self.private, self.token, self.names["private-state"])
        self.assertEqual(result["format"], 3)
        self.assertEqual(result["lineage"], self.manifest["emr"]["pair"]["lineage"])
        self.assertTrue(result["copy_mapping"], "the private database is another physical pair, so the mapping applied")
        self.assertTrue(result["ipc_ready"])
        self.assertTrue(result["second_owner_refused"])
        self.assertTrue(result["service_closed"])
        self.assertEqual(result["cleanup_failures"], [])
        self.assertEqual((self.directory / "emr-state.tgz").read_bytes(), self.source_bytes, "the source capture is never written")
        # The private copy is the captured chain: the appended synthetic event is sealed in it, at its captured tail.
        counted = ops.text(["docker", "exec", self.private, "psql", "-X", "-U", "kin", "-d", "kin", "-qAt", "-c",
                            "SELECT count(*) FROM emr_access.access_entry"])
        self.assertEqual(int(counted), int(ops.text(["docker", "exec", self.db, "psql", "-X", "-U", "postgres", "-d", "kin", "-qAt", "-c",
                                                      "SELECT count(*) FROM emr_access.access_entry"])))
        self.assertGreaterEqual(int(counted), 1)
        print(json.dumps({"v3_private_restore": True, "image": self.image, "result": result}), flush=True)


if __name__ == "__main__":
    unittest.main()
