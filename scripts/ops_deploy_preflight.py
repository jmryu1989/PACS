"""Read-only API deployment preflight. This never authorizes or executes deployment.

python scripts/ops_deploy_preflight.py request.json --request-sha256 <sha256>
The separately supplied hash binds bytes, not the identity/authority of an approver.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit

import ops_backup as ops

COMPOSE = ["docker-compose.yml", "docker-compose.prod.yml", "docker-compose.monitor.yml"]
# EMR-B1: the image's entry modes and the migration/runtime credential split are part of the deployment boundary.
PROTECTED = ["api/prisma", "api/Dockerfile", "api/start-production.sh", "keycloak", "config", "proxy", "worklist-v0", "gateway", *COMPOSE]
# A release that brings the EMR-B storage needs, before any switch: the provisioning (roles, secrets, tablespace volume),
# the installer-credential migration in its own process and a restore rehearsal of database plus API state volume.
# None of that is an API-only replacement, so this path refuses it outright.
EMR_MIGRATION = "api/prisma/migrations/20261008120000_emr_b/migration.sql"
EMR_STATE = "/var/lib/kin-emr"
FIELDS = {"version", "previous_sha", "target_sha", "previous_api_image", "target_api_image", "compose_files"}
SHA = re.compile(r"[0-9a-f]{40}")
IMAGE = re.compile(r"sha256:[0-9a-f]{64}")
HASH = re.compile(r"[0-9a-f]{64}")


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "Duplicate JSON key")
        result[key] = value
    return result


def parse_request(raw, expected_hash):
    require(isinstance(expected_hash, str) and HASH.fullmatch(expected_hash), "Invalid request hash")
    require(len(raw) <= 8192, "Request too large")
    require(hashlib.sha256(raw).hexdigest() == expected_hash, "Request hash mismatch")
    body = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object)
    require(type(body) is dict and set(body) == FIELDS, "Unexpected request fields")
    require(type(body["version"]) is int and body["version"] == 1, "Unsupported request version")
    for field in ("previous_sha", "target_sha"):
        require(type(body[field]) is str and SHA.fullmatch(body[field]), "Invalid commit SHA")
    for field in ("previous_api_image", "target_api_image"):
        require(type(body[field]) is str and IMAGE.fullmatch(body[field]), "Expected immutable local image ID")
    require(body["compose_files"] == COMPOSE, "Base, production and monitor overlays required in order")
    require(body["previous_sha"] != body["target_sha"], "Target is already selected")
    return body


def git(*args):
    return ops.text(["git", *args], timeout=30)


def api_tree(sha):
    require(type(sha) is str and SHA.fullmatch(sha), "Invalid image revision")
    require(git("cat-file", "-t", sha) == "commit", "Expected a Git commit")
    require(git("cat-file", "-t", sha + ":api") == "tree", "Missing API tree")
    return git("rev-parse", sha + ":api")


def has_emr_storage(sha):
    """Whether this commit's product carries the EMR-B storage (its migration file is in the tree)."""
    return ops.run(["git", "cat-file", "-e", sha + ":" + EMR_MIGRATION], check=False, timeout=30).returncode == 0


def check_repository(body):
    previous, target = body["previous_sha"], body["target_sha"]
    require(git("rev-parse", "--show-toplevel") == str(ops.ROOT).replace("\\", "/"), "Wrong repository root")
    require(git("rev-parse", "HEAD") == previous, "Checkout SHA changed")
    require(not git("status", "--porcelain", "--untracked-files=no"), "Tracked working tree is dirty")
    trees = {sha: api_tree(sha) for sha in (previous, target)}
    require(has_emr_storage(previous) or not has_emr_storage(target),
            "EMR-B storage requires provisioning, installer migration and restore evidence; not an API-only deployment")
    for path in PROTECTED:
        # Missing paths must not make an empty diff look like proven compatibility.
        before = git("rev-parse", previous + ":" + path)
        after = git("rev-parse", target + ":" + path)
        require(before == after, "API-only compatibility boundary changed")
    return trees


