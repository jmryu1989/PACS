# coding: utf-8
"""S5 hosted live gate: run a declared list of live modules, each once, from an immutable candidate checkout.

Hosted CI only. The candidate is checked out on its own (candidate_ci.hosted_target proves the exact SHA,
a clean tree and a separate tools checkout), and the candidate's own measurement_ci.main brings up one
disposable synthetic Compose stack with generated secrets, exactly as the candidate workflow does. This
file only adds one profile holding the listed suites, in order, so each live command is

    python scripts/run-tests.py --module <module> --mode live --unit <unit> --timeout <timeout>

with the values of its modules.json entry, and anything else is refused. The candidate SHA is never changed.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import sys
import traceback

HERE = Path(__file__).resolve().parent
TOOLS_ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
from summarize import MARGIN, PROFILE, parse_modules  # noqa: E402

CANDIDATE_FILE = re.compile(rb"([0-9a-f]{40})\r?\n")
# Hashed into provenance, with every listed module, so the evidence names the exact bytes the stack ran from.
SOURCES = (
    "tests/clinician_policy_fixtures.json", "tests/invariants_live.py", "tests/live_test_gate.py",
    "tests/measurement_ci.py", "scripts/run-tests.py",
    "api/src/clinician-policy.ts", "api/src/auth.guard.ts", "api/src/keycloak.service.ts",
    "api/src/admin.service.ts", "keycloak/kin-realm.json", "docker-compose.yml",
)


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    require(spec is not None and spec.loader is not None, "Cannot load " + str(path))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def candidate_ci():
    # Reuse the reviewed immutable-candidate checks rather than a second copy of them.
    return sys.modules.get("s5_live_candidate_ci") or load(TOOLS_ROOT / "tests/candidate_ci.py", "s5_live_candidate_ci")


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")


def resolve_candidate(event_name, input_sha, candidate_file):
    if event_name == "push":
        match = CANDIDATE_FILE.fullmatch(Path(candidate_file).read_bytes())
        require(match is not None, "candidate.txt must hold one full lowercase SHA and a line end")
        return match.group(1).decode("ascii")
    if event_name == "workflow_dispatch":
        return candidate_ci().valid_sha(input_sha)
    raise RuntimeError("Only a push to the gate branch or workflow_dispatch may run this gate")


def resolve_modules(event_name, input_modules, modules_file):
    """The bytes the run uses: the committed list, or on dispatch a non-empty override, both validated."""
    if input_modules.strip():
        require(event_name == "workflow_dispatch", "Only workflow_dispatch may override modules.json")
        return (json.dumps(parse_modules(input_modules), indent=2, ensure_ascii=True) + "\n").encode("utf-8")
    raw = Path(modules_file).read_bytes()
    parse_modules(raw)
    return raw


def suites(modules):
    return tuple((entry["module"].removeprefix("tests/"), None, entry["unit"]) for entry in modules)


def exact_plan(runner, entry):
    plan = runner.module_plan(entry["module"], entry["unit"], "live", entry["timeout"])
    require([row["file"] for row in plan["tests"]] == [entry["module"]] * len(entry["cases"])
            and [row["case"] for row in plan["tests"]] == list(entry["cases"]),
            entry["module"] + " must select exactly its declared cases, in order")
    return plan["tests"]


def configure(ci, target, modules, record):
    require(PROFILE not in ci.PROFILES, "The candidate already declares a profile with this name")
    out = target / "tests/e2e/artifacts" / (PROFILE + "-ci")
    declared = suites(modules)
    # suite_budgets caps each unit at its own timeout; the profile maximum is never the one that applies.
    ci.PROFILES[PROFILE] = {"out": out, "project_prefix": "kin-s5live-ci-",
                            "suite_timeout": max(entry["timeout"] for entry in modules),
                            "suite_budgets": {entry["unit"]: entry["timeout"] for entry in modules},
                            "suites": declared}
    original = ci.guarded_profile_run
    expected = [[sys.executable, str(target / "scripts/run-tests.py"), "--module", entry["module"], "--mode", "live",
                 "--unit", entry["unit"], "--timeout", str(entry["timeout"])] for entry in modules]

    def guarded(profile, suite, class_name, unit, remaining):
        index = len(record["launched_commands"])
        require(index < len(declared) and (suite, class_name, unit) == declared[index],
                "Each listed module runs once, in the listed order")
        command, outer = original(profile, suite, class_name, unit, remaining)
        # A slow stack or an earlier module would shrink --timeout; refuse instead of running a different command.
        require(command == expected[index] and outer == modules[index]["timeout"] + MARGIN,
                "Refusing a changed live command; %d s remained before %s" % (int(remaining), unit))
        record["launched_commands"].append(command)
        return command, outer

    ci.guarded_profile_run = guarded
    return ci.PROFILES[PROFILE]


def retain_ledger(state, destination, units):
    # The unit ledgers show how many attempts this runner made; lock files carry nothing.
    state, destination = Path(state), Path(destination)
    if not state.is_dir():
        return []
    copied = []
    for path in sorted(state.iterdir()):
        if path.is_file() and (any(path.name.startswith(unit) for unit in units)
                               or path.name == "live-needs-inspection.json") and not path.name.endswith(".lock"):
            destination.mkdir(exist_ok=True)
            shutil.copyfile(path, destination / path.name)
            copied.append(path.name)
    return copied


def run(target, candidate_sha, modules_path, evidence, record):
    tools = candidate_ci()
    candidate_sha = tools.valid_sha(candidate_sha)
    evidence = Path(evidence).resolve()
    require(evidence.is_dir() and not any(evidence.iterdir()), "Evidence directory must exist and be empty")
    raw = Path(modules_path).read_bytes()
    modules = parse_modules(raw)
    record["units"] = [entry["unit"] for entry in modules]
    target, tools_sha = tools.hosted_target(target, candidate_sha)
    sys.path.insert(0, str(target / "tests"))
    runner = tools.load(target / "scripts/run-tests.py", "s5_live_run_tests")
    ci = tools.load(target / "tests/measurement_ci.py", "s5_live_measurement_ci")
    plans = {entry["unit"]: exact_plan(runner, entry) for entry in modules}
    configure(ci, target, modules, record)
    sources = list(dict.fromkeys([entry["module"] for entry in modules] + list(SOURCES)))
    write_json(evidence / "provenance.json", {
        "schema": 2, "profile": PROFILE,
        "candidate_sha": candidate_sha, "checked_out_sha": tools.git(target, "rev-parse", "HEAD"),
        "tools_sha": tools_sha, "modules_sha256": hashlib.sha256(raw).hexdigest(), "modules": modules,
        "plans": plans,
        "source_sha256": {name: hashlib.sha256((target / name).read_bytes()).hexdigest() for name in sources},
        "synthetic_only": True, "github_hosted": True})
    try:
        ci.main(PROFILE)
    finally:
        # Never let a copy failure replace the stack's own exception.
        try:
            record["ledger_files"] = retain_ledger(runner.gate.STATE, evidence / "test-gate", record["units"])
        except OSError as error:
            record["ledger_error"] = str(error)


def run_recorded(target, candidate_sha, modules_path, evidence):
    record = {"schema": 2, "exit": None, "units": [], "launched_commands": [], "error": None, "ledger_files": []}
    try:
        run(target, candidate_sha, modules_path, evidence, record)
        record["exit"] = 0
    except Exception as error:
        traceback.print_exc()
        # 125: refused before any live command; 1: a command or the stack around it failed.
        record["exit"] = 125 if not record["launched_commands"] else 1
        record["error"] = (type(error).__name__ + ": " + str(error))[:2000]
    finally:
        # A cancelled step (KeyboardInterrupt) still leaves this record, with exit null.
        if Path(evidence).is_dir():
            write_json(Path(evidence) / "driver.json", record)
    return record["exit"]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    resolved = commands.add_parser("resolve")
    resolved.add_argument("--event-name", required=True)
    resolved.add_argument("--input-sha", default="")
    resolved.add_argument("--input-modules", default="")
    resolved.add_argument("--candidate-file", type=Path, default=HERE / "candidate.txt")
    resolved.add_argument("--modules-file", type=Path, default=HERE / "modules.json")
    resolved.add_argument("--modules-out", required=True, type=Path)
    started = commands.add_parser("run")
    started.add_argument("--target", required=True, type=Path)
    started.add_argument("--candidate-sha", required=True)
    started.add_argument("--modules", required=True, type=Path)
    started.add_argument("--evidence", required=True, type=Path)
    args = parser.parse_args(argv)
    if args.command == "run":
        return run_recorded(args.target, args.candidate_sha, args.modules, args.evidence)
    try:
        sha = resolve_candidate(args.event_name, args.input_sha, args.candidate_file)
        modules = resolve_modules(args.event_name, args.input_modules, args.modules_file)
        require(not args.modules_out.exists(), "The resolved module list must not exist yet")
        args.modules_out.write_bytes(modules)
        print(sha)
        return 0
    except (RuntimeError, OSError, ValueError) as error:
        print("S5_LIVE_REFUSED: " + str(error), file=sys.stderr)
        return 125


if __name__ == "__main__":
    sys.exit(main())
