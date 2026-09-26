# coding: utf-8
"""Pure checks for the S5 hosted live gate driver, module list and summary (stdlib; no Docker, stack or network)."""
from __future__ import annotations

import contextlib
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
import run_live  # noqa: E402
import summarize  # noqa: E402

# A fixture SHA for the synthetic runs below; the committed candidate is only ever read from candidate.txt,
# so replacing candidate.txt and modules.json together never needs a pin here.
SHA = "88ce2df3b56ca1b63a66e14e0406e04aee5f2f62"
WORKFLOW = ROOT / ".github/workflows/s5-u1a-clinician-live.yml"
MODULES_FILE = HERE / "modules.json"
CANDIDATE_FILE = HERE / "candidate.txt"
CLINICIAN = "kin-test-0123456789ab-clinician@local.test"
MIXED = "kin-test-0123456789ab-clinician-radiologist@local.test"
ADMIN = "kin-test-0123456789ab-jmryu@local.test"
POLICY_CASES = ["ClinicianPolicyLive." + name for name in (
    "test_01_clinician_only_session_routes_and_default_denial",
    "test_02_pending_and_invalid_clinician_keep_membership_codes_and_logout",
    "test_03_member_console_approves_updates_and_revokes_a_clinician",
    "test_04_mixed_and_legacy_roles_keep_their_existing_paths",
)]
POLICY = {"module": "tests/clinician_policy_live.py", "unit": "s5-u1a-clinician-live", "timeout": 900,
          "cases": POLICY_CASES,
          "expected": {"sweep": {"routes": 108, "denied": 102}, "audit_rows": {"clinician": 0}}}
# A second, sweep-free module shaped like the S5-U1b read module; the timeouts fit the shared deadline.
READ = {"module": "tests/clinician_read_live.py", "unit": "s5-u1b-clinician-read", "timeout": 600,
        "cases": ["ClinicianReadLive.test_01_list", "ClinicianReadLive.test_02_report"],
        "expected": {"sweep": None, "audit_rows": {"clinician": 0}}}
POLICY_SHORT = dict(POLICY, unit="s5-u1b-clinician-policy", timeout=300,
                    expected={"sweep": {"routes": 110, "denied": 99}, "audit_rows": {"clinician": 0}})
TWO = [READ, POLICY_SHORT]


def audit_line(*actors):
    rows = [json.dumps({"id": index, "actor": actor, "action": "admin.user.update", "target": "x",
                        "detail": None, "at": "2026-09-26T00:00:00"}) for index, actor in enumerate(actors, 1)]
    return summarize.CLEANUP + json.dumps(rows, ensure_ascii=True)


def suite_log(entry, routes=None, denied=None, markers=None, result="OK", ran=None, cleanup=(),
              plan_status="passed", plan_exit=0):
    stem, sweep = summarize.step_name(entry["module"]), entry["expected"]["sweep"]
    routes = sweep["routes"] if routes is None and sweep else routes
    denied = sweep["denied"] if denied is None and sweep else denied
    markers = (1 if sweep else 0) if markers is None else markers
    stdout = [summarize.EXACT + json.dumps([stem + "." + case for case in entry["cases"]])]
    stdout += [summarize.MARKER + json.dumps({"allowed": ["GET me", "POST auth/logout"], "denied": denied,
                                              "public": ["GET health"], "routes": routes}, sort_keys=True)] * markers
    stdout += list(cleanup)
    stdout.append(summarize.PLAN + json.dumps({"status": plan_status, "exit_code": plan_exit}))
    stderr = ["%s (%s.%s) ... ok" % (case.split(".")[1], stem, case) for case in entry["cases"]]
    stderr += ["", "-" * 70, "Ran %d tests in 41.203s" % (len(entry["cases"]) if ran is None else ran), "", result]
    return "\n".join(stdout + stderr) + "\n"


def committed_candidate():
    raw = CANDIDATE_FILE.read_bytes()
    match = re.fullmatch(rb"([0-9a-f]{40})\n", raw)
    if match is None:
        raise AssertionError("candidate.txt must hold one full lowercase SHA and a line end: %r" % raw[:80])
    return match.group(1).decode("ascii")


def committed_modules():
    return json.loads(MODULES_FILE.read_text(encoding="utf-8"))


