"""INTERIM-RELEASE-TOOLS: the EMR-introduction release mode's contracts, without Docker or a host.

Plan/target/request/approval/receipt validation, the clone/target allowlist, the preflight additions (as functions of
observed facts), and the phase state machine with a synthetic operations object that records what it was asked to do
and answers with configured facts or faults. The real docker/compose operations of each step are exercised by the
synthetic Linux rehearsal (tests/ops_deploy_host_container_test.py EmrIntroductionRehearsal). Assertions bind to the
mode's contract (refusals, order, lock, durable state, rollback decisions), not to implementation text.
"""
from __future__ import annotations

import copy
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import ops_backup as ops
import ops_deploy_preflight as pre
import ops_emr_introduction as intro

NOW = datetime(2026, 10, 13, 1, 0, tzinfo=timezone.utc)
MIGRATIONS_BEFORE = [["0_init", "1" * 64], ["20260926130000_study_image_requests", "2" * 64]]
MIGRATIONS_AFTER = MIGRATIONS_BEFORE + [["20261007170000_member_db_rights", "3" * 64], [intro.EMR_MIGRATION, "4" * 64],
                                        ["20261010150000_emr_read_jit_off", "5" * 64]]


def image(char):
    return "sha256:" + char * 64


def production_identity():
    identity = copy.deepcopy(intro.EXAMPLE_POLICY["production"])
    identity["host_key_sha256"] = "a" * 64
    identity["origin"] = "https://pacs.example.invalid"
    return identity


def target_fixture(kind="production", repository="/srv/kin/repository"):
    if kind == "production":
        target = intro.example_target()
        target.update({key: copy.deepcopy(value) for key, value in production_identity().items()})
        target["repository"] = repository
        return target
    return {"schema": 1, "kind": "rehearsal", "host_key_sha256": "b" * 64, "origin": "https://localhost:19443",
            "project": "kin-rh-0001", "repository": repository,
            "compose_files": ["docker-compose.yml", "docker-compose.prod.yml", "/srv/kin/rehearsal-override.yml"],
            "containers": {"db": "kin-rh-0001-db", "api": "kin-rh-0001-api", "keycloak": "kin-rh-0001-keycloak",
                           "orthanc": "kin-rh-0001-orthanc", "proxy": "kin-rh-0001-proxy",
                           "emr-provision": "kin-rh-0001-emr-provision", "api-migrate": "kin-rh-0001-api-migrate"},
            "volumes": {"pg": "kin-rh-0001_pg-db", "orthanc": "kin-rh-0001_orthanc-db", "emr_access": "kin-rh-0001_emr-access",
                        "emr_state": "kin-rh-0001_emr-state"},
            "networks": {"default": "kin-rh-0001_default", "workflow": "kin-rh-0001-workflow"},
            "ports": {"maintenance": "127.0.0.1:19444:443", "public": ["127.0.0.1:19443:443"]},
            "tls_certificate": "/etc/nginx/certs/kin.crt", "cron": None, "ca_file": "/srv/kin/clone-ca.pem",
            "keycloak_admin": "kin-clone-admin"}


def plan_fixture(target=None, kind="production"):
    target = target or target_fixture(kind)
    plan = {"schema": 1, "mode": intro.MODE, "unit": "INTERIM-RELEASE", "target_kind": kind,
            "target_manifest_sha256": hashlib.sha256(intro.canonical(target)).hexdigest(),
            "previous": {"sha": "a" * 40, "images": {"api": image("1"), "proxy": image("2"), "db": image("3"),
                                                       "keycloak": image("4"), "orthanc": image("5")}},
            "release": {"sha": "b" * 40, "images": {"api": image("6"), "proxy": image("7"), "db": image("3"),
                                                      "keycloak": image("4"), "orthanc": image("5")}},
            "compose": {"before_sha256": "c" * 64, "after_sha256": "d" * 64},
            "secrets": {"required": ["POSTGRES_PASSWORD", "KIN_EMR_RUNTIME_PASSWORD", "KC_ADMIN_PASSWORD"],
                        "absent": ["KIN_EMR_READER_PASSWORD", "KIN_EMR_RETENTION_PASSWORD"],
                        "runtime": "KIN_EMR_RUNTIME_PASSWORD", "installer": "POSTGRES_PASSWORD",
                        "logins": {"kin_emr_reader": False, "kin_emr_retention": False}, "env_next_sha256": "e" * 64},
            "migrations": {"before": copy.deepcopy(MIGRATIONS_BEFORE), "after": copy.deepcopy(MIGRATIONS_AFTER)},
            "storage": {"tablespace_path": intro.TABLESPACE, "postgres_uid": 70, "postgres_gid": 70, "node_uid": 1000, "node_gid": 1000},
            "members": {"realm_members": 3, "disabled": 1, "service_accounts": 1},
            "smoke": {"frame": {"path": "/dicom-web/studies/1.2/series/1.3/instances/1.4/frames/1", "bytes": 64, "sha256": "f" * 64}},
            "probe": {"study": "SYNTHETIC-release-probe", "event_id": "12345678-1234-4123-8123-123456789abc",
                      "institution": "kin-center", "approved_by": "commander", "approved_at": "2026-10-12T00:00:00Z"},
            "window": {"start": "2026-10-13T00:00:00Z", "end": "2026-10-13T12:00:00Z"},
            "budget": {"capture_s": 3600, "introduce_s": 3600, "verify_s": 3600, "reopen_s": 1800, "rollback_s": 3600,
                       "seed_s": 3600, "min_free_bytes": 2 * 1024 ** 3},
            "backup_root": "/home/ubuntu/backups/kin-pacs", "tool": {name: "9" * 64 for name in intro.TOOL_FILES},
            "seed": None, "projection_exempt": []}
    if kind == "rehearsal":
        plan["seed"] = {"b0_dir": "/srv/kin/b0-copy/emr-b0-20261013T000000Z-0123abcd", "b0_manifest_sha256": "8" * 64}
        plan["smoke"]["frame"] = None
    return plan


def refuses(test, function, *args, message=None):
    with test.assertRaises(intro.Stop) as caught:
        function(*args)
    if message:
        test.assertIn(message, str(caught.exception))


class PlanTests(unittest.TestCase):
    def test_01_valid_plans_pass_and_bind_a_core(self):
        for kind in ("production", "rehearsal"):
            plan = plan_fixture(kind=kind)
            self.assertIs(intro.plan_valid(plan), plan)
        production, rehearsal = plan_fixture(), plan_fixture(kind="rehearsal")
        # Host specifics differ; the rehearsed release (images, history, storage, secret roles) is the same core.
        self.assertEqual(intro.plan_core(production), intro.plan_core(rehearsal))
        changed = plan_fixture()
        changed["migrations"]["after"][-1][1] = "0" * 64
        self.assertNotEqual(intro.plan_core(production), intro.plan_core(changed))

    def test_02_every_field_is_closed(self):
        for key in intro.PLAN_KEYS:
            plan = plan_fixture()
            del plan[key]
            with self.subTest(missing=key):
                refuses(self, intro.plan_valid, plan)
        plan = plan_fixture()
        plan["command"] = "sh"
        refuses(self, intro.plan_valid, plan)

    def test_03_migration_lists_are_names_and_checksums_in_prisma_order(self):
        cases = {
            "not a prefix": lambda m: m["after"].__setitem__(0, ["0_init", "0" * 64]),
            "unordered": lambda m: m["after"].reverse(),
            "duplicate": lambda m: m["after"].append(list(m["after"][-1])),
            "no emr introduction": lambda m: m["after"].pop(3),
            "already introduced": lambda m: m["before"].append([intro.EMR_MIGRATION, "4" * 64]),
            "bad checksum": lambda m: m["after"].__setitem__(2, ["20261007170000_member_db_rights", "XYZ"]),
            "bad name": lambda m: m["after"].__setitem__(2, ["../etc", "3" * 64]),
            "nothing to apply": lambda m: m.__setitem__("after", copy.deepcopy(m["before"])),
        }
        for name, change in cases.items():
            plan = plan_fixture()
            change(plan["migrations"])
            with self.subTest(case=name):
                refuses(self, intro.plan_valid, plan)

    def test_04_unchanged_images_secret_roles_and_storage(self):
        plan = plan_fixture()
        plan["release"]["images"]["db"] = image("8")
        refuses(self, intro.plan_valid, plan, message="stay as they are")
        plan = plan_fixture()
        plan["release"]["images"]["api"] = plan["previous"]["images"]["api"]
        refuses(self, intro.plan_valid, plan)
        plan = plan_fixture()
        plan["secrets"]["runtime"] = "POSTGRES_PASSWORD"
        refuses(self, intro.plan_valid, plan)
        plan = plan_fixture()
        plan["secrets"]["absent"].remove("KIN_EMR_READER_PASSWORD")
        refuses(self, intro.plan_valid, plan, message="Optional EMR login")
        plan = plan_fixture()
        plan["secrets"]["logins"]["kin_emr_retention"] = True
        refuses(self, intro.plan_valid, plan, message="Optional EMR login")
        plan = plan_fixture()
        plan["storage"]["tablespace_path"] = "/srv/other"
        refuses(self, intro.plan_valid, plan, message="fixed by the product")
        plan = plan_fixture()
        plan["storage"]["postgres_uid"] = 0
        refuses(self, intro.plan_valid, plan)

    def test_05_probe_window_budget_and_seed(self):
        plan = plan_fixture()
        plan["probe"]["study"] = "1.2.840.10008.patient"
        refuses(self, intro.plan_valid, plan, message="synthetic")
        plan = plan_fixture()
        plan["window"]["end"] = "2026-10-21T00:00:00Z"
        refuses(self, intro.plan_valid, plan, message="window")
        plan = plan_fixture()
        plan["window"]["start"] = "2026-10-13T00:00:00+09:00"
        refuses(self, intro.plan_valid, plan, message="UTC")
        plan = plan_fixture()
        plan["budget"]["introduce_s"] = 30
        refuses(self, intro.plan_valid, plan)
        plan = plan_fixture()
        plan["seed"] = {"b0_dir": "/x", "b0_manifest_sha256": "8" * 64}
        refuses(self, intro.plan_valid, plan, message="Only a rehearsal")
        plan = plan_fixture(kind="rehearsal")
        plan["seed"] = None
        refuses(self, intro.plan_valid, plan)
        plan = plan_fixture()
        plan["smoke"]["frame"] = None
        refuses(self, intro.plan_valid, plan, message="real frame")


