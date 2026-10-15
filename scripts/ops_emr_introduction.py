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
  rollback   RB-00..RB-03: refused while a one-shot worker may be alive; failed state preserved (Bfail); B0 restored
             into FRESH recovery volumes of a recovery Compose project that the checkout's .env then names (kin +
             keycloak at the same point with their roles, owners and privileges, Orthanc index + files together);
             previous images; failed volumes kept detached with their identifiers. Ends RESTORED, still fenced.
  rollback_reopen  RB-04: the ordinary compose resolution is the recovery mapping; the previous version's own login
             (made after the restore), worklist and frame bytes through the maintenance ingress; then jobs and ingress.
  seed       rehearsal targets only: a verified B0 copy restored into the disposable clone, with clone-only secrets.
  receipt    rehearsal targets only: the local-restore receipt (replaces the offsite-restore proof while the external
             backup stays OFF) that production's introduce requires, once, for the production plan it names.

A settled failure after the first database change rolls back automatically only when every one-shot worker of this
release has ended and the public ingress was never reopened; a timeout or any other unknown end retains the lock and
stops (NEEDS_ATTENTION) without rollback. One phase of a plan runs at a time (an OS lease the kernel frees with a dead
process); a phase that never recorded its end is classified NEEDS_ATTENTION, never re-run. Every step records the host
before and after it and every command it ran (commands-<phase>-<request>.jsonl). Secrets are read only into memory;
logs and records carry names, modes, hashes and exits, never values.

Host wiring is declared, never tolerated: declared_overlays (compose files outside the checkout, hash-pinned, with
their binds) and external_networks; tracked_overlay_reconcile (a modified tracked file goes back to the commit only
when its overlay renders byte-identically); compose variables the .env lacks resolve from the running stack;
fix_checkout_mode (recorded chmod before the capture). With the policy's smoke.browser_cmd the smoke runs unattended
(D1062): a temporary member, one real browser login, the eight checks as the executor's record, the member deleted
before any reopen.

CLI helpers (no host change): example, check-plan, prepare-env, compose-digest, rehearsal-override, verify-receipt;
browser-smoke (the reference headless browser: login spec on stdin, one KIN_RESULT line on stdout).
"""
from __future__ import annotations

import argparse
import base64
import errno
from contextlib import contextmanager, nullcontext, redirect_stdout
from contextvars import ContextVar
from datetime import datetime, timedelta, timezone
import hashlib
import http.client
import io
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import secrets as token_source
import shutil
import signal
import socket
import ssl
import stat as stat_module
import subprocess
import sys
import threading
import time
from urllib.parse import quote, urlsplit
import uuid

import ops_backup as ops
import ops_deploy_preflight as pre

MODE = "emr-introduction"
EMR_MIGRATION = "20261008120000_emr_b"
TABLESPACE = "/var/lib/postgresql/emr-access/ts"
ROLES = ("db", "api", "keycloak", "orthanc", "proxy")
ONE_SHOTS = ("emr-provision", "api-migrate")
WRITERS = pre.WRITERS
EMR_STATE_DIR = ops.EMR_STATE
FENCE_ORDER = ("proxy", "api", "keycloak", "orthanc")
RESUME_ORDER = ("orthanc", "keycloak", "api", "proxy")
VOLUMES = ("pg", "orthanc", "emr_access", "emr_state")
PHASES = ("capture", "release", "introduce", "verify", "reopen", "rollback", "rollback_reopen", "seed", "receipt")
RECEIPT_PHASES = ("seed", "capture", "introduce", "verify", "rollback", "rollback_reopen")
RECEIPT_MAX_AGE = timedelta(days=7)
CLOCK_SKEW = timedelta(minutes=5)
HASH, SHA, IMAGE = pre.HASH, pre.SHA, pre.IMAGE
NONCE = re.compile(r"[0-9a-f]{32}")
UUID4 = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}")
COMPOSE_NAME = re.compile(r"docker-compose(?:\.[a-z0-9-]+)?\.yml")
PROJECT = re.compile(r"[a-z0-9][a-z0-9_-]{0,62}")
TAG = re.compile(r"[a-z0-9][a-z0-9-]{0,62}")
FENCED = "#kin-emr-introduction-fenced# "
# The tracked monitor file and the one bind it brings (the proxy's read-only public folder, ${KIN_MONITOR_PUBLIC_DIR}).
MONITOR_FILE = "docker-compose.monitor.yml"
MONITOR_PUBLIC_TARGET = "/var/run/kin-monitor-public"
TOOL_FILES = ("ops_emr_introduction.py", "ops_emr_probe.py", "ops_backup.py", "ops_deploy_preflight.py", "ops_deploy_host.py",
              "ops_audit_integrity.py", "ops_deploy_entry.py", "ops_deploy_runner.py")
OPERATOR_SMOKE_CHECKS = ("login_pkce", "logout_old_session_refused", "worklist_uid", "ohif_frame", "w2_folders",
                         "w2_modality", "w2_shortcuts", "realm_v1_pending_zero")
# IRT-14 (D1062): the unattended smoke's temporary member and the checks it proves of the previous version after a restore
# (the previous release has no W2 features and no member-rights import; its old-token refusal is not asserted).
SMOKE_PREFIX = "kin-smoke-"
SMOKE_BY = "Opus executor (D1062)"
# The smoke client's registered redirect: a name that never resolves (RFC 2606 .invalid; the browser also maps it to
# NOTFOUND), so the authorization code is read from the browser's own request and never reaches any server or log.
SMOKE_REDIRECT_HOST = "kin-smoke-callback.invalid"
PREVIOUS_SMOKE_CHECKS = ("login_pkce", "worklist_uid", "ohif_frame")
# The headless browser's bounds: one login (D17: on its end the whole process tree goes), the pre-fence probe of L-01
# (D01) and the single retry of an unattended release smoke before an automatic rollback (D07).
BROWSER_TIMEOUT_S = 300
BROWSER_PROBE_S = 60
SMOKE_RETRY_S = 120
SMOKE_CLEANUP_S = 20
_smoke_budget = ContextVar("smoke_budget", default=None)
# D04: the values of compose variables the .env lacks, resolved once from the running stack, kept for the plan's later
# phases (a rollback whose source container is gone) in this private file of the run directory, never in a record.
COMPOSE_VALUES = "compose-env-values.json"
RECOVERY_PHASES = ("rollback", "rollback_reopen")
# D07: the one step a settled refusal of which is retried once (read-only, fenced): the release smoke.
RETRIED_ONCE = ("fenced_smoke",)
# The Stage-5 configuration names a clone must replace before it starts (rehearsal.md §2). Values are compared in memory.
CLONE_SECRETS = ("POSTGRES_PASSWORD", "KC_ADMIN_PASSWORD", "KC_CLIENT_SECRET", "KC_WEB_SECRET", "KIN_COOKIE_SECRET",
                 "ORTHANC_PASS", "KIN_EMR_RUNTIME_PASSWORD", "KIN_EMR_READER_PASSWORD", "KIN_EMR_RETENTION_PASSWORD")


class Stop(RuntimeError):
    """A settled refusal: the operation ended and the observed state is known."""


class Unknown(RuntimeError):
    """An operation whose end state is not known (timeout, lost client): never retried or rolled back automatically."""


class SmokeDeadline(Stop):
    """The attempt exhausted its work allowance; its cleanup reserve is still available."""


class SmokeRefusal(Stop):
    """A credential, ownership or policy refusal cannot improve with another login."""

    retryable = False


class BrowserTimeout(subprocess.TimeoutExpired):
    """The browser's deadline expired and its supervisor proved the entire invocation terminated."""


class SmokeBudget:
    """One monotonic attempt budget, including termination and secret cleanup (C-SMOKE)."""

    def __init__(self, seconds, *, phase_end=None, cleanup=SMOKE_CLEANUP_S):
        self.end = min(time.monotonic() + seconds, phase_end if phase_end is not None else float("inf"))
        self.work_end = self.end - cleanup
        self.cleaning = False

    def remaining(self, cap=None):
        left = (self.end if self.cleaning else self.work_end) - time.monotonic()
        if left <= 0:
            if self.cleaning:
                raise Unknown("smoke 정리·종료 확인의 공통 제한 시간이 지났습니다")
            raise SmokeDeadline("smoke 작업의 공통 제한 시간이 지났습니다")
        return min(left, cap) if cap is not None else left

    @contextmanager
    def cleanup(self):
        earlier = self.cleaning
        self.cleaning = True
        try:
            self.remaining()
            yield
        finally:
            self.cleaning = earlier


def bounded_timeout(cap):
    budget = _smoke_budget.get()
    return budget.remaining(cap) if budget else cap


def browser_timeout(milliseconds=30000):
    return max(1, int(bounded_timeout(milliseconds / 1000) * 1000))


@contextmanager
def smoke_attempt(seconds, phase_left=None):
    existing = _smoke_budget.get()
    if existing is not None:
        existing.remaining()
        yield existing
        return
    budget = SmokeBudget(seconds, phase_end=time.monotonic() + phase_left if phase_left is not None else None)
    budget.remaining()
    token = _smoke_budget.set(budget)
    try:
        yield budget
        budget.remaining()
    finally:
        _smoke_budget.reset(token)


def require_smoke(condition, message):
    if not condition:
        raise SmokeRefusal(message)


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
             "projection_exempt", "rehearsal_host")
FRAME_PATH = re.compile(r"/dicom-web/studies/([0-9.]{1,64})/series/[0-9.]{1,64}/instances/[0-9.]{1,64}/frames/[1-9][0-9]{0,7}")


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
    # Every target reads one real frame of a study that exists in B0: the forward smoke of the new release and the
    # previous-version smoke after a rollback (login, worklist UID, frame bytes) both bind to it.
    smoke = _keys(plan["smoke"], ("frame", "member"), "smoke")
    require(smoke["frame"] is not None, "A smoke reads a real frame")
    if smoke["member"] is not None:
        # IRT-14: the temporary member of the unattended smoke - realm roles (never admin or gateway) and the one group
        # (institution) that sees the smoke study.
        member = _keys(smoke["member"], ("roles", "group"), "smoke member")
        require(type(member["roles"]) is list and member["roles"] and len(set(member["roles"])) == len(member["roles"])
                and set(member["roles"]) <= set(pre.APP_ROLES) - {"admin"}, "Invalid smoke member roles")
        _str(member["group"], re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}"), "smoke member group")
    frame = _keys(smoke["frame"], ("path", "bytes", "sha256"), "smoke frame")
    require(type(frame["path"]) is str and FRAME_PATH.fullmatch(frame["path"]), "Invalid smoke frame path")
    _int(frame["bytes"], 1, 16 * 1024 * 1024, "smoke frame bytes")
    _str(frame["sha256"], HASH, "smoke frame hash")
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
        # The rehearsal names the production plan it rehearses (its identity, fixed before the production capture) and
        # the verified copy of that production attempt's B0; its receipt is only ever valid for exactly that pair.
        seed = _keys(plan["seed"], ("b0_dir", "b0_manifest_sha256", "production_plan_sha256"), "seed")
        _abs(seed["b0_dir"], "seed B0 directory")
        _str(seed["b0_manifest_sha256"], HASH, "seed B0 manifest hash")
        _str(seed["production_plan_sha256"], HASH, "rehearsed production plan")
        require(plan["rehearsal_host"] is None, "A rehearsal plan names no rehearsal host")
    else:
        require(plan["seed"] is None, "Only a rehearsal plan seeds from a B0 copy")
        # The one disposable host whose local-restore receipt production accepts (its ed25519 key fingerprint).
        _str(plan["rehearsal_host"], HASH, "rehearsal host key")
    exempt = plan["projection_exempt"]
    require(type(exempt) is list and all(type(name) is str and ops.RESOURCE_NAME.fullmatch(name) for name in exempt), "Invalid projection exemptions")
    return plan


def plan_core(plan):
    """What a rehearsal must have rehearsed: the same release, history, storage, secret roles and smoke frame (not host
    specifics)."""
    secrets = plan["secrets"]
    return sha256_bytes(canonical({"previous": plan["previous"], "release": plan["release"], "migrations": plan["migrations"],
                                   "storage": plan["storage"], "members": plan["members"], "probe_study": plan["probe"]["study"],
                                   "smoke_frame": plan["smoke"]["frame"],
                                   "secrets": {key: secrets[key] for key in ("required", "absent", "runtime", "installer", "logins")}}))


def plan_identity(plan):
    """The identity of one plan document (its canonical form): what a rehearsal names as the production plan it rehearses."""
    return sha256_bytes(canonical(plan))


def frame_study(plan):
    """The worklist UID the smoke expects: the study of the plan's smoke frame."""
    return FRAME_PATH.fullmatch(plan["smoke"]["frame"]["path"]).group(1)


TARGET_KEYS = ("schema", "kind", "host_key_sha256", "origin", "project", "repository", "compose_files", "containers",
               "volumes", "networks", "ports", "tls_certificate", "cron", "ca_file", "keycloak_admin", "external_networks",
               "declared_overlays", "tracked_overlay_reconcile", "fix_checkout_mode")
NETWORK_KEY = re.compile(r"[a-z][a-z0-9_]{0,31}")
IDENTITY_KEYS = ("host_key_sha256", "origin", "project", "containers", "volumes", "networks")


def origin_valid(value):
    parsed = urlsplit(value) if type(value) is str else None
    require(parsed is not None and parsed.scheme == "https" and parsed.hostname and not parsed.username
            and not parsed.password and parsed.path == "" and not parsed.query and not parsed.fragment
            and value == "https://" + parsed.netloc, "Invalid origin")
    return value


def target_valid(target, *, operational=False):
    """A target manifest names every resource this mode touches; no docker command uses a name from elsewhere."""
    _keys(target, TARGET_KEYS, "target manifest")
    require(target["schema"] == 1 and type(target["schema"]) is int and target["kind"] in ("production", "rehearsal"), "Unsupported target manifest")
    _str(target["host_key_sha256"], HASH, "host key fingerprint")
    origin_valid(target["origin"])
    _str(target["project"], PROJECT, "compose project")
    _abs(target["repository"], "repository")
    files = target["compose_files"]
    require(type(files) is list and files and len(files) == len(set(files)), "Invalid compose files")
    # IRT-11: a declared overlay is a compose file OUTSIDE the checkout (a file the checkout tracked at one commit only
    # would vanish or block the other commit's checkout), pinned by its hash, with the binds it brings for one service.
    repository = PurePosixPath(target["repository"].replace("\\", "/"))
    declared_overlays = target["declared_overlays"]
    require(type(declared_overlays) is list and len(declared_overlays) <= 8, "Invalid declared overlays")
    overlays = {}
    for entry in declared_overlays:
        _keys(entry, ("file", "sha256", "service", "binds"), "declared overlay")
        _abs(entry["file"], "declared overlay file")
        location = PurePosixPath(entry["file"].replace("\\", "/"))
        require(entry["file"] in files and location != repository and repository not in location.parents,
                "A declared overlay is listed and lives outside the checkout")
        _str(entry["sha256"], HASH, "declared overlay hash")
        require(entry["service"] in ROLES, "Invalid declared overlay service")
        require(type(entry["binds"]) is list and len(entry["binds"]) <= 8, "Invalid declared overlay binds")
        for bind in entry["binds"]:
            _keys(bind, ("source", "target", "read_only"), "declared bind")
            _abs(bind["source"], "declared bind source")
            require(type(bind["target"]) is str and PurePosixPath(bind["target"]).is_absolute() and type(bind["read_only"]) is bool,
                    "Invalid declared bind")
        overlays[entry["file"]] = entry
    require(len(overlays) == len(declared_overlays), "An overlay is declared once")
    # A tracked file that the host carries modified is replaced by the declared overlay that reproduces the change: the
    # overlay follows the file it reconciles, so Compose merges it at the same place.
    reconcile = target["tracked_overlay_reconcile"]
    require(type(reconcile) is list and len(reconcile) <= 8, "Invalid overlay reconciliation")
    used = []
    for entry in reconcile:
        _keys(entry, ("path", "expected_sha256_before", "override_file", "override_sha256"), "overlay reconciliation")
        require(type(entry["path"]) is str and entry["path"] == "docker-compose.prod.yml" and entry["path"] in files
                and entry["override_file"] in overlays and files.index(entry["override_file"]) > files.index(entry["path"]),
                "A declared overlay must follow the tracked compose file it reconciles (docker-compose.prod.yml)")
        _str(entry["expected_sha256_before"], HASH, "modified file hash")
        require(entry["override_sha256"] == overlays[entry["override_file"]]["sha256"], "Overlay hash differs from its declaration")
        used.append(entry["override_file"])
    require(len(set(used)) == len(used), "An overlay reconciles one file")
    for item in files:
        require(type(item) is str and (COMPOSE_NAME.fullmatch(item) or ((target["kind"] == "rehearsal" or item in overlays) and _abs(item, "override"))),
                "Invalid compose file")
    require(files[0] == "docker-compose.yml", "The base compose file comes first")
    # A rehearsal override replaces the proxy's volumes (`volumes: !override`); an overlay merged before it would lose
    # its binds, so every declared overlay comes after every other override file.
    others = [index for index, item in enumerate(files) if item not in overlays and not COMPOSE_NAME.fullmatch(item)]
    require(all(files.index(item) > max(others, default=-1) for item in overlays), "A declared overlay must come after the rehearsal override")
    if overlays:
        # D09: the overlays reproduce production's change of docker-compose.prod.yml, and Compose renders that change
        # byte-identically only when they are merged right where the file is (an overlay after the monitor file renders
        # another order of the proxy's mounts; the reconcile would refuse at L-00b). Production: docker-compose.prod.yml,
        # then the overlays. A rehearsal: docker-compose.prod.yml, its rehearsal override, then the overlays.
        require("docker-compose.prod.yml" in files, "A declared overlay needs docker-compose.prod.yml in the list")
        start = files.index("docker-compose.prod.yml") + 1
        if target["kind"] == "rehearsal":
            require(start < len(files) and files[start] not in overlays and not COMPOSE_NAME.fullmatch(files[start]),
                    "A declared overlay must come right after the rehearsal override that follows docker-compose.prod.yml")
            start += 1
        require(set(files[start:start + len(overlays)]) == set(overlays),
                "A declared overlay must come right after docker-compose.prod.yml (a rehearsal: after the rehearsal override that follows it)")
    require(type(target["fix_checkout_mode"]) is bool, "Invalid checkout mode flag")
    if operational:
        production = target["kind"] == "production"
        if production:
            halo = "/etc/kin-deploy/overlays/docker-compose.halo-reports.yml"
            require(set(overlays) == {halo}, "중간 릴리스에는 고정 Halo overlay 한 개가 필요합니다")
        else:
            # A separate rehearsal host declares its own Halo paths/network. Its protected plan binds those exact
            # identities; requiring production's paths here would reject the isolated stack's ordinary entry.
            require(len(overlays) == 1, "리허설에는 선언된 Halo overlay 한 개가 필요합니다")
            halo = next(iter(overlays))
            require(PurePosixPath(halo).name == "docker-compose.halo-reports.yml", "리허설 Halo overlay 선언이 다릅니다")
        expected = ["docker-compose.yml", "docker-compose.prod.yml"]
        if target["kind"] == "rehearsal":
            require(len(others) == 1 and others[0] == 2, "VM override는 prod 바로 다음 한 개여야 합니다")
            expected.append(files[2])
        expected.extend((halo, "docker-compose.monitor.yml"))
        require(files == expected, "중간 릴리스의 Compose 입력 목록 또는 순서가 다릅니다")
        binds = overlays[halo]["binds"]
        require(overlays[halo]["service"] == "proxy" and len(binds) == 1 and
                binds[0]["target"] == "/etc/nginx/conf.d/halo-report.conf" and binds[0]["read_only"] is True and
                (not production or binds[0]["source"] == "/srv/halo-reports/nginx/report.conf"),
                "Halo 보고서의 RO bind 선언이 다릅니다")
        halo_network = target["external_networks"].get("proxy", {}).get("halo_reports")
        require(type(halo_network) is str and bool(halo_network) and (not production or halo_network == "halo_reports_private"),
                "Halo 보고서의 외부 network 선언이 다릅니다")
    containers = _keys(target["containers"], (*ROLES, *ONE_SHOTS), "containers")
    volumes = _keys(target["volumes"], VOLUMES, "volumes")
    networks = _keys(target["networks"], ("default", "workflow"), "networks")
    for group in (containers, volumes, networks):
        for value in group.values():
            _str(value, NAME, "resource name")
    # Further networks a service joins on this host (e.g. the proxy and an external service's network), declared with
    # their exact names; nothing else may appear in the resolved model.
    external = target["external_networks"]
    require(type(external) is dict and set(external) <= set(ROLES), "Invalid external networks")
    declared = []
    for service, entries in external.items():
        require(type(entries) is dict and entries, "Invalid external networks")
        for key, name in entries.items():
            require(type(key) is str and NETWORK_KEY.fullmatch(key) and key not in ("default", "workflow"), "Invalid external network key")
            _str(name, NAME, "external network name")
            declared.append((key, name))
    require(len({key for key, _ in declared}) == len({pair for pair in declared}) == len({name for _, name in declared}),
            "An external network key names one network")
    names = [*containers.values(), *volumes.values(), *networks.values(), *sorted({name for _, name in declared})]
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


def check_resolved(model, target, *, target_checkout, maintenance=None, images=None, recovery=None):
    """The resolved Compose model (selected, secret-free fields) is exactly the manifest's target before anything uses it:
    project, container names, every named volume (and which service mounts which at which path), networks, published
    ports (proxy only on the planned ingress, any other service on loopback only), origin settings and, when the caller
    pins them, images. A rehearsal binds nothing outside its own checkout but its declared overlay binds and the monitor
    file's public folder (RT-P3-MONITOR-BIND). recovery: after a rollback the project and the pg/Orthanc volumes are the
    recovery ones."""
    project = recovery["project"] if recovery else target["project"]
    require(model["project"] == project, "Resolved compose project differs")
    expected = {role: target["containers"][role] for role in ROLES}
    if target_checkout:
        expected.update({name: target["containers"][name] for name in ONE_SHOTS})
    require(model["containers"] == expected, "Resolved container names differ from the target manifest")
    volumes = {"pg-db": recovery["pg"] if recovery else target["volumes"]["pg"],
               "orthanc-db": recovery["orthanc"] if recovery else target["volumes"]["orthanc"]}
    if target_checkout:
        volumes.update({"emr-access": target["volumes"]["emr_access"], "emr-state": target["volumes"]["emr_state"]})
    require(all(model["volumes"].get(key) == name for key, name in volumes.items()), "Resolved volume names differ")
    # Any other declared volume belongs to this project (or the original project's own certificate volume of a clone).
    prefixes = tuple({target["project"] + "_", project + "_"})
    require(all(name in volumes.values() or (type(name) is str and name.startswith(prefixes)) for name in model["volumes"].values()),
            "A resolved volume belongs to another project")
    networks = {"default": project + "_default" if recovery else target["networks"]["default"], "workflow": target["networks"]["workflow"]}
    declared = {}
    for entries in target["external_networks"].values():
        declared.update(entries)
    require(model["networks"] == {**networks, **declared}, "Resolved networks differ from the target manifest (an undeclared network?)")
    for role in expected:
        joined = set(model["service_networks"].get(role) or [])
        own = set(target["external_networks"].get(role, {}))
        require(joined <= {"default", "workflow"} | own and own <= joined, "Resolved service networks differ: " + role)
        if role == "proxy":
            require(joined == {"default", "workflow"} | own, "Resolved service networks differ: proxy")
    mounts = {"db": {"/var/lib/postgresql/data": "pg-db"}, "orthanc": {"/var/lib/orthanc/db": "orthanc-db"}}
    if target_checkout:
        mounts["db"]["/var/lib/postgresql/emr-access"] = "emr-access"
        mounts["api"] = {EMR_STATE_DIR: "emr-state"}
    # Drive-letter paths (a Windows rehearsal host) compare without regard to case, as that file system does.
    fold = (lambda text: text.lower()) if PureWindowsPath(target["repository"]).drive else (lambda text: text)
    path_of = lambda value: PurePosixPath(fold(str(value).replace("\\", "/")))
    declared_binds = {}
    for overlay in target["declared_overlays"]:
        for bind in overlay["binds"]:
            declared_binds.setdefault(overlay["service"], []).append((path_of(bind["source"]), bind["target"], bind["read_only"]))
    require(set(declared_binds) <= set(expected), "A declared overlay names a service outside the model")
    for role in expected:
        named = {entry["target"]: entry["source"] for entry in model["mounts"].get(role, []) if entry["type"] == "volume"}
        require(all(named.get(path) == key for path, key in mounts.get(role, {}).items()), "Resolved mounts differ: " + role)
        require(set(named.values()) <= set(model["volumes"]), "A resolved mount names an undeclared volume: " + role)
        binds = [(path_of(entry["source"]), entry["target"], bool(entry.get("read_only"))) for entry in model["mounts"].get(role, [])
                 if entry["type"] == "bind"]
        # IRT-11: a declared overlay is in effect exactly as declared (an overlay merged too early loses its binds).
        require(all(bind in binds for bind in declared_binds.get(role, [])), "A declared overlay bind is missing from the resolved model: " + role)
        if target["kind"] == "rehearsal":
            repository = path_of(target["repository"])
            # RT-P3-MONITOR-BIND: the tracked monitor file binds ${KIN_MONITOR_PUBLIC_DIR}, which production keeps outside
            # its checkout; a clone of that shape may bind it there too, but only as that file declares it (the proxy's
            # one read-only bind at the monitor target, with the file listed). Any other outside path stays refused.
            monitor = [bind for bind in binds if bind[1] == MONITOR_PUBLIC_TARGET] \
                if role == "proxy" and MONITOR_FILE in target["compose_files"] else []
            for bind in binds:
                require(bind[0] == repository or repository in bind[0].parents or bind in declared_binds.get(role, [])
                        or (monitor == [bind] and bind[2] is True),
                        "A rehearsal binds a host path outside its checkout: " + role)
    for role, ports in model["ports"].items():
        if role == "proxy":
            wanted = [target["ports"]["maintenance"]] if maintenance else list(target["ports"]["public"])
            require(sorted(ports) == sorted(wanted), "Resolved proxy ports differ from the planned ingress")
        else:
            require(all(port.startswith("127.0.0.1:") for port in ports), "A resolved service publishes a port beyond loopback: " + role)
    origin = target["origin"]
    # A clone must never carry the production origin; production's own PUBLIC_ORIGIN line is Phase P's observation (G04).
    require(model["origin"].get("api_KC_ISSUER") == origin + "/auth/realms/kin"
            and model["origin"].get("keycloak_KC_HOSTNAME") == origin + "/auth"
            and (target["kind"] == "production" or model["origin"].get("api_PUBLIC_ORIGIN") == origin),
            "Resolved origin settings differ from the target")
    if images is not None:
        require(all(model["images"].get(role) == images[role] for role in ROLES), "Resolved images differ from the plan")


ANONYMOUS_VOLUME = re.compile(r"[0-9a-f]{64}")


def host_bind_source(value, repository):
    """A bind source as the host names it. Docker Desktop (a Windows rehearsal host) reports a bind made through the
    mount API as /run/desktop/mnt/host/<drive>/<path>, which is <drive>:/<path> on that host (a folder bind given as a
    Windows path keeps that form). Linux hosts - production, the VM - are returned unchanged."""
    text = str(value)
    if PureWindowsPath(str(repository)).drive:
        desktop = re.fullmatch(r"/run/desktop/mnt/host/([A-Za-z])/(.*)", text.replace("\\", "/"))
        if desktop:
            return desktop.group(1).upper() + ":/" + desktop.group(2)
    return text


def tmpfs_options(raw):
    require(type(raw) is str, "tmpfs 옵션 형식이 잘못됐습니다")
    values = {}
    for option in raw.split(",") if raw else []:
        key, equals, value = option.partition("=")
        require(key and key not in values, "tmpfs 옵션이 중복됐습니다")
        if key == "size":
            match = re.fullmatch(r"([0-9]+)([kKmMgG]?)", value)
            require(match is not None, "tmpfs 크기를 해석할 수 없습니다")
            value = str(int(match[1]) * 1024 ** ("kmg".index(match[2].lower()) + 1 if match[2] else 0))
        elif key == "mode":
            require(re.fullmatch(r"[0-7]{3,4}", value), "tmpfs mode를 해석할 수 없습니다")
            value = str(int(value, 8))
        values[key] = value if equals else None
    return values


def declared_tmpfs(entries):
    require(type(entries) is list, "Compose tmpfs 선언이 목록이 아닙니다")
    result = {}
    for entry in entries:
        require(type(entry) is str, "Compose tmpfs 선언 형식이 잘못됐습니다")
        destination, _, options = entry.partition(":")
        require(destination.startswith("/") and destination not in result, "Compose tmpfs 목적지가 잘못됐습니다")
        result[destination] = tmpfs_options(options)
    return result


def check_running(inspections, model, target, image_volumes=None, *, roles=ROLES):
    """IRT2-02, L-01 before anything changes: every running container of the previous release is what the checked model
    says - its Compose project and service labels, every named volume and bind at its path (an image's own anonymous
    volumes aside), its networks and its published ports - not only its name and image. A container that runs on another
    project's volume, joins another network or publishes another port is refused before any fence."""
    windows = bool(PureWindowsPath(target["repository"]).drive)

    def path_of(value):
        # A rehearsal on Docker Desktop (Windows) compares host paths case-insensitively and in one form (see
        # host_bind_source); production and the VM are Linux paths, compared exactly.
        text = host_bind_source(value, target["repository"]).replace("\\", "/")
        return PurePosixPath(text.lower() if windows else text)
    named = set(model["volumes"].values())
    require(set(roles) <= set(ROLES) and set(inspections) == set(roles), "실제 컨테이너 관측 대상이 다릅니다")
    for role in roles:
        item = inspections[role]
        require(item.get("Image") == model["images"].get(role) and IMAGE.fullmatch(str(item.get("Image"))),
                "실제 컨테이너의 immutable image ID가 다릅니다: " + role)
        labels = (item.get("Config") or {}).get("Labels") or {}
        require(labels.get("com.docker.compose.project") == model["project"] and labels.get("com.docker.compose.service") == role,
                "A running service belongs to another Compose project or service: " + role)
        expected = {}
        for entry in model["mounts"].get(role, []):
            require(entry["target"] not in expected, "선언 mount 목적지가 중복됩니다: " + role)
            readonly = entry.get("read_only") is True
            require(not entry.get("consistency") or entry["consistency"] == "consistent", "지원하지 않는 mount consistency입니다")
            require(not entry.get("volume") or set(entry["volume"]) <= {"nocopy"} and entry["volume"].get("nocopy") is False,
                    "관측 계약이 없는 volume 옵션입니다")
            require(not entry.get("tmpfs"), "관측 계약이 없는 tmpfs 옵션입니다")
            require(not entry.get("bind") or set(entry["bind"]) <= {"propagation", "create_host_path", "selinux"}
                    and not entry["bind"].get("selinux"), "관측 계약이 없는 bind 옵션입니다")
            if entry["type"] == "volume":
                expected[entry["target"]] = ("volume", model["volumes"].get(entry["source"]), readonly)
            elif entry["type"] == "bind":
                expected[entry["target"]] = ("bind", path_of(entry["source"]), readonly)
            elif entry["type"] == "tmpfs":
                expected[entry["target"]] = ("tmpfs", None, readonly)
            else:
                raise Stop("지원하지 않는 mount 종류입니다: " + role)
        actual = {}
        for mount in item.get("Mounts") or []:
            destination = mount.get("Destination")
            require(type(destination) is str and destination not in actual and type(mount.get("RW")) is bool,
                    "실제 mount 관측이 불완전하거나 중복됩니다: " + role)
            readonly = not mount["RW"]
            if mount.get("Type") == "volume":
                if ANONYMOUS_VOLUME.fullmatch(str(mount.get("Name"))) and mount.get("Name") not in named:
                    approved = (image_volumes or {}).get(role, {})
                    require(destination not in expected and approved.get(destination) == {"read_only": readonly},
                            "고정 이미지에 선언되지 않은 익명 volume 또는 권한입니다: " + role)
                    expected[destination] = ("volume", mount["Name"], readonly)
                actual[destination] = ("volume", mount.get("Name"), readonly)
            elif mount.get("Type") == "bind":
                actual[destination] = ("bind", path_of(mount.get("Source")), readonly)
                declaration = next((m for m in model["mounts"].get(role, []) if m["target"] == destination), {})
                propagation = (declaration.get("bind") or {}).get("propagation")
                accepted = (propagation,) if propagation else ("rprivate", "rslave")
                require(mount.get("Propagation", "rprivate") in accepted, "bind propagation이 선언과 다릅니다: " + role)
            elif mount.get("Type") == "tmpfs":
                actual[destination] = ("tmpfs", None, readonly)
            else:
                raise Stop("실제 mount 종류를 허용할 수 없습니다: " + role)
        differing = sorted(str(key) for key in set(actual) | set(expected) if actual.get(key) != expected.get(key))
        require(not differing, "A running service's mounts differ from the checked model: " + role + " (" + ", ".join(differing) + ")")
        host_tmpfs = (item.get("HostConfig") or {}).get("Tmpfs") or {}
        require(type(host_tmpfs) is dict and all(type(key) is str for key in host_tmpfs), "실제 tmpfs 관측 형식이 잘못됐습니다")
        require({path: tmpfs_options(options) for path, options in host_tmpfs.items()} ==
                declared_tmpfs(model.get("tmpfs", {}).get(role, [])), "실제 tmpfs 목적지·옵션이 Compose 선언과 다릅니다: " + role)
        require(not set(host_tmpfs) & set(actual), "tmpfs와 mount 목적지가 중복됩니다: " + role)
        networks = set(((item.get("NetworkSettings") or {}).get("Networks") or {}))
        require(networks == {model["networks"][key] for key in model["service_networks"].get(role, ["default"])},
                "A running service's networks differ from the checked model: " + role)
        if "network_observations" in model:
            for name, endpoint in item["NetworkSettings"]["Networks"].items():
                network = model["network_observations"][name]
                peer = network["Containers"].get(item["Id"])
                require(endpoint.get("NetworkID") == network["Id"] and peer is not None
                        and endpoint.get("EndpointID") and endpoint["EndpointID"] == peer.get("EndpointID"),
                        "network 연결 대상 신원이 다릅니다: " + role)
        published = []
        for port, values in (((item.get("HostConfig") or {}).get("PortBindings")) or {}).items():
            for value in values or []:
                host = value.get("HostIp") or ""
                require(re.fullmatch(r"[0-9]+/(tcp|udp|sctp)", port) is not None, "게시 protocol 관측이 불완전합니다")
                published.append((host + ":" if host and host not in ("0.0.0.0", "::") else "") + str(value.get("HostPort")) + ":" + port)
        wanted_ports = [p if "/" in p else p + "/tcp" for p in model["ports"].get(role, [])]
        require(sorted(set(published)) == sorted(set(wanted_ports)), "A running service's published ports differ from the checked model: " + role)


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


def evidence_for(phase, kind, unattended=False):
    """Production's introduce needs the rehearsal's local-restore receipt (a rehearsal is that receipt's producer);
    every reopen needs the browser-level smoke record - the operator's, or, unattended (D1062), the one the verify phase
    itself wrote, which the plan's state holds."""
    if phase == "introduce" and kind == "production":
        return ("local-restore",)
    if phase == "reopen" and not unattended:
        return ("operator-smoke",)
    return ()


def approval_valid(approval, request_sha256, phase, now, kind="production", unattended=False):
    _keys(approval, ("schema", "mode", "request_sha256", "expires_at", "evidence"), "approval")
    require(approval["schema"] == 1 and approval["mode"] == MODE and approval["request_sha256"] == request_sha256, "Approval is not bound to this request")
    require(type(approval["expires_at"]) is int and now < approval["expires_at"] <= now + 86400, "Approval expired or too long")
    evidence = approval["evidence"]
    require(type(evidence) is dict and set(evidence) == set(evidence_for(phase, kind, unattended)), "Approval evidence differs from the phase")
    for value in evidence.values():
        _str(value, HASH, "evidence hash")
    return approval


RECEIPT_KEYS = ("schema", "kind", "passed", "receipt_id", "plan_core_sha256", "production_plan_sha256", "rehearsal_plan_sha256",
                "rehearsal_target_manifest_sha256", "source_b0_manifest_sha256", "rehearsal_b0_manifest_sha256",
                "rehearsal_b1_manifest_sha256", "bfail_manifest_sha256", "tool", "host_key_sha256", "phases", "evidence",
                "journal_sha256", "journal_bytes", "created_utc")


def receipt_sha256(receipt):
    return sha256_bytes(canonical(receipt))


def receipt_use_identity(receipt):
    return sha256_bytes(canonical({key: receipt[key] for key in
                                   ("rehearsal_plan_sha256", "source_b0_manifest_sha256", "journal_sha256")}))


def receipt_valid(receipt, plan, b0_manifest_sha256, production, *, now=None, b0_created_utc=None, used=(), bundle=None):
    """A local-restore receipt is the rehearsal's own run record, never an offsite claim. It is accepted only for the
    production plan it names, on the rehearsal host that plan allows, for this production attempt's B0, within its
    freshness window and once (used: the receipts this plan already admitted). Every rehearsal phase must carry its
    exact step list (all PASS), its request and its result file's hash; the artifacts it names (B0, B1 and its restore
    check, the probe, Bfail, the recovery volumes and the previous-version smoke over this plan's frame) must agree
    with each other. IRT2-01: and with the producer's own run - the bundle (its result files and journal, see
    bundle_valid) is required and checked here, so no receipt is admitted on its claims alone. Anything short of that is
    a refusal before any change."""
    _keys(receipt, RECEIPT_KEYS, "local-restore receipt")
    require(receipt["schema"] == 2 and receipt["kind"] == "local-restore" and receipt["passed"] is True, "Receipt is not a passed local restore")
    _str(receipt["receipt_id"], NONCE, "receipt ID")
    for key in ("plan_core_sha256", "production_plan_sha256", "rehearsal_plan_sha256", "rehearsal_target_manifest_sha256",
                "source_b0_manifest_sha256", "rehearsal_b0_manifest_sha256", "rehearsal_b1_manifest_sha256", "bfail_manifest_sha256",
                "host_key_sha256", "journal_sha256"):
        _str(receipt[key], HASH, "receipt hash")
    _int(receipt["journal_bytes"], 1, 2 ** 40, "receipt journal length")
    require(receipt["plan_core_sha256"] == plan_core(plan), "Receipt rehearsed another release")
    require(plan["target_kind"] == "production" and receipt["production_plan_sha256"] == plan_identity(plan),
            "Receipt was made for another production plan")
    require(receipt["source_b0_manifest_sha256"] == b0_manifest_sha256, "Receipt rehearsed another B0 snapshot")
    require(receipt["tool"] == plan["tool"], "Receipt was produced by another tool")
    require(receipt["host_key_sha256"] != production["host_key_sha256"], "Receipt was produced on the production host")
    require(receipt["host_key_sha256"] == plan["rehearsal_host"], "Receipt comes from a host the plan does not allow")
    created, now = parse_utc(receipt["created_utc"]), now or utc_now()
    # D12: created_utc is the rehearsal host's clock, now and the B0 time are production's; up to CLOCK_SKEW of difference
    # between the two clocks is tolerated in both directions (receipt_clock records what was observed).
    require(created <= now + CLOCK_SKEW, "Receipt is dated in the future")
    require(now - created <= RECEIPT_MAX_AGE, "Receipt is stale")
    if b0_created_utc is not None:
        require(created >= parse_utc(b0_created_utc) - CLOCK_SKEW, "Receipt predates the B0 snapshot it rehearsed")
    phases = receipt["phases"]
    require(type(phases) is dict and set(phases) == set(RECEIPT_PHASES), "Receipt phases incomplete")
    requests = []
    for phase in RECEIPT_PHASES:
        item = _keys(phases[phase], ("request_sha256", "result_sha256", "seconds", "steps"), "receipt phase")
        _str(item["request_sha256"], HASH, "receipt phase request")
        _str(item["result_sha256"], HASH, "receipt phase result")
        require(type(item["seconds"]) in (int, float) and item["seconds"] >= 0, "Invalid receipt phase duration")
        require(item["steps"] == [[sid, "PASS"] for sid, _, _, _ in STEPS[phase]], "Receipt phase did not pass every step: " + phase)
        requests.append(item["request_sha256"])
    require(len(set(requests)) == len(requests), "Receipt phases reuse one request")
    evidence = _keys(receipt["evidence"], ("seed", "capture", "verify", "rollback", "rollback_reopen"), "receipt evidence")
    require(evidence["seed"] == {"source_b0_manifest_sha256": receipt["source_b0_manifest_sha256"]}, "Receipt seed evidence differs")
    require(evidence["capture"] == {"b0_manifest_sha256": receipt["rehearsal_b0_manifest_sha256"], "restore_check": True},
            "Receipt B0 evidence differs")
    verify = _keys(evidence["verify"], ("b1_manifest_sha256", "b1_restore_check", "probe"), "receipt verify evidence")
    require(verify["b1_manifest_sha256"] == receipt["rehearsal_b1_manifest_sha256"] and verify["b1_restore_check"] is True,
            "Receipt B1 evidence differs")
    probe = _keys(verify["probe"], ("added", "replay_duplicates", "restart", "evidence_sha256"), "receipt probe evidence")
    require(probe["added"] == 1 and probe["replay_duplicates"] == 0 and probe["restart"] == "same chain and seal"
            and type(probe["evidence_sha256"]) is str and HASH.fullmatch(probe["evidence_sha256"]), "Receipt probe evidence differs")
    rollback = _keys(evidence["rollback"], ("bfail_manifest_sha256", "recovery"), "receipt rollback evidence")
    require(rollback["bfail_manifest_sha256"] == receipt["bfail_manifest_sha256"], "Receipt Bfail evidence differs")
    recovery = _keys(rollback["recovery"], ("project", "pg", "orthanc"), "receipt recovery")
    require(type(recovery["project"]) is str and PROJECT.fullmatch(recovery["project"]) and recovery["pg"] == recovery["project"] + "_pg-db"
            and recovery["orthanc"] == recovery["project"] + "_orthanc-db", "Receipt recovery volumes differ")
    reopened = _keys(evidence["rollback_reopen"], ("recovery_persisted", "smoke"), "receipt reopen evidence")
    frame = plan["smoke"]["frame"]
    require(reopened["recovery_persisted"] is True and reopened["smoke"] == {
        "member": True, "token_after_restore": True, "worklist_uid": frame_study(plan), "frame_sha256": frame["sha256"],
        "frame_bytes": frame["bytes"]}, "Receipt previous-version smoke differs from this plan's frame")
    require(not {receipt_sha256(receipt), receipt_use_identity(receipt)} & set(used), "Receipt was already used")
    require(bundle is not None, "A local-restore receipt is admitted only with its producer's run bundle")
    bundle_valid(receipt, bundle)
    return receipt


def receipt_clock(receipt, now, b0_created_utc=None):
    """The clock facts of an accepted receipt (D12): how far its creation lies ahead of production's clock (0 when it is
    not ahead) and how long after the B0 it rehearsed it was made (negative within the tolerated skew), in seconds."""
    created = parse_utc(receipt["created_utc"])
    facts = {"tolerance_s": int(CLOCK_SKEW.total_seconds()), "ahead_of_production_s": round(max(0.0, (created - now).total_seconds()), 3)}
    if b0_created_utc is not None:
        facts["after_b0_s"] = round((created - parse_utc(b0_created_utc)).total_seconds(), 3)
    return facts


class DirectoryBundle:
    """A rehearsal run's files (its result files and journal) read from a folder: the rehearsal's own run directory, or
    the copy an operator places for production (IntroductionHost reads it from its protected emr-bundles folder)."""

    def __init__(self, directory, reader=None):
        self.directory = Path(directory)
        self.reader = reader or (lambda path: path.read_bytes())

    def read(self, name):
        require(re.fullmatch(r"(?:result-[a-z_]+-[0-9a-f]{16}\.json|journal\.jsonl|plan\.json)", name) is not None, "Invalid bundle file name")
        try:
            return self.reader(self.directory / name)
        except (OSError, RuntimeError):
            raise Stop("The rehearsal bundle lacks " + name) from None


def _step(result, sid):
    found = [step for step in result.get("steps") or [] if type(step) is dict and step.get("step") == sid]
    require(len(found) == 1 and found[0].get("outcome") == "PASS" and type(found[0].get("detail")) is dict,
            "The rehearsal result has no passed step " + sid)
    return found[0]["detail"]


def bundle_valid(receipt, bundle):
    """IRT2-01: the receipt against its producer's run, the rehearsal's own records. Every phase's result file is the one
    the receipt hashed and records that phase of the rehearsal plan, under the receipt's request, ended in the phase's
    passing status with exactly the receipt's steps, all passed; the journal is the hashed one and holds each phase's
    start (with that request) and its passing end, in the phases' order, for that plan; and the artifacts the receipt
    claims are the ones the steps recorded - the seed's source B0, the rehearsal's B0 and its restore check, B1 and its
    restore check, the probe's evidence, Bfail, the recovery volumes, the persisted recovery and the previous-version
    smoke. A fixture or an adjusted claim, another request's or a failed run's results are refused."""
    if not hasattr(bundle, "read"):
        bundle = DirectoryBundle(bundle)
    rehearsal_plan = decode(bundle.read("plan.json"))
    require(plan_identity(rehearsal_plan) == receipt["rehearsal_plan_sha256"]
            and rehearsal_plan.get("target_manifest_sha256") == receipt["rehearsal_target_manifest_sha256"],
            "영수증의 rehearsal 계획 또는 target manifest가 producer bundle과 다릅니다")
    results = {}
    for phase in RECEIPT_PHASES:
        item = receipt["phases"][phase]
        raw = bundle.read("result-" + phase + "-" + item["request_sha256"][:16] + ".json")
        require(sha256_bytes(raw) == item["result_sha256"], "Rehearsal result file differs from the receipt: " + phase)
        result = decode(raw)
        require(type(result) is dict and result.get("phase") == phase and result.get("request_sha256") == item["request_sha256"]
                and result.get("status") == DONE[phase] and result.get("plan_sha256") == receipt["rehearsal_plan_sha256"],
                "Rehearsal result is not this rehearsal's passed phase: " + phase)
        require([[step.get("step"), step.get("outcome")] for step in result.get("steps") or []] == item["steps"],
                "Rehearsal result steps differ from the receipt: " + phase)
        results[phase] = result
    raw = bundle.read("journal.jsonl")
    prefix = raw[:receipt["journal_bytes"]]
    require(len(prefix) == receipt["journal_bytes"] and sha256_bytes(prefix) == receipt["journal_sha256"],
            "Rehearsal journal differs from the receipt")
    try:
        events = [json.loads(line) for line in prefix.decode("utf-8").splitlines() if line.strip()]
    except ValueError:
        raise Stop("Rehearsal journal is unreadable") from None
    position = 0
    for phase in RECEIPT_PHASES:
        request = receipt["phases"][phase]["request_sha256"]
        starts = [index for index, event in enumerate(events) if index >= position and event.get("event") == "phase-start"
                  and event.get("phase") == phase and event.get("request_sha256") == request
                  and event.get("plan_sha256") == receipt["rehearsal_plan_sha256"]]
        require(starts, "Rehearsal journal has no start of " + phase + " for its request")
        ends = [index for index, event in enumerate(events) if index > starts[0] and event.get("event") == "phase-end"
                and event.get("phase") == phase and event.get("status") == DONE[phase]
                and event.get("plan_sha256") == receipt["rehearsal_plan_sha256"]]
        require(ends, "Rehearsal journal has no passing end of " + phase)
        position = ends[0] + 1
    evidence = receipt["evidence"]
    require(_step(results["seed"], "S-01").get("source_manifest_sha256") == receipt["source_b0_manifest_sha256"],
            "The rehearsal seeded another B0")
    require(_step(results["capture"], "L-04b").get("manifest_sha256") == receipt["rehearsal_b0_manifest_sha256"]
            and _step(results["capture"], "L-04c").get("success") is True, "The rehearsal's B0 or its restore check differs from the receipt")
    b1 = _step(results["verify"], "L-10c")
    require(b1.get("manifest_sha256") == receipt["rehearsal_b1_manifest_sha256"] and (b1.get("restore_check") or {}).get("success") is True,
            "The rehearsal's B1 or its restore check differs from the receipt")
    probe = _step(results["verify"], "L-10b")
    require({key: probe.get(key) for key in ("added", "replay_duplicates", "restart", "evidence_sha256")} == evidence["verify"]["probe"],
            "The rehearsal's probe differs from the receipt")
    require(_step(results["rollback"], "RB-01").get("manifest_sha256") == receipt["bfail_manifest_sha256"], "The rehearsal's Bfail differs from the receipt")
    recovery = _step(results["rollback"], "RB-02").get("recovery") or {}
    require({key: recovery.get(key) for key in ("project", "pg", "orthanc")} == evidence["rollback"]["recovery"],
            "The rehearsal's recovery volumes differ from the receipt")
    require(_step(results["rollback_reopen"], "RB-04a").get("project") == evidence["rollback"]["recovery"]["project"],
            "The rehearsal's persisted recovery differs from the receipt")
    smoke_result = _step(results["rollback_reopen"], "RB-04b")
    require(all(smoke_result.get(key) is True for key in ("health", "auth_refusal", "member", "worklist", "frame")),
            "The rehearsal's previous-version smoke did not pass every check")
    return True


def operator_smoke_valid(record, plan_sha256):
    _keys(record, ("schema", "kind", "plan_sha256", "checks", "passed", "by", "at"), "operator smoke")
    require(record["schema"] == 1 and record["kind"] == "operator-smoke" and record["plan_sha256"] == plan_sha256, "Operator smoke is for another plan")
    require(type(record["checks"]) is dict and set(record["checks"]) == set(OPERATOR_SMOKE_CHECKS)
            and all(value is True for value in record["checks"].values()) and record["passed"] is True, "Operator smoke did not pass")
    parse_utc(record["at"])
    return record


# ── durable records: state, journal and step logs (private files) ──

def _lock_descriptor(descriptor):
    """An exclusive, non-blocking OS lock on an open file. The kernel releases it when the holding process ends, so a
    crashed phase never keeps it; a live one always does (also against another thread of the same process)."""
    if os.name == "posix":
        import fcntl
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    else:
        import msvcrt
        os.lseek(descriptor, 0, os.SEEK_SET)
        msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)


def _unlock_descriptor(descriptor):
    if os.name == "posix":
        import fcntl
        fcntl.flock(descriptor, fcntl.LOCK_UN)
    else:
        import msvcrt
        os.lseek(descriptor, 0, os.SEEK_SET)
        msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)


SECRET_NAME = re.compile(r"(?i)password|secret|token|passwd|credential")


def redact_argv(args):
    """A command's identity for the records: names stay, a NAME=value whose name says secret keeps only the name, and a
    long or multi-line argument (an inline script or SQL) is kept as its hash and length."""
    out = []
    for item in args:
        text = str(item)
        name = text.split("=", 1)[0] if "=" in text else None
        if name is not None and SECRET_NAME.search(name):
            out.append(name + "=<redacted>")
        elif len(text) > 200 or "\n" in text:
            out.append("<text sha256=%s bytes=%d>" % (sha256_bytes(text.encode("utf-8")), len(text.encode("utf-8"))))
        else:
            out.append(text)
    return out


def output_record(raw):
    return None if raw is None else {"sha256": sha256_bytes(raw), "bytes": len(raw)}


class Records:
    """Portable durable files under one private directory; the host binds write/read to ops_deploy_host's protections.
    Besides state, journal, step logs and phase results it keeps one command record per phase run
    (commands-<phase>-<request>.jsonl): every command with its redacted argv, environment names, input hash, start,
    duration, outcome (exit code, timeout or launch error) and the hashes of its outputs, tagged with its step."""

    def __init__(self, directory, secrets=None):
        self.directory = Path(directory)
        # IRT2-15: a run's working secrets (the smoke member's password, the browser profiles with its session cookies,
        # resolved compose values) live apart from its records, which are evidence: never in the run directory.
        self.secrets = Path(secrets) if secrets is not None else self.directory.with_name(self.directory.name + ".secrets")
        self.commands_file = None
        self.seq = 0
        self.context = {}

    def ensure(self, directory):
        Path(directory).mkdir(mode=0o700, parents=True, exist_ok=True)

    def secret(self, name):
        """The path of one working secret of this run (a plain name, directly in the secrets directory)."""
        require(type(name) is str and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", name) is not None, "Invalid secret name")
        self.ensure(self.secrets)
        return self.secrets / name

    def write_secret(self, name, raw):
        self.write(self.secret(name), raw)

    def read_secret(self, name):
        return self.read(self.secret(name))

    def open_lease(self, path):
        return os.open(str(path), os.O_RDWR | os.O_CREAT, 0o600)

    @contextmanager
    def lease(self):
        """One phase of this plan at a time (separate from the retained operations lock)."""
        self.ensure(self.directory)
        descriptor = self.open_lease(self.directory / "phase.lock")
        try:
            try:
                _lock_descriptor(descriptor)
            except OSError:
                raise Stop("Another phase of this plan is running") from None
            try:
                yield
            finally:
                _unlock_descriptor(descriptor)
        finally:
            os.close(descriptor)

    def begin(self, phase, request_sha256):
        self.commands_file = "commands-" + phase + "-" + request_sha256[:16] + ".jsonl"
        self.seq = 0
        self.context = {}

    def command(self, entry):
        """Durable before the caller acts on the outcome; returns the command's sequence number in this phase run."""
        if self.commands_file is None:
            return None
        self.seq += 1
        self.write(self.directory / self.commands_file, canonical({"seq": self.seq, **self.context, **entry}) + b"\n", append=True)
        return self.seq

    def write(self, path, raw, *, append=False):
        self.ensure(path.parent)
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
            descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)

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

    def discard(self, path):
        """A private file of this run that must not outlive its use (the smoke member's password once the member is
        gone, a record moved aside). Missing is fine; only files directly in the run or secrets directory."""
        path = Path(path)
        require(path.parent in (self.directory, self.secrets), "Records stay in the plan's run directory")
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass

    def discard_secret(self, name):
        self.discard(self.secrets / name)

    def sweep_working_folders(self):
        """IRT2-15: browser profile folders (cookies of a session) that a crashed or killed process left in the secrets
        directory go at the next phase start and at the plan's end; a link there is removed, never followed. Returns how
        many went (the count is recorded, nothing of their contents)."""
        if not os.path.lexists(self.secrets):
            return 0
        require(not self.secrets.is_symlink() and self.secrets.is_dir(), "The secrets directory is not a plain folder")
        swept = 0
        for item in sorted(self.secrets.iterdir()):
            if not re.fullmatch(r"browser-(?:profile|probe)-[0-9a-f]{8}", item.name):
                continue
            if item.is_symlink() or not item.is_dir():
                item.unlink()
            else:
                shutil.rmtree(item)
            swept += 1
        return swept


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
        super().__init__(address, port, timeout=bounded_timeout(10), context=context)
        self._server_name = server_name

    def connect(self):
        sock = socket.create_connection((self.host, self.port), bounded_timeout(self.timeout))
        try:
            sock.settimeout(bounded_timeout(self.timeout))
            self.sock = self._context.wrap_socket(sock, server_hostname=self._server_name)
        except ssl.SSLCertVerificationError:
            sock.close()
            raise SmokeRefusal("인증서 chain·SAN 신원을 확인하지 못했습니다") from None
        except Exception:
            sock.close()
            raise
        budget = _smoke_budget.get()
        if budget is not None:
            sock = self.sock
            def expire():
                try:
                    sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
            self._deadline_timer = threading.Timer(budget.remaining(), expire)
            self._deadline_timer.daemon = True
            self._deadline_timer.start()

    def close(self):
        timer = getattr(self, "_deadline_timer", None)
        if timer is not None:
            timer.cancel()
        super().close()


def http_read(connection, response, limit):
    """A trickling response cannot renew the attempt budget on each socket read."""
    chunks, size = [], 0
    while size <= limit:
        left = bounded_timeout(10)
        if connection.sock is not None:
            connection.sock.settimeout(left)
        elif getattr(response, "fp", None) is not None:
            response.fp.raw._sock.settimeout(left)
        block = response.read1(min(65536, limit + 1 - size))
        if not block:
            break
        chunks.append(block)
        size += len(block)
    require(size <= limit, "smoke 응답이 허용 크기를 초과했습니다")
    return b"".join(chunks)


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
        if connection.sock is not None:
            connection.sock.settimeout(bounded_timeout(10))
        response = connection.getresponse()
        raw = http_read(connection, response, limit)
        require(len(raw) <= limit, "Smoke response too large")
        return response.status, response.getheader("Content-Type", ""), raw
    finally:
        connection.close()


def https_post(origin, path, form, *, connect=None, ca_file=None):
    from urllib.parse import urlencode
    parsed = urlsplit(origin)
    address, port = connect or (parsed.hostname, parsed.port or 443)
    connection = PinnedHTTPS(address, port, parsed.hostname, ssl.create_default_context(cafile=ca_file))
    try:
        connection.request("POST", path, body=urlencode(form).encode("ascii"),
                           headers={"Host": parsed.netloc, "Content-Type": "application/x-www-form-urlencoded"})
        if connection.sock is not None:
            connection.sock.settimeout(bounded_timeout(10))
        response = connection.getresponse()
        raw = http_read(connection, response, 65536)
        require(len(raw) <= 65536, "Response too large")
        return response.status, raw
    finally:
        connection.close()


def discovery_check(origin, *, connect=None, ca_file=None):
    """The ingress serves the realm's sign-in for this origin (the issuer the API trusts)."""
    code, _, raw = https_get(origin, "/auth/realms/kin/.well-known/openid-configuration", connect=connect, ca_file=ca_file)
    require(code == 200 and json.loads(raw).get("issuer") == origin + "/auth/realms/kin", "The realm's sign-in is not served for this origin")
    return True


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


def health_check(origin, *, connect=None, ca_file=None, member_rights=True):
    """health (and memberRights=ready for the introduced release) and the unauthenticated refusal only. Used where no
    database object changed (the previous release resumed as it was); never the pass of a rollback or a release."""
    code, _, raw = https_get(origin, "/api/health", connect=connect, ca_file=ca_file)
    health = json.loads(raw)
    require(code == 200 and health.get("ok") is True and health.get("auth") is True, "Health or authentication flag failed")
    if member_rights:
        require(health.get("memberRights") == "ready", "Member rights are not ready")
    require(https_get(origin, "/api/me", connect=connect, ca_file=ca_file)[0] == 401, "Unauthenticated request was not refused")
    return {"health": True, "auth_refusal": True}


def worklist_row(origin, uid, *, connect=None, ca_file=None, token=None, pages=1000):
    """The signed-in member's worklist row of the study, or None (the product's paged list: limit 100, follow 'next')."""
    after = None
    for _ in range(pages):
        bounded_timeout(10)
        query = "/api/studies?limit=100" + ("&after=" + quote(after, safe="") if after else "")
        code, _, raw = https_get(origin, query, connect=connect, ca_file=ca_file, token=token, limit=8 * 1024 * 1024)
        require_smoke(code not in (400, 401, 403), "Worklist credential or policy refused")
        require(code == 200, "Worklist request refused (HTTP %d %s)" % (code, refusal_code(raw)))
        listed = json.loads(raw)
        rows = listed.get("studies") if isinstance(listed, dict) else None
        require(type(rows) is list, "Worklist response has no study rows")
        for row in rows:
            if isinstance(row, dict) and row.get("uid") == uid:
                return row
        after = ((listed.get("pagination") or {}).get("next"))
        if not after:
            return None
    raise Stop("Worklist did not end within the page limit")


def worklist_has(origin, uid, **kwargs):
    return worklist_row(origin, uid, **kwargs) is not None


def smoke(origin, *, connect=None, ca_file=None, token, frame, worklist_uid, member_rights=True):
    """The authenticated smoke of a release that is about to serve users: health (memberRights for the introduced
    release), unauthenticated refusal, the token's subject, the worklist listing the smoke study, and the exact frame
    bytes. Each check must run and pass; a 200, a missing token or an unrun check is never a pass."""
    require(token is not None and frame is not None and worklist_uid, "The authenticated smoke needs a token, a worklist UID and a frame")
    result = health_check(origin, connect=connect, ca_file=ca_file, member_rights=member_rights)
    code, _, raw = https_get(origin, "/api/me", connect=connect, ca_file=ca_file, token=token["access_token"])
    require_smoke(code not in (400, 401, 403), "Authenticated credential or policy refused")
    require(code == 200, "Authenticated identity check refused (HTTP %d %s)" % (code, refusal_code(raw)))
    require_smoke(json.loads(raw).get("sub") == token["subject"], "Authenticated identity is another subject")
    result["member"] = True
    require(worklist_has(origin, worklist_uid, connect=connect, ca_file=ca_file, token=token["access_token"]),
            "The worklist does not list the smoke study")
    result["worklist"] = True
    code, kind, raw = https_get(origin, frame["path"], connect=connect, ca_file=ca_file, token=token["access_token"],
                                limit=frame["bytes"] + 65536, accept='multipart/related; type="application/octet-stream"')
    require_smoke(code not in (400, 401, 403), "Frame credential or policy refused")
    require(code == 200, "Frame request failed")
    payload = frame_payload(kind, raw)
    require(len(payload) == frame["bytes"] and sha256_bytes(payload) == frame["sha256"], "Frame bytes differ")
    result["frame"] = True
    return result


def smoke_passed(result):
    """Only a result in which every authenticated check ran and passed counts (a stubbed or partial result does not)."""
    return (isinstance(result, dict) and all(result.get(key) is True for key in ("health", "auth_refusal", "member", "worklist", "frame")))


SHORTCUT_KEYS = ("list", "image", "prior", "report", "context", "note", "tools", "nativeTools", "previous", "next")


def _owner_valid(value):
    return type(value) is list and len(value) == 2 and all(type(item) is str and item for item in value)


def folders_valid(body):
    """IRT2-11: GET /api/filter-folders by its contract (api/src/pacs/filters.ts): the member's owner pair, a revision
    and the folder and saved-search lists with their fields - not merely any JSON."""
    return (type(body) is dict and _owner_valid(body.get("owner")) and type(body.get("revision")) is int and body["revision"] >= 0
            and type(body.get("folders")) is list and all(type(item) is dict and type(item.get("path")) is str
                                                          and type(item.get("description")) is str and type(item.get("ordinal")) is int
                                                          for item in body["folders"])
            and type(body.get("filters")) is list and all(type(item) is dict and type(item.get("name")) is str and "id" in item
                                                          for item in body["filters"]))


def shortcuts_valid(body):
    """IRT2-11: GET /api/workspace-shortcuts by its contract (api/src/pacs/preferences.ts): owner, revision, the invalid
    flag, and either no bindings yet or exactly the ten workspace keys bound to allowed keys."""
    if not (type(body) is dict and _owner_valid(body.get("owner")) and type(body.get("revision")) is int and body["revision"] >= 0
            and type(body.get("invalid")) is bool):
        return False
    bindings = body.get("bindings")
    return bindings is None or (type(bindings) is dict and set(bindings) == set(SHORTCUT_KEYS) and all(
        type(value) is str and re.fullmatch(r"Digit[1-79]|Key[ABD-Z]|ArrowLeft|ArrowRight", value) for value in bindings.values()))


def product_logout_refused(session):
    """The browser's product-session check: signed in through the product, its logout answered 204, and the ended
    session is then refused (401) both with its binding header and by its cookie alone."""
    return (type(session) is dict and session.get("signed_in") is True and session.get("logout_status") == 204
            and session.get("old_session_status") == 401 and session.get("old_cookie_status") == 401)


def token_claims(token):
    """The (unverified) claims of the smoke token; the API verifies the token, this only reads when it was issued."""
    try:
        body = token["access_token"].split(".")[1]
        return json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
    except Exception:
        raise SmokeRefusal("The smoke token is not a readable JWT") from None


def token_valid(value):
    _keys(value, ("access_token", "subject"), "smoke token")
    require(type(value["access_token"]) is str and 0 < len(value["access_token"]) <= 16384
            and re.fullmatch(r"[A-Za-z0-9._~-]+", value["access_token"]), "Invalid smoke token")
    require(type(value["subject"]) is str and 0 < len(value["subject"]) <= 256, "Invalid smoke subject")
    return value


# ── the phase state machine ──

STEPS = {
    # L-00a/L-00b are the recorded pre-fence corrections a target manifest may declare (checkout mode IRT-13, a modified
    # tracked compose file replaced by its equivalent overlay IRT-11); without a declaration they only observe.
    "capture": (("L-00a", "checkout_mode", True, False), ("L-00b", "reconcile_checkout", True, False), ("L-01", "baseline", False, False),
                ("L-04a", "fence", True, False), ("L-04b", "capture_b0", True, False), ("L-04c", "restore_check_b0", True, False)),
    "release": (("RL-01", "unfence", True, False), ("RL-02", "public_check_previous", False, False)),
    "introduce": (("I-00", "recheck_fence", False, False), ("L-06a", "storage", True, False), ("L-06b", "provision", True, True),
                  ("L-07", "migrate", True, True), ("L-08a", "keycloak", True, True), ("L-08b", "member_import", True, True),
                  ("L-09a", "api", True, True), ("L-09b", "proxy_ui", True, True)),
    "verify": (("L-10a", "fenced_smoke", True, False), ("L-10b", "probe", True, True), ("L-10c", "capture_b1", True, True),
               ("L-10d", "resume", True, True), ("L-10e", "remove_smoke_member", True, True)),
    "reopen": (("L-11a", "final_allowlist", False, False), ("L-11b", "restore_jobs", True, False),
               ("L-11c", "reopen_ingress", True, False), ("L-11d", "public_smoke", False, False)),
    # The rollback restores (RB-00..RB-03) and stops behind the maintenance ingress with the lock and the fence kept; only
    # rollback_reopen (RB-04) opens anything, after the previous version proved itself with a login made after the
    # restore, the worklist and the frame bytes. Until then the status is RESTORED, never ROLLED_BACK.
    "rollback": (("RB-00", "classify", True, False), ("RB-01", "preserve_failed", True, False), ("RB-02", "restore_b0", True, False),
                 ("RB-03", "previous_services", True, False)),
    "rollback_reopen": (("RB-04a", "recovery_persisted", False, False), ("RB-04b", "fenced_previous_smoke", True, False),
                        ("RB-04c", "restore_jobs_after_rollback", True, False), ("RB-04d", "reopen_previous_ingress", True, False),
                        ("RB-04e", "public_previous_smoke", False, False)),
    "seed": (("S-01", "seed_check", False, False), ("S-02", "seed_restore", True, False), ("S-03", "seed_services", True, False)),
    "receipt": (("RC-01", "write_receipt", False, False),),
}
# Which statuses each phase may start from.
FROM = {"capture": ("NEW", "SEEDED"), "release": ("HELD", "CAPTURE_FAILED", "NEEDS_ATTENTION"), "introduce": ("HELD",),
        "verify": ("INTRODUCED",), "reopen": ("VERIFIED",),
        "rollback": ("INTRODUCED", "VERIFIED", "NEEDS_ATTENTION", "INTRODUCE_FAILED", "VERIFY_FAILED"),
        "rollback_reopen": ("RESTORED",), "seed": ("NEW",), "receipt": ("ROLLED_BACK",)}
DONE = {"capture": "HELD", "release": "RELEASED", "introduce": "INTRODUCED", "verify": "VERIFIED", "reopen": "DEPLOYED",
        "rollback": "RESTORED", "rollback_reopen": "ROLLED_BACK", "seed": "SEEDED", "receipt": "RECEIPTED"}
BUDGET = {"capture": "capture_s", "release": "capture_s", "introduce": "introduce_s", "verify": "verify_s", "reopen": "reopen_s",
          "rollback": "rollback_s", "rollback_reopen": "rollback_s", "seed": "seed_s", "receipt": "capture_s"}


def value_changes(before, after):
    """Structured table keys only; punctuation inside a quoted identifier cannot collide with another schema."""
    require(before.get("version") == after.get("version") == ops.RESTORE_INVENTORY, "복원 값 inventory 버전이 다릅니다")
    left = {tuple(row["key"]): row for row in before["tables"]}
    right = {tuple(row["key"]): row for row in after["tables"]}
    require(len(left) == len(before["tables"]) and len(right) == len(after["tables"]), "복원 값 식별자가 중복됐습니다")
    return {key for key in set(left) | set(right) if left.get(key) != right.get(key)}


class CloneFields:
    """Private expected rows fixed before a clone mutation. No table/column is omitted from residual comparison."""
    def __init__(self):
        self.rules = {}
        self.sql = []

    def change(self, table, columns, before, after):
        key = ("keycloak", "public", "table", table, None)
        require(len(columns) == len(before) and (after is None or len(after) == len(before)), "clone 변환 행의 열 수가 다릅니다")
        if after == before:
            return
        self.rules.setdefault(key, []).append((tuple(columns), tuple(before), None if after is None else tuple(after)))
        where = " AND ".join(ops._identifier(column) + " IS NOT DISTINCT FROM " + ("NULL" if value is None else ops._sql_literal(value))
                             for column, value in zip(columns, before))
        relation = 'public.' + ops._identifier(table)
        if after is None:
            self.sql.append("DELETE FROM " + relation + " WHERE " + where + ";")
        else:
            assignments = [ops._identifier(column) + "=" + ("NULL" if new is None else ops._sql_literal(new))
                           for column, old, new in zip(columns, before, after) if old != new]
            self.sql.append("UPDATE " + relation + " SET " + ",".join(assignments) + " WHERE " + where + ";")

    def expected(self, key, columns, rows):
        remaining = list(self.rules.get(key, []))
        result = []
        for row in rows:
            match = next((index for index, rule in enumerate(remaining) if rule[0] == tuple(columns) and rule[1] == tuple(row)), None)
            if match is None:
                result.append(row)
            else:
                _, _, after = remaining.pop(match)
                if after is not None:
                    result.append(list(after))
        require(not remaining, "clone 변경 직전에 원래 행 또는 열이 달라졌습니다")
        return result


def clone_origin(value, source, target):
    if value is None:
        return None
    return target + value[len(source):] if value == source or any(value.startswith(source + mark) for mark in ("/", "?", "#")) else value


def clone_admin_rows(before, after, *, username, realm, role_ids, started_ms, ended_ms):
    """Validate the pinned bootstrap command's new immutable IDs, then remove only those exact rows for comparison."""
    from collections import Counter
    additions = {}
    for table in ("user_entity", "credential", "user_attribute", "user_role_mapping"):
        columns, old = before[table]
        new_columns, new = after[table]
        require(columns == new_columns, "clone 관리자 생성 중 스키마가 달라졌습니다")
        old_rows, new_rows = Counter(map(tuple, old)), Counter(map(tuple, new))
        require(not (old_rows - new_rows), "clone 관리자 생성 중 기존 행이 바뀌거나 없어졌습니다")
        additions[table] = [dict(zip(columns, row)) for row in (new_rows - old_rows).elements()]
    require(len(additions["user_entity"]) == 1, "clone 관리자가 정확히 한 명 생성되지 않았습니다")
    user = additions["user_entity"][0]
    uid = user.get("id")
    require(type(uid) is str and re.fullmatch(r"[0-9a-f-]{36}", uid), "clone 관리자의 불변 ID가 잘못됐습니다")
    allowed = {"id": uid, "username": username, "realm_id": realm, "enabled": "true", "email_verified": "false", "not_before": "0"}
    for key in ("created_timestamp", "last_modified_timestamp"):
        value = user.get(key)
        require((key == "last_modified_timestamp" and value is None) or (type(value) is str and value.isdigit()
                and started_ms - 5000 <= int(value) <= ended_ms + 5000), "clone 관리자 생성 시각이 실행 범위를 벗어났습니다")
        allowed[key] = value
    require(type(user.get("email_constraint")) is str and re.fullmatch(r"[0-9a-f-]{36}", user["email_constraint"]),
            "clone 관리자 email 제약값이 잘못됐습니다")
    allowed["email_constraint"] = user["email_constraint"]
    require(all(value == allowed.get(key) for key, value in user.items()), "clone 관리자에 승인하지 않은 필드 값이 있습니다")
    credentials = additions["credential"]
    require(len(credentials) == 1, "clone 관리자 password credential이 유일하지 않습니다")
    credential = credentials[0]
    require(credential.get("user_id") == uid and credential.get("type") == "password"
            and type(credential.get("id")) is str and re.fullmatch(r"[0-9a-f-]{36}", credential["id"]),
            "clone credential 소유권 또는 종류가 다릅니다")
    try:
        secret, data = json.loads(credential["secret_data"]), json.loads(credential["credential_data"])
        require(type(secret) is dict and type(data) is dict and data.get("algorithm") in ("argon2", "pbkdf2-sha512", "pbkdf2-sha256")
                and all(type(secret.get(key)) is str and secret[key] for key in ("salt", "value")), "clone password verifier 형식이 다릅니다")
    except (TypeError, ValueError, KeyError):
        raise Stop("clone password verifier를 읽지 못했습니다") from None
    timestamp = credential.get("created_date")
    require(type(timestamp) is str and timestamp.isdigit() and started_ms - 5000 <= int(timestamp) <= ended_ms + 5000,
            "clone credential 생성 시각이 실행 범위를 벗어났습니다")
    generated = {key: credential[key] for key in ("id", "user_id", "type", "secret_data", "credential_data", "created_date")}
    # Keycloak 26.7.3 assigns the first stored credential priority 10; version starts at 0.
    generated.update(priority="10", version="0")
    require(all(value == generated.get(key) for key, value in credential.items()), "clone credential에 승인하지 않은 필드 값이 있습니다")
    attributes = additions["user_attribute"]
    require(len(attributes) == 1 and attributes[0].get("user_id") == uid and attributes[0].get("name") == "is_temporary_admin"
            and attributes[0].get("value") == "true" and type(attributes[0].get("id")) is str
            and re.fullmatch(r"[0-9a-f-]{36}", attributes[0]["id"]), "clone 관리자 소유 표식이 다릅니다")
    require(all(value is None for key, value in attributes[0].items() if key not in ("id", "user_id", "name", "value")),
            "clone 관리자 속성에 승인하지 않은 필드 값이 있습니다")
    mappings = additions["user_role_mapping"]
    require(len(mappings) == len(role_ids) and {row.get("role_id") for row in mappings} == set(role_ids)
            and all(row == {"user_id": uid, "role_id": row["role_id"]} for row in mappings), "clone 관리자 역할 부여 범위가 다릅니다")
    removed = CloneFields()
    for table, rows in additions.items():
        columns = after[table][0]
        for row in rows:
            removed.change(table, columns, [row[column] for column in columns], None)
    return uid, removed.expected


OBSERVATION_FIELDS = frozenset(("checkout", "compose_entry", "lock", "containers", "database", "fences", "workers"))
DB_ABSENCE_CHECKPOINTS = (("S-01", "before"), ("S-01", "after"), ("S-02", "before"), ("RB-02", "db-removed"))


def fact(value):
    return {"outcome": "OK", "value": value}


def absent():
    return {"outcome": "ABSENT"}


def observation_error(error):
    # A transport's exception may quote credentials; retain only its class.
    return {"outcome": "ERROR", "reason": type(error).__name__}


def observed(snapshot):
    """C-OBS: completeness is a closed schema, never the absence of an error string.

    ABSENT containers are facts (a successful daemon listing proved their absence). Whether a particular absence is
    allowed belongs to the step. Database absence is only observable at the explicitly named seed checkpoints.
    """
    def complete(value):
        if type(value) is not dict:
            return False
        if value.get("outcome") == "OK":
            return set(value) == {"outcome", "value"}
        return value == absent()

    if type(snapshot) is not dict or set(snapshot) != {"schema", "facts", "checkpoint"} or type(snapshot["schema"]) is not int or snapshot["schema"] != 1:
        return False
    if type(snapshot["checkpoint"]) is not list or len(snapshot["checkpoint"]) != 2 or not all(
            item is None or type(item) is str for item in snapshot["checkpoint"]):
        return False
    fields = snapshot["facts"]
    if type(fields) is not dict or set(fields) != OBSERVATION_FIELDS or not all(complete(v) for v in fields.values()):
        return False
    if any(fields[name].get("outcome") != "OK" for name in OBSERVATION_FIELDS - {"database"}):
        return False
    containers = fields["containers"]["value"]
    if type(containers) is not dict or set(containers) != set(ROLES) or not all(complete(v) for v in containers.values()):
        return False
    for item in containers.values():
        if item["outcome"] == "OK":
            data = item["value"]
            if type(data) is not dict or set(data) != {"id", "image", "running", "restarting", "project", "service"}:
                return False
            if not all(type(data[k]) is str and data[k] for k in ("id", "image", "project", "service")):
                return False
            if type(data["running"]) is not bool or type(data["restarting"]) is not bool:
                return False
    db = fields["database"]
    if db["outcome"] == "ABSENT":
        if tuple(snapshot["checkpoint"]) not in DB_ABSENCE_CHECKPOINTS:
            return False
        if containers["db"] != absent():
            return False
    else:
        value = db["value"]
        if type(value) is not dict or set(value) != {"ready", "migrations"} or value["ready"] is not True:
            return False
        if type(value["migrations"]) is not list or not all(
                type(row) is list and len(row) == 4 and type(row[0]) is str and row[0]
                and type(row[1]) is str and HASH.fullmatch(row[1]) is not None
                and type(row[2]) is bool and type(row[3]) is bool for row in value["migrations"]):
            return False
    checkout = fields["checkout"]["value"]
    entry = fields["compose_entry"]["value"]
    lock = fields["lock"]["value"]
    fences = fields["fences"]["value"]
    workers = fields["workers"]["value"]
    return (type(checkout) is dict and set(checkout) == {"sha"} and type(checkout["sha"]) is str
            and SHA.fullmatch(checkout["sha"]) is not None
            and type(entry) is dict and set(entry) == {"generation", "sha256"}
            and type(entry["generation"]) is str and (entry["generation"] == "admission" or HASH.fullmatch(entry["generation"]) is not None)
            and type(entry["sha256"]) is str and HASH.fullmatch(entry["sha256"]) is not None
            and type(lock) is dict and set(lock) == {"owned"} and type(lock["owned"]) is bool
            and type(fences) is dict and set(fences) == {"writers", "cron", "ingress", "db_clients"}
            and type(fences["writers"]) is dict and set(fences["writers"]) == set(WRITERS)
            and all(type(v) is bool for v in fences["writers"].values())
            and fences["cron"] in ("open", "fenced", "not-managed")
            and fences["ingress"] in ("public", "maintenance", "closed")
            and type(fences["db_clients"]) is int and fences["db_clients"] >= 0
            and type(workers) is dict and set(workers) == {"quiet", "pending"}
            and type(workers["quiet"]) is bool and type(workers["pending"]) is list
            and workers["quiet"] == (not workers["pending"]))


def workers_quiet(snapshot):
    return observed(snapshot) and snapshot["facts"]["workers"]["value"]["quiet"]


def pending_observed(snapshot):
    workers = snapshot.get("facts", {}).get("workers", {})
    return workers.get("outcome") == "OK" and bool(workers.get("value", {}).get("pending"))


# Completed boundary contracts. A failed command is compared only for observation completeness: a known partial
# result is STOP, whereas pretending the success postcondition held would hide precisely the state rollback needs.
BOUNDARY_RUNNING = {
    "L-00a": "all", "L-00b": "all", "L-01": "all", "L-04a": "db", "L-04b": "db", "L-04c": "db",
    "RL-01": "all", "RL-02": "all", "I-00": "db", "L-06a": "db", "L-06b": "db", "L-07": "db",
    "L-08a": "db keycloak", "L-08b": "db keycloak", "L-09a": "db keycloak api", "L-09b": "all",
    "L-10a": "all", "L-10b": "all", "L-10c": "db", "L-10d": "all", "L-10e": "all",
    "L-11a": "all", "L-11b": "all", "L-11c": "all", "L-11d": "all",
    "RB-00": "db", "RB-01": "db", "RB-02": "db", "RB-03": "all",
    "RB-04a": "all", "RB-04b": "all", "RB-04c": "all", "RB-04d": "all", "RB-04e": "all",
    "S-01": "", "S-02": "db", "S-03": "all", "RC-01": "all", "I-RV": "db",
}
PUBLIC_BOUNDARIES = frozenset(("L-00a", "L-00b", "L-01", "RL-01", "RL-02", "L-11c", "L-11d", "RB-04d", "RB-04e", "S-03", "RC-01"))
OPEN_CRON_BOUNDARIES = PUBLIC_BOUNDARIES | {"L-11b", "RB-04c"}
BEFORE_BOUNDARY = {
    "L-00a": "L-01", "L-00b": "L-00a", "L-01": "L-00b", "L-04a": "L-01", "L-04b": "L-04a", "L-04c": "L-04b",
    "RL-01": "L-04a", "RL-02": "RL-01", "I-00": "L-04c", "L-06a": "I-00", "L-06b": "L-06a", "L-07": "L-06b",
    "L-08a": "L-07", "L-08b": "L-08a", "L-09a": "L-08b", "L-09b": "L-09a",
    "L-10a": "L-09b", "L-10b": "L-10a", "L-10c": "L-10b", "L-10d": "L-10c", "L-10e": "L-10d",
    "L-11a": "L-10e", "L-11b": "L-11a", "L-11c": "L-11b", "L-11d": "L-11c",
    "RB-01": "RB-00", "RB-02": "RB-01", "RB-03": "RB-02", "RB-04a": "RB-03", "RB-04b": "RB-04a",
    "RB-04c": "RB-04b", "RB-04d": "RB-04c", "RB-04e": "RB-04d", "S-01": "S-01", "S-02": "S-01", "S-03": "S-02", "RC-01": "RC-01",
}


def checkpoint_valid(snapshot, context, sid):
    require(workers_quiet(snapshot), "필수 관측 또는 작업 종료가 미결입니다")
    require(sid in BOUNDARY_RUNNING, "미선언 단계의 관측 계약입니다")
    fields = snapshot["facts"]
    require(fields["lock"]["value"]["owned"] == bool(context.state.get("lock_token"))
            and (bool(context.state.get("lock_token")) or sid == "RC-01"), "작업 잠금 소유권이 다릅니다")
    side = "release" if context.state["checkout"] == "target" else "previous"
    require(fields["checkout"]["value"]["sha"] == context.plan[side]["sha"], "관측된 checkout이 계획과 다릅니다")
    if context.state.get("compose_entry"):
        expected = context.state["compose_entry"]
        require(fields["compose_entry"]["value"] == {"generation": expected["generation"], "sha256": expected["sha256"]},
                "관측된 Compose 세대가 활성화한 세대와 다릅니다")
    desired = set(ROLES) if BOUNDARY_RUNNING[sid] == "all" else set(BOUNDARY_RUNNING[sid].split())
    containers = fields["containers"]["value"]
    running = {role for role, fact_ in containers.items() if fact_.get("outcome") == "OK" and fact_["value"]["running"]}
    require(running == desired, "단계 종료의 서비스 실행 상태가 계약과 다릅니다")
    for role, fact_ in containers.items():
        if fact_ == absent():
            require(sid in ("S-01", "S-02", "RB-00", "RB-01", "RB-02") and role not in desired,
                    "단계 종료에 필요한 컨테이너가 없습니다")
            continue
        item = fact_["value"]
        require(not item["restarting"] and item["service"] == role, "컨테이너 실행 또는 service 신원이 다릅니다")
        expected_projects = {context.target["project"]}
        recovery = context.state.get("recovery")
        if recovery:
            expected_projects.add(recovery["project"])
        require(item["project"] in expected_projects and item["image"] in (context.plan["previous"]["images"][role], context.plan["release"]["images"][role]),
                "컨테이너 project 또는 image 신원이 계획 밖입니다")
        partial_failure = sid in ("RB-00", "RB-01") or (sid == "RB-02" and role != "db")
        if not partial_failure:
            previous_roles = {"L-06a": {"api", "proxy", "keycloak", "orthanc"},
                              "L-06b": {"api", "proxy", "keycloak", "orthanc"},
                              "L-07": {"api", "proxy", "keycloak", "orthanc"},
                              "L-08a": {"api", "proxy", "orthanc"}, "L-08b": {"api", "proxy", "orthanc"},
                              "L-09a": {"proxy", "orthanc"}}
            image_side = "previous" if side == "previous" or role in previous_roles.get(sid, set()) else "release"
            require(item["image"] == context.plan[image_side]["images"][role], "단계별 실제 이미지 ID가 다릅니다")
            expected_project = recovery["project"] if recovery and (sid not in ("RB-02",) or role == "db") else context.target["project"]
            require(item["project"] == expected_project, "단계별 실제 Compose project가 다릅니다")
    fences = fields["fences"]["value"]
    require(fences["writers"] == {role: role in desired for role in WRITERS}, "writer 관측과 컨테이너 관측이 다릅니다")
    ingress = "public" if sid in PUBLIC_BOUNDARIES else ("maintenance" if "proxy" in desired else "closed")
    require(fences["ingress"] == ingress, "단계 종료의 ingress 경계가 다릅니다")
    require(fences["cron"] in (("open", "not-managed") if sid in OPEN_CRON_BOUNDARIES or sid in ("S-01", "S-02")
                               else ("fenced", "not-managed")), "단계 종료의 예약 작업 경계가 다릅니다")
    if desired <= {"db"}:
        require(fences["db_clients"] == 0, "writer 차단 뒤 데이터베이스 연결이 남아 있습니다")
    if fields["database"] != absent() and sid not in ("RB-00", "RB-01"):
        after = sid in {"L-07", "L-08a", "L-08b", "L-09a", "L-09b", "L-10a", "L-10b", "L-10c", "L-10d", "L-10e", "L-11a", "L-11b", "L-11c", "L-11d"}
        pre.check_migration_rows(fields["database"]["value"]["migrations"], context.plan["migrations"]["after" if after else "before"])


def new_state(plan_sha256, plan):
    return {"schema": 1, "mode": MODE, "plan_sha256": plan_sha256, "target_kind": plan["target_kind"], "status": "NEW",
            "lock_token": None, "db_changed": False, "ponr": None, "fenced": None, "checkout": "previous",
            "b0": None, "b1": None, "bfail": None, "seed": None, "recovery": None, "rollback_attempted": False,
            "history": [], "probe": None, "receipt": None, "running": None, "receipts_used": [], "restored_at": None,
            "rollback_smoke": None, "unknown_hold": None, "host_changed": False, "recovery_reopen": None}


class Introduction:
    """One phase of one plan. `ops` performs and observes the host operations (HostOps on a real host); this class owns
    order, the durable state, the lock, budgets, windows, the automatic-rollback decision and the records."""

    def __init__(self, *, plan, plan_sha256, target, production, ops, records, repository, host_key, tool, evidence=None,
                 clock=time.monotonic, now=utc_now, warnings=()):
        self.plan, self.plan_sha256, self.target, self.production = plan, plan_sha256, target, production
        self.ops, self.records, self.repository = ops, records, Path(repository)
        self.host_key, self.tool, self.evidence = host_key, tool, evidence or {}
        self.clock, self.now = clock, now
        self.state = None
        self.steps = []
        # D05/D06: what a recovery phase went on despite (a reopened checkout mode found by the entry, an overlay file
        # that changed or vanished): recorded in the phase-start event, the result file and the result.
        self.warnings = list(warnings)
        self.receipt_facts = None
        self.retried = self.retrying = False

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
        """Collect command and observation results before classifying once (C-OBS).

        Raising from a command's except clause would bypass the final classification when after-observation also fails.
        No exception is propagated until the durable outcome includes both observations and worker termination.
        """
        record = {"step": sid, "action": name, "mutating": mutating, "started_utc": self.now().isoformat()}
        self.event("step-start", step=sid)
        started = self.clock()
        first = self.records.seq + 1
        record["before"] = self.observe(sid, "before")
        self.records.context = {"step": sid, "part": "step"}
        outcome, detail, launched = None, {}, False
        pending_before = bool(self.state.get("host_changed") or self.state.get("fenced") or self.state.get("db_changed"))
        try:
            if not workers_quiet(record["before"]):
                if pending_before or pending_observed(record["before"]):
                    raise Unknown("이전 변경 뒤 필수 관측 또는 작업 종료를 확인하지 못했습니다")
                raise Stop("변경 전 필수 관측 또는 작업 종료를 확인하지 못했습니다")
            self.guard()
            if sid in BEFORE_BOUNDARY:
                checkpoint_valid(record["before"], self, BEFORE_BOUNDARY[sid])
            else:
                require(sid in ("RB-00", "I-RV"), "미선언 단계의 시작 관측 계약입니다")
                fences = record["before"]["facts"]["fences"]["value"]
                require(fences["cron"] in ("fenced", "not-managed") and fences["ingress"] != "public"
                        and self.state.get("ponr") is None and not self.state.get("unknown_hold"),
                        "복구 시작 전 예약 작업·ingress 차단 경계를 확인하지 못했습니다")
            if db_change and not self.state["db_changed"]:
                # Durable before the first database change: from here on, only a full B0 restore is a rollback.
                self.state["db_changed"] = True
                self.save()
            launched = True
            try:
                with (smoke_attempt(BROWSER_TIMEOUT_S, self.deadline_left()) if name in RETRIED_ONCE or name == "fenced_previous_smoke" else nullcontext()):
                    detail = getattr(self.ops, name)(self) or {}
            except Stop as error:
                if name not in RETRIED_ONCE or self.retried or getattr(error, "retryable", True) is False:
                    raise
                # Even a nominally read-only smoke creates accounts, helpers and a browser. Its settled first failure
                # must be observed before a second attempt can launch anything.
                settled = self.observe(sid, "after")
                record["first_attempt_after"] = settled
                if not workers_quiet(settled):
                    raise Unknown("smoke 실패 뒤 필수 관측 또는 작업 종료를 확인하지 못했습니다") from None
                detail = self.retry_step(name, error)
            outcome = "PASS"
        except Unknown as error:
            outcome = "UNKNOWN"
            record.update(code=code_of(error))
        except Exception as error:
            outcome = "UNKNOWN" if launched and mutating and not isinstance(error, Stop) else "STOP"
            record.update(code=code_of(error))
        finally:
            record["action_started"] = launched
            record["after"] = self.observe(sid, "after")
            if not workers_quiet(record["after"]):
                # Once an action ran, both PASS and STOP require complete after facts, including read-only actions.
                # A refusal before any action or earlier change remains the unchanged entry's STOP.
                uncertain = pending_before or self.state.get("host_changed") or launched or pending_observed(record["after"])
                outcome = "UNKNOWN" if uncertain or outcome == "UNKNOWN" else "STOP"
                record["command_code"] = record.get("code")
                record["code"] = "단계 이후 필수 관측 또는 작업 종료를 확인하지 못했습니다"
            elif outcome == "PASS":
                try:
                    checkpoint_valid(record["after"], self, sid)
                except Stop as error:
                    outcome, record["code"] = "STOP", code_of(error)
            record["outcome"] = outcome or "UNKNOWN"
            record["seconds"] = round(self.clock() - started, 3)
            if outcome == "PASS":
                record["detail"] = detail
            record["commands"] = {"file": self.records.commands_file, "first": first, "last": self.records.seq}
            self.steps.append(record)
            if outcome == "UNKNOWN":
                self.state["unknown_hold"] = {"step": sid, "request_sha256": self.request_sha256,
                                               "reason": record["code"], "at": self.now().isoformat()}
                self.save()
            self.event("step-end", step=sid, outcome=record["outcome"], **({"code": record["code"]} if "code" in record else {}))
        if outcome == "UNKNOWN":
            raise Unknown(record["code"])
        if outcome == "STOP":
            raise Stop(record["code"])
        return detail

    def retry_step(self, name, error):
        """D07: the fenced smoke failed with a settled refusal (a browser that did not start, a moment's HTTP hiccup) - an
        environmental failure must not cost a full B0 rollback by itself. The same read-only step runs once more, within
        SMOKE_RETRY_S, and the retry, its reason and its outcome are recorded (state, journal, the step's detail). Nothing
        else repeats (no migration, no probe); the retry's own failure is the step's STOP and the settled-failure path
        (workers, point of no return, then the rollback) follows."""
        reason = code_of(error)
        self.retried = True
        started = self.clock()
        self.state["smoke_retry"] = {"step": name, "reason": reason, "at": self.now().isoformat(), "bound_s": SMOKE_RETRY_S, "passed": None}
        self.save()
        self.event("smoke-retry", reason=reason, bound_s=SMOKE_RETRY_S)
        self.retrying = True
        try:
            with smoke_attempt(SMOKE_RETRY_S, self.deadline_left()):
                detail = getattr(self.ops, name)(self) or {}
            require(self.clock() - started <= SMOKE_RETRY_S, "The smoke retry exceeded its bound of %d s" % SMOKE_RETRY_S)
        except (Stop, Unknown) as second:
            self.state["smoke_retry"].update(passed=False, retry_code=code_of(second))
            self.save()
            raise
        finally:
            self.retrying = False
        self.state["smoke_retry"].update(passed=True, seconds=round(self.clock() - started, 3))
        self.save()
        return {**detail, "retry": {"reason": reason, "passed": True}}

    def observe(self, sid=None, part=None):
        """The host as seen around a step (selected, secret-free); an unobservable host is recorded as such."""
        snapshot = getattr(self.ops, "snapshot", None)
        if snapshot is None:
            return {"unobservable": "no observer"}
        previous_context = self.records.context
        self.records.context = {"step": sid, "part": part}
        try:
            return snapshot(self)
        except Exception as error:
            return {"unobservable": type(error).__name__}
        finally:
            self.records.context = previous_context

    def result(self, status, passed, extra=None):
        steps = []
        for step in self.steps:
            steps.append({key: step[key] for key in ("step", "outcome", "seconds", "code") if key in step})
        out = {"mode": MODE, "phase": self.phase, "status": status, "phase_passed": passed, "plan_sha256": self.plan_sha256,
               "request_sha256": self.request_sha256, "target_kind": self.plan["target_kind"],
               "lock_retained": bool(self.state["lock_token"]) and lock_owned(self.repository, self.state["lock_token"]),
               "db_changed": self.state["db_changed"], "ponr": self.state["ponr"], "steps": steps,
               "compose_env_resolved": sorted(self.state.get("compose_env") or {})}
        if self.warnings:
            out["warnings"] = list(self.warnings)
        if extra:
            out.update(extra)
        return out

    def warn(self, kind, **facts):
        """A recovery phase goes on despite this fact (D05/D06): recorded now and in the phase's result - once per phase
        (each later resolution of the same overlay meets the same fact)."""
        warning = {"kind": kind, **facts}
        if warning in self.warnings:
            return
        self.warnings.append(warning)
        self.event("recovery-warning", warning=warning)

    def finish(self, status, passed, release=False, extra=None):
        if self.state.get("unknown_hold"):
            status, passed, release = "NEEDS_ATTENTION", False, False
        self.state["status"] = status
        if release and not passed and self.phase == "capture" and not self.state.get("fenced"):
            restore_entry = getattr(self.ops, "restore_previous_entry", None)
            if restore_entry is not None:
                restore_entry(self)
        if release and self.state["lock_token"]:
            release_lock(self.repository, self.state["lock_token"])
            self.state["lock_token"] = None
            # D04: the plan ended; the resolved compose values it kept for its later phases are not kept beyond it.
            self.records.discard_secret(COMPOSE_VALUES)
            self.records.sweep_working_folders()
        written = {"steps": self.steps, "status": status, "phase": self.phase, "request_sha256": self.request_sha256,
                   "plan_sha256": self.plan_sha256, "commands_file": self.records.commands_file}
        if self.warnings:
            written["warnings"] = list(self.warnings)
        digest = self.records.put("result-" + self.phase + "-" + self.request_sha256[:16] + ".json", written)
        self.state["history"].append({"phase": self.phase, "status": "PASS" if passed else status,
                                      "request_sha256": self.request_sha256, "seconds": round(self.clock() - self.started, 3),
                                      "result_sha256": digest, "steps": [[step["step"], step["outcome"]] for step in self.steps]})
        # The phase ended (settled or kept for an operator): no longer running.
        self.state["running"] = None
        self.save()
        self.event("phase-end", status=status)
        return self.result(status, passed, extra)

    # ── entry ──
    def run(self, request, request_sha256):
        """One phase, exclusively: the per-plan lease (an OS lock the kernel frees if this process dies) is held from
        before the state is read until the result is durable, so two approved requests can never both act."""
        self.phase = request["phase"]
        self.request_sha256 = request_sha256
        require(request["plan_sha256"] == self.plan_sha256, "Request names another plan")
        with self.records.lease():
            try:
                return self.run_exclusive()
            except Exception as error:
                if not getattr(self, "state", {}).get("running") or self.state["running"]["request_sha256"] != self.request_sha256:
                    raise
                changed = self.state.get("host_changed") or self.state.get("fenced") or self.state.get("db_changed")
                if changed or isinstance(error, Unknown) or any(row.get("state") != "QUIET" for row in self.state.get("workers", {}).values()):
                    self.state["unknown_hold"] = {"step": "execute", "request_sha256": self.request_sha256,
                                                   "reason": code_of(error), "at": self.now().isoformat()}
                    return self.finish("NEEDS_ATTENTION", False)
                return self.finish(self.state["status"], False, release=True)

    def run_exclusive(self):
        self.started = self.clock()
        self.recovering = self.phase in RECOVERY_PHASES
        self.state = self.records.state() or new_state(self.plan_sha256, self.plan)
        require(self.state["plan_sha256"] == self.plan_sha256 and self.state["mode"] == MODE, "State belongs to another plan")
        reentry = getattr(self.ops, "observe_pending_browsers", None)
        if reentry is not None:
            reentry(self)
        if self.state.get("running"):
            # A phase began and never wrote its end (crash, kill, lost host): nothing is re-run automatically; the
            # retained lock stays and the plan needs an operator (release or rollback decide from NEEDS_ATTENTION).
            stale = self.state["running"]
            self.state.update(running=None, status="NEEDS_ATTENTION")
            self.state["unknown_hold"] = {"step": "interrupted-phase", "request_sha256": stale["request_sha256"],
                                           "reason": "이전 실행의 종료를 확인하지 못했습니다", "at": self.now().isoformat()}
            self.state["history"].append({"phase": stale["phase"], "status": "INTERRUPTED", "request_sha256": stale["request_sha256"],
                                          "seconds": None, "result_sha256": None, "steps": []})
            self.save()
            self.records.journal({"event": "interrupted-phase", "plan_sha256": self.plan_sha256, "phase": stale["phase"],
                                  "request_sha256": stale["request_sha256"], "classified": "NEEDS_ATTENTION"})
            raise Stop("Phase " + stale["phase"] + " did not finish (process ended); classified NEEDS_ATTENTION, inspect before the next request")
        require(not self.state.get("unknown_hold"), "UNKNOWN 보류 중입니다. 같은 실행의 별도 조정 근거 없이 새 단계를 시작할 수 없습니다")
        self.budget = self.plan["budget"][BUDGET[self.phase]]
        require(self.state["status"] in FROM[self.phase], "Phase " + self.phase + " cannot follow " + self.state["status"])
        if self.phase in ("seed", "receipt"):
            require(self.plan["target_kind"] == "rehearsal", "Seed and receipt exist only on a rehearsal target")
        if self.phase == "rollback":
            require(self.state["ponr"] is None, "Ingress was reopened: no automatic or requested rollback past this point")
            require(self.state["db_changed"] and not self.state["rollback_attempted"], "Rollback is not applicable or was already attempted")
        if self.phase == "release":
            require(not self.state["db_changed"] and self.state["checkout"] == "previous", "Release is only for an unchanged database")
        require(self.tool == self.plan["tool"], "Installed tool differs from the plan")
        check_target(self.target, self.production, self.plan["target_kind"], self.host_key)
        require(sha256_bytes(canonical(self.target)) == self.plan["target_manifest_sha256"], "Target manifest differs from the plan")
        claimed = self.check_evidence()
        if self.phase not in ("capture", "seed", "receipt"):
            require(self.state["lock_token"] and lock_owned(self.repository, self.state["lock_token"]),
                    "This release no longer owns the operations lock")
        # Durable before any external effect: this phase is running (a crash leaves it for the classification above).
        self.records.begin(self.phase, self.request_sha256)
        self.records.put("plan.json", self.plan)
        self.state["running"] = {"phase": self.phase, "request_sha256": self.request_sha256, "started_utc": self.now().isoformat()}
        if claimed:
            # The local-restore receipt is spent by this attempt, whatever its outcome (one production attempt, once).
            self.state["receipts_used"].append(claimed)
        self.save()
        if self.phase in ("capture", "seed", "receipt"):
            # A new exclusive lock; a competing backup, rehearsal or API-only deployment cannot hold it meanwhile.
            try:
                self.state["lock_token"] = acquire_lock(self.repository)
            except FileExistsError:
                self.state["running"] = None
                self.save()
                raise Stop("Operations lock is held by another operation") from None
            self.save()
        prepare_repository = getattr(self.ops, "prepare_repository", None)
        if prepare_repository is not None:
            prepare_repository(self)
        self.event("phase-start", request_sha256=self.request_sha256,
                   **({"receipt_sha256": claimed, "receipt_clock": self.receipt_facts} if claimed else {}),
                   **({"warnings": list(self.warnings)} if self.warnings else {}))
        bind = getattr(self.ops, "bind", None)
        with (bind() if bind else nullcontext()):
            if any(row.get("state") != "QUIET" for row in self.state.get("workers", {}).values()):
                self.state["unknown_hold"] = {"step": "worker-admission", "request_sha256": self.request_sha256,
                                               "reason": "이전 작업의 종료가 미결입니다", "at": self.now().isoformat()}
                return self.finish("NEEDS_ATTENTION", False)
            prepare = getattr(self.ops, "prepare", None)
            if prepare is not None:
                # IRT-12: the compose environment of the running stack, before any step of this phase uses it.
                try:
                    self.environment = prepare(self)
                except Exception as error:
                    if self.state.get("host_changed") or self.state.get("fenced") or isinstance(error, Unknown):
                        self.state["unknown_hold"] = {"step": "prepare", "request_sha256": self.request_sha256,
                                                       "reason": code_of(error), "at": self.now().isoformat()}
                        return self.finish("NEEDS_ATTENTION", False)
                    return self.finish(self.state["status"], False, release=True)
            swept = self.records.sweep_working_folders()
            if swept:
                self.event("secrets-swept", browser_profiles=swept)
            return getattr(self, "phase_" + self.phase)()

    def check_evidence(self):
        """Evidence the phase needs, verified before anything runs. Returns the receipt this attempt spends, if any."""
        if self.phase == "introduce" and self.plan["target_kind"] == "production":
            require(self.state["b0"] is not None, "No B0 snapshot")
            require(type(self.evidence.get("local-restore")) is dict, "Local-restore receipt required")
            receipt = self.evidence["local-restore"]
            now = self.now()
            receipt_valid(receipt, self.plan, self.state["b0"]["manifest_sha256"], self.production, now=now,
                          b0_created_utc=self.state["b0"].get("created_utc"), used=self.state["receipts_used"],
                          bundle=self.evidence.get("local-restore-bundle"))
            self.receipt_facts = receipt_clock(receipt, now, self.state["b0"].get("created_utc"))
            return receipt_use_identity(receipt)
        if self.phase == "reopen":
            if getattr(self.ops, "unattended", False):
                # D1062: the record the verify phase wrote with its own browser login; the smoke member is gone.
                recorded = self.state.get("operator_smoke")
                require(recorded is not None, "Operator smoke record required")
                raw = self.records.read(self.records.directory / recorded["file"])
                require(sha256_bytes(raw) == recorded["sha256"], "Operator smoke record changed")
                operator_smoke_valid(decode(raw), self.plan_sha256)
                member = self.state.get("smoke_member")
                require(member is None or member.get("deleted_at"), "The smoke member still exists")
            else:
                require(type(self.evidence.get("operator-smoke")) is dict, "Operator smoke record required")
                operator_smoke_valid(self.evidence["operator-smoke"], self.plan_sha256)
        return None

    def steps_of(self, phase):
        for sid, name, mutating, db_change in STEPS[phase]:
            self.run_step(sid, name, mutating, db_change)

    # ── phases ──
    def phase_capture(self):
        fence = [item[1] for item in STEPS["capture"]].index("fence")
        try:
            for item in STEPS["capture"][:fence]:
                self.run_step(*item)
        except Stop:
            # Nothing was fenced yet (the pre-fence corrections keep the running configuration identical): free the lock
            # and leave the plan where it was.
            return self.finish(self.state["status"], False, release=True)
        except Unknown:
            return self.finish("NEEDS_ATTENTION", False)
        try:
            for item in STEPS["capture"][fence:]:
                self.run_step(*item)
        except Stop:
            if (not self.state.get("host_changed") and not self.state.get("fenced")
                    and self.steps[-1]["action"] == "fence" and not self.steps[-1]["action_started"]):
                return self.finish(self.state["status"], False, release=True)
            # The writers stay fenced: a failed capture is never "resumed" behind the operator's back.
            return self.finish("CAPTURE_FAILED", False)
        except Unknown:
            return self.finish("NEEDS_ATTENTION", False)
        return self.finish("HELD", True, extra={"b0": self.state["b0"]})

    def phase_release(self):
        try:
            for item in STEPS["release"]:
                if item[1] == "unfence":
                    self.state["ponr"] = {"step": item[0], "at": self.now().isoformat()}
                    self.save()
                self.run_step(*item)
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
            self.state["unknown_hold"] = {"step": "rollback-admission", "workers": alive, "request_sha256": self.request_sha256,
                                           "reason": "one-shot worker may be alive", "at": self.now().isoformat()}
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
                if item[1] == "restore_jobs":
                    # Scheduled writers can change the database before public ingress opens.
                    self.state["ponr"] = {"step": item[0], "at": self.now().isoformat()}
                    self.save()
                self.run_step(*item)
        except Unknown:
            return self.finish("NEEDS_ATTENTION", False)
        except Stop:
            return self.finish("NEEDS_ATTENTION" if self.state["ponr"] else "VERIFIED", False)
        return self.finish("DEPLOYED", True, release=True)

    def rollback_steps(self, explicit):
        """RB-00..RB-03 under the rollback budget. Automatic after a settled failure, or an explicit phase; once only.
        RB-00 only classifies (workers quiet, writers fenced) and changes no data: its refusal leaves the single attempt
        unused, so a rollback can be requested again once the worker has ended. From RB-01 on, a failure is final. A
        restored rollback keeps the maintenance ingress, the fenced jobs and the lock: RESTORED, not yet rolled back."""
        self.enter_recovery()
        try:
            self.run_step(*STEPS["rollback"][0])
        except (Stop, Unknown):
            return self.finish("NEEDS_ATTENTION", False,
                               extra={"rollback": "withheld: RB-00 refused (a worker may be alive or the database is not quiet)"})
        self.state["rollback_attempted"] = True
        self.save()
        try:
            for item in STEPS["rollback"][1:]:
                self.run_step(*item)
        except (Stop, Unknown):
            return self.finish("NEEDS_ATTENTION", False, extra={"rollback": "failed; maintenance and lock kept, no retry"})
        self.state["restored_at"] = self.now().isoformat()
        return self.finish("RESTORED", explicit,
                           extra={"rollback": "restored; the previous version stays behind the maintenance ingress until "
                                              "rollback_reopen passes its smoke with a login made after this restore",
                                  "data_restored": True, "recovery": self.state["recovery"], "bfail": self.state["bfail"]})

    def phase_rollback(self):
        return self.rollback_steps(explicit=True)

    def phase_rollback_reopen(self):
        """RB-04: the recovery mapping is what normal operations resolve, then the previous version's own login, worklist
        and frame through the maintenance ingress; only then the jobs and the public ingress, and the public smoke. A
        refusal before the ingress opens keeps RESTORED (fence and lock kept; a corrected request may follow)."""
        opened = bool(self.state.get("recovery_reopen"))
        try:
            for item in STEPS["rollback_reopen"]:
                if item[1] == "restore_jobs_after_rollback":
                    opened = True
                    self.state["recovery_reopen"] = {"step": item[0], "at": self.now().isoformat()}
                    self.save()
                self.run_step(*item)
        except Unknown:
            return self.finish("NEEDS_ATTENTION", False, extra={"rollback": "복구 재개 상태 불명: 자료와 잠금을 보존했습니다"})
        except Stop:
            return self.finish("NEEDS_ATTENTION" if opened else "RESTORED", False,
                               extra={"rollback": "previous-version smoke or reopen failed; " +
                                                  ("ingress was opened" if opened else "ingress stays closed, lock kept")})
        return self.finish("ROLLED_BACK", True, release=True,
                           extra={"rollback": "completed", "recovery": self.state["recovery"], "smoke": self.state["rollback_smoke"]})

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
        except Unknown:
            return self.finish("NEEDS_ATTENTION", False)
        except Stop:
            return self.finish("ROLLED_BACK", False, release=True)
        return self.finish("RECEIPTED", True, release=True, extra={"receipt": self.state["receipt"]})


def make_receipt(intro):
    """The rehearsal's local-restore receipt, from its own durable history and artifacts only (see receipt_valid)."""
    state, plan = intro.state, intro.plan
    phases = {}
    for item in state["history"]:
        if item["phase"] in RECEIPT_PHASES and item["status"] == "PASS":
            phases[item["phase"]] = {"request_sha256": item["request_sha256"], "result_sha256": item["result_sha256"],
                                     "seconds": item["seconds"], "steps": item["steps"]}
    require(set(phases) == set(RECEIPT_PHASES), "The rehearsal did not pass every phase")
    require(state["b0"] and state["b1"] and state["seed"] and state["bfail"] and state["recovery"] and state["rollback_smoke"]
            and state["probe"], "Rehearsal snapshots missing")
    journal = intro.records.read(intro.records.directory / "journal.jsonl")
    smoke_record = state["rollback_smoke"]
    return {"schema": 2, "kind": "local-restore", "passed": True, "receipt_id": uuid.uuid4().hex, "plan_core_sha256": plan_core(plan),
            "production_plan_sha256": plan["seed"]["production_plan_sha256"], "rehearsal_plan_sha256": intro.plan_sha256,
            "rehearsal_target_manifest_sha256": plan["target_manifest_sha256"],
            "source_b0_manifest_sha256": plan["seed"]["b0_manifest_sha256"],
            "rehearsal_b0_manifest_sha256": state["b0"]["manifest_sha256"], "rehearsal_b1_manifest_sha256": state["b1"]["manifest_sha256"],
            "bfail_manifest_sha256": state["bfail"]["manifest_sha256"], "tool": plan["tool"], "host_key_sha256": intro.host_key,
            "phases": phases,
            "evidence": {"seed": {"source_b0_manifest_sha256": state["seed"]["source_manifest_sha256"]},
                         "capture": {"b0_manifest_sha256": state["b0"]["manifest_sha256"],
                                     "restore_check": (state["b0"].get("restore_check") or {}).get("success") is True},
                         "verify": {"b1_manifest_sha256": state["b1"]["manifest_sha256"],
                                    "b1_restore_check": (state["b1"].get("restore_check") or {}).get("success") is True,
                                    "probe": {"added": state["probe"]["added"], "replay_duplicates": state["probe"]["replay_duplicates"],
                                              "restart": state["probe"]["restart"], "evidence_sha256": state["probe"]["evidence_sha256"]}},
                         "rollback": {"bfail_manifest_sha256": state["bfail"]["manifest_sha256"],
                                      "recovery": {key: state["recovery"][key] for key in ("project", "pg", "orthanc")}},
                         "rollback_reopen": {"recovery_persisted": state["recovery"].get("persisted") is True,
                                             "smoke": {key: smoke_record[key] for key in ("member", "token_after_restore", "worklist_uid",
                                                                                          "frame_sha256", "frame_bytes")}}},
            "journal_sha256": sha256_bytes(journal), "journal_bytes": len(journal), "created_utc": intro.now().isoformat()}


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


VARIABLE_BRACED = re.compile(r"(?<!\$)\$\{([A-Za-z_][A-Za-z0-9_]*)(:?[-?+])?")
VARIABLE_PLAIN = re.compile(r"(?<![$\w])\$([A-Za-z_][A-Za-z0-9_]*)")


def referenced_variables(texts):
    """{name: required} for every variable the compose files interpolate (comments ignored, $$ is a literal). Required
    means a value must exist: ${NAME}, ${NAME?..}, ${NAME:?..} or $NAME; a default or alternative form is not required."""
    names = {}
    for raw in texts:
        for line in raw.decode("utf-8").splitlines():
            line = re.sub(r"(^|\s)#.*$", r"\1", line)
            for match in VARIABLE_BRACED.finditer(line):
                required = match.group(2) in (None, "?", ":?")
                names[match.group(1)] = names.get(match.group(1), False) or required
            for match in VARIABLE_PLAIN.finditer(line):
                names[match.group(1)] = True
    return names


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
    # The clone's certificate volume is named outright, so a recovery project (after a rollback) keeps the same certificate.
    lines += ["networks:", "  workflow:", "    name: " + yaml_scalar(target["networks"]["workflow"]),
              "volumes:", "  rehearsal-workflow: {}", "  proxy-certs:", "    name: " + yaml_scalar(target["project"] + "_proxy-certs"), ""]
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
 const changes=(await db.providerChange.findMany({orderBy:{id:'asc'}})).map(c=>({kind:c.kind,target:c.kind==='credentials'?c.target:null,sub:c.sub,state:c.state}));
 const isolated=(await db.memberIsolation.findMany()).map(m=>m.sub).sort();
 process.stdout.write('KIN_RESULT '+JSON.stringify({markers,rights,legacy,changes,isolated})+'\n');})().catch(()=>{process.exitCode=1;}).finally(()=>db.$disconnect());
"""
SMOKE_MEMBERS_SQL = ("SELECT count(*) FROM user_entity u JOIN realm r ON r.id = u.realm_id "
                     "WHERE r.name = 'kin' AND u.username LIKE 'kin-smoke-%'")
SMOKE_ADMIN_SCRIPT = r"""
const base=(process.env.KC_ADMIN_URL||'').replace(/\/$/,'');
const [operation, raw]=process.argv.slice(1); const input=JSON.parse(raw);
const out=v=>process.stdout.write('KIN_RESULT '+JSON.stringify(v)+'\n');
// The parent also supervises this entire helper container. No request or readiness loop renews the attempt.
const end=Number(process.env.KIN_SMOKE_DEADLINE)||Date.now()+180000;
const left=()=>{const n=end-Date.now();if(n<=0)throw new Error('deadline');return n;};
const get=(url,options={})=>fetch(url,{...options,signal:AbortSignal.timeout(Math.max(1,Math.ceil(Math.min(15000,left()))))});
(async()=>{const form=new URLSearchParams({grant_type:'password',client_id:'admin-cli',username:process.env.KIN_KC_ADMIN_USER,password:process.env.KIN_KC_ADMIN_PASSWORD});
 // Keycloak may still be starting (writers resumed a moment ago, or a restore): ready means the realm kin answers 200 -
 // a 404 while it loads its realms is not ready (D18) - then the administrator's token; at most two minutes each.
 const until=async probe=>{for(let i=0;i<60;i++){left();try{const v=await probe();if(v)return v;}catch(e){}await new Promise(r=>setTimeout(r,Math.min(2000,left())));}return null;};
 if(!await until(async()=>(await get(base+'/realms/kin')).status===200))throw new Error('keycloak not ready');
 const granted=await until(async()=>{const r=await get(base+'/realms/master/protocol/openid-connect/token',{method:'POST',body:form});
  return r.status<500&&r.status!==404?r:null;});
 if(!granted)throw new Error('keycloak unreachable');
 if(granted.status!==200)throw new Error('admin');
 const token=(await granted.json()).access_token;
 const call=async(method,path,body)=>{const r=await get(base+'/admin/realms/kin'+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
   body:body===undefined?undefined:JSON.stringify(body)});if(r.status===404)return null;if(r.status>=300)throw new Error(method+' '+r.status);
   const text=await r.text();return text?JSON.parse(text):null;};
 // IRT2-23: this run's own objects carry its marker (the member's last name, each client's description); a same-named
 // account or client without it was not made here and is never changed or deleted.
 const mine=u=>!!input.marker&&u.lastName===input.marker;
 const mineClient=c=>!!input.marker&&c.description==='kin-smoke '+input.marker;
 const users=async()=>((await call('GET','/users?exact=true&username='+encodeURIComponent(input.username)))||[]).filter(u=>u.username===input.username);
 // One login client per attempt (a retry makes its own): the removal names every one of them.
 const ids=input.client_ids||(input.client_id?[input.client_id]:[]);
 const clients=async()=>{const out=[];for(const id of ids){out.push(...(((await call('GET','/clients?clientId='+encodeURIComponent(id)))||[]).filter(c=>c.clientId===id)));}return out;};
 if(operation==='create-member'){
  if(!input.marker)throw new Error('marker');
  if((await users()).length)throw new Error('exists');
  await call('POST','/users',{username:input.username,email:input.username+'@kin-smoke.invalid',enabled:true,emailVerified:true,
   firstName:'Release',lastName:input.marker,requiredActions:[]});
  const [user]=(await users()).filter(mine);
  if(!user)throw new Error('ownership');
  await call('PUT','/users/'+user.id+'/reset-password',{type:'password',value:process.env.KIN_SMOKE_PASSWORD,temporary:false});
  const roles=[];for(const name of input.roles){roles.push(await call('GET','/roles/'+encodeURIComponent(name)));}
  if(roles.some(r=>!r))throw new Error('role');
  await call('POST','/users/'+user.id+'/role-mappings/realm',roles);
  const group=((await call('GET','/groups?exact=true&search='+encodeURIComponent(input.group)))||[]).find(g=>g.name===input.group);
  if(!group)throw new Error('group');
  await call('PUT','/users/'+user.id+'/groups/'+group.id);
  out({id:user.id,username:user.username});return;}
 if(operation==='create-client'){
  if(!input.marker)throw new Error('marker');
  if((await clients()).length)throw new Error('exists');
  await call('POST','/clients',{clientId:input.client_id,description:'kin-smoke '+input.marker,enabled:true,publicClient:true,standardFlowEnabled:true,
   directAccessGrantsEnabled:false,protocol:'openid-connect',redirectUris:[input.redirect_uri],attributes:{'pkce.code.challenge.method':'S256'},
   protocolMappers:[{name:'kin-api-audience',protocol:'openid-connect',protocolMapper:'oidc-audience-mapper',config:{'included.custom.audience':'kin-api','access.token.claim':'true','id.token.claim':'false'}},
    {name:'kin-institution-groups',protocol:'openid-connect',protocolMapper:'oidc-group-membership-mapper',config:{'full.path':'false','access.token.claim':'true','id.token.claim':'false','userinfo.token.claim':'false','claim.name':'groups'}},
    {name:'kin-authentication-time',protocol:'openid-connect',protocolMapper:'oidc-usersessionmodel-note-mapper',config:{'user.session.note':'AUTH_TIME','claim.name':'auth_time','jsonType.label':'long','access.token.claim':'true','id.token.claim':'true'}}]});
  const [client]=(await clients()).filter(mineClient);
  if(!client)throw new Error('ownership');
  out({id:client.id,client_id:client.clientId});return;}
 if(operation==='owned'){
  out({users:(await users()).filter(mine).map(u=>u.id),clients:(await clients()).filter(mineClient).map(c=>c.id)});return;}
 if(operation==='remove'){
  const found=await users(),listed=await clients();
  if(found.filter(mine).some(u=>!(input.user_ids||[]).includes(u.id))||listed.filter(mineClient).some(c=>!(input.object_ids||[]).includes(c.id)))throw new Error('ownership');
  for(const user of found.filter(mine)){await call('PUT','/users/'+user.id,{enabled:false});await call('DELETE','/users/'+user.id);}
  for(const client of listed.filter(mineClient)){await call('DELETE','/clients/'+client.id);}
  out({user_absent:(await users()).filter(mine).length===0,client_absent:(await clients()).filter(mineClient).length===0,
   foreign_users:found.filter(u=>!mine(u)).length,foreign_clients:listed.filter(c=>!mineClient(c)).length});return;}
 throw new Error('operation');
})().catch(e=>{process.stderr.write(String((e&&e.message)||e).slice(0,80)+'\n');process.exitCode=1;});
"""
# The realm's own role and group definitions (read-only, Keycloak database): the import must not change them.
REALM_DEFINITIONS_SQL = """SELECT json_build_object(
  'roles', (SELECT coalesce(json_agg(k.name ORDER BY k.name), '[]'::json) FROM keycloak_role k WHERE k.realm_id = r.id AND NOT k.client_role),
  'groups', (SELECT coalesce(json_agg(g.name ORDER BY g.name), '[]'::json) FROM keycloak_group g WHERE g.realm_id = r.id))
  FROM realm r WHERE r.name = 'kin'"""
# D02: what the smoke member's creation needs from the realm, read before the fence: its realm roles and the top-level
# groups (the administration script finds the member's group among the top-level groups; Keycloak marks one by an
# empty or blank parent).
def smoke_password():
    # The fixed prefix supplies all supported character classes; the random part remains at least 256 bits.
    return "Aa0!" + token_source.token_urlsafe(32)


def smoke_policy_valid(policy):
    require_smoke(type(policy) is dict and type(policy.get("browserFlow")) is str and policy["browserFlow"]
                  and type(policy.get("requiredActions")) is list and type(policy.get("executions")) is list
                  and type(policy.get("passwordPolicy")) is str, "realm의 smoke 로그인 정책을 읽지 못했습니다")
    require_smoke(all(type(row) is dict and (row.get("enabled") is not True or row.get("defaultAction") is not True)
                      for row in policy["requiredActions"]), "smoke 계정에 기본 required action이 적용됩니다")
    executions = policy["executions"]
    require_smoke(executions, "browser flow 실행 정책이 비어 있습니다")
    password_login = False
    conditional = {}
    allowed = {"auth-cookie", "auth-username-password-form", "identity-provider-redirector", "conditional-user-configured", "auth-otp-form"}
    for index, row in enumerate(executions):
        require_smoke(type(row) is dict and type(row.get("level")) is int and row.get("requirement") in
                      ("DISABLED", "REQUIRED", "ALTERNATIVE", "CONDITIONAL"), "browser flow 실행 정책이 불완전합니다")
        level = row["level"]
        conditional = {key: value for key, value in conditional.items() if key < level}
        if row["requirement"] == "DISABLED":
            conditional[level] = "disabled"
            continue
        if "disabled" in conditional.values():
            continue
        if row.get("authenticationFlow") is True:
            if row["requirement"] == "CONDITIONAL":
                children = []
                for child in executions[index + 1:]:
                    if child.get("level", -1) <= level:
                        break
                    children.append(child)
                require_smoke(any(child.get("level") == level + 1 and child.get("providerId") == "conditional-user-configured"
                                  and child.get("requirement") == "REQUIRED"
                                  for child in children), "조건부 인증을 새 smoke 계정에 적용하지 않음을 증명할 수 없습니다")
                conditional[level] = "unconfigured"
            continue
        if row.get("providerId") == "organization":
            require_smoke("unconfigured" in conditional.values() and policy.get("organizationsEnabled") is False
                          and not row.get("authenticationConfig"), "조직 인증의 smoke 로그인 경계를 확인하지 못했습니다")
            continue
        if row.get("providerId") == "conditional-credential":
            # Keycloak 26.7's additional AND condition cannot enable a subflow whose required user-configured
            # condition is false for the fresh member. Its config may only narrow that already-disabled branch.
            require_smoke("unconfigured" in conditional.values() and row["requirement"] == "REQUIRED",
                          "credential 조건이 새 smoke 계정에 적용되지 않음을 증명할 수 없습니다")
            continue
        require_smoke(row.get("providerId") in allowed and not row.get("authenticationConfig"), "지원하지 않는 browser 인증 정책입니다")
        if row.get("providerId") == "auth-username-password-form":
            require_smoke("unconfigured" not in conditional.values(), "조건부 비밀번호 인증은 지원하지 않습니다")
            password_login |= row["requirement"] == "REQUIRED"
        if row.get("providerId") == "auth-otp-form":
            require_smoke("unconfigured" in conditional.values(), "smoke 계정에 OTP가 필수입니다")
    require_smoke(password_login, "browser flow에 지원하는 비밀번호 로그인이 없습니다")
    password = smoke_password()
    for token in policy["passwordPolicy"].split(" and ") if policy["passwordPolicy"] else []:
        match = re.fullmatch(r"([A-Za-z]+)\(([0-9]*)\)", token.strip())
        require_smoke(match is not None, "비밀번호 정책을 해석할 수 없습니다")
        name, raw = match.groups()
        limit = int(raw) if raw else 0
        counts = {"length": len(password), "digits": 1, "lowerCase": 1, "upperCase": 1, "specialChars": 1}
        require_smoke(name in {*counts, "maxLength", "notUsername", "notEmail", "hashIterations", "passwordHistory"},
                      "지원하지 않는 비밀번호 정책입니다")
        require_smoke((name not in counts or limit <= counts[name]) and (name != "maxLength" or limit >= len(password)),
                      "생성 smoke 비밀번호가 realm 정책을 충족하지 않습니다")
    return {"browserFlow": policy["browserFlow"], "password_policy": "compatible", "required_actions": "none"}


SMOKE_REALM_SQL = """SELECT json_build_object(
  'roles', (SELECT coalesce(json_agg(k.name ORDER BY k.name), '[]'::json) FROM keycloak_role k WHERE k.realm_id = r.id AND NOT k.client_role),
  'top_level_groups', (SELECT coalesce(json_agg(g.name ORDER BY g.name), '[]'::json) FROM keycloak_group g
    WHERE g.realm_id = r.id AND (g.parent_group IS NULL OR btrim(g.parent_group) = '')))
  FROM realm r WHERE r.name = 'kin'"""
SERVERINFO_SCRIPT = r"""
const base=(process.env.KC_ADMIN_URL||'').replace(/\/$/,'');
const get=(url,options={})=>fetch(url,{...options,signal:AbortSignal.timeout(15000)});
(async()=>{const form=new URLSearchParams({grant_type:'password',client_id:'admin-cli',username:process.env.KIN_KC_ADMIN_USER,password:process.env.KIN_KC_ADMIN_PASSWORD});
 // Its own readiness (D19): the master realm answers 200 (a 404 while Keycloak loads is not ready), then the token, then
 // serverinfo answers 200; a refused administrator stops at once; at most two minutes each.
 const until=async probe=>{for(let i=0;i<60;i++){try{const v=await probe();if(v)return v;}catch(e){if(e&&e.refused)throw e;}
  await new Promise(r=>setTimeout(r,2000));}return null;};
 if(!await until(async()=>(await get(base+'/realms/master')).status===200))throw new Error('keycloak not ready');
 const granted=await until(async()=>{const r=await get(base+'/realms/master/protocol/openid-connect/token',{method:'POST',body:form});
  return r.status<500&&r.status!==404?r:null;});
 if(!granted)throw new Error('keycloak unreachable');
 if(granted.status!==200)throw new Error('admin');
 const t=await granted.json();
 const answered=await until(async()=>{const r=await get(base+'/admin/serverinfo',{headers:{Authorization:'Bearer '+t.access_token}});
  if(r.status===401||r.status===403)throw Object.assign(new Error('serverinfo'),{refused:true});return r.status===200?r:null;});
 if(!answered)throw new Error('serverinfo');
 const info=await answered.json();
 const caches=info?.providers?.userSessions?.providers?.infinispan?.operationalInfo?.useCaches;
 const features=Array.isArray(info.features)?info.features:[];
 const persistent=features.find(f=>f&&f.name==='PERSISTENT_USER_SESSIONS');
 const read=async path=>{const r=await get(base+'/admin/realms/kin'+path,{headers:{Authorization:'Bearer '+t.access_token}});
   if(r.status!==200)throw new Error('smoke policy');return r.json();};
 const realm=await read('');
 const requiredActions=await read('/authentication/required-actions');
 const executions=await read('/authentication/flows/'+encodeURIComponent(realm.browserFlow)+'/executions');
 process.stdout.write('KIN_RESULT '+JSON.stringify({useCaches:caches===undefined?null:String(caches),persistentUserSessions:persistent?persistent.enabled===true:null,
   smokePolicy:{browserFlow:realm.browserFlow,passwordPolicy:realm.passwordPolicy||'',organizationsEnabled:realm.organizationsEnabled,requiredActions,executions}})+'\n');
})().catch(e=>{process.stderr.write(String((e&&e.message)||e).slice(0,80)+'\n');process.exitCode=1;});
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


class _ProcessTree:
    """Windows suspended-create → Job assignment → resume; breakaway is never enabled."""

    def __init__(self, argv, **popen_options):
        self.job = None
        require(os.name == "nt", "Linux browser는 systemd cgroup 서비스가 필요합니다")
        import ctypes
        from ctypes import wintypes
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

        class Basic(ctypes.Structure):
            _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                        ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                        ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                        ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]

        class Extended(ctypes.Structure):
            _fields_ = [("BasicLimitInformation", Basic), ("IoInfo", ctypes.c_uint64 * 6), ("ProcessMemoryLimit", ctypes.c_size_t),
                        ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]
        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        kernel32.CreateJobObjectW.argtypes = (ctypes.c_void_p, ctypes.c_wchar_p)
        kernel32.SetInformationJobObject.argtypes = (wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD)
        kernel32.AssignProcessToJobObject.argtypes = (wintypes.HANDLE, wintypes.HANDLE)
        kernel32.TerminateJobObject.argtypes = (wintypes.HANDLE, wintypes.UINT)
        kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
        self.kernel32 = kernel32
        job = kernel32.CreateJobObjectW(None, None)
        if not job:
            raise OSError("job object")
        limits = Extended()
        limits.BasicLimitInformation.LimitFlags = 0x2000   # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not kernel32.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            kernel32.CloseHandle(job)
            raise OSError("job object limits")
        self.job = job
        options = {"stdin": subprocess.PIPE, "stdout": subprocess.PIPE, "stderr": subprocess.PIPE, **popen_options}
        try:
            self.process = subprocess.Popen(argv, **options, creationflags=0x00000004)   # CREATE_SUSPENDED
        except OSError:
            kernel32.CloseHandle(job)
            self.job = None
            raise
        ntdll = ctypes.WinDLL("ntdll")
        ntdll.NtResumeProcess.argtypes = (wintypes.HANDLE,)
        if not kernel32.AssignProcessToJobObject(job, int(self.process._handle)) or ntdll.NtResumeProcess(int(self.process._handle)) != 0:
            self.kill()
            raise OSError("job assignment")

    def kill(self):
        """Every process of the tree ends (a no-op when none is left)."""
        if os.name == "posix":
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        elif self.job:
            self.kernel32.TerminateJobObject(self.job, 1)
        if self.process.poll() is None:
            try:
                self.process.kill()
            except OSError:
                pass

    def remaining(self):
        """How many processes of the tree still run (zombies waiting for a reaper do not run)."""
        if os.name == "posix":
            proc = Path("/proc")
            if not proc.is_dir():
                try:
                    os.killpg(self.process.pid, 0)
                    return 1
                except (ProcessLookupError, PermissionError):
                    return 0
            count = 0
            for entry in proc.iterdir():
                if entry.name.isdigit():
                    try:
                        fields = (entry / "stat").read_text().rsplit(") ", 1)[1].split()
                    except (OSError, IndexError):
                        continue
                    if fields[0] != "Z" and int(fields[2]) == self.process.pid:
                        count += 1
            return count
        if not self.job:
            return 0
        import ctypes
        from ctypes import wintypes

        class Accounting(ctypes.Structure):
            _fields_ = [("Times", ctypes.c_int64 * 4), ("TotalPageFaultCount", wintypes.DWORD), ("TotalProcesses", wintypes.DWORD),
                        ("ActiveProcesses", wintypes.DWORD), ("TotalTerminatedProcesses", wintypes.DWORD)]
        info = Accounting()
        self.kernel32.QueryInformationJobObject.argtypes = (wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p)
        if not self.kernel32.QueryInformationJobObject(self.job, 1, ctypes.byref(info), ctypes.sizeof(info), None):
            return 1
        return int(info.ActiveProcesses)

    def gone(self, seconds=10):
        """IRT2-13: after the kill, every process of the tree is observed gone within the time (then the job closes)."""
        deadline = time.monotonic() + seconds
        while self.remaining() and time.monotonic() < deadline:
            self.kill()
            time.sleep(0.2)
        done = self.remaining() == 0
        if os.name != "posix" and self.job and done:
            self.kernel32.CloseHandle(self.job)
            self.job = None
        return done


def run_tree(argv, *, input, timeout, deadline=None, **popen_options):
    """Run a command with its input; on its timeout - and after it ended, for whatever it left running - kill its whole
    process tree (D17). Returns (exit code, stdout, stderr) or raises subprocess.TimeoutExpired once the tree is gone."""
    end = deadline if deadline is not None else time.monotonic() + timeout + SMOKE_CLEANUP_S
    tree = _ProcessTree(argv, **popen_options)
    try:
        try:
            stdout, stderr = tree.process.communicate(input, timeout=min(timeout, max(0, end - time.monotonic())))
        except subprocess.TimeoutExpired:
            tree.kill()
            try:
                tree.process.communicate(timeout=max(0, end - time.monotonic()))
            except (subprocess.TimeoutExpired, ValueError, OSError):
                pass
            raise subprocess.TimeoutExpired(argv, timeout) from None
        return tree.process.returncode, stdout, stderr
    finally:
        tree.kill()
        # A reader thread may hold a pipe lock while a surviving descendant keeps the pipe open. Closing that
        # stream first would wait without a timeout and hide UNKNOWN behind the blocked close.
        if not tree.gone(seconds=max(0, end - time.monotonic())) or tree.process.poll() is None:
            raise Unknown("smoke Job 전체 종료·직접 자식 회수를 확인하지 못했습니다")
        for stream in (tree.process.stdout, tree.process.stderr, tree.process.stdin):
            try:
                if stream:
                    stream.close()
            except OSError:
                pass


class SystemdBrowser:
    """A named service owned by PID 1, including detached Chromium descendants.

    No shell or caller-selected systemd command is accepted. RuntimeMaxSec remains effective if the entry dies.
    Terminal unit identity, cgroup emptiness and /proc identities (including zombies) must agree before cleanup.
    """

    PROPERTIES = ("Id", "InvocationID", "LoadState", "ActiveState", "SubState", "Result", "ExecMainCode",
                  "ExecMainStatus", "ExecMainPID", "ControlGroup", "Type", "ExitType", "KillMode", "Restart")

    def __init__(self, worker, records, save, budget):
        self.worker, self.records, self.save, self.budget = worker, records, save, budget
        self.unit = worker["resource"]
        require(re.fullmatch(r"kin-browser-[0-9a-f]{32}\.service", self.unit), "browser unit 이름이 허용 범위 밖입니다")

    @staticmethod
    def command(argv):
        require(os.name == "posix" and os.geteuid() == 0 and Path("/run/systemd/system").is_dir()
                and Path("/sys/fs/cgroup/cgroup.controllers").is_file(), "root systemd/cgroup v2 실행 환경이 필요합니다")
        args = list(argv)
        browsers = None
        if args[:1] == ["/usr/bin/env"]:
            args.pop(0)
            if args[:1] == ["-i"]:
                args.pop(0)
            require(args and args[0].startswith("PLAYWRIGHT_BROWSERS_PATH="), "browser 환경은 설치 경로만 선언할 수 있습니다")
            browsers = args.pop(0).split("=", 1)[1]
        require(len(args) == 3 and args[-1] == "browser-smoke", "보호 설치 Python browser-smoke 명령이 필요합니다")
        require(re.fullmatch(r"python(?:3(?:\.\d+)?)?", Path(args[0]).name), "browser 실행기는 설치된 Python이어야 합니다")
        import ops_deploy_host as protected_host
        for path in args[:2]:
            require(Path(path).is_absolute(), "browser 실행 경로는 절대 경로여야 합니다")
            protected_host.protected(Path(path).resolve())
        require(Path(args[1]).resolve() == Path(__file__).resolve(), "browser 모듈이 보호 설치 도구와 다릅니다")
        require(browsers is not None and Path(browsers).is_absolute(), "Chromium 설치 경로를 명시해야 합니다")
        protected_host.protected(Path(browsers), directory=True)
        return ["/usr/bin/env", "-i", "PATH=/usr/bin:/bin", "HOME=/nonexistent",
                "PLAYWRIGHT_BROWSERS_PATH=" + browsers, *args]

    def supervisor_timeout(self, cap):
        """A supervisor command's own bound: its cap, within the attempt's cleanup end. The browser's work deadline is
        not this command's deadline: a query issued just before it would otherwise time out early and turn an ordinary
        browser timeout into an unconfirmed supervisor (R4-03). The work deadline is enforced between observations."""
        left = self.budget.end - time.monotonic()
        require(left > 0, "smoke 정리·종료 확인의 공통 제한 시간이 지났습니다")
        return min(cap, left)

    def control(self, operation, *options):
        require(operation in ("show", "stop", "kill", "reset-failed"), "허용되지 않은 browser 감독 명령입니다")
        try:
            result = subprocess.run(["/usr/bin/systemctl", operation, *options, self.unit],
                                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    env={"PATH": "/usr/bin:/bin", "LANG": "C"}, timeout=self.supervisor_timeout(5))
            require(result.returncode == 0, "browser 감독 명령이 실패했습니다")
            return result
        except Exception as error:
            self.record_error("systemctl-" + operation, error)
            raise Unknown("browser 감독 명령의 결과를 확인하지 못했습니다") from None

    def record_error(self, location, error):
        observation = {"location": location, "type": type(error).__name__,
                       "errno": getattr(error, "errno", None), "at": utc_now().isoformat()}
        self.worker.setdefault("observation_error", observation)
        self.worker.setdefault("observation_errors", []).append(observation)
        self.save()

    def observe(self):
        result = self.control("show", "--property=" + ",".join(self.PROPERTIES))
        require(result.returncode == 0, "browser 서비스 조회가 실패했습니다")
        values = dict(line.split("=", 1) for line in result.stdout.decode().splitlines() if "=" in line)
        require(set(values) == set(self.PROPERTIES) and values["Id"] == self.unit
                and values["LoadState"] == "loaded" and re.fullmatch(r"[0-9a-f]{32}", values["InvocationID"]),
                "browser 서비스 신원을 확인하지 못했습니다")
        require((values["Type"], values["ExitType"], values["KillMode"], values["Restart"]) ==
                ("exec", "cgroup", "control-group", "no"), "browser 서비스 종료 계약이 다릅니다")
        previous = self.worker.get("invocation_id")
        require(previous in (None, values["InvocationID"]), "browser 서비스가 다른 실행으로 교체됐습니다")
        self.worker["invocation_id"] = values["InvocationID"]
        self.save()
        group = "/system.slice/" + self.unit
        require(values["ControlGroup"] in ("", group), "browser cgroup 경로가 선언과 다릅니다")
        path = Path("/sys/fs/cgroup") / group.lstrip("/")
        terminal = values["SubState"] in ("exited", "failed", "dead") and int(values["ExecMainCode"]) in (1, 2, 3)
        try:
            events = dict(line.split() for line in (path / "cgroup.events").read_text().splitlines())
            require(events.get("populated") in ("0", "1"), "browser cgroup 상태가 불완전합니다")
            empty = events["populated"] == "0"
        except FileNotFoundError:
            # The cgroup can disappear before systemd publishes the terminal result. Keep waiting within the same
            # deadline; absence alone never proves quiet, and the invocation identity above must still match.
            empty = terminal
        except OSError as error:
            if error.errno == errno.ENODEV:
                # kernfs can retire an already-open node before its path disappears. Require a fresh observation;
                # this error alone proves neither absence nor emptiness, even when systemd already says terminal.
                empty = False
                self.worker["cgroup_read_retry"] = {
                    "count": self.worker.get("cgroup_read_retry", {}).get("count", 0) + 1,
                    "location": "cgroup-events", "type": type(error).__name__, "errno": error.errno,
                    "at": utc_now().isoformat(),
                }
            else:
                self.record_error("cgroup-events", error)
                raise
        # cgroup.procs/populated omit zombies. Scan their retained membership as well; PID reuse is distinguished by
        # starttime and never used to infer the status of the service itself.
        tracked = dict(self.worker.get("pids", {}))
        current = {}
        for entry in Path("/proc").iterdir():
            self.budget.remaining()
            if not entry.name.isdigit():
                continue
            try:
                membership = (entry / "cgroup").read_text()
                belongs = any(line.removesuffix(" (deleted)").removeprefix("0::") in (group,)
                              or line.removeprefix("0::").startswith(group + "/") for line in membership.splitlines())
                if belongs or entry.name in tracked:
                    fields = (entry / "stat").read_text().rsplit(") ", 1)[1].split()
                    start = fields[19]
                    if belongs:
                        tracked[entry.name] = start
                    if belongs or tracked.get(entry.name) == start:
                        current[entry.name] = start
            except (FileNotFoundError, ProcessLookupError):
                if entry.name in tracked:
                    try:
                        start = (entry / "stat").read_text().rsplit(") ", 1)[1].split()[19]
                        if tracked[entry.name] == start:
                            current[entry.name] = start
                    except (FileNotFoundError, ProcessLookupError):
                        pass
            except OSError as error:
                self.record_error("proc-observation", error)
                raise
        self.worker.update(invocation_id=values["InvocationID"], cgroup=group, pids=tracked,
                           unit_result=values["Result"], main_code=int(values["ExecMainCode"]),
                           main_status=int(values["ExecMainStatus"]), terminal=terminal, populated=not empty,
                           unreaped=sorted(current))
        self.save()
        return terminal and empty and not current

    def terminate(self):
        with self.budget.cleanup():
            # Retain the terminal unit until its identity/result have been recorded. RuntimeMaxSec also applies
            # independently; an explicit stop here could unload an inactive transient unit before observation.
            if self.observe():
                return
            stopped = self.control("kill", "--kill-whom=all", "--signal=TERM")
            require(stopped.returncode == 0, "browser 서비스 정지 요청이 실패했습니다")
            term_until = min(time.monotonic() + 5, self.budget.end)
            killed = False
            while True:
                if self.observe():
                    return
                if time.monotonic() >= term_until and not killed:
                    killed = True
                    result = self.control("kill", "--kill-whom=all", "--signal=KILL")
                    require(result.returncode == 0, "browser 서비스 전체 종료 요청이 실패했습니다")
                time.sleep(min(0.1, self.budget.remaining()))

    def run(self, argv, payload):
        command = self.command(argv)
        files = {key: self.unit + "." + key for key in ("in", "out", "err")}
        for key, name in files.items():
            self.records.write_secret(name, payload if key == "in" else b"")
        self.worker.update(supervisor="systemd-cgroup-v2", private_files=files,
                           profile=self.worker.get("profile"), work_deadline=self.budget.work_end,
                           cleanup_deadline=self.budget.end)
        self.save()
        def escaped(name):
            value = str(self.records.secret(name))
            require(not any(c in value for c in '\n\r\x00"\\'), "browser 작업 파일 경로가 지원되지 않습니다")
            return value.replace("%", "%%")
        properties = ["ExitType=cgroup", "KillMode=control-group", "SendSIGKILL=yes", "Restart=no",
                      "RemainAfterExit=yes", "TimeoutStopSec=5s", "UMask=0077",
                      "RuntimeMaxSec=%.6fs" % self.budget.remaining(),
                      "StandardInput=file:" + escaped(files["in"]), "StandardOutput=file:" + escaped(files["out"]),
                      "StandardError=file:" + escaped(files["err"])]
        launch = ["/usr/bin/systemd-run", "--quiet", "--unit=" + self.unit, "--service-type=exec"]
        launch += ["--property=" + prop for prop in properties]
        launch += ["--", *command]
        timed_out = False
        try:
            result = subprocess.run(launch, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    env={"PATH": "/usr/bin:/bin", "LANG": "C"}, timeout=self.supervisor_timeout(10))
            require(result.returncode == 0, "browser 서비스 시작이 실패했습니다")
            self.worker["launcher_reaped"] = True
            self.save()
            while not self.observe():
                time.sleep(min(0.1, self.budget.remaining()))
        except SmokeDeadline:
            timed_out = True
            self.terminate()
        except Exception as error:
            self.record_error("browser-launch-or-observe", error)
            raise Unknown("browser 실행·관측의 결과가 불명확합니다") from None
        # Preserve terminal result before releasing the retained unit. No profile or input is deleted by the child.
        with self.budget.cleanup():
            if not self.observe():
                raise Unknown("browser 서비스 전체 종료를 확인하지 못했습니다")
            code = self.worker["main_status"] if self.worker["main_code"] == 1 else 128 + self.worker["main_status"]
            # The main process can succeed while another cgroup member is OOM-killed or the unit fails.
            if self.worker["unit_result"] != "success" and code == 0:
                code = 1
            stdout, stderr = (self.records.read_secret(files[k]) for k in ("out", "err"))
            released = self.control("stop")
            require(released.returncode == 0, "종료된 browser 서비스 정리를 확인하지 못했습니다")
            # Stopping also clears a failed unit and may unload this transient service. A second reset would address
            # a unit that no longer exists; its terminal result and whole-tree termination were recorded above.
            for name in files.values():
                self.records.discard_secret(name)
        if timed_out or self.worker["unit_result"] == "timeout":
            raise BrowserTimeout(argv, 0)
        return code, stdout, stderr


def follow_folder_owner(path):
    """A file root wrote into a folder an operating account owns (a capture given to that account) becomes that account's
    too (IRT2-03); elsewhere nothing changes."""
    if os.name != "posix" or os.geteuid() != 0:
        return
    folder = os.stat(Path(path).parent)
    if folder.st_uid != 0:
        os.chown(path, folder.st_uid, folder.st_gid, follow_symlinks=False)


def remove_profile(path, seconds=15):
    """A browser profile folder (a member's session cookies) goes once its browser has ended; on Windows a killed
    browser's files may stay locked for a moment, so the removal is retried for a bounded time."""
    deadline = time.monotonic() + seconds
    while True:
        shutil.rmtree(path, ignore_errors=True)
        if not Path(path).exists() or time.monotonic() >= deadline:
            break
        time.sleep(min(0.1, max(0, deadline - time.monotonic())))
    require(not Path(path).exists(), "The browser profile could not be removed")


def engine_transport(command, request, timeout, *, cwd, env):
    """Keep the HTTP connection open through its response/upgrade before half-closing exec input.

    Closing dial-stdio stdin together with the request cancels Docker Desktop's named-pipe proxy before the
    HTTP handler starts. A single owned CLI carries the handshake and stream; its deadline includes reaping.
    """
    import threading
    tree = _ProcessTree(command, cwd=cwd, env=env) if os.name == "nt" else None
    process = tree.process if tree else subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.PIPE,
                                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    result, failed = [], []
    end = time.monotonic() + timeout
    def exchange():
        try:
            header, payload = request.split(b"\r\n\r\n", 1)
            length = int(next(line.split(b":", 1)[1] for line in header.split(b"\r\n") if line.lower().startswith(b"content-length:")))
            process.stdin.write(header + b"\r\n\r\n" + payload[:length])
            process.stdin.flush()
            class PipeSocket:
                def makefile(self, *args):
                    return process.stdout
            response = http.client.HTTPResponse(PipeSocket())
            response.begin()
            if response.status == 101:
                process.stdin.write(payload[length:])
                process.stdin.flush()
                process.stdin.close()
                body = response.fp.read()
            else:
                body = response.read()
                process.stdin.close()
            result.append((f"HTTP/1.1 {response.status} response\r\nContent-Length: {len(body)}\r\n\r\n").encode() + body)
        except BaseException as error:
            failed.append(error)
    thread = threading.Thread(target=exchange, daemon=True)
    thread.start()
    thread.join(max(0, end - time.monotonic()))
    try:
        if thread.is_alive():
            raise Unknown("Engine HTTP 응답·stream 종료가 제한 시간 안에 확인되지 않았습니다")
        if failed:
            raise failed[0]
        process.wait(timeout=max(0.01, end - time.monotonic()))
        return subprocess.CompletedProcess(command, process.returncode, result[0], process.stderr.read())
    finally:
        if tree:
            tree.kill()
            if not tree.gone(seconds=max(0, end - time.monotonic())):
                raise Unknown("Engine 전송 CLI Job의 전체 종료를 확인하지 못했습니다")
        elif process.poll() is None:
            process.kill()
        try:
            process.wait(timeout=max(0.01, end - time.monotonic()))
        except subprocess.TimeoutExpired:
            raise Unknown("Engine 전송 CLI 회수를 확인하지 못했습니다") from None
        thread.join(max(0, end - time.monotonic()))
        if thread.is_alive():
            raise Unknown("Engine 전송 stream의 종료가 미결입니다")
        for pipe in (process.stdin, process.stdout, process.stderr):
            if pipe and not pipe.closed:
                pipe.close()


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
        if args[:2] == ["docker", "compose"]:
            # Compose must never inherit interpolation or COMPOSE_* values from the launcher's shell.
            environment = compose_environment(env)
        identity = {}
        if args[0] == "git":
            command = [command[0], "-c", "core.hooksPath=" + os.devnull, "-c", "core.fsmonitor=false", *command[1:]]
            if self.owner:
                identity = {"user": self.owner["uid"], "group": self.owner["gid"], "extra_groups": []}
        if args[:3] == ["docker", "system", "dial-stdio"]:
            return engine_transport(command, input, timeout, cwd=self.cwd, env=environment)
        if os.name == "nt":
            # Docker's Compose plugin inherits the CLI's pipes. subprocess.run's Windows timeout kills only the
            # CLI and then drains those pipes without a deadline; keep both processes in the existing Job boundary.
            budget = _smoke_budget.get()
            code, stdout, stderr = run_tree(command, input=input, timeout=timeout,
                deadline=budget.end if budget else None, cwd=self.cwd, env=environment,
                stdin=subprocess.PIPE if input is not None else stdin, stdout=output or subprocess.PIPE,
                stderr=subprocess.PIPE, **identity)
            return subprocess.CompletedProcess(command, code, stdout, stderr)
        try:
            return subprocess.run(command, cwd=self.cwd, env=environment, input=input, stdin=stdin,
                                  stdout=output or subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, **identity)
        except subprocess.TimeoutExpired:
            # subprocess only reaps the direct CLI on POSIX. A Compose plugin can retain its pipes and keep acting;
            # without a whole-tree supervisor this transport cannot attest client termination or permit cancellation.
            raise Unknown("POSIX CLI timeout 뒤 plugin을 포함한 전체 종료를 확인하지 못했습니다") from None


def owned_private(path, owner, *, directory=False, private=False, own_mode=True, deferred=()):
    """The production checkout as the host keeps it: owned by its operating account (C1's own rule is root). Every
    ancestor is root's or that account's, none is a link or writable by others (a sticky directory excepted).
    own_mode=False leaves the path's own mode bits (and those of the deferred ancestors, e.g. the checkout above its
    .git) to a later check: a declared, recorded correction may come first. Owner and link rules still apply to all."""
    import stat as kinds
    path = Path(path)
    require(os.name == "posix" and os.geteuid() == 0 and path.is_absolute() and ".." not in path.parts, "Invalid protected path")
    later = {path, *map(Path, deferred)} if not own_mode else set()
    for item in reversed((path, *path.parents)):
        info = item.lstat()
        require(not kinds.S_ISLNK(info.st_mode) and info.st_uid in (0, owner["uid"]), "A path component is a link or has another owner")
        if item in later:
            continue
        require(not info.st_mode & 0o022 or (item != path and kinds.S_ISDIR(info.st_mode) and info.st_mode & kinds.S_ISVTX),
                "A path component is writable by others")
    info = path.lstat()
    require(info.st_uid == owner["uid"], "Path is not owned by the repository account")
    require(kinds.S_ISDIR(info.st_mode) if directory else (kinds.S_ISREG(info.st_mode) and info.st_nlink == 1), "Unexpected file type")
    require(not private or not own_mode or not info.st_mode & 0o077, "Path is not private")
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


def set_env_line(raw, name, value, *, pattern=r"[A-Za-z0-9_.-]{1,128}"):
    """The .env bytes with exactly one NAME=value line for this name (any earlier one removed), everything else kept."""
    require(ops.ENV_NAME.fullmatch(name) is not None and re.fullmatch(pattern, value) is not None, "Invalid env line")
    kept = [line for line in raw.decode("utf-8").splitlines() if line.strip().split("=", 1)[0].strip() != name]
    return ("\n".join(kept) + "\n" + name + "=" + value + "\n").lstrip("\n").encode("utf-8")


# A compose file list as an .env value: paths without blanks, quotes or shell/Compose interpolation characters.
COMPOSE_FILE_VALUE = r"[A-Za-z0-9_./:;\\-]{1,2048}"


def declared_compose_file(target):
    """IRT2-10: the target's compose file list as Compose's COMPOSE_FILE value (this host's path separator). Written into
    the checkout's .env, it makes every ordinary `docker compose` in the checkout - an operator's recreate of the proxy
    after the release or after a rollback - use exactly the declared list, external overlay included."""
    value = os.pathsep.join(target["compose_files"])
    require(re.fullmatch(COMPOSE_FILE_VALUE, value) is not None, "The declared compose files cannot be named in COMPOSE_FILE")
    return value


def env_with_compose_file(raw, target):
    """The .env bytes naming the declared compose list (only when the target declares an external overlay)."""
    if not target["declared_overlays"]:
        return raw
    return set_env_line(raw, "COMPOSE_FILE", declared_compose_file(target), pattern=COMPOSE_FILE_VALUE)


def names_declared_list(raw, target):
    """Whether .env bytes already name the declared compose list (wherever the line stands), or need not."""
    return not target["declared_overlays"] or parse_env(raw).get("COMPOSE_FILE") == declared_compose_file(target)


def compose_environment(values=None):
    """Only OS transport necessities and the pinned interpolation values enter Compose."""
    if os.name == "posix":
        environment = {"PATH": "/usr/bin:/bin", "HOME": "/nonexistent", "LANG": "C.UTF-8",
                       "DOCKER_HOST": "unix:///var/run/docker.sock"}
    else:
        environment = {key: os.environ[key] for key in ("PATH", "SystemRoot", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP")
                       if key in os.environ}
    environment.update(values or {})
    return environment


class ComposeEntry:
    """C-COMPOSE: a closed, immutable generation outside the checkout and run/secret lifetimes.

    The pointer names a fully synced manifest. A partial generation can never become an implicit fallback. Source paths
    are audit identities only: every invocation reads the pinned bytes, private env and generated runtime override.
    """
    def __init__(self, root):
        self.root = Path(root).absolute()

    @staticmethod
    def protect(path, *, private=False):
        path = Path(path)
        require(path.is_absolute() and ".." not in path.parts, "Compose entry 경로가 절대 경로가 아닙니다")
        for part in (*reversed(path.parents), path):
            info = part.lstat()
            require(not stat_module.S_ISLNK(info.st_mode) and not (getattr(info, "st_file_attributes", 0) & 0x400),
                    "Compose entry 경로에 링크가 있습니다")
            if os.name == "posix":
                require(info.st_uid == 0 and not info.st_mode & 0o022, "Compose entry 조상의 root 소유권 또는 쓰기 권한이 잘못됐습니다")
        info = path.lstat()
        if private and os.name == "posix":
            require(not info.st_mode & 0o077, "Compose entry 비밀 파일이 다른 계정에 열려 있습니다")
        if not stat_module.S_ISDIR(info.st_mode):
            require(stat_module.S_ISREG(info.st_mode) and info.st_nlink == 1, "Compose entry 파일 종류 또는 hardlink가 잘못됐습니다")
        return path

    @staticmethod
    def sync(path):
        if os.name == "posix":
            fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)

    def write(self, path, raw):
        self.protect(path.parent, private=True)
        with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600), "wb") as out:
            out.write(raw)
            out.flush()
            os.fsync(out.fileno())

    def load(self, pointer=None):
        self.protect(self.root, private=True)
        pointer = pointer or decode(self.protect(self.root / "active.json", private=True).read_bytes())
        _keys(pointer, ("generation", "sha256"), "Compose entry pointer")
        _str(pointer["generation"], HASH, "Compose generation")
        _str(pointer["sha256"], HASH, "Compose manifest hash")
        directory = self.protect(self.root / pointer["generation"], private=True)
        raw = self.protect(directory / "manifest.json", private=True).read_bytes()
        require(sha256_bytes(raw) == pointer["sha256"], "Compose entry manifest 해시가 다릅니다")
        manifest = decode(raw)
        _keys(manifest, ("schema", "generation", "repository", "project", "logical_files", "files", "runtime", "plan_sha256"), "Compose manifest")
        require(type(manifest["schema"]) is int and manifest["schema"] == 1 and manifest["generation"] == pointer["generation"], "Compose entry 세대가 다릅니다")
        _str(manifest["project"], PROJECT, "Compose project")
        _str(manifest["plan_sha256"], HASH, "Compose plan")
        _abs(manifest["repository"], "Compose checkout")
        core = {name: manifest[name] for name in ("repository", "project", "logical_files", "files", "plan_sha256")}
        require(sha256_bytes(canonical(core)) == pointer["generation"], "Compose entry 내용과 세대 신원이 다릅니다")
        require(type(manifest["logical_files"]) is list and manifest["logical_files"], "Compose 논리 입력이 없습니다")
        require(type(manifest["files"]) is dict and {"environment.json", "inputs.env", "runtime.yml"} <= set(manifest["files"]),
                "Compose entry 구성 파일이 빠졌습니다")
        for name, digest in manifest["files"].items():
            require(Path(name).name == name and name not in (".", ".."), "Compose entry 파일명이 잘못됐습니다")
            data = self.protect(directory / name, private=True).read_bytes()
            require(sha256_bytes(data) == digest, "Compose entry 구성 파일 해시가 다릅니다")
        require(set(p.name for p in directory.iterdir()) == set(manifest["files"]) | {"manifest.json"}, "Compose entry에 미선언 파일이 있습니다")
        for item in manifest["logical_files"]:
            _keys(item, ("logical", "pinned", "sha256"), "Compose source")
            require(manifest["files"].get(item["pinned"]) == item["sha256"], "Compose 논리 입력과 고정 bytes가 다릅니다")
        require([item["pinned"] for item in manifest["logical_files"]] ==
                ["source-%02d.yml" % index for index in range(len(manifest["logical_files"]))], "Compose 고정 입력 순서가 다릅니다")
        require(set(manifest["files"]) == {"environment.json", "inputs.env", "runtime.yml"} |
                {item["pinned"] for item in manifest["logical_files"]}, "Compose 고정 파일 목록이 닫혀 있지 않습니다")
        require(manifest["runtime"] == {"pinned": "runtime.yml", "sha256": manifest["files"]["runtime.yml"]},
                "Compose runtime override 결속이 다릅니다")
        values = decode((directory / "environment.json").read_bytes())
        require(type(values) is dict and all(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", k) and type(v) is str and "\x00" not in v
                                            for k, v in values.items()), "Compose 환경 입력이 잘못됐습니다")
        require(not any(k.startswith("COMPOSE_") or k.startswith("DOCKER_") for k in values), "Compose 환경에 실행 제어 변수가 있습니다")
        return pointer, manifest, values

    def argv(self, args, pointer=None):
        pointer, manifest, values = self.load(pointer)
        directory = self.root / pointer["generation"]
        command = ["docker", "compose", "--project-directory", manifest["repository"], "--project-name", manifest["project"],
                   "--env-file", str(directory / "inputs.env")]
        for item in manifest["logical_files"]:
            command.extend(("-f", str(directory / item["pinned"])))
        command.extend(("-f", str(directory / "runtime.yml")))
        return [*command, *args], values

    def publish(self, *, repository, project, sources, env_raw, values, runtime, plan_sha256, validate):
        require(self.root != repository and Path(repository) not in self.root.parents, "Compose entry는 checkout 밖에 있어야 합니다")
        if not self.root.exists():
            self.protect(self.root.parent, private=True)
            self.root.mkdir(mode=0o700)
            self.sync(self.root.parent)
        self.protect(self.root, private=True)
        files = {"inputs.env": env_raw, "environment.json": canonical(values) + b"\n", "runtime.yml": runtime.encode("utf-8")}
        logical = []
        for index, (name, data) in enumerate(sources):
            pinned = "source-%02d.yml" % index
            files[pinned] = data
            logical.append({"logical": name, "pinned": pinned, "sha256": sha256_bytes(data)})
        core = {"repository": str(repository), "project": project, "logical_files": logical,
                "files": {k: sha256_bytes(v) for k, v in files.items()}, "plan_sha256": plan_sha256}
        generation = sha256_bytes(canonical(core))
        manifest = {"schema": 1, "generation": generation, **core,
                    "runtime": {"pinned": "runtime.yml", "sha256": core["files"]["runtime.yml"]}}
        raw = canonical(manifest) + b"\n"
        pointer = {"generation": generation, "sha256": sha256_bytes(raw)}
        directory = self.root / generation
        if not directory.exists():
            directory.mkdir(mode=0o700)
            for name, data in files.items():
                self.write(directory / name, data)
            self.write(directory / "manifest.json", raw)
            self.sync(directory)
            self.sync(self.root)
        self.load(pointer)
        command, effective = self.argv(["config", "--format", "json"], pointer)
        validate(command, effective)
        temporary = self.root / (".active-" + uuid.uuid4().hex)
        self.write(temporary, canonical(pointer) + b"\n")
        os.replace(temporary, self.root / "active.json")
        self.sync(self.root)
        return pointer


class EngineExec:
    """Use an Engine exec instance, never the container's aggregate exec list, as the worker identity.

    The installed Docker CLI supplies its local daemon transport (Unix socket or Desktop named pipe). HTTP and
    multiplexed stream framing follow the Engine API; credentials and dump input stay on stdin, outside argv/logs.
    """
    def __init__(self, runner):
        self.runner = runner

    def request(self, method, path, body=None, *, stream=None, timeout=60, missing=False):
        payload = canonical(body) if body is not None else b""
        headers = (f"{method} /v1.45{path} HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\n"
                   f"Content-Length: {len(payload)}\r\n" +
                   ("Connection: Upgrade\r\nUpgrade: tcp\r\n" if stream is not None else "Connection: close\r\n") + "\r\n")
        result = self.runner(["docker", "system", "dial-stdio"], input=headers.encode() + payload + (stream or b""), timeout=timeout)
        require(result.returncode == 0, "Docker Engine 전송을 완료하지 못했습니다")
        class ResponseSocket:
            def makefile(self, *args):
                return io.BytesIO(result.stdout)
        response = http.client.HTTPResponse(ResponseSocket())
        response.begin()
        if missing and response.status == 404:
            return None
        require(response.status in (101, 200, 201), "Docker Engine 요청이 거절됐습니다")
        if stream is None:
            return decode(response.read())
        raw = response.fp.read() if response.status == 101 else response.read()
        channels = {1: bytearray(), 2: bytearray()}
        while raw:
            require(len(raw) >= 8 and raw[0] in channels and raw[1:4] == b"\0\0\0", "Docker exec 출력 framing이 잘못됐습니다")
            size = int.from_bytes(raw[4:8], "big")
            require(len(raw) >= size + 8, "Docker exec 출력이 잘렸습니다")
            channels[raw[0]].extend(raw[8:8 + size])
            raw = raw[8 + size:]
        return bytes(channels[1]), bytes(channels[2])

    def inspect(self, identity, *, missing=False, timeout=20):
        require(type(identity) is str and HASH.fullmatch(identity), "Docker exec 신원이 잘못됐습니다")
        return self.request("GET", "/exec/" + identity + "/json", missing=missing, timeout=timeout)

    def admit(self, container):
        health = (container.get("Config", {}).get("Healthcheck") or {}).get("Test") or []
        expected = health[1:] if health[:1] == ["CMD"] else (["/bin/sh", "-c", *health[1:]] if health[:1] == ["CMD-SHELL"] else None)
        require("ExecIDs" in container, "기존 Docker exec 관측이 없습니다")
        for identity in container["ExecIDs"] or []:
            item = self.inspect(identity, missing=True)
            if item is None or item.get("Running") is False:
                continue
            process = item.get("ProcessConfig") or {}
            require(item.get("Running") is True and expected is not None and
                    [process.get("entrypoint"), *process.get("arguments", [])] == expected,
                    "컨테이너의 외부 exec 작업이 아직 실행 중입니다")


def worker_unsettled(worker):
    # A registered server is intentionally alive between creation and its owned cleanup. Step-end observation still
    # requires every server to have been removed; only commands inside that lifetime may proceed.
    return worker.get("state") not in ("QUIET", "SERVING")


class HostOps:
    """The docker/compose/git/crontab operations of each step, against one target manifest only. Every command goes
    through cmd(), which records it (records.command) whatever its outcome."""

    def __init__(self, *, target, plan, runner, records, env_next=None, token_reader=None, secure=None, owner=None,
                 browser_cmd=None, repository_check=None, entry_root=None):
        self.t, self.plan, self.run, self.records = target, plan, runner, records
        self.owner = owner
        self.repo = Path(target["repository"])
        self.names = target["containers"]
        self.env_next = env_next          # path of the staged .env for the target (private)
        self.token_reader = token_reader  # () -> {"access_token", "subject"} (the operator's login; not used when unattended)
        self.secure = secure or (lambda path: None)
        # IRT-14: the configured headless-browser command (argv; the login spec arrives on stdin) for the unattended smoke.
        self.browser_cmd = list(browser_cmd) if browser_cmd else None
        # IRT-13: the protected-path check of the checkout itself (the host's; none outside a protected install).
        self.repository_check = repository_check or (lambda: None)
        # IRT-12: compose variables the .env lacks, resolved from the running stack (in memory; D04: also kept in the run
        # directory's private values file for the plan's later phases).
        self.compose_env = {}
        # D05: a recovery phase whose declared overlay file changed or vanished uses the bytes pinned at the plan's first
        # phase instead ({declared file: pinned copy}); every compose command and digest then reads the copy.
        self.overlay_paths = {}
        self.intro = None
        default_root = records.directory.parent
        if default_root.name == "emr-runs":
            default_root = default_root.parent
        self.entry = ComposeEntry(entry_root or default_root / "compose-entries")
        transient_roots = [records.directory, records.secrets]
        transient_roots.extend(parent for path in transient_roots.copy() for parent in path.parents
                               if parent.name in ("emr-runs", "emr-secrets"))
        for transient in transient_roots:
            require(self.entry.root != transient.absolute() and transient.absolute() not in self.entry.root.parents,
                    "지속 Compose entry를 일시 실행·비밀 자료 안에 둘 수 없습니다")
        self.entry_inputs = None

    @property
    def unattended(self):
        return self.browser_cmd is not None

    # ── primitives ──
    def cmd(self, args, *, timeout=60, input=None, env=None, check=True, mutating=False, stdin=None, output=None, quiet=False):
        """Run one fixed-binary command and record it before acting on its outcome: redacted argv, environment names (never
        values), input hash, start, duration, outcome (exit code, timeout or launch error), output hashes. quiet: the
        command carries a secret on stdin, so its error text (which may quote that input) is never kept."""
        timeout = bounded_timeout(timeout)
        args = list(args)
        worker = None
        remove_after = False
        pending = [row for row in self.intro.state.get("workers", {}).values() if worker_unsettled(row)] if self.intro else []
        own_launch = (len(pending) == 1 and pending[0]["state"] == "PLANNED" and pending[0]["kind"] == "compose-run"
                      and args[:2] == ["docker", "compose"] and "run" in args and "--name" in args
                      and args[args.index("--name") + 1] == pending[0]["resource"])
        if pending and not own_launch and (mutating or args[:2] in (["docker", "run"], ["docker", "exec"])):
            raise Unknown("이전 작업 종료가 미결이므로 새 작업·정리·복원을 시작할 수 없습니다")
        if self.intro is not None and args[:2] in (["docker", "run"], ["docker", "exec"]):
            kind = args[1]
            if kind == "run":
                remove_after = "--rm" in args
                args = [arg for arg in args if arg != "--rm"]
                if "--name" not in args:
                    args[2:2] = ["--name", self.t.get("project", "kin-release") + "-helper-" + uuid.uuid4().hex]
                resource = args[args.index("--name") + 1]
                args[2:2] = ["--label", "kin.emr-introduction=" + self.intro.plan_sha256[:16]]
                require(self.inspect_container(resource) is None, "보조 작업 이름을 기존 컨테이너가 사용 중입니다")
            else:
                # Every exec in this module uses fixed, separate option arguments. Refuse unfamiliar forms rather
                # than registering the wrong container and mistaking the client's death for the server's exit.
                offset = 2
                while offset < len(args) and args[offset].startswith("-"):
                    option = args[offset]
                    require(option in ("-i", "-t", "-it", "--interactive", "--tty", "-u", "--user", "-e", "--env", "-w", "--workdir"),
                            "등록할 수 없는 Docker exec 옵션입니다")
                    offset += 2 if option in ("-u", "--user", "-e", "--env", "-w", "--workdir") else 1
                require(offset < len(args), "Docker exec 대상이 없습니다")
                resource = args[offset]
                prior = self.inspect_container(resource)
                require(prior is not None, "Docker exec 대상 컨테이너가 없습니다")
                EngineExec(self.run).admit(prior)
            if kind == "run" and ("-d" in args or "--detach" in args):
                kind = "server"
            worker = self.register_worker(kind, resource, timeout, mutating=mutating)
            if kind == "exec":
                worker["container_id"] = prior["Id"]
                self.intro.save()
            else:
                args[2:2] = ["--label", "kin.release.worker=" + worker["nonce"]]
        entry = {"argv": redact_argv(args), "env": sorted(env or {}), "mutating": mutating, "timeout_s": timeout,
                 "started_utc": utc_now().isoformat()}
        if input is not None:
            entry["input"] = output_record(input)
        if stdin is not None:
            entry["stdin"] = Path(str(getattr(stdin, "name", "stream"))).name
        if output is not None:
            entry["stdout_to"] = Path(str(getattr(output, "name", "stream"))).name
        started = time.monotonic()
        label = args[0] + " " + (args[1] if len(args) > 1 else "")
        try:
            if worker is not None and worker["kind"] == "exec":
                result = self.exec_instance(args, offset, worker, input=input, stdin=stdin, output=output, timeout=timeout)
            else:
                result = self.run(args, input=input, timeout=timeout, env=env, stdin=stdin, output=output)
        except Unknown:
            entry.update(outcome="unknown", client_terminal=False, seconds=round(time.monotonic() - started, 3))
            self.records.command(entry)
            affected = [worker] if worker is not None else ([pending[0]] if own_launch else [])
            for active in affected:
                active.update(state="UNKNOWN", client_terminal=False)
                if active.get("mutating"):
                    self.intro.state["host_changed"] = True
            if mutating and self.intro is not None:
                self.intro.state["host_changed"] = True
            if affected or mutating and self.intro is not None:
                self.intro.save()
            raise
        except subprocess.TimeoutExpired:
            entry.update(outcome="timeout", client_terminal=os.name == "nt", seconds=round(time.monotonic() - started, 3))
            self.records.command(entry)
            affected = [worker] if worker is not None else ([pending[0]] if own_launch else [])
            for active in affected:
                active.update(state="UNKNOWN", client_terminal=os.name == "nt")
                if active.get("mutating"):
                    self.intro.state["host_changed"] = True
            if affected:
                self.intro.save()
            if mutating or worker is not None:
                raise Unknown(label + " timed out; its end state is unknown") from None
            raise Stop(label.strip() + " timed out") from None
        except OSError as error:
            entry.update(outcome="error", error=type(error).__name__, seconds=round(time.monotonic() - started, 3))
            self.records.command(entry)
            affected = [worker] if worker is not None else ([pending[0]] if own_launch else [])
            for active in affected:
                active["state"] = "UNKNOWN"
            if mutating and self.intro is not None:
                self.intro.state["host_changed"] = True
            if affected or mutating and self.intro is not None:
                self.intro.save()
                raise Unknown("등록한 작업의 시작·종료를 확인하지 못했습니다") from None
            raise Stop(label.strip() + " could not be started") from None
        except Exception as error:
            entry.update(outcome="error", error=type(error).__name__, seconds=round(time.monotonic() - started, 3))
            self.records.command(entry)
            if worker is not None:
                worker["state"] = "UNKNOWN"
                if worker.get("mutating"):
                    self.intro.state["host_changed"] = True
                self.intro.save()
                raise Unknown("등록 작업의 시작·종료 상태가 불명확합니다") from None
            raise
        entry.update(outcome="exit", exit=result.returncode, seconds=round(time.monotonic() - started, 3),
                     stdout=output_record(result.stdout if output is None else None), stderr=output_record(result.stderr))
        if check and result.returncode and not quiet:
            entry["failure_log"] = self.records.log("failed-" + uuid.uuid4().hex[:12] + ".err",
                                                    (" ".join(redact_argv(args[:3])) + "\n").encode() + (result.stderr or b"")[-16384:])
        self.records.command(entry)
        if mutating and result.returncode == 0 and self.intro is not None:
            self.intro.state["host_changed"] = True
            self.intro.save()
        if worker is not None:
            self.settle_worker(worker, result.returncode)
            if worker["kind"] == "exec" and result.returncode == 0 and args[offset + 1:offset + 2] == ["pg_isready"]:
                for server in self.intro.state.get("workers", {}).values():
                    if server.get("kind") == "server" and server.get("state") == "SERVING" and server["resource"] == worker["resource"]:
                        server["ready"] = {"exec_id": worker["exec_id"], "at": utc_now().isoformat()}
                        self.intro.save()
            if remove_after and not worker.get("resource_absent"):
                # Inspection delays --rm; retain its anonymous-volume cleanup semantics as well.
                self.cmd(["docker", "rm", "-v", worker["resource"]], mutating=mutating)
                require(self.inspect_container(worker["resource"]) is None, "종료한 보조 컨테이너의 제거를 확인하지 못했습니다")
            if check and worker.get("server_exit") not in (None, 0):
                raise Stop("보조 컨테이너의 실제 종료 코드가 실패입니다")
        if check and result.returncode:
            raise Stop(f"{label} failed (exit {result.returncode})")
        if self.intro is not None and args[:2] == ["docker", "rm"] and result.returncode == 0:
            for server in self.intro.state.get("workers", {}).values():
                if server.get("kind") == "server" and server.get("state") == "SERVING" and server["resource"] in args[2:]:
                    try:
                        require(self.inspect_container(server["resource"]) is None, "소유 서버 정리 뒤 부재를 확인하지 못했습니다")
                        server.update(state="QUIET", resource_absent=True, cleaned_at=utc_now().isoformat())
                    except Exception:
                        server["state"] = "UNKNOWN"
                        raise Unknown("소유 서버의 정리 상태가 불명확합니다") from None
                    finally:
                        self.intro.save()
        return result

    def exec_instance(self, args, offset, worker, *, input, stdin, output, timeout):
        engine = EngineExec(self.run)
        end = time.monotonic() + timeout
        options = args[2:offset]
        require(not any(flag in options for flag in ("-t", "-it", "--tty")), "등록 exec는 비대화형 출력만 지원합니다")
        configuration = {"AttachStdin": any(flag in options for flag in ("-i", "--interactive")),
                         "AttachStdout": True, "AttachStderr": True, "Tty": False, "Cmd": args[offset + 1:]}
        for flags, key in ((("-u", "--user"), "User"), (("-w", "--workdir"), "WorkingDir")):
            for flag in flags:
                if flag in options:
                    configuration[key] = options[options.index(flag) + 1]
        configuration["Env"] = [options[index + 1] for index, flag in enumerate(options) if flag in ("-e", "--env")]
        created = engine.request("POST", "/containers/" + quote(worker["container_id"], safe="") + "/exec", configuration,
                                 timeout=max(0.01, end - time.monotonic()))
        require(type(created.get("Id")) is str and HASH.fullmatch(created["Id"]), "Engine exec ID 응답이 잘못됐습니다")
        worker["exec_id"] = created["Id"]
        self.intro.save()
        stdout, stderr = engine.request("POST", "/exec/" + worker["exec_id"] + "/start", {"Detach": False, "Tty": False},
                                        stream=input if input is not None else (stdin.read() if stdin else b""),
                                        timeout=max(0.01, end - time.monotonic()))
        observed_exec = engine.inspect(worker["exec_id"], timeout=max(0.01, end - time.monotonic()))
        worker["exec_observation"] = {key: observed_exec.get(key) for key in ("ID", "ContainerID", "Running", "ExitCode")}
        self.intro.save()
        require(observed_exec.get("Running") is False and type(observed_exec.get("ExitCode")) is int,
                "등록 exec의 실제 종료를 확인하지 못했습니다")
        if output is not None:
            output.write(stdout)
        return subprocess.CompletedProcess(args, observed_exec["ExitCode"], None if output else stdout, stderr)

    def register_worker(self, kind, resource, timeout, *, mutating=False):
        require(self.intro is not None, "작업 등록에 실행 문맥이 필요합니다")
        if any(worker_unsettled(row) for row in self.intro.state.get("workers", {}).values()):
            raise Unknown("이전 작업 종료가 미결이므로 다음 작업을 등록할 수 없습니다")
        nonce = uuid.uuid4().hex
        worker = {"nonce": nonce, "kind": kind, "resource": resource, "state": "PLANNED", "mutating": mutating,
                  "plan_sha256": self.intro.plan_sha256, "request_sha256": self.intro.request_sha256,
                  "step": self.records.context.get("step"), "attempt": int(self.intro.retrying),
                  "deadline_utc": (utc_now() + timedelta(seconds=timeout)).isoformat()}
        self.intro.state.setdefault("workers", {})[nonce] = worker
        self.intro.save()
        return worker

    def settle_worker(self, worker, client_exit):
        try:
            if worker["kind"] == "exec":
                item = worker.get("exec_observation") or {}
                require(item.get("ID") == worker.get("exec_id") and item.get("ContainerID") == worker["container_id"]
                        and item.get("Running") is False and type(item.get("ExitCode")) is int,
                        "Docker exec 서버 작업 종료를 확인하지 못했습니다")
                server_exit = item["ExitCode"]
            else:
                item = self.inspect_container(worker["resource"])
                if item is None and client_exit != 0:
                    worker.update(state="QUIET", client_exit=client_exit, server_exit=None, resource_absent=True)
                    self.intro.save()
                    return
                require(item is not None, "소유 보조 컨테이너를 확인하지 못했습니다")
                labels = (item.get("Config") or {}).get("Labels") or {}
                require(labels.get("kin.emr-introduction") == self.intro.plan_sha256[:16]
                        and labels.get("kin.release.worker") == worker["nonce"],
                        "보조 컨테이너가 등록한 실행의 자원이 아닙니다")
                if worker["kind"] == "server":
                    require(client_exit == 0 and item["State"]["Running"] is True and item["State"]["Restarting"] is False,
                            "소유 서버 컨테이너의 생성을 확인하지 못했습니다")
                    worker.update(state="SERVING", container_id=item["Id"], client_exit=client_exit,
                                  created_at=utc_now().isoformat())
                    self.intro.save()
                    return
                require(item["State"]["Running"] is False and item["State"]["Restarting"] is False
                        and item["State"].get("Status") in ("exited", "dead") and type(item["State"].get("ExitCode")) is int,
                        "보조 컨테이너 종료를 확인하지 못했습니다")
                server_exit = item["State"]["ExitCode"]
            worker.update(state="QUIET", client_exit=client_exit, server_exit=server_exit)
            self.intro.save()
        except Exception as error:
            worker["state"] = "UNKNOWN"
            self.intro.save()
            raise Unknown("등록한 서버 작업의 종료를 확인하지 못했습니다") from None

    @contextmanager
    def bind(self):
        """ops_backup's helpers (captures, restores, catalogs) run against this repository through cmd(), recorded."""
        def run(args, *, output=None, input_file=None, timeout=600, check=True):
            return self.cmd(list(args), output=output, stdin=input_file, timeout=timeout, check=check)
        previous = ops.ROOT, ops.run, ops.remove_owned, ops.remove_owned_if_present
        def guarded_cleanup(function):
            def cleanup(*args, **kwargs):
                if self.intro is not None and any(worker_unsettled(row) for row in self.intro.state.get("workers", {}).values()):
                    raise Unknown("미결 작업이 있어 보조 자료 정리를 보류했습니다")
                return function(*args, **kwargs)
            return cleanup
        ops.ROOT, ops.run = self.repo, run
        ops.remove_owned, ops.remove_owned_if_present = guarded_cleanup(previous[2]), guarded_cleanup(previous[3])
        try:
            namespace = self.t.get("project", "kin-rehearsal")
            with ops.resource_names((namespace if namespace.startswith("kin-") else "kin-" + namespace) + "-"):
                yield
        finally:
            ops.ROOT, ops.run, ops.remove_owned, ops.remove_owned_if_present = previous

    def text(self, args, **kwargs):
        return self.cmd(args, **kwargs).stdout.decode("utf-8").strip()

    def compose_files(self):
        out = []
        for item in self.t["compose_files"]:
            out += ["-f", str(self.compose_path(item))]
        return out

    def compose(self, args, *, override=None, timeout=180, env=None, mutating=True, check=True, project=None, files=None):
        pending = [row for row in self.intro.state.get("workers", {}).values() if row.get("state") != "QUIET"] if self.intro else []
        own_launch = (len(pending) == 1 and pending[0]["state"] == "PLANNED" and pending[0]["kind"] == "compose-run"
                      and args[:1] == ["run"] and "--name" in args
                      and args[args.index("--name") + 1] == pending[0]["resource"])
        if pending and not own_launch:
            raise Unknown("작업 종료가 미결이므로 Compose entry와 서비스를 변경할 수 없습니다")
        if self.entry_inputs is not None and files is None:
            pointer = self.publish_entry(override, project)
            command, environment = self.entry.argv(args, pointer)
            # Helpers may pass their private container environment with -e; this is scoped to this invocation.
            require(all(key not in environment or environment[key] == value for key, value in (env or {}).items()),
                    "보조 작업 환경이 고정 Compose 입력을 덮으려 합니다")
            environment.update(env or {})
            return self.cmd(command, timeout=timeout, env=environment, mutating=mutating, check=check)
        require(not mutating, "지속 Compose entry 준비 전에 서비스를 변경할 수 없습니다")
        command = ["docker", "compose", "--project-directory", str(self.repo), "--project-name", project or self.t["project"],
                   *(files if files is not None else self.compose_files()), *(["-f", "-"] if override else []), *args]
        environment = {**self.compose_env, **(env or {})} or None
        return self.cmd(command, input=override.encode() if override else None, timeout=timeout, env=environment,
                        mutating=mutating, check=check)

    def pins(self, intro, *, maintenance=None):
        """Image IDs for every service of the current checkout, the API release label, the fenced proxy ports."""
        if maintenance is None:
            maintenance = bool(intro.state.get("fenced")) and not (intro.state.get("ponr") or intro.state.get("recovery_reopen"))
        side = "release" if intro.state["checkout"] == "target" else "previous"
        images = intro.plan[side]["images"]
        services = {role: {"image": images[role]} for role in ROLES}
        services["api"]["labels"] = {"kin.deploy.release": intro.plan[side]["sha"]}
        if side == "release":
            services["api-migrate"] = {"image": images["api"], "container_name": self.names["api-migrate"]}
            services["emr-provision"] = {"image": images["db"], "container_name": self.names["emr-provision"]}
        if maintenance:
            services["proxy"]["ports"] = ("!override", [self.t["ports"]["maintenance"]])
        recovery = intro.state.get("recovery")
        volumes = {"pg-db": recovery["pg"], "orthanc-db": recovery["orthanc"]} if recovery else None
        return override_yaml(services, volumes=volumes)

    def inspect(self, role):
        return self.inspect_container(self.names[role])

    def inspect_container(self, name):
        # A failed inspect is not absence. First obtain a successful, exact-name daemon inventory.
        listed = self.cmd(["docker", "container", "ls", "--all", "--filter", "name=^/" + name + "$", "--format", "{{.Names}}"])
        names = listed.stdout.decode("utf-8").splitlines()
        require(all(value == name for value in names) and len(names) <= 1, "컨테이너 목록 응답이 선언과 다릅니다")
        if not names:
            return None
        result = self.cmd(["docker", "inspect", name])
        items = json.loads(result.stdout)
        require(type(items) is list and len(items) == 1 and type(items[0]) is dict, "Docker 관측 응답을 해석할 수 없습니다")
        return items[0]

    def volume_exists(self, name):
        listed = self.text(["docker", "volume", "ls", "--filter", "name=^" + name + "$", "--format", "{{.Name}}"])
        names = listed.splitlines()
        require(all(value == name for value in names) and len(names) <= 1, "볼륨 목록 응답이 선언과 다릅니다")
        return bool(names)

    def running(self):
        state = {}
        for role in ROLES:
            item = self.inspect(role)
            state[role] = bool(item and item["State"]["Running"])
        return state

    def verify_networks(self, inspections, model, image_volumes, *, roles=ROLES):
        networks = {}
        names = {name for item in inspections.values() for name in item["NetworkSettings"]["Networks"]}
        for name in sorted(names):
            result = decode(self.cmd(["docker", "network", "inspect", name]).stdout)
            require(type(result) is list and len(result) == 1 and result[0].get("Name") == name,
                    "network 관측 응답이 선언과 다릅니다")
            networks[name] = result[0]
        check_running(inspections, {**model, "network_observations": networks}, self.t, image_volumes, roles=roles)

    def verify_running(self, model, *, absent_roles=()):
        require(set(absent_roles) <= set(ROLES), "부재를 허용한 운영 대상이 잘못됐습니다")
        inspections = {role: self.inspect(role) for role in ROLES}
        require(all(item is not None or role in absent_roles for role, item in inspections.items()),
                "허용하지 않은 운영 컨테이너가 없습니다")
        inspections = {role: item for role, item in inspections.items() if item is not None}
        require(all(item and item["State"]["Running"] and not item["State"]["Restarting"] for item in inspections.values()),
                "allowlist 대조에 필요한 컨테이너가 실행 중이 아닙니다")
        image_volumes = {}
        for role, item in inspections.items():
            image = decode(self.cmd(["docker", "image", "inspect", item["Image"]]).stdout)[0]
            require(image["Id"] == model["images"][role], "고정 이미지 신원이 다릅니다")
            image_volumes[role] = {path: {"read_only": False} for path in (image.get("Config") or {}).get("Volumes") or {}}
        self.verify_networks(inspections, model, image_volumes, roles=tuple(inspections))
        return inspections

    def psql(self, sql, database="kin"):
        return self.text(["docker", "exec", self.names["db"], "psql", "-X", "-U", "kin", "-d", database, "-v", "ON_ERROR_STOP=1",
                          "-qAt", "-c", sql], timeout=120)

    def db_clients(self):
        return int(self.psql("SELECT count(*) FROM pg_stat_activity WHERE "
                             "backend_type='client backend' AND pid<>pg_backend_pid();"))

    def observe_pending_browsers(self, intro):
        self.intro = intro
        # Re-entry observes a registered unit before helpers, profiles or credentials are touched. A terminal
        # observation is evidence for manual reconciliation; it never clears the durable UNKNOWN hold by itself.
        for worker in intro.state.get("workers", {}).values():
            if worker.get("kind") == "browser" and worker.get("state") != "QUIET" and os.name == "posix":
                try:
                    budget = SmokeBudget(5, cleanup=0)
                    quiet = SystemdBrowser(worker, self.records, intro.save, budget).observe()
                    worker["reentry_observation"] = {"terminal_and_empty": quiet, "at": utc_now().isoformat()}
                except Exception as error:
                    worker["reentry_observation"] = {"error": type(error).__name__, "at": utc_now().isoformat()}
                intro.save()

    def snapshot(self, intro):
        """C-OBS's mandatory observations, with transport failure retained separately from confirmed absence."""
        self.intro = intro
        fields, containers, inspected = {}, {}, {}

        self.observe_pending_browsers(intro)

        def read(name, action):
            try:
                fields[name] = fact(action())
            except Exception as error:
                fields[name] = observation_error(error)

        for role in ROLES:
            try:
                item = inspected[role] = self.inspect(role)
                if item is None:
                    containers[role] = absent()
                else:
                    labels = item["Config"]["Labels"]
                    containers[role] = fact({"id": item["Id"], "image": item["Image"], "running": item["State"]["Running"],
                                             "restarting": item["State"]["Restarting"],
                                             "project": labels["com.docker.compose.project"], "service": labels["com.docker.compose.service"]})
            except Exception as error:
                containers[role] = observation_error(error)
        fields["containers"] = fact(containers)
        read("checkout", lambda: {"sha": self.text(["git", "rev-parse", "HEAD"])})
        read("compose_entry", lambda: self.entry_observation())
        read("lock", lambda: {"owned": bool(intro.state.get("lock_token")) and lock_owned(self.repo, intro.state["lock_token"])})

        def database():
            item = inspected["db"]
            require(item is not None and item["State"]["Running"] and not item["State"]["Restarting"], "데이터베이스가 실행 준비 상태가 아닙니다")
            ready = self.cmd(["docker", "exec", self.names["db"], "pg_isready", "-h", "127.0.0.1", "-U", "kin"], timeout=20, check=False)
            require(ready.returncode == 0, "데이터베이스가 연결을 받을 준비가 아닙니다")
            with self.bind():
                rows = ops.migration_rows(self.names["db"])
            return {"ready": True, "migrations": rows}

        checkpoint = [self.records.context.get("step"), self.records.context.get("part")]
        if containers["db"] == absent() and tuple(checkpoint) in DB_ABSENCE_CHECKPOINTS:
            fields["database"] = absent()
        else:
            read("database", database)

        def fences():
            require(set(inspected) == set(ROLES), "writer 관측이 불완전합니다")
            raw = self.cron()
            cron = "not-managed"
            if raw is not None:
                _, tagged = self.cron_lines(raw, self.t["cron"]["tags"])
                require(all(len(rows) == 1 for rows in tagged.values()), "예약 작업 목록이 선언과 다릅니다")
                cron = "fenced" if all(rows[0].startswith(FENCED) for rows in tagged.values()) else "open"
            proxy = inspected["proxy"]
            ingress = "closed"
            if proxy is not None and proxy["State"]["Running"]:
                ports = self.resolved_public(intro)
                if ports == [self.t["ports"]["maintenance"]]:
                    ingress = "maintenance"
                else:
                    require(sorted(ports) == sorted(self.t["ports"]["public"]), "진입 포트가 선언과 다릅니다")
                    ingress = "public"
            clients = 0 if fields["database"] == absent() else self.db_clients()
            return {"writers": {r: bool(inspected[r] and inspected[r]["State"]["Running"]) for r in WRITERS},
                    "cron": cron, "ingress": ingress, "db_clients": clients}

        read("fences", fences)
        def workers():
            pending = self.one_shots_alive(intro)
            return {"quiet": not pending, "pending": pending}
        read("workers", workers)
        return {"schema": 1, "checkpoint": checkpoint, "facts": fields}

    def entry_observation(self):
        if self.entry_inputs is not None or (self.entry.root / "active.json").exists():
            pointer, _, _ = self.entry.load()
            return pointer
        return {"generation": "admission", "sha256": self.compose_digest_now()}

    def publish_entry(self, runtime=None, project=None):
        require(self.intro is not None and self.entry_inputs is not None, "Compose entry 입력이 준비되지 않았습니다")
        inputs = self.entry_inputs
        if "previous_operating_entry" not in self.intro.state:
            self.intro.state["previous_operating_entry"] = (self.entry.load()[0] if (self.entry.root / "active.json").exists() else None)
            self.intro.save()
        if runtime is None:
            runtime = self.pins(self.intro)
        project = project or (self.intro.state.get("recovery") or {}).get("project") or self.t["project"]
        def validate(command, effective):
            result = self.cmd(command, env=effective, timeout=60, quiet=True)
            require(type(decode(result.stdout)) is dict, "고정 Compose config가 유효하지 않습니다")
        pointer = self.entry.publish(repository=self.repo, project=project, runtime=runtime,
                                     plan_sha256=self.intro.plan_sha256, validate=validate, **inputs)
        self.intro.state["compose_entry"] = {**pointer, "root": str(self.entry.root)}
        self.intro.state["entry_checkout"] = self.intro.state["checkout"]
        self.intro.save()
        return pointer

    def restore_previous_entry(self, intro):
        if "previous_operating_entry" not in intro.state or not intro.state.get("compose_entry"):
            return
        current = {key: intro.state["compose_entry"][key] for key in ("generation", "sha256")}
        require(self.entry.load()[0] == current, "거절된 계획의 Compose pointer가 다른 실행으로 바뀌었습니다")
        previous = intro.state["previous_operating_entry"]
        if previous is None:
            (self.entry.root / "active.json").unlink()
        else:
            self.entry.load(previous)
            temporary = self.entry.root / (".active-" + uuid.uuid4().hex)
            self.entry.write(temporary, canonical(previous) + b"\n")
            os.replace(temporary, self.entry.root / "active.json")
        self.entry.sync(self.entry.root)
        intro.state.pop("compose_entry", None)
        intro.save()

    def one_shots_alive(self, intro):
        """Every one-shot container of this release that still exists (running or not removed yet)."""
        out = self.text(["docker", "ps", "-a", "--filter", "label=kin.emr-introduction=" + intro.plan_sha256[:16],
                         "--format", "{{.Names}} {{.State}}"])
        pending = [row["nonce"] for row in intro.state.get("workers", {}).values() if row.get("state") != "QUIET"]
        return pending + [line for line in out.splitlines() if line.strip() and not line.endswith(" exited")]

    def wait(self, predicate, seconds, message):
        deadline = time.monotonic() + bounded_timeout(seconds)
        while True:
            try:
                if predicate():
                    return
            except Stop:
                pass
            if time.monotonic() >= deadline:
                raise Stop(message)
            time.sleep(min(1, bounded_timeout(1), max(0, deadline - time.monotonic())))

    def healthy(self, role):
        item = self.inspect(role)
        return bool(item and item["State"]["Running"] and (item["State"].get("Health") or {}).get("Status") == "healthy")

    def db_ready(self, seconds, message):
        """The database's final server. On a fresh volume the image first runs a Unix-socket-only init server that the
        Compose healthcheck (pg_isready over the socket) already reports healthy before it stops and restarts; only the
        final server listens on TCP, so a restore never races that restart (ops_backup.rehearse waits the same way)."""
        def ready():
            if not self.healthy("db"):
                return False
            probe = self.cmd(["docker", "exec", self.names["db"], "pg_isready", "-h", "127.0.0.1", "-U", "kin"], timeout=20, check=False)
            return probe.returncode == 0
        self.wait(ready, seconds, message)

    def one_shot(self, intro, service, args, *, timeout, env=None, entrypoint=None, name, worker=True, project=None):
        """Every one-shot is registered, including reads: a timed-out CLI cannot prove its daemon worker ended.
        Keep the container until its terminal state is observed. Callers require both client and server exit codes."""
        timeout = bounded_timeout(timeout)
        if any(row.get("state") != "QUIET" for row in intro.state.get("workers", {}).values()):
            raise Unknown("이전 작업 종료가 미결이므로 보조 작업을 시작할 수 없습니다")
        token = uuid.uuid4().hex[:12]
        container = self.t["project"] + "-" + name + "-" + token
        command = ["run", "--no-deps", "-T", "--name", container, "--label", "kin.ops.run=" + token]
        command += ["--label", "kin.emr-introduction=" + intro.plan_sha256[:16]]
        for key in (env or {}):
            command += ["-e", key]
        if entrypoint:
            command += ["--entrypoint", entrypoint]
        command += [service, *args]
        require(self.inspect_container(container) is None, "보조 작업 이름을 기존 컨테이너가 사용 중입니다")
        registered = self.register_worker("compose-run", container, timeout, mutating=worker)
        command[1:1] = ["--label", "kin.release.worker=" + registered["nonce"]]
        try:
            result = self.compose(command, override=self.pins(intro), timeout=timeout, env=env, check=False, mutating=worker, project=project)
        except Unknown:
            registered["state"] = "UNKNOWN"
            self.intro.save()
            # A confirmed client timeout permits cancellation of its owned daemon helper. An unreaped CLI/plugin
            # can still act on that helper, so preserve both sides instead of mistaking daemon cleanup for quiet.
            if _smoke_budget.get() is not None and registered.get("client_terminal") is not False:
                self.cancel_smoke_helper(registered)
                raise Stop("smoke 보조 작업 제한 시간 뒤 전체 컨테이너 종료를 확인했습니다") from None
            raise Unknown("보조 작업 종료 불명: 컨테이너와 작업 자료를 보존했습니다") from None
        except Stop:
            # A refused config/launch is settled only if a successful daemon query proves that the named worker
            # never appeared (or attests its terminal state). An unavailable query remains UNKNOWN.
            registered["launch_refused"] = True
            self.settle_worker(registered, None)
            raise
        self.settle_worker(registered, result.returncode)
        logs = {"stdout": self.records.log(container + ".out", result.stdout), "stderr": self.records.log(container + ".err", result.stderr)}
        exit_code = registered["server_exit"]
        if not registered.get("resource_absent"):
            self.cmd(["docker", "rm", "-v", container], mutating=worker)
            require(self.inspect_container(container) is None, "종료한 보조 컨테이너의 제거를 확인하지 못했습니다")
        return {"container": container, "exit": result.returncode, "container_exit": exit_code, "logs": logs,
                "stdout": result.stdout, "stderr": result.stderr}

    def cancel_smoke_helper(self, worker):
        """Only a named one-shot with this attempt's nonce may be cancelled; unknown exec jobs stay held."""
        try:
            with _smoke_budget.get().cleanup():
                item = self.inspect_container(worker["resource"])
                require(item is not None and (item.get("Config", {}).get("Labels") or {}).get("kin.release.worker") == worker["nonce"],
                        "smoke 보조 작업의 소유권을 확인하지 못했습니다")
                # This fixed stop is the sole mutation allowed while the registered worker is pending.
                start = time.monotonic()
                result = self.run(["docker", "stop", "--time", "5", worker["resource"]],
                                  timeout=bounded_timeout(8), input=None, env=None, stdin=None, output=None)
                self.records.command({"argv": ["docker", "stop", "--time", "5", worker["resource"]],
                                      "exit": result.returncode, "outcome": "exit", "seconds": time.monotonic() - start,
                                      "cleanup": True})
                require(result.returncode == 0, "smoke 보조 작업 정지가 실패했습니다")
                self.settle_worker(worker, result.returncode)
                self.cmd(["docker", "rm", "-v", worker["resource"]], timeout=bounded_timeout(5), mutating=True)
                require(self.inspect_container(worker["resource"]) is None, "smoke 보조 작업의 비밀 환경 정리를 확인하지 못했습니다")
        except Exception:
            worker["state"] = "UNKNOWN"
            self.intro.save()
            raise Unknown("smoke 정리 제한 시간 안에 보조 작업 종료를 확인하지 못했습니다") from None

    def helper(self, intro, script, *, env=None, name="helper", timeout=120, args=()):
        out = self.one_shot(intro, "api", ["-e", script, *args], timeout=timeout, env=env, entrypoint="node", name=name, worker=False)
        require(out["exit"] == 0 and out["container_exit"] == 0, name + " helper failed")
        return result_line(out["stdout"])

    def resolved(self, intro, *, pinned=True, maintenance=True, project=None):
        """The Compose model this checkout resolves to: with this mode's pins (pinned) or exactly as an ordinary
        `docker compose` in the checkout would (no project flag, no override: what any later operation uses). Only
        names, mounts, ports, images and the origin settings leave this function; the model carries interpolated secrets."""
        if pinned:
            raw = self.compose(["config", "--format", "json"], override=self.pins(intro, maintenance=maintenance), timeout=60,
                               mutating=False, project=project).stdout
        else:
            command, environment = self.entry.argv(["config", "--format", "json"])
            raw = self.cmd(command, timeout=60, env=environment).stdout
        model = json.loads(raw)
        services = {name: service or {} for name, service in (model.get("services") or {}).items() if name in (*ROLES, *ONE_SHOTS)}

        def port(item):
            protocol = item.get("protocol", "tcp")
            require(protocol in ("tcp", "udp", "sctp"), "Compose 게시 protocol을 해석할 수 없습니다")
            return ((item.get("host_ip") + ":" if item.get("host_ip") else "") + str(item.get("published")) + ":" + str(item.get("target"))
                    + ("/" + protocol if protocol != "tcp" else ""))

        def setting(service, key):
            value = (services.get(service, {}).get("environment") or {}).get(key)
            return value if type(value) is str else None
        return {"project": model.get("name"),
                "containers": {name: service.get("container_name") for name, service in services.items()},
                "volumes": {key: (value or {}).get("name") for key, value in (model.get("volumes") or {}).items()},
                "networks": {key: (value or {}).get("name") for key, value in (model.get("networks") or {}).items()},
                "mounts": {name: [{"type": item.get("type"), "source": item.get("source"), "target": item.get("target"),
                                   "read_only": item.get("read_only") is True,
                                   **{key: item[key] for key in ("bind", "volume", "tmpfs", "consistency") if key in item}}
                                  for item in service.get("volumes") or []] for name, service in services.items()},
                "tmpfs": {name: service.get("tmpfs") or [] for name, service in services.items()},
                "ports": {name: [port(item) for item in service.get("ports") or []] for name, service in services.items()},
                "images": {name: service.get("image") for name, service in services.items()},
                "service_networks": {name: sorted(service.get("networks") or {"default": None}) for name, service in services.items()},
                "origin": {"api_KC_ISSUER": setting("api", "KC_ISSUER"), "keycloak_KC_HOSTNAME": setting("keycloak", "KC_HOSTNAME"),
                           "api_PUBLIC_ORIGIN": setting("api", "PUBLIC_ORIGIN")},
                "api_environment": sorted(services.get("api", {}).get("environment") or {}),
                "proxy_ports": [port(item) for item in services.get("proxy", {}).get("ports") or []]}

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
        entries = [(item, self.compose_path(item).read_bytes()) for item in self.t["compose_files"]]
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
        expected = {"plan_sha256": plan_sha256, "reason": "emr-introduction"}
        if path.exists() or path.is_symlink():
            require(not path.is_symlink() and path.is_file() and path.stat().st_nlink == 1
                    and decode(path.read_bytes()) == expected, "다른 실행의 보존 표식을 변경할 수 없습니다")
        if on:
            temporary = path.with_name(".hold-" + uuid.uuid4().hex)
            with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600), "wb") as stream:
                stream.write(canonical(expected) + b"\n")
                stream.flush()
                os.fsync(stream.fileno())
            follow_folder_owner(temporary)
            os.replace(temporary, path)
            ComposeEntry.sync(path.parent)
        elif path.exists():
            path.unlink()
            ComposeEntry.sync(path.parent)

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

    def token(self):
        require(self.token_reader is not None, "No smoke token configured")
        return token_valid(self.token_reader())

    # ── IRT-12: the compose environment as the running stack resolved it ──
    def compose_path(self, item):
        if item in self.overlay_paths:
            return Path(self.overlay_paths[item])
        return Path(item) if PurePosixPath(item).is_absolute() or PureWindowsPath(item).is_absolute() else self.repo / item

    def pinned_overlay(self, intro, entry):
        """The overlay bytes this plan pinned (D05) as a private copy in its run directory, verified against the declared
        hash; None when nothing was pinned or the copy differs."""
        pin = ((intro.state.get("overlay_pins") or {}) if intro is not None else {}).get(entry["file"])
        if not pin:
            return None
        path = intro.records.directory / pin["copy"]
        try:
            raw = intro.records.read(path)
        except (OSError, RuntimeError):
            return None
        return path if sha256_bytes(raw) == entry["sha256"] == pin["sha256"] else None

    def declared_overlay_facts(self, intro=None):
        """IRT-11, before any phase step: each declared overlay is exactly the declared bytes in a file (no link) that only
        its owner (root or this tool's user) can change, in a folder only that owner can change; each bind source it brings
        exists (Compose would otherwise create an empty folder in its place). Recorded: path, mode, owner and sha256 of the
        overlay and of each bind source file (a folder: mode and owner).
        D05: the plan's first phase pins the verified bytes (a private copy in its run directory). A recovery phase
        (rollback, rollback_reopen, or the revert/rollback after a settled failure) whose overlay file changed, vanished or
        lost its protection goes on with those pinned bytes and records a warning; every other phase refuses."""
        def protection(path, what):
            """IRT2-19: the overlay and every folder above it - no link, owned by root or this tool's user, writable by no
            one else (a sticky folder above excepted, as ops_deploy_host.protected allows)."""
            if os.name != "posix":
                return None, None
            path = Path(path)
            for item in reversed((path, *path.parents)):
                info = os.lstat(item)
                require(not stat_module.S_ISLNK(info.st_mode), what + " has a link on its path: " + str(item))
                require(info.st_uid in (0, os.geteuid()), what + " has another owner on its path: " + str(item))
                require(not info.st_mode & 0o022 or (item != path and stat_module.S_ISDIR(info.st_mode) and info.st_mode & stat_module.S_ISVTX),
                        what + " is writable by others: " + str(item))
            info = os.lstat(path)
            return oct(info.st_mode & 0o7777), info.st_uid
        facts = []
        recovering = bool(getattr(intro, "recovering", False))
        self.overlay_paths = {}
        for entry in self.t["declared_overlays"]:
            path = Path(entry["file"])
            used = "declared file"
            try:
                require(path.is_file() and not path.is_symlink(), "A declared overlay is missing: " + entry["file"])
                raw = path.read_bytes()
                require(sha256_bytes(raw) == entry["sha256"], "A declared overlay differs from the manifest: " + entry["file"])
                mode, owner = protection(path, "A declared overlay")
            except (Stop, OSError) as error:
                pinned = self.pinned_overlay(intro, entry) if recovering else None
                if pinned is None:
                    raise Stop(code_of(error) if isinstance(error, Stop) else "A declared overlay is unreadable: " + entry["file"]) from None
                self.overlay_paths[entry["file"]] = str(pinned)
                intro.warn("declared-overlay", file=entry["file"], reason=code_of(error) if isinstance(error, Stop) else type(error).__name__,
                           used="the bytes pinned at the plan's first phase", sha256=entry["sha256"])
                mode = owner = None
                used = "pinned copy"
            else:
                if intro is not None and entry["file"] not in (intro.state.get("overlay_pins") or {}):
                    copy = "overlay-" + entry["sha256"][:16] + ".yml"
                    intro.records.write(intro.records.directory / copy, raw)
                    intro.state.setdefault("overlay_pins", {})[entry["file"]] = {"sha256": entry["sha256"], "copy": copy}
                    intro.save()
            binds = []
            for bind in entry["binds"]:
                source = Path(bind["source"])
                require(source.exists(), "A declared bind source is missing: " + bind["source"])
                info = os.stat(source)
                binds.append({"source": bind["source"], "target": bind["target"], "read_only": bind["read_only"],
                              "mode": oct(info.st_mode & 0o7777) if os.name == "posix" else None,
                              "owner": info.st_uid if os.name == "posix" else None,
                              "sha256": sha256_bytes(source.read_bytes()) if source.is_file() else None,
                              "kind": "file" if source.is_file() else "directory"})
            facts.append({"file": entry["file"], "sha256": entry["sha256"], "mode": mode, "owner": owner, "service": entry["service"],
                          "binds": binds, "used": used})
        return facts

    def kept_compose_values(self, intro):
        """D04: the values this plan resolved earlier, from its private values file, each still the value whose hash the
        state recorded (a changed file is a refusal, never a value)."""
        path = intro.records.secrets / COMPOSE_VALUES
        if not path.exists():
            return {}
        values = decode(intro.records.read_secret(COMPOSE_VALUES))
        known = intro.state.get("compose_env") or {}
        require(type(values) is dict and all(type(value) is str and name in known
                                             and sha256_bytes(value.encode("utf-8")) == known[name]["sha256"]
                                             for name, value in values.items()), "A kept compose value differs from its recorded hash")
        return values

    def prepare(self, intro):
        """Before any phase step: every variable the compose files require that the checkout's .env lacks is resolved from
        the running (or stopped) containers - the value a service's environment or bind mount actually carries - by
        rendering the model once with a unique marker per variable and reading the container at exactly the place the
        marker landed. The state keeps each name with the hash of its value and where it came from, and a later phase must
        resolve the same. D04: the value itself is kept in the run directory's private values file (root, 0600; never in a
        journal, result or command record), so a later phase whose source container no longer exists (a rollback after
        L-09b removed the proxy) uses the value resolved before; a container that exists must still carry that value. A
        required variable that neither a container nor the kept values hold is a refusal. D28: before the seed no clone
        stack runs, so the clone's .env must carry every required variable; the refusal names each one and its files."""
        self.intro = intro
        if intro.phase == "capture":
            # Admission precedes even the declared checkout-mode/overlay corrections, not just the writer fence.
            self.source_admission = self.admit_source(intro)
        self.entry_inputs = None
        saved = intro.state.get("compose_entry")
        if saved and intro.state.get("entry_checkout") == intro.state["checkout"]:
            # C-COMPOSE: a phase on the persistent entry runs the entry's pinned bytes, which must be the declared bytes
            # (checked below), whatever the overlay file now is - the receipt after an ordinary recreate without the
            # original overlay included. D05 on this branch too (IRT3-03): a recovery still observes the declared
            # overlay first, so a changed, vanished or unprotected file is recorded as the warning the operator sees.
            overlays = self.declared_overlay_facts(intro) if getattr(intro, "recovering", False) else None
            pointer = {key: saved[key] for key in ("generation", "sha256")}
            _, manifest, values = self.entry.load(pointer)
            require(manifest["plan_sha256"] == intro.plan_sha256 and manifest["repository"] == str(self.repo),
                    "지속 Compose 입력이 현재 계획과 다릅니다")
            pinned = {row["logical"]: row["sha256"] for row in manifest["logical_files"]}
            require(all(pinned.get(item["file"]) == item["sha256"] for item in self.t["declared_overlays"]),
                    "지속 Compose 입력의 overlay가 선언과 다릅니다")
            directory = self.entry.root / pointer["generation"]
            self.entry_inputs = {"sources": [(row["logical"], (directory / row["pinned"]).read_bytes()) for row in manifest["logical_files"]],
                                 "env_raw": (directory / "inputs.env").read_bytes(), "values": values}
            self.overlay_paths = {row["logical"]: directory / row["pinned"] for row in manifest["logical_files"]
                                  if Path(row["logical"]).is_absolute()}
            self.compose_env = values
            for name, record in intro.state.get("compose_env", {}).items():
                require(name in values and type(record.get("places")) is list, "확정 환경값의 원본 위치 기록이 없습니다")
                for kind, service, key in record["places"]:
                    item = self.inspect(service)
                    if item is None:
                        continue
                    if kind == "environment":
                        present = dict(row.split("=", 1) for row in item["Config"].get("Env") or [] if "=" in row)
                        require(present.get(key) == values[name], "확정한 Compose 환경값과 실제 컨테이너 값이 다릅니다")
                    else:
                        sources = [host_bind_source(m["Source"], self.t["repository"]) for m in item.get("Mounts") or [] if m.get("Destination") == key]
                        require(sources == [values[name]], "확정한 Compose mount와 실제 컨테이너 경로가 다릅니다")
            return {"immutable_entry": pointer, "declared_overlays": overlays}
        overlays = self.declared_overlay_facts(intro)
        files = list(self.t["compose_files"])
        texts = [self.compose_path(item).read_bytes() for item in files]
        present = set(parse_env(self.env_file().read_bytes()))
        needed = sorted(name for name, required in referenced_variables(texts).items() if required and name not in present)
        if needed and getattr(intro, "phase", None) == "seed":
            requiring = {name: [Path(item).name for item, text in zip(files, texts) if referenced_variables([text]).get(name)]
                         for name in needed}
            raise Stop("The clone's .env must set " + "; ".join(name + " (required by " + ", ".join(requiring[name]) + ")" for name in needed)
                       + " before the seed: no clone stack runs yet to resolve it from")
        kept = self.kept_compose_values(intro) if needed else {}
        resolved, record = {}, {}
        if needed:
            markers = {name: "kin-resolve-" + uuid.uuid4().hex for name in needed}
            raw = self.cmd(["docker", "compose", "--project-directory", str(self.repo), "--project-name", self.t["project"],
                            *self.compose_files(), "config", "--format", "json"], timeout=60, env=markers).stdout.decode("utf-8")
            model = json.loads(raw)
            services = model.get("services") or {}
            for name, marker in markers.items():
                places = []
                for service, spec in services.items():
                    for key, value in ((spec or {}).get("environment") or {}).items():
                        if type(value) is str and marker in value:
                            require(value == marker and service in ROLES, "Unresolvable compose variable: " + name)
                            places.append(("environment", service, key))
                    for mount in (spec or {}).get("volumes") or []:
                        if marker in str(mount.get("source")):
                            # Compose renders a relative bind source (the marker is one) against the project directory:
                            # the variable is the whole source exactly when the rendered source is the marker or that path.
                            source = str(mount.get("source"))
                            require((source == marker or (mount.get("type") == "bind" and Path(source) == self.repo / marker))
                                    and service in ROLES, "Unresolvable compose variable: " + name)
                            places.append(("mount", service, mount.get("target")))
                require(places and raw.count(marker) == len(places), "Unresolvable compose variable: " + name)
                values, carriers = set(), set()
                for kind, service, key in places:
                    item = self.inspect(service)
                    if item is None:
                        # The container is gone (D04): the value resolved before, if any, stands in for it.
                        continue
                    if kind == "environment":
                        env = dict(entry.split("=", 1) for entry in (item.get("Config") or {}).get("Env") or [] if "=" in entry)
                        require(key in env, "Unresolvable compose variable: " + name)
                        values.add(env[key])
                    else:
                        sources = [m.get("Source") for m in item.get("Mounts") or [] if m.get("Destination") == key]
                        require(len(sources) == 1 and sources[0], "Unresolvable compose variable: " + name)
                        values.add(host_bind_source(sources[0], self.t["repository"]))
                    carriers.add(kind + ":" + service)
                require(len(values) <= 1, "Unresolvable compose variable: " + name)
                if values:
                    resolved[name] = values.pop()
                    origin = sorted(carriers)
                else:
                    require(name in kept, "Unresolvable compose variable: " + name)
                    resolved[name] = kept[name]
                    origin = ["kept"]
                record[name] = {"sha256": sha256_bytes(resolved[name].encode("utf-8")), "from": origin, "places": places}
        known = intro.state.setdefault("compose_env", {})
        for name, entry in record.items():
            require(known.get(name, entry)["sha256"] == entry["sha256"], "A resolved compose variable changed: " + name)
        for name, entry in record.items():
            known[name] = {**entry, "kept": True}
        if resolved and any(kept.get(name) != value for name, value in resolved.items()):
            intro.records.write_secret(COMPOSE_VALUES, canonical({**kept, **resolved}) + b"\n")
        intro.save()
        self.compose_env = resolved
        out = {"resolved_from_running_stack": record, "declared_overlays": overlays}
        # Names, hashes and places only (IRT-12), and the declared overlays' files and bind sources (IRT-11): at every
        # resolution, the phase start's and each later one (the target checkout, a revert, a rollback).
        intro.records.journal({"event": "compose-environment", "plan_sha256": getattr(intro, "plan_sha256", None),
                               "phase": getattr(intro, "phase", None), **out})
        self.prepare_entry(intro)
        return out

    def prepare_entry(self, intro):
        """Freeze all effective interpolation inputs using Compose's own dotenv evaluator, before service mutation."""
        command = ["docker", "compose", "--project-directory", str(self.repo), "--project-name", self.t["project"],
                   "--env-file", str(self.env_file()), *self.compose_files(), "config", "--environment"]
        raw = self.cmd(command, env=dict(self.compose_env), quiet=True).stdout.decode("utf-8")
        values = {}
        for line in raw.splitlines():
            name, separator, value = line.partition("=")
            require(separator and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name) and name not in values,
                    "Compose 환경값의 경계를 확정할 수 없습니다")
            values[name] = value
        values = {k: v for k, v in values.items() if not k.startswith(("COMPOSE_", "DOCKER_"))}
        sources = [(name, self.compose_path(name).read_bytes()) for name in self.t["compose_files"]]
        # Compare actual rendering with the frozen environment, including $, quotes, spaces and empty values.
        rendering = [*command[:-2], "config", "--format", "json"]
        before = self.cmd(rendering, env=dict(self.compose_env), quiet=True).stdout
        after = self.cmd(rendering, env=values, quiet=True).stdout
        require(before == after, "Compose 환경값 고정 전후 config가 다릅니다")
        unresolved = self.cmd([*command[:-2], "config", "--no-env-resolution", "--format", "json"],
                              env=values, quiet=True).stdout
        require(not any(service.get("env_file") for service in decode(unresolved).get("services", {}).values()),
                "v1 Compose bundle은 외부 service env_file을 지원하지 않습니다")
        self.entry_inputs = {"sources": sources, "env_raw": self.env_file().read_bytes(), "values": values}
        self.publish_entry(self.pins(intro, maintenance=bool(intro.state.get("fenced"))
                                     and not (intro.state.get("ponr") or intro.state.get("recovery_reopen"))))

    # ── IRT-13 / IRT-11: recorded pre-fence corrections of the checkout ──
    def checkout_mode(self, intro):
        """With the manifest's fix_checkout_mode: the checkout becomes 0700 and its .git loses group/other write (never
        recursively), modes recorded before and after; then the checkout is checked as private like any other run."""
        git = self.repo / ".git"
        before = {"checkout": oct(self.repo.stat().st_mode & 0o7777), ".git": oct(git.stat().st_mode & 0o7777)}
        if self.t["fix_checkout_mode"]:
            if before["checkout"] != "0o700" or git.stat().st_mode & 0o022:
                intro.state["host_changed"] = True
                intro.save()
            os.chmod(self.repo, 0o700)
            os.chmod(git, git.stat().st_mode & 0o7777 & ~0o022)
        after = {"checkout": oct(self.repo.stat().st_mode & 0o7777), ".git": oct(git.stat().st_mode & 0o7777)}
        self.repository_check()
        return {"fixed": self.t["fix_checkout_mode"], "before": before, "after": after}

    def config_bytes(self, files):
        args = []
        for item in files:
            args += ["-f", str(self.compose_path(item))]
        return self.compose(["config", "--format", "json"], files=args, timeout=60, mutating=False).stdout

    def reconcile_checkout(self, intro):
        """A tracked compose file the host carries modified (e.g. the proxy joining an external service's network) is
        replaced by its declared overlay only when that reproduces the running configuration byte for byte: the model of
        the current files, the model of the committed file plus the overlay (from a copy, before anything changes) and,
        after the file is restored to the commit, the model of the declared file list - all three identical. Only hashes
        are recorded (the model carries interpolated secrets). A mismatch changes nothing."""
        done = []
        for entry in self.t["tracked_overlay_reconcile"]:
            path = self.repo / entry["path"]
            head = self.cmd(["git", "cat-file", "blob", "HEAD:" + entry["path"]]).stdout
            current = path.read_bytes()
            overlay = self.compose_path(entry["override_file"]).read_bytes()
            require(sha256_bytes(overlay) == entry["override_sha256"], "The overlay differs from the manifest")
            if sha256_bytes(current) == sha256_bytes(head):
                done.append({"path": entry["path"], "state": "already the commit"})
                continue
            require(sha256_bytes(current) == entry["expected_sha256_before"], "The modified tracked file is not the declared one")
            running = [item for item in self.t["compose_files"] if item != entry["override_file"]]
            before = self.config_bytes(running)
            copy = intro.records.directory / ("head-" + Path(entry["path"]).name)
            intro.records.write(copy, head)
            candidate = self.config_bytes([str(copy) if item == entry["path"] else item for item in self.t["compose_files"]])
            require(candidate == before, "The overlay does not reproduce the modified compose file")
            self.cmd(["git", "checkout", "--", entry["path"]], mutating=True)
            require(sha256_bytes(path.read_bytes()) == sha256_bytes(head), "The tracked file was not restored")
            after = self.config_bytes(self.t["compose_files"])
            require(after == before, "The declared file list does not reproduce the running configuration")
            done.append({"path": entry["path"], "state": "restored to the commit", "modified_sha256": sha256_bytes(current),
                         "config_sha256": {"current_files": sha256_bytes(before), "commit_with_overlay": sha256_bytes(candidate),
                                           "declared_files": sha256_bytes(after)}})
        ordinary = self.ordinary_entry()
        # L-00b changed the source bytes. The operational generation must contain the reconciled sources and env,
        # rather than the pre-correction copy prepared at phase admission.
        self.intro = intro
        self.prepare_entry(intro)
        return {"reconciled": done, "ordinary_entry": ordinary}

    def ordinary_entry(self):
        """IRT2-10, the ordinary entry: with a declared external overlay, the checkout's .env names the declared compose
        list in COMPOSE_FILE, so an operator's plain `docker compose ...` in the checkout (no -f), after the release or
        after a rollback, uses exactly that list, overlay included (an explicit -f, like the API-only runner's, still
        wins). Written here when absent or different (recorded by hash; the plan's compose digest is computed over the
        .env with this line); the rollback restores B0's .env, which carries it."""
        if not self.t["declared_overlays"]:
            return "no declared overlay"
        raw = self.env_file().read_bytes()
        if names_declared_list(raw, self.t):
            return {"compose_file": "already named"}
        wanted = env_with_compose_file(raw, self.t)
        self.write_env(wanted)
        return {"compose_file": "written", "env_sha256": {"before": sha256_bytes(raw), "after": sha256_bytes(wanted)}}

    def ordinary_entry_kept(self):
        pointer, manifest, _ = self.entry.load()
        require([row["logical"] for row in manifest["logical_files"]] == self.t["compose_files"], "지속 Compose 입력 순서가 다릅니다")
        require(manifest["repository"] == str(self.repo), "지속 Compose entry가 다른 checkout을 가리킵니다")
        return {"entry": str(self.entry.root), **pointer, "supported": "보호된 공통 entry만 사용"}

    def token_since(self, moment, what):
        """The smoke token, issued (iat) no earlier than the given moment: a login made for this attempt, never an older one."""
        token = self.token()
        issued = token_claims(token).get("iat")
        require_smoke(type(issued) is int and issued >= int(parse_utc(moment).timestamp()), "The smoke token was issued before " + what)
        return token

    # ── IRT-14: the unattended smoke (D1062) - a temporary member, a real browser login, the checks, the record ──
    def smoke_project(self, intro):
        recovery = intro.state.get("recovery")
        return recovery["project"] if recovery and intro.state.get("restored_at") else None

    def smoke_admin(self, intro, operation, payload, *, password=None):
        """Keycloak administration for the smoke member and its login client, from a one-shot of the running API image
        with the target's administrator (values only in the one-shot's environment)."""
        env = {"KIN_KC_ADMIN_USER": self.t["keycloak_admin"], "KIN_KC_ADMIN_PASSWORD": parse_env(self.env_file().read_bytes()).get("KC_ADMIN_PASSWORD", "")}
        env["KIN_SMOKE_DEADLINE"] = str(int((time.time() + bounded_timeout(180)) * 1000))
        if password is not None:
            env["KIN_SMOKE_PASSWORD"] = password
        out = self.one_shot(intro, "api", ["-e", SMOKE_ADMIN_SCRIPT, operation, json.dumps(payload)], timeout=180, env=env,
                            entrypoint="node", name="kc-smoke-" + operation, project=self.smoke_project(intro))
        if out["exit"] != 0 or out["container_exit"] != 0:
            reason = out.get("stderr", "")
            if isinstance(reason, bytes):
                reason = reason.decode("utf-8", errors="replace")
            refusal = SmokeRefusal if reason.strip() in ("admin", "exists", "marker", "ownership", "role", "group", "PUT 403", "POST 403") else Stop
            raise refusal("임시 smoke 계정 관리가 실패했습니다: " + operation)
        return result_line(out["stdout"])

    def create_smoke_member(self, intro, side):
        """The temporary member kin-smoke-<run> with the plan's roles and group, a generated password kept only in a
        private file of this run's directory; recorded (created) in the state before anything uses it."""
        spec = intro.plan["smoke"]["member"]
        require(spec is not None, "The plan names no smoke member for the unattended smoke")
        earlier = intro.state.get("smoke_member")
        if earlier and not earlier.get("deleted_at"):
            # An earlier member of this plan (e.g. the release's, before a rollback restored the realm) is removed - and
            # its password discarded - before its record is replaced.
            self.remove_smoke_member_now(intro)
        run = intro.request_sha256[:10]
        username = SMOKE_PREFIX + run
        password = smoke_password()
        credentials = "smoke-member-" + side + ".json"
        # IRT2-23: this run's ownership marker - the member's last name and each login client's description carry it,
        # and the cleanup deletes only accounts and clients that carry it (a same-named account it did not make stays).
        marker = uuid.uuid4().hex
        # IRT2-15: the password lives in the run's secrets directory, never among its records (evidence).
        intro.records.write_secret(credentials, canonical({"username": username, "password": password}) + b"\n")
        intro.state["smoke_member"] = {"username": username, "id": None, "side": side, "client_id": None, "client_ids": [],
                                       "credentials": credentials, "marker": marker, "created_at": None, "deleted_at": None}
        intro.save()
        try:
            created = self.smoke_admin(intro, "create-member", {"username": username, "roles": spec["roles"], "group": spec["group"],
                                                                "marker": marker}, password=password)
        except Stop:
            # A settled refusal cannot use this password. UNKNOWN is a different exception and keeps the credentials
            # with the registered worker for diagnosis; cleanup may run only after that worker is known to have ended.
            intro.records.discard_secret(credentials)
            raise
        intro.state["smoke_member"].update(id=created["id"], created_at=utc_now().isoformat())
        intro.save()
        intro.records.journal({"event": "smoke-member-created", "plan_sha256": intro.plan_sha256, "username": username, "side": side})
        return intro.state["smoke_member"]

    def run_browser(self, spec, *, timeout=None, what="login"):
        """The configured headless browser (policy smoke_browser_cmd): the spec (a login's with the password, or the L-01
        probe's) goes on stdin; its one KIN_RESULT line is the answer. Recorded like every command (argv, input and output
        hashes only). D17: the browser runs as its own process tree, which is killed whole on the timeout and after the
        browser ended (no Chromium child outlives it)."""
        timeout = bounded_timeout(timeout if timeout is not None else BROWSER_TIMEOUT_S)
        budget = _smoke_budget.get() or SmokeBudget(timeout + SMOKE_CLEANUP_S)
        if os.name == "posix":
            SystemdBrowser.command(self.browser_cmd)
        resource = "kin-browser-" + uuid.uuid4().hex + (".service" if os.name == "posix" else "")
        worker = self.register_worker("browser", resource, budget.end - time.monotonic())
        worker.update(profile=spec["profile_dir"], attempt=spec.get("attempt", 0),
                      work_deadline=budget.work_end, cleanup_deadline=budget.end)
        self.intro.save()
        spec = {**spec, "work_deadline": budget.work_end, "supervised": True}
        entry = {"argv": redact_argv(self.browser_cmd), "env": [], "mutating": False, "timeout_s": timeout, "started_utc": utc_now().isoformat(),
                 "input": output_record(json.dumps(spec).encode()), "browser": what}
        started = time.monotonic()
        try:
            if os.name == "posix":
                code, stdout, stderr = SystemdBrowser(worker, self.records, self.intro.save, budget).run(
                    self.browser_cmd, json.dumps(spec).encode())
            else:
                code, stdout, stderr = run_tree(self.browser_cmd, input=json.dumps(spec).encode(), timeout=timeout,
                                                deadline=budget.end)
        except subprocess.TimeoutExpired as error:
            if os.name == "posix" and not isinstance(error, BrowserTimeout):
                worker.update(state="UNKNOWN", observation_error={"location": "browser-supervisor", "type": "TimeoutExpired"})
                self.intro.save()
                entry.update(outcome="unknown", error="TimeoutExpired", seconds=round(time.monotonic() - started, 3))
                self.records.command(entry)
                raise Unknown("browser 감독 명령 timeout 뒤 전체 종료를 확인하지 못했습니다") from None
            worker.update(state="QUIET", supervisor="systemd-cgroup-v2" if os.name == "posix" else "windows-job",
                          termination="confirmed-timeout")
            self.intro.save()
            entry.update(outcome="timeout", seconds=round(time.monotonic() - started, 3), tree="killed")
            self.records.command(entry)
            raise Stop("smoke browser 제한 시간 뒤 전체 실행 단위의 종료를 확인했습니다") from None
        except OSError as error:
            # Assignment/spawn may have partly succeeded. Only an affirmative supervisor result permits cleanup.
            worker.update(state="UNKNOWN")
            self.intro.save()
            entry.update(outcome="error", error=type(error).__name__, seconds=round(time.monotonic() - started, 3))
            self.records.command(entry)
            raise Unknown("smoke browser의 시작·전체 종료를 확인하지 못했습니다") from None
        except Exception as error:
            worker.update(state="UNKNOWN")
            self.intro.save()
            entry.update(outcome="unknown", error=type(error).__name__, observation=worker.get("observation_error"),
                         seconds=round(time.monotonic() - started, 3))
            self.records.command(entry)
            raise Unknown("smoke browser의 전체 종료를 확인하지 못했습니다") from None
        worker.update(state="QUIET", supervisor="systemd-cgroup-v2" if os.name == "posix" else "windows-job",
                      client_exit=code, termination="confirmed")
        self.intro.save()
        entry.update(outcome="exit", exit=code, seconds=round(time.monotonic() - started, 3),
                     stdout=output_record(stdout), stderr=output_record(stderr))
        self.records.command(entry)
        if code:
            # The browser's own record-safe failure code (a fixed check message or an error type; see code_of).
            try:
                failure = json.loads(stderr.decode("utf-8").strip().splitlines()[-1])
                reason = failure.get("error")
            except (ValueError, IndexError, AttributeError, UnicodeDecodeError):
                failure, reason = {}, None
            refusal = SmokeRefusal if failure.get("retryable") is False else Stop
            raise refusal("smoke browser " + what + " 실행이 실패했습니다" + (": " + reason[:160] if type(reason) is str else ""))
        return result_line(stdout)

    def cleanup_browser_profile(self, profile):
        pending = [item for item in self.intro.state.get("workers", {}).values() if item.get("state") != "QUIET"]
        if pending:
            raise Unknown("작업 종료가 미결이므로 browser profile을 보존했습니다")
        try:
            budget = _smoke_budget.get()
            with budget.cleanup() if budget else nullcontext():
                remove_profile(profile, seconds=bounded_timeout(15))
        except Exception:
            raise Unknown("browser profile 정리를 확인하지 못했습니다") from None

    def browser_check(self, intro):
        """D01 (L-01, before the fence): the policy's browser command is an executable file and the browser it runs opens a
        blank page in a new profile folder and ends with exit 0 within BROWSER_PROBE_S; the browsers' folder it names
        (PLAYWRIGHT_BROWSERS_PATH) resolves. A missing or broken browser stops here, not after the migration."""
        with smoke_attempt(BROWSER_PROBE_S + SMOKE_CLEANUP_S,
                           intro.deadline_left() if hasattr(intro, "deadline_left") else None):
            return self.browser_probe_attempt(intro)

    def browser_probe_attempt(self, intro):
        program = Path(self.browser_cmd[0])
        require(program.is_absolute() and program.is_file() and os.access(program, os.X_OK),
                "The smoke browser command is not an executable file: " + str(program))
        profile = intro.records.secret("browser-probe-" + uuid.uuid4().hex[:8])
        try:
            value = self.run_browser({"probe": True, "profile_dir": str(profile)}, timeout=BROWSER_PROBE_S, what="probe")
        finally:
            self.cleanup_browser_profile(profile)
        require(type(value) is dict and value.get("probe") == "ok" and type(value.get("browser")) is str,
                "The smoke browser did not open a blank page")
        return {"program": str(program), "browser": value["browser"][:80], "browsers_path": value.get("browsers_path")}

    def browser_login(self, intro, *, connect, product_session=False, timeout=None, attempt=1):
        """One real Authorization Code + PKCE login of the smoke member in the headless browser, through a temporary public
        client (removed with the member; a retry makes its own); the token must belong to that member. product_session
        (the introduced release): first the product's own sign-in, its logout and the refusal of the ended session, in
        the same browser."""
        member = intro.state["smoke_member"]
        credentials = json.loads(intro.records.read_secret(member["credentials"]))
        client_id = member["username"] + "-client" + ("" if attempt == 1 else "-" + str(attempt))
        redirect = "https://" + SMOKE_REDIRECT_HOST + "/" + member["username"]
        member["client_id"] = client_id
        member["client_ids"] = sorted({*(member.get("client_ids") or []), client_id})
        intro.save()
        created = self.smoke_admin(intro, "create-client", {"client_id": client_id, "redirect_uri": redirect, "marker": member["marker"]})
        member.setdefault("client_objects", {})[client_id] = created["id"]
        intro.save()
        # The browser's profile (its cookies are this member's session) lives in this run's secrets folder and is gone
        # after the login, whatever the browser did; every attempt has a new one.
        profile = intro.records.secret("browser-profile-" + uuid.uuid4().hex[:8])
        try:
            value = self.run_browser({"origin": self.t["origin"], "connect": list(connect) if connect else None, "ca_file": self.t["ca_file"],
                                      "username": credentials["username"], "password": credentials["password"], "client_id": client_id,
                                      "redirect_uri": redirect, "profile_dir": str(profile), "product_session": product_session,
                                      "study_uid": frame_study(intro.plan) if product_session else None, "attempt": attempt},
                                     timeout=timeout)
        finally:
            self.cleanup_browser_profile(profile)
        require(type(value) is dict and value.get("flow") == "authorization_code+S256" and type(value.get("refresh_token")) is str,
                "The smoke browser did not return an authorization-code login")
        token = token_valid({"access_token": value.get("access_token"), "subject": value.get("subject")})
        require_smoke(token["subject"] == member["id"], "The browser login belongs to another subject")
        return token, value["refresh_token"], client_id, value

    def end_session(self, refresh_token, client_id, *, connect):
        """The temporary client's own sign-in session ends with the smoke (its access token is a bearer credential the API
        checks statelessly until it expires; the product's session logout is the browser's check)."""
        code, _ = https_post(self.t["origin"], "/auth/realms/kin/protocol/openid-connect/logout",
                             {"client_id": client_id, "refresh_token": refresh_token}, connect=connect, ca_file=self.t["ca_file"])
        require(code in (200, 204), "The smoke login session could not be ended")

    def remove_smoke_member_now(self, intro):
        if any(row.get("state") != "QUIET" for row in intro.state.get("workers", {}).values()):
            raise Unknown("작업 종료가 미결이므로 임시 계정과 비밀 자료를 보존했습니다")
        member = intro.state.get("smoke_member")
        if member and not member.get("deleted_at"):
            clients = sorted({*(member.get("client_ids") or []), *([member["client_id"]] if member.get("client_id") else [])})
            # IRT2-23: only what carries this run's marker is removed; a same-named account or client stays (and the
            # realm check below then refuses any reopen while an account named like a smoke member exists).
            identity = {"username": member["username"], "client_ids": clients, "marker": member["marker"]}
            # A helper may have exited after creation and before returning its ID. Recover only objects with this
            # attempt's random marker, persist their immutable IDs, then require those IDs again during removal.
            owned = self.smoke_admin(intro, "owned", identity)
            require(type(owned.get("users")) is list and type(owned.get("clients")) is list,
                    "임시 계정의 불변 ID 목록을 확인하지 못했습니다")
            require(member.get("id") is None or set(owned["users"]) <= {member["id"]}, "임시 계정 신원이 교체됐습니다")
            known = set(member.get("client_objects", {}).values())
            require(not known or known <= set(owned["clients"]), "임시 로그인 client 신원을 확인하지 못했습니다")
            member["cleanup_objects"] = owned
            intro.save()
            removed = self.smoke_admin(intro, "remove", {**identity, "user_ids": owned["users"], "object_ids": owned["clients"]})
            require(removed.get("user_absent") is True and removed.get("client_absent") is True, "The smoke member or its client is still present")
            member["deleted_at"] = utc_now().isoformat()
            member["foreign_kept"] = {"users": removed.get("foreign_users", 0), "clients": removed.get("foreign_clients", 0)}
            intro.save()
            intro.records.journal({"event": "smoke-member-deleted", "plan_sha256": intro.plan_sha256, "username": member["username"],
                                   "foreign_kept": member["foreign_kept"]})
        if member and member.get("deleted_at"):
            # The password of a member that no longer exists is not kept.
            intro.records.discard_secret(member["credentials"])
        require(self.psql(SMOKE_MEMBERS_SQL, "keycloak") == "0", "The smoke member still exists")
        return {"member": member["username"] if member else None, "deleted": bool(member)}

    def write_smoke_record(self, intro, checks, name):
        record = {"schema": 1, "kind": "operator-smoke", "plan_sha256": intro.plan_sha256, "checks": checks,
                  "passed": all(value is True for value in checks.values()), "by": SMOKE_BY, "at": utc_now().isoformat()}
        digest = intro.records.put(name, record)
        return record, {"file": name, "sha256": digest}

    def unattended_release_smoke(self, intro, connect):
        """L-10a unattended: the eight operator checks, by the executor (D1062), with the smoke member made at L-08b. The
        product's own sign-in and logout run in the browser (the ended session must be refused); the worklist, frame and
        W2 checks use the temporary client's fresh token. D07: when the phase retries this step (intro.retrying), the
        attempt has its own login client and browser profile within SMOKE_RETRY_S, and the first attempt's record is kept
        as operator-smoke-attempt-1.json."""
        retrying = bool(getattr(intro, "retrying", False))
        if retrying:
            first = intro.records.directory / "operator-smoke.json"
            if first.exists():
                raw = intro.records.read(first)
                intro.records.write(intro.records.directory / "operator-smoke-attempt-1.json", raw)
                intro.records.discard(first)
            intro.state.pop("operator_smoke", None)
            intro.save()
        with smoke_attempt(SMOKE_RETRY_S if retrying else BROWSER_TIMEOUT_S,
                           intro.deadline_left() if hasattr(intro, "deadline_left") else None):
            return self.release_smoke_attempt(intro, connect)

    def release_smoke_attempt(self, intro, connect, *, timeout=None):
        """One attempt of the unattended release smoke (see unattended_release_smoke)."""
        member = intro.state.get("smoke_member") or {}
        attempt = len(member.get("client_ids") or []) + 1
        token, refresh, client_id, value = self.browser_login(intro, connect=connect, product_session=True, timeout=timeout, attempt=attempt)
        issued = token_claims(token).get("iat")
        require_smoke(type(issued) is int and issued >= int(parse_utc(intro.state["imported_at"]).timestamp()), "The smoke login predates the member import")
        result = smoke(self.t["origin"], connect=connect, ca_file=self.t["ca_file"], token=token, frame=self.frame(intro),
                       worklist_uid=frame_study(intro.plan))
        require(smoke_passed(result), "The fenced smoke did not run every check")
        row = worklist_row(self.t["origin"], frame_study(intro.plan), connect=connect, ca_file=self.t["ca_file"], token=token["access_token"])
        session = value.get("product_session")
        screens = session.get("screens") if type(session) is dict else None
        screen = lambda name: type(screens) is dict and screens.get(name) is True
        # IRT2-11: each check is its API answer (by its contract) and the screen that uses it, both.
        checks = {"login_pkce": type(session) is dict and session.get("signed_in") is True,
                  "worklist_uid": screen("worklist_row"),
                  "ohif_frame": screen("viewer_rendered") and screen("reading_workspace"),
                  "realm_v1_pending_zero": True,
                  "w2_modality": type((row or {}).get("modality")) is str and bool(row["modality"]) and screen("modality_rendered"),
                  "logout_old_session_refused": product_logout_refused(session)}
        for name, path, valid, shown in (("w2_folders", "/api/filter-folders", folders_valid, "folders_loaded"),
                                         ("w2_shortcuts", "/api/workspace-shortcuts", shortcuts_valid, "shortcuts_dialog")):
            code, _, raw = https_get(self.t["origin"], path, connect=connect, ca_file=self.t["ca_file"], token=token["access_token"])
            try:
                checks[name] = code == 200 and valid(json.loads(raw)) and screen(shown)
            except ValueError:
                checks[name] = False
        self.end_session(refresh, client_id, connect=connect)
        record, stored = self.write_smoke_record(intro, {name: checks[name] for name in OPERATOR_SMOKE_CHECKS}, "operator-smoke.json")
        require(record["passed"], "The unattended smoke failed: " + ",".join(sorted(name for name, value in checks.items() if not value)))
        operator_smoke_valid(record, intro.plan_sha256)
        intro.state["operator_smoke"] = stored
        intro.save()
        return {**result, "checks": checks, "record_sha256": stored["sha256"]}

    def remove_smoke_member(self, intro):
        """L-10e: before anything reopens, the smoke member and its client are disabled and deleted and the realm holds no
        smoke member (a smoke account with a password this tool knows never meets the public ingress)."""
        return self.remove_smoke_member_now(intro)

    # ── capture ──
    def admit_source(self, intro):
        db = self.inspect("db")
        require(db is not None and db["State"]["Running"] and not db["State"].get("Restarting")
                and db["Image"] == intro.plan["previous"]["images"]["db"], "변경 전 DB 신원 또는 실행 상태가 다릅니다")
        labels = (db.get("Config") or {}).get("Labels") or {}
        require(labels.get("com.docker.compose.project") == self.t["project"] and labels.get("com.docker.compose.service") == "db",
                "변경 전 DB가 선언한 Compose 자원이 아닙니다")
        require(ops._volume_of(db, "/var/lib/postgresql/data") == self.t["volumes"]["pg"], "변경 전 DB volume이 다릅니다")
        try:
            with self.bind():
                catalog, values = ops.restore_admission(self.names["db"], shape="pre", image=db["Image"])
        except ops.RestoreAdmissionError as error:
            intro.records.put("restore-admission-refusal.json", error.evidence)
            raise Stop("변경 전 PostgreSQL 복원 admission이 거절됐습니다. 거절 기록을 확인하세요") from None
        return {"version": ops.RESTORE_INVENTORY, "admitted": True, "object_databases": sorted(catalog["objects"]),
                "value_tables": len(values["tables"]), "before_checkout_correction": True}

    def baseline(self, intro):
        model = self.resolved(intro, maintenance=False)
        check_resolved(model, self.t, target_checkout=False, maintenance=False, images=intro.plan["previous"]["images"])
        self.secure(self.env_file())
        require(self.compose_digest_now() == intro.plan["compose"]["before_sha256"], "Compose files or .env differ from the plan")
        running, restarting, images, inspections = {}, {}, {}, {}
        for role in ROLES:
            item = self.inspect(role)
            require(item is not None, "A service of the previous release does not exist: " + role)
            running[role], restarting[role], images[role] = item["State"]["Running"], bool(item["State"].get("Restarting")), item["Image"]
            inspections[role] = item
        # IRT2-02: the running containers themselves are the checked model's (project, mounts, networks, ports).
        image_volumes = {}
        for role, item in inspections.items():
            image = json.loads(self.text(["docker", "image", "inspect", item["Image"]]))[0]
            require(image.get("Id") == intro.plan["previous"]["images"][role], "고정 이미지 신원이 다릅니다: " + role)
            image_volumes[role] = {path: {"read_only": False} for path in (image.get("Config") or {}).get("Volumes") or {}}
        check_running(inspections, model, self.t, image_volumes)
        self.verify_networks(inspections, model, image_volumes)
        api = self.inspect("api")
        existing = [name for name in (self.t["volumes"]["emr_access"], self.t["volumes"]["emr_state"])
                    if self.volume_exists(name)]
        cron = "not-managed"
        raw = self.cron()
        if raw is not None:
            _, tagged = self.cron_lines(raw, self.t["cron"]["tags"])
            cron = "matched" if all(len(lines) == 1 and not lines[0].lstrip().startswith("#") for lines in tagged.values()) else "mismatch"
        self.image_revision(intro.plan["previous"])
        with self.bind():
            migrations = ops.migration_rows(self.names["db"])
            catalog = ops.role_catalog(self.names["db"])
        require(getattr(self, "source_admission", {}).get("admitted") is True, "변경 전 복원 admission 증거가 없습니다")
        observed = {"head": self.text(["git", "rev-parse", "HEAD"]),
                    "dirty": bool(self.text(["git", "status", "--porcelain", "--untracked-files=no"])),
                    "images": images, "running": running, "restarting": restarting, "migrations": migrations, "catalog": catalog,
                    "emr_volumes": existing, "api_state_mounts": sum(1 for m in api.get("Mounts") or [] if m.get("Destination") == ops.EMR_STATE),
                    "cron": cron, "members": self.realm_members()}
        pre.check_baseline(observed, intro.plan)
        backup_owner = self.backup_owner(intro)
        free = shutil.disk_usage(intro.plan["backup_root"] if Path(intro.plan["backup_root"]).exists() else Path(intro.plan["backup_root"]).parent).free
        require(free >= intro.plan["budget"]["min_free_bytes"], "Free disk space below the plan")
        # L-08a reads the Keycloak server options with the target's administrator. Prove that credential now, read-only,
        # so that a wrong administrator name or password stops here instead of after the first database change.
        keycloak = self.keycloak_selected(intro)
        if self.unattended:
            smoke_policy_valid(keycloak.get("smokePolicy"))
        # D01/D02: what the unattended smoke will need after the migration is proved before the fence - the plan's smoke
        # member can be made in this realm (its roles and group exist) and the configured browser runs.
        member = self.smoke_member_realm(intro)
        browser = self.browser_check(intro) if self.unattended else "not configured (operator smoke)"
        return {"head": observed["head"], "images": images, "migrations": len(observed["migrations"]), "cron": cron, "free_bytes": free,
                "members": observed["members"], "keycloak_admin": "verified", "keycloak_before": keycloak,
                "roles": sorted(role["rolname"] for role in catalog["roles"]), "smoke_member_realm": member, "smoke_browser": browser,
                "backup_root_owner": "the operating account" if backup_owner else "this tool's user"}

    def backup_owner(self, intro):
        """IRT2-03: the backup root (B0, B1, Bfail, the audit ledger) is this tool's own private folder, or - the observed
        production shape - the private folder of the checkout's operating account (policy repository_owner), whose daily
        backups and ledger live there; then what this tool writes there is given to that account. Any other owner, a link
        or a folder open to others is refused here at L-01, before any fence; nothing existing is chown/chmod-ed. Returns
        None or (uid, gid) of that account."""
        root = Path(intro.plan["backup_root"])
        if not root.exists() and not root.is_symlink():
            return None
        info = os.lstat(root)
        require(stat_module.S_ISDIR(info.st_mode), "The backup root is not a folder (or is a link)")
        if os.name != "posix" or info.st_uid == os.geteuid():
            require(os.name != "posix" or not info.st_mode & 0o077, "The backup root is open to others")
            return None
        require(os.geteuid() == 0 and self.owner is not None and info.st_uid == self.owner["uid"] and info.st_gid == self.owner["gid"],
                "The backup root belongs to neither this tool's user nor the checkout's operating account")
        require(not info.st_mode & 0o077, "The backup root is open to others")
        return info.st_uid, info.st_gid

    def give_to_backup_owner(self, intro, path):
        """What this tool wrote into the operating account's backup root becomes that account's (IRT2-03)."""
        ops.give_to(path, self.backup_owner(intro))

    def smoke_member_realm(self, intro):
        """D02: the unattended smoke needs a plan member, and every role and the group the plan gives it exist in realm kin
        (realm roles; a top-level group, as the administration script looks it up); otherwise L-01 stops."""
        member = intro.plan["smoke"]["member"]
        require(member is not None or not self.unattended, "The plan names no smoke member for the unattended smoke")
        if member is None:
            return "no smoke member planned"
        realm = json.loads(self.psql(SMOKE_REALM_SQL, "keycloak"))
        require(type(realm) is dict and type(realm.get("roles")) is list and type(realm.get("top_level_groups")) is list,
                "The realm kin is not readable")
        missing = sorted(set(member["roles"]) - set(realm["roles"]))
        require(not missing, "The plan's smoke member roles are not realm roles: " + ",".join(missing))
        require(member["group"] in realm["top_level_groups"], "The plan's smoke member group is not a top-level group of the realm: " + member["group"])
        return {"roles": sorted(member["roles"]), "group": member["group"]}

    def realm_members(self):
        """Realm kin's people by count only (read-only SQL on the Keycloak database): members as the product counts them
        (keycloak.service.ts excludes service accounts, also by their reserved name), the disabled ones, service accounts."""
        value = json.loads(self.psql(REALM_MEMBERS_SQL, "keycloak"))
        return {key: int(value[key]) for key in ("realm_members", "disabled", "service_accounts")}

    def realm_definitions(self):
        return json.loads(self.psql(REALM_DEFINITIONS_SQL, "keycloak"))

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
        with self.bind(), redirect_stdout(printed):
            directory = ops.capture_held(intro.plan["backup_root"], self.resources(), shape=shape, label=label,
                                         config=self.capture_config(),
                                         facts={"origin": self.t["origin"], "project": self.t["project"],
                                                "tls_certificate": self.t["tls_certificate"], "checkout": self.text(["git", "rev-parse", "HEAD"])})
            _, manifest, digest = ops.validate_held(directory)
        self.records.log(label + ".out", printed.getvalue().encode())
        self.hold(directory, intro.plan_sha256, True)
        return {"dir": str(directory), "manifest_sha256": digest, "shape": shape, "counts": manifest["counts"],
                "created_utc": manifest["created_utc"]}

    def capture_b0(self, intro):
        self.freeze(intro)
        intro.state["b0"] = self.capture(intro, "pre", "emr-b0")
        intro.save()
        return intro.state["b0"]

    def restore_check(self, directory):
        """ops.rehearse(): fresh networkless containers and volumes; a pre-EMR B0 restored exactly as a rollback would
        (roles replayed, owners and privileges kept, whole catalog, counts, projection), a post-EMR B1 with owners/ACL,
        tablespace and seal recovery; the Orthanc index with every attachment."""
        printed = io.StringIO()
        try:
            with self.bind(), redirect_stdout(printed):
                ops.rehearse(directory)
        finally:
            for record in Path(directory).glob("rehearsal-*.json"):
                follow_folder_owner(record)
        self.records.log("restore-check-" + Path(directory).name + ".out", printed.getvalue().encode())
        found = sorted(Path(directory).glob("rehearsal-*.json"), key=lambda path: path.stat().st_mtime)
        result = json.loads(found[-1].read_text(encoding="utf-8"))
        require(result.get("success") is True and not result.get("cleanup_failures"), "Same-point restore check failed")
        return {"success": True, "seconds": result.get("seconds"), "emr": result.get("emr"), "orthanc": result.get("orthanc"),
                "catalog": result.get("catalog")}

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
        # Nothing in the database changed: the previous containers resumed as they were (health and refusal only).
        self.keep_operational_volumes(intro)
        return health_check(self.t["origin"], ca_file=self.t["ca_file"], member_rights=False)

    def keep_operational_volumes(self, intro):
        """A later recreate must not let Compose silently replace a missing data volume with an empty one."""
        model = self.resolved(intro, pinned=False)
        identities = {name: self.volume_identity(name) for name in sorted(set(model["volumes"].values()))}
        require(all(type(item.get("created")) is str and item["created"] for item in identities.values()),
                "운영 인계 volume의 생성 신원을 확인하지 못했습니다")
        intro.state["operational_volumes"] = identities
        intro.save()

    # ── introduce ──
    def recheck_fence(self, intro):
        observed = self.freeze(intro)
        with self.bind():
            ops.validate_held(intro.state["b0"]["dir"], intro.state["b0"]["manifest_sha256"])
        return {"freeze": observed, "b0": "valid"}

    def staged_env(self, intro):
        self.secure(self.env_next)
        raw = Path(self.env_next).read_bytes()
        require(sha256_bytes(raw) == intro.plan["secrets"]["env_next_sha256"], "Staged env differs from the plan")
        pre.check_env_secrets(parse_env(raw), intro.plan["secrets"])
        # IRT2-10: the target's .env keeps the ordinary entry (COMPOSE_FILE = the declared list) once it replaces this one.
        require(names_declared_list(raw, self.t), "The staged env does not name the declared compose files (COMPOSE_FILE)")
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
        with self.bind():
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
        # The target's compose files may require other variables: resolve again (the same values, else a refusal).
        self.prepare(intro)
        check_resolved(self.resolved(intro), self.t, target_checkout=True, maintenance=True, images=intro.plan["release"]["images"])
        intro.state["db_recreated"] = True
        intro.save()
        self.compose(["up", "-d", "--no-deps", "--no-build", "--pull", "never", "--force-recreate", "db"], override=self.pins(intro), timeout=180)
        self.db_ready(120, "Database did not become ready")
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
        with self.bind():
            pre.check_provision_first(ops.role_catalog(self.names["db"]), ops.migration_rows(self.names["db"]), intro.plan)
        out = self.one_shot(intro, "emr-provision", [], timeout=300, name="emr-provision")
        require(out["exit"] == 0 and out["container_exit"] == 0, "emr-provision failed")
        with self.bind():
            catalog = ops.role_catalog(self.names["db"])
        logins = {"kin_emr_owner": False, "kin_runtime": True, **intro.plan["secrets"]["logins"]}
        pre.check_provisioned(catalog, intro.plan["storage"], logins)
        return {"exit": out["exit"], "container_exit": out["container_exit"], "logs": out["logs"],
                "roles": sorted(role["rolname"] for role in catalog["roles"])}

    IMPORT_BOOKKEEPING = ("updatedAt",)

    def preserved(self, intro):
        """After the migration: every pre-existing table keeps every value of its B0 columns. Then, with that proven, the
        same rows without the member import's bookkeeping column become the import's reference: the import's intended
        designation/session binding writes rows through Prisma, which also moves their @updatedAt, and nothing else."""
        b0 = Path(intro.state["b0"]["dir"])
        before = json.loads((b0 / "projection.json").read_text(encoding="utf-8"))
        exempt = {"_prisma_migrations", *intro.plan["projection_exempt"]}
        before = {name: value for name, value in before.items() if name not in exempt}
        with self.bind():
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
        with self.bind():
            after = ops.projection(self.names["db"], columns={name: value["columns"] for name, value in reference.items()})
        pre.check_projection_preserved(reference, after)
        return {"tables": len(reference), "ignored_columns": list(self.IMPORT_BOOKKEEPING)}

    def migrate(self, intro):
        timeout = max(60, min(3600, int(intro.deadline_left())))
        out = self.one_shot(intro, "api-migrate", [], timeout=timeout, name="api-migrate")
        require(out["exit"] == 0 and out["container_exit"] == 0, "Installer migration failed")
        with self.bind():
            rows = ops.migration_rows(self.names["db"])
            pre.check_migration_rows(rows, intro.plan["migrations"]["after"])
            pre.check_emr_catalog(ops.emr_catalog(self.names["db"], "kin"))
        placement = json.loads(self.psql(PLACEMENT_SQL))
        pre.check_placement(placement)
        return {"exit": out["exit"], "container_exit": out["container_exit"], "logs": out["logs"], "migrations": len(rows),
                "placement": len(placement), "preserved": self.preserved(intro)}

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
        realm_before = self.realm_definitions()
        # The roster the product reads must be the realm the plan observed: the same members, the same disabled ones.
        counted = self.realm_members()
        pre.check_member_counts(counted, intro.plan["members"])
        smoke_member = None
        if self.unattended:
            # D1062: the unattended smoke's temporary member exists before the import, so the product's own import gives
            # it its rights exactly as for every other member (it is removed again before anything reopens).
            smoke_member = self.create_smoke_member(intro, "release")["username"]
        roster = self.helper(intro, ROSTER_SCRIPT, name="kc-roster")["users"]
        planned = [user for user in roster if user["username"] != smoke_member]
        require(len(planned) == len(roster) - (1 if smoke_member else 0), "The smoke member is missing from the roster")
        pre.check_member_counts({"realm_members": len(planned), "disabled": sum(1 for user in planned if not user["enabled"]),
                                 "service_accounts": counted["service_accounts"]}, intro.plan["members"])
        out = self.one_shot(intro, "api", ["prisma/import-member-rights.cjs"], timeout=600, entrypoint="node", name="member-import")
        require(out["exit"] == 0 and out["container_exit"] == 0 and b"Member rights import completed" in out["stdout"], "Member rights import failed")
        retried = False
        rights = self.helper(intro, RIGHTS_SCRIPT, name="rights")
        if any(change["state"] != "done" for change in rights["legacy"]):
            # The reviewed explicit recovery of the CLI, once; still unconfirmed is a STOP, never a pass.
            retry = self.one_shot(intro, "api", ["prisma/import-member-rights.cjs", "--retry-roster"], timeout=600,
                                  entrypoint="node", name="member-retry")
            retried = {"exit": retry["exit"], "container_exit": retry["container_exit"], "logs": retry["logs"]}
            require(retry["exit"] == 0 and retry["container_exit"] == 0, "The member roster retry left unconfirmed publications")
            rights = self.helper(intro, RIGHTS_SCRIPT, name="rights")
        after = self.helper(intro, ROSTER_SCRIPT, name="kc-roster")["users"]
        realm_after = self.realm_definitions()
        state = "ready" if rights["markers"] == ["realm-v1"] else "pending"
        pre.check_member_import({"markers": rights["markers"], "state": state, "roster_before": roster, "rights": rights["rights"],
                                 "legacy_enable": rights["legacy"], "roster_after": after, "changes": rights["changes"],
                                 "isolated": rights["isolated"], "realm_before": realm_before, "realm_after": realm_after})
        intro.state["imported_at"] = utc_now().isoformat()
        intro.save()
        return {"members": len(roster), "legacy_enable": len(rights["legacy"]), "retried": retried, "exit": out["exit"],
                "container_exit": out["container_exit"], "logs": out["logs"], "preserved": self.preserved_after_import(intro)}

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
        # D05: the recovery's overlays first (a changed or vanished overlay file -> the pinned bytes), then the digest.
        self.prepare(intro)
        require(self.compose_digest_now() == intro.plan["compose"]["before_sha256"], "Previous configuration was not restored")
        if intro.state.pop("db_recreated", False):
            self.compose(["up", "-d", "--no-deps", "--no-build", "--pull", "never", "--force-recreate", "db"], override=self.pins(intro), timeout=180)
            self.db_ready(120, "Database did not become ready")
            reverted.append("db")
        intro.save()
        with self.bind():
            catalog = ops.role_catalog(self.names["db"])
        require(not {role["rolname"] for role in catalog["roles"]} & set(pre.EMR_ROLES), "EMR roles exist after a revert")
        return {"reverted": reverted}

    # ── verify ──
    def frame(self, intro):
        return intro.plan["smoke"]["frame"]

    def fenced_smoke(self, intro):
        if self.unattended:
            result = self.unattended_release_smoke(intro, self.maintenance())
        else:
            token = self.token_since(intro.state["imported_at"], "the member import")
            result = smoke(self.t["origin"], connect=self.maintenance(), ca_file=self.t["ca_file"], token=token, frame=self.frame(intro),
                           worklist_uid=frame_study(intro.plan))
            require(smoke_passed(result), "The fenced smoke did not run every check")
        model = self.resolved(intro)
        try:
            check_resolved(model, self.t, target_checkout=True, maintenance=True, images=intro.plan["release"]["images"])
        except Stop:
            raise SmokeRefusal("smoke 뒤 Compose allowlist가 선언과 다릅니다") from None
        return result

    def probe(self, intro):
        import ops_emr_probe as probe
        result = probe.run(self, intro)
        intro.state["probe"] = {"event_id": result["event_id"], "receipt": result["receipt"], "evidence_sha256": result["evidence_sha256"],
                                "added": result["added"], "replay_duplicates": result["replay_duplicates"], "restart": result["restart"]}
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
        model = self.resolved(intro, pinned=False)
        check_resolved(model, self.t, target_checkout=True, maintenance=True, images=intro.plan["release"]["images"])
        self.verify_running(model)
        image = json.loads(self.text(["docker", "image", "inspect", intro.plan["release"]["images"]["api"]]))[0]
        image_names = {item.split("=", 1)[0] for item in (image.get("Config") or {}).get("Env") or []}
        names = {item.split("=", 1)[0] for item in api["Config"].get("Env") or []}
        require(names - image_names == set(model["api_environment"]) - image_names, "API environment names differ from the release")
        with self.bind():
            pre.check_migration_rows(ops.migration_rows(self.names["db"]), intro.plan["migrations"]["after"])
            # Retention stays OFF: its role (and the reader) keep the planned login state; nothing was granted since L-06b.
            logins = {"kin_emr_owner": False, "kin_runtime": True, **intro.plan["secrets"]["logins"]}
            pre.check_provisioned(ops.role_catalog(self.names["db"]), intro.plan["storage"], logins)
        pre.check_keycloak_serverinfo(self.keycloak_selected(intro))
        require(not self.one_shots_alive(intro), "A one-shot worker of this release exists")
        # No smoke member (or any account named like one) may meet the public ingress.
        require(self.psql(SMOKE_MEMBERS_SQL, "keycloak") == "0", "The smoke member still exists")
        return {"images": images, "api_environment": sorted(names - image_names), "backup": self.backup_readiness(intro),
                "ordinary_entry": self.ordinary_entry_kept()}

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
                target, protocol = port.split("/")
                require(protocol in ("tcp", "udp", "sctp"), "게시 protocol을 해석할 수 없습니다")
                out.append((host + ":" if host and host not in ("0.0.0.0", "::") else "") + value.get("HostPort") + ":" + target
                           + ("/" + protocol if protocol != "tcp" else ""))
        return out

    def public_smoke(self, intro):
        self.keep_operational_volumes(intro)
        if self.unattended:
            # The authenticated checks ran fenced through the same proxy configuration; the smoke member is gone, so the
            # public ingress proves health, the unauthenticated refusal and the realm's sign-in for this origin.
            result = health_check(self.t["origin"], ca_file=self.t["ca_file"], member_rights=True)
            return {**result, "discovery": discovery_check(self.t["origin"], ca_file=self.t["ca_file"]), "authenticated": "fenced (L-10a)"}
        token = self.token_since(intro.state["imported_at"], "the member import")
        result = smoke(self.t["origin"], ca_file=self.t["ca_file"], token=token, frame=self.frame(intro), worklist_uid=frame_study(intro.plan))
        require(smoke_passed(result), "The public smoke did not run every check")
        return result

    # ── rollback ──
    def classify(self, intro):
        try:
            alive = self.one_shots_alive(intro)
        except Exception:
            alive = ["unobservable"]
        if alive:
            intro.state["unknown_hold"] = {"step": "RB-00", "workers": alive, "request_sha256": intro.request_sha256,
                                           "reason": "worker end unconfirmed", "at": utc_now().isoformat()}
            intro.save()
            raise Unknown("보조 작업 종료를 확인하지 못해 복원을 보류했습니다")
        require(intro.state.get("db_changed") is True and not intro.state.get("ponr")
                and not intro.state.get("recovery_reopen") and not intro.state.get("unknown_hold")
                and not intro.state.get("rollback_attempted"), "데이터 복원 admission 상태가 아닙니다")
        b0 = intro.state.get("b0")
        require(type(b0) is dict and (b0.get("restore_check") or {}).get("success") is True,
                "B0의 완전한 복원 확인이 없습니다")
        directory = Path(b0["dir"])
        hold = directory / ops.HOLD_FILE
        require(not directory.is_symlink() and not hold.is_symlink() and hold.is_file() and hold.stat().st_nlink == 1,
                "B0 보존 표식이 없거나 경로가 안전하지 않습니다")
        require(decode(hold.read_bytes()) == {"plan_sha256": intro.plan_sha256, "reason": "emr-introduction"},
                "B0 보존 표식이 현재 실행에 속하지 않습니다")
        with self.bind():
            ops.validate_held(directory, b0["manifest_sha256"])
        require(shutil.disk_usage(intro.plan["backup_root"]).free >= intro.plan["budget"]["min_free_bytes"],
                "실패 자료 보존과 복원에 필요한 여유 공간이 없습니다")
        self.stop_writers()
        observed = self.freeze_without_cron(intro)
        return {"workers": "quiet", "freeze": observed, "held_b0": b0["manifest_sha256"], "reserve": "checked"}

    def freeze_without_cron(self, intro):
        return self.freeze(intro)

    def preserve_failed(self, intro):
        """Bfail: the failed database (with whatever EMR state exists) and the identities of every volume this attempt
        touched. Nothing is deleted or reused."""
        state_volume = self.t["volumes"]["emr_state"]
        has_state = self.volume_exists(state_volume)
        directory = Path(intro.plan["backup_root"]) / ("emr-bfail-" + utc_now().strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8])
        directory.mkdir(mode=0o700, parents=False)
        components = {}
        for database in ("kin", "keycloak"):
            with open(directory / (database + ".dump"), "wb") as handle:
                self.cmd(["docker", "exec", self.names["db"], "pg_dump", "-U", "kin", "-d", database, "--encoding=UTF8", "-Fc", "--create"],
                         output=handle, timeout=1800)
        with open(directory / "cluster-roles.sql", "wb") as handle:
            self.cmd(["docker", "exec", self.names["db"], "pg_dumpall", "-U", "kin", "--encoding=UTF8", "--roles-only", "--no-role-passwords"], output=handle)
        with self.bind():
            (directory / "catalog.json").write_text(json.dumps(ops.role_catalog(self.names["db"]), sort_keys=True) + "\n", encoding="utf-8")
            (directory / "migrations.json").write_text(json.dumps(ops.migration_rows(self.names["db"])) + "\n", encoding="utf-8")
            if has_state:
                with open(directory / "emr-state.tgz", "wb") as handle:
                    ops.temporary_run(["--network", "none", "--read-only", "--mount", f"type=volume,source={state_volume},target=/source,readonly",
                                       "--entrypoint", "tar", intro.plan["release"]["images"]["db"], "-czf", "-", "-C", "/source", "."],
                                      timeout=1800, output=handle)
        identities = {key: self.volume_identity(name) for key, name in self.t["volumes"].items()
                      if self.volume_exists(name)}
        for path in sorted(directory.iterdir()):
            if os.name == "posix":
                path.chmod(0o600)
            components[path.name] = ops.digest(path)
        manifest = {"format": 1, "kind": "failed-state", "plan_sha256": intro.plan_sha256, "created_utc": utc_now().isoformat(),
                    "sha256": components, "volumes": identities, "kept": "never deleted or reused by this mode"}
        (directory / "manifest.json").write_text(json.dumps(manifest, sort_keys=True, indent=1) + "\n", encoding="utf-8")
        if os.name == "posix":
            (directory / "manifest.json").chmod(0o600)
        self.give_to_backup_owner(intro, directory)
        intro.state["bfail"] = {"dir": str(directory), "manifest_sha256": ops.digest(directory / "manifest.json"), "volumes": identities}
        intro.save()
        return intro.state["bfail"]

    def remove_container(self, role):
        """The failed state's container goes (stopped first); its volumes stay - Bfail recorded every one of them."""
        item = self.inspect(role)
        if item is None:
            return False
        if item["State"]["Running"]:
            self.cmd(["docker", "stop", "--time", "45", self.names[role]], timeout=120, mutating=True)
        self.cmd(["docker", "rm", self.names[role]], timeout=60, mutating=True)
        return True

    def recovery_project(self, intro):
        base = self.t["project"][:52].rstrip("-_")
        return base + "-rb" + uuid.uuid4().hex[:8]

    def restore_b0(self, intro):
        """B0 into FRESH recovery volumes of a recovery Compose project, never over the migrated database. The checkout's
        own configuration then names that project (COMPOSE_PROJECT_NAME in .env): any later compose command of this
        checkout - the API-only runner, an operator's recreate - resolves pg and Orthanc to the recovery volumes, never
        to the failed ones, which stay detached and kept under their original names."""
        b0 = Path(intro.state["b0"]["dir"])
        with self.bind():
            _, manifest, _ = ops.validate_held(b0, intro.state["b0"]["manifest_sha256"])
        if intro.state["checkout"] != "previous":
            self.checkout(intro, "previous")
        previous_env = (b0 / ".env").read_bytes()
        self.write_env(previous_env)
        # D05: the recovery's overlays first (a changed or vanished overlay file -> the pinned bytes), then the digest.
        self.prepare(intro)
        require(self.compose_digest_now() == intro.plan["compose"]["before_sha256"], "Previous configuration was not restored")
        project = self.recovery_project(intro)
        recovery = {"project": project, "pg": project + "_pg-db", "orthanc": project + "_orthanc-db", "persisted": False}
        for name in (recovery["pg"], recovery["orthanc"]):
            require(not self.volume_exists(name), "A recovery volume name is taken: " + name)
        # Durable before creation: a failed restore still names exactly the project and volumes it made.
        intro.state["recovery"] = recovery
        intro.save()
        for key, name in (("pg-db", recovery["pg"]), ("orthanc-db", recovery["orthanc"])):
            self.cmd(["docker", "volume", "create", "--label", "com.docker.compose.project=" + project, "--label", "com.docker.compose.volume=" + key,
                      "--label", "kin.ops.recovery=" + intro.plan_sha256[:16], name], mutating=True)
        # Only this named interval admits absence. Persist the exact target before removal; an interrupted interval
        # remains a running/unknown phase and is never interpreted as permission to repeat the restore.
        intro.state["db_transition"] = {"step": "RB-02", "container": self.names["db"],
                                        "volume": recovery["pg"], "state": "REMOVING"}
        intro.save()
        self.remove_container("db")
        checkpoint = intro.observe("RB-02", "db-removed")
        intro.records.put("checkpoint-rb02-db-removed.json", checkpoint)
        if not workers_quiet(checkpoint):
            raise Unknown("DB 제거 뒤 생성 전 필수 관측을 확인하지 못했습니다")
        facts = checkpoint["facts"]
        fence = facts["fences"]["value"]
        require(facts["database"] == absent() and facts["lock"]["value"]["owned"]
                and not any(fence["writers"].values()) and fence["cron"] in ("fenced", "not-managed")
                and fence["ingress"] == "closed", "DB 생성 전 부재·writer 차단 상태가 다릅니다")
        intro.state["db_transition"]["state"] = "ABSENT_CONFIRMED"
        intro.save()
        recovery_env = set_env_line(previous_env, "COMPOSE_PROJECT_NAME", project)
        self.write_env(recovery_env)
        recovery.update(env_sha256=sha256_bytes(recovery_env), compose_sha256=self.compose_digest_now())
        intro.save()
        self.compose(["up", "-d", "--no-deps", "--no-build", "--pull", "never", "db"], override=self.pins(intro), timeout=180, project=project)
        self.db_ready(180, "Recovery database did not become ready")
        intro.state["db_transition"]["state"] = "READY"
        intro.save()
        db = self.inspect("db")
        require({m.get("Destination"): m.get("Name") for m in db.get("Mounts") or []}.get("/var/lib/postgresql/data") == recovery["pg"],
                "Recovery database is not on its fresh volume")
        with self.bind():
            restored = ops.restore_pre_snapshot(self.names["db"], b0)
            # IRT2-24: every row of kin (every schema) and of Keycloak is B0's, before anything starts on it.
            require(ops.value_catalog(self.names["db"]) == json.loads((b0 / "values.json").read_text(encoding="utf-8")),
                    "Restored row values differ from B0")
        with open(b0 / "orthanc.tgz", "rb") as handle:
            self.cmd(["docker", "run", "--rm", "-i", "--network", "none", "--label", "kin.ops.recovery=" + intro.plan_sha256[:16],
                      "--mount", "type=volume,source=" + recovery["orthanc"] + ",target=/restore", "--entrypoint", "tar",
                      intro.plan["previous"]["images"]["db"], "-xzf", "-", "-C", "/restore"], stdin=handle, timeout=1800, mutating=True)
        checked = json.loads(self.text(["docker", "run", "--rm", "--network", "none", "--read-only", "--mount",
                                        "type=volume,source=" + recovery["orthanc"] + ",target=/restore,readonly", "--entrypoint", "python3",
                                        intro.plan["previous"]["images"]["orthanc"], "-c", ops.SQLITE_CHECK], timeout=600))
        require(checked.get("integrity") == "ok", "Restored Orthanc index failed")
        with self.bind():
            require(ops.value_counts(ops.value_catalog(self.names["db"])) == manifest["counts"], "복원된 구조화 행 수가 B0와 다릅니다")
            pre.check_migration_rows(ops.migration_rows(self.names["db"]), intro.plan["migrations"]["before"])
            before = json.loads((b0 / "projection.json").read_text(encoding="utf-8"))
            pre.check_projection_preserved(before, ops.projection(self.names["db"], columns={k: v["columns"] for k, v in before.items()}))
            roles = {role["rolname"] for role in ops.role_catalog(self.names["db"])["roles"]}
        require(not roles & set(pre.EMR_ROLES), "EMR roles exist in the restored cluster")
        return {"recovery": recovery, "orthanc": checked, "catalog": restored}

    def previous_services(self, intro):
        recovery = intro.state["recovery"]
        override = self.pins(intro)
        for role in ("keycloak", "orthanc", "api", "proxy"):
            self.remove_container(role)
            self.compose(["up", "-d", "--no-deps", "--no-build", "--pull", "never", role], override=override, timeout=240, project=recovery["project"])
        self.api_health(member_rights=False)
        self.wait(lambda: self.proxy_observed(intro)["running"], 60, "Proxy did not start")
        orthanc = self.inspect("orthanc")
        require({m.get("Destination"): m.get("Name") for m in orthanc.get("Mounts") or []}.get("/var/lib/orthanc/db")
                == recovery["orthanc"], "Orthanc is not on its recovery volume")
        api = self.inspect("api")
        require(api["Image"] == intro.plan["previous"]["images"]["api"]
                and not any(m.get("Destination") == ops.EMR_STATE for m in api.get("Mounts") or []), "Previous API differs or holds EMR state")
        images = {role: self.inspect(role)["Image"] for role in ROLES}
        require(images == intro.plan["previous"]["images"], "Recovery services do not run the previous images")
        return {"images": images, "project": recovery["project"]}

    def recovery_persisted(self, intro):
        """RB-04a: what an ordinary compose command of this checkout resolves to (no project flag, no pins) is the
        recovery project, its pg/Orthanc volumes and the previous images; every service runs in that project; the
        failed volumes exist with their recorded identities and no container uses them. Recorded as the handover."""
        recovery = intro.state["recovery"]
        model = self.resolved(intro, pinned=False)
        check_resolved(model, self.t, target_checkout=False, maintenance=True, recovery=recovery, images=intro.plan["previous"]["images"])
        self.verify_running(model)
        for role in ROLES:
            item = self.inspect(role)
            require(item and item["State"]["Running"] and item["Image"] == intro.plan["previous"]["images"][role]
                    and (item["Config"].get("Labels") or {}).get("com.docker.compose.project") == recovery["project"],
                    "A service does not run the previous image in the recovery project: " + role)
        failed = {}
        for key, identity in (intro.state["bfail"]["volumes"] or {}).items():
            require(self.volume_identity(identity["name"]) == identity, "A failed volume changed: " + key)
            users = self.text(["docker", "ps", "-a", "--filter", "volume=" + identity["name"], "--format", "{{.Names}}"])
            require(not users.strip(), "A failed volume is attached to a container: " + key)
            failed[key] = identity
        entry = self.ordinary_entry_kept()
        baseline = {"schema": 1, "kind": "recovery-baseline", "plan_sha256": intro.plan_sha256, "project": recovery["project"],
                    "ordinary_entry": entry,
                    "volumes": {"pg": recovery["pg"], "orthanc": recovery["orthanc"]}, "images": intro.plan["previous"]["images"],
                    "previous_sha": intro.plan["previous"]["sha"], "env_sha256": recovery["env_sha256"],
                    "compose_sha256": recovery["compose_sha256"], "failed_volumes_kept": failed,
                    "bfail_manifest_sha256": intro.state["bfail"]["manifest_sha256"],
                    "handover": ["운영 재생성은 /opt/kin-deploy/entry.py compose recreate를 사용합니다.",
                                 "기존 API 배포 경로와 bare/explicit-f Compose 절차는 중간 릴리스에서 지원하지 않습니다.",
                                 "실패 볼륨은 분석을 위해 보존하며 재연결하거나 삭제하지 않습니다."]}
        recovery["baseline_sha256"] = intro.records.put("recovery-baseline.json", baseline)
        recovery["persisted"] = True
        intro.save()
        return {"project": recovery["project"], "volumes": baseline["volumes"], "failed_volumes_kept": sorted(failed),
                "baseline_sha256": recovery["baseline_sha256"]}

    def previous_smoke(self, intro, *, connect):
        token = self.token_since(intro.state["restored_at"], "this rollback restored the previous version")
        frame = self.frame(intro)
        result = smoke(self.t["origin"], connect=connect, ca_file=self.t["ca_file"], token=token, frame=frame,
                       worklist_uid=frame_study(intro.plan), member_rights=False)
        require(smoke_passed(result), "The previous-version smoke did not run every check")
        return result

    def unattended_previous_smoke(self, intro, connect):
        """RB-04b unattended: a smoke member made in the restored realm (so its login is necessarily after the restore),
        the headless-browser login, the previous version's own checks, then the member deleted again - whatever happened."""
        self.create_smoke_member(intro, "previous")
        try:
            token, refresh, client_id, _ = self.browser_login(intro, connect=connect)
            issued = token_claims(token).get("iat")
            require_smoke(type(issued) is int and issued >= int(parse_utc(intro.state["restored_at"]).timestamp()),
                    "The smoke login predates this rollback's restore")
            result = smoke(self.t["origin"], connect=connect, ca_file=self.t["ca_file"], token=token, frame=self.frame(intro),
                           worklist_uid=frame_study(intro.plan), member_rights=False)
            require(smoke_passed(result), "The previous-version smoke did not run every check")
            self.end_session(refresh, client_id, connect=connect)
            record, stored = self.write_smoke_record(intro, {name: True for name in PREVIOUS_SMOKE_CHECKS}, "operator-smoke-previous.json")
            intro.state["rollback_smoke_record"] = stored
        finally:
            self.remove_smoke_member_now(intro)
        return result

    def fenced_previous_smoke(self, intro):
        """RB-04b: the previous version proves itself before anything opens: a login made after the restore, the worklist
        listing the plan's study and the exact frame bytes, through the maintenance ingress."""
        with smoke_attempt(BROWSER_TIMEOUT_S, intro.deadline_left()):
            if self.unattended:
                result = self.unattended_previous_smoke(intro, self.maintenance())
            else:
                result = self.previous_smoke(intro, connect=self.maintenance())
            frame = self.frame(intro)
            intro.state["rollback_smoke"] = {"member": True, "token_after_restore": True, "worklist_uid": frame_study(intro.plan),
                                             "frame_sha256": frame["sha256"], "frame_bytes": frame["bytes"]}
            intro.save()
            return result

    def restore_jobs_after_rollback(self, intro):
        require(intro.state.get("rollback_smoke"), "The previous-version smoke has not passed")
        return self.restore_cron(intro)

    def reopen_previous_ingress(self, intro):
        require(intro.state.get("rollback_smoke") and intro.state["recovery"].get("persisted"), "The previous version has not proved itself")
        require(self.psql(SMOKE_MEMBERS_SQL, "keycloak") == "0", "The smoke member still exists")
        self.compose(["up", "-d", "--no-deps", "--no-build", "--pull", "never", "--force-recreate", "proxy"],
                     override=self.pins(intro, maintenance=False), timeout=180, project=intro.state["recovery"]["project"])
        self.wait(lambda: self.proxy_observed(intro)["running"], 60, "Proxy did not start")
        observed = self.proxy_observed(intro)
        pre.check_proxy(observed, intro.plan["previous"]["images"]["proxy"])
        ports = self.resolved_public(intro)
        require(sorted(ports) == sorted(self.t["ports"]["public"]), "Public ports differ from the target manifest")
        return {"proxy": observed, "ports": ports}

    def public_previous_smoke(self, intro):
        self.keep_operational_volumes(intro)
        if self.unattended:
            result = health_check(self.t["origin"], ca_file=self.t["ca_file"], member_rights=False)
            return {**result, "discovery": discovery_check(self.t["origin"], ca_file=self.t["ca_file"]), "authenticated": "fenced (RB-04b)"}
        return self.previous_smoke(intro, connect=None)

    # ── rehearsal seed ──
    def seed_check(self, intro):
        """S-01, before any change: the seed is a verified pre-EMR B0 copy this tool can rebuild exactly; the clone's own
        configuration is the planned one (digest), resolves to exactly the target manifest (names, volumes and mounts,
        networks, ports, origin, images) and carries its own secrets and origin; no clone resource exists yet."""
        seed = intro.plan["seed"]
        with self.bind():
            _, manifest, digest = ops.validate_held(seed["b0_dir"], seed["b0_manifest_sha256"])
        require(manifest["shape"] == "pre", "The seed is not a pre-EMR snapshot")
        # The target first: what the clone's compose actually resolves to must be exactly the manifest's clone.
        model = self.resolved(intro, maintenance=False)
        check_resolved(model, self.t, target_checkout=False, maintenance=False, images=intro.plan["previous"]["images"])
        self.secure(self.env_file())
        require(self.compose_digest_now() == intro.plan["compose"]["before_sha256"], "Clone compose files or .env differ from the plan")
        source = parse_env((Path(seed["b0_dir"]) / ".env").read_bytes())
        clone = parse_env(self.env_file().read_bytes())
        shared = [name for name in CLONE_SECRETS if name in source and name in clone and source[name] == clone[name]]
        require(not shared, "The clone reuses a source secret")
        require(all(clone.get(name) for name in CLONE_SECRETS if source.get(name)), "The clone lacks its own value for a source secret")
        require(clone.get("PUBLIC_ORIGIN") == self.t["origin"], "The clone's PUBLIC_ORIGIN is not the target origin")
        # IRT2-10: a clone with a declared overlay names the declared list in its .env from the start (the VM preparer
        # writes it; the plan's digest covers it), as production's capture writes it at L-00b.
        self.ordinary_entry_kept()
        catalog = Path(seed["b0_dir"]) / "catalog.json"
        require(catalog.is_file(), "The seed has no cluster catalog")
        ops.supported_pre_catalog(json.loads(catalog.read_text(encoding="utf-8")))
        require(not any(self.inspect(role) for role in ROLES), "Clone containers already exist")
        require(not any(self.volume_exists(name) for name in self.t["volumes"].values()),
                "Clone volumes already exist")
        require(intro.state["checkout"] == "previous" and self.text(["git", "rev-parse", "HEAD"]) == intro.plan["previous"]["sha"],
                "Clone checkout is not the previous release")
        certificate = self.certificate_volume_check(intro, model)
        return {"source_manifest_sha256": digest, "secrets_isolated": True, "resolved": "target manifest", "certificate": certificate}

    def certificate_volume_check(self, intro, model):
        """D1066: the clone's proxy reads its certificate from a named volume, which must already hold the clone's kin.crt
        and kin.key before the proxy first starts (an empty volume would make the image generate a self-signed pair that
        the CA file does not trust). The seed never fills it: an absent or empty volume, or a certificate that does not
        fit the origin's host, the CA file or the next seven days, is a refusal before any change. Read-only check: a
        networkless, read-only container of the previous proxy image with the volume and the CA file mounted read-only
        (the volume is inspected first, so the check never creates it)."""
        sources = [entry["source"] for entry in model["mounts"].get("proxy", []) if entry["type"] == "volume" and entry["target"] == "/etc/nginx/certs"]
        require(len(sources) == 1 and model["volumes"].get(sources[0]), "The clone proxy has no certificate volume")
        volume = model["volumes"][sources[0]]
        require(self.volume_exists(volume),
                "The clone certificate volume does not exist; fill it with kin.crt and kin.key before the seed: " + volume)
        host = urlsplit(self.t["origin"]).hostname
        # D30: the key is the certificate's own (their public keys are equal, any key type), and the chain verifies against
        # the CA file (else the image's trust store), intermediates taken from the certificate file itself.
        script = ('test -s /certs/kin.crt && test -s /certs/kin.key && openssl x509 -in /certs/kin.crt -noout -checkend 604800 >/dev/null '
                  '&& openssl x509 -in /certs/kin.crt -noout "$2" "$1" | grep -q " does match " '
                  '&& certificate_key="$(openssl x509 -in /certs/kin.crt -noout -pubkey)" && private_key="$(openssl pkey -in /certs/kin.key -pubout)" '
                  '&& [ -n "$certificate_key" ] && [ "$certificate_key" = "$private_key" ] '
                  '&& if [ -e /kin-ca.pem ]; then openssl verify -CAfile /kin-ca.pem -untrusted /certs/kin.crt /certs/kin.crt >/dev/null; '
                  'else openssl verify -untrusted /certs/kin.crt /certs/kin.crt >/dev/null; fi')
        command = ["docker", "run", "--rm", "--network", "none", "--read-only", "--user", "0:0", "--label", "kin.ops.run=" + uuid.uuid4().hex[:12],
                   "--mount", "type=volume,source=" + volume + ",target=/certs,readonly"]
        if self.t["ca_file"]:
            # A missing bind source would be a refusal for the wrong reason (and some engines create it on the host).
            require(Path(self.t["ca_file"]).is_file(), "The clone CA file is missing: " + self.t["ca_file"])
            command +=["--mount", "type=bind,source=" + self.t["ca_file"] + ",target=/kin-ca.pem,readonly"]
        try:
            ipaddress.ip_address(host)
            flag = "-checkip"
        except ValueError:
            flag = "-checkhost"
        command += ["--entrypoint", "sh", intro.plan["previous"]["images"]["proxy"], "-c", script, "certificate-check", host, flag]
        result = self.cmd(command, timeout=120, check=False)
        require(result.returncode == 0, "The clone certificate volume is empty or its key, origin or chain does not fit (key = certificate, "
                                        "host, CA file, seven days): " + volume)
        return {"volume": volume, "host": host, "ca_file": bool(self.t["ca_file"]), "valid_days_at_least": 7, "key_matches": True,
                "chain": "CA file" if self.t["ca_file"] else "image trust store"}

    def keycloak_isolation(self, intro, source_env, clone_env, source_origin):
        """Keycloak 26.7.3: exact realm/row/field changes, then compare every residual value of both databases."""
        version = self.text(["docker", "run", "--rm", "--network", "none", "--entrypoint", "/opt/keycloak/bin/kc.sh",
                             intro.plan["previous"]["images"]["keycloak"], "--version"], timeout=120)
        require(re.search(r"\bKeycloak 26\.7\.3\b", version) is not None, "clone 변환이 지원하는 Keycloak 버전은 26.7.3입니다")
        require(type(source_origin) is str and urlsplit(source_origin).scheme == "https" and urlsplit(source_origin).netloc
                and urlsplit(source_origin).path in ("", "/"), "원본 origin을 복원 자료에서 확인하지 못했습니다")
        source_origin = source_origin.rstrip("/")
        with self.bind():
            def table(name):
                columns, rows = ops.value_rows(self.names["db"], "keycloak", "public", name)
                return columns, rows
            columns, rows = table("realm")
            require({"id", "name"} <= set(columns), "Keycloak realm 스키마가 다릅니다")
            realms = [row[columns.index("id")] for row in rows if row[columns.index("name")] == "kin"]
            require(len(realms) == 1 and realms[0], "복원한 Keycloak의 kin realm이 유일하지 않습니다")
            realm = realms[0]
            inputs = {name: table(name) for name in ("client", "redirect_uris", "web_origins", "realm_smtp_config", "identity_provider")}
        changes, regenerated, replaced, clients = CloneFields(), [], [], set()
        mapping = {source_env.get(name): clone_env.get(name) for name in ("KC_CLIENT_SECRET", "KC_WEB_SECRET") if source_env.get(name)}
        columns, rows = inputs["client"]
        require({"id", "realm_id", "client_id", "secret", "root_url", "base_url", "management_url"} <= set(columns),
                "Keycloak client 스키마가 다릅니다")
        for row in rows:
            item = dict(zip(columns, row))
            if item["realm_id"] != realm:
                continue
            require(item["id"] not in clients, "Keycloak client ID가 중복됐습니다")
            clients.add(item["id"])
            if item["secret"]:
                if item["secret"] in mapping:
                    require(bool(mapping[item["secret"]]), "원본 client secret에 대응하는 clone 입력이 없습니다")
                    item["secret"] = mapping[item["secret"]]
                else:
                    item["secret"] = token_source.token_urlsafe(32)
                    regenerated.append(item["client_id"])
                replaced.append(item["client_id"])
            for column in ("root_url", "base_url", "management_url"):
                item[column] = clone_origin(item[column], source_origin, self.t["origin"])
            changes.change("client", columns, row, [item[column] for column in columns])
        for table in ("redirect_uris", "web_origins"):
            columns, rows = inputs[table]
            require({"client_id", "value"} <= set(columns), "Keycloak origin 스키마가 다릅니다")
            for row in rows:
                if row[columns.index("client_id")] in clients:
                    after = list(row)
                    after[columns.index("value")] = clone_origin(after[columns.index("value")], source_origin, self.t["origin"])
                    changes.change(table, columns, row, after)
        for table in ("realm_smtp_config", "identity_provider"):
            columns, rows = inputs[table]
            require("realm_id" in columns and (table != "identity_provider" or {"internal_id", "enabled"} <= set(columns)),
                    "Keycloak 외부 연결 스키마가 다릅니다")
            for row in rows:
                if row[columns.index("realm_id")] == realm:
                    after = None if table == "realm_smtp_config" else list(row)
                    if after is not None:
                        after[columns.index("enabled")] = "false"
                    changes.change(table, columns, row, after)
        with self.bind():
            expected = ops.value_catalog(self.names["db"], transform=changes.expected)
            expected_catalog = ops.cluster_catalog(self.names["db"])
        statements = ["SET client_encoding='UTF8';", "BEGIN;", *changes.sql, "COMMIT;"]
        self.cmd(["docker", "exec", "-i", self.names["db"], "psql", "-X", "-U", "kin", "-d", "keycloak", "-v", "ON_ERROR_STOP=1", "-q"],
                 input="\n".join(statements).encode(), mutating=True, timeout=120, quiet=True)
        with self.bind():
            require(ops.cluster_catalog(self.names["db"]) == expected_catalog, "clone 변환 중 catalog가 달라졌습니다")
            require(ops.value_catalog(self.names["db"]) == expected, "clone의 승인된 행·필드 외 값이 달라졌습니다")
        return {"version": "26.7.3", "client_secrets_replaced": replaced, "client_secrets_regenerated": regenerated,
                "realm": realm, "residual_values": "equal", "smtp": "kin realm removed", "identity_providers": "kin realm disabled"}

    def isolate_database_credentials(self, catalog, source_env, clone_env):
        """After exact source restoration, replace its login credentials with the clone's private inputs.

        Keep the verifier set and all role attributes unchanged; authenticate over TCP before any cloned service
        starts. Socket trust would hide a missed password replacement, as would catalog equality alone.
        """
        import shlex
        keys = {"kin": "POSTGRES_PASSWORD", "kin_runtime": "KIN_EMR_RUNTIME_PASSWORD",
                "kin_emr_reader": "KIN_EMR_READER_PASSWORD", "kin_emr_retention": "KIN_EMR_RETENTION_PASSWORD"}
        statements, probes = [], ["set -eu"]
        for role in catalog["login_verifiers"]:
            key = keys.get(role)
            password = clone_env.get(key)
            require(key is not None and password and password != source_env.get(key) and "\x00" not in password,
                    "clone LOGIN 역할의 분리된 인증 입력이 없습니다")
            statements.append("ALTER ROLE " + ops._identifier(role) + " PASSWORD " + ops._sql_literal(password) + ";")
            probes.append("export PGPASSWORD=" + shlex.quote(password))
            probes.append("psql -h 127.0.0.1 -U " + shlex.quote(role) + " -d kin -XqAt --no-password -v ON_ERROR_STOP=1 -c 'SELECT 1' >/dev/null")
        sql = "SET log_statement='none'; SET log_min_duration_statement=-1; BEGIN;\n" + "\n".join(statements) + "\nCOMMIT;\n"
        self.cmd(["docker", "exec", "-i", self.names["db"], "psql", "-X", "-U", "kin", "-d", "postgres", "-q", "-v", "ON_ERROR_STOP=1"],
                 input=sql.encode(), timeout=120, mutating=True, quiet=True)
        self.cmd(["docker", "exec", "-i", self.names["db"], "sh", "-s"], input=("\n".join(probes) + "\n").encode(), timeout=120, quiet=True)
        return list(catalog["login_verifiers"])

    def seed_restore(self, intro):
        seed = Path(intro.plan["seed"]["b0_dir"])
        with self.bind():
            _, manifest, _ = ops.validate_held(seed, intro.plan["seed"]["b0_manifest_sha256"])
        override = self.pins(intro)
        self.compose(["up", "-d", "--no-deps", "--no-build", "--pull", "never", "db"], override=override, timeout=180)
        self.db_ready(180, "Clone database did not become ready")
        with self.bind():
            restored = ops.restore_pre_snapshot(self.names["db"], seed)
            # IRT2-24: the restored copy is the seed's exactly (every row of both databases) before the clone's own,
            # recorded changes below (client secrets, origin, mail, identity providers, its administrator) are made.
            restored_values = ops.value_catalog(self.names["db"])
            require(restored_values == json.loads((seed / "values.json").read_text(encoding="utf-8")),
                    "Seeded row values differ from the seed")
            require(ops.value_counts(restored_values) == manifest["counts"], "Seeded row counts differ from the held manifest")
        source_env, clone_env = parse_env((seed / ".env").read_bytes()), parse_env(self.env_file().read_bytes())
        credentials = self.isolate_database_credentials(json.loads((seed / "catalog.json").read_text(encoding="utf-8")), source_env, clone_env)
        source_facts = json.loads((seed / "metadata.json").read_text(encoding="utf-8")).get("facts", {})
        source_origin = source_env.get("PUBLIC_ORIGIN") or source_facts.get("origin")
        isolation = self.keycloak_isolation(intro, source_env, clone_env, source_origin)
        isolation["database_credentials"] = credentials
        with self.bind():
            transformed = ops.value_catalog(self.names["db"])
            expected_catalog = ops.cluster_catalog(self.names["db"])
            require(expected_catalog == json.loads((seed / "catalog.json").read_text(encoding="utf-8")), "clone 변환 뒤 catalog가 B0와 다릅니다")
        changed = value_changes(json.loads((seed / "values.json").read_text(encoding="utf-8")), transformed)
        isolation["changed_tables"] = sorted(changed)
        # The restored master realm keeps the source administrator (whose password the clone must not know); the clone
        # gets its own administrator with the clone's KC_ADMIN_PASSWORD, through Keycloak's own recovery command.
        with self.bind():
            master = ops.psql_json(self.names["db"], "keycloak", "SELECT json_agg(id) FROM realm WHERE name='master';")
            require(type(master) is list and len(master) == 1, "clone master realm이 유일하지 않습니다")
            role_ids = ops.psql_json(self.names["db"], "keycloak", "SELECT json_agg(id ORDER BY id) FROM keycloak_role WHERE realm_id="
                                    + ops._sql_literal(master[0]) + " AND name IN ('admin','default-roles-master');")
            require(type(role_ids) is list and len(role_ids) == 2, "clone 관리자 기본 역할 계약을 확인하지 못했습니다")
            before_admin = {name: ops.value_rows(self.names["db"], "keycloak", "public", name)
                            for name in ("user_entity", "credential", "user_attribute", "user_role_mapping")}
        columns, users = before_admin["user_entity"]
        require(not any(row[columns.index("realm_id")] == master[0] and row[columns.index("username")] == self.t["keycloak_admin"]
                        for row in users), "clone 관리자 이름을 기존 계정이 사용 중입니다")
        started_ms = int(time.time() * 1000)
        admin = self.one_shot(intro, "keycloak", ["bootstrap-admin", "user", "--username", self.t["keycloak_admin"],
                                                 "--password:env", "KC_BOOTSTRAP_ADMIN_PASSWORD", "--no-prompt"],
                              timeout=600, entrypoint="/opt/keycloak/bin/kc.sh", name="kc-bootstrap-admin")
        require(admin["exit"] == 0 and admin["container_exit"] == 0, "The clone Keycloak administrator could not be created")
        with self.bind():
            require(ops.cluster_catalog(self.names["db"]) == expected_catalog, "clone 관리자 생성 뒤 catalog가 B0와 다릅니다")
            after_admin = {name: ops.value_rows(self.names["db"], "keycloak", "public", name) for name in before_admin}
            admin_id, strip_new_admin = clone_admin_rows(before_admin, after_admin, username=self.t["keycloak_admin"], realm=master[0],
                role_ids=role_ids, started_ms=started_ms, ended_ms=int(time.time() * 1000))
            require(ops.value_catalog(self.names["db"], transform=strip_new_admin) == transformed,
                    "clone 관리자 생성이 승인된 새 행 밖의 값을 바꿨습니다")
        isolation["administrator"] = {"created": self.t["keycloak_admin"], "id": admin_id, "logs": admin["logs"], "residual_values": "equal"}
        self.compose(["up", "--no-deps", "--no-build", "--pull", "never", "--no-start", "orthanc"], override=override, timeout=180)
        with open(seed / "orthanc.tgz", "rb") as handle:
            self.cmd(["docker", "run", "--rm", "-i", "--network", "none", "--mount", "type=volume,source=" + self.t["volumes"]["orthanc"] + ",target=/restore",
                      "--entrypoint", "tar", intro.plan["previous"]["images"]["db"], "-xzf", "-", "-C", "/restore"], stdin=handle, timeout=1800, mutating=True)
        with self.bind():
            pre.check_migration_rows(ops.migration_rows(self.names["db"]), intro.plan["migrations"]["before"])
            before = json.loads((seed / "projection.json").read_text(encoding="utf-8"))
            pre.check_projection_preserved(before, ops.projection(self.names["db"], columns={k: v["columns"] for k, v in before.items()}))
        intro.state["seed"] = {"source_manifest_sha256": intro.plan["seed"]["b0_manifest_sha256"], "isolation": isolation, "catalog": restored}
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
        return {"public": health_check(self.t["origin"], ca_file=self.t["ca_file"], member_rights=False)}

    def write_receipt(self, intro):
        receipt = make_receipt(intro)
        digest = intro.records.put("local-restore-receipt.json", receipt)
        intro.state["receipt"] = {"sha256": digest, "file": "local-restore-receipt.json"}
        intro.save()
        return intro.state["receipt"]


def tool_hashes(directory=None):
    directory = Path(directory or Path(__file__).resolve().parent)
    # The protected launcher lives beside lib, not in it. Bind the entry that actually receives requests so a
    # partial installation cannot retain an old caller while presenting the new library's receipt hashes.
    entry = directory.parent / "entry.py" if directory == Path("/opt/kin-deploy/lib") else directory / "ops_deploy_entry.py"
    return {name: sha256_bytes((entry if name == "ops_deploy_entry.py" else directory / name).read_bytes())
            for name in TOOL_FILES}


def local_host_key(path="/etc/ssh/ssh_host_ed25519_key.pub"):
    """sha256 (hex) of the host's ed25519 public key blob: the same key OpenSSH's SHA256 fingerprint encodes."""
    fields = Path(path).read_text(encoding="ascii").split()
    require(len(fields) >= 2 and fields[0] == "ssh-ed25519", "Unreadable host key")
    return sha256_bytes(base64.b64decode(fields[1], validate=True))


# ── the protected entrypoint adapter ──

POLICY_KEYS = ("schema", "enabled", "repository", "state_dir", "production", "targets_allowed", "smoke", "repository_owner")
EMR_DIRS = ("emr-plans", "emr-targets", "emr-approvals", "emr-evidence", "emr-used", "emr-runs", "emr-staged", "emr-secrets",
            "emr-bundles")


def policy_valid(policy):
    _keys(policy, POLICY_KEYS, "policy")
    require(policy["schema"] == 1 and type(policy["schema"]) is int and type(policy["enabled"]) is bool, "Unsupported policy")
    for key in ("repository", "state_dir"):
        require(type(policy[key]) is str and policy[key].startswith("/") and "\x00" not in policy[key], "Invalid policy path")
    identity_valid(policy["production"])
    require(type(policy["targets_allowed"]) is list and policy["targets_allowed"] in (["production"], ["rehearsal"]), "Invalid targets")
    smoke_policy = _keys(policy["smoke"], ("token_file", "ca_file", "browser_cmd"), "policy smoke")
    require(type(smoke_policy["token_file"]) is str and smoke_policy["token_file"].startswith("/"), "Invalid token file")
    require(smoke_policy["ca_file"] is None or (type(smoke_policy["ca_file"]) is str and smoke_policy["ca_file"].startswith("/")), "Invalid CA file")
    # IRT-14 (D1062): null keeps the operator's login and smoke record; an argv (absolute program first) runs the
    # unattended smoke through that headless browser (on this host, or a wrapper reaching the browser host).
    browser = smoke_policy["browser_cmd"]
    require(browser is None or (type(browser) is list and 0 < len(browser) <= 16 and all(type(item) is str and 0 < len(item) <= 512
                                                                                        and "\x00" not in item for item in browser)
                                and browser[0].startswith("/")), "Invalid smoke browser command")
    # null: the C1 rule (a root-owned checkout). Otherwise the operating account that owns the production checkout
    # (e.g. /home/ubuntu/pacs-starter-kit); policy, state, approvals and evidence stay root-owned either way.
    owner = policy["repository_owner"]
    if owner is not None:
        _keys(owner, ("uid", "gid"), "repository owner")
        _int(owner["uid"], 1, 65535, "repository owner uid")
        _int(owner["gid"], 1, 65535, "repository owner gid")
    return policy


class HostRecords(Records):
    """The run records of one plan under the protected state directory: root-owned 0700 directories (the plan's run
    directory and its logs/) that this class creates itself, 0600 files written without following links."""

    def __init__(self, directory, host, secrets=None):
        super().__init__(directory, secrets)
        self.host = host

    def ensure(self, directory):
        """Create a records directory (the run directory itself or one level below it, or the plan's secrets directory) as
        0700 if it is missing, then accept it only as ops_deploy_host.protected accepts a private directory: no link,
        root-owned, nothing for group or others, along the whole path. A new directory is made durable in its parent."""
        directory = Path(directory)
        require(directory in (self.directory, self.secrets) or directory.parent == self.directory, "Records stay in the plan's run directory")
        try:
            os.mkdir(directory, 0o700)
            created = True
        except FileExistsError:
            created = False
        self.host.protected(directory, private=True, directory=True)
        if created:
            self.host.sync_dir(directory.parent)

    def open_lease(self, path):
        descriptor = os.open(str(path), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        info = os.fstat(descriptor)
        if not (info.st_uid == 0 and info.st_nlink == 1 and not info.st_mode & 0o077):
            os.close(descriptor)
            raise Stop("The phase lease file is not private")
        return descriptor

    def write(self, path, raw, *, append=False):
        self.ensure(path.parent)
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

    def discard(self, path):
        parent = Path(path).parent
        if not os.path.lexists(parent):
            return   # nothing was ever written there (e.g. a plan that never needed a working secret)
        self.host.protected(parent, private=True, directory=True)
        super().discard(path)
        self.host.sync_dir(parent)

    def sweep_working_folders(self):
        if not os.path.lexists(self.secrets):
            return 0
        self.host.protected(self.secrets, private=True, directory=True)
        return super().sweep_working_folders()


class IntroductionHost:
    """Installed with the C1 library; reached through /opt/kin-deploy/entry.py for requests of mode emr-introduction."""

    POLICY = "/etc/kin-deploy/emr-introduction.json"

    def __init__(self, policy_path=POLICY):
        import ops_deploy_host as host
        self.host = host
        self.policy = policy_valid(host.decode(host.read_secure(policy_path)))
        require(self.policy["enabled"] is True, "Introduction policy is disabled")
        self.owner = self.policy["repository_owner"]
        # The checkout's own mode bits are judged per request (a target manifest may declare the recorded correction of
        # IRT-13); its path, owner and every ancestor are judged here.
        if self.owner is None:
            self.repository = Path(self.policy["repository"])
            host.protected(self.repository.parent, directory=True)
            require(self.repository.lstat().st_uid == 0 and not stat_module.S_ISLNK(self.repository.lstat().st_mode), "Repository is not root's")
        else:
            self.repository = owned_private(self.policy["repository"], self.owner, directory=True, own_mode=False)
            owned_private(self.repository / ".git", self.owner, directory=True, own_mode=False, deferred=(self.repository,))
        self.state = host.protected(self.policy["state_dir"], private=True, directory=True)
        for name in EMR_DIRS:
            host.protected(self.state / name, private=True, directory=True)

    def document(self, folder, digest, limit=262144):
        _str(digest, HASH, "document hash")
        raw = self.host.read_secure(self.state / folder / (digest + ".json"), limit)
        require(sha256_bytes(raw) == digest, "Document bytes differ from their name")
        return decode(raw)

    def compose_operation(self, arguments):
        """The supported root operator command. No caller-supplied Compose file, env, project, image or volume options."""
        require(arguments and arguments[0] in ("config", "recreate"), "지원 운영 명령은 config 또는 recreate입니다")
        roles = arguments[1:]
        require(len(roles) == len(set(roles)) and all(role in ROLES for role in roles), "지원 서비스 목록이 아닙니다")
        require(arguments[0] != "config" or not roles, "config 명령에는 추가 인수를 넣을 수 없습니다")
        entry = ComposeEntry(self.state / "compose-entries")
        pointer, manifest, _ = entry.load()
        require(manifest["repository"] == str(self.repository), "운영 entry가 다른 저장소를 가리킵니다")
        plan = plan_valid(self.document("emr-plans", manifest["plan_sha256"]))
        target = target_valid(self.document("emr-targets", plan["target_manifest_sha256"]), operational=True)
        require(plan["target_kind"] in self.policy["targets_allowed"], "이 호스트에 허용된 운영 대상이 아닙니다")
        check_target(target, self.policy["production"], plan["target_kind"], local_host_key())
        require(tool_hashes() == plan["tool"], "설치 도구가 운영 entry의 계획과 다릅니다")
        if self.owner is None:
            self.host.protected(self.repository, private=True, directory=True)
            self.host.protected(self.repository / ".git", directory=True)
        else:
            owned_private(self.repository, self.owner, private=True, directory=True)
            owned_private(self.repository / ".git", self.owner, private=True, directory=True)
        require([row["logical"] for row in manifest["logical_files"]] == target["compose_files"],
                "운영 entry의 논리 입력이 대상 선언과 다릅니다")
        state = decode(self.host.read_secure(self.state / "emr-runs" / manifest["plan_sha256"] / "state.json", 16 * 1024 * 1024))
        require(state.get("plan_sha256") == manifest["plan_sha256"] and not state.get("running") and not state.get("unknown_hold")
                and all(row.get("state") == "QUIET" for row in state.get("workers", {}).values()),
                "진행 중이거나 종료 미결인 릴리스의 운영 entry를 사용할 수 없습니다")
        require(state.get("status") in ("DEPLOYED", "ROLLED_BACK", "RELEASED") and state.get("lock_token") is None,
                "릴리스의 검증된 공개 재개가 끝나지 않았습니다")
        require({k: state.get("compose_entry", {}).get(k) for k in pointer} == pointer,
                "릴리스 종료 상태와 운영 entry의 세대가 다릅니다")
        runner = Runner(self.repository, fixed=True, base_env=self.host.ENV, owner=self.owner)
        records = HostRecords(self.state / "emr-runs" / ("operator-" + uuid.uuid4().hex), self.host)
        records.ensure(records.directory)
        records.begin("compose", sha256_bytes(canonical(arguments)))
        token = acquire_lock(self.repository)
        records.put("state.json", {"status": "RUNNING", "entry": pointer, "arguments": arguments, "lock_token": token})
        changed = False
        try:
            command, environment = entry.argv(["config", "--format", "json"], pointer)
            configured = runner(command, env=environment, timeout=60)
            require(configured.returncode == 0, "고정 Compose 설정을 검증하지 못했습니다")
            model = decode(configured.stdout)
            images = {role: model["services"][role]["image"] for role in ROLES}
            side = "release" if state["status"] == "DEPLOYED" else "previous"
            require(images == plan[side]["images"], "고정 Compose 이미지 ID가 종료 상태의 계획과 다릅니다")
            require(model["name"] == manifest["project"], "고정 Compose project가 다릅니다")
            observer = HostOps(target=target, plan=plan, runner=runner, records=records, entry_root=entry.root)
            resolved = observer.resolved(None, pinned=False)
            check_resolved(resolved, target, target_checkout=side == "release", maintenance=False,
                           images=images, recovery=state.get("recovery"))
            expected_volumes = state.get("operational_volumes")
            require(type(expected_volumes) is dict and set(expected_volumes) == set(resolved["volumes"].values()),
                    "완료 릴리스의 volume 인계 목록이 없습니다")
            current_volumes = {name: observer.volume_identity(name) for name in sorted(expected_volumes)}
            require(current_volumes == expected_volumes and all(type(item.get("created")) is str and item["created"]
                                                               for item in current_volumes.values()),
                    "운영 volume이 없거나 완료 릴리스 이후 교체됐습니다")
            if arguments[0] == "recreate":
                observer.verify_running(resolved, absent_roles=roles or ROLES)
                changed = True
                records.put("state.json", {"status": "RUNNING", "entry": pointer, "arguments": arguments,
                                            "lock_token": token, "change_started": True})
                for role in roles or ROLES:
                    command, environment = entry.argv(["up", "-d", "--no-deps", "--no-build", "--pull", "never", "--force-recreate", role], pointer)
                    result = runner(command, env=environment, timeout=240)
                    records.command({"service": role, "exit": result.returncode, "entry": pointer})
                    require(result.returncode == 0, "고정 Compose 재생성 명령이 실패했습니다")
                observer.verify_running(resolved)
            require(entry.load()[0] == pointer, "운영 중 active Compose entry가 바뀌었습니다")
            result = {"phase_passed": True, "entry": pointer, "images": images, "project": manifest["project"],
                      "config_sha256": sha256_bytes(configured.stdout), "recreated": (roles or list(ROLES)) if arguments[0] == "recreate" else []}
            records.put("state.json", {"status": "PASS", **result})
            release_lock(self.repository, token)
            return result
        except Exception:
            records.put("state.json", {"status": "UNKNOWN" if changed else "STOP", "entry": pointer,
                                        "lock_token": token if changed else None,
                                        "reason": "운영 명령 변경 뒤 확인 불가" if changed else "운영 명령 변경 전 거절"})
            if not changed:
                release_lock(self.repository, token)
            raise

    def execute(self, raw):
        self.active_introduction = None
        self.entry_request = None
        try:
            return self.execute_request(raw)
        except Exception as error:
            # Admission parsers and OS boundaries can raise other exceptions too. Once a phase has begun,
            # Introduction.run owns its durable STOP/UNKNOWN classification and finalization under the lease.
            machine = self.active_introduction
            state = getattr(machine, "state", {}) if machine is not None else {}
            uncertain = bool(state.get("unknown_hold") or state.get("running") or state.get("host_changed")
                             or state.get("fenced") or state.get("db_changed"))
            return {"mode": MODE, "status": "NEEDS_ATTENTION" if uncertain else "REJECTED", "phase_passed": False,
                    "phase": (self.entry_request or {}).get("phase"), "request_sha256": sha256_bytes(raw), "code": code_of(error)}

    def execute_request(self, raw):
        host = self.host
        request = request_valid(raw)
        self.entry_request = request
        digest = sha256_bytes(raw)
        plan = plan_valid(self.document("emr-plans", request["plan_sha256"]))
        require(plan["target_kind"] in self.policy["targets_allowed"], "This host does not run that target kind")
        target = target_valid(self.document("emr-targets", plan["target_manifest_sha256"]), operational=True)
        require(target["repository"] == str(self.repository), "Target repository is not the protected repository")
        browser_cmd = self.policy["smoke"]["browser_cmd"]

        def repository_check():
            if self.owner is None:
                host.protected(self.repository, private=True, directory=True)
                host.protected(self.repository / ".git", directory=True)
            else:
                owned_private(self.repository, self.owner, private=True, directory=True)
                owned_private(self.repository / ".git", self.owner, directory=True)

        def ownership_check():
            """Everything repository_check requires except the mode bits of the checkout and of its .git: owner, no link,
            the ancestors' owners and modes."""
            if self.owner is None:
                host.protected(self.repository.parent, directory=True)
                for path in (self.repository, self.repository / ".git"):
                    info = path.lstat()
                    require(info.st_uid == 0 and stat_module.S_ISDIR(info.st_mode), "Repository is not root's")
            else:
                owned_private(self.repository, self.owner, directory=True, own_mode=False)
                owned_private(self.repository / ".git", self.owner, directory=True, own_mode=False, deferred=(self.repository,))
        warnings = []
        repair_checkout = None
        if not (target["fix_checkout_mode"] and request["phase"] == "capture"):
            # Only a capture whose manifest declares the correction may meet an open checkout (its L-00a fixes and records
            # it); every other request requires the private checkout first - except a recovery (D06): a rollback goes on
            # when only the checkout's mode was reopened since the capture (owner, links and ancestors still checked),
            # and records it as a warning; introduce, verify and reopen keep refusing.
            try:
                repository_check()
            except RuntimeError as error:
                if request["phase"] not in RECOVERY_PHASES:
                    raise
                # IRT2-07: owner, links and ancestors still hold; only the mode of the checkout and its .git was opened
                # again. The capture's own correction is made again (checkout 0700, .git without group/other write, never
                # recursive), recorded, and the full check must then pass; the rollback's steps check the content (a clean
                # tracked tree, the planned compose files and .env) before they use it.
                ownership_check()
                git = self.repository / ".git"
                before = {name: oct(path.lstat().st_mode & 0o7777) for name, path in (("checkout", self.repository), (".git", git))}
                warning = {"kind": "checkout-mode", "reason": code_of(error), "modes": before}
                warnings.append(warning)
                def repair_checkout(machine):
                    # Defer the correction until approval, the lease and a durable running record exist. An OS
                    # error between these chmod calls then follows the phase's UNKNOWN finalization path.
                    ownership_check()
                    machine.state["host_changed"] = True
                    machine.save()
                    os.chmod(self.repository, 0o700)
                    os.chmod(git, git.lstat().st_mode & 0o7777 & ~0o022)
                    warning["restored"] = {name: oct(path.lstat().st_mode & 0o7777)
                                           for name, path in (("checkout", self.repository), (".git", git))}
                    repository_check()
        approval = approval_valid(decode(host.read_secure(self.state / "emr-approvals" / (digest + ".json"))), digest,
                                  request["phase"], int(time.time()), plan["target_kind"], unattended=browser_cmd is not None)
        evidence = {kind: self.document("emr-evidence", value) for kind, value in approval["evidence"].items()}
        if "local-restore" in evidence:
            # IRT2-01: the producer's run bundle of exactly this receipt, in the protected state (root-owned, private):
            # emr-bundles/<receipt sha256>/ with the rehearsal's result-*.json files and journal.jsonl.
            folder = self.state / "emr-bundles" / receipt_sha256(evidence["local-restore"])
            if folder.exists() or folder.is_symlink():
                host.protected(folder, private=True, directory=True)
                evidence["local-restore-bundle"] = DirectoryBundle(folder, reader=lambda path: host.read_secure(path, 16 * 1024 * 1024))
        # One use: a replayed request with the same bytes can never run a phase twice.
        host.write_secure(self.state / "emr-used" / (digest + ".json"), {"request_sha256": digest, "consumed_at": int(time.time())},
                          exclusive=True)
        records = HostRecords(self.state / "emr-runs" / request["plan_sha256"], host, secrets=self.state / "emr-secrets" / request["plan_sha256"])
        records.ensure(records.directory)
        runner = Runner(self.repository, fixed=True, base_env=host.ENV, owner=self.owner)
        token_file = self.policy["smoke"]["token_file"]
        staged = self.state / "emr-staged" / (plan["secrets"]["env_next_sha256"] + ".env")

        def secure(path):
            # The staged env is root's (state directory); the checkout's .env belongs to the checkout's owner.
            if self.owner is None or Path(path) == staged:
                return host.protected(path, private=True)
            return owned_private(path, self.owner, private=True)
        ops_host = HostOps(target=target, plan=plan, runner=runner, records=records, env_next=staged,
                           token_reader=lambda: host.decode(host.read_secure(token_file, 32768)), secure=secure, owner=self.owner,
                           browser_cmd=browser_cmd, repository_check=repository_check, entry_root=self.state / "compose-entries")
        ops_host.prepare_repository = repair_checkout
        intro = Introduction(plan=plan, plan_sha256=request["plan_sha256"], target=target, production=self.policy["production"],
                             ops=ops_host, records=records, repository=self.repository, host_key=local_host_key(),
                             tool=tool_hashes(), evidence=evidence, warnings=warnings)
        self.active_introduction = intro
        with bound_ops(self.repository, runner):
            try:
                return intro.run(request, digest)
            except Stop as error:
                return {"mode": MODE, "phase": request["phase"], "status": "REJECTED", "phase_passed": False,
                        "request_sha256": digest, "code": code_of(error)}


# ── IRT-14: the reference headless browser of the unattended smoke ──

def _der(data, offset):
    """One DER element at offset: (tag, start of its content, end of the element)."""
    require(offset + 2 <= len(data), "Truncated certificate")
    tag, length, offset = data[offset], data[offset + 1], offset + 2
    if length & 0x80:
        count = length & 0x7F
        require(1 <= count <= 4 and offset + count <= len(data), "Unsupported certificate encoding")
        length, offset = int.from_bytes(data[offset:offset + count], "big"), offset + count
    require(offset + length <= len(data), "Truncated certificate")
    return tag, offset, offset + length


def spki_pin(der):
    """base64(sha256(SubjectPublicKeyInfo)) of a DER certificate: the form Chromium's --ignore-certificate-errors-spki-list
    takes. TBSCertificate = [0] version (optional), serialNumber, signature, issuer, validity, subject, SPKI, ..."""
    tag, start, end = _der(der, 0)
    require(tag == 0x30 and end == len(der), "Not a certificate")
    tag, start, end = _der(der, start)
    require(tag == 0x30, "Not a certificate")
    fields, offset = [], start
    while offset < end:
        tag, _, stop = _der(der, offset)
        fields.append((tag, offset, stop))
        offset = stop
    if fields and fields[0][0] == 0xA0:
        fields = fields[1:]
    require(len(fields) >= 6 and fields[0][0] == 0x02 and all(field[0] == 0x30 for field in fields[1:6]), "Unexpected certificate layout")
    _, begin, stop = fields[5]
    return base64.b64encode(hashlib.sha256(der[begin:stop]).digest()).decode("ascii")


def verified_pin(host, port, connect, ca_file):
    """The chain of the server the browser will reach, verified here (the CA file of a clone, else the system trust
    store) for the origin's host name; the leaf's SPKI pin is then the only certificate the browser accepts."""
    try:
        context = ssl.create_default_context(cafile=ca_file) if ca_file else ssl.create_default_context()
        with socket.create_connection(tuple(connect) if connect else (host, port), timeout=bounded_timeout(20)) as raw:
            raw.settimeout(bounded_timeout(20))
            with context.wrap_socket(raw, server_hostname=host) as tls:
                return spki_pin(tls.getpeercert(binary_form=True))
    except SmokeDeadline:
        # The attempt's time ran out; that is not a certificate identity and stays a retryable deadline (R4-16).
        raise
    except (ssl.SSLCertVerificationError, Stop) as error:
        raise SmokeRefusal("인증서 chain·SAN·SPKI 신원을 확인하지 못했습니다") from None


def browser_probe(spec):
    """D01, L-01's check of the reference browser before the fence: the browsers' folder this command was given
    (PLAYWRIGHT_BROWSERS_PATH, carried explicitly because the entry clears the environment) resolves to a folder that
    holds the Chromium Playwright will start, and that Chromium starts headless in a new profile folder, opens a blank
    page and closes. The profile folder is removed afterwards."""
    profile = Path(spec["profile_dir"])
    require(profile.is_absolute() and not profile.exists() and profile.parent.is_dir(), "The browser profile folder must be new")
    browsers = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
    if browsers is not None:
        require(Path(browsers).is_absolute() and Path(browsers).is_dir(), "PLAYWRIGHT_BROWSERS_PATH does not name a folder")
    from playwright.sync_api import sync_playwright
    profile.mkdir(mode=0o700)
    try:
        with sync_playwright() as playwright:
            executable = Path(playwright.chromium.executable_path)
            require(executable.is_file(), "The Chromium of this Playwright is not installed")
            if browsers is not None:
                require(Path(browsers).resolve() in executable.resolve().parents, "The Chromium does not come from PLAYWRIGHT_BROWSERS_PATH")
            context = playwright.chromium.launch_persistent_context(str(profile), headless=True, timeout=browser_timeout(30000))
            try:
                context.add_init_script("window.__kinSmokeDeadline = %d;" % (time.time() * 1000 + browser_timeout(300000)))
                context.set_default_timeout(browser_timeout())
                context.set_default_navigation_timeout(browser_timeout(60000))
                page = context.pages[0] if context.pages else context.new_page()
                # The context defaults above were cut when they were set; acquiring the page spends the same attempt,
                # so the navigation takes its own cut now (R5-01) instead of a stale default.
                page.goto("about:blank", timeout=browser_timeout(60000))
                agent = re.search(r"Chrome/([0-9.]+)", page.evaluate("navigator.userAgent") or "")
            finally:
                context.close()
    finally:
        if not spec.get("supervised"):
            shutil.rmtree(profile, ignore_errors=True)
    return {"probe": "ok", "browser": "chromium " + (agent.group(1) if agent else "unknown"),
            "browsers_path": "given" if browsers is not None else "default"}


def browser_smoke(spec):
    """One real Authorization Code + PKCE login in headless Chromium (Playwright): the realm's own sign-in page, the
    member's credentials typed in, the code taken at the registered redirect before it reaches any application, and
    exchanged with its S256 verifier. Chromium does not use the system trust store, so the chain is verified here first
    (ca_file or the system store) and the browser accepts exactly that leaf key (--ignore-certificate-errors-spki-list,
    honoured with a user-data-dir only). With `connect` (the fenced maintenance ingress) the browser maps the origin's
    host:port to it (--host-resolver-rules), so every redirect keeps the real origin. The profile lives in the given
    folder (the run's private folder) and is removed afterwards. The policy's browser command carries the browsers' path
    explicitly (the entry clears the environment), e.g. /usr/bin/env PLAYWRIGHT_BROWSERS_PATH=/opt/kin-smoke/browsers
    /usr/bin/python3 <repository>/scripts/ops_emr_introduction.py browser-smoke."""
    from urllib.parse import parse_qs, urlencode
    origin = urlsplit(origin_valid(spec["origin"]))
    host, port = origin.hostname, origin.port or 443
    connect = tuple(spec["connect"]) if spec.get("connect") else None
    require(connect is None or (len(connect) == 2 and connect[0] == "127.0.0.1" and type(connect[1]) is int), "The browser connects to loopback only")
    profile = Path(spec["profile_dir"])
    require(profile.is_absolute() and not profile.exists() and profile.parent.is_dir(), "The browser profile folder must be new")
    redirect = urlsplit(spec["redirect_uri"])
    require(redirect.scheme == "https" and redirect.hostname == SMOKE_REDIRECT_HOST, "The smoke redirect must be the unresolvable callback")
    from playwright.sync_api import sync_playwright
    pin = verified_pin(host, port, connect, spec.get("ca_file"))
    verifier = token_source.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).decode("ascii").rstrip("=")
    state = uuid.uuid4().hex
    query = urlencode({"client_id": spec["client_id"], "response_type": "code", "scope": "openid", "redirect_uri": spec["redirect_uri"],
                       "state": state, "nonce": state, "code_challenge": challenge, "code_challenge_method": "S256"})
    landed = {}
    rules =["MAP %s ~NOTFOUND" % SMOKE_REDIRECT_HOST]
    if connect:
        rules.insert(0, "MAP %s:%d %s:%d" % (host, port, connect[0], connect[1]))
    args = ["--ignore-certificate-errors-spki-list=" + pin, "--host-resolver-rules=" + ", ".join(rules)]
    profile.mkdir(mode=0o700)
    product = None
    try:
        with sync_playwright() as playwright:
            context = playwright.chromium.launch_persistent_context(str(profile), headless=True, args=args, ignore_https_errors=False, timeout=browser_timeout(30000))
            try:
                context.add_init_script("window.__kinSmokeDeadline = %d;" % (time.time() * 1000 + browser_timeout(300000)))
                context.set_default_timeout(browser_timeout())
                context.set_default_navigation_timeout(browser_timeout(60000))
                page = context.pages[0] if context.pages else context.new_page()
                if spec.get("product_session"):
                    product = product_session_check(page, spec)
                    # A new sign-in session for the temporary client (the ended one must not be continued by SSO).
                    context.clear_cookies()

                def capture(request):
                    # Redirects are not routed; the request event sees the redirect target before it fails to resolve.
                    if request.url.startswith(spec["redirect_uri"]) and "url" not in landed:
                        landed["url"] = request.url
                page.on("request", capture)
                browser_stage(page, "the sign-in page", lambda: page.goto(spec["origin"] + "/auth/realms/kin/protocol/openid-connect/auth?" + query,
                                                                          wait_until="domcontentloaded", timeout=browser_timeout(60000)))
                agent = re.search(r"Chrome/([0-9.]+)", page.evaluate("navigator.userAgent") or "")
                version = agent.group(1) if agent else "unknown"
                browser_stage(page, "the sign-in form", lambda: (page.fill("#username", spec["username"], timeout=browser_timeout()), page.fill("#password", spec["password"], timeout=browser_timeout())))
                try:
                    page.click("#kc-login", timeout=browser_timeout())
                except Exception:
                    # The navigation to the unresolvable callback fails by design; only a click before it is an error.
                    if "url" not in landed:
                        raise
                for _ in range(120):
                    if "url" in landed:
                        break
                    page.wait_for_timeout(browser_timeout(250))
                if "url" not in landed:
                    # Where the sign-in stopped (a page title such as a required action; never a value of the form).
                    landed["title"] = re.sub(r"[^\w .:-]", "", page.title() or "")[:60]
            finally:
                context.close()
    finally:
        if not spec.get("supervised"):
            shutil.rmtree(profile, ignore_errors=True)
    if "url" not in landed:
        raise SmokeRefusal("로그인이 등록한 redirect로 돌아오지 않았습니다. 계정·필수 인증 정책을 확인해야 합니다")
    params = parse_qs(urlsplit(landed["url"]).query)
    require(params.get("state") == [state] and len(params.get("code", [])) == 1, "The sign-in returned another login's code")
    code, raw = https_post(spec["origin"], "/auth/realms/kin/protocol/openid-connect/token",
                           {"client_id": spec["client_id"], "grant_type": "authorization_code", "code": params["code"][0],
                            "redirect_uri": spec["redirect_uri"], "code_verifier": verifier}, connect=connect, ca_file=spec.get("ca_file"))
    if code != 200:
        refusal = SmokeRefusal if code in (400, 401, 403) else Stop
        raise refusal("인증 코드 교환이 실패했습니다")
    tokens = json.loads(raw)
    claims = token_claims({"access_token": tokens["access_token"]})
    return {"flow": "authorization_code+S256", "browser": "chromium " + version, "access_token": tokens["access_token"],
            "refresh_token": tokens["refresh_token"], "subject": claims.get("sub"), "product_session": product}


# The product's own session requests as its web documents send them (worklist-v0/hpacs-lite/auth.js: X-KIN-CSRF, and
# X-KIN-Session once the document knows its session); GET /api/me without the binding is the product's bootstrap call.
PRODUCT_ME_JS = ("async (sid) => { const kinSmokeSignal = () => { const left = (window.__kinSmokeDeadline || (Date.now()+60000))-Date.now(); if(left<=0) throw new Error('smoke deadline'); return AbortSignal.timeout(Math.ceil(left)); }; const h = {'X-KIN-CSRF': '1'}; if (sid) h['X-KIN-Session'] = sid;"
                 " const r = await fetch('/api/me', {headers: h, credentials: 'same-origin', cache: 'no-store', signal: kinSmokeSignal()});"
                 " let b = {}; try { b = await r.json(); } catch (e) {}"
                 " return {status: r.status, sid: typeof b.sessionId === 'string' && b.sessionId ? b.sessionId : null}; }")
PRODUCT_LOGOUT_JS = ("async (sid) => { const kinSmokeSignal = () => { const left = (window.__kinSmokeDeadline || (Date.now()+60000))-Date.now(); if(left<=0) throw new Error('smoke deadline'); return AbortSignal.timeout(Math.ceil(left)); }; return (await fetch('/api/auth/logout', {method: 'POST', credentials: 'same-origin', signal: kinSmokeSignal(),"
                     " headers: {'X-KIN-CSRF': '1', 'X-KIN-Session': sid}})).status; }")


def sign_in(page, spec):
    """The realm's sign-in form, filled with the smoke member's credentials."""
    page.wait_for_selector("#username", timeout=browser_timeout(60000))
    page.fill("#username", spec["username"], timeout=browser_timeout())
    page.fill("#password", spec["password"], timeout=browser_timeout())
    page.click("#kc-login", timeout=browser_timeout())


def browser_stage(page, name, action):
    """One browser stage; a failure names the stage, the error type and the page it stopped on (path and title only:
    never a query, a fragment or a form value)."""
    try:
        if _smoke_budget.get() is not None:
            page.set_default_timeout(browser_timeout())
            page.set_default_navigation_timeout(browser_timeout(60000))
        return action()
    except Stop:
        raise
    except Exception as error:
        try:
            where = urlsplit(page.url).path[:80] + ": " + re.sub(r"[^\w .:-]", "", page.title() or "")[:60]
        except Exception:
            where = "unreadable"
        raise Stop("The browser stopped at %s (%s, page %s)" % (name, type(error).__name__, where)) from None


def product_session_check(page, spec):
    """The product's own sign-in (its client, through /api/auth/login and its callback) in this browser until its
    document has entered the session; then, from a neutral page of the same origin, the product's logout and the ended
    session asked again with its binding and by its cookie alone. Statuses only; the session id stays in the browser."""
    from urllib.parse import parse_qs
    origin = spec["origin"]
    browser_stage(page, "the product sign-in page", lambda: page.goto(origin + "/api/auth/login", wait_until="domcontentloaded", timeout=browser_timeout(60000)))
    browser_stage(page, "the product sign-in form", lambda: sign_in(page, spec))
    browser_stage(page, "the product's return", lambda: page.wait_for_url(lambda url: url.startswith(origin + "/worklist/"),
                                                                           wait_until="commit", timeout=browser_timeout(60000)))
    sid = None
    for _ in range(120):
        try:
            answer = page.evaluate(PRODUCT_ME_JS, None)
            if answer.get("status") == 200 and answer.get("sid"):
                sid = answer["sid"]
                break
        except Exception:
            pass   # the document is still navigating (its entry step)
        page.wait_for_timeout(browser_timeout(500))
    if sid is None:
        error = (parse_qs(urlsplit(page.url).query).get("auth_error") or [""])[0]
        raise Stop("The product sign-in did not open a session" + (" (" + re.sub(r"[^\w-]", "", error)[:40] + ")" if error else ""))
    # IRT2-11: the product's real screens, as the signed-in member sees them, before the session ends.
    screens = product_screens_check(page, spec, sid) if spec.get("study_uid") else None
    # IRT2-12: the session's own cookies (HttpOnly included) as the browser holds them before the logout, in memory only;
    # after the logout they are sent again from outside the browser, so a server that only clears the cookie and keeps
    # the session is caught (the browser itself no longer has the cookie to send).
    jar = "; ".join(cookie["name"] + "=" + cookie["value"] for cookie in page.context.cookies([origin])
                    if "/api/me".startswith(cookie.get("path") or "/"))
    require(jar, "The product sign-in left no session cookie")
    browser_stage(page, "a neutral page", lambda: page.goto(origin + "/auth/realms/kin/.well-known/openid-configuration",
                                                             wait_until="domcontentloaded", timeout=browser_timeout(60000)))
    logout = browser_stage(page, "the product logout", lambda: page.evaluate(PRODUCT_LOGOUT_JS, sid))
    bound = session_replay(spec, {"Cookie": jar, "X-KIN-CSRF": "1", "X-KIN-Session": sid})
    cookie_only = session_replay(spec, {"Cookie": jar, "X-KIN-CSRF": "1"})
    return {"signed_in": True, "logout_status": logout, "old_session_status": bound, "old_cookie_status": cookie_only, "screens": screens}


SCREEN_CHECKS = ("worklist_row", "modality_rendered", "folders_loaded", "reading_workspace", "shortcuts_dialog", "viewer_rendered")
# The signed-in document's own paged list (as study-pages.js asks for it): the plan's study and its patient ID and
# modality, which stay in the browser (only booleans leave it).
SCREEN_STUDY_JS = ("async ([uid, sid]) => { const kinSmokeSignal = () => { const left = (window.__kinSmokeDeadline || (Date.now()+60000))-Date.now(); if(left<=0) throw new Error('smoke deadline'); return AbortSignal.timeout(Math.ceil(left)); }; const h = {'X-KIN-CSRF': '1', 'X-KIN-Session': sid}; let after = null;"
                   " for (let n = 0; n < 500; n++) { const r = await fetch('/api/studies?limit=100' + (after ? '&after=' + encodeURIComponent(after) : ''),"
                   " {headers: h, credentials: 'same-origin', cache: 'no-store', signal: kinSmokeSignal()}); if (r.status !== 200) return {status: r.status};"
                   " const body = await r.json(); const row = (body.studies || []).find(s => s && s.uid === uid);"
                   " if (row) return {status: 200, found: true, patient: typeof row.id === 'string' ? row.id : null,"
                   " modality: typeof row.modality === 'string' ? row.modality : null};"
                   " after = body.pagination && body.pagination.next; if (!after) break; } return {status: 200, found: false}; }")
# The rendered row's Modality cell: the column whose header key is 'modality' (worklist-columns-view.js).
SCREEN_MODALITY_JS = ("uid => { const heads = [...document.querySelectorAll('#heads th')];"
                      " const index = heads.findIndex(e => e.dataset.key === 'modality'); if (index < 0) return null;"
                      " const row = document.querySelector('#rows tr[data-uid=\"' + CSS.escape(uid) + '\"]'); if (!row) return null;"
                      " const cell = row.querySelectorAll('td')[index]; return cell ? cell.textContent.trim() : null; }")
# A displayed image: every cornerstone canvas of the viewer has a drawing context, a size and real contrast (as the
# product's own viewer tests judge it; a blank or failed viewport has none).
SCREEN_CANVAS_JS = ("() => { const cs = [...document.querySelectorAll('.cornerstone-canvas')]; return cs.length > 0 && cs.every(c => {"
                    " const ctx = c.getContext('2d'); if (!ctx || !c.width || !c.height) return false;"
                    " const d = ctx.getImageData(0, 0, c.width, c.height).data; let lo = 255, hi = 0;"
                    " for (let i = 0; i < d.length; i += 16) { lo = Math.min(lo, d[i]); hi = Math.max(hi, d[i]); } return hi - lo > 40; }); }")


def canvas_rendered(page, timeout=60000):
    """Whether the page's viewer drew the image within the time (see SCREEN_CANVAS_JS)."""
    try:
        page.wait_for_function(SCREEN_CANVAS_JS, timeout=browser_timeout(timeout))
        return True
    except Exception:
        return False


def product_screens_check(page, spec, sid):
    """IRT2-11: the screens behind the eight checks, in the product's own document, signed in as the smoke member:
    the worklist row of the plan's study (found by its patient ID in the product's quick search) with its Modality cell
    as the API gives it; the saved-search manager loading its folders (W2); the Reading Workspace connecting its viewer
    and its Workspace Shortcuts dialog opening (W2); and OHIF opened for the study drawing its image. Only booleans
    leave the browser; a step that does not reach its state within its time is False, never skipped."""
    origin, uid = spec["origin"], spec["study_uid"]
    out = {name: False for name in SCREEN_CHECKS}
    row = '#rows tr[data-uid="' + uid + '"]'
    browser_stage(page, "the worklist", lambda: page.wait_for_function(
        "() => ((document.querySelector('#dbstat') || {}).textContent || '').includes('DB Connected')", timeout=browser_timeout(60000)))
    study = browser_stage(page, "the worklist's own list", lambda: page.evaluate(SCREEN_STUDY_JS, [uid, sid]))
    require(type(study) is dict and study.get("status") == 200 and study.get("found") is True, "The product's list does not hold the plan's study")
    try:
        if study.get("patient"):
            page.fill("#quick", study["patient"], timeout=browser_timeout())
        page.wait_for_selector(row, timeout=browser_timeout(90000))
        out["worklist_row"] = True
        rendered = page.evaluate(SCREEN_MODALITY_JS, uid)
        out["modality_rendered"] = bool(rendered) and rendered == (study.get("modality") or "").strip()
    except Exception:
        pass
    try:
        page.click("#toolbar-filters > summary", timeout=browser_timeout())
        page.click("#managefilters", timeout=browser_timeout())
        page.wait_for_selector("#saved-filter-manager", state="visible", timeout=browser_timeout(30000))
        page.click("#sfm-organize > summary", timeout=browser_timeout())
        page.click("#sfm-load-folders", timeout=browser_timeout())
        page.wait_for_function("() => ((document.querySelector('#sfm-status') || {}).textContent || '').includes('검색 모음을 불러왔습니다')"
                               " && (document.querySelector('#saved-filter-manager') || {}).getAttribute('aria-busy') === 'false'", timeout=browser_timeout(30000))
        out["folders_loaded"] = True
        page.press("body", "Escape", timeout=browser_timeout())
        page.wait_for_selector("#saved-filter-manager", state="hidden", timeout=browser_timeout(10000))
    except Exception:
        pass
    if out["worklist_row"]:
        try:
            page.click(row, timeout=browser_timeout())
            page.click("#m-reading", timeout=browser_timeout())
            page.wait_for_function("() => ((document.querySelector('#reading-status') || {}).textContent || '').includes('영상 작업공간 연결됨')",
                                   timeout=browser_timeout(90000))
            out["reading_workspace"] = True
            page.click("#workspace-shortcuts-edit", timeout=browser_timeout())
            page.wait_for_selector("#workspace-shortcuts-dialog", state="visible", timeout=browser_timeout(30000))
            page.wait_for_selector("#workspace-shortcut-list", timeout=browser_timeout(30000))
            out["shortcuts_dialog"] = True
            page.click("#workspace-shortcuts-cancel", timeout=browser_timeout())
        except Exception:
            pass
    viewer = page.context.new_page()
    try:
        viewer.goto(origin + "/ohif/viewer?StudyInstanceUIDs=" + quote(uid, safe=""), wait_until="domcontentloaded", timeout=browser_timeout(60000))
        out["viewer_rendered"] = canvas_rendered(viewer)
    except Exception:
        out["viewer_rendered"] = False
    finally:
        viewer.close()
    return out


def session_replay(spec, headers):
    """GET /api/me sent again with the ended session's original cookie (and binding), from a separate connection - the
    maintenance ingress when the spec names one, the origin's certificate checked as https_get does. Only the status
    leaves this function."""
    parsed = urlsplit(spec["origin"])
    https = parsed.scheme == "https"
    address, port = tuple(spec["connect"]) if spec.get("connect") else (parsed.hostname, parsed.port or (443 if https else 80))
    if https:
        connection = PinnedHTTPS(address, port, parsed.hostname, ssl.create_default_context(cafile=spec.get("ca_file")))
    else:
        connection = http.client.HTTPConnection(address, port, timeout=bounded_timeout(10))
    try:
        connection.request("GET", "/api/me", headers={"Host": parsed.netloc, "Accept": "application/json", **headers})
        if connection.sock is not None:
            connection.sock.settimeout(bounded_timeout(10))
        response = connection.getresponse()
        http_read(connection, response, 65536)
        return response.status
    finally:
        connection.close()


# ── CLI helpers: no host change ──

EXAMPLE_POLICY = {"schema": 1, "enabled": False, "repository": "/srv/kin/repository", "state_dir": "/var/lib/kin-deploy",
                  "production": {"host_key_sha256": "0" * 64, "origin": "https://pacs.example.invalid", "project": "pacs-starter-kit",
                                 "containers": {"db": "kin-db", "api": "kin-api", "keycloak": "kin-keycloak", "orthanc": "kin-orthanc",
                                                "proxy": "kin-proxy", "emr-provision": "kin-emr-provision", "api-migrate": "kin-api-migrate"},
                                 "volumes": {"pg": "pacs-starter-kit_pg-db", "orthanc": "pacs-starter-kit_orthanc-db",
                                             "emr_access": "pacs-starter-kit_emr-access", "emr_state": "pacs-starter-kit_emr-state"},
                                 "networks": {"default": "pacs-starter-kit_default", "workflow": "kin-workflow"}},
                  "targets_allowed": ["production"], "smoke": {"token_file": "/etc/kin-deploy/smoke-token.json", "ca_file": None,
                                                               "browser_cmd": None},
                  "repository_owner": None}


def example_target():
    production = EXAMPLE_POLICY["production"]
    halo = "/etc/kin-deploy/overlays/docker-compose.halo-reports.yml"
    return {"schema": 1, "kind": "production", **{key: production[key] for key in IDENTITY_KEYS},
            "repository": "/srv/kin/repository", "compose_files": ["docker-compose.yml", "docker-compose.prod.yml", halo, "docker-compose.monitor.yml"],
            "ports": {"maintenance": "127.0.0.1:9444:443", "public": ["80:80", "443:443"]},
            "tls_certificate": "/etc/letsencrypt/live/pacs.example.invalid/fullchain.pem",
            "cron": {"user": "ubuntu", "tags": ["kin-pacs-reviewed-backup", "kin-pacs-reviewed-monitor"]}, "ca_file": None,
            "keycloak_admin": "admin", "external_networks": {"proxy": {"halo_reports": "halo_reports_private"}},
            "declared_overlays": [{"file": halo, "sha256": "REPLACE_WITH_OBSERVED_SHA256", "service": "proxy",
                                   "binds": [{"source": "/srv/halo-reports/nginx/report.conf",
                                              "target": "/etc/nginx/conf.d/halo-report.conf", "read_only": True}]}],
            "tracked_overlay_reconcile": [],
            "fix_checkout_mode": False}


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
    prepare.add_argument("--target", type=Path, help="A target manifest with a declared overlay: the copy names its compose list "
                                                    "(COMPOSE_FILE, IRT2-10)")
    digest = sub.add_parser("compose-digest")
    digest.add_argument("--repository", type=Path, required=True)
    digest.add_argument("--sha", required=True)
    digest.add_argument("--env", type=Path, required=True)
    digest.add_argument("--target", type=Path, help="Digest the .env as the capture leaves it: with the target's COMPOSE_FILE line (IRT2-10)")
    digest.add_argument("files", nargs="+")
    over = sub.add_parser("rehearsal-override")
    over.add_argument("target", type=Path)
    over.add_argument("--out", type=Path, required=True)
    receipt = sub.add_parser("verify-receipt")
    receipt.add_argument("receipt", type=Path)
    receipt.add_argument("plan", type=Path)
    receipt.add_argument("--b0-manifest-sha256", required=True)
    receipt.add_argument("--b0-created-utc")
    receipt.add_argument("--policy", type=Path, required=True)
    receipt.add_argument("--bundle", type=Path, required=True, help="The rehearsal's run directory (its result files and journal)")
    sub.add_parser("browser-smoke", help="The reference headless browser of the unattended smoke: login spec on stdin, KIN_RESULT out")
    args = parser.parse_args(argv)
    if args.command == "browser-smoke":
        try:
            spec = json.loads(sys.stdin.buffer.read(65536).decode("utf-8"))
            require(type(spec) is dict, "Invalid browser spec")
            if spec.get("work_deadline") is not None:
                require(type(spec["work_deadline"]) in (int, float) and spec["work_deadline"] > time.monotonic(),
                        "browser 작업 제한 시간이 지났습니다")
                child_budget = SmokeBudget(1)
                child_budget.work_end = child_budget.end = spec["work_deadline"]
                _smoke_budget.set(child_budget)
            print("KIN_RESULT " + json.dumps(browser_probe(spec) if spec.get("probe") is True else browser_smoke(spec)))
            return 0
        except Exception as error:   # never the spec or a token in the message
            print(json.dumps({"valid": False, "error": code_of(error), "retryable": getattr(error, "retryable", True)}), file=sys.stderr)
            return 1
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
            if args.target:
                declared_target = target_valid(decode(args.target.read_bytes()))
                raw = raw if names_declared_list(raw, declared_target) else env_with_compose_file(raw, declared_target)
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
            env_raw = args.env.read_bytes()
            if args.target:
                # The .env as L-00b leaves it: an existing COMPOSE_FILE line naming the declared list stays where it is.
                declared_target = target_valid(decode(args.target.read_bytes()))
                env_raw = env_raw if names_declared_list(env_raw, declared_target) else env_with_compose_file(env_raw, declared_target)
            entries.append((".env", env_raw))
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
            receipt = decode(args.receipt.read_bytes())
            receipt_valid(receipt, plan, args.b0_manifest_sha256, policy["production"], b0_created_utc=args.b0_created_utc,
                          bundle=DirectoryBundle(args.bundle))
            print(json.dumps({"valid": True, "receipt_sha256": receipt_sha256(receipt), "bundle": True}))
    except (Stop, OSError, ValueError, subprocess.CalledProcessError) as error:
        print(json.dumps({"valid": False, "error": code_of(error)}), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
