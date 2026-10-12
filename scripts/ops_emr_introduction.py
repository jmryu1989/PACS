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
from contextlib import contextmanager, nullcontext, redirect_stdout
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
TOOL_FILES = ("ops_emr_introduction.py", "ops_emr_probe.py", "ops_backup.py", "ops_deploy_preflight.py", "ops_deploy_host.py",
              "ops_audit_integrity.py")
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
# D04: the values of compose variables the .env lacks, resolved once from the running stack, kept for the plan's later
# phases (a rollback whose source container is gone) in this private file of the run directory, never in a record.
COMPOSE_VALUES = "compose-env-values.json"
RECOVERY_PHASES = ("rollback", "rollback_reopen")
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
    pins them, images. A rehearsal binds nothing outside its own checkout. recovery: after a rollback the project and
    the pg/Orthanc volumes are the recovery ones."""
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
            for bind in binds:
                require(bind[0] == repository or repository in bind[0].parents or bind in declared_binds.get(role, []),
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


def receipt_valid(receipt, plan, b0_manifest_sha256, production, *, now=None, b0_created_utc=None, used=()):
    """A local-restore receipt is the rehearsal's own run record, never an offsite claim. It is accepted only for the
    production plan it names, on the rehearsal host that plan allows, for this production attempt's B0, within its
    freshness window and once (used: the receipts this plan already admitted). Every rehearsal phase must carry its
    exact step list (all PASS), its request and its result file's hash; the artifacts it names (B0, B1 and its restore
    check, the probe, Bfail, the recovery volumes and the previous-version smoke over this plan's frame) must agree
    with each other. Anything short of that is a refusal before any change."""
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
    require(receipt_sha256(receipt) not in set(used), "Receipt was already used")
    return receipt


def receipt_clock(receipt, now, b0_created_utc=None):
    """The clock facts of an accepted receipt (D12): how far its creation lies ahead of production's clock (0 when it is
    not ahead) and how long after the B0 it rehearsed it was made (negative within the tolerated skew), in seconds."""
    created = parse_utc(receipt["created_utc"])
    facts = {"tolerance_s": int(CLOCK_SKEW.total_seconds()), "ahead_of_production_s": round(max(0.0, (created - now).total_seconds()), 3)}
    if b0_created_utc is not None:
        facts["after_b0_s"] = round((created - parse_utc(b0_created_utc)).total_seconds(), 3)
    return facts


def bundle_valid(receipt, directory):
    """Re-verify a receipt against the rehearsal's run directory: every phase result file it names exists with that hash
    and records exactly the steps the receipt claims, and the journal is the one it hashed."""
    directory = Path(directory)
    for phase in RECEIPT_PHASES:
        item = receipt["phases"][phase]
        path = directory / ("result-" + phase + "-" + item["request_sha256"][:16] + ".json")
        raw = path.read_bytes()
        require(sha256_bytes(raw) == item["result_sha256"], "Rehearsal result file differs from the receipt: " + phase)
        result = decode(raw)
        require(result.get("phase") == phase and [[step["step"], step["outcome"]] for step in result.get("steps", [])] == item["steps"],
                "Rehearsal result steps differ from the receipt: " + phase)
    with open(directory / "journal.jsonl", "rb") as stream:
        prefix = stream.read(receipt["journal_bytes"])
    require(len(prefix) == receipt["journal_bytes"] and sha256_bytes(prefix) == receipt["journal_sha256"],
            "Rehearsal journal differs from the receipt")
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

    def __init__(self, directory):
        self.directory = Path(directory)
        self.commands_file = None
        self.seq = 0
        self.context = {}

    def ensure(self, directory):
        Path(directory).mkdir(mode=0o700, parents=True, exist_ok=True)

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
        gone). Missing is fine; only files directly in the run directory."""
        path = Path(path)
        require(path.parent == self.directory, "Records stay in the plan's run directory")
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass


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


def https_post(origin, path, form, *, connect=None, ca_file=None):
    from urllib.parse import urlencode
    parsed = urlsplit(origin)
    address, port = connect or (parsed.hostname, parsed.port or 443)
    connection = PinnedHTTPS(address, port, parsed.hostname, ssl.create_default_context(cafile=ca_file))
    try:
        connection.request("POST", path, body=urlencode(form).encode("ascii"),
                           headers={"Host": parsed.netloc, "Content-Type": "application/x-www-form-urlencoded"})
        response = connection.getresponse()
        raw = response.read(65537)
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
        query = "/api/studies?limit=100" + ("&after=" + quote(after, safe="") if after else "")
        code, _, raw = https_get(origin, query, connect=connect, ca_file=ca_file, token=token, limit=8 * 1024 * 1024)
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
    require(code == 200, "Authenticated identity check refused (HTTP %d %s)" % (code, refusal_code(raw)))
    require(json.loads(raw).get("sub") == token["subject"], "Authenticated identity is another subject")
    result["member"] = True
    require(worklist_has(origin, worklist_uid, connect=connect, ca_file=ca_file, token=token["access_token"]),
            "The worklist does not list the smoke study")
    result["worklist"] = True
    code, kind, raw = https_get(origin, frame["path"], connect=connect, ca_file=ca_file, token=token["access_token"],
                                limit=frame["bytes"] + 65536, accept='multipart/related; type="application/octet-stream"')
    require(code == 200, "Frame request failed")
    payload = frame_payload(kind, raw)
    require(len(payload) == frame["bytes"] and sha256_bytes(payload) == frame["sha256"], "Frame bytes differ")
    result["frame"] = True
    return result