class TargetAllowlistTests(unittest.TestCase):
    def test_06_targets_name_every_resource(self):
        for kind in ("production", "rehearsal"):
            intro.target_valid(target_fixture(kind))
        target = target_fixture("rehearsal")
        target["containers"]["api"] = target["containers"]["db"]
        refuses(self, intro.target_valid, target, message="distinct")
        target = target_fixture()
        target["ports"]["maintenance"] = "0.0.0.0:9444:443"
        refuses(self, intro.target_valid, target, message="loopback")
        target = target_fixture()
        target["compose_files"] = ["docker-compose.prod.yml", "docker-compose.yml"]
        refuses(self, intro.target_valid, target)
        target = target_fixture()
        target["compose_files"].append("/tmp/override.yml")
        refuses(self, intro.target_valid, target)
        target = target_fixture()
        target["ca_file"] = "/tmp/ca.pem"
        refuses(self, intro.target_valid, target, message="system trust")
        target = target_fixture()
        target["cron"] = None
        refuses(self, intro.target_valid, target, message="scheduled jobs")

    def test_07_production_requires_the_pinned_identity_on_the_pinned_host(self):
        production = production_identity()
        intro.check_target(target_fixture(), production, "production", "a" * 64)
        refuses(self, intro.check_target, target_fixture(), production, "production", "b" * 64, message="not the production host")
        for group, key, value in (("containers", "db", "kin-db-copy"), ("networks", "workflow", "other"), ("volumes", "pg", "x")):
            target = target_fixture()
            target[group][key] = value
            with self.subTest(group=group):
                refuses(self, intro.check_target, target, production, "production", "a" * 64, message="production identity")
        target = target_fixture()
        target["origin"] = "https://other.example.invalid"
        refuses(self, intro.check_target, target, production, "production", "a" * 64)
        refuses(self, intro.check_target, target_fixture(), production, "rehearsal", "a" * 64, message="kind")

    def test_08_a_rehearsal_refuses_every_production_name_address_and_host(self):
        production = production_identity()
        intro.check_target(target_fixture("rehearsal"), production, "rehearsal", "b" * 64)
        refuses(self, intro.check_target, target_fixture("rehearsal"), production, "rehearsal", "a" * 64, message="production host")
        refuses(self, intro.check_target, target_fixture("rehearsal"), production, "rehearsal", "c" * 64, message="another host")
        cases = [("containers", "db", "kin-db"), ("containers", "api-migrate", "kin-api-migrate"), ("volumes", "emr_state", "pacs-starter-kit_emr-state"),
                 ("networks", "workflow", "kin-workflow"), ("networks", "default", "pacs-starter-kit_default")]
        for group, key, value in cases:
            target = target_fixture("rehearsal")
            target[group][key] = value
            with self.subTest(name=value):
                refuses(self, intro.check_target, target, production, "rehearsal", "b" * 64, message="reuses a production")
        target = target_fixture("rehearsal")
        target["origin"] = "https://pacs.example.invalid:8443"
        refuses(self, intro.check_target, target, production, "rehearsal", "b" * 64, message="origin")
        target = target_fixture("rehearsal")
        target["project"] = "pacs-starter-kit"
        refuses(self, intro.check_target, target, production, "rehearsal", "b" * 64, message="project")

    def test_09_resolved_compose_model_must_assign_the_manifest_names(self):
        target = target_fixture("rehearsal")
        model = {"project": target["project"], "containers": {role: target["containers"][role] for role in intro.ROLES},
                 "volumes": {"pg-db": target["volumes"]["pg"], "orthanc-db": target["volumes"]["orthanc"]},
                 "networks": {"default": target["networks"]["default"], "workflow": target["networks"]["workflow"]}}
        intro.check_resolved(model, target, target_checkout=False)
        # The target checkout also names the one-shots and both EMR volumes.
        with self.assertRaises(intro.Stop):
            intro.check_resolved(model, target, target_checkout=True)
        full = copy.deepcopy(model)
        full["containers"].update({name: target["containers"][name] for name in intro.ONE_SHOTS})
        full["volumes"].update({"emr-access": target["volumes"]["emr_access"], "emr-state": target["volumes"]["emr_state"]})
        intro.check_resolved(full, target, target_checkout=True)
        for change in (lambda m: m["containers"].__setitem__("db", "kin-db"), lambda m: m["networks"].__setitem__("workflow", "kin-workflow"),
                       lambda m: m["volumes"].__setitem__("emr-state", "pacs-starter-kit_emr-state"), lambda m: m.__setitem__("project", "x")):
            bad = copy.deepcopy(full)
            change(bad)
            with self.assertRaises(intro.Stop):
                intro.check_resolved(bad, target, target_checkout=True)