def launched(entry):
    return ["/opt/venv/bin/python", "/w/target/scripts/run-tests.py", "--module", entry["module"], "--mode", "live",
            "--unit", entry["unit"], "--timeout", str(entry["timeout"])]


class Recorded:
    """One workflow run's files: the resolved list, the driver's evidence and measurement_ci's output."""

    def __init__(self, root, modules=(POLICY,), logs=None, exits=None, ran=None, driver_exit=0, commands=None,
                 checked_out=SHA, attempts=None, provenance_modules=None):
        modules = list(modules)
        ran = len(modules) if ran is None else ran
        self.out, self.evidence = Path(root) / "out", Path(root) / "s5-live"
        self.modules = Path(root) / "s5-live-modules.json"
        self.out.mkdir()
        self.evidence.mkdir()
        raw = (json.dumps(modules, indent=2) + "\n").encode("utf-8")
        self.modules.write_bytes(raw)
        steps = [{"name": "stack", "exit": 0, "seconds": 70.0}]
        (self.evidence / "test-gate").mkdir()
        for index, entry in enumerate(modules[:ran]):
            stem = summarize.step_name(entry["module"])
            log = (logs or {}).get(entry["unit"])
            (self.out / (stem + ".log")).write_text(suite_log(entry) if log is None else log, encoding="utf-8")
            steps.append({"name": stem, "exit": (exits or {}).get(entry["unit"], 0), "seconds": 45.0})
            unit_attempts = (attempts or {}).get(entry["unit"], ({"status": "passed", "exit_code": 0},))
            run_live.write_json(self.evidence / "test-gate" / (entry["unit"] + ".json"),
                                {"attempts": list(unit_attempts), "max_attempts": 3})
        steps.append({"name": "cleanup", "exit": 0, "seconds": 9.0})
        (self.out / "results.json").write_text(json.dumps(steps), encoding="utf-8")
        digest = hashlib.sha256(raw).hexdigest() if provenance_modules is None else provenance_modules
        run_live.write_json(self.evidence / "provenance.json", {"candidate_sha": SHA, "checked_out_sha": checked_out,
                                                                "tools_sha": "f" * 40, "modules_sha256": digest})
        commands = [launched(entry) for entry in modules[:ran]] if commands is None else commands
        run_live.write_json(self.evidence / "driver.json", {"exit": driver_exit, "launched_commands": commands,
                                                            "error": None})

    def summary(self, candidate=SHA):
        return summarize.build_summary(self.out, self.evidence, self.modules, candidate, "123", "1")