def check_image(image, expected_id, expected_tree):
    require(image.get("Id") == expected_id, "Image ID mismatch")
    config = image.get("Config") or {}
    require(config.get("User") == "node", "Expected production node user")
    revision = (config.get("Labels") or {}).get("org.opencontainers.image.revision")
    require(api_tree(revision) == expected_tree, "Image revision API tree mismatch")


def check_running_api(container, expected_id, emr=False):
    require(container.get("Name") == "/kin-api", "Wrong API container")
    require(container.get("Image") == expected_id, "Running API image changed")
    require((container.get("State") or {}).get("Running") is True, "API is not running")
    config = container.get("Config") or {}
    labels = config.get("Labels") or {}
    require(labels.get("com.docker.compose.project.working_dir") == str(ops.ROOT), "Wrong Compose working directory")
    require(labels.get("com.docker.compose.service") == "api", "Wrong Compose service")
    require(config.get("User") == "node", "Running API is not the production user")
    mounts = container.get("Mounts")
    if emr:
        # EMR-B: exactly the protected state volume (ledger seal and failure journal), never a host path.
        require(type(mounts) is list and len(mounts) == 1 and type(mounts[0]) is dict and mounts[0].get("Type") == "volume"
                and mounts[0].get("Destination") == EMR_STATE and mounts[0].get("RW") is True,
                "API must run with only its EMR state volume")
    else:
        require(mounts == [], "API must run without host or volume overrides")
    network = container.get("NetworkSettings") or {}
    require("Ports" in network and not any((network["Ports"] or {}).values()), "API host ports are exposed or unknown")
    host = container.get("HostConfig") or {}
    require(host.get("NetworkMode") not in (None, "host") and not host.get("PortBindings"), "Unsafe API network mode or host bindings")
    env = dict(item.split("=", 1) for item in config.get("Env", []) if "=" in item)
    require(env.get("DEPLOYMENT_MODE") == "production" and env.get("AUTH_REQUIRED") == "true", "Production authentication settings required")
    if emr:
        # The server holds the runtime role only: no installer password and no other database user in its environment.
        try:
            user = urlsplit(env.get("DATABASE_URL", "")).username
        except ValueError:
            user = None
        require(user == "kin_runtime" and "POSTGRES_PASSWORD" not in env and env.get("KIN_EMR_STATE_DIR") == EMR_STATE,
                "API must hold only the EMR runtime credential and its state directory")


def inspect_one(args):
    items = json.loads(ops.text(["docker", *args], timeout=30))
    require(type(items) is list and len(items) == 1 and type(items[0]) is dict, "Unexpected Docker inspection")
    return items[0]


def observe(body):
    """Recheck on the host; the caller must already own the operations lock."""
    ops.require_local_docker()
    trees = check_repository(body)
    for prefix in ("previous", "target"):
        identity = body[prefix + "_api_image"]
        check_image(inspect_one(["image", "inspect", identity]), identity, trees[body[prefix + "_sha"]])
    # check_repository refused an EMR introduction, so previous and target agree on the storage shape.
    check_running_api(inspect_one(["inspect", "kin-api"]), body["previous_api_image"], has_emr_storage(body["previous_sha"]))
    return {"preflight_passed": True, "deployment_authorized": False,
            "automatic_rollback_authorized": False, "schema_unchanged": True,
            "previous_sha": body["previous_sha"], "target_sha": body["target_sha"],
            "previous_api_image": body["previous_api_image"],
            "target_api_image": body["target_api_image"], "compose_files": list(COMPOSE)}


def preflight(body):
    # Share the backup lock, but do not issue a token that could be reused after
    # releasing it. A future deployer must recheck and keep this lock throughout.
    with ops.lock():
        return observe(body)


