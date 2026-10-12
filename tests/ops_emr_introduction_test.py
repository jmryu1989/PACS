"""INTERIM-RELEASE-TOOLS: the EMR-introduction release mode's contracts, without Docker or a host.

Plan/target/request/approval/receipt validation, the clone/target allowlist, the preflight additions (as functions of
observed facts), and the phase state machine with a synthetic operations object that records what it was asked to do
and answers with configured facts or faults. The real docker/compose operations of each step are exercised by the
synthetic Linux rehearsal (tests/ops_deploy_host_container_test.py EmrIntroductionRehearsal). Assertions bind to the
mode's contract (refusals, order, lock, durable state, rollback decisions), not to implementation text.
"""
from __future__ import annotations

import base64
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
from types import SimpleNamespace
import unittest
from unittest.mock import patch

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
            "keycloak_admin": "kin-clone-admin", "external_networks": {}, "declared_overlays": [], "tracked_overlay_reconcile": [],
            "fix_checkout_mode": False}


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
            "smoke": {"frame": {"path": "/dicom-web/studies/1.2/series/1.3/instances/1.4/frames/1", "bytes": 64, "sha256": "f" * 64},
                      "member": {"roles": ["radiologist"], "group": "hallym"}},
            "probe": {"study": "SYNTHETIC-release-probe", "event_id": "12345678-1234-4123-8123-123456789abc",
                      "institution": "kin-center", "approved_by": "commander", "approved_at": "2026-10-12T00:00:00Z"},
            "window": {"start": "2026-10-13T00:00:00Z", "end": "2026-10-13T12:00:00Z"},
            "budget": {"capture_s": 3600, "introduce_s": 3600, "verify_s": 3600, "reopen_s": 1800, "rollback_s": 3600,
                       "seed_s": 3600, "min_free_bytes": 2 * 1024 ** 3},
            "backup_root": "/home/ubuntu/backups/kin-pacs", "tool": {name: "9" * 64 for name in intro.TOOL_FILES},
            "seed": None, "projection_exempt": [], "rehearsal_host": "b" * 64}
    if kind == "rehearsal":
        # The rehearsal names the production plan it rehearses (the default production fixture) and that attempt's B0.
        plan["seed"] = {"b0_dir": "/srv/kin/b0-copy/emr-b0-20261013T000000Z-0123abcd", "b0_manifest_sha256": "8" * 64,
                        "production_plan_sha256": intro.plan_identity(plan_fixture())}
        plan["rehearsal_host"] = None
    return plan


FRAME_STUDY = "1.2"


def receipt_fixture(plan, *, created=None, **changes):
    """A receipt as the rehearsal's receipt phase writes it for the given production plan (see make_receipt)."""
    frame = plan["smoke"]["frame"]
    created = created or datetime.now(timezone.utc) - timedelta(hours=1)
    phases = {phase: {"request_sha256": "%x" % (index + 1) * 64, "result_sha256": "c" * 64, "seconds": 1.0,
                      "steps": [[sid, "PASS"] for sid, _, _, _ in intro.STEPS[phase]]}
              for index, phase in enumerate(intro.RECEIPT_PHASES)}
    recovery = {"project": "kin-rh-0001-rbabcdef01", "pg": "kin-rh-0001-rbabcdef01_pg-db", "orthanc": "kin-rh-0001-rbabcdef01_orthanc-db"}
    body = {"schema": 2, "kind": "local-restore", "passed": True, "receipt_id": "1" * 32, "plan_core_sha256": intro.plan_core(plan),
            "production_plan_sha256": intro.plan_identity(plan), "rehearsal_plan_sha256": "d" * 64,
            "rehearsal_target_manifest_sha256": "a" * 64, "source_b0_manifest_sha256": "8" * 64,
            "rehearsal_b0_manifest_sha256": "e" * 64, "rehearsal_b1_manifest_sha256": "f" * 64, "bfail_manifest_sha256": "6" * 64,
            "tool": plan["tool"], "host_key_sha256": "b" * 64, "phases": phases,
            "evidence": {"seed": {"source_b0_manifest_sha256": "8" * 64},
                         "capture": {"b0_manifest_sha256": "e" * 64, "restore_check": True},
                         "verify": {"b1_manifest_sha256": "f" * 64, "b1_restore_check": True,
                                    "probe": {"added": 1, "replay_duplicates": 0, "restart": "same chain and seal", "evidence_sha256": "5" * 64}},
                         "rollback": {"bfail_manifest_sha256": "6" * 64, "recovery": recovery},
                         "rollback_reopen": {"recovery_persisted": True,
                                             "smoke": {"member": True, "token_after_restore": True, "worklist_uid": FRAME_STUDY,
                                                       "frame_sha256": frame["sha256"], "frame_bytes": frame["bytes"]}}},
            "journal_sha256": "7" * 64, "journal_bytes": 1024, "created_utc": created.isoformat()}
    body.update(changes)
    return body


def resolved_model(target, *, target_checkout, maintenance, images=None, recovery=None):
    """The selected, secret-free fields HostOps.resolved() reads from `docker compose config`, for a correct target."""
    project = recovery["project"] if recovery else target["project"]
    services = list(intro.ROLES) + (list(intro.ONE_SHOTS) if target_checkout else [])
    volumes = {"pg-db": recovery["pg"] if recovery else target["volumes"]["pg"],
               "orthanc-db": recovery["orthanc"] if recovery else target["volumes"]["orthanc"], "proxy-certs": target["project"] + "_proxy-certs"}
    mounts = {role: [] for role in services}
    mounts["db"].append({"type": "volume", "source": "pg-db", "target": "/var/lib/postgresql/data"})
    mounts["orthanc"] += [{"type": "volume", "source": "orthanc-db", "target": "/var/lib/orthanc/db"},
                          {"type": "bind", "source": target["repository"] + "/config/orthanc.json", "target": "/etc/orthanc/orthanc.json"}]
    mounts["proxy"].append({"type": "volume", "source": "proxy-certs", "target": "/etc/nginx/certs"})
    for overlay in target["declared_overlays"]:
        mounts[overlay["service"]] += [{"type": "bind", "source": bind["source"], "target": bind["target"], "read_only": bind["read_only"]}
                                       for bind in overlay["binds"]]
    if target_checkout:
        volumes.update({"emr-access": target["volumes"]["emr_access"], "emr-state": target["volumes"]["emr_state"]})
        mounts["db"].append({"type": "volume", "source": "emr-access", "target": "/var/lib/postgresql/emr-access"})
        mounts["api"].append({"type": "volume", "source": "emr-state", "target": intro.EMR_STATE_DIR})
    ports = {role: [] for role in services}
    ports["proxy"] = [target["ports"]["maintenance"]] if maintenance else list(target["ports"]["public"])
    if target["kind"] == "production":
        ports["orthanc"], ports["keycloak"] = ["127.0.0.1:8042:8042"], ["127.0.0.1:8080:8080"]
    origin = target["origin"]
    networks = {role: ["default"] for role in services}
    networks["proxy"] = ["default", "workflow"]
    for role, entries in target["external_networks"].items():
        networks[role] = sorted(set(networks[role]) | set(entries))
    declared = {key: name for entries in target["external_networks"].values() for key, name in entries.items()}
    return {"project": project, "containers": {role: target["containers"][role] for role in services}, "volumes": volumes,
            "networks": {"default": project + "_default" if recovery else target["networks"]["default"], "workflow": target["networks"]["workflow"],
                         **declared},
            "service_networks": networks,
            "mounts": mounts, "ports": ports, "images": dict(images) if images else {role: None for role in services},
            "origin": {"api_KC_ISSUER": origin + "/auth/realms/kin", "keycloak_KC_HOSTNAME": origin + "/auth", "api_PUBLIC_ORIGIN": origin},
            "api_environment": ["AUTH_REQUIRED", "DATABASE_URL"], "proxy_ports": ports["proxy"]}


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
        for kind in ("production", "rehearsal"):
            plan = plan_fixture(kind=kind)
            plan["smoke"]["frame"] = None
            refuses(self, intro.plan_valid, plan, message="real frame")
        plan = plan_fixture()
        plan["rehearsal_host"] = None
        refuses(self, intro.plan_valid, plan, message="rehearsal host")
        plan = plan_fixture(kind="rehearsal")
        del plan["seed"]["production_plan_sha256"]
        refuses(self, intro.plan_valid, plan, message="seed")


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

    def test_09_resolved_compose_model_must_be_exactly_the_target(self):
        """IRT-03: names, every mount, networks, ports, origin settings and pinned images of the resolved model."""
        target = target_fixture("rehearsal")
        model = resolved_model(target, target_checkout=False, maintenance=False)
        intro.check_resolved(model, target, target_checkout=False, maintenance=False)
        # The target checkout also names the one-shots and both EMR volumes.
        with self.assertRaises(intro.Stop):
            intro.check_resolved(model, target, target_checkout=True, maintenance=False)
        full = resolved_model(target, target_checkout=True, maintenance=True, images=plan_fixture(target, "rehearsal")["release"]["images"])
        intro.check_resolved(full, target, target_checkout=True, maintenance=True, images=plan_fixture(target, "rehearsal")["release"]["images"])
        cases = {"production container": lambda m: m["containers"].__setitem__("db", "kin-db"),
                 "production workflow network": lambda m: m["networks"].__setitem__("workflow", "kin-workflow"),
                 "production volume": lambda m: m["volumes"].__setitem__("emr-state", "pacs-starter-kit_emr-state"),
                 "project": lambda m: m.__setitem__("project", "x"),
                 "a volume of another project": lambda m: m["volumes"].__setitem__("proxy-certs", "pacs-starter-kit_proxy-certs"),
                 "db mounts another volume": lambda m: m["mounts"]["db"].__setitem__(0, {"type": "volume", "source": "orthanc-db",
                                                                                        "target": "/var/lib/postgresql/data"}),
                 "api without its state": lambda m: m["mounts"].__setitem__("api", []),
                 "bind outside the checkout": lambda m: m["mounts"]["proxy"].append({"type": "bind", "source": "/etc/letsencrypt",
                                                                                     "target": "/etc/letsencrypt"}),
                 "public proxy while fenced": lambda m: m["ports"].__setitem__("proxy", list(target["ports"]["public"])),
                 "orthanc published": lambda m: m["ports"].__setitem__("orthanc", ["8042:8042"]),
                 "production origin": lambda m: m["origin"].__setitem__("api_KC_ISSUER", "https://pacs.example.invalid/auth/realms/kin"),
                 "public origin": lambda m: m["origin"].__setitem__("api_PUBLIC_ORIGIN", "https://pacs.example.invalid"),
                 "image": lambda m: m["images"].__setitem__("api", image("1"))}
        for name, change in cases.items():
            bad = copy.deepcopy(full)
            change(bad)
            with self.subTest(case=name), self.assertRaises(intro.Stop):
                intro.check_resolved(bad, target, target_checkout=True, maintenance=True,
                                     images=plan_fixture(target, "rehearsal")["release"]["images"])


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
        return receipt_fixture(plan, **changes)

    def test_12_local_restore_receipt_replaces_offsite_only_for_the_same_release_and_snapshot(self):
        plan, production = plan_fixture(), production_identity()
        intro.receipt_valid(self.receipt(plan), plan, "8" * 64, production)
        cases = {"another snapshot": {"source_b0_manifest_sha256": "7" * 64}, "another release": {"plan_core_sha256": "0" * 64},
                 "production host": {"host_key_sha256": "a" * 64}, "offsite kind": {"kind": "offsite-restore"},
                 "not passed": {"passed": False}, "another tool": {"tool": {name: "1" * 64 for name in intro.TOOL_FILES}},
                 "old schema": {"schema": 1}}
        for name, change in cases.items():
            with self.subTest(case=name):
                refuses(self, intro.receipt_valid, self.receipt(plan, **change), plan, "8" * 64, production)
        missing = self.receipt(plan)
        del missing["phases"]["rollback"]
        refuses(self, intro.receipt_valid, missing, plan, "8" * 64, production, message="phases")

    def test_59_a_receipt_binds_its_run_artifacts_plan_host_time_and_one_use(self):
        """IRT-02: every way a receipt can be other than one real rehearsal of this plan's B0 is refused."""
        plan, production = plan_fixture(), production_identity()
        now = datetime.now(timezone.utc)
        good = self.receipt(plan)
        self.assertIs(intro.receipt_valid(good, plan, "8" * 64, production, now=now, b0_created_utc=(now - timedelta(days=1)).isoformat()), good)

        def phases(change):
            body = self.receipt(plan)
            change(body["phases"])
            return body

        def evidence(change):
            body = self.receipt(plan)
            change(body["evidence"])
            return body
        other_target = target_fixture()
        other_target["origin"] = "https://different-production.example.invalid"
        other_plan = copy.deepcopy(plan)
        other_plan["target_manifest_sha256"] = intro.sha256_bytes(intro.canonical(other_target))
        cases = {
            "fabricated phases (status only)": phases(lambda p: [p.__setitem__(name, {"status": "PASS"}) for name in list(p)]),
            "a step missing": phases(lambda p: p["introduce"]["steps"].pop()),
            "a step not passed": phases(lambda p: p["verify"]["steps"][1].__setitem__(1, "STOP")),
            "no result file hash": phases(lambda p: p["rollback"].__setitem__("result_sha256", "short")),
            "one request for two phases": phases(lambda p: p["verify"].__setitem__("request_sha256", p["introduce"]["request_sha256"])),
            "rollback never reopened": phases(lambda p: p.pop("rollback_reopen")),
            "another B1": self.receipt(plan, rehearsal_b1_manifest_sha256="0" * 64),
            "another B0 of the rehearsal": self.receipt(plan, rehearsal_b0_manifest_sha256="0" * 64),
            "another Bfail": self.receipt(plan, bfail_manifest_sha256="0" * 64),
            "B1 restore check missing": evidence(lambda e: e["verify"].__setitem__("b1_restore_check", False)),
            "probe replayed twice": evidence(lambda e: e["verify"]["probe"].__setitem__("replay_duplicates", 1)),
            "recovery volume of another project": evidence(lambda e: e["rollback"]["recovery"].__setitem__("pg", "pacs-starter-kit_pg-db")),
            "recovery never persisted": evidence(lambda e: e["rollback_reopen"].__setitem__("recovery_persisted", False)),
            "rollback smoke on another frame": evidence(lambda e: e["rollback_reopen"]["smoke"].__setitem__("frame_sha256", "0" * 64)),
            "rollback smoke without the worklist": evidence(lambda e: e["rollback_reopen"]["smoke"].__setitem__("worklist_uid", "9.9")),
            "rollback smoke with an old token": evidence(lambda e: e["rollback_reopen"]["smoke"].__setitem__("token_after_restore", False)),
            "stale": self.receipt(plan, created=now - timedelta(days=8)),
            "from the year 2000": self.receipt(plan, created_utc="2000-01-01T00:00:00Z"),
            "dated in the future": self.receipt(plan, created=now + timedelta(hours=1)),
            "another rehearsal host": self.receipt(plan, host_key_sha256="c" * 64),
            "for another production plan": self.receipt(plan, production_plan_sha256="0" * 64),
        }
        for name, body in cases.items():
            with self.subTest(case=name):
                refuses(self, intro.receipt_valid, body, plan, "8" * 64, production)
        refuses(self, intro.receipt_valid, good, other_plan, "8" * 64, production, message="another production plan")
        with self.assertRaisesRegex(intro.Stop, "predates"):
            intro.receipt_valid(good, plan, "8" * 64, production, b0_created_utc=now.isoformat())
        with self.assertRaisesRegex(intro.Stop, "already used"):
            intro.receipt_valid(good, plan, "8" * 64, production, used=[intro.receipt_sha256(good)])

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


def pg_role(name, *, superuser=False, login=False):
    return {"rolname": name, "rolsuper": superuser, "rolcreaterole": superuser, "rolcreatedb": superuser, "rolcanlogin": login,
            "rolreplication": superuser, "rolbypassrls": superuser, "rolinherit": True, "rolconnlimit": -1, "rolvaliduntil": None,
            "rolconfig": None}


