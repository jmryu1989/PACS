#!/usr/bin/env python3
"""EMR-introduction deployment mode of the protected runner family (INTERIM-RELEASE-TOOLS, D1039/D1043/D1048).

The API-only runner (ops_deploy_runner/ops_deploy_host/ops_deploy_preflight.observe) stays unchanged and keeps refusing
a release that brings the EMR-B storage. This mode is the reviewed path for exactly that release: it materialises the
plan's ordered steps L-01..L-11 / RB-00..RB-04, each with its observation before and after, its actual exit, and a
STOP when an observation differs. It reuses the isolated entrypoint (scripts/ops_deploy_entry.py routes requests whose
"mode" is "emr-introduction" here), the root-owned policy/state checks of ops_deploy_host, and the shared operations
lock of ops_backup (retained across phases).

Phases, one request each (a phase may only follow the one before it):
  capture    L-01 observe-before allowlist; L-04 fence every writer and scheduled job; pre-EMR capture B0 with the
             writers held; isolated restore check of B0. The writers stay fenced.
  release    only while no database object changed: writers back exactly as they were, jobs restored, lock released.
  introduce  L-06a storage mount; L-06b provisioning (installer); L-07 migration (same target image, installer); L-08a
             Keycloak session-cache option; L-08b member-rights import and per-member verification; L-09a state volume
             and the API as node / kin_runtime; L-09b UI/viewer bytes and the new proxy image, ingress still fenced.
  verify     L-10 fenced HTTPS smoke, the one-shot EMR probe (scripts/ops_emr_probe.py), post-EMR capture B1 with the
             writers held, and B1's same-point restore check into fresh isolated volumes.
  reopen     L-11 final allowlist, jobs restored, public ingress (the point of no return is recorded first).
  rollback   RB-00..RB-04: refused while a one-shot worker may be alive; failed state preserved (Bfail); B0 restored
             into FRESH recovery volumes (kin + keycloak at the same point, Orthanc index + files together); previous
             images, compose and env; failed EMR volumes kept with their identifiers.
  seed       rehearsal targets only: a verified B0 copy restored into the disposable clone, with clone-only secrets.
  receipt    rehearsal targets only: the local-restore receipt (replaces the offsite-restore proof while the external
             backup stays OFF) that production's introduce requires.

A settled failure after the first database change rolls back automatically only when every one-shot worker of this
release has ended and the public ingress was never reopened; a timeout or any other unknown end retains the lock and
stops (NEEDS_ATTENTION) without rollback. Secrets are read only into memory; logs and records carry names, modes,
hashes and exits, never values.

CLI helpers (no host change): example, check-plan, prepare-env, compose-digest, rehearsal-override, verify-receipt.
"""
from __future__ import annotations

import argparse
import base64
from contextlib import contextmanager, redirect_stdout
from datetime import datetime, timedelta, timezone
import hashlib
import http.client
import io
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import secrets as token_source
import shutil
import socket
import ssl
import subprocess
import sys
import time
from urllib.parse import urlsplit
import uuid

import ops_backup as ops
import ops_deploy_preflight as pre

MODE = "emr-introduction"
EMR_MIGRATION = "20261008120000_emr_b"
TABLESPACE = "/var/lib/postgresql/emr-access/ts"
ROLES = ("db", "api", "keycloak", "orthanc", "proxy")
ONE_SHOTS = ("emr-provision", "api-migrate")
WRITERS = pre.WRITERS
FENCE_ORDER = ("proxy", "api", "keycloak", "orthanc")
RESUME_ORDER = ("orthanc", "keycloak", "api", "proxy")
VOLUMES = ("pg", "orthanc", "emr_access", "emr_state")
PHASES = ("capture", "release", "introduce", "verify", "reopen", "rollback", "seed", "receipt")
HASH, SHA, IMAGE = pre.HASH, pre.SHA, pre.IMAGE
NONCE = re.compile(r"[0-9a-f]{32}")
UUID4 = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}")
COMPOSE_NAME = re.compile(r"docker-compose(?:\.[a-z0-9-]+)?\.yml")
PROJECT = re.compile(r"[a-z0-9][a-z0-9_-]{0,62}")
TAG = re.compile(r"[a-z0-9][a-z0-9-]{0,62}")
FENCED = "#kin-emr-introduction-fenced# "
TOOL_FILES = ("ops_emr_introduction.py", "ops_emr_probe.py", "ops_backup.py", "ops_deploy_preflight.py", "ops_deploy_host.py",
              "ops_audit_integrity.py")
OPERATOR_SMOKE_CHECKS = ("login_pkce", "logout_old_session_refused", "worklist_uid", "ohif_frame", "w2_folders",
                         "w2_modality", "w2_shortcuts", "realm_v1_pending_zero")
# The Stage-5 configuration names a clone must replace before it starts (rehearsal.md §2). Values are compared in memory.
CLONE_SECRETS = ("POSTGRES_PASSWORD", "KC_ADMIN_PASSWORD", "KC_CLIENT_SECRET", "KC_WEB_SECRET", "KIN_COOKIE_SECRET",
                 "ORTHANC_PASS", "KIN_EMR_RUNTIME_PASSWORD", "KIN_EMR_READER_PASSWORD", "KIN_EMR_RETENTION_PASSWORD")


class Stop(RuntimeError):
    """A settled refusal: the operation ended and the observed state is known."""


class Unknown(RuntimeError):
    """An operation whose end state is not known (timeout, lost client): never retried or rolled back automatically."""


def require(condition, message):
    if not condition:
        raise Stop(message)


def code_of(error):
    """A record-safe failure code: fixed check messages; anything else only by its type."""
    if isinstance(error, (Stop, Unknown)) or type(error) is RuntimeError:
        text = str(error).replace("\n", " ")[:240]
        return text if text else type(error).__name__
    return type(error).__name__


def utc_now():
    return datetime.now(timezone.utc)


def parse_utc(value):
    require(type(value) is str and (value.endswith("Z") or value.endswith("+00:00")), "Timestamp must be UTC")
    stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    require(stamp.tzinfo is not None, "Timestamp must be UTC")
    return stamp


def canonical(value):
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode("ascii")


def sha256_bytes(raw):
    return hashlib.sha256(raw).hexdigest()


def decode(raw):
    return json.loads(raw.decode("utf-8"), object_pairs_hook=pre.unique_object)


def _keys(value, keys, what):
    require(type(value) is dict and set(value) == set(keys), "Unexpected " + what + " fields")
    return value


def _str(value, pattern, what):
    require(type(value) is str and pattern.fullmatch(value) is not None, "Invalid " + what)
    return value


def _int(value, low, high, what):
    require(type(value) is int and low <= value <= high, "Invalid " + what)
    return value


def _abs(value, what):
    require(type(value) is str and "\x00" not in value and len(value) <= 1024
            and (PurePosixPath(value).is_absolute() or PureWindowsPath(value).is_absolute())
            and ".." not in PurePosixPath(value.replace("\\", "/")).parts, "Invalid " + what)
    return value


def _names(value, what):
    require(type(value) is list and all(type(item) is str and ops.ENV_NAME.fullmatch(item) for item in value)
            and len(set(value)) == len(value), "Invalid " + what)
    return value


def _images(value, what):
    _keys(value, ("api", "proxy", "db", "keycloak", "orthanc"), what)
    for key in value:
        _str(value[key], IMAGE, what + " image")
    return value


def migrations_valid(value):
    _keys(value, ("before", "after"), "migrations")
    lists = []
    for key in ("before", "after"):
        rows = value[key]
        require(type(rows) is list and rows, "Invalid migration list")
        for row in rows:
            require(type(row) is list and len(row) == 2 and type(row[0]) is str and pre.MIGRATION_NAME.fullmatch(row[0])
                    and type(row[1]) is str and HASH.fullmatch(row[1]), "Invalid migration entry")
        names = [row[0] for row in rows]
        # Prisma applies in name order; a list out of that order cannot be the history it will write.
        require(names == sorted(names) and len(set(names)) == len(names), "Migration list is not in Prisma order")
        lists.append(rows)
    before, after = lists
    require(len(after) > len(before) and after[:len(before)] == before, "The target history must extend the previous one")
    require(EMR_MIGRATION not in [row[0] for row in before] and EMR_MIGRATION in [row[0] for row in after],
            "This mode is only the introduction of the EMR-B storage")
    return value


PLAN_KEYS = ("schema", "mode", "unit", "target_kind", "target_manifest_sha256", "previous", "release", "compose", "secrets",
             "migrations", "storage", "members", "smoke", "probe", "window", "budget", "backup_root", "tool", "seed",
             "projection_exempt")


def plan_valid(plan):
    """The protected plan document: everything this release binds, and nothing the request could choose."""
    _keys(plan, PLAN_KEYS, "plan")
    require(plan["schema"] == 1 and type(plan["schema"]) is int and plan["mode"] == MODE, "Unsupported plan")
    require(type(plan["unit"]) is str and 0 < len(plan["unit"]) <= 64, "Invalid unit")
    require(plan["target_kind"] in ("production", "rehearsal"), "Invalid target kind")
    _str(plan["target_manifest_sha256"], HASH, "target manifest hash")
    for key in ("previous", "release"):
        _keys(plan[key], ("sha", "images"), key)
        _str(plan[key]["sha"], SHA, key + " SHA")
        _images(plan[key]["images"], key)
    previous, release = plan["previous"], plan["release"]
    require(previous["sha"] != release["sha"] and previous["images"]["api"] != release["images"]["api"], "Target is already selected")
    require(all(previous["images"][key] == release["images"][key] for key in ("db", "keycloak", "orthanc")),
            "Database, Keycloak and Orthanc images stay as they are in this release")
    _keys(plan["compose"], ("before_sha256", "after_sha256"), "compose")
    for key in plan["compose"]:
        _str(plan["compose"][key], HASH, "compose hash")
    secrets = _keys(plan["secrets"], ("required", "absent", "runtime", "installer", "logins", "env_next_sha256"), "secrets")
    _names(secrets["required"], "required secret names")
    _names(secrets["absent"], "absent secret names")
    require(secrets["runtime"] == "KIN_EMR_RUNTIME_PASSWORD" and secrets["installer"] == "POSTGRES_PASSWORD"
            and {secrets["runtime"], secrets["installer"]} <= set(secrets["required"])
            and not set(secrets["required"]) & set(secrets["absent"]), "Invalid secret roles")
    _keys(secrets["logins"], ("kin_emr_reader", "kin_emr_retention"), "logins")
    for role, name in (("kin_emr_reader", "KIN_EMR_READER_PASSWORD"), ("kin_emr_retention", "KIN_EMR_RETENTION_PASSWORD")):
        require(type(secrets["logins"][role]) is bool, "Invalid login plan")
        # Default OFF: an optional role without a planned login is NOLOGIN and its secret must stay unset.
        require((name in secrets["required"]) is secrets["logins"][role] and (name in secrets["absent"]) is not secrets["logins"][role],
                "Optional EMR login and its secret disagree")
    _str(secrets["env_next_sha256"], HASH, "staged env hash")
    migrations_valid(plan["migrations"])
    storage = _keys(plan["storage"], ("tablespace_path", "postgres_uid", "postgres_gid", "node_uid", "node_gid"), "storage")
    require(storage["tablespace_path"] == TABLESPACE, "The tablespace path is fixed by the product")
    for key in ("postgres_uid", "postgres_gid", "node_uid", "node_gid"):
        _int(storage[key], 1, 65535, key)
    # The member-rights import's expectation, from the plan's read-only observation of the realm: every member is imported
    # once; the disabled ones keep a PACS suspension; service accounts are never members.
    members = _keys(plan["members"], ("realm_members", "disabled", "service_accounts"), "members")
    for key in members:
        _int(members[key], 0, 100000, key)
    require(members["disabled"] <= members["realm_members"], "Invalid member expectation")
    smoke = _keys(plan["smoke"], ("frame",), "smoke")
    if smoke["frame"] is not None:
        frame = _keys(smoke["frame"], ("path", "bytes", "sha256"), "smoke frame")
        require(type(frame["path"]) is str and re.fullmatch(
            r"/dicom-web/studies/[0-9.]{1,64}/series/[0-9.]{1,64}/instances/[0-9.]{1,64}/frames/[1-9][0-9]{0,7}", frame["path"]),
            "Invalid smoke frame path")
        _int(frame["bytes"], 1, 16 * 1024 * 1024, "smoke frame bytes")
        _str(frame["sha256"], HASH, "smoke frame hash")
    if plan["target_kind"] == "production":
        require(smoke["frame"] is not None, "A production smoke reads a real frame")
    probe = _keys(plan["probe"], ("study", "event_id", "institution", "approved_by", "approved_at"), "probe")
    require(type(probe["study"]) is str and re.fullmatch(r"SYNTHETIC-[A-Za-z0-9.-]{1,64}", probe["study"]), "Probe study must be a synthetic selector")
    _str(probe["event_id"], UUID4, "probe event ID")
    for key in ("institution", "approved_by"):
        require(type(probe[key]) is str and 0 < len(probe[key]) <= 128, "Invalid probe " + key)
    parse_utc(probe["approved_at"])
    window = _keys(plan["window"], ("start", "end"), "window")
    start, end = parse_utc(window["start"]), parse_utc(window["end"])
    require(start < end <= start + timedelta(days=7), "Invalid window")
    budget = _keys(plan["budget"], ("capture_s", "introduce_s", "verify_s", "reopen_s", "rollback_s", "seed_s", "min_free_bytes"), "budget")
    for key in budget:
        if key == "min_free_bytes":
            _int(budget[key], 1024 ** 3, 2 ** 50, key)
        else:
            _int(budget[key], 60, 86400, key)
    _abs(plan["backup_root"], "backup root")
    _keys(plan["tool"], TOOL_FILES, "tool hashes")
    for key in TOOL_FILES:
        _str(plan["tool"][key], HASH, "tool hash")
    if plan["target_kind"] == "rehearsal":
        seed = _keys(plan["seed"], ("b0_dir", "b0_manifest_sha256"), "seed")
        _abs(seed["b0_dir"], "seed B0 directory")
        _str(seed["b0_manifest_sha256"], HASH, "seed B0 manifest hash")
    else:
        require(plan["seed"] is None, "Only a rehearsal plan seeds from a B0 copy")
    exempt = plan["projection_exempt"]
    require(type(exempt) is list and all(type(name) is str and ops.RESOURCE_NAME.fullmatch(name) for name in exempt), "Invalid projection exemptions")
    return plan


def plan_core(plan):
    """What a rehearsal must have rehearsed: the same release, history, storage and secret roles (not host specifics)."""
    secrets = plan["secrets"]
    return sha256_bytes(canonical({"previous": plan["previous"], "release": plan["release"], "migrations": plan["migrations"],
                                   "storage": plan["storage"], "members": plan["members"], "probe_study": plan["probe"]["study"],
                                   "secrets": {key: secrets[key] for key in ("required", "absent", "runtime", "installer", "logins")}}))


TARGET_KEYS = ("schema", "kind", "host_key_sha256", "origin", "project", "repository", "compose_files", "containers",
               "volumes", "networks", "ports", "tls_certificate", "cron", "ca_file", "keycloak_admin")
IDENTITY_KEYS = ("host_key_sha256", "origin", "project", "containers", "volumes", "networks")


def origin_valid(value):
    parsed = urlsplit(value) if type(value) is str else None
    require(parsed is not None and parsed.scheme == "https" and parsed.hostname and not parsed.username
            and not parsed.password and parsed.path == "" and not parsed.query and not parsed.fragment
            and value == "https://" + parsed.netloc, "Invalid origin")
    return value


