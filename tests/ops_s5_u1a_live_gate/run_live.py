# coding: utf-8
"""S5-U1a G2: run tests/clinician_policy_live.py once from an immutable candidate checkout.

Hosted CI only. The candidate is checked out on its own (candidate_ci.hosted_target proves the exact SHA,
a clean tree and a separate tools checkout), and the candidate's own measurement_ci.main brings up its
disposable synthetic Compose stack with generated secrets, exactly as the candidate workflow does. This
file only adds one profile holding one suite, so the single live command is

    python scripts/run-tests.py --module tests/clinician_policy_live.py --mode live --unit s5-u1a-clinician-live --timeout 900

and refuses to launch anything else. The candidate SHA is never changed.
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
from summarize import CASES, MODULE, TIMEOUT, UNIT  # noqa: E402

PROFILE = UNIT
SUITE = (MODULE.removeprefix("tests/"), None, UNIT)
CANDIDATE_FILE = re.compile(rb"([0-9a-f]{40})\r?\n")
# Hashed into provenance so the evidence names the exact bytes the stack and the module ran from.
SOURCES = (
    "tests/clinician_policy_live.py", "tests/clinician_policy_fixtures.json", "tests/invariants_live.py",
    "tests/live_test_gate.py", "tests/measurement_ci.py", "scripts/run-tests.py",
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
    return sys.modules.get("u1a_candidate_ci") or load(TOOLS_ROOT / "tests/candidate_ci.py", "u1a_candidate_ci")


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


def exact_plan(runner):
    plan = runner.module_plan(MODULE, UNIT, "live", TIMEOUT)
    require([row["file"] for row in plan["tests"]] == [MODULE] * len(CASES)
            and [row["case"] for row in plan["tests"]] == list(CASES),
            "The candidate module must select exactly the four declared clinician cases")
    return plan["tests"]


def configure(ci, target, record):
    require(PROFILE not in ci.PROFILES, "The candidate already declares a profile with this name")
    out = target / "tests/e2e/artifacts" / (PROFILE + "-ci")
    ci.PROFILES[PROFILE] = {"out": out, "project_prefix": "kin-s5u1a-ci-", "suite_timeout": TIMEOUT,
                            "suites": (SUITE,)}
    original = ci.guarded_profile_run
    expected = [sys.executable, str(target / "scripts/run-tests.py"), "--module", MODULE, "--mode", "live",
                "--unit", UNIT, "--timeout", str(TIMEOUT)]

    def guarded(profile, suite, class_name, unit, remaining):
        require(record.get("launched_command") is None, "The clinician live module runs once per workflow run")
        command, outer = original(profile, suite, class_name, unit, remaining)
        # A slow stack setup would shrink --timeout below 900; refuse instead of running a different command.
        require(command == expected, "Refusing a changed live command; %d s remained after stack setup" % int(remaining))
        record["launched_command"] = command
        return command, outer

    ci.guarded_profile_run = guarded
    return ci.PROFILES[PROFILE]


def retain_ledger(state, destination):
    # The unit ledger shows how many attempts this runner made; lock files carry nothing.
    state, destination = Path(state), Path(destination)
    if not state.is_dir():
        return []
    copied = []
    for path in sorted(state.iterdir()):
        if path.is_file() and (path.name.startswith(UNIT) or path.name == "live-needs-inspection.json") \
                and not path.name.endswith(".lock"):
            destination.mkdir(exist_ok=True)
            shutil.copyfile(path, destination / path.name)
            copied.append(path.name)
    return copied


def run(target, candidate_sha, evidence, record):
    tools = candidate_ci()
    candidate_sha = tools.valid_sha(candidate_sha)
    evidence = Path(evidence).resolve()
    require(evidence.is_dir() and not any(evidence.iterdir()), "Evidence directory must exist and be empty")
    target, tools_sha = tools.hosted_target(target, candidate_sha)
    sys.path.insert(0, str(target / "tests"))
    runner = tools.load(target / "scripts/run-tests.py", "u1a_run_tests")
    ci = tools.load(target / "tests/measurement_ci.py", "u1a_measurement_ci")
    plan = exact_plan(runner)
    configure(ci, target, record)
    write_json(evidence / "provenance.json", {
        "schema": 1, "requirement": "REQ-S5-U1a-ROLE-DEFAULT-DENY", "test": "TEST-S5-U1a-CLINICIAN-LIVE",
        "unit": UNIT, "profile": PROFILE, "timeout_seconds": TIMEOUT,
        "candidate_sha": candidate_sha, "checked_out_sha": tools.git(target, "rev-parse", "HEAD"),
        "tools_sha": tools_sha, "plan": plan,
        "source_sha256": {name: hashlib.sha256((target / name).read_bytes()).hexdigest() for name in SOURCES},
        "synthetic_only": True, "github_hosted": True})
    try:
        ci.main(PROFILE)
    finally:
        # Never let a copy failure replace the stack's own exception.
        try:
            record["ledger_files"] = retain_ledger(runner.gate.STATE, evidence / "test-gate")
        except OSError as error:
            record["ledger_error"] = str(error)


def run_recorded(target, candidate_sha, evidence):
    record = {"schema": 1, "exit": None, "launched_command": None, "error": None, "ledger_files": []}
    try:
        run(target, candidate_sha, evidence, record)
        record["exit"] = 0
    except Exception as error:
        traceback.print_exc()
        # 125: refused before the live command; 1: the command or the stack around it failed.
        record["exit"] = 125 if record["launched_command"] is None else 1
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
    resolved.add_argument("--candidate-file", type=Path, default=HERE / "candidate.txt")
    started = commands.add_parser("run")
    started.add_argument("--target", required=True, type=Path)
    started.add_argument("--candidate-sha", required=True)
    started.add_argument("--evidence", required=True, type=Path)
    args = parser.parse_args(argv)
    if args.command == "run":
        return run_recorded(args.target, args.candidate_sha, args.evidence)
    try:
        print(resolve_candidate(args.event_name, args.input_sha, args.candidate_file))
        return 0
    except (RuntimeError, OSError) as error:
        print("U1A_LIVE_REFUSED: " + str(error), file=sys.stderr)
        return 125


if __name__ == "__main__":
    sys.exit(main())
