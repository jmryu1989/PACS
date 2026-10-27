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
from pathlib import Path, PureWindowsPath
import shutil
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import ops_backup as ops
import ops_deploy_preflight as pre
import ops_emr_introduction as intro

ACTION_CONTRACT = {
    "capture": (("L-00a", "checkout_mode"), ("L-00b", "reconcile_checkout"), ("L-01", "baseline"),
                ("L-04a", "fence"), ("L-04b", "capture_b0"), ("L-04c", "restore_check_b0")),
    "release": (("RL-01", "unfence"), ("RL-02", "public_check_previous")),
    "introduce": (("I-00", "recheck_fence"), ("L-06a", "storage"), ("L-06b", "provision"), ("L-07", "migrate"),
                  ("L-08a", "keycloak"), ("L-08b", "member_import"), ("L-09a", "api"), ("L-09b", "proxy_ui")),
    "verify": (("L-10a", "fenced_smoke"), ("L-10b", "probe"), ("L-10c", "capture_b1"), ("L-10d", "resume"),
               ("L-10e", "remove_smoke_member")),
    "reopen": (("L-11a", "final_allowlist"), ("L-11b", "restore_jobs"), ("L-11c", "reopen_ingress"), ("L-11d", "public_smoke")),
    "rollback": (("RB-00", "classify"), ("RB-01", "preserve_failed"), ("RB-02", "restore_b0"), ("RB-03", "previous_services")),
    "rollback_reopen": (("RB-04a", "recovery_persisted"), ("RB-04b", "fenced_previous_smoke"),
                        ("RB-04c", "restore_jobs_after_rollback"), ("RB-04d", "reopen_previous_ingress"), ("RB-04e", "public_previous_smoke")),
    "seed": (("S-01", "seed_check"), ("S-02", "seed_restore"), ("S-03", "seed_services")),
    "receipt": (("RC-01", "write_receipt"),),
}
CONTRACT_DONE = {"capture":"HELD","release":"RELEASED","introduce":"INTRODUCED","verify":"VERIFIED","reopen":"DEPLOYED",
                 "rollback":"RESTORED","rollback_reopen":"ROLLED_BACK","seed":"SEEDED","receipt":"RECEIPTED"}

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
        # Minimal synthetic model for individual invariants. Protected-entry fixtures below use the complete
        # operational list, including the real Halo logical path and an independently hashed synthetic overlay.
        target.update(compose_files=["docker-compose.yml", "docker-compose.prod.yml", "docker-compose.monitor.yml"],
                      external_networks={}, declared_overlays=[])
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
                      "steps": [[sid, "PASS"] for sid, _ in ACTION_CONTRACT[phase]]}
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
                                    "probe": {"added": 1, "replay_duplicates": 0, "restart": "same PostgreSQL outcome and entry", "evidence_sha256": "5" * 64}},
                         "rollback": {"bfail_manifest_sha256": "6" * 64, "recovery": recovery},
                         "rollback_reopen": {"recovery_persisted": True,
                                             "smoke": {"member": True, "token_after_restore": True, "worklist_uid": FRAME_STUDY,
                                                       "frame_sha256": frame["sha256"], "frame_bytes": frame["bytes"]}}},
            "journal_sha256": "7" * 64, "journal_bytes": 1024, "created_utc": created.isoformat()}
    body.update(changes)
    return body


