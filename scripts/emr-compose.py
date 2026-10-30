#!/usr/bin/env python3
"""Check EMR-B deployment safety and supply the fixed provisioning SQL.

  python scripts/emr-compose.py sql provision        print the provisioning SQL (no secrets; psql reads them via \\getenv)
  python scripts/emr-compose.py check [--json]        Compose credentials, state, startup order and production mounts

This tool never connects to a database or a Docker daemon and never runs an operational command. Provisioning is
executed by whoever installs a deployment (the compose service `emr-provision`, CI, or an operator) with psql and the
installer credential; secrets come from that environment only (KIN_EMR_RUNTIME_PASSWORD, and optionally
KIN_EMR_READER_PASSWORD / KIN_EMR_RETENTION_PASSWORD).
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
ROLES = ("kin_emr_owner", "kin_runtime", "kin_emr_reader", "kin_emr_retention")
TABLESPACE_LOCATION = "/var/lib/postgresql/emr-access/ts"

_ROLE_LIST = ", ".join("'%s'" % role for role in ROLES)
_PASSWORD = r"\A[A-Za-z0-9._~-]+\Z"
# Compose's volume-name grammar. Anything else in a short-syntax source is a host path once Compose interpolates it
# (${PWD}/api, ${KIN_DATA:-/srv/kin}), so a prefix list of path characters is not enough.
_VOLUME_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]*")


def _optional_login(role, variable, environment):
    return "\n".join([
        "\\getenv %s %s" % (variable, environment),
        "\\if :{?%s}" % variable,
        "SELECT CASE WHEN length(:'%s') >= 24 AND :'%s' ~ '%s'" % (variable, variable, _PASSWORD),
        "  THEN format('ALTER ROLE %s LOGIN PASSWORD %%L', :'%s') ELSE 'SELECT %s_password_unusable' END \\gexec" % (role, variable, role),
        "\\else",
        "ALTER ROLE %s NOLOGIN;" % role,
        "\\endif",
    ])


# Kept free of '$' so docker-compose.yml can carry the same text verbatim (Compose would interpolate it).
PROVISION_SQL = "\n".join([
    "-- EMR-B provisioning, run with the installer credential outside any migration transaction (CREATE TABLESPACE cannot",
    "-- run inside one). Idempotent: every run re-asserts the roles, their attributes, the secrets given in the environment",
    "-- and the dedicated placement, and fails on any elevated attribute or membership. Secrets are never printed.",
    "\\set QUIET on",
    "\\set ON_ERROR_STOP on",
    "\\if :{?tablespace_location}",
    "\\else",
    "\\set tablespace_location " + TABLESPACE_LOCATION,
    "\\endif",
    "SELECT format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT', r)",
    "  FROM unnest(ARRAY[%s]) AS r" % _ROLE_LIST,
    "  WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r) \\gexec",
    "SELECT format('ALTER ROLE %I NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT', r)",
    "  FROM unnest(ARRAY[%s]) AS r \\gexec" % _ROLE_LIST,
    "ALTER ROLE kin_emr_owner NOLOGIN;",
    "\\getenv runtime_password KIN_EMR_RUNTIME_PASSWORD",
    "\\if :{?runtime_password}",
    "\\else",
    "\\warn 'KIN_EMR_RUNTIME_PASSWORD is required'",
    "SELECT kin_emr_runtime_password_required;",
    "\\endif",
    "SELECT CASE WHEN length(:'runtime_password') >= 24 AND :'runtime_password' ~ '%s'" % _PASSWORD,
    "  THEN format('ALTER ROLE kin_runtime LOGIN PASSWORD %L', :'runtime_password') ELSE 'SELECT kin_runtime_password_unusable' END \\gexec",
    _optional_login("kin_emr_reader", "reader_password", "KIN_EMR_READER_PASSWORD"),
    _optional_login("kin_emr_retention", "retention_password", "KIN_EMR_RETENTION_PASSWORD"),
    "SELECT format('CREATE TABLESPACE kin_emr_access OWNER kin_emr_owner LOCATION %L', :'tablespace_location')",
    "  WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_tablespace WHERE spcname = 'kin_emr_access') \\gexec",
    "ALTER TABLESPACE kin_emr_access OWNER TO kin_emr_owner;",
    "SELECT CASE WHEN pg_catalog.pg_tablespace_location(oid) = :'tablespace_location' THEN 'SELECT 1 AS kin_emr_tablespace_checked'",
    "  ELSE 'SELECT kin_emr_tablespace_location_differs' END FROM pg_catalog.pg_tablespace WHERE spcname = 'kin_emr_access' \\gexec",
    "-- A database migrated before the tablespace existed: move the ledger (tables carry their TOAST; indexes move apart).",
    "SELECT format('ALTER TABLE emr_access.%I SET TABLESPACE kin_emr_access', c.relname)",
    "  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace",
    "  WHERE n.nspname = 'emr_access' AND c.relkind = 'r'",
    "    AND c.reltablespace IS DISTINCT FROM (SELECT t.oid FROM pg_catalog.pg_tablespace t WHERE t.spcname = 'kin_emr_access') \\gexec",
    "SELECT format('ALTER INDEX emr_access.%I SET TABLESPACE kin_emr_access', c.relname)",
    "  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace",
    "  WHERE n.nspname = 'emr_access' AND c.relkind = 'i'",
    "    AND c.reltablespace IS DISTINCT FROM (SELECT t.oid FROM pg_catalog.pg_tablespace t WHERE t.spcname = 'kin_emr_access') \\gexec",
    "SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname IN (%s)" % _ROLE_LIST,
    "    AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))",
    "  OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles g ON g.oid = m.roleid",
    "    JOIN pg_catalog.pg_roles u ON u.oid = m.member WHERE g.rolname IN (%s) OR u.rolname IN (%s))" % (_ROLE_LIST, _ROLE_LIST),
    "  OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'kin_emr_owner' AND rolcanlogin)",
    "  OR pg_catalog.has_parameter_privilege('kin_runtime', 'session_replication_role', 'SET')",
    "  THEN 'SELECT kin_emr_role_check_failed' ELSE 'SELECT 1 AS kin_emr_roles_checked' END \\gexec",
    "",
])


def problem(problems, code, detail=""):
    problems.append(code + (": " + detail if detail else ""))


def load_yaml(path):
    import yaml  # PyYAML, as the existing CI declaration tests use it

    class ComposeLoader(yaml.SafeLoader):
        """Compose's merge tags (!reset, !override) carry the value they replace with; nothing else is admitted."""

    for tag in ("!reset", "!override"):
        ComposeLoader.add_constructor(tag, lambda loader, node: (
            loader.construct_sequence(node) if isinstance(node, yaml.SequenceNode) else
            loader.construct_mapping(node) if isinstance(node, yaml.MappingNode) else loader.construct_scalar(node)))
    return yaml.load(path.read_text(encoding="utf-8"), Loader=ComposeLoader)