def pre_catalog():
    """A supported pre-EMR cluster catalog: the installer superuser, the two databases and the default tablespaces."""
    return {"roles": [pg_role("kin", superuser=True, login=True)], "memberships": [],
            "databases": [{"name": name, "owner": "kin", "acl": None} for name in ("keycloak", "kin", "postgres")],
            "schemas": ["public"], "tablespaces": [{"name": "pg_default", "owner": "kin", "location": ""},
                                                   {"name": "pg_global", "owner": "kin", "location": ""}]}


def baseline_observed(plan):
    return {"head": plan["previous"]["sha"], "dirty": False, "images": dict(plan["previous"]["images"]),
            "running": {role: True for role in intro.ROLES}, "restarting": {role: False for role in intro.ROLES},
            "migrations": [[name, checksum, True, False] for name, checksum in plan["migrations"]["before"]],
            "catalog": pre_catalog(), "emr_volumes": [], "api_state_mounts": 0, "cron": "matched", "members": dict(plan["members"])}


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
                 "service accounts": lambda o: o["members"].__setitem__("service_accounts", 2),
                 # IRT-07: a B0 the rollback could not rebuild exactly is refused before the fence.
                 "further login role": lambda o: o["catalog"]["roles"].append(pg_role("legacy_app", login=True)),
                 "another database": lambda o: o["catalog"]["databases"].append({"name": "other", "owner": "kin", "acl": None}),
                 "another tablespace": lambda o: o["catalog"]["tablespaces"].append({"name": "fast", "owner": "kin", "location": "/x"})}
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
        realm = {"roles": ["admin", "clinician", "default-roles-kin", "gateway", "radiologist", "technician"], "groups": ["hallym", "kin-center"]}
        return {"markers": ["realm-v1"], "state": "ready", "roster_before": roster, "rights": rights,
                "legacy_enable": [{"sub": "u3", "state": "done"}], "roster_after": after,
                "changes": [{"kind": "credentials", "target": "legacy-enable:u3", "sub": "u3", "state": "done"}], "isolated": [],
                "realm_before": realm, "realm_after": copy.deepcopy(realm)}

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

    def test_60_member_rights_equal_the_products_rule_and_the_realm_is_unchanged(self):
        """IRT-08: exact per-member rights (every role, approval, suspension) and no realm change beyond the confirmed
        legacy enables."""
        multi = self.member_observed()
        multi["roster_before"][0]["roles"] = ["admin", "default-roles-kin", "radiologist"]
        multi["roster_after"][0]["roles"] = ["admin", "default-roles-kin", "radiologist"]
        multi["rights"][0]["roles"] = ["admin", "radiologist"]
        pre.check_member_import(multi)
        cases = {
            "one of two roles lost": lambda o: o["rights"][0].__setitem__("roles", ["radiologist"]),
            "approved member imported unapproved": lambda o: o["rights"][0].update(approved=False, institution=None, roles=[]),
            "unapproved member imported approved": lambda o: o["rights"][1].update(approved=True),
            "active member suspended": lambda o: o["rights"][0].__setitem__("suspended", True),
            "realm role changed for a member": lambda o: o["roster_after"][0].__setitem__("roles", ["admin", "default-roles-kin"]),
            "realm group changed for a member": lambda o: o["roster_after"][0].__setitem__("groups", ["kin-center"]),
            "member added": lambda o: o["roster_after"].append({**o["roster_after"][1], "id": "u8", "username": "new"}),
            "member removed": lambda o: o["roster_after"].pop(1),
            "member renamed": lambda o: o["roster_after"][1].__setitem__("username", "renamed"),
            "enabled without a legacy enable": lambda o: o["roster_after"][1].__setitem__("enabled", False),
            "realm role defined": lambda o: o["realm_after"]["roles"].append("superuser"),
            "realm group removed": lambda o: o["realm_after"]["groups"].remove("kin-center"),
            "provider change unconfirmed": lambda o: o["changes"].append({"kind": "end_session", "target": None, "sub": "u1", "state": "unknown"}),
            "another roster change": lambda o: o["changes"].append({"kind": "credentials", "target": "u1", "sub": "u1", "state": "done"}),
        }
        for name, change in cases.items():
            observed = copy.deepcopy(multi)
            change(observed)
            with self.subTest(case=name), self.assertRaises(RuntimeError):
                pre.check_member_import(observed)
        # The product's own rule: a gateway role or two groups never approve; an isolated member is suspended.
        rule = pre.expected_member_rights
        self.assertFalse(rule({"id": "x", "username": "g", "enabled": True, "groups": ["hallym"], "roles": ["gateway", "admin"]}, set(), set())["approved"])
        self.assertFalse(rule({"id": "x", "username": "g", "enabled": True, "groups": ["a", "b"], "roles": ["admin"]}, set(), set())["approved"])
        self.assertTrue(rule({"id": "x", "username": "g", "enabled": True, "groups": ["a"], "roles": ["admin"]}, {"x"}, set())["suspended"])
        self.assertEqual(rule({"id": "x", "username": "g", "enabled": True, "groups": ["a"], "roles": ["offline_access", "clinician"]}, set(), set())["roles"],
                         ["clinician"])


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

    def effect_restore_check_b0(self, context):
        context.state["b0"]["restore_check"] = {"success": True}

    def effect_capture_b1(self, context):
        context.state["b1"] = {"dir": "/backups/emr-b1", "manifest_sha256": "7" * 64, "restore_check": {"success": True}}

    def effect_storage(self, context):
        context.state["checkout"] = "target"

    def effect_member_import(self, context):
        context.state["imported_at"] = NOW.isoformat()

    def effect_probe(self, context):
        context.state["probe"] = {"event_id": "e", "receipt": {}, "evidence_sha256": "5" * 64, "added": 1, "replay_duplicates": 0,
                                  "restart": "same chain and seal"}

    def effect_seed_restore(self, context):
        context.state["seed"] = {"source_manifest_sha256": "8" * 64}

    def effect_preserve_failed(self, context):
        context.state["bfail"] = {"dir": "/backups/emr-bfail", "manifest_sha256": "6" * 64, "volumes": {}}

    def effect_restore_b0(self, context):
        context.state["recovery"] = {"project": "kin-rh-0001-rbabcdef01", "pg": "kin-rh-0001-rbabcdef01_pg-db",
                                     "orthanc": "kin-rh-0001-rbabcdef01_orthanc-db", "persisted": False}

    def effect_recovery_persisted(self, context):
        context.state["recovery"]["persisted"] = True

    def effect_fenced_previous_smoke(self, context):
        frame = context.plan["smoke"]["frame"]
        context.state["rollback_smoke"] = {"member": True, "token_after_restore": True, "worklist_uid": intro.frame_study(context.plan),
                                           "frame_sha256": frame["sha256"], "frame_bytes": frame["bytes"]}

    def effect_write_receipt(self, context):
        context.state["receipt"] = {"sha256": context.records.put("local-restore-receipt.json", intro.make_receipt(context))}


class Clock:
    def __init__(self):
        self.value = 0.0

    def __call__(self):
        return self.value


class MachineHarness:
    """One plan's state machine with the synthetic operations object, in a temporary repository and records folder."""

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
        # The production plan this machine runs (its target names the test's repository): the receipt names exactly it.
        plan = plan_fixture(target_fixture(self.kind, repository=str(self.repository)), kind=self.kind)
        return {"local-restore": receipt_fixture(plan, created=NOW - timedelta(hours=1))}

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


class StateMachineTests(MachineHarness, unittest.TestCase):
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
        for phase in ("introduce", "verify", "reopen", "rollback", "rollback_reopen", "release"):
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
        self.assertEqual(self.ops.calls, ["checkout_mode", "reconcile_checkout", "baseline"])
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
        # Restored, but nothing reopens before the previous version proved itself (IRT-06): fence and lock stay.
        self.assertEqual((result["status"], result["phase_passed"], result["data_restored"]), ("RESTORED", False, True))
        rollback = [name for _, name, _, _ in intro.STEPS["rollback"]]
        self.assertEqual(self.ops.calls[-len(rollback) - 1:], ["one_shots_alive", *rollback])
        self.assertFalse({name for _, name, _, _ in intro.STEPS["rollback_reopen"]} & set(self.ops.calls),
                         "the rollback itself never smokes, restores jobs or opens the ingress")
        self.assertTrue(self.records.state()["rollback_attempted"])
        self.assertTrue(self.lock_held())
        refuses(self, self.run_phase, "rollback", message="cannot follow RESTORED")
        reopened = self.run_phase("rollback_reopen")
        self.assertEqual((reopened["status"], reopened["phase_passed"]), ("ROLLED_BACK", True))
        self.assertEqual(self.ops.calls[-len(intro.STEPS["rollback_reopen"]):], [name for _, name, _, _ in intro.STEPS["rollback_reopen"]])
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
        self.assertEqual(self.run_phase("rollback")["status"], "RESTORED")

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
        self.assertEqual(self.run_phase("rollback")["status"], "RESTORED")

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
        self.assertEqual(self.run_phase("rollback")["status"], "RESTORED")
        self.assertTrue(self.records.state()["rollback_attempted"])

    def test_38_verify_failure_rolls_back_from_the_held_b0(self):
        self.deploy_through("introduce")
        self.ops.faults["probe"] = RuntimeError("The replay added a ledger entry")
        result = self.run_phase("verify")
        self.assertEqual(result["status"], "RESTORED")
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
        self.assertEqual(self.run_phase("rollback")["status"], "RESTORED")
        refuses(self, self.run_phase, "receipt", message="cannot follow RESTORED")
        self.assertEqual(self.run_phase("rollback_reopen")["status"], "ROLLED_BACK")
        result = self.run_phase("receipt")
        self.assertEqual(result["status"], "RECEIPTED")
        receipt = json.loads((self.records.directory / "local-restore-receipt.json").read_text())
        production_plan = plan_fixture()
        intro.receipt_valid(receipt, production_plan, plan_fixture(kind="rehearsal")["seed"]["b0_manifest_sha256"], production_identity(),
                            now=NOW)
        self.assertEqual(self.records.state()["receipt"]["sha256"], intro.sha256_bytes(intro.canonical(receipt) + b"\n"))
        # The run bundle re-verifies: every phase's result file and the journal prefix are the receipt's.
        self.assertTrue(intro.bundle_valid(receipt, self.records.directory))
        (path,) = self.records.directory.glob("result-verify-*.json")
        path.write_bytes(path.read_bytes().replace(b'"PASS"', b'"STOP"', 1))
        refuses(self, intro.bundle_valid, receipt, self.records.directory, message="differs from the receipt")

    def machine_with_state(self):
        machine = self.machine()
        machine.state = self.records.state()
        return machine

    def test_52_every_step_records_the_host_before_and_after(self):
        """IRT-10: read-only steps (L-01, L-04b/c, I-00, L-10a, L-11a/d, RB-01, ...) too, not only the mutating ones."""
        results = self.deploy_through("reopen")
        for phase in ("capture", "introduce", "verify", "reopen"):
            (record,) = self.records.directory.glob("result-" + phase + "-*.json")
            steps = {step["step"]: step for step in json.loads(record.read_text())["steps"]}
            self.assertEqual(set(steps), {sid for sid, _, _, _ in intro.STEPS[phase]})
            for sid in steps:
                with self.subTest(step=sid):
                    self.assertIsInstance(steps[sid]["before"], dict)
                    self.assertIsInstance(steps[sid]["after"], dict)
                    self.assertEqual(set(steps[sid]["commands"]), {"file", "first", "last"})
        (record,) = self.records.directory.glob("result-introduce-*.json")
        steps = {step["step"]: step for step in json.loads(record.read_text())["steps"]}
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


class RoundTwoStateMachineTests(MachineHarness, unittest.TestCase):
    """IRT-02 admission, IRT-04 one phase at a time and crash classification, IRT-06 reopen gating (state machine)."""

    def test_61_a_receipt_is_spent_by_its_production_attempt(self):
        self.run_phase("capture")
        self.ops.faults["storage"] = RuntimeError("Tablespace directory owner differs")
        first = self.run_phase("introduce", self.local_restore())
        self.assertEqual(first["status"], "HELD")
        receipt = self.local_restore()["local-restore"]
        self.assertEqual(self.records.state()["receipts_used"], [intro.receipt_sha256(receipt)])
        calls = list(self.ops.calls)
        self.ops.faults.clear()
        refuses(self, self.run_phase, "introduce", self.local_restore(), message="already used")
        self.assertEqual(self.ops.calls, calls, "a reused receipt is refused before any step")
        fresh = {"local-restore": receipt_fixture(plan_fixture(target_fixture(repository=str(self.repository))),
                                                  created=NOW - timedelta(hours=1), receipt_id="2" * 32)}
        self.assertEqual(self.run_phase("introduce", fresh)["status"], "INTRODUCED")

    def test_62_two_approved_requests_of_one_plan_never_run_together(self):
        """IRT-04: the second of two concurrent requests (introduce/introduce, verify/rollback) is refused before it reads
        the state; only one ever reaches a step."""
        import threading
        self.run_phase("capture")
        entered, release = threading.Event(), threading.Event()
        holder = self

        class Blocking(FakeOps):
            def effect_recheck_fence(self, context):
                entered.set()
                release.wait(10)
                return {}
        self.ops = Blocking()
        first = self.machine(self.local_restore())
        outcome = {}

        def run_first():
            request = {"version": 1, "mode": intro.MODE, "phase": "introduce", "plan_sha256": self.plan_sha256, "nonce": "1" * 32}
            outcome["first"] = first.run(request, "1" * 64)
        thread = threading.Thread(target=run_first)
        thread.start()
        self.assertTrue(entered.wait(10))
        for phase in ("introduce", "rollback", "verify"):
            second = self.machine(self.local_restore() if phase == "introduce" else {})
            request = {"version": 1, "mode": intro.MODE, "phase": phase, "plan_sha256": self.plan_sha256, "nonce": "2" * 32}
            with self.subTest(phase=phase), self.assertRaisesRegex(intro.Stop, "Another phase of this plan is running"):
                second.run(request, "2" * 64)
        release.set()
        thread.join(10)
        self.assertEqual(outcome["first"]["status"], "INTRODUCED")
        self.assertEqual(holder.ops.calls.count("migrate"), 1)
        self.assertEqual(holder.ops.calls.count("recheck_fence"), 1)

    def test_63_a_phase_whose_process_died_is_classified_never_rerun(self):
        """IRT-04: a process that dies mid-phase (os._exit after the first database change) leaves the running marker;
        the next request classifies it NEEDS_ATTENTION, keeps the lock and runs nothing; recovery is explicit."""
        self.run_phase("capture")
        script = (
            "import hashlib, json, os, sys; sys.path[:0] = [%r, %r]\n"
            "import ops_emr_introduction as intro, ops_emr_introduction_test as t\n"
            "class Dying(t.FakeOps):\n"
            "    def effect_provision(self, context):\n"
            "        os._exit(9)\n"
            "target = t.target_fixture('production', repository=%r)\n"
            "plan = t.plan_fixture(target)\n"
            "machine = intro.Introduction(plan=plan, plan_sha256='a' * 64, target=target, production=t.production_identity(), ops=Dying(),\n"
            "    records=intro.Records(%r), repository=%r, host_key='a' * 64, tool=plan['tool'],\n"
            "    evidence={'local-restore': t.receipt_fixture(plan, created=t.NOW - t.timedelta(hours=1))}, clock=t.Clock(), now=lambda: t.NOW)\n"
            "machine.run({'version': 1, 'mode': intro.MODE, 'phase': 'introduce', 'plan_sha256': 'a' * 64, 'nonce': '3' * 32}, '3' * 64)\n"
        ) % (str(Path(intro.__file__).parent), str(Path(__file__).parent), str(self.repository), str(self.records.directory), str(self.repository))
        died = subprocess.run([sys.executable, "-c", script], capture_output=True)
        self.assertEqual(died.returncode, 9, died.stderr[-2000:])
        state = self.records.state()
        self.assertEqual((state["running"]["phase"], state["db_changed"], state["status"]), ("introduce", True, "HELD"))
        calls = list(self.ops.calls)
        refuses(self, self.run_phase, "verify", message="did not finish")
        self.assertEqual(self.ops.calls, calls)
        state = self.records.state()
        self.assertEqual((state["status"], state["running"]), ("NEEDS_ATTENTION", None))
        self.assertEqual(state["history"][-1]["status"], "INTERRUPTED")
        self.assertTrue(self.lock_held())
        # Never re-run automatically; the operator's explicit rollback (workers re-observed in RB-00) is the way back.
        self.assertEqual(self.run_phase("rollback")["status"], "RESTORED")

    def test_64_rollback_never_reopens_before_the_previous_version_proved_itself(self):
        """IRT-06: a failed previous-version smoke keeps RESTORED with the fence and the lock; nothing opens."""
        self.deploy_through("verify")
        self.assertEqual(self.run_phase("rollback")["status"], "RESTORED")
        for step in ("recovery_persisted", "fenced_previous_smoke"):
            self.ops.faults = {step: RuntimeError("The previous-version smoke did not run every check")}
            before = list(self.ops.calls)
            result = self.run_phase("rollback_reopen")
            with self.subTest(step=step):
                self.assertEqual((result["status"], result["phase_passed"]), ("RESTORED", False))
                self.assertTrue(self.lock_held())
                done = self.ops.calls[len(before):]
                self.assertNotIn("restore_jobs_after_rollback", done)
                self.assertNotIn("reopen_previous_ingress", done)
        self.ops.faults = {}
        self.assertEqual(self.run_phase("rollback_reopen")["status"], "ROLLED_BACK")
        self.assertFalse(self.lock_held())