class RequestApprovalReceiptTests(unittest.TestCase):
    def request(self, **changes):
        body = {"version": 1, "mode": intro.MODE, "phase": "capture", "plan_sha256": "a" * 64, "nonce": "0" * 32, **changes}
        return json.dumps(body).encode()

    def test_10_requests_are_closed_and_small(self):
        intro.request_valid(self.request())
        for raw in (self.request(phase="deploy"), self.request(nonce="short"), self.request(mode="api-only"),
                    self.request(extra=1), b'{"mode":"emr-introduction","mode":"x"}', b" " * 8193):
            with self.subTest(raw=raw[:40]), self.assertRaises((intro.Stop, RuntimeError, ValueError)):
                intro.request_valid(raw)
        self.assertTrue(intro.is_introduction(self.request()))
        self.assertFalse(intro.is_introduction(json.dumps({"version": 1, "previous_sha": "a" * 40}).encode()))
        self.assertFalse(intro.is_introduction(b"\xff"))

    def test_11_approval_binds_request_phase_evidence_and_expiry(self):
        now = 1_800_000_000
        good = {"schema": 1, "mode": intro.MODE, "request_sha256": "a" * 64, "expires_at": now + 600, "evidence": {"local-restore": "b" * 64}}
        intro.approval_valid(good, "a" * 64, "introduce", now)
        for change in ({"request_sha256": "c" * 64}, {"expires_at": now}, {"expires_at": now + 90000}, {"evidence": {}},
                       {"evidence": {"offsite-restore": "b" * 64}}, {"evidence": {"local-restore": "short"}}, {"mode": "api-only"}):
            with self.subTest(change=change):
                refuses(self, intro.approval_valid, {**good, **change}, "a" * 64, "introduce", now)
        intro.approval_valid({**good, "evidence": {}}, "a" * 64, "capture", now)
        refuses(self, intro.approval_valid, good, "a" * 64, "capture", now)
        # A rehearsal is the receipt's producer: its introduce carries no receipt; every reopen needs the operator smoke.
        intro.approval_valid({**good, "evidence": {}}, "a" * 64, "introduce", now, "rehearsal")
        intro.approval_valid({**good, "evidence": {"operator-smoke": "b" * 64}}, "a" * 64, "reopen", now, "rehearsal")

    def receipt(self, plan, **changes):
        phases = {name: {"status": "PASS", "seconds": 1.0, "request_sha256": "c" * 64}
                  for name in ("seed", "capture", "introduce", "verify", "rollback")}
        body = {"schema": 1, "kind": "local-restore", "passed": True, "plan_core_sha256": intro.plan_core(plan),
                "rehearsal_plan_sha256": "d" * 64, "source_b0_manifest_sha256": "8" * 64, "rehearsal_b0_manifest_sha256": "e" * 64,
                "rehearsal_b1_manifest_sha256": "f" * 64, "tool": plan["tool"], "host_key_sha256": "b" * 64, "phases": phases,
                "created_utc": "2026-10-13T00:00:00+00:00"}
        body.update(changes)
        return body

    def test_12_local_restore_receipt_replaces_offsite_only_for_the_same_release_and_snapshot(self):
        plan, production = plan_fixture(), production_identity()
        intro.receipt_valid(self.receipt(plan), plan, "8" * 64, production)
        cases = {"another snapshot": {"source_b0_manifest_sha256": "7" * 64}, "another release": {"plan_core_sha256": "0" * 64},
                 "production host": {"host_key_sha256": "a" * 64}, "offsite kind": {"kind": "offsite-restore"},
                 "not passed": {"passed": False}, "another tool": {"tool": {name: "1" * 64 for name in intro.TOOL_FILES}}}
        for name, change in cases.items():
            with self.subTest(case=name):
                refuses(self, intro.receipt_valid, self.receipt(plan, **change), plan, "8" * 64, production)
        missing = self.receipt(plan)
        del missing["phases"]["rollback"]
        refuses(self, intro.receipt_valid, missing, plan, "8" * 64, production, message="phases")

    def test_13_operator_smoke_record(self):
        good = {"schema": 1, "kind": "operator-smoke", "plan_sha256": "a" * 64, "checks": {name: True for name in intro.OPERATOR_SMOKE_CHECKS},
                "passed": True, "by": "executor", "at": "2026-10-13T02:00:00Z"}
        intro.operator_smoke_valid(good, "a" * 64)
        refuses(self, intro.operator_smoke_valid, good, "b" * 64)
        bad = copy.deepcopy(good)
        bad["checks"]["ohif_frame"] = False
        refuses(self, intro.operator_smoke_valid, bad, "a" * 64)
        bad = copy.deepcopy(good)
        del bad["checks"]["w2_shortcuts"]
        refuses(self, intro.operator_smoke_valid, bad, "a" * 64)


def baseline_observed(plan):
    return {"head": plan["previous"]["sha"], "dirty": False, "images": dict(plan["previous"]["images"]),
            "running": {role: True for role in intro.ROLES}, "restarting": {role: False for role in intro.ROLES},
            "migrations": [[name, checksum, True, False] for name, checksum in plan["migrations"]["before"]],
            "catalog": {"roles": [{"rolname": "kin"}], "schemas": ["public"], "tablespaces": [{"name": "pg_default"}]},
            "emr_volumes": [], "api_state_mounts": 0, "cron": "matched", "members": dict(plan["members"])}


def provisioned_catalog():
    roles = [{"rolname": name, "rolsuper": False, "rolcreaterole": False, "rolcreatedb": False, "rolreplication": False,
              "rolbypassrls": False, "rolcanlogin": name == "kin_runtime", "rolinherit": False} for name in pre.EMR_ROLES]
    roles.append({"rolname": "kin", "rolsuper": True, "rolcreaterole": True, "rolcreatedb": True, "rolreplication": True,
                  "rolbypassrls": True, "rolcanlogin": True, "rolinherit": True})
    return {"roles": roles, "memberships": [], "tablespaces": [{"name": "kin_emr_access", "owner": "kin_emr_owner", "location": intro.TABLESPACE}],
            "databases": [], "schemas": ["public"]}


def api_container(name="kin-api", state="pacs-starter-kit_emr-state"):
    return {"Name": "/" + name, "Image": image("6"), "State": {"Running": True},
            "Config": {"User": "node", "Labels": {"kin.deploy.release": "b" * 40, "com.docker.compose.project.working_dir": "/srv/kin/repository",
                                                  "com.docker.compose.service": "api"},
                       "Env": ["DEPLOYMENT_MODE=production", "AUTH_REQUIRED=true", "DATABASE_URL=postgresql://kin_runtime:x@db:5432/kin",
                               "KIN_EMR_STATE_DIR=" + pre.EMR_STATE]},
            "Mounts": [{"Type": "volume", "Name": state, "Destination": pre.EMR_STATE, "RW": True}],
            "NetworkSettings": {"Ports": {"3000/tcp": None}}, "HostConfig": {"NetworkMode": "x_default", "PortBindings": {}}}


