#!/usr/bin/env python3
"""Run an explicit unittest plan with persistent attempts and a wall-clock bound.

Use record-run.py around this command to retain raw output/source hashes. Plans
select exact File/Class/test names, never implicit unittest discovery. This does
not cap Codex calls or remove the host account's Docker/credential access.
"""
import argparse
from contextlib import nullcontext
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import signal
import subprocess
import sys
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tests"))
import live_test_gate as gate


def read_plan(path):
    plan = json.loads(Path(path).read_text(encoding="utf-8"))
    return validate_plan(plan)


def validate_plan(plan):
    if not isinstance(plan, dict) or set(plan) != {"unit", "mode", "tests", "max_attempts", "timeout_seconds"}:
        raise gate.Refused("Plan requires unit, mode, tests, max_attempts, timeout_seconds only")
    if not isinstance(plan["unit"], str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,79}", plan["unit"]):
        raise gate.Refused("Invalid unit")
    if plan["mode"] not in ("pure", "live"):
        raise gate.Refused("Mode must be pure or live")
    for key, maximum in (("max_attempts", 3), ("timeout_seconds", 3600)):
        if type(plan[key]) is not int or not 1 <= plan[key] <= maximum:
            raise gate.Refused("Invalid " + key)
    if isinstance(plan["tests"], dict):
        selector = plan["tests"]
        if (set(selector) != {"module", "class"} or not isinstance(selector["module"], str)
                or selector["class"] is not None and (not isinstance(selector["class"], str)
                    or not re.fullmatch(r"[A-Za-z_]\w*", selector["class"]))):
            raise gate.Refused("Invalid module selector")
        path = (ROOT / selector["module"]).resolve()
        if ROOT / "tests" not in path.parents or path.suffix != ".py" or not path.is_file():
            raise gate.Refused("Module must be a test file in this repository")
        return plan
    if not isinstance(plan["tests"], list) or not 1 <= len(plan["tests"]) <= 200:
        raise gate.Refused("Select 1..200 exact tests")
    seen = set()
    for item in plan["tests"]:
        if not isinstance(item, dict) or set(item) != {"file", "case"}:
            raise gate.Refused("Each test requires file and case only")
        if not isinstance(item["file"], str) or not isinstance(item["case"], str):
            raise gate.Refused("File and case must be strings")
        path = (ROOT / item["file"]).resolve()
        if ROOT / "tests" not in path.parents or path.suffix != ".py" or not path.is_file():
            raise gate.Refused("Tests must be Python files inside this repository's tests directory")
        if not re.fullmatch(r"[A-Za-z_]\w*\.test\w*", item["case"]):
            raise gate.Refused("Select Class.test_method exactly")
        key = (str(path), item["case"])
        if key in seen:
            raise gate.Refused("Duplicate test")
        seen.add(key)
    return plan


def load_module(path):
    path = Path(path).resolve()
    name = path.stem
    previous = sys.modules.get(name)
    if previous:
        if Path(previous.__file__).resolve() != path:
            raise gate.Refused("Ambiguous test module: " + name)
        return previous
    sys.path.insert(0, str(path.parent))
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def collect(plan):
    selected = []
    # All imports and selection checks occur while LiveStack permission is off.
    for item in plan["tests"]:
        module = load_module(ROOT / item["file"])
        class_name, method = item["case"].split(".")
        cls = getattr(module, class_name, None)
        if not isinstance(cls, type) or not issubclass(cls, unittest.TestCase) or cls.__module__ != module.__name__:
            raise gate.Refused("Selected TestCase must be declared in " + item["file"])
        if method not in unittest.defaultTestLoader.getTestCaseNames(cls):
            raise gate.Refused("Unknown test: " + item["case"])
        selected.append(cls(method))
    return unittest.TestSuite(selected)


def worker(path):
    # The internal entry point cannot start an independent, unbudgeted run.
    ticket = sys.stdin.readline(1024).strip()
    plan = read_plan(path)
    ledger = json.loads((gate.STATE / (plan["unit"] + ".json")).read_text())
    claim = ledger["attempts"][-1]
    if (not ticket or claim["status"] != "running"
            or claim["ticket_sha256"] != hashlib.sha256(ticket.encode()).hexdigest()
            or claim["plan_sha256"] != hashlib.sha256(Path(path).read_bytes()).hexdigest()):
        raise gate.Refused("Worker requires its active parent attempt")
    if isinstance(plan["tests"], dict):
        selector = plan["tests"]
        selected = module_plan(selector["module"], plan["unit"], plan["mode"], plan["timeout_seconds"], selector["class"])
        plan["tests"] = selected["tests"]
        validate_plan(plan)
        with Path(path).with_suffix(".resolved.json").open("x", encoding="utf-8") as stream:
            json.dump(plan, stream)
    suite = collect(plan)
    print("EXACT_TESTS " + json.dumps([test.id() for test in suite]), flush=True)
    with gate.live_run() if plan["mode"] == "live" else nullcontext():
        result = unittest.TextTestRunner(verbosity=2).run(suite)
        # A failed live run retains the inspection marker, even if it appears
        # to have cleaned up. Do not retry against uncertain shared fixtures.
        if not result.wasSuccessful() or result.skipped:
            raise gate.Refused("Tests failed or skipped; this is not a completed plan")
    return 0


def write_json(path, value):
    temporary = path.with_suffix(".new")
    temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    os.replace(str(temporary), str(path))