def environment(service):
    values = service.get("environment") or {}
    if isinstance(values, list):
        return dict(value.partition("=")[::2] for value in values)
    return values


def mounts(service):
    """Accept both Compose volume syntaxes; a Windows drive colon belongs to the source."""
    for volume in service.get("volumes") or []:
        if isinstance(volume, dict):
            yield volume
        else:
            match = re.fullmatch(r"(.+):(/[^:]*)(?::([^:]*))?", volume)
            if match:
                source, target, mode = match.groups()
                yield {"type": "volume" if _VOLUME_NAME.fullmatch(source) else "bind", "source": source,
                       "target": target, "read_only": "ro" in (mode or "").split(",")}
            else:
                yield {"target": volume}


def has_state_volume(service):
    return any(volume.get("source") == "emr-state" and volume.get("target") == "/var/lib/kin-emr"
               and volume.get("type", "volume") == "volume" and not volume.get("read_only")
               for volume in mounts(service))


def compose_shape(root, problems):
    compose = load_yaml(root / "docker-compose.yml")
    prod = load_yaml(root / "docker-compose.prod.yml")
    services = compose.get("services") or {}
    for name in ("db", "emr-provision", "api-migrate", "api"):
        if name not in services:
            problem(problems, "compose-service-missing", name)
    if problems:
        return
    migrate, api = (services[n] for n in ("api-migrate", "api"))
    env = environment(api)
    # Compose password substitutions may contain '?'; these are templates, not resolved URLs.
    url = env.get("DATABASE_URL", "")
    if not url.startswith(("postgresql://kin_runtime:", "postgres://kin_runtime:")):
        problem(problems, "compose-api-not-runtime-role")
    if any("POSTGRES_PASSWORD" in str(value) for pair in env.items() for value in pair):
        problem(problems, "compose-api-holds-installer-secret")
    if env.get("KIN_EMR_STATE_DIR") != "/var/lib/kin-emr" or not has_state_volume(api):
        problem(problems, "compose-api-state-volume")
    if ((api.get("depends_on") or {}).get("api-migrate") or {}).get("condition") != "service_completed_successfully":
        problem(problems, "compose-api-before-migration")
    if ((migrate.get("depends_on") or {}).get("emr-provision") or {}).get("condition") != "service_completed_successfully":
        problem(problems, "compose-migration-before-provision")
    if "emr-state" not in (compose.get("volumes") or {}):
        problem(problems, "compose-volume-undeclared", "emr-state")
    pservices = prod.get("services") or {}
    papi, pmigrate = pservices.get("api") or {}, pservices.get("api-migrate") or {}
    if (pmigrate.get("build") or {}).get("target") != "production":
        problem(problems, "prod-migration-not-production-image")
    if not has_state_volume(papi):
        problem(problems, "prod-api-state-volume")
    # A host bind can replace image contents. Other named volumes need not be read-only.
    if any(volume.get("type") == "bind" or ("source" in volume and not _VOLUME_NAME.fullmatch(str(volume["source"])))
           for volume in mounts(papi)):
        problem(problems, "prod-api-host-bind")