class PreflightAdditionTests(unittest.TestCase):
    def test_14_migration_history_is_compared_by_name_and_checksum_not_count(self):
        rows = [[name, checksum, True, False] for name, checksum in MIGRATIONS_AFTER]
        pre.check_migration_rows(rows, MIGRATIONS_AFTER)
        same_count = copy.deepcopy(rows)
        same_count[2][0] = "20261007170001_other"
        for bad in (same_count, rows[:-1], rows + [["20261011120000_filter_shortcuts", "6" * 64, True, False]]):
            with self.assertRaises(RuntimeError):
                pre.check_migration_rows(bad, MIGRATIONS_AFTER)
        for index, value in ((1, "0" * 64),):
            bad = copy.deepcopy(rows)
            bad[3][index] = value
            with self.assertRaisesRegex(RuntimeError, "checksums"):
                pre.check_migration_rows(bad, MIGRATIONS_AFTER)
        for position, value in ((2, False), (3, True)):
            bad = copy.deepcopy(rows)
            bad[-1][position] = value
            with self.assertRaisesRegex(RuntimeError, "unfinished or rolled back"):
                pre.check_migration_rows(bad, MIGRATIONS_AFTER)

    def test_15_baseline_is_the_previous_release_without_emr_storage(self):
        plan = plan_fixture()
        pre.check_baseline(baseline_observed(plan), plan)
        cases = {"head": lambda o: o.__setitem__("head", "f" * 40), "dirty": lambda o: o.__setitem__("dirty", True),
                 "image": lambda o: o["images"].__setitem__("proxy", image("9")),
                 "stopped": lambda o: o["running"].__setitem__("orthanc", False),
                 "restarting": lambda o: o["restarting"].__setitem__("api", True),
                 "history": lambda o: o["migrations"].pop(),
                 "role": lambda o: o["catalog"]["roles"].append({"rolname": "kin_runtime"}),
                 "schema": lambda o: o["catalog"]["schemas"].append("emr_access"),
                 "later EMR schema": lambda o: o["catalog"]["schemas"].append("emr_clinical"),
                 "tablespace": lambda o: o["catalog"]["tablespaces"].append({"name": "kin_emr_access"}),
                 "volume": lambda o: o.__setitem__("emr_volumes", ["pacs-starter-kit_emr-state"]),
                 "mount": lambda o: o.__setitem__("api_state_mounts", 1), "cron": lambda o: o.__setitem__("cron", "mismatch"),
                 "members": lambda o: o["members"].__setitem__("realm_members", 4),
                 "disabled": lambda o: o["members"].__setitem__("disabled", 0),
                 "service accounts": lambda o: o["members"].__setitem__("service_accounts", 2)}
        for name, change in cases.items():
            observed = baseline_observed(plan)
            change(observed)
            with self.subTest(case=name), self.assertRaises(RuntimeError):
                pre.check_baseline(observed, plan)

    def test_16_write_freeze_covers_every_entry_point(self):
        good = {"running": {"db": True, "api": False, "keycloak": False, "orthanc": False, "proxy": False}, "db_clients": 0,
                "cron": "fenced", "one_shots": []}
        pre.check_write_freeze(good)
        for role in pre.WRITERS:
            bad = copy.deepcopy(good)
            bad["running"][role] = True
            with self.subTest(writer=role), self.assertRaisesRegex(RuntimeError, "writer"):
                pre.check_write_freeze(bad)
        for key, value in (("db_clients", 1), ("cron", "open"), ("one_shots", ["kin-api-migrate-x running"])):
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                pre.check_write_freeze({**good, key: value})
        bad = copy.deepcopy(good)
        bad["running"]["db"] = False
        with self.assertRaises(RuntimeError):
            pre.check_write_freeze(bad)

    def test_17_tablespace_directory_is_the_images_postgres_0700_and_empty(self):
        storage = plan_fixture()["storage"]
        good = {"path": intro.TABLESPACE, "type": "directory", "uid": 70, "gid": 70, "mode": "700", "entries": 0}
        pre.check_tablespace_directory(good, storage, fresh=True)
        for key, value, message in (("uid", 999, "owner"), ("gid", 0, "owner"), ("mode", "755", "0700"), ("entries", 1, "empty"),
                                    ("type", "regular file", "path"), ("path", "/var/lib/other", "path")):
            with self.subTest(key=key), self.assertRaisesRegex(RuntimeError, message):
                pre.check_tablespace_directory({**good, key: value}, storage, fresh=True)
        # An existing tablespace keeps its content; it is never emptied to pass.
        pre.check_tablespace_directory({**good, "entries": 3}, storage, fresh=False)

    def test_18_secret_names_form_and_separation(self):
        secrets = plan_fixture()["secrets"]
        env = {"POSTGRES_PASSWORD": "i" * 30, "KIN_EMR_RUNTIME_PASSWORD": "r" * 43, "KC_ADMIN_PASSWORD": "k"}
        pre.check_env_secrets(env, secrets)
        for change, message in (({"KIN_EMR_RUNTIME_PASSWORD": "short"}, "form"), ({"KIN_EMR_RUNTIME_PASSWORD": "has space " * 4}, "form"),
                                ({"KIN_EMR_RUNTIME_PASSWORD": "i" * 30}, "installer"), ({"KIN_EMR_READER_PASSWORD": "x" * 30}, "unset"),
                                ({"KC_ADMIN_PASSWORD": ""}, "missing")):
            with self.subTest(change=list(change)), self.assertRaisesRegex(RuntimeError, message) as caught:
                pre.check_env_secrets({**env, **change}, secrets)
            self.assertNotIn("i" * 30, str(caught.exception))

    def test_19_provisioned_roles_are_least_privilege_and_the_tablespace_is_exact(self):
        storage, logins = plan_fixture()["storage"], {"kin_emr_owner": False, "kin_runtime": True, "kin_emr_reader": False, "kin_emr_retention": False}
        pre.check_provisioned(provisioned_catalog(), storage, logins)
        for name in pre.EMR_ROLES:
            for attribute in pre.ELEVATED:
                catalog = provisioned_catalog()
                next(role for role in catalog["roles"] if role["rolname"] == name)[attribute] = True
                with self.subTest(role=name, attribute=attribute), self.assertRaisesRegex(RuntimeError, "elevated"):
                    pre.check_provisioned(catalog, storage, logins)
        catalog = provisioned_catalog()
        catalog["memberships"].append({"granted": "pg_read_all_data", "member": "kin_runtime"})
        with self.assertRaisesRegex(RuntimeError, "membership"):
            pre.check_provisioned(catalog, storage, logins)
        catalog = provisioned_catalog()
        next(role for role in catalog["roles"] if role["rolname"] == "kin_emr_owner")["rolcanlogin"] = True
        with self.assertRaisesRegex(RuntimeError, "login"):
            pre.check_provisioned(catalog, storage, logins)
        for change in ({"owner": "kin_runtime"}, {"location": "/var/lib/postgresql/data/ts"}):
            catalog = provisioned_catalog()
            catalog["tablespaces"][0].update(change)
            with self.assertRaisesRegex(RuntimeError, "tablespace"):
                pre.check_provisioned(catalog, storage, logins)

    def test_20_ledger_placement_and_existing_rows(self):
        catalog = {"schema": {"owner": "kin_emr_owner"}, "tablespace": {"owner": "kin_emr_owner"},
                   "tables": [{"name": "access_entry", "owner": "kin_emr_owner", "tablespace": "kin_emr_access"}],
                   "functions": [{"signature": "f()", "owner": "kin_emr_owner"}]}
        pre.check_emr_catalog(catalog)
        for change in (lambda c: c["tables"][0].__setitem__("tablespace", None), lambda c: c["tables"][0].__setitem__("owner", "kin_runtime"),
                       lambda c: c["functions"][0].__setitem__("owner", "kin"), lambda c: c["schema"].__setitem__("owner", "kin")):
            bad = copy.deepcopy(catalog)
            change(bad)
            with self.assertRaises(RuntimeError):
                pre.check_emr_catalog(bad)
        before = {"Report": {"columns": ["id"], "count": 2, "sha256": "a" * 64}}
        pre.check_projection_preserved(before, {**before, "NewTable": {"columns": ["id"], "count": 0, "sha256": "b" * 64}})
        with self.assertRaisesRegex(RuntimeError, "Existing rows changed: Report"):
            pre.check_projection_preserved(before, {"Report": {"columns": ["id"], "count": 2, "sha256": "c" * 64}})
        with self.assertRaisesRegex(RuntimeError, "disappeared"):
            pre.check_projection_preserved(before, {})

    def test_55_provision_first_refuses_a_database_migrated_before_it_was_provisioned(self):
        """DR2-09: emr-compose's PROVISION_SQL does not move existing TOAST storage or later EMR schemas into the
        tablespace, so the mode refuses that shape instead of repairing it."""
        plan = plan_fixture()
        clean = {"roles": [{"rolname": "kin"}], "schemas": ["public"], "tablespaces": [{"name": "pg_default"}]}
        before = [[name, checksum, True, False] for name, checksum in plan["migrations"]["before"]]
        pre.check_provision_first(clean, before, plan)
        migrated = before + [[intro.EMR_MIGRATION, "4" * 64, True, False]]
        with self.assertRaisesRegex(RuntimeError, "differ"):
            pre.check_provision_first(clean, migrated, plan)
        for change in (lambda c: c["roles"].append({"rolname": "kin_emr_owner"}), lambda c: c["schemas"].append("emr_access"),
                       lambda c: c["schemas"].append("emr_clinical"), lambda c: c["tablespaces"].append({"name": "kin_emr_access"})):
            catalog = copy.deepcopy(clean)
            change(catalog)
            with self.assertRaisesRegex(RuntimeError, "migrated before provisioned"):
                pre.check_provision_first(catalog, before, plan)

    def test_56_every_emr_relation_and_its_toast_storage_is_in_the_tablespace(self):
        rows = [{"relation": "emr_access.access_entry", "tablespace": "kin_emr_access"},
                {"relation": "emr_access.access_entry:toast", "tablespace": "kin_emr_access"},
                {"relation": "emr_access.access_entry:toast-index", "tablespace": "kin_emr_access"}]
        pre.check_placement(rows)
        for index in range(len(rows)):
            bad = copy.deepcopy(rows)
            bad[index]["tablespace"] = "database-default"
            with self.subTest(relation=bad[index]["relation"]), self.assertRaisesRegex(RuntimeError, bad[index]["relation"]):
                pre.check_placement(bad)
        bad = rows + [{"relation": "emr_clinical.sr_purpose_end:toast", "tablespace": "database-default"}]
        with self.assertRaisesRegex(RuntimeError, "emr_clinical"):
            pre.check_placement(bad)
        for empty in ([], None):
            with self.assertRaises(RuntimeError):
                pre.check_placement(empty)

    def test_57_member_expectation_is_part_of_the_plan(self):
        plan = plan_fixture()
        for change in ({"disabled": 4}, {"realm_members": -1}, {"service_accounts": "1"}):
            bad = copy.deepcopy(plan)
            bad["members"].update(change)
            with self.subTest(change=change):
                refuses(self, intro.plan_valid, bad)
        changed = copy.deepcopy(plan)
        changed["members"]["realm_members"] = 4
        self.assertNotEqual(intro.plan_core(plan), intro.plan_core(changed))
        pre.check_member_counts(dict(plan["members"]), plan["members"])
        with self.assertRaisesRegex(RuntimeError, "Realm members differ"):
            pre.check_member_counts({**plan["members"], "disabled": 0}, plan["members"])

    def test_21_introduced_api_runs_as_node_with_runtime_role_and_one_state_volume(self):
        arguments = {"name": "kin-api", "image": image("6"), "release": "b" * 40, "working_dir": "/srv/kin/repository",
                     "state_volume": "pacs-starter-kit_emr-state"}
        pre.check_introduced_api(api_container(), **arguments)
        mounts = api_container()["Mounts"][0]
        cases = {"user": lambda c: c["Config"].__setitem__("User", "root"),
                 "two mounts": lambda c: c.__setitem__("Mounts", [mounts, {**mounts, "Name": "other", "Destination": "/evidence"}]),
                 "bind": lambda c: c["Mounts"][0].__setitem__("Type", "bind"), "read-only": lambda c: c["Mounts"][0].__setitem__("RW", False),
                 "other volume": lambda c: c["Mounts"][0].__setitem__("Name", "kin-rh_emr-state"),
                 "port": lambda c: c["NetworkSettings"].__setitem__("Ports", {"3000/tcp": [{"HostPort": "3000"}]}),
                 "privileged": lambda c: c["HostConfig"].__setitem__("Privileged", True),
                 "installer url": lambda c: c["Config"]["Env"].__setitem__(2, "DATABASE_URL=postgresql://kin:x@db:5432/kin"),
                 "installer secret": lambda c: c["Config"]["Env"].append("POSTGRES_PASSWORD=x"),
                 "reader secret": lambda c: c["Config"]["Env"].append("KIN_EMR_READER_PASSWORD=x"),
                 "auth off": lambda c: c["Config"]["Env"].__setitem__(1, "AUTH_REQUIRED=false"),
                 "release label": lambda c: c["Config"]["Labels"].__setitem__("kin.deploy.release", "a" * 40),
                 "name": lambda c: c.__setitem__("Name", "/kin-api-copy")}
        for name, change in cases.items():
            container = api_container()
            change(container)
            with self.subTest(case=name), self.assertRaises(RuntimeError):
                pre.check_introduced_api(container, **arguments)

    def test_22_state_volume_keycloak_and_proxy(self):
        storage = plan_fixture()["storage"]
        pre.check_state_volume({"uid": 1000, "gid": 1000, "mode": "700", "writable": True}, storage)
        for change in ({"uid": 0}, {"mode": "777"}, {"writable": False}):
            with self.assertRaises(RuntimeError):
                pre.check_state_volume({"uid": 1000, "gid": 1000, "mode": "700", "writable": True, **change}, storage)
        pre.check_keycloak_serverinfo({"useCaches": "false", "persistentUserSessions": True})
        for selected in ({"useCaches": "true", "persistentUserSessions": True}, {"useCaches": None, "persistentUserSessions": True},
                         {"useCaches": "false", "persistentUserSessions": False}, {"useCaches": "false", "persistentUserSessions": None}):
            with self.assertRaises(RuntimeError):
                pre.check_keycloak_serverinfo(selected)
        good = {"image": image("7"), "running": True, "nginx_test": 0, "certificate_valid_days": True}
        pre.check_proxy(good, image("7"))
        for change in ({"image": image("2")}, {"nginx_test": 1}, {"certificate_valid_days": False}, {"running": False}):
            with self.assertRaises(RuntimeError):
                pre.check_proxy({**good, **change}, image("7"))

    def member_observed(self):
        roster = [{"id": "u1", "username": "doctor", "enabled": True, "groups": ["hallym"], "roles": ["radiologist"]},
                  {"id": "u2", "username": "pending", "enabled": True, "groups": [], "roles": []},
                  {"id": "u3", "username": "legacy", "enabled": False, "groups": ["hallym"], "roles": ["technician"]}]
        rights = [{"sub": "u1", "username": "doctor", "approved": True, "suspended": False, "institution": "hallym", "roles": ["radiologist"]},
                  {"sub": "u2", "username": "pending", "approved": False, "suspended": False, "institution": None, "roles": []},
                  {"sub": "u3", "username": "legacy", "approved": True, "suspended": True, "institution": "hallym", "roles": ["technician"]}]
        after = copy.deepcopy(roster)
        after[2]["enabled"] = True
        return {"markers": ["realm-v1"], "state": "ready", "roster_before": roster, "rights": rights,
                "legacy_enable": [{"sub": "u3", "state": "done"}], "roster_after": after}

    def test_23_member_import_is_verified_per_member_and_per_publication(self):
        pre.check_member_import(self.member_observed())
        cases = {"no marker": lambda o: o.__setitem__("markers", []), "pending": lambda o: o.__setitem__("state", "pending"),
                 "member missing": lambda o: o["rights"].pop(0), "unknown member": lambda o: o["rights"].append({**o["rights"][0], "sub": "u9"}),
                 "duplicate row": lambda o: o["rights"].append(dict(o["rights"][0])),
                 "institution": lambda o: o["rights"][0].__setitem__("institution", "kin-center"),
                 "role escalation": lambda o: o["rights"][0].__setitem__("roles", ["radiologist", "admin"]),
                 "unapproved rights": lambda o: o["rights"][1].__setitem__("roles", ["admin"]),
                 "disabled active": lambda o: o["rights"][2].__setitem__("suspended", False),
                 "publication unknown": lambda o: o["legacy_enable"][0].__setitem__("state", "unknown"),
                 "publication missing": lambda o: o.__setitem__("legacy_enable", []),
                 "realm not enabled": lambda o: o["roster_after"][2].__setitem__("enabled", False),
                 "identity": lambda o: o["rights"][0].__setitem__("username", "someone")}
        for name, change in cases.items():
            observed = self.member_observed()
            change(observed)
            with self.subTest(case=name), self.assertRaises(RuntimeError):
                pre.check_member_import(observed)