class FakeDocker:
    """The fixed-binary boundary of HostOps (git, docker, crontab): answers by command purpose from configured facts and
    keeps every call, so a test can tell read-only commands from mutating ones."""

    READ_ONLY = (("docker", "inspect"), ("docker", "volume", "inspect"), ("docker", "image", "inspect"), ("docker", "ps"),
                 ("git", "rev-parse"), ("git", "status"), ("git", "cat-file"), ("crontab", "-u"),
                 ("docker", "run", "--rm", "--network", "none", "--read-only"))

    def __init__(self, target, plan):
        self.target, self.plan = target, plan
        self.calls, self.inputs, self.envs = [], [], []
        self.containers, self.volumes, self.tags = {}, {}, {}
        self.head = plan["previous"]["sha"]
        self.config = {}           # "pinned" / "plain" -> the compose config model (dict)
        self.psql = {}             # SQL fragment -> stdout text
        self.attached = {}         # volume -> container names using it
        self.run_output = b'KIN_RESULT {"useCaches":"false","persistentUserSessions":true}\n'
        self.failing = None        # a predicate over argv: those calls exit 1
        self.crontab = ""
        self.image_labels = {}
        self.config_for = None     # (argv, env) -> model, when the model depends on the files or the environment given
        self.blobs = {}            # "HEAD:<path>" -> committed bytes
        self.checkouts, self.on_checkout = [], None

    def result(self, code=0, stdout=b"", stderr=b""):
        return SimpleNamespace(returncode=code, stdout=stdout if isinstance(stdout, bytes) else stdout.encode(), stderr=stderr)

    def __call__(self, args, *, input=None, timeout=60, env=None, output=None, stdin=None):
        args = list(args)
        self.calls.append(args)
        self.envs.append(dict(env or {}))
        if input is not None:
            self.inputs.append(input)
        if self.failing and self.failing(args):
            return self.result(1, stderr=b"synthetic failure")
        if args[:2] == ["docker", "compose"]:
            if "config" in args:
                if self.config_for is not None:
                    return self.result(stdout=json.dumps(self.config_for(args, env or {})))
                return self.result(stdout=json.dumps(self.config["pinned" if "--project-name" in args else "plain"]))
            if "run" in args:
                return self.result(stdout=self.run_output(args) if callable(self.run_output) else self.run_output)
            return self.result()
        if args[:3] == ["git", "cat-file", "blob"]:
            return self.result(stdout=self.blobs.get(args[3], b""))
        if args[:3] == ["git", "checkout", "--"]:
            self.checkouts.append(args[3])
            if self.on_checkout:
                self.on_checkout(args[3])
            return self.result()
        if args[:2] == ["docker", "inspect"]:
            if args[2] == "--format":
                return self.result(stdout="0" if "ExitCode" in args[3] else "false")
            item = self.containers.get(args[2])
            return self.result(stdout=json.dumps([item])) if item else self.result(1, stderr=b"No such object")
        if args[:3] == ["docker", "volume", "inspect"]:
            item = self.volumes.get(args[3])
            return self.result(stdout=json.dumps([item])) if item else self.result(1, stderr=b"no such volume")
        if args[:3] == ["docker", "image", "inspect"]:
            return self.result(stdout=json.dumps([{"Id": self.tags.get(args[3], args[3]),
                                                   "Config": {"User": "node", "Labels": dict(self.image_labels), "Env": []}}]))
        if args[:1] == ["crontab"] and args[-1] == "-l":
            return self.result(stdout=self.crontab)
        if args[:2] == ["docker", "ps"]:
            volume = next((item.split("=", 1)[1] for item in args if item.startswith("volume=")), None)
            return self.result(stdout="\n".join(self.attached.get(volume, [])))
        if args[:2] == ["docker", "exec"] and "psql" in args:
            sql = args[-1]
            for fragment, answer in self.psql.items():
                if fragment in sql:
                    return self.result(stdout=answer)
            raise AssertionError("unexpected SQL " + sql[:60])
        if args[:3] == ["git", "rev-parse", "HEAD"]:
            return self.result(stdout=self.head + "\n")
        if args[:2] == ["git", "status"]:
            return self.result()
        return self.result()

    def mutating(self):
        return [call for call in self.calls if not any(tuple(call[:len(prefix)]) == prefix for prefix in self.READ_ONLY)
                and not (call[:2] == ["docker", "compose"] and "config" in call)
                and not (call[:2] == ["docker", "exec"] and "psql" in call and "-i" not in call)]


def compose_config(target, *, project=None, recovery=None, names=None, workflow=None, origin=None, previous_images=None, proxy_ports=None,
                   extra_networks=None, extra_binds=None):
    """A `docker compose config --format json` model of the previous release for a target (or a corrupted one)."""
    project = project or (recovery["project"] if recovery else target["project"])
    names = names or target["containers"]
    origin = origin or target["origin"]
    images = previous_images or {}
    public = []
    for item in proxy_ports or target["ports"]["public"]:
        parts = item.split(":")
        public.append({"host_ip": parts[0], "published": parts[1], "target": int(parts[2])} if len(parts) == 3 else
                      {"published": parts[0], "target": int(parts[1])})
    services = {
        "db": {"container_name": names["db"], "image": images.get("db"), "environment": {},
               "volumes": [{"type": "volume", "source": "pg-db", "target": "/var/lib/postgresql/data"}]},
        "api": {"container_name": names["api"], "image": images.get("api"),
                "environment": {"KC_ISSUER": origin + "/auth/realms/kin", "PUBLIC_ORIGIN": origin}, "volumes": []},
        "keycloak": {"container_name": names["keycloak"], "image": images.get("keycloak"), "environment": {"KC_HOSTNAME": origin + "/auth"}},
        "orthanc": {"container_name": names["orthanc"], "image": images.get("orthanc"),
                    "volumes": [{"type": "volume", "source": "orthanc-db", "target": "/var/lib/orthanc/db"},
                                {"type": "bind", "source": target["repository"] + "/config/orthanc.json", "target": "/etc/orthanc/orthanc.json"}]},
        "proxy": {"container_name": names["proxy"], "image": images.get("proxy"), "ports": public,
                  "networks": {"default": None, "workflow": None, **{key: None for key in (extra_networks or {})}},
                  "volumes": [{"type": "volume", "source": "proxy-certs", "target": "/etc/nginx/certs"}, *(extra_binds or [])]}}
    return {"name": project, "services": services,
            "volumes": {"pg-db": {"name": recovery["pg"] if recovery else project + "_pg-db"},
                        "orthanc-db": {"name": recovery["orthanc"] if recovery else project + "_orthanc-db"},
                        "proxy-certs": {"name": target["project"] + "_proxy-certs"}},
            "networks": {"default": {"name": project + "_default"}, "workflow": {"name": workflow or target["networks"]["workflow"]},
                         **{key: {"name": name, "external": True} for key, name in (extra_networks or {}).items()}}}


class HostHarness:
    """HostOps against FakeDocker in a temporary rehearsal checkout with its seed copy and records."""

    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.override = self.root / "rehearsal-override.yml"
        for name in ("docker-compose.yml", "docker-compose.prod.yml"):
            (self.repo / name).write_text("services: {}\n")
        self.override.write_text("services: {}\n")
        self.target = target_fixture("rehearsal", str(self.repo))
        self.target["compose_files"] = ["docker-compose.yml", "docker-compose.prod.yml", str(self.override)]
        self.target["volumes"] = {key: self.target["project"] + "_" + value.split("_", 1)[1] for key, value in self.target["volumes"].items()}
        self.target["networks"]["default"] = self.target["project"] + "_default"
        self.target["ca_file"] = str(self.root / "clone-ca.pem")
        (self.root / "clone-ca.pem").write_text("-----BEGIN CERTIFICATE-----\nsynthetic\n-----END CERTIFICATE-----\n")
        self.seed = self.root / "seed"
        self.seed.mkdir()
        (self.seed / ".env").write_text("POSTGRES_PASSWORD=source-placeholder-0001\nKC_ADMIN_PASSWORD=source-admin-0001\n"
                                        "PUBLIC_ORIGIN=https://pacs.example.invalid\n")
        (self.seed / "catalog.json").write_text(json.dumps(pre_catalog()))
        self.write_env("POSTGRES_PASSWORD=clone-placeholder-0002\nKC_ADMIN_PASSWORD=clone-admin-0002\nPUBLIC_ORIGIN=" + self.target["origin"] + "\n")
        self.records = intro.Records(self.root / "records")
        self.records.begin("seed", "f" * 64)

    def write_env(self, text):
        (self.repo / ".env").write_text(text, newline="\n")

    def plan(self):
        plan = plan_fixture(self.target, "rehearsal")
        plan["seed"]["b0_dir"] = str(self.seed)
        entries = [(name, (self.repo / name).read_bytes()) for name in ("docker-compose.yml", "docker-compose.prod.yml")]
        entries += [(str(self.override), self.override.read_bytes()), (".env", (self.repo / ".env").read_bytes())]
        plan["compose"]["before_sha256"] = intro.compose_digest(entries)
        return plan

    def host(self, plan=None, *, token=None):
        plan = plan or self.plan()
        docker = FakeDocker(self.target, plan)
        docker.config["pinned"] = compose_config(self.target, previous_images=plan["previous"]["images"])
        docker.config["plain"] = compose_config(self.target)
        # The clone's certificate volume, filled before the seed (the read-only certificate check passes).
        docker.volumes[self.target["project"] + "_proxy-certs"] = {"Name": self.target["project"] + "_proxy-certs"}
        ops_host = intro.HostOps(target=self.target, plan=plan, runner=docker, records=self.records,
                                 token_reader=(lambda: token) if token else None)
        return ops_host, docker, SimpleNamespace(plan=plan, plan_sha256="a" * 64, state={"checkout": "previous"}, records=self.records,
                                                 save=lambda: None)

    def seed_check(self, ops_host, context):
        with patch.object(ops, "validate_held", return_value=(self.seed, {"shape": "pre"}, "8" * 64)):
            return ops_host.seed_check(context)