# ── EMR introduction (INTERIM-RELEASE-TOOLS, D1039/D1043): checks over facts the introduction mode observed ──
# scripts/ops_emr_introduction.py is the only caller. Everything above stays the API-only path, which keeps refusing a
# release that brings the EMR-B storage. Each check raises RuntimeError with a fixed message (the STOP code); none of
# them reads a secret value into its message, and none of them mutates anything.
MIGRATION_NAME = re.compile(r"0_init|\d{14}_[a-z0-9_]{1,80}")
EMR_ROLES = ("kin_emr_owner", "kin_runtime", "kin_emr_reader", "kin_emr_retention")
ELEVATED = ("rolsuper", "rolcreatedb", "rolcreaterole", "rolreplication", "rolbypassrls")
WRITERS = ("api", "keycloak", "orthanc", "proxy")
SECRET_FORM = re.compile(r"[A-Za-z0-9._~-]{24,}")
APP_ROLES = ("radiologist", "technician", "admin", "clinician")


def check_migration_rows(rows, expected):
    """The applied history equals the expected list exactly: names and SQL checksums, every one finished, none rolled back."""
    require(type(rows) is list and all(type(row) is list and len(row) == 4 for row in rows), "Unreadable migration history")
    require([[row[0], row[1]] for row in rows] == [list(item) for item in expected], "Migration names or checksums differ")
    require(all(row[2] is True and row[3] is False for row in rows), "A migration is unfinished or rolled back")


def emr_storage_present(catalog):
    """Any trace of the EMR storage in a cluster catalog: an EMR role, an emr_* schema (emr_access, and the later units'
    emr_clinical and the like) or the dedicated tablespace."""
    roles = {role["rolname"] for role in catalog["roles"]}
    return bool(roles & set(EMR_ROLES) or any(str(name).startswith("emr_") for name in catalog["schemas"])
                or any(space["name"] == "kin_emr_access" for space in catalog["tablespaces"]))


def check_baseline(observed, plan):
    """Before anything changes: the host is exactly the plan's previous release (fresh observation, not the old record)."""
    previous = plan["previous"]
    require(observed["head"] == previous["sha"] and observed["dirty"] is False, "Checkout is not the clean previous release")
    require(observed["images"] == previous["images"], "Running service images differ from the previous release")
    require(all(observed["running"].get(role) is True for role in ("db", *WRITERS)), "A service of the previous release is not running")
    require(not any(observed["restarting"].values()), "A service is restarting")
    check_migration_rows(observed["migrations"], plan["migrations"]["before"])
    require(not emr_storage_present(observed["catalog"]), "EMR storage already exists on the source")
    # A B0 the rollback could not rebuild exactly (a further LOGIN role, role settings, another database or tablespace)
    # is refused here, before the fence or any capture.
    ops.supported_pre_catalog(observed["catalog"])
    require(observed["emr_volumes"] == [], "EMR volumes already exist on the source")
    require(observed["api_state_mounts"] == 0, "The previous API already has an EMR state mount")
    require(observed["cron"] in ("matched", "not-managed"), "Scheduled jobs differ from the target manifest")
    check_member_counts(observed["members"], plan["members"])


def check_member_counts(observed, expected):
    """The realm's people as the plan recorded them in its read-only observation: members (service accounts are not
    members), how many of them are disabled, and the service accounts counted apart."""
    require(observed == expected, "Realm members differ from the plan")


def check_provision_first(catalog, rows, plan):
    """Provision-first only (Astra DR2-09): the provisioning runs on exactly the previous release's database, before any
    EMR migration. A database that already carries EMR roles, an emr_* schema, the tablespace or any migration beyond the
    previous history (a database migrated before it was provisioned) is refused, never repaired: emr-compose's
    PROVISION_SQL does not move existing relations' TOAST storage or later units' schemas into the tablespace."""
    check_migration_rows(rows, plan["migrations"]["before"])
    require(not emr_storage_present(catalog), "EMR storage exists before provisioning (migrated before provisioned); refused, not repaired")


def check_placement(rows):
    """Every relation of every emr_* schema - tables, indexes, sequences and each table's TOAST table and TOAST index -
    sits in kin_emr_access (what emr_access.require_placement demands, for all EMR schemas)."""
    require(type(rows) is list and rows, "EMR placement is unreadable or empty")
    outside = sorted(row["relation"] for row in rows if row["tablespace"] != "kin_emr_access")
    require(not outside, "EMR relations outside kin_emr_access: " + ",".join(outside)[:400])