def target_valid(target):
    """A target manifest names every resource this mode touches; no docker command uses a name from elsewhere."""
    _keys(target, TARGET_KEYS, "target manifest")
    require(target["schema"] == 1 and type(target["schema"]) is int and target["kind"] in ("production", "rehearsal"), "Unsupported target manifest")
    _str(target["host_key_sha256"], HASH, "host key fingerprint")
    origin_valid(target["origin"])
    _str(target["project"], PROJECT, "compose project")
    _abs(target["repository"], "repository")
    files = target["compose_files"]
    require(type(files) is list and files and len(files) == len(set(files)), "Invalid compose files")
    for item in files:
        require(type(item) is str and (COMPOSE_NAME.fullmatch(item) or (target["kind"] == "rehearsal" and _abs(item, "override"))),
                "Invalid compose file")
    require(files[0] == "docker-compose.yml", "The base compose file comes first")
    containers = _keys(target["containers"], (*ROLES, *ONE_SHOTS), "containers")
    volumes = _keys(target["volumes"], VOLUMES, "volumes")
    networks = _keys(target["networks"], ("default", "workflow"), "networks")
    for group in (containers, volumes, networks):
        for value in group.values():
            _str(value, NAME, "resource name")
    names = [*containers.values(), *volumes.values(), *networks.values()]
    require(len(names) == len(set(names)), "Resource names must be distinct")
    ports = _keys(target["ports"], ("maintenance", "public"), "ports")
    require(type(ports["maintenance"]) is str and re.fullmatch(r"127\.0\.0\.1:[1-9][0-9]{0,4}:443", ports["maintenance"]),
            "Maintenance ingress must listen on loopback only")
    require(type(ports["public"]) is list and ports["public"] and all(type(item) is str and re.fullmatch(
        r"(?:127\.0\.0\.1:)?[1-9][0-9]{0,4}:(?:80|443)", item) for item in ports["public"]), "Invalid public ports")
    require(type(target["tls_certificate"]) is str and PurePosixPath(target["tls_certificate"]).is_absolute(), "Invalid certificate path")
    if target["cron"] is not None:
        cron = _keys(target["cron"], ("user", "tags"), "cron")
        _str(cron["user"], re.compile(r"[a-z_][a-z0-9_-]{0,31}"), "cron user")
        require(type(cron["tags"]) is list and cron["tags"] and all(type(tag) is str and TAG.fullmatch(tag) for tag in cron["tags"]),
                "Invalid cron tags")
    if target["ca_file"] is not None:
        _abs(target["ca_file"], "CA file")
    # The master-realm administrator whose password is the target's KC_ADMIN_PASSWORD. A clone restored from the
    # source realm never knows the source administrator's password; its seed creates its own (kc.sh bootstrap-admin).
    _str(target["keycloak_admin"], re.compile(r"[a-z][a-z0-9_.-]{0,63}"), "Keycloak administrator name")
    if target["kind"] == "production":
        require(target["ca_file"] is None, "Production HTTPS uses the system trust store")
        require(target["cron"] is not None, "Production scheduled jobs are part of the fence")
    return target


def identity_valid(production):
    _keys(production, IDENTITY_KEYS, "production identity")
    _str(production["host_key_sha256"], HASH, "production host key")
    origin_valid(production["origin"])
    _str(production["project"], PROJECT, "production project")
    _keys(production["containers"], (*ROLES, *ONE_SHOTS), "production containers")
    _keys(production["volumes"], VOLUMES, "production volumes")
    _keys(production["networks"], ("default", "workflow"), "production networks")
    return production


def check_target(target, production, kind, local_host_key):
    """Clone/target allowlist. Production runs only with exactly the pinned production identity on the pinned host; any
    other target refuses every production name, address and host key (never a renaming of the production names)."""
    identity_valid(production)
    require(target["kind"] == kind, "Target kind differs from the plan")
    if kind == "production":
        require({key: target[key] for key in IDENTITY_KEYS} == production, "Target manifest is not the production identity")
        require(local_host_key == production["host_key_sha256"], "This host is not the production host")
        return
    require(local_host_key != production["host_key_sha256"], "A rehearsal never runs on the production host")
    require(target["host_key_sha256"] == local_host_key, "Rehearsal manifest names another host")
    require(urlsplit(target["origin"]).hostname != urlsplit(production["origin"]).hostname, "Rehearsal origin is the production host")
    require(target["project"] != production["project"], "Rehearsal compose project is the production project")
    for group in ("containers", "volumes", "networks"):
        require(not set(target[group].values()) & set(production[group].values()), "Rehearsal reuses a production " + group[:-1] + " name")


def check_resolved(model, target, *, target_checkout):
    """The resolved Compose model (selected fields only) assigns exactly the manifest's names."""
    require(model["project"] == target["project"], "Resolved compose project differs")
    expected = {role: target["containers"][role] for role in ROLES}
    if target_checkout:
        expected.update({name: target["containers"][name] for name in ONE_SHOTS})
    require(model["containers"] == expected, "Resolved container names differ from the target manifest")
    volumes = {"pg-db": target["volumes"]["pg"], "orthanc-db": target["volumes"]["orthanc"]}
    if target_checkout:
        volumes.update({"emr-access": target["volumes"]["emr_access"], "emr-state": target["volumes"]["emr_state"]})
    require(all(model["volumes"].get(key) == name for key, name in volumes.items()), "Resolved volume names differ")
    require(model["networks"].get("default") == target["networks"]["default"]
            and model["networks"].get("workflow") == target["networks"]["workflow"], "Resolved network names differ")


REQUEST_KEYS = ("version", "mode", "phase", "plan_sha256", "nonce")


def request_valid(raw):
    require(type(raw) is bytes and len(raw) <= 8192, "Request too large")
    body = decode(raw)
    _keys(body, REQUEST_KEYS, "request")
    require(type(body["version"]) is int and body["version"] == 1 and body["mode"] == MODE and body["phase"] in PHASES, "Unsupported request")
    _str(body["plan_sha256"], HASH, "plan hash")
    _str(body["nonce"], NONCE, "nonce")
    return body


def is_introduction(raw):
    """For the entrypoint's routing only; the selected path validates the whole request."""
    try:
        body = json.loads(raw.decode("utf-8"), object_pairs_hook=pre.unique_object)
    except Exception:
        return False
    return type(body) is dict and body.get("mode") == MODE


def evidence_for(phase, kind):
    """Production's introduce needs the rehearsal's local-restore receipt (a rehearsal is that receipt's producer);
    every reopen needs the operator's browser-level smoke record."""
    if phase == "introduce" and kind == "production":
        return ("local-restore",)
    if phase == "reopen":
        return ("operator-smoke",)
    return ()


def approval_valid(approval, request_sha256, phase, now, kind="production"):
    _keys(approval, ("schema", "mode", "request_sha256", "expires_at", "evidence"), "approval")
    require(approval["schema"] == 1 and approval["mode"] == MODE and approval["request_sha256"] == request_sha256, "Approval is not bound to this request")
    require(type(approval["expires_at"]) is int and now < approval["expires_at"] <= now + 86400, "Approval expired or too long")
    evidence = approval["evidence"]
    require(type(evidence) is dict and set(evidence) == set(evidence_for(phase, kind)), "Approval evidence differs from the phase")
    for value in evidence.values():
        _str(value, HASH, "evidence hash")
    return approval


def receipt_valid(receipt, plan, b0_manifest_sha256, production):
    """A local-restore receipt is a rehearsal's own record (kind, phases, hashes); it is never an offsite claim."""
    _keys(receipt, ("schema", "kind", "passed", "plan_core_sha256", "rehearsal_plan_sha256", "source_b0_manifest_sha256",
                    "rehearsal_b0_manifest_sha256", "rehearsal_b1_manifest_sha256", "tool", "host_key_sha256", "phases",
                    "created_utc"), "local-restore receipt")
    require(receipt["schema"] == 1 and receipt["kind"] == "local-restore" and receipt["passed"] is True, "Receipt is not a passed local restore")
    require(receipt["plan_core_sha256"] == plan_core(plan), "Receipt rehearsed another release")
    require(receipt["source_b0_manifest_sha256"] == b0_manifest_sha256, "Receipt rehearsed another B0 snapshot")
    require(receipt["tool"] == plan["tool"], "Receipt was produced by another tool")
    require(receipt["host_key_sha256"] != production["host_key_sha256"], "Receipt was produced on the production host")
    phases = receipt["phases"]
    require(type(phases) is dict and set(phases) == {"seed", "capture", "introduce", "verify", "rollback"}
            and all(type(item) is dict and item.get("status") == "PASS" for item in phases.values()), "Receipt phases incomplete")
    for key in ("rehearsal_plan_sha256", "rehearsal_b0_manifest_sha256", "rehearsal_b1_manifest_sha256"):
        _str(receipt[key], HASH, "receipt hash")
    parse_utc(receipt["created_utc"])
    return receipt


def operator_smoke_valid(record, plan_sha256):
    _keys(record, ("schema", "kind", "plan_sha256", "checks", "passed", "by", "at"), "operator smoke")
    require(record["schema"] == 1 and record["kind"] == "operator-smoke" and record["plan_sha256"] == plan_sha256, "Operator smoke is for another plan")
    require(type(record["checks"]) is dict and set(record["checks"]) == set(OPERATOR_SMOKE_CHECKS)
            and all(value is True for value in record["checks"].values()) and record["passed"] is True, "Operator smoke did not pass")
    parse_utc(record["at"])
    return record


# ── durable records: state, journal and step logs (private files) ──