class HostBoundaryTests(HostHarness, unittest.TestCase):
    """HostOps against the fixed-binary boundary: IRT-03 seed allowlist, IRT-05 persisted recovery, IRT-06 previous-version
    smoke, IRT-10 command records."""

    def test_65_seed_refuses_every_wrong_target_before_any_docker_change(self):
        """IRT-03: production names, the production workflow network, another origin, a reused secret or a missing
        override stop S-01 with zero mutating commands; the correct clone passes."""
        ops_host, docker, context = self.host()
        self.assertEqual(self.seed_check(ops_host, context)["resolved"], "target manifest")
        self.assertEqual(docker.mutating(), [])
        production = production_identity()
        cases = {
            "production names (override missing from the model)": lambda d: d.config.__setitem__(
                "pinned", compose_config(self.target, names=production["containers"])),
            "kin-workflow": lambda d: d.config.__setitem__("pinned", compose_config(self.target, workflow="kin-workflow")),
            "another origin": lambda d: d.config.__setitem__("pinned", compose_config(self.target, origin="https://pacs.example.invalid")),
            "public proxy beyond loopback": lambda d: d.config.__setitem__("pinned", compose_config(self.target, proxy_ports=["443:443"])),
            "secret reuse": lambda d: self.write_env("POSTGRES_PASSWORD=source-placeholder-0001\nKC_ADMIN_PASSWORD=clone-admin-0002\n"
                                                      "PUBLIC_ORIGIN=" + self.target["origin"] + "\n"),
            "override file missing": lambda d: self.override.unlink(),
            "clone origin is production": lambda d: self.write_env("POSTGRES_PASSWORD=clone-placeholder-0002\nKC_ADMIN_PASSWORD=clone-admin-0002\n"
                                                                    "PUBLIC_ORIGIN=https://pacs.example.invalid\n"),
        }
        for name, change in cases.items():
            self.setUp()
            plan = self.plan()
            ops_host, docker, context = self.host(plan)
            change(docker)
            with self.subTest(case=name):
                with self.assertRaises((intro.Stop, OSError)):
                    self.seed_check(ops_host, context)
                self.assertEqual(docker.mutating(), [], name)

    def test_66_every_command_is_recorded_with_its_outcome_and_no_secret(self):
        """IRT-10: success, a non-zero exit, a timeout (unknown when mutating) and a launch error each leave a command record;
        values of secret environment, secret stdin and secret-bearing output never reach a record."""
        secret = "Sup3rSecretValue-" + "x" * 20
        ops_host, docker, context = self.host()
        docker.run_output = b"KIN_RESULT {}\n"
        ops_host.cmd(["docker", "compose", "--project-directory", str(self.repo), "config"], env={"KC_ADMIN_PASSWORD": secret})
        docker.failing = lambda args: args[:2] == ["docker", "exec"]
        with self.assertRaisesRegex(intro.Stop, "exit 1"):
            ops_host.cmd(["docker", "exec", "-i", "db", "psql"], input=("UPDATE client SET secret='" + secret + "';").encode(), quiet=True)
        with self.assertRaisesRegex(intro.Stop, "exit 1"):
            ops_host.cmd(["docker", "exec", "db", "psql", "-c", "SELECT 1"])
        docker.failing = None

        def timeout(*args, **kwargs):
            raise subprocess.TimeoutExpired(["docker"], 1)

        def missing(*args, **kwargs):
            raise FileNotFoundError("docker")
        for runner, error in ((timeout, intro.Unknown), (missing, intro.Stop)):
            ops_host.run = runner
            with self.assertRaises(error):
                ops_host.cmd(["docker", "compose", "up", "-d", "db"], mutating=True)
        ops_host.run = timeout
        with self.assertRaisesRegex(intro.Stop, "timed out"):
            ops_host.cmd(["docker", "inspect", "x"])
        ops_host.run = lambda *a, **k: SimpleNamespace(returncode=0, stdout=("password=" + secret).encode(), stderr=b"")
        ops_host.cmd(["docker", "compose", "config", "--format", "json"])
        entries = [json.loads(line) for line in (self.records.directory / self.records.commands_file).read_text().splitlines()]
        self.assertEqual([entry["seq"] for entry in entries], list(range(1, 8)))
        self.assertEqual([entry["outcome"] for entry in entries], ["exit", "exit", "exit", "timeout", "error", "timeout", "exit"])
        self.assertEqual([entry.get("exit") for entry in entries], [0, 1, 1, None, None, None, 0])
        self.assertEqual(entries[0]["env"], ["KC_ADMIN_PASSWORD"])
        self.assertEqual(set(entries[1]["input"]), {"sha256", "bytes"})
        self.assertIn("failure_log", entries[2])
        self.assertNotIn("failure_log", entries[1], "a command carrying a secret on stdin keeps no error text")
        self.assertEqual(entries[6]["stdout"]["bytes"], len("password=" + secret))
        for path in self.records.directory.rglob("*"):
            if path.is_file():
                self.assertNotIn(secret.encode(), path.read_bytes(), path.name)

    def test_67_steps_name_the_commands_they_ran(self):
        """IRT-10: each step's record names the range of command records it produced, tagged with its step."""
        ops_host, docker, context = self.host()

        class Linked(FakeOps):
            def effect_baseline(self, machine):
                ops_host.cmd(["git", "rev-parse", "HEAD"])
                ops_host.cmd(["docker", "inspect", "x"], check=False)
        folder = self.root / "machine"
        folder.mkdir()
        records = intro.Records(folder / "records")
        ops_host.records = records
        target = target_fixture(repository=str(folder))
        plan = plan_fixture(target)
        machine = intro.Introduction(plan=plan, plan_sha256="a" * 64, target=target, production=production_identity(), ops=Linked(),
                                     records=records, repository=folder, host_key="a" * 64, tool=plan["tool"], clock=Clock(), now=lambda: NOW)
        machine.run({"version": 1, "mode": intro.MODE, "phase": "capture", "plan_sha256": "a" * 64, "nonce": "4" * 32}, "4" * 64)
        (result,) = records.directory.glob("result-capture-*.json")
        step = next(item for item in json.loads(result.read_text())["steps"] if item["step"] == "L-01")
        entries = [json.loads(line) for line in (records.directory / step["commands"]["file"]).read_text().splitlines()]
        linked = [entry for entry in entries if step["commands"]["first"] <= entry["seq"] <= step["commands"]["last"]]
        self.assertEqual([(entry["step"], entry["part"], entry["argv"][:2]) for entry in linked],
                         [("L-01", "step", ["git", "rev-parse"]), ("L-01", "step", ["docker", "inspect"])])

    def recovered(self, plan):
        recovery = {"project": self.target["project"] + "-rbabcdef01", "pg": self.target["project"] + "-rbabcdef01_pg-db",
                    "orthanc": self.target["project"] + "-rbabcdef01_orthanc-db", "persisted": False}
        self.write_env(intro.set_env_line((self.repo / ".env").read_bytes(), "COMPOSE_PROJECT_NAME", recovery["project"]).decode())
        ops_host, docker, context = self.host(plan)
        recovery["compose_sha256"] = ops_host.compose_digest_now()
        recovery["env_sha256"] = intro.sha256_bytes((self.repo / ".env").read_bytes())
        failed = {"pg": {"name": self.target["volumes"]["pg"], "created": "2026-10-12T00:00:00Z"},
                  "emr_state": {"name": self.target["volumes"]["emr_state"], "created": "2026-10-12T00:00:01Z"}}
        context.state.update(recovery=recovery, bfail={"manifest_sha256": "6" * 64, "volumes": failed})
        docker.config["plain"] = compose_config(self.target, recovery=recovery)
        for identity in failed.values():
            docker.volumes[identity["name"]] = {"Name": identity["name"], "CreatedAt": identity["created"]}
        for role in intro.ROLES:
            docker.containers[self.target["containers"][role]] = {"Image": plan["previous"]["images"][role], "State": {"Running": True},
                                                                  "Config": {"Labels": {"com.docker.compose.project": recovery["project"]}}}
        for role in ("api", "proxy"):
            docker.tags[recovery["project"] + "-" + role + ":latest"] = plan["previous"]["images"][role]
        return ops_host, docker, context

    def test_68_the_recovery_mapping_is_what_ordinary_operations_resolve(self):
        """IRT-05: after the restore, a plain compose of the checkout (no project flag, no pins) resolves to the recovery
        project and volumes, compose's own image names are the previous images, every service runs there, and the
        failed volumes exist unchanged and detached; otherwise RB-04a refuses."""
        plan = self.plan()
        ops_host, docker, context = self.recovered(plan)
        result = ops_host.recovery_persisted(context)
        self.assertEqual(result["project"], context.state["recovery"]["project"])
        self.assertTrue(context.state["recovery"]["persisted"])
        baseline = json.loads((self.records.directory / "recovery-baseline.json").read_text())
        self.assertEqual(baseline["volumes"], {"pg": context.state["recovery"]["pg"], "orthanc": context.state["recovery"]["orthanc"]})
        self.assertEqual(set(baseline["failed_volumes_kept"]), {"pg", "emr_state"})
        self.assertEqual(docker.mutating(), [])
        failed_pg = self.target["volumes"]["pg"]
        cases = {"plain compose still the original project": lambda d, c: d.config.__setitem__("plain", compose_config(self.target)),
                 "failed volume attached": lambda d, c: d.attached.__setitem__(failed_pg, ["kin-rh-0001-db"]),
                 "failed volume replaced": lambda d, c: d.volumes[failed_pg].__setitem__("CreatedAt", "2026-10-13T00:00:00Z"),
                 "compose image name not the previous one": lambda d, c: d.tags.__setitem__(c.state["recovery"]["project"] + "-api:latest", image("6")),
                 "a service in the old project": lambda d, c: d.containers[self.target["containers"]["db"]]["Config"]["Labels"].__setitem__(
                     "com.docker.compose.project", self.target["project"]),
                 "recovery configuration changed": lambda d, c: self.write_env("PUBLIC_ORIGIN=" + self.target["origin"] + "\n")}
        for name, change in cases.items():
            self.setUp()
            ops_host, docker, context = self.recovered(self.plan())
            change(docker, context)
            with self.subTest(case=name), self.assertRaises(intro.Stop):
                ops_host.recovery_persisted(context)
            self.assertFalse(context.state["recovery"]["persisted"])

    def test_69_env_line_replaces_exactly_one_variable(self):
        raw = b"A=1\nCOMPOSE_PROJECT_NAME=old\n# note\nB=2"
        self.assertEqual(intro.set_env_line(raw, "COMPOSE_PROJECT_NAME", "kin-rh-rb1"), b"A=1\n# note\nB=2\nCOMPOSE_PROJECT_NAME=kin-rh-rb1\n")
        self.assertEqual(intro.parse_env(intro.set_env_line(raw, "COMPOSE_PROJECT_NAME", "x"))["A"], "1")
        refuses(self, intro.set_env_line, raw, "COMPOSE_PROJECT_NAME", "bad value;rm")

    def token(self, issued):
        body = base64.urlsafe_b64encode(json.dumps({"sub": "doctor", "iat": issued}).encode()).decode().rstrip("=")
        return {"access_token": "e30." + body + ".sig", "subject": "doctor"}

    def test_70_the_previous_version_smoke_needs_a_login_after_the_restore_and_every_check(self):
        """IRT-06: an older token, a stubbed result without the worklist/frame, or a refused check never counts."""
        plan = self.plan()
        restored = datetime.now(timezone.utc) - timedelta(minutes=10)
        context_state = {"checkout": "previous", "restored_at": restored.isoformat(), "recovery": {"persisted": True}}
        full = {"health": True, "auth_refusal": True, "member": True, "worklist": True, "frame": True}
        for token, answer, accepted in ((self.token(int(restored.timestamp()) + 60), full, True),
                                        (self.token(int(restored.timestamp()) - 60), full, False),
                                        (self.token(int(restored.timestamp()) + 60), {**full, "worklist": None, "frame": None}, False),
                                        (None, full, False)):
            ops_host, docker, context = self.host(plan, token=token)
            context.state.update(context_state)
            calls = []
            with patch.object(intro, "smoke", side_effect=lambda *a, **k: calls.append(k) or answer):
                if accepted:
                    ops_host.fenced_previous_smoke(context)
                    self.assertEqual(context.state["rollback_smoke"]["worklist_uid"], FRAME_STUDY)
                else:
                    with self.assertRaises(intro.Stop):
                        ops_host.fenced_previous_smoke(context)
                    self.assertIsNone(context.state.get("rollback_smoke"))
            self.assertTrue(all(call["token"] and call["frame"] == plan["smoke"]["frame"] and call["worklist_uid"] == FRAME_STUDY for call in calls))
        # Nothing opens without that proof.
        ops_host, docker, context = self.host(plan, token=self.token(int(restored.timestamp()) + 60))
        context.state.update(context_state)
        refuses(self, ops_host.reopen_previous_ingress, context, message="not proved itself")
        refuses(self, ops_host.restore_jobs_after_rollback, context, message="has not passed")
        self.assertEqual(docker.mutating(), [])

    def test_71_the_smoke_runs_every_check(self):
        """IRT-06: health, refusal, identity, worklist UID and frame bytes; each failure is a refusal."""
        frame = plan_fixture()["smoke"]["frame"]
        payload = b"\x01" * frame["bytes"]
        frame = dict(frame, sha256=intro.sha256_bytes(payload))
        token = self.token(1)
        boundary = "kinframe"
        multipart = (("--" + boundary + "\r\nContent-Type: application/octet-stream\r\n\r\n").encode() + payload
                     + ("\r\n--" + boundary + "--\r\n").encode())
        answers = {"/api/health": (200, "application/json", b'{"ok":true,"auth":true,"memberRights":"ready"}'),
                   "/api/me": (200, "application/json", b'{"sub":"doctor"}'),
                   "/api/studies?limit=100": (200, "application/json", json.dumps({"studies": [{"uid": FRAME_STUDY}]}).encode()),
                   frame["path"]: (200, 'multipart/related; type="application/octet-stream"; boundary=' + boundary, multipart)}

        def fake(origin, path, *, token=None, **kwargs):
            if path == "/api/me" and token is None:
                return 401, "application/json", b"{}"
            return answers[path]
        with patch.object(intro, "https_get", side_effect=fake):
            self.assertTrue(intro.smoke_passed(intro.smoke("https://x.invalid", token=token, frame=frame, worklist_uid=FRAME_STUDY)))
        breaks = {"identity": ("/api/me", (403, "application/json", b'{"code":"AUTH_RIGHTS_PENDING"}')),
                  "worklist": ("/api/studies?limit=100", (200, "application/json", b'{"studies":[]}')),
                  "frame": (frame["path"], (200, 'multipart/related; type="application/octet-stream"; boundary=' + boundary,
                                            multipart.replace(b"\x01", b"\x02")))}
        for name, (path, answer) in breaks.items():
            original = answers[path]
            answers[path] = answer
            with self.subTest(check=name), patch.object(intro, "https_get", side_effect=fake), self.assertRaises(intro.Stop):
                intro.smoke("https://x.invalid", token=token, frame=frame, worklist_uid=FRAME_STUDY)
            answers[path] = original
        with self.assertRaises(intro.Stop):
            intro.smoke("https://x.invalid", token=None, frame=frame, worklist_uid=FRAME_STUDY)


HALO_OVERLAY = (b"services:\n  proxy:\n    networks:\n      halo_reports: {}\n    volumes:\n"
                b"      - /srv/halo-reports/nginx/report.conf:/etc/nginx/conf.d/halo-report.conf:ro\n\n"
                b"networks:\n  halo_reports:\n    external: true\n    name: halo_reports_private\n")
FAKE_BROWSER = r"""
import base64, json, os, sys, time
spec = json.loads(sys.stdin.read())
# A browser that leaves its profile (with the member's session cookie) behind; the redirect is the unresolvable callback.
assert spec["redirect_uri"].startswith("https://kin-smoke-callback.invalid/"), spec["redirect_uri"]
os.makedirs(spec["profile_dir"])
with open(os.path.join(spec["profile_dir"], "Cookies"), "w") as handle:
    handle.write("KEYCLOAK_SESSION=synthetic")
claims = {"sub": spec["username"].replace("kin-smoke-", "id-"), "iat": int(time.time())}
body = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
# The product's sign-in, logout and the refusal of the ended session (statuses as the browser saw them).
product = {"signed_in": True, "logout_status": 204, "old_session_status": 401, "old_cookie_status": 401} if spec["product_session"] else None
print("KIN_RESULT " + json.dumps({"flow": "authorization_code+S256", "browser": "fake", "access_token": "e30." + body + ".sig",
                                  "refresh_token": "refresh-" + spec["client_id"], "subject": claims["sub"], "product_session": product}))
"""