def receipt_bundle(plan, folder, *, created=None, receipt_id="1" * 32, details=None, status=None):
    """A receipt and the producer run bundle it hashes (IRT2-01): one result file per rehearsal phase as finish() writes it
    (the steps with the details the real steps record) and a journal with each phase's start and passing end. details /
    status replace what one step recorded or how one phase ended, for the refusals."""
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    body = receipt_fixture(plan, created=created, receipt_id=receipt_id)
    rehearsal_plan = plan_fixture(target_fixture("rehearsal"), kind="rehearsal")
    rehearsal_plan["target_manifest_sha256"] = body["rehearsal_target_manifest_sha256"]
    rehearsal_plan["seed"]["production_plan_sha256"] = body["production_plan_sha256"]
    body["rehearsal_plan_sha256"] = intro.plan_identity(rehearsal_plan)
    (folder / "plan.json").write_bytes(intro.canonical(rehearsal_plan))
    recovery = body["evidence"]["rollback"]["recovery"]
    recorded = {("seed", "S-01"): {"source_manifest_sha256": body["source_b0_manifest_sha256"]},
                ("capture", "L-04b"): {"manifest_sha256": body["rehearsal_b0_manifest_sha256"]}, ("capture", "L-04c"): {"success": True},
                ("verify", "L-10b"): dict(body["evidence"]["verify"]["probe"]),
                ("verify", "L-10c"): {"manifest_sha256": body["rehearsal_b1_manifest_sha256"], "restore_check": {"success": True}},
                ("rollback", "RB-01"): {"manifest_sha256": body["bfail_manifest_sha256"]}, ("rollback", "RB-02"): {"recovery": dict(recovery)},
                ("rollback_reopen", "RB-04a"): {"project": recovery["project"]},
                ("rollback_reopen", "RB-04b"): {"health": True, "auth_refusal": True, "member": True, "worklist": True, "frame": True}}
    recorded.update(details or {})
    events = []
    for phase in intro.RECEIPT_PHASES:
        item = body["phases"][phase]
        steps = [{"step": sid, "outcome": "PASS", "detail": recorded.get((phase, sid), {})} for sid, _ in ACTION_CONTRACT[phase]]
        ended = (status or {}).get(phase, CONTRACT_DONE[phase])
        raw = intro.canonical({"steps": steps, "status": ended, "phase": phase, "request_sha256": item["request_sha256"],
                               "plan_sha256": body["rehearsal_plan_sha256"], "commands_file": "commands.jsonl"}) + b"\n"
        (folder / ("result-" + phase + "-" + item["request_sha256"][:16] + ".json")).write_bytes(raw)
        item["result_sha256"] = intro.sha256_bytes(raw)
        events += [{"event": "phase-start", "plan_sha256": body["rehearsal_plan_sha256"], "phase": phase, "request_sha256": item["request_sha256"]},
                   {"event": "phase-end", "plan_sha256": body["rehearsal_plan_sha256"], "phase": phase, "status": ended}]
    journal = b"".join(intro.canonical(event) + b"\n" for event in events)
    (folder / "journal.jsonl").write_bytes(journal)
    body.update(journal_sha256=intro.sha256_bytes(journal), journal_bytes=len(journal))
    return body, intro.DirectoryBundle(folder)


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

    def bundled(self, plan, **kwargs):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        return receipt_bundle(plan, Path(folder.name) / "bundle", **kwargs)

    def test_12_local_restore_receipt_replaces_offsite_only_for_the_same_release_and_snapshot(self):
        plan, production = plan_fixture(), production_identity()
        receipt, bundle = self.bundled(plan)
        intro.receipt_valid(receipt, plan, "8" * 64, production, bundle=bundle)
        cases = {"another snapshot": {"source_b0_manifest_sha256": "7" * 64}, "another release": {"plan_core_sha256": "0" * 64},
                 "production host": {"host_key_sha256": "a" * 64}, "offsite kind": {"kind": "offsite-restore"},
                 "not passed": {"passed": False}, "another tool": {"tool": {name: "1" * 64 for name in intro.TOOL_FILES}},
                 "old schema": {"schema": 1}}
        # Each case: the admitted receipt with its own bundle and one change (never refused only for a missing bundle).
        for name, change in cases.items():
            with self.subTest(case=name):
                body = {**copy.deepcopy(receipt), **change}
                refuses(self, lambda: intro.receipt_valid(body, plan, "8" * 64, production, bundle=bundle))
        missing = copy.deepcopy(receipt)
        del missing["phases"]["rollback"]
        refuses(self, lambda: intro.receipt_valid(missing, plan, "8" * 64, production, bundle=bundle), message="phases")

    def test_59_a_receipt_binds_its_run_artifacts_plan_host_and_one_use(self):
        """IRT-02: every way a receipt can be other than one real rehearsal of this plan's B0 is refused."""
        plan, production = plan_fixture(), production_identity()
        now = datetime.now(timezone.utc)
        good, bundle = self.bundled(plan)
        self.assertIs(intro.receipt_valid(good, plan, "8" * 64, production, now=now, b0_created_utc=(now - timedelta(days=1)).isoformat(),
                                          bundle=bundle), good)

        # Each case is the admitted receipt (with its own bundle) and exactly one change, so a case is refused by its own
        # rule, not by a receipt that never matched the bundle.
        def variant(created=None, **changes):
            body = copy.deepcopy(good)
            body.update(changes)
            if created is not None:
                body["created_utc"] = created.isoformat()
            return body

        def phases(change):
            body = variant()
            change(body["phases"])
            return body

        def evidence(change):
            body = variant()
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
            "another B1": variant(rehearsal_b1_manifest_sha256="0" * 64),
            "another B0 of the rehearsal": variant(rehearsal_b0_manifest_sha256="0" * 64),
            "another Bfail": variant(bfail_manifest_sha256="0" * 64),
            "B1 restore check missing": evidence(lambda e: e["verify"].__setitem__("b1_restore_check", False)),
            "probe replayed twice": evidence(lambda e: e["verify"]["probe"].__setitem__("replay_duplicates", 1)),
            "recovery volume of another project": evidence(lambda e: e["rollback"]["recovery"].__setitem__("pg", "pacs-starter-kit_pg-db")),
            "recovery never persisted": evidence(lambda e: e["rollback_reopen"].__setitem__("recovery_persisted", False)),
            "rollback smoke on another frame": evidence(lambda e: e["rollback_reopen"]["smoke"].__setitem__("frame_sha256", "0" * 64)),
            "rollback smoke without the worklist": evidence(lambda e: e["rollback_reopen"]["smoke"].__setitem__("worklist_uid", "9.9")),
            "rollback smoke with an old token": evidence(lambda e: e["rollback_reopen"]["smoke"].__setitem__("token_after_restore", False)),
            "another rehearsal host": variant(host_key_sha256="c" * 64),
            "for another production plan": variant(production_plan_sha256="0" * 64),
        }
        for name, body in cases.items():
            with self.subTest(case=name):
                refuses(self, lambda: intro.receipt_valid(body, plan, "8" * 64, production, bundle=bundle))
        refuses(self, lambda: intro.receipt_valid(good, other_plan, "8" * 64, production, bundle=bundle), message="another production plan")
        intro.receipt_valid(good, plan, "8" * 64, production, b0_created_utc=now.isoformat(), bundle=bundle)
        with self.assertRaisesRegex(intro.Stop, "already used"):
            intro.receipt_valid(good, plan, "8" * 64, production, used=[intro.receipt_sha256(good)], bundle=bundle)

    def test_106_a_receipt_is_admitted_only_with_its_producers_run_bundle(self):
        """IRT2-01: without the bundle, with a bundle whose phase ended otherwise, ran under another request, whose journal
        lacks the run, or whose recorded artifact differs from the receipt's claim (B1 changed in both the receipt and
        its evidence), the receipt is refused; only the matching bundle admits it."""
        plan, production = plan_fixture(), production_identity()
        good, bundle = self.bundled(plan)
        refuses(self, lambda: intro.receipt_valid(good, plan, "8" * 64, production), message="run bundle")
        changed_b1 = copy.deepcopy(good)
        changed_b1["rehearsal_b1_manifest_sha256"] = changed_b1["evidence"]["verify"]["b1_manifest_sha256"] = "0" * 64
        refuses(self, lambda: intro.receipt_valid(changed_b1, plan, "8" * 64, production, bundle=bundle), message="B1")
        changed_target = copy.deepcopy(good)
        changed_target["rehearsal_target_manifest_sha256"] = "0" * 64
        refuses(self, lambda: intro.receipt_valid(changed_target, plan, "8" * 64, production, bundle=bundle))
        for name, kwargs, message in (("a phase that needed attention", {"status": {"verify": "NEEDS_ATTENTION"}}, "passed phase: verify"),
                                      ("a probe that replayed", {"details": {("verify", "L-10b"): {"added": 1, "replay_duplicates": 1,
                                                                                                   "restart": "same PostgreSQL outcome and entry",
                                                                                                   "evidence_sha256": "5" * 64}}}, "probe"),
                                      ("a seed of another B0", {"details": {("seed", "S-01"): {"source_manifest_sha256": "0" * 64}}}, "another B0"),
                                      ("a failed previous smoke", {"details": {("rollback_reopen", "RB-04b"): {"health": True}}}, "previous-version smoke")):
            receipt, other = self.bundled(plan, **kwargs)
            with self.subTest(case=name):
                refuses(self, lambda: intro.receipt_valid(receipt, plan, "8" * 64, production, bundle=other), message=message)
        # Another request's results, and a journal of no run, under the receipt's own hashes.
        receipt, other = self.bundled(plan)
        (path,) = [item for item in other.directory.glob("result-capture-*.json")]
        body = json.loads(path.read_text())
        body["request_sha256"] = "0" * 64
        path.write_bytes(intro.canonical(body) + b"\n")
        receipt["phases"]["capture"]["result_sha256"] = intro.sha256_bytes(path.read_bytes())
        refuses(self, lambda: intro.bundle_valid(receipt, other), message="passed phase: capture")
        receipt, other = self.bundled(plan)
        journal = b'{"event":"no-rehearsal-was-executed"}\n'
        (other.directory / "journal.jsonl").write_bytes(journal)
        receipt.update(journal_sha256=intro.sha256_bytes(journal), journal_bytes=len(journal))
        refuses(self, lambda: intro.bundle_valid(receipt, other), message="no start of seed")

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
    return {"server_major": 16, "unsupported_verifiers": [], "login_verifiers": ["kin"], "builtin_roles": [], "settings": [],
            "setting_names": ["search_path", "statement_timeout", "work_mem"],
            "role_comments": [["kin", None]], "roles": [pg_role("kin", superuser=True, login=True)], "memberships": [],
            "databases": [{"name": name, "owner": "kin", "acl": None, "attributes": {"datistemplate": False, "datallowconn": True}} for name in ("keycloak", "kin", "postgres", "template0", "template1")],
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
        self.live_roles = {"db", "api", "keycloak", "orthanc", "proxy"}
        self.cron_state = "open"
        self.ingress_state = "public"
        self.migrated = False
        self.loaded_host = False

    def __getattr__(self, name):
        if name not in {step[1] for steps in ACTION_CONTRACT.values() for step in steps} | {"revert_configuration"}:
            raise AttributeError(name)

        def step(context):
            self.calls.append(name)
            fault = self.faults.get(name)
            if isinstance(fault, BaseException):
                raise fault
            effect = getattr(self, "effect_" + name, None)
            result = effect(context) if effect else {}
            if name not in ("baseline", "recheck_fence", "final_allowlist", "public_smoke", "public_previous_smoke", "public_check_previous", "write_receipt", "seed_check"):
                context.state["host_changed"] = True
            if name in ("fence", "storage", "provision", "migrate", "capture_b1", "classify", "restore_b0", "revert_configuration", "seed_restore"):
                self.live_roles = {"db"}
                self.ingress_state = "closed"
            if name in ("keycloak", "member_import"):
                self.live_roles = {"db", "keycloak"}
            if name == "api":
                self.live_roles = {"db", "keycloak", "api"}
            if name in ("proxy_ui", "resume", "previous_services", "unfence", "seed_services"):
                self.live_roles = {"db", "keycloak", "api", "orthanc", "proxy"}
                self.ingress_state = "public" if name in ("unfence", "seed_services") else "maintenance"
            if name == "fence":
                self.cron_state = "fenced"
            if name in ("restore_jobs", "restore_jobs_after_rollback", "unfence"):
                self.cron_state = "open"
            if name in ("reopen_ingress", "reopen_previous_ingress"):
                self.ingress_state = "public"
            if name == "migrate":
                self.migrated = True
            if name in ("restore_b0", "revert_configuration", "seed_restore"):
                self.migrated = False
                context.state["checkout"] = "previous"
            if name == "seed_check":
                self.live_roles = set()
                self.ingress_state = "closed"
            image_sides = context.state.setdefault("fixture_images", {role: "previous" for role in intro.ROLES})
            for role in {"storage": ("db",), "keycloak": ("keycloak",), "api": ("api",), "proxy_ui": ("orthanc", "proxy")}.get(name, ()):
                image_sides[role] = "release"
            if name in ("restore_b0", "seed_restore"):
                image_sides["db"] = "previous"
            if name in ("previous_services", "revert_configuration", "seed_services"):
                image_sides.update({role: "previous" for role in intro.ROLES})
            if name == "previous_services":
                context.state["fixture_recovered_services"] = True
            context.state["fixture_host"] = {"live_roles": sorted(self.live_roles), "cron_state": self.cron_state,
                                              "ingress_state": self.ingress_state, "migrated": self.migrated}
            return result
        return step

    def one_shots_alive(self, context):
        self.calls.append("one_shots_alive")
        return list(self.alive)

    def snapshot(self, context):
        # Independent, complete C-OBS fixture. Missing facts are failures, not a shortcut for pure state tests.
        if not self.loaded_host:
            saved = context.state.get("fixture_host")
            if saved:
                self.live_roles = set(saved["live_roles"])
                self.cron_state, self.ingress_state, self.migrated = saved["cron_state"], saved["ingress_state"], saved["migrated"]
            self.loaded_host = True
        side = "release" if context.state["checkout"] == "target" else "previous"
        ok = lambda value: {"outcome": "OK", "value": value}
        snapshot = {"schema": 1, "checkpoint": [context.records.context.get("step"), context.records.context.get("part")], "facts": {
            "checkout": ok({"sha": context.plan[side]["sha"]}),
            "compose_entry": ok({"generation": "c" * 64, "sha256": "c" * 64}),
            "lock": ok({"owned": bool(context.state.get("lock_token"))}),
            "containers": ok({role: ok({"id": "container-" + role, "image": context.plan[context.state.get("fixture_images", {}).get(role, "previous")]["images"][role],
                                         "running": role in self.live_roles, "restarting": False,
                                          "project": (context.state.get("recovery") or {}).get("project", context.target["project"])
                                          if role == "db" or context.state.get("fixture_recovered_services") else context.target["project"], "service": role})
                              for role in ("db", "api", "keycloak", "orthanc", "proxy")}),
            "database": ok({"ready": True, "migrations": [row + [True, False] for row in context.plan["migrations"]["after" if self.migrated else "before"]]}),
            "fences": ok({"writers": {role: role in self.live_roles for role in ("api", "keycloak", "orthanc", "proxy")},
                           "cron": self.cron_state, "ingress": self.ingress_state, "db_clients": 0}),
            "workers": ok({"quiet": not self.alive, "pending": list(self.alive)})}}
        if not self.live_roles:
            snapshot["facts"]["containers"] = ok({role: {"outcome": "ABSENT"} for role in ("db", "api", "keycloak", "orthanc", "proxy")})
            snapshot["facts"]["database"] = {"outcome": "ABSENT"}
        return snapshot

    def effect_fence(self, context):
        context.state["fenced"] = {"running_before": list(pre.WRITERS)}

    # The steps' details as the real ones record them (the receipt's producer bundle is checked against them, IRT2-01).
    def effect_seed_check(self, context):
        # Certificate inspection creates an owned temporary helper, without changing operating host state.
        return {"source_manifest_sha256": context.plan["seed"]["b0_manifest_sha256"]}

    def effect_capture_b0(self, context):
        context.state["b0"] = {"dir": "/backups/emr-b0", "manifest_sha256": "8" * 64}
        return context.state["b0"]

    def effect_restore_check_b0(self, context):
        context.state["b0"]["restore_check"] = {"success": True}
        return context.state["b0"]["restore_check"]

    def effect_capture_b1(self, context):
        context.state["b1"] = {"dir": "/backups/emr-b1", "manifest_sha256": "7" * 64, "restore_check": {"success": True}}
        return context.state["b1"]

    def effect_storage(self, context):
        context.state["checkout"] = "target"

    def effect_member_import(self, context):
        context.state["imported_at"] = NOW.isoformat()

    def effect_probe(self, context):
        context.state["probe"] = {"event_id": "e", "receipt": {}, "evidence_sha256": "5" * 64, "added": 1, "replay_duplicates": 0,
                                  "restart": "same PostgreSQL outcome and entry"}
        return context.state["probe"]

    def effect_seed_restore(self, context):
        context.state["seed"] = {"source_manifest_sha256": "8" * 64}

    def effect_preserve_failed(self, context):
        context.state["bfail"] = {"dir": "/backups/emr-bfail", "manifest_sha256": "6" * 64, "volumes": {}}
        return context.state["bfail"]

    def effect_restore_b0(self, context):
        context.state["recovery"] = {"project": "kin-rh-0001-rbabcdef01", "pg": "kin-rh-0001-rbabcdef01_pg-db",
                                     "orthanc": "kin-rh-0001-rbabcdef01_orthanc-db", "persisted": False}
        return {"recovery": context.state["recovery"]}

    def effect_recovery_persisted(self, context):
        context.state["recovery"]["persisted"] = True
        return {"project": context.state["recovery"]["project"]}

    def effect_fenced_previous_smoke(self, context):
        frame = context.plan["smoke"]["frame"]
        context.state["rollback_smoke"] = {"member": True, "token_after_restore": True, "worklist_uid": intro.frame_study(context.plan),
                                           "frame_sha256": frame["sha256"], "frame_bytes": frame["bytes"]}
        return {"health": True, "auth_refusal": True, "member": True, "worklist": True, "frame": True}

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
        self.plan_sha256 = intro.plan_identity(plan)
        host_key = "a" * 64 if self.kind == "production" else "b" * 64
        evidence = phase_evidence if phase_evidence is not None else {}
        return intro.Introduction(plan=plan, plan_sha256=self.plan_sha256, target=target, production=production_identity(),
                                  ops=self.ops, records=self.records, repository=self.repository, host_key=host_key,
                                  tool=plan["tool"], evidence=evidence, clock=self.clock, now=lambda: NOW)

    def run_phase(self, phase, evidence=None):
        if phase == "seed" and self.records.state() is None:
            self.ops.live_roles = set()
            self.ops.ingress_state = "closed"
        machine = self.machine(evidence)
        request = {"version": 1, "mode": intro.MODE, "phase": phase, "plan_sha256": self.plan_sha256, "nonce": os.urandom(16).hex()}
        return machine.run(request, hashlib.sha256(json.dumps(request).encode()).hexdigest())

    def local_restore(self, receipt_id="1" * 32):
        # The production plan this machine runs (its target names the test's repository): the receipt names exactly it,
        # with the producer's run bundle (IRT2-01).
        plan = plan_fixture(target_fixture(self.kind, repository=str(self.repository)), kind=self.kind)
        receipt, bundle = receipt_bundle(plan, self.root / ("bundle-" + receipt_id), created=NOW - timedelta(hours=1), receipt_id=receipt_id)
        return {"local-restore": receipt, "local-restore-bundle": bundle}

    def operator_smoke(self):
        return {"operator-smoke": {"schema": 1, "kind": "operator-smoke", "plan_sha256": self.machine().plan_sha256,
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
        self.assertEqual(self.ops.calls, [name for phase in ("capture", "introduce", "verify", "reopen") for _, name in ACTION_CONTRACT[phase]])
        self.assertTrue(results["capture"]["lock_retained"] and results["verify"]["lock_retained"])
        self.assertFalse(self.lock_held())
        state = self.records.state()
        self.assertEqual(state["status"], "DEPLOYED")
        self.assertEqual(state["ponr"]["step"], "L-11b")
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
        # This scenario has a confirmed refusal before capture writes; unclassified failures retain UNKNOWN.
        self.ops.faults["capture_b0"] = intro.Stop("Insufficient free space for the capture and its restore margin")
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
        self.ops.faults["storage"] = intro.Stop("Tablespace directory owner differs")
        result = self.run_phase("introduce", self.local_restore())
        self.assertEqual(result["status"], "HELD")
        self.assertEqual(self.ops.calls[-2:], ["storage", "revert_configuration"])
        self.assertNotIn("restore_b0", self.ops.calls)
        self.assertFalse(self.records.state()["db_changed"])
        self.assertTrue(self.lock_held())

    def test_30_settled_failure_after_the_first_database_change_rolls_back_automatically(self):
        self.run_phase("capture")
        self.ops.faults["migrate"] = intro.Stop("Installer migration failed")
        result = self.run_phase("introduce", self.local_restore())
        # Restored, but nothing reopens before the previous version proved itself (IRT-06): fence and lock stay.
        self.assertEqual((result["status"], result["phase_passed"]), ("RESTORED", False))
        self.assertIs(result.get("data_restored"), True)
        rollback = [name for _, name in ACTION_CONTRACT["rollback"]]
        self.assertEqual(self.ops.calls[-len(rollback) - 1:], ["one_shots_alive", *rollback])
        self.assertFalse({name for _, name in ACTION_CONTRACT["rollback_reopen"]} & set(self.ops.calls),
                         "the rollback itself never smokes, restores jobs or opens the ingress")
        self.assertTrue(self.records.state()["rollback_attempted"])
        self.assertTrue(self.lock_held())
        refuses(self, self.run_phase, "rollback", message="cannot follow RESTORED")
        reopened = self.run_phase("rollback_reopen")
        self.assertEqual((reopened["status"], reopened["phase_passed"]), ("ROLLED_BACK", True))
        self.assertEqual(self.ops.calls[-len(ACTION_CONTRACT["rollback_reopen"]):], [name for _, name in ACTION_CONTRACT["rollback_reopen"]])
        self.assertFalse(self.lock_held())
        refuses(self, self.run_phase, "rollback", message="cannot follow ROLLED_BACK")

    def test_31_no_automatic_rollback_while_a_migration_worker_may_be_alive(self):
        self.run_phase("capture")
        self.ops.faults["migrate"] = intro.Stop("Installer migration failed")
        self.ops.alive = ["kin-api-migrate-1 running"]
        result = self.run_phase("introduce", self.local_restore())
        self.assertEqual(result["status"], "NEEDS_ATTENTION")
        self.assertIsNotNone(self.records.state()["unknown_hold"])
        self.assertNotIn("classify", self.ops.calls)
        self.assertTrue(self.lock_held())
        # A later quiet inventory cannot erase the previous uncertainty without a separate manual reconciliation.
        self.ops.alive = []
        self.ops.faults.clear()
        refuses(self, self.run_phase, "rollback", message="UNKNOWN")

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
        self.assertEqual(next(step for step in result["steps"] if step["step"] == "I-00")["code"], "Outside the approved window")
        self.assertEqual(self.ops.calls[-1], "revert_configuration")

    def test_35_reopen_requires_operator_smoke_and_rollback_is_refused_after_the_point_of_no_return(self):
        self.deploy_through("verify")
        refuses(self, self.run_phase, "reopen", {}, message="Operator smoke record required")
        self.ops.faults["public_smoke"] = RuntimeError("Frame bytes differ")
        result = self.run_phase("reopen", self.operator_smoke())
        self.assertEqual(result["status"], "NEEDS_ATTENTION")
        self.assertIsNotNone(result["ponr"])
        refuses(self, self.run_phase, "rollback", message="Ingress was reopened")

    def test_36_scheduled_writer_reopen_failure_retains_point_of_no_return(self):
        self.deploy_through("verify")
        self.ops.faults["restore_jobs"] = intro.Stop("Scheduled jobs were not restored exactly")
        result = self.run_phase("reopen", self.operator_smoke())
        self.assertIsInstance(result["ponr"], dict, "the first scheduled writer requires a durable point-of-no-return marker")
        self.assertEqual((result["status"], result["ponr"]["step"]), ("NEEDS_ATTENTION", "L-11b"))
        self.assertNotIn("reopen_ingress", self.ops.calls)
        self.assertTrue(self.lock_held())
        refuses(self, self.run_phase, "rollback", message="Ingress was reopened")

    def test_37_failed_rollback_is_never_retried(self):
        self.deploy_through("verify")
        self.ops.faults["restore_b0"] = intro.Stop("Restored row counts differ: kin")
        result = self.run_phase("rollback")
        self.assertEqual(result["status"], "NEEDS_ATTENTION")
        self.assertTrue(self.lock_held())
        refuses(self, self.run_phase, "rollback", message="already attempted")

    def test_58_a_classification_refusal_leaves_the_single_rollback_unused(self):
        self.deploy_through("introduce")
        self.ops.faults["classify"] = intro.Unknown("A one-shot worker may still be alive; observe only")
        result = self.run_phase("rollback")
        self.assertEqual(result["status"], "NEEDS_ATTENTION")
        self.assertIn("RB-00", result["rollback"])
        self.assertNotIn("preserve_failed", self.ops.calls)
        self.assertFalse(self.records.state()["rollback_attempted"])
        self.assertTrue(self.lock_held())
        # Worker disappearance alone does not reconcile a durable UNKNOWN hold.
        self.ops.faults.clear()
        refuses(self, self.run_phase, "rollback")
        self.assertIsNotNone(self.records.state()["unknown_hold"])
        self.assertFalse(self.records.state()["rollback_attempted"])

    def test_38_verify_failure_rolls_back_from_the_held_b0(self):
        self.deploy_through("introduce")
        self.ops.faults["probe"] = intro.Stop("The replay added a ledger entry")
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
                            now=NOW, bundle=intro.DirectoryBundle(self.records.directory))
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
        def provision(context):
            self.assertTrue(self.records.state()["db_changed"])
            return {}
        self.ops.effect_provision = provision
        results = self.deploy_through("reopen")
        for phase in ("capture", "introduce", "verify", "reopen"):
            (record,) = self.records.directory.glob("result-" + phase + "-*.json")
            steps = {step["step"]: step for step in json.loads(record.read_text())["steps"]}
            self.assertEqual(set(steps), {sid for sid, _ in ACTION_CONTRACT[phase]})
            for sid in steps:
                with self.subTest(step=sid):
                    for boundary in ("before", "after"):
                        self.assertEqual(set(steps[sid][boundary]["facts"]),
                                         {"checkout", "compose_entry", "lock", "containers", "database", "fences", "workers"})
                        self.assertTrue(intro.observed(steps[sid][boundary]))
                    self.assertEqual(set(steps[sid]["commands"]), {"file", "first", "last"})
        (record,) = self.records.directory.glob("result-introduce-*.json")
        steps = {step["step"]: step for step in json.loads(record.read_text())["steps"]}
        self.assertEqual(steps["L-06a"]["after"]["facts"]["checkout"]["value"]["sha"], self.machine().plan["release"]["sha"])
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
        self.ops.faults["storage"] = intro.Stop("Tablespace directory owner differs")
        first = self.run_phase("introduce", self.local_restore())
        self.assertEqual(first["status"], "HELD")
        receipt = self.local_restore()["local-restore"]
        self.assertEqual(self.records.state()["receipts_used"], [intro.receipt_use_identity(receipt)])
        calls = list(self.ops.calls)
        self.ops.faults.clear()
        refuses(self, self.run_phase, "introduce", self.local_restore(), message="already used")
        self.assertEqual(self.ops.calls, calls, "a reused receipt is refused before any step")
        # A newly printed UUID is still the same rehearsal, B0 and journal.
        refuses(self, self.run_phase, "introduce", self.local_restore(receipt_id="2" * 32))

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
            "machine = intro.Introduction(plan=plan, plan_sha256=intro.plan_identity(plan), target=target, production=t.production_identity(), ops=Dying(),\n"
            "    records=intro.Records(%r), repository=%r, host_key='a' * 64, tool=plan['tool'],\n"
            "    evidence=dict(zip(('local-restore', 'local-restore-bundle'), t.receipt_bundle(plan, %r, created=t.NOW - t.timedelta(hours=1)))),\n"
            "    clock=t.Clock(), now=lambda: t.NOW)\n"
            "machine.run({'version': 1, 'mode': intro.MODE, 'phase': 'introduce', 'plan_sha256': intro.plan_identity(plan), 'nonce': '3' * 32}, '3' * 64)\n"
        ) % (str(Path(intro.__file__).parent), str(Path(__file__).parent), str(self.repository), str(self.records.directory), str(self.repository),
             str(self.root / "bundle-dying"))
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
        # Explicit recovery is also blocked until separately reviewed reconciliation of this interrupted execution.
        self.assertIsNotNone(state["unknown_hold"])
        refuses(self, self.run_phase, "rollback", message="UNKNOWN")

    def test_64_rollback_never_reopens_before_the_previous_version_proved_itself(self):
        """IRT-06: a failed previous-version smoke keeps RESTORED with the fence and the lock; nothing opens."""
        self.deploy_through("verify")
        self.assertEqual(self.run_phase("rollback")["status"], "RESTORED")
        for step in ("recovery_persisted", "fenced_previous_smoke"):
            self.ops.faults = {step: intro.Stop("The previous-version smoke did not run every check")}
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

    READ_ONLY = (("docker", "inspect"), ("docker", "container", "ls"), ("docker", "volume", "ls"),
                 ("docker", "volume", "inspect"), ("docker", "image", "inspect"), ("docker", "ps"),
                 ("docker", "network", "inspect"),
                 ("git", "rev-parse"), ("git", "status"), ("git", "cat-file"), ("crontab", "-u"),
                 ("docker", "run", "--rm", "--network", "none", "--read-only"))

    def __init__(self, target, plan):
        self.target, self.plan = target, plan
        self.calls, self.inputs, self.envs = [], [], []
        self.containers, self.volumes, self.tags = {}, {}, {}
        self.engine_exec = None
        self.head = plan["previous"]["sha"]
        self.config = {}           # "pinned" / "plain" -> the compose config model (dict)
        self.psql = {}             # SQL fragment -> stdout text
        self.attached = {}         # volume -> container names using it
        policy = {"browserFlow": "browser", "passwordPolicy": "", "requiredActions": [],
                  "executions": [{"providerId": "auth-username-password-form", "requirement": "REQUIRED", "level": 1}]}
        self.run_output = ("KIN_RESULT " + json.dumps({"useCaches": "false", "persistentUserSessions": True, "smokePolicy": policy}) + "\n").encode()
        self.failing = None        # a predicate over argv: those calls exit 1
        self.crontab = ""
        self.image_labels = {}
        self.image_volumes = {}
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
        if args[:3] == ["docker", "system", "dial-stdio"]:
            if self.engine_exec is None:
                from ops_deploy_round5_test import EngineFixture
                self.engine_exec = EngineFixture(self.containers, self)
            self.engine_exec.containers = self.containers
            return self.result(stdout=self.engine_exec(input))
        if args[:2] == ["docker", "compose"]:
            if "config" in args:
                if "--environment" in args:
                    values = intro.parse_env((Path(self.target["repository"]) / ".env").read_bytes())
                    values.update(env or {})
                    return self.result(stdout="\n".join(name + "=" + value for name, value in sorted(values.items())) + "\n")
                if self.config_for is not None:
                    return self.result(stdout=json.dumps(self.config_for(args, env or {})))
                return self.result(stdout=json.dumps(self.config["pinned" if "--project-name" in args else "plain"]))
            if "run" in args:
                name = args[args.index("--name") + 1]
                self.containers[name] = {"Id": "helper-" + name, "ExecIDs": None,
                                         "Config": {"Labels": dict(args[index + 1].split("=", 1) for index, arg in enumerate(args) if arg == "--label")},
                                         "State": {"Running": False, "Restarting": False, "Status": "exited", "ExitCode": 0}}
                return self.result(stdout=self.run_output(args) if callable(self.run_output) else self.run_output)
            return self.result()
        if args[:3] in (["docker", "container", "ls"], ["docker", "volume", "ls"]):
            name = args[args.index("--filter") + 1].split("=^", 1)[1].removeprefix("/").removesuffix("$")
            inventory = self.containers if args[1] == "container" else self.volumes
            return self.result(stdout=name + "\n" if name in inventory else "")
        if args[:2] == ["docker", "rm"]:
            self.containers.pop(args[-1], None)
            return self.result()
        if args[:2] == ["docker", "run"]:
            if "--name" in args:
                name = args[args.index("--name") + 1]
                self.containers[name] = {"Id": "helper-" + name, "ExecIDs": None,
                                         "Config": {"Labels": dict(args[index + 1].split("=", 1) for index, arg in enumerate(args) if arg == "--label")},
                                         "State": {"Running": "-d" in args or "--detach" in args, "Restarting": False, "Status": "running" if "-d" in args or "--detach" in args else "exited", "ExitCode": 0}}
            return self.result(stdout=self.run_output(args) if callable(self.run_output) else self.run_output)
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
                                                   "Config": {"User": "node", "Labels": dict(self.image_labels), "Env": [],
                                                              "Volumes": self.image_volumes.get(args[3], {})}}]))
        if args[:3] == ["docker", "network", "inspect"]:
            name = args[3]
            members = {item["Id"]: {"EndpointID": item["NetworkSettings"]["Networks"][name]["EndpointID"]}
                       for item in self.containers.values() if name in item.get("NetworkSettings", {}).get("Networks", {})}
            return self.result(stdout=json.dumps([{"Name": name, "Id": "network-" + name, "Containers": members}]))
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
                and call[:3] != ["docker", "system", "dial-stdio"]
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
                                {"type": "bind", "source": target["repository"] + "/config/orthanc.json", "target": "/etc/orthanc/orthanc.json", "read_only": True}]},
        "proxy": {"container_name": names["proxy"], "image": images.get("proxy"), "ports": public,
                  "networks": {"default": None, "workflow": None, **{key: None for key in (extra_networks or {})}},
                  "volumes": [{"type": "volume", "source": "proxy-certs", "target": "/etc/nginx/certs"}, *(extra_binds or [])]}}
    return {"name": project, "services": services,
            "volumes": {"pg-db": {"name": recovery["pg"] if recovery else project + "_pg-db"},
                        "orthanc-db": {"name": recovery["orthanc"] if recovery else project + "_orthanc-db"},
                        "proxy-certs": {"name": target["project"] + "_proxy-certs"}},
            "networks": {"default": {"name": project + "_default"}, "workflow": {"name": workflow or target["networks"]["workflow"]},
                         **{key: {"name": name, "external": True} for key, name in (extra_networks or {}).items()}}}


