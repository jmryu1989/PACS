#!/usr/bin/env python3
"""EMR-B deployment declaration: check it, and supply the fixed provisioning SQL.

  python scripts/emr-compose.py sql provision        print the provisioning SQL (no secrets; psql reads them via \\getenv)
  python scripts/emr-compose.py check [--json]        the unit declaration emr/units/b.json against this checkout
  python scripts/emr-compose.py check-run --kind node|unittest --run-dir DIR --cases-from contract|live
                                                      a record-run.py evidence directory against the declared cases

This tool never connects to a database or a Docker daemon and never runs an operational command. Provisioning is
executed by whoever installs a deployment (the compose service `emr-provision`, CI, or an operator) with psql and the
installer credential; secrets come from that environment only (KIN_EMR_RUNTIME_PASSWORD, and optionally
KIN_EMR_READER_PASSWORD / KIN_EMR_RETENTION_PASSWORD). It checks honest-mistake consistency against reviewed tables;
it is not a general judge of test results.
"""
from __future__ import annotations

import argparse
import ast
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
DECLARATION = ROOT / "emr" / "units" / "b.json"
ROLES = ("kin_emr_owner", "kin_runtime", "kin_emr_reader", "kin_emr_retention")
TABLESPACE_LOCATION = "/var/lib/postgresql/emr-access/ts"

_ROLE_LIST = ", ".join("'%s'" % role for role in ROLES)
_PASSWORD = r"\A[A-Za-z0-9._~-]+\Z"


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


DECLARATION_KEYS = {"unit", "round", "base_sha", "dependencies", "owned_paths", "models", "routes", "records", "migrations",
                    "deployment", "restore", "req_risk_test", "cases", "expected", "mutants", "candidate_cases"}


def declared_cases(root, declaration, kind):
    """The live/contract case names collected from the test files themselves (Python AST; TypeScript AST for JS is
    the contract test's own C10)."""
    cases = declaration["cases"][kind]
    if kind == "live":
        try:
            module = ast.parse((root / cases["file"]).read_text(encoding="utf-8"))
        except (OSError, SyntaxError, UnicodeDecodeError):
            return None
        cls = next((n for n in module.body if isinstance(n, ast.ClassDef) and n.name == cases["class"]), None)
        if cls is None:
            return None
        return [n.name for n in cls.body if isinstance(n, ast.FunctionDef) and n.name.startswith("test_")]
    return None


def compose_shape(root, problems):
    compose = load_yaml(root / "docker-compose.yml")
    prod = load_yaml(root / "docker-compose.prod.yml")
    services = compose.get("services") or {}
    for name in ("db", "emr-provision", "api-migrate", "api"):
        if name not in services:
            problem(problems, "compose-service-missing", name)
    if problems:
        return
    db, provision, migrate, api = (services[n] for n in ("db", "emr-provision", "api-migrate", "api"))
    if "emr-access:/var/lib/postgresql/emr-access" not in (db.get("volumes") or []):
        problem(problems, "compose-tablespace-volume")
    entry = " ".join(db.get("entrypoint") or [])
    if "install -d -o postgres -g postgres -m 700 " + TABLESPACE_LOCATION not in entry or "docker-entrypoint.sh postgres" not in entry:
        problem(problems, "compose-tablespace-directory")
    script = (provision.get("command") or [""])[-1]
    match = re.search(r"<<'KIN_EMR_SQL'\n(.*)KIN_EMR_SQL\n?\Z", script, re.S)
    if not match or match.group(1) != PROVISION_SQL:
        problem(problems, "compose-provision-sql-differs")
    env = provision.get("environment") or {}
    if "KIN_EMR_RUNTIME_PASSWORD" not in env or env.get("PGUSER") != "kin":
        problem(problems, "compose-provision-environment")
    url = (api.get("environment") or {}).get("DATABASE_URL", "")
    if not url.startswith("postgresql://kin_runtime:${KIN_EMR_RUNTIME_PASSWORD"):
        problem(problems, "compose-api-not-runtime-role")
    if any("POSTGRES_PASSWORD" in str(value) for value in (api.get("environment") or {}).values()):
        problem(problems, "compose-api-holds-installer-secret")
    if (api.get("environment") or {}).get("KIN_EMR_STATE_DIR") != "/var/lib/kin-emr" or "emr-state:/var/lib/kin-emr" not in (api.get("volumes") or []):
        problem(problems, "compose-api-state-volume")
    if ((api.get("depends_on") or {}).get("api-migrate") or {}).get("condition") != "service_completed_successfully":
        problem(problems, "compose-api-before-migration")
    murl = (migrate.get("environment") or {}).get("DATABASE_URL", "")
    if not murl.startswith("postgresql://kin:${POSTGRES_PASSWORD") or migrate.get("command") != ["./node_modules/.bin/prisma", "migrate", "deploy"]:
        problem(problems, "compose-migration-credential")
    if ((migrate.get("depends_on") or {}).get("emr-provision") or {}).get("condition") != "service_completed_successfully":
        problem(problems, "compose-migration-before-provision")
    for volume in ("emr-access", "emr-state"):
        if volume not in (compose.get("volumes") or {}):
            problem(problems, "compose-volume-undeclared", volume)
    pservices = prod.get("services") or {}
    papi, pmigrate = pservices.get("api") or {}, pservices.get("api-migrate") or {}
    if (pmigrate.get("build") or {}).get("target") != "production":
        problem(problems, "prod-migration-not-production-image")
    if list(papi.get("volumes") or []) != ["emr-state:/var/lib/kin-emr"]:
        problem(problems, "prod-api-state-volume")