class FakeOps:
    """Answers each step with {} (or a configured fault) and does what the real step records in the durable state."""

    def __init__(self):
        self.calls = []
        self.faults = {}
        self.alive = []

    def __getattr__(self, name):
        if name not in {step[1] for steps in intro.STEPS.values() for step in steps} | {"revert_configuration"}:
            raise AttributeError(name)

        def step(context):
            self.calls.append(name)
            fault = self.faults.get(name)
            if isinstance(fault, BaseException):
                raise fault
            effect = getattr(self, "effect_" + name, None)
            return effect(context) if effect else {}
        return step

    def one_shots_alive(self, context):
        self.calls.append("one_shots_alive")
        return list(self.alive)

    def snapshot(self, context):
        return {"db_changed": context.state["db_changed"], "checkout": context.state["checkout"]}

    def effect_fence(self, context):
        context.state["fenced"] = {"running_before": list(pre.WRITERS)}

    def effect_capture_b0(self, context):
        context.state["b0"] = {"dir": "/backups/emr-b0", "manifest_sha256": "8" * 64}

    def effect_capture_b1(self, context):
        context.state["b1"] = {"dir": "/backups/emr-b1", "manifest_sha256": "7" * 64}

    def effect_storage(self, context):
        context.state["checkout"] = "target"

    def effect_seed_restore(self, context):
        context.state["seed"] = {"source_manifest_sha256": "8" * 64}

    def effect_restore_b0(self, context):
        context.state["recovery"] = {"pg": "pg-recovery", "orthanc": "orthanc-recovery", "override_sha256": "6" * 64}

    def effect_write_receipt(self, context):
        context.state["receipt"] = {"sha256": intro.sha256_bytes(intro.canonical(intro.make_receipt(context)))}


class Clock:
    def __init__(self):
        self.value = 0.0

    def __call__(self):
        return self.value


class StateMachineTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        self.repository = self.root / "repository"
        self.repository.mkdir()
        self.records = intro.Records(self.root / "records")
        self.ops = FakeOps()
        self.clock = Clock()
        self.kind = "production"
        self.receipt = None

    def machine(self, phase_evidence=None):
        target = target_fixture(self.kind, repository=str(self.repository))
        plan = plan_fixture(target, kind=self.kind)
        self.plan_sha256 = "a" * 64
        host_key = "a" * 64 if self.kind == "production" else "b" * 64
        evidence = phase_evidence if phase_evidence is not None else {}
        return intro.Introduction(plan=plan, plan_sha256=self.plan_sha256, target=target, production=production_identity(),
                                  ops=self.ops, records=self.records, repository=self.repository, host_key=host_key,
                                  tool=plan["tool"], evidence=evidence, clock=self.clock, now=lambda: NOW)

    def run_phase(self, phase, evidence=None):
        machine = self.machine(evidence)
        request = {"version": 1, "mode": intro.MODE, "phase": phase, "plan_sha256": self.plan_sha256, "nonce": os.urandom(16).hex()}
        return machine.run(request, hashlib.sha256(json.dumps(request).encode()).hexdigest())

    def local_restore(self):
        plan = plan_fixture()
        phases = {name: {"status": "PASS", "seconds": 1.0, "request_sha256": "c" * 64} for name in ("seed", "capture", "introduce", "verify", "rollback")}
        return {"local-restore": {"schema": 1, "kind": "local-restore", "passed": True, "plan_core_sha256": intro.plan_core(plan),
                                  "rehearsal_plan_sha256": "d" * 64, "source_b0_manifest_sha256": "8" * 64,
                                  "rehearsal_b0_manifest_sha256": "e" * 64, "rehearsal_b1_manifest_sha256": "f" * 64,
                                  "tool": plan["tool"], "host_key_sha256": "b" * 64, "phases": phases, "created_utc": NOW.isoformat()}}

    def operator_smoke(self):
        return {"operator-smoke": {"schema": 1, "kind": "operator-smoke", "plan_sha256": "a" * 64,
                                   "checks": {name: True for name in intro.OPERATOR_SMOKE_CHECKS}, "passed": True, "by": "executor",
                                   "at": NOW.isoformat()}}

    def lock_held(self):
        return (self.repository / ".kin-ops.lock").exists()

    def deploy_through(self, last):
        order = ["capture", "introduce", "verify", "reopen"]
        evidence = {"introduce": self.local_restore(), "reopen": self.operator_smoke()}
        results = {}
        for phase in order[:order.index(last) + 1]:
            results[phase] = self.run_phase(phase, evidence.get(phase))
        return results

    def test_24_full_release_order_lock_and_point_of_no_return(self):
        results = self.deploy_through("reopen")
        self.assertEqual([results[p]["status"] for p in results], ["HELD", "INTRODUCED", "VERIFIED", "DEPLOYED"])
        self.assertTrue(all(results[p]["phase_passed"] for p in results))
        self.assertEqual(self.ops.calls, [name for phase in ("capture", "introduce", "verify", "reopen") for _, name, _, _ in intro.STEPS[phase]])
        self.assertTrue(results["capture"]["lock_retained"] and results["verify"]["lock_retained"])
        self.assertFalse(self.lock_held())
        state = self.records.state()
        self.assertEqual(state["status"], "DEPLOYED")
        self.assertEqual(state["ponr"]["step"], "L-11c")
        journal = [json.loads(line) for line in (self.records.directory / "journal.jsonl").read_text().splitlines()]
        ponr_record = [entry for entry in journal if entry.get("step") == "L-11c" and entry["event"] == "step-start"]
        self.assertEqual(len(ponr_record), 1)

    def test_25_phases_follow_each_other_only(self):
        for phase in ("introduce", "verify", "reopen", "rollback", "release"):
            with self.subTest(phase=phase), self.assertRaisesRegex(intro.Stop, "cannot follow NEW"):
                self.run_phase(phase, self.local_restore() if phase == "introduce" else self.operator_smoke() if phase == "reopen" else {})
        self.assertEqual(self.ops.calls, [])
        refuses(self, self.run_phase, "seed", message="only on a rehearsal target")
        refuses(self, self.run_phase, "receipt", message="cannot follow NEW")
        self.assertFalse(self.lock_held())

    def test_26_introduce_requires_the_local_restore_receipt_of_this_b0(self):
        self.run_phase("capture")
        refuses(self, self.run_phase, "introduce", {}, message="Local-restore receipt required")
        evidence = self.local_restore()
        evidence["local-restore"]["source_b0_manifest_sha256"] = "1" * 64
        refuses(self, self.run_phase, "introduce", evidence, message="another B0")
        self.assertNotIn("recheck_fence", self.ops.calls)
        self.assertTrue(self.lock_held())

    def test_27_baseline_refusal_changes_nothing_and_frees_the_lock(self):
        self.ops.faults["baseline"] = RuntimeError("Running service images differ from the previous release")
        result = self.run_phase("capture")
        self.assertEqual((result["status"], result["phase_passed"]), ("NEW", False))
        self.assertEqual(self.ops.calls, ["baseline"])
        self.assertFalse(self.lock_held())
        self.assertEqual(result["steps"][-1]["code"], "Running service images differ from the previous release")

    def test_28_failed_capture_keeps_writers_fenced_and_the_lock(self):
        self.ops.faults["capture_b0"] = RuntimeError("Insufficient free space for the capture and its restore margin")
        result = self.run_phase("capture")
        self.assertEqual(result["status"], "CAPTURE_FAILED")
        self.assertNotIn("unfence", self.ops.calls)
        self.assertTrue(self.lock_held())
        release = self.run_phase("release")
        self.assertEqual(release["status"], "RELEASED")
        self.assertEqual(self.ops.calls[-2:], ["unfence", "public_check_previous"])
        self.assertFalse(self.lock_held())

    def test_29_settled_failure_before_any_database_change_reverts_configuration_only(self):
        self.run_phase("capture")
        self.ops.faults["storage"] = RuntimeError("Tablespace directory owner differs")
        result = self.run_phase("introduce", self.local_restore())
        self.assertEqual(result["status"], "HELD")
        self.assertEqual(self.ops.calls[-2:], ["storage", "revert_configuration"])
        self.assertNotIn("restore_b0", self.ops.calls)
        self.assertFalse(self.records.state()["db_changed"])
        self.assertTrue(self.lock_held())

    def test_30_settled_failure_after_the_first_database_change_rolls_back_automatically(self):
        self.run_phase("capture")
        self.ops.faults["migrate"] = RuntimeError("Installer migration failed")
        result = self.run_phase("introduce", self.local_restore())
        self.assertEqual((result["status"], result["phase_passed"], result["rollback"]), ("ROLLED_BACK", False, "completed"))
        rollback = [name for _, name, _, _ in intro.STEPS["rollback"]]
        self.assertEqual(self.ops.calls[-len(rollback) - 1:], ["one_shots_alive", *rollback])
        self.assertTrue(self.records.state()["rollback_attempted"])
        self.assertFalse(self.lock_held())
        refuses(self, self.run_phase, "rollback", message="cannot follow ROLLED_BACK")

    def test_31_no_automatic_rollback_while_a_migration_worker_may_be_alive(self):
        self.run_phase("capture")
        self.ops.faults["migrate"] = RuntimeError("Installer migration failed")
        self.ops.alive = ["kin-api-migrate-1 running"]
        result = self.run_phase("introduce", self.local_restore())
        self.assertEqual(result["status"], "NEEDS_ATTENTION")
        self.assertIn("alive", result["rollback"])
        self.assertNotIn("classify", self.ops.calls)
        self.assertTrue(self.lock_held())
        # An explicit rollback re-observes; the real RB-00 refuses while a worker exists (tested on the host).
        self.ops.alive = []
        self.ops.faults.clear()
        self.assertEqual(self.run_phase("rollback")["status"], "ROLLED_BACK")

    def test_32_unknown_end_never_rolls_back(self):
        self.run_phase("capture")
        self.ops.faults["migrate"] = intro.Unknown("api-migrate worker is still running")
        result = self.run_phase("introduce", self.local_restore())
        self.assertEqual(result["status"], "NEEDS_ATTENTION")
        self.assertNotIn("one_shots_alive", self.ops.calls)
        self.assertNotIn("classify", self.ops.calls)
        self.assertTrue(self.lock_held())
        self.assertEqual(result["steps"][-1]["outcome"], "UNKNOWN")

    def test_33_budget_exceeded_stops_before_the_mutation(self):
        self.run_phase("capture")
        original = self.ops.effect_storage

        def slow(context):
            self.clock.value += 4000
            return original(context)
        self.ops.effect_storage = slow
        result = self.run_phase("introduce", self.local_restore())
        self.assertIn("Phase budget exceeded", [step.get("code") for step in result["steps"]])
        self.assertNotIn("provision", self.ops.calls)
        # Nothing in the database changed: the revert still runs although the forward budget is spent.
        self.assertEqual((result["status"], self.ops.calls[-1]), ("HELD", "revert_configuration"))

    def test_34_window_closed_refuses_forward_steps_but_never_recovery(self):
        self.run_phase("capture")
        late = datetime(2026, 10, 13, 13, 0, tzinfo=timezone.utc)
        machine = self.machine(self.local_restore())
        machine.now = lambda: late
        request = {"version": 1, "mode": intro.MODE, "phase": "introduce", "plan_sha256": self.plan_sha256, "nonce": "1" * 32}
        result = machine.run(request, "b" * 64)
        # Forward: the first mutating step after the window is refused; nothing in the database changed, so revert only.
        self.assertEqual(result["status"], "HELD")
        self.assertNotIn("storage", self.ops.calls)
        self.assertEqual(result["steps"][1]["code"], "Outside the approved window")
        self.assertEqual(self.ops.calls[-1], "revert_configuration")

    def test_35_reopen_requires_operator_smoke_and_rollback_is_refused_after_the_point_of_no_return(self):
        self.deploy_through("verify")
        refuses(self, self.run_phase, "reopen", {}, message="Operator smoke record required")
        self.ops.faults["public_smoke"] = RuntimeError("Frame bytes differ")
        result = self.run_phase("reopen", self.operator_smoke())
        self.assertEqual(result["status"], "NEEDS_ATTENTION")
        self.assertIsNotNone(result["ponr"])
        refuses(self, self.run_phase, "rollback", message="Ingress was reopened")

    def test_36_reopen_failure_before_ingress_keeps_the_verified_release_fenced(self):
        self.deploy_through("verify")
        self.ops.faults["restore_jobs"] = RuntimeError("Scheduled jobs were not restored exactly")
        result = self.run_phase("reopen", self.operator_smoke())
        self.assertEqual((result["status"], result["ponr"]), ("VERIFIED", None))
        self.assertNotIn("reopen_ingress", self.ops.calls)
        self.assertTrue(self.lock_held())
        self.assertEqual(self.run_phase("rollback")["status"], "ROLLED_BACK")

    def test_37_failed_rollback_is_never_retried(self):
        self.deploy_through("verify")
        self.ops.faults["restore_b0"] = RuntimeError("Restored row counts differ: kin")
        result = self.run_phase("rollback")
        self.assertEqual(result["status"], "NEEDS_ATTENTION")
        self.assertTrue(self.lock_held())
        refuses(self, self.run_phase, "rollback", message="already attempted")

    def test_58_a_classification_refusal_leaves_the_single_rollback_unused(self):
        self.deploy_through("introduce")
        self.ops.faults["classify"] = RuntimeError("A one-shot worker may still be alive; observe only")
        result = self.run_phase("rollback")
        self.assertEqual(result["status"], "NEEDS_ATTENTION")
        self.assertIn("RB-00", result["rollback"])
        self.assertNotIn("preserve_failed", self.ops.calls)
        self.assertFalse(self.records.state()["rollback_attempted"])
        self.assertTrue(self.lock_held())
        # Once the worker has ended, the rollback runs (once).
        self.ops.faults.clear()
        self.assertEqual(self.run_phase("rollback")["status"], "ROLLED_BACK")
        self.assertTrue(self.records.state()["rollback_attempted"])

    def test_38_verify_failure_rolls_back_from_the_held_b0(self):
        self.deploy_through("introduce")
        self.ops.faults["probe"] = RuntimeError("The replay added a ledger entry")
        result = self.run_phase("verify")
        self.assertEqual(result["status"], "ROLLED_BACK")
        self.assertIn("preserve_failed", self.ops.calls)
        self.assertLess(self.ops.calls.index("preserve_failed"), self.ops.calls.index("restore_b0"))

    def test_39_a_competing_lock_refuses_before_any_step(self):
        (self.repository / ".kin-ops.lock").write_text("backup-in-progress")
        refuses(self, self.run_phase, "capture", message="held by another operation")
        self.assertEqual(self.ops.calls, [])
        self.assertEqual((self.repository / ".kin-ops.lock").read_text(), "backup-in-progress")

    def test_40_a_lost_lock_stops_the_next_phase(self):
        self.run_phase("capture")
        (self.repository / ".kin-ops.lock").write_text("someone-else")
        refuses(self, self.run_phase, "introduce", self.local_restore(), message="no longer owns")
        self.assertEqual((self.repository / ".kin-ops.lock").read_text(), "someone-else")

    def test_41_tool_and_target_manifest_must_be_the_planned_ones(self):
        machine = self.machine()
        machine.tool = {name: "0" * 64 for name in intro.TOOL_FILES}
        request = {"version": 1, "mode": intro.MODE, "phase": "capture", "plan_sha256": self.plan_sha256, "nonce": "1" * 32}
        refuses(self, machine.run, request, "c" * 64, message="Installed tool differs")
        machine = self.machine()
        machine.target = dict(machine.target, tls_certificate="/etc/other.pem")
        refuses(self, machine.run, request, "c" * 64, message="Target manifest differs")
        self.assertEqual(self.ops.calls, [])

    def test_42_rehearsal_produces_the_receipt_production_accepts(self):
        self.kind = "rehearsal"
        self.assertEqual(self.run_phase("seed")["status"], "SEEDED")
        self.assertEqual(self.run_phase("capture")["status"], "HELD")
        # A rehearsal introduces without a receipt of its own; it is the receipt's producer.
        self.assertEqual(self.run_phase("introduce")["status"], "INTRODUCED")
        self.assertEqual(self.run_phase("verify")["status"], "VERIFIED")
        self.assertEqual(self.run_phase("rollback")["status"], "ROLLED_BACK")
        result = self.run_phase("receipt")
        self.assertEqual(result["status"], "RECEIPTED")
        receipt = intro.make_receipt(self.machine_with_state())
        production_plan = plan_fixture()
        intro.receipt_valid(receipt, production_plan, plan_fixture(kind="rehearsal")["seed"]["b0_manifest_sha256"], production_identity())
        self.assertEqual(self.records.state()["receipt"]["sha256"], intro.sha256_bytes(intro.canonical(receipt)))

    def machine_with_state(self):
        machine = self.machine()
        machine.state = self.records.state()
        return machine

    def test_52_every_mutating_step_records_the_host_before_and_after(self):
        results = self.deploy_through("introduce")
        (record,) = self.records.directory.glob("result-introduce-*.json")
        steps = {step["step"]: step for step in json.loads(record.read_text())["steps"]}
        for sid, _, mutating, _ in intro.STEPS["introduce"]:
            with self.subTest(step=sid):
                self.assertEqual(("before" in steps[sid], "after" in steps[sid]), (mutating, mutating))
        # The first database change is durable between its before and after observations.
        self.assertEqual((steps["L-06b"]["before"]["db_changed"], steps["L-06b"]["after"]["db_changed"]), (False, True))
        self.assertEqual(steps["L-06a"]["after"]["checkout"], "target")
        self.assertEqual(results["introduce"]["status"], "INTRODUCED")

    def test_43_receipt_needs_every_rehearsal_phase(self):
        self.kind = "rehearsal"
        self.run_phase("seed")
        machine = self.machine_with_state()
        refuses(self, intro.make_receipt, machine, message="did not pass every phase")
        refuses(self, self.run_phase, "receipt", message="cannot follow SEEDED")