def smoke_passed(result):
    """Only a result in which every authenticated check ran and passed counts (a stubbed or partial result does not)."""
    return (isinstance(result, dict) and all(result.get(key) is True for key in ("health", "auth_refusal", "member", "worklist", "frame")))


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
        raise Stop("The smoke token is not a readable JWT") from None


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
                ("L-04a", "fence", True, False), ("L-04b", "capture_b0", False, False), ("L-04c", "restore_check_b0", False, False)),
    "release": (("RL-01", "unfence", True, False), ("RL-02", "public_check_previous", False, False)),
    "introduce": (("I-00", "recheck_fence", False, False), ("L-06a", "storage", True, False), ("L-06b", "provision", True, True),
                  ("L-07", "migrate", True, True), ("L-08a", "keycloak", True, True), ("L-08b", "member_import", True, True),
                  ("L-09a", "api", True, True), ("L-09b", "proxy_ui", True, True)),
    "verify": (("L-10a", "fenced_smoke", False, False), ("L-10b", "probe", True, True), ("L-10c", "capture_b1", True, True),
               ("L-10d", "resume", True, True), ("L-10e", "remove_smoke_member", True, True)),
    "reopen": (("L-11a", "final_allowlist", False, False), ("L-11b", "restore_jobs", True, False),
               ("L-11c", "reopen_ingress", True, False), ("L-11d", "public_smoke", False, False)),
    # The rollback restores (RB-00..RB-03) and stops behind the maintenance ingress with the lock and the fence kept; only
    # rollback_reopen (RB-04) opens anything, after the previous version proved itself with a login made after the
    # restore, the worklist and the frame bytes. Until then the status is RESTORED, never ROLLED_BACK.
    "rollback": (("RB-00", "classify", True, False), ("RB-01", "preserve_failed", False, False), ("RB-02", "restore_b0", True, False),
                 ("RB-03", "previous_services", True, False)),
    "rollback_reopen": (("RB-04a", "recovery_persisted", False, False), ("RB-04b", "fenced_previous_smoke", False, False),
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


def new_state(plan_sha256, plan):
    return {"schema": 1, "mode": MODE, "plan_sha256": plan_sha256, "target_kind": plan["target_kind"], "status": "NEW",
            "lock_token": None, "db_changed": False, "ponr": None, "fenced": None, "checkout": "previous",
            "b0": None, "b1": None, "bfail": None, "seed": None, "recovery": None, "rollback_attempted": False,
            "history": [], "probe": None, "receipt": None, "running": None, "receipts_used": [], "restored_at": None,
            "rollback_smoke": None}


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
        """Every step (read-only ones too) records the host before and after it, its outcome, its duration and the
        range of commands it ran (commands-<phase>-<request>.jsonl), so the record shows which command a step reached."""
        record = {"step": sid, "action": name, "mutating": mutating, "started_utc": self.now().isoformat()}
        self.event("step-start", step=sid)
        started = self.clock()
        first = self.records.seq + 1
        record["before"] = self.observe(sid, "before")
        self.records.context = {"step": sid, "part": "step"}
        outcome = None
        try:
            if mutating:
                self.guard()
            if db_change and not self.state["db_changed"]:
                # Durable before the first database change: from here on, only a full B0 restore is a rollback.
                self.state["db_changed"] = True
                self.save()
            detail = getattr(self.ops, name)(self) or {}
            outcome = "PASS"
        except Unknown as error:
            outcome = "UNKNOWN"
            record.update(code=code_of(error))
            raise
        except Exception as error:
            outcome = "STOP"
            record.update(code=code_of(error))
            raise Stop(record["code"]) from None
        finally:
            record["outcome"] = outcome or "UNKNOWN"
            record["seconds"] = round(self.clock() - started, 3)
            if outcome == "PASS":
                record["detail"] = detail
            record["after"] = self.observe(sid, "after")
            record["commands"] = {"file": self.records.commands_file, "first": first, "last": self.records.seq}
            self.steps.append(record)
            self.event("step-end", step=sid, outcome=record["outcome"], **({"code": record["code"]} if "code" in record else {}))
        return detail

    def observe(self, sid=None, part=None):
        """The host as seen around a step (selected, secret-free); an unobservable host is recorded as such."""
        snapshot = getattr(self.ops, "snapshot", None)
        if snapshot is None:
            return {"unobservable": "no observer"}
        self.records.context = {"step": sid, "part": part}
        try:
            return snapshot(self)
        except Exception as error:
            return {"unobservable": type(error).__name__}
        finally:
            self.records.context = {}

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
        """A recovery phase goes on despite this fact (D05/D06): recorded now and in the phase's result."""
        warning = {"kind": kind, **facts}
        self.warnings.append(warning)
        self.event("recovery-warning", **warning)

    def finish(self, status, passed, release=False, extra=None):
        self.state["status"] = status
        if release and self.state["lock_token"]:
            release_lock(self.repository, self.state["lock_token"])
            self.state["lock_token"] = None
            # D04: the plan ended; the resolved compose values it kept for its later phases are not kept beyond it.
            self.records.discard(self.records.directory / COMPOSE_VALUES)
        written = {"steps": self.steps, "status": status, "phase": self.phase, "request_sha256": self.request_sha256,
                   "commands_file": self.records.commands_file}
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
            return self.run_exclusive()

    def run_exclusive(self):
        self.started = self.clock()
        self.recovering = self.phase in RECOVERY_PHASES
        self.state = self.records.state() or new_state(self.plan_sha256, self.plan)
        require(self.state["plan_sha256"] == self.plan_sha256 and self.state["mode"] == MODE, "State belongs to another plan")
        if self.state.get("running"):
            # A phase began and never wrote its end (crash, kill, lost host): nothing is re-run automatically; the
            # retained lock stays and the plan needs an operator (release or rollback decide from NEEDS_ATTENTION).
            stale = self.state["running"]
            self.state.update(running=None, status="NEEDS_ATTENTION")
            self.state["history"].append({"phase": stale["phase"], "status": "INTERRUPTED", "request_sha256": stale["request_sha256"],
                                          "seconds": None, "result_sha256": None, "steps": []})
            self.save()
            self.records.journal({"event": "interrupted-phase", "plan_sha256": self.plan_sha256, "phase": stale["phase"],
                                  "request_sha256": stale["request_sha256"], "classified": "NEEDS_ATTENTION"})
            raise Stop("Phase " + stale["phase"] + " did not finish (process ended); classified NEEDS_ATTENTION, inspect before the next request")
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
        self.state["running"] = {"phase": self.phase, "request_sha256": self.request_sha256, "started_utc": self.now().isoformat()}
        if claimed:
            # The local-restore receipt is spent by this attempt, whatever its outcome (one production attempt, once).
            self.state["receipts_used"].append(claimed)
        self.save()
        self.event("phase-start", **({"receipt_sha256": claimed, "receipt_clock": self.receipt_facts} if claimed else {}),
                   **({"warnings": list(self.warnings)} if self.warnings else {}))
        if self.phase in ("capture", "seed"):
            # A new exclusive lock; a competing backup, rehearsal or API-only deployment cannot hold it meanwhile.
            try:
                self.state["lock_token"] = acquire_lock(self.repository)
            except FileExistsError:
                self.state["running"] = None
                self.save()
                raise Stop("Operations lock is held by another operation") from None
            self.save()
        bind = getattr(self.ops, "bind", None)
        with (bind() if bind else nullcontext()):
            prepare = getattr(self.ops, "prepare", None)
            if prepare is not None:
                # IRT-12: the compose environment of the running stack, before any step of this phase uses it.
                try:
                    self.environment = prepare(self)
                except (Stop, Unknown, RuntimeError, OSError) as error:
                    self.state["running"] = None
                    if self.phase in ("capture", "seed") and self.state.get("lock_token"):
                        release_lock(self.repository, self.state["lock_token"])
                        self.state["lock_token"] = None
                    self.save()
                    raise Stop("Compose environment: " + code_of(error)) from None
                # Names, hashes and places only (IRT-12), and the declared overlays' files and bind sources (IRT-11).
                self.event("compose-environment", **(self.environment or {}))
            return getattr(self, "phase_" + self.phase)()

    def check_evidence(self):
        """Evidence the phase needs, verified before anything runs. Returns the receipt this attempt spends, if any."""
        if self.phase == "introduce" and self.plan["target_kind"] == "production":
            require(self.state["b0"] is not None, "No B0 snapshot")
            require(type(self.evidence.get("local-restore")) is dict, "Local-restore receipt required")
            receipt = self.evidence["local-restore"]
            now = self.now()
            receipt_valid(receipt, self.plan, self.state["b0"]["manifest_sha256"], self.production, now=now,
                          b0_created_utc=self.state["b0"].get("created_utc"), used=self.state["receipts_used"])
            self.receipt_facts = receipt_clock(receipt, now, self.state["b0"].get("created_utc"))
            return receipt_sha256(receipt)
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
            # The writers stay fenced: a failed capture is never "resumed" behind the operator's back.
            return self.finish("CAPTURE_FAILED", False)
        except Unknown:
            return self.finish("NEEDS_ATTENTION", False)
        return self.finish("HELD", True, extra={"b0": self.state["b0"]})

    def phase_release(self):
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
        opened = False
        try:
            for item in STEPS["rollback_reopen"]:
                if item[1] == "reopen_previous_ingress":
                    opened = True
                self.run_step(*item)
        except (Stop, Unknown):
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
        except (Stop, Unknown):
            return self.finish("ROLLED_BACK", False, release=False)
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
(async()=>{const form=new URLSearchParams({grant_type:'password',client_id:'admin-cli',username:process.env.KIN_KC_ADMIN_USER,password:process.env.KIN_KC_ADMIN_PASSWORD});
 // Keycloak may still be starting (writers resumed a moment ago, or a restore): ready means the realm kin answers 200 -
 // a 404 while it loads its realms is not ready (D18) - then the administrator's token; at most two minutes each.
 const until=async probe=>{for(let i=0;i<60;i++){try{const v=await probe();if(v)return v;}catch(e){}await new Promise(r=>setTimeout(r,2000));}return null;};
 if(!await until(async()=>(await fetch(base+'/realms/kin')).status===200))throw new Error('keycloak not ready');
 const granted=await until(async()=>{const r=await fetch(base+'/realms/master/protocol/openid-connect/token',{method:'POST',body:form});
  return r.status<500&&r.status!==404?r:null;});
 if(!granted)throw new Error('keycloak unreachable');
 if(granted.status!==200)throw new Error('admin');
 const token=(await granted.json()).access_token;
 const call=async(method,path,body)=>{const r=await fetch(base+'/admin/realms/kin'+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
   body:body===undefined?undefined:JSON.stringify(body)});if(r.status===404)return null;if(r.status>=300)throw new Error(method+' '+r.status);
   const text=await r.text();return text?JSON.parse(text):null;};
 const users=async()=>((await call('GET','/users?exact=true&username='+encodeURIComponent(input.username)))||[]).filter(u=>u.username===input.username);
 // One login client per attempt (a retry makes its own): the removal names every one of them.
 const ids=input.client_ids||(input.client_id?[input.client_id]:[]);
 const clients=async()=>{const out=[];for(const id of ids){out.push(...(((await call('GET','/clients?clientId='+encodeURIComponent(id)))||[]).filter(c=>c.clientId===id)));}return out;};
 if(operation==='create-member'){
  if((await users()).length)throw new Error('exists');
  await call('POST','/users',{username:input.username,email:input.username+'@kin-smoke.invalid',enabled:true,emailVerified:true,
   firstName:'Release',lastName:'Smoke',requiredActions:[]});
  const [user]=await users();
  await call('PUT','/users/'+user.id+'/reset-password',{type:'password',value:process.env.KIN_SMOKE_PASSWORD,temporary:false});
  const roles=[];for(const name of input.roles){roles.push(await call('GET','/roles/'+encodeURIComponent(name)));}
  if(roles.some(r=>!r))throw new Error('role');
  await call('POST','/users/'+user.id+'/role-mappings/realm',roles);
  const group=((await call('GET','/groups?exact=true&search='+encodeURIComponent(input.group)))||[]).find(g=>g.name===input.group);
  if(!group)throw new Error('group');
  await call('PUT','/users/'+user.id+'/groups/'+group.id);
  out({id:user.id,username:user.username});return;}
 if(operation==='create-client'){
  if((await clients()).length)throw new Error('exists');
  await call('POST','/clients',{clientId:input.client_id,enabled:true,publicClient:true,standardFlowEnabled:true,directAccessGrantsEnabled:false,
   protocol:'openid-connect',redirectUris:[input.redirect_uri],attributes:{'pkce.code.challenge.method':'S256'},
   protocolMappers:[{name:'kin-api-audience',protocol:'openid-connect',protocolMapper:'oidc-audience-mapper',config:{'included.custom.audience':'kin-api','access.token.claim':'true','id.token.claim':'false'}},
    {name:'kin-institution-groups',protocol:'openid-connect',protocolMapper:'oidc-group-membership-mapper',config:{'full.path':'false','access.token.claim':'true','id.token.claim':'false','userinfo.token.claim':'false','claim.name':'groups'}},
    {name:'kin-authentication-time',protocol:'openid-connect',protocolMapper:'oidc-usersessionmodel-note-mapper',config:{'user.session.note':'AUTH_TIME','claim.name':'auth_time','jsonType.label':'long','access.token.claim':'true','id.token.claim':'true'}}]});
  const [client]=await clients();out({id:client.id,client_id:client.clientId});return;}
 if(operation==='remove'){
  for(const user of await users()){await call('PUT','/users/'+user.id,{enabled:false});await call('DELETE','/users/'+user.id);}
  for(const client of await clients()){await call('DELETE','/clients/'+client.id);}
  out({user_absent:(await users()).length===0,client_absent:(await clients()).length===0});return;}
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
SMOKE_REALM_SQL = """SELECT json_build_object(
  'roles', (SELECT coalesce(json_agg(k.name ORDER BY k.name), '[]'::json) FROM keycloak_role k WHERE k.realm_id = r.id AND NOT k.client_role),
  'top_level_groups', (SELECT coalesce(json_agg(g.name ORDER BY g.name), '[]'::json) FROM keycloak_group g
    WHERE g.realm_id = r.id AND (g.parent_group IS NULL OR btrim(g.parent_group) = '')))
  FROM realm r WHERE r.name = 'kin'"""
SERVERINFO_SCRIPT = r"""
const base=(process.env.KC_ADMIN_URL||'').replace(/\/$/,'');
(async()=>{const form=new URLSearchParams({grant_type:'password',client_id:'admin-cli',username:process.env.KIN_KC_ADMIN_USER,password:process.env.KIN_KC_ADMIN_PASSWORD});
 // Its own readiness (D19): the master realm answers 200 (a 404 while Keycloak loads is not ready), then the token, then
 // serverinfo answers 200; a refused administrator stops at once; at most two minutes each.
 const until=async probe=>{for(let i=0;i<60;i++){try{const v=await probe();if(v)return v;}catch(e){if(e&&e.refused)throw e;}
  await new Promise(r=>setTimeout(r,2000));}return null;};
 if(!await until(async()=>(await fetch(base+'/realms/master')).status===200))throw new Error('keycloak not ready');
 const granted=await until(async()=>{const r=await fetch(base+'/realms/master/protocol/openid-connect/token',{method:'POST',body:form});
  return r.status<500&&r.status!==404?r:null;});
 if(!granted)throw new Error('keycloak unreachable');
 if(granted.status!==200)throw new Error('admin');
 const t=await granted.json();
 const answered=await until(async()=>{const r=await fetch(base+'/admin/serverinfo',{headers:{Authorization:'Bearer '+t.access_token}});
  if(r.status===401||r.status===403)throw Object.assign(new Error('serverinfo'),{refused:true});return r.status===200?r:null;});
 if(!answered)throw new Error('serverinfo');
 const info=await answered.json();
 const caches=info?.providers?.userSessions?.providers?.infinispan?.operationalInfo?.useCaches;
 const features=Array.isArray(info.features)?info.features:[];
 const persistent=features.find(f=>f&&f.name==='PERSISTENT_USER_SESSIONS');
 process.stdout.write('KIN_RESULT '+JSON.stringify({useCaches:caches===undefined?null:String(caches),persistentUserSessions:persistent?persistent.enabled===true:null})+'\n');
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
    """D17: the process group (POSIX) or job object (Windows) of one command, so that every process it started - a
    browser's renderer, GPU and zygote children included - ends with it. On Windows the job kills what is left when it
    closes; the command starts suspended and resumes only once it is in the job, so no child can escape it."""

    def __init__(self, argv):
        self.job = None
        if os.name == "posix":
            self.process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                            start_new_session=True)
            return
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
        self.process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                        creationflags=0x00000004)   # CREATE_SUSPENDED
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
            self.kernel32.CloseHandle(self.job)
            self.job = None
        if self.process.poll() is None:
            try:
                self.process.kill()
            except OSError:
                pass


def run_tree(argv, *, input, timeout):
    """Run a command with its input; on its timeout - and after it ended, for whatever it left running - kill its whole
    process tree (D17). Returns (exit code, stdout, stderr) or raises subprocess.TimeoutExpired once the tree is gone."""
    tree = _ProcessTree(argv)
    try:
        try:
            stdout, stderr = tree.process.communicate(input, timeout=timeout)
        except subprocess.TimeoutExpired:
            tree.kill()
            try:
                tree.process.communicate(timeout=30)
            except (subprocess.TimeoutExpired, ValueError, OSError):
                pass
            raise subprocess.TimeoutExpired(argv, timeout) from None
        return tree.process.returncode, stdout, stderr
    finally:
        tree.kill()
        for stream in (tree.process.stdout, tree.process.stderr, tree.process.stdin):
            try:
                if stream:
                    stream.close()
            except OSError:
                pass


def remove_profile(path, seconds=15):
    """A browser profile folder (a member's session cookies) goes once its browser has ended; on Windows a killed
    browser's files may stay locked for a moment, so the removal is retried for a bounded time."""
    deadline = time.monotonic() + seconds
    while True:
        shutil.rmtree(path, ignore_errors=True)
        if not Path(path).exists() or time.monotonic() >= deadline:
            break
        time.sleep(0.5)
    require(not Path(path).exists(), "The browser profile could not be removed")


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


def set_env_line(raw, name, value):
    """The .env bytes with exactly one NAME=value line for this name (any earlier one removed), everything else kept."""
    require(ops.ENV_NAME.fullmatch(name) is not None and re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", value) is not None, "Invalid env line")
    kept = [line for line in raw.decode("utf-8").splitlines() if line.strip().split("=", 1)[0].strip() != name]
    return ("\n".join(kept) + "\n" + name + "=" + value + "\n").lstrip("\n").encode("utf-8")


class HostOps:
    """The docker/compose/git/crontab operations of each step, against one target manifest only. Every command goes
    through cmd(), which records it (records.command) whatever its outcome."""

    def __init__(self, *, target, plan, runner, records, env_next=None, token_reader=None, secure=None, owner=None,
                 browser_cmd=None, repository_check=None):
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

    @property
    def unattended(self):
        return self.browser_cmd is not None

    # ── primitives ──
    def cmd(self, args, *, timeout=60, input=None, env=None, check=True, mutating=False, stdin=None, output=None, quiet=False):
        """Run one fixed-binary command and record it before acting on its outcome: redacted argv, environment names (never
        values), input hash, start, duration, outcome (exit code, timeout or launch error), output hashes. quiet: the
        command carries a secret on stdin, so its error text (which may quote that input) is never kept."""
        args = list(args)
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
            result = self.run(args, input=input, timeout=timeout, env=env, stdin=stdin, output=output)
        except subprocess.TimeoutExpired:
            entry.update(outcome="timeout", seconds=round(time.monotonic() - started, 3))
            self.records.command(entry)
            if mutating:
                raise Unknown(label + " timed out; its end state is unknown") from None
            raise Stop(label.strip() + " timed out") from None
        except OSError as error:
            entry.update(outcome="error", error=type(error).__name__, seconds=round(time.monotonic() - started, 3))
            self.records.command(entry)
            raise Stop(label.strip() + " could not be started") from None
        entry.update(outcome="exit", exit=result.returncode, seconds=round(time.monotonic() - started, 3),
                     stdout=output_record(result.stdout if output is None else None), stderr=output_record(result.stderr))
        if check and result.returncode and not quiet:
            entry["failure_log"] = self.records.log("failed-" + uuid.uuid4().hex[:12] + ".err",
                                                    (" ".join(redact_argv(args[:3])) + "\n").encode() + (result.stderr or b"")[-16384:])
        self.records.command(entry)
        if check and result.returncode:
            raise Stop(f"{label} failed (exit {result.returncode})")
        return result

    @contextmanager
    def bind(self):
        """ops_backup's helpers (captures, restores, catalogs) run against this repository through cmd(), recorded."""
        def run(args, *, output=None, input_file=None, timeout=600, check=True):
            return self.cmd(list(args), output=output, stdin=input_file, timeout=timeout, check=check)
        previous = ops.ROOT, ops.run
        ops.ROOT, ops.run = self.repo, run
        try:
            yield
        finally:
            ops.ROOT, ops.run = previous

    def text(self, args, **kwargs):
        return self.cmd(args, **kwargs).stdout.decode("utf-8").strip()

    def compose_files(self):
        out = []
        for item in self.t["compose_files"]:
            out += ["-f", str(self.compose_path(item))]
        return out

    def compose(self, args, *, override=None, timeout=180, env=None, mutating=True, check=True, project=None, files=None):
        command = ["docker", "compose", "--project-directory", str(self.repo), "--project-name", project or self.t["project"],
                   *(files if files is not None else self.compose_files()), *(["-f", "-"] if override else []), *args]
        environment = {**self.compose_env, **(env or {})} or None
        return self.cmd(command, input=override.encode() if override else None, timeout=timeout, env=environment,
                        mutating=mutating, check=check)

    def pins(self, intro, *, maintenance=True):
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
        return override_yaml(services)

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
        """Around each step: which image each role runs (or none) and its Compose project, the checkout, the applied
        history's head, the lock."""
        running, projects = {}, {}
        for role in ROLES:
            item = self.inspect(role)
            running[role] = item["Image"] if item and item["State"]["Running"] else None
            projects[role] = ((item or {}).get("Config") or {}).get("Labels", {}).get("com.docker.compose.project") if item else None
        try:
            with self.bind():
                rows = ops.migration_rows(self.names["db"])
            history = {"count": len(rows), "last": rows[-1][0] if rows else None}
        except Exception as error:
            history = {"unobservable": type(error).__name__}
        return {"running": running, "projects": projects, "head": self.text(["git", "rev-parse", "HEAD"]), "migrations": history,
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
        """A named, labelled one-shot (never --rm before its exit is recorded). A worker (anything that writes) carries
        this release's label, so a later rollback can see whether it may still be alive; its client timeout is an
        unknown end. A read-only helper that times out is removed and is a settled refusal. The result carries both the
        client's and the container's own exit; callers require both."""
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
            result = self.compose(command, override=self.pins(intro), timeout=timeout, env=env, check=False, mutating=True, project=project)
        except Unknown:
            state = self.cmd(["docker", "inspect", "--format", "{{.State.Running}}", container], check=False)
            alive = state.returncode == 0 and state.stdout.decode().strip() == "true"
            if not worker:
                self.cmd(["docker", "rm", "-f", container], check=False)
                raise Stop(name + " helper timed out") from None
            raise Unknown(name + (" worker is still running" if alive else " ended without a recorded exit")) from None
        logs = {"stdout": self.records.log(container + ".out", result.stdout), "stderr": self.records.log(container + ".err", result.stderr)}
        exited = self.cmd(["docker", "inspect", "--format", "{{.State.ExitCode}}", container], check=False)
        exit_code = int(exited.stdout.decode().strip()) if exited.returncode == 0 and exited.stdout.decode().strip().isdigit() else None
        if exit_code is not None:
            self.cmd(["docker", "rm", container], check=False)
        return {"container": container, "exit": result.returncode, "container_exit": exit_code, "logs": logs, "stdout": result.stdout}

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
            raw = self.cmd(["docker", "compose", "--project-directory", str(self.repo), *self.compose_files(), "config", "--format", "json"],
                           timeout=60, env=dict(self.compose_env) or None).stdout
        model = json.loads(raw)
        services = {name: service or {} for name, service in (model.get("services") or {}).items() if name in (*ROLES, *ONE_SHOTS)}

        def port(item):
            return (item.get("host_ip") + ":" if item.get("host_ip") else "") + str(item.get("published")) + ":" + str(item.get("target"))

        def setting(service, key):
            value = (services.get(service, {}).get("environment") or {}).get(key)
            return value if type(value) is str else None
        return {"project": model.get("name"),
                "containers": {name: service.get("container_name") for name, service in services.items()},
                "volumes": {key: (value or {}).get("name") for key, value in (model.get("volumes") or {}).items()},
                "networks": {key: (value or {}).get("name") for key, value in (model.get("networks") or {}).items()},
                "mounts": {name: [{"type": item.get("type"), "source": item.get("source"), "target": item.get("target"),
                                   "read_only": item.get("read_only") is True}
                                  for item in service.get("volumes") or []] for name, service in services.items()},
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
            if os.name != "posix":
                return None, None
            info = os.lstat(path)
            require(info.st_uid in (0, os.geteuid()) and not info.st_mode & 0o022, what + " is writable by others: " + str(path))
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
                protection(path.parent, "A declared overlay's folder")
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
        path = intro.records.directory / COMPOSE_VALUES
        if not path.exists():
            return {}
        values = decode(intro.records.read(path))
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
                            require(mount.get("source") == marker and service in ROLES, "Unresolvable compose variable: " + name)
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
                        values.add(sources[0])
                    carriers.add(kind + ":" + service)
                require(len(values) <= 1, "Unresolvable compose variable: " + name)
                if values:
                    resolved[name] = values.pop()
                    origin = sorted(carriers)
                else:
                    require(name in kept, "Unresolvable compose variable: " + name)
                    resolved[name] = kept[name]
                    origin = ["kept"]
                record[name] = {"sha256": sha256_bytes(resolved[name].encode("utf-8")), "from": origin}
        known = intro.state.setdefault("compose_env", {})
        for name, entry in record.items():
            require(known.get(name, entry)["sha256"] == entry["sha256"], "A resolved compose variable changed: " + name)
        for name, entry in record.items():
            known[name] = {**entry, "kept": True}
        if resolved and any(kept.get(name) != value for name, value in resolved.items()):
            intro.records.write(intro.records.directory / COMPOSE_VALUES, canonical({**kept, **resolved}) + b"\n")
        intro.save()
        self.compose_env = resolved
        return {"resolved_from_running_stack": record, "declared_overlays": overlays}

    # ── IRT-13 / IRT-11: recorded pre-fence corrections of the checkout ──
    def checkout_mode(self, intro):
        """With the manifest's fix_checkout_mode: the checkout becomes 0700 and its .git loses group/other write (never
        recursively), modes recorded before and after; then the checkout is checked as private like any other run."""
        git = self.repo / ".git"
        before = {"checkout": oct(self.repo.stat().st_mode & 0o7777), ".git": oct(git.stat().st_mode & 0o7777)}
        if self.t["fix_checkout_mode"]:
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
        return {"reconciled": done}

    def token_since(self, moment, what):
        """The smoke token, issued (iat) no earlier than the given moment: a login made for this attempt, never an older one."""
        token = self.token()
        issued = token_claims(token).get("iat")
        require(type(issued) is int and issued >= int(parse_utc(moment).timestamp()), "The smoke token was issued before " + what)
        return token

    # ── IRT-14: the unattended smoke (D1062) - a temporary member, a real browser login, the checks, the record ──
    def smoke_project(self, intro):
        recovery = intro.state.get("recovery")
        return recovery["project"] if recovery and intro.state.get("restored_at") else None

    def smoke_admin(self, intro, operation, payload, *, password=None):
        """Keycloak administration for the smoke member and its login client, from a one-shot of the running API image
        with the target's administrator (values only in the one-shot's environment)."""
        env = {"KIN_KC_ADMIN_USER": self.t["keycloak_admin"], "KIN_KC_ADMIN_PASSWORD": parse_env(self.env_file().read_bytes()).get("KC_ADMIN_PASSWORD", "")}
        if password is not None:
            env["KIN_SMOKE_PASSWORD"] = password
        out = self.one_shot(intro, "api", ["-e", SMOKE_ADMIN_SCRIPT, operation, json.dumps(payload)], timeout=180, env=env,
                            entrypoint="node", name="kc-smoke-" + operation, project=self.smoke_project(intro))
        require(out["exit"] == 0 and out["container_exit"] == 0, "Smoke member administration failed: " + operation)
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
        password = token_source.token_urlsafe(32)
        credentials = "smoke-member-" + side + ".json"
        intro.records.write(intro.records.directory / credentials, canonical({"username": username, "password": password}) + b"\n")
        intro.state["smoke_member"] = {"username": username, "id": None, "side": side, "client_id": None, "credentials": credentials,
                                       "created_at": None, "deleted_at": None}
        intro.save()
        created = self.smoke_admin(intro, "create-member", {"username": username, "roles": spec["roles"], "group": spec["group"]},
                                   password=password)
        intro.state["smoke_member"].update(id=created["id"], created_at=utc_now().isoformat())
        intro.save()
        intro.records.journal({"event": "smoke-member-created", "plan_sha256": intro.plan_sha256, "username": username, "side": side})
        return intro.state["smoke_member"]

    def run_browser(self, spec, *, timeout=None, what="login"):
        """The configured headless browser (policy smoke_browser_cmd): the spec (a login's with the password, or the L-01
        probe's) goes on stdin; its one KIN_RESULT line is the answer. Recorded like every command (argv, input and output
        hashes only). D17: the browser runs as its own process tree, which is killed whole on the timeout and after the
        browser ended (no Chromium child outlives it)."""
        timeout = timeout or BROWSER_TIMEOUT_S
        entry = {"argv": redact_argv(self.browser_cmd), "env": [], "mutating": False, "timeout_s": timeout, "started_utc": utc_now().isoformat(),
                 "input": output_record(json.dumps(spec).encode()), "browser": what}
        started = time.monotonic()
        try:
            code, stdout, stderr = run_tree(self.browser_cmd, input=json.dumps(spec).encode(), timeout=timeout)
        except subprocess.TimeoutExpired:
            entry.update(outcome="timeout", seconds=round(time.monotonic() - started, 3), tree="killed")
            self.records.command(entry)
            raise Stop("The smoke browser timed out") from None
        except OSError as error:
            entry.update(outcome="error", error=type(error).__name__, seconds=round(time.monotonic() - started, 3))
            self.records.command(entry)
            raise Stop("The smoke browser could not be started") from None
        entry.update(outcome="exit", exit=code, seconds=round(time.monotonic() - started, 3),
                     stdout=output_record(stdout), stderr=output_record(stderr))
        self.records.command(entry)
        if code:
            # The browser's own record-safe failure code (a fixed check message or an error type; see code_of).
            try:
                reason = json.loads(stderr.decode("utf-8").strip().splitlines()[-1]).get("error")
            except (ValueError, IndexError, AttributeError, UnicodeDecodeError):
                reason = None
            raise Stop("The smoke browser " + what + " failed" + (": " + reason[:160] if type(reason) is str else ""))
        return result_line(stdout)

    def browser_check(self, intro):
        """D01 (L-01, before the fence): the policy's browser command is an executable file and the browser it runs opens a
        blank page in a new profile folder and ends with exit 0 within BROWSER_PROBE_S; the browsers' folder it names
        (PLAYWRIGHT_BROWSERS_PATH) resolves. A missing or broken browser stops here, not after the migration."""
        program = Path(self.browser_cmd[0])
        require(program.is_absolute() and program.is_file() and os.access(program, os.X_OK),
                "The smoke browser command is not an executable file: " + str(program))
        profile = intro.records.directory / ("browser-probe-" + uuid.uuid4().hex[:8])
        try:
            value = self.run_browser({"probe": True, "profile_dir": str(profile)}, timeout=BROWSER_PROBE_S, what="probe")
        finally:
            remove_profile(profile)
        require(type(value) is dict and value.get("probe") == "ok" and type(value.get("browser")) is str,
                "The smoke browser did not open a blank page")
        return {"program": str(program), "browser": value["browser"][:80], "browsers_path": value.get("browsers_path")}

    def browser_login(self, intro, *, connect, product_session=False, timeout=None, attempt=1):
        """One real Authorization Code + PKCE login of the smoke member in the headless browser, through a temporary public
        client (removed with the member; a retry makes its own); the token must belong to that member. product_session
        (the introduced release): first the product's own sign-in, its logout and the refusal of the ended session, in
        the same browser."""
        member = intro.state["smoke_member"]
        credentials = json.loads(intro.records.read(intro.records.directory / member["credentials"]))
        client_id = member["username"] + "-client" + ("" if attempt == 1 else "-" + str(attempt))
        redirect = "https://" + SMOKE_REDIRECT_HOST + "/" + member["username"]
        member["client_id"] = client_id
        member["client_ids"] = sorted({*(member.get("client_ids") or []), client_id})
        intro.save()
        self.smoke_admin(intro, "create-client", {"client_id": client_id, "redirect_uri": redirect})
        # The browser's profile (its cookies are this member's session) lives in this run's private folder and is gone
        # after the login, whatever the browser did; every attempt has a new one.
        profile = intro.records.directory / ("browser-profile-" + uuid.uuid4().hex[:8])
        try:
            value = self.run_browser({"origin": self.t["origin"], "connect": list(connect) if connect else None, "ca_file": self.t["ca_file"],
                                      "username": credentials["username"], "password": credentials["password"], "client_id": client_id,
                                      "redirect_uri": redirect, "profile_dir": str(profile), "product_session": product_session},
                                     timeout=timeout)
        finally:
            remove_profile(profile)
        require(type(value) is dict and value.get("flow") == "authorization_code+S256" and type(value.get("refresh_token")) is str,
                "The smoke browser did not return an authorization-code login")
        token = token_valid({"access_token": value.get("access_token"), "subject": value.get("subject")})
        require(token["subject"] == member["id"], "The browser login belongs to another subject")
        return token, value["refresh_token"], client_id, value

    def end_session(self, refresh_token, client_id, *, connect):
        """The temporary client's own sign-in session ends with the smoke (its access token is a bearer credential the API
        checks statelessly until it expires; the product's session logout is the browser's check)."""
        code, _ = https_post(self.t["origin"], "/auth/realms/kin/protocol/openid-connect/logout",
                             {"client_id": client_id, "refresh_token": refresh_token}, connect=connect, ca_file=self.t["ca_file"])
        require(code in (200, 204), "The smoke login session could not be ended")

    def remove_smoke_member_now(self, intro):
        member = intro.state.get("smoke_member")
        if member and not member.get("deleted_at"):
            clients = sorted({*(member.get("client_ids") or []), *([member["client_id"]] if member.get("client_id") else [])})
            removed = self.smoke_admin(intro, "remove", {"username": member["username"], "client_ids": clients})
            require(removed.get("user_absent") is True and removed.get("client_absent") is True, "The smoke member or its client is still present")
            member["deleted_at"] = utc_now().isoformat()
            intro.save()
            intro.records.journal({"event": "smoke-member-deleted", "plan_sha256": intro.plan_sha256, "username": member["username"]})
        if member and member.get("deleted_at"):
            # The password of a member that no longer exists is not kept.
            intro.records.discard(intro.records.directory / member["credentials"])
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
        W2 checks use the temporary client's fresh token. D07: a failed attempt (an environmental hiccup must not cost a
        full B0 rollback) is retried once - a new login client and a new browser profile, all of it within SMOKE_RETRY_S -
        and the retry and its reason are recorded (state, journal, the step's detail; the first attempt's record kept as
        operator-smoke-attempt-1.json). Only the retry's failure is the step's STOP."""
        try:
            return self.release_smoke_attempt(intro, connect)
        except Stop as error:
            reason = code_of(error)
        started = time.monotonic()
        first = intro.records.directory / "operator-smoke.json"
        kept = None
        if first.exists():
            raw = intro.records.read(first)
            intro.records.write(intro.records.directory / "operator-smoke-attempt-1.json", raw)
            intro.records.discard(first)
            kept = sha256_bytes(raw)
        intro.state.pop("operator_smoke", None)
        intro.state["smoke_retry"] = {"reason": reason, "at": utc_now().isoformat(), "bound_s": SMOKE_RETRY_S,
                                      "first_record_sha256": kept, "passed": None}
        intro.save()
        intro.records.journal({"event": "smoke-retry", "plan_sha256": intro.plan_sha256, "reason": reason, "bound_s": SMOKE_RETRY_S})
        try:
            result = self.release_smoke_attempt(intro, connect, attempt=2, timeout=max(10, SMOKE_RETRY_S - 5))
            require(time.monotonic() - started <= SMOKE_RETRY_S, "The smoke retry exceeded its bound of %d s" % SMOKE_RETRY_S)
        except Stop as error:
            intro.state["smoke_retry"].update(passed=False, retry_code=code_of(error))
            intro.state.pop("operator_smoke", None)
            intro.save()
            raise
        intro.state["smoke_retry"].update(passed=True, seconds=round(time.monotonic() - started, 3))
        intro.save()
        return {**result, "retry": {"reason": reason, "passed": True}}

    def release_smoke_attempt(self, intro, connect, *, attempt=1, timeout=None):
        """One attempt of the unattended release smoke (see unattended_release_smoke)."""
        token, refresh, client_id, value = self.browser_login(intro, connect=connect, product_session=True, timeout=timeout, attempt=attempt)
        issued = token_claims(token).get("iat")
        require(type(issued) is int and issued >= int(parse_utc(intro.state["imported_at"]).timestamp()), "The smoke login predates the member import")
        result = smoke(self.t["origin"], connect=connect, ca_file=self.t["ca_file"], token=token, frame=self.frame(intro),
                       worklist_uid=frame_study(intro.plan))
        require(smoke_passed(result), "The fenced smoke did not run every check")
        row = worklist_row(self.t["origin"], frame_study(intro.plan), connect=connect, ca_file=self.t["ca_file"], token=token["access_token"])
        session = value.get("product_session")
        checks = {"login_pkce": type(session) is dict and session.get("signed_in") is True, "worklist_uid": True, "ohif_frame": True,
                  "realm_v1_pending_zero": True, "w2_modality": type((row or {}).get("modality")) is str and bool(row["modality"]),
                  "logout_old_session_refused": product_logout_refused(session)}
        for name, path in (("w2_folders", "/api/filter-folders"), ("w2_shortcuts", "/api/workspace-shortcuts")):
            code, _, raw = https_get(self.t["origin"], path, connect=connect, ca_file=self.t["ca_file"], token=token["access_token"])
            try:
                checks[name] = code == 200 and json.loads(raw) is not None
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
    def baseline(self, intro):
        model = self.resolved(intro, maintenance=False)
        check_resolved(model, self.t, target_checkout=False, maintenance=False, images=intro.plan["previous"]["images"])
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
        with self.bind():
            migrations, catalog = ops.migration_rows(self.names["db"]), ops.role_catalog(self.names["db"])
        observed = {"head": self.text(["git", "rev-parse", "HEAD"]),
                    "dirty": bool(self.text(["git", "status", "--porcelain", "--untracked-files=no"])),
                    "images": images, "running": running, "restarting": restarting, "migrations": migrations, "catalog": catalog,
                    "emr_volumes": existing, "api_state_mounts": sum(1 for m in api.get("Mounts") or [] if m.get("Destination") == ops.EMR_STATE),
                    "cron": cron, "members": self.realm_members()}
        pre.check_baseline(observed, intro.plan)
        free = shutil.disk_usage(intro.plan["backup_root"] if Path(intro.plan["backup_root"]).exists() else Path(intro.plan["backup_root"]).parent).free
        require(free >= intro.plan["budget"]["min_free_bytes"], "Free disk space below the plan")
        # L-08a reads the Keycloak server options with the target's administrator. Prove that credential now, read-only,
        # so that a wrong administrator name or password stops here instead of after the first database change.
        keycloak = self.keycloak_selected(intro)
        # D01/D02: what the unattended smoke will need after the migration is proved before the fence - the plan's smoke
        # member can be made in this realm (its roles and group exist) and the configured browser runs.
        member = self.smoke_member_realm(intro)
        browser = self.browser_check(intro) if self.unattended else "not configured (operator smoke)"
        return {"head": observed["head"], "images": images, "migrations": len(observed["migrations"]), "cron": cron, "free_bytes": free,
                "members": observed["members"], "keycloak_admin": "verified", "keycloak_before": keycloak,
                "roles": sorted(role["rolname"] for role in catalog["roles"]), "smoke_member_realm": member, "smoke_browser": browser}

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
        with self.bind(), redirect_stdout(printed):
            ops.rehearse(directory)
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
        return health_check(self.t["origin"], ca_file=self.t["ca_file"], member_rights=False)

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
        require(self.compose_digest_now() == intro.plan["compose"]["before_sha256"], "Previous configuration was not restored")
        self.prepare(intro)
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
        check_resolved(self.resolved(intro), self.t, target_checkout=True, maintenance=True, images=intro.plan["release"]["images"])
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
        model = self.resolved(intro)
        check_resolved(model, self.t, target_checkout=True, maintenance=True, images=intro.plan["release"]["images"])
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
        with self.bind():
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
        require(self.compose_digest_now() == intro.plan["compose"]["before_sha256"], "Previous configuration was not restored")
        self.prepare(intro)
        project = self.recovery_project(intro)
        recovery = {"project": project, "pg": project + "_pg-db", "orthanc": project + "_orthanc-db", "persisted": False}
        for name in (recovery["pg"], recovery["orthanc"]):
            require(self.cmd(["docker", "volume", "inspect", name], check=False).returncode != 0, "A recovery volume name is taken: " + name)
        # Durable before creation: a failed restore still names exactly the project and volumes it made.
        intro.state["recovery"] = recovery
        intro.save()
        for key, name in (("pg-db", recovery["pg"]), ("orthanc-db", recovery["orthanc"])):
            self.cmd(["docker", "volume", "create", "--label", "com.docker.compose.project=" + project, "--label", "com.docker.compose.volume=" + key,
                      "--label", "kin.ops.recovery=" + intro.plan_sha256[:16], name], mutating=True)
        self.remove_container("db")
        recovery_env = set_env_line(previous_env, "COMPOSE_PROJECT_NAME", project)
        self.write_env(recovery_env)
        recovery.update(env_sha256=sha256_bytes(recovery_env), compose_sha256=self.compose_digest_now())
        intro.save()
        self.compose(["up", "-d", "--no-deps", "--no-build", "--pull", "never", "db"], override=self.pins(intro), timeout=180, project=project)
        self.db_ready(180, "Recovery database did not become ready")
        db = self.inspect("db")
        require({m.get("Destination"): m.get("Name") for m in db.get("Mounts") or []}.get("/var/lib/postgresql/data") == recovery["pg"],
                "Recovery database is not on its fresh volume")
        with self.bind():
            restored = ops.restore_pre_snapshot(self.names["db"], b0)
        with open(b0 / "orthanc.tgz", "rb") as handle:
            self.cmd(["docker", "run", "--rm", "-i", "--network", "none", "--label", "kin.ops.recovery=" + intro.plan_sha256[:16],
                      "--mount", "type=volume,source=" + recovery["orthanc"] + ",target=/restore", "--entrypoint", "tar",
                      intro.plan["previous"]["images"]["db"], "-xzf", "-", "-C", "/restore"], stdin=handle, timeout=1800, mutating=True)
        checked = json.loads(self.text(["docker", "run", "--rm", "--network", "none", "--read-only", "--mount",
                                        "type=volume,source=" + recovery["orthanc"] + ",target=/restore,readonly", "--entrypoint", "python3",
                                        intro.plan["previous"]["images"]["orthanc"], "-c", ops.SQLITE_CHECK], timeout=600))
        require(checked.get("integrity") == "ok", "Restored Orthanc index failed")
        with self.bind():
            for database in ("kin", "keycloak"):
                require(ops.counts(self.names["db"], database, "kin") == manifest["counts"][database], "Restored row counts differ: " + database)
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
        # Compose's own image name of each built service of the recovery project names the previous image, so an ordinary
        # `compose up` of this checkout uses exactly the previous API and proxy.
        for role in ("api", "proxy"):
            self.cmd(["docker", "image", "tag", intro.plan["previous"]["images"][role], recovery["project"] + "-" + role + ":latest"], mutating=True)
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
        check_resolved(model, self.t, target_checkout=False, maintenance=False, recovery=recovery)
        for role in ("api", "proxy"):
            tagged = json.loads(self.text(["docker", "image", "inspect", recovery["project"] + "-" + role + ":latest"]))[0]
            require(tagged.get("Id") == intro.plan["previous"]["images"][role], "The recovery project's " + role + " image is not the previous one")
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
        require(self.compose_digest_now() == recovery["compose_sha256"], "The recovery configuration changed")
        baseline = {"schema": 1, "kind": "recovery-baseline", "plan_sha256": intro.plan_sha256, "project": recovery["project"],
                    "volumes": {"pg": recovery["pg"], "orthanc": recovery["orthanc"]}, "images": intro.plan["previous"]["images"],
                    "previous_sha": intro.plan["previous"]["sha"], "env_sha256": recovery["env_sha256"],
                    "compose_sha256": recovery["compose_sha256"], "failed_volumes_kept": failed,
                    "bfail_manifest_sha256": intro.state["bfail"]["manifest_sha256"],
                    "handover": ["The checkout's .env names COMPOSE_PROJECT_NAME=" + recovery["project"] + "; keep it.",
                                 "An API-only deployment needs its policy's compose_sha256 set to compose_sha256 above.",
                                 "The failed volumes are kept for analysis; nothing in this mode deletes or reattaches them."]}
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
            require(type(issued) is int and issued >= int(parse_utc(intro.state["restored_at"]).timestamp()),
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
        catalog = Path(seed["b0_dir"]) / "catalog.json"
        require(catalog.is_file(), "The seed has no cluster catalog")
        ops.supported_pre_catalog(json.loads(catalog.read_text(encoding="utf-8")))
        require(not any(self.inspect(role) for role in ROLES), "Clone containers already exist")
        require(not any(self.cmd(["docker", "volume", "inspect", name], check=False).returncode == 0 for name in self.t["volumes"].values()),
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
        require(self.cmd(["docker", "volume", "inspect", volume], check=False).returncode == 0,
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
        with self.bind():
            _, manifest, _ = ops.validate_held(seed, intro.plan["seed"]["b0_manifest_sha256"])
        override = self.pins(intro)
        self.compose(["up", "-d", "--no-deps", "--no-build", "--pull", "never", "db"], override=override, timeout=180)
        self.db_ready(180, "Clone database did not become ready")
        with self.bind():
            restored = ops.restore_pre_snapshot(self.names["db"], seed)
            for database in ("kin", "keycloak"):
                require(ops.counts(self.names["db"], database, "kin") == manifest["counts"][database], "Seeded row counts differ: " + database)
        source_env, clone_env = parse_env((seed / ".env").read_bytes()), parse_env(self.env_file().read_bytes())
        isolation = self.keycloak_isolation(intro, source_env, clone_env, source_env.get("PUBLIC_ORIGIN", "https://pacs.koreaimagingnetwork.com"))
        # The restored master realm keeps the source administrator (whose password the clone must not know); the clone
        # gets its own administrator with the clone's KC_ADMIN_PASSWORD, through Keycloak's own recovery command.
        admin = self.one_shot(intro, "keycloak", ["bootstrap-admin", "user", "--username", self.t["keycloak_admin"],
                                                 "--password:env", "KC_BOOTSTRAP_ADMIN_PASSWORD", "--no-prompt"],
                              timeout=600, entrypoint="/opt/keycloak/bin/kc.sh", name="kc-bootstrap-admin")
        require(admin["exit"] == 0 and admin["container_exit"] == 0, "The clone Keycloak administrator could not be created")
        isolation["administrator"] = {"created": self.t["keycloak_admin"], "logs": admin["logs"]}
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

    def __init__(self, directory, host):
        super().__init__(directory)
        self.host = host

    def ensure(self, directory):
        """Create a records directory (the run directory itself or one level below it) as 0700 if it is missing, then
        accept it only as ops_deploy_host.protected accepts a private directory: no link, root-owned, nothing for group
        or others, along the whole path. A new directory is made durable in its parent."""
        directory = Path(directory)
        require(directory == self.directory or directory.parent == self.directory, "Records stay in the plan's run directory")
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
        super().discard(path)
        self.host.sync_dir(self.directory)


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

    def execute(self, raw):
        host = self.host
        request = request_valid(raw)
        digest = sha256_bytes(raw)
        plan = plan_valid(self.document("emr-plans", request["plan_sha256"]))
        require(plan["target_kind"] in self.policy["targets_allowed"], "This host does not run that target kind")
        target = target_valid(self.document("emr-targets", plan["target_manifest_sha256"]))
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
                ownership_check()
                modes = {name: oct(path.lstat().st_mode & 0o7777) for name, path in (("checkout", self.repository), (".git", self.repository / ".git"))}
                warnings.append({"kind": "checkout-mode", "reason": code_of(error), "modes": modes})
        approval = approval_valid(decode(host.read_secure(self.state / "emr-approvals" / (digest + ".json"))), digest,
                                  request["phase"], int(time.time()), plan["target_kind"], unattended=browser_cmd is not None)
        evidence = {kind: self.document("emr-evidence", value) for kind, value in approval["evidence"].items()}
        # One use: a replayed request with the same bytes can never run a phase twice.
        host.write_secure(self.state / "emr-used" / (digest + ".json"), {"request_sha256": digest, "consumed_at": int(time.time())},
                          exclusive=True)
        records = HostRecords(self.state / "emr-runs" / request["plan_sha256"], host)
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
                           browser_cmd=browser_cmd, repository_check=repository_check)
        intro = Introduction(plan=plan, plan_sha256=request["plan_sha256"], target=target, production=self.policy["production"],
                             ops=ops_host, records=records, repository=self.repository, host_key=local_host_key(),
                             tool=tool_hashes(), evidence=evidence, warnings=warnings)
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
    context = ssl.create_default_context(cafile=ca_file) if ca_file else ssl.create_default_context()
    with socket.create_connection(tuple(connect) if connect else (host, port), timeout=20) as raw, \
            context.wrap_socket(raw, server_hostname=host) as tls:
        return spki_pin(tls.getpeercert(binary_form=True))


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
            context = playwright.chromium.launch_persistent_context(str(profile), headless=True)
            try:
                page = context.pages[0] if context.pages else context.new_page()
                page.goto("about:blank")
                agent = re.search(r"Chrome/([0-9.]+)", page.evaluate("navigator.userAgent") or "")
            finally:
                context.close()
    finally:
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
            context = playwright.chromium.launch_persistent_context(str(profile), headless=True, args=args, ignore_https_errors=False)
            try:
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
                                                                          wait_until="domcontentloaded", timeout=60000))
                agent = re.search(r"Chrome/([0-9.]+)", page.evaluate("navigator.userAgent") or "")
                version = agent.group(1) if agent else "unknown"
                browser_stage(page, "the sign-in form", lambda: (page.fill("#username", spec["username"]), page.fill("#password", spec["password"])))
                try:
                    page.click("#kc-login")
                except Exception:
                    # The navigation to the unresolvable callback fails by design; only a click before it is an error.
                    if "url" not in landed:
                        raise
                for _ in range(120):
                    if "url" in landed:
                        break
                    page.wait_for_timeout(250)
                if "url" not in landed:
                    # Where the sign-in stopped (a page title such as a required action; never a value of the form).
                    landed["title"] = re.sub(r"[^\w .:-]", "", page.title() or "")[:60]
            finally:
                context.close()
    finally:
        shutil.rmtree(profile, ignore_errors=True)
    require("url" in landed, "The sign-in did not return to the registered redirect (page: " + landed.get("title", "") + ")")
    params = parse_qs(urlsplit(landed["url"]).query)
    require(params.get("state") == [state] and len(params.get("code", [])) == 1, "The sign-in returned another login's code")
    code, raw = https_post(spec["origin"], "/auth/realms/kin/protocol/openid-connect/token",
                           {"client_id": spec["client_id"], "grant_type": "authorization_code", "code": params["code"][0],
                            "redirect_uri": spec["redirect_uri"], "code_verifier": verifier}, connect=connect, ca_file=spec.get("ca_file"))
    require(code == 200, "The authorization code was not exchanged")
    tokens = json.loads(raw)
    claims = token_claims({"access_token": tokens["access_token"]})
    return {"flow": "authorization_code+S256", "browser": "chromium " + version, "access_token": tokens["access_token"],
            "refresh_token": tokens["refresh_token"], "subject": claims.get("sub"), "product_session": product}


# The product's own session requests as its web documents send them (worklist-v0/hpacs-lite/auth.js: X-KIN-CSRF, and
# X-KIN-Session once the document knows its session); GET /api/me without the binding is the product's bootstrap call.
PRODUCT_ME_JS = ("async (sid) => { const h = {'X-KIN-CSRF': '1'}; if (sid) h['X-KIN-Session'] = sid;"
                 " const r = await fetch('/api/me', {headers: h, credentials: 'same-origin', cache: 'no-store'});"
                 " let b = {}; try { b = await r.json(); } catch (e) {}"
                 " return {status: r.status, sid: typeof b.sessionId === 'string' && b.sessionId ? b.sessionId : null}; }")
PRODUCT_LOGOUT_JS = ("async (sid) => (await fetch('/api/auth/logout', {method: 'POST', credentials: 'same-origin',"
                     " headers: {'X-KIN-CSRF': '1', 'X-KIN-Session': sid}})).status")


def sign_in(page, spec):
    """The realm's sign-in form, filled with the smoke member's credentials."""
    page.wait_for_selector("#username", timeout=60000)
    page.fill("#username", spec["username"])
    page.fill("#password", spec["password"])
    page.click("#kc-login")


def browser_stage(page, name, action):
    """One browser stage; a failure names the stage, the error type and the page it stopped on (path and title only:
    never a query, a fragment or a form value)."""
    try:
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
    browser_stage(page, "the product sign-in page", lambda: page.goto(origin + "/api/auth/login", wait_until="domcontentloaded", timeout=60000))
    browser_stage(page, "the product sign-in form", lambda: sign_in(page, spec))
    browser_stage(page, "the product's return", lambda: page.wait_for_url(lambda url: url.startswith(origin + "/worklist/"),
                                                                           wait_until="commit", timeout=60000))
    sid = None
    for _ in range(120):
        try:
            answer = page.evaluate(PRODUCT_ME_JS, None)
            if answer.get("status") == 200 and answer.get("sid"):
                sid = answer["sid"]
                break
        except Exception:
            pass   # the document is still navigating (its entry step)
        page.wait_for_timeout(500)
    if sid is None:
        error = (parse_qs(urlsplit(page.url).query).get("auth_error") or [""])[0]
        raise Stop("The product sign-in did not open a session" + (" (" + re.sub(r"[^\w-]", "", error)[:40] + ")" if error else ""))
    browser_stage(page, "a neutral page", lambda: page.goto(origin + "/auth/realms/kin/.well-known/openid-configuration",
                                                             wait_until="domcontentloaded", timeout=60000))
    logout = browser_stage(page, "the product logout", lambda: page.evaluate(PRODUCT_LOGOUT_JS, sid))
    bound = browser_stage(page, "the ended session", lambda: page.evaluate(PRODUCT_ME_JS, sid).get("status"))
    cookie = browser_stage(page, "the ended session's cookie", lambda: page.evaluate(PRODUCT_ME_JS, None).get("status"))
    return {"signed_in": True, "logout_status": logout, "old_session_status": bound, "old_cookie_status": cookie}


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
    return {"schema": 1, "kind": "production", **{key: production[key] for key in IDENTITY_KEYS},
            "repository": "/srv/kin/repository", "compose_files": ["docker-compose.yml", "docker-compose.prod.yml", "docker-compose.monitor.yml"],
            "ports": {"maintenance": "127.0.0.1:9444:443", "public": ["80:80", "443:443"]},
            "tls_certificate": "/etc/letsencrypt/live/pacs.example.invalid/fullchain.pem",
            "cron": {"user": "ubuntu", "tags": ["kin-pacs-reviewed-backup", "kin-pacs-reviewed-monitor"]}, "ca_file": None,
            "keycloak_admin": "admin", "external_networks": {}, "declared_overlays": [], "tracked_overlay_reconcile": [],
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
    receipt.add_argument("--b0-created-utc")
    receipt.add_argument("--policy", type=Path, required=True)
    receipt.add_argument("--bundle", type=Path, help="The rehearsal's run directory: re-verify every phase result and the journal")
    sub.add_parser("browser-smoke", help="The reference headless browser of the unattended smoke: login spec on stdin, KIN_RESULT out")
    args = parser.parse_args(argv)
    if args.command == "browser-smoke":
        try:
            spec = json.loads(sys.stdin.buffer.read(65536).decode("utf-8"))
            require(type(spec) is dict, "Invalid browser spec")
            print("KIN_RESULT " + json.dumps(browser_probe(spec) if spec.get("probe") is True else browser_smoke(spec)))
            return 0
        except Exception as error:   # never the spec or a token in the message
            print(json.dumps({"valid": False, "error": code_of(error)}), file=sys.stderr)
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
            receipt = decode(args.receipt.read_bytes())
            receipt_valid(receipt, plan, args.b0_manifest_sha256, policy["production"], b0_created_utc=args.b0_created_utc)
            if args.bundle:
                bundle_valid(receipt, args.bundle)
            print(json.dumps({"valid": True, "receipt_sha256": receipt_sha256(receipt), "bundle": bool(args.bundle)}))
    except (Stop, OSError, ValueError, subprocess.CalledProcessError) as error:
        print(json.dumps({"valid": False, "error": code_of(error)}), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