def running_from(config, role, image_id):
    """`docker inspect` of the container Compose made for one service of a config model (compose_config above): its
    project and service labels, named volumes and binds, networks and published ports."""
    service = config["services"][role]
    mounts = [{"Type": "volume", "Name": config["volumes"][entry["source"]]["name"], "Destination": entry["target"]} if entry["type"] == "volume"
              else {"Type": "bind", "Source": entry["source"], "Destination": entry["target"]} for entry in service.get("volumes") or []]
    for mount, declared in zip(mounts, service.get("volumes") or []):
        mount["RW"] = not declared.get("read_only", False)
        if mount["Type"] == "bind":
            mount["Propagation"] = (declared.get("bind") or {}).get("propagation", "rprivate")
    networks = {config["networks"][key]["name"]: {"NetworkID": "network-" + config["networks"][key]["name"],
                                                  "EndpointID": "endpoint-" + role + "-" + key}
                for key in (service.get("networks") or {"default": None})}
    bindings = {}
    for port in service.get("ports") or []:
        bindings.setdefault(str(port["target"]) + "/" + port.get("protocol", "tcp"), []).append({"HostIp": port.get("host_ip", ""), "HostPort": str(port["published"])})
    return {"Id": "container-" + role, "Image": image_id, "ExecIDs": None, "State": {"Running": True, "Restarting": False}, "Mounts": mounts, "NetworkSettings": {"Networks": networks},
            "HostConfig": {"PortBindings": bindings},
            "Config": {"Labels": {"com.docker.compose.project": config["name"], "com.docker.compose.service": role}, "Env": []}}


class HostHarness:
    """HostOps against FakeDocker in a temporary rehearsal checkout with its seed copy and records."""

    def setUp(self):
        if os.name == "posix":
            # These fixture programs model browser outputs. Only their command admission is substituted; the real
            # systemd service, cgroup termination and deadlines still run. Real Chromium tests exercise admission too.
            admitted = intro.SystemdBrowser.command
            self.enterContext(patch.object(intro.SystemdBrowser, "command", side_effect=lambda argv:
                list(argv) if list(argv)[:2] == [sys.executable, "-c"] else admitted(argv)))
        # These host-boundary tests supply PG admission independently of the Docker/Compose double. The real admission
        # and its before-change ordering are tested in ops_backup_restore_test and the isolated PG16 batch.
        self.enterContext(patch.object(intro.HostOps, "admit_source", return_value={"admitted": True, "version": intro.ops.RESTORE_INVENTORY}))
        folder = tempfile.TemporaryDirectory(dir="/root" if os.name == "posix" and os.geteuid() == 0 else None)
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

    def host(self, plan=None, *, token=None, prepare=True):
        plan = plan or self.plan()
        docker = FakeDocker(self.target, plan)
        docker.config["pinned"] = compose_config(self.target, previous_images=plan["previous"]["images"])
        docker.config["plain"] = compose_config(self.target)
        # The clone's certificate volume, filled before the seed (the read-only certificate check passes).
        docker.volumes[self.target["project"] + "_proxy-certs"] = {"Name": self.target["project"] + "_proxy-certs"}
        ops_host = intro.HostOps(target=self.target, plan=plan, runner=docker, records=self.records,
                                 token_reader=(lambda: token) if token else None)
        context = SimpleNamespace(plan=plan, plan_sha256="a" * 64, request_sha256="f" * 64, retrying=False, phase="capture",
                                  state={"checkout": "previous"}, records=self.records, save=lambda: self.records.save(context.state))
        ops_host.intro = context
        if prepare:
            ops_host.prepare_entry(context)
        return ops_host, docker, context

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
        self.assertTrue(all(row["state"] == "QUIET" for row in context.state["workers"].values()))
        self.assertFalse(docker.containers)
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
        self.records.begin("command-fixture", "c" * 64)
        docker.containers["db"] = {"Id": "fixture-db", "ExecIDs": None}
        docker.run_output = b"KIN_RESULT {}\n"
        ops_host.cmd(["docker", "compose", "--project-directory", str(self.repo), "config"], env={"KC_ADMIN_PASSWORD": secret})
        docker.failing = lambda args: args[:2] == ["docker", "exec"]
        with self.assertRaises(intro.Stop):
            ops_host.cmd(["docker", "exec", "-i", "db", "psql"], input=("UPDATE client SET secret='" + secret + "';").encode(), quiet=True)
        with self.assertRaises(intro.Stop):
            ops_host.cmd(["docker", "exec", "db", "psql", "-c", "SELECT 1"])
        docker.failing = None

        def timeout(*args, **kwargs):
            raise subprocess.TimeoutExpired(["docker"], 1)

        def missing(*args, **kwargs):
            raise FileNotFoundError("docker")
        for runner, error in ((timeout, intro.Unknown), (missing, intro.Unknown)):
            ops_host.run = runner
            with self.assertRaises(error):
                ops_host.cmd(["docker", "compose", "up", "-d", "db"], mutating=True)
        ops_host.run = timeout
        with self.assertRaisesRegex(intro.Stop, "timed out"):
            ops_host.cmd(["docker", "inspect", "x"])
        ops_host.run = lambda *a, **k: SimpleNamespace(returncode=0, stdout=("password=" + secret).encode(), stderr=b"")
        ops_host.cmd(["docker", "compose", "config", "--format", "json"])
        entries = [json.loads(line) for line in (self.records.directory / self.records.commands_file).read_text().splitlines()]
        self.assertEqual([entry["seq"] for entry in entries], list(range(1, len(entries) + 1)))
        entries = [entry for entry in entries if entry["argv"][:2] in (["docker", "compose"], ["docker", "exec"])
                   or entry["argv"] == ["docker", "inspect", "x"]]
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
        docker.config["pinned"] = compose_config(self.target, recovery=recovery, previous_images=plan["previous"]["images"],
                                                 proxy_ports=[self.target["ports"]["maintenance"]])
        for identity in failed.values():
            docker.volumes[identity["name"]] = {"Name": identity["name"], "CreatedAt": identity["created"]}
        for role in intro.ROLES:
            docker.containers[self.target["containers"][role]] = running_from(docker.config["pinned"], role, plan["previous"]["images"][role])
        for role in ("api", "proxy"):
            docker.tags[recovery["project"] + "-" + role + ":latest"] = image("6")
        ops_host.publish_entry(ops_host.pins(context), project=recovery["project"])
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
        cases = {"common entry still the original project": lambda d, c: d.config.__setitem__("pinned", compose_config(self.target)),
                 "failed volume attached": lambda d, c: d.attached.__setitem__(failed_pg, ["kin-rh-0001-db"]),
                 "failed volume replaced": lambda d, c: d.volumes[failed_pg].__setitem__("CreatedAt", "2026-10-13T00:00:00Z"),
                 "common entry image not the previous one": lambda d, c: d.config["pinned"]["services"]["api"].__setitem__("image", image("6")),
                 "a service in the old project": lambda d, c: d.containers[self.target["containers"]["db"]]["Config"]["Labels"].__setitem__(
                     "com.docker.compose.project", self.target["project"]),
                 "recovery bundle damaged": lambda d, c: (self.root / "compose-entries" / c.state["compose_entry"]["generation"] / "runtime.yml").write_bytes(b"broken")}
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
            context.deadline_left = lambda: 1800
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
# W2 answers by their contracts (api/src/pacs/filters.ts, preferences.ts): a new member's empty folders and no shortcuts.
W2_ANSWERS = {"/api/filter-folders": json.dumps({"owner": ["hallym", "id-x"], "revision": 0, "folders": [], "filters": []}).encode(),
              "/api/workspace-shortcuts": json.dumps({"owner": ["hallym", "id-x"], "revision": 0, "bindings": None,
                                                      "invalid": False}).encode()}
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
product = {"signed_in": True, "logout_status": 204, "old_session_status": 401, "old_cookie_status": 401,
           "screens": {name: True for name in ("worklist_row", "modality_rendered", "folders_loaded", "reading_workspace", "shortcuts_dialog",
                                               "viewer_rendered")}} if spec["product_session"] else None
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
            logical = {str(path): Path(path).name for path in files}
            for path in files:
                manifest = Path(path).parent / "manifest.json"
                if manifest.exists():
                    for row in json.loads(manifest.read_bytes())["logical_files"]:
                        logical[str(manifest.parent / row["pinned"])] = Path(row["logical"]).name
            names = set(logical.values())
            prod = Path(next(item for item in files if logical[item] in ("docker-compose.prod.yml", "head-docker-compose.prod.yml"))).read_bytes()
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
        ops_host, docker, context = self.host(prepare=False)
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
        kept = self.records.secrets / intro.COMPOSE_VALUES
        for path in self.records.directory.rglob("*"):
            if path.is_file() and path != kept:
                self.assertNotIn(value.encode(), path.read_bytes(), path.name)
        # The value a later phase finds must be the same one.
        docker.containers[self.target["containers"]["proxy"]]["Mounts"][0]["Source"] = "/tmp/elsewhere"
        with self.assertRaises(intro.Stop):
            ops_host.prepare(context)
        # Removed carrier and run secrets cannot remove the independently retained operational input.
        docker.containers.pop(self.target["containers"]["proxy"])
        context.state.pop("compose_env")
        kept.unlink()
        ops_host.prepare(context)
        self.assertEqual(ops_host.entry.load()[2]["KIN_MONITOR_PUBLIC_DIR"], value)
        (ops_host.entry.root / "active.json").unlink()
        # This phase has a generation identity; corruption of its pinned data still refuses without live inference.
        (ops_host.entry.root / context.state["compose_entry"]["generation"] / "environment.json").write_bytes(b"{}")
        with self.assertRaises((intro.Stop, OSError)):
            ops_host.prepare(context)
        self.assertEqual(intro.referenced_variables([b"a: ${A}\nb: ${B:-x}\nc: $C\nd: $${D}\n# e: ${E}\nf: ${F:?m}\n"]),
                         {"A": True, "B": False, "C": True, "F": True})

    def unattended_host(self):
        ops_host, docker, context = self.host()
        docker.containers[self.target["containers"]["db"]] = {"Id": "fixture-db", "ExecIDs": None}
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
            if "kc-smoke-owned" in name:
                member = context.state.get("smoke_member") or {}
                return ("KIN_RESULT " + json.dumps({"users": [member["id"]] if member.get("id") else [],
                        "clients": sorted(set(member.get("client_objects", {}).values()))}) + "\n").encode()
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
        credentials = self.records.secrets / member["credentials"]
        password = json.loads(credentials.read_text())["password"]
        if os.name == "posix":
            self.assertEqual(credentials.stat().st_mode & 0o777, 0o600)
        full = {"health": True, "auth_refusal": True, "member": True, "worklist": True, "frame": True}

        def https(origin, path, *, token=None, **kwargs):
            if path == "/api/me":
                return 401, "application/json", b"{}"
            return 200, "application/json", W2_ANSWERS.get(path, b"[]")
        with patch.object(intro, "smoke", return_value=full), patch.object(intro, "worklist_row", return_value={"uid": FRAME_STUDY, "modality": "CT"}), \
                patch.object(intro, "https_get", side_effect=https), patch.object(intro, "https_post", return_value=(204, b"")):
            result = ops_host.unattended_release_smoke(context, ("127.0.0.1", 19444))
        record = json.loads((self.records.directory / "operator-smoke.json").read_text())
        intro.operator_smoke_valid(record, context.plan_sha256)
        self.assertEqual((record["by"], set(record["checks"])), ("Opus executor (D1062)", set(intro.OPERATOR_SMOKE_CHECKS)))
        self.assertTrue(all(record["checks"].values()) and result["record_sha256"] == context.state["operator_smoke"]["sha256"])
        self.assertEqual(list(self.records.secrets.glob("browser-profile-*")), [], "the browser profile is removed after the login")
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
        good = lambda origin, path, *, token=None, **kwargs: (401, "", b"{}") if path == "/api/me" else (200, "", W2_ANSWERS.get(path, b"[]"))
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
        earlier = self.records.secrets / first["credentials"]
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

    def test_119_a_rehearsal_binds_the_monitor_public_folder_where_production_keeps_it_and_nothing_else_outside(self):
        """RT-P3-MONITOR-BIND (prep3 readiness3 §3-1, D1311): an operational rehearsal lists docker-compose.monitor.yml
        last, and that file binds ${KIN_MONITOR_PUBLIC_DIR} read-only into the proxy. Production keeps the folder outside
        its checkout (/home/ubuntu/.kin-monitor-public); a clone with production's shape binds it outside its checkout
        too, and that one bind - the proxy's read-only monitor folder with the monitor file listed - is accepted. Every
        other host path outside the checkout is still refused, and so is the monitor bind in any other shape."""
        self.production_host()
        rehearsal = target_fixture("rehearsal", str(self.repo))
        # The operational check names the overlay file by its POSIX name (the VM's paths); written that way here too.
        overlays = [dict(entry, file=Path(entry["file"]).as_posix()) for entry in copy.deepcopy(self.target["declared_overlays"])]
        rehearsal.update(compose_files=["docker-compose.yml", "docker-compose.prod.yml", self.override.as_posix(), self.overlay.as_posix(),
                                        "docker-compose.monitor.yml"],
                         external_networks=copy.deepcopy(self.target["external_networks"]), declared_overlays=overlays)
        intro.target_valid(rehearsal, operational=True)
        monitor_target = "/var/run/kin-monitor-public"
        # Beside the checkout, as production's /home/ubuntu/.kin-monitor-public is beside /home/ubuntu/pacs-starter-kit.
        outside = {"type": "bind", "source": str(self.root / ".kin-monitor-public"), "target": monitor_target, "read_only": True}
        for maintenance in (False, True):
            model = resolved_model(rehearsal, target_checkout=False, maintenance=maintenance)
            model["mounts"]["proxy"].append(dict(outside))
            check = lambda model, target=rehearsal, maintenance=maintenance: intro.check_resolved(
                model, target, target_checkout=False, maintenance=maintenance)
            with self.subTest(maintenance=maintenance):
                check(model)
            inside = copy.deepcopy(model)
            inside["mounts"]["proxy"][-1]["source"] = str(self.repo / ".kin-monitor-public")   # the D1311 data workaround
            check(inside)
            elsewhere = {"type": "bind", "source": str(self.root / "elsewhere"), "target": "/etc/nginx/conf.d/x.conf", "read_only": True}
            for name, change in {
                    "the monitor bind writable": lambda m: m["mounts"]["proxy"][-1].__setitem__("read_only", False),
                    "the monitor folder at another target": lambda m: m["mounts"]["proxy"][-1].__setitem__("target", monitor_target + "-x"),
                    "the monitor folder on another service": lambda m: m["mounts"]["api"].append(m["mounts"]["proxy"].pop()),
                    "a second outside folder at the monitor target": lambda m: m["mounts"]["proxy"].append(
                        dict(outside, source=str(self.root / "second-monitor"))),
                    "another outside bind beside the monitor bind": lambda m: m["mounts"]["proxy"].append(dict(elsewhere)),
                    "another outside bind on another service": lambda m: m["mounts"]["orthanc"].append(dict(elsewhere))}.items():
                bad = copy.deepcopy(model)
                change(bad)
                with self.subTest(case=name, maintenance=maintenance):
                    refuses(self, check, bad, message="outside its checkout")
            unlisted = copy.deepcopy(rehearsal)
            unlisted["compose_files"].remove("docker-compose.monitor.yml")
            with self.subTest(case="the monitor file not listed", maintenance=maintenance):
                refuses(self, check, model, unlisted, message="outside its checkout")
        # Production is as production runs it: no rehearsal rule, its monitor folder outside its checkout.
        images = plan_fixture(self.target)["previous"]["images"]
        production = resolved_model(self.target, target_checkout=False, maintenance=False, images=images)
        production["mounts"]["proxy"].append(dict(outside, source="/home/ubuntu/.kin-monitor-public"))
        intro.target_valid(self.target, operational=False)
        intro.check_resolved(production, self.target, target_checkout=False, maintenance=False, images=images)

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
        self.assertFalse(docker.containers)
        self.assertTrue(all(row["state"] == "QUIET" for row in context.state["workers"].values()))
        for name, (change, message) in {
                "absent": (lambda d: d.volumes.pop(self.target["project"] + "_proxy-certs"), "certificate volume does not exist"),
                "the CA file missing": (lambda d: Path(self.target["ca_file"]).unlink(), "CA file is missing"),
                "empty or not this origin's": (lambda d: setattr(d, "failing", lambda args: args[:2] == ["docker", "run"]), "certificate volume is empty")}.items():
            self.setUp()
            ops_host, docker, context = self.host()
            change(docker)
            with self.subTest(case=name):
                refuses(self, self.seed_check, ops_host, context, message=message)
                self.assertFalse(docker.containers)
                if name != "empty or not this origin's":
                    self.assertEqual(docker.mutating(), [])
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