def check_write_freeze(observed):
    """Every write entry point is closed: HTTPS ingress (proxy), DICOM receive and REST (Orthanc), gateway and member
    administration (API), account changes (Keycloak), scheduled jobs; and no database client remains."""
    require(all(observed["running"].get(role) is False for role in WRITERS), "A writer is still running")
    require(observed["running"].get("db") is True, "The database must keep running for the capture")
    require(observed["db_clients"] == 0, "Database clients remain after the fence")
    require(observed["cron"] in ("fenced", "not-managed"), "Scheduled jobs are not fenced")
    require(observed["one_shots"] == [], "A one-shot worker of this release is still present")


def check_tablespace_directory(observed, storage, fresh):
    """The tablespace directory belongs to the DB image's real postgres account, 0700; empty before CREATE TABLESPACE.
    An existing tablespace keeps its path and owner and is never emptied or chmodded to pass."""
    require(observed["path"] == storage["tablespace_path"] and observed["type"] == "directory", "Tablespace path differs")
    require((observed["uid"], observed["gid"]) == (storage["postgres_uid"], storage["postgres_gid"]), "Tablespace directory owner differs")
    require(observed["mode"] == "700", "Tablespace directory mode is not 0700")
    require(observed["entries"] == 0 if fresh else observed["entries"] >= 0, "Tablespace directory is not empty before CREATE TABLESPACE")


def check_env_secrets(env, secrets):
    """Secret names only by shape: the runtime secret exists in its URL-safe form and is not the installer's; reader and
    retention stay unset (NOLOGIN) unless the plan names them. Values never leave this function."""
    for name in secrets["required"]:
        require(type(env.get(name)) is str and env[name] != "", "A required secret name is missing")
    for name in secrets["absent"]:
        require(name not in env, "A secret that must stay unset is present")
    runtime, installer = env.get(secrets["runtime"], ""), env.get(secrets["installer"], "")
    require(SECRET_FORM.fullmatch(runtime) is not None, "Runtime secret form is unusable")
    require(runtime != installer, "Runtime secret reuses the installer secret")


def check_provisioned(catalog, storage, logins):
    """emr-provision's outcome: owner NOLOGIN, runtime LOGIN, reader/retention as planned; nothing elevated; no
    membership; the dedicated tablespace at the planned path, owned by kin_emr_owner."""
    roles = {role["rolname"]: role for role in catalog["roles"]}
    require(set(EMR_ROLES) <= set(roles), "An EMR role is missing")
    for name in EMR_ROLES:
        require(not any(roles[name][key] for key in ELEVATED), "An EMR role holds an elevated attribute")
        require(roles[name]["rolcanlogin"] is logins[name], "An EMR role login state differs from the plan")
    require(not any(m["granted"] in EMR_ROLES or m["member"] in EMR_ROLES for m in catalog["memberships"]),
            "An EMR role has a membership")
    spaces = [space for space in catalog["tablespaces"] if space["name"] == "kin_emr_access"]
    require(len(spaces) == 1 and spaces[0]["owner"] == "kin_emr_owner"
            and spaces[0]["location"] == storage["tablespace_path"], "EMR tablespace differs from the plan")


def check_emr_catalog(catalog):
    """After the migration: every ledger relation in the dedicated tablespace, owned by kin_emr_owner; the runtime role
    owns nothing; SECURITY DEFINER functions belong to the owner."""
    require(catalog["schema"]["owner"] == "kin_emr_owner", "EMR schema owner differs")
    require(catalog["tablespace"]["owner"] == "kin_emr_owner", "EMR tablespace owner differs")
    require(catalog["tables"] and all(item["owner"] == "kin_emr_owner" and item["tablespace"] == "kin_emr_access"
                                      for item in catalog["tables"]), "A ledger relation is outside its owner or tablespace")
    require(all(item["owner"] == "kin_emr_owner" for item in catalog["functions"] or []), "A ledger function has another owner")