class ModuleListTests(unittest.TestCase):
    def test_committed_list_is_a_valid_run_description(self):
        # candidate.txt and modules.json move together in the conductor's commit; the pins here are the rules a
        # push would run under, not the values of one candidate.
        modules = committed_modules()
        self.assertEqual(summarize.parse_modules(MODULES_FILE.read_bytes()), modules)
        self.assertTrue(1 <= len(modules) <= 4, len(modules))
        # Restated rather than read from summarize so a changed constant there cannot widen what a push runs.
        self.assertEqual((summarize.DEADLINE - summarize.STACK_RESERVE, summarize.MARGIN), (1325, 35))
        self.assertLessEqual(sum(entry["timeout"] + 35 for entry in modules), 1325)
        for key in ("unit", "module"):
            names = [entry[key] for entry in modules]
            self.assertEqual(len(set(names)), len(names), key)
        stems = [summarize.step_name(entry["module"]) for entry in modules]
        self.assertEqual(len(set(stems)), len(stems))
        for entry in modules:
            with self.subTest(unit=entry["unit"]):
                self.assertEqual(set(entry), {"module", "unit", "timeout", "cases", "expected"})
                self.assertRegex(entry["module"], r"^tests/[a-z][a-z0-9_]*_live\.py$")
                self.assertRegex(entry["unit"], r"^[a-z0-9][a-z0-9-]{0,79}$")
                self.assertIs(type(entry["timeout"]), int)
                self.assertTrue(1 <= entry["timeout"] <= 900, entry["timeout"])
                self.assertTrue(entry["cases"])
                self.assertEqual(len(set(entry["cases"])), len(entry["cases"]))
                for case in entry["cases"]:
                    self.assertRegex(case, r"^[A-Za-z_]\w*\.test_\w+$")
                self.assertEqual(set(entry["expected"]), {"sweep", "audit_rows"})
                sweep = entry["expected"]["sweep"]
                if sweep is not None:
                    self.assertEqual(set(sweep), {"routes", "denied"})
                    for count in sweep.values():
                        self.assertIs(type(count), int)
                        self.assertGreaterEqual(count, 0)
                self.assertIsInstance(entry["expected"]["audit_rows"], dict)
                for logical, count in entry["expected"]["audit_rows"].items():
                    self.assertRegex(logical, r"^[a-z0-9_-]+$")
                    self.assertIs(type(count), int)
                    self.assertGreaterEqual(count, 0)

    def test_valid_lists(self):
        self.assertEqual(summarize.validate_modules(copy.deepcopy(TWO)), TWO)
        # 1325 s is the largest declared worst case: 1500 s deadline less the 175 s stack reserve.
        edge = [dict(READ, timeout=900), dict(POLICY_SHORT, timeout=1325 - 935 - 35)]
        self.assertEqual(summarize.validate_modules(edge), edge)

    def test_defective_lists_are_refused(self):
        def changed(index, **fields):
            modules = copy.deepcopy(TWO)
            modules[index].update(fields)
            return modules
        cases = {
            "not a list": {"module": "tests/clinician_read_live.py"},
            "empty": [],
            "too many": [dict(READ, unit="u%d" % n, module="tests/m%d_live.py" % n, timeout=60) for n in range(5)],
            "extra key": changed(0, note="x"),
            "missing key": [{key: value for key, value in READ.items() if key != "cases"}],
            "parent path": changed(0, module="tests/../api/x_live.py"),
            "e2e module": changed(0, module="tests/e2e/test_worklist.py"),
            "not a live module": changed(0, module="tests/clinician_policy_fixtures.py"),
            "unit case": changed(0, unit="S5-read"),
            "unit type": changed(0, unit=5),
            "bool timeout": changed(0, timeout=True),
            "zero timeout": changed(0, timeout=0),
            "timeout over 900": changed(0, timeout=901),
            "string timeout": changed(0, timeout="600"),
            "no cases": changed(0, cases=[]),
            "duplicate case": changed(0, cases=READ["cases"] + READ["cases"][:1]),
            "bare case": changed(0, cases=["test_01_list"]),
            "expected keys": changed(0, expected={"sweep": None}),
            "sweep shape": changed(1, expected={"sweep": {"routes": 110}, "audit_rows": {}}),
            "sweep negative": changed(1, expected={"sweep": {"routes": 110, "denied": -1}, "audit_rows": {}}),
            "sweep bool": changed(1, expected={"sweep": {"routes": True, "denied": 99}, "audit_rows": {}}),
            "audit logical": changed(0, expected={"sweep": None, "audit_rows": {"Clinician": 0}}),
            "audit count": changed(0, expected={"sweep": None, "audit_rows": {"clinician": None}}),
            "duplicate unit": changed(1, unit=READ["unit"]),
            "duplicate module": changed(1, module=READ["module"]),
            "worst case over the deadline": [dict(READ, timeout=900), dict(POLICY_SHORT, timeout=900)],
            "one second over": [dict(READ, timeout=900), dict(POLICY_SHORT, timeout=1325 - 935 - 35 + 1)],
        }
        for name, value in cases.items():
            with self.subTest(name=name), self.assertRaises(ValueError):
                summarize.validate_modules(value)
        for text in ('[{"module": "a", "module": "b"}]', "not json", ""):
            with self.subTest(text=text), self.assertRaises(ValueError):
                summarize.parse_modules(text)


class SummaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

    def test_expected_single_module_run_matches_every_check(self):
        logs = {POLICY["unit"]: suite_log(POLICY, cleanup=[audit_line(ADMIN, ADMIN)])}
        summary = Recorded(self.temp.name, logs=logs).summary()
        self.assertTrue(summary["matches_expected"], summary["problems"])
        self.assertEqual(summary["problems"], [])
        (item,) = summary["modules"]
        self.assertEqual((item["status"], item["exit"], item["routes"], item["denied"], item["audit_rows"],
                          item["audit_rows_in_test"], item["tests_ran"], item["unittest_result"], item["attempts"]),
                         ("passed", 0, 108, 102, {"clinician": 0}, 0, 4, "OK", 1))
        self.assertEqual(item["audit_archive_by_logical"], {"jmryu": 2})
        self.assertTrue(item["marker"].startswith(summarize.MARKER))
        self.assertEqual((summary["candidate_sha"], summary["run_id"]), (SHA, "123"))

    def test_expected_two_module_run_matches_and_each_module_is_its_own_record(self):
        summary = Recorded(self.temp.name, modules=TWO).summary()
        self.assertTrue(summary["matches_expected"], summary["problems"])
        read, policy = summary["modules"]
        self.assertEqual((read["unit"], read["status"], read["marker"], read["routes"], read["audit_rows_in_test"]),
                         (READ["unit"], "passed", None, None, None))
        self.assertIn("no_sweep_marker", read["checks"])
        self.assertEqual((policy["unit"], policy["routes"], policy["denied"], policy["tests_ran"]),
                         (POLICY_SHORT["unit"], 110, 99, 4))
        self.assertEqual(policy["launched_command"][-1], "300")

    def test_a_failed_first_module_leaves_the_second_not_run(self):
        # measurement_ci stops at the first nonzero suite exit, so the second module never launches.
        logs = {READ["unit"]: suite_log(READ, result="FAILED (failures=1)", plan_status="failed", plan_exit=125)}
        summary = Recorded(self.temp.name, modules=TWO, logs=logs, exits={READ["unit"]: 125}, ran=1,
                           driver_exit=1).summary()
        read, policy = summary["modules"]
        self.assertEqual((read["status"], read["exit"], read["audit_rows"]), ("failed", 125, None))
        self.assertEqual((policy["status"], policy["exit"], policy["launched_command"]), ("not_run", None, None))
        self.assertFalse(summary["checks"]["each_module_launched_once"])
        self.assertFalse(summary["matches_expected"])
        self.assertTrue(any(problem.startswith(POLICY_SHORT["unit"] + ": ") for problem in summary["problems"]))

    def test_route_counts_other_than_expected_fail(self):
        logs = {POLICY["unit"]: suite_log(POLICY, routes=110, denied=104)}
        item = Recorded(self.temp.name, logs=logs).summary()["modules"][0]
        self.assertEqual((item["routes"], item["denied"]), (110, 104))
        self.assertFalse(item["checks"]["routes_expected"] or item["checks"]["denied_expected"])
        self.assertFalse(item["matches_expected"])

    def test_a_marker_where_none_is_expected_fails(self):
        logs = {READ["unit"]: suite_log(READ, routes=1, denied=1, markers=1)}
        summary = Recorded(self.temp.name, modules=TWO, logs=logs).summary()
        self.assertFalse(summary["modules"][0]["checks"]["no_sweep_marker"])
        self.assertFalse(summary["matches_expected"])

    def test_marker_after_subtest_failures_is_not_a_pass(self):
        # subTest failures do not stop test_01, so the marker still prints its probe count.
        logs = {POLICY["unit"]: suite_log(POLICY, result="FAILED (failures=3)", plan_status="failed", plan_exit=125)}
        summary = Recorded(self.temp.name, logs=logs, exits={POLICY["unit"]: 125}, driver_exit=1).summary()
        item = summary["modules"][0]
        self.assertEqual((item["routes"], item["denied"], item["audit_rows_in_test"]), (108, 102, 0))
        self.assertIsNone(item["audit_rows"], "cleanup is unproven without a clean unittest result")
        for name in ("unittest_ok", "plan_passed", "run_tests_exit_zero", "audit_rows_expected"):
            self.assertFalse(item["checks"][name], name)
        self.assertFalse(summary["checks"]["driver_exit_zero"])
        self.assertFalse(summary["matches_expected"])

    def test_archived_clinician_rows_are_counted_and_mixed_identities_are_not(self):
        logs = {POLICY["unit"]: suite_log(POLICY, cleanup=[audit_line(MIXED), audit_line(CLINICIAN, CLINICIAN)])}
        item = Recorded(self.temp.name, logs=logs).summary()["modules"][0]
        self.assertEqual(item["audit_rows"], {"clinician": 2})
        self.assertEqual(item["audit_archive_by_logical"], {"clinician": 2, "clinician-radiologist": 1})
        self.assertFalse(item["checks"]["audit_rows_expected"])
        self.assertFalse(item["matches_expected"])

    def test_unparsed_cleanup_archive_leaves_the_audit_count_unknown(self):
        logs = {POLICY["unit"]: suite_log(POLICY, cleanup=[summarize.CLEANUP + "[not json"])}
        summary = Recorded(self.temp.name, logs=logs).summary()
        self.assertIsNone(summary["modules"][0]["audit_rows"])
        self.assertFalse(summary["matches_expected"])

    def test_missing_or_repeated_marker_fails(self):
        for markers in (0, 2):
            with self.subTest(markers=markers), tempfile.TemporaryDirectory() as root:
                item = Recorded(root, logs={POLICY["unit"]: suite_log(POLICY, markers=markers)}).summary()["modules"][0]
                self.assertEqual(item["marker_lines"], markers)
                self.assertIsNone(item["marker"])
                self.assertIsNone(item["audit_rows_in_test"])
                self.assertFalse(item["checks"]["single_marker"])
                self.assertFalse(item["matches_expected"])

    def test_run_identity_list_and_budget_failures(self):
        second = copy.deepcopy(TWO)
        cases = {
            ("candidate_checked_out", None): dict(checked_out="0" * 40),
            ("modules_match_provenance", None): dict(provenance_modules="0" * 64),
            ("each_module_launched_once", None): dict(commands=[launched(POLICY)] * 2),
            ("single_attempt", POLICY["unit"]): dict(attempts={POLICY["unit"]: ({"status": "failed"},
                                                                               {"status": "passed"})}),
            ("launched_exact_command", POLICY["unit"]): dict(commands=[launched(POLICY)[:-1] + ["600"]]),
            ("exact_cases", POLICY["unit"]): dict(logs={POLICY["unit"]: suite_log(POLICY).replace(
                POLICY_CASES[3], POLICY_CASES[3] + "_renamed")}),
            ("launched_exact_command", READ["unit"]): dict(modules=second, commands=[launched(POLICY_SHORT),
                                                                                     launched(READ)]),
        }
        for (check, unit), arguments in cases.items():
            with self.subTest(check=check, unit=unit), tempfile.TemporaryDirectory() as root:
                summary = Recorded(root, **arguments).summary()
                checks = summary["checks"] if unit is None else next(
                    item["checks"] for item in summary["modules"] if item["unit"] == unit)
                self.assertFalse(checks[check])
                self.assertFalse(summary["matches_expected"])
        with tempfile.TemporaryDirectory() as root:
            self.assertFalse(Recorded(root).summary(candidate="")["checks"]["candidate_checked_out"])

    def test_an_unusable_module_list_fails_the_summary(self):
        recorded = Recorded(self.temp.name)
        recorded.modules.write_text("[]", encoding="utf-8")
        summary = recorded.summary()
        self.assertEqual(summary["modules"], [])
        self.assertFalse(summary["checks"]["modules_valid"])
        self.assertFalse(summary["matches_expected"])
        self.assertTrue(summary["problems"][0].startswith("module list unusable"))

    def test_nothing_recorded_still_writes_a_failing_summary(self):
        # The committed list and a fixed two-entry list: every listed unit gets its own not_run record.
        two = Path(self.temp.name) / "two.json"
        two.write_text(json.dumps(TWO), encoding="utf-8")
        for name, listed, modules in (("committed", MODULES_FILE, committed_modules()), ("two", two, TWO)):
            with self.subTest(modules=name), tempfile.TemporaryDirectory() as root:
                out, evidence = Path(root) / "absent", Path(root) / "s5-live"
                evidence.mkdir()
                output = evidence / "s5-live-summary.json"
                with mock.patch("sys.stdout"):
                    code = summarize.main(["write", "--out-dir", str(out), "--evidence", str(evidence), "--modules",
                                           str(listed), "--candidate-sha", SHA, "--run-id", "9", "--run-attempt",
                                           "1", "--output", str(output)])
                self.assertEqual(code, 0)
                summary = json.loads(output.read_text(encoding="utf-8"))
                self.assertEqual([item["unit"] for item in summary["modules"]],
                                 [entry["unit"] for entry in modules])
                for item in summary["modules"]:
                    self.assertEqual({key: item[key] for key in ("status", "exit", "marker", "routes", "denied",
                                                                 "audit_rows")},
                                     {"status": "not_run", "exit": None, "marker": None, "routes": None,
                                      "denied": None, "audit_rows": None}, item["unit"])
                    self.assertFalse(item["matches_expected"], item["unit"])
                self.assertIn("results.json missing", summary["problems"])
                self.assertFalse(summary["matches_expected"])
                with mock.patch("sys.stdout"):
                    self.assertEqual(summarize.main(["check", str(output)]), 1)

    def test_check_exits_zero_only_for_a_matching_summary(self):
        recorded = Recorded(self.temp.name, modules=TWO)
        output = recorded.evidence / "s5-live-summary.json"
        with mock.patch("sys.stdout"):
            self.assertEqual(summarize.main(["write", "--out-dir", str(recorded.out), "--evidence",
                                             str(recorded.evidence), "--modules", str(recorded.modules),
                                             "--candidate-sha", SHA, "--run-id", "9", "--run-attempt", "1",
                                             "--output", str(output)]), 0)
            self.assertEqual(summarize.main(["check", str(output)]), 0)