PROXY_TEST_IMAGE = os.environ.get("KIN_TEST_PREVIOUS_PROXY_IMAGE", "release-tools-rehearsal/proxy:previous")


def uuid_hex():
    return os.urandom(16).hex()


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
# A child that outlives this process: it inherits the output pipes and sleeps (a Chromium renderer left behind) - far
# longer than the test's bounds (a refusal within 60 s, the child gone 10 s later), short enough that a tool which
# waits on its pipes is seen failing within minutes rather than hanging the suite.
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(90)"])
with open(%r, "w") as handle:
    handle.write(str(child.pid))
if %r:
    time.sleep(600)
"""


class RoundThreeHostTests(HostHarness, unittest.TestCase):
    """Round 3 (D1084): the defects round 2 recorded itself, as the commander decided them, against the fixed-binary
    boundary (FakeDocker) and real child processes."""

    def context(self, plan, phase="capture", **state):
        context = Context(plan=plan, plan_sha256="a" * 64, state={"checkout": "previous", "lock_token": None, **state}, records=self.records,
                          phase=phase, recovering=phase in intro.RECOVERY_PHASES, warnings=[], request_sha256="c" * 64, retrying=False)
        context.save = lambda: self.records.save(context.state)
        return context

    def monitor_stack(self):
        """The production shape of IRT-12/D04: a compose file binds ${KIN_MONITOR_PUBLIC_DIR} into the proxy, the .env lacks
        it, and the running proxy carries it as its bind source."""
        (self.repo / "docker-compose.prod.yml").write_text(MONITOR_COMPOSE, newline="\n")
        ops_host, docker, _ = self.host(prepare=False)
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
        kept = self.records.secrets / intro.COMPOSE_VALUES
        self.assertEqual(json.loads(kept.read_text()), {"KIN_MONITOR_PUBLIC_DIR": value})
        if os.name == "posix":
            self.assertEqual(kept.stat().st_mode & 0o777, 0o600)
        docker.containers.pop(self.target["containers"]["proxy"])
        rollback = intro.HostOps(target=self.target, plan=plan, runner=docker, records=self.records)
        context.phase, context.recovering = "rollback", True
        result = rollback.prepare(context)
        self.assertEqual(result["immutable_entry"]["generation"], context.state["compose_entry"]["generation"])
        rollback.compose(["up", "-d", "--no-deps", "proxy"], mutating=True)
        self.assertEqual(docker.envs[-1].get("KIN_MONITOR_PUBLIC_DIR"), value)
        kept.unlink()
        reopened = intro.HostOps(target=self.target, plan=plan, runner=docker, records=self.records)
        reopened.prepare(context)
        self.assertEqual(reopened.entry.load()[2]["KIN_MONITOR_PUBLIC_DIR"], value)
        (reopened.entry.root / context.state["compose_entry"]["generation"] / "environment.json").write_bytes(b"{}")
        with self.assertRaises(intro.Stop):
            intro.HostOps(target=self.target, plan=plan, runner=docker, records=self.records).prepare(context)

    @unittest.skipUnless(os.name == "posix", "POSIX mode bits")
    def test_122_the_declared_checkout_correction_leaves_git_private(self):
        """RT-P3-GIT-MODE: with fix_checkout_mode, L-00a leaves the checkout and its .git at 0700 whatever their modes were
        (an open checkout; production after its window: checkout 0700, .git 0755), records both before and after and
        marks the host changed; contents below .git are not touched. An already private checkout is recorded unchanged."""
        git = self.repo / ".git"
        (git / "objects").mkdir(parents=True, exist_ok=True)
        (git / "objects").chmod(0o755)
        self.target["fix_checkout_mode"] = True
        for name, (checkout, git_mode, changed) in {"open checkout and .git": (0o775, 0o775, True),
                                                    "production after its window": (0o700, 0o755, True),
                                                    "already private": (0o700, 0o700, False)}.items():
            self.repo.chmod(checkout)
            git.chmod(git_mode)
            ops_host, _, context = self.host(prepare=False)
            with self.subTest(case=name):
                detail = ops_host.checkout_mode(context)
                self.assertEqual(detail, {"fixed": True, "before": {"checkout": oct(checkout), ".git": oct(git_mode)},
                                          "after": {"checkout": "0o700", ".git": "0o700"}})
                self.assertEqual(((self.repo.stat().st_mode & 0o7777), (git.stat().st_mode & 0o7777)), (0o700, 0o700))
                self.assertEqual((git / "objects").stat().st_mode & 0o777, 0o755, "never recursive")
                self.assertEqual(bool(context.state.get("host_changed")), changed)

    def test_91_the_seed_names_each_compose_variable_the_clone_env_lacks(self):
        """D28: before the seed no clone stack runs, so a VM target whose compose files require KIN_MONITOR_PUBLIC_DIR
        needs it in the clone's .env; the seed refuses with the variable and the file named, before any command."""
        (self.repo / "docker-compose.monitor.yml").write_text(MONITOR_COMPOSE, newline="\n")
        self.target["compose_files"] = [*self.target["compose_files"], "docker-compose.monitor.yml"]
        ops_host, docker, _ = self.host(prepare=False)
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
        https = lambda origin, path, *, token=None, **kwargs: (401, "", b"{}") if path == "/api/me" else (200, "", W2_ANSWERS.get(path, b"[]"))
        return (patch.object(intro, "smoke", return_value=full),
                patch.object(intro, "worklist_row", return_value={"uid": FRAME_STUDY, "modality": "CT"}),
                patch.object(intro, "https_get", side_effect=https), patch.object(intro, "https_post", return_value=(204, b"")))

    def test_95_a_retried_unattended_smoke_has_its_own_login_client_profile_and_record(self):
        """D07 at the host: the retry of the release smoke (the phase's retrying flag) makes its own login client and a new
        browser profile, keeps the first attempt's record beside its own, and the member's removal names both clients."""
        marker = self.root / "first-attempt"
        flaky = FAKE_BROWSER.replace("spec = json.loads(sys.stdin.read())",
                                     "spec = json.loads(sys.stdin.read())\nimport pathlib\nmark = pathlib.Path(%r)\nif not mark.exists():\n"
                                     "    mark.write_text('1')\n    os.makedirs(spec['profile_dir'])\n"
                                     "    print(json.dumps({'valid': False, 'error': 'synthetic first-attempt failure'}), file=sys.stderr)\n"
                                     "    sys.exit(1)" % str(marker))
        ops_host, docker, context = self.unattended(flaky)
        patches = self.smoke_patches()
        with patches[0], patches[1], patches[2], patches[3]:
            refuses(self, ops_host.unattended_release_smoke, context, ("127.0.0.1", 19444), message="synthetic first-attempt failure")
            (self.records.directory / "operator-smoke.json").write_text('{"first": "attempt"}\n')
            context.retrying = True
            result = ops_host.unattended_release_smoke(context, ("127.0.0.1", 19444))
        self.assertTrue(all(result["checks"].values()))
        self.assertTrue(json.loads((self.records.directory / "operator-smoke.json").read_text())["passed"])
        self.assertEqual(json.loads((self.records.directory / "operator-smoke-attempt-1.json").read_text()), {"first": "attempt"})
        member = context.state["smoke_member"]
        self.assertEqual(len(member["client_ids"]), 2, "the retry made its own login client")
        self.assertEqual(list(self.records.secrets.glob("browser-profile-*")), [])
        ops_host.remove_smoke_member(context)
        removal = next(call for call in docker.calls if call[:2] == ["docker", "compose"] and "run" in call
                       and any("kc-smoke-remove" in item for item in call))
        self.assertEqual(sorted(json.loads(removal[-1])["client_ids"]), sorted(member["client_ids"]))

    def test_96_a_browser_timeout_ends_its_whole_process_tree_and_removes_the_profile(self):
        """D17: a browser that runs past its time - or ends while a child it started keeps running with its pipes - is
        killed with every process it started (POSIX process group / Windows job object), and its profile folder goes."""
        for parent_waits in (True, False):
            pids = self.root / ("pid-%s" % parent_waits)
            ops_host, docker, context = self.unattended(LINGERING_BROWSER % (str(pids), parent_waits))
            with self.subTest(parent_waits=parent_waits), patch.object(intro, "BROWSER_TIMEOUT_S", 4):
                started = time.monotonic()
                refuses(self, lambda: ops_host.browser_login(context, connect=("127.0.0.1", 19444)))
                browser = [row for row in context.state["workers"].values() if row["kind"] == "browser"]
                self.assertEqual([(row["state"], row["termination"]) for row in browser], [("QUIET", "confirmed-timeout")])
                self.assertLess(time.monotonic() - started, 60)
                child = int(pids.read_text())
                deadline = time.monotonic() + 10
                while process_alive(child) and time.monotonic() < deadline:
                    time.sleep(0.2)
                self.assertFalse(process_alive(child), "the browser's child outlived the timeout")
                self.assertEqual(list(self.records.secrets.glob("browser-profile-*")), [])
            self.setUp()

    def baseline_host(self, *, member=None, browser=None, realm=None):
        # The browser/preflight fixture supplies a supported database observation. Closed PG admission has its own
        # negative tests and real-cluster rehearsal; this host double does not emulate PostgreSQL's catalogs.
        self.enterContext(patch.object(intro.ops, "restore_admission", side_effect=lambda container, **kw:
            (intro.ops.supported_catalog(intro.ops.role_catalog(container), shape=kw["shape"]), {"version": intro.ops.RESTORE_INVENTORY, "tables": []})))
        """HostOps.baseline (L-01) of a production target against FakeDocker: the previous release as the plan observed it."""
        repo = self.root / "production"
        repo.mkdir()
        for name in ("docker-compose.yml", "docker-compose.prod.yml", "docker-compose.monitor.yml"):
            (repo / name).write_text("services: {}\n")
        (repo / ".env").write_text("POSTGRES_PASSWORD=installer-placeholder-0001\n")
        backups = self.root / "production-backups"
        backups.mkdir(mode=0o700)   # the backup root is private (IRT2-03); a POSIX run checks it at L-01
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
            docker.containers[target["containers"][role]] = running_from(docker.config["pinned"], role, plan["previous"]["images"][role])
        docker.psql = {"_prisma_migrations": json.dumps([[n, c, True, False] for n, c in plan["migrations"]["before"]]),
                       "rolconnlimit": json.dumps(pre_catalog()), "service_account_client_link": json.dumps(plan["members"]),
                       "parent_group": json.dumps(realm or {"roles": ["admin", "clinician", "radiologist"], "top_level_groups": ["hallym", "kin-center"]})}
        ops_host = intro.HostOps(target=target, plan=plan, runner=docker, records=self.records, browser_cmd=browser)
        context = self.context(plan)
        ops_host.prepare(context)
        return ops_host, docker, context

    def test_97_the_smoke_browser_and_the_smoke_member_are_proved_at_l01_before_the_fence(self):
        """D01/D02: L-01 refuses a smoke browser command that is no executable file, a browser that fails or does not end
        within its bound, a planned smoke member whose role or group the realm lacks, and an unattended smoke without a
        planned member; a working browser and a fitting member pass (the probe's profile folder is removed)."""
        good = [sys.executable, "-c", FAKE_PROBE]
        ops_host, docker, context = self.baseline_host(browser=good)
        detail = ops_host.baseline(context)
        self.assertEqual(detail["smoke_browser"]["browser"], "chromium fake")
        self.assertEqual(detail["smoke_member_realm"], {"roles": ["radiologist"], "group": "hallym"})
        self.assertEqual(list(self.records.secrets.glob("browser-probe-*")), [])
        cases = {
            "no executable file": ({"browser": [str(self.root / "no-such-browser"), "browser-smoke"]}, "not an executable file"),
            "a browser that fails": ({"browser": [sys.executable, "-c", "import sys, json; print(json.dumps({'error': 'chromium missing'}), "
                                                                       "file=sys.stderr); sys.exit(1)"]}, None),
            "a browser that does not end": ({"browser": [sys.executable, "-c", "import time; time.sleep(600)"]}, None),
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
                if name == "a browser that fails":
                    browser = [row for row in context.state["workers"].values() if row["kind"] == "browser"]
                    self.assertEqual([(row["state"], row["client_exit"]) for row in browser], [("QUIET", 1)])
                if name == "a browser that does not end":
                    browser = [row for row in context.state["workers"].values() if row["kind"] == "browser"]
                    self.assertEqual([(row["state"], row["termination"]) for row in browser], [("QUIET", "confirmed-timeout")])
                # Nothing but L-01's own read-only Keycloak helper (a labelled one-shot, removed after its exit).
                self.assertEqual([call for call in docker.mutating() if not any("kc-serverinfo" in item for item in call)], [],
                                 "L-01 changes nothing")
                self.assertEqual(list(self.records.secrets.glob("browser-probe-*")), [])

    def test_99_a_declared_overlay_sits_right_after_docker_compose_prod_yml(self):
        """D09: production lists the overlay immediately after docker-compose.prod.yml (where Compose renders production's
        modified file byte-identically); a rehearsal lists docker-compose.prod.yml, its rehearsal override, the overlay.
        Anything else - after the monitor file, a file between - is refused by the manifest check, not at L-00b."""
        CommanderAdditionsTests.production_host(self)
        production = self.target
        overlay = str(self.overlay)
        intro.target_valid(production)
        rehearsal = target_fixture("rehearsal", str(self.repo))
        rehearsal.update(compose_files=["docker-compose.yml", "docker-compose.prod.yml", str(self.override), overlay, "docker-compose.monitor.yml"],
                         external_networks=copy.deepcopy(production["external_networks"]), declared_overlays=copy.deepcopy(production["declared_overlays"]))
        intro.target_valid(rehearsal)
        refused = {
            "production: the overlay after the monitor file": (production, ["docker-compose.yml", "docker-compose.prod.yml", "docker-compose.monitor.yml", overlay]),
            "production: the overlay before docker-compose.prod.yml": (production, ["docker-compose.yml", overlay, "docker-compose.prod.yml", "docker-compose.monitor.yml"]),
            "rehearsal: the monitor file between the override and the overlay": (
                rehearsal, ["docker-compose.yml", "docker-compose.prod.yml", str(self.override), "docker-compose.monitor.yml", overlay]),
            "rehearsal: the monitor file between docker-compose.prod.yml and the override": (
                rehearsal, ["docker-compose.yml", "docker-compose.prod.yml", "docker-compose.monitor.yml", str(self.override), overlay]),
        }
        for name, (base, files) in refused.items():
            bad = copy.deepcopy(base)
            bad["compose_files"] = files
            with self.subTest(case=name):
                refuses(self, intro.target_valid, bad, message="docker-compose.prod.yml")
        other = copy.deepcopy(production)
        other["tracked_overlay_reconcile"][0]["path"] = "docker-compose.yml"
        refuses(self, intro.target_valid, other, message="docker-compose.prod.yml")

    @unittest.skipUnless(shutil.which("docker"), "needs the docker CLI (`docker compose config` only: no container, no daemon change)")
    def test_100_compose_renders_production_s_modified_file_only_with_the_overlay_right_after_it(self):
        """D09 with real `docker compose config` (the product's compose files at this commit): production's modified
        docker-compose.prod.yml (the proxy joins the Halo network and binds report.conf) renders byte-identically to the
        committed file followed directly by the overlay, and differently with the overlay after the monitor file (the
        order D09 now refuses). The rehearsal order (prod, override, overlay) gives the proxy exactly that network entry
        and bind entry."""
        source = Path(__file__).resolve().parents[1]
        for name in ("docker-compose.yml", "docker-compose.prod.yml", "docker-compose.monitor.yml"):
            (self.repo / name).write_bytes((source / name).read_bytes())
        head = (self.repo / "docker-compose.prod.yml").read_text(encoding="utf-8")
        conf = (self.root / "halo-reports" / "report.conf").as_posix()
        modified = head.replace("      workflow: {}\n", "      workflow: {}\n      halo_reports: {}\n", 1)
        modified = modified.replace("      - /etc/kin-workflow/nginx:/etc/nginx/workflow:ro\n",
                                    "      - /etc/kin-workflow/nginx:/etc/nginx/workflow:ro\n      - " + conf + ":/etc/nginx/conf.d/halo-report.conf:ro\n", 1)
        modified = modified.replace("\nnetworks:\n", "\nnetworks:\n  halo_reports:\n    external: true\n    name: halo_reports_private\n", 1)
        self.assertNotEqual(modified, head)
        changed = self.root / "modified" / "docker-compose.prod.yml"
        changed.parent.mkdir()
        changed.write_text(modified, encoding="utf-8", newline="\n")
        overlay = self.root / "overlays" / "docker-compose.halo-reports.yml"
        overlay.parent.mkdir()
        overlay.write_bytes(HALO_OVERLAY.replace(b"/srv/halo-reports/nginx/report.conf", conf.encode()))
        texts = [path.read_bytes() for path in (self.repo / "docker-compose.yml", self.repo / "docker-compose.prod.yml", self.repo / "docker-compose.monitor.yml")]
        required = sorted(name for name, needed in intro.referenced_variables(texts).items() if needed)
        self.write_env("".join(name + "=synthetic-placeholder\n" for name in required if name != "KIN_MONITOR_PUBLIC_DIR")
                       + "KIN_MONITOR_PUBLIC_DIR=/home/ubuntu/.kin-monitor-public\nPUBLIC_ORIGIN=https://pacs.example.invalid\n")

        def config(files, project="pacs-starter-kit"):
            args = ["docker", "compose", "--project-directory", str(self.repo), "--project-name", project]
            for item in files:
                args += ["-f", str(item)]
            result = subprocess.run(args + ["config", "--format", "json"], capture_output=True, timeout=120)
            self.assertEqual(result.returncode, 0, result.stderr[-800:])
            return result.stdout
        base, monitor, prod = self.repo / "docker-compose.yml", self.repo / "docker-compose.monitor.yml", self.repo / "docker-compose.prod.yml"
        production_render = config([base, changed, monitor])
        self.assertEqual(config([base, prod, overlay, monitor]), production_render, "the overlay right after docker-compose.prod.yml")
        self.assertNotEqual(config([base, prod, monitor, overlay]), production_render, "the overlay after the monitor file")
        rendered = json.loads(production_render)["services"]["proxy"]
        target = target_fixture("rehearsal", str(self.repo))
        self.override.write_text(intro.rehearsal_override(target, target["origin"]), newline="\n")
        rehearsal = json.loads(config([base, prod, self.override, overlay], project=target["project"]))["services"]["proxy"]
        halo = lambda proxy: ([entry for entry in proxy["volumes"] if entry.get("target") == "/etc/nginx/conf.d/halo-report.conf"],
                              proxy["networks"].get("halo_reports", "absent"))
        self.assertEqual(halo(rehearsal), halo(rendered))
        self.assertEqual(len(halo(rendered)[0]), 1)

    @unittest.skipUnless(shutil.which("docker") and subprocess.run(["docker", "image", "inspect", PROXY_TEST_IMAGE], capture_output=True).returncode == 0
                         if shutil.which("docker") else False, "needs the docker daemon and the local proxy image " + PROXY_TEST_IMAGE)
    def test_102_the_certificate_check_refuses_a_foreign_key_and_a_foreign_chain(self):
        """D30, with the product's proxy image and real openssl: a clone certificate volume passes only when its kin.key is
        the certificate's own key and the certificate verifies against the CA file; a volume whose key belongs to another
        certificate, or a CA file of another authority, is refused (networkless, read-only check containers)."""
        token = uuid_hex()
        created = []

        def docker(*args, **kwargs):
            result = subprocess.run(["docker", *args], capture_output=True, timeout=120, **kwargs)
            self.assertEqual(result.returncode, 0, result.stderr[-800:])
            return result.stdout

        def filled(name, script):
            volume = "kin-rehearsal-" + token[:12] + "-" + name
            docker("volume", "create", "--label", "kin.ops.run=" + token, volume)
            created.append(volume)
            docker("run", "--rm", "--network", "none", "--label", "kin.ops.run=" + token, "--mount", "type=volume,source=" + volume + ",target=/certs",
                   "--entrypoint", "sh", PROXY_TEST_IMAGE, "-c", script)
            return volume

        def remove():
            for volume in created:
                subprocess.run(["docker", "volume", "rm", volume], capture_output=True)
        self.addCleanup(remove)
        pair = ("openssl req -x509 -nodes -newkey rsa:2048 -days 30 -keyout /certs/kin.key -out /certs/kin.crt -subj /CN=localhost "
                "-addext subjectAltName=DNS:localhost,IP:127.0.0.1 2>/dev/null")
        good = filled("good", pair)
        foreign = filled("foreign-key", pair + " && openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out /certs/kin.key 2>/dev/null")
        other = filled("other-authority", pair)
        read = lambda volume: docker("run", "--rm", "--network", "none", "--mount", "type=volume,source=" + volume + ",target=/certs,readonly",
                                     "--entrypoint", "cat", PROXY_TEST_IMAGE, "/certs/kin.crt")
        own_ca, other_ca, foreign_ca = self.root / "own-ca.pem", self.root / "other-ca.pem", self.root / "foreign-ca.pem"
        own_ca.write_bytes(read(good))
        other_ca.write_bytes(read(other))
        # The foreign-key volume's certificate is its own authority: only the key differs.
        foreign_ca.write_bytes(read(foreign))
        plan = self.plan()
        plan["previous"]["images"]["proxy"] = json.loads(docker("image", "inspect", PROXY_TEST_IMAGE))[0]["Id"]
        self.target.update(origin="https://localhost:19443")
        context = SimpleNamespace(plan=plan)
        outcomes = {}
        for name, volume, ca in (("own pair, own CA", good, own_ca), ("a foreign key", foreign, foreign_ca),
                                 ("another authority", good, other_ca)):
            self.target["ca_file"] = str(ca)
            ops_host = intro.HostOps(target=self.target, plan=plan, runner=intro.Runner(self.repo), records=self.records)
            model = {"mounts": {"proxy": [{"type": "volume", "source": "proxy-certs", "target": "/etc/nginx/certs"}]}, "volumes": {"proxy-certs": volume}}
            try:
                ops_host.certificate_volume_check(context, model)
                outcomes[name] = "accepted"
            except intro.Stop as error:
                outcomes[name] = str(error)
        self.assertEqual(outcomes["own pair, own CA"], "accepted")
        for name in ("a foreign key", "another authority"):
            self.assertIn("does not fit", outcomes[name], name)

    def test_105_l01_compares_the_running_containers_with_the_checked_model(self):
        """IRT2-02: same names and images, but a container on another project's volume, of another Compose project, on
        another network or publishing another port is refused at L-01, with nothing changed; an image's own anonymous
        volume is not a difference."""
        ops_host, docker, context = self.baseline_host()
        db = ops_host.t["containers"]["db"]
        docker.containers[db]["Mounts"].append({"Type": "volume", "Name": "a" * 64, "Destination": "/var/lib/postgresql/extra", "RW": True})
        docker.image_volumes[ops_host.plan["previous"]["images"]["db"]] = {"/var/lib/postgresql/extra": {}}
        ops_host.baseline(context)
        if PureWindowsPath(ops_host.t["repository"]).drive:
            # Docker Desktop reports a file bind as /run/desktop/mnt/host/<drive>/<path> (r3-rehearsal-04): the same file.
            orthanc = docker.containers[ops_host.t["containers"]["orthanc"]]["Mounts"][1]
            windows = PureWindowsPath(orthanc["Source"])
            orthanc["Source"] = "/run/desktop/mnt/host/" + windows.drive[0].lower() + "/" + "/".join(windows.parts[1:])
            ops_host.baseline(context)
        cases = {"a foreign volume": ("db", lambda item: item["Mounts"][0].__setitem__("Name", "pacs-old_pg-db"), "mounts"),
                 "another project": ("api", lambda item: item["Config"]["Labels"].__setitem__("com.docker.compose.project", "other"), "project"),
                 "another network": ("proxy", lambda item: item["NetworkSettings"]["Networks"].__setitem__("foreign_net", {}), "networks"),
                 "another published port": ("orthanc", lambda item: item["HostConfig"]["PortBindings"].__setitem__("8042/tcp", [{"HostIp": "", "HostPort": "8042"}]),
                                            "published ports"),
                 "a bind elsewhere": ("orthanc", lambda item: item["Mounts"][1].__setitem__("Source", "/srv/other/orthanc.json"), "mounts")}
        for name, (role, change, message) in cases.items():
            self.setUp()
            ops_host, docker, context = self.baseline_host()
            change(docker.containers[ops_host.t["containers"][role]])
            with self.subTest(case=name):
                refuses(self, ops_host.baseline, context, message=message)
                self.assertEqual([call for call in docker.mutating() if not any("kc-serverinfo" in item for item in call)], [])

    def test_107_each_smoke_check_needs_its_screen_and_its_api_contract(self):
        """IRT2-11: a W2 answer that is JSON but not its contract (e.g. `false`) fails its check, and every screen behind
        the checks - the worklist row, its Modality cell, the folders, the Reading Workspace with OHIF, the shortcuts
        dialog, the standalone viewer's image - must have been reached in the real browser; any one missing is no pass."""
        self.assertTrue(intro.folders_valid(json.loads(W2_ANSWERS["/api/filter-folders"])))
        self.assertTrue(intro.shortcuts_valid(json.loads(W2_ANSWERS["/api/workspace-shortcuts"])))
        v2 = {"version": 2, "list": "Control+Alt+Digit1", "image": None, "prior": "Control+Alt+Digit3",
              "report": "Control+Alt+Digit4", "context": "Control+Alt+Digit5", "note": "Control+Alt+Digit6",
              "tools": "Control+Alt+Digit7", "nativeTools": "Control+Alt+Digit9", "previous": "Control+Alt+ArrowLeft",
              "next": "Control+Alt+ArrowRight", "finalize": "Control+KeyS"}
        answer = {"owner": ["a", "b"], "revision": 2, "bindings": v2, "invalid": False}
        self.assertTrue(intro.shortcuts_valid(answer))
        self.assertFalse(intro.shortcuts_valid(dict(answer, bindings=dict(v2, report="Control+KeyS"))))
        for body in (False, None, [], {"owner": ["a", "b"], "revision": -1, "folders": [], "filters": []},
                     {"owner": ["a", "b"], "revision": 0, "folders": [{"path": "x"}], "filters": []}):
            self.assertFalse(intro.folders_valid(body), body)
        for body in (False, {"owner": ["a", "b"], "revision": 0, "bindings": {"list": "KeyC"}, "invalid": False},
                     {"owner": ["a", "b"], "revision": 0, "bindings": None}):
            self.assertFalse(intro.shortcuts_valid(body), body)
        ops_host, docker, context = self.unattended(FAKE_BROWSER)
        patches = self.smoke_patches()
        with patches[0], patches[1], patch.object(intro, "https_get", return_value=(200, "application/json", b"false")), patches[3]:
            refuses(self, ops_host.unattended_release_smoke, context, ("127.0.0.1", 19444), message="w2_folders,w2_shortcuts")
        for screen, check in (("worklist_row", "worklist_uid"), ("modality_rendered", "w2_modality"), ("folders_loaded", "w2_folders"),
                              ("reading_workspace", "ohif_frame"), ("shortcuts_dialog", "w2_shortcuts"), ("viewer_rendered", "ohif_frame")):
            self.setUp()
            ops_host, docker, context = self.unattended(FAKE_BROWSER.replace('"%s",' % screen if screen != "viewer_rendered" else '"viewer_rendered")',
                                                                             '' if screen != "viewer_rendered" else ')'))
            patches = self.smoke_patches()
            with self.subTest(screen=screen), patches[0], patches[1], patches[2], patches[3]:
                refuses(self, ops_host.unattended_release_smoke, context, ("127.0.0.1", 19444), message=check)

    def test_108_a_failed_member_creation_leaves_no_password_and_secrets_never_live_among_the_records(self):
        """IRT2-15: the smoke member's password, the browser profiles and the kept compose values live in the run's secrets
        directory, never in the run (evidence) directory; a creation that fails drops the password at once."""
        ops_host, docker, context = CommanderAdditionsTests.unattended_host(self)
        with patch.object(ops_host, "smoke_admin", side_effect=intro.Stop("synthetic create failure")):
            refuses(self, ops_host.create_smoke_member, context, "release", message="synthetic create failure")
        self.assertEqual(list(self.records.directory.glob("smoke-member-*.json")), [])
        self.assertEqual(list(self.records.secrets.glob("smoke-member-*.json")), [], "a refused creation keeps no password")
        member = ops_host.create_smoke_member(context, "release")
        self.assertTrue((self.records.secrets / member["credentials"]).is_file())
        self.assertFalse((self.records.directory / member["credentials"]).exists())
        self.assertNotEqual(self.records.secrets.resolve(), self.records.directory.resolve())
        self.assertNotIn(self.records.directory.resolve(), self.records.secrets.resolve().parents)

    def test_109_the_checkout_env_names_the_declared_compose_list_for_ordinary_commands(self):
        """IRT2-10: with a declared overlay, L-00b writes COMPOSE_FILE (the declared list) into the checkout's .env (once;
        recorded by hash), the staged env of the target must carry the same line, and the final allowlist / the recovery
        handover refuse a .env without it; a target without overlays changes nothing."""
        ops_host, docker, context = CommanderAdditionsTests.production_host(self)
        env = self.repo / ".env"
        env.write_text("POSTGRES_PASSWORD=placeholder-0001\n", newline="\n")
        detail = ops_host.reconcile_checkout(context)["ordinary_entry"]
        self.assertEqual(detail["compose_file"], "written")
        self.assertEqual(intro.parse_env(env.read_bytes())["COMPOSE_FILE"], os.pathsep.join(ops_host.t["compose_files"]))
        self.assertEqual(ops_host.reconcile_checkout(context)["ordinary_entry"], {"compose_file": "already named"})
        ops_host.intro = context
        ops_host.prepare_entry(context)
        active = ops_host.ordinary_entry_kept()
        self.assertEqual(active["generation"], context.state["compose_entry"]["generation"])
        # A line that already names the list stays where it stands (the plan's digest covers these bytes; r3-rehearsal-05
        # found the staged env refused only because its COMPOSE_FILE line was not the last one).
        middle = ("COMPOSE_FILE=" + intro.declared_compose_file(ops_host.t) + "\nPOSTGRES_PASSWORD=placeholder-0001\n").encode()
        self.assertTrue(intro.names_declared_list(middle, ops_host.t))
        env.write_bytes(middle)
        self.assertEqual(ops_host.reconcile_checkout(context)["ordinary_entry"], {"compose_file": "already named"})
        self.assertEqual(env.read_bytes(), middle)
        active = ops_host.ordinary_entry_kept()
        self.assertFalse(intro.names_declared_list(b"COMPOSE_FILE=docker-compose.yml\n", ops_host.t))
        env.write_text("POSTGRES_PASSWORD=placeholder-0001\n", newline="\n")
        self.assertEqual(ops_host.ordinary_entry_kept(), active, "handover uses the immutable entry, independently of checkout .env")
        staged = self.root / "env.next"
        staged.write_bytes(b"POSTGRES_PASSWORD=placeholder-0001\n")
        self.assertNotEqual(intro.env_with_compose_file(staged.read_bytes(), ops_host.t), staged.read_bytes())
        plain = target_fixture(repository=str(self.repo))
        self.assertEqual(intro.env_with_compose_file(b"A=1\n", plain), b"A=1\n")

    @unittest.skipUnless(shutil.which("docker"), "needs the docker CLI (`docker compose config` only)")
    def test_110_a_plain_compose_in_the_checkout_keeps_the_overlay_through_compose_file(self):
        """IRT2-10 with real Compose: in a checkout whose .env names the declared list, a plain `docker compose config`
        (no -f, as an operator types it) renders the overlay's bind and network on the proxy; without the line it does
        not."""
        source = Path(__file__).resolve().parents[1]
        for name in ("docker-compose.yml", "docker-compose.prod.yml"):
            (self.repo / name).write_bytes((source / name).read_bytes())
        conf = self.root / "halo-reports" / "report.conf"
        conf.parent.mkdir()
        conf.write_text("# synthetic\n")
        overlay = self.root / "overlays" / "docker-compose.halo-reports.yml"
        overlay.parent.mkdir()
        overlay.write_bytes(HALO_OVERLAY.replace(b"/srv/halo-reports/nginx/report.conf", conf.as_posix().encode()))
        target = target_fixture(repository=str(self.repo))
        target.update(compose_files=["docker-compose.yml", "docker-compose.prod.yml", str(overlay)],
                      declared_overlays=[{"file": str(overlay), "sha256": intro.sha256_bytes(overlay.read_bytes()), "service": "proxy",
                                          "binds": [{"source": str(conf), "target": "/etc/nginx/conf.d/halo-report.conf", "read_only": True}]}])
        texts = [path.read_bytes() for path in (self.repo / "docker-compose.yml", self.repo / "docker-compose.prod.yml")]
        base = "".join(name + "=synthetic-placeholder\n" for name, needed in intro.referenced_variables(texts).items() if needed).encode()
        environment = {key: value for key, value in os.environ.items() if not key.startswith("COMPOSE_")}

        def proxy(env_raw):
            (self.repo / ".env").write_bytes(env_raw)
            result = subprocess.run(["docker", "compose", "config", "--format", "json"], cwd=str(self.repo), env=environment,
                                    capture_output=True, timeout=120)
            self.assertEqual(result.returncode, 0, result.stderr[-800:])
            return json.loads(result.stdout)["services"]["proxy"]
        wired = proxy(intro.env_with_compose_file(base, target))
        self.assertIn("halo_reports", wired["networks"])
        self.assertTrue(any(entry.get("target") == "/etc/nginx/conf.d/halo-report.conf" for entry in wired["volumes"]))
        bare = proxy(base)
        self.assertNotIn("halo_reports", bare.get("networks") or {})

    @unittest.skipUnless(os.name == "posix" and hasattr(os, "geteuid") and os.geteuid() == 0, "POSIX root (ancestor owners and modes)")
    def test_111_every_folder_above_a_declared_overlay_is_protected(self):
        """IRT2-19: a folder above the overlay's own folder that others can write, or a link on the path, refuses the
        overlay; the normal root-owned path is accepted."""
        ops_host, docker, context = CommanderAdditionsTests.production_host(self)
        ops_host.declared_overlay_facts()
        self.overlays.parent.chmod(0o777)
        refuses(self, ops_host.declared_overlay_facts, message="writable by others")
        self.overlays.parent.chmod(0o755)
        os.chown(self.overlays.parent, 1000, 1000)
        refuses(self, ops_host.declared_overlay_facts, message="another owner")
        os.chown(self.overlays.parent, 0, 0)
        moved = self.root / "real-kin-deploy"
        self.overlays.parent.rename(moved)
        (self.root / "kin-deploy").symlink_to(moved, target_is_directory=True)
        refuses(self, ops_host.declared_overlay_facts, message="link")

    @unittest.skipUnless(shutil.which("node"), "needs node (the Linux root fixture has it)")
    def test_112_a_same_named_account_or_client_is_never_deleted(self):
        """IRT2-23 with the real administration script: a pre-existing account and client with the smoke names make the
        creation refuse ('exists'), and the cleanup deletes only what carries this run's marker - the foreign account and
        client stay."""
        import http.server
        import threading
        store = {"users": [{"id": "foreign-user", "username": "kin-smoke-x", "lastName": "someone"}],
                 "clients": [{"id": "foreign-client", "clientId": "kin-smoke-x-client", "description": "not ours"}], "deleted": []}

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def respond(self):
                path = self.path.split("?")[0]
                body, status = {}, 200
                if path.endswith("/token"):
                    body = {"access_token": "t"}
                elif path == "/admin/realms/kin/users":
                    body = store["users"]
                elif path == "/admin/realms/kin/clients":
                    body = store["clients"]
                elif self.command == "DELETE":
                    store["deleted"].append(path)
                    for kind in ("users", "clients"):
                        store[kind] = [item for item in store[kind] if path != "/admin/realms/kin/%s/%s" % (kind, item["id"])]
                raw = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
            do_GET = do_POST = do_PUT = do_DELETE = respond
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        env = {**os.environ, "KC_ADMIN_URL": "http://127.0.0.1:%d" % server.server_address[1], "KIN_KC_ADMIN_USER": "admin",
               "KIN_KC_ADMIN_PASSWORD": "synthetic", "KIN_SMOKE_PASSWORD": "synthetic"}
        run = lambda operation, payload: subprocess.run(["node", "-e", intro.SMOKE_ADMIN_SCRIPT, operation, json.dumps(payload)], env=env,
                                                        capture_output=True, timeout=120)
        created = run("create-member", {"username": "kin-smoke-x", "roles": ["radiologist"], "group": "hallym", "marker": "m" * 32})
        self.assertNotEqual(created.returncode, 0)
        self.assertIn(b"exists", created.stderr)
        client = run("create-client", {"client_id": "kin-smoke-x-client", "redirect_uri": "https://kin-smoke-callback.invalid/x", "marker": "m" * 32})
        self.assertIn(b"exists", client.stderr)
        removed = run("remove", {"username": "kin-smoke-x", "client_ids": ["kin-smoke-x-client"], "marker": "m" * 32})
        self.assertEqual(removed.returncode, 0, removed.stderr)
        self.assertEqual(intro.result_line(removed.stdout), {"user_absent": True, "client_absent": True, "foreign_users": 1, "foreign_clients": 1})
        self.assertEqual(store["deleted"], [], "nothing this run did not make was deleted")
        # A creation whose answer was lost (or that failed half-way) left this run's own marked account and client: the
        # cleanup finds them by the marker and removes exactly those.
        store["users"].append({"id": "own-user", "username": "kin-smoke-y", "lastName": "m" * 32})
        store["clients"].append({"id": "own-client", "clientId": "kin-smoke-y-client", "description": "kin-smoke " + "m" * 32})
        identity = {"username": "kin-smoke-y", "client_ids": ["kin-smoke-y-client"], "marker": "m" * 32}
        refused = run("remove", identity)
        self.assertNotEqual(refused.returncode, 0, "a marker alone cannot authorize deletion without immutable IDs")
        self.assertEqual(store["deleted"], [])
        owned = run("owned", identity)
        self.assertEqual(owned.returncode, 0, owned.stderr)
        ids = intro.result_line(owned.stdout)
        self.assertEqual(ids, {"users": ["own-user"], "clients": ["own-client"]})
        removed = run("remove", {**identity, "user_ids": ids["users"], "object_ids": ids["clients"]})
        self.assertEqual(removed.returncode, 0, removed.stderr)
        self.assertEqual(intro.result_line(removed.stdout), {"user_absent": True, "client_absent": True, "foreign_users": 0, "foreign_clients": 0})
        self.assertEqual(store["deleted"], ["/admin/realms/kin/users/own-user", "/admin/realms/kin/clients/own-client"])
        self.assertEqual([item["id"] for item in store["users"]], ["foreign-user"])
        self.assertEqual([item["id"] for item in store["clients"]], ["foreign-client"])

    def test_114_the_ended_sessions_original_cookie_is_sent_again_from_outside_the_browser(self):
        """IRT2-12: after the product logout, the ended session's original cookie (and its binding) goes to /api/me again
        from a separate connection; a server that only cleared the cookie and still accepts the session answers 200 there,
        which is no 'old session refused'. Only the status leaves."""
        import http.server
        import threading
        revoked = {"value": False}
        seen = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                seen.append((self.path, self.headers.get("Cookie"), self.headers.get("X-KIN-Session")))
                accepted = self.headers.get("Cookie") == "kin_sid=still-valid" and not revoked["value"]
                self.send_response(200 if accepted else 401)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"{}")
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        spec = {"origin": "http://127.0.0.1:%d" % server.server_address[1]}
        headers = {"Cookie": "kin_sid=still-valid", "X-KIN-Session": "binding"}
        self.assertEqual(intro.session_replay(spec, headers), 200, "a session the server kept is seen as accepted")
        session = {"signed_in": True, "logout_status": 204, "old_session_status": 200, "old_cookie_status": 200}
        self.assertFalse(intro.product_logout_refused(session))
        revoked["value"] = True
        self.assertEqual(intro.session_replay(spec, headers), 401)
        self.assertEqual(seen[-1], ("/api/me", "kin_sid=still-valid", "binding"))

    @unittest.skipUnless(shutil.which("docker"), "needs the docker CLI (`docker compose config` only: no container)")
    def test_117_a_bind_source_variable_resolves_with_the_real_compose_rendering(self):
        """IRT-12/D04 with real Compose rendering (found by the forced rehearsal r3-rehearsal-forced-03): the product's
        docker-compose.monitor.yml binds ${KIN_MONITOR_PUBLIC_DIR}; Compose renders the resolution marker, a relative
        source, against the project directory - still the variable's whole source, so the value comes from the running
        proxy's mount. A source that only contains the variable (/srv/${...}) stays unresolvable."""
        source = Path(__file__).resolve().parents[1]
        (self.repo / "docker-compose.yml").write_text("services:\n  proxy:\n    image: synthetic/proxy:1\n", newline="\n")
        monitor = (source / "docker-compose.monitor.yml").read_text(encoding="utf-8")
        self.assertIn("${KIN_MONITOR_PUBLIC_DIR:?", monitor)
        (self.repo / "docker-compose.monitor.yml").write_text(monitor, encoding="utf-8", newline="\n")
        self.target["compose_files"] = [*self.target["compose_files"], "docker-compose.monitor.yml"]
        ops_host, docker, context = self.host()
        value = "/home/ubuntu/.kin-monitor-public"
        clean = {key: item for key, item in os.environ.items() if not key.startswith("COMPOSE_")}

        def config_for(args, env):
            result = subprocess.run(args, env={**clean, **env}, capture_output=True, timeout=120)
            self.assertEqual(result.returncode, 0, result.stderr[-800:])
            return json.loads(result.stdout)
        docker.config_for = config_for
        docker.containers[self.target["containers"]["proxy"]] = {"Image": image("2"), "State": {"Running": True}, "Config": {"Env": []},
                                                                 "Mounts": [{"Destination": "/var/run/kin-monitor-public", "Source": value}]}
        entry = ops_host.prepare(self.context(ops_host.plan))["resolved_from_running_stack"]["KIN_MONITOR_PUBLIC_DIR"]
        self.assertEqual((entry["sha256"], entry["from"]), (intro.sha256_bytes(value.encode()), ["mount:proxy"]))
        (self.repo / "docker-compose.monitor.yml").write_text(monitor.replace("source: ${KIN_MONITOR_PUBLIC_DIR", "source: /srv/${KIN_MONITOR_PUBLIC_DIR"),
                                                              encoding="utf-8", newline="\n")
        self.records.discard_secret(intro.COMPOSE_VALUES)   # another plan: nothing kept
        refuses(self, intro.HostOps(target=self.target, plan=ops_host.plan, runner=docker, records=self.records).prepare,
                self.context(ops_host.plan), message="Unresolvable compose variable: KIN_MONITOR_PUBLIC_DIR")

    def test_115_the_seeds_clone_changes_touch_only_their_keycloak_tables(self):
        """IRT2-24: changed/lost/new tables are identified without values or ambiguous dotted names. Authorization is
        separately checked against exact precomputed rows, including residual fields inside changed tables."""
        def row(database, schema, name):
            return intro.ops.value_digest((database, schema, "table", name, None), ["id"], [["before"]])
        seed = {"version": intro.ops.RESTORE_INVENTORY, "tables": [row("kin", "public", "Report"),
            row("keycloak", "public", "client"), row("keycloak", "public", "user_entity")]}
        after = copy.deepcopy(seed)
        self.assertEqual(intro.value_changes(seed, after), set())
        after["tables"][1]["sha256"] = "d" * 64
        self.assertEqual(intro.value_changes(seed, after), {("keycloak", "public", "table", "client", None)})
        after["tables"][2]["sha256"] = "e" * 64
        after["tables"].append(row("kin", "archive", "new"))
        del after["tables"][0]
        self.assertEqual(intro.value_changes(seed, after), {("keycloak", "public", "table", "client", None),
            ("keycloak", "public", "table", "user_entity", None), ("kin", "archive", "table", "new", None), ("kin", "public", "table", "Report", None)})

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
        smoke_policy = {"browserFlow": "browser", "passwordPolicy": "", "requiredActions": [], "executions": []}
        answers.update({("GET", "/admin/realms/kin"): [(200, {"browserFlow": "browser", "passwordPolicy": ""})],
                        ("GET", "/admin/realms/kin/authentication/required-actions"): [(200, [])],
                        ("GET", "/admin/realms/kin/authentication/flows/browser/executions"): [(200, [])]})
        answers.update({("GET", "/realms/master"): [(404, {}), (200, {})], ("POST", "/realms/master/protocol/openid-connect/token"): token,
                        ("GET", "/admin/serverinfo"): [(404, {}), (200, info)]})
        out = subprocess.run(["node", "-e", intro.SERVERINFO_SCRIPT], env=env, capture_output=True, timeout=120)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(intro.result_line(out.stdout), {"useCaches": "false", "persistentUserSessions": True, "smokePolicy": smoke_policy})
        self.assertEqual(seen.count(("GET", "/realms/master")), 2)
        self.assertEqual(seen.count(("GET", "/admin/serverinfo")), 2)
        seen.clear()
        answers.update({("GET", "/realms/kin"): [(404, {}), (404, {}), (200, {})], ("POST", "/realms/master/protocol/openid-connect/token"): token,
                        ("GET", "/admin/realms/kin/users"): [(200, [])], ("GET", "/admin/realms/kin/clients"): [(200, [])]})
        payload = json.dumps({"username": "kin-smoke-x", "client_ids": ["kin-smoke-x-client", "kin-smoke-x-client-2"], "marker": "m" * 32})
        out = subprocess.run(["node", "-e", intro.SMOKE_ADMIN_SCRIPT, "remove", payload], env=env, capture_output=True, timeout=120)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(intro.result_line(out.stdout), {"user_absent": True, "client_absent": True, "foreign_users": 0, "foreign_clients": 0})
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

    def test_101_matching_receipts_do_not_expire_and_clock_differences_are_recorded(self):
        """An unchanged release/snapshot remains rehearsed across calendar and host-clock differences."""
        plan, production = plan_fixture(), production_identity()
        now = datetime.now(timezone.utc)
        for created, b0 in ((now - timedelta(days=8), None), (now + timedelta(hours=1), None),
                            (now - timedelta(hours=1), now), (datetime(2000, 1, 1, tzinfo=timezone.utc), None)):
            receipt, bundle = receipt_bundle(plan, self.root / ("bundle-" + created.isoformat().replace(":", "-")), created=created)
            with self.subTest(created=created.isoformat(), b0=b0 and b0.isoformat()):
                check = lambda: intro.receipt_valid(receipt, plan, "8" * 64, production, now=now, b0_created_utc=b0 and b0.isoformat(),
                                                    bundle=bundle)
                check()
        self.run_phase("capture")
        receipt, bundle = receipt_bundle(plan_fixture(target_fixture(repository=str(self.repository))), self.root / "bundle-ahead",
                                         created=NOW + timedelta(minutes=3))
        self.assertEqual(self.run_phase("introduce", {"local-restore": receipt, "local-restore-bundle": bundle})["status"], "INTRODUCED")
        journal = [json.loads(line) for line in (self.records.directory / "journal.jsonl").read_text().splitlines()]
        start = next(entry for entry in journal if entry["event"] == "phase-start" and entry["phase"] == "introduce")
        self.assertEqual(start["receipt_clock"], {"ahead_of_production_s": 180.0})

    def test_103_the_release_smoke_gets_one_bounded_retry_before_an_automatic_rollback(self):
        """D07 (IRT2-08): a settled refusal of the fenced smoke is retried once within SMOKE_RETRY_S, recorded (state,
        journal, the step's detail); a passing retry verifies without any rollback, the step list stays exact (a receipt
        still sees every step once) and nothing else repeats. A retry that fails, or exceeds its bound, is the step's STOP
        and the settled-failure path rolls back; an unknown end is never retried."""
        holder = self

        class Flaky(FakeOps):
            def __init__(self, failures, slow=False):
                super().__init__()
                self.failures, self.slow = failures, slow

            def effect_fenced_smoke(self, context):
                if self.slow and self.calls.count("fenced_smoke") == 2:
                    holder.clock.value += 121   # beyond the 120 s bound of the retry
                if self.calls.count("fenced_smoke") <= self.failures:
                    raise intro.Stop("synthetic transient browser startup")
                return {"checks": "passed"}
        for name, ops_object, status in (("first attempt fails", Flaky(1), "VERIFIED"), ("both attempts fail", Flaky(2), "RESTORED"),
                                         ("the retry exceeds its bound", Flaky(1, slow=True), "RESTORED")):
            self.setUp()
            self.ops = ops_object
            self.deploy_through("introduce")
            with self.subTest(case=name):
                result = self.run_phase("verify")
                self.assertEqual(result["status"], status)
                self.assertEqual(self.ops.calls.count("fenced_smoke"), 2)
                self.assertEqual((self.ops.calls.count("migrate"), self.ops.calls.count("probe")), (1, 0 if status != "VERIFIED" else 1))
                state = self.records.state()
                self.assertEqual((state["smoke_retry"]["reason"], state["smoke_retry"]["passed"]),
                                 ("synthetic transient browser startup", status == "VERIFIED"))
                journal = [json.loads(line) for line in (self.records.directory / "journal.jsonl").read_text().splitlines()]
                self.assertEqual(sum(1 for entry in journal if entry["event"] == "smoke-retry"), 1)
                (written,) = self.records.directory.glob("result-verify-*.json")
                steps = json.loads(written.read_text())["steps"]
                self.assertEqual([step["step"] for step in steps if step["step"] == "L-10a"], ["L-10a"])
                if status == "VERIFIED":
                    self.assertEqual([step["step"] for step in steps], [sid for sid, _ in ACTION_CONTRACT["verify"]])
                    self.assertEqual(steps[0]["detail"]["retry"], {"reason": "synthetic transient browser startup", "passed": True})
                else:
                    self.assertIn("preserve_failed", self.ops.calls)
        self.setUp()
        self.deploy_through("introduce")
        self.ops.faults["fenced_smoke"] = intro.Unknown("browser state unknown")
        self.assertEqual(self.run_phase("verify")["status"], "NEEDS_ATTENTION")
        self.assertEqual(self.ops.calls.count("fenced_smoke"), 1, "an unknown end is never retried")

    def test_104_a_step_whose_host_cannot_be_observed_never_passes(self):
        """IRT2-22: no observation before a step - it does not run (the capture changes nothing, the lock is freed); no
        observation after a changing step - its end is unknown (NEEDS_ATTENTION, no automatic rollback); after a read-only
        step - a refusal; a running database whose migration history cannot be read is no observation."""
        with patch.object(self.ops, "snapshot", side_effect=OSError("synthetic observer unavailable")):
            result = self.run_phase("capture")
        self.assertEqual((result["status"], result["phase_passed"]), ("NEW", False))
        self.assertEqual(self.ops.calls, [])
        self.assertEqual(len(result["steps"]), 1, "the refused entry still needs its failed before-observation record")
        self.assertEqual(result["steps"][0]["outcome"], "STOP")
        self.assertFalse(self.lock_held())
        original = self.ops.snapshot
        calls = {"n": 0}

        def after_fence_fails(context):
            calls["n"] += 1
            if "fence" in self.ops.calls and calls["n"] > 0 and self.ops.calls[-1] == "fence":
                return {"unobservable": "OSError"}
            return original(context)
        with patch.object(self.ops, "snapshot", side_effect=after_fence_fails):
            result = self.run_phase("capture")
        self.assertEqual(result["status"], "NEEDS_ATTENTION")
        self.assertEqual([(step["step"], step["outcome"]) for step in result["steps"]][-1], ("L-04a", "UNKNOWN"))
        self.assertTrue(self.lock_held())
        self.assertFalse(intro.observed({"running": {"db": image("3")}, "migrations": {"unobservable": "RuntimeError"}}))
        self.assertFalse(intro.observed({"running": {"db": None}, "migrations": {"unobservable": "RuntimeError"}}))

    def test_116_browser_profiles_a_crash_left_go_at_the_next_phase_start(self):
        """IRT2-15: a browser profile folder (its session cookies) that a killed process left in the secrets directory is
        removed when the next phase starts, the count recorded, nothing of its contents; a link there is removed without
        following it; other secrets (the kept values) stay."""
        left = self.records.secret("browser-profile-0123abcd")
        left.mkdir()
        (left / "Cookies").write_bytes(b"synthetic cookie store")
        outside = self.root / "outside-profile"
        outside.mkdir()
        (outside / "keep").write_text("x")
        linked = self.records.secrets / "browser-probe-89abcdef"
        if os.name == "posix":
            linked.symlink_to(outside, target_is_directory=True)
        values = self.records.secret(intro.COMPOSE_VALUES)
        values.write_text("{}\n")
        self.assertEqual(self.run_phase("capture")["status"], "HELD")
        self.assertFalse(left.exists())
        self.assertFalse(os.path.lexists(linked))
        self.assertTrue((outside / "keep").exists(), "a link is never followed")
        self.assertTrue(values.exists())
        journal = [json.loads(line) for line in (self.records.directory / "journal.jsonl").read_text().splitlines()]
        swept = [entry for entry in journal if entry["event"] == "secrets-swept"]
        self.assertEqual([entry["browser_profiles"] for entry in swept], [2 if os.name == "posix" else 1])
        self.assertNotIn("synthetic cookie store", (self.records.directory / "journal.jsonl").read_text())

    def test_94_recovery_warnings_are_in_the_result_and_the_kept_values_end_with_the_plan(self):
        """D05/D06: warnings handed to a phase (the entry's) or recorded by its steps are in its result, its result file
        and its phase-start record. D04: the private values file is kept while the plan runs and removed when it ends."""
        self.deploy_through("introduce")
        values = self.records.secret(intro.COMPOSE_VALUES)
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
    def test_118_docker_desktop_bind_sources_name_the_host_path_only_on_a_windows_rehearsal(self):
        """IRT2-02/D04 on a Windows rehearsal host (r3-rehearsal-04): Docker Desktop reports a bind made through the mount
        API as /run/desktop/mnt/host/<drive>/<path>; that is the host path <drive>:/<path>. A Linux target (production,
        the VM) gets every source exactly as reported."""
        self.assertEqual(intro.host_bind_source("/run/desktop/mnt/host/c/Users/x/report.conf", r"C:\work\repo"), "C:/Users/x/report.conf")
        self.assertEqual(intro.host_bind_source(r"C:\Users\x\folder", r"C:\work\repo"), r"C:\Users\x\folder")
        for source in ("/run/desktop/mnt/host/c/Users/x", "/home/ubuntu/.kin-monitor-public"):
            self.assertEqual(intro.host_bind_source(source, "/srv/kin/repository"), source)

    @unittest.skipUnless(os.name == "posix" and Path("/usr/bin/env").is_file(), "the supervised browser command is a POSIX host's")
    def test_120_the_supervised_browser_smoke_writes_no_bytecode_into_the_tools_folder(self):
        """RT-P3-PYCACHE (prep3 readiness3 §3-2, prep5 readiness5 note 2): the supervised smoke and the L-01 probe run the
        protected install's own ops_emr_introduction.py; the first one wrote /opt/kin-deploy/lib/__pycache__ into that
        install. The command the supervisor runs, executed as built against a copy of the tool folder, leaves no
        __pycache__ there, while the policy's command run as it is does (the control: the entry imports cacheable
        modules from its folder). The host admission of the command (root, systemd with cgroup v2, protected paths) is
        given here; the policy's interpreter, tool path and subcommand are kept."""
        import ops_deploy_host
        scripts = Path(intro.__file__).resolve().parent
        browsers = tempfile.TemporaryDirectory(prefix="kin-browsers-")
        self.addCleanup(browsers.cleanup)
        policy = ["/usr/bin/env", "PLAYWRIGHT_BROWSERS_PATH=" + browsers.name, sys.executable, intro.__file__, "browser-smoke"]
        host = {"/run/systemd/system", "/sys/fs/cgroup/cgroup.controllers"}
        real_dir, real_file = Path.is_dir, Path.is_file
        with patch.object(intro.os, "geteuid", return_value=0), patch.object(ops_deploy_host, "protected"), \
                patch.object(Path, "is_dir", lambda path: str(path) in host or real_dir(path)), \
                patch.object(Path, "is_file", lambda path: str(path) in host or real_file(path)):
            command = intro.SystemdBrowser.command(policy)
        self.assertEqual(command[:2], ["/usr/bin/env", "-i"])
        self.assertIn("PLAYWRIGHT_BROWSERS_PATH=" + browsers.name, command)
        self.assertEqual([item for item in command if item in (sys.executable, intro.__file__, "browser-smoke")],
                         [sys.executable, intro.__file__, "browser-smoke"])

        def run(argv):
            folder = Path(tempfile.mkdtemp(prefix="kin-lib-"))
            self.addCleanup(shutil.rmtree, folder, True)
            for path in scripts.glob("ops_*.py"):
                shutil.copy2(path, folder / path.name)
            tool = str(folder / Path(intro.__file__).name)
            result = subprocess.run([tool if item == intro.__file__ else item for item in argv], stdin=subprocess.DEVNULL,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
            # an empty spec is refused by the entry itself (after its imports), with its record-safe error line
            self.assertEqual(result.returncode, 1, result.stderr[-2000:])
            self.assertIn(b'"valid": false', result.stderr)
            return folder

        control = run(["/usr/bin/env", "-i", "PATH=/usr/bin:/bin", "HOME=/nonexistent", *policy[2:]])
        self.assertTrue((control / "__pycache__").is_dir(), "the control writes bytecode beside the tool")
        supervised = run(command)
        self.assertFalse((supervised / "__pycache__").exists(), sorted(p.name for p in supervised.rglob("*")))

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
        example = intro.example_target()
        with self.assertRaises(intro.Stop):
            intro.target_valid(example, operational=True)
        example["declared_overlays"][0]["sha256"] = "1" * 64
        intro.target_valid(example, operational=True)
        intro.identity_valid(policy["production"])


@unittest.skipUnless(os.name == "posix" and hasattr(os, "geteuid") and os.geteuid() == 0
                     and os.environ.get("KIN_TEST_ISOLATED_INSTALL") == "1", "isolated Linux root fixture required")
class ProtectedHostTests(unittest.TestCase):
    """The entry adapter's root-owned policy, documents by hash and one-use approval (as ops_deploy_host's HostTests)."""

    def setUp(self):
        self.enterContext(patch.object(intro.HostOps, "admit_source", return_value={"admitted": True, "version": intro.ops.RESTORE_INVENTORY}))
        folder = tempfile.TemporaryDirectory(prefix="kin-emr-host-", dir="/root")
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
        self.halo = Path("/etc/kin-deploy/overlays/docker-compose.halo-reports.yml")
        self.halo.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        overlay = {"services": {"proxy": {"networks": {"halo_reports": None},
                    "volumes": [{"type": "bind", "source": "/srv/halo-reports/nginx/report.conf",
                                 "target": "/etc/nginx/conf.d/halo-report.conf", "read_only": True}]}},
                   "networks": {"halo_reports": {"external": True, "name": "halo_reports_private"}}}
        self.halo.write_bytes(intro.canonical(overlay))
        self.halo.chmod(0o600)
        bind = Path("/srv/halo-reports/nginx/report.conf")
        bind.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
        bind.write_text("# isolated synthetic Halo binding\n", encoding="utf-8", newline="\n")
        bind.chmod(0o644)
        target = self.operational_target()
        self.target_sha = self.document("emr-targets", target)
        plan = plan_fixture(target)
        self.plan_sha = self.document("emr-plans", plan)

    def operational_target(self):
        target = target_fixture(repository=str(self.repo))
        example = intro.example_target()
        for key in ("compose_files", "declared_overlays", "external_networks"):
            target[key] = example[key]
        target["declared_overlays"][0]["sha256"] = intro.sha256_bytes(self.halo.read_bytes())
        return target

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
        self.assertEqual(host.execute(raw)["status"], "REJECTED")
        digest = self.approve(raw)
        calls = []
        original, key = intro.Introduction.run, intro.local_host_key
        intro.Introduction.run = lambda machine, request, request_sha256: calls.append(request_sha256) or {"status": "x"}
        intro.local_host_key = lambda: "a" * 64
        try:
            host.execute(raw)
            self.assertEqual(host.execute(raw)["status"], "REJECTED")
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
        self.assertEqual(host.execute(raw)["status"], "REJECTED")
        self.repo.chmod(0o700)
        os.chown(self.repo, 1001, 1001)
        with self.assertRaisesRegex(intro.Stop, "another owner"):
            intro.IntroductionHost(self.policy_path)

    def test_54_git_runs_as_the_checkout_owner_and_env_keeps_its_owner(self):
        owner = {"uid": 1000, "gid": 1000}
        # /root itself is private; making only its child traversable cannot model an operating-account checkout.
        accessible = tempfile.TemporaryDirectory(prefix="kin-emr-owner-", dir="/tmp")
        self.addCleanup(accessible.cleanup)
        parent = Path(accessible.name)
        parent.chmod(0o755)
        repo = parent / "owned"
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

    def test_113_the_backup_root_of_the_operating_account_is_accepted_at_l01_and_any_other_owner_is_refused(self):
        """IRT2-03: the protected entry runs as root; the production backup root is the checkout's operating account's
        private folder (with its ledger). L-01 accepts it when that account is the policy's repository owner, refuses
        another owner or an open mode before any fence, and changes nothing of it."""
        owner = {"uid": 1000, "gid": 1000}
        policy = json.loads(self.policy_path.read_bytes())
        policy["repository_owner"] = owner
        self.write(self.policy_path, policy)
        for path in (self.repo, self.repo / ".git"):
            os.chown(path, 1000, 1000)
        for name, (uid, mode, outcome) in {"the operating account's 0700 folder": (1000, 0o700, "PASS"),
                                           "another account's folder": (1001, 0o700, "STOP"),
                                           "an open folder": (1000, 0o750, "STOP")}.items():
            with self.subTest(case=name):
                result, runs, docker = self.installed_run(backup_owner=(uid, mode), prepare=lambda runs: os.chown(self.repo / ".env", 1000, 1000))
                steps = {step["step"]: step for step in result["steps"]}
                self.assertEqual(steps["L-01"]["outcome"], outcome, result)
                if outcome == "STOP":
                    self.assertIn("backup root", steps["L-01"]["code"])
                    self.assertNotIn("L-04a", steps)
                info = (self.root / "backups").stat()
                self.assertEqual((info.st_uid, info.st_mode & 0o777), (uid, mode), "the backup root is never changed")
                shutil.rmtree(runs)
                shutil.rmtree(self.root / "backups")
                (self.repo / ".kin-ops.lock").unlink(missing_ok=True)

    def installed_run(self, *, prepare=None, target_changes=None, backup_owner=None):
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
        if backup_owner:
            os.chown(backups, backup_owner[0], backup_owner[0])
            backups.chmod(backup_owner[1])
        target = self.operational_target()
        target.update(target_changes or {})
        self.document("emr-targets", target)
        plan = plan_fixture(target)
        now = datetime.now(timezone.utc)
        # The approved baseline includes L-00b's declared COMPOSE_FILE, even when the installed checkout starts without it.
        planned_env = intro.env_with_compose_file((repo / ".env").read_bytes(), target)
        entries = [(name, (repo / name).read_bytes()) for name in target["compose_files"]] + [(".env", planned_env)]
        plan.update(window={"start": (now - timedelta(hours=1)).isoformat(), "end": (now + timedelta(hours=2)).isoformat()},
                    backup_root=str(backups), tool=intro.tool_hashes())
        plan["compose"]["before_sha256"] = intro.compose_digest(entries)
        plan["budget"]["min_free_bytes"] = 1024 ** 3
        plan_sha = self.document("emr-plans", plan)
        docker = FakeDocker(target, plan)
        docker.config["pinned"] = compose_config(target, previous_images=plan["previous"]["images"],
                                                extra_networks=target["external_networks"]["proxy"],
                                                extra_binds=[{"type": "bind", **bind} for bind in target["declared_overlays"][0]["binds"]])
        docker.crontab = "".join("0 3 * * * /usr/bin/true # " + tag + "\n" for tag in target["cron"]["tags"])
        docker.image_labels = {"org.opencontainers.image.revision": plan["previous"]["sha"]}
        for role in intro.ROLES:
            docker.containers[target["containers"][role]] = running_from(docker.config["pinned"], role, plan["previous"]["images"][role])
        docker.psql = {"_prisma_migrations": json.dumps([[n, c, True, False] for n, c in plan["migrations"]["before"]]),
                       "rolconnlimit": json.dumps(pre_catalog()), "service_account_client_link": json.dumps(plan["members"]),
                       "parent_group": json.dumps({"roles": ["radiologist"], "top_level_groups": ["hallym"]}),
                       "pg_stat_activity": "0"}
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
        try:
            result, runs, docker = self.installed_run()
        except FileNotFoundError as error:
            self.fail("the installed entry must create its protected run/log directories: " + str(error))
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
        and its .git 0700 (RT-P3-GIT-MODE; no recursion), records both modes, and the privacy check then runs as usual."""
        (self.repo / "inner").mkdir(mode=0o775)
        self.repo.chmod(0o775)
        (self.repo / ".git").chmod(0o775)
        (self.repo / "inner").chmod(0o775)
        result, runs, docker = self.installed_run(target_changes={"fix_checkout_mode": True})
        first = json.loads(next(runs.glob("result-capture-*.json")).read_text())["steps"][0]
        self.assertEqual((first["step"], first["outcome"]), ("L-00a", "PASS"))
        self.assertEqual(first["detail"], {"fixed": True, "before": {"checkout": "0o775", ".git": "0o775"},
                                           "after": {"checkout": "0o700", ".git": "0o700"}})
        self.assertEqual(((self.repo.stat().st_mode & 0o777), ((self.repo / "inner").stat().st_mode & 0o777)), (0o700, 0o775))
        self.assertEqual(result["status"], "CAPTURE_FAILED", "the run went on past L-00a (to the fence made to fail)")

    def test_121_a_deployed_hosts_0755_git_is_made_private_by_the_next_capture_and_the_operator_command_then_admits_it(self):
        """RT-P3-GIT-MODE (prep7-window report-window.md, 차단; D1355): production after its window - an operating-account
        checkout at 0700 whose .git L-00a had left at 0755 - refused every `entry.py compose config`/`recreate`, whose
        rule requires that .git private. The next capture's L-00a (fix_checkout_mode) makes .git 0700 and records it, and
        the operator command's checkout rule then admits the checkout; with .git as it was, that rule refuses."""
        owner = {"uid": 1000, "gid": 1000}
        policy = json.loads(self.policy_path.read_bytes())
        policy["repository_owner"] = owner
        self.write(self.policy_path, policy)
        git = self.repo / ".git"
        for path in (self.repo, git):
            os.chown(path, 1000, 1000)
        self.repo.chmod(0o700)
        git.chmod(0o755)
        operator_rule = lambda: intro.owned_private(git, owner, private=True, directory=True)   # compose_operation's .git rule
        with self.assertRaisesRegex(intro.Stop, "not private"):
            operator_rule()
        result, runs, docker = self.installed_run(target_changes={"fix_checkout_mode": True},
                                                  prepare=lambda runs: os.chown(self.repo / ".env", 1000, 1000))
        first = json.loads(next(runs.glob("result-capture-*.json")).read_text())["steps"][0]
        self.assertEqual((first["step"], first["outcome"]), ("L-00a", "PASS"), result)
        self.assertEqual(first["detail"], {"fixed": True, "before": {"checkout": "0o700", ".git": "0o755"},
                                           "after": {"checkout": "0o700", ".git": "0o700"}})
        self.assertEqual(((self.repo.stat().st_mode & 0o777), (git.stat().st_mode & 0o777), git.stat().st_uid), (0o700, 0o700, 1000))
        operator_rule()
        self.assertEqual(intro.IntroductionHost(self.policy_path).owner, owner)

    def test_84_an_open_checkout_without_the_declaration_is_refused_before_any_step(self):
        self.repo.chmod(0o775)
        result, runs, docker = self.installed_run()
        self.assertEqual((result["status"], result["phase_passed"], result["phase"]),
                         ("REJECTED", False, "capture"))
        self.assertEqual((self.repo.stat().st_mode & 0o777), 0o775)
        self.assertFalse(any((self.state / "emr-runs").iterdir()))
        self.assertFalse(docker.calls, "an unapproved checkout mode must refuse before host commands")
        self.assertFalse((self.repo / ".kin-ops.lock").exists())

    def test_74_two_approved_host_entries_never_act_together(self):
        """IRT-04 through the installed entry: of two distinct approved introduce requests, one acts, the other is refused."""
        import threading
        target = self.operational_target()
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
        staging = self.root / "bundle-staging"
        receipt, _ = receipt_bundle(plan, staging)
        # The producer's run bundle where the installed entry reads it (IRT2-01): root's, private.
        bundles = self.state / "emr-bundles" / intro.receipt_sha256(receipt)
        bundles.mkdir(mode=0o700)
        for path in staging.iterdir():
            (bundles / path.name).write_bytes(path.read_bytes())
            (bundles / path.name).chmod(0o600)
        evidence = self.document("emr-evidence", receipt)
        entered, release = threading.Event(), threading.Event()

        class Blocking(FakeOps):
            def effect_recheck_fence(self, context):
                entered.set()
                release.wait(10)
                return {}
        shared = Blocking()
        shared.live_roles = {"db"}
        shared.cron_state, shared.ingress_state = "fenced", "closed"
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
        self.assertEqual(host.execute(raw)["status"], "REJECTED")

    def test_93_a_rollback_goes_on_with_a_reopened_checkout_mode_and_records_it_forward_phases_refuse(self):
        """D06: after the capture the checkout (0700) and its .git were opened again (chmod 0775). A rollback request is
        not refused for that: it runs, and its result, result file and phase-start record carry the warning with the
        modes; introduce and verify requests keep refusing; an ownership change still refuses the rollback too."""
        target = self.operational_target()
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
        shared.cron_state, shared.ingress_state = "fenced", "maintenance"

        def request(phase):
            raw = json.dumps({"version": 1, "mode": intro.MODE, "phase": phase, "plan_sha256": plan_sha, "nonce": os.urandom(16).hex()}).encode()
            self.approve(raw)
            return raw

        def executed(phase):
            # R4-22: the protected entry answers every request with a classified result; an escaped refusal is a defect.
            try:
                return intro.IntroductionHost(self.policy_path).execute(request(phase))
            except Exception as error:
                self.fail("the protected entry raised instead of answering %s: %s: %s" % (phase, type(error).__name__, error))
        with patch.object(intro, "HostOps", lambda **kwargs: shared), patch.object(intro, "local_host_key", lambda: "a" * 64):
            for phase in ("introduce", "verify"):
                with self.subTest(phase=phase):
                    self.assertEqual(executed(phase)["status"], "REJECTED")
            self.assertEqual(shared.calls, [], "no forward step ran")
            result = executed("rollback")
        self.assertEqual(result["status"], "RESTORED", result)
        (warning,) = result["warnings"]
        self.assertEqual((warning["kind"], warning["modes"], warning["restored"]),
                         ("checkout-mode", {"checkout": "0o775", ".git": "0o775"}, {"checkout": "0o700", ".git": "0o700"}))
        self.assertEqual(((self.repo.stat().st_mode & 0o777), ((self.repo / ".git").stat().st_mode & 0o777)), (0o700, 0o700))
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
        with patch.object(intro, "HostOps", lambda **kwargs: shared), patch.object(intro, "local_host_key", lambda: "a" * 64):
            self.assertEqual(intro.IntroductionHost(self.policy_path).execute(request("rollback"))["status"], "REJECTED")

    def test_123_a_rollback_on_an_operating_accounts_0700_checkout_with_a_0755_git_leaves_the_operator_command_admitted(self):
        """P3R1-02 (Astra review of 7adea16): the deployed shape of RT-P3-GIT-MODE - an operating-account checkout at 0700
        whose .git is 0755 - met by a recovery. The rollback records the opened mode as its warning, makes .git 0700
        after approval, the lease and a durable host_changed record (non-recursive), and the operator command's .git rule
        then admits the checkout; before, the rollback ran without the correction and that rule refused afterwards. An
        ownership change is still refused."""
        owner = {"uid": 1000, "gid": 1000}
        policy = json.loads(self.policy_path.read_bytes())
        policy["repository_owner"] = owner
        self.write(self.policy_path, policy)
        git = self.repo / ".git"
        (git / "objects").mkdir(mode=0o755, exist_ok=True)
        (git / "objects").chmod(0o755)
        for path in (self.repo, git):
            os.chown(path, 1000, 1000)
        self.repo.chmod(0o700)
        git.chmod(0o755)
        operator_rule = lambda: intro.owned_private(git, owner, private=True, directory=True)   # compose_operation's .git rule
        with self.assertRaisesRegex(intro.Stop, "not private"):
            operator_rule()
        target = self.operational_target()
        target["fix_checkout_mode"] = True
        plan = plan_fixture(target)
        now = datetime.now(timezone.utc)
        plan.update(window={"start": (now - timedelta(hours=1)).isoformat(), "end": (now + timedelta(hours=2)).isoformat()},
                    tool=intro.tool_hashes())
        self.document("emr-targets", target)
        plan_sha = self.document("emr-plans", plan)
        runs = self.state / "emr-runs" / plan_sha
        runs.mkdir(mode=0o700)
        token = intro.acquire_lock(self.repo)
        state = intro.new_state(plan_sha, plan)
        state.update(status="INTRODUCED", lock_token=token, db_changed=True, checkout="target",
                     b0={"dir": "/b0", "manifest_sha256": "8" * 64}, fenced={"running_before": []})
        self.write(runs / "state.json", state)
        shared = FakeOps()
        shared.cron_state, shared.ingress_state = "fenced", "maintenance"

        def rollback():
            raw = json.dumps({"version": 1, "mode": intro.MODE, "phase": "rollback", "plan_sha256": plan_sha,
                              "nonce": os.urandom(16).hex()}).encode()
            self.approve(raw)
            with patch.object(intro, "HostOps", lambda **kwargs: shared), patch.object(intro, "local_host_key", lambda: "a" * 64):
                return intro.IntroductionHost(self.policy_path).execute(raw)
        result = rollback()
        self.assertEqual(result["status"], "RESTORED", result)
        self.assertEqual([warning["kind"] for warning in result.get("warnings", [])], ["checkout-mode"],
                         "the rollback met the opened .git and recorded it")
        (warning,) = result["warnings"]
        self.assertEqual((warning["kind"], warning["modes"], warning["restored"]),
                         ("checkout-mode", {"checkout": "0o700", ".git": "0o755"}, {"checkout": "0o700", ".git": "0o700"}))
        self.assertTrue(json.loads((runs / "state.json").read_text())["host_changed"])
        self.assertEqual(((self.repo.stat().st_mode & 0o777), (git.stat().st_mode & 0o777), ((git / "objects").stat().st_mode & 0o777),
                          git.stat().st_uid), (0o700, 0o700, 0o755, 1000))
        operator_rule()
        # Owner is still the rule for a recovery: another account's .git is refused (by the entry, before any request
        # runs), its mode untouched.
        state = json.loads((runs / "state.json").read_text())
        state.update(status="INTRODUCED", rollback_attempted=False)
        self.write(runs / "state.json", state)
        git.chmod(0o755)
        os.chown(git, 1001, 1001)
        with self.assertRaises(intro.Stop):
            rollback()
        self.assertEqual((git.stat().st_mode & 0o777), 0o755)


if __name__ == "__main__":
    unittest.main(verbosity=2)