def execute(path):
    plan = read_plan(path)
    gate.STATE.mkdir(parents=True, exist_ok=True)
    # Keep the unit stable across fixes and evidence directories. A different
    # plan is not an implicit permission to restart the same unit's budget.
    ledger_path = gate.STATE / (plan["unit"] + ".json")
    with gate.exclusive(gate.STATE / (plan["unit"] + ".lock")):
        if plan["mode"] == "live":
            gate.preflight_live()
        ledger = json.loads(ledger_path.read_text()) if ledger_path.exists() else {"attempts": [], "max_attempts": plan["max_attempts"]}
        if ledger["max_attempts"] != plan["max_attempts"]:
            raise gate.Refused("Cannot change an existing unit's attempt limit")
        if any(row["status"] in ("running", "passed", "interrupted") for row in ledger["attempts"]):
            raise gate.Refused("Unit already passed or needs inspection; automatic repetition is refused")
        if len(ledger["attempts"]) >= ledger["max_attempts"]:
            raise gate.Refused("Unit attempt budget exhausted")
        frozen = gate.STATE / (plan["unit"] + "-attempt-" + str(len(ledger["attempts"]) + 1) + ".json")
        if frozen.exists():
            raise gate.Refused("Unrecorded attempt file needs inspection: " + str(frozen))
        with frozen.open("x", encoding="utf-8") as stream:
            json.dump(plan, stream)
        ticket = secrets.token_hex(32)
        row = {"status": "running", "plan_sha256": hashlib.sha256(frozen.read_bytes()).hexdigest(), "started": time.time(),
               "ticket_sha256": hashlib.sha256(ticket.encode()).hexdigest()}
        ledger["attempts"].append(row)
        write_json(ledger_path, ledger)
        process = None
        try:
            process = subprocess.Popen([sys.executable, "-B", str(Path(__file__).resolve()), "--worker", str(frozen)], cwd=ROOT,
                                       stdin=subprocess.PIPE, start_new_session=os.name != "nt")
            process.stdin.write((ticket + "\n").encode())
            process.stdin.close()
            code = process.wait(timeout=plan["timeout_seconds"])
            row.update(status="passed" if code == 0 else "failed", exit_code=code)
        except (subprocess.TimeoutExpired, KeyboardInterrupt):
            row.update(status="interrupted", exit_code=124)
            if process is not None:
                if os.name == "nt":
                    # Only this owned PID and its descendants; no process-name
                    # matching and no shell command construction.
                    killed = subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True, timeout=30)
                    row["tree_termination_exit"] = killed.returncode
                else:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                process.wait(timeout=30)
        except OSError as error:
            row.update(status="interrupted", exit_code=125, error=str(error))
        finally:
            row["ended"] = time.time()
            write_json(ledger_path, ledger)
        print("PLAN_RESULT " + json.dumps(row), flush=True)
        return row["exit_code"]


def module_plan(filename, unit, mode, timeout, class_name=None):
    path = (ROOT / filename).resolve()
    if ROOT / "tests" not in path.parents or path.suffix != ".py":
        raise gate.Refused("Module must be a test file in this repository")
    module = load_module(path)
    if class_name:
        cls = getattr(module, class_name, None)
        if not isinstance(cls, type) or not issubclass(cls, unittest.TestCase) or cls.__module__ != module.__name__:
            raise gate.Refused("Selected class must be declared in this module")
        pending = [cls(name) for name in unittest.defaultTestLoader.getTestCaseNames(cls) if name in cls.__dict__]
    else:
        pending = [unittest.defaultTestLoader.loadTestsFromModule(module)]
    tests = []
    while pending:
        test = pending.pop(0)
        if isinstance(test, unittest.TestSuite):
            pending[0:0] = list(test)
        else:
            if type(test).__module__ != module.__name__:
                raise gate.Refused("Discovery included an imported TestCase; select explicit local tests")
            tests.append({"file": path.relative_to(ROOT).as_posix(), "case": type(test).__name__ + "." + test._testMethodName})
    return {"unit": unit, "mode": mode, "tests": tests, "max_attempts": 3, "timeout_seconds": timeout}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--plan")
    group.add_argument("--worker", help=argparse.SUPPRESS)
    group.add_argument("--module", help="Freeze this module's existing load_tests selection before executing")
    parser.add_argument("--unit")
    parser.add_argument("--class", dest="class_name", help="Select only test methods declared on this local class")
    parser.add_argument("--mode", choices=("pure", "live"), default="pure")
    parser.add_argument("--timeout", type=int, default=600)
    args = parser.parse_args()
    try:
        if args.module:
            if not args.unit or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,79}", args.unit):
                raise gate.Refused("Module execution requires a stable --unit")
            # Import/collection runs only in the budgeted child, so a hanging
            # import is subject to the same process-tree deadline as a test.
            plan = validate_plan({"unit": args.unit, "mode": args.mode,
                "tests": {"module": args.module, "class": args.class_name},
                "max_attempts": 3, "timeout_seconds": args.timeout})
            gate.STATE.mkdir(parents=True, exist_ok=True)
            path = gate.STATE / (args.unit + "-selected-" + secrets.token_hex(6) + ".json")
            with path.open("x", encoding="utf-8") as stream:
                json.dump(plan, stream)
            return execute(path)
        return worker(args.worker) if args.worker else execute(args.plan)
    except (gate.Refused, ValueError, OSError) as error:
        print("TEST_RUN_REFUSED: " + str(error), file=sys.stderr)
        return 125


if __name__ == "__main__":
    sys.exit(main())