class HelperTests(unittest.TestCase):
    def test_44_env_parsing_compose_digest_and_override(self):
        values = intro.parse_env(b"# comment\nA=1\nB='two words'\n export=x\nC=\"q\"\nbad line\n")
        self.assertEqual(values, {"A": "1", "B": "two words", "C": "q", "export": "x"})
        first = intro.compose_digest([("docker-compose.yml", b"a"), (".env", b"b")])
        self.assertNotEqual(first, intro.compose_digest([("docker-compose.yml", b"a"), (".env", b"c")]))
        self.assertNotEqual(first, intro.compose_digest([("docker-compose.yml", b"ab"), (".env", b"")]))
        text = intro.override_yaml({"proxy": {"image": image("7"), "ports": ("!override", ["127.0.0.1:9444:443"])},
                                    "api": {"labels": {"kin.deploy.release": "b" * 40}}}, volumes={"kin-recovery-pg": "x_recovery"})
        try:
            import yaml
        except ImportError:
            self.skipTest("PyYAML is not installed")

        class Loader(yaml.SafeLoader):
            pass
        Loader.add_constructor("!override", lambda loader, node: loader.construct_sequence(node))
        loaded = yaml.load(text, Loader=Loader)
        self.assertEqual(loaded["services"]["proxy"]["ports"], ["127.0.0.1:9444:443"])
        self.assertEqual(loaded["volumes"]["kin-recovery-pg"], {"external": True, "name": "x_recovery"})

    def test_45_rehearsal_override_names_only_clone_resources(self):
        try:
            import yaml
        except ImportError:
            self.skipTest("PyYAML is not installed")

        class Loader(yaml.SafeLoader):
            pass
        for tag in ("!override", "!reset"):
            Loader.add_constructor(tag, lambda loader, node: loader.construct_sequence(node) if isinstance(node, yaml.SequenceNode) else None)
        target = target_fixture("rehearsal")
        loaded = yaml.load(intro.rehearsal_override(target, target["origin"]), Loader=Loader)
        self.assertEqual(loaded["name"], target["project"])
        self.assertEqual({role: loaded["services"][role]["container_name"] for role in intro.ROLES},
                         {role: target["containers"][role] for role in intro.ROLES})
        self.assertEqual(loaded["networks"]["workflow"]["name"], target["networks"]["workflow"])
        self.assertEqual(loaded["services"]["proxy"]["ports"], target["ports"]["public"])
        self.assertEqual(loaded["services"]["keycloak"]["environment"]["KC_HOSTNAME"], target["origin"] + "/auth")
        rendered = json.dumps(loaded)
        for name in production_identity()["containers"].values():
            self.assertNotIn('"' + name + '"', rendered)
        refuses(self, intro.rehearsal_override, target_fixture(), "https://pacs.example.invalid")

    def test_46_prepare_env_generates_an_unprinted_url_safe_runtime_secret_once(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / ".env"
            source.write_bytes(b"POSTGRES_PASSWORD=installer-secret-value-000\n")
            out = Path(folder) / "env.next"
            result = subprocess.run([sys.executable, intro.__file__, "prepare-env", "--env", str(source), "--out", str(out)],
                                    capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            values = intro.parse_env(out.read_bytes())
            secret = values["KIN_EMR_RUNTIME_PASSWORD"]
            self.assertRegex(secret, r"^[A-Za-z0-9_-]{43}$")
            self.assertNotIn(secret.encode(), result.stdout + result.stderr)
            self.assertNotIn(b"installer-secret-value-000", result.stdout + result.stderr)
            self.assertEqual(json.loads(result.stdout)["names"], ["KIN_EMR_RUNTIME_PASSWORD", "POSTGRES_PASSWORD"])
            if os.name == "posix":
                self.assertEqual(out.stat().st_mode & 0o777, 0o600)
            again = Path(folder) / "env.again"
            subprocess.run([sys.executable, intro.__file__, "prepare-env", "--env", str(out), "--out", str(again)], check=True, capture_output=True)
            self.assertEqual(intro.parse_env(again.read_bytes())["KIN_EMR_RUNTIME_PASSWORD"], secret)
            refused = subprocess.run([sys.executable, intro.__file__, "prepare-env", "--env", str(source), "--out", str(out)], capture_output=True)
            self.assertNotEqual(refused.returncode, 0)

    def test_47_entry_routes_the_mode_and_still_refuses_a_nonisolated_interpreter(self):
        entry = Path(intro.__file__).with_name("ops_deploy_entry.py")
        raw = json.dumps({"version": 1, "mode": intro.MODE, "phase": "capture", "plan_sha256": "a" * 64, "nonce": "0" * 32}).encode()
        result = subprocess.run([sys.executable, str(entry)], input=raw, capture_output=True)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stderr), {"status": "REJECTED", "stage": "entry"})
        self.assertEqual(result.stdout, b"")

    def test_48_examples_validate_and_stay_disabled(self):
        policy = intro.policy_valid(copy.deepcopy(intro.EXAMPLE_POLICY))
        self.assertIs(policy["enabled"], False)
        intro.target_valid(intro.example_target())
        intro.identity_valid(policy["production"])


