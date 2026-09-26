# coding: utf-8
"""S5-U1a G2: turn the recorded clinician live gate files into u1a-live-summary.json.

Stdlib only; reads files, never Docker, the network or the stack. `write` records facts and exits 0
whenever the summary could be written. `check` is the convenience status: it exits 1 unless every
recorded check held. Acceptance is decided from the uploaded evidence, not from that colour.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys

UNIT = "s5-u1a-clinician-live"
MODULE = "tests/clinician_policy_live.py"
TIMEOUT = 900
# measurement_ci.main names the suite's sanitized log and its results.json row after the module stem.
SUITE_STEP = "clinician_policy_live"
CASES = tuple("ClinicianPolicyLive." + name for name in (
    "test_01_clinician_only_session_routes_and_default_denial",
    "test_02_pending_and_invalid_clinician_keep_membership_codes_and_logout",
    "test_03_member_console_approves_updates_and_revokes_a_clinician",
    "test_04_mixed_and_legacy_roles_keep_their_existing_paths",
))
# The G2 expectation for candidate 88ce2df (S5-U1a): 108 declared routes, 6 of them public or
# clinician session routes, and no AuditLog row written by the clinician actor.
EXPECTED = {"routes": 108, "denied": 102, "audit_rows": 0}

MARKER = "CLINICIAN_LIVE_SWEEP "
CLEANUP = "OWNED TEST AUDIT CLEANUP "
PLAN = "PLAN_RESULT "
EXACT = "EXACT_TESTS "
RAN = re.compile(r"Ran (\d+) tests? in [0-9.]+s")
RESULT = re.compile(r"(OK|FAILED)(?: \(.*\))?")
# LiveStack's temporary identities; the actor is the token email. `clinician` must match exactly so the
# mixed clinician-radiologist/-technician/-admin identities are never counted as the clinician.
OWNED_ACTOR = re.compile(r"kin-test-[0-9a-f]{12}-([a-z0-9_-]+)@local\.test")


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


def build_summary(out_dir, evidence_dir, candidate_sha, run_id, run_attempt):
    out_dir, evidence_dir = Path(out_dir), Path(evidence_dir)
    problems = []
    provenance = load_json(evidence_dir / "provenance.json", "provenance.json", problems) or {}
    driver = load_json(evidence_dir / "driver.json", "driver.json", problems) or {}
    ledger = load_json(evidence_dir / "test-gate" / (UNIT + ".json"), "run-tests ledger", problems) or {}
    results = load_json(out_dir / "results.json", "results.json", problems)
    try:
        log = (out_dir / (SUITE_STEP + ".log")).read_text(encoding="utf-8")
    except FileNotFoundError:
        problems.append(SUITE_STEP + ".log missing")
        log = ""
    except OSError as error:
        problems.append(SUITE_STEP + ".log unreadable: " + str(error))
        log = ""
    facts = parse_suite_log(log)

    steps = results if isinstance(results, list) else []
    suite_rows = [row for row in steps if isinstance(row, dict) and row.get("name") == SUITE_STEP]
    exit_code = suite_rows[0].get("exit") if len(suite_rows) == 1 else None
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

    # The marker is printed only after test_01 asserted count(*) = 0 for the clinician actor.
    audit_in_test = 0 if len(facts["markers"]) == 1 else None
    # Class cleanup archives every owned actor's rows to the log before deleting them. Only a clean
    # unittest result proves that cleanup ran to the end, so only then is an absent line a zero.
    by_logical = audit_by_logical(facts["cleanup_rows"])
    cleanup_proven = facts["unittest_result"] == "OK" and facts["cleanup_unparsed"] == 0
    audit_rows = by_logical.get("clinician", 0) if cleanup_proven else None

    attempts = ledger.get("attempts") if isinstance(ledger.get("attempts"), list) else None
    launched = driver.get("launched_command")
    exact_tail = ["--module", MODULE, "--mode", "live", "--unit", UNIT, "--timeout", str(TIMEOUT)]
    checks = {
        "candidate_checked_out": bool(candidate_sha) and provenance.get("candidate_sha") == candidate_sha
            and provenance.get("checked_out_sha") == candidate_sha,
        "driver_exit_zero": driver.get("exit") == 0,
        "launched_exact_command": isinstance(launched, list) and len(launched) == 10
            and isinstance(launched[1], str) and launched[1].endswith("/scripts/run-tests.py")
            and launched[2:] == exact_tail,
        "run_tests_exit_zero": exit_code == 0,
        "plan_passed": isinstance(plan_result, dict) and plan_result.get("status") == "passed"
            and plan_result.get("exit_code") == 0,
        "single_attempt": attempts is not None and len(attempts) == 1
            and isinstance(attempts[0], dict) and attempts[0].get("status") == "passed",
        "exact_cases": facts["exact_tests"] == ["clinician_policy_live." + case for case in CASES],
        "unittest_ok": facts["tests_ran"] == len(CASES) and facts["unittest_result"] == "OK",
        "single_marker": len(facts["markers"]) == 1 and routes is not None and denied is not None,
        "routes_expected": routes == EXPECTED["routes"],
        "denied_expected": denied == EXPECTED["denied"],
        "audit_rows_zero": audit_rows == EXPECTED["audit_rows"] and audit_in_test == EXPECTED["audit_rows"],
    }
    problems.extend("check failed: " + name for name, held in checks.items() if not held)
    if facts["cleanup_unparsed"]:
        problems.append("unparsed audit cleanup lines: " + str(facts["cleanup_unparsed"]))
    return {
        "schema": 1,
        "gate": "S5-U1a G2 clinician live",
        "unit": UNIT,
        "candidate_sha": candidate_sha,
        "checked_out_sha": provenance.get("checked_out_sha"),
        "tools_sha": provenance.get("tools_sha"),
        "run_id": run_id,
        "run_attempt": run_attempt,
        "exit": exit_code,
        "driver_exit": driver.get("exit"),
        "driver_error": driver.get("error"),
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
        "audit_rows_source": "clinician-actor rows in the OWNED TEST AUDIT CLEANUP archive; null unless unittest OK",
        "audit_rows_in_test": audit_in_test,
        "audit_archive_by_logical": by_logical,
        "steps": [row for row in steps if isinstance(row, dict)],
        "expected": EXPECTED,
        "checks": checks,
        "matches_expected": all(checks.values()),
        "problems": problems,
    }


def write(args):
    summary = build_summary(args.out_dir, args.evidence, args.candidate_sha, args.run_id, args.run_attempt)
    output = Path(args.output)
    output.write_text(json.dumps(summary, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    print(json.dumps({key: summary[key] for key in ("candidate_sha", "exit", "routes", "denied",
                                                    "audit_rows", "matches_expected")}, ensure_ascii=True))
    return 0


def check(args):
    summary = json.loads(Path(args.summary).read_text(encoding="utf-8"))
    print("### S5-U1a G2 clinician live (synthetic, hosted)")
    print("")
    for key in ("candidate_sha", "run_id", "exit", "marker", "routes", "denied", "audit_rows",
                "audit_rows_in_test", "unittest_result", "attempts", "matches_expected"):
        print("- {}: `{}`".format(key, summary.get(key)))
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
        print("U1A_SUMMARY_FAILED: " + str(error), file=sys.stderr)
        return 125


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