class FakeRunner:
    def __init__(self, cases):
        self.cases, self.calls = cases, []

    def module_plan(self, filename, unit, mode, timeout, class_name=None):
        self.calls.append((filename, unit, mode, timeout, class_name))
        return {"unit": unit, "mode": mode, "tests": [{"file": filename, "case": case} for case in self.cases],
                "max_attempts": 3, "timeout_seconds": timeout}


class DriverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

    def test_committed_candidate_matches_the_dispatch_default(self):
        # A dispatch left at its default must run the candidate the committed module list describes.
        candidate = committed_candidate()
        self.assertEqual(run_live.resolve_candidate("push", "", CANDIDATE_FILE), candidate)
        defaults = re.findall(r"(?m)^ +default: ([0-9a-f]{40})$", WORKFLOW.read_text(encoding="utf-8"))
        self.assertEqual(defaults, [candidate])

    def test_candidate_resolution_is_strict(self):
        path = Path(self.temp.name) / "candidate.txt"
        for content in (SHA.encode() + b"\n", SHA.encode() + b"\r\n"):
            path.write_bytes(content)
            self.assertEqual(run_live.resolve_candidate("push", "ignored", path), SHA)
        for content in (SHA.encode(), SHA.upper().encode() + b"\n", SHA[:39].encode() + b"\n",
                        SHA.encode() + b"\n\n", b" " + SHA.encode() + b"\n"):
            path.write_bytes(content)
            with self.subTest(content=content), self.assertRaises(RuntimeError):
                run_live.resolve_candidate("push", "", path)
        self.assertEqual(run_live.resolve_candidate("workflow_dispatch", SHA, path), SHA)
        for event, value in (("workflow_dispatch", SHA[:12]), ("workflow_dispatch", ""), ("pull_request", SHA)):
            with self.subTest(event=event, value=value), self.assertRaises(RuntimeError):
                run_live.resolve_candidate(event, value, HERE / "candidate.txt")

    def test_module_resolution_uses_the_committed_bytes_or_a_valid_dispatch_override(self):
        self.assertEqual(run_live.resolve_modules("push", "", MODULES_FILE), MODULES_FILE.read_bytes())
        self.assertEqual(run_live.resolve_modules("workflow_dispatch", "  ", MODULES_FILE), MODULES_FILE.read_bytes())
        override = run_live.resolve_modules("workflow_dispatch", json.dumps(TWO), MODULES_FILE)
        self.assertEqual(summarize.parse_modules(override), TWO)
        with self.assertRaisesRegex(RuntimeError, "Only workflow_dispatch"):
            run_live.resolve_modules("push", json.dumps(TWO), MODULES_FILE)
        with self.assertRaises(ValueError):
            run_live.resolve_modules("workflow_dispatch", json.dumps([dict(READ, timeout=901)]), MODULES_FILE)
        broken = Path(self.temp.name) / "modules.json"
        broken.write_text("[]", encoding="utf-8")
        with self.assertRaises(ValueError):
            run_live.resolve_modules("push", "", broken)

    def test_resolve_command_writes_the_list_once_and_prints_the_sha(self):
        out = Path(self.temp.name) / "s5-live-modules.json"
        printed = io.StringIO()
        with contextlib.redirect_stdout(printed):
            self.assertEqual(run_live.main(["resolve", "--event-name", "push", "--modules-out", str(out)]), 0)
        self.assertEqual(printed.getvalue(), committed_candidate() + "\n")
        self.assertEqual(out.read_bytes(), MODULES_FILE.read_bytes())
        # An existing output is never overwritten, and a refused override writes nothing.
        with mock.patch("sys.stderr"):
            self.assertEqual(run_live.main(["resolve", "--event-name", "push", "--modules-out", str(out)]), 125)
            self.assertEqual(run_live.main(["resolve", "--event-name", "workflow_dispatch", "--input-sha", SHA,
                                            "--input-modules=[]", "--modules-out",
                                            str(Path(self.temp.name) / "other.json")]), 125)
        self.assertFalse((Path(self.temp.name) / "other.json").exists())

    def test_exact_plan_accepts_only_the_declared_cases(self):
        runner = FakeRunner(POLICY_CASES)
        self.assertEqual([row["case"] for row in run_live.exact_plan(runner, POLICY)], POLICY_CASES)
        self.assertEqual(runner.calls, [(POLICY["module"], POLICY["unit"], "live", 900, None)])
        for cases in (POLICY_CASES[:3], POLICY_CASES + ["ClinicianPolicyLive.test_05_extra"],
                      list(reversed(POLICY_CASES))):
            with self.subTest(cases=len(cases)), self.assertRaises(RuntimeError):
                run_live.exact_plan(FakeRunner(cases), POLICY)

    def load_ci(self, name):
        # This checkout's measurement_ci is byte-identical to the candidate's (489c326..d02ed37e leaves it alone).
        return run_live.load(ROOT / "tests/measurement_ci.py", name)

    def test_the_real_profile_runner_yields_each_exact_command_once_in_order(self):
        ci = self.load_ci("s5_test_measurement_ci")
        record = {"launched_commands": []}
        profile = run_live.configure(ci, ROOT, TWO, record)
        self.assertEqual((profile["suite_timeout"], profile["suite_budgets"], profile["suites"], profile["out"]),
                         (600, {READ["unit"]: 600, POLICY_SHORT["unit"]: 300},
                          (("clinician_read_live.py", None, READ["unit"]),
                           ("clinician_policy_live.py", None, POLICY_SHORT["unit"])),
                          ROOT / "tests/e2e/artifacts/s5-live-gate-ci"))
        with self.assertRaisesRegex(RuntimeError, "listed order"):
            ci.guarded_profile_run(profile, *profile["suites"][1], 1400)
        first, outer = ci.guarded_profile_run(profile, *profile["suites"][0], 1500 - 70)
        self.assertEqual(first, [sys.executable, str(ROOT / "scripts/run-tests.py"), "--module",
                                 "tests/clinician_read_live.py", "--mode", "live", "--unit",
                                 "s5-u1b-clinician-read", "--timeout", "600"])
        self.assertEqual(outer, 635)
        with self.assertRaisesRegex(RuntimeError, "listed order"):
            ci.guarded_profile_run(profile, *profile["suites"][0], 1400)
        second, outer = ci.guarded_profile_run(profile, *profile["suites"][1], 1500 - 70 - 60)
        self.assertEqual((second[-3:], outer), (["s5-u1b-clinician-policy", "--timeout", "300"], 335))
        self.assertEqual(record["launched_commands"], [first, second])
        with self.assertRaisesRegex(RuntimeError, "listed order"):
            ci.guarded_profile_run(profile, *profile["suites"][1], 1400)
        with self.assertRaisesRegex(RuntimeError, "already declares"):
            run_live.configure(ci, ROOT, TWO, {"launched_commands": []})

    def test_a_shortened_timeout_is_refused_before_launch(self):
        ci = self.load_ci("s5_test_measurement_ci_short")
        record = {"launched_commands": []}
        profile = run_live.configure(ci, ROOT, TWO, record)
        ci.guarded_profile_run(profile, *profile["suites"][0], 1430)
        # An earlier module that ran long leaves less than 300 + 35 s: the second is refused, not shortened.
        with self.assertRaisesRegex(RuntimeError, "Refusing a changed live command"):
            ci.guarded_profile_run(profile, *profile["suites"][1], 334)
        self.assertEqual(len(record["launched_commands"]), 1)

    def test_ledger_copy_keeps_the_listed_units_and_the_inspection_marker_only(self):
        state, destination = Path(self.temp.name) / "state", Path(self.temp.name) / "copy"
        state.mkdir()
        for name in ("s5-u1b-clinician-read.json", "s5-u1b-clinician-policy.json", "s5-u1b-clinician-read.lock",
                     "live.lock", "live-needs-inspection.json", "ci-other.json"):
            (state / name).write_text("{}", encoding="utf-8")
        self.assertEqual(run_live.retain_ledger(state, destination, [READ["unit"], POLICY_SHORT["unit"]]),
                         ["live-needs-inspection.json", "s5-u1b-clinician-policy.json",
                          "s5-u1b-clinician-read.json"])
        self.assertEqual(run_live.retain_ledger(Path(self.temp.name) / "absent", destination / "none", ["x"]), [])

    def test_refusal_outside_hosted_ci_records_the_driver_without_launching(self):
        # The committed list and a fixed two-entry list: the refusal names every listed unit, in order.
        two = Path(self.temp.name) / "two.json"
        two.write_text(json.dumps(TWO), encoding="utf-8")
        for name, listed, modules in (("committed", MODULES_FILE, committed_modules()), ("two", two, TWO)):
            with self.subTest(modules=name), tempfile.TemporaryDirectory() as root:
                evidence = Path(root) / "s5-live"
                evidence.mkdir()
                with mock.patch.dict(os.environ, {"GITHUB_ACTIONS": "false"}), mock.patch("traceback.print_exc"):
                    code = run_live.run_recorded(Path(root) / "target", SHA, listed, evidence)
                record = json.loads((evidence / "driver.json").read_text(encoding="utf-8"))
                self.assertEqual((code, record["exit"], record["launched_commands"], record["units"]),
                                 (125, 125, [], [entry["unit"] for entry in modules]))
                self.assertIn("GitHub-hosted", record["error"])
                self.assertEqual(sorted(path.name for path in evidence.iterdir()), ["driver.json"])
        evidence = Path(self.temp.name) / "s5-live"
        evidence.mkdir()
        (evidence / "stale.json").write_text("{}", encoding="utf-8")
        with mock.patch("traceback.print_exc"):
            self.assertEqual(run_live.run_recorded(Path(self.temp.name) / "target", SHA, MODULES_FILE, evidence), 125)
        self.assertIn("must exist and be empty", json.loads((evidence / "driver.json").read_text("utf-8"))["error"])