def check_projection_preserved(before, after):
    """Every pre-existing table kept every row value of its pre-existing columns (counts and digests equal)."""
    require(set(before) <= set(after), "A pre-existing table disappeared")
    changed = sorted(name for name in before if (after[name]["count"], after[name]["sha256"]) != (before[name]["count"], before[name]["sha256"]))
    require(not changed, "Existing rows changed: " + ",".join(changed)[:400])


def check_counts_preserved(before, after):
    require(all(after.get(name) == count for name, count in before.items()), "Row counts of existing tables changed")


def check_introduced_api(container, *, name, image, release, working_dir, state_volume):
    """The running API of the introduced release: OS user node, DB role kin_runtime only, production authentication,
    exactly one RW named state volume and no host port; no installer secret in its environment."""
    require(container.get("Name") == "/" + name, "Wrong API container")
    require(container.get("Image") == image and (container.get("State") or {}).get("Running") is True, "API is not the running target image")
    config = container.get("Config") or {}
    labels = config.get("Labels") or {}
    require(labels.get("kin.deploy.release") == release, "API release label differs")
    require(labels.get("com.docker.compose.project.working_dir") == working_dir and labels.get("com.docker.compose.service") == "api",
            "Wrong Compose working directory or service")
    require(config.get("User") == "node", "Running API is not the production user")
    mounts = container.get("Mounts")
    require(type(mounts) is list and len(mounts) == 1 and mounts[0].get("Type") == "volume"
            and mounts[0].get("Name") == state_volume and mounts[0].get("Destination") == EMR_STATE
            and mounts[0].get("RW") is True, "API must run with only its EMR state volume")
    network = container.get("NetworkSettings") or {}
    require("Ports" in network and not any((network["Ports"] or {}).values()), "API host ports are exposed or unknown")
    host = container.get("HostConfig") or {}
    require(host.get("NetworkMode") not in (None, "host") and not host.get("PortBindings") and host.get("Privileged") is not True,
            "Unsafe API network mode, host bindings or privilege")
    env = dict(item.split("=", 1) for item in config.get("Env", []) if "=" in item)
    require(env.get("DEPLOYMENT_MODE") == "production" and env.get("AUTH_REQUIRED") == "true", "Production authentication settings required")
    try:
        user = urlsplit(env.get("DATABASE_URL", "")).username
    except ValueError:
        user = None
    require(user == "kin_runtime" and env.get("KIN_EMR_STATE_DIR") == EMR_STATE, "API must hold the EMR runtime credential and state directory")
    require(not {"POSTGRES_PASSWORD", "PGPASSWORD", "KIN_EMR_READER_PASSWORD", "KIN_EMR_RETENTION_PASSWORD"} & set(env),
            "API holds an installer, reader or retention secret")


def check_state_volume(observed, storage):
    """The API state volume as the node account sees it: owner node, 0700, and a file can be created, synced, renamed."""
    require((observed["uid"], observed["gid"]) == (storage["node_uid"], storage["node_gid"]), "State volume owner differs")
    require(observed["mode"] == "700" and observed["writable"] is True, "State volume mode or write test failed")


def check_keycloak_serverinfo(selected):
    """Process options of the running Keycloak (keycloak/README.md): user-session caches off, persistent sessions on."""
    require(selected.get("useCaches") == "false", "Keycloak user-session caches are not off")
    require(selected.get("persistentUserSessions") is True, "Keycloak persistent user sessions are not on")


def expected_member_rights(user, isolated, unconfirmed):
    """The row the product's import (api/src/member-rights-import.ts importMemberRights) writes for one realm member:
    the realm roles within APP_ROLES; approved only with exactly one group (the institution), at least one such role and
    no gateway role; an unapproved member holds no institution and no roles; suspended when the realm account is
    disabled, the member is isolated or a disable/enable of it is unconfirmed."""
    roles = sorted(role for role in user["roles"] if role in APP_ROLES)
    approved = len(user["groups"]) == 1 and bool(roles) and "gateway" not in user["roles"]
    return {"username": user["username"], "approved": approved, "institution": user["groups"][0] if approved else None,
            "roles": roles if approved else [],
            "suspended": user["enabled"] is not True or user["id"] in isolated or user["id"] in unconfirmed}