def check(root):
    problems = []
    try:
        compose_shape(root, problems)
    except Exception as error:
        problem(problems, "compose-unreadable", type(error).__name__)
    return problems


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    sql = sub.add_parser("sql")
    sql.add_argument("what", choices=["provision", "audit-grantor"])
    for option in ("institution", "issuer", "subject", "basis-document"):
        sql.add_argument("--" + option)
    sql.add_argument("--capacity", choices=["privacy-officer", "institution-representative"])
    chk = sub.add_parser("check")
    chk.add_argument("--root", type=Path, default=ROOT)
    chk.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    if args.command == "sql":
        if args.what == "audit-grantor":
            values = [args.institution, args.issuer, args.subject, args.capacity, args.basis_document]
            if any(not value or not value.strip() or "\x00" in value for value in values):
                parser.error("audit-grantor needs institution, issuer, subject, capacity and basis-document")
            institution, issuer, subject, capacity, basis = [
                "E'" + value.replace("\\", "\\\\").replace("'", "''") + "'" for value in values]
            delimiter = "$designation$"
            while any(delimiter in value for value in values):
                delimiter = delimiter[:-1] + "_$"
            sys.stdout.write("\\set ON_ERROR_STOP on\nBEGIN;\n"
                f"DO {delimiter}\nDECLARE member_id uuid;\nBEGIN\n"
                f"SELECT emr_access.existing_member_identity({issuer},{subject}) INTO member_id;\n"
                "IF member_id IS NULL THEN RAISE EXCEPTION 'Unknown identity: check issuer/subject and ask the person to sign in once before designation'; END IF;\n"
                "INSERT INTO emr_audit.grantor(institution_id,subject_id,capacity,basis_document_id)\n"
                f"VALUES({institution},member_id::text,{capacity},{basis})\n"
                "ON CONFLICT(institution_id,subject_id) DO UPDATE SET capacity=EXCLUDED.capacity,\n"
                f"basis_document_id=EXCLUDED.basis_document_id;\nEND\n{delimiter};\nCOMMIT;\n")
            return 0
        sys.stdout.write(PROVISION_SQL)
        return 0
    problems = check(args.root.resolve())
    print(json.dumps({"ok": not problems, "problems": problems}, indent=None if getattr(args, "json", False) else 1))
    return 0 if not problems else 1


if __name__ == "__main__":
    sys.exit(main())