class WorkflowTextTests(unittest.TestCase):
    """Text pins only: no YAML parser is assumed on the runner's system Python."""

    @classmethod
    def setUpClass(cls):
        cls.text = WORKFLOW.read_text(encoding="utf-8")

    def test_triggers_permissions_and_rerun_refusal(self):
        self.assertIn("  push:\n    branches: [opus/s5-u1a-live-gate-20260926]\n", self.text)
        self.assertIn("  workflow_dispatch:\n", self.text)
        self.assertIn("      modules:\n", self.text)
        self.assertIn("INPUT_MODULES: ${{ inputs.modules }}\n", self.text)
        self.assertIn("permissions:\n  contents: read\n", self.text)
        self.assertIn("cancel-in-progress: false", self.text)
        self.assertIn('[ "$RUN_ATTEMPT" = "1" ]', self.text)
        self.assertNotIn("secrets.", self.text)
        self.assertNotIn("continue-on-error", self.text)
        self.assertEqual(self.text.count("persist-credentials: false"), 2)

    def test_the_driver_runs_once_with_the_resolved_list_and_actions_are_pinned(self):
        self.assertEqual(self.text.count("run_live.py run "), 1)
        self.assertEqual(self.text.count('--modules "$GITHUB_WORKSPACE/s5-live-modules.json"'), 1)
        self.assertEqual(self.text.count("--modules s5-live-modules.json"), 1)
        self.assertNotIn("--timeout", self.text, "every timeout comes from the validated module list")
        # The dispatch input only reaches a shell through an environment variable, never an expression.
        self.assertEqual(re.findall(r"\$\{\{ inputs\.\w+ \}\}", self.text),
                         ["${{ inputs.candidate_sha }}", "${{ inputs.modules }}"])
        uses = re.findall(r"uses: (\S+)", self.text)
        self.assertTrue(uses)
        for action in uses:
            self.assertRegex(action, r"^[\w.-]+/[\w.-]+@[0-9a-f]{40}$")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    unittest.main(verbosity=2)