class Records:
    """Portable durable files under one private directory; the host binds write/read to ops_deploy_host's protections."""

    def __init__(self, directory):
        self.directory = Path(directory)

    def write(self, path, raw, *, append=False):
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if append:
            with open(path, "ab") as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            return
        temporary = path.with_name(".pending-" + uuid.uuid4().hex)
        with open(temporary, "xb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        if os.name == "posix":
            os.chmod(path, 0o600)

    def read(self, path):
        return path.read_bytes()

    def state(self):
        path = self.directory / "state.json"
        return decode(self.read(path)) if path.exists() else None

    def save(self, state):
        self.write(self.directory / "state.json", canonical(state) + b"\n")

    def journal(self, event):
        self.write(self.directory / "journal.jsonl", canonical({"at": utc_now().isoformat(), **event}) + b"\n", append=True)

    def log(self, name, raw):
        path = self.directory / "logs" / name
        self.write(path, raw)
        return {"file": "logs/" + name, "sha256": sha256_bytes(raw), "bytes": len(raw)}

    def put(self, name, value):
        raw = canonical(value) + b"\n"
        self.write(self.directory / name, raw)
        return sha256_bytes(raw)


# ── the shared operations lock, retained between phases ──

def lock_path(repository):
    return Path(repository) / ".kin-ops.lock"


def acquire_lock(repository):
    """The same file ops_backup.lock() creates; this mode keeps it until a final phase releases it."""
    token = uuid.uuid4().hex
    descriptor = os.open(str(lock_path(repository)), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as handle:
        handle.write(token)
        handle.flush()
        os.fsync(handle.fileno())
    if os.name == "posix":
        directory = os.open(str(repository), os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    return token


def lock_owned(repository, token):
    path = lock_path(repository)
    try:
        return not path.is_symlink() and path.read_text() == token
    except OSError:
        return False


def release_lock(repository, token):
    require(lock_owned(repository, token), "Operations lock ownership changed")
    lock_path(repository).unlink()


# ── HTTPS smoke over the maintenance (loopback) or public ingress ──

class PinnedHTTPS(http.client.HTTPSConnection):
    """Connect to an address while verifying the certificate for the origin's host name (SNI and hostname check)."""

    def __init__(self, address, port, server_name, context):
        super().__init__(address, port, timeout=10, context=context)
        self._server_name = server_name

    def connect(self):
        sock = socket.create_connection((self.host, self.port), self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self._server_name)


def https_get(origin, path, *, connect=None, ca_file=None, token=None, limit=65536, accept="application/json"):
    parsed = urlsplit(origin)
    address, port = connect or (parsed.hostname, parsed.port or 443)
    context = ssl.create_default_context(cafile=ca_file)
    connection = PinnedHTTPS(address, port, parsed.hostname, context)
    headers = {"Host": parsed.netloc, "Accept": accept}
    if token:
        headers["Authorization"] = "Bearer " + token
    try:
        connection.request("GET", path, headers=headers)
        response = connection.getresponse()
        raw = response.read(limit + 1)
        require(len(raw) <= limit, "Smoke response too large")
        return response.status, response.getheader("Content-Type", ""), raw
    finally:
        connection.close()


def refusal_code(raw):
    """Only the API's fixed refusal code (e.g. AUTH_RIGHTS_PENDING) leaves a refused response; never its body."""
    try:
        value = json.loads(raw)
    except ValueError:
        return "-"
    code = value.get("code") if isinstance(value, dict) else None
    return code if isinstance(code, str) and re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", code) else "-"


def frame_payload(kind, raw):
    from email.parser import BytesParser
    from email.policy import default as email_policy
    require(len(kind) <= 1024, "Unexpected frame response type")
    message = BytesParser(policy=email_policy).parsebytes(("Content-Type: " + kind + "\r\nMIME-Version: 1.0\r\n\r\n").encode("ascii") + raw)
    require(message.is_multipart(), "Frame response is not multipart")
    parts = list(message.iter_parts())
    require(len(parts) == 1 and parts[0].get_content_type() == "application/octet-stream", "Unexpected frame parts")
    return parts[0].get_payload(decode=True)


def smoke(origin, *, connect=None, ca_file=None, token=None, frame=None, member_rights=True):
    """health (and memberRights=ready for the introduced release), unauthenticated refusal, the token's subject, and the
    exact frame bytes; a 200 alone is never a pass."""
    code, _, raw = https_get(origin, "/api/health", connect=connect, ca_file=ca_file)
    health = json.loads(raw)
    require(code == 200 and health.get("ok") is True and health.get("auth") is True, "Health or authentication flag failed")
    if member_rights:
        require(health.get("memberRights") == "ready", "Member rights are not ready")
    require(https_get(origin, "/api/me", connect=connect, ca_file=ca_file)[0] == 401, "Unauthenticated request was not refused")
    result = {"health": True, "auth_refusal": True, "member": None, "frame": None}
    if token is not None:
        code, _, raw = https_get(origin, "/api/me", connect=connect, ca_file=ca_file, token=token["access_token"])
        require(code == 200, "Authenticated identity check refused (HTTP %d %s)" % (code, refusal_code(raw)))
        require(json.loads(raw).get("sub") == token["subject"], "Authenticated identity is another subject")
        result["member"] = True
        if frame is not None:
            code, kind, raw = https_get(origin, frame["path"], connect=connect, ca_file=ca_file, token=token["access_token"],
                                        limit=frame["bytes"] + 65536, accept='multipart/related; type="application/octet-stream"')
            require(code == 200, "Frame request failed")
            payload = frame_payload(kind, raw)
            require(len(payload) == frame["bytes"] and sha256_bytes(payload) == frame["sha256"], "Frame bytes differ")
            result["frame"] = True
    return result


def token_valid(value):
    _keys(value, ("access_token", "subject"), "smoke token")
    require(type(value["access_token"]) is str and 0 < len(value["access_token"]) <= 16384
            and re.fullmatch(r"[A-Za-z0-9._~-]+", value["access_token"]), "Invalid smoke token")
    require(type(value["subject"]) is str and 0 < len(value["subject"]) <= 256, "Invalid smoke subject")
    return value


# ── the phase state machine ──

STEPS = {
    "capture": (("L-01", "baseline", False, False), ("L-04a", "fence", True, False), ("L-04b", "capture_b0", False, False),
                ("L-04c", "restore_check_b0", False, False)),
    "release": (("RL-01", "unfence", True, False), ("RL-02", "public_check_previous", False, False)),
    "introduce": (("I-00", "recheck_fence", False, False), ("L-06a", "storage", True, False), ("L-06b", "provision", True, True),
                  ("L-07", "migrate", True, True), ("L-08a", "keycloak", True, True), ("L-08b", "member_import", True, True),
                  ("L-09a", "api", True, True), ("L-09b", "proxy_ui", True, True)),
    "verify": (("L-10a", "fenced_smoke", False, False), ("L-10b", "probe", True, True), ("L-10c", "capture_b1", True, True),
               ("L-10d", "resume", True, True)),
    "reopen": (("L-11a", "final_allowlist", False, False), ("L-11b", "restore_jobs", True, False),
               ("L-11c", "reopen_ingress", True, False), ("L-11d", "public_smoke", False, False)),
    "rollback": (("RB-00", "classify", True, False), ("RB-01", "preserve_failed", False, False), ("RB-02", "restore_b0", True, False),
                 ("RB-03", "previous_services", True, False), ("RB-04", "verify_and_reopen", True, False)),
    "seed": (("S-01", "seed_check", False, False), ("S-02", "seed_restore", True, False), ("S-03", "seed_services", True, False)),
    "receipt": (("RC-01", "write_receipt", False, False),),
}
# Which statuses each phase may start from.
FROM = {"capture": ("NEW", "SEEDED"), "release": ("HELD", "CAPTURE_FAILED"), "introduce": ("HELD",), "verify": ("INTRODUCED",),
        "reopen": ("VERIFIED",), "rollback": ("INTRODUCED", "VERIFIED", "NEEDS_ATTENTION", "INTRODUCE_FAILED", "VERIFY_FAILED"),
        "seed": ("NEW",), "receipt": ("ROLLED_BACK",)}
DONE = {"capture": "HELD", "release": "RELEASED", "introduce": "INTRODUCED", "verify": "VERIFIED", "reopen": "DEPLOYED",
        "rollback": "ROLLED_BACK", "seed": "SEEDED", "receipt": "RECEIPTED"}
BUDGET = {"capture": "capture_s", "release": "capture_s", "introduce": "introduce_s", "verify": "verify_s", "reopen": "reopen_s",
          "rollback": "rollback_s", "seed": "seed_s", "receipt": "capture_s"}


def new_state(plan_sha256, plan):
    return {"schema": 1, "mode": MODE, "plan_sha256": plan_sha256, "target_kind": plan["target_kind"], "status": "NEW",
            "lock_token": None, "db_changed": False, "ponr": None, "fenced": None, "checkout": "previous",
            "b0": None, "b1": None, "bfail": None, "seed": None, "recovery": None, "rollback_attempted": False,
            "history": [], "probe": None, "receipt": None}


class Introduction:
    """One phase of one plan. `ops` performs and observes the host operations (HostOps on a real host); this class owns
    order, the durable state, the lock, budgets, windows, the automatic-rollback decision and the records."""

    def __init__(self, *, plan, plan_sha256, target, production, ops, records, repository, host_key, tool, evidence=None,
                 clock=time.monotonic, now=utc_now):
        self.plan, self.plan_sha256, self.target, self.production = plan, plan_sha256, target, production
        self.ops, self.records, self.repository = ops, records, Path(repository)
        self.host_key, self.tool, self.evidence = host_key, tool, evidence or {}
        self.clock, self.now = clock, now
        self.state = None
        self.steps = []

    # ── bookkeeping ──
    def save(self):
        self.records.save(self.state)

    def event(self, kind, **fields):
        self.records.journal({"event": kind, "plan_sha256": self.plan_sha256, "phase": self.phase, **fields})

    def deadline_left(self):
        return self.budget - (self.clock() - self.started)

    def guard(self):
        """Before a mutating step: the budget, the window and the lock (a step never starts when one of them fails).
        A rollback is recovery, so the end of the window never blocks it; its own budget still does."""
        require(self.deadline_left() > 0, "Phase budget exceeded")
        if not self.recovering:
            now = self.now()
            require(parse_utc(self.plan["window"]["start"]) <= now < parse_utc(self.plan["window"]["end"]), "Outside the approved window")
        if self.state["lock_token"]:
            require(lock_owned(self.repository, self.state["lock_token"]), "Operations lock ownership changed")

    def run_step(self, sid, name, mutating, db_change):
        record = {"step": sid, "action": name, "mutating": mutating, "started_utc": self.now().isoformat()}
        self.event("step-start", step=sid)
        started = self.clock()
        if mutating:
            record["before"] = self.observe()
        try:
            if mutating:
                self.guard()
            if db_change and not self.state["db_changed"]:
                # Durable before the first database change: from here on, only a full B0 restore is a rollback.
                self.state["db_changed"] = True
                self.save()
            detail = getattr(self.ops, name)(self) or {}
        except Unknown as error:
            record.update(outcome="UNKNOWN", code=code_of(error), seconds=round(self.clock() - started, 3), after=self.observe())
            self.steps.append(record)
            self.event("step-end", step=sid, outcome="UNKNOWN", code=record["code"])
            raise
        except Exception as error:
            record.update(outcome="STOP", code=code_of(error), seconds=round(self.clock() - started, 3))
            if mutating:
                record["after"] = self.observe()
            self.steps.append(record)
            self.event("step-end", step=sid, outcome="STOP", code=record["code"])
            raise Stop(record["code"]) from None
        record.update(outcome="PASS", seconds=round(self.clock() - started, 3), detail=detail)
        if mutating:
            record["after"] = self.observe()
        self.steps.append(record)
        self.event("step-end", step=sid, outcome="PASS")
        return detail

    def observe(self):
        """The host as seen around a mutating step (selected, secret-free); an unobservable host is recorded as such."""
        snapshot = getattr(self.ops, "snapshot", None)
        if snapshot is None:
            return None
        try:
            return snapshot(self)
        except Exception as error:
            return {"unobservable": type(error).__name__}

    def result(self, status, passed, extra=None):
        steps = []
        for step in self.steps:
            steps.append({key: step[key] for key in ("step", "outcome", "seconds", "code") if key in step})
        out = {"mode": MODE, "phase": self.phase, "status": status, "phase_passed": passed, "plan_sha256": self.plan_sha256,
               "request_sha256": self.request_sha256, "target_kind": self.plan["target_kind"],
               "lock_retained": bool(self.state["lock_token"]) and lock_owned(self.repository, self.state["lock_token"]),
               "db_changed": self.state["db_changed"], "ponr": self.state["ponr"], "steps": steps}
        if extra:
            out.update(extra)
        return out

    def finish(self, status, passed, release=False, extra=None):
        self.state["status"] = status
        self.state["history"].append({"phase": self.phase, "status": "PASS" if passed else status,
                                      "request_sha256": self.request_sha256, "seconds": round(self.clock() - self.started, 3)})
        if release and self.state["lock_token"]:
            release_lock(self.repository, self.state["lock_token"])
            self.state["lock_token"] = None
        self.save()
        self.records.put("result-" + self.phase + "-" + self.request_sha256[:16] + ".json",
                         {"steps": self.steps, "status": status, "phase": self.phase})
        self.event("phase-end", status=status)
        return self.result(status, passed, extra)

    # ── entry ──
    def run(self, request, request_sha256):
        self.phase = request["phase"]
        self.request_sha256 = request_sha256
        self.started = self.clock()
        self.recovering = self.phase == "rollback"
        require(request["plan_sha256"] == self.plan_sha256, "Request names another plan")
        self.state = self.records.state() or new_state(self.plan_sha256, self.plan)
        require(self.state["plan_sha256"] == self.plan_sha256 and self.state["mode"] == MODE, "State belongs to another plan")
        self.budget = self.plan["budget"][BUDGET[self.phase]]
        require(self.state["status"] in FROM[self.phase], "Phase " + self.phase + " cannot follow " + self.state["status"])
        if self.phase in ("seed", "receipt"):
            require(self.plan["target_kind"] == "rehearsal", "Seed and receipt exist only on a rehearsal target")
        if self.phase == "rollback":
            require(self.state["ponr"] is None, "Ingress was reopened: no automatic or requested rollback past this point")
            require(self.state["db_changed"] and not self.state["rollback_attempted"], "Rollback is not applicable or was already attempted")
        require(self.tool == self.plan["tool"], "Installed tool differs from the plan")
        check_target(self.target, self.production, self.plan["target_kind"], self.host_key)
        require(sha256_bytes(canonical(self.target)) == self.plan["target_manifest_sha256"], "Target manifest differs from the plan")
        self.check_evidence()
        self.event("phase-start")
        if self.phase in ("capture", "seed"):
            # A new exclusive lock; a competing backup, rehearsal or API-only deployment cannot hold it meanwhile.
            try:
                self.state["lock_token"] = acquire_lock(self.repository)
            except FileExistsError:
                raise Stop("Operations lock is held by another operation") from None
            self.save()
        elif self.phase != "receipt":
            require(self.state["lock_token"] and lock_owned(self.repository, self.state["lock_token"]),
                    "This release no longer owns the operations lock")
        return getattr(self, "phase_" + self.phase)()

    def check_evidence(self):
        if self.phase == "introduce" and self.plan["target_kind"] == "production":
            require(self.state["b0"] is not None, "No B0 snapshot")
            require(type(self.evidence.get("local-restore")) is dict, "Local-restore receipt required")
            receipt_valid(self.evidence["local-restore"], self.plan, self.state["b0"]["manifest_sha256"], self.production)
        if self.phase == "reopen":
            require(type(self.evidence.get("operator-smoke")) is dict, "Operator smoke record required")
            operator_smoke_valid(self.evidence["operator-smoke"], self.plan_sha256)

    def steps_of(self, phase):
        for sid, name, mutating, db_change in STEPS[phase]:
            self.run_step(sid, name, mutating, db_change)

    # ── phases ──
    def phase_capture(self):
        try:
            self.run_step(*STEPS["capture"][0])
        except Stop:
            # Nothing changed yet: free the lock and leave the plan where it was.
            return self.finish(self.state["status"], False, release=True)
        except Unknown:
            return self.finish("NEEDS_ATTENTION", False)
        try:
            for item in STEPS["capture"][1:]:
                self.run_step(*item)
        except Stop:
            # The writers stay fenced: a failed capture is never "resumed" behind the operator's back.
            return self.finish("CAPTURE_FAILED", False)
        except Unknown:
            return self.finish("NEEDS_ATTENTION", False)
        return self.finish("HELD", True, extra={"b0": self.state["b0"]})

    def phase_release(self):
        require(not self.state["db_changed"] and self.state["checkout"] == "previous", "Release is only for an unchanged database")
        try:
            self.steps_of("release")
        except (Stop, Unknown):
            return self.finish("NEEDS_ATTENTION", False)
        return self.finish("RELEASED", True, release=True)

    def settled_failure(self, failed_status):
        """After a settled STOP: before the first database change the configuration is reverted (writers stay fenced);
        after it, an automatic rollback runs only if no one-shot worker can still be alive."""
        if not self.state["db_changed"]:
            self.enter_recovery()
            try:
                self.run_step("I-RV", "revert_configuration", True, False)
            except (Stop, Unknown):
                return self.finish("NEEDS_ATTENTION", False)
            return self.finish("HELD", False)
        try:
            alive = self.ops.one_shots_alive(self)
        except Exception:
            alive = ["unobservable"]
        if alive:
            self.event("rollback-withheld", reason="one-shot worker may be alive")
            return self.finish("NEEDS_ATTENTION", False, extra={"rollback": "withheld: a one-shot worker may be alive"})
        if self.state["ponr"] is not None:
            return self.finish("NEEDS_ATTENTION", False, extra={"rollback": "withheld: ingress was reopened"})
        self.state["status"] = failed_status
        self.save()
        return self.rollback_steps(explicit=False)

    def phase_introduce(self):
        try:
            self.steps_of("introduce")
        except Stop:
            return self.settled_failure("INTRODUCE_FAILED")
        except Unknown:
            return self.finish("NEEDS_ATTENTION", False, extra={"rollback": "withheld: unknown end state"})
        return self.finish("INTRODUCED", True)

    def phase_verify(self):
        try:
            self.steps_of("verify")
        except Stop:
            return self.settled_failure("VERIFY_FAILED")
        except Unknown:
            return self.finish("NEEDS_ATTENTION", False, extra={"rollback": "withheld: unknown end state"})
        return self.finish("VERIFIED", True, extra={"b1": self.state["b1"], "probe": self.state["probe"]})

    def phase_reopen(self):
        try:
            for item in STEPS["reopen"]:
                if item[1] == "reopen_ingress":
                    # The point of no return is durable before the public ingress opens.
                    self.state["ponr"] = {"step": item[0], "at": self.now().isoformat()}
                    self.save()
                self.run_step(*item)
        except (Stop, Unknown):
            return self.finish("NEEDS_ATTENTION" if self.state["ponr"] else "VERIFIED", False)
        return self.finish("DEPLOYED", True, release=True)

    def rollback_steps(self, explicit):
        """RB-00..RB-04 under the rollback budget. Automatic after a settled failure, or an explicit phase; once only."""
        self.state["rollback_attempted"] = True
        self.save()
        self.enter_recovery()
        try:
            self.steps_of("rollback")
        except (Stop, Unknown):
            return self.finish("NEEDS_ATTENTION", False, extra={"rollback": "failed; maintenance and lock kept, no retry"})
        return self.finish("ROLLED_BACK", explicit, release=True,
                           extra={"rollback": "completed", "data_restored": True, "recovery": self.state["recovery"],
                                  "bfail": self.state["bfail"]})

    def phase_rollback(self):
        return self.rollback_steps(explicit=True)

    def enter_recovery(self):
        """Recovery steps (revert, rollback) run under the rollback budget; the window's end never blocks them."""
        self.recovering = True
        self.started, self.budget = self.clock(), self.plan["budget"]["rollback_s"]

    def phase_seed(self):
        try:
            self.steps_of("seed")
        except (Stop, Unknown):
            return self.finish("NEEDS_ATTENTION", False)
        return self.finish("SEEDED", True, release=True)

    def phase_receipt(self):
        try:
            self.steps_of("receipt")
        except (Stop, Unknown):
            return self.finish("ROLLED_BACK", False, release=False)
        return self.finish("RECEIPTED", True, release=True, extra={"receipt": self.state["receipt"]})


def make_receipt(intro):
    """The rehearsal's local-restore receipt, from its own durable history only."""
    state, plan = intro.state, intro.plan
    phases = {}
    for item in state["history"]:
        if item["phase"] in ("seed", "capture", "introduce", "verify", "rollback") and item["status"] == "PASS":
            phases[item["phase"]] = {"status": "PASS", "seconds": item["seconds"], "request_sha256": item["request_sha256"]}
    require(set(phases) == {"seed", "capture", "introduce", "verify", "rollback"}, "The rehearsal did not pass every phase")
    require(state["b0"] and state["b1"] and state["seed"], "Rehearsal snapshots missing")
    return {"schema": 1, "kind": "local-restore", "passed": True, "plan_core_sha256": plan_core(plan),
            "rehearsal_plan_sha256": intro.plan_sha256, "source_b0_manifest_sha256": plan["seed"]["b0_manifest_sha256"],
            "rehearsal_b0_manifest_sha256": state["b0"]["manifest_sha256"], "rehearsal_b1_manifest_sha256": state["b1"]["manifest_sha256"],
            "tool": plan["tool"], "host_key_sha256": intro.host_key, "phases": phases, "created_utc": intro.now().isoformat()}


# ── host operations ──

def parse_env(raw):
    values = {}
    for line in raw.decode("utf-8").splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith("#") and "=" in stripped:
            name, value = stripped.split("=", 1)
            name = name.strip()
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
                value = value[1:-1]
            if ops.ENV_NAME.fullmatch(name):
                values[name] = value
    return values


def compose_digest(entries):
    """sha256 over (name, length, bytes) of each compose file then .env, as ops_deploy_host.compose_digest does."""
    digest = hashlib.sha256()
    for name, raw in entries:
        digest.update(name.encode() + b"\0" + len(raw).to_bytes(8, "big") + raw)
    return digest.hexdigest()


def yaml_scalar(value):
    return json.dumps(value, ensure_ascii=True)


def override_yaml(services, *, volumes=None):
    """A Compose override from {service: {key: value}}; list values may carry a merge tag as ('!override', [...])."""
    lines = ["services:"]
    for service, fields in services.items():
        lines.append("  " + yaml_scalar(service) + ":")
        for key, value in fields.items():
            if isinstance(value, tuple):
                tag, items = value
                lines.append("    " + key + ": " + tag + " [" + ", ".join(yaml_scalar(item) for item in items) + "]")
            elif isinstance(value, list):
                lines.append("    " + key + ": [" + ", ".join(yaml_scalar(item) for item in value) + "]")
            elif isinstance(value, dict):
                lines.append("    " + key + ":")
                for name, item in value.items():
                    lines.append("      " + yaml_scalar(name) + ": " + yaml_scalar(item))
            else:
                lines.append("    " + key + ": " + yaml_scalar(value))
    if volumes:
        lines.append("volumes:")
        for key, name in volumes.items():
            lines.append("  " + yaml_scalar(key) + ": {external: true, name: " + yaml_scalar(name) + "}")
    return "\n".join(lines) + "\n"


def rehearsal_override(target, origin):
    """The clone's resource names and origin over the product's production compose (written to a private file that the
    rehearsal target manifest lists). Ports are loopback; the workflow network and certificates are the clone's own."""
    require(target["kind"] == "rehearsal", "Overrides exist only for rehearsal targets")
    parsed = urlsplit(origin)
    names = target["containers"]
    lines = ["name: " + yaml_scalar(target["project"]), "services:"]
    for role, extra in (("db", ["    ports: !reset []"]),
                        ("keycloak", ["    ports: !reset []", "    environment:", "      KC_HOSTNAME: " + yaml_scalar(origin + "/auth")]),
                        ("orthanc", ["    ports: !reset []"]),
                        ("api", ["    environment:", "      KC_ISSUER: " + yaml_scalar(origin + "/auth/realms/kin")]),
                        ("proxy", ["    ports: !override [" + ", ".join(yaml_scalar(item) for item in target["ports"]["public"]) + "]",
                                   "    environment:", "      DEPLOYMENT_MODE: \"development\"",
                                   "      SERVER_NAME: " + yaml_scalar(parsed.hostname),
                                   "      PUBLIC_PORT: " + yaml_scalar(str(parsed.port or 443)),
                                   "    volumes: !override [\"proxy-certs:/etc/nginx/certs\", \"rehearsal-workflow:/etc/nginx/workflow:ro\"]"])):
        lines += ["  " + role + ":", "    container_name: " + yaml_scalar(names[role]), *extra]
    lines += ["networks:", "  workflow:", "    name: " + yaml_scalar(target["networks"]["workflow"]),
              "volumes:", "  rehearsal-workflow: {}", ""]
    return "\n".join(lines)


ROSTER_SCRIPT = r"""
const {KeycloakService}=require('/app/dist/keycloak.service');
(async()=>{const listed=await new KeycloakService().listUsers(1);
 const users=listed.realmUsers.map(u=>({id:u.id,username:u.username,enabled:u.enabled===true,groups:[...u.groups].sort(),roles:[...u.roles].sort()}));
 process.stdout.write('KIN_RESULT '+JSON.stringify({users})+'\n');})().catch(()=>{process.exitCode=1;});
"""
RIGHTS_SCRIPT = r"""
const {PrismaClient}=require('/app/node_modules/@prisma/client');const db=new PrismaClient();
(async()=>{const markers=(await db.memberRightsImport.findMany()).map(m=>m.id).sort();
 const rights=(await db.memberRights.findMany()).map(r=>({sub:r.sub,username:r.username,approved:r.approved,suspended:r.suspended,institution:r.institution,roles:[...r.roles].sort()}));
 const legacy=(await db.providerChange.findMany({where:{kind:'credentials'}})).filter(c=>c.target==='legacy-enable:'+c.sub).map(c=>({sub:c.sub,state:c.state}));
 process.stdout.write('KIN_RESULT '+JSON.stringify({markers,rights,legacy})+'\n');})().catch(()=>{process.exitCode=1;}).finally(()=>db.$disconnect());
"""
SERVERINFO_SCRIPT = r"""
const base=(process.env.KC_ADMIN_URL||'').replace(/\/$/,'');
(async()=>{const form=new URLSearchParams({grant_type:'password',client_id:'admin-cli',username:process.env.KIN_KC_ADMIN_USER,password:process.env.KIN_KC_ADMIN_PASSWORD});
 const t=await (await fetch(base+'/realms/master/protocol/openid-connect/token',{method:'POST',body:form})).json();
 const info=await (await fetch(base+'/admin/serverinfo',{headers:{Authorization:'Bearer '+t.access_token}})).json();
 const caches=info?.providers?.userSessions?.providers?.infinispan?.operationalInfo?.useCaches;
 const features=Array.isArray(info.features)?info.features:[];
 const persistent=features.find(f=>f&&f.name==='PERSISTENT_USER_SESSIONS');
 process.stdout.write('KIN_RESULT '+JSON.stringify({useCaches:caches===undefined?null:String(caches),persistentUserSessions:persistent?persistent.enabled===true:null})+'\n');
})().catch(()=>{process.exitCode=1;});
"""
STATE_VOLUME_SCRIPT = r"""
const fs=require('fs'),p='/var/lib/kin-emr',s=fs.statSync(p);let writable=false;
try{const t=p+'/.kin-introduction-'+process.pid;const fd=fs.openSync(t,'wx',0o600);fs.writeSync(fd,'probe');fs.fsyncSync(fd);fs.closeSync(fd);
 fs.renameSync(t,t+'.renamed');writable=fs.readFileSync(t+'.renamed','utf8')==='probe';fs.unlinkSync(t+'.renamed');}catch{writable=false;}
process.stdout.write('KIN_RESULT '+JSON.stringify({uid:s.uid,gid:s.gid,mode:(s.mode&0o777).toString(8),writable,uid_self:process.getuid()})+'\n');
"""
HEALTH_SCRIPT = r"""
fetch('http://127.0.0.1:3000/api/health').then(async r=>{const h=await r.json();
 process.stdout.write('KIN_RESULT '+JSON.stringify({status:r.status,ok:h.ok===true,auth:h.auth===true,memberRights:h.memberRights??null})+'\n');})
 .catch(()=>{process.exitCode=1;});
"""
SERVED_SCRIPT = r"""
import hashlib, json, os
def tree(root):
    out = {}
    for base, dirs, files in os.walk(root):
        dirs.sort()
        for name in sorted(files):
            path = os.path.join(base, name)
            out[os.path.relpath(path, root)] = hashlib.sha256(open(path, 'rb').read()).hexdigest()
    return out
single = lambda path: hashlib.sha256(open(path, 'rb').read()).hexdigest()
print('KIN_RESULT ' + json.dumps({'ohif.js': single('/etc/orthanc/ohif.js'), 'orthanc.json': single('/etc/orthanc/orthanc.json'),
                                  'worklist-v0': tree('/worklist')}, sort_keys=True))
"""


REALM_MEMBERS_SQL = """SELECT json_build_object(
  'realm_members', count(*) FILTER (WHERE NOT service),
  'disabled', count(*) FILTER (WHERE NOT service AND NOT enabled),
  'service_accounts', count(*) FILTER (WHERE service)) FROM (
  SELECT u.enabled, (u.service_account_client_link IS NOT NULL OR u.username LIKE 'service-account-%') AS service
  FROM user_entity u JOIN realm r ON r.id = u.realm_id WHERE r.name = 'kin') m"""
# Every relation of every emr_* schema with each table's TOAST table and TOAST index: emr_access.storage_placement()'s rule
# (relkinds r/i/p/m), applied to all EMR schemas, read as the installer (the function itself exists only after L-07).
PLACEMENT_SQL = """WITH own AS (
  SELECT c.oid, n.nspname || '.' || c.relname AS relation, c.reltablespace, c.reltoastrelid
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname LIKE 'emr\\_%' AND c.relkind IN ('r', 'i', 'p', 'm')
), every AS (
  SELECT relation, reltablespace FROM own
  UNION ALL SELECT own.relation || ':toast', t.reltablespace FROM own JOIN pg_class t ON t.oid = own.reltoastrelid
  UNION ALL SELECT own.relation || ':toast-index', i.reltablespace
    FROM own JOIN pg_index x ON x.indrelid = own.reltoastrelid JOIN pg_class i ON i.oid = x.indexrelid
)
SELECT coalesce(json_agg(json_build_object('relation', relation, 'tablespace',
  coalesce((SELECT spcname::text FROM pg_tablespace s WHERE s.oid = every.reltablespace), 'database-default'))
  ORDER BY relation), '[]'::json) FROM every"""


def result_line(raw):
    lines = [line for line in raw.decode("utf-8", errors="replace").splitlines() if line.startswith("KIN_RESULT ")]
    require(len(lines) == 1, "Helper produced no single result")
    return json.loads(lines[0][len("KIN_RESULT "):])


class Runner:
    """Executes git/docker/crontab only. On the protected host the binaries and the environment are fixed. When the
    checkout belongs to an operating account (policy repository_owner), git runs as that account, so a checkout never
    leaves root-owned files in it."""

    def __init__(self, cwd, *, fixed=False, base_env=None, owner=None):
        self.cwd = str(cwd)
        self.fixed = fixed
        self.base_env = dict(base_env) if base_env is not None else None
        self.owner = owner

    def __call__(self, args, *, input=None, timeout=60, env=None, output=None, stdin=None):
        require(args and args[0] in ("git", "docker", "crontab"), "Command outside the fixed set")
        command = list(args)
        environment = None
        if self.fixed:
            command[0] = "/usr/bin/" + args[0]
            environment = dict(self.base_env or {})
        elif env:
            environment = dict(os.environ)
        if env:
            environment.update(env)
        identity = {}
        if args[0] == "git":
            command = [command[0], "-c", "core.hooksPath=" + os.devnull, "-c", "core.fsmonitor=false", *command[1:]]
            if self.owner:
                identity = {"user": self.owner["uid"], "group": self.owner["gid"], "extra_groups": []}
        return subprocess.run(command, cwd=self.cwd, env=environment, input=input, stdin=stdin,
                              stdout=output or subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, **identity)


def owned_private(path, owner, *, directory=False, private=False):
    """The production checkout as the host keeps it: owned by its operating account (C1's own rule is root). Every
    ancestor is root's or that account's, none is a link or writable by others (a sticky directory excepted)."""
    import stat as kinds
    path = Path(path)
    require(os.name == "posix" and os.geteuid() == 0 and path.is_absolute() and ".." not in path.parts, "Invalid protected path")
    for item in reversed((path, *path.parents)):
        info = item.lstat()
        require(not kinds.S_ISLNK(info.st_mode) and info.st_uid in (0, owner["uid"]), "A path component is a link or has another owner")
        require(not info.st_mode & 0o022 or (item != path and kinds.S_ISDIR(info.st_mode) and info.st_mode & kinds.S_ISVTX),
                "A path component is writable by others")
    info = path.lstat()
    require(info.st_uid == owner["uid"], "Path is not owned by the repository account")
    require(kinds.S_ISDIR(info.st_mode) if directory else (kinds.S_ISREG(info.st_mode) and info.st_nlink == 1), "Unexpected file type")
    require(not private or not info.st_mode & 0o077, "Path is not private")
    return path


@contextmanager
def bound_ops(repository, runner):
    """ops_backup's capture/rehearse helpers run against this repository through the fixed runner only."""
    def run(args, *, output=None, input_file=None, timeout=600, check=True):
        result = runner(args, output=output, stdin=input_file, timeout=timeout)
        if check and result.returncode:
            raise RuntimeError(f"{args[0]} {args[1] if len(args) > 1 else ''} failed (exit {result.returncode})")
        return result
    previous = ops.ROOT, ops.run
    ops.ROOT, ops.run = Path(repository), run
    try:
        yield
    finally:
        ops.ROOT, ops.run = previous


class HostOps:
    """The docker/compose/git/crontab operations of each step, against one target manifest only."""

    def __init__(self, *, target, plan, runner, records, env_next=None, token_reader=None, secure=None, owner=None):
        self.t, self.plan, self.run, self.records = target, plan, runner, records
        self.owner = owner
        self.repo = Path(target["repository"])
        self.names = target["containers"]
        self.env_next = env_next          # path of the staged .env for the target (private)
        self.token_reader = token_reader  # () -> {"access_token", "subject"}
        self.secure = secure or (lambda path: None)

    # ── primitives ──
    def cmd(self, args, *, timeout=60, input=None, env=None, check=True, mutating=False, stdin=None, output=None, quiet=False):
        """quiet: the command carries a secret on stdin, so its error text (which may quote that input) is never kept."""
        try:
            result = self.run(args, input=input, timeout=timeout, env=env, stdin=stdin, output=output)
        except subprocess.TimeoutExpired:
            if mutating:
                raise Unknown(args[0] + " " + (args[1] if len(args) > 1 else "") + " timed out; its end state is unknown") from None
            raise Stop(args[0] + " timed out") from None
        if check and result.returncode:
            if not quiet:
                self.records.log("failed-" + uuid.uuid4().hex[:12] + ".err",
                                 (" ".join(args[:3]) + "\n").encode() + (result.stderr or b"")[-16384:])
            raise Stop(f"{args[0]} {args[1] if len(args) > 1 else ''} failed (exit {result.returncode})")
        return result

    def text(self, args, **kwargs):
        return self.cmd(args, **kwargs).stdout.decode("utf-8").strip()

    def compose_files(self):
        out = []
        for item in self.t["compose_files"]:
            out += ["-f", item if PurePosixPath(item).is_absolute() or PureWindowsPath(item).is_absolute() else str(self.repo / item)]
        return out

    def compose(self, args, *, override=None, timeout=180, env=None, mutating=True, check=True):
        command = ["docker", "compose", "--project-directory", str(self.repo), "--project-name", self.t["project"],
                   *self.compose_files(), *(["-f", "-"] if override else []), *args]
        return self.cmd(command, input=override.encode() if override else None, timeout=timeout, env=env,
                        mutating=mutating, check=check)

    def pins(self, intro, *, release=None, maintenance=True, recovery=None):
        """Image IDs for every service of the current checkout, the API release label, the fenced proxy ports."""
        side = "release" if intro.state["checkout"] == "target" else "previous"
        images = intro.plan[side]["images"]
        services = {role: {"image": images[role]} for role in ROLES}
        services["api"]["labels"] = {"kin.deploy.release": intro.plan[side]["sha"]}
        if side == "release":
            services["api-migrate"] = {"image": images["api"], "container_name": self.names["api-migrate"]}
            services["emr-provision"] = {"image": images["db"], "container_name": self.names["emr-provision"]}
        if maintenance:
            services["proxy"]["ports"] = ("!override", [self.t["ports"]["maintenance"]])
        volumes = None
        if recovery:
            services["db"]["volumes"] = ["kin-recovery-pg:/var/lib/postgresql/data"]
            services["orthanc"]["volumes"] = ["kin-recovery-orthanc:/var/lib/orthanc/db"]
            volumes = {"kin-recovery-pg": recovery["pg"], "kin-recovery-orthanc": recovery["orthanc"]}
        return override_yaml(services, volumes=volumes)

    def inspect(self, role):
        result = self.cmd(["docker", "inspect", self.names[role]], check=False)
        if result.returncode:
            return None
        items = json.loads(result.stdout)
        require(type(items) is list and len(items) == 1, "Unexpected Docker inspection")
        return items[0]

    def running(self):
        state = {}
        for role in ROLES:
            item = self.inspect(role)
            state[role] = bool(item and item["State"]["Running"])
        return state

    def psql(self, sql, database="kin"):
        return self.text(["docker", "exec", self.names["db"], "psql", "-X", "-U", "kin", "-d", database, "-v", "ON_ERROR_STOP=1",
                          "-qAt", "-c", sql], timeout=120)

    def db_clients(self):
        return int(self.psql("SELECT count(*) FROM pg_stat_activity WHERE datname IN ('kin','keycloak') "
                             "AND backend_type='client backend' AND pid<>pg_backend_pid();"))

    def snapshot(self, intro):
        """Around each mutating step: which image each role runs (or none), the checkout, the applied history's head."""
        running = {}
        for role in ROLES:
            item = self.inspect(role)
            running[role] = item["Image"] if item and item["State"]["Running"] else None
        try:
            rows = ops.migration_rows(self.names["db"])
            history = {"count": len(rows), "last": rows[-1][0] if rows else None}
        except Exception as error:
            history = {"unobservable": type(error).__name__}
        return {"running": running, "head": self.text(["git", "rev-parse", "HEAD"]), "migrations": history,
                "lock": lock_owned(self.repo, intro.state["lock_token"]) if intro.state.get("lock_token") else False}

    def one_shots_alive(self, intro):
        """Every one-shot container of this release that still exists (running or not removed yet)."""
        out = self.text(["docker", "ps", "-a", "--filter", "label=kin.emr-introduction=" + intro.plan_sha256[:16],
                         "--format", "{{.Names}} {{.State}}"])
        return [line for line in out.splitlines() if line.strip() and not line.endswith(" exited")]

    def wait(self, predicate, seconds, message):
        deadline = time.monotonic() + seconds
        while True:
            try:
                if predicate():
                    return
            except Stop:
                pass
            if time.monotonic() >= deadline:
                raise Stop(message)
            time.sleep(1)

    def healthy(self, role):
        item = self.inspect(role)
        return bool(item and item["State"]["Running"] and (item["State"].get("Health") or {}).get("Status") == "healthy")

    def one_shot(self, intro, service, args, *, timeout, env=None, entrypoint=None, name, worker=True):
        """A named, labelled one-shot (never --rm before its exit is recorded). A worker (anything that writes) carries
        this release's label, so a later rollback can see whether it may still be alive; its client timeout is an
        unknown end. A read-only helper that times out is removed and is a settled refusal."""
        token = uuid.uuid4().hex[:12]
        container = self.t["project"] + "-" + name + "-" + token
        command = ["run", "--no-deps", "-T", "--name", container, "--label", "kin.ops.run=" + token]
        if worker:
            command += ["--label", "kin.emr-introduction=" + intro.plan_sha256[:16]]
        for key in (env or {}):
            command += ["-e", key]
        if entrypoint:
            command += ["--entrypoint", entrypoint]
        command += [service, *args]
        try:
            result = self.compose(command, override=self.pins(intro), timeout=timeout, env=env, check=False, mutating=True)
        except Unknown:
            state = self.cmd(["docker", "inspect", "--format", "{{.State.Running}}", container], check=False)
            alive = state.returncode == 0 and state.stdout.decode().strip() == "true"
            if not worker:
                self.cmd(["docker", "rm", "-f", container], check=False)
                raise Stop(name + " helper timed out") from None
            raise Unknown(name + (" worker is still running" if alive else " ended without a recorded exit")) from None
        logs = {"stdout": self.records.log(container + ".out", result.stdout), "stderr": self.records.log(container + ".err", result.stderr)}
        exited = self.cmd(["docker", "inspect", "--format", "{{.State.ExitCode}}", container], check=False)
        exit_code = int(exited.stdout.decode().strip()) if exited.returncode == 0 else None
        if exit_code is not None:
            self.cmd(["docker", "rm", container], check=False)
        return {"container": container, "exit": result.returncode, "container_exit": exit_code, "logs": logs, "stdout": result.stdout}

    def helper(self, intro, script, *, env=None, name="helper", timeout=120, args=()):
        out = self.one_shot(intro, "api", ["-e", script, *args], timeout=timeout, env=env, entrypoint="node", name=name, worker=False)
        require(out["exit"] == 0, name + " helper failed")
        return result_line(out["stdout"])

    def resolved(self, intro):
        raw = self.compose(["config", "--format", "json"], override=self.pins(intro), timeout=60, mutating=False).stdout
        model = json.loads(raw)
        # Only names leave this function; the resolved model carries interpolated secrets.
        return {"project": model.get("name"),
                "containers": {name: (service or {}).get("container_name") for name, service in (model.get("services") or {}).items()
                               if name in (*ROLES, *ONE_SHOTS)},
                "volumes": {key: (value or {}).get("name") for key, value in (model.get("volumes") or {}).items()},
                "networks": {key: (value or {}).get("name") for key, value in (model.get("networks") or {}).items()},
                "api_environment": sorted(((model.get("services") or {}).get("api") or {}).get("environment") or {}),
                "proxy_ports": [f"{p.get('host_ip') + ':' if p.get('host_ip') else ''}{p.get('published')}:{p.get('target')}"
                                for p in ((model.get("services") or {}).get("proxy") or {}).get("ports") or []]}

    def cron(self):
        if self.t["cron"] is None:
            return None
        result = self.cmd(["crontab", "-u", self.t["cron"]["user"], "-l"], check=False)
        require(result.returncode == 0, "Scheduled jobs are unreadable")
        return result.stdout

    def cron_lines(self, raw, tags):
        lines = raw.decode("utf-8").splitlines()
        tagged = {tag: [line for line in lines if line.rstrip().endswith("# " + tag)] for tag in tags}
        return lines, tagged

    def env_file(self):
        return self.repo / ".env"

    def git_blob_sha256(self, sha, path):
        return sha256_bytes(self.cmd(["git", "cat-file", "blob", sha + ":" + path]).stdout)

    def git_tree_sha256(self, sha, path):
        listing = self.text(["git", "ls-tree", "-r", "--full-tree", sha, path])
        out = {}
        for line in listing.splitlines():
            meta, name = line.split("\t", 1)
            if meta.split()[1] == "blob":
                out[str(PurePosixPath(name).relative_to(path))] = self.git_blob_sha256(sha, name)
        return out

    def compose_digest_now(self):
        entries = []
        for item in self.t["compose_files"]:
            path = Path(item) if PurePosixPath(item).is_absolute() or PureWindowsPath(item).is_absolute() else self.repo / item
            entries.append((item, path.read_bytes()))
        entries.append((".env", self.env_file().read_bytes()))
        return compose_digest(entries)

    def resources(self):
        return {"containers": {role: self.names[role] for role in ROLES},
                "volumes": {key: self.t["volumes"][key] for key in VOLUMES}}

    def capture_config(self):
        """Compose files beyond the legacy pair (monitor overlay, a rehearsal override) are captured by their own names."""
        out = {}
        for item in self.t["compose_files"]:
            name = Path(item).name
            if name not in ops.FILES[3:]:
                out[name] = Path(item) if PurePosixPath(item).is_absolute() or PureWindowsPath(item).is_absolute() else self.repo / item
        return out

    def hold(self, directory, plan_sha256, on):
        path = Path(directory) / ops.HOLD_FILE
        if on:
            path.write_text(json.dumps({"plan_sha256": plan_sha256, "reason": "emr-introduction"}) + "\n", encoding="utf-8")
            if os.name == "posix":
                path.chmod(0o600)
        elif path.exists():
            path.unlink()

    def stop_writers(self):
        for role in FENCE_ORDER:
            item = self.inspect(role)
            if item and item["State"]["Running"]:
                self.cmd(["docker", "stop", "--time", "45", self.names[role]], timeout=120, mutating=True)

    def start_roles(self, roles):
        for role in RESUME_ORDER:
            if role in roles:
                self.cmd(["docker", "start", self.names[role]], timeout=120, mutating=True)

    def api_health(self, member_rights):
        def ready():
            out = self.cmd(["docker", "exec", self.names["api"], "node", "-e", HEALTH_SCRIPT], timeout=20, check=False)
            if out.returncode:
                item = self.inspect("api")
                require(item and item["State"]["Running"], "API exited during start")
                return False
            value = result_line(out.stdout)
            return value["status"] == 200 and value["ok"] and value["auth"] and (not member_rights or value["memberRights"] == "ready")
        self.wait(ready, 120, "API did not become healthy")

    def reload_proxy(self):
        self.cmd(["docker", "exec", self.names["proxy"], "nginx", "-t"], timeout=30)
        self.cmd(["docker", "exec", self.names["proxy"], "nginx", "-s", "reload"], timeout=30, mutating=True)

    def maintenance(self):
        host, port, _ = self.t["ports"]["maintenance"].split(":")
        return (host, int(port))

    # ── capture ──
    def baseline(self, intro):
        model = self.resolved(intro)
        check_resolved(model, self.t, target_checkout=False)
        self.secure(self.env_file())
        require(self.compose_digest_now() == intro.plan["compose"]["before_sha256"], "Compose files or .env differ from the plan")
        running, restarting, images = {}, {}, {}
        for role in ROLES:
            item = self.inspect(role)
            require(item is not None, "A service of the previous release does not exist: " + role)
            running[role], restarting[role], images[role] = item["State"]["Running"], bool(item["State"].get("Restarting")), item["Image"]
        api = self.inspect("api")
        existing = [name for name in (self.t["volumes"]["emr_access"], self.t["volumes"]["emr_state"])
                    if self.cmd(["docker", "volume", "inspect", name], check=False).returncode == 0]
        cron = "not-managed"
        raw = self.cron()
        if raw is not None:
            _, tagged = self.cron_lines(raw, self.t["cron"]["tags"])
            cron = "matched" if all(len(lines) == 1 and not lines[0].lstrip().startswith("#") for lines in tagged.values()) else "mismatch"
        self.image_revision(intro.plan["previous"])
        observed = {"head": self.text(["git", "rev-parse", "HEAD"]),
                    "dirty": bool(self.text(["git", "status", "--porcelain", "--untracked-files=no"])),
                    "images": images, "running": running, "restarting": restarting,
                    "migrations": ops.migration_rows(self.names["db"]), "catalog": ops.role_catalog(self.names["db"]),
                    "emr_volumes": existing, "api_state_mounts": sum(1 for m in api.get("Mounts") or [] if m.get("Destination") == ops.EMR_STATE),
                    "cron": cron, "members": self.realm_members()}
        pre.check_baseline(observed, intro.plan)
        free = shutil.disk_usage(intro.plan["backup_root"] if Path(intro.plan["backup_root"]).exists() else Path(intro.plan["backup_root"]).parent).free
        require(free >= intro.plan["budget"]["min_free_bytes"], "Free disk space below the plan")
        return {"head": observed["head"], "images": images, "migrations": len(observed["migrations"]), "cron": cron, "free_bytes": free,
                "members": observed["members"]}

    def realm_members(self):
        """Realm kin's people by count only (read-only SQL on the Keycloak database): members as the product counts them
        (keycloak.service.ts excludes service accounts, also by their reserved name), the disabled ones, service accounts."""
        value = json.loads(self.psql(REALM_MEMBERS_SQL, "keycloak"))
        return {key: int(value[key]) for key in ("realm_members", "disabled", "service_accounts")}

    def freeze(self, intro):
        running = self.running()
        cron = "not-managed"
        raw = self.cron()
        if raw is not None:
            _, tagged = self.cron_lines(raw, self.t["cron"]["tags"])
            cron = "fenced" if all(lines and all(line.startswith(FENCED) for line in lines) for lines in tagged.values()) else "open"
        observed = {"running": running, "db_clients": self.db_clients(), "cron": cron, "one_shots": self.one_shots_alive(intro)}
        pre.check_write_freeze(observed)
        return observed

    def fence(self, intro):
        before = self.running()
        intro.state["fenced"] = {"running_before": [role for role in WRITERS if before[role]]}
        raw = self.cron()
        if raw is not None:
            intro.state["fenced"]["cron_sha256"] = sha256_bytes(raw)
            intro.records.write(intro.records.directory / "cron-before", raw)
        intro.save()
        if raw is not None:
            lines, _ = self.cron_lines(raw, self.t["cron"]["tags"])
            fenced = [FENCED + line if any(line.rstrip().endswith("# " + tag) for tag in self.t["cron"]["tags"]) else line for line in lines]
            self.cmd(["crontab", "-u", self.t["cron"]["user"], "-"], input=("\n".join(fenced) + "\n").encode(), mutating=True)
        self.stop_writers()
        return {"running_before": intro.state["fenced"]["running_before"], "freeze": self.freeze(intro)}

    def capture(self, intro, shape, label):
        printed = io.StringIO()
        with bound_ops(self.repo, self.run), redirect_stdout(printed):
            directory = ops.capture_held(intro.plan["backup_root"], self.resources(), shape=shape, label=label,
                                         config=self.capture_config(),
                                         facts={"origin": self.t["origin"], "project": self.t["project"],
                                                "tls_certificate": self.t["tls_certificate"], "checkout": self.text(["git", "rev-parse", "HEAD"])})
            _, manifest, digest = ops.validate_held(directory)
        self.records.log(label + ".out", printed.getvalue().encode())
        self.hold(directory, intro.plan_sha256, True)
        return {"dir": str(directory), "manifest_sha256": digest, "shape": shape, "counts": manifest["counts"]}

    def capture_b0(self, intro):
        self.freeze(intro)
        intro.state["b0"] = self.capture(intro, "pre", "emr-b0")
        intro.save()
        return intro.state["b0"]

    def restore_check(self, directory):
        """ops.rehearse(): fresh networkless containers and volumes, counts, (post) owners/ACL/tablespace and seal recovery."""
        printed = io.StringIO()
        with bound_ops(self.repo, self.run), redirect_stdout(printed):
            ops.rehearse(directory)
        self.records.log("restore-check-" + Path(directory).name + ".out", printed.getvalue().encode())
        found = sorted(Path(directory).glob("rehearsal-*.json"), key=lambda path: path.stat().st_mtime)
        result = json.loads(found[-1].read_text(encoding="utf-8"))
        require(result.get("success") is True and not result.get("cleanup_failures"), "Same-point restore check failed")
        return {"success": True, "seconds": result.get("seconds"), "emr": result.get("emr"), "orthanc": result.get("orthanc")}

    def restore_check_b0(self, intro):
        intro.state["b0"]["restore_check"] = self.restore_check(intro.state["b0"]["dir"])
        intro.save()
        return intro.state["b0"]["restore_check"]

    # ── release (nothing in the database changed) ──
    def restore_cron(self, intro):
        if self.t["cron"] is None:
            return {"cron": "not-managed"}
        raw = intro.records.read(intro.records.directory / "cron-before")
        require(sha256_bytes(raw) == intro.state["fenced"]["cron_sha256"], "Saved scheduled jobs changed")
        self.cmd(["crontab", "-u", self.t["cron"]["user"], "-"], input=raw, mutating=True)
        require(self.cron() == raw, "Scheduled jobs were not restored exactly")
        return {"cron": "restored"}

    def unfence(self, intro):
        require(not self.one_shots_alive(intro), "A one-shot worker of this release exists")
        require(self.text(["git", "rev-parse", "HEAD"]) == intro.plan["previous"]["sha"], "Checkout is not the previous release")
        self.start_roles(intro.state["fenced"]["running_before"])
        self.api_health(member_rights=False)
        self.reload_proxy()
        out = self.restore_cron(intro)
        if intro.state["b0"]:
            self.hold(intro.state["b0"]["dir"], intro.plan_sha256, False)
        return out

    def public_check_previous(self, intro):
        return smoke(self.t["origin"], ca_file=self.t["ca_file"], member_rights=False)

    # ── introduce ──
    def recheck_fence(self, intro):
        observed = self.freeze(intro)
        with bound_ops(self.repo, self.run):
            ops.validate_held(intro.state["b0"]["dir"], intro.state["b0"]["manifest_sha256"])
        return {"freeze": observed, "b0": "valid"}

    def staged_env(self, intro):
        self.secure(self.env_next)
        raw = Path(self.env_next).read_bytes()
        require(sha256_bytes(raw) == intro.plan["secrets"]["env_next_sha256"], "Staged env differs from the plan")
        pre.check_env_secrets(parse_env(raw), intro.plan["secrets"])
        return raw

    def checkout(self, intro, side):
        sha = intro.plan["release" if side == "target" else "previous"]["sha"]
        require(not self.text(["git", "status", "--porcelain", "--untracked-files=no"]), "Tracked working tree is dirty")
        require(self.text(["git", "cat-file", "-t", sha]) == "commit", "Commit is not present")
        intro.state["checkout"] = "changing"
        intro.save()
        self.cmd(["git", "checkout", "--detach", sha], timeout=60, mutating=True)
        require(self.text(["git", "rev-parse", "HEAD"]) == sha, "Checkout did not reach the commit")
        intro.state["checkout"] = side
        intro.save()

    def write_env(self, raw):
        path = self.env_file()
        temporary = path.with_name(".env.pending-" + uuid.uuid4().hex)
        with open(temporary, "xb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        if os.name == "posix":
            os.chmod(temporary, 0o600)
            if self.owner:
                # The account that owns the checkout (and runs the daily backup) keeps reading its .env.
                os.chown(temporary, self.owner["uid"], self.owner["gid"])
        os.replace(temporary, path)

    def image_ids(self, image, user):
        """The account's numeric IDs inside the exact image (never a number assumed from a test). The helper container is
        named and labelled, so even a timed-out client cannot leave an unowned container behind."""
        out = []
        with bound_ops(self.repo, self.run):
            for flag in ("-u", "-g"):
                value = ops.temporary_run(["--network", "none", "--read-only", "--entrypoint", "id", image, flag, user], timeout=60)
                require(re.fullmatch(r"[0-9]{1,5}", value or "") is not None, "Image account IDs are unreadable")
                out.append(int(value))
        return tuple(out)

    def tablespace_observed(self):
        out = self.text(["docker", "exec", self.names["db"], "sh", "-c",
                         "stat -c '%u %g %a %F' " + TABLESPACE + " && ls -A " + TABLESPACE + " | wc -l"])
        first, count = out.splitlines()
        uid, gid, mode, kind = first.split(" ", 3)
        return {"path": TABLESPACE, "uid": int(uid), "gid": int(gid), "mode": mode, "type": kind, "entries": int(count)}

    def image_revision(self, side):
        """The API image's OCI revision carries the same API tree as the release commit (as the API-only preflight checks)."""
        image = json.loads(self.text(["docker", "image", "inspect", side["images"]["api"]]))[0]
        require(image.get("Id") == side["images"]["api"] and (image.get("Config") or {}).get("User") == "node", "API image identity differs")
        revision = ((image.get("Config") or {}).get("Labels") or {}).get("org.opencontainers.image.revision", "")
        require(SHA.fullmatch(revision or "") is not None, "API image has no commit revision")
        require(self.text(["git", "rev-parse", revision + ":api"]) == self.text(["git", "rev-parse", side["sha"] + ":api"]),
                "API image revision tree differs from the release commit")

    def storage(self, intro):
        raw = self.staged_env(intro)
        self.image_revision(intro.plan["release"])
        storage = intro.plan["storage"]
        require(self.image_ids(intro.plan["release"]["images"]["db"], "postgres") == (storage["postgres_uid"], storage["postgres_gid"]),
                "The DB image's postgres account differs from the plan")
        require(self.image_ids(intro.plan["release"]["images"]["api"], "node") == (storage["node_uid"], storage["node_gid"]),
                "The API image's node account differs from the plan")
        pg_before = self.volume_identity(self.t["volumes"]["pg"])
        self.checkout(intro, "target")
        intro.state["env_written"] = True
        intro.save()
        self.write_env(raw)
        require(self.compose_digest_now() == intro.plan["compose"]["after_sha256"], "Target compose files or .env differ from the plan")
        check_resolved(self.resolved(intro), self.t, target_checkout=True)
        intro.state["db_recreated"] = True
        intro.save()
        self.compose(["up", "-d", "--no-deps", "--no-build", "--pull", "never", "--force-recreate", "db"], override=self.pins(intro), timeout=180)
        self.wait(lambda: self.healthy("db"), 120, "Database did not become healthy")
        db = self.inspect("db")
        mounts = {m.get("Destination"): m.get("Name") for m in db.get("Mounts") or []}
        require(mounts.get("/var/lib/postgresql/data") == self.t["volumes"]["pg"]
                and mounts.get("/var/lib/postgresql/emr-access") == self.t["volumes"]["emr_access"], "Database mounts differ")
        require(self.volume_identity(self.t["volumes"]["pg"]) == pg_before, "The database volume was replaced")
        observed = self.tablespace_observed()
        pre.check_tablespace_directory(observed, storage, fresh=True)
        return {"tablespace": observed, "pg_volume": pg_before, "env_names": sorted(parse_env(raw))}

    def volume_identity(self, name):
        result = self.cmd(["docker", "volume", "inspect", name], check=False)
        require(result.returncode == 0, "Volume missing: " + name)
        item = json.loads(result.stdout)[0]
        return {"name": item["Name"], "created": item.get("CreatedAt")}

    def provision(self, intro):
        # Provision-first (DR2-09): this database must still be the previous release's, without any EMR object or EMR
        # migration. emr-compose's PROVISION_SQL cannot repair a database migrated before it was provisioned.
        pre.check_provision_first(ops.role_catalog(self.names["db"]), ops.migration_rows(self.names["db"]), intro.plan)
        out = self.one_shot(intro, "emr-provision", [], timeout=300, name="emr-provision")
        require(out["exit"] == 0 and out["container_exit"] == 0, "emr-provision failed")
        catalog = ops.role_catalog(self.names["db"])
        logins = {"kin_emr_owner": False, "kin_runtime": True, **intro.plan["secrets"]["logins"]}
        pre.check_provisioned(catalog, intro.plan["storage"], logins)
        return {"exit": out["exit"], "logs": out["logs"], "roles": sorted(role["rolname"] for role in catalog["roles"])}

    IMPORT_BOOKKEEPING = ("updatedAt",)

    def preserved(self, intro):
        """After the migration: every pre-existing table keeps every value of its B0 columns. Then, with that proven, the
        same rows without the member import's bookkeeping column become the import's reference: the import's intended
        designation/session binding writes rows through Prisma, which also moves their @updatedAt, and nothing else."""
        b0 = Path(intro.state["b0"]["dir"])
        before = json.loads((b0 / "projection.json").read_text(encoding="utf-8"))
        exempt = {"_prisma_migrations", *intro.plan["projection_exempt"]}
        before = {name: value for name, value in before.items() if name not in exempt}
        after = ops.projection(self.names["db"], columns={name: value["columns"] for name, value in before.items()})
        pre.check_projection_preserved(before, after)
        reduced = {name: [column for column in value["columns"] if column not in self.IMPORT_BOOKKEEPING] for name, value in before.items()}
        reference = ops.projection(self.names["db"], columns={name: columns for name, columns in reduced.items() if columns})
        intro.state["import_reference_sha256"] = intro.records.put("projection-before-import.json", reference)
        intro.save()
        return {"tables": len(before)}

    def preserved_after_import(self, intro):
        path = intro.records.directory / "projection-before-import.json"
        raw = intro.records.read(path)
        require(sha256_bytes(raw) == intro.state.get("import_reference_sha256"), "Import reference projection changed")
        reference = json.loads(raw)
        after = ops.projection(self.names["db"], columns={name: value["columns"] for name, value in reference.items()})
        pre.check_projection_preserved(reference, after)
        return {"tables": len(reference), "ignored_columns": list(self.IMPORT_BOOKKEEPING)}

    def migrate(self, intro):
        timeout = max(60, min(3600, int(intro.deadline_left())))
        out = self.one_shot(intro, "api-migrate", [], timeout=timeout, name="api-migrate")
        require(out["exit"] == 0 and out["container_exit"] == 0, "Installer migration failed")
        rows = ops.migration_rows(self.names["db"])
        pre.check_migration_rows(rows, intro.plan["migrations"]["after"])
        pre.check_emr_catalog(ops.emr_catalog(self.names["db"], "kin"))
        placement = json.loads(self.psql(PLACEMENT_SQL))
        pre.check_placement(placement)
        return {"exit": out["exit"], "logs": out["logs"], "migrations": len(rows), "placement": len(placement),
                "preserved": self.preserved(intro)}

    def serverinfo(self, intro):
        env = parse_env(self.env_file().read_bytes())
        secret = {"KIN_KC_ADMIN_USER": self.t["keycloak_admin"], "KIN_KC_ADMIN_PASSWORD": env.get("KC_ADMIN_PASSWORD", "")}
        return self.helper(intro, SERVERINFO_SCRIPT, env=secret, name="kc-serverinfo")

    def keycloak(self, intro):
        self.compose(["up", "-d", "--no-deps", "--no-build", "--pull", "never", "--force-recreate", "keycloak"], override=self.pins(intro), timeout=180)
        item = self.inspect("keycloak")
        require(item["Image"] == intro.plan["release"]["images"]["keycloak"], "Keycloak image differs")
        require("--spi-user-sessions--infinispan--use-caches=false" in " ".join(item["Config"].get("Cmd") or []), "Keycloak command lacks the cache option")
        selected = self.keycloak_selected(intro)
        pre.check_keycloak_serverinfo(selected)
        return selected

    def member_import(self, intro):
        roster = self.helper(intro, ROSTER_SCRIPT, name="kc-roster")["users"]
        # The roster the product reads must be the realm the plan observed: the same members, the same disabled ones.
        counted = self.realm_members()
        pre.check_member_counts(counted, intro.plan["members"])
        pre.check_member_counts({"realm_members": len(roster), "disabled": sum(1 for user in roster if not user["enabled"]),
                                 "service_accounts": counted["service_accounts"]}, intro.plan["members"])
        out = self.one_shot(intro, "api", ["prisma/import-member-rights.cjs"], timeout=600, entrypoint="node", name="member-import")
        require(out["exit"] == 0 and b"Member rights import completed" in out["stdout"], "Member rights import failed")
        retried = False
        rights = self.helper(intro, RIGHTS_SCRIPT, name="rights")
        if any(change["state"] != "done" for change in rights["legacy"]):
            # The reviewed explicit recovery of the CLI, once; still unconfirmed is a STOP, never a pass.
            retry = self.one_shot(intro, "api", ["prisma/import-member-rights.cjs", "--retry-roster"], timeout=600,
                                  entrypoint="node", name="member-retry")
            retried = {"exit": retry["exit"], "logs": retry["logs"]}
            rights = self.helper(intro, RIGHTS_SCRIPT, name="rights")
        after = self.helper(intro, ROSTER_SCRIPT, name="kc-roster")["users"]
        state = "ready" if rights["markers"] == ["realm-v1"] else "pending"
        pre.check_member_import({"markers": rights["markers"], "state": state, "roster_before": roster, "rights": rights["rights"],
                                 "legacy_enable": rights["legacy"], "roster_after": after})
        return {"members": len(roster), "legacy_enable": len(rights["legacy"]), "retried": retried,
                "logs": out["logs"], "preserved": self.preserved_after_import(intro)}

    def api(self, intro):
        self.compose(["up", "--no-deps", "--no-build", "--pull", "never", "--force-recreate", "--no-start", "api"],
                     override=self.pins(intro), timeout=180)
        token = uuid.uuid4().hex[:12]
        out = self.cmd(["docker", "run", "--rm", "--network", "none", "--name", self.t["project"] + "-state-check-" + token,
                        "--label", "kin.ops.run=" + token, "--mount", "type=volume,source=" + self.t["volumes"]["emr_state"] + ",target=" + ops.EMR_STATE,
                        "--entrypoint", "node", intro.plan["release"]["images"]["api"], "-e", STATE_VOLUME_SCRIPT], timeout=60)
        observed = result_line(out.stdout)
        pre.check_state_volume(observed, intro.plan["storage"])
        self.cmd(["docker", "start", self.names["api"]], timeout=60, mutating=True)
        self.api_health(member_rights=True)
        pre.check_introduced_api(self.inspect("api"), name=self.names["api"], image=intro.plan["release"]["images"]["api"],
                                 release=intro.plan["release"]["sha"], working_dir=str(self.repo), state_volume=self.t["volumes"]["emr_state"])
        return {"state_volume": observed}

    def served(self, intro):
        out = self.text(["docker", "exec", self.names["orthanc"], "python3", "-c", SERVED_SCRIPT], timeout=120)
        observed = json.loads(out.split("KIN_RESULT ", 1)[1])
        sha = intro.plan["release"]["sha"]
        expected = {"ohif.js": self.git_blob_sha256(sha, "config/ohif.js"), "orthanc.json": self.git_blob_sha256(sha, "config/orthanc.json"),
                    "worklist-v0": self.git_tree_sha256(sha, "worklist-v0")}
        if observed != expected:
            tree_seen, tree_wanted = observed.get("worklist-v0") or {}, expected["worklist-v0"]
            differing = sorted({name for name in set(tree_seen) | set(tree_wanted) if tree_seen.get(name) != tree_wanted.get(name)}
                               | {name for name in ("ohif.js", "orthanc.json") if observed.get(name) != expected[name]})
            self.records.log("served-differences.json", json.dumps(differing[:500]).encode())
        pre.check_served_bytes(observed, expected)
        return {"files": len(observed["worklist-v0"]) + 2}

    def proxy_observed(self, intro):
        item = self.inspect("proxy")
        test = self.cmd(["docker", "exec", self.names["proxy"], "nginx", "-t"], timeout=30, check=False)
        cert = self.cmd(["docker", "exec", self.names["proxy"], "openssl", "x509", "-noout", "-checkend", "604800",
                         "-in", self.t["tls_certificate"]], timeout=30, check=False)
        return {"image": item["Image"] if item else None, "running": bool(item and item["State"]["Running"]),
                "nginx_test": test.returncode, "certificate_valid_days": cert.returncode == 0}

    def proxy_ui(self, intro):
        orthanc_before = self.volume_identity(self.t["volumes"]["orthanc"])
        self.compose(["up", "-d", "--no-deps", "--no-build", "--pull", "never", "--force-recreate", "orthanc"], override=self.pins(intro), timeout=180)
        self.wait(lambda: bool(self.inspect("orthanc")["State"]["Running"]), 60, "Orthanc did not start")
        require(self.volume_identity(self.t["volumes"]["orthanc"]) == orthanc_before, "The Orthanc volume was replaced")
        served = self.served(intro)
        self.compose(["up", "-d", "--no-deps", "--no-build", "--pull", "never", "--force-recreate", "proxy"], override=self.pins(intro), timeout=180)
        self.wait(lambda: self.proxy_observed(intro)["running"], 60, "Proxy did not start")
        observed = self.proxy_observed(intro)
        pre.check_proxy(observed, intro.plan["release"]["images"]["proxy"])
        return {"served": served, "proxy": observed}

    # ── a settled failure before the first database change ──
    def revert_configuration(self, intro):
        """Undo only what this attempt changed before any database object: checkout, .env, the recreated DB container."""
        b0 = Path(intro.state["b0"]["dir"])
        reverted = []
        if intro.state["checkout"] != "previous":
            self.checkout(intro, "previous")
            reverted.append("checkout")
        if intro.state.pop("env_written", False):
            self.write_env((b0 / ".env").read_bytes())
            reverted.append("env")
        require(self.compose_digest_now() == intro.plan["compose"]["before_sha256"], "Previous configuration was not restored")
        if intro.state.pop("db_recreated", False):
            self.compose(["up", "-d", "--no-deps", "--no-build", "--pull", "never", "--force-recreate", "db"], override=self.pins(intro), timeout=180)
            self.wait(lambda: self.healthy("db"), 120, "Database did not become healthy")
            reverted.append("db")
        intro.save()
        catalog = ops.role_catalog(self.names["db"])
        require(not {role["rolname"] for role in catalog["roles"]} & set(pre.EMR_ROLES), "EMR roles exist after a revert")
        return {"reverted": reverted}

    # ── verify ──
    def token(self):
        require(self.token_reader is not None, "No smoke token configured")
        return token_valid(self.token_reader())

    def fenced_smoke(self, intro):
        result = smoke(self.t["origin"], connect=self.maintenance(), ca_file=self.t["ca_file"], token=self.token(),
                       frame=intro.plan["smoke"]["frame"])
        check_resolved(self.resolved(intro), self.t, target_checkout=True)
        return result

    def probe(self, intro):
        import ops_emr_probe as probe
        result = probe.run(self, intro)
        intro.state["probe"] = {"event_id": result["event_id"], "receipt": result["receipt"], "evidence_sha256": result["evidence_sha256"]}
        intro.save()
        return intro.state["probe"]

    def capture_b1(self, intro):
        self.stop_writers()
        self.freeze(intro)
        intro.state["b1"] = self.capture(intro, "post", "emr-b1")
        intro.save()
        intro.state["b1"]["restore_check"] = self.restore_check(intro.state["b1"]["dir"])
        intro.save()
        return intro.state["b1"]

    def resume(self, intro):
        self.start_roles(WRITERS)
        self.api_health(member_rights=True)
        self.reload_proxy()
        return {"resumed": list(RESUME_ORDER)}

    # ── reopen ──
    def final_allowlist(self, intro):
        images = {}
        for role in ROLES:
            item = self.inspect(role)
            require(item and item["State"]["Running"], "A service is not running: " + role)
            images[role] = item["Image"]
        require(images == intro.plan["release"]["images"], "Running images differ from the release")
        api = self.inspect("api")
        pre.check_introduced_api(api, name=self.names["api"], image=intro.plan["release"]["images"]["api"], release=intro.plan["release"]["sha"],
                                 working_dir=str(self.repo), state_volume=self.t["volumes"]["emr_state"])
        model = self.resolved(intro)
        image = json.loads(self.text(["docker", "image", "inspect", intro.plan["release"]["images"]["api"]]))[0]
        image_names = {item.split("=", 1)[0] for item in (image.get("Config") or {}).get("Env") or []}
        names = {item.split("=", 1)[0] for item in api["Config"].get("Env") or []}
        require(names - image_names == set(model["api_environment"]) - image_names, "API environment names differ from the release")
        pre.check_migration_rows(ops.migration_rows(self.names["db"]), intro.plan["migrations"]["after"])
        # Retention stays OFF: its role (and the reader) keep the planned login state; nothing was granted since L-06b.
        logins = {"kin_emr_owner": False, "kin_runtime": True, **intro.plan["secrets"]["logins"]}
        pre.check_provisioned(ops.role_catalog(self.names["db"]), intro.plan["storage"], logins)
        pre.check_keycloak_serverinfo(self.keycloak_selected(intro))
        require(not self.one_shots_alive(intro), "A one-shot worker of this release exists")
        return {"images": images, "api_environment": sorted(names - image_names), "backup": self.backup_readiness(intro)}

    def backup_readiness(self, intro):
        """The daily backup of the introduced release seals each set into the backup root's audit ledger
        (ops_audit_integrity); without a readable ledger every daily backup would end in backup_error. That is a gate
        failure here, never a silent pass. The ledger is initialised once (G09) before the capture takes the lock."""
        import ops_audit_integrity as audit
        try:
            ledger = audit.read_ledger(Path(intro.plan["backup_root"]))
        except Exception as error:
            raise Stop("The backup root has no readable audit ledger (" + type(error).__name__ + ")") from None
        return {"audit_ledger": "readable", "seals": sum(1 for entry in ledger["entries"] if entry["kind"] == "seal")}

    def keycloak_selected(self, intro):
        """serverinfo once Keycloak answers (it may still be starting after a resume)."""
        selected = {}

        def ready():
            selected.update(self.serverinfo(intro))
            return True
        self.wait(ready, 240, "Keycloak administration did not answer")
        return selected

    def restore_jobs(self, intro):
        return self.restore_cron(intro)

    def reopen_ingress(self, intro):
        self.compose(["up", "-d", "--no-deps", "--no-build", "--pull", "never", "--force-recreate", "proxy"],
                     override=self.pins(intro, maintenance=False), timeout=180)
        self.wait(lambda: self.proxy_observed(intro)["running"], 60, "Proxy did not start")
        observed = self.proxy_observed(intro)
        pre.check_proxy(observed, intro.plan["release"]["images"]["proxy"])
        model = self.resolved_public(intro)
        require(sorted(model) == sorted(self.t["ports"]["public"]), "Public ports differ from the target manifest")
        for directory in (intro.state["b0"]["dir"], intro.state["b1"]["dir"]):
            self.hold(directory, intro.plan_sha256, False)
        return {"proxy": observed, "ports": model}

    def resolved_public(self, intro):
        item = self.inspect("proxy")
        bindings = (item.get("HostConfig") or {}).get("PortBindings") or {}
        out = []
        for port, values in bindings.items():
            for value in values or []:
                host = value.get("HostIp") or ""
                out.append((host + ":" if host and host not in ("0.0.0.0", "::") else "") + value.get("HostPort") + ":" + port.split("/")[0])
        return out

    def public_smoke(self, intro):
        return smoke(self.t["origin"], ca_file=self.t["ca_file"], token=self.token(), frame=intro.plan["smoke"]["frame"])

    # ── rollback ──
    def classify(self, intro):
        alive = self.one_shots_alive(intro)
        require(not alive, "A one-shot worker may still be alive; observe only")
        self.stop_writers()
        observed = self.freeze_without_cron(intro)
        return {"workers": "quiet", "freeze": observed}

    def freeze_without_cron(self, intro):
        running = self.running()
        observed = {"running": running, "db_clients": self.db_clients(), "cron": "fenced" if self.t["cron"] else "not-managed",
                    "one_shots": self.one_shots_alive(intro)}
        pre.check_write_freeze(observed)
        return observed

    def preserve_failed(self, intro):
        """Bfail: the failed database (with whatever EMR state exists) and the identities of every volume this attempt
        touched. Nothing is deleted or reused."""
        state_volume = self.t["volumes"]["emr_state"]
        has_state = self.cmd(["docker", "volume", "inspect", state_volume], check=False).returncode == 0
        directory = Path(intro.plan["backup_root"]) / ("emr-bfail-" + utc_now().strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8])
        directory.mkdir(mode=0o700, parents=False)
        components = {}
        for database in ("kin", "keycloak"):
            with open(directory / (database + ".dump"), "wb") as handle:
                self.cmd(["docker", "exec", self.names["db"], "pg_dump", "-U", "kin", "-d", database, "-Fc", "--create"],
                         output=handle, timeout=1800)
        with open(directory / "cluster-roles.sql", "wb") as handle:
            self.cmd(["docker", "exec", self.names["db"], "pg_dumpall", "-U", "kin", "--roles-only", "--no-role-passwords"], output=handle)
        with bound_ops(self.repo, self.run):
            (directory / "catalog.json").write_text(json.dumps(ops.role_catalog(self.names["db"]), sort_keys=True) + "\n", encoding="utf-8")
            (directory / "migrations.json").write_text(json.dumps(ops.migration_rows(self.names["db"])) + "\n", encoding="utf-8")
            if has_state:
                with open(directory / "emr-state.tgz", "wb") as handle:
                    ops.temporary_run(["--network", "none", "--read-only", "--mount", f"type=volume,source={state_volume},target=/source,readonly",
                                       "--entrypoint", "tar", intro.plan["release"]["images"]["db"], "-czf", "-", "-C", "/source", "."],
                                      timeout=1800, output=handle)
        identities = {key: self.volume_identity(name) for key, name in self.t["volumes"].items()
                      if self.cmd(["docker", "volume", "inspect", name], check=False).returncode == 0}
        for path in sorted(directory.iterdir()):
            if os.name == "posix":
                path.chmod(0o600)
            components[path.name] = ops.digest(path)
        manifest = {"format": 1, "kind": "failed-state", "plan_sha256": intro.plan_sha256, "created_utc": utc_now().isoformat(),
                    "sha256": components, "volumes": identities, "kept": "never deleted or reused by this mode"}
        (directory / "manifest.json").write_text(json.dumps(manifest, sort_keys=True, indent=1) + "\n", encoding="utf-8")
        if os.name == "posix":
            (directory / "manifest.json").chmod(0o600)
        intro.state["bfail"] = {"dir": str(directory), "manifest_sha256": ops.digest(directory / "manifest.json"), "volumes": identities}
        intro.save()
        return intro.state["bfail"]

    def restore_b0(self, intro):
        b0 = Path(intro.state["b0"]["dir"])
        with bound_ops(self.repo, self.run):
            _, manifest, _ = ops.validate_held(b0, intro.state["b0"]["manifest_sha256"])
        if intro.state["checkout"] != "previous":
            self.checkout(intro, "previous")
        self.write_env((b0 / ".env").read_bytes())
        require(self.compose_digest_now() == intro.plan["compose"]["before_sha256"], "Previous configuration was not restored")
        suffix = uuid.uuid4().hex[:8]
        recovery = {"pg": self.t["volumes"]["pg"] + "-recovery-" + suffix, "orthanc": self.t["volumes"]["orthanc"] + "-recovery-" + suffix}
        # Durable before creation: a failed restore still names exactly the volumes it made.
        intro.state["recovery"] = {**recovery, "override_sha256": None}
        intro.save()
        for name in recovery.values():
            self.cmd(["docker", "volume", "create", "--label", "kin.ops.recovery=" + intro.plan_sha256[:16], name], mutating=True)
        override = self.pins(intro, recovery=recovery)
        intro.state["recovery"]["override_sha256"] = intro.records.put("recovery-override.json", {"yaml": override})
        intro.save()
        self.compose(["up", "-d", "--no-deps", "--no-build", "--pull", "never", "--force-recreate", "db"], override=override, timeout=180)
        self.wait(lambda: self.healthy("db"), 180, "Recovery database did not become healthy")
        db = self.inspect("db")
        require({m.get("Destination"): m.get("Name") for m in db.get("Mounts") or []}.get("/var/lib/postgresql/data") == recovery["pg"],
                "Recovery database is not on its fresh volume")
        self.restore_dumps(b0)
        with open(b0 / "orthanc.tgz", "rb") as handle:
            self.cmd(["docker", "run", "--rm", "-i", "--network", "none", "--label", "kin.ops.recovery=" + intro.plan_sha256[:16],
                      "--mount", "type=volume,source=" + recovery["orthanc"] + ",target=/restore", "--entrypoint", "tar",
                      intro.plan["previous"]["images"]["db"], "-xzf", "-", "-C", "/restore"], stdin=handle, timeout=1800, mutating=True)
        checked = json.loads(self.text(["docker", "run", "--rm", "--network", "none", "--read-only", "--mount",
                                        "type=volume,source=" + recovery["orthanc"] + ",target=/restore,readonly", "--entrypoint", "python3",
                                        intro.plan["previous"]["images"]["orthanc"], "-c", ops.SQLITE_CHECK], timeout=600))
        require(checked.get("integrity") == "ok", "Restored Orthanc index failed")
        with bound_ops(self.repo, self.run):
            for database in ("kin", "keycloak"):
                require(ops.counts(self.names["db"], database, "kin") == manifest["counts"][database], "Restored row counts differ: " + database)
            pre.check_migration_rows(ops.migration_rows(self.names["db"]), intro.plan["migrations"]["before"])
            before = json.loads((b0 / "projection.json").read_text(encoding="utf-8"))
            pre.check_projection_preserved(before, ops.projection(self.names["db"], columns={k: v["columns"] for k, v in before.items()}))
            roles = {role["rolname"] for role in ops.role_catalog(self.names["db"])["roles"]}
            require(not roles & set(pre.EMR_ROLES), "EMR roles exist in the restored cluster")
        return {"recovery": recovery, "orthanc": checked}

    def restore_dumps(self, directory):
        """A pre-EMR snapshot into a freshly initialised cluster: kin into its empty database (created by the image's init
        as POSTGRES_DB), keycloak created by the dump. Owners and privileges are restored, never stripped."""
        source = json.loads((Path(directory) / "catalog.json").read_text(encoding="utf-8"))
        fresh = {role["rolname"] for role in ops.role_catalog(self.names["db"])["roles"]}
        require({role["rolname"] for role in source["roles"]} <= fresh, "The snapshot needs roles the fresh cluster lacks")
        require(self.psql("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public';") == "0"
                and self.psql("SELECT count(*) FROM pg_database WHERE datname='keycloak';") == "0", "The restore target is not a fresh cluster")
        for database, args in (("kin", ["-d", "kin"]), ("keycloak", ["-d", "postgres", "--create"])):
            with open(Path(directory) / (database + ".dump"), "rb") as handle:
                self.cmd(["docker", "exec", "-i", self.names["db"], "pg_restore", "-U", "kin", *args, "--exit-on-error"],
                         stdin=handle, timeout=1800, mutating=True)

    def previous_services(self, intro):
        override = self.pins(intro, recovery=intro.state["recovery"])
        for role in ("keycloak", "orthanc", "api", "proxy"):
            self.compose(["up", "-d", "--no-deps", "--no-build", "--pull", "never", "--force-recreate", role], override=override, timeout=240)
        self.api_health(member_rights=False)
        orthanc = self.inspect("orthanc")
        require({m.get("Destination"): m.get("Name") for m in orthanc.get("Mounts") or []}.get("/var/lib/orthanc/db")
                == intro.state["recovery"]["orthanc"], "Orthanc is not on its recovery volume")
        api = self.inspect("api")
        require(api["Image"] == intro.plan["previous"]["images"]["api"]
                and not any(m.get("Destination") == ops.EMR_STATE for m in api.get("Mounts") or []), "Previous API differs or holds EMR state")
        return {"images": {role: self.inspect(role)["Image"] for role in ROLES}}

    def verify_and_reopen(self, intro):
        fenced = smoke(self.t["origin"], connect=self.maintenance(), ca_file=self.t["ca_file"], member_rights=False)
        cron = self.restore_cron(intro)
        override = self.pins(intro, recovery=intro.state["recovery"], maintenance=False)
        self.compose(["up", "-d", "--no-deps", "--no-build", "--pull", "never", "--force-recreate", "proxy"], override=override, timeout=180)
        self.wait(lambda: self.proxy_observed(intro)["running"], 60, "Proxy did not start")
        public = smoke(self.t["origin"], ca_file=self.t["ca_file"], member_rights=False)
        return {"fenced": fenced, "public": public, "cron": cron, "recovery_override_sha256": intro.state["recovery"]["override_sha256"]}

    # ── rehearsal seed ──
    def seed_check(self, intro):
        seed = intro.plan["seed"]
        with bound_ops(self.repo, self.run):
            _, manifest, digest = ops.validate_held(seed["b0_dir"], seed["b0_manifest_sha256"])
        require(manifest["shape"] == "pre", "The seed is not a pre-EMR snapshot")
        source = parse_env((Path(seed["b0_dir"]) / ".env").read_bytes())
        clone = parse_env(self.env_file().read_bytes())
        shared = [name for name in CLONE_SECRETS if name in source and name in clone and source[name] == clone[name]]
        require(not shared, "The clone reuses a source secret")
        require(not any(self.inspect(role) for role in ROLES), "Clone containers already exist")
        require(not any(self.cmd(["docker", "volume", "inspect", name], check=False).returncode == 0 for name in self.t["volumes"].values()),
                "Clone volumes already exist")
        require(intro.state["checkout"] == "previous" and self.text(["git", "rev-parse", "HEAD"]) == intro.plan["previous"]["sha"],
                "Clone checkout is not the previous release")
        return {"source_manifest_sha256": digest, "secrets_isolated": True}

    def keycloak_isolation(self, intro, source_env, clone_env, source_origin):
        """The restored realm keeps every member/role/group row; only the clone's client secrets, origin and mail change."""
        realm = self.psql("SELECT id FROM realm WHERE name='kin';", "keycloak")
        require(realm and re.fullmatch(r"[0-9a-f-]{1,64}", realm), "Realm kin missing in the restored Keycloak")
        rows = self.psql("SELECT client_id || '|' || coalesce(secret, '') FROM client WHERE realm_id='" + realm + "' ORDER BY client_id;", "keycloak")
        updates, regenerated = [], []
        mapping = {source_env.get(name): clone_env.get(name) for name in ("KC_CLIENT_SECRET", "KC_WEB_SECRET") if source_env.get(name)}
        for line in rows.splitlines():
            client, secret = line.split("|", 1)
            if not secret:
                continue
            if secret in mapping:
                require(bool(mapping[secret]), "A client secret of the source has no clone replacement")
                updates.append((client, mapping[secret]))
            else:
                # A source credential nothing in the clone uses (e.g. a generated template secret): never kept.
                updates.append((client, token_source.token_urlsafe(32)))
                regenerated.append(client)
        tag = "kin" + uuid.uuid4().hex
        statements = ["BEGIN;"]
        for client, value in updates:
            statements.append(f"UPDATE client SET secret = ${tag}${value}${tag}$ WHERE realm_id = '{realm}' AND client_id = ${tag}${client}${tag}$;")
        clone_origin = self.t["origin"]
        for table in ("redirect_uris", "web_origins"):
            statements.append(f"UPDATE {table} SET value = replace(value, ${tag}${source_origin}${tag}$, ${tag}${clone_origin}${tag}$) "
                              f"WHERE client_id IN (SELECT id FROM client WHERE realm_id = '{realm}');")
        for column in ("root_url", "base_url", "management_url"):
            statements.append(f"UPDATE client SET {column} = replace({column}, ${tag}${source_origin}${tag}$, ${tag}${clone_origin}${tag}$) "
                              f"WHERE realm_id = '{realm}' AND {column} IS NOT NULL;")
        statements += [f"DELETE FROM realm_smtp_config WHERE realm_id = '{realm}';",
                       f"UPDATE identity_provider SET enabled = false WHERE realm_id = '{realm}';", "COMMIT;"]
        self.cmd(["docker", "exec", "-i", self.names["db"], "psql", "-X", "-U", "kin", "-d", "keycloak", "-v", "ON_ERROR_STOP=1", "-q"],
                 input="\n".join(statements).encode(), mutating=True, timeout=120, quiet=True)
        return {"client_secrets_replaced": [client for client, _ in updates], "client_secrets_regenerated": regenerated,
                "origin_rewritten": ["redirect_uris", "web_origins",
                "client.root_url", "client.base_url", "client.management_url"], "smtp": "removed", "identity_providers": "disabled"}

    def seed_restore(self, intro):
        seed = Path(intro.plan["seed"]["b0_dir"])
        with bound_ops(self.repo, self.run):
            _, manifest, _ = ops.validate_held(seed, intro.plan["seed"]["b0_manifest_sha256"])
        override = self.pins(intro)
        self.compose(["up", "-d", "--no-deps", "--no-build", "--pull", "never", "db"], override=override, timeout=180)
        self.wait(lambda: self.healthy("db"), 180, "Clone database did not become healthy")
        self.restore_dumps(seed)
        source_env, clone_env = parse_env((seed / ".env").read_bytes()), parse_env(self.env_file().read_bytes())
        isolation = self.keycloak_isolation(intro, source_env, clone_env, source_env.get("PUBLIC_ORIGIN", "https://pacs.koreaimagingnetwork.com"))
        # The restored master realm keeps the source administrator (whose password the clone must not know); the clone
        # gets its own administrator with the clone's KC_ADMIN_PASSWORD, through Keycloak's own recovery command.
        admin = self.one_shot(intro, "keycloak", ["bootstrap-admin", "user", "--username", self.t["keycloak_admin"],
                                                 "--password:env", "KC_BOOTSTRAP_ADMIN_PASSWORD", "--no-prompt"],
                              timeout=600, entrypoint="/opt/keycloak/bin/kc.sh", name="kc-bootstrap-admin")
        require(admin["exit"] == 0, "The clone Keycloak administrator could not be created")
        isolation["administrator"] = {"created": self.t["keycloak_admin"], "logs": admin["logs"]}
        self.compose(["up", "--no-deps", "--no-build", "--pull", "never", "--no-start", "orthanc"], override=override, timeout=180)
        with open(seed / "orthanc.tgz", "rb") as handle:
            self.cmd(["docker", "run", "--rm", "-i", "--network", "none", "--mount", "type=volume,source=" + self.t["volumes"]["orthanc"] + ",target=/restore",
                      "--entrypoint", "tar", intro.plan["previous"]["images"]["db"], "-xzf", "-", "-C", "/restore"], stdin=handle, timeout=1800, mutating=True)
        with bound_ops(self.repo, self.run):
            require(ops.counts(self.names["db"], "kin", "kin") == manifest["counts"]["kin"], "Seeded row counts differ")
            pre.check_migration_rows(ops.migration_rows(self.names["db"]), intro.plan["migrations"]["before"])
            before = json.loads((seed / "projection.json").read_text(encoding="utf-8"))
            pre.check_projection_preserved(before, ops.projection(self.names["db"], columns={k: v["columns"] for k, v in before.items()}))
        intro.state["seed"] = {"source_manifest_sha256": intro.plan["seed"]["b0_manifest_sha256"], "isolation": isolation}
        intro.save()
        return intro.state["seed"]

    def seed_services(self, intro):
        """The clone then runs like the production host before the release: previous images, public (loopback) ports."""
        override = self.pins(intro, maintenance=False)
        for role in ("keycloak", "orthanc", "api", "proxy"):
            self.compose(["up", "-d", "--no-deps", "--no-build", "--pull", "never", role], override=override, timeout=240)
        self.api_health(member_rights=False)
        self.wait(lambda: self.proxy_observed(intro)["running"], 60, "Proxy did not start")
        self.reload_proxy()
        return {"public": smoke(self.t["origin"], ca_file=self.t["ca_file"], member_rights=False)}

    def write_receipt(self, intro):
        receipt = make_receipt(intro)
        digest = intro.records.put("local-restore-receipt.json", receipt)
        intro.state["receipt"] = {"sha256": digest, "file": "local-restore-receipt.json"}
        intro.save()
        return intro.state["receipt"]


def tool_hashes(directory=None):
    directory = Path(directory or Path(__file__).resolve().parent)
    return {name: sha256_bytes((directory / name).read_bytes()) for name in TOOL_FILES}


def local_host_key(path="/etc/ssh/ssh_host_ed25519_key.pub"):
    """sha256 (hex) of the host's ed25519 public key blob: the same key OpenSSH's SHA256 fingerprint encodes."""
    fields = Path(path).read_text(encoding="ascii").split()
    require(len(fields) >= 2 and fields[0] == "ssh-ed25519", "Unreadable host key")
    return sha256_bytes(base64.b64decode(fields[1], validate=True))


# ── the protected entrypoint adapter ──

POLICY_KEYS = ("schema", "enabled", "repository", "state_dir", "production", "targets_allowed", "smoke", "repository_owner")
EMR_DIRS = ("emr-plans", "emr-targets", "emr-approvals", "emr-evidence", "emr-used", "emr-runs", "emr-staged")


def policy_valid(policy):
    _keys(policy, POLICY_KEYS, "policy")
    require(policy["schema"] == 1 and type(policy["schema"]) is int and type(policy["enabled"]) is bool, "Unsupported policy")
    for key in ("repository", "state_dir"):
        require(type(policy[key]) is str and policy[key].startswith("/") and "\x00" not in policy[key], "Invalid policy path")
    identity_valid(policy["production"])
    require(type(policy["targets_allowed"]) is list and policy["targets_allowed"] in (["production"], ["rehearsal"]), "Invalid targets")
    smoke_policy = _keys(policy["smoke"], ("token_file", "ca_file"), "policy smoke")
    require(type(smoke_policy["token_file"]) is str and smoke_policy["token_file"].startswith("/"), "Invalid token file")
    require(smoke_policy["ca_file"] is None or (type(smoke_policy["ca_file"]) is str and smoke_policy["ca_file"].startswith("/")), "Invalid CA file")
    # null: the C1 rule (a root-owned checkout). Otherwise the operating account that owns the production checkout
    # (e.g. /home/ubuntu/pacs-starter-kit); policy, state, approvals and evidence stay root-owned either way.
    owner = policy["repository_owner"]
    if owner is not None:
        _keys(owner, ("uid", "gid"), "repository owner")
        _int(owner["uid"], 1, 65535, "repository owner uid")
        _int(owner["gid"], 1, 65535, "repository owner gid")
    return policy


class HostRecords(Records):
    def __init__(self, directory, host):
        super().__init__(directory)
        self.host = host

    def write(self, path, raw, *, append=False):
        self.host.protected(path.parent, private=True, directory=True)
        if append:
            with open(path, "ab", opener=lambda name, flags: os.open(name, flags | os.O_NOFOLLOW, 0o600)) as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            self.host.sync_dir(path.parent)
            return
        temporary = path.with_name(".pending-" + uuid.uuid4().hex)
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        self.host.sync_dir(path.parent)

    def read(self, path):
        return self.host.read_secure(path, limit=16 * 1024 * 1024)


class IntroductionHost:
    """Installed with the C1 library; reached through /opt/kin-deploy/entry.py for requests of mode emr-introduction."""

    POLICY = "/etc/kin-deploy/emr-introduction.json"

    def __init__(self, policy_path=POLICY):
        import ops_deploy_host as host
        self.host = host
        self.policy = policy_valid(host.decode(host.read_secure(policy_path)))
        require(self.policy["enabled"] is True, "Introduction policy is disabled")
        self.owner = self.policy["repository_owner"]
        if self.owner is None:
            self.repository = host.protected(self.policy["repository"], private=True, directory=True)
            host.protected(self.repository / ".git", directory=True)
        else:
            self.repository = owned_private(self.policy["repository"], self.owner, private=True, directory=True)
            owned_private(self.repository / ".git", self.owner, directory=True)
        self.state = host.protected(self.policy["state_dir"], private=True, directory=True)
        for name in EMR_DIRS:
            host.protected(self.state / name, private=True, directory=True)

    def document(self, folder, digest, limit=262144):
        _str(digest, HASH, "document hash")
        raw = self.host.read_secure(self.state / folder / (digest + ".json"), limit)
        require(sha256_bytes(raw) == digest, "Document bytes differ from their name")
        return decode(raw)

    def execute(self, raw):
        host = self.host
        request = request_valid(raw)
        digest = sha256_bytes(raw)
        plan = plan_valid(self.document("emr-plans", request["plan_sha256"]))
        require(plan["target_kind"] in self.policy["targets_allowed"], "This host does not run that target kind")
        target = target_valid(self.document("emr-targets", plan["target_manifest_sha256"]))
        require(target["repository"] == str(self.repository), "Target repository is not the protected repository")
        approval = approval_valid(decode(host.read_secure(self.state / "emr-approvals" / (digest + ".json"))), digest,
                                  request["phase"], int(time.time()), plan["target_kind"])
        evidence = {kind: self.document("emr-evidence", value) for kind, value in approval["evidence"].items()}
        # One use: a replayed request with the same bytes can never run a phase twice.
        host.write_secure(self.state / "emr-used" / (digest + ".json"), {"request_sha256": digest, "consumed_at": int(time.time())},
                          exclusive=True)
        runs = self.state / "emr-runs" / request["plan_sha256"]
        if not runs.exists():
            runs.mkdir(mode=0o700)
        records = HostRecords(runs, host)
        runner = Runner(self.repository, fixed=True, base_env=host.ENV, owner=self.owner)
        token_file = self.policy["smoke"]["token_file"]
        staged = self.state / "emr-staged" / (plan["secrets"]["env_next_sha256"] + ".env")

        def secure(path):
            # The staged env is root's (state directory); the checkout's .env belongs to the checkout's owner.
            if self.owner is None or Path(path) == staged:
                return host.protected(path, private=True)
            return owned_private(path, self.owner, private=True)
        ops_host = HostOps(target=target, plan=plan, runner=runner, records=records, env_next=staged,
                           token_reader=lambda: host.decode(host.read_secure(token_file, 32768)), secure=secure, owner=self.owner)
        intro = Introduction(plan=plan, plan_sha256=request["plan_sha256"], target=target, production=self.policy["production"],
                             ops=ops_host, records=records, repository=self.repository, host_key=local_host_key(),
                             tool=tool_hashes(), evidence=evidence)
        with bound_ops(self.repository, runner):
            try:
                return intro.run(request, digest)
            except Stop as error:
                return {"mode": MODE, "phase": request["phase"], "status": "REJECTED", "phase_passed": False,
                        "request_sha256": digest, "code": code_of(error)}


# ── CLI helpers: no host change ──

EXAMPLE_POLICY = {"schema": 1, "enabled": False, "repository": "/srv/kin/repository", "state_dir": "/var/lib/kin-deploy",
                  "production": {"host_key_sha256": "0" * 64, "origin": "https://pacs.example.invalid", "project": "pacs-starter-kit",
                                 "containers": {"db": "kin-db", "api": "kin-api", "keycloak": "kin-keycloak", "orthanc": "kin-orthanc",
                                                "proxy": "kin-proxy", "emr-provision": "kin-emr-provision", "api-migrate": "kin-api-migrate"},
                                 "volumes": {"pg": "pacs-starter-kit_pg-db", "orthanc": "pacs-starter-kit_orthanc-db",
                                             "emr_access": "pacs-starter-kit_emr-access", "emr_state": "pacs-starter-kit_emr-state"},
                                 "networks": {"default": "pacs-starter-kit_default", "workflow": "kin-workflow"}},
                  "targets_allowed": ["production"], "smoke": {"token_file": "/etc/kin-deploy/smoke-token.json", "ca_file": None},
                  "repository_owner": None}


def example_target():
    production = EXAMPLE_POLICY["production"]
    return {"schema": 1, "kind": "production", **{key: production[key] for key in IDENTITY_KEYS},
            "repository": "/srv/kin/repository", "compose_files": ["docker-compose.yml", "docker-compose.prod.yml", "docker-compose.monitor.yml"],
            "ports": {"maintenance": "127.0.0.1:9444:443", "public": ["80:80", "443:443"]},
            "tls_certificate": "/etc/letsencrypt/live/pacs.example.invalid/fullchain.pem",
            "cron": {"user": "ubuntu", "tags": ["kin-pacs-reviewed-backup", "kin-pacs-reviewed-monitor"]}, "ca_file": None,
            "keycloak_admin": "admin"}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    example = sub.add_parser("example")
    example.add_argument("what", choices=["policy", "target"])
    check = sub.add_parser("check-plan")
    check.add_argument("plan", type=Path)
    check.add_argument("target", type=Path)
    prepare = sub.add_parser("prepare-env", help="Copy .env and add a generated KIN_EMR_RUNTIME_PASSWORD unless one exists")
    prepare.add_argument("--env", type=Path, required=True)
    prepare.add_argument("--out", type=Path, required=True)
    digest = sub.add_parser("compose-digest")
    digest.add_argument("--repository", type=Path, required=True)
    digest.add_argument("--sha", required=True)
    digest.add_argument("--env", type=Path, required=True)
    digest.add_argument("files", nargs="+")
    over = sub.add_parser("rehearsal-override")
    over.add_argument("target", type=Path)
    over.add_argument("--out", type=Path, required=True)
    receipt = sub.add_parser("verify-receipt")
    receipt.add_argument("receipt", type=Path)
    receipt.add_argument("plan", type=Path)
    receipt.add_argument("--b0-manifest-sha256", required=True)
    receipt.add_argument("--policy", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "example":
            print(json.dumps(EXAMPLE_POLICY if args.what == "policy" else example_target(), indent=1))
        elif args.command == "check-plan":
            plan_raw, target_raw = args.plan.read_bytes(), args.target.read_bytes()
            plan, target = plan_valid(decode(plan_raw)), target_valid(decode(target_raw))
            require(sha256_bytes(canonical(target)) == plan["target_manifest_sha256"], "Target manifest differs from the plan")
            print(json.dumps({"plan_sha256": sha256_bytes(plan_raw), "plan_core_sha256": plan_core(plan),
                              "target_manifest_sha256": sha256_bytes(canonical(target)), "valid": True}))
        elif args.command == "prepare-env":
            raw = args.env.read_bytes()
            values = parse_env(raw)
            if "KIN_EMR_RUNTIME_PASSWORD" not in values:
                # 43 URL-safe characters; generated here and written only to the private staged file, never printed.
                raw = raw.rstrip(b"\n") + b"\nKIN_EMR_RUNTIME_PASSWORD=" + token_source.token_urlsafe(32).encode() + b"\n"
            fd = os.open(args.out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as stream:
                stream.write(raw)
            print(json.dumps({"names": sorted(parse_env(raw)), "sha256": sha256_bytes(raw), "out": str(args.out)}))
        elif args.command == "compose-digest":
            entries = []
            for item in args.files:
                if PurePosixPath(item).is_absolute() or PureWindowsPath(item).is_absolute():
                    entries.append((item, Path(item).read_bytes()))
                else:
                    entries.append((item, subprocess.run(["git", "-C", str(args.repository), "cat-file", "blob", args.sha + ":" + item],
                                                         check=True, capture_output=True).stdout))
            entries.append((".env", args.env.read_bytes()))
            print(json.dumps({"sha256": compose_digest(entries)}))
        elif args.command == "rehearsal-override":
            target = target_valid(decode(args.target.read_bytes()))
            fd = os.open(args.out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
                stream.write(rehearsal_override(target, target["origin"]))
            print(json.dumps({"out": str(args.out), "sha256": sha256_bytes(args.out.read_bytes())}))
        else:
            plan = plan_valid(decode(args.plan.read_bytes()))
            policy = policy_valid(decode(args.policy.read_bytes()))
            receipt_valid(decode(args.receipt.read_bytes()), plan, args.b0_manifest_sha256, policy["production"])
            print(json.dumps({"valid": True}))
    except (Stop, OSError, ValueError, subprocess.CalledProcessError) as error:
        print(json.dumps({"valid": False, "error": code_of(error)}), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