class CommanderAdditionsTests(HostHarness, unittest.TestCase):
    """IRT-11 declared overlay and networks, IRT-12 environment from the running stack, IRT-14 unattended smoke."""

    def production_host(self, *, declared=True):
        """A production-kind target whose host carries a modified docker-compose.prod.yml (the Halo Reports wiring) and
        declares its equivalent overlay; FakeDocker renders a model from the given files the way Compose merges them."""
        self.head = b"services:\n  proxy:\n    networks:\n      default: {}\n      workflow: {}\n"
        self.modified = self.head.replace(b"      workflow: {}\n", b"      workflow: {}\n      halo_reports: {}\n") + b"# + halo bind\n"
        (self.repo / "docker-compose.prod.yml").write_bytes(self.modified)
        (self.repo / "docker-compose.monitor.yml").write_text("services: {}\n")
        # The overlay lives outside the checkout (D1066), e.g. /etc/kin-deploy/overlays/, with the host file it binds.
        self.overlays = self.root / "kin-deploy" / "overlays"
        self.overlays.mkdir(parents=True)
        self.overlay = self.overlays / "docker-compose.halo-reports.yml"
        self.overlay.write_bytes(HALO_OVERLAY)
        self.report_conf = self.root / "halo-reports" / "nginx" / "report.conf"
        self.report_conf.parent.mkdir(parents=True)
        self.report_conf.write_text("# synthetic Halo Reports stand-in\n")
        overlay_text = HALO_OVERLAY.replace(b"/srv/halo-reports/nginx/report.conf", str(self.report_conf).replace("\\", "/").encode())
        self.overlay.write_bytes(overlay_text)
        target = target_fixture("production", str(self.repo))
        target["compose_files"] = ["docker-compose.yml", "docker-compose.prod.yml", str(self.overlay), "docker-compose.monitor.yml"]
        target["external_networks"] = {"proxy": {"halo_reports": "halo_reports_private"}} if declared else {}
        self.halo_bind = {"source": str(self.report_conf), "target": "/etc/nginx/conf.d/halo-report.conf", "read_only": True}
        target["declared_overlays"] = [{"file": str(self.overlay), "sha256": intro.sha256_bytes(overlay_text), "service": "proxy",
                                        "binds": [dict(self.halo_bind)]}]
        target["tracked_overlay_reconcile"] = [{"path": "docker-compose.prod.yml", "expected_sha256_before": intro.sha256_bytes(self.modified),
                                                "override_file": str(self.overlay), "override_sha256": intro.sha256_bytes(overlay_text)}]
        intro.target_valid(target)
        self.target = target
        plan = plan_fixture(target)
        docker = FakeDocker(target, plan)
        docker.blobs["HEAD:docker-compose.prod.yml"] = self.head

        def restored(path):
            (self.repo / path).write_bytes(self.head)
        docker.on_checkout = restored
        self.equivalent = True

        def config_for(args, env):
            files = [args[index + 1] for index, item in enumerate(args) if item == "-f"]
            names = {Path(item).name for item in files}
            prod = Path(next(item for item in files if Path(item).name in ("docker-compose.prod.yml", "head-docker-compose.prod.yml"))).read_bytes()
            halo = b"halo_reports" in prod or ("docker-compose.halo-reports.yml" in names and self.equivalent)
            return compose_config(target, previous_images=plan["previous"]["images"],
                                  extra_networks={"halo_reports": "halo_reports_private"} if halo else None,
                                  extra_binds=[{"type": "bind", **self.halo_bind}] if halo else None)
        docker.config_for = config_for
        ops_host = intro.HostOps(target=target, plan=plan, runner=docker, records=self.records)
        context = SimpleNamespace(plan=plan, plan_sha256="a" * 64, state={"checkout": "previous"}, records=self.records, save=lambda: None,
                                  request_sha256="9" * 64)
        return ops_host, docker, context

    def test_76_a_declared_overlay_replaces_the_modified_file_only_when_the_configuration_is_identical(self):
        """IRT-11: current files, committed file + overlay, and the declared list after the restore must render the same
        model; otherwise nothing changes."""
        ops_host, docker, context = self.production_host()
        done = ops_host.reconcile_checkout(context)["reconciled"][0]
        self.assertEqual(done["state"], "restored to the commit")
        self.assertEqual(len(set(done["config_sha256"].values())), 1)
        self.assertEqual((self.repo / "docker-compose.prod.yml").read_bytes(), self.head)
        self.assertEqual(docker.checkouts, ["docker-compose.prod.yml"])
        self.assertEqual(ops_host.reconcile_checkout(context)["reconciled"][0]["state"], "already the commit")
        cases = {"the overlay renders another configuration": lambda: setattr(self, "equivalent", False),
                 "the overlay's bytes differ": lambda: self.overlay.write_bytes(HALO_OVERLAY + b"# other\n"),
                 "the modified file is not the declared one": lambda: (self.repo / "docker-compose.prod.yml").write_bytes(self.modified + b"#\n")}
        for name, change in cases.items():
            self.setUp()
            ops_host, docker, context = self.production_host()
            change()
            before = (self.repo / "docker-compose.prod.yml").read_bytes()
            with self.subTest(case=name), self.assertRaises(intro.Stop):
                ops_host.reconcile_checkout(context)
            self.assertEqual((self.repo / "docker-compose.prod.yml").read_bytes(), before)
            self.assertEqual(docker.checkouts, [], "nothing is restored when the overlay is not equivalent")

    def test_77_only_declared_external_networks_are_accepted(self):
        """IRT-11: the proxy network check is {default, workflow} plus the manifest's declared networks."""
        self.production_host()
        target = self.target
        images = plan_fixture(target)["previous"]["images"]
        model = resolved_model(target, target_checkout=False, maintenance=False, images=images)
        intro.check_resolved(model, target, target_checkout=False, maintenance=False, images=images)
        undeclared = copy.deepcopy(target)
        undeclared["external_networks"] = {}
        with self.assertRaisesRegex(intro.Stop, "undeclared network"):
            intro.check_resolved(model, undeclared, target_checkout=False, maintenance=False, images=images)
        missing = copy.deepcopy(model)
        missing["service_networks"]["proxy"] = ["default", "workflow"]
        with self.assertRaisesRegex(intro.Stop, "service networks"):
            intro.check_resolved(missing, target, target_checkout=False, maintenance=False, images=images)
        elsewhere = copy.deepcopy(model)
        elsewhere["service_networks"]["api"] = ["default", "halo_reports"]
        with self.assertRaisesRegex(intro.Stop, "service networks"):
            intro.check_resolved(elsewhere, target, target_checkout=False, maintenance=False, images=images)
        for change in (lambda t: t["compose_files"].append("/srv/extra/docker-compose.other.yml"),
                       lambda t: t.__setitem__("compose_files", [t["compose_files"][0], t["compose_files"][2], t["compose_files"][1], t["compose_files"][3]]),
                       lambda t: t["external_networks"].__setitem__("proxy", {"workflow": "x"})):
            bad = copy.deepcopy(target)
            change(bad)
            with self.assertRaises(intro.Stop):
                intro.target_valid(bad)

    def test_78_compose_variables_come_from_the_running_stack(self):
        """IRT-12: a variable the compose files require and the .env lacks takes the value the running container carries
        (here a bind source), recorded as name, hash and place only; an unresolvable one refuses."""
        (self.repo / "docker-compose.prod.yml").write_text("services:\n  proxy:\n    volumes:\n      - type: bind\n"
                                                            "        source: ${KIN_MONITOR_PUBLIC_DIR:?Set it}\n"
                                                            "        target: /var/run/kin-monitor-public\n"
                                                            "  api:\n    environment:\n      X: ${OPTIONAL_THING:-fallback}\n")
        ops_host, docker, context = self.host()
        value = "/home/ubuntu/.kin-monitor-public"

        def config_for(args, env):
            model = compose_config(self.target)
            source = env.get("KIN_MONITOR_PUBLIC_DIR")
            if source:
                model["services"]["proxy"]["volumes"].append({"type": "bind", "source": source, "target": "/var/run/kin-monitor-public"})
            return model
        docker.config_for = config_for
        docker.containers[self.target["containers"]["proxy"]] = {"Image": image("2"), "State": {"Running": False}, "Config": {"Env": []},
                                                                 "Mounts": [{"Destination": "/var/run/kin-monitor-public", "Source": value}]}
        result = ops_host.prepare(context)
        entry = result["resolved_from_running_stack"]["KIN_MONITOR_PUBLIC_DIR"]
        self.assertEqual((entry["sha256"], entry["from"]), (intro.sha256_bytes(value.encode()), ["mount:proxy"]))
        self.assertNotIn("OPTIONAL_THING", result["resolved_from_running_stack"], "a defaulted variable is not required")
        self.assertEqual(context.state["compose_env"]["KIN_MONITOR_PUBLIC_DIR"]["sha256"], entry["sha256"])
        ops_host.compose(["ps"], mutating=False)
        self.assertEqual(docker.calls[-1][:2], ["docker", "compose"])
        # The value itself only in the run directory's private values file (D04), never in a journal, result or command
        # record.
        kept = self.records.directory / intro.COMPOSE_VALUES
        for path in self.records.directory.rglob("*"):
            if path.is_file() and path != kept:
                self.assertNotIn(value.encode(), path.read_bytes(), path.name)
        # The value a later phase finds must be the same one.
        docker.containers[self.target["containers"]["proxy"]]["Mounts"][0]["Source"] = "/tmp/elsewhere"
        refuses(self, ops_host.prepare, context, message="changed")
        # No container carries it and nothing was kept: a refusal.
        docker.containers.pop(self.target["containers"]["proxy"])
        context.state.pop("compose_env")
        kept.unlink()
        refuses(self, ops_host.prepare, context, message="Unresolvable compose variable: KIN_MONITOR_PUBLIC_DIR")
        self.assertEqual(intro.referenced_variables([b"a: ${A}\nb: ${B:-x}\nc: $C\nd: $${D}\n# e: ${E}\nf: ${F:?m}\n"]),
                         {"A": True, "B": False, "C": True, "F": True})

    def unattended_host(self):
        ops_host, docker, context = self.host()
        ops_host.browser_cmd = [sys.executable, "-c", FAKE_BROWSER]
        context.request_sha256 = "c" * 64
        context.state.update(imported_at=(datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat())

        def run_output(args):
            operation = args[args.index("-e") + 3] if "-e" in args else ""
            name = args[args.index("--name") + 1]
            if "kc-smoke-create-member" in name:
                payload = json.loads(args[-1])
                return ("KIN_RESULT " + json.dumps({"id": payload["username"].replace("kin-smoke-", "id-"), "username": payload["username"]}) + "\n").encode()
            if "kc-smoke-create-client" in name:
                return b'KIN_RESULT {"id": "client-id", "client_id": "c"}\n'
            if "kc-smoke-remove" in name:
                return b'KIN_RESULT {"user_absent": true, "client_absent": true}\n'
            return b"KIN_RESULT {}\n" if operation is not None else b""
        docker.run_output = run_output
        docker.psql[intro.SMOKE_MEMBERS_SQL[:40]] = "0"
        return ops_host, docker, context

    def test_79_the_unattended_smoke_writes_the_operator_record_and_removes_its_member(self):
        """IRT-14 (D1062): the member exists before the import, the browser login is that member's, the eight checks
        are the executor's record, and the member is gone before anything reopens."""
        ops_host, docker, context = self.unattended_host()
        member = ops_host.create_smoke_member(context, "release")
        credentials = self.records.directory / member["credentials"]
        password = json.loads(credentials.read_text())["password"]
        if os.name == "posix":
            self.assertEqual(credentials.stat().st_mode & 0o777, 0o600)
        full = {"health": True, "auth_refusal": True, "member": True, "worklist": True, "frame": True}

        def https(origin, path, *, token=None, **kwargs):
            if path == "/api/me":
                return 401, "application/json", b"{}"
            return 200, "application/json", b"[]"
        with patch.object(intro, "smoke", return_value=full), patch.object(intro, "worklist_row", return_value={"uid": FRAME_STUDY, "modality": "CT"}), \
                patch.object(intro, "https_get", side_effect=https), patch.object(intro, "https_post", return_value=(204, b"")):
            result = ops_host.unattended_release_smoke(context, ("127.0.0.1", 19444))
        record = json.loads((self.records.directory / "operator-smoke.json").read_text())
        intro.operator_smoke_valid(record, context.plan_sha256)
        self.assertEqual((record["by"], set(record["checks"])), ("Opus executor (D1062)", set(intro.OPERATOR_SMOKE_CHECKS)))
        self.assertTrue(all(record["checks"].values()) and result["record_sha256"] == context.state["operator_smoke"]["sha256"])
        self.assertEqual(list(self.records.directory.glob("browser-profile-*")), [], "the browser profile is removed after the login")
        ops_host.remove_smoke_member(context)
        self.assertIsNotNone(context.state["smoke_member"]["deleted_at"])
        self.assertFalse(credentials.exists(), "the password does not outlive the member")
        for path in self.records.directory.rglob("*"):
            if path.is_file() and path != credentials:
                self.assertNotIn(password.encode(), path.read_bytes(), path.name)
        # The browser's spec carried the password on stdin only; the command record keeps its hash.
        entries = [json.loads(line) for line in (self.records.directory / self.records.commands_file).read_text().splitlines()]
        self.assertTrue(any(entry["argv"][:1] == [sys.executable] and "input" in entry for entry in entries))

    def test_80_the_unattended_smoke_refuses_anything_short_of_the_members_own_fresh_login(self):
        ops_host, docker, context = self.unattended_host()
        ops_host.create_smoke_member(context, "release")
        full = {"health": True, "auth_refusal": True, "member": True, "worklist": True, "frame": True}
        good = lambda origin, path, *, token=None, **kwargs: (401, "", b"{}") if path == "/api/me" else (200, "", b"[]")
        fake = lambda old, new: [sys.executable, "-c", FAKE_BROWSER.replace(old, new)]
        cases = {"another subject": (fake('replace("kin-smoke-", "id-")', 'replace("kin-smoke-", "other-")'), good, {}),
                 "a login before the import": (None, good, {"imported_at": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()}),
                 "the ended product session still accepted": (fake('"old_session_status": 401', '"old_session_status": 200'), good, {}),
                 "the ended session's cookie still accepted": (fake('"old_cookie_status": 401', '"old_cookie_status": 200'), good, {}),
                 "the product logout not confirmed": (fake('"logout_status": 204', '"logout_status": 409'), good, {}),
                 "no product sign-in": (fake("if spec[\"product_session\"] else None", "if False else None"), good, {}),
                 "a W2 check failing": (None, lambda origin, path, *, token=None, **kwargs: (401, "", b"{}") if path == "/api/me" else (404, "", b""), {})}
        for name, (browser, https, state) in cases.items():
            if browser:
                ops_host.browser_cmd = browser
            context.state.update(state)
            context.state.pop("operator_smoke", None)
            with self.subTest(case=name), patch.object(intro, "smoke", return_value=full), \
                    patch.object(intro, "worklist_row", return_value={"uid": FRAME_STUDY, "modality": "CT"}), \
                    patch.object(intro, "https_get", side_effect=https), patch.object(intro, "https_post", return_value=(204, b"")):
                with self.assertRaises(intro.Stop):
                    ops_host.unattended_release_smoke(context, ("127.0.0.1", 19444))
                self.assertNotIn("operator_smoke", context.state)
            ops_host.browser_cmd = [sys.executable, "-c", FAKE_BROWSER]
            context.state["imported_at"] = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()

    def test_81_nothing_reopens_while_a_smoke_member_exists(self):
        """IRT-14: the reopen refuses when the smoke member was not removed (state) or any smoke member is in the realm."""
        ops_host, docker, context = self.unattended_host()
        docker.psql[intro.SMOKE_MEMBERS_SQL[:40]] = "1"
        refuses(self, ops_host.remove_smoke_member_now, context, message="still exists")
        context.state["recovery"] = {"persisted": True}
        context.state["rollback_smoke"] = {"member": True}
        refuses(self, ops_host.reopen_previous_ingress, context, message="still exists")
        self.assertEqual(docker.mutating(), [])

    def test_89_a_later_smoke_member_first_removes_an_earlier_one_and_its_password(self):
        """IRT-14: a member made after a rollback restored the realm never leaves the release's member record (or its
        password file) behind: the earlier one is removed first."""
        ops_host, docker, context = self.unattended_host()
        first = ops_host.create_smoke_member(context, "release")
        earlier = self.records.directory / first["credentials"]
        self.assertTrue(earlier.is_file())
        context.request_sha256 = "d" * 64
        second = ops_host.create_smoke_member(context, "previous")
        self.assertIsNotNone(first["deleted_at"])
        self.assertFalse(earlier.exists())
        self.assertEqual(context.state["smoke_member"]["username"], second["username"])
        self.assertNotEqual(second["username"], first["username"])
        removals = [call for call in docker.calls if call[:2] == ["docker", "compose"] and "run" in call
                    and any("kc-smoke-remove" in item for item in call)]
        self.assertEqual(len(removals), 1, "one removal of the earlier member")

    def test_85_a_declared_overlay_lives_outside_the_checkout_and_is_in_effect_exactly_as_declared(self):
        """IRT-11 (D1066): the overlay file is outside the checkout, pinned by hash and listed after any rehearsal
        override; its binds are the only host paths a rehearsal may bind outside its checkout, and they must be in the
        resolved model exactly (source, target, read-only); its file and bind sources are checked and recorded."""
        ops_host, docker, context = self.production_host()
        target = self.target
        images = plan_fixture(target)["previous"]["images"]
        model = resolved_model(target, target_checkout=False, maintenance=False, images=images)
        intro.check_resolved(model, target, target_checkout=False, maintenance=False, images=images)
        for name, change in {
                "the overlay inside the checkout": lambda t: (t["declared_overlays"][0].__setitem__("file", str(self.repo / "halo.yml")),
                                                              t["compose_files"].__setitem__(2, str(self.repo / "halo.yml")),
                                                              t["tracked_overlay_reconcile"][0].__setitem__("override_file", str(self.repo / "halo.yml"))),
                "a listed absolute file that is not declared": lambda t: t["compose_files"].append("/etc/kin-deploy/overlays/other.yml"),
                "a declared overlay that is not listed": lambda t: t["compose_files"].remove(str(self.overlay)),
                "the reconcile hash differs from the declaration": lambda t: t["tracked_overlay_reconcile"][0].__setitem__("override_sha256", "0" * 64),
                "a relative bind source": lambda t: t["declared_overlays"][0]["binds"][0].__setitem__("source", "nginx/report.conf")}.items():
            bad = copy.deepcopy(target)
            change(bad)
            with self.subTest(case=name), self.assertRaises(intro.Stop):
                intro.target_valid(bad)
        # The shape: an overlay merged too early loses its bind (Compose's `volumes: !override` of a later file).
        for name, change in {"bind missing": lambda m: m["mounts"]["proxy"].pop(),
                             "bind writable": lambda m: m["mounts"]["proxy"][-1].__setitem__("read_only", False),
                             "bind elsewhere": lambda m: m["mounts"]["proxy"][-1].__setitem__("target", "/etc/nginx/conf.d/other.conf")}.items():
            bad = copy.deepcopy(model)
            change(bad)
            with self.subTest(case=name):
                refuses(self, lambda: intro.check_resolved(bad, target, target_checkout=False, maintenance=False, images=images),
                        message="declared overlay bind is missing")
        # A rehearsal: the override first, then the overlay; only the declared bind may leave the checkout.
        rehearsal = target_fixture("rehearsal", str(self.repo))
        rehearsal.update(compose_files=["docker-compose.yml", "docker-compose.prod.yml", str(self.override), str(self.overlay)],
                         external_networks=copy.deepcopy(target["external_networks"]), declared_overlays=copy.deepcopy(target["declared_overlays"]))
        intro.target_valid(rehearsal)
        early = copy.deepcopy(rehearsal)
        early["compose_files"] = ["docker-compose.yml", "docker-compose.prod.yml", str(self.overlay), str(self.override)]
        refuses(self, intro.target_valid, early, message="after the rehearsal override")
        clone_model = resolved_model(rehearsal, target_checkout=False, maintenance=False)
        check = lambda model: intro.check_resolved(model, rehearsal, target_checkout=False, maintenance=False)
        check(clone_model)
        undeclared = copy.deepcopy(clone_model)
        undeclared["mounts"]["proxy"].append({"type": "bind", "source": str(self.root / "elsewhere.conf"), "target": "/etc/nginx/conf.d/x.conf",
                                              "read_only": True})
        refuses(self, check, undeclared, message="outside its checkout")
        elsewhere = copy.deepcopy(clone_model)
        elsewhere["mounts"]["api"].append(dict(elsewhere["mounts"]["proxy"][-1]))
        refuses(self, check, elsewhere, message="outside its checkout")
        # The host files: the overlay's bytes, its bind source, both recorded (hash; mode and owner on POSIX).
        facts = ops_host.declared_overlay_facts()
        self.assertEqual((facts[0]["sha256"], facts[0]["binds"][0]["sha256"], facts[0]["binds"][0]["kind"]),
                         (target["declared_overlays"][0]["sha256"], intro.sha256_bytes(self.report_conf.read_bytes()), "file"))
        self.report_conf.unlink()
        refuses(self, ops_host.declared_overlay_facts, message="bind source is missing")
        self.report_conf.write_text("# synthetic Halo Reports stand-in\n")
        if os.name == "posix":
            self.overlay.chmod(0o666)
            refuses(self, ops_host.declared_overlay_facts, message="writable by others")
            self.overlay.chmod(0o644)
            self.overlays.chmod(0o777)
            refuses(self, ops_host.declared_overlay_facts, message="writable by others")
            self.overlays.chmod(0o755)
        self.overlay.write_bytes(self.overlay.read_bytes() + b"# changed\n")
        refuses(self, ops_host.declared_overlay_facts, message="differs from the manifest")

    @unittest.skipUnless(shutil.which("docker"), "needs the docker CLI (`docker compose config` only: no container, no daemon change)")
    def test_86_compose_itself_drops_an_overlay_merged_before_the_rehearsal_override(self):
        """IRT-11 (D1066): the product's compose files, the generated rehearsal override (`volumes: !override` on the
        proxy) and the overlay, rendered by Compose: after the override the overlay's bind and network are in the model and
        the check passes; before it, Compose drops the bind and the check refuses."""
        source = Path(__file__).resolve().parents[1]
        for name in ("docker-compose.yml", "docker-compose.prod.yml"):
            (self.repo / name).write_bytes((source / name).read_bytes())
        conf = self.root / "halo-reports" / "report.conf"
        conf.parent.mkdir()
        conf.write_text("# synthetic Halo Reports stand-in\n")
        overlay = self.root / "overlays" / "docker-compose.halo-reports.yml"
        overlay.parent.mkdir()
        overlay.write_text("services:\n  proxy:\n    networks:\n      halo_reports: {}\n    volumes:\n      - type: bind\n        source: "
                           + json.dumps(str(conf)) + "\n        target: /etc/nginx/conf.d/halo-report.conf\n        read_only: true\n\n"
                           "networks:\n  halo_reports:\n    external: true\n    name: halo_reports_private\n", newline="\n")
        target = target_fixture("rehearsal", str(self.repo))
        self.override.write_text(intro.rehearsal_override(target, target["origin"]), newline="\n")
        target.update(external_networks={"proxy": {"halo_reports": "halo_reports_private"}},
                      declared_overlays=[{"file": str(overlay), "sha256": intro.sha256_bytes(overlay.read_bytes()), "service": "proxy",
                                          "binds": [{"source": str(conf), "target": "/etc/nginx/conf.d/halo-report.conf", "read_only": True}]}])
        texts = [path.read_bytes() for path in (self.repo / "docker-compose.yml", self.repo / "docker-compose.prod.yml", self.override, overlay)]
        required = sorted(name for name, needed in intro.referenced_variables(texts).items() if needed)
        self.write_env("".join(name + "=synthetic-placeholder\n" for name in required) + "PUBLIC_ORIGIN=" + target["origin"] + "\n")
        plan = plan_fixture(target, "rehearsal")
        outcomes = {}
        for order, files in (("after", [str(self.override), str(overlay)]), ("before", [str(overlay), str(self.override)])):
            target["compose_files"] = ["docker-compose.yml", "docker-compose.prod.yml", *files]
            ops_host = intro.HostOps(target=target, plan=plan, runner=intro.Runner(self.repo), records=self.records)
            model = ops_host.resolved(SimpleNamespace(plan=plan, state={"checkout": "target"}), maintenance=True)
            self.assertIn("halo_reports", model["service_networks"]["proxy"])
            try:
                intro.check_resolved(model, target, target_checkout=True, maintenance=True, images=plan["release"]["images"])
                outcomes[order] = "accepted"
            except intro.Stop as error:
                outcomes[order] = str(error)
        self.assertEqual(outcomes["after"], "accepted")
        self.assertIn("declared overlay bind is missing", outcomes["before"])

    def test_87_the_seed_refuses_a_clone_certificate_volume_that_is_absent_or_empty(self):
        """D1066: the clone's certificate volume must hold the clone's certificate before the proxy first starts; the
        seed check refuses an absent volume (never creating it) or a failed read-only certificate check, with no change."""
        ops_host, docker, context = self.host()
        result = self.seed_check(ops_host, context)
        self.assertEqual(result["certificate"]["volume"], self.target["project"] + "_proxy-certs")
        check = [call for call in docker.calls if call[:2] == ["docker", "run"]]
        self.assertEqual(len(check), 1)
        self.assertTrue({"--read-only", "none"} <= set(check[0]) and any(item.endswith("target=/certs,readonly") for item in check[0]))
        self.assertEqual(docker.mutating(), [])
        for name, (change, message) in {
                "absent": (lambda d: d.volumes.pop(self.target["project"] + "_proxy-certs"), "certificate volume does not exist"),
                "the CA file missing": (lambda d: Path(self.target["ca_file"]).unlink(), "CA file is missing"),
                "empty or not this origin's": (lambda d: setattr(d, "failing", lambda args: args[:2] == ["docker", "run"]), "certificate volume is empty")}.items():
            self.setUp()
            ops_host, docker, context = self.host()
            change(docker)
            with self.subTest(case=name):
                refuses(self, self.seed_check, ops_host, context, message=message)
                self.assertEqual(docker.mutating(), [])
                if name != "empty or not this origin's":
                    self.assertFalse(any(call[:2] == ["docker", "run"] for call in docker.calls), "no check container (nothing created)")

    def test_88_the_browser_trusts_exactly_the_verified_leaf_key(self):
        """IRT-14 (D1066): the pin is base64(sha256(SPKI)) as openssl computes it (known answer); a malformed certificate
        is refused; the browser spec is refused before any browser starts unless its profile folder is new and the redirect
        is the unresolvable callback."""
        der = base64.b64decode("".join(KAT_CERTIFICATE.strip().splitlines()[1:-1]))
        self.assertEqual(intro.spki_pin(der), KAT_PIN)
        for broken in (der[:-1], b"\x30\x03\x02\x01\x01", der[:40]):
            with self.assertRaises(intro.Stop):
                intro.spki_pin(broken)
        spec = {"origin": "https://localhost:19443", "connect": ["127.0.0.1", 19444], "ca_file": None, "username": "kin-smoke-x",
                "password": "p", "client_id": "c", "redirect_uri": "https://kin-smoke-callback.invalid/kin-smoke-x",
                "profile_dir": str(self.root / "profile")}
        (self.root / "used").mkdir()
        for name, change in {"an existing profile": {"profile_dir": str(self.root / "used")},
                             "a relative profile": {"profile_dir": "profile"},
                             "a redirect that resolves": {"redirect_uri": "https://localhost:19443/kin-smoke-callback"},
                             "a non-loopback ingress": {"connect": ["10.0.0.1", 443]}}.items():
            with self.subTest(case=name), patch.object(intro, "verified_pin", side_effect=AssertionError("no network before the checks")):
                refuses(self, intro.browser_smoke, {**spec, **change})


KAT_CERTIFICATE = """-----BEGIN CERTIFICATE-----
MIIBhDCCASmgAwIBAgIUHMwta1xp38hRm9r5BfdXB95i7a4wCgYIKoZIzj0EAwIw
FjEUMBIGA1UEAwwLa2F0LmludmFsaWQwIBcNMjYxMDEyMTIyMDIwWhgPMjEyNjA5
MTgxMjIwMjBaMBYxFDASBgNVBAMMC2thdC5pbnZhbGlkMFkwEwYHKoZIzj0CAQYI
KoZIzj0DAQcDQgAEkJyl0hyQrt2oSAhUJD/FXfzVfrLDqPb+mMuVLZQFzZe4xU0h
JzwfiQo4JkdUHG0b3pxxWpsSFQ+1uS8Z1nxLv6NTMFEwHQYDVR0OBBYEFCarPFrg
XZdjjSZ1IY6VyxRiSck8MB8GA1UdIwQYMBaAFCarPFrgXZdjjSZ1IY6VyxRiSck8
MA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSQAwRgIhAKD4TkyT+K8Jb5aK
E5fskFBtmacQj376iCIO54dOHeHkAiEAjLtoXmWWTS74kOyTgpxzpgEQBrGmmzV/
6AR2cyf1IN8=
-----END CERTIFICATE-----"""
# openssl x509 -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | openssl base64
KAT_PIN = "PyJTCx3uWmj6EtrTxESiV8YPH/rzxpVd9q3uZb1lR8k="


class UnattendedReopenTests(MachineHarness, unittest.TestCase):
    """IRT-14 at the phase entry: an unattended reopen needs the record verify wrote and a removed smoke member."""

    def test_82_unattended_reopen_requires_the_executor_record_and_no_smoke_member(self):
        self.deploy_through("verify")
        self.ops.unattended = True
        state = self.records.state()
        refuses(self, self.run_phase, "reopen", {}, message="Operator smoke record required")
        record = {"schema": 1, "kind": "operator-smoke", "plan_sha256": self.plan_sha256, "checks": {name: True for name in intro.OPERATOR_SMOKE_CHECKS},
                  "passed": True, "by": intro.SMOKE_BY, "at": NOW.isoformat()}
        digest = self.records.put("operator-smoke.json", record)
        state = self.records.state()
        state.update(operator_smoke={"file": "operator-smoke.json", "sha256": digest},
                     smoke_member={"username": "kin-smoke-x", "deleted_at": None})
        self.records.save(state)
        calls = list(self.ops.calls)
        refuses(self, self.run_phase, "reopen", {}, message="The smoke member still exists")
        self.assertEqual(self.ops.calls, calls)
        state["smoke_member"]["deleted_at"] = NOW.isoformat()
        self.records.save(state)
        self.assertEqual(self.run_phase("reopen", {})["status"], "DEPLOYED")


class Context(SimpleNamespace):
    """What a HostOps step reads of its phase (Introduction's plan, state, records, phase, recovery flag), with the
    warnings a recovery records."""

    def warn(self, kind, **facts):
        self.warnings.append({"kind": kind, **facts})


def process_alive(pid):
    """Whether a process still runs (a zombie waiting for its reaper does not)."""
    if os.name == "posix":
        try:
            with open("/proc/%d/stat" % pid) as handle:
                return handle.read().rsplit(") ", 1)[1][0] != "Z"
        except FileNotFoundError:
            return False
    import ctypes
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.restype = ctypes.c_void_p
    handle = kernel32.OpenProcess(0x1000, False, pid)
    if not handle:
        return False
    try:
        code = ctypes.c_ulong()
        kernel32.GetExitCodeProcess(ctypes.c_void_p(handle), ctypes.byref(code))
        return code.value == 259
    finally:
        kernel32.CloseHandle(ctypes.c_void_p(handle))


MONITOR_COMPOSE = ("services:\n  proxy:\n    volumes:\n      - type: bind\n        source: ${KIN_MONITOR_PUBLIC_DIR:?Set a dedicated public-only "
                   "monitor directory}\n        target: /var/run/kin-monitor-public\n        read_only: true\n")
FAKE_PROBE = r"""
import json, os, sys
spec = json.loads(sys.stdin.read())
assert spec.get("probe") is True and not os.path.exists(spec["profile_dir"]), spec
os.makedirs(spec["profile_dir"])
print("KIN_RESULT " + json.dumps({"probe": "ok", "browser": "chromium fake", "browsers_path": "given"}))
"""
LINGERING_BROWSER = r"""
import json, os, subprocess, sys, time
spec = json.loads(sys.stdin.read())
os.makedirs(spec["profile_dir"], exist_ok=True)
# A child that outlives this process: it inherits the output pipes and sleeps (a Chromium renderer left behind).
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"])
with open(%r, "w") as handle:
    handle.write(str(child.pid))
if %r:
    time.sleep(600)
"""


class RoundThreeHostTests(HostHarness, unittest.TestCase):
    """Round 3 (D1084): the defects round 2 recorded itself, as the commander decided them, against the fixed-binary
    boundary (FakeDocker) and real child processes."""

    def context(self, plan, phase="capture", **state):
        return Context(plan=plan, plan_sha256="a" * 64, state={"checkout": "previous", "lock_token": None, **state}, records=self.records,
                       save=lambda: None, phase=phase, recovering=phase in intro.RECOVERY_PHASES, warnings=[], request_sha256="c" * 64)

    def monitor_stack(self):
        """The production shape of IRT-12/D04: a compose file binds ${KIN_MONITOR_PUBLIC_DIR} into the proxy, the .env lacks
        it, and the running proxy carries it as its bind source."""
        (self.repo / "docker-compose.prod.yml").write_text(MONITOR_COMPOSE, newline="\n")
        ops_host, docker, _ = self.host()
        value = "/home/ubuntu/.kin-monitor-public"

        def config_for(args, env):
            model = compose_config(self.target)
            if env.get("KIN_MONITOR_PUBLIC_DIR"):
                model["services"]["proxy"]["volumes"].append({"type": "bind", "source": env["KIN_MONITOR_PUBLIC_DIR"],
                                                              "target": "/var/run/kin-monitor-public"})
            return model
        docker.config_for = config_for
        docker.containers[self.target["containers"]["proxy"]] = {"Image": image("2"), "State": {"Running": False}, "Config": {"Env": []},
                                                                 "Mounts": [{"Destination": "/var/run/kin-monitor-public", "Source": value}]}
        return ops_host, docker, value

    def test_90_a_value_resolved_from_the_stack_is_kept_for_a_rollback_whose_container_is_gone(self):
        """D04: the capture resolves KIN_MONITOR_PUBLIC_DIR from the proxy's bind and keeps the value in the run's private
        values file. A settled failure at L-09b removed the proxy; the rollback (a new process: nothing in memory) still
        gives every compose command the same value. A kept value that differs from its recorded hash is a refusal."""
        ops_host, docker, value = self.monitor_stack()
        plan = ops_host.plan
        context = self.context(plan)
        ops_host.prepare(context)
        kept = self.records.directory / intro.COMPOSE_VALUES
        self.assertEqual(json.loads(kept.read_text()), {"KIN_MONITOR_PUBLIC_DIR": value})
        if os.name == "posix":
            self.assertEqual(kept.stat().st_mode & 0o777, 0o600)
        docker.containers.pop(self.target["containers"]["proxy"])
        rollback = intro.HostOps(target=self.target, plan=plan, runner=docker, records=self.records)
        context.phase, context.recovering = "rollback", True
        result = rollback.prepare(context)
        self.assertEqual(result["resolved_from_running_stack"]["KIN_MONITOR_PUBLIC_DIR"]["from"], ["kept"])
        rollback.compose(["up", "-d", "--no-deps", "proxy"], mutating=True)
        self.assertEqual(docker.envs[-1].get("KIN_MONITOR_PUBLIC_DIR"), value)
        kept.write_text(json.dumps({"KIN_MONITOR_PUBLIC_DIR": "/tmp/elsewhere"}))
        refuses(self, intro.HostOps(target=self.target, plan=plan, runner=docker, records=self.records).prepare, context,
                message="kept compose value differs")

    def test_91_the_seed_names_each_compose_variable_the_clone_env_lacks(self):
        """D28: before the seed no clone stack runs, so a VM target whose compose files require KIN_MONITOR_PUBLIC_DIR
        needs it in the clone's .env; the seed refuses with the variable and the file named, before any command."""
        (self.repo / "docker-compose.monitor.yml").write_text(MONITOR_COMPOSE, newline="\n")
        self.target["compose_files"] = [*self.target["compose_files"], "docker-compose.monitor.yml"]
        ops_host, docker, _ = self.host()
        context = self.context(ops_host.plan, phase="seed")
        with self.assertRaises(intro.Stop) as caught:
            ops_host.prepare(context)
        self.assertIn("KIN_MONITOR_PUBLIC_DIR (required by docker-compose.monitor.yml)", str(caught.exception))
        self.assertIn("before the seed", str(caught.exception))
        self.assertEqual(docker.calls, [], "no command before the refusal")
        self.write_env((self.repo / ".env").read_text() + "KIN_MONITOR_PUBLIC_DIR=/srv/kin-monitor-public\n")
        self.assertEqual(ops_host.prepare(context)["resolved_from_running_stack"], {})

    def test_92_a_recovery_uses_the_pinned_overlay_when_its_file_changed_or_vanished(self):
        """D05: the plan's first phase pins the declared overlay's verified bytes in its run directory. A recovery whose
        overlay file changed or vanished goes on with those bytes (every compose command and the configuration digest
        read the pinned copy) and records a warning; a forward phase refuses; a pinned copy that differs is no fallback."""
        ops_host, docker, base = CommanderAdditionsTests.production_host(self)
        declared = self.overlay.read_bytes()
        capture = self.context(base.plan)
        ops_host.declared_overlay_facts(capture)
        pin = capture.state["overlay_pins"][str(self.overlay)]
        copy_path = self.records.directory / pin["copy"]
        self.assertEqual(copy_path.read_bytes(), declared)
        expected_digest = ops_host.compose_digest_now()
        for change in ("changed", "vanished"):
            with self.subTest(change=change):
                if change == "changed":
                    self.overlay.write_bytes(declared + b"# changed by hand\n")
                else:
                    self.overlay.unlink()
                forward = self.context(base.plan, phase="introduce", overlay_pins=dict(capture.state["overlay_pins"]))
                refuses(self, ops_host.declared_overlay_facts, forward)
                recovery = self.context(base.plan, phase="rollback", overlay_pins=dict(capture.state["overlay_pins"]))
                facts = ops_host.declared_overlay_facts(recovery)
                self.assertEqual(facts[0]["used"], "pinned copy")
                self.assertEqual([warning["kind"] for warning in recovery.warnings], ["declared-overlay"])
                self.assertIn(str(copy_path), ops_host.compose_files())
                self.assertNotIn(str(self.overlay), ops_host.compose_files())
                self.assertEqual(ops_host.compose_digest_now(), expected_digest)
                self.overlay.write_bytes(declared)
        copy_path.write_bytes(declared + b"#")
        self.overlay.unlink()
        refuses(self, ops_host.declared_overlay_facts, self.context(base.plan, phase="rollback", overlay_pins=dict(capture.state["overlay_pins"])))

    def unattended(self, script):
        ops_host, docker, context = CommanderAdditionsTests.unattended_host(self)
        ops_host.browser_cmd = [sys.executable, "-c", script]
        ops_host.create_smoke_member(context, "release")
        return ops_host, docker, context

    def smoke_patches(self):
        full = {"health": True, "auth_refusal": True, "member": True, "worklist": True, "frame": True}
        https = lambda origin, path, *, token=None, **kwargs: (401, "", b"{}") if path == "/api/me" else (200, "", b"[]")
        return (patch.object(intro, "smoke", return_value=full),
                patch.object(intro, "worklist_row", return_value={"uid": FRAME_STUDY, "modality": "CT"}),
                patch.object(intro, "https_get", side_effect=https), patch.object(intro, "https_post", return_value=(204, b"")))

    def test_95_one_bounded_smoke_retry_before_an_automatic_rollback(self):
        """D07: an unattended release smoke that fails once is retried once - its own login client, a new browser profile,
        within SMOKE_RETRY_S - and the retry and its reason are recorded; both login clients go with the member. A retry
        that fails too, or exceeds its bound, is the step's STOP (the automatic rollback follows)."""
        marker = self.root / "first-attempt"
        flaky = FAKE_BROWSER.replace("spec = json.loads(sys.stdin.read())",
                                     "spec = json.loads(sys.stdin.read())\nimport pathlib\nmark = pathlib.Path(%r)\nif not mark.exists():\n"
                                     "    mark.write_text('1')\n    os.makedirs(spec['profile_dir'])\n"
                                     "    print(json.dumps({'valid': False, 'error': 'synthetic first-attempt failure'}), file=sys.stderr)\n"
                                     "    sys.exit(1)" % str(marker))
        ops_host, docker, context = self.unattended(flaky)
        patches = self.smoke_patches()
        with patches[0], patches[1], patches[2], patches[3]:
            result = ops_host.unattended_release_smoke(context, ("127.0.0.1", 19444))
        self.assertEqual(result["retry"], {"reason": "The smoke browser login failed: synthetic first-attempt failure", "passed": True})
        retry = context.state["smoke_retry"]
        self.assertEqual((retry["passed"], retry["bound_s"], retry["reason"]), (True, intro.SMOKE_RETRY_S, result["retry"]["reason"]))
        self.assertTrue(json.loads((self.records.directory / "operator-smoke.json").read_text())["passed"])
        journal = [json.loads(line) for line in (self.records.directory / "journal.jsonl").read_text().splitlines()]
        self.assertEqual([entry["reason"] for entry in journal if entry["event"] == "smoke-retry"], [retry["reason"]])
        member = context.state["smoke_member"]
        self.assertEqual(len(member["client_ids"]), 2, "the retry made its own login client")
        self.assertEqual(list(self.records.directory.glob("browser-profile-*")), [])
        ops_host.remove_smoke_member(context)
        removal = next(call for call in docker.calls if any("kc-smoke-remove" in item for item in call))
        self.assertEqual(sorted(json.loads(removal[-1])["client_ids"]), sorted(member["client_ids"]))
        for name, script, bound in (("fails twice", FAKE_BROWSER.replace('"logout_status": 204', '"logout_status": 409'), None),
                                    ("retry beyond its bound", flaky.replace("print(\"KIN_RESULT \"", "time.sleep(3)\nprint(\"KIN_RESULT \""), 2)):
            self.setUp()
            marker.unlink(missing_ok=True)
            ops_host, docker, context = self.unattended(script)
            patches = self.smoke_patches()
            with self.subTest(case=name), patches[0], patches[1], patches[2], patches[3], \
                    patch.object(intro, "SMOKE_RETRY_S", bound or intro.SMOKE_RETRY_S):
                with self.assertRaises(intro.Stop) as caught:
                    ops_host.unattended_release_smoke(context, ("127.0.0.1", 19444))
                self.assertIs(context.state["smoke_retry"]["passed"], False)
                self.assertNotIn("operator_smoke", context.state)
                if bound:
                    self.assertIn("exceeded its bound", str(caught.exception))

    def test_96_a_browser_timeout_ends_its_whole_process_tree_and_removes_the_profile(self):
        """D17: a browser that runs past its time - or ends while a child it started keeps running with its pipes - is
        killed with every process it started (POSIX process group / Windows job object), and its profile folder goes."""
        for parent_waits in (True, False):
            pids = self.root / ("pid-%s" % parent_waits)
            ops_host, docker, context = self.unattended(LINGERING_BROWSER % (str(pids), parent_waits))
            with self.subTest(parent_waits=parent_waits), patch.object(intro, "BROWSER_TIMEOUT_S", 4):
                started = time.monotonic()
                refuses(self, ops_host.browser_login, context, message="timed out", connect=("127.0.0.1", 19444))
                self.assertLess(time.monotonic() - started, 60)
                child = int(pids.read_text())
                deadline = time.monotonic() + 10
                while process_alive(child) and time.monotonic() < deadline:
                    time.sleep(0.2)
                self.assertFalse(process_alive(child), "the browser's child outlived the timeout")
                self.assertEqual(list(self.records.directory.glob("browser-profile-*")), [])
            self.setUp()

    def baseline_host(self, *, member=None, browser=None, realm=None):
        """HostOps.baseline (L-01) of a production target against FakeDocker: the previous release as the plan observed it."""
        repo = self.root / "production"
        repo.mkdir()
        for name in ("docker-compose.yml", "docker-compose.prod.yml", "docker-compose.monitor.yml"):
            (repo / name).write_text("services: {}\n")
        (repo / ".env").write_text("POSTGRES_PASSWORD=installer-placeholder-0001\n")
        backups = self.root / "production-backups"
        backups.mkdir()
        target = target_fixture(repository=str(repo))
        plan = plan_fixture(target)
        plan.update(backup_root=str(backups))
        plan["budget"]["min_free_bytes"] = 1024 ** 3
        if member is not None:
            plan["smoke"]["member"] = member or None
        entries = [(name, (repo / name).read_bytes()) for name in target["compose_files"]] + [(".env", (repo / ".env").read_bytes())]
        plan["compose"]["before_sha256"] = intro.compose_digest(entries)
        docker = FakeDocker(target, plan)
        docker.config["pinned"] = compose_config(target, previous_images=plan["previous"]["images"])
        docker.crontab = "".join("0 3 * * * /usr/bin/true # " + tag + "\n" for tag in target["cron"]["tags"])
        docker.image_labels = {"org.opencontainers.image.revision": plan["previous"]["sha"]}
        for role in intro.ROLES:
            docker.containers[target["containers"][role]] = {"Image": plan["previous"]["images"][role], "State": {"Running": True},
                                                             "Mounts": [], "Config": {"Labels": {}}}
        docker.psql = {"_prisma_migrations": json.dumps([[n, c, True, False] for n, c in plan["migrations"]["before"]]),
                       "rolconnlimit": json.dumps(pre_catalog()), "service_account_client_link": json.dumps(plan["members"]),
                       "parent_group": json.dumps(realm or {"roles": ["admin", "clinician", "radiologist"], "top_level_groups": ["hallym", "kin-center"]})}
        ops_host = intro.HostOps(target=target, plan=plan, runner=docker, records=self.records, browser_cmd=browser)
        return ops_host, docker, self.context(plan)

    def test_97_the_smoke_browser_and_the_smoke_member_are_proved_at_l01_before_the_fence(self):
        """D01/D02: L-01 refuses a smoke browser command that is no executable file, a browser that fails or does not end
        within its bound, a planned smoke member whose role or group the realm lacks, and an unattended smoke without a
        planned member; a working browser and a fitting member pass (the probe's profile folder is removed)."""
        good = [sys.executable, "-c", FAKE_PROBE]
        ops_host, docker, context = self.baseline_host(browser=good)
        detail = ops_host.baseline(context)
        self.assertEqual(detail["smoke_browser"]["browser"], "chromium fake")
        self.assertEqual(detail["smoke_member_realm"], {"roles": ["radiologist"], "group": "hallym"})
        self.assertEqual(list(self.records.directory.glob("browser-probe-*")), [])
        cases = {
            "no executable file": ({"browser": [str(self.root / "no-such-browser"), "browser-smoke"]}, "not an executable file"),
            "a browser that fails": ({"browser": [sys.executable, "-c", "import sys, json; print(json.dumps({'error': 'chromium missing'}), "
                                                                       "file=sys.stderr); sys.exit(1)"]}, "probe failed: chromium missing"),
            "a browser that does not end": ({"browser": [sys.executable, "-c", "import time; time.sleep(600)"]}, "timed out"),
            "a role the realm lacks": ({"browser": good, "realm": {"roles": ["clinician"], "top_level_groups": ["hallym"]}},
                                       "roles are not realm roles: radiologist"),
            "a group the realm lacks (or only below another)": ({"browser": good, "realm": {"roles": ["radiologist"], "top_level_groups": ["kin-center"]}},
                                                                "group is not a top-level group of the realm: hallym"),
            "an unattended smoke without a member": ({"browser": good, "member": {}}, "names no smoke member"),
        }
        for name, (options, message) in cases.items():
            self.setUp()
            ops_host, docker, context = self.baseline_host(**options)
            with self.subTest(case=name), patch.object(intro, "BROWSER_PROBE_S", 4):
                refuses(self, ops_host.baseline, context, message=message)
                self.assertEqual(docker.mutating(), [], "L-01 changes nothing")
                self.assertEqual(list(self.records.directory.glob("browser-probe-*")), [])

    @unittest.skipUnless(shutil.which("node"), "needs node (the Linux root fixture has it)")
    def test_98_keycloak_readiness_waits_for_200_and_a_refused_administrator_stops_at_once(self):
        """D18/D19: the administration and serverinfo helpers wait while Keycloak answers 404 (realms still loading) and
        then work; a refused administrator ends the helper at once (no two-minute wait)."""
        import http.server
        import threading
        answers = {}
        seen = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def respond(self):
                path = self.path.split("?")[0]
                seen.append((self.command, path))
                queue = answers.get((self.command, path)) or answers.get(("*", path)) or [(200, [])]
                status, body = queue.pop(0) if len(queue) > 1 else queue[0]
                raw = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
            do_GET = do_POST = do_PUT = do_DELETE = respond
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.shutdown)
        env = {**os.environ, "KC_ADMIN_URL": "http://127.0.0.1:%d" % server.server_address[1], "KIN_KC_ADMIN_USER": "admin",
               "KIN_KC_ADMIN_PASSWORD": "synthetic"}
        token = [(200, {"access_token": "t"})]
        info = {"providers": {"userSessions": {"providers": {"infinispan": {"operationalInfo": {"useCaches": "false"}}}}},
                "features": [{"name": "PERSISTENT_USER_SESSIONS", "enabled": True}]}
        answers.update({("GET", "/realms/master"): [(404, {}), (200, {})], ("POST", "/realms/master/protocol/openid-connect/token"): token,
                        ("GET", "/admin/serverinfo"): [(404, {}), (200, info)]})
        out = subprocess.run(["node", "-e", intro.SERVERINFO_SCRIPT], env=env, capture_output=True, timeout=120)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(intro.result_line(out.stdout), {"useCaches": "false", "persistentUserSessions": True})
        self.assertEqual(seen.count(("GET", "/realms/master")), 2)
        self.assertEqual(seen.count(("GET", "/admin/serverinfo")), 2)
        seen.clear()
        answers.update({("GET", "/realms/kin"): [(404, {}), (404, {}), (200, {})], ("POST", "/realms/master/protocol/openid-connect/token"): token,
                        ("GET", "/admin/realms/kin/users"): [(200, [])], ("GET", "/admin/realms/kin/clients"): [(200, [])]})
        payload = json.dumps({"username": "kin-smoke-x", "client_ids": ["kin-smoke-x-client", "kin-smoke-x-client-2"]})
        out = subprocess.run(["node", "-e", intro.SMOKE_ADMIN_SCRIPT, "remove", payload], env=env, capture_output=True, timeout=120)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(intro.result_line(out.stdout), {"user_absent": True, "client_absent": True})
        self.assertEqual(seen.count(("GET", "/realms/kin")), 3)
        self.assertEqual(seen.count(("GET", "/admin/realms/kin/clients")), 4, "each login client is looked up before and after")
        answers[("POST", "/realms/master/protocol/openid-connect/token")] = [(401, {})]
        for script, args in ((intro.SERVERINFO_SCRIPT, []), (intro.SMOKE_ADMIN_SCRIPT, ["remove", payload])):
            started = time.monotonic()
            out = subprocess.run(["node", "-e", script, *args], env=env, capture_output=True, timeout=120)
            self.assertNotEqual(out.returncode, 0)
            self.assertIn(b"admin", out.stderr)
            self.assertLess(time.monotonic() - started, 30, "a refused administrator stops at once")