def check(root, declaration_path):
    problems = []
    try:
        declaration = json.loads(declaration_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        return ["declaration-unreadable: " + type(error).__name__]
    if not isinstance(declaration, dict) or set(declaration) != DECLARATION_KEYS:
        return ["declaration-keys: " + ",".join(sorted(set(declaration) ^ DECLARATION_KEYS if isinstance(declaration, dict) else DECLARATION_KEYS))]
    owned = declaration["owned_paths"]
    paths = [path for group in owned.values() for path in group]
    if len(paths) != len(set(paths)):
        problem(problems, "owned-path-duplicated", ",".join(sorted({p for p in paths if paths.count(p) > 1})))
    for path in paths:
        if not (root / path).is_file():
            problem(problems, "owned-path-missing", path)
    migrations = sorted(p.parent.name for p in (root / "api/prisma/migrations").glob("*/migration.sql"))
    spec = declaration["migrations"]
    if len(migrations) != spec["count"]:
        problem(problems, "migration-count", "%d != %d" % (len(migrations), spec["count"]))
    for name in spec["added"]:
        if name not in migrations:
            problem(problems, "migration-missing", name)
    if migrations and migrations[-1] != spec["added"][-1]:
        problem(problems, "migration-not-last", migrations[-1])
    # Every ledger table the declared migration creates is declared and classified, and nothing declared is absent.
    tables = sorted(declaration["deployment"]["tables"])
    try:
        sql = "\n".join((root / "api/prisma/migrations" / name / "migration.sql").read_text(encoding="utf-8") for name in spec["added"])
        created = sorted(set(re.findall(r"^\s*CREATE TABLE (?:IF NOT EXISTS )?emr_access\.(\w+)", sql, re.M)))
    except OSError:
        created = None
    if created != tables:
        problem(problems, "catalog-tables-differ", json.dumps({"created": created, "declared": tables}))
    classified = sorted(name.removeprefix("emr_access.") for name in declaration["models"]["sql"])
    if classified != tables:
        problem(problems, "table-unclassified", json.dumps({"classified": classified, "declared": tables}))
    for path in ("tests/production_image_test.py", "tests/ops_product_transfer_fixture.py"):
        text = (root / path).read_text(encoding="utf-8")
        for name in spec["added"]:
            if name not in text:
                problem(problems, "migration-consumer-stale", path)
    live = declared_cases(root, declaration, "live")
    expected_live = [case.split(" ", 1)[0] for case in declaration["cases"]["live"][declaration["round"]]]
    if live != expected_live:
        problem(problems, "live-cases-differ", json.dumps({"collected": live, "declared": expected_live}))
    sys.path.insert(0, str(root / "tests"))
    try:
        import measurement_ci  # noqa: E402
        import candidate_ci  # noqa: E402
    except Exception as error:  # an unreadable consumer is a failed check, never a pass
        problem(problems, "ci-consumer-unreadable", type(error).__name__)
    else:
        profile = measurement_ci.PROFILES.get("emr-b")
        live_spec = declaration["cases"]["live"]
        if not profile or [tuple(s) for s in profile["suites"]] != [tuple(s) for s in live_spec["profile_suites"]]:
            problem(problems, "profile-differs")
        if len(measurement_ci.PROFILES) != declaration["expected"]["profiles"]:
            problem(problems, "profile-count", str(len(measurement_ci.PROFILES)))
        selected = {(row[0], row[1] + "." + row[2]) for row in candidate_ci.FLOWS}
        for item in declaration["candidate_cases"]:
            if (item["file"].removeprefix("tests/"), item["case"]) not in selected:
                problem(problems, "candidate-case-missing", item["case"])
        flows = [row for row in candidate_ci.FLOWS if row[0].startswith("emr/b/")]
        if len(flows) != len(declaration["candidate_cases"]):
            problem(problems, "candidate-cases-differ")
    try:
        compose_shape(root, problems)
    except Exception as error:
        problem(problems, "compose-unreadable", type(error).__name__)
    return problems


def run_cases(declaration, which):
    return [case.split(" ", 1)[0] for case in declaration["cases"][which][declaration["round"]]]


def check_run(run_dir, kind, cases):
    """record-run.py evidence: both exits zero, and exactly the declared cases reported passed once each."""
    problems = []
    try:
        record = json.loads((run_dir / "run.json").read_text(encoding="utf-8"))
        stdout = (run_dir / "stdout.log").read_text(encoding="utf-8", errors="replace")
        stderr = (run_dir / "stderr.log").read_text(encoding="utf-8", errors="replace")
    except (OSError, ValueError) as error:
        return ["evidence-unreadable: " + type(error).__name__]
    if record.get("status") != "completed" or record.get("exit_code") != 0 or record.get("recorder_exit_code") != 0:
        problem(problems, "exit-not-zero", "%s/%s" % (record.get("exit_code"), record.get("recorder_exit_code")))
    text = stdout + "\n" + stderr
    if kind == "node":
        passed = re.findall(r"^\s*ok \d+ - (.+?)\s*$", text, re.M)
        failed = re.findall(r"^\s*not ok \d+ - (.+?)\s*$", text, re.M)
        skipped = re.findall(r"^\s*ok \d+ - .+ # (?:SKIP|TODO)", text, re.M)
        names = [re.split(r"[ :]", name, maxsplit=1)[0] for name in passed]
    else:
        # unittest verbosity 2: "name (module.Class.name)", then the docstring's first line when there is one, then
        # " ... ok"; every failure or error (also of a subtest or a class fixture) has its own "FAIL: " / "ERROR: " header.
        passed = re.findall(r"^(test_\w+) \([\w.]+\)(?:\n(?!test_)[^\n]*?)? \.\.\. ok$", text, re.M)
        failed = re.findall(r"^(?:FAIL|ERROR): (\w+) \(", text, re.M)
        skipped = re.findall(r"^(test_\w+) \([\w.]+\)(?:\n(?!test_)[^\n]*?)? \.\.\. skipped", text, re.M)
        names = passed
    if failed or skipped:
        problem(problems, "cases-not-passed", ",".join(failed + skipped))
    for case in cases:
        if names.count(case) != 1:
            problem(problems, "case-not-passed-once", case)
    extra = sorted(set(names) - set(cases))
    if extra:
        problem(problems, "undeclared-cases", ",".join(extra))
    return problems


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    sql = sub.add_parser("sql")
    sql.add_argument("what", choices=["provision"])
    chk = sub.add_parser("check")
    chk.add_argument("--declaration", type=Path, default=DECLARATION)
    chk.add_argument("--root", type=Path, default=ROOT)
    chk.add_argument("--json", action="store_true")
    run = sub.add_parser("check-run")
    run.add_argument("--declaration", type=Path, default=DECLARATION)
    run.add_argument("--kind", choices=["node", "unittest"], required=True)
    run.add_argument("--cases-from", choices=["contract", "live"], required=True)
    run.add_argument("--run-dir", type=Path, required=True)
    args = parser.parse_args(argv)
    if args.command == "sql":
        sys.stdout.write(PROVISION_SQL)
        return 0
    if args.command == "check":
        problems = check(args.root.resolve(), args.declaration)
    else:
        try:
            declaration = json.loads(args.declaration.read_text(encoding="utf-8"))
            cases = run_cases(declaration, args.cases_from)
        except (OSError, ValueError, KeyError, TypeError) as error:
            problems = ["declaration-unreadable: " + type(error).__name__]
        else:
            problems = check_run(args.run_dir, args.kind, cases)
    print(json.dumps({"ok": not problems, "problems": problems}, indent=None if getattr(args, "json", False) else 1))
    return 0 if not problems else 1


if __name__ == "__main__":
    sys.exit(main())