@unittest.skipUnless(os.name == "posix" and hasattr(os, "geteuid") and os.geteuid() == 0, "isolated Linux root fixture required")
class ProtectedHostTests(unittest.TestCase):
    """The entry adapter's root-owned policy, documents by hash and one-use approval (as ops_deploy_host's HostTests)."""

    def setUp(self):
        folder = tempfile.TemporaryDirectory(prefix="kin-emr-host-")
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        self.repo, self.state = self.root / "repo", self.root / "state"
        self.repo.mkdir(mode=0o700)
        (self.repo / ".git").mkdir(mode=0o755)
        self.state.mkdir(mode=0o700)
        for name in intro.EMR_DIRS:
            (self.state / name).mkdir(mode=0o700)
        policy = copy.deepcopy(intro.EXAMPLE_POLICY)
        policy.update(enabled=True, repository=str(self.repo), state_dir=str(self.state))
        policy["production"] = production_identity()
        self.policy_path = self.write(self.root / "policy.json", policy)
        target = target_fixture(repository=str(self.repo))
        self.target_sha = self.document("emr-targets", target)
        plan = plan_fixture(target)
        self.plan_sha = self.document("emr-plans", plan)

    def write(self, path, value):
        raw = intro.canonical(value)
        path.write_bytes(raw)
        path.chmod(0o600)
        return path

    def document(self, folder, value):
        raw = intro.canonical(value)
        digest = hashlib.sha256(raw).hexdigest()
        self.write(self.state / folder / (digest + ".json"), value)
        return digest

    def request(self, phase="capture"):
        return json.dumps({"version": 1, "mode": intro.MODE, "phase": phase, "plan_sha256": self.plan_sha, "nonce": os.urandom(16).hex()}).encode()

    def approve(self, raw, evidence=None):
        digest = hashlib.sha256(raw).hexdigest()
        self.write(self.state / "emr-approvals" / (digest + ".json"),
                   {"schema": 1, "mode": intro.MODE, "request_sha256": digest, "expires_at": int(__import__("time").time()) + 600,
                    "evidence": evidence or {}})
        return digest

    def test_49_policy_must_be_enabled_root_owned_and_private(self):
        host = intro.IntroductionHost(self.policy_path)
        self.assertTrue(host.policy["enabled"])
        self.policy_path.chmod(0o644)
        with self.assertRaises(RuntimeError):
            intro.IntroductionHost(self.policy_path)
        self.policy_path.chmod(0o600)
        disabled = json.loads(self.policy_path.read_bytes())
        disabled["enabled"] = False
        self.write(self.policy_path, disabled)
        with self.assertRaises(RuntimeError):
            intro.IntroductionHost(self.policy_path)

    def test_50_unapproved_or_replayed_requests_never_reach_a_step(self):
        host = intro.IntroductionHost(self.policy_path)
        raw = self.request()
        with self.assertRaises(FileNotFoundError):
            host.execute(raw)
        digest = self.approve(raw)
        calls = []
        original, key = intro.Introduction.run, intro.local_host_key
        intro.Introduction.run = lambda machine, request, request_sha256: calls.append(request_sha256) or {"status": "x"}
        intro.local_host_key = lambda: "a" * 64
        try:
            host.execute(raw)
            with self.assertRaises(FileExistsError):
                host.execute(raw)
        finally:
            intro.Introduction.run, intro.local_host_key = original, key
        self.assertEqual(calls, [digest])
        self.assertTrue((self.state / "emr-used" / (digest + ".json")).is_file())

    def test_53_an_operating_account_checkout_is_accepted_only_when_private_and_owned(self):
        owner = {"uid": 1000, "gid": 1000}
        policy = json.loads(self.policy_path.read_bytes())
        policy["repository_owner"] = owner
        self.write(self.policy_path, policy)
        with self.assertRaisesRegex(intro.Stop, "not owned by the repository account"):
            intro.IntroductionHost(self.policy_path)
        for path in (self.repo, self.repo / ".git"):
            os.chown(path, 1000, 1000)
        host = intro.IntroductionHost(self.policy_path)
        self.assertEqual(host.owner, owner)
        self.repo.chmod(0o770)
        with self.assertRaisesRegex(intro.Stop, "writable by others"):
            intro.IntroductionHost(self.policy_path)
        self.repo.chmod(0o700)
        os.chown(self.repo, 1001, 1001)
        with self.assertRaisesRegex(intro.Stop, "another owner"):
            intro.IntroductionHost(self.policy_path)

    def test_54_git_runs_as_the_checkout_owner_and_env_keeps_its_owner(self):
        owner = {"uid": 1000, "gid": 1000}
        self.root.chmod(0o755)   # the account must be able to reach its own checkout
        repo = self.root / "owned"
        repo.mkdir(mode=0o700)
        os.chown(repo, 1000, 1000)
        runner = intro.Runner(repo, owner=owner)
        for args in (["git", "init", "-q"], ["git", "-c", "user.email=f@example.invalid", "-c", "user.name=F", "commit", "-q",
                                              "--allow-empty", "-m", "one"]):
            self.assertEqual(runner(args).returncode, 0)
        (repo / "file.txt").write_text("x")
        os.chown(repo / "file.txt", 1000, 1000)
        runner(["git", "add", "file.txt"])
        runner(["git", "-c", "user.email=f@example.invalid", "-c", "user.name=F", "commit", "-q", "-m", "two"])
        runner(["git", "checkout", "-q", "--detach", "HEAD~1"])
        runner(["git", "checkout", "-q", "--detach", "HEAD@{1}"])
        self.assertEqual((repo / "file.txt").stat().st_uid, 1000, "a checkout as root would leave root-owned files")
        (repo / ".env").write_bytes(b"A=1\n")
        os.chown(repo / ".env", 1000, 1000)
        target = target_fixture(repository=str(repo))
        ops_host = intro.HostOps(target=target, plan=plan_fixture(target), runner=runner, records=intro.Records(self.root / "r"), owner=owner)
        ops_host.write_env(b"A=2\n")
        info = (repo / ".env").stat()
        self.assertEqual((info.st_uid, info.st_gid, info.st_mode & 0o777), (1000, 1000, 0o600))
        intro.owned_private(repo / ".env", owner, private=True)

    def test_51_documents_are_bound_by_their_hash(self):
        host = intro.IntroductionHost(self.policy_path)
        path = self.state / "emr-plans" / (self.plan_sha + ".json")
        path.write_bytes(path.read_bytes() + b" ")
        path.chmod(0o600)
        raw = self.request()
        self.approve(raw)
        with self.assertRaisesRegex(intro.Stop, "Document bytes differ"):
            host.execute(raw)


if __name__ == "__main__":
    unittest.main(verbosity=2)
