# coding: utf-8
"""S5 hosted live gate: validate the module list and turn the recorded files into s5-live-summary.json.

Stdlib only; reads files, never Docker, the network or the stack. `write` records facts and exits 0
whenever the summary could be written. `check` is the convenience status: it exits 1 unless every
recorded check of every listed module held. Acceptance is decided from the uploaded evidence, not from
that colour.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import sys

PROFILE = "s5-live-gate"
# measurement_ci.main's single deadline covers the stack and every suite; guarded_suite_command keeps a
# 35 s margin per suite. The reserve is the smallest stack share an existing multi-suite profile keeps
# (the MPR profiles' 175 s), so a declared worst case that does not fit is refused before any run.
DEADLINE = 25 * 60
MARGIN = 35
STACK_RESERVE = 175
MAX_TIMEOUT = 900
MAX_MODULES = 4
# API-only modules at the top of tests/: the job installs no browser, only the seed's numpy/pydicom.
MODULE_PATH = re.compile(r"tests/[a-z][a-z0-9_]*_live\.py")
UNIT_NAME = re.compile(r"[a-z0-9][a-z0-9-]{0,79}")  # run-tests.py validate_plan
CASE_NAME = re.compile(r"[A-Za-z_]\w*\.test_\w+")
LOGICAL = re.compile(r"[a-z0-9_-]+")
MODULE_KEYS = {"module", "unit", "timeout", "cases", "expected"}
EXPECTED_KEYS = {"sweep", "audit_rows"}

MARKER = "CLINICIAN_LIVE_SWEEP "
CLEANUP = "OWNED TEST AUDIT CLEANUP "
PLAN = "PLAN_RESULT "
EXACT = "EXACT_TESTS "
RAN = re.compile(r"Ran (\d+) tests? in [0-9.]+s")
RESULT = re.compile(r"(OK|FAILED)(?: \(.*\))?")
# LiveStack's temporary identities; the actor is the token email. The logical name must match exactly so
# the mixed clinician-radiologist/-technician/-admin identities are never counted as the clinician.
OWNED_ACTOR = re.compile(r"kin-test-[0-9a-f]{12}-([a-z0-9_-]+)@local\.test")


def step_name(module):
    # measurement_ci.main names the suite's sanitized log and its results.json row after the module stem.
    return PurePosixPath(module).stem


def _unique_object(pairs):
    keys = [key for key, _ in pairs]
    if len(keys) != len(set(keys)):
        raise ValueError("duplicate key in the module list")
    return dict(pairs)


def _count(value):
    return type(value) is int and value >= 0


def validate_modules(value):
    """Return the list unchanged when every entry is exact; raise ValueError naming the first defect."""
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_MODULES:
        raise ValueError("the module list must hold 1..%d entries" % MAX_MODULES)
    for index, entry in enumerate(value):
        where = "module %d: " % index
        if not isinstance(entry, dict) or set(entry) != MODULE_KEYS:
            raise ValueError(where + "keys must be exactly " + ", ".join(sorted(MODULE_KEYS)))
        if not isinstance(entry["module"], str) or not MODULE_PATH.fullmatch(entry["module"]):
            raise ValueError(where + "module must be tests/<name>_live.py")
        if not isinstance(entry["unit"], str) or not UNIT_NAME.fullmatch(entry["unit"]):
            raise ValueError(where + "invalid unit")
        if type(entry["timeout"]) is not int or not 1 <= entry["timeout"] <= MAX_TIMEOUT:
            raise ValueError(where + "timeout must be an integer 1..%d" % MAX_TIMEOUT)
        cases = entry["cases"]
        if (not isinstance(cases, list) or not 1 <= len(cases) <= 50 or len(set(map(str, cases))) != len(cases)
                or not all(isinstance(case, str) and CASE_NAME.fullmatch(case) for case in cases)):
            raise ValueError(where + "cases must be 1..50 distinct Class.test_name entries")
        expected = entry["expected"]
        if not isinstance(expected, dict) or set(expected) != EXPECTED_KEYS:
            raise ValueError(where + "expected keys must be exactly audit_rows, sweep")
        sweep = expected["sweep"]
        if sweep is not None and (not isinstance(sweep, dict) or set(sweep) != {"routes", "denied"}
                                  or not all(_count(sweep[key]) for key in sweep)):
            raise ValueError(where + "expected.sweep must be null or {routes, denied} counts")
        audit = expected["audit_rows"]
        if not isinstance(audit, dict) or not all(LOGICAL.fullmatch(key) and _count(count)
                                                  for key, count in audit.items()):
            raise ValueError(where + "expected.audit_rows must map logical identities to counts")
    for field, label in ((lambda entry: step_name(entry["module"]), "module"), (lambda entry: entry["unit"], "unit")):
        names = [field(entry) for entry in value]
        if len(set(names)) != len(names):
            raise ValueError("each " + label + " may appear once")
    worst = sum(entry["timeout"] + MARGIN for entry in value)
    if worst > DEADLINE - STACK_RESERVE:
        raise ValueError("declared worst case %d s exceeds the %d s left after the %d s stack reserve"
                         % (worst, DEADLINE - STACK_RESERVE, STACK_RESERVE))
    return value


def parse_modules(data):
    """Parse and validate module-list bytes or text; ValueError on any defect."""
    if isinstance(data, bytes):
        data = data.decode("utf-8")
    return validate_modules(json.loads(data, object_pairs_hook=_unique_object))


def parse_suite_log(text):
    facts = {"exact_tests": None, "markers": [], "plan_results": [], "cleanup_rows": [],
             "cleanup_unparsed": 0, "tests_ran": None, "unittest_result": None}
    lines = [line.rstrip() for line in text.splitlines()]
    for line in lines:
        if line.startswith(EXACT):
            try:
                facts["exact_tests"] = json.loads(line[len(EXACT):])
            except ValueError:
                facts["exact_tests"] = None
        elif line.startswith(MARKER):
            facts["markers"].append(line)
        elif line.startswith(PLAN):
            try:
                facts["plan_results"].append(json.loads(line[len(PLAN):]))
            except ValueError:
                facts["plan_results"].append(None)
        elif line.startswith(CLEANUP):
            # One line per owned actor that still had rows: a JSON list of to_jsonb(AuditLog) texts.
            try:
                rows = [json.loads(item) for item in json.loads(line[len(CLEANUP):])]
                if not all(isinstance(row, dict) for row in rows):
                    raise ValueError("row is not an object")
                facts["cleanup_rows"].extend(rows)
            except (TypeError, ValueError):
                facts["cleanup_unparsed"] += 1
    ran = [index for index, line in enumerate(lines) if RAN.fullmatch(line)]
    if ran:
        facts["tests_ran"] = int(RAN.fullmatch(lines[ran[-1]]).group(1))
        following = [line for line in lines[ran[-1] + 1:] if line.strip()]
        if following and RESULT.fullmatch(following[0]):
            facts["unittest_result"] = following[0]
    return facts


def audit_by_logical(rows):
    counts = {}
    for row in rows:
        actor = row.get("actor")
        match = OWNED_ACTOR.fullmatch(actor) if isinstance(actor, str) else None
        logical = match.group(1) if match else "(not an owned test actor)"
        counts[logical] = counts.get(logical, 0) + 1
    return dict(sorted(counts.items()))


def load_json(path, label, problems):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        problems.append(label + " missing")
    except (OSError, ValueError) as error:
        problems.append(label + " unreadable: " + str(error))
    return None


def module_summary(entry, index, out_dir, evidence_dir, steps, launched_commands, problems):
    unit, module, step = entry["unit"], entry["module"], step_name(entry["module"])
    expected, cases = entry["expected"], entry["cases"]
    rows = [row for row in steps if row.get("name") == step]
    ran = len(rows) == 1
    local = []
    if ran:
        ledger = load_json(evidence_dir / "test-gate" / (unit + ".json"), unit + " run-tests ledger", local) or {}
        try:
            log = (out_dir / (step + ".log")).read_text(encoding="utf-8")
        except FileNotFoundError:
            local.append(step + ".log missing")
            log = ""
        except OSError as error:
            local.append(step + ".log unreadable: " + str(error))
            log = ""
    else:
        ledger, log = {}, ""
    facts = parse_suite_log(log)
    exit_code = rows[0].get("exit") if ran else None
    plan_result = facts["plan_results"][0] if len(facts["plan_results"]) == 1 else None

    sweep = None
    if len(facts["markers"]) == 1:
        try:
            sweep = json.loads(facts["markers"][0][len(MARKER):])
        except ValueError:
            sweep = None
    sweep = sweep if isinstance(sweep, dict) else {}
    routes, denied = sweep.get("routes"), sweep.get("denied")
    routes = routes if type(routes) is int else None
    denied = denied if type(denied) is int else None
    # The policy module prints its marker only after asserting count(*) = 0 for the clinician actor.
    audit_in_test = 0 if expected["sweep"] is not None and len(facts["markers"]) == 1 else None
    # Class cleanup archives every owned actor's rows to the log before deleting them. Only a clean
    # unittest result proves that cleanup ran to the end, so only then is an absent line a zero.
    by_logical = audit_by_logical(facts["cleanup_rows"])
    cleanup_proven = facts["unittest_result"] == "OK" and facts["cleanup_unparsed"] == 0
    audit_rows = {key: by_logical.get(key, 0) for key in expected["audit_rows"]} if cleanup_proven else None

    attempts = ledger.get("attempts") if isinstance(ledger.get("attempts"), list) else None
    launched = launched_commands[index] if index < len(launched_commands) else None
    exact_tail = ["--module", module, "--mode", "live", "--unit", unit, "--timeout", str(entry["timeout"])]
    checks = {
        "launched_exact_command": isinstance(launched, list) and len(launched) == 10
            and isinstance(launched[1], str) and launched[1].endswith("/scripts/run-tests.py")
            and launched[2:] == exact_tail,
        "run_tests_exit_zero": exit_code == 0,
        "plan_passed": isinstance(plan_result, dict) and plan_result.get("status") == "passed"
            and plan_result.get("exit_code") == 0,
        "single_attempt": attempts is not None and len(attempts) == 1
            and isinstance(attempts[0], dict) and attempts[0].get("status") == "passed",
        "exact_cases": facts["exact_tests"] == [step + "." + case for case in cases],
        "unittest_ok": facts["tests_ran"] == len(cases) and facts["unittest_result"] == "OK",
    }
    if expected["sweep"] is None:
        checks["no_sweep_marker"] = not facts["markers"]
    else:
        checks["single_marker"] = len(facts["markers"]) == 1 and routes is not None and denied is not None
        checks["routes_expected"] = routes == expected["sweep"]["routes"]
        checks["denied_expected"] = denied == expected["sweep"]["denied"]
    checks["audit_rows_expected"] = audit_rows == expected["audit_rows"] \
        and (expected["sweep"] is None or audit_in_test == 0)
    local.extend("check failed: " + name for name, held in checks.items() if not held)
    if facts["cleanup_unparsed"]:
        local.append("unparsed audit cleanup lines: " + str(facts["cleanup_unparsed"]))
    problems.extend(unit + ": " + problem for problem in local)
    return {
        "module": module,
        "unit": unit,
        "timeout": entry["timeout"],
        "status": "not_run" if not ran else "passed" if all(checks.values()) else "failed",
        "exit": exit_code,
        "launched_command": launched,
        "plan_result": plan_result,
        "attempts": len(attempts) if attempts is not None else None,
        "exact_tests": facts["exact_tests"],
        "tests_ran": facts["tests_ran"],
        "unittest_result": facts["unittest_result"],
        "marker": facts["markers"][0] if len(facts["markers"]) == 1 else None,
        "marker_lines": len(facts["markers"]),
        "routes": routes,
        "denied": denied,
        "audit_rows": audit_rows,
        "audit_rows_source": "listed identities' rows in the OWNED TEST AUDIT CLEANUP archive; null unless unittest OK",
        "audit_rows_in_test": audit_in_test,
        "audit_archive_by_logical": by_logical,
        "expected": expected,
        "checks": checks,
        "matches_expected": all(checks.values()),
    }


def build_summary(out_dir, evidence_dir, modules_path, candidate_sha, run_id, run_attempt):
    out_dir, evidence_dir, modules_path = Path(out_dir), Path(evidence_dir), Path(modules_path)
    problems = []
    try:
        raw = modules_path.read_bytes()
        modules_sha256 = hashlib.sha256(raw).hexdigest()
        modules = parse_modules(raw)
    except (OSError, ValueError) as error:
        problems.append("module list unusable: " + str(error))
        modules_sha256, modules = None, []
    provenance = load_json(evidence_dir / "provenance.json", "provenance.json", problems) or {}
    driver = load_json(evidence_dir / "driver.json", "driver.json", problems) or {}
    results = load_json(out_dir / "results.json", "results.json", problems)
    steps = [row for row in results if isinstance(row, dict)] if isinstance(results, list) else []
    launched = driver.get("launched_commands")
    launched = launched if isinstance(launched, list) else []

    summaries = [module_summary(entry, index, out_dir, evidence_dir, steps, launched, problems)
                 for index, entry in enumerate(modules)]
    checks = {
        "modules_valid": bool(modules),
        "modules_match_provenance": modules_sha256 is not None and provenance.get("modules_sha256") == modules_sha256,
        "candidate_checked_out": bool(candidate_sha) and provenance.get("candidate_sha") == candidate_sha
            and provenance.get("checked_out_sha") == candidate_sha,
        "driver_exit_zero": driver.get("exit") == 0,
        "each_module_launched_once": bool(modules) and len(launched) == len(modules),
        "every_module_matches": bool(summaries) and all(item["matches_expected"] for item in summaries),
    }
    problems.extend("check failed: " + name for name, held in checks.items() if not held)
    return {
        "schema": 2,
        "gate": "S5 clinician live gate",
        "profile": PROFILE,
        "candidate_sha": candidate_sha,
        "checked_out_sha": provenance.get("checked_out_sha"),
        "tools_sha": provenance.get("tools_sha"),
        "run_id": run_id,
        "run_attempt": run_attempt,
        "modules_sha256": modules_sha256,
        "driver_exit": driver.get("exit"),
        "driver_error": driver.get("error"),
        "modules": summaries,
        "steps": steps,
        "checks": checks,
        "matches_expected": all(checks.values()),
        "problems": problems,
    }


def write(args):
    summary = build_summary(args.out_dir, args.evidence, args.modules, args.candidate_sha, args.run_id,
                            args.run_attempt)
    output = Path(args.output)
    output.write_text(json.dumps(summary, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    print(json.dumps({"candidate_sha": summary["candidate_sha"], "matches_expected": summary["matches_expected"],
                      "modules": [{key: item[key] for key in ("unit", "status", "exit", "tests_ran", "routes",
                                                              "denied", "audit_rows")}
                                  for item in summary["modules"]]}, ensure_ascii=True))
    return 0


def check(args):
    summary = json.loads(Path(args.summary).read_text(encoding="utf-8"))
    print("### S5 clinician live gate (synthetic, hosted)")
    print("")
    for key in ("candidate_sha", "run_id", "modules_sha256", "driver_exit", "matches_expected"):
        print("- {}: `{}`".format(key, summary.get(key)))
    for item in summary.get("modules") or []:
        print("")
        print("#### `{}` ({})".format(item.get("module"), item.get("unit")))
        for key in ("status", "exit", "unittest_result", "tests_ran", "attempts", "marker", "routes", "denied",
                    "audit_rows", "audit_rows_in_test", "matches_expected"):
            print("- {}: `{}`".format(key, item.get(key)))
    print("")
    for problem in summary.get("problems") or []:
        print("- problem: " + problem)
    print("")
    print("This colour is a convenience. Acceptance is decided from the uploaded evidence.")
    return 0 if summary.get("matches_expected") is True else 1


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    written = commands.add_parser("write")
    written.add_argument("--out-dir", required=True, type=Path)
    written.add_argument("--evidence", required=True, type=Path)
    written.add_argument("--modules", required=True, type=Path)
    written.add_argument("--candidate-sha", required=True)
    written.add_argument("--run-id", required=True)
    written.add_argument("--run-attempt", required=True)
    written.add_argument("--output", required=True, type=Path)
    checked = commands.add_parser("check")
    checked.add_argument("summary", type=Path)
    args = parser.parse_args(argv)
    try:
        return write(args) if args.command == "write" else check(args)
    except (OSError, ValueError) as error:
        print("S5_LIVE_SUMMARY_FAILED: " + str(error), file=sys.stderr)
        return 125


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