class RoundThreeMachineTests(MachineHarness, unittest.TestCase):
    """Round 3 at the phase level: the D12 receipt clock and the recorded warnings and kept values of a plan."""

    def test_101_a_receipt_tolerates_five_minutes_of_clock_skew_and_the_skew_is_recorded(self):
        """D12: the rehearsal host's clock may run up to five minutes ahead of production's (receipt 'in the future') or
        behind it (receipt 'before' the B0 it rehearsed); more is refused; what was observed is recorded at admission."""
        plan, production = plan_fixture(), production_identity()
        now = datetime.now(timezone.utc)
        for created, b0, accepted in ((now + timedelta(minutes=4), None, True), (now + timedelta(minutes=6), None, False),
                                      (now - timedelta(hours=1), now - timedelta(hours=1) + timedelta(minutes=4), True),
                                      (now - timedelta(hours=1), now - timedelta(hours=1) + timedelta(minutes=6), False)):
            receipt = receipt_fixture(plan, created=created)
            with self.subTest(created=created.isoformat(), b0=b0 and b0.isoformat()):
                check = lambda: intro.receipt_valid(receipt, plan, "8" * 64, production, now=now, b0_created_utc=b0 and b0.isoformat())
                if accepted:
                    check()
                else:
                    refuses(self, check)
        self.run_phase("capture")
        evidence = {"local-restore": receipt_fixture(plan_fixture(target_fixture(repository=str(self.repository))),
                                                     created=NOW + timedelta(minutes=3))}
        self.assertEqual(self.run_phase("introduce", evidence)["status"], "INTRODUCED")
        journal = [json.loads(line) for line in (self.records.directory / "journal.jsonl").read_text().splitlines()]
        start = next(entry for entry in journal if entry["event"] == "phase-start" and entry["phase"] == "introduce")
        self.assertEqual(start["receipt_clock"], {"tolerance_s": 300, "ahead_of_production_s": 180.0})

    def test_94_recovery_warnings_are_in_the_result_and_the_kept_values_end_with_the_plan(self):
        """D05/D06: warnings handed to a phase (the entry's) or recorded by its steps are in its result, its result file
        and its phase-start record. D04: the private values file is kept while the plan runs and removed when it ends."""
        self.deploy_through("introduce")
        values = self.records.directory / intro.COMPOSE_VALUES
        values.write_text('{"KIN_MONITOR_PUBLIC_DIR":"/srv/x"}\n')
        machine = self.machine({})
        machine.warnings = [{"kind": "checkout-mode", "reason": "A path component is writable by others", "modes": {"checkout": "0o775"}}]

        class Warning(FakeOps):
            def effect_classify(self, context):
                context.warn("declared-overlay", file="/etc/kin-deploy/overlays/x.yml", reason="A declared overlay is missing")
        self.ops = Warning()
        machine.ops = self.ops
        request = {"version": 1, "mode": intro.MODE, "phase": "rollback", "plan_sha256": self.plan_sha256, "nonce": "5" * 32}
        result = machine.run(request, "5" * 64)
        self.assertEqual(result["status"], "RESTORED")
        self.assertEqual([warning["kind"] for warning in result["warnings"]], ["checkout-mode", "declared-overlay"])
        (written,) = self.records.directory.glob("result-rollback-*.json")
        self.assertEqual(json.loads(written.read_text())["warnings"], result["warnings"])
        self.assertTrue(values.exists(), "kept while the plan still holds its lock")
        self.assertEqual(self.run_phase("rollback_reopen")["status"], "ROLLED_BACK")
        self.assertFalse(values.exists(), "removed when the plan ended")


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
        # The checkout's own mode is judged per request (IRT-13: only a declared capture correction may meet it open).
        host = intro.IntroductionHost(self.policy_path)
        raw = self.request()
        self.approve(raw)
        with self.assertRaisesRegex(intro.Stop, "writable by others"):
            host.execute(raw)
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

    def installed_run(self, *, prepare=None, target_changes=None):
        """A real IntroductionHost.execute of a capture request on the protected install: policy, documents, approval,
        one-use marker, HostRecords and the state machine are the product's; only the fixed binaries answer from
        FakeDocker. The plan's window is now, so L-04a (the fence's crontab write, made to fail) is the first refusal."""
        import time as clock
        repo = self.repo
        for name in ("docker-compose.yml", "docker-compose.prod.yml", "docker-compose.monitor.yml"):
            (repo / name).write_text("services: {}\n")
        (repo / ".env").write_text("POSTGRES_PASSWORD=installer-placeholder-0001\n")
        (repo / ".env").chmod(0o600)
        backups = self.root / "backups"
        backups.mkdir(mode=0o700, exist_ok=True)
        target = target_fixture(repository=str(repo))
        target.update(target_changes or {})
        self.document("emr-targets", target)
        plan = plan_fixture(target)
        now = datetime.now(timezone.utc)
        entries = [(name, (repo / name).read_bytes()) for name in target["compose_files"]] + [(".env", (repo / ".env").read_bytes())]
        plan.update(window={"start": (now - timedelta(hours=1)).isoformat(), "end": (now + timedelta(hours=2)).isoformat()},
                    backup_root=str(backups), tool=intro.tool_hashes())
        plan["compose"]["before_sha256"] = intro.compose_digest(entries)
        plan["budget"]["min_free_bytes"] = 1024 ** 3
        plan_sha = self.document("emr-plans", plan)
        docker = FakeDocker(target, plan)
        docker.config["pinned"] = compose_config(target, previous_images=plan["previous"]["images"])
        docker.crontab = "".join("0 3 * * * /usr/bin/true # " + tag + "\n" for tag in target["cron"]["tags"])
        docker.image_labels = {"org.opencontainers.image.revision": plan["previous"]["sha"]}
        for role in intro.ROLES:
            docker.containers[target["containers"][role]] = {"Image": plan["previous"]["images"][role], "State": {"Running": True},
                                                             "Mounts": [], "Config": {"Labels": {}}}
        docker.psql = {"_prisma_migrations": json.dumps([[n, c, True, False] for n, c in plan["migrations"]["before"]]),
                       "rolconnlimit": json.dumps(pre_catalog()), "service_account_client_link": json.dumps(plan["members"])}
        docker.failing = lambda args: args[:1] == ["crontab"] and args[-1] == "-"
        if prepare:
            prepare(self.state / "emr-runs" / plan_sha)
        raw = json.dumps({"version": 1, "mode": intro.MODE, "phase": "capture", "plan_sha256": plan_sha,
                          "nonce": os.urandom(16).hex()}).encode()
        self.approve(raw)
        with patch.object(intro, "Runner", lambda *a, **k: docker), patch.object(intro, "local_host_key", lambda: "a" * 64):
            result = intro.IntroductionHost(self.policy_path).execute(raw)
        del clock
        return result, self.state / "emr-runs" / plan_sha, docker

    def test_72_the_installed_entry_writes_its_first_helper_log_and_its_phase_result(self):
        """IRT-01: the protected install creates its own 0700 run and logs directories and records the first helper's
        stdout/stderr (0600) and the phase result."""
        result, runs, docker = self.installed_run()
        self.assertEqual((result["status"], result["phase_passed"]), ("CAPTURE_FAILED", False), result)
        self.assertEqual([(step["step"], step["outcome"]) for step in result["steps"]],
                         [("L-00a", "PASS"), ("L-00b", "PASS"), ("L-01", "PASS"), ("L-04a", "STOP")])
        helper = sorted((runs / "logs").glob("*-kc-serverinfo-*.out"))
        self.assertEqual(len(helper), 1)
        self.assertIn(b"KIN_RESULT", helper[0].read_bytes())
        self.assertTrue(helper[0].with_suffix(".err").is_file())
        for path in (runs, runs / "logs"):
            info = path.lstat()
            self.assertEqual((info.st_uid, info.st_mode & 0o777), (0, 0o700), path)
        for path in [*runs.glob("*.json*"), *(runs / "logs").iterdir()]:
            self.assertEqual(path.lstat().st_mode & 0o777, 0o600, path.name)
        self.assertEqual(len(list(runs.glob("result-capture-*.json"))), 1)
        self.assertTrue(any(runs.glob("commands-capture-*.jsonl")))
        self.assertIsNone(json.loads((runs / "state.json").read_text())["running"])

    def test_73_a_linked_foreign_or_open_logs_directory_is_still_refused(self):
        """IRT-01: creating the directories never relaxes the protected-path rule."""
        elsewhere = self.root / "elsewhere"
        elsewhere.mkdir(mode=0o700)
        cases = {"link": lambda runs: (runs.mkdir(mode=0o700), (runs / "logs").symlink_to(elsewhere, target_is_directory=True)),
                 "open mode": lambda runs: (runs.mkdir(mode=0o700), (runs / "logs").mkdir(mode=0o700), (runs / "logs").chmod(0o755)),
                 "other owner": lambda runs: (runs.mkdir(mode=0o700), (runs / "logs").mkdir(mode=0o700), os.chown(runs / "logs", 1000, 1000))}
        for name, prepare in cases.items():
            with self.subTest(case=name):
                result, runs, docker = self.installed_run(prepare=prepare)
                # The pre-fence checks write no log; the first step that does (L-01's first helper) stops, nothing after it runs.
                self.assertEqual([(step["step"], step["outcome"]) for step in result["steps"]],
                                 [("L-00a", "PASS"), ("L-00b", "PASS"), ("L-01", "STOP")], result)
                self.assertEqual(result["steps"][-1]["code"], "Invalid protected deployment state")
                self.assertFalse(any(call[:1] == ["crontab"] and call[-1] == "-" for call in docker.calls), "the fence never ran")
                self.assertEqual(list(elsewhere.iterdir()), [])
                shutil.rmtree(runs)
                self.setUp()
                elsewhere.mkdir(mode=0o700, exist_ok=True)

    def test_83_a_declared_checkout_mode_correction_is_applied_recorded_and_then_checked(self):
        """IRT-13: an open checkout (0775, .git 0775) passes only with fix_checkout_mode: the capture's L-00a makes it 0700
        and its .git 0755 (no recursion), records both modes, and the privacy check then runs as usual."""
        (self.repo / "inner").mkdir(mode=0o775)
        self.repo.chmod(0o775)
        (self.repo / ".git").chmod(0o775)
        (self.repo / "inner").chmod(0o775)
        result, runs, docker = self.installed_run(target_changes={"fix_checkout_mode": True})
        first = json.loads(next(runs.glob("result-capture-*.json")).read_text())["steps"][0]
        self.assertEqual((first["step"], first["outcome"]), ("L-00a", "PASS"))
        self.assertEqual(first["detail"], {"fixed": True, "before": {"checkout": "0o775", ".git": "0o775"},
                                           "after": {"checkout": "0o700", ".git": "0o755"}})
        self.assertEqual(((self.repo.stat().st_mode & 0o777), ((self.repo / "inner").stat().st_mode & 0o777)), (0o700, 0o775))
        self.assertEqual(result["status"], "CAPTURE_FAILED", "the run went on past L-00a (to the fence made to fail)")

    def test_84_an_open_checkout_without_the_declaration_is_refused_before_any_step(self):
        self.repo.chmod(0o775)
        with self.assertRaises(RuntimeError):
            self.installed_run()
        self.assertEqual((self.repo.stat().st_mode & 0o777), 0o775)
        self.assertFalse(any((self.state / "emr-runs").iterdir()))

    def test_74_two_approved_host_entries_never_act_together(self):
        """IRT-04 through the installed entry: of two distinct approved introduce requests, one acts, the other is refused."""
        import threading
        target = target_fixture(repository=str(self.repo))
        plan = plan_fixture(target)
        now = datetime.now(timezone.utc)
        plan.update(window={"start": (now - timedelta(hours=1)).isoformat(), "end": (now + timedelta(hours=2)).isoformat()},
                    tool=intro.tool_hashes())
        plan_sha = self.document("emr-plans", plan)
        runs = self.state / "emr-runs" / plan_sha
        runs.mkdir(mode=0o700)
        token = intro.acquire_lock(self.repo)
        state = intro.new_state(plan_sha, plan)
        state.update(status="HELD", lock_token=token, b0={"dir": "/b0", "manifest_sha256": "8" * 64}, fenced={"running_before": []})
        self.write(runs / "state.json", state)
        evidence = self.document("emr-evidence", receipt_fixture(plan))
        entered, release = threading.Event(), threading.Event()

        class Blocking(FakeOps):
            def effect_recheck_fence(self, context):
                entered.set()
                release.wait(10)
                return {}
        shared = Blocking()
        requests = [json.dumps({"version": 1, "mode": intro.MODE, "phase": "introduce", "plan_sha256": plan_sha,
                                "nonce": str(index) * 32}).encode() for index in (1, 2)]
        for raw in requests:
            self.approve(raw, {"local-restore": evidence})
        results = {}
        with patch.object(intro, "HostOps", lambda **kwargs: shared), patch.object(intro, "local_host_key", lambda: "a" * 64):
            first = threading.Thread(target=lambda: results.__setitem__("first", intro.IntroductionHost(self.policy_path).execute(requests[0])))
            first.start()
            self.assertTrue(entered.wait(10))
            results["second"] = intro.IntroductionHost(self.policy_path).execute(requests[1])
            release.set()
            first.join(10)
        self.assertEqual((results["second"]["status"], results["second"]["code"]), ("REJECTED", "Another phase of this plan is running"))
        self.assertEqual(results["first"]["status"], "INTRODUCED")
        self.assertEqual(shared.calls.count("migrate"), 1)

    def test_51_documents_are_bound_by_their_hash(self):
        host = intro.IntroductionHost(self.policy_path)
        path = self.state / "emr-plans" / (self.plan_sha + ".json")
        path.write_bytes(path.read_bytes() + b" ")
        path.chmod(0o600)
        raw = self.request()
        self.approve(raw)
        with self.assertRaisesRegex(intro.Stop, "Document bytes differ"):
            host.execute(raw)

    def test_93_a_rollback_goes_on_with_a_reopened_checkout_mode_and_records_it_forward_phases_refuse(self):
        """D06: after the capture the checkout (0700) and its .git were opened again (chmod 0775). A rollback request is
        not refused for that: it runs, and its result, result file and phase-start record carry the warning with the
        modes; introduce and verify requests keep refusing; an ownership change still refuses the rollback too."""
        target = target_fixture(repository=str(self.repo))
        plan = plan_fixture(target)
        now = datetime.now(timezone.utc)
        plan.update(window={"start": (now - timedelta(hours=1)).isoformat(), "end": (now + timedelta(hours=2)).isoformat()},
                    tool=intro.tool_hashes())
        plan_sha = self.document("emr-plans", plan)
        runs = self.state / "emr-runs" / plan_sha
        runs.mkdir(mode=0o700)
        token = intro.acquire_lock(self.repo)
        state = intro.new_state(plan_sha, plan)
        state.update(status="INTRODUCED", lock_token=token, db_changed=True, checkout="target",
                     b0={"dir": "/b0", "manifest_sha256": "8" * 64}, fenced={"running_before": []})
        self.write(runs / "state.json", state)
        self.repo.chmod(0o775)
        (self.repo / ".git").chmod(0o775)
        shared = FakeOps()

        def request(phase):
            raw = json.dumps({"version": 1, "mode": intro.MODE, "phase": phase, "plan_sha256": plan_sha, "nonce": os.urandom(16).hex()}).encode()
            self.approve(raw)
            return raw
        with patch.object(intro, "HostOps", lambda **kwargs: shared), patch.object(intro, "local_host_key", lambda: "a" * 64):
            for phase in ("introduce", "verify"):
                with self.subTest(phase=phase), self.assertRaisesRegex(RuntimeError, "Invalid protected deployment state"):
                    intro.IntroductionHost(self.policy_path).execute(request(phase))
            self.assertEqual(shared.calls, [], "no forward step ran")
            result = intro.IntroductionHost(self.policy_path).execute(request("rollback"))
        self.assertEqual(result["status"], "RESTORED", result)
        (warning,) = result["warnings"]
        self.assertEqual((warning["kind"], warning["modes"]), ("checkout-mode", {"checkout": "0o775", ".git": "0o775"}))
        (written,) = runs.glob("result-rollback-*.json")
        self.assertEqual(json.loads(written.read_text())["warnings"], result["warnings"])
        journal = [json.loads(line) for line in (runs / "journal.jsonl").read_text().splitlines()]
        start = [entry for entry in journal if entry["event"] == "phase-start" and entry["phase"] == "rollback"]
        self.assertEqual(start[0]["warnings"], result["warnings"])
        # Owner and links are still the rule for a rollback.
        state = json.loads((runs / "state.json").read_text())
        state.update(status="INTRODUCED", rollback_attempted=False)
        self.write(runs / "state.json", state)
        os.chown(self.repo / ".git", 1000, 1000)
        with patch.object(intro, "HostOps", lambda **kwargs: shared), patch.object(intro, "local_host_key", lambda: "a" * 64), \
                self.assertRaises(RuntimeError):
            intro.IntroductionHost(self.policy_path).execute(request("rollback"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