def check_member_import(observed):
    """realm-v1: one marker, ready, every realm member imported once with exactly the rights the product's rule gives
    its realm facts (identity, institution, every role, approval, suspension), every legacy-enable publication confirmed
    and no provider change left unconfirmed; and the realm itself unchanged by the import except those confirmed
    enables (the same members, names, groups and roles, the same realm role and group definitions)."""
    require(observed["markers"] == ["realm-v1"] and observed["state"] == "ready", "Member rights import marker missing")
    roster = {user["id"]: user for user in observed["roster_before"]}
    require(len(roster) == len(observed["roster_before"]), "The realm roster lists a member twice")
    rows = {row["sub"]: row for row in observed["rights"]}
    require(len(rows) == len(observed["rights"]) and set(rows) == set(roster), "Imported members differ from the realm members")
    changes = observed["changes"]
    isolated = set(observed["isolated"])
    unconfirmed = {change["sub"] for change in changes if change["kind"] in ("disable", "enable") and change["state"] == "unknown"}
    for sub, row in rows.items():
        actual = {"username": row["username"], "approved": row["approved"], "institution": row["institution"],
                  "roles": sorted(row["roles"]), "suspended": row["suspended"]}
        require(actual == expected_member_rights(roster[sub], isolated, unconfirmed),
                "An imported member's rights differ from the realm (identity, institution, roles, approval or suspension)")
    legacy = {change["sub"]: change for change in observed["legacy_enable"]}
    disabled = {sub for sub, user in roster.items() if not user["enabled"]}
    require(set(legacy) == disabled and len(legacy) == len(observed["legacy_enable"]), "Legacy enable intents differ from disabled members")
    require(all(change["state"] == "done" for change in legacy.values()), "A roster publication is unconfirmed")
    require(all(change["kind"] != "credentials" or change["target"] == "legacy-enable:" + str(change["sub"]) for change in changes),
            "The import left a roster change other than the legacy enables")
    require(not any(change["state"] == "unknown" for change in changes), "A provider change is unconfirmed")
    after = {user["id"]: user for user in observed["roster_after"]}
    require(set(after) == set(roster) and len(after) == len(observed["roster_after"]), "Realm members were added or removed during the import")
    for sub, user in roster.items():
        other = after[sub]
        require(other["username"] == user["username"] and sorted(other["groups"]) == sorted(user["groups"])
                and sorted(other["roles"]) == sorted(user["roles"]), "A realm member's name, groups or roles changed during the import")
        if sub in legacy:
            require(user["enabled"] is False and other["enabled"] is True, "A confirmed legacy enable is not in the realm")
        else:
            require(other["enabled"] == user["enabled"], "A realm member's enabled state changed without a legacy enable")
    require(observed["realm_before"] == observed["realm_after"], "Realm roles or groups changed during the import")
    require(all(rows[sub]["suspended"] for sub in disabled), "A legacy-disabled member lost its PACS suspension")


def check_proxy(observed, image):
    require(observed["image"] == image and observed["running"] is True, "Proxy is not the running target image")
    require(observed["nginx_test"] == 0, "nginx configuration test failed")
    require(observed["certificate_valid_days"] is True, "Proxy certificate is missing or expires within seven days")


def check_served_bytes(observed, expected):
    """UI and viewer configuration served by the Orthanc container equal the target tree (whole files, not a sample)."""
    require(observed == expected, "Served UI or viewer configuration differs from the target tree")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("request", type=Path)
    parser.add_argument("--request-sha256", required=True)
    args = parser.parse_args()
    try:
        with args.request.open("rb") as handle:
            body = parse_request(handle.read(8193), args.request_sha256)
        result = preflight(body)
    except Exception as error:
        # JSON, Docker and filesystem errors can contain supplied paths/secrets.
        print(json.dumps({"preflight_passed": False, "deployment_authorized": False,
                          "error_type": type(error).__name__}), file=sys.stderr)
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
