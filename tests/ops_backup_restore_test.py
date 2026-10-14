"""C-RESTORE v1 admission and residual-value contracts. Docker cases live in ops_backup_held_test.

These tests supply catalog/row observations, never change product SQL to fit a parser or a test selector.
"""
import copy
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import ops_backup as ops
import ops_emr_introduction as intro
import ops_backup_held_test as held
from ops_backup_held_test import FakeHost, FakeCluster, catalog_globals, inventory, object_row, role


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


if __name__ == "__main__":
    unittest.main()
